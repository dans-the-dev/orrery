import type { Sql } from "./db.js";
import type { DiscordApi } from "./discord.js";
import { draftProblems, type Draft, type Drafter, type Incoming, type SupportSource } from "./support-draft.js";
import type { Mention, XClient } from "./support-x.js";

/**
 * Support queue: public questions on Discord and X mentions get a drafted reply in the private #reply-queue room.
 * Answers from the docs and greetings (the owner's allowlist) are sent at once, within a daily cap, and shown in the queue
 * as "Sent automatically"; everything else waits until an Admin or Core Team member reacts ✅ (send) or ❌ (skip), and a
 * reply to a queue post with new text replaces the draft first. ❌ on a sent item deletes the reply. Every item is one row
 * in `support_items`, so a restart never sends twice.
 */

export const QUEUE_CHANNEL = "reply-queue";
export const APPROVER_ROLES = ["Admin", "Core Team"];
export const STAFF_ROLES = ["Admin", "Core Team", "Moderator"];
export const SEND = "✅";
export const SKIP = "❌";

export interface SupportItem {
  id: string;
  source: SupportSource;
  source_id: string;
  channel_id: string | null;
  author: string;
  text: string;
  link: string;
  category: string;
  reason: string;
  draft: string;
  status: "pending" | "sending" | "sent" | "skipped" | "failed" | "deleted";
  queue_message_id: string | null;
  sent_id?: string | null;
  sent_ref?: string | null;
  decided_by?: string | null;
}

export interface AutoSend {
  /** Draft categories sent without approval (owner, 2026-11-11: "faq" and "greeting"). Empty turns auto-send off. */
  categories: Set<string>;
  /** Automatic sends across Discord and X per rolling 24 hours; past it, items wait for approval. */
  maxPerDay: number;
  /** Automatic replies to one author per rolling hour; past it, items wait for approval. */
  maxPerAuthorHour: number;
}

export interface SupportContext {
  sql: Sql;
  api: DiscordApi;
  guildId: string;
  botUserId: string;
  queueChannelId: string;
  /** True for channels never read: the TEAM category and its threads, the queue itself, bot-only rooms. */
  ignored: (channelId: string) => boolean;
  roleIds: Record<string, string>;
  draft: Drafter;
  x: XClient | null;
  log: (fields: Record<string, unknown>) => void;
  maxDraftsPerDay: number;
  auto: AutoSend;
  /** Role pinged (at most every 15 minutes) when an item needs the owner. */
  pingRoleId?: string;
}

// ------------------------------------------------------------------ pure parts

/** Cheap filter before a paid draft: questions, mentions of the bot, or longer messages. Chatter and reactions stay out. */
export function worthDrafting(text: string, mentionsBot: boolean): boolean {
  const t = text.trim();
  if (t.length < 3) return false;
  if (mentionsBot) return true;
  if (/^(gm|gn|lol|lmao|nice|ok|okay|wow|ty|thx|thanks)[.!]*$/i.test(t)) return false;
  if (t.includes("?")) return true;
  if (/\b(how|what|when|where|why|which|who|can|does|do|is|are|help|error|bug|issue|fail(ed)?|stuck|lost|refund|price|apa|bagaimana|kapan|kenapa|gimana|bisa|cara|tolong)\b/i.test(t)) return true;
  return t.length >= 80;
}

export function discordLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

const quote = (s: string, max = 900) => (s.length > max ? s.slice(0, max) + " …" : s).split("\n").map((l) => `> ${l}`).join("\n");

const LABEL: Record<string, string> = { faq: "Answer from the docs", greeting: "Greeting", needs_owner: "Needs you", not_for_us: "No reply needed" };

