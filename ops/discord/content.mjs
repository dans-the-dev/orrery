// Posts and pins the opening message of every Orrery Discord channel. Idempotent: a channel where the bot already
// posted is skipped. Usage: node ops/discord/content.mjs <guildId> [--dry-run]   Token: ~/.secrets/orrery/discord-bot.txt
// Optional env: ORRERY_X_URL and ORRERY_DISCORD_INVITE fill the X and invite lines of #official-links.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const guild = process.argv[2];
const dry = process.argv.includes("--dry-run");
const update = process.argv.includes("--update"); // rewrite the bot's existing opening messages (new channel links)
const token = readFileSync(join(homedir(), ".secrets/orrery/discord-bot.txt"), "utf8").trim();
const API = "https://discord.com/api/v10";
async function call(method, path, body) {
  for (;;) {
    const r = await fetch(API + path, { method, headers: { Authorization: `Bot ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { const j = await r.json(); await new Promise((res) => setTimeout(res, Math.ceil((j.retry_after ?? 1) * 1000) + 100)); continue; }
    if (r.status === 204) return null;
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  }
}

const SITE = "https://orrery.tech";
// Optional: the official X profile URL and Discord invite. A line is left out of #official-links while its value is unset.
const X = process.env.ORRERY_X_URL ?? "";
const INVITE = process.env.ORRERY_DISCORD_INVITE ?? "";
const all = await call("GET", `/guilds/${guild}/channels`);
const ch = Object.fromEntries(all.map((c) => [c.name, c.id]));
const textRoom = new Set(all.filter((c) => c.type === 0 || c.type === 5).map((c) => c.id));
const L = (name) => (ch[name] ? `<#${ch[name]}>` : `#${name}`);

const CONTENT = {
  welcome: [`# Orrery · start here

Orrery keeps every AI agent on a set orbit. An operator places public caps on the agent's own account, the agent pays in USDG over x402 inside those caps, and whoever receives a payment can take a reading of the payer and get it back signed. ORRY is the token that Orrery's revenue flows into.

## Four steps in
**1. Read** ${L("rules")} and accept them when Discord prompts you. Every community room opens once you do.
**2. Introduce yourself** in ${L("introductions")}: your name and what you are building.
**3. Ask and suggest** in ${L("help")} and ${L("ideas")}. Rooms for operators, builders, merchants, ORRY and events join the sidebar as each feature opens, and ${L("announcements")} marks each one.
**4. Connect your wallet** with \`/verify\` from any channel to receive the roles that fit your activity on Orrery: Verified, ORRY Holder, Operator or Merchant.

**Boosting the server** brings a violet Orrery Booster name, images and files in every room, and the private #boosters lounge with release previews and first tester invites.

Questions go to ${L("help")}. Links are official only when they come from ${L("official-links")}.`],

  rules: [`# House rules

**1. Respect everyone.** Harassment, hate speech and personal attacks are removed.
**2. No spam and no uninvited promotion.** Check with a moderator before posting your own project.
**3. Product talk, not price calls.** Talk about what Orrery does rather than where a price is heading, and do not press others for trading advice.
**4. Keep your keys to yourself.** Nobody from the team will message you first or ask for a seed phrase, private key or payment. Report anyone who does.
**5. Links from official sources.** Take links from ${L("official-links")} and ${SITE}.
**6. Use the right room.** Pick the room that matches your question.
**7. Public rooms are in English,** so everyone can follow along.

Moderators remove messages and members that break these rules. Accept the rules in Discord's prompt to open the community rooms.`],

  announcements: [`# Announcements

The Orrery team posts releases, launch waves and product news here before anywhere else. Follow this channel to receive them in your own server.

Orrery is at ${SITE}.`],

  "official-links": [`# Official links

**Website** ${SITE}
**Docs** ${SITE}/docs
${X ? `**X** ${X}\n` : ""}${INVITE ? `**Discord invite** ${INVITE}\n` : ""}
**Contract addresses** appear in this room and on ${SITE} as each contract opens on Robinhood Chain. An address sent by DM or posted in any other room is not an official one.`],

  general: [`**#general** · Open conversation about Orrery: agents, payments, ideas and the product itself. Questions belong in ${L("help")}.`],
  introductions: [`**#introductions** · Introduce yourself: your name, what you are building, and how you came across Orrery.`],
  ideas: [`**#ideas** · Suggestions and feedback. Post one idea per message so the team can follow each one, and add a 👍 to back an idea.`],
  memes: [`**#memes** · Light moments, still about Orrery.`],

  operators: [`**#operators** · For anyone running an AI agent.
At ${SITE}/operator you connect the wallet that owns the agent's Safe, open the agent by its ERC-8004 ID and set its orbit: per payment, daily and float caps, the contracts it may call, and the delay any raise must wait out. Bring setup questions here.`],
  "agent-builders": [`**#agent-builders** · For developers whose agents pay.
An agent pays in USDG over x402 from its own signer, inside the caps its operator set. The SDK is documented at ${SITE}/docs; code questions go here.`],
  merchants: [`**#merchants** · For services that take payments from agents.
Take a reading of any paying address at no cost on ${SITE}/signer, or call \`checkPayer\` from your code using check credits from ${SITE}/credits, then confirm the signed reading with \`verifyCheck\`.`],
  showcase: [`**#showcase** · Agents, integrations and dashboards built on Orrery. A short description plus a link reads best.`],

  "orry-chat": [`**#orry-chat** · Conversation about ORRY. Orrery's revenue flows into ORRY: most of the USDG Orrery earns buys ORRY for stakers and for burning, and the ORRY pools send their swap fees to Earn. How-to questions fit better in ${L("earn-and-stake")}.`],
  "earn-and-stake": [`**#earn-and-stake** · Earn, Stake and Claim questions answered here.
> **Earn** ${SITE}/earn: add to the ORRY/ETH or ORRY/USDG pool; 85% of each swap fee streams to Earn shares over 7 days.
> **Stake** ${SITE}/stake: receive a share of Orrery revenue in ETH and ORRY. Unstaking takes 7 days, or 14 days for stake behind an agent.
> **Claim** ${SITE}/claim: collect all rewards in a single transaction.`],
  "burn-tracker": [`**#burn-tracker** · The bot posts each ORRY burn here with its amount, source and transaction. ${SITE}/burn charts the full history.`],

  help: [`**#help** · Questions about using Orrery. Say which page you were on and what you expected to see. Keep your seed phrase and private key to yourself, here and in DMs.`],
  "bug-reports": [`**#bug-reports** · To report a bug, include:
> 1. The steps you took
> 2. The result you expected
> 3. The result you got
> 4. Page, browser and wallet
> 5. The transaction hash, when there is one
Confirmed reports can earn a reward through ${L("bounty-board")}.`],
  "docs-and-guides": [`# Docs and guides

**Overview** ${SITE}/docs
**Set an agent's caps** ${SITE}/operator
**Take a reading of a payer** ${SITE}/signer
**Check credits** ${SITE}/credits
**Earn** ${SITE}/docs/earn · **Stake** ${SITE}/docs/stake · **Claims** ${SITE}/docs/claims

The team posts each new guide in this room.`],

  missions: [`# Missions

Community missions and events are posted here with the task, the reward and the deadline. A mission's reward is locked when the mission is created and paid to its winners when it ends. Missions that can be verified on chain are claimed directly; the rest are announced with a public review window before payout.`],
  achievements: [`# Achievements

Mission and event winners, plus achievement standings, are posted here. ${SITE}/leaderboard shows the current stakers and earners.`],
  "bounty-board": [`# Bounty board

Bug bounties and rewarded tasks are listed here with their reward and scope. Send findings to ${L("bug-reports")}; the team confirms valid ones in this room.`],

  "team-chat": [`**#team-chat** · Team room.`],
  "moderation-log": [`**#moderation-log** · Moderators record warnings, removals and bans here, with the reason for each.`],
  alerts: [`**#alerts** · The Orrery bot reports operational alerts here: indexer lag and low gas on the relayer, attester and keeper wallets, no more than once every six hours per alert.`],
};

const me = await call("GET", "/users/@me");
for (const [name, msgs] of Object.entries(CONTENT)) {
  const id = ch[name];
  if (!id) { console.log(`missing #${name}`); continue; }
  if (!textRoom.has(id)) { console.log(`skip    #${name} (forum: its guidelines carry the text)`); continue; }
  const recent = await call("GET", `/channels/${id}/messages?limit=50`);
  const mine = recent.filter((m) => m.author?.id === me.id && m.type === 0 && !m.content.startsWith("🔒"));
  if (mine.length && update) {
    const first = mine[mine.length - 1];
    if (first.content !== msgs[0]) { await call("PATCH", `/channels/${id}/messages/${first.id}`, { content: msgs[0], allowed_mentions: { parse: [] } }); console.log(`updated #${name}`); }
    else console.log(`same    #${name}`);
    continue;
  }
  if (mine.length) { console.log(`skip    #${name} (already posted)`); continue; }
  if (dry) { console.log(`post    #${name} (${msgs.join("").length} chars)`); continue; }
  for (const content of msgs) {
    if (content.length > 2000) throw new Error(`#${name} message is ${content.length} characters`);
    const m = await call("POST", `/channels/${id}/messages`, { content, allowed_mentions: { parse: [] }, flags: 4 });
    await call("PUT", `/channels/${id}/pins/${m.id}`);
  }
  console.log(`posted  #${name}`);
}
