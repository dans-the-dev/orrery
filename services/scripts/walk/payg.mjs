// Walk: pay per check with ORRY on the credits page. Quotes a number of checks, pays the quote (approve when needed,
// then burnForCredits), waits for the credits to reach the address, and reads the balance with the wallet's API key.
//   node payg.mjs <web base> <rpc> <chainId> <key file> <api base> [checks] [shots dir]
import { createRequire } from "node:module";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { attachWallet } from "./wallet.mjs";
const require = createRequire(process.env.WALK_PLAYWRIGHT ?? "/home/dand/Projects/promo-films/_pw/package.json");
const { chromium } = require("playwright-core");
const [base, rpc, chainIdIn, keyFile, api, checksIn = "3", shots = "."] = process.argv.slice(2);
if (!base || !rpc || !chainIdIn || !keyFile || !api) throw new Error("usage: node payg.mjs <web base> <rpc> <chainId> <key file> <api base> [checks] [shots dir]");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !m.text().includes("_rsc") && errors.push(m.text().slice(0, 200)));
const w = await attachWallet(page, { keyFile, rpc, chainId: Number(chainIdIn) });
const signer = privateKeyToAccount(JSON.parse(readFileSync(keyFile, "utf8")).privateKey);
const say = (s) => console.log(s);
const block = page.locator(".rc-checkout-grid > div").filter({ has: page.getByRole("heading", { name: "Pay per check" }) });

await page.goto(base + "/credits", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await page.getByRole("button", { name: /connect/i }).first().click().catch(() => {});
await page.waitForTimeout(1500);
if ((await block.count()) === 0) {
  say("Pay per check is not on the page (held, or checkout held)");
  await browser.close();
  process.exit(1);
}
say(`1 block: ${(await block.innerText()).replace(/\n/g, " · ")}`);

// the balance before, through the wallet's own key (signed rotation)
const keyFor = async () => {
  const n = await (await fetch(`${api}/v1/keys/nonce?address=${w.address}`)).json();
  const signature = await signer.signMessage({ message: n.message });
  const r = await fetch(`${api}/v1/keys/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: w.address, nonce: n.nonce, signature }) });
  return (await r.json()).apiKey;
};
const creditsOf = async (key) => BigInt((await (await fetch(`${api}/v1/credits`, { headers: { authorization: `Bearer ${key}` } })).json()).credits ?? 0);
let key = await keyFor();
const before = await creditsOf(key);
say(`2 credits before: ${before}`);

await block.getByLabel("Checks").fill(checksIn);
await page.waitForTimeout(300);
say(`3 unit: ${await block.locator(".rc-unit").innerText()}`);
await block.getByRole("button", { name: "Get ORRY price" }).click();
await block.getByRole("button", { name: /^Pay .* ORRY$|Not enough ORRY/ }).waitFor({ timeout: 20000 });
say(`4 quote: ${(await block.locator(".rc-rows").innerText()).replace(/\n/g, " · ")}`);
await block.getByRole("button", { name: /^Pay .* ORRY$/ }).click();
const notice = async () => (await block.locator(".rc-notice").last().innerText().catch(() => "")).trim();
for (let i = 0; i < 60 && !/Paid and burned|rejected|failed|did not/i.test(await notice()); i++) await page.waitForTimeout(1000);
say(`5 paid: ${await notice()}`);

let after = before;
for (let i = 0; i < 60 && after === before; i++) {
  await page.waitForTimeout(2000);
  key = await keyFor();
  after = await creditsOf(key);
}
say(`6 credits after: ${after} (+${after - before})`);
await page.screenshot({ path: join(shots, "walk-payg.png"), fullPage: false, clip: { x: 0, y: Math.max(0, (await block.boundingBox())?.y - 200 || 0), width: 1440, height: 700 } });
say(`wallet calls: ${[...new Set(w.log)].join(", ")}`);
say(errors.length ? `console errors: ${[...new Set(errors)].join(" | ")}` : "no console errors");
await browser.close();
