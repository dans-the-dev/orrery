/**
 * Wave 3 public x402 facilitator on Robinhood Chain mainnet 4663, after the ORRY and markets deploys.
 *
 *   tsx scripts/deploy-facilitator-4663.ts --rpc http://127.0.0.1:18548 --fork   dry run on an anvil fork (46630 keys)
 *   tsx scripts/deploy-facilitator-4663.ts                                       live: prints a summary and waits for CONFIRM
 *
 * Deploys MerchantSplitterFactory (fee 0.2%, immutable; USDG fees to the v1 treasury, ORRY fees burned; stake discount
 * from the markets' FeeTiers) and X402Permit2Proxy on the canonical Permit2. Neither has an owner. Re-running with an
 * existing deployments/facilitator-4663.json only reads it back. Keys come from ~/.secrets/orrery/<keys>-deployer.json;
 * only addresses print.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, formatEther, getAddress, http, type Abi, type Account, type Address, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as rc from "../test/generated/orry.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const FORK = process.argv.includes("--fork");
// The official RPC: it accepts transactions (rpc-robinhood.blockmachine.io serves reads only and refuses eth_sendRawTransaction,
// found on the first live run 2026-11-11). Where the official name is DNS-blocked, pass --rpc https://robinhood-rpc.publicnode.com.
const RPC = arg("--rpc") ?? "https://rpc.mainnet.chain.robinhood.com";
const KEYS = arg("--keys") ?? (FORK ? "46630" : "mainnet");
const TAG = FORK ? "4663-fork" : "4663";
const DEPLOYMENTS = join(here, "../../deployments");
/** Uniswap's canonical Permit2, the same address on every chain (checked for code below). */
const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
/** 20 bps = 0.2% of every forward (the factory caps it at 100 bps and it can never change). */
const FEE_BPS = 20;
const ESTIMATE_GAS = 4_000_000n;

const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 1500 }) });
const keyOf = (role: string) => (JSON.parse(readFileSync(join(homedir(), ".secrets/orrery", `${KEYS}-${role}.json`), "utf8")) as { privateKey: Hex }).privateKey;
const wallet = createWalletClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 1500 }), account: privateKeyToAccount(keyOf("deployer")) }) as WalletClient & { account: Account };
const deployer = wallet.account.address;
const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) => pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
let spent = 0n;

