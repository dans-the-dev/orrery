import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  alertsFor, applyRoles, buildApi, burnMessage, formatOrry, handleInteraction, releaseMessage, rolesFor, verificationMessage, verifyInteraction,
  type Chain, type Config, type DiscordApi, type DiscordConfig, type Sql,
} from "@orrery/server";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12).toString("hex");
const signed = (ts: string, body: string) => sign(null, Buffer.from(ts + body), privateKey).toString("hex");

describe("Discord interactions signature", () => {
  it("accepts Discord's signature and refuses a changed body or another key", () => {
    const body = JSON.stringify({ type: 1 });
    const sig = signed("1700000000", body);
    expect(verifyInteraction(pubHex, sig, "1700000000", body)).toBe(true);
    expect(verifyInteraction(pubHex, sig, "1700000000", body.replace("1", "2"))).toBe(false);
    expect(verifyInteraction(pubHex, sig, "1700000001", body)).toBe(false);
    expect(verifyInteraction("00".repeat(32), sig, "1700000000", body)).toBe(false);
    expect(verifyInteraction(pubHex, "zz", "1700000000", body)).toBe(false);
  });

  it("the API answers a signed PING and refuses an unsigned one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-discord-"));
    writeFileSync(join(dir, "t"), "test-token");
    process.env.ORRERY_DISCORD_TOKEN_FILE = join(dir, "t");
    process.env.ORRERY_DISCORD_GUILD = "1569204585011220480";
    process.env.ORRERY_DISCORD_PUBLIC_KEY = pubHex;
    try {
      const cfg = { chainId: 4663, corsOrigins: [], publicRatePerMinute: 60, trustProxy: false, addresses: {}, pricing: { checksPerMinute: 120, planChecksPerMinute: 1200 }, releaseSeed: { chainId: 4663 }, releasesCacheMs: 0 } as unknown as Config;
      const app = buildApi(cfg, {} as Chain, (() => { throw new Error("no db"); }) as unknown as Sql);
      const body = JSON.stringify({ type: 1 });
      const ok = await app.inject({ method: "POST", url: "/v1/discord/interactions", payload: body, headers: { "content-type": "application/json", "x-signature-ed25519": signed("1700000000", body), "x-signature-timestamp": "1700000000" } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ type: 1 });
      const bad = await app.inject({ method: "POST", url: "/v1/discord/interactions", payload: body, headers: { "content-type": "application/json", "x-signature-ed25519": "00".repeat(64), "x-signature-timestamp": "1700000000" } });
      expect(bad.statusCode).toBe(401);
    } finally {
      delete process.env.ORRERY_DISCORD_TOKEN_FILE;
      delete process.env.ORRERY_DISCORD_GUILD;
      delete process.env.ORRERY_DISCORD_PUBLIC_KEY;
    }
  });

  it("rejects malformed addresses without reading the chain", async () => {
    const d = { webUrl: "https://orrery.tech" } as DiscordConfig;
    const r = (await handleInteraction({} as Config, {} as Chain, {} as Sql, d, { type: 2, data: { name: "payer", options: [{ name: "address", value: "nope" }] } })) as { data: { content: string; flags: number } };
    expect(r.data.content).toBe("Pass a 0x address.");
    expect(r.data.flags).toBe(64);
  });
});

describe("roles", () => {
  it("gives roles from facts", () => {
    expect(rolesFor({ orryHeld: 0n, orryStaked: 0n, agentsOwned: 0n, creditPurchases: 0 })).toEqual(["Verified"]);
    expect(rolesFor({ orryHeld: 0n, orryStaked: 5n, agentsOwned: 1n, creditPurchases: 2 })).toEqual(["Verified", "ORRY Holder", "Operator", "Merchant"]);
  });

  it("adds what is missing and removes what no longer applies, only for automatic roles", async () => {
    const calls: string[] = [];
    const api = { addRole: async (_u: string, r: string) => void calls.push(`+${r}`), removeRole: async (_u: string, r: string) => void calls.push(`-${r}`) } as unknown as DiscordApi;
    const ids = { Verified: "v", "ORRY Holder": "h", Operator: "o", Merchant: "m", Admin: "a" };
    await applyRoles(api, ids, "u", ["Verified", "Merchant", "Admin"], ["Verified", "ORRY Holder"]);
    expect(calls.sort()).toEqual(["+h", "-m"]);
  });
});

