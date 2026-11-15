/**
 * Posts a plan on X as @OrreryHQ, one item after another (owner approval covers the plan).
 *   tsx scripts/x-send.ts <plan.json> [--dry-run]
 * plan.json: [{ "text": "...", "image"?: "file.png", "video"?: "file.mp4", "replyTo"?: "<post id>" | "prev" | "first",
 *              "quote"?: "<post id>", "waitSec"?: 240, "label"?: "..." }]
 * Results are appended to <plan>.result.jsonl; an item already recorded there is skipped, so a rerun never posts twice.
 * Credentials: ~/.secrets/orrery/x-api.json (never printed).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadXCredentials } from "../packages/server/src/support-x.js";
import { xMedia } from "../packages/server/src/x-media.js";

interface Item { text: string; image?: string; video?: string; replyTo?: string; quote?: string; waitSec?: number; label?: string }
const planFile = process.argv[2];
if (!planFile) throw new Error("usage: tsx scripts/x-send.ts <plan.json> [--dry-run]");
const plan = JSON.parse(readFileSync(planFile, "utf8")) as Item[];
const resultFile = `${planFile}.result.jsonl`;
const done = new Map<number, { id?: string; error?: string }>();
if (existsSync(resultFile)) for (const l of readFileSync(resultFile, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l) as { i: number; id?: string; error?: string }; done.set(r.i, r); }
const dry = process.argv.includes("--dry-run");
for (const [i, it] of plan.entries()) {
  const w = it.text.replace(/https?:\/\/\S+|\b[a-z0-9-]+\.(tech|gg|com)\/?\S*/gi, "x".repeat(23)).length;
  if (w > 280) throw new Error(`item ${i} is ${w} characters by X's count (limit 280)`);
  if (/[—–]/.test(it.text)) throw new Error(`item ${i} has a dash used as punctuation`);
}
if (dry) { for (const [i, it] of plan.entries()) console.log(`${i} ${it.label ?? ""} replyTo=${it.replyTo ?? "-"} quote=${it.quote ?? "-"} media=${it.image ?? it.video ?? "-"} wait=${it.waitSec ?? 0}s\n${it.text}\n`); process.exit(0); }
const c = loadXCredentials(join(homedir(), ".secrets/orrery/x-api.json"));
if (!c) throw new Error("~/.secrets/orrery/x-api.json is missing or incomplete.");
const x = xMedia(c);
const ids: (string | undefined)[] = plan.map((_, i) => done.get(i)?.id);
for (const [i, it] of plan.entries()) {
  if (done.has(i)) continue;
  if (it.waitSec) await new Promise((r) => setTimeout(r, it.waitSec! * 1000));
  try {
    const replyTo = it.replyTo === "prev" ? ids[i - 1] : it.replyTo === "first" ? ids[0] : it.replyTo;
    if (it.replyTo && !replyTo) throw new Error("the post this one replies to was not posted");
    const media: string[] = [];
    if (it.image) media.push(await x.uploadImage(new Uint8Array(readFileSync(it.image)), it.image.endsWith(".png") ? "image/png" : "image/jpeg"));
    if (it.video) media.push(await x.uploadVideo(new Uint8Array(readFileSync(it.video))));
    const id = await x.post(it.text, media, { replyTo, quote: it.quote });
    ids[i] = id;
    appendFileSync(resultFile, JSON.stringify({ i, id, label: it.label, at: new Date().toISOString() }) + "\n");
    console.log(`${i} posted https://x.com/OrreryHQ/status/${id} ${it.label ?? ""}`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    appendFileSync(resultFile, JSON.stringify({ i, error, label: it.label, at: new Date().toISOString() }) + "\n");
    console.log(`${i} FAILED ${it.label ?? ""}: ${error}`);
  }
}
