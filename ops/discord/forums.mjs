// Replaces the text rooms #help, #bug-reports and #ideas with Forum channels of the same name (one topic per question,
// bug or idea, with tags; staff-only tags mark status). Keeps each room's place, permissions and slowmode, moves the
// onboarding default channels to the forums, then deletes the old text rooms. Idempotent: an existing forum is updated.
// Usage: node ops/discord/forums.mjs <guildId>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const G = process.argv[2];
const token = readFileSync(join(homedir(), ".secrets/orrery/discord-bot.txt"), "utf8").trim();
async function call(method, path, body) {
  for (;;) {
    const r = await fetch("https://discord.com/api/v10" + path, { method, headers: { Authorization: `Bot ${token}`, "content-type": "application/json", "X-Audit-Log-Reason": "Orrery forums" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { const j = await r.json(); await new Promise((res) => setTimeout(res, Math.ceil((j.retry_after ?? 1) * 1000) + 100)); continue; }
    if (r.status === 204) return null;
    const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`); return j;
  }
}
const tag = (name, emoji, moderated = false) => ({ name, moderated, emoji_name: emoji });
const FORUMS = {
  help: {
    topic: "Open one post per question, with what you tried and the page you were on. Keep your seed phrase and private key to yourself. A moderator tags the post Solved once answered.",
    tags: [tag("Question", "❓"), tag("Operator", "🛠️"), tag("Merchant", "🧾"), tag("ORRY", "🪙"), tag("Wallet", "👛"), tag("Solved", "✅", true)],
    reaction: null,
  },
  "bug-reports": {
    topic: "Open one post per bug: the steps you took, the result you expected, the result you got, page, browser and wallet, plus the transaction hash when there is one. Confirmed reports can earn a bounty.",
    tags: [tag("Web", "🖥️"), tag("Contracts", "📜"), tag("API", "🔌"), tag("Discord", "💬"), tag("Confirmed", "🔎", true), tag("Fixed", "✅", true)],
    reaction: null,
  },
  ideas: {
    topic: "Open one post per idea and add a 👍 to back the ones you like. The team tags ideas as they are planned and shipped.",
    tags: [tag("Product", "💡"), tag("ORRY", "🪙"), tag("Community", "🤝"), tag("Planned", "🗓️", true), tag("Shipped", "🚀", true)],
    reaction: "👍",
  },
};

const chans = await call("GET", `/guilds/${G}/channels`);
const ob = await call("GET", `/guilds/${G}/onboarding`);
let defaults = [...ob.default_channel_ids];
for (const [name, f] of Object.entries(FORUMS)) {
  const forum = chans.find((c) => c.name === name && c.type === 15);
  const text = chans.find((c) => c.name === name && c.type === 0);
  const body = {
    topic: f.topic, available_tags: f.tags, default_sort_order: 0, default_forum_layout: 1,
    default_reaction_emoji: f.reaction ? { emoji_name: f.reaction } : null, default_thread_rate_limit_per_user: 5,
  };
  let id = forum?.id;
  if (forum) { await call("PATCH", `/channels/${forum.id}`, body); console.log(`forum updated #${name}`); }
  else {
    if (!text) { console.log(`skip #${name}: no room to replace`); continue; }
    const created = await call("POST", `/guilds/${G}/channels`, {
      name, type: 15, parent_id: text.parent_id, position: text.position, permission_overwrites: text.permission_overwrites, rate_limit_per_user: 60, ...body,
    });
    id = created.id;
    console.log(`forum created #${name}`);
  }
  if (text) defaults = defaults.map((d) => (d === text.id ? id : d));
}
// onboarding defaults point at the forums before the old rooms go
await call("PUT", `/guilds/${G}/onboarding`, { prompts: ob.prompts, default_channel_ids: [...new Set(defaults)], enabled: ob.enabled, mode: ob.mode });
console.log("onboarding defaults moved to the forums");
for (const name of Object.keys(FORUMS)) {
  const text = chans.find((c) => c.name === name && c.type === 0);
  if (text) { await call("DELETE", `/channels/${text.id}`); console.log(`deleted old text room #${name}`); }
}
