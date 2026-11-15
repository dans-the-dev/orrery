/**
 * The real ORRY contracts on a local anvil, wired as `contracts/test/orry/integration/OrrySystem.t.sol` wires them:
 * the live 4663 PoolManager runtime set at its own address, the hook at a flag address (a CREATE2 salt mined through
 * anvil's default deterministic deployer), the buyback and rewards router at predicted CREATE addresses, and the v1
 * contracts (registry, DevUSDG, OrreryAttestor, OrreryPolicyModule, OrreryLens) the treasury and the checks use.
 * Used by `orry.real.test.ts` and `scripts/dev-orry-stack.ts`. Anvil keys only (the standard test mnemonic).
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  http,
  isAddressEqual,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { devUSDGAbi, orreryAttestorAbi, orreryLensAbi, orreryPolicyModuleAbi, mockAccount7579Abi, mockIdentityRegistryAbi } from "@orrery/shared";
import { operatorCalls, signSessionConsent, type Policy } from "@orrery/sdk";
import { gasWithHeadroom } from "@orrery/server";
import * as v1 from "./generated/bytecode.js";
import * as rc from "./generated/orry.js";

export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
/** Accounts anvil is started with (`--accounts`); indexes 0 to 9 are the usual ones. */
export const ANVIL_ACCOUNTS = 20;
export const anvilKey = (i: number): Hex => toHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).getHdKey().privateKey!);

/** Anvil key index of every role. 1, 2, 5 and 6 match the API's own 31337 defaults (check signer, attester, quote signer, keeper). */
export const ROLE = {
  deployer: 0, // contracts, DevUSDG and attestor owner, treasury owner, API relayer
  checkSigner: 1,
  attester: 2,
  operator: 3, // owner of agent 1, stakes behind it
  agentOwner2: 4, // owner of agent 2, verified with ORRY
  quoteSigner: 5,
  keeper: 6,
  alice: 7, // Earn only
  bob: 8, // Earn and plain stake
  carol: 9, // plain stake only, buys checks with ORRY
  sessionSigner: 10, // agent 1's session signer
} as const;

export const POOL_MANAGER = rc.poolManagerAddress as Address;
export const CREATE2_FACTORY: Address = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const Q96 = 2n ** 96n;
/** 4,000,000 ORRY per ETH, as in OrrySystem.t.sol. */
export const HUB_SQRT_PRICE = 2000n * Q96;
/** About 2,235 USDG per ETH. */
export const USDG_PER_ETH = 2235n;
const HOOK_FLAGS = 0x10c4n;
export const FULL_RANGE_10 = [-887270, 887270] as const;

export const pmAbi = parseAbi([
  "function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24 tick)",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
]);

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}
export const poolIdOf = (k: PoolKey): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));

export type Wallet = WalletClient & { account: Account };

export interface OrrySystem {
  rpc: string;
  pub: PublicClient;
  wallet: (role: number) => Wallet;
  address: (role: number) => Address;
  startBlock: bigint;
  // v1
  registry: Address;
  usdg: Address;
  attestor: Address;
  module: Address;
  orreryLens: Address;
  account: Address;
  agentId: bigint;
  agentId2: bigint;
  // ORRY
  token: Address;
  staking: Address;
  treasury: Address;
  hook: Address;
  buyback: Address;
  router: Address;
  /** Earn vaults from the factory: the ORRY/ETH hub's and the ORRY/USDG hub's. */
  vault: Address;
  vaultU: Address;
  earnFactory: Address;
  ethFeed: Address;
  claimAll: Address;
  lens: Address;
  trader: Address;
  hubKey: PoolKey;
  hubKeyU: PoolKey;
  /** ORRY is currency0 of the ORRY/USDG hub (its address sorts below USDG's). */
  usdgHubOrryFirst: boolean;
  usdgKey: PoolKey;
  hubPoolId: Hex;
  usdgHubPoolId: Hex;
  usdPoolId: Hex;
}

