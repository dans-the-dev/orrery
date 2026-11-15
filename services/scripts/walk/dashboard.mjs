// Walk: the wallet dashboard (its own app at /dashboard). Connects the walk wallet and reads every section.
//   node dashboard.mjs <web base> <rpc> <chainId> <key file> [shots dir]
import { createRequire } from "node:module";
import { join } from "node:path";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");
const [base, rpc, chainIdIn, keyFile, shots = "."] = process.argv.slice(2);
if (!base || !rpc || !chainIdIn || !keyFile) throw new Error("usage: node dashboard.mjs <web base> <rpc> <chainId> <key file> [shots dir]");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !m.text().includes("_rsc") && errors.push(m.text().slice(0, 200)));
await attachWallet(page, { keyFile, rpc, chainId: Number(chainIdIn) });
await page.goto(base + "/dashboard", { waitUntil: "networkidle" });
await page.locator(".dsh-connect button, .dsh-actions button").first().click().catch(() => {});
await page.locator(".cp-stats").waitFor({ timeout: 30000 });
console.log(`site nav on the dashboard: ${await page.locator("nav.nav").count()}`);
console.log(`sidebar: ${(await page.locator(".dsh-nav").innerText()).replace(/\n+/g, " · ")}`);
for (const s of ["", "/agents", "/merchant", "/positions", "/orders"]) {
  if (s) await page.locator(`.dsh-nav a[href="/dashboard${s}"]`).click();
  await page.waitForURL(`**/dashboard${s}`);
  await page.waitForTimeout(4500);
  const text = (await page.locator(".dsh-body").innerText()).replace(/\s+/g, " ").slice(0, 300);
  console.log(`\n== /dashboard${s}\n${text}`);
  await page.screenshot({ path: join(shots, `dashboard${s.replace("/", "-") || "-overview"}.png`) });
}
console.log(errors.length ? `\nconsole errors: ${[...new Set(errors)].join(" | ")}` : "\nno console errors");
await browser.close();
