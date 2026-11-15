/**
 * Fork-only check of the Operator page's one-click account: on an anvil fork of 4663, a fresh wallet creates its Safe,
 * prepares it (adapter + Orrery policy module) and registers an ERC-8004 agent with the same calldata the page sends,
 * then the lens is read back. Refuses anything but a local RPC.
 *
 *   tsx scripts/operator-setup-fork.ts --rpc http://127.0.0.1:8561 --deployment ../deployments/4663.json
 */
import { readFileSync } from "node:fs";
import { concat, createPublicClient, createTestClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { orreryLensAbi } from "@orrery/shared";
import { SAFE_STACK, createSafeCall, identityRegistryAbi, prepareAccountCall, safeFactoryAbi, safeSetupAbi } from "../packages/web/lib/operator-setup";

const arg = (n: string) => process.argv[process.argv.indexOf(n) + 1]!;
const RPC = arg("--rpc");
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC)) throw new Error("local fork only");
const dep = JSON.parse(readFileSync(arg("--deployment"), "utf8")) as Record<string, string>;
const chain = defineChain({ id: 4663, name: "4663 fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 120_000 }) });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const owner = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ chain, transport: http(RPC, { timeout: 120_000 }), account: owner });
await test.setBalance({ address: owner.address, value: parseEther("1") });
const stack = SAFE_STACK[4663]!;
const execAbi = parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)"]);
const Z = "0x0000000000000000000000000000000000000000" as const;

async function send(to: Address, data: Hex) {
  const hash = await wallet.sendTransaction({ to, data });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx to ${to} reverted`);
  return r;
}
const c = createSafeCall(stack, owner.address, BigInt(Date.now()));
const created = await send(c.to, c.data);
let safe: Address | undefined;
for (const l of created.logs) {
  try {
    const ev = decodeEventLog({ abi: safeFactoryAbi, data: l.data, topics: l.topics });
    if (ev.eventName === "ProxyCreation") safe = ev.args.proxy;
  } catch {}
}
if (!safe) throw new Error("no ProxyCreation event");
console.log("1 safe", safe, "gas", created.gasUsed);
const p = prepareAccountCall(stack, safe, dep.module as Address);
const sig = concat([`0x${owner.address.slice(2).padStart(64, "0")}`, `0x${"0".repeat(64)}`, "0x01"]);
const prepared = await send(safe, encodeFunctionData({ abi: execAbi, functionName: "execTransaction", args: [p.to, 0n, p.data, p.operation, 0n, 0n, 0n, Z, Z, sig] }));
console.log("2 prepared, gas", prepared.gasUsed, "adapter enabled", await pub.readContract({ address: safe, abi: safeSetupAbi, functionName: "isModuleEnabled", args: [stack.adapter] }));
const reg = await send(dep.registry as Address, encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [""] }));
let agentId = -1n;
for (const l of reg.logs) {
  try {
    const ev = decodeEventLog({ abi: identityRegistryAbi, data: l.data, topics: l.topics });
    if (ev.eventName === "Registered") agentId = ev.args.agentId;
  } catch {}
}
console.log("3 agent", agentId, "gas", reg.gasUsed);
const view = await pub.readContract({ address: dep.lens as Address, abi: orreryLensAbi, functionName: "checkByAgent", args: [agentId, safe] });
console.log("lens: installed", view.installed, "bound", view.bound, "accountKind", (view as { accountKind?: unknown }).accountKind, "status", view.status);
if (!view.installed) throw new Error("policy module not installed");
