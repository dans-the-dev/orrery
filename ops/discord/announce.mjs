// Posts an approved release card (ops/discord/cards/<feature>.png + captions.json) to #announcements. For use before
// the API is live; afterwards Admin and Core Team use /announce in Discord. Run only after the owner approved the card.
// Usage: node ops/discord/announce.mjs <guildId> <feature>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [guild, feature] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const token = readFileSync(join(homedir(), ".secrets/orrery/discord-bot.txt"), "utf8").trim();
const caption = JSON.parse(readFileSync(join(here, "cards/captions.json"), "utf8"))[feature];
if (!caption) throw new Error(`no caption for ${feature}`);
const png = readFileSync(join(here, `cards/${feature}.png`));
const chans = await (await fetch(`https://discord.com/api/v10/guilds/${guild}/channels`, { headers: { Authorization: `Bot ${token}` } })).json();
const ann = chans.find((c) => c.name === "announcements");
const form = new FormData();
form.append("payload_json", JSON.stringify({ content: caption, allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: `${feature}.png` }] }));
form.append("files[0]", new Blob([png], { type: "image/png" }), `${feature}.png`);
const r = await fetch(`https://discord.com/api/v10/channels/${ann.id}/messages`, { method: "POST", headers: { Authorization: `Bot ${token}` }, body: form });
console.log(r.ok ? `posted ${feature} to #announcements` : `failed: ${r.status} ${await r.text()}`);
