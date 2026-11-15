/**
 * Discord for Orrery (stage 1 and 2). Stage 1: a notifier posts release openings to #announcements, ORRY burns to
 * #burn-tracker and operational alerts to #alerts. Stage 2: slash commands over the interactions endpoint
 * (/payer, /agent, /orry, /verify) and wallet verification that gives roles from on-chain and database facts.
 *
 * The bot reads only public data and its own token; no wallet key is used here. Configuration comes from its own
 * variables (loadDiscordConfig), so the rest of the API runs unchanged without them.
 */
import { createPublicKey, randomBytes, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { formatUnits, getAddress, isAddress, parseAbi, verifyMessage, type Address, type Hex } from "viem";
import type { Chain } from "./chain.js";
import { readLens } from "./check.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { chainHead, lag, lagBehind } from "./indexer.js";
import { orryLag } from "./orry-indexer.js";

// ---------------------------------------------------------------- configuration

export interface DiscordConfig {
  token: string;
  guildId: string;
  publicKey: string; // application public key, hex (interactions signature)
  appId: string;
  webUrl: string; // where /discord/verify lives
  watch: { name: string; address: Address; minEth: number }[];
  maxLagBlocks: bigint;
  cardsDir: string | null; // <feature>.png release images and captions.json, reviewed before posting
  draftLeadMs: number; // how long before a release its draft goes to #release-drafts
  /**
   * Test mode (ORRERY_DISCORD_TEST_CHANNEL, for the development network on the community server): every post goes to
   * this one private channel, rooms are never opened, roles are never given or taken (verification reports the roles
   * it would give), commands answer only in this channel, and the upkeep and welcomes stay with the production process.
   */
  testChannel: string | null;
  /** Explorer for transaction links in posts: ORRERY_EXPLORER_URL, else the chain's own (see explorerFor). */
  explorer: string;
}

/** The chain's explorer: Blockscout on 4663, the development network's explorer on 46630, Blockscout otherwise. */
export function explorerFor(chainId: number): string {
  return chainId === 46630 ? "https://explorer.testnet.chain.robinhood.com" : "https://robinhoodchain.blockscout.com";
}

/** Null when ORRERY_DISCORD_TOKEN_FILE or ORRERY_DISCORD_GUILD is missing: every Discord feature stays off. */
export function loadDiscordConfig(env: NodeJS.ProcessEnv = process.env): DiscordConfig | null {
  const file = env.ORRERY_DISCORD_TOKEN_FILE;
  const guildId = env.ORRERY_DISCORD_GUILD;
  if (!file || !guildId) return null;
  const watch = (env.ORRERY_DISCORD_WATCH ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, rest] = s.split("=");
      const [addr, min] = (rest ?? "").split(":");
      if (!name || !addr || !isAddress(addr)) throw new Error(`ORRERY_DISCORD_WATCH entry "${s}" is not name=0xaddress[:minEth]`);
      return { name, address: getAddress(addr), minEth: Number(min ?? "0.0001") };
    });
  return {
    token: readFileSync(file, "utf8").trim(),
    guildId,
    publicKey: env.ORRERY_DISCORD_PUBLIC_KEY ?? "",
    appId: env.ORRERY_DISCORD_APP_ID ?? "",
    webUrl: (env.ORRERY_WEB_URL ?? "https://orrery.tech").replace(/\/$/, ""),
    watch,
    maxLagBlocks: BigInt(env.ORRERY_INDEXER_MAX_LAG ?? 600),
    cardsDir: env.ORRERY_DISCORD_CARDS_DIR ?? null,
    draftLeadMs: Number(env.ORRERY_DISCORD_DRAFT_LEAD_MIN ?? 60) * 60_000,
    testChannel: env.ORRERY_DISCORD_TEST_CHANNEL?.trim().replace(/^#/, "") || null,
    explorer: (env.ORRERY_EXPLORER_URL?.trim() || explorerFor(Number(env.ORRERY_CHAIN_ID ?? 4663))).replace(/\/$/, ""),
  };
}

// ---------------------------------------------------------------- REST client

export interface DiscordApi {
  post(channelId: string, content: string): Promise<void>;
  postImage(channelId: string, content: string, png: Uint8Array, filename: string): Promise<void>;
  setRoleOverwrite(channelId: string, roleId: string, allow: bigint, deny: bigint): Promise<void>;
  addRole(userId: string, roleId: string): Promise<void>;
  removeRole(userId: string, roleId: string): Promise<void>;
  channels(): Promise<{ id: string; name: string; type: number }[]>;
  roles(): Promise<{ id: string; name: string }[]>;
  /** Any other Discord REST call, used by the upkeep. */
  raw(method: string, path: string, body?: unknown): Promise<unknown>;
}

