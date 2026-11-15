// Rewards members who boost the Orrery server. Discord creates its own managed "Server Booster" role at the first
// boost (tags.premium_subscriber) and gives it to every booster itself; nobody can assign it by hand. This script
// names and colours that role for Orrery, lists boosters as their own group in the member list, grants the booster
// perks and opens the private #boosters lounge under COMMUNITY. Before the first boost there is no role to style, so
// the script says so and changes nothing (or, with --wait, checks every few minutes and applies the moment it appears).
//
// Booster perks set here: links with previews and file uploads in every room they can write in (otherwise only Verified
// and staff), stickers from other servers, a coloured name listed separately, and the #boosters lounge.
// Perks the owner chose on 2026-11-09 that run through the team, not this script: release previews in #boosters before
// #announcements, first tester invites, a monthly thank-you drafted to #release-drafts; Coming soon: a Booster
// achievement paid from the Reward Pool and a short booster window in Agent Launch.
// Security baseline (harden.mjs, rooms.mjs) stays as it is: @everyone is not touched, boosters are not exempt from
// AutoMod (links outside the allowlist are still blocked for them), and a booster gets no overwrite in a locked room.
// Idempotent; the result is read back and checked at the end.
//
// Usage: node ops/discord/boosters.mjs <guildId> [--wait [minutes]] [--status] [--dry-run]
//   (none)     apply now if someone has boosted, otherwise report that the role does not exist yet and exit
//   --wait     check every 5 minutes (or the given number) until the first boost, apply, then exit
//   --status   read only: booster role, perks, lounge and boost count
//   --dry-run  print what would change, change nothing
// Token: ~/.secrets/orrery/discord-bot.txt
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const G = argv[0];
if (!/^\d{15,}$/.test(G ?? "")) throw new Error("usage: node boosters.mjs <guildId> [--wait [minutes]] [--status] [--dry-run]");
const dry = argv.includes("--dry-run");
const statusOnly = argv.includes("--status");
const waitAt = argv.indexOf("--wait");
const waitMinutes = waitAt < 0 ? 0 : Number(/^\d+$/.test(argv[waitAt + 1] ?? "") ? argv[waitAt + 1] : 5);
const token = readFileSync(join(homedir(), ".secrets/orrery/discord-bot.txt"), "utf8").trim();
async function call(method, path, body) {
  for (;;) {
    const r = await fetch("https://discord.com/api/v10" + path, { method, headers: { Authorization: `Bot ${token}`, "content-type": "application/json", "X-Audit-Log-Reason": "Orrery booster rewards" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { const j = await r.json(); await new Promise((res) => setTimeout(res, Math.ceil((j.retry_after ?? 1) * 1000) + 100)); continue; }
    if (r.status === 204) return null;
    const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`); return j;
  }
}
const B = (n) => 1n << BigInt(n);
const P = { VIEW: B(10), SEND: B(11), MANAGE_MESSAGES: B(13), EMBED: B(14), ATTACH: B(15), HISTORY: B(16), EXT_STICKERS: B(37) };
const s = (x) => x.toString();
const log = (m) => console.log(m);

// The booster role as Orrery shows it. Violet sets it apart from the blue staff roles and the amber, green and
// orange member roles in the member list.
const ROLE = { name: "Orrery Booster", color: 0xb46bff, hoist: true, mentionable: false, permissions: P.EMBED | P.ATTACH | P.EXT_STICKERS };
// Approved by the owner on 2026-11-09 ("Setuju, posting"); posted and pinned once when the lounge exists.
const LOUNGE_INFO = `**Welcome to #boosters**
Thank you for boosting Orrery. Every boost keeps the server upgraded for the whole community.

**What boosters get**
• **Orrery Booster role:** a violet name and your own section in the member list.
• **Images and files** in every room you can write in, with previews for official links.
• **Release previews:** the next release card and the features coming up land here before #announcements.
• **First tester invites:** when a new feature is ready to try on the development network, boosters hear first.
• **Monthly thank-you:** once a month the team thanks its boosters in #announcements.

**Coming soon**
• **Booster achievement** on the Achievement Board, paid from the Reward Pool. Link your wallet with /verify to be ready.
• **Agent Launch booster window:** boosters with a linked wallet get a short early window on new launches.`;
const LOUNGE = { name: "boosters", topic: "The boosters' lounge: release previews before #announcements and first invites to test new features. Thank you for boosting Orrery.", slowmode: 5 };
const STAFF = ["Admin", "Core Team", "Moderator"];

const isBoosterRole = (r) => r.tags && "premium_subscriber" in r.tags;
// Discord ranks roles by position, and among equal positions the older role (lower id) ranks higher.
const above = (a, b) => a.position > b.position || (a.position === b.position && BigInt(a.id) < BigInt(b.id));

async function state() {
  const [guild, roles, chans, me] = await Promise.all([call("GET", `/guilds/${G}`), call("GET", `/guilds/${G}/roles`), call("GET", `/guilds/${G}/channels`), call("GET", "/users/@me")]);
  return { guild, roles, chans, booster: roles.find(isBoosterRole), bot: roles.find((r) => r.tags?.bot_id === me.id) };
}

function loungeOverwrites(st) {
  const allow = (id, perms) => ({ id, type: 0, allow: s(perms), deny: "0" });
  const o = [{ id: G, type: 0, allow: "0", deny: s(P.VIEW) }, allow(st.booster.id, P.VIEW | P.SEND | P.HISTORY | P.EMBED | P.ATTACH)];
  for (const n of STAFF) { const r = st.roles.find((x) => x.name === n); if (r) o.push(allow(r.id, P.VIEW | P.SEND | P.HISTORY)); }
  if (st.bot) o.push(allow(st.bot.id, P.VIEW | P.SEND | P.EMBED | P.HISTORY | P.MANAGE_MESSAGES));
  return o;
}

async function apply(st) {
  const r = st.booster;
  if (st.bot && !above(st.bot, r)) throw new Error(`OrreryBot ranks below "${r.name}", so it cannot edit it. Drag OrreryBot above it in Server Settings > Roles and run again.`);
  const want = { name: ROLE.name, color: ROLE.color, hoist: ROLE.hoist, mentionable: ROLE.mentionable, permissions: s(ROLE.permissions) };
  const same = r.name === want.name && r.color === want.color && r.hoist === want.hoist && r.mentionable === want.mentionable && r.permissions === want.permissions;
  if (same) log(`role ok      ${r.name}`);
  else if (dry) log(`role update  "${r.name}" -> "${ROLE.name}", colour, listed separately, links + files + external stickers`);
  else { await call("PATCH", `/guilds/${G}/roles/${r.id}`, want); log(`role update  "${r.name}" -> "${ROLE.name}", colour, listed separately, links + files + external stickers`); }

  const community = st.chans.find((c) => c.type === 4 && c.name.toUpperCase() === "COMMUNITY");
  const lounge = st.chans.find((c) => c.type === 0 && c.name === LOUNGE.name);
  const body = { topic: LOUNGE.topic, parent_id: community?.id, rate_limit_per_user: LOUNGE.slowmode, permission_overwrites: loungeOverwrites(st) };
  if (dry) { log(`${lounge ? "lounge update" : "lounge create"} #${LOUNGE.name} under COMMUNITY (boosters and staff only)`); return; }
  if (lounge) { await call("PATCH", `/channels/${lounge.id}`, body); log(`lounge update #${LOUNGE.name}`); }
  else {
    const last = Math.max(0, ...st.chans.filter((c) => c.parent_id === community?.id).map((c) => c.position));
    await call("POST", `/guilds/${G}/channels`, { name: LOUNGE.name, type: 0, position: last + 1, ...body });
    log(`lounge create #${LOUNGE.name} under COMMUNITY`);
  }
  // the approved welcome message, posted and pinned once
  const id = lounge?.id ?? (await call("GET", `/guilds/${G}/channels`)).find((c) => c.type === 0 && c.name === LOUNGE.name)?.id;
  if (id) {
    const me = await call("GET", "/users/@me");
    const pins = await call("GET", `/channels/${id}/pins`);
    if (!pins.some((m) => m.author?.id === me.id && m.content.startsWith("**Welcome to #boosters**"))) {
      const m = await call("POST", `/channels/${id}/messages`, { content: LOUNGE_INFO, flags: 4, allowed_mentions: { parse: [] } });
      await call("PUT", `/channels/${id}/pins/${m.id}`);
      log("lounge info posted and pinned");
    }
  }
}

// Read back and compare with what this script sets. Returns the list of mismatches.
async function verify() {
  const st = await state();
  const bad = [];
  const r = st.booster;
  if (!r) return { st, bad: ["no booster role"] };
  if (r.name !== ROLE.name) bad.push(`role name is "${r.name}"`);
  if (r.color !== ROLE.color) bad.push(`role colour is #${r.color.toString(16)}`);
  if (r.hoist !== ROLE.hoist) bad.push("role is not listed separately");
  if (BigInt(r.permissions) !== ROLE.permissions) bad.push(`role permissions are ${r.permissions}`);
  const everyone = st.roles.find((x) => x.id === G);
  if (BigInt(everyone.permissions) & (P.EMBED | P.ATTACH)) bad.push("@everyone has links or files (baseline loosened)");
  const lounge = st.chans.find((c) => c.type === 0 && c.name === LOUNGE.name);
  if (!lounge) bad.push("no #boosters lounge");
  else {
    const ow = (id) => lounge.permission_overwrites.find((o) => o.id === id);
    if (!(BigInt(ow(G)?.deny ?? 0) & P.VIEW)) bad.push("#boosters is visible to @everyone");
    if (!(BigInt(ow(r.id)?.allow ?? 0) & P.SEND)) bad.push("boosters cannot write in #boosters");
    const community = st.chans.find((c) => c.type === 4 && c.name.toUpperCase() === "COMMUNITY");
    if (lounge.parent_id !== community?.id) bad.push("#boosters is not under COMMUNITY");
  }
  return { st, bad };
}

function report(st) {
  const r = st.booster;
  log(`boosts: ${st.guild.premium_subscription_count ?? 0}, boost level ${st.guild.premium_tier}`);
  if (!r) { log("booster role: not created yet (Discord creates it at the first boost)"); return; }
  const perms = Object.entries(P).filter(([, v]) => BigInt(r.permissions) & v).map(([k]) => k).join(", ") || "none";
  log(`booster role: "${r.name}" #${r.color.toString(16)} listed separately=${r.hoist} perms=${perms} position=${r.position}`);
  const lounge = st.chans.find((c) => c.type === 0 && c.name === LOUNGE.name);
  log(`lounge: ${lounge ? `#${lounge.name} ${lounge.id}` : "not created"}`);
  // Owner's order (2026-11-09): Admin > Core Team > Moderator > OrreryBot > booster > Builder > ... > Member.
  // The bot cannot move roles to or above its own place, so the order is reported here and set by the owner.
  const ranked = [...st.roles].filter((x) => x.id !== G).sort((a, b) => (above(a, b) ? -1 : 1));
  log(`role order: ${ranked.map((x) => x.name).join(" > ")}`);
  const i = ranked.findIndex((x) => x.id === r.id);
  if (st.bot && ranked[i - 1]?.id !== st.bot.id) log(`owner: in Server Settings > Roles, drag "${r.name}" to just below OrreryBot (above Builder).`);
}

let st = await state();
if (statusOnly) { report(st); process.exit(0); }
while (!st.booster && waitMinutes > 0) {
  log(`${new Date().toISOString()} no boost yet, checking again in ${waitMinutes} min`);
  await new Promise((res) => setTimeout(res, waitMinutes * 60_000));
  st = await state();
}
if (!st.booster) {
  log("Nobody has boosted yet, so Discord has not created the booster role. Nothing changed.");
  log(`Run again after the first boost (Discord posts it in #moderation-log): node ops/discord/boosters.mjs ${G}`);
  log(`Or leave a watcher running until then: node ops/discord/boosters.mjs ${G} --wait`);
  process.exit(0);
}
await apply(st);
if (dry) { log("dry run done, nothing changed"); process.exit(0); }
const { st: after, bad } = await verify();
report(after);
if (bad.length) { console.error("check failed: " + bad.join("; ")); process.exit(1); }
log("check ok: booster role, perks and lounge match, @everyone unchanged");