async function deploy(name: string, abi: Abi, bytecode: Hex, args: unknown[]) {
  const data = encodeDeployData({ abi, bytecode, args });
  const gas = ((await pub.estimateGas({ account: deployer, data })) * 12n) / 10n + 60_000n;
  const hash = await wallet.sendTransaction({ data, chain, account: wallet.account, gas } as never);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deployment reverted (${hash})`);
  spent += r.gasUsed * r.effectiveGasPrice;
  console.log(`deployed ${name.padEnd(24)} ${r.contractAddress} (gas ${r.gasUsed})`);
  return getAddress(r.contractAddress);
}

// ------------------------------------------------------------------ inputs

if ((await pub.getChainId()) !== 4663) throw new Error("not chain 4663");
const need = [`${TAG}.json`, `orry-${TAG}.json`, `markets-${TAG}.json`].map((f) => join(DEPLOYMENTS, f));
for (const f of need) if (!existsSync(f)) throw new Error(`${f} is needed: deploy v1, ORRY and the markets first.`);
const v1 = JSON.parse(readFileSync(need[0]!, "utf8")) as { treasury: Address; usdg: Address };
const r = JSON.parse(readFileSync(need[1]!, "utf8")) as { orry: Address };
const mk = JSON.parse(readFileSync(need[2]!, "utf8")) as { feeTiers: Address };
const permit2Code = await pub.getCode({ address: PERMIT2 });
if (!permit2Code || permit2Code === "0x") throw new Error(`No Permit2 code at ${PERMIT2} on this chain.`);
const outFile = join(DEPLOYMENTS, `facilitator-${TAG}.json`);
const prev = !FORK && existsSync(outFile) ? (JSON.parse(readFileSync(outFile, "utf8")) as { factory: Address; proxy: Address; startBlock: string }) : null;

const price = await pub.getGasPrice();
const balance = await pub.getBalance({ address: deployer });
console.log(`Wave 3 facilitator on chain 4663${FORK ? " (fork)" : ""}
  deployer         ${deployer} (balance ${formatEther(balance)} ETH)
  fee              ${FEE_BPS / 100}% of every forward, immutable; USDG fee to ${v1.treasury}, ORRY fee burned
  discount         stake tiers of FeeTiers ${mk.feeTiers}
  tokens           USDG ${v1.usdg}, ORRY ${r.orry}
  permit2          ${PERMIT2}
  ${prev ? `exists           factory ${prev.factory}, proxy ${prev.proxy}: read back only` : `gas estimate     ~${ESTIMATE_GAS} gas at ${price} wei = ~${formatEther(ESTIMATE_GAS * price)} ETH`}`);
if (!FORK && !prev && balance < ESTIMATE_GAS * price) {
  console.log(`Deployer balance is below the estimate. Send at least ${formatEther(ESTIMATE_GAS * price * 2n)} ETH to ${deployer} on 4663 first. Nothing was sent.`);
  process.exit(1);
}
if (!FORK && !prev) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Type CONFIRM to deploy the facilitator contracts on mainnet: ");
  rl.close();
  if (answer.trim() !== "CONFIRM") {
    console.log("Not confirmed. Nothing was sent.");
    process.exit(1);
  }
}

// ------------------------------------------------------------------ deploy

let factory: Address;
let proxy: Address;
let startBlock: bigint;
if (prev) {
  ({ factory, proxy } = prev);
  startBlock = BigInt(prev.startBlock);
} else {
  // the facilitator indexer starts here, before the factory, so it sees every SplitterCreated
  startBlock = await pub.getBlockNumber();
  factory = await deploy("merchantSplitterFactory", rc.merchantSplitterFactoryAbi as Abi, rc.merchantSplitterFactoryBytecode as Hex, [FEE_BPS, v1.usdg, r.orry, v1.treasury, mk.feeTiers]);
  proxy = await deploy("x402Permit2Proxy", rc.x402Permit2ProxyAbi as Abi, rc.x402Permit2ProxyBytecode as Hex, [PERMIT2]);
}

// read back: every immutable is what this script meant, and the splitter implementation exists
const fa = rc.merchantSplitterFactoryAbi as Abi;
const [fee, usdg, orry, treasury, tiers, impl, p2] = await Promise.all([
  read<number>(factory, fa, "FEE_BPS"),
  read<Address>(factory, fa, "usdg"),
  read<Address>(factory, fa, "orry"),
  read<Address>(factory, fa, "treasury"),
  read<Address>(factory, fa, "feeTiers"),
  read<Address>(factory, fa, "implementation"),
  read<Address>(proxy, rc.x402Permit2ProxyAbi as Abi, "permit2"),
]);
const implCode = await pub.getCode({ address: impl });
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const checks: [string, boolean][] = [
  ["factory fee", Number(fee) === FEE_BPS],
  ["factory usdg", eq(usdg, v1.usdg)],
  ["factory orry", eq(orry, r.orry)],
  ["factory treasury", eq(treasury, v1.treasury)],
  ["factory fee tiers", eq(tiers, mk.feeTiers)],
  ["splitter implementation has code", Boolean(implCode && implCode !== "0x")],
  ["proxy permit2", eq(p2, PERMIT2)],
];
for (const [label, ok] of checks) console.log(`read back ${ok ? "ok  " : "FAIL"} ${label}`);
console.log(`spent ${formatEther(spent)} ETH`);
if (checks.some(([, ok]) => !ok)) throw new Error("A read-back does not match. Do not configure the API or the web; check the deployment above.");
writeFileSync(outFile, JSON.stringify({ chainId: 4663, startBlock: startBlock.toString(), factory, proxy, permit2: PERMIT2, feeBps: FEE_BPS, implementation: impl }, null, 2) + "\n");
console.log(`wrote deployments/facilitator-${TAG}.json
API, indexer and keeper: ORRERY_SPLITTER_FACTORY=${factory} ORRERY_X402_PERMIT2_PROXY=${proxy} ORRERY_FACILITATOR_START_BLOCK=${startBlock} ORRERY_FEE_TIERS=${mk.feeTiers}; web: NEXT_PUBLIC_SPLITTER_FACTORY=${factory}`);