describe("notifier messages", () => {
  it("formats burns, releases and alerts", () => {
    expect(formatOrry("1234500000000000000000")).toBe("1,234.5");
    expect(burnMessage({ amount: "2000000000000000000", source: "2", tx: "0xabc" }, "https://x")).toBe("🔥 2 ORRY burned · check packs paid in ORRY\nhttps://x/tx/0xabc");
    expect(burnMessage({ amount: "89720000000000000000", source: "5", tx: "0xdef" }, "https://x")).toBe("🔥 89.72 ORRY burned · market orders, sealing fee\nhttps://x/tx/0xdef");
    expect(releaseMessage("earn", "https://orrery.tech")).toContain("https://orrery.tech/earn");
    const a = alertsFor({ lag: { lag: 900n }, orryLag: { lag: 5n }, orryOn: true, maxLag: 600n, confirmations: 10, balances: [{ name: "keeper", address: "0x1", eth: 0.0005, minEth: 0.001 }, { name: "relayer", address: "0x2", eth: 1, minEth: 0.0001 }] });
    expect(a.map((x) => x.key)).toEqual(["indexer-lag", "low-gas-keeper"]);
    expect(alertsFor({ lag: { lag: 1n }, orryLag: null, orryOn: false, maxLag: 600n, confirmations: 10, balances: [] })).toEqual([]);
  });

  it("the verification message names the member and the nonce", () => {
    expect(verificationMessage("42", "ab")).toBe("Orrery Discord verification\nDiscord user: 42\nNonce: ab");
  });
});

describe("release rooms and cards", () => {
  it("maps features to rooms and opens them for members, read-only rooms stay read-only", async () => {
    const { roomsFor, openRooms } = await import("@orrery/server");
    expect(roomsFor("earn").sort()).toEqual(["earn-and-stake", "orry-chat"]);
    expect(roomsFor("core").length).toBe(4);
    const calls: [string, bigint, bigint][] = [];
    const api = { setRoleOverwrite: async (c: string, _r: string, allow: bigint, deny: bigint) => void calls.push([c, allow, deny]) } as unknown as DiscordApi;
    const opened = await openRooms(api, { "orry-chat": "1", "earn-and-stake": "2", "burn-tracker": "3" }, { Member: "m" }, "earn");
    expect(opened.sort()).toEqual(["earn-and-stake", "orry-chat"]);
    const SEND = 1n << 11n;
    expect(calls.every(([, allow, deny]) => (allow & SEND) === SEND && deny === 0n)).toBe(true);
    calls.length = 0;
    await openRooms(api, { "burn-tracker": "3" }, { Member: "m" }, "burn");
    expect((calls[0]?.[2] ?? 0n) & SEND).toBe(SEND);
  });

  it("uses the reviewed caption and image when present, the plain text otherwise", async () => {
    const { releaseCard } = await import("@orrery/server");
    const dir = mkdtempSync(join(tmpdir(), "rc-cards-"));
    writeFileSync(join(dir, "captions.json"), JSON.stringify({ earn: "Reviewed caption" }));
    writeFileSync(join(dir, "earn.png"), Buffer.from([137, 80, 78, 71]));
    const withCard = releaseCard("earn", { cardsDir: dir, webUrl: "https://orrery.tech" });
    expect(withCard.caption).toBe("Reviewed caption");
    expect(withCard.png?.length).toBe(4);
    const plain = releaseCard("stake", { cardsDir: dir, webUrl: "https://orrery.tech" });
    expect(plain.png).toBeNull();
    expect(plain.caption).toContain("https://orrery.tech/stake");
  });

  it("/announce refuses members without Admin or Core Team", async () => {
    const api = { roles: async () => [{ id: "adm", name: "Admin" }, { id: "core", name: "Core Team" }] } as unknown as DiscordApi;
    const r = (await handleInteraction({} as Config, {} as Chain, {} as Sql, {} as DiscordConfig, { type: 2, data: { name: "announce", options: [{ name: "feature", value: "earn" }] }, member: { user: { id: "1" }, roles: ["x"] } }, api)) as { data: { content: string } };
    expect(r.data.content).toBe("Only Admin and Core Team can approve announcements.");
  });
});

