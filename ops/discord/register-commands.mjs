// Registers Orrery's slash commands in the Orrery server (guild commands appear at once).
// Usage: node ops/discord/register-commands.mjs <appId> <guildId>   Token: ~/.secrets/orrery/discord-bot.txt
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [appId, guildId] = process.argv.slice(2);
if (!/^\d{15,}$/.test(appId ?? "") || !/^\d{15,}$/.test(guildId ?? "")) throw new Error("usage: node register-commands.mjs <appId> <guildId>");
const token = readFileSync(join(homedir(), ".secrets/orrery/discord-bot.txt"), "utf8").trim();
const STRING = 3;
const commands = [
  { name: "payer", description: "Check an address that paid you: session, caps and spend today.", options: [{ type: STRING, name: "address", description: "Paying address (0x...)", required: true }] },
  { name: "agent", description: "Read an agent's limits on its account.", options: [
    { type: STRING, name: "id", description: "ERC-8004 agent ID", required: true },
    { type: STRING, name: "account", description: "The agent's account (0x...)", required: true },
  ] },
  { name: "orry", description: "ORRY staked and burned so far." },
  { name: "verify", description: "Link your wallet and get your Orrery roles." },
  { name: "announce", description: "Post an approved release card to #announcements (Admin and Core Team).", default_member_permissions: "32", options: [
    { type: STRING, name: "feature", description: "Release feature", required: true, choices: ["core", "earn", "stake", "claim", "leaderboard", "agent-stake", "burn", "checkout"].map((f) => ({ name: f, value: f })) },
  ] },
];
const r = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});
const j = await r.json();
if (!r.ok) throw new Error(`register failed: ${r.status} ${JSON.stringify(j)}`);
console.log(`registered: ${j.map((c) => "/" + c.name).join(", ")}`);
