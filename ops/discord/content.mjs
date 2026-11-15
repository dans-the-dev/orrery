// Posts and pins the opening message of every Orrery Discord channel. Idempotent: a channel where the bot already
// posted is skipped. Usage: node ops/discord/content.mjs <guildId> [--dry-run]   Token: ~/.secrets/orrery/discord-bot.txt
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
const X = "https://x.com/OrreryHQ";
const INVITE = "https://discord.gg/zk3dybhead";
const all = await call("GET", `/guilds/${guild}/channels`);
const ch = Object.fromEntries(all.map((c) => [c.name, c.id]));
const textRoom = new Set(all.filter((c) => c.type === 0 || c.type === 5).map((c) => c.id));
const L = (name) => (ch[name] ? `<#${ch[name]}>` : `#${name}`);

const CONTENT = {
  welcome: [`# Welcome to Orrery

Orrery gives AI agents a budget they cannot exceed. Operators set public spending limits on the agent's own account, agents pay in USDG over x402, and anyone who receives a payment can check the payer and get a signed answer. ORRY is the token that runs on Orrery's revenue.

## Get started in four steps
**1. Read the rules** in ${L("rules")} and accept them when Discord asks. That opens every community room for you.
**2. Say hello** in ${L("introductions")}: who you are and what you build.
**3. Ask and share** in ${L("help")} and ${L("ideas")}. Rooms for operators, builders, merchants, ORRY and events appear in the sidebar as each feature goes live; ${L("announcements")} tells you when.
**4. Link your wallet** with \`/verify\` in any channel. You get the roles that match what you do on Orrery: Verified, ORRY Holder, Operator or Merchant.

**Boost the server** for a violet Orrery Booster name, images and files in every room, and the private #boosters lounge with release previews and first tester invites.

Need help? Ask in ${L("help")}. Official links only come from ${L("official-links")}.`],

  rules: [`# Rules

**1. Be respectful.** No harassment, hate speech or personal attacks.
**2. No spam or unsolicited self promotion.** Ask a moderator before sharing your own project.
**3. No financial advice requests or price talk pressure.** Discuss the product, not where the price goes.
**4. Protect yourself.** The team never DMs you first and never asks for a seed phrase, private key or a payment. Report anyone who does.
**5. Official links only.** Trust links from ${L("official-links")} and ${SITE}. Anything else may be fake.
**6. Stay on topic.** Use the room that fits your question.
**7. English in public rooms,** so everyone can follow.

Moderators may remove messages and members who break these rules. Accept the rules in Discord's prompt to open the community rooms.`],

  announcements: [`# Announcements

Releases, launch waves and product updates from the Orrery team appear here first. Follow this channel to get them in your own server too.

Orrery is live at ${SITE}.`],

  "official-links": [`# Official links

**Website** ${SITE}
**Docs** ${SITE}/docs
**X** ${X}
**Discord invite** ${INVITE}

**Contract addresses** are posted in this channel when they go live on Robinhood Chain, and on ${SITE}. Never trust an address from a DM or another channel.`],

  general: [`**#general** · Talk about anything Orrery: agents, payments, ideas, the product. For questions use ${L("help")}.`],
  introductions: [`**#introductions** · Say hello. Tell us who you are, what you are building and how you found Orrery.`],
  ideas: [`**#ideas** · Feature ideas and feedback. One idea per message helps the team track them; react with 👍 to support one.`],
  memes: [`**#memes** · Keep it fun and on topic.`],

  operators: [`**#operators** · For people who run an AI agent.
On ${SITE}/operator you connect the wallet that owns the agent's Safe, open the agent by its ERC-8004 ID, and set its limits: per payment, per day and float caps, the contracts it may call, and how long any increase must wait. Ask setup questions here.`],
  "agent-builders": [`**#agent-builders** · For developers building agents that pay.
Agents pay in USDG over x402 from their own signer, inside the caps their operator set. Read ${SITE}/docs for the SDK and share code questions here.`],
  merchants: [`**#merchants** · For services that receive payments from agents.
Look up any paying address free at ${SITE}/signer, or call \`checkPayer\` from your own code with check credits from ${SITE}/credits and verify the signed answer with \`verifyCheck\`.`],
  showcase: [`**#showcase** · Show what you built with Orrery: agents, integrations, dashboards. A short description and a link work best.`],

  "orry-chat": [`**#orry-chat** · Talk about ORRY. ORRY runs on Orrery's revenue: most of the USDG Orrery earns buys ORRY for stakers and for burning, and the ORRY pools pay their swap fees to Earn. Use ${L("earn-and-stake")} for how-to questions.`],
  "earn-and-stake": [`**#earn-and-stake** · Questions about Earn, Stake and Claim.
> **Earn** ${SITE}/earn: deposit into the ORRY/ETH or ORRY/USDG pool, 85% of every swap fee streams to Earn shares over 7 days.
> **Stake** ${SITE}/stake: a share of Orrery's revenue in ETH and ORRY. Unstaking takes 7 days, stake behind an agent 14 days.
> **Claim** ${SITE}/claim: every reward in one transaction.`],
  "burn-tracker": [`**#burn-tracker** · Every ORRY burn is posted here automatically, with its amount, its source and its transaction. The full history is on ${SITE}/burn.`],

  help: [`**#help** · Ask anything about using Orrery. Include the page you were on and what you expected to happen. Never share a seed phrase or private key, here or in DMs.`],
  "bug-reports": [`**#bug-reports** · Found a bug? Post:
> 1. What you did
> 2. What you expected
> 3. What happened instead
> 4. Page, browser and wallet
> 5. A transaction hash if one is involved
Valid reports can earn a reward through ${L("bounty-board")}.`],
  "docs-and-guides": [`# Docs and guides

**Start here** ${SITE}/docs
**Set an agent's limits** ${SITE}/operator
**Check a payer** ${SITE}/signer
**Buy check credits** ${SITE}/credits
**Earn** ${SITE}/docs/earn · **Stake** ${SITE}/docs/stake · **Claims** ${SITE}/docs/claims

New guides from the team are posted in this channel.`],

  missions: [`# Missions

Community missions and events are posted here: what to do, the reward and the deadline. Rewards are locked when a mission is created and paid to the winners when it ends. Missions that can be checked on chain are claimed directly; others are announced with a public check window before payout.`],
  achievements: [`# Achievements

Winners of missions and events, and achievement leaderboards, are posted here. The live leaderboard of stakers and earners is on ${SITE}/leaderboard.`],
  "bounty-board": [`# Bounty board

Bug bounties and reward tasks are listed here with their reward and scope. Report findings in ${L("bug-reports")}; the team confirms valid ones here.`],

  "team-chat": [`**#team-chat** · Core team only.`],
  "moderation-log": [`**#moderation-log** · Moderators note warnings, removals and bans here with the reason.`],
  alerts: [`**#alerts** · The Orrery bot posts operational alerts here: indexer lag and low gas on the relayer, attester and keeper wallets, at most once every six hours per alert.`],
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
