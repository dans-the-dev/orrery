/**
 * The whole of Orrery on Robinhood Chain 46630 (development network), to try every feature before mainnet.
 *
 *   tsx scripts/deploy-46630-full.ts [--rpc <url>]          deploy and seed (resumable: re-run continues where it stopped)
 *   tsx scripts/deploy-46630-full.ts --execute-coin         48 hours later: the treasury takes ORRY (checkout opens)
 *
 * v1 as on mainnet, with the treasury (OWNER_BPS 3000, R-57) as the attestor's fee recipient. What 46630 lacks gets a
 * stand-in (owner decision 2026-11-10): DevUSDG for USDG (the 46630 test token is owner-mint only), DevAccount7579 for
 * the Safe7579 adapter (absent), a fixed-supply ORRY coin for the Pons launch (Pons is absent), a fixed ETH/USD feed
 * for Chainlink (absent; the hook reads it only when a pair is registered), and our own hookless ETH/USDG pool with
 * concentrated depth for the buyback's first hop. The Uniswap v4 PoolManager, the CREATE2 factory, Permit2, the
 * EntryPoints and the ERC-8004 registry are the real 46630 contracts.
 *
 * Wave 3: MerchantSplitterFactory (0.2%, stake discount from the markets' FeeTiers) and X402Permit2Proxy on the real Permit2.
 *
 * Seeds: a demo agent in the real registry with a session and its verification, Earn deposits in both hubs, a few
 * hub swaps so Earn has fees, treasury revenue, the walk wallet's ORRY and DevUSDG, and proposeCoin. Writes
 * deployments/46630-full.json (state and addresses), services/.local/api-46630-full.env and web-46630-full.env.
 * Keys: ~/.secrets/orrery/46630-<role>.json. Prints addresses only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  getContractAddress,
  hashTypedData,
  http,
  isAddressEqual,
  keccak256,
  pad,
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
import * as v1 from "../test/generated/bytecode.js";
import * as rc from "../test/generated/orry.js";
import { CREATE2_FACTORY, HUB_SQRT_PRICE, POOL_MANAGER, Q96, USDG_PER_ETH, ZERO, isqrt, mineHookSalt, pmAbi, poolIdOf, type PoolKey } from "../test/orry-system.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
// The official 46630 RPC is DNS-blocked on some ISPs; publicnode serves 46630 too. Server 1 reaches the official one.
const RPC = arg("--rpc") ?? "https://robinhood-sepolia-rpc.publicnode.com";
const SERVER_RPC = "https://rpc.testnet.chain.robinhood.com";
const EXECUTE_COIN = process.argv.includes("--execute-coin");

// 46630 contracts (eth_getCode 2026-11-10)
const REGISTRY: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const EP07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const EP08: Address = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const NO_ADAPTER = ZERO; // Safe7579 is not deployed on 46630; the development account stands in

// Testnet sizes: ETH is scarce (bank), USDG and ORRY are not.
const OWNER_BPS = 3000; // R-57, as on mainnet
const BUYBACK_SLICE_CAP = 500_000n; // 0.5 USDG per slice, small against the stand-in pool's depth
const POOL_ETH = 2_400_000_000_000_000n; // 0.0024 ETH of depth in the ETH/USDG pool, inside +-2% of the price
const TRADER_ETH = 3_000_000_000_000_000n; // 0.003 ETH to the trader (pool depth plus a few small swaps)
const EARN_ETH = 500_000_000_000_000n; // 0.0005 ETH deposit into the ORRY/ETH hub
const EARN_USDG = 20_000_000n; // 20 USDG deposit into the ORRY/USDG hub
const MAX_SQRT = (1n << 160n) - 1n; // open price bounds: the development seed sets the price itself
const TREASURY_REVENUE = 20_000_000n; // 20 USDG of revenue, so the buyback has a reserve

const chain = defineChain({ id: 46630, name: "Robinhood Chain development network", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 1500 }) });
const key = (role: string) => (JSON.parse(readFileSync(join(homedir(), ".secrets/orrery", `46630-${role}.json`), "utf8")) as { privateKey: Hex }).privateKey;
const wallet = (role: string) => createWalletClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 1500 }), account: privateKeyToAccount(key(role)) }) as WalletClient & { account: Account };
const addr = (role: string) => privateKeyToAccount(key(role)).address;

const outDir = join(here, "../../deployments");
const statePath = join(outDir, "46630-full.json");
type State = { chainId: 46630; startBlock?: string; marketsStartBlock?: string; facilitatorStartBlock?: string; spentWei: string; done: string[]; a: Record<string, string>; coinExecutableAt?: string; agentId?: string };
const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { chainId: 46630, spentWei: "0", done: [], a: {} };
const save = () => {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
};
const A = (n: string) => state.a[n] as Address;

const addSpent = (gas: bigint, price: bigint) => (state.spentWei = (BigInt(state.spentWei) + gas * price).toString());
async function send(role: string, to: Address, abi: Abi, functionName: string, args: unknown[] = [], value?: bigint) {
  const w = wallet(role);
  const hash = await w.writeContract({ address: to, abi, functionName, args, value, chain, account: w.account } as never);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  addSpent(r.gasUsed, r.effectiveGasPrice);
  console.log(`  ${role} ${functionName} ${hash}`);
  return r;
}
async function deploy(name: string, abi: Abi, bytecode: Hex, args: unknown[] = []) {
  if (state.a[name]) return A(name);
  const w = wallet("deployer");
  const hash = await w.deployContract({ abi, bytecode, args, chain, account: w.account });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deployment reverted (${hash})`);
  addSpent(r.gasUsed, r.effectiveGasPrice);
  state.a[name] = r.contractAddress;
  save();
  console.log(`deployed ${name} ${r.contractAddress}`);
  return r.contractAddress;
}
/** Runs a named step once; a re-run skips the steps already done. */
async function step(name: string, fn: () => Promise<void>) {
  if (state.done.includes(name)) return;
  console.log(`- ${name}`);
  await fn();
  state.done.push(name);
  save();
}
const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) => pub.readContract({ address, abi, functionName, args }) as Promise<T>;

