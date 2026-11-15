import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, migrate, type DiscordApi, type Sql } from "@orrery/server";
import type { Drafter, Incoming } from "../packages/server/src/support-draft.js";
import type { Mention, XClient } from "../packages/server/src/support-x.js";
import { onMessage, onReaction, pollX, type SupportContext } from "../packages/server/src/support.js";
import { DATABASE_URL } from "./env.js";

/**
 * The support queue end to end against Postgres, with Discord, X and the model faked: with auto-send off nothing leaves
 * without ✅; with it on, only allowlisted categories go out at once, within the caps, and ❌ deletes a sent reply.
 */
const GUILD = "g1";
const QUEUE = "q1";
const BOT = "bot1";
const ADMIN_ROLE = "r-admin";
const MOD_ROLE = "r-mod";

let sql: Sql;
const calls: { method: string; path: string; body?: unknown }[] = [];
let nextId = 100;
const api = {
  raw: async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return method === "POST" ? { id: String(nextId++) } : null;
  },
} as unknown as DiscordApi;

const drafted: Incoming[] = [];
const draft: Drafter = async (m) => {
  drafted.push(m);
  if (m.text.includes("price")) return { reply: true, category: "needs_owner", draft: "The team will follow up here.", reason: "Price question." };
  if (m.text.includes("meme")) return { reply: false, category: "not_for_us", draft: "", reason: "" };
  return { reply: true, category: "faq", draft: "Set caps at orrery.tech/operator.", reason: "" };
};

const sentX: { text: string; to: string }[] = [];
const deletedX: string[] = [];
let mentions: Mention[] = [];
let mentionArgs: (string | undefined)[] = [];
const x: XClient = {
  me: async () => ({ id: "x-me", username: "OrreryHQ" }),
  mentions: async (...args) => {
    mentionArgs = args;
    return mentions;
  },
  reply: async (text, to) => {
    sentX.push({ text, to });
    return `tw-reply-${sentX.length}`;
  },
  deleteTweet: async (id) => {
    deletedX.push(id);
  },
};

const ctx = (auto: string[] = [], maxPerDay = 50, maxPerAuthorHour = 3): SupportContext => ({
  sql, api, guildId: GUILD, botUserId: BOT, queueChannelId: QUEUE, ignored: (id) => id === "team-room",
  roleIds: { Admin: ADMIN_ROLE, Moderator: MOD_ROLE }, draft, x, log: () => {}, maxDraftsPerDay: 50,
  auto: { categories: new Set(auto), maxPerDay, maxPerAuthorHour }, pingRoleId: ADMIN_ROLE,
});
const name = (id: string) => ({ c1: "general" })[id as "c1"] ?? id;
const msg = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ id, channel_id: "c1", guild_id: GUILD, content, author: { id: "u1", username: "ann" }, member: { roles: [] }, ...extra });
const react = (message_id: string, emoji: string, roles = [ADMIN_ROLE]) => ({ user_id: "owner", channel_id: QUEUE, message_id, guild_id: GUILD, member: { roles, user: { username: "owner" } }, emoji: { name: emoji } });
const posts = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

beforeAll(async () => {
  sql = connect(DATABASE_URL);
  await migrate(sql);
  await sql`truncate support_items, support_state`;
});
afterAll(async () => {
  await sql.end();
});

