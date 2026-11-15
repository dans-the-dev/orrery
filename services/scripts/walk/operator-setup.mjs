// Walk: a first-time operator in the dashboard (Agents), on a local anvil fork of 4663 only. A fresh wallet creates its
// account, registers an agent, binds the identity, creates the signer on the page, opens the session from the Standard
// preset, funds the agent and pays the verification. The saved key file is then used by the SDK (`agentFromEnv`) to top
// up the float through the module, which proves the file, the session and the limits together.
//
//   node scripts/walk/operator-setup.mjs http://localhost:3161 http://127.0.0.1:8561 <dir for shots and the key file>
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeAbiParameters, erc20Abi, http, keccak256, numberToHex, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");

const [base = "http://localhost:3161", rpc = "http://127.0.0.1:8561", out = "."] = process.argv.slice(2);
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(rpc)) throw new Error("local fork only");
mkdirSync(out, { recursive: true });
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const pub = createPublicClient({ transport: http(rpc, { timeout: 120_000 }) });
const raw = (method, params) => pub.request({ method, params });
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

// A throwaway owner that exists only on the fork: 1 ETH and 100 USDG (balances mapping at slot 1 on the fork).
const privateKey = generatePrivateKey();
const owner = privateKeyToAccount(privateKey).address;
const keyFile = join(out, "fork-owner.json");
writeFileSync(keyFile, JSON.stringify({ privateKey }), { mode: 0o600 });
await raw("anvil_setBalance", [owner, numberToHex(parseEther("1"))]);
await raw("anvil_setStorageAt", [USDG, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, 1n])), numberToHex(100_000_000n, { size: 32 })]);
const usdgOf = (a) => pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [a] });
say(`owner ${owner}: ${(await usdgOf(owner)) / 1_000_000n} USDG on the fork`);

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !/_rsc|402|favicon/.test(m.text()) && errors.push(m.text().slice(0, 200)));
await attachWallet(page, { keyFile, rpc, chainId: 4663, name: "fork operator" });

const notice = async () => (await page.locator(".notice").last().innerText().catch(() => "")).trim();
async function act(name, timeoutMs = 240_000) {
  const btn = page.getByRole("button", { name }).first();
  await btn.waitFor({ timeout: 60_000 });
  for (let i = 0; i < 60 && (await btn.isDisabled()); i++) await page.waitForTimeout(1000);
  const before = await notice();
  await btn.click();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const n = await notice();
    if (n !== before && /: done\.|was not completed|closed/.test(n)) return n;
    await page.waitForTimeout(1000);
  }
  return `TIMEOUT, last notice: ${await notice()}`;
}
const steps = async () => (await page.locator(".setup-steps li").evaluateAll((els) => els.map((e) => `${e.dataset.done === "true" ? "done" : "open"} ${e.querySelector("strong")?.textContent}`))).join(" | ");
const must = (label, text) => {
  say(`${label}: ${text}`);
  if (!/: done\./.test(text)) throw new Error(`${label} failed`);
};

await page.goto(base + "/operator", { waitUntil: "load", timeout: 120_000 });
say(`0 the old /operator address lands on ${new URL(page.url()).pathname}`);
if (new URL(page.url()).pathname !== "/dashboard/agents") throw new Error("redirect missing");
await page.getByRole("button", { name: "Connect wallet", disabled: false }).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: join(out, "op-1-start.png"), fullPage: true });

must("1 create account (2 confirmations)", await act(/^Create a Safe$/));
const account = await page.getByPlaceholder("0x… Safe address").inputValue();
must("2 register agent", await act(/^Register an identity$/));
const agentId = await page.getByPlaceholder("1", { exact: true }).inputValue();
say(`   account ${account}, agent #${agentId}`);
await page.locator(".editor").waitFor({ timeout: 60_000 });
await page.waitForTimeout(3000);
say(`   steps: ${await steps()}`);
must("3 bind identity", await act(/^Bind identity$/));
await page.waitForTimeout(3000);

