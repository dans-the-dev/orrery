// Walk: Signer lookup, the agent record, and agent stake on the development network. Looks up the agent's account on
// /signer, opens /agent/<id> from its form, then stakes ORRY behind the agent from the operator page with the operator
// wallet (the agent's ERC-8004 owner) and reads the record again to see the stake.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");
const [base = "https://orrery-dev.vercel.app", account = "0x339A3fC1726E06aE26A69c4C527A86073C5559a4", agent = "328", amount = "500", shots = "."] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1200 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !/_rsc|402/.test(m.text()) && errors.push(m.text().slice(0, 200)));
await attachWallet(page, { keyFile: join(homedir(), ".secrets/orrery/46630-operator.json"), rpc: process.env.WALK_RPC ?? "https://robinhood-sepolia-rpc.publicnode.com", chainId: Number(process.env.WALK_CHAIN ?? 46630), name: "operator wallet" });
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const flat = (s) => s.replace(/\s+/g, " ").trim();
const recordText = async () => {
  for (let i = 0; i < 40; i++) {
    const t = flat(await page.locator("main").innerText());
    if (!/Reading the chain/.test(t) && /Per payment|did not finish|not found|No session/i.test(t)) return t;
    await page.waitForTimeout(1500);
  }
  return flat(await page.locator("main").innerText());
};

// 1 Signer lookup through the form
await page.goto(base + "/signer", { waitUntil: "load", timeout: 60000 });
await page.getByPlaceholder("0x…", { exact: true }).fill(account);
await page.getByRole("button", { name: "Look up" }).click();
await page.waitForURL(/\/signer\/0x/i, { timeout: 30000 });
const sig = await recordText();
say(`1 signer ${page.url().replace(base, "")}: ${sig.slice(sig.search(/Session|Agent #|Active|Paused/), sig.search(/Session|Agent #|Active|Paused/) + 420)}`);
await page.screenshot({ path: join(shots, "walk-signer.png"), fullPage: true });

// 2 Agent record through its own form
await page.goto(base + `/agent/${agent}`, { waitUntil: "load", timeout: 60000 });
await page.getByPlaceholder("0x… the agent's Safe").fill(account);
await page.getByRole("button", { name: "Open record" }).click();
await page.waitForURL(/account=0x/i, { timeout: 30000 });
const rec = await recordText();
const stakeBefore = rec.match(/Stake[^.]{0,80}ORRY/i)?.[0] ?? "no stake line";
say(`2 agent record: ${rec.slice(0, 380)}`);
say(`   stake line before: ${stakeBefore}`);
await page.screenshot({ path: join(shots, "walk-agent.png"), fullPage: true });

// 3 Agent stake from the operator page
await page.goto(base + "/operator", { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(2500);
await page.getByPlaceholder("0x… your Safe").fill(account);
await page.getByPlaceholder("1", { exact: true }).fill(agent);
const panel = page.locator('section[aria-label="Agent stake"]');
await panel.waitFor({ timeout: 40000 });
await page.waitForTimeout(3000);
say(`3 panel before: ${flat(await panel.innerText()).slice(0, 260)}`);
await panel.locator(`#agent-amount-${agent}`).fill(amount);
const btn = panel.getByRole("button", { name: "Stake behind agent" });
for (let i = 0; i < 20 && (await btn.isDisabled()); i++) await page.waitForTimeout(1000);
await btn.click();
let n = "";
for (let i = 0; i < 80; i++) {
  n = flat((await panel.locator(".rc-notice, .notice, [role=status]").allInnerTexts().catch(() => [])).join(" "));
  if (/Staked|did not|rejected|failed/i.test(n)) break;
  await page.waitForTimeout(1500);
}
say(`   stake: ${n.slice(0, 220)}`);
await page.waitForTimeout(5000);
say(`   panel after: ${flat(await panel.innerText()).slice(0, 260)}`);

// 4 The record again
await page.goto(base + `/agent/${agent}?account=${account}`, { waitUntil: "load", timeout: 60000 });
const rec2 = await recordText();
say(`4 stake line after: ${rec2.match(/Stake[^.]{0,80}ORRY/i)?.[0] ?? "no stake line"}`);
say(`console errors: ${[...new Set(errors)].join(" | ") || "none"}`);
await browser.close();
