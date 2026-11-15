/**
 * Fork-only setup for walking the operator flow in the web app on a real Safe: on an anvil fork of 4663, creates a
 * Safe 1.4.1 (1-of-1, owner = account 0 of the fork mnemonic) with the Safe7579 v1.0.0 adapter as module and fallback handler
 * (initialised with no modules, as a fresh Safe7579 account), registers an ERC-8004 agent owned by the operator in the
 * real registry, and prints the signer consent for the policy the walk will type into the operator form.
 *
 *   tsx scripts/setup-safe-fork.ts --rpc http://127.0.0.1:8548 --deployment ../deployments/4663-fork.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, http, parseAbi, parseUnits, type Account, type Address, type Hex, type WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { signSessionConsent, type Policy } from "@orrery/sdk";

const arg = (n: string) => process.argv[process.argv.indexOf(n) + 1]!;
const RPC = arg("--rpc");
const dep = JSON.parse(readFileSync(arg("--deployment"), "utf8")) as Record<string, string>;
const chain = defineChain({ id: 4663, name: "4663 fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
// Fresh accounts from the fork's own mnemonic (the default anvil accounts carry EIP-7702 delegations on 4663).
const MNEMONIC = readFileSync(process.env.ORRERY_FORK_MNEMONIC_FILE!, "utf8").trim();
const operator = createWalletClient({ chain, transport: http(RPC), account: mnemonicToAccount(MNEMONIC, { addressIndex: 0 }) }) as WalletClient & { account: Account };
const FACTORY: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const ADAPTER = dep.safe7579Adapter as Address;

const safeAbi = parseAbi([
  "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
  "function enableModule(address module)",
]);
const factoryAbi = parseAbi(["function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)", "event ProxyCreation(address indexed proxy, address singleton)"]);
const initAbi = parseAbi([
  "struct ModuleInit { address module; bytes initData; }",
  "struct RegistryInit { address registry; address[] attesters; uint8 threshold; }",
  "function initializeAccount(ModuleInit[] validators, ModuleInit[] executors, ModuleInit[] fallbacks, ModuleInit[] hooks, RegistryInit registryInit)",
]);
const registryAbi = parseAbi(["function register(string agentURI) returns (uint256 agentId)", "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)"]);

async function send(to: Address, data: Hex) {
  const hash = await operator.sendTransaction({ to, data, chain, account: operator.account });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx to ${to} reverted`);
  return r;
}
async function viaSafe(safe: Address, to: Address, data: Hex) {
  const sig = `0x${operator.account.address.slice(2).padStart(64, "0")}${"0".repeat(64)}01` as Hex;
  return send(safe, encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", sig] }));
}

const init = encodeFunctionData({ abi: safeAbi, functionName: "setup", args: [[operator.account.address], 1n, "0x0000000000000000000000000000000000000000", "0x", ADAPTER, "0x0000000000000000000000000000000000000000", 0n, "0x0000000000000000000000000000000000000000"] });
const created = await send(FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: "createProxyWithNonce", args: [SAFE_L2, init, BigInt(Date.now())] }));
let safe: Address | undefined;
for (const l of created.logs) {
  try {
    const ev = decodeEventLog({ abi: factoryAbi, data: l.data, topics: l.topics });
    if (ev.eventName === "ProxyCreation") safe = ev.args.proxy;
  } catch {}
}
if (!safe) throw new Error("no ProxyCreation event");
await viaSafe(safe, safe, encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [ADAPTER] }));
await viaSafe(safe, safe, encodeFunctionData({ abi: initAbi, functionName: "initializeAccount", args: [[], [], [], [], { registry: "0x0000000000000000000000000000000000000000", attesters: [], threshold: 0 }] }));

const reg = await send(dep.registry as Address, encodeFunctionData({ abi: registryAbi, functionName: "register", args: ["data:,"] }));
let agentId = -1n;
for (const l of reg.logs) {
  try {
    const ev = decodeEventLog({ abi: registryAbi, data: l.data, topics: l.topics });
    if (ev.eventName === "Registered") agentId = ev.args.agentId;
  } catch {}
}

// The policy the walk types: 10 / 50 / 20 USDG, no targets, expiry 2026-12-31, 1 hour delay (the web form's encoding).
const policy: Policy = {
  caps: [{ token: dep.usdg as Address, perTx: parseUnits("10", 6), perDay: parseUnits("50", 6), floatMax: parseUnits("20", 6) }],
  targets: [],
  validUntil: BigInt(Math.floor(new Date("2026-12-31T23:59:59Z").getTime() / 1000)),
  increaseDelay: 3600,
};
const signer = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const consent = await signSessionConsent(signer, { chainId: 4663, module: dep.module as Address, account: safe, agentId, policy });
const out = { safe, operator: operator.account.address, agentId: agentId.toString(), signer: signer.address, consent };
writeFileSync(new URL("../.local/safe-walk.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