/** The queue post an approver sees. */
export function queuePost(i: Pick<SupportItem, "source" | "author" | "text" | "link" | "category" | "reason" | "draft" | "status">, where: string, note?: string): string {
  const head = `**${i.source === "x" ? "X mention" : "Discord"}** · ${where} · ${i.author} · <${i.link}>`;
  const problems = i.draft ? draftProblems(i.draft, i.source) : ["empty"];
  const lines = [
    head,
    quote(i.text),
    `**${LABEL[i.category] ?? i.category}**${i.reason ? `: ${i.reason}` : ""}`,
    i.draft ? "Draft:\n" + quote(i.draft, 2000) : "No draft yet.",
  ];
  if (i.status === "pending") {
    lines.push(problems.length ? `Fix before sending: ${problems.join("; ")}. Reply to this post with the text to send.` : `React ${SEND} to send, ${SKIP} to skip, or reply to this post with the text to send instead.`);
  }
  if (note) lines.push(note);
  return lines.join("\n").slice(0, 2000);
}

// ------------------------------------------------------------------ store

async function insertItem(sql: Sql, it: Omit<SupportItem, "id" | "status" | "queue_message_id">): Promise<SupportItem | null> {
  const rows = await sql<SupportItem[]>`
    insert into support_items (source, source_id, channel_id, author, text, link, category, reason, draft)
    values (${it.source}, ${it.source_id}, ${it.channel_id}, ${it.author}, ${it.text}, ${it.link}, ${it.category}, ${it.reason}, ${it.draft})
    on conflict (source, source_id) do nothing returning *`;
  return rows[0] ?? null;
}