if ((await pub.getChainId()) !== 46630) throw new Error("not chain 46630");

// ------------------------------------------------------------------ --execute-coin (48 hours after proposeCoin)
if (EXECUTE_COIN) {
  const at = BigInt(state.coinExecutableAt ?? "0");
  const now = (await pub.getBlock()).timestamp;
  if (!at || now < at) {
    console.log(`The coin can be set from ${at ? new Date(Number(at) * 1000).toISOString() : "(no proposal yet)"}. Nothing was sent.`);
    process.exit(1);
  }
  await send("deployer", A("treasury"), rc.orreryTreasuryAbi as Abi, "executeCoin");
  console.log(`treasury orry ${await read<Address>(A("treasury"), rc.orreryTreasuryAbi as Abi, "orry")}, buyback ${await read<Address>(A("treasury"), rc.orreryTreasuryAbi as Abi, "buyback")}`);
  save();
  process.exit(0);
}

console.log(`chain 46630 at block ${await pub.getBlockNumber()} via ${RPC}`);
state.startBlock ??= (await pub.getBlockNumber()).toString();
save();

// ------------------------------------------------------------------ v1 with the treasury
await step("v1", async () => {
  await deploy("usdg", devUSDGAbi as Abi, v1.devUSDGBytecode, [addr("deployer")]);
  await deploy("attestor", orreryAttestorAbi as Abi, v1.orreryAttestorBytecode, [REGISTRY, A("usdg"), addr("deployer"), addr("deployer"), 5_000_000n]);
  await deploy("module", orreryPolicyModuleAbi as Abi, v1.orreryPolicyModuleBytecode, [REGISTRY, A("attestor"), PERMIT2, EP07, EP08, NO_ADAPTER]);
  await deploy("lens", orreryLensAbi as Abi, v1.orreryLensBytecode, [A("module"), A("attestor"), NO_ADAPTER, [], []]);
  await deploy("account", devAccount7579Abi as Abi, v1.devAccount7579Bytecode, [addr("operator")]);
});
await step("roles", async () => {
  await send("deployer", A("attestor"), orreryAttestorAbi as Abi, "setCheckSigner", [addr("check-signer"), true]);
  await send("deployer", A("attestor"), orreryAttestorAbi as Abi, "setAttester", [addr("attester"), true]);
});
await step("treasury", async () => {
  await deploy("treasury", rc.orreryTreasuryAbi as Abi, rc.orreryTreasuryBytecode, [A("usdg"), A("attestor"), addr("deployer"), OWNER_BPS, [addr("quote-signer")]]);
  await send("deployer", A("attestor"), orreryAttestorAbi as Abi, "setTreasury", [A("treasury")]);
});

