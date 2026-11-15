// Walk: merchant payments (wave 3). The walk wallet is the merchant: it opens the dashboard, sets up its payment address
// on the Merchants page and saves a profile. A second key (the payer) then pays it over x402 through the API, once in
// USDG (EIP-3009) and once in ORRY (Permit2, approved once), and the merchant forwards both from the page.
//   node merchants.mjs <web base> <rpc> <chainId> <merchant key file> <payer key file> <api base> [shots dir]
import { createRequire } from "node:module";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, maxUint256, parseAbi, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { attachWallet } from "./wallet.mjs";
const require = createRequire("/home/dand/Projects/blockchain/matriks-destiny/package.json");
const { chromium } = require("playwright-core");
const [base, rpc, chainIdIn, keyFile, payerFile, api, shots = "."] = process.argv.slice(2);
if (!base || !rpc || !chainIdIn || !keyFile || !payerFile || !api) throw new Error("usage: node merchants.mjs <web base> <rpc> <chainId> <merchant key> <payer key> <api base> [shots dir]");
const chainId = Number(chainIdIn);
if ((chainId === 4663 || chainId === 1) && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(rpc)) throw new Error("test networks or a local fork only");
const say = (s) => console.log(s);
const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc) });
const payer = privateKeyToAccount(JSON.parse(readFileSync(payerFile, "utf8")).privateKey);
const payerWallet = createWalletClient({ chain, transport: http(rpc), account: payer });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !m.text().includes("_rsc") && errors.push(m.text().slice(0, 200)));
const w = await attachWallet(page, { keyFile, rpc, chainId });

// 1 the dashboard, its own app (dashboard.mjs walks every section)
await page.goto(base + "/dashboard", { waitUntil: "networkidle" });
await page.locator(".dsh-connect button, .dsh-actions button").first().click().catch(() => {});
await page.locator(".cp-stats").waitFor({ timeout: 30000 });
say(`1 dashboard: ${(await page.locator(".dsh-nav").innerText()).replace(/\n+/g, " · ")}`);
await page.screenshot({ path: join(shots, "merchants-1-dashboard.png") });

// 2 the payment address, known before it exists
await page.goto(base + "/merchants", { waitUntil: "networkidle" });
await page.locator(".mc-address code").waitFor({ timeout: 30000 });
const splitter = (await page.locator(".mc-address code").innerText()).trim();
say(`2 payment address ${splitter}`);
const supported = await (await fetch(`${api}/v1/x402/supported`)).json();
const usdgKind = supported.kinds.find((k) => k.extra.assetTransferMethod === "eip3009");
const orryKind = supported.kinds.find((k) => k.extra.assetTransferMethod === "permit2");
say(`  supported: ${supported.kinds.map((k) => `${k.extra.assetTransferMethod} ${k.asset}`).join(", ")}`);

// 3 create it
if (await page.getByRole("button", { name: "Create payment address" }).isVisible()) {
  await page.getByRole("button", { name: "Create payment address" }).click();
  await page.getByText("Your payment address is ready.").waitFor({ timeout: 60000 });
}
await page.getByText("Ready for payments").waitFor({ timeout: 30000 });
say("3 created: Ready for payments");

// 4 profile, signed
await page.getByLabel("Name").fill("Walk Weather");
await page.getByLabel("Link").fill("https://weather.example");
await page.getByLabel("What agents can buy").fill("Forecasts per call.");
await page.getByRole("button", { name: "Save profile" }).click();
await page.getByText("Profile saved.").waitFor({ timeout: 30000 });
say("4 profile saved");