export function discordRest(cfg: Pick<DiscordConfig, "token" | "guildId">, fetchImpl: typeof fetch = fetch): DiscordApi {
  const API = "https://discord.com/api/v10";
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await fetchImpl(API + path, {
        method,
        headers: { Authorization: `Bot ${cfg.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (r.status === 429) {
        const j = (await r.json().catch(() => ({}))) as { retry_after?: number };
        await new Promise((res) => setTimeout(res, Math.ceil((j.retry_after ?? 1) * 1000) + 100));
        continue;
      }
      if (r.status === 204) return null;
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`Discord ${method} ${path}: ${r.status}`);
      return j;
    }
    throw new Error(`Discord ${method} ${path}: rate limited`);
  }
  async function upload(channelId: string, content: string, png: Uint8Array, filename: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ content, allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename }] }));
      form.append("files[0]", new Blob([new Uint8Array(png)], { type: "image/png" }), filename);
      const r = await fetchImpl(`${API}/channels/${channelId}/messages`, { method: "POST", headers: { Authorization: `Bot ${cfg.token}` }, body: form });
      if (r.status === 429) {
        const j = (await r.json().catch(() => ({}))) as { retry_after?: number };
        await new Promise((res) => setTimeout(res, Math.ceil((j.retry_after ?? 1) * 1000) + 100));
        continue;
      }
      if (!r.ok) throw new Error(`Discord upload: ${r.status}`);
      return;
    }
    throw new Error("Discord upload: rate limited");
  }
  return {
    post: async (channelId, content) => void (await call("POST", `/channels/${channelId}/messages`, { content, allowed_mentions: { parse: [] } })),
    postImage: upload,
    setRoleOverwrite: async (c, r, allow, deny) => void (await call("PUT", `/channels/${c}/permissions/${r}`, { type: 0, allow: allow.toString(), deny: deny.toString() })),
    addRole: async (u, r) => void (await call("PUT", `/guilds/${cfg.guildId}/members/${u}/roles/${r}`)),
    removeRole: async (u, r) => void (await call("DELETE", `/guilds/${cfg.guildId}/members/${u}/roles/${r}`)),
    raw: (method, path, body) => call(method, path, body),
    channels: async () => (await call("GET", `/guilds/${cfg.guildId}/channels`)) as { id: string; name: string; type: number }[],
    roles: async () => (await call("GET", `/guilds/${cfg.guildId}/roles`)) as { id: string; name: string }[],
  };
}

// ---------------------------------------------------------------- stage 1: messages (pure)

const FEATURE_TEXT: Record<string, string> = {
  earn: "Earn is now in view. Pair ORRY with ETH or USDG and collect 85% of the pool's swap fees.",
  stake: "Staking is now in view. Stake ORRY to receive a share of Orrery revenue, paid out in ETH and ORRY.",
  claim: "Claim is now in view. Collect Earn fees and stake rewards together in a single transaction.",
  burn: "The burn chart is up. Each ORRY burn is plotted with its transaction.",
  leaderboard: "The leaderboard is up, ranking the top stakers and earners.",
  "agent-stake": "Agent stake is now in view. Back your agent with ORRY, and the stake appears in each signed reading.",
  checkout: "ORRY checkout is now in view. Buy check packs and agent verifications in ORRY, and all ORRY spent is burned.",
};
const FEATURE_PATH: Record<string, string> = {
  earn: "/earn", stake: "/stake", claim: "/claim", burn: "/burn", leaderboard: "/leaderboard", "agent-stake": "/stake", checkout: "/credits",
};

export function releaseMessage(feature: string, webUrl: string): string {
  const text = FEATURE_TEXT[feature] ?? `${feature} is now in view on Orrery.`;
  return `**${text}**\n${webUrl}${FEATURE_PATH[feature] ?? ""}`;
}

const BURN_SOURCE: Record<string, string> = {
  "1": "ORRY portion of protocol fees",
  "2": "ORRY check pack purchase",
  "3": "ORRY agent verification",
  "4": "ETH portion of protocol fees, bought back",
  "5": "market order sealing fee",
  "6": "market trading fee in ORRY",
  "7": "Orrery fee on ORRY merchant payments",
};

export function formatOrry(amount: string): string {
  const [i, f = ""] = formatUnits(BigInt(amount), 18).split(".");
  return `${Number(i).toLocaleString("en-US")}${f && Number(f.slice(0, 2)) > 0 ? "." + f.slice(0, 2) : ""}`;
}

export function burnMessage(b: { amount: string; source: string; tx: string }, explorer: string): string {
  return `🔥 ${formatOrry(b.amount)} ORRY burned · ${BURN_SOURCE[b.source] ?? "burn"}\n${explorer}/tx/${b.tx}`;
}

/** Alerts as of now. Each has a key that the notifier posts once per six hour bucket. */
export function alertsFor(input: {
  lag: { lag: bigint } | null;
  orryLag: { lag: bigint } | null;
  /** True when the live chain head could not be read; the lags are then the indexers' own and may hide a stall. */
  headUnreadable?: boolean;
  orryOn: boolean;
  maxLag: bigint;
  confirmations: number;
  balances: { name: string; address: string; eth: number; minEth: number }[];
}): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  if (input.headUnreadable) out.push({ key: "chain-head", text: "Chain head unreadable, so indexer lag cannot be measured. Look at the RPC." });
  if (!input.lag) out.push({ key: "indexer-missing", text: "Indexer state is empty." });
  else if (input.lag.lag > input.maxLag) out.push({ key: "indexer-lag", text: `Indexer trails the chain head by ${input.lag.lag} blocks.` });
  if (input.orryOn) {
    const limit = input.maxLag + BigInt(input.confirmations);
    if (!input.orryLag) out.push({ key: "orry-indexer-missing", text: "ORRY indexer state is empty." });
    else if (input.orryLag.lag > limit) out.push({ key: "orry-indexer-lag", text: `ORRY indexer trails the chain head by ${input.orryLag.lag} blocks.` });
  }
  for (const b of input.balances) {
    if (b.eth < b.minEth) out.push({ key: `low-gas-${b.name}`, text: `${b.name} wallet ${b.address} is at ${b.eth.toFixed(6)} ETH, under its ${b.minEth} ETH floor. Refill it.` });
  }
  return out;
}

// ---------------------------------------------------------------- releases: rooms, cards, drafts

/** Room -> the release feature that opens it for members to write (same map as ops/discord/rooms.mjs). */
export const ROOM_RELEASES: Record<string, string> = {
  operators: "core", "agent-builders": "core", merchants: "core", showcase: "core",
  "orry-chat": "earn", "earn-and-stake": "earn", "burn-tracker": "burn",
  missions: "achievements", achievements: "achievements", "bounty-board": "achievements",
};
/** Rooms members only read even after they open; the bot and staff post there. */
export const READ_ONLY_ROOMS = new Set(["burn-tracker", "missions", "achievements", "bounty-board"]);

export function roomsFor(feature: string): string[] {
  return Object.entries(ROOM_RELEASES).filter(([, f]) => f === feature).map(([r]) => r);
}

/** The reviewed caption and image for a release, or the plain text when no card was made. */
export function releaseCard(feature: string, d: Pick<DiscordConfig, "cardsDir" | "webUrl">): { caption: string; png: Uint8Array | null } {
  let caption = releaseMessage(feature, d.webUrl);
  let png: Uint8Array | null = null;
  if (d.cardsDir) {
    try {
      const captions = JSON.parse(readFileSync(`${d.cardsDir}/captions.json`, "utf8")) as Record<string, string>;
      if (captions[feature]) caption = captions[feature];
    } catch {}
    try {
      png = readFileSync(`${d.cardsDir}/${feature}.png`);
    } catch {}
  }
  return { caption, png };
}

const P_VIEW = 1n << 10n, P_SEND = 1n << 11n, P_HISTORY = 1n << 16n;

/** Lets members write in the rooms a feature opens (read-only rooms stay read-only). */
export async function openRooms(api: DiscordApi, ch: Record<string, string>, roles: Record<string, string>, feature: string): Promise<string[]> {
  const member = roles["Member"];
  if (!member) return [];
  const opened: string[] = [];
  for (const room of roomsFor(feature)) {
    if (!ch[room]) continue;
    const write = !READ_ONLY_ROOMS.has(room);
    await api.setRoleOverwrite(ch[room], member, write ? P_VIEW | P_HISTORY | P_SEND : P_VIEW | P_HISTORY, write ? 0n : P_SEND);
    opened.push(room);
  }
  return opened;
}

/** Posts the approved release card to #announcements, once per feature. */
export async function announceRelease(sql: Sql, api: DiscordApi, ch: Record<string, string>, d: DiscordConfig, feature: string): Promise<"posted" | "already" | "no-channel"> {
  const target = d.testChannel ? ch[d.testChannel] : ch.announcements;
  if (!target) return "no-channel";
  const rows = await sql`insert into discord_posts (kind, key) values ('release', ${feature}) on conflict do nothing returning key`;
  if (rows.length !== 1) return "already";
  try {
    const card = releaseCard(feature, d);
    if (card.png) await api.postImage(target, card.caption, card.png, `${feature}.png`);
    else await api.post(target, card.caption);
  } catch (e) {
    await sql`delete from discord_posts where kind = 'release' and key = ${feature}`;
    throw e;
  }
  return "posted";
}

// ---------------------------------------------------------------- stage 1: notifier loop

async function postedOnce(sql: Sql, kind: string, key: string): Promise<boolean> {
  const rows = await sql`insert into discord_posts (kind, key) values (${kind}, ${key}) on conflict do nothing returning key`;
  return rows.length === 1;
}

export async function channelIds(api: DiscordApi): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // Text (0) and Announcement (5) channels both take messages; #announcements is an Announcement channel, so a text-only
  // map left /announce and the notifier with "no #announcements channel" (found at the public launch, 2026-11-11).
  for (const c of await api.channels()) if (c.type === 0 || c.type === 5) out[c.name] = c.id;
  return out;
}

/** One notifier pass: release openings, burns not yet posted, alerts. Returns what it posted. */
export async function notifyOnce(cfg: Config, chain: Chain, sql: Sql, d: DiscordConfig, api: DiscordApi, ch: Record<string, string>, now = new Date()): Promise<string[]> {
  const posted: string[] = [];
  const at = (channel: string) => ch[d.testChannel ?? channel];
  const send = async (channel: string, kind: string, key: string, text: string) => {
    const id = at(channel);
    if (!id) return;
    if (!(await postedOnce(sql, kind, key))) return;
    try {
      await api.post(id, text);
      posted.push(`${channel}:${key}`);
    } catch (e) {
      await sql`delete from discord_posts where kind = ${kind} and key = ${key}`; // retry next pass
      throw e;
    }
  };

  // releases: the draft goes to #release-drafts ahead of time for review; the rooms open at the hour. Nothing reaches
  // #announcements until someone approves it with /announce (or ops/discord/announce.mjs).
  const due = await sql<{ feature: string; opens_at: Date }[]>`select feature, opens_at from releases
    where opens_at is not null and opens_at <= ${new Date(now.getTime() + d.draftLeadMs)}`;
  for (const r of due) {
    if (at("release-drafts") && (await postedOnce(sql, "draft", `${r.feature}@${r.opens_at.toISOString()}`))) {
      const card = releaseCard(r.feature, d);
      const head = `**Pending review** · ${r.feature} opens ${r.opens_at.toISOString().replace("T", " ").slice(0, 16)} UTC. Run \`/announce ${r.feature}\` to publish it; it stays unposted until then.\n\n`;
      try {
        if (card.png) await api.postImage(at("release-drafts")!, head + card.caption, card.png, `${r.feature}.png`);
        else await api.post(at("release-drafts")!, head + card.caption);
        posted.push(`release-drafts:${r.feature}`);
      } catch (e) {
        await sql`delete from discord_posts where kind = 'draft' and key = ${`${r.feature}@${r.opens_at.toISOString()}`}`;
        throw e;
      }
    }
    if (r.opens_at <= now && (await postedOnce(sql, "rooms", `${r.feature}@${r.opens_at.toISOString()}`))) {
      if (d.testChannel) {
        const rooms = roomsFor(r.feature).filter((room) => ch[room]);
        if (rooms.length && at("rooms")) await api.post(at("rooms")!, `Opening with ${r.feature} on mainnet: ${rooms.map((x) => `#${x}`).join(", ")}. No change in this room.`);
      } else {
        const opened = await openRooms(api, ch, await roleIdsByName(api), r.feature);
        if (opened.length) posted.push(`rooms:${opened.join(",")}`);
      }
    }
  }

  // burns (same validity rule as the burn page), oldest first, at most 20 per pass
  if (cfg.orry) {
    // ORRY contracts burn with sources 1 to 4; a market the factory created burns with 5 (sealing fee) or 6 (fee in ORRY)
    const burns = await sql<{ tx_hash: string; log_index: number; block_number: string; source: string; amount: string }[]>`
      select b.tx_hash, b.log_index, b.block_number::text, b.source, b.amount from (
        select tx_hash, log_index, block_number, args->>'source' as source, args->>'amount' as amount from orry_events
        where event = 'Burned' and ((source = 'router' and args->>'source' = '1') or (source = 'treasury' and args->>'source' in ('2', '3'))
          or (source = 'buyback' and args->>'source' = '4'))
        union all
        select tx_hash, log_index, block_number, args->>'source', args->>'amount' from market_events
        where event = 'Burned' and args->>'source' in ('5', '6') and address in (select market from markets)
      ) b
      where not exists (select 1 from discord_posts p where p.kind = 'burn' and p.key = b.block_number::text || ':' || b.log_index::text)
      order by b.block_number, b.log_index limit 20`;
    for (const b of burns) await send("burn-tracker", "burn", `${b.block_number}:${b.log_index}`, burnMessage({ amount: b.amount, source: b.source, tx: b.tx_hash }, d.explorer));
  }

  // alerts, at most once per six hours each
  const balances = await Promise.all(
    d.watch.map(async (w) => ({ name: w.name, address: w.address, minEth: w.minEth, eth: Number(formatUnits(await chain.public.getBalance({ address: w.address }), 18)) })),
  );
  // lag against the live head: a stuck indexer keeps a stored head as old as its cursor
  const head = await chainHead(chain).catch(() => null);
  const live = <T extends { last: bigint; lag: bigint }>(c: T | null) => (c && head !== null ? { ...c, lag: lagBehind(c, head)! } : c);
  const alerts = alertsFor({
    lag: live(await lag(sql)),
    orryLag: cfg.orry ? live(await orryLag(sql)) : null,
    headUnreadable: head === null,
    orryOn: !!cfg.orry,
    maxLag: d.maxLagBlocks,
    confirmations: cfg.confirmations,
    balances,
  });
  const bucket = Math.floor(now.getTime() / (6 * 3600_000));
  for (const a of alerts) await send("alerts", "alert", `${a.key}:${bucket}`, `⚠️ ${a.text}`);
  return posted;
}

// ---------------------------------------------------------------- stage 2: roles (pure)

export type AutoRole = "Verified" | "ORRY Holder" | "Operator" | "Merchant";
export const AUTO_ROLES: AutoRole[] = ["Verified", "ORRY Holder", "Operator", "Merchant"];

export function rolesFor(f: { orryHeld: bigint; orryStaked: bigint; agentsOwned: bigint; creditPurchases: number }): AutoRole[] {
  const r: AutoRole[] = ["Verified"];
  if (f.orryHeld + f.orryStaked > 0n) r.push("ORRY Holder");
  if (f.agentsOwned > 0n) r.push("Operator");
  if (f.creditPurchases > 0) r.push("Merchant");
  return r;
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const erc721 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export async function factsFor(cfg: Config, chain: Chain, sql: Sql, address: Address) {
  const a = address.toLowerCase();
  const [held, staked, agents, credits] = await Promise.all([
    cfg.orry ? chain.public.readContract({ address: cfg.orry.token, abi: erc20, functionName: "balanceOf", args: [address] }) : Promise.resolve(0n),
    cfg.orry
      ? sql<{ s: string | null }[]>`select (plain_active + plain_leaving + agent_active)::text as s from orry_stakers where address = ${a}`.then((r) => BigInt(r[0]?.s ?? "0"))
      : Promise.resolve(0n),
    chain.public.readContract({ address: cfg.addresses.registry, abi: erc721, functionName: "balanceOf", args: [address] }).catch(() => 0n),
    sql<{ n: string }[]>`select count(*)::text as n from credit_grants where payer = ${a}`.then((r) => Number(r[0]?.n ?? 0)),
  ]);
  return { orryHeld: held as bigint, orryStaked: staked, agentsOwned: agents as bigint, creditPurchases: credits };
}

/** Gives and removes the automatic roles of one member so they match `want`. */
export async function applyRoles(api: DiscordApi, roleIds: Record<string, string>, userId: string, have: string[], want: AutoRole[]): Promise<void> {
  for (const r of AUTO_ROLES) {
    const id = roleIds[r];
    if (!id) continue;
    if (want.includes(r) && !have.includes(r)) await api.addRole(userId, id);
    if (!want.includes(r) && have.includes(r)) await api.removeRole(userId, id);
  }
}

export async function roleIdsByName(api: DiscordApi): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of await api.roles()) out[r.name] = r.id;
  return out;
}

/** Re-checks every linked member and corrects their roles. */
export async function syncRoles(cfg: Config, chain: Chain, sql: Sql, api: DiscordApi, testMode = false): Promise<number> {
  if (testMode) return 0;
  const ids = await roleIdsByName(api);
  const links = await sql<{ discord_user_id: string; address: string; roles: string[] }[]>`select discord_user_id, address, roles from discord_links`;
  for (const l of links) {
    const want = rolesFor(await factsFor(cfg, chain, sql, getAddress(l.address)));
    await applyRoles(api, ids, l.discord_user_id, l.roles, want);
    await sql`update discord_links set roles = ${want}, checked_at = now() where discord_user_id = ${l.discord_user_id}`;
  }
  return links.length;
}

// ---------------------------------------------------------------- stage 2: verification

export function verificationMessage(discordUserId: string, nonce: string): string {
  return `Orrery Discord verification\nDiscord user: ${discordUserId}\nNonce: ${nonce}`;
}

export async function newNonce(sql: Sql, discordUserId: string): Promise<string> {
  const nonce = randomBytes(16).toString("hex");
  await sql`insert into discord_nonces (nonce, discord_user_id, expires_at) values (${nonce}, ${discordUserId}, now() + interval '15 minutes')`;
  return nonce;
}

/** Checks the signed message, links the wallet to the Discord member and gives the roles. One use per nonce. */
export async function completeVerification(
  cfg: Config, chain: Chain, sql: Sql, api: DiscordApi, nonce: string, address: Address, signature: Hex, testMode = false,
): Promise<{ ok: true; roles: AutoRole[]; test?: true } | { ok: false; error: string }> {
  const [n] = await sql<{ discord_user_id: string }[]>`update discord_nonces set used = true
    where nonce = ${nonce} and not used and expires_at > now() returning discord_user_id`;
  if (!n) return { ok: false, error: "This link is spent or past its 15 minutes. Run /verify in Discord to get a fresh one." };
  const valid = await verifyMessage({ address, message: verificationMessage(n.discord_user_id, nonce), signature }).catch(() => false);
  if (!valid) return { ok: false, error: "Signature and wallet differ. Run /verify again and sign from the wallet you connect." };
  const [prev] = await sql<{ roles: string[] }[]>`select roles from discord_links where discord_user_id = ${n.discord_user_id}`;
  const want = rolesFor(await factsFor(cfg, chain, sql, address));
  if (testMode) return { ok: true, roles: want, test: true }; // the development network never changes community roles
  await applyRoles(api, await roleIdsByName(api), n.discord_user_id, prev?.roles ?? [], want);
  await sql`insert into discord_links (discord_user_id, address, roles) values (${n.discord_user_id}, ${address.toLowerCase()}, ${want})
    on conflict (discord_user_id) do update set address = excluded.address, roles = excluded.roles, linked_at = now(), checked_at = now()`;
  return { ok: true, roles: want };
}

// ---------------------------------------------------------------- stage 2: interactions

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyInteraction(publicKeyHex: string, signatureHex: string, timestamp: string, body: string): boolean {
  try {
    if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(timestamp + body), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

const STATUS = ["No session", "Active", "Paused", "Revoked", "Expired"];
const usd = (v: bigint) => Number(formatUnits(v, 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type LensView = Awaited<ReturnType<typeof readLens>>;
export function lensReply(v: LensView, label: string): string {
  if (v.account === "0x0000000000000000000000000000000000000000") return `${label}: no Orrery session is on record for this address.`;
  const c = v.caps[0];
  const lines = [
    `**${label}** · ${STATUS[v.status] ?? "Unknown"}${v.verified ? " · verified" : ""}`,
    `Agent #${v.agentId} · account ${v.account}`,
  ];
  if (c) lines.push(`Per payment cap ${usd(c.perTx)} · daily cap ${usd(c.perDay)} (${usd(c.spentToday)} used today) · float ${usd(c.floatMax)} USDG`);
  lines.push(`Endpoints: ${v.attestation.endpointsLive ? "answered the last probe" : "no answer on record"}`);
  return lines.join("\n");
}

type Interaction = {
  type: number;
  channel_id?: string;
  data?: { name: string; options?: { name: string; value: string | number }[] };
  member?: { user?: { id: string }; roles?: string[] };
  user?: { id: string };
};
const reply = (content: string, ephemeral = false) => ({ type: 4, data: { content, flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] } } });

export async function handleInteraction(cfg: Config, chain: Chain, sql: Sql, d: DiscordConfig, i: Interaction, api?: DiscordApi): Promise<unknown> {
  if (i.type === 1) return { type: 1 }; // PING
  if (i.type !== 2 || !i.data) return reply("That command is not recognised.", true);
  const opt = (n: string) => i.data?.options?.find((o) => o.name === n)?.value;
  const userId = i.member?.user?.id ?? i.user?.id;
  if (d.testChannel && api) {
    const testId = (await channelIds(api))[d.testChannel];
    if (!testId || i.channel_id !== testId) return reply(`Run these commands in #${d.testChannel}.`, true);
  }
  try {
    switch (i.data.name) {
      case "payer": {
        const a = String(opt("address") ?? "");
        if (!isAddress(a)) return reply("Expected a 0x address.", true);
        return reply(lensReply(await readLens(cfg, chain, { signer: getAddress(a) }), `Payer ${getAddress(a)}`));
      }
      case "agent": {
        const id = String(opt("id") ?? "");
        const acc = String(opt("account") ?? "");
        if (!/^\d+$/.test(id) || !isAddress(acc)) return reply("Give the numeric agent ID followed by its account address.", true);
        return reply(lensReply(await readLens(cfg, chain, { agentId: BigInt(id), account: getAddress(acc) }), `Agent #${id}`));
      }
      case "orry": {
        if (!cfg.orry) return reply("ORRY figures show here once ORRY opens.", true);
        const [s] = await sql<{ staked: string | null; burned: string | null }[]>`select
          (select sum(plain_active + agent_active)::text from orry_stakers) as staked,
          (select sum((args->>'amount')::numeric)::text from orry_events where event = 'Burned') as burned`;
        return reply(`**ORRY**\nStaked now: ${formatOrry(s?.staked ?? "0")} ORRY\nBurned to date: ${formatOrry(s?.burned ?? "0")} ORRY\n${d.webUrl}/stake`);
      }
      case "announce": {
        if (!api) return reply("This server has no announcement setup.", true);
        const feature = String(opt("feature") ?? "");
        const roles = await roleIdsByName(api);
        const allowed = [roles["Admin"], roles["Core Team"]].filter(Boolean);
        if (!i.member?.roles?.some((r) => allowed.includes(r))) return reply("Announcements need approval from an Admin or Core Team member.", true);
        const out = await announceRelease(sql, api, await channelIds(api), d, feature);
        return reply(out === "posted" ? `${feature} announcement published.` : out === "already" ? `${feature} announcement is already up.` : "No #announcements channel found.", true);
      }
      case "verify": {
        if (!userId) return reply("Use /verify from within the Orrery server.", true);
        const nonce = await newNonce(sql, userId);
        return reply(`Link your wallet: open the page below, connect, and sign a single message. The link is good for one use within 15 minutes.\n${d.webUrl}/discord/verify?n=${nonce}&u=${userId}`, true);
      }
    }
  } catch {
    return reply("Chain read failed. Retry in a few seconds.", true);
  }
  return reply("That command is not recognised.", true);
}

/** POST /v1/discord/interactions (signed by Discord) and POST /v1/discord/verify (from the web page). */
export function registerDiscordRoutes(app: FastifyInstance, cfg: Config, chain: Chain, sql: Sql, d: DiscordConfig, api: DiscordApi, allowPublic: (ip: string) => boolean): void {
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      try {
        done(null, { raw: body as string, json: JSON.parse(body as string) });
      } catch {
        done(null, { raw: body as string, json: null });
      }
    });
    scope.post("/v1/discord/interactions", async (req, res) => {
      const b = req.body as { raw: string; json: Interaction | null };
      const sig = String(req.headers["x-signature-ed25519"] ?? "");
      const ts = String(req.headers["x-signature-timestamp"] ?? "");
      if (!b?.json || !verifyInteraction(d.publicKey, sig, ts, b.raw)) return res.code(401).send({ error: "invalid request signature" });
      return handleInteraction(cfg, chain, sql, d, b.json, api);
    });
    scope.post("/v1/discord/verify", async (req, res) => {
      if (!allowPublic(req.ip)) return res.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
      const j = (req.body as { json: { nonce?: string; address?: string; signature?: string } | null }).json;
      if (!j?.nonce || !j.address || !isAddress(j.address) || !/^0x[0-9a-fA-F]+$/.test(j.signature ?? "")) {
        return res.code(400).send({ error: "Required fields: nonce, address, signature." });
      }
      const out = await completeVerification(cfg, chain, sql, api, j.nonce, getAddress(j.address), j.signature as Hex, !!d.testChannel);
      return out.ok ? { roles: out.roles, test: out.test } : res.code(400).send({ error: out.error });
    });
  });
}

