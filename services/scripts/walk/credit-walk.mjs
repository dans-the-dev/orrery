// Walk: lane L4 pages on a local stack (anvil 31337, scripts/credit-local.ts, the API, the credit indexer, next dev).
// Wallets are anvil development accounts only: the lender (6) lends and withdraws, the operator (5) draws on and repays
// its agent's line, a new wallet (9) becomes an attester. Screenshots at 1440 and 375 wide, held and open.
// Run: node scripts/walk/credit-walk.mjs <web base> <rpc> <stack.json> <shots dir> <phase: held|open>
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");

const [base = "http://localhost:3204", rpc = "http://127.0.0.1:18661", stackFile, out = "credit-shots", phase = "open"] = process.argv.slice(2);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(rpc)) throw new Error("the L4 walk runs against a local anvil only");
const stack = JSON.parse(readFileSync(stackFile, "utf8"));
mkdirSync(out, { recursive: true });
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const keyFile = (i) => {
  const pk = toHex(mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i }).getHdKey().privateKey);
  const f = join(out, `.walk-key-${i}.json`);
  writeFileSync(f, JSON.stringify({ privateKey: pk }), { mode: 0o600 });
  return f;
};
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const findings = [];
async function open(i, width = 1440) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 768 ? 812 : 1100 }, ...(width < 768 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && findings.push(`console (${i}): ${m.text().slice(0, 160)}`));
  page.on("response", (r) => r.status() >= 400 && r.url().includes("/v1/") && !r.url().includes("/v1/attesters/0x") && findings.push(`${r.status()} ${r.url().slice(0, 100)}`));
  await attachWallet(page, { keyFile: keyFile(i), rpc, chainId: 31337, name: `Walk wallet ${i}` });
  return page;
}
async function connect(page) {
  const b = page.getByRole("button", { name: "Connect wallet", disabled: false }).first();
  await b.waitFor({ timeout: 120000 }).catch(() => {});
  if (await b.count()) {
    await b.click();
    await page.waitForTimeout(1500);
  }
}
async function notice(page, re, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const all = await page.locator(".rc-notice").allInnerTexts().catch(() => []);
    const hit = all.find((t) => re.test(t));
    if (hit) return hit;
    const err = all.find((t) => /did not go through|closed|Not enough|reverted/i.test(t));
    if (err) throw new Error(err);
    await page.waitForTimeout(800);
  }
  throw new Error(`no notice matching ${re}`);
}
const shot = async (page, name, full = true) => {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: full });
  say(`shot ${name}`);
};
for (const r of ["/credit", "/attesters", "/dashboard"]) await fetch(`${base}${r}`).catch(() => {});

if (phase === "held") {
  const p = await open(6);
  await p.goto(`${base}/credit`, { waitUntil: "networkidle" });
  await connect(p);
  await p.getByText("Credit opens soon.").waitFor({ timeout: 60000 });
  await p.getByRole("button", { name: "Withdraw all" }).waitFor({ timeout: 30000 }); // never held: the lender's exit
  await shot(p, "credit-held-1440");
  await p.goto(`${base}/attesters`, { waitUntil: "networkidle" });
  await p.getByText("Attesters open soon.").waitFor({ timeout: 60000 });
  await shot(p, "attesters-held-1440");
  await p.goto(`${base}/dashboard`, { waitUntil: "networkidle" });
  await p.locator(".dsh-nav a", { hasText: "Credit" }).waitFor({ timeout: 60000 });
  await shot(p, "dashboard-sidebar-held-1440", false);
} else {
  // lender: lend 500 USDG, then withdraw 200
  const lender = await open(6);
  await lender.goto(`${base}/credit`, { waitUntil: "networkidle" });
  await connect(lender);
  await lender.locator("#cr-lend").waitFor({ timeout: 60000 });
  await lender.locator("#cr-lend").fill("500");
  await lender.getByRole("button", { name: "Lend USDG" }).click();
  say(await notice(lender, /lent to the pool/));
  await lender.getByRole("tab", { name: "Withdraw" }).click();
  await lender.locator("#cr-out").fill("200");
  await lender.getByRole("button", { name: "Withdraw USDG" }).click();
  say(await notice(lender, /back in your wallet/));
  await shot(lender, "credit-lender-1440");
  // operator: its agent's line, draw 100 then repay 50
  const op = await open(5);
  await op.goto(`${base}/credit`, { waitUntil: "networkidle" });
  await connect(op);
  await op.locator("input[placeholder='328']").waitFor({ timeout: 60000 });
  await op.locator("input[placeholder='328']").fill(stack.agent);
  await op.locator(".cr-meter").waitFor({ timeout: 60000 });
  await op.getByRole("tab", { name: "Draw", exact: true }).click();
  await op.locator("#cr-line").fill("100");
  await op.getByRole("button", { name: "Draw USDG" }).click();
  say(await notice(op, /sent to the agent wallet/));
  await op.getByRole("tab", { name: "Repay", exact: true }).click();
  await op.locator("#cr-line").fill("50");
  await op.getByRole("button", { name: "Repay" }).last().click();
  say(await notice(op, /Repaid/));
  await op.locator(".cr-meter").scrollIntoViewIfNeeded();
  await shot(op, "credit-operator-1440");
  // a new attester stakes 1,000,000 ORRY with a probe key
  const at = await open(6);
  await at.goto(`${base}/attesters`, { waitUntil: "networkidle" });
  await connect(at);
  await at.locator("#at-amt").waitFor({ timeout: 60000 });
  await at.locator("#at-amt").fill("1000000");
  await at.locator("input[placeholder='0x…']").fill(stack.accounts.operator2);
  await at.getByRole("button", { name: "Stake ORRY" }).click();
  say(await notice(at, /staked as an attester/));
  await shot(at, "attesters-1440");
  // phone width
  const m = await open(6, 375);
  await m.goto(`${base}/credit`, { waitUntil: "networkidle" });
  await connect(m);
  await m.locator("#cr-lend").waitFor({ timeout: 60000 });
  await shot(m, "credit-375");
  await m.goto(`${base}/attesters`, { waitUntil: "networkidle" });
  await m.locator("#at-amt").or(m.getByRole("tab", { name: "Leave" })).first().waitFor({ timeout: 60000 });
  await shot(m, "attesters-375");
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) findings.push(`horizontal overflow at 375: ${overflow}px`);
}
await browser.close();
console.log(findings.length ? `findings:\n${findings.join("\n")}` : "no console errors, no failed API calls");