describe("support queue", () => {
  it("queues a drafted question and sends nothing yet", async () => {
    await onMessage(ctx(), msg("m1", "how do I set a spending cap?"), name);
    const [row] = await sql`select * from support_items where source_id = 'm1'`;
    expect(row).toMatchObject({ status: "pending", category: "faq", channel_id: "c1" });
    expect(posts(`/channels/${QUEUE}/messages`)).toHaveLength(1);
    expect(posts("/channels/c1/messages")).toHaveLength(0);
    expect(drafted.at(-1)).toMatchObject({ source: "discord", where: "#general", author: "ann" });
  });

  it("ignores staff, bots, chatter, team rooms, the queue and messages already queued", async () => {
    const before = drafted.length;
    await onMessage(ctx(), msg("m2", "how?", { member: { roles: [MOD_ROLE] } }), name);
    await onMessage(ctx(), msg("m3", "how?", { author: { id: "b", username: "b", bot: true } }), name);
    await onMessage(ctx(), msg("m4", "gm"), name);
    await onMessage(ctx(), msg("m5", "how?", { channel_id: "team-room" }), name);
    await onMessage(ctx(), msg("m1", "how do I set a spending cap?"), name);
    expect(drafted.length).toBe(before);
    await onMessage(ctx(), msg("m6", "look at this meme, is it good?"), name);
    expect(drafted.length).toBe(before + 1);
    expect(await sql`select 1 from support_items where source_id = 'm6'`).toHaveLength(0);
  });

  it("only an approver's ✅ sends, exactly once, as a reply to the question", async () => {
    const [row] = await sql<{ queue_message_id: string }[]>`select queue_message_id from support_items where source_id = 'm1'`;
    await onReaction(ctx(), react(row!.queue_message_id, "✅", [MOD_ROLE]), name);
    expect(posts("/channels/c1/messages")).toHaveLength(0);
    await onReaction(ctx(), react(row!.queue_message_id, "✅"), name);
    await onReaction(ctx(), react(row!.queue_message_id, "✅"), name);
    const sent = posts("/channels/c1/messages");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ content: "Set caps at orrery.tech/operator.", message_reference: { message_id: "m1" }, allowed_mentions: { parse: [] } });
    const [after] = await sql`select status, decided_by, sent_ref from support_items where source_id = 'm1'`;
    expect(after).toMatchObject({ status: "sent", decided_by: "owner" });
  });

  it("an approver's reply replaces the draft before sending; ❌ skips", async () => {
    await onMessage(ctx(), msg("m7", "what is the ORRY price?"), name);
    const [row] = await sql<{ queue_message_id: string; category: string }[]>`select queue_message_id, category from support_items where source_id = 'm7'`;
    expect(row!.category).toBe("needs_owner");
    await onMessage(ctx(), { ...msg("m8", "Thanks for asking. Price is set by the market on Pons."), channel_id: QUEUE, member: { roles: [ADMIN_ROLE] }, message_reference: { message_id: row!.queue_message_id } }, name);
    const [edited] = await sql`select draft from support_items where source_id = 'm7'`;
    expect(edited!.draft).toBe("Thanks for asking. Price is set by the market on Pons.");
    await onMessage(ctx(), msg("m9", "where are the docs for staking?"), name);
    const [skip] = await sql<{ queue_message_id: string }[]>`select queue_message_id from support_items where source_id = 'm9'`;
    await onReaction(ctx(), react(skip!.queue_message_id, "❌"), name);
    await onReaction(ctx(), react(skip!.queue_message_id, "✅"), name);
    const [s] = await sql`select status from support_items where source_id = 'm9'`;
    expect(s!.status).toBe("skipped");
  });

  it("refuses to send a draft that breaks a hard rule", async () => {
    await onMessage(ctx(), msg("m10", "how do I verify my agent?"), name);
    const [row] = await sql<{ queue_message_id: string }[]>`select queue_message_id from support_items where source_id = 'm10'`;
    await sql`update support_items set draft = ${"Verify on the testnet first"} where source_id = 'm10'`;
    const before = posts("/channels/c1/messages").length;
    await onReaction(ctx(), react(row!.queue_message_id, "✅"), name);
    expect(posts("/channels/c1/messages")).toHaveLength(before);
    const [s] = await sql`select status from support_items where source_id = 'm10'`;
    expect(s!.status).toBe("pending");
  });

  it("X: the first pass only records where to start; later mentions are queued and sent on ✅", async () => {
    const me = await x.me();
    mentions = [{ id: "100", text: "@OrreryHQ old question?", authorId: "a1", username: "old", createdAt: "" }];
    expect(await pollX(ctx(), me)).toBe(0);
    mentions = [
      { id: "101", text: "@OrreryHQ how do caps work?", authorId: "a2", username: "bob", createdAt: "" },
      { id: "102", text: "my own post", authorId: "x-me", username: "OrreryHQ", createdAt: "" },
    ];
    expect(await pollX(ctx(), me)).toBe(1);
    const [row] = await sql<{ queue_message_id: string; link: string }[]>`select queue_message_id, link from support_items where source = 'x' and source_id = '101'`;
    expect(row!.link).toBe("https://x.com/bob/status/101");
    expect(sentX).toHaveLength(0);
    await onReaction(ctx(), react(row!.queue_message_id, "✅"), name);
    expect(sentX).toEqual([{ text: "Set caps at orrery.tech/operator.", to: "101" }]);
    const [s] = await sql`select status, sent_ref from support_items where source_id = '101'`;
    expect(s).toMatchObject({ status: "sent", sent_ref: "https://x.com/OrreryHQ/status/tw-reply-1" });
  });
});

