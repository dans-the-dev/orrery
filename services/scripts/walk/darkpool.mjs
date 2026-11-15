// Walk: one Dark Pool batch on the development network. The walk wallet seals a buy of TSLA and the operator seals a
// sell in the same batch, both revealed by Orrery's relay; then the batch should clear at the Chainlink price.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");
const [base = "https://orrery-dev.vercel.app", api = "https://orrery-dev-api.187-53-130-188.sslip.io", shots = "."] = process.argv.slice(2);
const RPC = process.env.WALK_RPC ?? "https://robinhood-sepolia-rpc.publicnode.com";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

async function trader(role, side, amount, limit) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && !/_rsc|402/.test(m.text()) && errors.push(m.text().slice(0, 200)));
  const w = await attachWallet(page, { keyFile: join(homedir(), `.secrets/orrery/46630-${role}.json`), rpc: RPC, chainId: Number(process.env.WALK_CHAIN ?? 46630), name: `${role} wallet` });
  await page.goto(base + "/dark-pool", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  return { page, w, errors, role, side, amount, limit };
}
async function seal(t) {
  const { page } = t;
  await page.getByRole("tab", { name: new RegExp(`^${t.side === "buy" ? "Buy" : "Sell"}`) }).click();
  const pick = page.locator("#mk-stock-0");
  if (await pick.count()) await pick.selectOption("AAPL");
  // the amount resets when the market data arrives, so wait for the price, then fill until it holds
  await page.getByText(/price now/i).first().waitFor({ timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 10; i++) {
    await page.locator("#mk-amount-0").fill(t.amount);
    await page.waitForTimeout(1500);
    if ((await page.locator("#mk-amount-0").inputValue()) === t.amount) break;
  }
  await page.locator("#mk-limit").fill(t.limit);
  const relay = page.locator('input[name="mk-reveal-0"]').nth(1);
  if (await relay.count()) await relay.check();
  const btn = page.getByRole("button", { name: new RegExp(`^Seal ${t.side} order$`) });
  await btn.waitFor({ timeout: 20000 });
  for (let i = 0; i < 60 && (await btn.isDisabled()); i++) await page.waitForTimeout(1000);
  if (await btn.isDisabled()) throw new Error(`${t.role}: seal button stays disabled: ${await page.locator(".mk-problem").innerText().catch(() => "")}`);
  await btn.click();
  for (let i = 0; i < 90; i++) {
    const strip = await page.locator('[aria-label="Orders in flight"]').innerText().catch(() => "");
    if (/Sealed\./.test(strip)) return strip.replace(/\s+/g, " ").slice(0, 200);
    await page.waitForTimeout(1500);
  }
  return (await page.locator('[aria-label="Orders in flight"]').innerText().catch(() => "no strip")).replace(/\s+/g, " ").slice(0, 200);
}

const buyer = await trader("walk", "buy", "400", "360");
const seller = await trader("operator", "sell", "1", "340");
// wait for a batch with more than 100 s of sealing left, so both seal in the same batch
for (let i = 0; i < 400; i++) {
  const clock = await buyer.page.locator('[aria-label^="Batch "]').getAttribute("aria-label").catch(() => "");
  const m = clock?.match(/sealing, (?:(\d+) min )?(\d+) s left/);
  const left = m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : -1;
  const no = clock?.match(/Batch (\d+)/)?.[1];
  // a wallet seals once per batch: skip a batch either wallet already sealed in
  const used = no ? await Promise.all([buyer, seller].map((t) => fetch(`${api}/v1/markets/accounts/${t.w.address}/orders`).then((x) => x.json()).then((r) => (r.orders ?? []).some((o) => String(o.batch) === no)).catch(() => true))) : [true];
  if (left > 100 && !used.some(Boolean)) { say(`clock: ${clock}`); break; }
  await buyer.page.waitForTimeout(2000);
}
const [b, s] = await Promise.all([seal(buyer), seal(seller)]);
say(`buyer: ${b}`);
say(`seller: ${s}`);
const batchNo = b.match(/Batch (\d+)/)?.[1];
// the relay reveals in the reveal window and the keeper clears after it: follow the buyer's order in the API
let last = "";
for (let i = 0; i < 80; i++) {
  const r = await fetch(`${api}/v1/markets/accounts/${buyer.w.address}/orders`).then((x) => x.json()).catch(() => null);
  const o = r?.orders?.find((x) => String(x.batch) === batchNo);
  last = JSON.stringify(o ? { status: o.status, batch: o.batch, filled: o.assetFilled ?? o.filled, price: o.price } : r).slice(0, 300);
  if (o && /^(filled|unfilled|missed|expired|dropped)/.test(o.status)) break;
  await new Promise((res) => setTimeout(res, 8000));
}
say(`buyer order: ${last}`);
await buyer.page.reload({ waitUntil: "networkidle" });
await buyer.page.waitForTimeout(4000);
await buyer.page.screenshot({ path: join(shots, "walk-darkpool.png"), fullPage: true });
say(`console errors: ${[...new Set([...buyer.errors, ...seller.errors])].join(" | ") || "none"}`);
await browser.close();