// 5 the payer pays 20 USDG over x402 (EIP-3009), through verify and settle
const head = await pub.getBlock();
const req = (requirements, payload) => ({ x402Version: 2, paymentRequirements: requirements, paymentPayload: { x402Version: 2, accepted: requirements, payload } });
const usdgReq = { scheme: "exact", network: `eip155:${chainId}`, amount: "20000000", asset: usdgKind.asset, payTo: splitter, maxTimeoutSeconds: 600, extra: { name: usdgKind.extra.name, version: usdgKind.extra.version, assetTransferMethod: "eip3009" } };
const auth = { from: payer.address, to: splitter, value: 20_000_000n, validAfter: head.timestamp - 60n, validBefore: head.timestamp + 3600n, nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) };
const sig = await payer.signTypedData({
  domain: { name: usdgKind.extra.name, version: usdgKind.extra.version, chainId, verifyingContract: usdgKind.asset },
  types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "TransferWithAuthorization",
  message: auth,
});
const usdgBody = req(usdgReq, { signature: sig, authorization: { ...auth, value: "20000000", validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString() } });
const post = async (path, body) => (await fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
say(`5 USDG verify ${JSON.stringify(await post("/v1/x402/verify", usdgBody))}`);
const settled = await post("/v1/x402/settle", usdgBody);
say(`  settle ${settled.success ? "ok " + settled.transaction : JSON.stringify(settled)}`);

// 6 the payer pays 40 ORRY over Permit2 (approve Permit2 once)
if (orryKind) {
  const permit2 = orryKind.extra.permit2;
  if ((await pub.readContract({ address: orryKind.asset, abi: erc20, functionName: "allowance", args: [payer.address, permit2] })) < 40n * 10n ** 18n) {
    const h = await payerWallet.writeContract({ address: orryKind.asset, abi: erc20, functionName: "approve", args: [permit2, maxUint256] });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const orryReq = { scheme: "exact", network: `eip155:${chainId}`, amount: (40n * 10n ** 18n).toString(), asset: orryKind.asset, payTo: splitter, maxTimeoutSeconds: 600, extra: { assetTransferMethod: "permit2", proxy: orryKind.extra.proxy } };
  const nonce = BigInt(toHex(crypto.getRandomValues(new Uint8Array(31))));
  const deadline = head.timestamp + 3600n;
  const psig = await payer.signTypedData({
    domain: { name: "Permit2", chainId, verifyingContract: permit2 },
    types: {
      PermitWitnessTransferFrom: [{ name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "witness", type: "X402Payment" }],
      TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
      X402Payment: [{ name: "to", type: "address" }],
    },
    primaryType: "PermitWitnessTransferFrom",
    message: { permitted: { token: orryKind.asset, amount: 40n * 10n ** 18n }, spender: orryKind.extra.proxy, nonce, deadline, witness: { to: splitter } },
  });
  const orryBody = req(orryReq, { signature: psig, permit2Authorization: { from: payer.address, permitted: { token: orryKind.asset, amount: orryReq.amount }, spender: orryKind.extra.proxy, nonce: nonce.toString(), deadline: deadline.toString(), witness: { to: splitter } } });
  say(`6 ORRY verify ${JSON.stringify(await post("/v1/x402/verify", orryBody))}`);
  const s2 = await post("/v1/x402/settle", orryBody);
  say(`  settle ${s2.success ? "ok " + s2.transaction : JSON.stringify(s2)}`);
} else say("6 ORRY over x402 is held");

// 7 the merchant forwards both from the page
const before = await pub.readContract({ address: usdgKind.asset, abi: erc20, functionName: "balanceOf", args: [w.address] });
await page.reload({ waitUntil: "networkidle" });
await page.getByRole("button", { name: "Forward USDG now" }).waitFor({ timeout: 20000 });
await page.waitForTimeout(3000);
say(`7 before forward: ${(await page.locator(".mc-sec").first().locator(".rc-rows").innerText()).replace(/\n+/g, " · ")}`);
await page.getByRole("button", { name: "Forward USDG now" }).click();
await page.getByText("USDG is on its way to your wallet.").waitFor({ timeout: 60000 });
const after = await pub.readContract({ address: usdgKind.asset, abi: erc20, functionName: "balanceOf", args: [w.address] });
say(`  USDG received ${Number(after - before) / 1e6} (20 paid, fee ${(20 - Number(after - before) / 1e6).toFixed(4)})`);
if (orryKind) {
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "Forward ORRY now" }).click();
  await page.getByText("ORRY is on its way to your wallet.").waitFor({ timeout: 60000 });
  say("  ORRY forwarded");
}
await page.waitForTimeout(3000);
await page.screenshot({ path: join(shots, "merchants-2-page.png"), fullPage: true });
say(`8 merchant record ${JSON.stringify(await (await fetch(`${api}/v1/merchants/${w.address}`)).json())}`);
say(errors.length ? `console errors: ${[...new Set(errors)].join(" | ")}` : "no console errors");
await browser.close();