// ------------------------------------------------------------------ ORRY with stand-ins
await step("coin", async () => {
  await deploy("orry", rc.mockOrryAbi as Abi, rc.mockOrryBytecode);
  await deploy("staking", rc.orryStakingAbi as Abi, rc.orryStakingBytecode, [A("orry"), REGISTRY, 7n * 86400n, 14n * 86400n, 7n * 86400n]);
});
await step("hook-buyback-router", async () => {
  // The hook (CREATE2 at a mined address carrying its permission bits), the buyback and the router reference each
  // other: the buyback and the router land at the deployer's next two CREATE nonces. A fresh feed is deployed first,
  // in this same step, because the hook's constructor needs one that answered within 25 hours.
  if (state.a.hook) throw new Error("hook exists but this step did not finish: check the buyback and router by hand before re-running");
  state.a.ethFeed = (await deployFresh("ethFeed", rc.mockFeedAbi as Abi, rc.mockFeedBytecode, [USDG_PER_ETH * 10n ** 8n])) as string;
  const deployer = addr("deployer");
  const nonce = await pub.getTransactionCount({ address: deployer, blockTag: "pending" });
  const buybackAt = getContractAddress({ from: deployer, nonce: BigInt(nonce + 1) });
  const routerAt = getContractAddress({ from: deployer, nonce: BigInt(nonce + 2) });
  const hookInit = encodeDeployData({
    abi: rc.orreryHookAbi as Abi,
    bytecode: rc.orreryHookBytecode,
    args: [POOL_MANAGER, A("orry"), routerAt, A("treasury"), 8500, 1500, 200, A("usdg"), A("ethFeed")],
  });
  const { salt, address: hookAt } = mineHookSalt(keccak256(hookInit));
  const w = wallet("deployer");
  const hookTx = await w.sendTransaction({ to: CREATE2_FACTORY, data: concat([salt, hookInit]), chain, account: w.account, nonce });
  const hr = await pub.waitForTransactionReceipt({ hash: hookTx, timeout: 180_000 });
  addSpent(hr.gasUsed, hr.effectiveGasPrice);
  if (hr.status !== "success" || !(await pub.getCode({ address: hookAt }))) throw new Error("hook deployment failed");
  state.a.hook = hookAt;
  save();
  console.log(`deployed hook ${hookAt}`);
  const usdgKey: PoolKey = { currency0: ZERO, currency1: A("usdg"), fee: 500, tickSpacing: 10, hooks: ZERO };
  await deploy("buyback", rc.orryBuybackAbi as Abi, rc.orryBuybackBytecode, [A("treasury"), routerAt, hookAt, A("usdg"), POOL_MANAGER, [usdgKey], BUYBACK_SLICE_CAP, 1000]);
  await deploy("router", rc.orryRewardsRouterAbi as Abi, rc.orryRewardsRouterBytecode, [A("orry"), A("staking"), A("buyback"), hookAt, 5000, 3600n]);
  if (!isAddressEqual(A("buyback"), buybackAt) || !isAddressEqual(A("router"), routerAt)) throw new Error("buyback or router address prediction failed");
});
async function deployFresh(name: string, abi: Abi, bytecode: Hex, args: unknown[]) {
  delete state.a[name];
  return deploy(name, abi, bytecode, args);
}
await step("earn", async () => {
  await deploy("earnFactory", rc.earnVaultFactoryAbi as Abi, rc.earnVaultFactoryBytecode, [A("hook")]);
  await send("deployer", A("earnFactory"), rc.earnVaultFactoryAbi as Abi, "createVault", [ZERO]);
  await send("deployer", A("earnFactory"), rc.earnVaultFactoryAbi as Abi, "createVault", [A("usdg")]);
  state.a.vault = await read<Address>(A("earnFactory"), rc.earnVaultFactoryAbi as Abi, "vaultOf", [ZERO]);
  state.a.vaultU = await read<Address>(A("earnFactory"), rc.earnVaultFactoryAbi as Abi, "vaultOf", [A("usdg")]);
  await deploy("claimAll", rc.claimAllAbi as Abi, rc.claimAllBytecode, [A("earnFactory"), A("staking")]);
  await deploy("orryLens", rc.orryLensAbi as Abi, rc.orryLensBytecode, [A("earnFactory"), A("staking")]);
});

