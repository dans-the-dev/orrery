// Walk: Stake and Earn on the development network with the walk wallet. Stakes 1,000 ORRY, then deposits 10 USDG
// (with its ORRY side) into the ORRY/USDG Earn pool; reports each page's notice and the position read back.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachWallet } from "./wallet.mjs";
const require = createRequire(process.env.WALK_PLAYWRIGHT ?? "/home/dand/Projects/promo-films/_pw/package.json");
const { chromium } = require("playwright-core");
const [base = "https://orrery-dev.vercel.app", shots = "."] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !/_rsc|402/.test(m.text()) && errors.push(m.text().slice(0, 200)));
await attachWallet(page, { keyFile: join(homedir(), ".secrets/orrery/46630-walk.json"), rpc: process.env.WALK_RPC ?? "https://robinhood-sepolia-rpc.publicnode.com", chainId: Number(process.env.WALK_CHAIN ?? 46630) });
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const waitNotice = async (scope, re) => {
  for (let i = 0; i < 80; i++) {
    const t = (await scope.locator(".rc-notice, .notice, [role=status]").allInnerTexts().catch(() => [])).join(" ").replace(/\s+/g, " ");
    if (re.test(t)) return t.slice(0, 220);
    await page.waitForTimeout(1500);
  }
  return (await scope.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
};

// Stake
await page.goto(base + "/stake", { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
await page.locator("#stake-in").fill("1000");
await page.locator('section[aria-label="Stake actions"] button.rc-go').click();
say(`stake: ${await waitNotice(page.locator('section[aria-label="Stake actions"]'), /Staked|did not|rejected|failed/i)}`);
await page.waitForTimeout(4000);
say(`your stake: ${(await page.locator('section[aria-label="Your stake"]').innerText()).replace(/\s+/g, " ").slice(0, 200)}`);

// Earn: the ORRY/USDG pool
await page.goto(base + "/earn", { waitUntil: "networkidle" });
await page.waitForTimeout(4000);
const hub = page.locator("section.rc-hub").filter({ hasText: "USDG" }).first();
const qInput = hub.locator('input[id^="earn-q-"]');
await qInput.fill("10");
await page.waitForTimeout(2500);
await hub.locator("button.rc-go").first().click();
say(`earn deposit: ${await waitNotice(hub, /Deposited|did not|rejected|failed|added/i)}`);
await page.waitForTimeout(5000);
say(`earn share: ${(await hub.locator("section.rc-side").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 220)}`);
await page.screenshot({ path: join(shots, "walk-earn.png"), fullPage: true });
say(`console errors: ${[...new Set(errors)].join(" | ") || "none"}`);
await browser.close();
