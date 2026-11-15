// Sets the server icon to the Orrery avatar (the one on X) and keeps a server template as a backup of the
// structure (rooms, roles, permissions; no messages or members). Re-running syncs the template to the current state.
// Usage: node ops/discord/brand-and-backup.mjs <guildId>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const G = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const token = readFileSync(join(homedir(), ".secrets/orrery/discord-bot.txt"), "utf8").trim();
async function call(method, path, body) {
  const r = await fetch("https://discord.com/api/v10" + path, { method, headers: { Authorization: `Bot ${token}`, "content-type": "application/json", "X-Audit-Log-Reason": "Orrery brand and backup" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return null;
  const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`); return j;
}
const icon = "data:image/png;base64," + readFileSync(join(here, "../../design/brand/x-avatar.png")).toString("base64");
const g = await call("PATCH", `/guilds/${G}`, { icon });
console.log(`icon set: ${g.icon ? "yes" : "no"}`);
const templates = await call("GET", `/guilds/${G}/templates`);
const t = templates[0]
  ? await call("PUT", `/guilds/${G}/templates/${templates[0].code}`)
  : await call("POST", `/guilds/${G}/templates`, { name: "Orrery", description: "Orrery Discord layout: rooms, roles and permissions." });
console.log(`template ${templates[0] ? "synced" : "created"}: https://discord.new/${t.code}`);