// ---------------------------------------------------------------- upkeep: keeps the server as designed, unattended

type Overwrite = { id: string; type: number; allow: string; deny: string };
type RoleRow = { id: string; name: string; color: number; hoist: boolean; mentionable: boolean; permissions: string; tags?: Record<string, unknown> };
type ChannelRow = { id: string; name: string; type: number; parent_id?: string | null; topic?: string | null; permission_overwrites?: Overwrite[] };

const B = (n: number) => 1n << BigInt(n);
const UP = { VIEW: B(10), SEND: B(11), MANAGE_MESSAGES: B(13), EMBED: B(14), ATTACH: B(15), HISTORY: B(16), EXT_STICKERS: B(37) };

/** The booster role as Orrery shows it (ops/discord/boosters.mjs made the first one; this keeps it so). */
export const BOOSTER_ROLE = { name: "Orrery Booster", color: 0xb46bff, hoist: true, mentionable: false, permissions: UP.EMBED | UP.ATTACH | UP.EXT_STICKERS };
export const BOOSTER_LOUNGE = {
  name: "boosters",
  topic: "Boosters and the team. Release previews land here ahead of #announcements, along with first invites to try new features. Thanks for boosting Orrery.",
};
/** Approved by the owner on 2026-11-09; posted and pinned once in #boosters. */
export const BOOSTER_INFO = `**#boosters · start here**
Thanks for boosting Orrery. Your boosts keep the server's upgrades on for everyone.

**Booster perks**
• **Orrery Booster role:** a violet name and a section of your own in the member list.
• **Images and files** in each room where you can post, plus previews for official links.
• **Release previews:** upcoming release cards and features show up here ahead of #announcements.
• **First tester invites:** boosters are first to hear when a new feature is ready to try on the development network.
• **Monthly thanks:** the team thanks its boosters in #announcements each month.

**Coming soon**
• **Booster achievement** on the Achievement Board, paid from the Reward Pool. Link a wallet with /verify ahead of time.
• **Agent Launch booster window:** boosters with a linked wallet get a brief early window on new launches.`;
const STAFF_ROLES = ["Admin", "Core Team", "Moderator"];