async function draftsToday(sql: Sql): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from support_items where created_at > now() - interval '1 day'`;
  return r!.n;
}

export async function getState(sql: Sql, key: string): Promise<string | null> {
  const [r] = await sql<{ value: string }[]>`select value from support_state where key = ${key}`;
  return r?.value ?? null;
}

export async function setState(sql: Sql, key: string, value: string): Promise<void> {
  await sql`insert into support_state (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

// ------------------------------------------------------------------ queue

async function enqueue(c: SupportContext, item: Omit<SupportItem, "id" | "status" | "queue_message_id" | "category" | "reason" | "draft">, m: Incoming): Promise<void> {
  const [seen] = await c.sql`select 1 from support_items where source = ${item.source} and source_id = ${item.source_id}`;
  if (seen) return;
  if ((await draftsToday(c.sql)) >= c.maxDraftsPerDay) {
    c.log({ support: "daily draft cap reached", cap: c.maxDraftsPerDay, skipped: item.link });
    return;
  }
  let d: Draft;
  try {
    d = await c.draft(m);
  } catch (e) {
    d = { reply: true, category: "needs_owner", draft: "", reason: `Drafting failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}).` };
  }
  if (!d.reply) {
    c.log({ support: "no reply needed", link: item.link });
    return;
  }
  const row = await insertItem(c.sql, { ...item, category: d.category, reason: d.reason, draft: d.draft });
  if (!row) return; // already queued
  const react = async (id: string, emojis: string[]) => {
    for (const e of emojis) await c.api.raw("PUT", `/channels/${c.queueChannelId}/messages/${id}/reactions/${encodeURIComponent(e)}/@me`);
  };

  const why = await autoBlock(c, row);
  if (!why) {
    // Claimed before sending, exactly like an approval, so a crash in between never sends twice.
    const [claimed] = await c.sql<SupportItem[]>`update support_items set status = 'sending', decided_by = 'auto', decided_at = now() where id = ${row.id} and status = 'pending' returning *`;
    if (!claimed) return;
    const done = await sendItem(c, claimed);
    const note = done.status === "sent" ? `Sent automatically: <${done.sent_ref}>. React ${SKIP} to delete it.` : `Automatic send failed: ${done.error ?? "unknown error"}`;
    const msg = (await c.api.raw("POST", `/channels/${c.queueChannelId}/messages`, { content: queuePost(done, m.where, note), allowed_mentions: { parse: [] } })) as { id: string };
    await c.sql`update support_items set queue_message_id = ${msg.id} where id = ${row.id}`;
    if (done.status === "sent") await react(msg.id, [SKIP]);
    c.log({ support: done.status === "sent" ? "sent automatically" : "auto send failed", id: row.id, source: row.source, category: d.category });
    return;
  }

  const ping = d.category === "needs_owner" && c.pingRoleId ? await pingDue(c.sql) : false;
  const head = ping ? `<@&${c.pingRoleId}> ` : "";
  const note = c.auto.categories.has(row.category) ? `Waiting for you: ${why}.` : undefined;
  const msg = (await c.api.raw("POST", `/channels/${c.queueChannelId}/messages`, {
    content: (head + queuePost(row, m.where, note)).slice(0, 2000),
    allowed_mentions: ping ? { parse: [], roles: [c.pingRoleId] } : { parse: [] },
  })) as { id: string };
  await c.sql`update support_items set queue_message_id = ${msg.id} where id = ${row.id}`;
  await react(msg.id, [SEND, SKIP]);
  c.log({ support: "queued", id: row.id, source: row.source, category: d.category });
}

/** Why an item may not be sent automatically, or null when it may. */
async function autoBlock(c: SupportContext, row: SupportItem): Promise<string | null> {
  if (!c.auto.categories.has(row.category)) return "needs approval";
  if (draftProblems(row.draft, row.source).length) return "the draft needs an edit";
  if (row.source === "x" && !c.x) return "X is not configured";
  const [day] = await c.sql<{ n: number }[]>`select count(*)::int as n from support_items where decided_by = 'auto' and decided_at > now() - interval '1 day'`;
  if (day!.n >= c.auto.maxPerDay) return `the daily limit of ${c.auto.maxPerDay} automatic replies is reached`;
  const [hour] = await c.sql<{ n: number }[]>`select count(*)::int as n from support_items where decided_by = 'auto' and author = ${row.author} and source = ${row.source} and decided_at > now() - interval '1 hour'`;
  if (hour!.n >= c.auto.maxPerAuthorHour) return `${row.author} already got ${c.auto.maxPerAuthorHour} automatic replies this hour`;
  return null;
}

/** True at most once per 15 minutes, so a burst of hard questions pings the owner once. */
async function pingDue(sql: Sql): Promise<boolean> {
  const rows = await sql`
    insert into support_state (key, value) values ('last_ping', now()::text)
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where support_state.updated_at < now() - interval '15 minutes'
    returning key`;
  return rows.length === 1;
}

/** Sends a claimed item (status 'sending') and records the outcome. Discord replies quote the question; X replies thread. */
export async function sendItem(c: SupportContext, row: SupportItem): Promise<SupportItem & { error?: string | null }> {
  try {
    let ref: string;
    let sentId: string;
    if (row.source === "discord") {
      const sent = (await c.api.raw("POST", `/channels/${row.channel_id}/messages`, {
        content: row.draft,
        message_reference: { message_id: row.source_id, channel_id: row.channel_id, guild_id: c.guildId, fail_if_not_exists: false },
        allowed_mentions: { parse: [], replied_user: true },
      })) as { id: string };
      sentId = sent.id;
      ref = discordLink(c.guildId, row.channel_id!, sent.id);
    } else {
      if (!c.x) throw new Error("X is not configured");
      sentId = await c.x.reply(row.draft, row.source_id);
      ref = `https://x.com/OrreryHQ/status/${sentId}`;
    }
    const [done] = await c.sql<SupportItem[]>`update support_items set status = 'sent', sent_id = ${sentId}, sent_ref = ${ref} where id = ${row.id} returning *`;
    c.log({ support: "sent", id: row.id, source: row.source, by: row.decided_by });
    return done!;
  } catch (e) {
    const error = e instanceof Error ? e.message.split("\n")[0]! : String(e);
    const [failed] = await c.sql<SupportItem[]>`update support_items set status = 'failed', error = ${error} where id = ${row.id} returning *`;
    c.log({ support: "send failed", id: row.id, error });
    return { ...failed!, error };
  }
}

const hasRole = (roles: string[] | undefined, ids: string[]) => Boolean(roles?.some((r) => ids.includes(r)));
const idsFor = (c: SupportContext, names: string[]) => names.map((n) => c.roleIds[n]).filter((x): x is string => Boolean(x));

interface GatewayMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  member?: { roles?: string[] };
  mentions?: { id: string }[];
  message_reference?: { message_id?: string };
  referenced_message?: { content?: string } | null;
}

