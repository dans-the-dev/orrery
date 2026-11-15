/**
 * Buys one Orrery credit pack on mainnet over x402, from the mainnet buyer wallet, to prove the live purchase path:
 * the API's 402 terms, an EIP-3009 authorization signed by the buyer, the relayer's settlement, the treasury's USDG and
 * the credits on the buyer's API key. The buyer needs USDG only; the relayer pays the gas.
 *
 *   tsx scripts/buy-credits-4663.ts --dry-run    prints the terms and the buyer's balance, sends nothing
 *   tsx scripts/buy-credits-4663.ts              prints them and waits for a typed CONFIRM
 *   tsx scripts/buy-credits-4663.ts --yes        the owner approved this purchase in chat (one pack, item and total shown)
 *
 * Key: ~/.secrets/orrery/mainnet-buyer.json (never printed).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, fallback, formatUnits, http, type Account, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HEADER_REQUIRED, OrreryApi, decodeHeader, type PaymentRequired } from "@orrery/sdk";

const API = "https://api.orrery.tech";
const DRY = process.argv.includes("--dry-run");
const YES = process.argv.includes("--yes");
const RPCS = ["https://robinhood-rpc.publicnode.com", "https://rpc-robinhood.blockmachine.io"];
const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: RPCS } } });
const transport = fallback(RPCS.map((u) => http(u, { retryCount: 2, timeout: 20_000 })));
const pub = createPublicClient({ chain, transport });
const buyer = privateKeyToAccount((JSON.parse(readFileSync(join(homedir(), ".secrets/orrery/mainnet-buyer.json"), "utf8")) as { privateKey: Hex }).privateKey);
const wallet = createWalletClient({ chain, transport, account: buyer }) as WalletClient & { account: Account };

const first = await fetch(`${API}/v1/credits`, { method: "POST" });
const header = first.headers.get(HEADER_REQUIRED);
if (first.status !== 402 || !header) throw new Error(`expected 402 with payment terms, got ${first.status}`);
const terms = decodeHeader<PaymentRequired>(header).accepts.find((a) => a.network === "eip155:4663");
if (!terms) throw new Error("no payment option for 4663");
const pricing = (await (await fetch(`${API}/v1/pricing`)).json()) as { packSize: number };
const usdg = await pub.readContract({ address: terms.asset, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] });
const treasuryBefore = await pub.readContract({ address: terms.asset, abi: erc20Abi, functionName: "balanceOf", args: [terms.payTo] });

console.log(`Buy 1 credit pack (${pricing.packSize} credits) on orrery.tech for ${formatUnits(BigInt(terms.amount), 6)} USDG
  buyer     ${buyer.address} (USDG ${formatUnits(usdg, 6)})
  pays to   ${terms.payTo} (the Orrery treasury, USDG ${formatUnits(treasuryBefore, 6)})
  settled by the relayer over x402 (EIP-3009); the buyer pays no gas`);
if (usdg < BigInt(terms.amount)) {
  console.log("The buyer does not hold enough USDG yet. Nothing was sent.");
  process.exit(1);
}
if (DRY) {
  console.log("Dry run: nothing was sent.");
  process.exit(0);
}
if (!YES) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Type CONFIRM to buy on mainnet: ");
  rl.close();
  if (answer.trim() !== "CONFIRM") {
    console.log("Not confirmed. Nothing was sent.");
    process.exit(1);
  }
}

const out = await OrreryApi.buyCredits(API, wallet, pub as never);
console.log(`  bought: credits ${out.credits}, API key ${out.apiKey ? "issued" : "unchanged"}`);
const treasuryAfter = await pub.readContract({ address: terms.asset, abi: erc20Abi, functionName: "balanceOf", args: [terms.payTo] });
const usdgAfter = await pub.readContract({ address: terms.asset, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] });
console.log(`  treasury USDG ${formatUnits(treasuryBefore, 6)} -> ${formatUnits(treasuryAfter, 6)}; buyer USDG ${formatUnits(usdg, 6)} -> ${formatUnits(usdgAfter, 6)}`);
if (out.apiKey) {
  const account = (await (await fetch(`${API}/v1/credits`, { headers: { authorization: `Bearer ${out.apiKey}` } })).json()) as { credits: string; purchases: unknown[] };
  console.log(`  API: credits ${account.credits}, purchases ${account.purchases.length}`);
}
