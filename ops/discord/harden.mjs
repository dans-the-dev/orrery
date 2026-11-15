// Hardens the Orrery Discord server to the usual web3 community baseline: verification level, join messages away
// from public rooms, safety alerts, staff role permissions, a narrower @everyone, slowmode, and AutoMod rules
// against scam keywords, foreign links, impersonating names and spam. Idempotent (rules matched by name).
// Usage: node ops/discord/harden.mjs <guildId>   Token: ~/.secrets/orrery/discord-bot.txt
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const G = process.argv[2];
const token = readFileSync(join(homedir(), ".secrets/orrery/discord-bot.txt"), "utf8").trim();
async function call(method, path, body) {
  for (;;) {
    const r = await fetch("https://discord.com/api/v10" + path, { method, headers: { Authorization: `Bot ${token}`, "content-type": "application/json", "X-Audit-Log-Reason": "Orrery security baseline" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { const j = await r.json(); await new Promise((res) => setTimeout(res, Math.ceil((j.retry_after ?? 1) * 1000) + 100)); continue; }
    if (r.status === 204) return null;
    const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`); return j;
  }
}
const B = (n) => 1n << BigInt(n);
const P = { CREATE_INVITE: B(0), KICK: B(1), BAN: B(2), ADMIN: B(3), VIEW_AUDIT: B(7), VIEW: B(10), SEND: B(11), MANAGE_MESSAGES: B(13), EMBED: B(14), ATTACH: B(15), HISTORY: B(16), EXT_EMOJI: B(18), CONNECT: B(20), SPEAK: B(21), USE_VAD: B(25), CHANGE_NICK: B(26), MANAGE_NICK: B(27), APP_COMMANDS: B(31), MANAGE_THREADS: B(34), SEND_IN_THREADS: B(38), MODERATE: B(40), EXT_APPS: B(50), ADD_REACTIONS: B(6), STREAM: B(9) };
const s = (x) => x.toString();
const chans = await call("GET", `/guilds/${G}/channels`);
const ch = (n) => chans.find((c) => c.name === n && c.type === 0)?.id;
const roles = await call("GET", `/guilds/${G}/roles`);
const role = (n) => roles.find((r) => r.name === n);
const log = (m) => console.log(m);

// 1. Server: high verification (account older than 5 minutes and in the server 10 minutes before talking), join and
// boost messages to the private moderation log, raid and DM-spam alerts there too.
await call("PATCH", `/guilds/${G}`, { verification_level: 3, explicit_content_filter: 2, system_channel_id: ch("moderation-log"), safety_alerts_channel_id: ch("moderation-log"), default_message_notifications: 1 });
log("server: verification high, explicit filter all members, join messages and safety alerts to #moderation-log");

// 2. @everyone: talk, react, slash commands, voice. No links, files, external apps, invites or threads by default.
const everyone = s(P.VIEW | P.SEND | P.HISTORY | P.ADD_REACTIONS | P.EXT_EMOJI | P.APP_COMMANDS | P.CONNECT | P.SPEAK | P.USE_VAD | P.CHANGE_NICK | P.SEND_IN_THREADS);
await call("PATCH", `/guilds/${G}/roles/${G}`, { permissions: everyone });
log("@everyone: no embeds, attachments, external apps, invites or new threads");

// 3. Roles: staff get what they need; Member and Verified get links and files back.
// Roles above the bot (Admin, Core Team, Moderator once the owner orders the hierarchy) cannot be edited by it: skip them.
const set = async (name, perms) => {
  const r = role(name); if (!r) return;
  try { await call("PATCH", `/guilds/${G}/roles/${r.id}`, { permissions: s(perms) }); log(`role ${name}`); }
  catch (e) { if (String(e.message).includes("50013")) log(`role ${name}: above the bot, left as it is`); else throw e; }
};
await set("Admin", P.ADMIN);
await set("Core Team", P.VIEW_AUDIT | P.MANAGE_MESSAGES | P.MANAGE_THREADS | P.MODERATE | P.KICK | P.MANAGE_NICK | P.EMBED | P.ATTACH | P.CREATE_INVITE);
await set("Moderator", P.VIEW_AUDIT | P.MANAGE_MESSAGES | P.MANAGE_THREADS | P.MODERATE | P.KICK | P.MANAGE_NICK | P.EMBED | P.ATTACH);
await set("Verified", P.EMBED | P.ATTACH);
await set("Member", 0n);
// Files allowed where they help: screenshots in bug reports and the showcase, for members.
for (const n of ["bug-reports", "showcase", "help"]) {
  const id = ch(n); const m = role("Member");
  if (!id || !m) continue;
  const c = chans.find((x) => x.id === id);
  const cur = c.permission_overwrites.find((o) => o.id === m.id);
  const allow = BigInt(cur?.allow ?? 0) | P.ATTACH | P.EMBED;
  const deny = BigInt(cur?.deny ?? 0) & ~(P.ATTACH | P.EMBED);
  await call("PUT", `/channels/${id}/permissions/${m.id}`, { type: 0, allow: s(allow), deny: s(deny) });
  log(`#${n}: members may attach screenshots`);
}

// 4. Slowmode in the open rooms.
for (const [n, secs] of [["general", 5], ["introductions", 30], ["ideas", 10], ["memes", 10], ["help", 5]]) {
  if (ch(n)) { await call("PATCH", `/channels/${ch(n)}`, { rate_limit_per_user: secs }); log(`#${n}: slowmode ${secs}s`); }
}

// 5. AutoMod. Staff are exempt; every block also alerts #moderation-log.
const staff = ["Admin", "Core Team", "Moderator"].map((n) => role(n)?.id).filter(Boolean);
const alert = { type: 2, metadata: { channel_id: ch("moderation-log") } };
const block = (msg) => ({ type: 1, metadata: { custom_message: msg } });
const existing = await call("GET", `/guilds/${G}/auto-moderation/rules`);
const RULES = [
  { name: "Scam phrases", event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: [
      "*seed phrase*", "*recovery phrase*", "*secret phrase*", "*private key*", "*validate your wallet*", "*wallet validation*", "*sync your wallet*",
      "*rectify*", "*claim your airdrop*", "*airdrop claim*", "*free mint*", "*mint is live*", "*open a ticket*", "*support ticket*", "*raise a ticket*",
      "*dm me*", "*dm for*", "*message me privately*", "*free nitro*", "*discord nitro*", "*steamcommunity*", "*wallet connect*", "*walletconnect*",
      "*double your*", "*guaranteed profit*", "*investment plan*",
    ] }, actions: [block("Blocked to protect members: the team never asks for keys, phrases or DMs. Ask in #help instead."), alert] },
  { name: "Links outside the allowlist", event_type: 1, trigger_type: 1, trigger_metadata: {
      regex_patterns: ["(?i)(https?://|www\\.|discord\\.gg/|discord\\.com/invite/)\\S+"],
      allow_list: ["orrery.tech", "x.com/OrreryHQ", "twitter.com/OrreryHQ", "discord.gg/zk3dybhead", "robinhoodchain.blockscout.com", "github.com"],
    }, actions: [block("Links are limited to official Orrery sites. Share other links with a moderator first."), alert] },
  { name: "Impersonating names", event_type: 2, trigger_type: 6, trigger_metadata: { keyword_filter: [
      "*admin*", "*moderator*", "*support*", "*helpdesk*", "*orrery team*", "*orrery official*", "*official orrery*", "*core team*",
    ] }, actions: [{ type: 4 }, alert] },
  { name: "Spam content", event_type: 1, trigger_type: 3, trigger_metadata: {}, actions: [{ type: 1 }, alert] },
  { name: "Mention spam", event_type: 1, trigger_type: 5, trigger_metadata: { mention_total_limit: 5, mention_raid_protection_enabled: true }, actions: [{ type: 1 }, alert, { type: 3, metadata: { duration_seconds: 3600 } }] },
];
for (const r of RULES) {
  const body = { ...r, enabled: true, exempt_roles: staff };
  const found = existing.find((e) => e.name === r.name || (r.trigger_type === 5 && e.trigger_type === 5));
  if (found) {
    const { event_type, trigger_type, ...patch } = body;
    try { await call("PATCH", `/guilds/${G}/auto-moderation/rules/${found.id}`, { ...patch, name: r.name }); log(`automod updated: ${r.name}`); }
    catch { log(`automod kept: ${found.name} (Discord's built-in rule, edited in Server Settings only)`); }
  }
  else { await call("POST", `/guilds/${G}/auto-moderation/rules`, body); log(`automod created: ${r.name}`); }
}
log("done");
