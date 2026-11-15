/**
 * Lane L5 local stack (development and test only) and the deploy helpers the 4663 plan reuses: the CREATE2 salt miner for
 * the spoke hook's permission bits, and the two-step deployment (hook through the CREATE2 factory with the predicted
 * AgentLaunch address, then AgentLaunch at that address).
 *
 *   pnpm tsx scripts/launch-stack.ts --rpc http://127.0.0.1:18680 --out /path/launch-stack.json
 *
 * The local stack: the 4663 PoolManager runtime at its own address, a stand-in ORRY, the real `OrryStaking`, stand-ins
 * for the ERC-8004 registry, the attestor, the policy module, the ORRY price (100 ORRY = 1 USD), the Earn vault and the
 * treasury, a v4 swap router, and a verified agent with a bound wallet, a 200 USD stake locked 91 days and a staker with a
 * 300 USD plain stake. Used by test/launch.integration.test.ts and the local walk. Never run against 4663 or 46630.
 */
import { writeFileSync } from "node:fs";
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getContractAddress,
  http,
  keccak256,
  pad,
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
import * as g from "./launch-generated.js";
import { poolManagerAddress, poolManagerRuntime } from "../test/generated/orry.js";

const MNEMONIC = "test test test test test test test test test test test junk";
export const LAUNCH_ROLE = { deployer: 0, owner: 1, alice: 11, bob: 12, carol: 13, aliceWallet: 14 } as const;
/** v4 permission bits of `SpokeHook` (beforeInitialize, beforeAddLiquidity, beforeSwap, afterSwap, both return deltas). */
export const SPOKE_HOOK_BITS = 0x28ccn;
const HOOK_MASK = 0x3fffn;
/** The deterministic deployer every EVM chain shares (Arachnid), present on anvil and on 4663. */
export const CREATE2_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c" as Address;
const E18 = 10n ** 18n;

/** Spec defaults (`docs/updates/L5-LAUNCH-SPEC.md` 9): constructor values, all owner questions. */
export const LAUNCH_DEFAULTS = {
  hook: { startFeePips: 800_000, decayWindow: 60, earlyWindow: 600 },
  params: { startTick: 25_000, maxFirstBuyBps: 500, minStakeUsd: 100_000_000n, earlyMaxBps: 50, earlyFullUsd: 1_000_000_000n, earlyMinUsd: 10_000_000n },
} as const;

export interface HookArgs {
  poolManager: Address;
  orry: Address;
  launch: Address;
  startFeePips: number;
  decayWindow: number;
  earlyWindow: number;
}

/** Creation code plus constructor arguments of `SpokeHook`. */
export function spokeHookInitCode(a: HookArgs): Hex {
  const args = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint24" }, { type: "uint32" }, { type: "uint32" }],
    [a.poolManager, a.orry, a.launch, a.startFeePips, a.decayWindow, a.earlyWindow],
  );
  return concat([g.spokeHookBytecode, args]);
}

/** The first salt from `start` whose CREATE2 address through `factory` carries exactly the spoke hook's bits (one in 16,384). */
export function mineSpokeHookSalt(initCode: Hex, factory: Address = CREATE2_FACTORY, start = 0n, tries = 2_000_000n): { salt: Hex; address: Address } {
  const bytecodeHash = keccak256(initCode);
  for (let i = start; i < start + tries; i++) {
    const salt = pad(toHex(i), { size: 32 });
    const address = getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecodeHash });
    if ((BigInt(address) & HOOK_MASK) === SPOKE_HOOK_BITS) return { salt, address };
  }
  throw new Error("no salt found");
}

type Wallet = WalletClient & { account: Account };

