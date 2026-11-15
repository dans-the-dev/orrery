// Walk: lane L3 pages on a local stack (anvil 31337, scripts/r2-stack.ts, the API, the R2 indexer and keeper, next dev).
// Two walk wallets (anvil accounts 11 and 12, development keys only) open a prediction market, stake both sides, sign a
// limit order the keeper fills, and fund an agent's gas; screenshots at 1440 and 375 wide, and the held state.
// Run: node scripts/walk/r2-walk.mjs <web base> <api> <rpc> <stack.json> <shots dir>
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");

const [base = "http://localhost:3203", api = "http://127.0.0.1:18647", rpc = "http://127.0.0.1:18640", stackFile, out = "r2-shots"] = process.argv.slice(2);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(rpc)) throw new Error("the R2 walk runs against a local anvil only");
const stack = JSON.parse(readFileSync(stackFile, "utf8"));
mkdirSync(out, { recursive: true });
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
// anvil's well-known development mnemonic; the key files live beside the screenshots, outside the repository
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
  page.on("response", (r) => r.status() >= 400 && r.url().includes("/v1/") && findings.push(`${r.status()} ${r.url().slice(0, 100)}`));
  const w = await attachWallet(page, { keyFile: keyFile(i), rpc, chainId: 31337, name: `Walk wallet ${i}` });
  return { page, w };
}
async function connect(page) {
  // the button stays disabled until the page has hydrated (a first dev compile can take a while)
  const b = page.getByRole("button", { name: "Connect wallet", disabled: false }).first();
  await b.waitFor({ timeout: 120000 }).catch(() => {});
  if (await b.count()) {
    await b.click();
    await page.waitForTimeout(1500);
  }
}
// warm the dev server: compile every page once before the walk
for (const r of ["/predict", "/limit-orders", "/gas", "/shield"]) await fetch(`${base}${r}`).catch(() => {});
async function notice(page, re, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const all = await page.locator(".rc-notice").allInnerTexts().catch(() => []);
    const hit = all.find((t) => re.test(t));
    if (hit) return hit;
    const err = all.find((t) => /did not go through|closed|Not enough/i.test(t));
    if (err) throw new Error(err);
    await page.waitForTimeout(800);
  }
  throw new Error(`no notice matching ${re}`);
}
async function shot(page, name, full = true) {
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: full });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) findings.push(`${name}: horizontal overflow ${overflow}px`);
  say(`shot ${name}`);
}

const shotsOnly = process.env.WALK_SHOTS_ONLY === "1";
const alice = await open(11);
if (!shotsOnly) {
// ---------------------------------------------------------------- Predict
await alice.page.goto(`${base}/predict`, { waitUntil: "networkidle" });
await connect(alice.page);
await alice.page.locator("#predict-strike").fill("360");
await alice.page.getByRole("button", { name: "Open the market" }).click();
say(await notice(alice.page, /Market created/));
await alice.page.waitForTimeout(4000);
await alice.page.reload({ waitUntil: "networkidle" });
await connect(alice.page);
await alice.page.getByRole("tab", { name: /^YES/ }).click();
await alice.page.locator("#predict-amt").fill("100");
await alice.page.getByRole("button", { name: /^Stake on YES/ }).click();
say(await notice(alice.page, /Staked/));

const bob = await open(12);
await bob.page.goto(`${base}/predict`, { waitUntil: "networkidle" });
await connect(bob.page);
await bob.page.getByRole("tab", { name: /^NO/ }).click();
await bob.page.locator("#predict-amt").fill("300");
await bob.page.getByRole("button", { name: /^Stake on NO/ }).click();
say(await notice(bob.page, /Staked/));
await alice.page.waitForTimeout(6000);
await alice.page.reload({ waitUntil: "networkidle" });
await alice.page.waitForTimeout(3000);
await shot(alice.page, "predict-1440");

// ---------------------------------------------------------------- Limit orders
await alice.page.goto(`${base}/limit-orders`, { waitUntil: "networkidle" });
await connect(alice.page);
await alice.page.getByText(/Chainlink/).first().waitFor({ timeout: 30000 });
await alice.page.getByRole("tab", { name: "Sell" }).click();
await alice.page.locator("#limit-amt").fill("1");
await alice.page.locator("#limit-price").fill("350");
await alice.page.getByRole("button", { name: /^Sign sell order/ }).click();
say(await notice(alice.page, /Order placed/));
// the keeper fills it on its next pass; the indexer records the fill
let status = "";
for (let i = 0; i < 30; i++) {
  const r = await fetch(`${api}/v1/r2/limit-orders?owner=${alice.w.address}`).then((x) => x.json());
  status = r.orders?.[0]?.status ?? "";
  if (status === "filled") break;
  await new Promise((res) => setTimeout(res, 2000));
}
say(`limit order status: ${status}`);
await alice.page.reload({ waitUntil: "networkidle" });
await alice.page.waitForTimeout(3000);
await shot(alice.page, "limit-orders-1440");

// ---------------------------------------------------------------- Gas in ORRY
await alice.page.goto(`${base}/gas`, { waitUntil: "networkidle" });
await connect(alice.page);
await alice.page.locator("input[placeholder^='0x']").fill(stack.accounts.agent);
await alice.page.locator("#gas-amt").fill("500");
await alice.page.getByRole("button", { name: "Fund gas" }).click();
say(await notice(alice.page, /ready for/));
await alice.page.waitForTimeout(3000);
await shot(alice.page, "gas-1440");
} else {
  for (const r of ["/predict", "/limit-orders", "/gas", "/shield"]) {
    await alice.page.goto(`${base}${r}`, { waitUntil: "networkidle" });
    await connect(alice.page);
    await alice.page.waitForTimeout(4000);
    await shot(alice.page, `${r.slice(1)}-1440`);
  }
}

// ---------------------------------------------------------------- phone width
// the phone layout before a wallet connects (the shim answers on desktop and phone alike; connecting is the desktop walk)
const phone = await open(11, 375);
for (const r of ["/predict", "/limit-orders", "/gas", "/shield"]) {
  await phone.page.goto(`${base}${r}`, { waitUntil: "networkidle" });
  await phone.page.waitForTimeout(4000);
  await shot(phone.page, `${r.slice(1)}-375`);
}

// ---------------------------------------------------------------- the account view (never held) and the API
const acc = await fetch(`${api}/v1/r2/accounts/${alice.w.address}`).then((x) => x.json());
say(`account: ${JSON.stringify({ predict: acc.predict, orders: acc.limitOrders?.map((o) => o.status), gas: acc.gas })}`);
await browser.close();
say(findings.length ? `FINDINGS:\n${[...new Set(findings)].join("\n")}` : "no console errors, no failed API calls, no overflow");
