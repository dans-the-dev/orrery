// Walk: the way out, with the walk wallet on the development network. Claim all on /claim, a request to unstake on
// /stake (the withdrawal itself waits for the cooldown), and half of the ORRY/USDG Earn position withdrawn on /earn.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");
const [base = "https://orrery-dev.vercel.app", shots = ".", unstake = "100"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !/_rsc|402/.test(m.text()) && errors.push(m.text().slice(0, 200)));
await attachWallet(page, { keyFile: join(homedir(), ".secrets/orrery/46630-walk.json"), rpc: process.env.WALK_RPC ?? "https://robinhood-sepolia-rpc.publicnode.com", chainId: Number(process.env.WALK_CHAIN ?? 46630) });
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const flat = (s) => s.replace(/\s+/g, " ").trim();
const waitNotice = async (scope, re) => {
  for (let i = 0; i < 80; i++) {
    const t = flat((await scope.locator(".rc-notice, .notice, [role=status]").allInnerTexts().catch(() => [])).join(" "));
    if (re.test(t)) return t.slice(0, 240);
    await page.waitForTimeout(1500);
  }
  return flat(await scope.innerText().catch(() => "")).slice(0, 240);
};
const click = async (btn) => {
  for (let i = 0; i < 25 && (await btn.isDisabled()); i++) await page.waitForTimeout(1000);
  if (await btn.isDisabled()) return false;
  await btn.click();
  return true;
};

// 1 Claim all
await page.goto(base + "/claim", { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(5000);
const ready = page.locator('[aria-label="Ready to claim, per asset"]');
say(`1 ready to claim: ${flat(await ready.innerText().catch(() => "none listed")).slice(0, 220)}`);
const claim = page.getByRole("button", { name: "Claim all" }).first();
if (await click(claim)) say(`  claim all: ${await waitNotice(page.locator("main"), /in your wallet|did not|rejected|failed/i)}`);
else say("  claim all: button stays disabled (nothing ready)");
await page.waitForTimeout(4000);
say(`  after: ${flat(await ready.innerText().catch(() => "none listed")).slice(0, 220)}`);
await page.screenshot({ path: join(shots, "walk-claim.png"), fullPage: true });

// 2 Request unstake
await page.goto(base + "/stake", { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(4000);
const desk = page.locator('section[aria-label="Stake actions"]');
await desk.getByRole("tab", { name: "Request unstake" }).click();
await page.locator("#unstake-in").fill(unstake);
if (await click(desk.getByRole("button", { name: "Request unstake", exact: true }))) say(`2 request unstake ${unstake}: ${await waitNotice(desk, /Requested|did not|rejected|failed/i)}`);
else say("2 request unstake: button stays disabled");
await page.waitForTimeout(4000);
await desk.getByRole("tab", { name: "Withdraw" }).click();
say(`  withdraw tab: ${flat(await desk.innerText()).slice(0, 220)}`);
say(`  your stake: ${flat(await page.locator('section[aria-label="Your stake"]').innerText()).slice(0, 220)}`);

// 3 Earn withdraw, half of the ORRY/USDG position
await page.goto(base + "/earn", { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(5000);
const hub = page.locator("section.rc-hub").filter({ hasText: "USDG" }).first();
say(`3 position before: ${flat(await hub.locator("section.rc-side").innerText().catch(() => "")).slice(0, 220)}`);
await hub.getByRole("tab", { name: "Withdraw" }).click();
await hub.locator('input[id^="earn-wd-"]').fill("50");
await page.waitForTimeout(3000);
const wd = hub.locator("button.rc-go").first();
say(`  withdraw button: ${flat(await wd.innerText())}`);
if (await click(wd)) say(`  withdraw 50%: ${await waitNotice(hub, /Withdrew|Withdrawn|did not|rejected|failed/i)}`);
else say("  withdraw: button stays disabled");
await page.waitForTimeout(5000);
say(`  position after: ${flat(await hub.locator("section.rc-side").innerText().catch(() => "")).slice(0, 220)}`);
await page.screenshot({ path: join(shots, "walk-exits.png"), fullPage: true });
say(`console errors: ${[...new Set(errors)].join(" | ") || "none"}`);
await browser.close();
