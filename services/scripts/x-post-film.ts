/**
 * Posts a film with its caption on X as @OrreryHQ (owner approval per post). Reads the X block of a captions file.
 *   tsx scripts/x-post-film.ts <video.mp4> <captions.md> [--dry-run]
 * Credentials: ~/.secrets/orrery/x-api.json (OAuth 1.0a, read and write), never printed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadXCredentials } from "../packages/server/src/support-x.js";
import { xMedia } from "../packages/server/src/x-media.js";

const [video, captions] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!video || !captions) throw new Error("usage: tsx scripts/x-post-film.ts <video.mp4> <captions.md> [--dry-run]");
const text = readFileSync(captions, "utf8").split(/^## X/m)[1]?.match(/```\n([\s\S]*?)\n```/)?.[1];
if (!text) throw new Error(`No X caption block in ${captions}.`);
const bytes = new Uint8Array(readFileSync(video));
console.log(`video ${video} (${(bytes.length / 1048576).toFixed(1)} MiB)\ncaption (${text.length} chars):\n${text}\n`);
if (process.argv.includes("--dry-run")) process.exit(0);
const c = loadXCredentials(join(homedir(), ".secrets/orrery/x-api.json"));
if (!c) throw new Error("~/.secrets/orrery/x-api.json is missing or incomplete.");
const x = xMedia(c);
const media = await x.uploadVideo(bytes, (s) => console.log(s));
const id = await x.post(text, [media]);
console.log(`posted https://x.com/OrreryHQ/status/${id}`);
