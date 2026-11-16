// Walk: the Platform plan on /credits with the walk wallet on the development network. Starts the plan (one USDG
// authorization), then reads the balance: plan end date, credits, and the cost of the next check.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachWallet } from "./wallet.mjs";
const require = createRequire(process.env.WALK_PLAYWRIGHT ?? "/home/dand/Projects/promo-films/_pw/package.json");
const { chromium } = require("playwright-core");
const [base = "https://orrery-dev.vercel.app", shots = "."] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1200 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !/_rsc|402/.test(m.text()) && errors.push(m.text().slice(0, 200)));
await attachWallet(page, { keyFile: join(homedir(), ".secrets/orrery/46630-walk.json"), rpc: process.env.WALK_RPC ?? "https://robinhood-sepolia-rpc.publicnode.com", chainId: Number(process.env.WALK_CHAIN ?? 46630) });
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const notice = async () => (await page.locator(".notice").last().innerText().catch(() => "")).trim();
const balance = async () => {
  await page.getByRole("button", { name: "Show balance" }).click();
  await page.waitForTimeout(3000);
  return (await page.locator(".kv").last().innerText()).replace(/\n/g, " · ");
};
await page.goto(base + "/credits", { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Issue my API key" }).click();
await page.locator(".key-box").waitFor({ timeout: 30000 });
say(`1 before: ${await balance()}`);
await page.getByRole("button", { name: "Start the plan" }).click();
for (let i = 0; i < 40 && !/added|active|not accepted|did not finish|declined/i.test(await notice()); i++) await page.waitForTimeout(1500);
say(`2 plan: ${await notice()}`);
say(`3 after: ${await balance()}`);
await page.screenshot({ path: join(shots, "walk-plan.png"), fullPage: true });
say(`console errors: ${[...new Set(errors)].join(" | ") || "none"}`);
await browser.close();
