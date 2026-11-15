// Creates (or keeps) the private #dev-lab room where the development network's bot posts and answers commands (Discord
// test mode, ORRERY_DISCORD_TEST_CHANNEL=dev-lab): staff only (Admin, Core Team) and the bot, in the TEAM category.
// Idempotent. Usage: node ops/discord/dev-lab.mjs <guildId>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const G = process.argv[2];
const token = readFileSync(join(homedir(), ".secrets/orrery/discord-bot.txt"), "utf8").trim();
async function call(method, path, body) {
  for (;;) {
    const r = await fetch("https://discord.com/api/v10" + path, { method, headers: { Authorization: `Bot ${token}`, "content-type": "application/json", "X-Audit-Log-Reason": "Orrery development network room" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { const j = await r.json(); await new Promise((res) => setTimeout(res, Math.ceil((j.retry_after ?? 1) * 1000) + 100)); continue; }
    if (r.status === 204) return null;
    const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`); return j;
  }
}
const B = (n) => 1n << BigInt(n);
const VIEW = B(10), SEND = B(11), HISTORY = B(16), EMBED = B(14), ATTACH = B(15), APP_COMMANDS = B(31);
const chans = await call("GET", `/guilds/${G}/channels`);
const roles = await call("GET", `/guilds/${G}/roles`);
const role = (n) => roles.find((r) => r.name === n);
const bot = roles.find((r) => r.managed && r.tags?.bot_id);
const team = chans.find((c) => c.type === 4 && c.name.toUpperCase() === "TEAM");
const staffAllow = (VIEW | SEND | HISTORY | EMBED | ATTACH | APP_COMMANDS).toString();
const ow = [{ id: G, type: 0, allow: "0", deny: VIEW.toString() }, ...["Admin", "Core Team"].map(role).filter(Boolean).map((r) => ({ id: r.id, type: 0, allow: staffAllow, deny: "0" }))];
if (bot) ow.push({ id: bot.id, type: 0, allow: (VIEW | SEND | HISTORY | EMBED | ATTACH).toString(), deny: "0" });
const existing = chans.find((c) => c.name === "dev-lab" && c.type === 0);
const topic = "Orrery on the development network: bot posts, alerts and commands for testing. Nothing here touches the community rooms or roles.";
if (existing) {
  await call("PATCH", `/channels/${existing.id}`, { parent_id: team?.id, topic, permission_overwrites: ow });
  console.log(`kept #dev-lab ${existing.id} private`);
} else {
  const c = await call("POST", `/guilds/${G}/channels`, { name: "dev-lab", type: 0, parent_id: team?.id, topic, permission_overwrites: ow });
  console.log(`created #dev-lab ${c.id}`);
}
