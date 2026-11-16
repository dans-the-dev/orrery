// Walk: the stake exits that wait for a cooldown. The browser clock follows the chain's latest block time, so a fork
// whose time was moved forward reads the same as the live network on that date.
//   node stake-exit.mjs plain <web base> <rpc> <key file>                      withdraw a plain unstake on /stake
//   node stake-exit.mjs agent-request <web base> <rpc> <key file> <account> <agentId> <amount>   request on /operator
//   node stake-exit.mjs agent-withdraw <web base> <rpc> <key file> <account> <agentId>           withdraw on /operator
import { createRequire } from "node:module";
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { attachWallet } from "./wallet.mjs";
const require = createRequire(process.env.WALK_PLAYWRIGHT ?? "/home/dand/Projects/promo-films/_pw/package.json");
const { chromium } = require("playwright-core");
const [mode, base, rpc, keyFile, account, agentId, amount] = process.argv.slice(2);
const STAKING = process.env.WALK_STAKING ?? "0x187d4bb95587fded89ec13e7cd53d80155fb0a5f";
const ORRY = process.env.WALK_ORRY ?? "0x3bf68ed6c9e98910575a31650e9bdc3cf56a50c3";
const pub = createPublicClient({ transport: http(rpc) });
const abi = parseAbi([
  "function plainStake(address) view returns (uint256 active, uint256 leaving, uint64 readyAt)",
  "function agentStake(uint256) view returns ((address staker, uint128 active, uint128 leaving, uint64 leavingAt, uint64 lockedUntil))",
  "function balanceOf(address) view returns (uint256)",
]);
const chainMs = Number((await pub.getBlock()).timestamp) * 1000;
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await context.clock.install({ time: chainMs });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !/_rsc|402/.test(m.text()) && errors.push(m.text().slice(0, 200)));
const w = await attachWallet(page, { keyFile, rpc, chainId: Number(process.env.WALK_CHAIN ?? 46630) });
const say = (s) => console.log(s);
const bal = () => pub.readContract({ address: ORRY, abi, functionName: "balanceOf", args: [w.address] });
const fmt = (v) => formatUnits(v, 18);
say(`chain time ${new Date(chainMs).toISOString()}, wallet ${w.address}`);
const rcNotice = async (scope) => (await scope.locator(".rc-notice").last().innerText().catch(() => "")).trim();
const settled = /Withdrawn|requested|rejected|failed|did not|reverted/i;

if (mode === "plain") {
  const [, leaving, readyAt] = await pub.readContract({ address: STAKING, abi, functionName: "plainStake", args: [w.address] });
  say(`1 leaving ${fmt(leaving)} ORRY, ready at ${new Date(Number(readyAt) * 1000).toISOString()}`);
  const b0 = await bal();
  await page.goto(base + "/stake", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page.getByRole("tab", { name: "Withdraw" }).or(page.getByRole("button", { name: "Withdraw", exact: true }).first()).first().click();
  await page.waitForTimeout(1500);
  const desk = page.locator(".rc-desk-body").first();
  say(`2 page: ${(await desk.innerText()).replace(/\n/g, " · ")}`);
  await desk.getByRole("button", { name: "Withdraw" }).click();
  for (let i = 0; i < 60 && !settled.test(await rcNotice(page)); i++) await page.waitForTimeout(1000);
  say(`3 notice: ${await rcNotice(page)}`);
  const [, leftAfter] = await pub.readContract({ address: STAKING, abi, functionName: "plainStake", args: [w.address] });
  say(`4 ORRY to wallet ${fmt((await bal()) - b0)}, leaving now ${fmt(leftAfter)}`);
} else {
  const id = BigInt(agentId);
  const pos0 = await pub.readContract({ address: STAKING, abi, functionName: "agentStake", args: [id] });
  say(`1 agent #${agentId}: active ${fmt(pos0.active)}, leaving ${fmt(pos0.leaving)}, leavingAt ${pos0.leavingAt ? new Date(Number(pos0.leavingAt) * 1000).toISOString() : "-"}`);
  const b0 = await bal();
  await page.goto(base + "/operator", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.getByPlaceholder("0x… Safe address").fill(account);
  await page.getByPlaceholder("1", { exact: true }).fill(agentId);
  const panel = page.locator('section[aria-label="Agent stake"]');
  await panel.waitFor({ timeout: 40000 });
  await page.waitForTimeout(3000);
  say(`2 panel: ${(await panel.innerText()).replace(/\n/g, " · ").slice(0, 300)}`);
  if (mode === "agent-request") {
    await panel.getByLabel(`ORRY to unstake from agent ${agentId}`).fill(amount);
    await panel.getByRole("button", { name: "Request unstake" }).click();
  } else {
    await panel.getByRole("button", { name: /^Withdraw/ }).click();
  }
  for (let i = 0; i < 60 && !settled.test(await rcNotice(panel)); i++) await page.waitForTimeout(1000);
  say(`3 notice: ${await rcNotice(panel)}`);
  const pos1 = await pub.readContract({ address: STAKING, abi, functionName: "agentStake", args: [id] });
  say(`4 agent #${agentId}: active ${fmt(pos1.active)}, leaving ${fmt(pos1.leaving)}, leavingAt ${pos1.leavingAt ? new Date(Number(pos1.leavingAt) * 1000).toISOString() : "-"}; ORRY to wallet ${fmt((await bal()) - b0)}`);
}
say(`wallet calls: ${[...new Set(w.log)].join(", ")}`);
say(errors.length ? `console errors: ${[...new Set(errors)].join(" | ")}` : "no console errors");
await browser.close();
