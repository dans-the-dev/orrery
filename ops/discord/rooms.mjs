// Hides the rooms whose feature is not released yet from members (staff still see them; owner's choice 2026-11-09) and creates the private #release-drafts room for announcement review. The Discord process unlocks a room
// when its feature opens (services/packages/server/src/discord.ts, ROOM_RELEASES). Idempotent.
// Usage: node ops/discord/rooms.mjs <guildId> lock|unlock <feature>|status
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [guild, action, feature] = process.argv.slice(2);
const token = readFileSync(join(homedir(), ".secrets/orrery/discord-bot.txt"), "utf8").trim();
async function call(method, path, body) {
  for (;;) {
    const r = await fetch("https://discord.com/api/v10" + path, { method, headers: { Authorization: `Bot ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { const j = await r.json(); await new Promise((res) => setTimeout(res, Math.ceil((j.retry_after ?? 1) * 1000) + 100)); continue; }
    if (r.status === 204) return null;
    const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`); return j;
  }
}

// Same map as ROOM_RELEASES in discord.ts: room -> the release feature that opens it, and the name shown to members.
export const ROOMS = {
  operators: ["core", "Orrery"], "agent-builders": ["core", "Orrery"], merchants: ["core", "Orrery"], showcase: ["core", "Orrery"],
  "orry-chat": ["earn", "ORRY"], "earn-and-stake": ["earn", "Earn and Stake"], "burn-tracker": ["burn", "the burn page"],
  missions: ["achievements", "Missions"], achievements: ["achievements", "Achievements"], "bounty-board": ["achievements", "the bounty board"],
};
const SEND = 1n << 11n, VIEW = 1n << 10n, HISTORY = 1n << 16n, ATTACH = 1n << 15n, EMBED = 1n << 14n;
const chans = await call("GET", `/guilds/${guild}/channels`);
const roles = await call("GET", `/guilds/${guild}/roles`);
const member = roles.find((r) => r.name === "Member").id;
const staff = ["Admin", "Core Team"].map((n) => roles.find((r) => r.name === n).id);
const byName = (n) => chans.find((c) => c.name === n && c.type === 0);
const me = await call("GET", "/users/@me");

async function setMember(ch, open) {
  // Locked: hidden from members. Open: members read, and write unless the room is read-only (burn-tracker, missions, ...).
  const readOnly = ["burn-tracker", "missions", "achievements", "bounty-board"].includes(ch.name);
  const allow = !open ? 0n : readOnly ? VIEW | HISTORY : VIEW | HISTORY | SEND;
  const deny = !open ? VIEW | SEND : readOnly ? SEND : 0n;
  await call("PUT", `/channels/${ch.id}/permissions/${member}`, { type: 0, allow: allow.toString(), deny: deny.toString() });
}

if (action === "lock") {
  for (const [name, [feat, label]] of Object.entries(ROOMS)) {
    const ch = byName(name); if (!ch) continue;
    await setMember(ch, false);
    const pins = await call("GET", `/channels/${ch.id}/pins`);
    if (!pins.some((m) => m.author?.id === me.id && m.content.startsWith("🔒"))) {
      const m = await call("POST", `/channels/${ch.id}/messages`, { content: `🔒 This room opens when ${label} goes live on orrery.tech. Follow <#${byName("announcements")?.id}> for the moment it opens.`, flags: 4, allowed_mentions: { parse: [] } });
      await call("PUT", `/channels/${ch.id}/pins/${m.id}`);
    }
    console.log(`hidden  #${name} (opens with ${feat})`);
  }
  // private review room for release posts
  if (!byName("release-drafts")) {
    const team = chans.find((c) => c.type === 4 && c.name.toUpperCase() === "TEAM");
    const ow = [{ id: guild, type: 0, allow: "0", deny: VIEW.toString() }, ...staff.map((id) => ({ id, type: 0, allow: (VIEW | SEND | HISTORY | ATTACH | EMBED).toString(), deny: "0" }))];
    const c = await call("POST", `/guilds/${guild}/channels`, { name: "release-drafts", type: 0, parent_id: team?.id, topic: "Release posts waiting for review. Approve one and it goes to #announcements.", permission_overwrites: ow });
    console.log(`created #release-drafts ${c.id}`);
  }
} else if (action === "unlock") {
  for (const [name, [feat]] of Object.entries(ROOMS)) {
    if (feat !== feature) continue;
    const ch = byName(name); if (!ch) continue;
    await setMember(ch, true);
    const pins = await call("GET", `/channels/${ch.id}/pins`);
    for (const m of pins.filter((m) => m.author?.id === me.id && m.content.startsWith("🔒"))) await call("DELETE", `/channels/${ch.id}/messages/${m.id}`);
    console.log(`opened  #${name}`);
  }
} else {
  for (const [name, [feat]] of Object.entries(ROOMS)) {
    const ch = byName(name); if (!ch) continue;
    const o = ch.permission_overwrites.find((x) => x.id === member);
    const deny = BigInt(o?.deny ?? 0);
    console.log(`${deny & VIEW ? "hidden" : deny & SEND ? "read  " : "open  "}  #${name} (${feat})`);
  }
}
