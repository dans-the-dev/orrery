// Walk: the Discord verify page on the development network. Takes a nonce and user id (as /verify in Discord would
// issue), connects the walk wallet, signs the one message and reports what the page answers. Run it twice with the same
// nonce to see the used-link answer.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");
const [nonce, user, base = "https://orrery-dev.vercel.app", shots = "."] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !/_rsc|402|400/.test(m.text()) && errors.push(m.text().slice(0, 200)));
await attachWallet(page, { keyFile: join(homedir(), ".secrets/orrery/46630-walk.json"), rpc: process.env.WALK_RPC ?? "https://robinhood-sepolia-rpc.publicnode.com", chainId: Number(process.env.WALK_CHAIN ?? 46630) });
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const status = async () => (await page.locator('[role="status"]').innerText().catch(() => "")).replace(/\s+/g, " ");
for (const round of [1, 2]) {
  await page.goto(`${base}/discord/verify?n=${nonce}&u=${user}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3000);
  const btn = page.getByRole("button", { name: /Sign|Verify/ }).first();
  await btn.waitFor({ timeout: 20000 });
  for (let i = 0; i < 15 && (await btn.isDisabled()); i++) await page.waitForTimeout(1000);
  await btn.click();
  let t = "";
  for (let i = 0; i < 30; i++) {
    t = await status();
    if (t && !/^Sign the message/.test(t)) break;
    await page.waitForTimeout(1000);
  }
  say(`${round}: ${t}`);
  if (round === 1) await page.screenshot({ path: join(shots, "walk-discord-verify.png"), fullPage: true });
}
say(`console errors: ${[...new Set(errors)].join(" | ") || "none"}`);
await browser.close();