/**
 * Booster upkeep: once anyone boosts, Discord creates its own booster role. This styles it, gives its perks, keeps the
 * private #boosters lounge (boosters and staff) and its pinned welcome. Does nothing before the first boost. Returns
 * what it changed; a second run changes nothing.
 */
export async function ensureBoosters(api: DiscordApi, guildId: string): Promise<string[]> {
  const done: string[] = [];
  const roles = (await api.raw("GET", `/guilds/${guildId}/roles`)) as RoleRow[];
  const booster = roles.find((r) => r.tags && "premium_subscriber" in r.tags);
  if (!booster) return done;
  const want = BOOSTER_ROLE;
  if (booster.name !== want.name || booster.color !== want.color || booster.hoist !== want.hoist || booster.mentionable !== want.mentionable || BigInt(booster.permissions) !== want.permissions) {
    await api.raw("PATCH", `/guilds/${guildId}/roles/${booster.id}`, { name: want.name, color: want.color, hoist: want.hoist, mentionable: want.mentionable, permissions: want.permissions.toString() });
    done.push("booster role styled");
  }
  const me = (await api.raw("GET", "/users/@me")) as { id: string };
  const bot = roles.find((r) => r.tags?.bot_id === me.id);
  const chans = (await api.raw("GET", `/guilds/${guildId}/channels`)) as ChannelRow[];
  const community = chans.find((c) => c.type === 4 && c.name.toUpperCase() === "COMMUNITY");
  const allow = (id: string, p: bigint): Overwrite => ({ id, type: 0, allow: p.toString(), deny: "0" });
  const overwrites: Overwrite[] = [{ id: guildId, type: 0, allow: "0", deny: UP.VIEW.toString() }, allow(booster.id, UP.VIEW | UP.SEND | UP.HISTORY | UP.EMBED | UP.ATTACH)];
  for (const n of STAFF_ROLES) {
    const r = roles.find((x) => x.name === n);
    if (r) overwrites.push(allow(r.id, UP.VIEW | UP.SEND | UP.HISTORY));
  }
  if (bot) overwrites.push(allow(bot.id, UP.VIEW | UP.SEND | UP.EMBED | UP.HISTORY | UP.MANAGE_MESSAGES));
  let lounge = chans.find((c) => c.type === 0 && c.name === BOOSTER_LOUNGE.name);
  if (!lounge) {
    lounge = (await api.raw("POST", `/guilds/${guildId}/channels`, { name: BOOSTER_LOUNGE.name, type: 0, topic: BOOSTER_LOUNGE.topic, parent_id: community?.id, rate_limit_per_user: 5, permission_overwrites: overwrites })) as ChannelRow;
    done.push("#boosters created");
  } else if (!sameOverwrites(lounge.permission_overwrites ?? [], overwrites)) {
    await api.raw("PATCH", `/channels/${lounge.id}`, { permission_overwrites: overwrites });
    done.push("#boosters access restored");
  }
  const pins = (await api.raw("GET", `/channels/${lounge.id}/pins`)) as { author?: { id: string }; content: string }[];
  if (!pins.some((m) => m.author?.id === me.id && m.content.startsWith("**#boosters · start here**"))) {
    const m = (await api.raw("POST", `/channels/${lounge.id}/messages`, { content: BOOSTER_INFO, flags: 4, allowed_mentions: { parse: [] } })) as { id: string };
    await api.raw("PUT", `/channels/${lounge.id}/pins/${m.id}`);
    done.push("#boosters welcome pinned");
  }
  return done;
}

