// Walk: the operator page on the development network with the operator wallet (owner of the development account).
// Lowers a cap, pauses and resumes the agent, proposes an increase and cancels it.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");
const [base = "https://orrery-dev.vercel.app", account = "0x339A3fC1726E06aE26A69c4C527A86073C5559a4", agent = "328", shots = "."] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1200 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !/_rsc|402/.test(m.text()) && errors.push(m.text().slice(0, 200)));
await attachWallet(page, { keyFile: join(homedir(), ".secrets/orrery/46630-operator.json"), rpc: process.env.WALK_RPC ?? "https://robinhood-sepolia-rpc.publicnode.com", chainId: Number(process.env.WALK_CHAIN ?? 46630), name: "operator wallet" });
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const notice = async () => (await page.locator(".notice").last().innerText().catch(() => "")).trim();
async function act(name) {
  const btn = page.getByRole("button", { name });
  await btn.waitFor({ timeout: 30000 });
  for (let i = 0; i < 20 && (await btn.isDisabled()); i++) await page.waitForTimeout(1000);
  await btn.click();
  for (let i = 0; i < 60; i++) {
    const n = await notice();
    if (/: done\.|was not completed|closed/.test(n)) return n;
    await page.waitForTimeout(1500);
  }
  return await notice();
}
const field = (label) => page.locator("label", { hasText: label }).locator("input").first();
await page.goto(base + "/operator", { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(2500);
await page.getByPlaceholder("0x… Safe address").fill(account);
await page.getByPlaceholder("1", { exact: true }).fill(agent);
await page.locator(".editor").waitFor({ timeout: 30000 });
await page.waitForTimeout(3000);
say(`opened: ${(await page.locator(".editor-head").innerText()).replace(/\s+/g, " ")} · ${(await page.locator(".editor .row").first().innerText()).replace(/\s+/g, " ")}`);
say(`caps now: per payment ${await field("Per payment").inputValue()}, per day ${await field("Per day").inputValue()}, float ${await field("Float ceiling").inputValue()}`);
if (!process.env.ONLY_CANCEL) {
await field("Per payment").fill("8");
say(`1 lower: ${await act(/^Lower the caps now$/)}`);
await page.waitForTimeout(4000);
say(`2 pause: ${await act(/^Pause agent$/)}`);
await page.waitForTimeout(4000);
say(`   status: ${(await page.locator(".editor-head").innerText()).replace(/\s+/g, " ")}`);
say(`3 resume: ${await act(/^Resume agent$/)}`);
await page.waitForTimeout(4000);
await field("Per payment").fill("10");
say(`4 propose increase: ${await act(/^Propose higher caps/)}`);
await page.waitForTimeout(4000);
}
say(`   pending: ${(await page.locator(".editor").innerText()).match(/Increase pending[^\n]*\n?[^\n]*/)?.[0]?.replace(/\s+/g, " ") ?? "none shown"}`);
say(`5 cancel increase: ${await act(/^Cancel$/)}`);
await page.waitForTimeout(3000);
await page.screenshot({ path: join(shots, "walk-operator.png"), fullPage: true });
say(`console errors: ${[...new Set(errors)].join(" | ") || "none"}`);
await browser.close();
