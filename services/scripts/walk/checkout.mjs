// Walk: ORRY checkout on the credits page. Buys one credit pack with ORRY and pays an agent's verification in ORRY,
// then reads the credits through the wallet's API key and the agent's verified flag on chain.
//   node checkout.mjs <web base> <rpc> <chainId> <key file> <api base> <agentId> <attestor> [shots dir]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");
const [base, rpc, chainIdIn, keyFile, api, agentId, attestor, shots = "."] = process.argv.slice(2);
if (!attestor) throw new Error("usage: node checkout.mjs <web base> <rpc> <chainId> <key file> <api base> <agentId> <attestor> [shots dir]");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !m.text().includes("_rsc") && errors.push(m.text().slice(0, 200)));
const w = await attachWallet(page, { keyFile, rpc, chainId: Number(chainIdIn) });
const signer = privateKeyToAccount(JSON.parse(readFileSync(keyFile, "utf8")).privateKey);
const pub = createPublicClient({ transport: http(rpc) });
const say = (s) => console.log(s);
const verified = () => pub.readContract({ address: attestor, abi: parseAbi(["function isVerified(uint256) view returns (bool)"]), functionName: "isVerified", args: [BigInt(agentId)] });
const keyFor = async () => {
  const n = await (await fetch(`${api}/v1/keys/nonce?address=${w.address}`)).json();
  const signature = await signer.signMessage({ message: n.message });
  const r = await fetch(`${api}/v1/keys/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: w.address, nonce: n.nonce, signature }) });
  return (await r.json()).apiKey;
};
const creditsOf = async () => BigInt((await (await fetch(`${api}/v1/credits`, { headers: { authorization: `Bearer ${await keyFor()}` } })).json()).credits ?? 0);
const box = (title) => page.locator(".rc-checkout-grid > div").filter({ has: page.getByRole("heading", { name: title }) });
const notice = async (b) => (await b.locator(".rc-notice").last().innerText().catch(() => "")).trim();
const done = /Paid and burned|is verified|rejected|failed|did not|reverted/i;

await page.goto(base + "/credits", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const before = await creditsOf();
say(`1 credits before: ${before}`);

const packs = box("Credit packs");
await packs.getByRole("button", { name: "Get ORRY price" }).click();
await packs.getByRole("button", { name: /^Pay .* ORRY$|Not enough ORRY/ }).waitFor({ timeout: 20000 });
say(`2 pack quote: ${(await packs.locator(".rc-rows").innerText()).replace(/\n/g, " · ")}`);
await packs.getByRole("button", { name: /^Pay .* ORRY$/ }).click();
for (let i = 0; i < 60 && !done.test(await notice(packs)); i++) await page.waitForTimeout(1000);
say(`3 pack paid: ${await notice(packs)}`);
let after = before;
for (let i = 0; i < 40 && after === before; i++) {
  await page.waitForTimeout(2000);
  after = await creditsOf();
}
say(`4 credits after: ${after} (+${after - before})`);

const ver = box("Agent verification");
say(`5 agent #${agentId} verified before: ${await verified()}`);
await ver.getByLabel("Agent ID").fill(agentId);
await ver.getByRole("button", { name: "Get ORRY price" }).click();
await ver.getByRole("button", { name: /^Verify for .* ORRY$|Not enough ORRY/ }).waitFor({ timeout: 20000 });
say(`6 verification quote: ${(await ver.locator(".rc-rows").innerText()).replace(/\n/g, " · ")}`);
await ver.getByRole("button", { name: /^Verify for .* ORRY$/ }).click();
for (let i = 0; i < 60 && !done.test(await notice(ver)); i++) await page.waitForTimeout(1000);
say(`7 verification paid: ${await notice(ver)}`);
say(`8 agent #${agentId} verified after: ${await verified()}`);

await page.screenshot({ path: join(shots, "walk-checkout.png"), fullPage: true });
say(`wallet calls: ${[...new Set(w.log)].join(", ")}`);
say(errors.length ? `console errors: ${[...new Set(errors)].join(" | ")}` : "no console errors");
await browser.close();