describe("automatic replies", () => {
  const AUTO = ["faq", "greeting"];
  const sentTo = (id: string) => posts("/channels/c1/messages").filter((p) => (p.body as { message_reference?: { message_id: string } }).message_reference?.message_id === id);

  it("sends an answer from the docs at once and shows it in the queue with an undo", async () => {
    await onMessage(ctx(AUTO), msg("a1", "how do caps work?", { author: { id: "u2", username: "cat" } }), name);
    expect(sentTo("a1")).toHaveLength(1);
    const [row] = await sql`select status, decided_by, sent_id from support_items where source_id = 'a1'`;
    expect(row).toMatchObject({ status: "sent", decided_by: "auto" });
    const queuePost = calls.filter((c) => c.method === "POST" && c.path === `/channels/${QUEUE}/messages`).at(-1)!.body as { content: string };
    expect(queuePost.content).toContain("Sent automatically");
  });

  it("keeps a question that needs the owner waiting, and pings the owner once per 15 minutes", async () => {
    await sql`delete from support_state where key = 'last_ping'`;
    await onMessage(ctx(AUTO), msg("a2", "what will the price be?", { author: { id: "u3", username: "dan" } }), name);
    await onMessage(ctx(AUTO), msg("a3", "price next week?", { author: { id: "u4", username: "eve" } }), name);
    expect(sentTo("a2")).toHaveLength(0);
    const [row] = await sql`select status from support_items where source_id = 'a2'`;
    expect(row!.status).toBe("pending");
    const queued = calls.filter((c) => c.method === "POST" && c.path === `/channels/${QUEUE}/messages`).slice(-2).map((c) => c.body as { content: string; allowed_mentions: { roles?: string[] } });
    expect(queued[0]!.content.startsWith(`<@&${ADMIN_ROLE}>`)).toBe(true);
    expect(queued[0]!.allowed_mentions.roles).toEqual([ADMIN_ROLE]);
    expect(queued[1]!.content.startsWith("<@&")).toBe(false);
  });

  it("stops at the per-author and daily caps and leaves the rest for approval", async () => {
    for (const id of ["b1", "b2", "b3", "b4"]) await onMessage(ctx(AUTO, 50, 3), msg(id, "how do I verify an agent?", { author: { id: "u5", username: "fay" } }), name);
    expect(["b1", "b2", "b3", "b4"].map((id) => sentTo(id).length)).toEqual([1, 1, 1, 0]);
    const [waiting] = await sql`select status from support_items where source_id = 'b4'`;
    expect(waiting!.status).toBe("pending");
    const [day] = await sql<{ n: number }[]>`select count(*)::int as n from support_items where decided_by = 'auto'`;
    await onMessage(ctx(AUTO, day!.n, 3), msg("b5", "how do I verify an agent?", { author: { id: "u6", username: "gus" } }), name);
    expect(sentTo("b5")).toHaveLength(0);
  });

  it("❌ on a sent reply deletes it, on Discord and on X", async () => {
    const [row] = await sql<{ queue_message_id: string; sent_id: string }[]>`select queue_message_id, sent_id from support_items where source_id = 'a1'`;
    await onReaction(ctx(AUTO), react(row!.queue_message_id, "❌", [MOD_ROLE]), name);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    await onReaction(ctx(AUTO), react(row!.queue_message_id, "❌"), name);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([`/channels/c1/messages/${row!.sent_id}`]);
    const [gone] = await sql`select status from support_items where source_id = 'a1'`;
    expect(gone!.status).toBe("deleted");

    mentions = [{ id: "200", text: "@OrreryHQ how do caps work?", authorId: "a9", username: "hal", createdAt: "" }];
    expect(await pollX(ctx(AUTO), await x.me())).toBe(1);
    const [tw] = await sql<{ queue_message_id: string; sent_id: string; status: string }[]>`select queue_message_id, sent_id, status from support_items where source = 'x' and source_id = '200'`;
    expect(tw!.status).toBe("sent");
    await onReaction(ctx(AUTO), react(tw!.queue_message_id, "❌"), name);
    expect(deletedX).toEqual([tw!.sent_id]);
  });

  it("X: an account with no mentions yet starts from the time of the first pass, so its first mention is answered", async () => {
    await sql`delete from support_state where key in ('x_since_id', 'x_start_time')`;
    const me = await x.me();
    mentions = [];
    expect(await pollX(ctx(), me)).toBe(0);
    const [start] = await sql<{ value: string }[]>`select value from support_state where key = 'x_start_time'`;
    expect(start!.value).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    mentions = [{ id: "300", text: "@OrreryHQ is staking open?", authorId: "a7", username: "ivy", createdAt: "" }];
    expect(await pollX(ctx(), me)).toBe(1);
    expect(mentionArgs).toEqual([me.id, undefined, start!.value]);
    mentions = [];
    expect(await pollX(ctx(), me)).toBe(0);
    expect(mentionArgs[1]).toBe("300");
  });
});