// ------------------------------------------------------------------ pools: both hubs and the ETH/USDG pool
const usdgKey: PoolKey = { currency0: ZERO, currency1: A("usdg") ?? ZERO, fee: 500, tickSpacing: 10, hooks: ZERO };
const sqrtA = isqrt((USDG_PER_ETH * 10n ** 6n * 2n ** 192n) / 10n ** 18n); // USDG base units per wei
await step("pools", async () => {
  const hubKey = await read<PoolKey>(A("hook"), rc.orreryHookAbi as Abi, "hubKey", [ZERO]);
  const hubKeyU = await read<PoolKey>(A("hook"), rc.orreryHookAbi as Abi, "hubKey", [A("usdg")]);
  const pairU = await read<{ poolId: Hex; orryIsCurrency0: boolean }>(A("hook"), rc.orreryHookAbi as Abi, "pairOf", [A("usdg")]);
  await send("deployer", POOL_MANAGER, pmAbi as Abi, "initialize", [hubKey, HUB_SQRT_PRICE]);
  await send("deployer", POOL_MANAGER, pmAbi as Abi, "initialize", [usdgKey, sqrtA]);
  const sqrtU = pairU.orryIsCurrency0 ? (sqrtA * Q96) / HUB_SQRT_PRICE : (HUB_SQRT_PRICE * Q96) / sqrtA;
  await send("deployer", POOL_MANAGER, pmAbi as Abi, "initialize", [hubKeyU, sqrtU]);
  state.a.usdPoolId = poolIdOf(usdgKey);
});
await step("eth-usdg-depth", async () => {
  // Depth inside +-2% of the price: the same ETH buys about fifty times the depth of a full range.
  const trader = await deploy("trader", rc.hubActorAbi as Abi, rc.hubActorBytecode, [POOL_MANAGER]);
  const w = wallet("deployer");
  const h = await w.sendTransaction({ to: trader, value: TRADER_ETH, chain, account: w.account });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  addSpent(r.gasUsed, r.effectiveGasPrice);
  await send("deployer", A("usdg"), devUSDGAbi as Abi, "mint", [trader, 100_000n * 10n ** 6n]);
  await send("deployer", A("orry"), rc.mockOrryAbi as Abi, "transfer", [trader, 10n ** 24n]);
  const p = Number(sqrtA) / Number(Q96);
  const tick = Math.floor(Math.log(p * p) / Math.log(1.0001));
  const lower = Math.floor((tick - 200) / 10) * 10;
  const upper = Math.ceil((tick + 200) / 10) * 10;
  const pb = Math.sqrt(1.0001 ** upper);
  const liquidity = BigInt(Math.floor((Number(POOL_ETH) * p * pb) / (pb - p)));
  await send("deployer", trader, rc.hubActorAbi as Abi, "modify", [usdgKey, lower, upper, liquidity, pad("0x0", { size: 32 })]);
});

