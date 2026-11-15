// Walk: Shield V2 on a local stack (anvil 31337, scripts/r2-stack.ts, the API with ORRERY_SHIELD, the R2 indexer,
// next dev). A walk wallet (anvil account 11, development key) opens its Shield (one signature, then a register
// transaction), deposits 100 USDG, then withdraws 20 USDG to another address with a proof made in the browser.
// Run: node scripts/walk/r2-shield-walk.mjs <web base> <rpc> <stack.json> <shots dir>
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");

const [base = "http://localhost:3203", rpc = "http://127.0.0.1:18640", stackFile, out = "r2-shots"] = process.argv.slice(2);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(rpc)) throw new Error("the walk runs against a local anvil only");
const stack = JSON.parse(readFileSync(stackFile, "utf8"));
mkdirSync(out, { recursive: true });
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const keyFile = join(out, ".walk-key-11.json");
writeFileSync(keyFile, JSON.stringify({ privateKey: toHex(mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 11 }).getHdKey().privateKey) }), { mode: 0o600 });

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const findings = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && findings.push(m.text().slice(0, 160)));
const w = await attachWallet(page, { keyFile, rpc, chainId: 31337, name: "Walk wallet 11" });

async function notice(re, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const all = await page.locator(".rc-notice").allInnerTexts().catch(() => []);
    const hit = all.find((t) => re.test(t));
    if (hit) return hit;
    const err = all.find((t) => /did not go through|closed|Not enough|could not/i.test(t));
    if (err) throw new Error(err);
    await page.waitForTimeout(1000);
  }
  throw new Error(`no notice matching ${re}`);
}

await page.goto(`${base}/shield`, { waitUntil: "networkidle" });
// the wallet may already be connected (an injected wallet that answers eth_accounts reconnects on load)
const openBtn = page.getByRole("button", { name: "Open my Shield" });
const connectBtn = page.getByRole("button", { name: "Connect wallet", disabled: false }).first();
await Promise.race([openBtn.waitFor({ timeout: 120000 }), connectBtn.waitFor({ timeout: 120000 })]);
if (!(await openBtn.isVisible())) {
  await connectBtn.click();
  await openBtn.waitFor({ timeout: 60000 });
}
await openBtn.click();
say(await notice(/Shield is open/, 120000));
await page.locator("#shield-in").fill("100");
await page.getByRole("button", { name: "Deposit", exact: true }).click();
say(await notice(/private balance/, 120000));
await page.getByRole("tab", { name: "Withdraw" }).click();
await page.locator("input[spellcheck='false']").fill(stack.accounts.bob);
await page.locator("#shield-amt").fill("20");
const started = Date.now();
await page.getByRole("button", { name: "Withdraw", exact: true }).click();
say(await notice(/withdrawn to/, 600000));
say(`withdrawal with an in-browser proof took ${Math.round((Date.now() - started) / 1000)} s, signing and confirming included`);
const pub = createPublicClient({ transport: http(rpc) });
const bobUsdg = await pub.readContract({ address: stack.usdg, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [stack.accounts.bob] });
say(`bob's USDG after the withdrawal: ${bobUsdg}`);
await page.waitForTimeout(3000);
await page.screenshot({ path: join(out, "shield-1440.png"), fullPage: true });
const phone = await (await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
await phone.goto(`${base}/shield`, { waitUntil: "networkidle" });
await phone.waitForTimeout(3000);
await phone.screenshot({ path: join(out, "shield-375.png"), fullPage: true });
await browser.close();
rmSync(keyFile);
say(findings.length ? `FINDINGS:\n${[...new Set(findings)].join("\n")}` : "no console errors");
void w;