describe("upkeep runs unattended", () => {
  // A tiny in-memory Discord: roles, channels, pins, and a log of writes.
  function fakeGuild(opts: { booster: boolean }) {
    const G = "100";
    const roles: Record<string, unknown>[] = [
      { id: G, name: "@everyone", color: 0, hoist: false, mentionable: false, permissions: "0" },
      { id: "bot", name: "OrreryBot", color: 0, hoist: false, mentionable: false, permissions: "8", tags: { bot_id: "me" } },
      { id: "adm", name: "Admin", color: 0, hoist: true, mentionable: false, permissions: "8" },
      { id: "mem", name: "Member", color: 0, hoist: false, mentionable: false, permissions: "0" },
    ];
    if (opts.booster) roles.push({ id: "boo", name: "Server Booster", color: 0xf47fff, hoist: false, mentionable: false, permissions: "0", tags: { premium_subscriber: null } });
    const chans: Record<string, unknown>[] = [
      { id: "cat", name: "COMMUNITY", type: 4 },
      { id: "c1", name: "orry-chat", type: 0, permission_overwrites: [{ id: "mem", type: 0, allow: "1024", deny: "0" }] },
      { id: "c2", name: "operators", type: 0, permission_overwrites: [] },
    ];
    const pins: Record<string, Record<string, unknown>[]> = {};
    const writes: string[] = [];
    let n = 0;
    const raw = async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method !== "GET") writes.push(`${method} ${path}`);
      if (path === `/guilds/${G}/roles` && method === "GET") return roles;
      if (path === `/guilds/${G}/channels` && method === "GET") return chans;
      if (path === "/users/@me") return { id: "me" };
      if (path.startsWith(`/guilds/${G}/roles/`) && method === "PATCH") { Object.assign(roles.find((r) => path.endsWith(String(r.id)))!, body); return {}; }
      if (path === `/guilds/${G}/channels` && method === "POST") { const c = { id: `new${++n}`, type: 0, ...body }; chans.push(c); return c; }
      if (path.startsWith("/channels/") && path.endsWith("/pins") && method === "GET") return pins[path.split("/")[2]!] ?? [];
      if (path.endsWith("/messages") && method === "POST") { const ch = path.split("/")[2]!; const m = { id: `m${++n}`, author: { id: "me" }, content: body!.content }; (pins[ch] ??= []).push(m); return m; }
      return {};
    };
    const api = {
      raw,
      setRoleOverwrite: async (c: string, r: string, allow: bigint, deny: bigint) => {
        writes.push(`overwrite ${c}`);
        const ch = chans.find((x) => x.id === c)!;
        const ow = ((ch.permission_overwrites as Record<string, unknown>[]) ?? []).filter((o) => o.id !== r);
        ow.push({ id: r, type: 0, allow: allow.toString(), deny: deny.toString() });
        ch.permission_overwrites = ow;
      },
    } as unknown as DiscordApi;
    return { G, api, roles, chans, pins, writes };
  }

  it("does nothing before the first boost", async () => {
    const { ensureBoosters } = await import("@orrery/server");
    const g = fakeGuild({ booster: false });
    expect(await ensureBoosters(g.api, g.G)).toEqual([]);
    expect(g.writes).toEqual([]);
  });

  it("styles the booster role, opens the private lounge and pins the welcome once", async () => {
    const { ensureBoosters, BOOSTER_ROLE } = await import("@orrery/server");
    const g = fakeGuild({ booster: true });
    expect(await ensureBoosters(g.api, g.G)).toEqual(["booster role styled", "#boosters created", "#boosters welcome pinned"]);
    const role = g.roles.find((r) => r.id === "boo")!;
    expect(role.name).toBe(BOOSTER_ROLE.name);
    const lounge = g.chans.find((c) => c.name === "boosters")!;
    const everyone = (lounge.permission_overwrites as { id: string; deny: string }[]).find((o) => o.id === g.G)!;
    expect(BigInt(everyone.deny) & (1n << 10n)).toBe(1n << 10n);
    g.writes.length = 0;
    expect(await ensureBoosters(g.api, g.G)).toEqual([]);
    expect(g.writes).toEqual([]);
  });

  it("hides feature rooms until the release opens, then opens them on its own", async () => {
    const { syncFeatureRooms } = await import("@orrery/server");
    const g = fakeGuild({ booster: false });
    let released: { feature: string }[] = [];
    const sql = (() => Promise.resolve(released)) as unknown as Sql;
    expect((await syncFeatureRooms(sql, g.api, g.G)).sort()).toEqual(["#operators hidden", "#orry-chat hidden"]);
    expect(await syncFeatureRooms(sql, g.api, g.G)).toEqual([]);
    released = [{ feature: "earn" }];
    expect(await syncFeatureRooms(sql, g.api, g.G)).toEqual(["#orry-chat opened"]);
    const ow = (g.chans.find((c) => c.id === "c1")!.permission_overwrites as { id: string; allow: string }[]).find((o) => o.id === "mem")!;
    expect(BigInt(ow.allow) & (1n << 11n)).toBe(1n << 11n);
  });
});

