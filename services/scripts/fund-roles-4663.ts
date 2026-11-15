/**
 * Tops up Orrery's mainnet role wallets with ETH from the deployer, for the owner to run and confirm.
 *
 *   tsx scripts/fund-roles-4663.ts --dry-run          prints the plan and sends nothing
 *   tsx scripts/fund-roles-4663.ts                    prints the plan, waits for a typed CONFIRM, then sends
 *   [--roles relayer,attester] [--target 0.0002] [--rpc <url>]
 *
 * Each role wallet is topped up to the target balance (only the difference is sent; a wallet already at or above it
 * gets nothing). Default roles are the ones the live core needs now: the relayer (settles credit packs over x402)
 * and the attester (submits agent verifications). keeper, market-keeper and reveal-relay are funded the same way when
 * ORRY and the markets deploy. The deployer key is read from ~/.secrets/orrery/mainnet-deployer.json and never printed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, defineChain, fallback, formatEther, http, keccak256, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DRY = process.argv.includes("--dry-run");
const ROLES = (arg("--roles") ?? "relayer,attester").split(",").map((r) => r.trim()).filter(Boolean);
const TARGET = parseEther(arg("--target") ?? "0.0002");
// Both accept transactions; the official name is DNS-blocked on some ISPs, so publicnode follows it.
const CANDIDATES = arg("--rpc") ? [arg("--rpc")!] : ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"];
/** The endpoints that answer eth_chainId within six seconds, in order; a blocked one would stall every call. */
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
// "walk" is the wallet of the live operator walk (scripts/walk/operator-live-4663.mjs).
const KNOWN = ["walk", "relayer", "attester", "keeper", "market-keeper", "reveal-relay"];
for (const r of ROLES) if (!KNOWN.includes(r)) throw new Error(`unknown role "${r}"; use: ${KNOWN.join(", ")}`);
if (TARGET <= 0n || TARGET > parseEther("0.01")) throw new Error("--target must be above 0 and at most 0.01 ETH");

const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: RPCS } } });
const transport = fallback(RPCS.map((u) => http(u, { retryCount: 3, retryDelay: 1500, timeout: 20_000 })));
const pub = createPublicClient({ chain, transport });
const keyFile = (role: string) => join(homedir(), ".secrets/orrery", `mainnet-${role}.json`);
const addressOf = (role: string) => privateKeyToAccount((JSON.parse(readFileSync(keyFile(role), "utf8")) as { privateKey: Hex }).privateKey).address;
const deployer = privateKeyToAccount((JSON.parse(readFileSync(keyFile("deployer"), "utf8")) as { privateKey: Hex }).privateKey);
const wallet = createWalletClient({ chain, transport, account: deployer });

if ((await pub.getChainId()) !== 4663) throw new Error("not chain 4663");
const gasPrice = await pub.getGasPrice();
const plan = [];
for (const role of ROLES) {
  const to = addressOf(role);
  const now = await pub.getBalance({ address: to });
  plan.push({ role, to, now, send: now >= TARGET ? 0n : TARGET - now });
}
const total = plan.reduce((s, p) => s + p.send, 0n);
const gasEach = 21_000n * gasPrice * 2n; // headroom for a base fee rise between the estimate and the send
const sends = plan.filter((p) => p.send > 0n);
const have = await pub.getBalance({ address: deployer.address });

console.log(`Top up Orrery role wallets on Robinhood Chain mainnet (4663) to ${formatEther(TARGET)} ETH each
  from deployer ${deployer.address} (balance ${formatEther(have)} ETH)`);
for (const p of plan) console.log(`  ${p.role.padEnd(13)} ${p.to}  now ${formatEther(p.now)}  send ${formatEther(p.send)} ETH`);
console.log(`  total ${formatEther(total)} ETH in ${sends.length} transfer(s), gas about ${formatEther(gasEach * BigInt(sends.length))} ETH; deployer keeps ${formatEther(have - total)} ETH`);
if (sends.length === 0) {
  console.log("Every wallet is already at the target. Nothing to send.");
  process.exit(0);
}
if (have < total + gasEach * BigInt(sends.length)) {
  console.log("The deployer cannot cover these transfers and their gas. Nothing was sent.");
  process.exit(1);
}
if (DRY) {
  console.log("Dry run: nothing was sent.");
  process.exit(0);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question("Type CONFIRM to send these transfers on mainnet: ");
rl.close();
if (answer.trim() !== "CONFIRM") {
  console.log("Not confirmed. Nothing was sent.");
  process.exit(1);
}
for (const p of sends) {
  // Sign once and send the raw transaction: a retry of the same bytes answers "already known" when the first send got
  // through (seen on the first live run, 2026-11-11), and the hash is known before the send either way.
  const request = await wallet.prepareTransactionRequest({ to: p.to, value: p.send, chain, account: deployer });
  const signed = await wallet.signTransaction(request as never);
  const hash = keccak256(signed);
  try {
    await wallet.sendRawTransaction({ serializedTransaction: signed });
  } catch (e) {
    if (!/already known/i.test(String(e))) throw e;
  }
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${p.role}: the transfer reverted (${hash}); later transfers were not sent`);
  console.log(`  sent ${formatEther(p.send)} ETH to ${p.role} ${p.to}: ${hash}`);
}
for (const p of plan) console.log(`  ${p.role.padEnd(13)} now ${formatEther(await pub.getBalance({ address: p.to }))} ETH`);
console.log(`  deployer now ${formatEther(await pub.getBalance({ address: deployer.address }))} ETH`);
