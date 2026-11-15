// Walk (lane L1): the Community pages on the local stack of scripts/community-local.ts (anvil, API, community indexer,
// `next start`). Connects the walk wallet, posts one message, reads every page at desktop and phone width, reports
// console errors, failed requests and horizontal overflow, and saves screenshots.
// Run: WALK_KEY=<json with privateKey> node scripts/walk/community-pages.mjs http://127.0.0.1:3201 <out dir>
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");

const [base = "http://127.0.0.1:3201", out = "walk-community"] = process.argv.slice(2);
const rpc = process.env.WALK_RPC ?? "http://127.0.0.1:18600";
const referrer = process.env.WALK_REFERRER ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
mkdirSync(out, { recursive: true });
const routes = ["/community", "/community/rewards", "/community/templates", `/community/referrals?ref=${referrer}`, "/community/passes"];
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });

async function walk(width, height, tag, act) {
  const ctx = await browser.newContext({ viewport: { width, height }, ...(width < 768 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await ctx.newPage();
  const w = await attachWallet(page, { keyFile: process.env.WALK_KEY, rpc, chainId: Number(process.env.WALK_CHAIN ?? 31337) });
  for (const r of routes) {
    const errors = [];
    const onConsole = (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); };
    const onFail = (req) => errors.push(`request failed ${req.url().slice(0, 100)} ${req.failure()?.errorText}`);
    const onResp = (res) => { if (res.status() >= 400) errors.push(`${res.status()} ${res.url().slice(0, 110)}`); };
    page.on("console", onConsole); page.on("requestfailed", onFail); page.on("response", onResp);
    await page.goto(base + r, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => errors.push(`goto ${e.message.slice(0, 80)}`));
    await page.getByRole("button", { name: /connect/i }).first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(2500);
    if (act && r === "/community") await act(page, errors);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) errors.push(`horizontal overflow ${overflow}px`);
    const text = (await page.evaluate(() => document.querySelector("main")?.innerText ?? document.body.innerText)).replace(/\s+/g, " ").slice(0, 300);
    const name = r.split("?")[0].slice(1).replace(/[/]/g, "_");
    await page.screenshot({ path: join(out, `${tag}-${name}.png`), fullPage: width >= 768 });
    console.log(`\n== ${tag} ${r}\n${text}\n${errors.length ? "ERRORS: " + [...new Set(errors)].join(" | ") : "no errors"}`);
    page.off("console", onConsole); page.off("requestfailed", onFail); page.off("response", onResp);
  }
  console.log(`wallet calls (${tag}): ${[...new Set(w?.log ?? [])].join(", ")}`);
  await ctx.close();
}

// desktop: also post one message through the wallet and wait for it to appear
await walk(1440, 900, "desktop", async (page, errors) => {
  const box = page.locator("textarea").first();
  if (!(await box.count())) return errors.push("no post box");
  const text = `Walk check ${new Date().toISOString().slice(0, 16)}: posting from the local stack.`;
  await box.fill(text);
  await page.getByRole("button", { name: /^post/i }).first().click().catch((e) => errors.push(`post click ${e.message.slice(0, 60)}`));
  // the post is indexed (API), then a reload shows it in the room (the box is empty after a reload, so the match is the message)
  const api = process.env.WALK_API ?? "http://127.0.0.1:18605";
  let indexed = false;
  for (let i = 0; i < 45 && !indexed; i++) {
    const r = await fetch(`${api}/v1/community/messages?room=0&limit=5`).then((x) => x.json()).catch(() => ({ messages: [] }));
    indexed = r.messages.some((m) => m.text === text);
    if (!indexed) await page.waitForTimeout(1000);
  }
  await page.reload({ waitUntil: "networkidle" });
  const seen = indexed && (await page.getByText(text).first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false));
  console.log(`posted, indexed: ${indexed}, shown in the room after reload: ${seen}`);
  if (!seen) errors.push("posted message not shown");
});
await walk(375, 812, "phone");
await browser.close();
