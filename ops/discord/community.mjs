import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Usage: node ops/discord/community.mjs <guildId>
const G = process.argv[2];
if (!/^\d{15,}$/.test(G ?? "")) throw new Error("usage: node community.mjs <guildId>");
const token = readFileSync(join(homedir(), ".secrets/orrery/discord-bot.txt"), "utf8").trim();
async function call(method, path, body) {
  for (;;) {
    const r = await fetch("https://discord.com/api/v10" + path, { method, headers: { Authorization: `Bot ${token}`, "content-type": "application/json", "X-Audit-Log-Reason": "Orrery community and onboarding" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { const j = await r.json(); await new Promise((res) => setTimeout(res, Math.ceil((j.retry_after ?? 1) * 1000) + 100)); continue; }
    if (r.status === 204) return null;
    const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`); return j;
  }
}
const chans = await call("GET", `/guilds/${G}/channels`);
const id = (n) => chans.find((c) => c.name === n && c.type === 0)?.id;
const roles = await call("GET", `/guilds/${G}/roles`);
const member = roles.find((r) => r.name === "Member").id;
// 1. Community: rules channel, community updates to the private moderation log, safer defaults
const snow = (k) => (((BigInt(Date.now()) - 1420070400000n) << 22n) + BigInt(k)).toString();
const g = await call("PATCH", `/guilds/${G}`, {
  features: ["COMMUNITY"], rules_channel_id: id("rules"), public_updates_channel_id: id("moderation-log"),
  verification_level: 1, explicit_content_filter: 2, default_message_notifications: 1, preferred_locale: "en-US",
  description: "Public caps that keep paying AI agents on course, and ORRY, the token Orrery's revenue flows into.",
});
console.log("community:", g.features.includes("COMMUNITY"), "rules:", g.rules_channel_id === id("rules"));
// 2. Onboarding: default channels and one required prompt that gives the Member role
const defaults = ["welcome", "rules", "announcements", "official-links", "general", "introductions", "ideas", "memes", "help"].map(id);
const ob = await call("PUT", `/guilds/${G}/onboarding`, {
  enabled: true, mode: 0, default_channel_ids: defaults,
  prompts: [{
    id: snow(1), type: 0, title: "One step before the rooms open", single_select: true, required: true, in_onboarding: true,
    options: [{ id: snow(2), title: "I read the rules and I am ready to join", description: "Unlocks the Builders, ORRY, Events and Support rooms.", role_ids: [member], channel_ids: [], emoji: { name: "✅" } }],
  }],
});
console.log("onboarding enabled:", ob.enabled, "prompts:", ob.prompts.length, "defaults:", ob.default_channel_ids.length);