// ------------------------------------------------------------------ demo agent (as the 2026-11-07 rehearsal)
const registryAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);
await step("agent", async () => {
  for (const [to, amt] of [[A("account"), 1_000_000_000n], [addr("merchant"), 100_000_000n], [addr("operator"), 100_000_000n], [addr("walk"), 100_000_000n]] as const) {
    await send("deployer", A("usdg"), devUSDGAbi as Abi, "mint", [to, amt]);
  }
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
  state.agentId = agentId.toString();
  save();
  const registration = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Orrery demo agent",
    description: "Demo agent for trying Orrery on the development network.",
    services: [{ name: "web", endpoint: "https://orrery.tech/" }],
    registrations: [{ agentRegistry: `eip155:46630:${REGISTRY}`, agentId: Number(agentId) }],
  };
  await send("operator", REGISTRY, registryAbi as unknown as Abi, "setAgentURI", [agentId, `data:application/json;base64,${Buffer.from(JSON.stringify(registration)).toString("base64")}`]);
  const deadline = (await pub.getBlock()).timestamp + 240n;
  const digest = hashTypedData({
    domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: 46630, verifyingContract: REGISTRY },
    types: { AgentWalletSet: [{ name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "owner", type: "address" }, { name: "deadline", type: "uint256" }] },
    primaryType: "AgentWalletSet",
    message: { agentId, newWallet: A("account"), owner: addr("operator"), deadline },
  });
  await send("operator", REGISTRY, registryAbi as unknown as Abi, "setAgentWallet", [agentId, A("account"), deadline, await sign({ hash: digest, privateKey: key("operator"), to: "hex" })]);
  await send("operator", A("account"), devAccount7579Abi as Abi, "execute", [A("account"), 0n, encodeFunctionData({ abi: devAccount7579Abi, functionName: "installModule", args: [2n, A("module"), "0x"] })]);
  const now = (await pub.getBlock()).timestamp;
  const policy: Policy = { caps: [{ token: A("usdg"), perTx: 10_000_000n, perDay: 50_000_000n, floatMax: 20_000_000n }], targets: [], validUntil: now + 60n * 86400n, increaseDelay: 3600 };
  const consent = await signSessionConsent(privateKeyToAccount(key("agent-signer")), { chainId: 46630, module: A("module"), account: A("account"), agentId, policy });
  await send("operator", A("account"), devAccount7579Abi as Abi, "execute", [A("module"), 0n, operatorCalls.openSession(agentId, addr("agent-signer"), policy, consent)]);
  await send("operator", A("usdg"), devUSDGAbi as Abi, "approve", [A("attestor"), 5_000_000n]);
  await send("operator", A("attestor"), orreryAttestorAbi as Abi, "payVerification", [agentId, addr("operator"), 5_000_000n]);
  await send("agent-signer", A("module"), orreryPolicyModuleAbi as Abi, "topUp", [A("usdg"), 3_500_000n]);
});

