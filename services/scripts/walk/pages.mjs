// Opens every page of the development network web app with the walk wallet attached; reports console errors and
// failed requests per page and saves a screenshot of each.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");
const [base = "https://orrery-dev.vercel.app", out = "walk-shots"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const routes = ["/", "/dashboard", "/merchants", "/signer", "/signer/0x4C4bd566516eAe906ad5029317758C58E4A2a606", "/operator", "/credits", "/earn", "/stake", "/claim", "/leaderboard", "/burn", "/stocks", "/swap", "/dark-pool", "/docs", "/terms", "/privacy"];
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
// WALK_VIEWPORT=375x812 walks the phone layout (touch, mobile user agent).
const [vw, vh] = (process.env.WALK_VIEWPORT ?? "1440x900").split("x").map(Number);
const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, ...(vw < 768 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
const page = await ctx.newPage();
const w = await attachWallet(page, { keyFile: process.env.WALK_KEY ?? join(homedir(), ".secrets/orrery/46630-walk.json"), rpc: process.env.WALK_RPC ?? "https://robinhood-sepolia-rpc.publicnode.com", chainId: Number(process.env.WALK_CHAIN ?? 46630) });
for (const r of routes) {
  const errors = [];
  const onConsole = (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); };
  const onFail = (req) => errors.push(`request failed ${req.url().slice(0, 100)} ${req.failure()?.errorText}`);
  const onResp = (res) => { if (res.status() >= 400 && !res.url().includes("_vercel")) errors.push(`${res.status()} ${res.url().slice(0, 110)}`); };
  page.on("console", onConsole); page.on("requestfailed", onFail); page.on("response", onResp);
  await page.goto(base + r, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => errors.push(`goto ${e.message.slice(0, 80)}`));
  await page.waitForTimeout(2500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errors.push(`horizontal overflow ${overflow}px`);
  const text = (await page.evaluate(() => document.querySelector("main")?.innerText ?? document.body.innerText)).replace(/\s+/g, " ").slice(0, 260);
  await page.screenshot({ path: join(out, (r === "/" ? "home" : r.slice(1).replace(/[/]/g, "_").slice(0, 40)) + ".png"), fullPage: false });
  console.log(`\n== ${r}\n${text}\n${errors.length ? "ERRORS: " + [...new Set(errors)].join(" | ") : "no errors"}`);
  page.off("console", onConsole); page.off("requestfailed", onFail); page.off("response", onResp);
}
await browser.close();