/** Starts anvil on 127.0.0.1:`port` with the test mnemonic's first `ANVIL_ACCOUNTS` accounts; resolves once it answers. */
export async function startAnvil(port: number, extraArgs: string[] = []): Promise<ChildProcess> {
  const child = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--accounts", String(ANVIL_ACCOUNTS), "--silent", ...extraArgs], { stdio: "ignore" });
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const ok = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    }).then((r) => r.ok, () => false);
    if (ok) return child;
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGTERM");
  throw new Error(`anvil did not start on port ${port}`);
}

export function clients(rpc: string) {
  const pub = createPublicClient({ chain: foundry, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
  const wallets = new Map<number, Wallet>();
  const wallet = (role: number): Wallet => {
    let w = wallets.get(role);
    if (!w) {
      w = createWalletClient({ chain: foundry, transport: http(rpc), account: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: role }) }) as Wallet;
      wallets.set(role, w);
    }
    return w;
  };
  return { pub, wallet, address: (role: number) => wallet(role).account.address };
}

/** Sends one call and waits for it; throws (with the decoded revert from the estimate) if it would fail. */
export async function send(sys: Pick<OrrySystem, "pub" | "wallet">, role: number, address: Address, abi: Abi, functionName: string, args: unknown[] = [], value?: bigint) {
  const w = sys.wallet(role);
  // the keeper's headroom (keeper.ts): an exact estimate runs out of gas when the tx lands in a later second
  const gas = gasWithHeadroom(await sys.pub.estimateContractGas({ address, abi, functionName, args, value, account: w.account } as never));
  const hash = await w.writeContract({ address, abi, functionName, args, value, gas, chain: foundry, account: w.account } as never);
  const r = await sys.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
  return r;
}