describe("booster gamification", () => {
  it("places boosters in the tier their unbroken boost has reached", async () => {
    const { tierFor } = await import("@orrery/server");
    const now = new Date("2026-12-01T00:00:00Z");
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
    expect(tierFor(null, now)).toBeNull();
    expect(tierFor(ago(10), now)).toBeNull();
    expect(tierFor(ago(31), now)).toBe("Booster 1M");
    expect(tierFor(ago(95), now)).toBe("Booster 3M");
    expect(tierFor(ago(400), now)).toBe("Booster 6M");
  });

  it("says how many boosts the next level needs", async () => {
    const { boostProgressMessage } = await import("@orrery/server");
    expect(boostProgressMessage(1, 0)).toContain("1 more boost reach Level 1");
    expect(boostProgressMessage(9, 2)).toContain("5 more boosts reach Level 3, which unlocks a custom server link");
    expect(boostProgressMessage(14, 3)).toContain("Level 3 is unlocked");
  });

  it("moves a booster up a tier and removes tiers when the boost ends", async () => {
    const { ensureBoosterTiers } = await import("@orrery/server");
    const G = "100";
    const roles: Record<string, unknown>[] = [
      { id: G, name: "@everyone", permissions: "0" }, { id: "bot", name: "OrreryBot", permissions: "8", tags: { bot_id: "me" } },
      { id: "boo", name: "Orrery Booster", permissions: "0", tags: { premium_subscriber: null } },
      { id: "t1", name: "Booster 1M", permissions: "0" }, { id: "t3", name: "Booster 3M", permissions: "0" }, { id: "t6", name: "Booster 6M", permissions: "0" },
      { id: "adm", name: "Admin", permissions: "8" },
    ];
    const now = new Date("2026-12-01T00:00:00Z");
    const members = [
      { user: { id: "a" }, roles: ["t1"], premium_since: new Date(now.getTime() - 100 * 86_400_000).toISOString() },
      { user: { id: "b" }, roles: ["t3"], premium_since: null },
    ];
    const calls: string[] = [];
    const api = {
      raw: async (method: string, path: string) => {
        if (path === `/guilds/${G}/roles`) return roles;
        if (path === "/users/@me") return { id: "me" };
        if (path === `/guilds/${G}/channels` && method === "GET") return [{ id: "cat", name: "COMMUNITY", type: 4 }, { id: "v", name: "Booster Stage", type: 2, permission_overwrites: [] }, { id: "ic", name: "inner-circle", type: 0, permission_overwrites: [] }];
        if (path.startsWith(`/guilds/${G}/members`)) return members;
        return {};
      },
      addRole: async (u: string, r: string) => void calls.push(`+${u}:${r}`),
      removeRole: async (u: string, r: string) => void calls.push(`-${u}:${r}`),
    } as unknown as DiscordApi;
    await ensureBoosterTiers(api, G, now);
    expect(calls.sort()).toEqual(["+a:t3", "-a:t1", "-b:t3"]);
  });
});