export function sameOverwrites(have: Overwrite[], want: Overwrite[]): boolean {
  const key = (o: Overwrite) => `${o.id}:${BigInt(o.allow)}:${BigInt(o.deny)}`;
  return have.length === want.length && want.every((w) => have.some((h) => key(h) === key(w)));
}

/** The Member overwrite a feature room should carry: hidden until its feature opens, then open (or read-only). */
export function memberOverwriteFor(room: string, released: boolean): { allow: bigint; deny: bigint } {
  if (!released) return { allow: 0n, deny: UP.VIEW | UP.SEND };
  return READ_ONLY_ROOMS.has(room) ? { allow: UP.VIEW | UP.HISTORY, deny: UP.SEND } : { allow: UP.VIEW | UP.HISTORY | UP.SEND, deny: 0n };
}

/**
 * Room upkeep: every feature room shows to members exactly when its feature has opened in the release switch, and is
 * hidden before. Corrects drift (a re-run of setup, a hand edit) and opens rooms at the release hour on its own.
 */
export async function syncFeatureRooms(sql: Sql, api: DiscordApi, guildId: string, now = new Date()): Promise<string[]> {
  const done: string[] = [];
  const open = new Set((await sql<{ feature: string }[]>`select feature from releases where opens_at is not null and opens_at <= ${now}`).map((r) => r.feature));
  const roles = (await api.raw("GET", `/guilds/${guildId}/roles`)) as RoleRow[];
  const member = roles.find((r) => r.name === "Member");
  if (!member) return done;
  const chans = (await api.raw("GET", `/guilds/${guildId}/channels`)) as ChannelRow[];
  const me = (await api.raw("GET", "/users/@me")) as { id: string };
  for (const [room, feature] of Object.entries(ROOM_RELEASES)) {
    const ch = chans.find((c) => c.name === room && (c.type === 0 || c.type === 15));
    if (!ch) continue;
    const want = memberOverwriteFor(room, open.has(feature));
    const have = (ch.permission_overwrites ?? []).find((o) => o.id === member.id);
    if (have && BigInt(have.allow) === want.allow && BigInt(have.deny) === want.deny) continue;
    await api.setRoleOverwrite(ch.id, member.id, want.allow, want.deny);
    done.push(`#${room} ${open.has(feature) ? "opened" : "hidden"}`);
    if (open.has(feature)) {
      const pins = (await api.raw("GET", `/channels/${ch.id}/pins`).catch(() => [])) as { id: string; author?: { id: string }; content: string }[];
      for (const m of pins.filter((m) => m.author?.id === me.id && m.content.startsWith("🔒"))) await api.raw("DELETE", `/channels/${ch.id}/messages/${m.id}`);
    }
  }
  return done;
}