// ------------------------------------------------------------------ ORRY seeding
await step("orry-holders", async () => {
  for (const role of ["operator", "walk"]) await send("deployer", A("orry"), rc.mockOrryAbi as Abi, "transfer", [addr(role), 10n ** 24n]); // 1,000,000 ORRY each
});
await step("earn-deposits", async () => {
  for (const spender of [A("vault"), A("vaultU")]) await send("deployer", A("orry"), rc.mockOrryAbi as Abi, "approve", [spender, 2n ** 256n - 1n]);
  await send("deployer", A("usdg"), devUSDGAbi as Abi, "mint", [addr("deployer"), 1_000n * 10n ** 6n]);
  await send("deployer", A("usdg"), devUSDGAbi as Abi, "approve", [A("vaultU"), 2n ** 256n - 1n]);
  const ts = (await pub.getBlock()).timestamp;
  // ORRY side at the opening prices plus 1%: 4,000,000 ORRY per ETH; ORRY per USDG = that / 2,235
  const orryForEth = (EARN_ETH * 4_000_000n * 101n) / 100n;
  const orryForUsdg = (EARN_USDG * 10n ** 12n * 4_000_000n * 101n) / (USDG_PER_ETH * 100n);
  await send("deployer", A("vault"), rc.earnVaultAbi as Abi, "deposit", [EARN_ETH, orryForEth, 0n, 0n, MAX_SQRT, ts + 900n], EARN_ETH);
  await send("deployer", A("vaultU"), rc.earnVaultAbi as Abi, "deposit", [EARN_USDG, orryForUsdg, 0n, 0n, MAX_SQRT, ts + 900n]);
});
await step("hub-swaps", async () => {
  const hubKey = await read<PoolKey>(A("hook"), rc.orreryHookAbi as Abi, "hubKey", [ZERO]);
  const hubKeyU = await read<PoolKey>(A("hook"), rc.orreryHookAbi as Abi, "hubKey", [A("usdg")]);
  const pairU = await read<{ orryIsCurrency0: boolean }>(A("hook"), rc.orreryHookAbi as Abi, "pairOf", [A("usdg")]);
  for (let i = 0; i < 4; i++) {
    const zeroForOne = i % 2 === 0; // ETH is currency0 in the ETH hub
    await send("deployer", A("trader"), rc.hubActorAbi as Abi, "swap", [hubKey, zeroForOne, -(zeroForOne ? 10_000_000_000_000n : 40n * 10n ** 18n)]);
    const sellUsdg = i % 2 === 0;
    await send("deployer", A("trader"), rc.hubActorAbi as Abi, "swap", [hubKeyU, sellUsdg !== pairU.orryIsCurrency0, -(sellUsdg ? 500_000n : 900n * 10n ** 18n)]);
  }
});
await step("treasury-revenue-and-coin", async () => {
  await send("deployer", A("usdg"), devUSDGAbi as Abi, "mint", [A("treasury"), TREASURY_REVENUE]);
  await send("deployer", A("treasury"), rc.orreryTreasuryAbi as Abi, "sync");
  const r = await send("deployer", A("treasury"), rc.orreryTreasuryAbi as Abi, "proposeCoin", [A("orry"), A("buyback")]);
  const ts = (await pub.getBlock({ blockNumber: r.blockNumber })).timestamp;
  state.coinExecutableAt = (ts + BigInt(await read<bigint>(A("treasury"), rc.orreryTreasuryAbi as Abi, "COIN_DELAY"))).toString();
});