describe("role order and welcomes", () => {
  it("puts boosters above the community roles, and waits while positions are not numbered", async () => {
    const { ensureRoleOrder } = await import("@orrery/server");
    const mk = (pos: Record<string, number>) => Object.entries(pos).map(([name, position], i) => ({ id: String(10 + i), name, position, permissions: "0", color: 0, hoist: false, mentionable: false, ...(name === "OrreryBot" ? { tags: { bot_id: "me" } } : {}) }));
    let sent: unknown = null;
    const apiFor = (roles: unknown[]) => ({ raw: async (m: string, p: string, b?: unknown) => { if (m === "PATCH") sent = b; return p === "/users/@me" ? { id: "me" } : roles; } }) as unknown as DiscordApi;
    expect(await ensureRoleOrder(apiFor(mk({ OrreryBot: 1, Member: 1, "Orrery Booster": 1 })), "G")).toEqual(["role order waits: in Server Settings > Roles drag OrreryBot to the top once"]);
    const out = await ensureRoleOrder(apiFor(mk({ OrreryBot: 10, Member: 3, "Orrery Booster": 2, Verified: 4 })), "G");
    expect(out[0]).toContain("Orrery Booster > Verified > Member");
    expect((sent as { position: number }[]).map((x) => x.position)).toEqual([9, 8, 7]);
    sent = null;
    expect(await ensureRoleOrder(apiFor(mk({ OrreryBot: 10, Member: 3, "Orrery Booster": 5, Verified: 4 })), "G")).toEqual([]);
    expect(sent).toBeNull();
  });

  it("welcomes only members who joined since the last pass, after a silent first baseline", async () => {
    const { welcomeNewMembers } = await import("@orrery/server");
    const now = new Date("2026-12-01T12:00:00Z");
    let members = [{ user: { id: "a" }, joined_at: "2026-11-01T00:00:00Z" }, { user: { id: "bot1", bot: true }, joined_at: "2026-11-01T00:00:00Z" }];
    const posts: string[] = [];
    const store = new Set<string>();
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join("?");
      if (q.startsWith("select key from discord_posts")) return Promise.resolve([...store].map((key) => ({ key })));
      if (q.includes("insert into discord_posts")) { for (const id of vals[0] as string[]) store.add(id); return Promise.resolve([]); }
      return Promise.resolve([]);
    }) as unknown as Sql;
    const api = {
      raw: async (m: string, p: string, b?: { content: string }) => {
        if (p === "/users/@me") return { id: "me" };
        if (p.endsWith("/roles")) return [{ id: "bot", name: "OrreryBot", tags: { bot_id: "me" }, permissions: "8" }];
        if (p.endsWith("/channels") && m === "GET") return [{ id: "sh", name: "START HERE", type: 4 }, { id: "nm", name: "new-members", type: 0, permission_overwrites: [] }];
        if (p.includes("/members")) return members;
        if (m === "POST" && p.endsWith("/messages")) posts.push(b!.content);
        return {};
      },
    } as unknown as DiscordApi;
    const first = await welcomeNewMembers(sql, api, "G", now);
    expect(first.some((x) => x.startsWith("welcome baseline: 1"))).toBe(true);
    expect(posts).toEqual([]);
    members = [...members, { user: { id: "b" }, joined_at: "2026-12-01T11:59:00Z" }];
    await welcomeNewMembers(sql, api, "G", now);
    expect(posts.length).toBe(1);
    expect(posts[0]).toContain("<@b>");
    expect(posts[0]).toContain("never DMs you first");
    await welcomeNewMembers(sql, api, "G", now);
    expect(posts.length).toBe(1);
  });
});