// ---------------------------------------------------------------- booster gamification (team proposal, owner "A", 2026-11-09)

/** Tiers by how long a member has boosted without a break (Discord's premium_since). Each member holds only the highest. */
export const BOOSTER_TIERS = [
  { name: "Booster 6M", days: 180, color: 0x7a3df0 },
  { name: "Booster 3M", days: 90, color: 0x9455f5 },
  { name: "Booster 1M", days: 30, color: 0xa96bff },
] as const;
/** Rooms only long-term boosters (and staff) see. */
export const TIER_ROOMS = [
  { name: "Booster Stage", type: 2, from: "Booster 3M", topic: "" },
  { name: "inner-circle", type: 0, from: "Booster 6M", topic: "Boosters of six months or more, with the team. Earliest feature trials and direct conversations with the people building Orrery." },
] as const;
/** Server boost levels and the boosts each needs. */
export const BOOST_LEVELS = [
  { level: 1, boosts: 2 },
  { level: 2, boosts: 7 },
  { level: 3, boosts: 14 },
] as const;

export function tierFor(premiumSince: string | null | undefined, now = new Date()): string | null {
  if (!premiumSince) return null;
  const days = (now.getTime() - new Date(premiumSince).getTime()) / 86_400_000;
  return BOOSTER_TIERS.find((t) => days >= t.days)?.name ?? null;
}