/** MESSAGE_CREATE: a public question becomes a queue item; an approver's reply to a queue post replaces its draft. */
export async function onMessage(c: SupportContext, m: GatewayMessage, channelName: (id: string) => string): Promise<void> {
  if (m.guild_id !== c.guildId || m.author.bot) return;
  if (m.channel_id === c.queueChannelId) {
    const ref = m.message_reference?.message_id;
    if (!ref || !hasRole(m.member?.roles, idsFor(c, APPROVER_ROLES))) return;
    const [row] = await c.sql<SupportItem[]>`
      update support_items set draft = ${m.content.trim()}, reason = ${"Draft replaced by " + m.author.username + "."}
      where queue_message_id = ${ref} and status = 'pending' returning *`;
    if (!row) return;
    await c.api.raw("PATCH", `/channels/${c.queueChannelId}/messages/${ref}`, { content: queuePost(row, row.source === "x" ? "mention" : `#${channelName(row.channel_id ?? "")}`), allowed_mentions: { parse: [] } });
    return;
  }
  if (c.ignored(m.channel_id)) return;
  if (hasRole(m.member?.roles, idsFor(c, STAFF_ROLES))) return;
  const mentionsBot = Boolean(m.mentions?.some((u) => u.id === c.botUserId));
  if (!worthDrafting(m.content, mentionsBot)) return;
  const author = m.author.global_name ?? m.author.username;
  const where = `#${channelName(m.channel_id)}`;
  await enqueue(
    c,
    { source: "discord", source_id: m.id, channel_id: m.channel_id, author, text: m.content, link: discordLink(c.guildId, m.channel_id, m.id) },
    { source: "discord", author, text: m.content, where, inReplyTo: m.referenced_message?.content || undefined },
  );
}

interface GatewayReaction {
  user_id: string;
  channel_id: string;
  message_id: string;
  guild_id?: string;
  member?: { roles?: string[]; user?: { username: string } };
  emoji: { name: string | null };
}

/**
 * MESSAGE_REACTION_ADD on a queue post by an approver: ✅ sends a waiting draft; ❌ skips a waiting item, or deletes the
 * reply of a sent one (automatic or approved).
 */
