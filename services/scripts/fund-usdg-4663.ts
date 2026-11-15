/**
 * Buys USDG with the deployer's ETH and delivers it to a Orrery mainnet wallet, for the owner to run and confirm.
 * None of Orrery's keyed wallets holds USDG, so tests that pay in USDG (a credit pack, an agent verification) start here.
 *
 *   tsx scripts/fund-usdg-4663.ts --dry-run                 prints the quote, sends nothing
 *   tsx scripts/fund-usdg-4663.ts                           prints it and waits for a typed CONFIRM
 *   [--to buyer] [--usdg 1.2] [--rpc <url>]
 *
 * Route: the Uniswap V2 router on 4663 (0x89e5…9eba, factory 0x8bce…937f, WETH 0x0bd7…ad73) through its ETH/USDG pair,
 * swapETHForExactTokens: exactly the USDG asked for, to the recipient; the router refunds unused ETH to the deployer.
 * The ETH sent is the router's quote plus 2%, so a price move inside that margin still fills and a larger one reverts.
 * Keys: ~/.secrets/orrery/mainnet-<role>.json (never printed).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, fallback, formatEther, formatUnits, getAddress, http, keccak256, parseAbi, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DRY = process.argv.includes("--dry-run");
const TO_ROLE = arg("--to") ?? "buyer";
const USDG_OUT = parseUnits(arg("--usdg") ?? "1.2", 6);
if (USDG_OUT <= 0n || USDG_OUT > parseUnits("50", 6)) throw new Error("--usdg must be above 0 and at most 50");
// "walk" is the wallet of the live operator walk (scripts/walk/operator-live-4663.mjs).
const ROLES = ["buyer", "walk", "relayer", "attester", "keeper", "market-keeper", "reveal-relay"];
if (!ROLES.includes(TO_ROLE)) throw new Error(`--to must be one of: ${ROLES.join(", ")}`);

const ROUTER = getAddress("0x89e5DB8B5aA49aA85AC63f691524311AEB649eba");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const routerAbi = parseAbi([
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)",
  "function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
]);

const CANDIDATES = arg("--rpc") ? [arg("--rpc")!] : ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"];
async function reachable(urls: string[]): Promise<string[]> {
  const ok: string[] = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(6000) });
      if (((await r.json()) as { result?: string }).result === "0x1237") ok.push(url);
    } catch {
      // unreachable from this network: skipped
    }
  }
  if (!ok.length) throw new Error(`no RPC answered: ${urls.join(", ")}`);
  return ok;
}
const RPCS = await reachable(CANDIDATES);
const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: RPCS } } });
const transport = fallback(RPCS.map((u) => http(u, { retryCount: 2, timeout: 20_000 })));
const pub = createPublicClient({ chain, transport });
const keyOf = (role: string) => (JSON.parse(readFileSync(join(homedir(), ".secrets/orrery", `mainnet-${role}.json`), "utf8")) as { privateKey: Hex }).privateKey;
const deployer = privateKeyToAccount(keyOf("deployer"));
const to = privateKeyToAccount(keyOf(TO_ROLE)).address;
const wallet = createWalletClient({ chain, transport, account: deployer });

if ((await pub.getChainId()) !== 4663) throw new Error("not chain 4663");
if (getAddress(await pub.readContract({ address: ROUTER, abi: routerAbi, functionName: "WETH" })) !== WETH) throw new Error("the router's WETH changed; check the route");
const path = [WETH, USDG];
const [quoteIn] = await pub.readContract({ address: ROUTER, abi: routerAbi, functionName: "getAmountsIn", args: [USDG_OUT, path] });
const value = (quoteIn! * 102n) / 100n;
const gasPrice = await pub.getGasPrice();
const have = await pub.getBalance({ address: deployer.address });
const usdgBefore = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [to] });
const price = Number(USDG_OUT) / 1e6 / (Number(quoteIn) / 1e18);

console.log(`Buy ${formatUnits(USDG_OUT, 6)} USDG with the deployer's ETH for ${TO_ROLE} ${to}
  route     Uniswap V2 router ${ROUTER}, ETH -> USDG (about ${price.toFixed(0)} USDG per ETH)
  spend     up to ${formatEther(value)} ETH (quote ${formatEther(quoteIn!)} plus 2%; unused ETH comes back)
  deployer  ${deployer.address} (ETH ${formatEther(have)})
  ${TO_ROLE.padEnd(9)} USDG ${formatUnits(usdgBefore, 6)} now`);
if (have < value + 300_000n * gasPrice) {
  console.log("The deployer cannot cover this and its gas. Nothing was sent.");
  process.exit(1);
}
// Simulated on the live chain state (eth_call), so a route that would revert stops here with nothing sent.
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const sim = await pub.simulateContract({ address: ROUTER, abi: routerAbi, functionName: "swapETHForExactTokens", args: [USDG_OUT, path, to, deadline], value, account: deployer.address });
console.log(`  simulated on the live chain: spends ${formatEther(sim.result[0]!)} ETH, delivers ${formatUnits(sim.result[1]!, 6)} USDG`);
if (DRY) {
  console.log("Dry run: nothing was sent.");
  process.exit(0);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question("Type CONFIRM to buy USDG on mainnet: ");
rl.close();
if (answer.trim() !== "CONFIRM") {
  console.log("Not confirmed. Nothing was sent.");
  process.exit(1);
}
const data = encodeFunctionData({ abi: routerAbi, functionName: "swapETHForExactTokens", args: [USDG_OUT, path, to, deadline] });
const request = await wallet.prepareTransactionRequest({ to: ROUTER, data, value, chain, account: deployer });
const signed = await wallet.signTransaction(request as never);
const hash = keccak256(signed);
try {
  await wallet.sendRawTransaction({ serializedTransaction: signed });
} catch (e) {
  if (!/already known/i.test(String(e))) throw e;
}
const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
if (r.status !== "success") throw new Error(`the swap reverted (${hash}); nothing moved but gas`);
const usdgAfter = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [to] });
console.log(`  swapped: ${hash}
  ${TO_ROLE} USDG ${formatUnits(usdgBefore, 6)} -> ${formatUnits(usdgAfter, 6)}; deployer ETH now ${formatEther(await pub.getBalance({ address: deployer.address }))}`);
