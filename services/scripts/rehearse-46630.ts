/**
 * Orrery rehearsal on Robinhood Chain 46630 (or a local fork of it).
 *
 *   tsx scripts/rehearse-46630.ts --rpc <url> [--fork]      run every phase against <url>
 *   tsx scripts/rehearse-46630.ts --estimate                estimate gas of the deployments against the live RPC only
 *
 * Phases: deploy (DevUSDG, OrreryAttestor, OrreryPolicyModule, OrreryLens, DevAccount7579) -> roles -> agent in the real ERC-8004
 * registry with an inline registration file -> bind via ERC-1271 -> install module -> open session -> verification fee
 * -> one top-up. Writes deployments/46630[-fork].json and the env files for the API and the web app.
 * Keys come from ~/.secrets/orrery/46630-<role>.json. With --fork, balances are set with anvil_setBalance.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  hashTypedData,
  http,
  parseAbi,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { devAccount7579Abi, devUSDGAbi, orreryAttestorAbi, orreryLensAbi, orreryPolicyModuleAbi } from "@orrery/shared";
import { operatorCalls, signSessionConsent, type Policy } from "@orrery/sdk";
import * as bytecode from "../test/generated/bytecode.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const FORK = process.argv.includes("--fork");
const ESTIMATE = process.argv.includes("--estimate");
const LIVE_RPC = "https://rpc.testnet.chain.robinhood.com";
const RPC = arg("--rpc") ?? LIVE_RPC;

// 46630 addresses (verified with eth_getCode on 2026-11-07)
const REGISTRY: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const EP07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const EP08: Address = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const NO_ADAPTER: Address = "0x0000000000000000000000000000000000000000"; // Safe7579 is not deployed on 46630

const chain = defineChain({ id: 46630, name: "Robinhood Chain development network", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 3 }) });
const key = (role: string) => (JSON.parse(readFileSync(join(homedir(), ".secrets/orrery", `46630-${role}.json`), "utf8")) as { privateKey: Hex }).privateKey;
const wallet = (role: string) => createWalletClient({ chain, transport: http(RPC, { retryCount: 3 }), account: privateKeyToAccount(key(role)) }) as WalletClient & { account: Account };
const addr = (role: string) => privateKeyToAccount(key(role)).address;

const registryAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

const deployments: { name: string; abi: Abi; code: Hex; args: (ctx: Record<string, Address>) => unknown[] }[] = [
  { name: "usdg", abi: devUSDGAbi as Abi, code: bytecode.devUSDGBytecode, args: () => [addr("deployer")] },
  { name: "attestor", abi: orreryAttestorAbi as Abi, code: bytecode.orreryAttestorBytecode, args: (c) => [REGISTRY, c.usdg, addr("deployer"), addr("deployer"), 5_000_000n] },
  { name: "module", abi: orreryPolicyModuleAbi as Abi, code: bytecode.orreryPolicyModuleBytecode, args: (c) => [REGISTRY, c.attestor, PERMIT2, EP07, EP08, NO_ADAPTER] },
  { name: "lens", abi: orreryLensAbi as Abi, code: bytecode.orreryLensBytecode, args: (c) => [c.module, c.attestor, NO_ADAPTER, [], []] },
  { name: "account", abi: devAccount7579Abi as Abi, code: bytecode.devAccount7579Bytecode, args: () => [addr("operator")] },
];

let spentWei = 0n;
async function send(role: string, to: Address, abi: Abi, functionName: string, args: unknown[]) {
  const w = wallet(role);
  const hash = await w.writeContract({ address: to, abi, functionName, args, chain, account: w.account } as never);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  spentWei += r.gasUsed * r.effectiveGasPrice;
  console.log(`  ${role} ${functionName} ${hash} gas ${r.gasUsed}`);
  return r;
}

if (ESTIMATE) {
  // Gas for the five deployments as the live chain prices them (includes the L1 data component on Arbitrum chains).
  const fake: Record<string, Address> = { usdg: addr("deployer"), attestor: addr("deployer"), module: addr("deployer") };
  const price = await pub.getGasPrice();
  let total = 0n;
  for (const d of deployments) {
    const g = await pub.estimateGas({ account: addr("deployer"), data: encodeDeployData({ abi: d.abi, bytecode: d.code, args: d.args(fake) }) });
    total += g;
    console.log(`${d.name.padEnd(9)} ${g} gas`);
  }
  console.log(`deployments: ${total} gas at ${price} wei = ${formatEther(total * price)} ETH`);
  process.exit(0);
}

const head = await pub.getBlockNumber();
console.log(`chain ${await pub.getChainId()} at block ${head} via ${RPC}${FORK ? " (fork)" : ""}`);
if (FORK) {
  for (const r of ["deployer", "relayer", "attester", "operator", "agent-signer"]) {
    await pub.request({ method: "anvil_setBalance" as never, params: [addr(r), "0x2386F26FC10000"] as never }); // 0.01 ETH
  }
}

// 1. deploy
const c: Record<string, Address> = {};
const d0 = wallet("deployer");
let deployBlock = 0n;
for (const d of deployments) {
  const hash = await d0.deployContract({ abi: d.abi, bytecode: d.code, args: d.args(c), chain, account: d0.account });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  spentWei += r.gasUsed * r.effectiveGasPrice;
  c[d.name] = r.contractAddress!;
  if (deployBlock === 0n) deployBlock = r.blockNumber;
  console.log(`deployed ${d.name} ${r.contractAddress} gas ${r.gasUsed}`);
}

// 2. roles and balances
await send("deployer", c.attestor!, orreryAttestorAbi as Abi, "setCheckSigner", [addr("check-signer"), true]);
await send("deployer", c.attestor!, orreryAttestorAbi as Abi, "setAttester", [addr("attester"), true]);
for (const [to, amt] of [[c.account!, 1_000_000_000n], [addr("merchant"), 100_000_000n], [addr("operator"), 100_000_000n]] as const) {
  await send("deployer", c.usdg!, devUSDGAbi as Abi, "mint", [to, amt]);
}

// 3. agent in the real ERC-8004 registry, with an inline registration file naming its service
const reg = await send("operator", REGISTRY, registryAbi as unknown as Abi, "register", ["data:,"]);
let agentId = -1n;
for (const l of reg.logs) {
  if (l.address.toLowerCase() !== REGISTRY.toLowerCase()) continue;
  try {
    const ev = decodeEventLog({ abi: registryAbi, data: l.data, topics: l.topics });
    if (ev.eventName === "Registered") agentId = ev.args.agentId;
  } catch {}
}
if (agentId < 0n) throw new Error("Registered event not found");
const registration = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Orrery rehearsal agent",
  description: "Agent used to rehearse Orrery on the development network.",
  services: [{ name: "web", endpoint: "https://orreryagent.com/" }],
  registrations: [{ agentRegistry: `eip155:46630:${REGISTRY}`, agentId: Number(agentId) }],
};
const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(registration)).toString("base64")}`;
await send("operator", REGISTRY, registryAbi as unknown as Abi, "setAgentURI", [agentId, uri]);

// 4. bind the account as agentWallet through ERC-1271 (DevAccount7579 accepts the owner's raw signature over the digest)
const blockTs = (await pub.getBlock()).timestamp;
const deadline = blockTs + 240n;
const digest = hashTypedData({
  domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: 46630, verifyingContract: REGISTRY },
  types: { AgentWalletSet: [{ name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "owner", type: "address" }, { name: "deadline", type: "uint256" }] },
  primaryType: "AgentWalletSet",
  message: { agentId, newWallet: c.account!, owner: addr("operator"), deadline },
});
const bindSig = await sign({ hash: digest, privateKey: key("operator"), to: "hex" });
await send("operator", REGISTRY, registryAbi as unknown as Abi, "setAgentWallet", [agentId, c.account, deadline, bindSig]);

// 5. install the module and open the session (signer consent)
await send("operator", c.account!, devAccount7579Abi as Abi, "execute", [c.account, 0n, encodeFunctionData({ abi: devAccount7579Abi, functionName: "installModule", args: [2n, c.module!, "0x"] })]);
const now = (await pub.getBlock()).timestamp;
const policy: Policy = { caps: [{ token: c.usdg!, perTx: 10_000_000n, perDay: 50_000_000n, floatMax: 20_000_000n }], targets: [], validUntil: now + 30n * 86400n, increaseDelay: 3600 };
const consent = await signSessionConsent(privateKeyToAccount(key("agent-signer")), { chainId: 46630, module: c.module!, account: c.account!, agentId, policy });
await send("operator", c.account!, devAccount7579Abi as Abi, "execute", [c.module, 0n, operatorCalls.openSession(agentId, addr("agent-signer"), policy, consent)]);

// 6. verification fee and one top-up
await send("operator", c.usdg!, devUSDGAbi as Abi, "approve", [c.attestor, 5_000_000n]);
await send("operator", c.attestor!, orreryAttestorAbi as Abi, "payVerification", [agentId, addr("operator"), 5_000_000n]);
await send("agent-signer", c.module!, orreryPolicyModuleAbi as Abi, "topUp", [c.usdg, 3_500_000n]);

const view = await pub.readContract({ address: c.lens!, abi: orreryLensAbi, functionName: "checkBySigner", args: [addr("agent-signer")] });
console.log(`lens: status ${view.status}, bound ${view.bound}, installed ${view.installed}, verified ${view.verified}, spent ${view.caps[0]?.spentToday}`);
console.log(`spent ${formatEther(spentWei)} ETH across all transactions`);

const tag = FORK ? "46630-fork" : "46630";
const outDir = join(here, "../../deployments");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ chainId: 46630, rpc: FORK ? RPC : LIVE_RPC, deployBlock: deployBlock.toString(), registry: REGISTRY, ...c, agentId: agentId.toString(), signer: addr("agent-signer"), operator: addr("operator"), merchant: addr("merchant"), treasury: addr("deployer"), spentEth: formatEther(spentWei) }, null, 2) + "\n");
mkdirSync(join(here, "../.local"), { recursive: true });
writeFileSync(join(here, `../.local/api-${tag}.env`), [
  "ORRERY_CHAIN_ID=46630", `ORRERY_RPC_URL=${RPC}`, `ORRERY_MODULE=${c.module}`, `ORRERY_ATTESTOR=${c.attestor}`, `ORRERY_LENS=${c.lens}`,
  `ORRERY_REGISTRY=${REGISTRY}`, `ORRERY_USDG=${c.usdg}`, `ORRERY_TREASURY=${addr("deployer")}`, "ORRERY_CONFIRMATIONS=2", "ORRERY_PORT=8787",
  "ORRERY_PUBLIC_URL=http://127.0.0.1:8787", `ORRERY_RELAYER_KEY_FILE=${join(homedir(), ".secrets/orrery/46630-relayer.json")}`,
  `ORRERY_CHECK_SIGNER_KEY_FILE=${join(homedir(), ".secrets/orrery/46630-check-signer.json")}`, `ORRERY_ATTESTER_KEY_FILE=${join(homedir(), ".secrets/orrery/46630-attester.json")}`,
  `ORRERY_INDEXER_START_BLOCK=${deployBlock}`,
].join("\n") + "\n");
console.log(`wrote deployments/${tag}.json and services/.local/api-${tag}.env`);