export async function onReaction(c: SupportContext, r: GatewayReaction, channelName: (id: string) => string): Promise<void> {
  if (r.channel_id !== c.queueChannelId || r.user_id === c.botUserId) return;
  if (r.emoji.name !== SEND && r.emoji.name !== SKIP) return;
  if (!hasRole(r.member?.roles, idsFor(c, APPROVER_ROLES))) return;
  const by = r.member?.user?.username ?? r.user_id;
  const where = (i: SupportItem) => (i.source === "x" ? "mention" : `#${channelName(i.channel_id ?? "")}`);
  const edit = (i: SupportItem, note: string) => c.api.raw("PATCH", `/channels/${c.queueChannelId}/messages/${r.message_id}`, { content: queuePost(i, where(i), note), allowed_mentions: { parse: [] } });

  if (r.emoji.name === SKIP) {
    const [skipped] = await c.sql<SupportItem[]>`update support_items set status = 'skipped', decided_by = ${by}, decided_at = now() where queue_message_id = ${r.message_id} and status = 'pending' returning *`;
    if (skipped) return void (await edit(skipped, `Skipped by ${by}.`));
    // Undo: claim the sent item, delete its reply, then record it.
    const [sent] = await c.sql<SupportItem[]>`update support_items set status = 'sending' where queue_message_id = ${r.message_id} and status = 'sent' returning *`;
    if (!sent) return;
    try {
      if (sent.source === "discord") await c.api.raw("DELETE", `/channels/${sent.channel_id}/messages/${sent.sent_id}`);
      else if (c.x) await c.x.deleteTweet(sent.sent_id!);
      else throw new Error("X is not configured");
      const [gone] = await c.sql<SupportItem[]>`update support_items set status = 'deleted' where id = ${sent.id} returning *`;
      await edit(gone!, `Reply deleted by ${by}.`);
      c.log({ support: "deleted", id: sent.id, source: sent.source });
    } catch (e) {
      await c.sql`update support_items set status = 'sent' where id = ${sent.id}`;
      await edit(sent, `Could not delete the reply: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
    return;
  }
  // Claim the item first, so two clicks or a restart can never send it twice.
  const [row] = await c.sql<SupportItem[]>`update support_items set status = 'sending', decided_by = ${by}, decided_at = now() where queue_message_id = ${r.message_id} and status = 'pending' returning *`;
  if (!row) return;
  const problems = draftProblems(row.draft, row.source);
  if (problems.length) {
    await c.sql`update support_items set status = 'pending', decided_by = null, decided_at = null where id = ${row.id}`;
    await edit({ ...row, status: "pending" }, `Not sent: ${problems.join("; ")}.`);
    return;
  }
  const done = await sendItem(c, row);
  await edit(done, done.status === "sent" ? `Sent by ${by}: <${done.sent_ref}>. React ${SKIP} to delete it.` : `Sending failed: ${done.error ?? "unknown error"}`);
}

/** One X pass: new mentions since the last one become queue items. The first pass only records where to start. */
export async function pollX(c: SupportContext, me: { id: string; username: string }): Promise<number> {
  if (!c.x) return 0;
  const since = await getState(c.sql, "x_since_id");
  // An account with no mentions yet has no id to start from, so the start is kept as a time until the first one arrives.
  const startTime = since ? null : await getState(c.sql, "x_start_time");
  const firstPass = !since && !startTime;
  const mentions: Mention[] = await c.x.mentions(me.id, since ?? undefined, startTime ?? undefined);
  if (mentions.length === 0) {
    if (firstPass) await setState(c.sql, "x_start_time", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
    return 0;
  }
  const newest = mentions.reduce((a, b) => (BigInt(b.id) > BigInt(a) ? b.id : a), mentions[0]!.id);
  await setState(c.sql, "x_since_id", newest);
  if (firstPass) {
    c.log({ support: "x start", sinceId: newest, skippedOlder: mentions.length });
    return 0;
  }
  let queued = 0;
  for (const t of [...mentions].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
    if (t.authorId === me.id) continue;
    await enqueue(
      c,
      { source: "x", source_id: t.id, channel_id: null, author: `@${t.username}`, text: t.text, link: `https://x.com/${t.username}/status/${t.id}` },
      { source: "x", author: `@${t.username}`, text: t.text, where: "mention" },
    );
    queued++;
  }
  return queued;
}

/** Finds or creates #reply-queue next to #release-drafts, with the same (team-only) permissions. */
export async function ensureQueueChannel(api: DiscordApi, guildId: string): Promise<{ queueId: string; teamCategoryId: string | null }> {
  const channels = (await api.raw("GET", `/guilds/${guildId}/channels`)) as { id: string; name: string; type: number; parent_id: string | null; permission_overwrites: unknown[] }[];
  const drafts = channels.find((c) => c.type === 0 && c.name === "release-drafts");
  const existing = channels.find((c) => c.type === 0 && c.name === QUEUE_CHANNEL);
  if (existing) return { queueId: existing.id, teamCategoryId: drafts?.parent_id ?? existing.parent_id };
  if (!drafts) throw new Error("#release-drafts not found; cannot copy team-only permissions for #reply-queue");
  const created = (await api.raw("POST", `/guilds/${guildId}/channels`, {
    name: QUEUE_CHANNEL,
    type: 0,
    parent_id: drafts.parent_id,
    permission_overwrites: drafts.permission_overwrites,
    topic: `Drafted replies to Discord questions and X mentions. ${SEND} sends, ${SKIP} skips, a reply to a post replaces its draft.`,
  })) as { id: string };
  return { queueId: created.id, teamCategoryId: drafts.parent_id };
}