// ------------------------------------------------------------------ wave R1 markets (Stocks, Private Swap, Dark Pool)
// 46630 has no Robinhood stock tokens and no Chainlink feeds: DevStockToken copies a 4663 stock's name and symbol (the
// web finds its official mark by symbol on a development network) and DevRoundFeed carries rounds that the dev-feeds
// process mirrors from the 4663 Chainlink feed, owned by the keeper key. Parameters are the spec's (ORRY-R1-SPEC 2.1,
// L2), with 26 h staleness as on mainnet.
const MAINNET_RPC = "https://robinhood-rpc.publicnode.com";
const STOCKS = [
  { key: "TSLA", token4663: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", feed4663: "0x4A1166a659A55625345e9515b32adECea5547C38" },
  { key: "AAPL", token4663: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", feed4663: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0" },
] as const;
const ETH_USD_4663 = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const mainnet = createPublicClient({ transport: http(MAINNET_RPC, { retryCount: 5, retryDelay: 1500 }) });
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)"]);
const tokenAbi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);
const answer4663 = async (feed: string) => (await mainnet.readContract({ address: feed as Address, abi: feedAbi, functionName: "latestRoundData" }))[1];
await step("markets-feeds", async () => {
  const eth = await deploy("devEthUsdFeed", rc.devRoundFeedAbi as Abi, rc.devRoundFeedBytecode, [8, "ETH / USD (mirror of 4663)", addr("keeper")]);
  await send("keeper", eth, rc.devRoundFeedAbi as Abi, "push", [await answer4663(ETH_USD_4663)]);
  for (const st of STOCKS) {
    const name = await mainnet.readContract({ address: st.token4663 as Address, abi: tokenAbi, functionName: "name" });
    const symbol = await mainnet.readContract({ address: st.token4663 as Address, abi: tokenAbi, functionName: "symbol" });
    await deploy(`stock${st.key}`, rc.devStockTokenAbi as Abi, rc.devStockTokenBytecode, [name, symbol, addr("deployer")]);
    const feed = await deploy(`feed${st.key}`, rc.devRoundFeedAbi as Abi, rc.devRoundFeedBytecode, [8, `${symbol} / USD (mirror of 4663)`, addr("keeper")]);
    await send("keeper", feed, rc.devRoundFeedAbi as Abi, "push", [await answer4663(st.feed4663)]);
  }
});
await step("markets", async () => {
  // the markets indexer starts here: before the factory, so it sees every MarketCreated
  state.marketsStartBlock ??= (await pub.getBlockNumber()).toString();
  save();
  const oracle = await deploy("orryPriceOracle", rc.orryPriceOracleAbi as Abi, rc.orryPriceOracleBytecode, [A("hook"), A("usdg"), A("devEthUsdFeed"), 93_600n]);
  const feeTiers = await deploy("feeTiers", rc.feeTiersAbi as Abi, rc.feeTiersBytecode, [A("staking"), oracle, [100_000_000n, 1_000_000_000n], [2500, 5000]]);
  const params = { commitSeconds: 240, revealSeconds: 60, feeBps: 15, minNotionalUsdg: 10_000_000n, maxStaleness: 93_600, commitFeeUsd: 50_000n, orryFeeDiscountBps: 2500, maxDeviationBps: 50 };
  const factory = await deploy("marketFactory", rc.marketFactoryAbi as Abi, rc.marketFactoryBytecode, [addr("deployer"), A("usdg"), A("treasury"), feeTiers, oracle, A("orry"), POOL_MANAGER, params]);
  const noPool = { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO };
  for (const st of STOCKS) {
    await send("deployer", factory, rc.marketFactoryAbi as Abi, "create", [A(`stock${st.key}`), A(`feed${st.key}`), noPool]);
    state.a[`market${st.key}`] = await read<Address>(factory, rc.marketFactoryAbi as Abi, "marketOf", [A(`stock${st.key}`)]);
  }
});
await step("markets-holders", async () => {
  // two traders so a batch can cross: the walk wallet and the operator each hold both stocks and USDG
  for (const role of ["walk", "operator"]) {
    for (const st of STOCKS) await send("deployer", A(`stock${st.key}`), rc.devStockTokenAbi as Abi, "mint", [addr(role), 5n * 10n ** 18n]);
    await send("deployer", A("usdg"), devUSDGAbi as Abi, "mint", [addr(role), 2_000n * 10n ** 6n]);
  }
});

// ------------------------------------------------------------------ wave 3 facilitator (as deploy-facilitator-4663.ts)
await step("facilitator", async () => {
  // the facilitator indexer starts here, before the factory, so it sees every SplitterCreated
  state.facilitatorStartBlock ??= (await pub.getBlockNumber()).toString();
  save();
  await deploy("splitterFactory", rc.merchantSplitterFactoryAbi as Abi, rc.merchantSplitterFactoryBytecode as Hex, [20, A("usdg"), A("orry"), A("treasury"), A("feeTiers")]);
  await deploy("x402Permit2Proxy", rc.x402Permit2ProxyAbi as Abi, rc.x402Permit2ProxyBytecode as Hex, [PERMIT2]);
});

