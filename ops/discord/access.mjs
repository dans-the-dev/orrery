// Shows, for every room, which roles can see it and write in it (effective permissions: role permissions, then the
// category-synced or channel overwrites for @everyone and each role; Administrator sees everything). With --fix it sets
// the private rooms to their audience (PRIVATE below) and re-checks. Read-only without --fix.
// Usage: node ops/discord/access.mjs <guildId> [--fix]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const G = process.argv[2];
const fix = process.argv.includes("--fix");
const token = readFileSync(join(homedir(), ".secrets/orrery/discord-bot.txt"), "utf8").trim();
async function call(method, path, body) {
  for (;;) {
    const r = await fetch("https://discord.com/api/v10" + path, { method, headers: { Authorization: `Bot ${token}`, "content-type": "application/json", "X-Audit-Log-Reason": "Orrery private rooms" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { const j = await r.json(); await new Promise((res) => setTimeout(res, Math.ceil((j.retry_after ?? 1) * 1000) + 100)); continue; }
    if (r.status === 204) return null;
    const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`); return j;
  }
}
const B = (n) => 1n << BigInt(n);
const VIEW = B(10), SEND = B(11), HISTORY = B(16), ADMIN = B(3), EMBED = B(14), ATTACH = B(15), MANAGE_MESSAGES = B(13), CREATE_POSTS = SEND;

// Private rooms and who may see them. Everyone else, @everyone included, is denied.
const PRIVATE = {
  "team-chat": ["Admin", "Core Team"],
  "release-drafts": ["Admin", "Core Team"],
  alerts: ["Admin", "Core Team"],
  "moderation-log": ["Admin", "Core Team", "Moderator"],
  "dev-lab": ["Admin", "Core Team"],
  boosters: ["Admin", "Core Team", "Moderator", "@booster"],
};

let chans = await call("GET", `/guilds/${G}/channels`);
const roles = await call("GET", `/guilds/${G}/roles`);
const byName = Object.fromEntries(roles.map((r) => [r.name, r]));
const booster = roles.find((r) => r.tags && "premium_subscriber" in r.tags);
const bot = roles.find((r) => r.managed && r.tags?.bot_id);
const roleOf = (n) => (n === "@booster" ? booster : byName[n]);

function effective(ch, roleIds) {
  const all = [G, ...roleIds];
  let p = 0n;
  for (const id of all) p |= BigInt(roles.find((r) => r.id === id)?.permissions ?? 0);
  if (p & ADMIN) return { view: true, send: true };
  const ow = Object.fromEntries((ch.permission_overwrites ?? []).map((o) => [o.id, o]));
  if (ow[G]) p = (p & ~BigInt(ow[G].deny)) | BigInt(ow[G].allow);
  let allow = 0n, deny = 0n;
  for (const id of roleIds) if (ow[id]) { allow |= BigInt(ow[id].allow); deny |= BigInt(ow[id].deny); }
  p = (p & ~deny) | allow;
  return { view: !!(p & VIEW), send: !!(p & SEND) };
}

const AUDIENCES = ["@everyone", "Member", "Verified", "Moderator", "Core Team", "Admin", ...(booster ? [booster.name] : [])];
function table() {
  const rows = [];
  for (const ch of chans.filter((c) => [0, 2, 5, 15].includes(c.type)).sort((a, b) => a.position - b.position)) {
    const cat = chans.find((c) => c.id === ch.parent_id)?.name ?? "";
    const seen = AUDIENCES.filter((a) => effective(ch, a === "@everyone" ? [] : [roleOf(a)?.id ?? byName[a]?.id].filter(Boolean)).view);
    rows.push({ cat, name: ch.name, seen, priv: !!PRIVATE[ch.name] });
  }
  return rows;
}

if (fix) {
  for (const [name, who] of Object.entries(PRIVATE)) {
    const ch = chans.find((c) => c.name === name && [0, 15].includes(c.type));
    if (!ch) { console.log(`not present: #${name}${name === "boosters" ? " (made at the first boost by boosters.mjs)" : ""}`); continue; }
    const ow = [{ id: G, type: 0, allow: "0", deny: VIEW.toString() }];
    for (const n of who) {
      const r = roleOf(n);
      if (r) ow.push({ id: r.id, type: 0, allow: (VIEW | SEND | HISTORY | EMBED | ATTACH).toString(), deny: "0" });
    }
    if (bot) ow.push({ id: bot.id, type: 0, allow: (VIEW | SEND | HISTORY | EMBED | ATTACH | MANAGE_MESSAGES).toString(), deny: "0" });
    await call("PATCH", `/channels/${ch.id}`, { permission_overwrites: ow });
    console.log(`private: #${name} -> ${who.join(", ")} and the bot`);
  }
  // the TEAM category itself stays staff-only, so a new room created in it starts private
  const team = chans.find((c) => c.type === 4 && c.name.toUpperCase() === "TEAM");
  if (team) {
    const ow = [{ id: G, type: 0, allow: "0", deny: VIEW.toString() }, ...["Admin", "Core Team"].map((n) => ({ id: byName[n].id, type: 0, allow: (VIEW | SEND | HISTORY).toString(), deny: "0" }))];
    if (bot) ow.push({ id: bot.id, type: 0, allow: (VIEW | SEND | HISTORY).toString(), deny: "0" });
    await call("PATCH", `/channels/${team.id}`, { permission_overwrites: ow });
    console.log("private: TEAM category -> Admin, Core Team and the bot");
  }
  chans = await call("GET", `/guilds/${G}/channels`);
}

let bad = 0;
for (const r of table()) {
  const want = PRIVATE[r.name];
  let flag = "";
  if (want) {
    const extra = r.seen.filter((a) => a !== "Admin" && !want.includes(a) && !(want.includes("@booster") && a === booster?.name));
    if (extra.length) { flag = `  << also visible to ${extra.join(", ")}`; bad++; }
  }
  console.log(`${r.priv ? "[private]" : "         "} ${r.cat.padEnd(11)} #${r.name.padEnd(16)} seen by: ${r.seen.join(", ")}${flag}`);
}
console.log(bad ? `${bad} private room(s) visible beyond their audience` : "every private room is limited to its audience");
