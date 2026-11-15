/**
 * Support process: drafts replies to public Discord questions and the Orrery X account mentions on X. Answers from the docs and
 * greetings are sent at once within a daily cap (ORRERY_SUPPORT_AUTO, ..._AUTO_MAX_DAY, ..._AUTO_MAX_AUTHOR_HOUR); the
 * rest wait in the private #reply-queue room until an Admin or Core Team member reacts ✅. Needs
 * ORRERY_DISCORD_TOKEN_FILE, ORRERY_DISCORD_GUILD, ORRERY_DATABASE_URL and ORRERY_ANTHROPIC_KEY_FILE; X is optional
 * (ORRERY_SUPPORT_X_FILE). Never logs a key, a token or a message text.
 */
import { readFileSync } from "node:fs";
import { connect, migrate } from "../db.js";
import { discordRest, loadDiscordConfig, READ_ONLY_ROOMS, roleIdsByName } from "../discord.js";
import { buildKb } from "../support-kb.js";
import { makeDrafter } from "../support-draft.js";
import { startGateway } from "../support-gateway.js";
import { loadXCredentials, xClient } from "../support-x.js";
import { ensureQueueChannel, getState, onMessage, onReaction, pollX, setState, type SupportContext } from "../support.js";

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
const err = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

const d = loadDiscordConfig();
if (!d) throw new Error("Set ORRERY_DISCORD_TOKEN_FILE and ORRERY_DISCORD_GUILD to run the support process.");
const keyFile = process.env.ORRERY_ANTHROPIC_KEY_FILE;
if (!keyFile) throw new Error("Set ORRERY_ANTHROPIC_KEY_FILE (a file holding ANTHROPIC_API_KEY=... or the bare key).");
const keyText = readFileSync(keyFile, "utf8");
const apiKey = (keyText.match(/^\s*ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s]+)/m)?.[1] ?? keyText.trim()).trim();
if (!apiKey.startsWith("sk-ant")) throw new Error(`${keyFile} does not hold an Anthropic API key.`);

const sql = connect(process.env.ORRERY_DATABASE_URL ?? "postgres://orrery:orrery@127.0.0.1:55432/orrery");
await migrate(sql);
const api = discordRest(d);

// Knowledge base: the live site and API, refreshed every 30 minutes; the last good text stays when a refresh fails.
const webUrl = d.webUrl;
const apiUrl = (process.env.ORRERY_SUPPORT_API_URL ?? "https://api.orrery.tech").replace(/\/$/, "");
let kb = "";
async function refreshKb() {
  const r = await buildKb({ webUrl, apiUrl });
  if (r.text.length > 2000) kb = r.text;
  log({ support: "kb", chars: kb.length, missing: r.missing });
}
await refreshKb();
setInterval(() => void refreshKb().catch((e) => log({ support: "kb failed", error: err(e) })), Number(process.env.ORRERY_SUPPORT_KB_EVERY_MS ?? 30 * 60_000));

// The server's public rooms, so a draft can point people to #help or #ideas; rebuilt when channels change.
let rooms = "";
const draft = makeDrafter({ apiKey, kb: () => (rooms ? `${kb}\n\n${rooms}` : kb), model: process.env.ORRERY_SUPPORT_MODEL ?? "claude-opus-5-5" });
const xCreds = loadXCredentials(process.env.ORRERY_SUPPORT_X_FILE);
const x = xCreds ? xClient(xCreds) : null;

const roleIds = await roleIdsByName(api);
// Owner, 2026-11-11: replies come from the bot under the server nickname "Orrery Team".
const nick = process.env.ORRERY_SUPPORT_NICK ?? "Orrery Team";
if (nick) await api.raw("PATCH", `/guilds/${d.guildId}/members/@me`, { nick }).catch((e) => log({ support: "nickname failed", error: err(e) }));
const { queueId, teamCategoryId } = await ensureQueueChannel(api, d.guildId);

