// Builds the Orrery Discord server: roles, categories, channels and permission overwrites. Idempotent: existing
// roles and channels (matched by name) are reused, nothing is deleted except the two empty default categories.
// Token: ~/.secrets/orrery/discord-bot.txt. Usage: node ops/discord/setup.mjs <guildId> [--dry-run]
// After a re-run, run `node ops/discord/rooms.mjs <guildId> lock` again: setup gives members the rooms that rooms.mjs
// keeps hidden until their feature releases.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const guild = process.argv[2];
const dry = process.argv.includes("--dry-run");
if (!/^\d{15,}$/.test(guild ?? "")) throw new Error("usage: node setup.mjs <guildId> [--dry-run]");
const token = readFileSync(join(homedir(), ".secrets/orrery/discord-bot.txt"), "utf8").trim();
const API = "https://discord.com/api/v10";

async function call(method, path, body) {
  for (;;) {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bot ${token}`, "content-type": "application/json", "X-Audit-Log-Reason": "Orrery server setup" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) {
      const j = await r.json();
      await new Promise((res) => setTimeout(res, Math.ceil((j.retry_after ?? 1) * 1000) + 100));
      continue;
    }
    if (r.status === 204) return null;
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  }
}

const P = { VIEW: 1n << 10n, SEND: 1n << 11n, MANAGE_MESSAGES: 1n << 13n, EMBED: 1n << 14n, HISTORY: 1n << 16n };
const s = (n) => n.toString();

// Roles the bot can create (it cannot grant permissions it does not hold, so Admin gets Administrator by hand).
const ROLES = [
  { name: "Admin", color: 0x3152e9, hoist: true, permissions: 0n },
  { name: "Core Team", color: 0x7b93ff, hoist: true, permissions: 0n },
  { name: "Moderator", color: 0x12855a, hoist: true, permissions: P.MANAGE_MESSAGES },
  { name: "Builder", color: 0xe0a33a, hoist: false, permissions: 0n },
  { name: "Operator", color: 0x5fd39a, hoist: false, permissions: 0n },
  { name: "Merchant", color: 0xd76f4a, hoist: false, permissions: 0n },
  { name: "ORRY Holder", color: 0xa9b8ff, hoist: false, permissions: 0n },
  { name: "Verified", color: 0x8a93a8, hoist: false, permissions: 0n },
  { name: "Member", color: 0x59637d, hoist: false, permissions: 0n },
];

// mode: "open" everyone writes; "read" everyone reads, staff writes; "team" staff only.
const LAYOUT = [
  { cat: "START HERE", channels: [
    ["welcome", "start", "Begin here. A short tour of Orrery and where each room leads."],
    ["rules", "start", "The house rules for this server."],
    ["announcements", "start", "Release notes, launch waves and product news, posted by the team."],
    ["official-links", "start", "The site, our X account and contract addresses. This room is the source for official links."],
  ] },
  { cat: "COMMUNITY", channels: [
    ["general", "lobby", "Open conversation about Orrery."],
    ["introductions", "lobby", "Introduce yourself and what you are building."],
    ["ideas", "lobby", "Suggestions and feedback for the product."],
    ["memes", "lobby", "Light moments, still about Orrery."],
  ] },
  { cat: "BUILDERS", channels: [
    ["operators", "open", "For operators: Safe accounts, an agent's caps, policy changes."],
    ["agent-builders", "open", "Agent code: the SDK, the MCP server and x402 payments."],
    ["merchants", "open", "Accepting agent payments: signed readings of payers, and check credits."],
    ["showcase", "open", "Agents and integrations people have shipped."],
  ] },
  { cat: "ORRY", channels: [
    ["orry-chat", "open", "Conversation about the ORRY token."],
    ["earn-and-stake", "open", "Questions on Earn, Stake and Claim."],
    ["burn-tracker", "read", "Each ORRY burn, posted as it lands on chain."],
  ] },
  { cat: "SUPPORT", channels: [
    ["help", "lobby", "Questions about using Orrery, answered here."],
    ["bug-reports", "open", "Report a bug with the steps that led to it."],
    ["docs-and-guides", "read", "Walkthroughs and answers written by the team."],
  ] },
  { cat: "EVENTS", channels: [
    ["missions", "read", "Missions and events running now."],
    ["achievements", "read", "Achievement winners and standings."],
    ["bounty-board", "read", "Bug bounties and rewarded tasks."],
  ] },
  { cat: "TEAM", team: true, channels: [
    ["team-chat", "team", "Team room."],
    ["moderation-log", "modlog", "Moderator actions on record."],
    ["alerts", "team", "Alerts from indexers, keepers and deploys."],
  ] },
];

const log = (m) => console.log(m);
const roles = await call("GET", `/guilds/${guild}/roles`);
const me = await call("GET", "/users/@me");
const botRole = roles.find((r) => r.tags?.bot_id === me.id);
const roleId = {};
for (const def of ROLES) {
  const found = roles.find((r) => r.name === def.name);
  if (found) { roleId[def.name] = found.id; log(`role ok      ${def.name}`); continue; }
  if (dry) { log(`role create  ${def.name}`); roleId[def.name] = `dry-${def.name}`; continue; }
  const r = await call("POST", `/guilds/${guild}/roles`, { name: def.name, color: def.color, hoist: def.hoist, mentionable: false, permissions: s(def.permissions) });
  roleId[def.name] = r.id;
  log(`role create  ${def.name}`);
}

const everyone = guild; // @everyone role id equals the guild id
const staff = ["Admin", "Core Team", "Moderator"].map((n) => roleId[n]);
const overwrites = (mode) => {
  const o = [];
  const member = roleId["Member"];
  if (mode === "start") {
    o.push({ id: everyone, type: 0, allow: s(P.VIEW | P.HISTORY), deny: s(P.SEND) });
    for (const id of staff) o.push({ id, type: 0, allow: s(P.SEND), deny: "0" });
  } else if (mode === "lobby") {
    o.push({ id: everyone, type: 0, allow: s(P.VIEW | P.SEND | P.HISTORY), deny: "0" });
  } else if (mode === "open") {
    o.push({ id: everyone, type: 0, allow: "0", deny: s(P.VIEW) });
    o.push({ id: member, type: 0, allow: s(P.VIEW | P.SEND | P.HISTORY), deny: "0" });
    for (const id of staff) o.push({ id, type: 0, allow: s(P.VIEW | P.SEND | P.HISTORY), deny: "0" });
  } else if (mode === "read") {
    o.push({ id: everyone, type: 0, allow: "0", deny: s(P.VIEW | P.SEND) });
    o.push({ id: member, type: 0, allow: s(P.VIEW | P.HISTORY), deny: s(P.SEND) });
    for (const id of staff) o.push({ id, type: 0, allow: s(P.VIEW | P.SEND | P.HISTORY), deny: "0" });
  } else if (mode === "team" || mode === "modlog") {
    // team rooms: Admin and Core Team; the moderation log also lets Moderators in (same audience as ops/discord/access.mjs)
    const who = mode === "modlog" ? staff : ["Admin", "Core Team"].map((n) => roleId[n]);
    o.push({ id: everyone, type: 0, allow: "0", deny: s(P.VIEW) });
    for (const id of who) o.push({ id, type: 0, allow: s(P.VIEW | P.SEND | P.HISTORY), deny: "0" });
  }
  if (botRole) o.push({ id: botRole.id, type: 0, allow: s(P.VIEW | P.SEND | P.EMBED | P.HISTORY | P.MANAGE_MESSAGES), deny: "0" });
  return o.filter((x) => x.id && !String(x.id).startsWith("dry-"));
};

let channels = await call("GET", `/guilds/${guild}/channels`);
let pos = 0;
for (const group of LAYOUT) {
  let cat = channels.find((c) => c.type === 4 && c.name.toUpperCase() === group.cat);
  if (!cat) {
    if (dry) log(`category create ${group.cat}`);
    else { cat = await call("POST", `/guilds/${guild}/channels`, { name: group.cat, type: 4, position: pos, permission_overwrites: group.team ? overwrites("team") : [] }); log(`category create ${group.cat}`); }
  } else log(`category ok  ${group.cat}`);
  pos++;
  for (const [name, mode, topic] of group.channels) {
    const existing = channels.find((c) => (c.type === 0 || c.type === 15) && c.name === name);
    const body = { name, type: 0, topic, parent_id: cat?.id, permission_overwrites: overwrites(mode) };
    if (dry) { log(`  ${existing ? "update" : "create"} #${name} (${mode})`); continue; }
    if (existing) { await call("PATCH", `/channels/${existing.id}`, { topic, parent_id: cat.id, permission_overwrites: body.permission_overwrites }); log(`  update #${name} (${mode})`); }
    else { await call("POST", `/guilds/${guild}/channels`, body); log(`  create #${name} (${mode})`); }
  }
}