// ------------------------------------------------------------------ records
const s = (role: string) => join(homedir(), ".secrets/orrery", `46630-${role}.json`);
mkdirSync(join(here, "../.local"), { recursive: true });
const api = {
  ORRERY_CHAIN_ID: "46630",
  ORRERY_RPC_URL: SERVER_RPC,
  ORRERY_MODULE: A("module"),
  ORRERY_ATTESTOR: A("attestor"),
  ORRERY_LENS: A("lens"),
  ORRERY_REGISTRY: REGISTRY,
  ORRERY_USDG: A("usdg"),
  ORRERY_USDG_NAME: await read<string>(A("usdg"), devUSDGAbi as Abi, "name"),
  ORRERY_TREASURY: A("treasury"),
  ORRERY_CONFIRMATIONS: "2",
  ORRERY_INDEXER_START_BLOCK: state.startBlock!,
  ORRERY_ORRY_TOKEN: A("orry"),
  ORRERY_ORRY_HOOK: A("hook"),
  ORRERY_ORRY_EARN_FACTORY: A("earnFactory"),
  ORRERY_ORRY_STAKING: A("staking"),
  ORRERY_ORRY_ROUTER: A("router"),
  ORRERY_ORRY_BUYBACK: A("buyback"),
  ORRERY_ORRY_LENS: A("orryLens"),
  ORRERY_ORRY_CLAIM_ALL: A("claimAll"),
  ORRERY_POOL_MANAGER: POOL_MANAGER,
  ORRERY_ORRY_USD_POOL_ID: state.a.usdPoolId!,
  ORRERY_ORRY_START_BLOCK: state.startBlock!,
  ORRERY_MARKET_FACTORY: A("marketFactory"),
  ORRERY_MARKETS_START_BLOCK: state.marketsStartBlock!,
  ORRERY_SPLITTER_FACTORY: A("splitterFactory"),
  ORRERY_X402_PERMIT2_PROXY: A("x402Permit2Proxy"),
  ORRERY_PERMIT2: PERMIT2,
  ORRERY_FACILITATOR_START_BLOCK: state.facilitatorStartBlock!,
  ORRERY_FEE_TIERS: A("feeTiers"),
  ORRERY_MULTICALL: MULTICALL3,
  // dev-feeds: each 46630 feed and the 4663 Chainlink feed it mirrors
  ORRERY_DEV_FEEDS: [`${A("devEthUsdFeed")}=${ETH_USD_4663}`, ...STOCKS.map((st) => `${A(`feed${st.key}`)}=${st.feed4663}`)].join(","),
};
writeFileSync(join(here, "../.local/api-46630-full.env"), Object.entries(api).map(([k, v]) => `${k}=${v}`).join("\n") + "\n" +
  ["relayer", "check-signer", "attester", "quote-signer"].map((r) => `# key file: ${s(r)}`).join("\n") + "\n");
const web = {
  NEXT_PUBLIC_CHAIN_ID: "46630",
  NEXT_PUBLIC_RPC_URL: RPC,
  NEXT_PUBLIC_MODULE: A("module"),
  NEXT_PUBLIC_ATTESTOR: A("attestor"),
  NEXT_PUBLIC_LENS: A("lens"),
  NEXT_PUBLIC_REGISTRY: REGISTRY,
  NEXT_PUBLIC_USDG: A("usdg"),
  NEXT_PUBLIC_ORRY_TOKEN: A("orry"),
  NEXT_PUBLIC_ORRY_EARN_FACTORY: A("earnFactory"),
  NEXT_PUBLIC_ORRY_EARN_VAULT: A("vault"),
  NEXT_PUBLIC_ORRY_STAKING: A("staking"),
  NEXT_PUBLIC_ORRY_CLAIM_ALL: A("claimAll"),
  NEXT_PUBLIC_ORRY_REWARDS_ROUTER: A("router"),
  NEXT_PUBLIC_ORRY_TREASURY: A("treasury"),
  NEXT_PUBLIC_MARKET_FACTORY: A("marketFactory"),
  NEXT_PUBLIC_SPLITTER_FACTORY: A("splitterFactory"),
};
writeFileSync(join(here, "../.local/web-46630-full.env"), Object.entries(web).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
save();
console.log(`spent ${formatEther(BigInt(state.spentWei))} ETH; coin can be set from ${state.coinExecutableAt ? new Date(Number(state.coinExecutableAt) * 1000).toISOString() : "?"}`);
console.log("wrote deployments/46630-full.json, services/.local/api-46630-full.env and web-46630-full.env");