await page.getByRole("button", { name: "Generate a signer" }).click();
const dl = page.waitForEvent("download");
await page.getByRole("button", { name: "Save the key file" }).click();
const file = join(out, "agent.env");
await (await dl).saveAs(file);
const env = Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("=")));
say(`4 key file saved: ${Object.keys(env).join(", ")}`);
const openBtn = page.getByRole("button", { name: /^Open session$/ });
say(`   open session before the box is ticked: ${(await openBtn.isDisabled()) ? "disabled" : "ENABLED"}`);
await page.getByLabel(/I saved the key file/).check();
say(`   limits: per payment ${await page.locator("label", { hasText: "Per payment" }).locator("input").inputValue()}, per day ${await page.locator("label", { hasText: "Per day" }).locator("input").inputValue()}, float ${await page.locator("label", { hasText: "Float ceiling" }).locator("input").inputValue()}, expiry ${await page.locator("label", { hasText: "Policy expiry" }).locator("input").inputValue()}`);
await page.screenshot({ path: join(out, "op-2-before-session.png"), fullPage: true });
must("5 open session", await act(/^Open session$/));
await page.waitForTimeout(4000);
say(`   steps: ${await steps()} · ${(await page.locator(".editor-head").innerText()).replace(/\s+/g, " ")}`);

must("6 add USDG to the account", await act(/^Add USDG$/));
// anvil adds a 1 gwei tip on a fork, about 50 times the gas price of 4663, so the walk sends more than the page's default
await page.locator(".fund-row").nth(1).locator("input").fill("0.01");
must("7 send ETH to the signer", await act(/^Send ETH$/));
must("8 pay verification", await act(/^Pay verification$/));
await page.waitForTimeout(4000);
say(`   steps: ${await steps()}`);
await page.screenshot({ path: join(out, "op-3-done.png"), fullPage: true });

// The agent, from the saved file alone (tsx, since the SDK ships as TypeScript): tops its float up through the module.
const r = JSON.parse(execFileSync(new URL("../../node_modules/.bin/tsx", import.meta.url).pathname, ["scripts/walk/agent-from-keyfile.ts", file, USDG], { encoding: "utf8", cwd: new URL("../..", import.meta.url).pathname }).trim().split("\n").pop());
const hash = r.topUp;
say(`9 agent from the key file: session account ${r.account}, agent #${r.agentId}, top-up ${hash}, float ${Number(r.float) / 1e6} USDG, account ${Number(await usdgOf(account)) / 1e6} USDG`);
say(`   above the float ceiling: ${r.aboveCeiling}`);
if (r.account.toLowerCase() !== account.toLowerCase() || r.float !== "1000000" || r.aboveCeiling === "went through") throw new Error("agent top-up check failed");

// A reload opens the same agent again without typing, and the public record shows the session.
await page.reload({ waitUntil: "load" });
await page.getByRole("button", { name: "Connect wallet", disabled: false }).first().click().catch(() => {});
await page.locator(".editor").waitFor({ timeout: 60_000 });
say(`10 after reload: account ${await page.getByPlaceholder("0x… Safe address").inputValue()}, agent ${await page.getByPlaceholder("1", { exact: true }).inputValue()}`);
await page.goto(base + "/signer", { waitUntil: "load" });
await page.getByLabel(/Paying address or transaction hash/).fill(hash);
await page.getByRole("button", { name: "Look up" }).click();
await page.waitForURL(/\/signer\/0x/, { timeout: 60_000 });
await page.waitForTimeout(5000);
say(`11 signer lookup by the top-up transaction hash: ${page.url().split("/").pop()} · ${(await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 160)}`);
await page.screenshot({ path: join(out, "op-4-signer.png"), fullPage: true });
say(`console errors: ${[...new Set(errors)].join(" | ") || "none"}`);
await browser.close();