type MemberRow = { user: { id: string }; roles: string[]; premium_since?: string | null };

/**
 * Creates the tier roles and tier rooms once, then gives each booster the role of their tier and takes away the ones that
 * no longer fit (a longer boost moves them up; an ended boost removes all of them). Reading members needs the Server
 * Members Intent; without it the roles and rooms still exist and the run says so.
 */
export async function ensureBoosterTiers(api: DiscordApi, guildId: string, now = new Date()): Promise<string[]> {
  const done: string[] = [];
  let roles = (await api.raw("GET", `/guilds/${guildId}/roles`)) as RoleRow[];
  if (!roles.some((r) => r.tags && "premium_subscriber" in r.tags)) return done; // nothing before the first boost
  for (const t of [...BOOSTER_TIERS].reverse()) {
    if (!roles.some((r) => r.name === t.name)) {
      await api.raw("POST", `/guilds/${guildId}/roles`, { name: t.name, color: t.color, hoist: false, mentionable: false, permissions: "0" });
      done.push(`role ${t.name} created`);
    }
  }
  roles = (await api.raw("GET", `/guilds/${guildId}/roles`)) as RoleRow[];
  const id = (n: string) => roles.find((r) => r.name === n)?.id;
  const me = (await api.raw("GET", "/users/@me")) as { id: string };
  const bot = roles.find((r) => r.tags?.bot_id === me.id);
  const chans = (await api.raw("GET", `/guilds/${guildId}/channels`)) as ChannelRow[];
  const community = chans.find((c) => c.type === 4 && c.name.toUpperCase() === "COMMUNITY");
  const VOICE = B(20) | B(21) | B(25); // connect, speak, voice activity
  for (const room of TIER_ROOMS) {
    const eligible = BOOSTER_TIERS.slice(0, BOOSTER_TIERS.findIndex((t) => t.name === room.from) + 1).map((t) => id(t.name)).filter(Boolean) as string[];
    const perms = room.type === 2 ? UP.VIEW | VOICE : UP.VIEW | UP.SEND | UP.HISTORY | UP.EMBED | UP.ATTACH;
    const ow: Overwrite[] = [{ id: guildId, type: 0, allow: "0", deny: UP.VIEW.toString() }];
    for (const r of [...eligible, ...STAFF_ROLES.map((n) => id(n)).filter(Boolean) as string[]]) ow.push({ id: r, type: 0, allow: perms.toString(), deny: "0" });
    if (bot) ow.push({ id: bot.id, type: 0, allow: (UP.VIEW | UP.SEND | UP.HISTORY).toString(), deny: "0" });
    const have = chans.find((c) => c.name === room.name && c.type === room.type);
    if (!have) {
      await api.raw("POST", `/guilds/${guildId}/channels`, { name: room.name, type: room.type, parent_id: community?.id, permission_overwrites: ow, ...(room.topic ? { topic: room.topic } : {}) });
      done.push(`${room.type === 2 ? "voice" : "#"}${room.name} created`);
    } else if (!sameOverwrites(have.permission_overwrites ?? [], ow)) {
      await api.raw("PATCH", `/channels/${have.id}`, { permission_overwrites: ow });
      done.push(`${room.name} access restored`);
    }
  }
  // members: page through the guild (Server Members Intent)
  const members: MemberRow[] = [];
  let after = "0";
  try {
    for (;;) {
      const page = (await api.raw("GET", `/guilds/${guildId}/members?limit=1000&after=${after}`)) as MemberRow[];
      members.push(...page);
      if (page.length < 1000) break;
      after = page[page.length - 1]!.user.id;
    }
  } catch (e) {
    if (String((e as Error).message).includes(": 403")) return [...done, "members not readable: enable Server Members Intent in the Developer Portal"];
    throw e;
  }
  const tierIds = Object.fromEntries(BOOSTER_TIERS.map((t) => [t.name, id(t.name)!]));
  for (const m of members) {
    const want = tierFor(m.premium_since, now);
    for (const t of BOOSTER_TIERS) {
      const has = m.roles.includes(tierIds[t.name]!);
      if (t.name === want && !has) { await api.addRole(m.user.id, tierIds[t.name]!); done.push(`${m.user.id} -> ${t.name}`); }
      if (t.name !== want && has) { await api.removeRole(m.user.id, tierIds[t.name]!); done.push(`${m.user.id} left ${t.name}`); }
    }
  }
  return done;
}

/** The progress line for #boosters: boosts now, the level, and what the next level needs. */
export function boostProgressMessage(boosts: number, level: number): string {
  const next = BOOST_LEVELS.find((l) => l.boosts > boosts);
  const head = `**Boosts: ${boosts}** · Server level ${level}`;
  if (!next) return `${head}\nLevel 3 reached, which unlocks the custom server link. Thanks, boosters.`;
  const more = next.boosts - boosts;
  const perk = next.level === 3 ? "a custom invite link for Orrery" : next.level === 2 ? "a banner and bigger uploads" : "extra emoji slots, higher audio quality and an animated icon";
  return `${head}\nLevel ${next.level} is ${more} ${more === 1 ? "boost" : "boosts"} away and brings ${perk}.`;
}

/**
 * Posts the boost count to the private #boosters when it changes, and alerts #alerts when it falls (Level 3's custom
 * link is lost when the server drops below 14). Remembers the last state in discord_posts.
 */
export async function boostProgress(sql: Sql, api: DiscordApi, guildId: string): Promise<string[]> {
  const g = (await api.raw("GET", `/guilds/${guildId}`)) as { premium_subscription_count?: number; premium_tier?: number };
  const boosts = g.premium_subscription_count ?? 0;
  const level = g.premium_tier ?? 0;
  const [last] = await sql<{ key: string }[]>`select key from discord_posts where kind = 'boost-state' order by posted_at desc limit 1`;
  const key = `${boosts}:${level}`;
  if (last?.key === key) return [];
  await sql`insert into discord_posts (kind, key) values ('boost-state', ${key}) on conflict (kind, key) do update set posted_at = now()`;
  const prev = last ? Number(last.key.split(":")[0]) : null;
  const prevLevel = last ? Number(last.key.split(":")[1]) : null;
  const ch = await channelIds(api);
  const done: string[] = [];
  if (ch.boosters && boosts > 0) { await api.post(ch.boosters, boostProgressMessage(boosts, level)); done.push(`progress ${key}`); }
  if (ch.alerts && prev !== null && boosts < prev) {
    const l3 = BOOST_LEVELS[2].boosts;
    const lost = prevLevel !== null && level < prevLevel ? ` Server level went from ${prevLevel} to ${level}.` : "";
    const near = boosts < l3 && prev >= l3 ? " Keeping the custom server link takes 14 boosts." : "";
    await api.post(ch.alerts, `⚠️ Boost count went from ${prev} to ${boosts}.${lost}${near}`);
    done.push("boost drop alert");
  }
  return done;
}