async function deploy(sys: Pick<OrrySystem, "pub" | "wallet">, abi: Abi, bytecode: Hex, args: unknown[] = []): Promise<Address> {
  const w = sys.wallet(ROLE.deployer);
  const hash = await w.deployContract({ abi, bytecode, args, chain: foundry, account: w.account });
  const r = await sys.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deployment reverted in ${hash}`);
  return r.contractAddress;
}

export const rpcCall = (sys: Pick<OrrySystem, "pub">, method: string, params: unknown[]) => sys.pub.request({ method: method as never, params: params as never });
/** Moves chain time forward by `seconds` and mines one block. */
export async function warp(sys: Pick<OrrySystem, "pub">, seconds: number | bigint) {
  await rpcCall(sys, "evm_increaseTime", [toHex(BigInt(seconds))]);
  await rpcCall(sys, "evm_mine", []);
}
export const mine = (sys: Pick<OrrySystem, "pub">, blocks = 1) => rpcCall(sys, "anvil_mine", [toHex(blocks)]);

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** A CREATE2 salt whose address carries exactly the hook's permission bits in its low 14 bits. */
export function mineHookSalt(initCodeHash: Hex): { salt: Hex; address: Address } {
  for (let i = 0n; ; i++) {
    const salt = pad(toHex(i), { size: 32 });
    const address = getContractAddress({ opcode: "CREATE2", from: CREATE2_FACTORY, salt, bytecodeHash: initCodeHash });
    if ((BigInt(address) & 0x3fffn) === HOOK_FLAGS) return { salt, address };
  }
}

/** Deploys v1 and every ORRY contract, initializes the hub and an ETH/USDG pool with full-range depth, and opens agent 1's session. */
export async function deployOrrySystem(rpc: string): Promise<OrrySystem> {
  const c = clients(rpc);
  const s = { ...c, rpc } as OrrySystem;
  const deployer = c.address(ROLE.deployer);
  s.startBlock = await c.pub.getBlockNumber();

  await rpcCall(s, "anvil_setCode", [POOL_MANAGER, rc.poolManagerRuntime]);

  // v1, as scripts/seed-local.ts deploys it
  s.registry = await deploy(s, mockIdentityRegistryAbi as Abi, v1.mockIdentityRegistryBytecode);
  s.usdg = await deploy(s, devUSDGAbi as Abi, v1.devUSDGBytecode, [deployer]);
  s.attestor = await deploy(s, orreryAttestorAbi as Abi, v1.orreryAttestorBytecode, [s.registry, s.usdg, deployer, deployer, 5_000_000n]);
  const adapter: Address = "0x7579EE8307284F293B1927136486880611F20002";
  s.module = await deploy(s, orreryPolicyModuleAbi as Abi, v1.orreryPolicyModuleBytecode, [
    s.registry, s.attestor, "0x000000000022D473030F116dDEE9F6B43aC78BA3", "0x0000000071727De22E5E9d8BAf0edAc6f37da032", "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108", adapter,
  ]);
  s.orreryLens = await deploy(s, orreryLensAbi as Abi, v1.orreryLensBytecode, [s.module, s.attestor, adapter, [], []]);
  s.account = await deploy(s, mockAccount7579Abi as Abi, v1.mockAccount7579Bytecode, [c.address(ROLE.operator)]);
  await send(s, ROLE.deployer, s.attestor, orreryAttestorAbi as Abi, "setCheckSigner", [c.address(ROLE.checkSigner), true]);
  await send(s, ROLE.deployer, s.attestor, orreryAttestorAbi as Abi, "setAttester", [c.address(ROLE.attester), true]);

  // ORRY: coin, staking, treasury (wired as the attestor's treasury)
  s.token = await deploy(s, rc.mockOrryAbi as Abi, rc.mockOrryBytecode);
  s.staking = await deploy(s, rc.orryStakingAbi as Abi, rc.orryStakingBytecode, [s.token, s.registry, 7n * 86400n, 14n * 86400n, 7n * 86400n]);
  s.treasury = await deploy(s, rc.orreryTreasuryAbi as Abi, rc.orreryTreasuryBytecode, [s.usdg, s.attestor, deployer, 1000, [c.address(ROLE.quoteSigner)]]);
  await send(s, ROLE.deployer, s.attestor, orreryAttestorAbi as Abi, "setTreasury", [s.treasury]);

  // the Chainlink ETH/USD feed the hook checks for the ETH pair (a stand-in answering 2,235 USD, 8 decimals)
  s.ethFeed = await deploy(s, rc.mockFeedAbi as Abi, rc.mockFeedBytecode, [USDG_PER_ETH * 10n ** 8n]);

  // hook (CREATE2 at a flag address), buyback and router (next two CREATE nonces) reference each other
  const nonce = await c.pub.getTransactionCount({ address: deployer, blockTag: "pending" });
  const buybackAt = getContractAddress({ from: deployer, nonce: BigInt(nonce + 1) });
  const routerAt = getContractAddress({ from: deployer, nonce: BigInt(nonce + 2) });
  // multi-pair hook (R-35): launch pairs ORRY/ETH (feed checked) and ORRY/USDG registered by the constructor
  const hookInit = encodeDeployData({
    abi: rc.orreryHookAbi as Abi,
    bytecode: rc.orreryHookBytecode,
    args: [POOL_MANAGER, s.token, routerAt, s.treasury, 8500, 1500, 200, s.usdg, s.ethFeed],
  });
  const { salt, address: hookAt } = mineHookSalt(keccak256(hookInit));
  const d = c.wallet(ROLE.deployer);
  const hookTx = await d.sendTransaction({ to: CREATE2_FACTORY, data: concat([salt, hookInit]), chain: foundry, account: d.account });
  if ((await c.pub.waitForTransactionReceipt({ hash: hookTx })).status !== "success") throw new Error("hook deployment reverted");
  if (!(await c.pub.getCode({ address: hookAt }))) throw new Error("hook not at its mined address");
  s.hook = hookAt;
  s.usdgKey = { currency0: ZERO, currency1: s.usdg, fee: 500, tickSpacing: 10, hooks: ZERO };
  // B-1: cashback 10% of what the buyback buys, paid only once the treasury owner sets a sink (unset here)
  s.buyback = await deploy(s, rc.orryBuybackAbi as Abi, rc.orryBuybackBytecode, [s.treasury, routerAt, hookAt, s.usdg, POOL_MANAGER, [s.usdgKey], 1_000_000_000n, 1000]);
  s.router = await deploy(s, rc.orryRewardsRouterAbi as Abi, rc.orryRewardsRouterBytecode, [s.token, s.staking, s.buyback, hookAt, 5000, 3600n]);
  if (!isAddressEqual(s.buyback, buybackAt) || !isAddressEqual(s.router, routerAt)) throw new Error("buyback or router address prediction failed");
  // one Earn vault per hub, created by the factory (anyone may, once the hook lists the pair)
  s.earnFactory = await deploy(s, rc.earnVaultFactoryAbi as Abi, rc.earnVaultFactoryBytecode, [s.hook]);
  await send(s, ROLE.deployer, s.earnFactory, rc.earnVaultFactoryAbi as Abi, "createVault", [ZERO]);
  await send(s, ROLE.deployer, s.earnFactory, rc.earnVaultFactoryAbi as Abi, "createVault", [s.usdg]);
  s.vault = (await c.pub.readContract({ address: s.earnFactory, abi: rc.earnVaultFactoryAbi as Abi, functionName: "vaultOf", args: [ZERO] })) as Address;
  s.vaultU = (await c.pub.readContract({ address: s.earnFactory, abi: rc.earnVaultFactoryAbi as Abi, functionName: "vaultOf", args: [s.usdg] })) as Address;
  s.claimAll = await deploy(s, rc.claimAllAbi as Abi, rc.claimAllBytecode, [s.earnFactory, s.staking]);
  s.lens = await deploy(s, rc.orryLensAbi as Abi, rc.orryLensBytecode, [s.earnFactory, s.staking]);

  // pools: the hub through the hook, and a hookless ETH/USDG pool for the buyback's hop 1 and the API's USD price
  const hookRead = (functionName: string, args: unknown[]) => c.pub.readContract({ address: s.hook, abi: rc.orreryHookAbi as Abi, functionName, args }) as Promise<unknown>;
  s.hubKey = (await hookRead("hubKey", [ZERO])) as PoolKey;
  s.hubKeyU = (await hookRead("hubKey", [s.usdg])) as PoolKey;
  const pairU = (await hookRead("pairOf", [s.usdg])) as { poolId: Hex; orryIsCurrency0: boolean };
  s.hubPoolId = ((await hookRead("pairOf", [ZERO])) as { poolId: Hex }).poolId;
  s.usdgHubPoolId = pairU.poolId;
  s.usdgHubOrryFirst = pairU.orryIsCurrency0;
  s.usdPoolId = poolIdOf(s.usdgKey);
  await send(s, ROLE.deployer, POOL_MANAGER, pmAbi as Abi, "initialize", [s.hubKey, HUB_SQRT_PRICE]);
  const sqrtA = isqrt((USDG_PER_ETH * 10n ** 6n * 2n ** 192n) / 10n ** 18n); // USDG per wei
  await send(s, ROLE.deployer, POOL_MANAGER, pmAbi as Abi, "initialize", [s.usdgKey, sqrtA]);
  // ORRY/USDG at the same ORRY price: ORRY per USDG = (ORRY per ETH) / (USDG per ETH), oriented by currency order
  const sqrtU = s.usdgHubOrryFirst ? (sqrtA * Q96) / HUB_SQRT_PRICE : (HUB_SQRT_PRICE * Q96) / sqrtA;
  await send(s, ROLE.deployer, POOL_MANAGER, pmAbi as Abi, "initialize", [s.hubKeyU, sqrtU]);

  // a trader with depth on the ETH/USDG pool (about 1,000 ETH and 2.2 M USDG, full range)
  s.trader = await deploy(s, rc.hubActorAbi as Abi, rc.hubActorBytecode, [POOL_MANAGER]);
  await d.sendTransaction({ to: s.trader, value: 3_000n * 10n ** 18n, chain: foundry, account: d.account }).then((h) => c.pub.waitForTransactionReceipt({ hash: h }));
  await send(s, ROLE.deployer, s.usdg, devUSDGAbi as Abi, "mint", [s.trader, 10_000_000n * 10n ** 6n]);
  await send(s, ROLE.deployer, s.token, rc.mockOrryAbi as Abi, "transfer", [s.trader, 10n ** 26n]);
  await send(s, ROLE.deployer, s.trader, rc.hubActorAbi as Abi, "modify", [s.usdgKey, FULL_RANGE_10[0], FULL_RANGE_10[1], 47_000_000_000_000_000n, pad("0x0", { size: 32 })]);

  // people hold ORRY and approve the vault, staking and the treasury
  for (const role of [ROLE.operator, ROLE.agentOwner2, ROLE.alice, ROLE.bob, ROLE.carol]) {
    await send(s, ROLE.deployer, s.token, rc.mockOrryAbi as Abi, "transfer", [c.address(role), 16n * 10n ** 25n]);
    await send(s, ROLE.deployer, s.usdg, devUSDGAbi as Abi, "mint", [c.address(role), 1_000_000n * 10n ** 6n]);
    for (const spender of [s.vault, s.vaultU, s.staking, s.treasury]) {
      await send(s, role, s.token, rc.mockOrryAbi as Abi, "approve", [spender, 2n ** 256n - 1n]);
    }
    await send(s, role, s.usdg, devUSDGAbi as Abi, "approve", [s.vaultU, 2n ** 256n - 1n]);
  }

  // agent 1 (operator) with a smart account, the module and a session; agent 2 (agentOwner2) bare
  await send(s, ROLE.operator, s.registry, mockIdentityRegistryAbi as Abi, "register", [c.address(ROLE.operator)]);
  s.agentId = 1n;
  await send(s, ROLE.operator, s.registry, mockIdentityRegistryAbi as Abi, "setAgentWallet", [s.agentId, s.account]);
  const viaAccount = (target: Address, data: Hex) => send(s, ROLE.operator, s.account, mockAccount7579Abi as Abi, "execute", [target, 0n, data]);
  await viaAccount(s.account, encodeFunctionData({ abi: mockAccount7579Abi, functionName: "installModule", args: [2n, s.module, "0x"] }));
  await send(s, ROLE.deployer, s.usdg, devUSDGAbi as Abi, "mint", [s.account, 1_000_000_000n]);
  const now = (await c.pub.getBlock()).timestamp;
  const policy: Policy = { caps: [{ token: s.usdg, perTx: 10_000_000n, perDay: 50_000_000n, floatMax: 20_000_000n }], targets: [], validUntil: now + 365n * 86400n, increaseDelay: 3600 };
  const signer = c.wallet(ROLE.sessionSigner).account;
  const consent = await signSessionConsent(signer, { chainId: 31337, module: s.module, account: s.account, agentId: s.agentId, policy });
  await viaAccount(s.module, operatorCalls.openSession(s.agentId, signer.address, policy, consent));
  await send(s, ROLE.agentOwner2, s.registry, mockIdentityRegistryAbi as Abi, "register", [c.address(ROLE.agentOwner2)]);
  s.agentId2 = 2n;
  return s;
}

/** ORRY base units worth `eth` at the hub's current slot0 price (read with PoolManager `extsload`). */
export async function orryForEth(sys: OrrySystem, eth: bigint): Promise<bigint> {
  const word = (await sys.pub.readContract({
    address: POOL_MANAGER,
    abi: parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]),
    functionName: "extsload",
    args: [keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [sys.hubPoolId, 6n]))],
  })) as Hex;
  const sqrt = BigInt(word) & ((1n << 160n) - 1n);
  return (((eth * sqrt) / Q96) * sqrt) / Q96;
}

/** A balanced Earn deposit of `eth` (ORRY side at the current hub price plus 1%). */
export async function deposit(sys: OrrySystem, role: number, eth: bigint) {
  const r = await orryForEth(sys, eth);
  const ts = (await sys.pub.getBlock()).timestamp;
  return send(sys, role, sys.vault, rc.earnVaultAbi as Abi, "deposit", [eth, (r * 101n) / 100n, 0n, 0n, (1n << 160n) - 1n, ts + 600n], eth);
}

/** ORRY base units worth `usdg` USDG base units at the ORRY/USDG hub's current price. */
export async function orryForUsdg(sys: OrrySystem, usdg: bigint): Promise<bigint> {
  const word = (await sys.pub.readContract({
    address: POOL_MANAGER,
    abi: parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]),
    functionName: "extsload",
    args: [keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [sys.usdgHubPoolId, 6n]))],
  })) as Hex;
  const sqrt = BigInt(word) & ((1n << 160n) - 1n);
  return sys.usdgHubOrryFirst ? (((usdg * Q96) / sqrt) * Q96) / sqrt : (((usdg * sqrt) / Q96) * sqrt) / Q96;
}

/** A balanced deposit of `usdg` USDG into the ORRY/USDG vault (ORRY side at the hub price plus 1%). */
export async function depositUsdg(sys: OrrySystem, role: number, usdg: bigint) {
  const r = await orryForUsdg(sys, usdg);
  const ts = (await sys.pub.getBlock()).timestamp;
  return send(sys, role, sys.vaultU, rc.earnVaultAbi as Abi, "deposit", [usdg, (r * 101n) / 100n, 0n, 0n, (1n << 160n) - 1n, ts + 600n]);
}

/** Alternating swaps in the ORRY/USDG hub by the trader: `usdgIn` USDG in, then `orryIn` ORRY in. */
export async function usdgHubSwaps(sys: OrrySystem, n: number, usdgIn = 500n * 10n ** 6n, orryIn = 900_000n * 10n ** 18n) {
  for (let i = 0; i < n; i++) {
    const sellUsdg = i % 2 === 0;
    // zeroForOne sells currency0: USDG is currency0 exactly when ORRY is not
    await send(sys, ROLE.deployer, sys.trader, rc.hubActorAbi as Abi, "swap", [sys.hubKeyU, sellUsdg !== sys.usdgHubOrryFirst, -(sellUsdg ? usdgIn : orryIn)]);
  }
}

/** Alternating hub swaps by the trader, one per block: 1 ETH in, then 4,000,000 ORRY in. */
export async function hubSwaps(sys: OrrySystem, n: number, ethIn = 10n ** 18n, orryIn = 4_000_000n * 10n ** 18n) {
  for (let i = 0; i < n; i++) {
    const zeroForOne = i % 2 === 0;
    await send(sys, ROLE.deployer, sys.trader, rc.hubActorAbi as Abi, "swap", [sys.hubKey, zeroForOne, -(zeroForOne ? ethIn : orryIn)]);
  }
}

/** Coinless revenue, then the coin: USDG to the treasury, sync, proposeCoin, 48 hours, executeCoin. */
export async function setCoin(sys: OrrySystem, usdgRevenue = 100_000n * 10n ** 6n) {
  await send(sys, ROLE.deployer, sys.usdg, devUSDGAbi as Abi, "mint", [sys.treasury, usdgRevenue]);
  await send(sys, ROLE.deployer, sys.treasury, rc.orreryTreasuryAbi as Abi, "sync");
  await send(sys, ROLE.deployer, sys.treasury, rc.orreryTreasuryAbi as Abi, "proposeCoin", [sys.token, sys.buyback]);
  await warp(sys, 48 * 3600);
  await send(sys, ROLE.deployer, sys.treasury, rc.orreryTreasuryAbi as Abi, "executeCoin");
}

/** The API's environment for this system (31337 defaults supply the anvil role keys). */
export function apiEnv(sys: OrrySystem, databaseUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ORRERY_CHAIN_ID: "31337",
    ORRERY_RPC_URL: sys.rpc,
    ORRERY_DATABASE_URL: databaseUrl,
    ORRERY_MODULE: sys.module,
    ORRERY_ATTESTOR: sys.attestor,
    ORRERY_LENS: sys.orreryLens,
    ORRERY_REGISTRY: sys.registry,
    ORRERY_USDG: sys.usdg,
    ORRERY_TREASURY: sys.treasury,
    ORRERY_INDEXER_START_BLOCK: sys.startBlock.toString(),
    ORRERY_ORRY_TOKEN: sys.token,
    ORRERY_ORRY_HOOK: sys.hook,
    ORRERY_ORRY_EARN_FACTORY: sys.earnFactory,
    ORRERY_ORRY_STAKING: sys.staking,
    ORRERY_ORRY_ROUTER: sys.router,
    ORRERY_ORRY_BUYBACK: sys.buyback,
    ORRERY_ORRY_LENS: sys.lens,
    ORRERY_ORRY_CLAIM_ALL: sys.claimAll,
    ORRERY_POOL_MANAGER: POOL_MANAGER,
    ORRERY_ORRY_USD_POOL_ID: sys.usdPoolId,
    ORRERY_ORRY_START_BLOCK: sys.startBlock.toString(),
    ...extra,
  };
}
