// Walk: lane L5 Agent Launch pages on a local stack (anvil 31337, scripts/launch-stack.ts, the API, the launch indexer,
// next dev). Walk wallets (anvil accounts 11, 12 and 13, development keys only): the agent's owner launches its coin with a
// first buy, a staker buys in the early window, then, after the chain moves past the public opening, a third wallet buys
// and sells through the router and splits the fees and pays the agent. Screenshots at 1440 and 375 wide, and the held state.
// Run: node scripts/walk/launch-walk.mjs <web base> <api> <rpc> <shots dir> <key dir>
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");

const [base = "http://localhost:3205", api = "http://127.0.0.1:18687", rpc = "http://127.0.0.1:18680", out = "launch-shots", keys = "launch-keys"] = process.argv.slice(2);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(rpc)) throw new Error("the launch walk runs against a local anvil only");
mkdirSync(out, { recursive: true });
mkdirSync(keys, { recursive: true, mode: 0o700 });
process.env.WALK_CHAIN_CLOCK = "1"; // the page clock follows the chain, which the walk moves past the early window
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const keyFile = (i) => {
  const pk = toHex(mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i }).getHdKey().privateKey);
  const f = join(keys, `.walk-key-${i}.json`);
  writeFileSync(f, JSON.stringify({ privateKey: pk }), { mode: 0o600 });
  return f;
};
const pub = createPublicClient({ transport: http(rpc) });

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const findings = [];
const contexts = [];
// the community lane's site-wide config route is not part of this stack; after the release closes, 404s are expected
let recording = true;
const record = (f) => recording && !f.includes("/v1/community/config") && findings.push(f);
async function open(i, width = 1440) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 768 ? 812 : 1100 }, ...(width < 768 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && !/status of 404/.test(m.text()) && record(`console (${i}): ${m.text().slice(0, 160)}`));
  page.on("response", (r) => r.status() >= 400 && r.url().includes("/v1/") && record(`${r.status()} ${r.url().slice(0, 100)}`));
  const w = await attachWallet(page, { keyFile: keyFile(i), rpc, chainId: 31337, name: `Walk wallet ${i}` });
  return { page, w };
}
async function connect(page) {
  const b = page.getByRole("button", { name: "Connect wallet", disabled: false }).first();
  await b.waitFor({ timeout: 120000 }).catch(() => {});
  if (await b.count()) {
    await b.click();
    await page.waitForTimeout(1500);
  }
}
async function notice(page, re, ms = 90000) {
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
async function indexed(pred, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fetch(`${api}/v1/launch/coins`).then((x) => x.json()).catch(() => null);
    if (r && pred(r)) return r;
    await pub.request({ method: "evm_mine", params: [] });
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error("the indexer did not catch up");
}
for (const r of ["/launch", "/launch/new"]) await fetch(`${base}${r}`).catch(() => {});

// ---------------------------------------------------------------- launch
const alice = await open(11);
await alice.page.goto(`${base}/launch`, { waitUntil: "networkidle" });
await connect(alice.page);
await alice.page.waitForTimeout(2500);
await shot(alice.page, "01-launch-list-empty-1440");
await alice.page.goto(`${base}/launch/new?agent=1`, { waitUntil: "networkidle" });
await connect(alice.page);
await alice.page.getByText("No coin launched yet").waitFor({ timeout: 60000 });
await alice.page.getByLabel("Name").fill("Atlas Research");
await alice.page.getByLabel("Symbol").fill("ATLAS");
await alice.page.locator("#launch-buy").fill("50000");
await alice.page.waitForTimeout(800);
await shot(alice.page, "02-launch-form-1440");
await alice.page.getByRole("button", { name: "Launch ATLAS" }).click();
// the form moves to the coin's page as soon as the launch lands, so the URL is the signal (an error stays on the form)
await alice.page.waitForURL(/\/launch\/0x/, { timeout: 120000 }).catch(async () => {
  throw new Error(`launch did not land: ${(await alice.page.locator(".rc-notice").allInnerTexts()).join(" | ")}`);
});
say("ATLAS launched");
const coin = alice.page.url().split("/launch/")[1];
say(`coin ${coin}`);
await indexed((r) => r.coins.length === 1);

// ---------------------------------------------------------------- early window
const bob = await open(12);
await bob.page.goto(`${base}/launch/${coin}`, { waitUntil: "networkidle" });
await connect(bob.page);
await bob.page.getByText(/Stakers buy first/).waitFor({ timeout: 60000 });
await bob.page.getByText(/Your allocation left/).waitFor({ timeout: 60000 });
await bob.page.waitForTimeout(2000);
await bob.page.locator("#early-amt").fill("2000");
await shot(bob.page, "03-coin-early-window-1440");
await bob.page.getByRole("button", { name: "Buy ATLAS early" }).click();
say(await notice(bob.page, /before the public opening/));
const phoneEarly = await open(13, 375);
await phoneEarly.page.goto(`${base}/launch/${coin}`, { waitUntil: "networkidle" });
await phoneEarly.page.waitForTimeout(4000);
await shot(phoneEarly.page, "04-coin-early-window-375");

// ---------------------------------------------------------------- public trading (chain moves 11 minutes)
await pub.request({ method: "evm_increaseTime", params: [toHex(660)] });
await pub.request({ method: "evm_mine", params: [] });
const carol = await open(13);
await carol.page.goto(`${base}/launch/${coin}`, { waitUntil: "networkidle" });
await connect(carol.page);
await carol.page.locator("#trade-amt").waitFor({ timeout: 60000 });
await carol.page.locator("#trade-amt").fill("20000");
await carol.page.waitForTimeout(800);
await carol.page.getByRole("button", { name: "Buy ATLAS" }).last().click();
say(await notice(carol.page, /Bought ATLAS/));
await carol.page.getByRole("tab", { name: "Sell ATLAS" }).click();
await carol.page.locator("#trade-amt").fill("50000");
await carol.page.getByRole("button", { name: "Sell ATLAS" }).last().click();
say(await notice(carol.page, /Sold ATLAS/));
await indexed((r) => r.coins[0]?.trades >= 4);
await carol.page.reload({ waitUntil: "networkidle" });
await connect(carol.page);
await carol.page.waitForTimeout(3000);
await shot(carol.page, "05-coin-trading-1440");
await carol.page.getByRole("button", { name: "Split fees" }).click();
say(await notice(carol.page, /Fees split/));
await carol.page.getByRole("button", { name: "Pay the agent" }).click();
say(await notice(carol.page, /Paid to the agent/));
await indexed((r) => BigInt(r.coins[0]?.feesDistributed ?? "0") > 0n);
await carol.page.reload({ waitUntil: "networkidle" });
await carol.page.waitForTimeout(3000);
await shot(carol.page, "06-coin-fees-paid-1440");
await carol.page.goto(`${base}/launch`, { waitUntil: "networkidle" });
await carol.page.waitForTimeout(3000);
await shot(carol.page, "07-launch-list-1440");
const phone = await open(13, 375);
for (const [r, n] of [["/launch", "08-launch-list-375"], [`/launch/${coin}`, "09-coin-375"], ["/launch/new?agent=1", "10-launch-form-375"]]) {
  await phone.page.goto(`${base}${r}`, { waitUntil: "networkidle" });
  await phone.page.waitForTimeout(3500);
  await shot(phone.page, n);
}

// ---------------------------------------------------------------- held state
recording = false;
execFileSync("docker", ["exec", "orrery-pg-l5", "psql", "-U", "orrery", "-d", "orrery", "-c", "update releases set opens_at = null where feature in ('launch', 'launch-priority')"]);
const held = await open(11);
await held.page.goto(`${base}/launch`, { waitUntil: "networkidle" });
await held.page.waitForTimeout(3500);
await shot(held.page, "11-launch-held-1440");
const heldApi = await fetch(`${api}/v1/launch/coins`);
say(`held API answers ${heldApi.status}`);
execFileSync("docker", ["exec", "orrery-pg-l5", "psql", "-U", "orrery", "-d", "orrery", "-c", "update releases set opens_at = now() - interval '1 minute' where feature in ('launch', 'launch-priority')"]);

for (const c of contexts) await c.close();
await browser.close();
const summary = await fetch(`${api}/v1/launch/coins/${coin}`).then((x) => x.json());
writeFileSync(join(out, "walk-result.json"), JSON.stringify({ coin, summary, findings }, null, 2));
say(`findings: ${findings.length ? findings.join(" | ") : "none"}`);