// Move the default voice room into COMMUNITY as "Lounge", then drop the two default categories if they are empty.
channels = await call("GET", `/guilds/${guild}/channels`);
const community = channels.find((c) => c.type === 4 && c.name.toUpperCase() === "COMMUNITY");
for (const v of channels.filter((c) => c.type === 2 && c.name === "General")) {
  if (dry) log("voice General -> COMMUNITY / Lounge");
  else { await call("PATCH", `/channels/${v.id}`, { name: "Lounge", parent_id: community?.id }); log("voice General -> COMMUNITY / Lounge"); }
}
for (const v of channels.filter((c) => c.type === 2 && c.name === "Lounge")) {
  if (!dry) await call("PATCH", `/channels/${v.id}`, { permission_overwrites: overwrites("lobby") });
}
channels = dry ? channels : await call("GET", `/guilds/${guild}/channels`);
for (const name of ["Text channels", "Voice channels"]) {
  const c = channels.find((x) => x.type === 4 && x.name === name);
  if (!c) continue;
  const kids = channels.filter((x) => x.parent_id === c.id);
  if (kids.length) { log(`keep category ${name} (${kids.length} channels left)`); continue; }
  if (dry) log(`delete empty category ${name}`);
  else { await call("DELETE", `/channels/${c.id}`); log(`delete empty category ${name}`); }
}
log(dry ? "dry run done, nothing changed" : "done");