describe("Discord test mode (development network on the community server)", () => {
  const base = { ORRERY_DISCORD_TOKEN_FILE: "", ORRERY_DISCORD_GUILD: "1" };
  it("reads the private test channel and stays off without it", async () => {
    const { loadDiscordConfig } = await import("@orrery/server");
    const dir = mkdtempSync(join(tmpdir(), "rc-test-"));
    writeFileSync(join(dir, "t"), "x");
    expect(loadDiscordConfig({ ...base, ORRERY_DISCORD_TOKEN_FILE: join(dir, "t"), ORRERY_DISCORD_TEST_CHANNEL: "#dev-lab" })?.testChannel).toBe("dev-lab");
    expect(loadDiscordConfig({ ...base, ORRERY_DISCORD_TOKEN_FILE: join(dir, "t") })?.testChannel).toBeNull();
  });

  it("links transactions to the explorer of the chain the process runs on", async () => {
    const { loadDiscordConfig } = await import("@orrery/server");
    const dir = mkdtempSync(join(tmpdir(), "rc-test-"));
    writeFileSync(join(dir, "t"), "x");
    const env = { ...base, ORRERY_DISCORD_TOKEN_FILE: join(dir, "t") };
    expect(loadDiscordConfig({ ...env, ORRERY_CHAIN_ID: "4663" })?.explorer).toBe("https://robinhoodchain.blockscout.com");
    expect(loadDiscordConfig({ ...env, ORRERY_CHAIN_ID: "46630" })?.explorer).toBe("https://explorer.testnet.chain.robinhood.com");
    expect(loadDiscordConfig(env)?.explorer).toBe("https://robinhoodchain.blockscout.com");
    expect(loadDiscordConfig({ ...env, ORRERY_CHAIN_ID: "46630", ORRERY_EXPLORER_URL: "https://scan.example/" })?.explorer).toBe("https://scan.example");
  });

  const d = { testChannel: "dev-lab", webUrl: "https://dev.example" } as unknown as DiscordConfig;
  const api = { channels: async () => [{ id: "lab", name: "dev-lab", type: 0 }, { id: "ann", name: "announcements", type: 0 }] } as unknown as DiscordApi;
  const cfg = { orry: null } as unknown as Config;
  const cmd = (channel_id: string) => ({ type: 2, channel_id, data: { name: "orry" }, member: { user: { id: "u" } } });

  it("answers commands only in the test channel", async () => {
    const outside = (await handleInteraction(cfg, {} as Chain, {} as Sql, d, cmd("ann"), api)) as { data: { content: string; flags: number } };
    expect(outside.data.content).toMatch(/answer in #dev-lab/);
    expect(outside.data.flags).toBe(64);
    const inside = (await handleInteraction(cfg, {} as Chain, {} as Sql, d, cmd("lab"), api)) as { data: { content: string } };
    expect(inside.data.content).toMatch(/ORRY stats appear here/);
  });

  it("an approved announcement goes to the test channel, never to #announcements", async () => {
    const { announceRelease } = await import("@orrery/server");
    const posts: string[] = [];
    const sql = (async () => [{ key: "earn" }]) as unknown as Sql;
    const out = await announceRelease(sql, { post: async (c: string) => void posts.push(c) } as unknown as DiscordApi, { "dev-lab": "lab", announcements: "ann" }, { ...d, cardsDir: null } as DiscordConfig, "earn");
    expect(out).toBe("posted");
    expect(posts).toEqual(["lab"]);
  });

  it("role sync changes nothing", async () => {
    const { syncRoles } = await import("@orrery/server");
    const failing = { roles: async () => { throw new Error("must not be called"); } } as unknown as DiscordApi;
    expect(await syncRoles(cfg, {} as Chain, {} as Sql, failing, true)).toBe(0);
  });
});

describe("channel map", () => {
  it("includes Announcement channels, so /announce reaches #announcements", async () => {
    const { channelIds } = await import("@orrery/server");
    const api = { channels: async () => [
      { id: "1", name: "general", type: 0 },
      { id: "2", name: "announcements", type: 5 },
      { id: "3", name: "Voice", type: 2 },
      { id: "4", name: "TEAM", type: 4 },
    ] } as unknown as Parameters<typeof channelIds>[0];
    expect(await channelIds(api)).toEqual({ general: "1", announcements: "2" });
  });
});