export function launchClients(rpc: string) {
  const pub = createPublicClient({ chain: foundry, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
  const wallets = new Map<number, Wallet>();
  const wallet = (i: number): Wallet => {
    let w = wallets.get(i);
    if (!w) {
      w = createWalletClient({ chain: foundry, transport: http(rpc), account: mnemonicToAccount(MNEMONIC, { addressIndex: i }) }) as Wallet;
      wallets.set(i, w);
    }
    return w;
  };
  return { pub, wallet, address: (i: number) => wallet(i).account.address };
}

export interface LaunchStack {
  rpc: string;
  chainId: number;
  startBlock: string;
  poolManager: Address;
  orry: Address;
  registry: Address;
  attestor: Address;
  module: Address;
  staking: Address;
  price: Address;
  vault: Address;
  treasury: Address;
  hook: Address;
  hookSalt: Hex;
  agentLaunch: Address;
  spokeRouter: Address;
  swapRouter: Address;
  agentId: string;
  accounts: Record<keyof typeof LAUNCH_ROLE, Address>;
}

export async function deployLaunchStack(rpc: string): Promise<LaunchStack> {
  const c = launchClients(rpc);
  const d = c.wallet(LAUNCH_ROLE.deployer);
  const deploy = async (abi: Abi, bytecode: Hex, args: readonly unknown[] = []): Promise<Address> => {
    const hash = await d.deployContract({ abi, bytecode, args, chain: foundry, account: d.account } as never);
    const r = await c.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error("deployment reverted");
    return r.contractAddress;
  };
  const send = async (role: number, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => {
    const w = c.wallet(role);
    const hash = await w.writeContract({ address, abi, functionName, args, chain: foundry, account: w.account } as never);
    const r = await c.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return r;
  };
  const startBlock = await c.pub.getBlockNumber();
  await c.pub.request({ method: "anvil_setCode" as never, params: [poolManagerAddress, poolManagerRuntime] as never });
  const pm = poolManagerAddress as Address;
  const deployer = c.address(LAUNCH_ROLE.deployer);

  const orry = await deploy(g.mockOrryAbi as Abi, g.mockOrryBytecode, [deployer, 10n ** 30n]);
  const registry = await deploy(g.mockIdentityRegistryAbi as Abi, g.mockIdentityRegistryBytecode);
  const attestor = await deploy(g.mockAttestorL5Abi as Abi, g.mockAttestorL5Bytecode);
  const module = await deploy(g.mockPolicyModuleL5Abi as Abi, g.mockPolicyModuleL5Bytecode);
  const price = await deploy(g.mockOrryPriceAbi as Abi, g.mockOrryPriceBytecode);
  const vault = await deploy(g.mockEarnVaultL5Abi as Abi, g.mockEarnVaultL5Bytecode, [orry]);
  const treasury = await deploy(g.mockTreasuryL5Abi as Abi, g.mockTreasuryL5Bytecode, [c.address(LAUNCH_ROLE.owner)]);
  const staking = await deploy(g.orryStakingAbi as Abi, g.orryStakingBytecode, [orry, registry, 7n * 86_400n, 14n * 86_400n, 7n * 86_400n]);
  const swapRouter = await deploy(g.poolSwapTestAbi as Abi, g.poolSwapTestBytecode, [pm]);

  const { hook, agentLaunch, hookSalt } = await deployLaunchPair(c.pub, d, {
    poolManager: pm,
    orry,
    registry,
    attestor,
    module,
    staking,
    price,
    vault,
    treasury,
  });

  const spokeRouter = await deploy(g.spokeRouterAbi as Abi, g.spokeRouterBytecode, [agentLaunch]);

  // people: ORRY, approvals, the agent of alice (wallet = account 14) and a staker
  for (const role of [LAUNCH_ROLE.alice, LAUNCH_ROLE.bob, LAUNCH_ROLE.carol]) {
    await send(LAUNCH_ROLE.deployer, orry, g.mockOrryAbi as Abi, "transfer", [c.address(role), 50_000_000n * E18]);
    for (const spender of [staking, swapRouter]) {
      await send(role, orry, g.mockOrryAbi as Abi, "approve", [spender, (1n << 256n) - 1n]);
    }
  }
  const alice = c.address(LAUNCH_ROLE.alice);
  const aliceWallet = c.address(LAUNCH_ROLE.aliceWallet);
  await send(LAUNCH_ROLE.deployer, registry, g.mockIdentityRegistryAbi as Abi, "register", [alice]);
  const agentId = 1n;
  await send(LAUNCH_ROLE.alice, registry, g.mockIdentityRegistryAbi as Abi, "setAgentWallet", [agentId, aliceWallet]);
  await send(LAUNCH_ROLE.deployer, attestor, g.mockAttestorL5Abi as Abi, "setVerified", [agentId, true]);
  await send(LAUNCH_ROLE.deployer, module, g.mockPolicyModuleL5Abi as Abi, "setInstalled", [aliceWallet, true]);
  await send(LAUNCH_ROLE.alice, staking, g.orryStakingAbi as Abi, "stakeForAgent", [agentId, 20_000n * E18]);
  const now = (await c.pub.getBlock()).timestamp;
  await send(LAUNCH_ROLE.alice, staking, g.orryStakingAbi as Abi, "extendAgentLock", [agentId, now + 91n * 86_400n]);
  await send(LAUNCH_ROLE.bob, staking, g.orryStakingAbi as Abi, "stake", [30_000n * E18]);

  return {
    rpc,
    chainId: 31337,
    startBlock: startBlock.toString(),
    poolManager: pm,
    orry,
    registry,
    attestor,
    module,
    staking,
    price,
    vault,
    treasury,
    hook,
    hookSalt,
    agentLaunch,
    spokeRouter,
    swapRouter,
    agentId: agentId.toString(),
    accounts: Object.fromEntries(Object.entries(LAUNCH_ROLE).map(([k, i]) => [k, c.address(i)])) as Record<keyof typeof LAUNCH_ROLE, Address>,
  };
}

/**
 * Deploys the L5 pair from `wallet`: `SpokeHook` through the CREATE2 factory at a mined salt, with the AgentLaunch address
 * predicted from the wallet's next nonce, then `AgentLaunch`. Reads back the link both ways.
 */
export async function deployLaunchPair(
  pub: PublicClient,
  wallet: Wallet,
  a: {
    poolManager: Address;
    orry: Address;
    registry: Address;
    attestor: Address;
    module: Address;
    staking: Address;
    price: Address;
    vault: Address;
    treasury: Address;
  },
  defaults = LAUNCH_DEFAULTS,
): Promise<{ hook: Address; agentLaunch: Address; hookSalt: Hex }> {
  const nonce = await pub.getTransactionCount({ address: wallet.account.address });
  // the factory call uses `nonce`, AgentLaunch the next one
  const launchAt = getContractAddress({ from: wallet.account.address, nonce: BigInt(nonce + 1) });
  const init = spokeHookInitCode({ poolManager: a.poolManager, orry: a.orry, launch: launchAt, ...defaults.hook });
  const { salt, address: hookAt } = mineSpokeHookSalt(init);
  const h1 = await wallet.sendTransaction({ to: CREATE2_FACTORY, data: concat([salt, init]), chain: foundry, account: wallet.account } as never);
  if ((await pub.waitForTransactionReceipt({ hash: h1 })).status !== "success") throw new Error("hook deployment reverted");
  if (!(await pub.getCode({ address: hookAt }))) throw new Error("no code at the mined hook address");
  const p = defaults.params;
  const h2 = await wallet.deployContract({
    abi: g.agentLaunchAbi as Abi,
    bytecode: g.agentLaunchBytecode,
    args: [a.poolManager, a.orry, hookAt, a.registry, a.attestor, a.module, a.staking, a.price, a.vault, a.treasury, p],
    chain: foundry,
    account: wallet.account,
  } as never);
  const r = await pub.waitForTransactionReceipt({ hash: h2 });
  if (r.status !== "success" || !r.contractAddress) throw new Error("AgentLaunch deployment reverted");
  if (r.contractAddress.toLowerCase() !== launchAt.toLowerCase()) throw new Error("AgentLaunch is not at the predicted address");
  const linked = await pub.readContract({ address: hookAt, abi: g.spokeHookAbi as Abi, functionName: "launch" });
  if (String(linked).toLowerCase() !== launchAt.toLowerCase()) throw new Error("hook and AgentLaunch are not linked");
  return { hook: hookAt, agentLaunch: r.contractAddress, hookSalt: salt };
}

/** A salt for which `predictCoin(caller, salt, name, symbol)` sorts above ORRY (L5-2); the web does the same. */
export async function coinSalt(pub: PublicClient, agentLaunch: Address, orry: Address, caller: Address, name: string, symbol: string): Promise<Hex> {
  for (let i = 0n; i < 512n; i++) {
    const salt = pad(toHex(i), { size: 32 });
    const coin = (await pub.readContract({ address: agentLaunch, abi: g.agentLaunchAbi as Abi, functionName: "predictCoin", args: [caller, salt, name, symbol] })) as Address;
    if (BigInt(coin) > BigInt(orry)) return salt;
  }
  throw new Error("no coin salt");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n: string) => {
    const i = process.argv.indexOf(n);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const rpc = arg("--rpc") ?? "http://127.0.0.1:18680";
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(rpc)) throw new Error("the launch stack deploys to a local anvil only");
  const s = await deployLaunchStack(rpc);
  const out = arg("--out");
  if (out) writeFileSync(out, JSON.stringify(s, null, 2));
  console.log(JSON.stringify(s, null, 2));
}