// Channel names and parents, kept current from gateway events, so threads (forum posts) resolve to their room.
const channels = new Map<string, { name: string; parent: string | null; type: number; topic: string }>();
const remember = (c: { id: string; name?: string; parent_id?: string | null; type?: number; topic?: string | null }) => {
  const prev = channels.get(c.id);
  channels.set(c.id, { name: c.name ?? prev?.name ?? c.id, parent: c.parent_id ?? null, type: c.type ?? prev?.type ?? 0, topic: c.topic ?? prev?.topic ?? "" });
};
const describeRooms = () => {
  const list = [...channels.entries()]
    .filter(([id, c]) => (c.type === 0 || c.type === 15) && !ignored(id))
    .map(([, c]) => `#${c.name}${c.type === 15 ? " (forum)" : ""}${c.topic ? `: ${c.topic.replace(/\s+/g, " ").slice(0, 160)}` : ""}`)
    .sort();
  rooms = list.length ? `# Public Discord rooms\nThere are no tickets: questions and problems belong in the #help forum, suggestions in #ideas, bug reports in #bug-reports.\n${list.join("\n")}` : "";
};
const channelName = (id: string) => channels.get(id)?.name ?? id;
const ignored = (id: string): boolean => {
  if (id === queueId) return true;
  const c = channels.get(id);
  if (!c) return false;
  if (READ_ONLY_ROOMS.has(c.name)) return true;
  if (teamCategoryId && c.parent === teamCategoryId) return true;
  return c.parent ? ignored(c.parent) : false;
};

const ctx: SupportContext = {
  sql,
  api,
  guildId: d.guildId,
  botUserId: "",
  queueChannelId: queueId,
  ignored,
  roleIds,
  draft,
  x,
  log,
  maxDraftsPerDay: Number(process.env.ORRERY_SUPPORT_MAX_DRAFTS_DAY ?? 300),
  // Owner, 2026-11-11: answers from the docs and greetings go out at once; everything else waits for approval.
  auto: {
    categories: new Set((process.env.ORRERY_SUPPORT_AUTO ?? "faq,greeting").split(",").map((s) => s.trim()).filter(Boolean)),
    maxPerDay: Number(process.env.ORRERY_SUPPORT_AUTO_MAX_DAY ?? 40),
    maxPerAuthorHour: Number(process.env.ORRERY_SUPPORT_AUTO_MAX_AUTHOR_HOUR ?? 3),
  },
  pingRoleId: roleIds["Admin"],
};

startGateway({
  token: d.token,
  log,
  onDispatch: async (event, data) => {
    switch (event) {
      case "READY":
        ctx.botUserId = (data as { user: { id: string } }).user.id;
        break;
      case "GUILD_CREATE": {
        const g = data as { id: string; channels?: { id: string; name: string; parent_id: string | null; type: number; topic?: string | null }[]; threads?: { id: string; name: string; parent_id: string | null; type: number }[] };
        if (g.id !== d.guildId) break;
        for (const c of [...(g.channels ?? []), ...(g.threads ?? [])]) remember(c);
        describeRooms();
        log({ support: "guild", channels: channels.size, roomsChars: rooms.length });
        break;
      }
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
        remember(data as { id: string; name?: string; parent_id?: string | null; type?: number; topic?: string | null });
        describeRooms();
        break;
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
        remember(data as { id: string; name?: string; parent_id?: string | null });
        break;
      case "THREAD_LIST_SYNC":
        for (const t of (data as { threads?: { id: string; name: string; parent_id: string | null }[] }).threads ?? []) remember(t);
        break;
      case "MESSAGE_CREATE":
        await onMessage(ctx, data as Parameters<typeof onMessage>[1], channelName);
        break;
      case "MESSAGE_REACTION_ADD":
        await onReaction(ctx, data as Parameters<typeof onReaction>[1], channelName);
        break;
    }
  },
});
log({ support: "started", queue: "#reply-queue", x: Boolean(x), maxDraftsPerDay: ctx.maxDraftsPerDay, auto: [...ctx.auto.categories], autoMaxPerDay: ctx.auto.maxPerDay });

if (x) {
  // The account id is read once and kept, since every X read is billed.
  let me = await getState(sql, "x_me").then((s) => (s ? (JSON.parse(s) as { id: string; username: string }) : null));
  const everyMs = Number(process.env.ORRERY_SUPPORT_X_EVERY_MS ?? 5 * 60_000);
  for (;;) {
    try {
      if (!me) {
        me = await x.me();
        await setState(sql, "x_me", JSON.stringify(me));
      }
      const queued = await pollX(ctx, me);
      if (queued) log({ support: "x", queued });
    } catch (e) {
      log({ support: "x failed", error: err(e) });
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
