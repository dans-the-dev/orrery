/**
 * Fresh-post watcher for the Orrery X account (docs/launch/x-playbook.md): waits until an account on the watch list, or a larger
 * account on our keywords, publishes a post we could reply to while it is fresh, prints the candidates as JSON lines and
 * exits. It posts nothing. Replies go out by hand or through the logged-in browser.
 *   tsx scripts/x-watch.ts [--minutes 180] [--every 15]
 * State (newest post seen per query, posts already offered): ~/.cache/orrery-ux/x-watch-state.json
 * Cost: X bills each post returned, so every query carries since_id (or start_time on its first run).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadXCredentials, oauth1Header } from "../packages/server/src/support-x.js";

const arg = (n: string, d: number) => { const i = process.argv.indexOf(n); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const MINUTES = arg("--minutes", 180);
const EVERY = arg("--every", 15);
const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, "../../docs/launch/x-accounts.json"), "utf8")) as { niche: string[]; nicheWords: string; ecosystem: string[]; keywordQuery: string; keywordMinFollowers: number; maxAgeMinutes: number };
const stateFile = join(homedir(), ".cache/orrery-ux/x-watch-state.json");
mkdirSync(dirname(stateFile), { recursive: true });
const state: { since: Record<string, string>; offered: string[] } = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { since: {}, offered: [] };
const c = loadXCredentials(join(homedir(), ".secrets/orrery/x-api.json"));
if (!c) throw new Error("~/.secrets/orrery/x-api.json is missing or incomplete.");
const URL_ = "https://api.x.com/2/tweets/search/recent";
const from = (names: string[]) => `(${names.map((n) => `from:${n}`).join(" OR ")}) -is:retweet -is:reply`;
const queries: { key: string; query: string; kind: "niche" | "ecosystem" | "keyword" }[] = [
  { key: "niche", query: from(cfg.niche), kind: "niche" },
  { key: "ecosystem", query: from(cfg.ecosystem), kind: "ecosystem" },
  { key: "keyword", query: cfg.keywordQuery, kind: "keyword" },
];
for (const q of queries) if (q.query.length > 512) throw new Error(`query "${q.key}" is ${q.query.length} characters (limit 512): shorten the list`);
const nicheRe = new RegExp(`\\b(${cfg.nicheWords})\\b`, "i");

async function pass(): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const q of queries) {
    const params: Record<string, string> = { query: q.query, max_results: "30", "tweet.fields": "created_at,public_metrics,reply_settings,author_id", expansions: "author_id", "user.fields": "username,public_metrics" };
    if (state.since[q.key]) params.since_id = state.since[q.key]!;
    else params.start_time = new Date(Date.now() - cfg.maxAgeMinutes * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
    const r = await fetch(`${URL_}?${new URLSearchParams(params)}`, { headers: { authorization: oauth1Header("GET", URL_, params, c!) } });
    const j = (await r.json()) as { data?: any[]; includes?: { users?: any[] }; meta?: { newest_id?: string }; title?: string; detail?: string };
    if (!r.ok) { console.error(`query ${q.key}: ${r.status} ${j.title ?? ""} ${j.detail ?? ""}`); continue; }
    if (j.meta?.newest_id) state.since[q.key] = j.meta.newest_id;
    const users = new Map((j.includes?.users ?? []).map((u) => [u.id, u]));
    for (const t of j.data ?? []) {
      const u = users.get(t.author_id);
      const ageMin = (Date.now() - Date.parse(t.created_at)) / 60_000;
      if (!u || u.username.toLowerCase() === "orrerytech" || t.reply_settings !== "everyone" || ageMin > cfg.maxAgeMinutes || state.offered.includes(t.id)) continue;
      if (q.kind === "niche" && !nicheRe.test(t.text)) continue;
      // keyword hits come from anyone: keep larger accounts whose post is already being read, two per author at most
      if (q.kind === "keyword" && (u.public_metrics.followers_count < cfg.keywordMinFollowers || (t.public_metrics.impression_count < 150 && u.public_metrics.followers_count < 25000))) continue;
      if (out.filter((o) => (o as { user: string }).user === u.username).length >= 2) continue;
      state.offered.push(t.id);
      out.push({ id: t.id, url: `https://x.com/${u.username}/status/${t.id}`, user: u.username, followers: u.public_metrics.followers_count, kind: q.kind, ageMin: Math.round(ageMin), views: t.public_metrics.impression_count, replies: t.public_metrics.reply_count, text: t.text });
    }
  }
  state.offered = state.offered.slice(-500);
  writeFileSync(stateFile, JSON.stringify(state));
  return out;
}

const deadline = Date.now() + MINUTES * 60_000;
for (;;) {
  const found = await pass();
  if (found.length) { for (const f of found) console.log(JSON.stringify(f)); process.exit(0); }
  if (Date.now() + EVERY * 60_000 > deadline) { console.log(JSON.stringify({ none: true, watchedMinutes: MINUTES })); process.exit(0); }
  await new Promise((r) => setTimeout(r, EVERY * 60_000));
}