// ---------------------------------------------------------------- role order and the welcome room (2026-11-09)

/**
 * Role order below the bot, top first. Staff, then boosters (so their violet shows over the grey and colour of the
 * community roles), then the community roles. Roles above the bot are left alone; missing roles are skipped.
 */
export const ROLE_ORDER = [
  "Admin", "Core Team", "Moderator",
  "Booster 6M", "Booster 3M", "Booster 1M", BOOSTER_ROLE.name,
  "Builder", "Operator", "Merchant", "ORRY Holder", "Verified", "Member",
];

type PositionedRole = RoleRow & { position: number };
const ranksAbove = (a: PositionedRole, b: PositionedRole) => a.position > b.position || (a.position === b.position && BigInt(a.id) < BigInt(b.id));

/** Puts the roles below the bot in ROLE_ORDER. Changes nothing when the order already holds. */
export async function ensureRoleOrder(api: DiscordApi, guildId: string): Promise<string[]> {
  const roles = (await api.raw("GET", `/guilds/${guildId}/roles`)) as PositionedRole[];
  const me = (await api.raw("GET", "/users/@me")) as { id: string };
  const bot = roles.find((r) => r.tags?.bot_id === me.id);
  if (!bot) return [];
  const below = ROLE_ORDER.map((n) => roles.find((r) => r.name === n)).filter((r): r is PositionedRole => !!r && ranksAbove(bot, r));
  const inOrder = below.every((r, i) => i === 0 || ranksAbove(below[i - 1]!, r));
  if (inOrder) return [];
  // Discord numbers positions from the bottom and a bot may only place roles below its own position. While every role still
  // shares one position (a new server), there is no room below the bot: the owner drags any role once to number them.
  if (bot.position <= below.length) return ["role order waits: in Server Settings > Roles drag OrreryBot to the top once"];
  const top = bot.position - 1;
  const payload = below.map((r, i) => ({ id: r.id, position: top - i }));
  await api.raw("PATCH", `/guilds/${guildId}/roles`, payload);
  return [`role order set: ${below.map((r) => r.name).join(" > ")}`];
}

export const WELCOME_ROOM = { name: "new-members", topic: "New arrivals are greeted here by the Orrery bot. Introduce yourself in #introductions." };

export function welcomeMessage(userIds: string[], ch: Record<string, string>): string {
  const link = (n: string) => (ch[n] ? `<#${ch[n]}>` : `#${n}`);
  const who = userIds.map((u) => `<@${u}>`).join(", ");
  return `${who}, welcome aboard Orrery. Read ${link("rules")} first, introduce yourself in ${link("introductions")}, and connect your wallet with \`/verify\`. Nobody from the team will message you first.`;
}

/**
 * Keeps the read-only #new-members room (only the bot posts; members may react) and welcomes members who joined since
 * the last pass. The first run marks everyone already in the server as welcomed without posting. More than five new
 * members at once (a raid or a wave) get one shared message.
 */
export async function welcomeNewMembers(sql: Sql, api: DiscordApi, guildId: string, now = new Date()): Promise<string[]> {
  const done: string[] = [];
  const roles = (await api.raw("GET", `/guilds/${guildId}/roles`)) as RoleRow[];
  const me = (await api.raw("GET", "/users/@me")) as { id: string };
  const bot = roles.find((r) => r.tags?.bot_id === me.id);
  const chans = (await api.raw("GET", `/guilds/${guildId}/channels`)) as (ChannelRow & { position?: number })[];
  const start = chans.find((c) => c.type === 4 && c.name.toUpperCase() === "START HERE");
  const NO_POST = UP.SEND | B(38) | B(35) | B(36); // send, send in threads, create public and private threads
  const ow: Overwrite[] = [{ id: guildId, type: 0, allow: (UP.VIEW | UP.HISTORY | B(6)).toString(), deny: NO_POST.toString() }];
  for (const n of STAFF_ROLES.slice(1)) { const r = roles.find((x) => x.name === n); if (r) ow.push({ id: r.id, type: 0, allow: "0", deny: NO_POST.toString() }); }
  if (bot) ow.push({ id: bot.id, type: 0, allow: (UP.VIEW | UP.SEND | UP.EMBED | UP.HISTORY).toString(), deny: "0" });
  let room = chans.find((c) => c.type === 0 && c.name === WELCOME_ROOM.name);
  if (!room) {
    room = (await api.raw("POST", `/guilds/${guildId}/channels`, { name: WELCOME_ROOM.name, type: 0, topic: WELCOME_ROOM.topic, parent_id: start?.id, permission_overwrites: ow })) as ChannelRow;
    done.push("#new-members created");
  } else if (!sameOverwrites(room.permission_overwrites ?? [], ow)) {
    await api.raw("PATCH", `/channels/${room.id}`, { permission_overwrites: ow });
    done.push("#new-members kept bot-only");
  }
  const members: { user: { id: string; bot?: boolean }; joined_at: string }[] = [];
  let after = "0";
  try {
    for (;;) {
      const page = (await api.raw("GET", `/guilds/${guildId}/members?limit=1000&after=${after}`)) as typeof members;
      members.push(...page);
      if (page.length < 1000) break;
      after = page[page.length - 1]!.user.id;
    }
  } catch (e) {
    if (String((e as Error).message).includes(": 403")) return [...done, "members not readable: enable Server Members Intent"];
    throw e;
  }
  const humans = members.filter((m) => !m.user.bot);
  const seen = new Set((await sql<{ key: string }[]>`select key from discord_posts where kind = 'welcome'`).map((r) => r.key));
  const mark = async (ids: string[]) => {
    if (ids.length) await sql`insert into discord_posts (kind, key) select 'welcome', unnest(${ids}::text[]) on conflict do nothing`;
  };
  if (seen.size === 0) {
    await mark(humans.map((m) => m.user.id));
    return [...done, `welcome baseline: ${humans.length} members`];
  }
  const fresh = humans.filter((m) => !seen.has(m.user.id));
  const recent = fresh.filter((m) => now.getTime() - new Date(m.joined_at).getTime() < 24 * 3600_000).map((m) => m.user.id);
  const old = fresh.filter((m) => !recent.includes(m.user.id)).map((m) => m.user.id);
  await mark(old);
  if (!recent.length) return done;
  const ch = Object.fromEntries(chans.map((c) => [c.name, c.id]));
  const groups = recent.length > 5 ? [recent.slice(0, 20)] : recent.map((u) => [u]);
  for (const g of groups) {
    await api.raw("POST", `/channels/${room.id}/messages`, { content: welcomeMessage(g, ch), allowed_mentions: { users: g } });
  }
  await mark(recent);
  return [...done, `welcomed ${recent.length}`];
}
