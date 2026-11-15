/**
 * Lane L3 local stack (development and test only): the R2 contracts on an anvil, with the R1 test stand-ins around them
 * (a TSLA-like stock token, USDG, ORRY, Chainlink-like feeds, the hub price stand-in, fee tiers, the R1 market factory
 * with a plain v4 stock/USDG pool on the 4663 PoolManager runtime, and an EntryPoint stand-in for the paymaster).
 *
 *   pnpm tsx scripts/r2-stack.ts --rpc http://127.0.0.1:18640 --out /path/r2-stack.json
 *
 * Used by test/r2.integration.test.ts and by the local walk (scripts/walk/r2-walk.mjs). Never run against 4663 or 46630.
 */
import { writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
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
import * as g from "./r2-generated.js";
import { poolManagerAddress, poolManagerRuntime } from "../test/generated/orry.js";

const MNEMONIC = "test test test test test test test test test test test junk";
export const R2_ROLE = { deployer: 0, treasury: 1, keeper: 9, alice: 11, bob: 12, carol: 13, agent: 14, operator: 15 } as const;
const TSLA_ANSWER = 358_25000000n; // 358.25 USD, 8 decimals
const ETH_ANSWER = 2235_00000000n;
const HUB_TICK = 138200; // about 1,002,600 ORRY per ETH
const pmAbi = parseAbi([
  "function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24 tick)",
]);

export interface R2Stack {
  rpc: string;
  chainId: number;
  startBlock: string;
  poolManager: Address;
  registry: Address;
  stock: Address;
  usdg: Address;
  orry: Address;
  stockFeed: Address;
  ethFeed: Address;
  staking: Address;
  hook: Address;
  orryPrice: Address;
  feeTiers: Address;
  marketFactory: Address;
  stockMarket: Address;
  swapRouter: Address;
  predictFactory: Address;
  limitBook: Address;
  entryPoint: Address;
  paymaster: Address;
  shield: Address;
  treasury: Address;
  accounts: Record<keyof typeof R2_ROLE, Address>;
}

type Wallet = WalletClient & { account: Account };

export function r2Clients(rpc: string) {
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

export async function deployR2Stack(rpc: string): Promise<R2Stack> {
  const c = r2Clients(rpc);
  const d = c.wallet(R2_ROLE.deployer);
  const deploy = async (abi: Abi, bytecode: Hex, args: readonly unknown[] = []): Promise<Address> => {
    const hash = await d.deployContract({ abi, bytecode, args, chain: foundry, account: d.account } as never);
    const r = await c.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error("deployment reverted");
    return r.contractAddress;
  };
  const send = async (role: number, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], value = 0n) => {
    const w = c.wallet(role);
    const hash = await w.writeContract({ address, abi, functionName, args, value, chain: foundry, account: w.account } as never);
    const r = await c.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return r;
  };
  const now = BigInt((await c.pub.getBlock()).timestamp);
  const startBlock = await c.pub.getBlockNumber();
  await c.pub.request({ method: "anvil_setCode" as never, params: [poolManagerAddress, poolManagerRuntime] as never });
  const pm = poolManagerAddress as Address;
  const deployer = c.address(R2_ROLE.deployer);
  const treasury = c.address(R2_ROLE.treasury);

  const registry = await deploy(g.mockAccessRegistryAbi as Abi, g.mockAccessRegistryBytecode);
  const stock = await deploy(g.mockStockAbi as Abi, g.mockStockBytecode, [registry]);
  const usdg = await deploy(g.mockUsdgAbi as Abi, g.mockUsdgBytecode);
  const orry = await deploy(g.mockOrryAbi as Abi, g.mockOrryBytecode, [deployer, 10n ** 27n]);
  const stockFeed = await deploy(g.mockFeedAbi as Abi, g.mockFeedBytecode, [8]);
  const ethFeed = await deploy(g.mockFeedAbi as Abi, g.mockFeedBytecode, [8]);
  await send(R2_ROLE.deployer, stockFeed, g.mockFeedAbi as Abi, "push", [TSLA_ANSWER, now - 60n]);
  await send(R2_ROLE.deployer, ethFeed, g.mockFeedAbi as Abi, "push", [ETH_ANSWER, now - 60n]);
  const staking = await deploy(g.mockEarningStakingAbi as Abi, g.mockEarningStakingBytecode);
  const hook = await deploy(g.oracleHookStandInAbi as Abi, g.oracleHookStandInBytecode);
  await send(R2_ROLE.deployer, hook, g.oracleHookStandInAbi as Abi, "set", [HUB_TICK, now - 7200n]);
  const orryPrice = await deploy(g.orryPriceOracleAbi as Abi, g.orryPriceOracleBytecode, [hook, usdg, ethFeed, 90_000n]);
  const feeTiers = await deploy(g.feeTiersAbi as Abi, g.feeTiersBytecode, [staking, orryPrice, [100_000_000n, 1_000_000_000n], [2500, 5000]]);
  const marketFactory = await deploy(g.marketFactoryAbi as Abi, g.marketFactoryBytecode, [
    deployer, usdg, treasury, feeTiers, orryPrice, orry, pm,
    { commitSeconds: 240, revealSeconds: 60, feeBps: 15, minNotionalUsdg: 10_000_000n, maxStaleness: 90_000, commitFeeUsd: 50_000n, orryFeeDiscountBps: 2500, maxDeviationBps: 50 },
  ]);

  // a plain stock/USDG v4 pool at the feed price, full range (about 1,060 TSLA and 378,000 USDG), as the R1 tests use
  const lp = await deploy(g.poolModifyLiquidityTestAbi as Abi, g.poolModifyLiquidityTestBytecode, [pm]);
  const swapRouter = await deploy(g.poolSwapTestAbi as Abi, g.poolSwapTestBytecode, [pm]);
  const stockIs0 = stock.toLowerCase() < usdg.toLowerCase();
  const key = { currency0: stockIs0 ? stock : usdg, currency1: stockIs0 ? usdg : stock, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" as Address };
  const price = 358_250_000n; // USDG base units per 1e18 stock base units
  const ratio = stockIs0 ? (price << 192n) / 10n ** 18n : (10n ** 18n << 192n) / price;
  await send(R2_ROLE.deployer, pm, pmAbi as Abi, "initialize", [key, isqrt(ratio)]);
  await send(R2_ROLE.deployer, stock, g.mockStockAbi as Abi, "mint", [deployer, 100_000n * 10n ** 18n]);
  await send(R2_ROLE.deployer, usdg, g.mockUsdgAbi as Abi, "mint", [deployer, 100_000_000n * 10n ** 6n]);
  for (const t of [stock, usdg]) {
    await send(R2_ROLE.deployer, t, g.mockUsdgAbi as Abi, "approve", [lp, (1n << 256n) - 1n]);
    await send(R2_ROLE.deployer, t, g.mockUsdgAbi as Abi, "approve", [swapRouter, (1n << 256n) - 1n]);
  }
  await send(R2_ROLE.deployer, lp, g.poolModifyLiquidityTestAbi as Abi, "modifyLiquidity", [
    key, { tickLower: -887270, tickUpper: 887270, liquidityDelta: 2n * 10n ** 16n, salt: toHex(0, { size: 32 }) }, "0x",
  ]);
  await send(R2_ROLE.deployer, marketFactory, g.marketFactoryAbi as Abi, "create", [stock, stockFeed, key]);
  const stockMarket = (await c.pub.readContract({ address: marketFactory, abi: g.marketFactoryAbi as Abi, functionName: "marketOf", args: [stock] })) as Address;

  // lane L3 contracts, with the spec's guesses
  const predictFactory = await deploy(g.predictionMarketFactoryAbi as Abi, g.predictionMarketFactoryBytecode, [
    deployer, usdg, treasury, feeTiers, orryPrice, orry,
    { feeBps: 200, lockSeconds: 1800, minStake: 1_000_000n, creationFeeUsd: 1_000_000n, orryFeeDiscountBps: 2500 },
  ]);
  await send(R2_ROLE.deployer, predictFactory, g.predictionMarketFactoryAbi as Abi, "listFeed", [stockFeed, stock]);
  await send(R2_ROLE.deployer, predictFactory, g.predictionMarketFactoryAbi as Abi, "listFeed", [ethFeed, "0x0000000000000000000000000000000000000000"]);
  const limitBook = await deploy(g.limitOrderBookAbi as Abi, g.limitOrderBookBytecode, [
    usdg, marketFactory, pm, treasury, feeTiers, orryPrice, orry, 10, 100, 90_000, 2500,
  ]);
  const entryPoint = await deploy(g.mockEntryPointAbi as Abi, g.mockEntryPointBytecode);
  const paymaster = await deploy(g.orryPaymasterAbi as Abi, g.orryPaymasterBytecode, [
    entryPoint, orry, orryPrice, ethFeed, deployer, deployer,
    { premiumBps: 1000, bufferBps: 2000, maxCostWei: 2_000_000_000_000_000n, postOpOverheadGas: 45_000, maxRateAge: 3600, maxEthStaleness: 90_000 },
  ]);
  await send(R2_ROLE.deployer, paymaster, g.orryPaymasterAbi as Abi, "refreshRate");

  // Shield V2: the generated verifier calls two external libraries, linked here into its bytecode
  const libs: Record<string, Address> = {
    ZKTranscriptLib: await deploy(g.zKTranscriptLibAbi as Abi, g.zKTranscriptLibBytecode),
    RelationsLib: await deploy(g.relationsLibAbi as Abi, g.relationsLibBytecode),
  };
  let code: string = g.honkVerifierBytecode;
  for (const ref of g.honkVerifierLinkReferences) {
    for (const start of ref.starts) {
      const at = 2 + start * 2;
      code = code.slice(0, at) + libs[ref.lib]!.slice(2).toLowerCase() + code.slice(at + 40);
    }
  }
  const verifier = await deploy(g.honkVerifierAbi as Abi, code as Hex);
  const shield = await deploy(g.orreryShieldAbi as Abi, g.orreryShieldBytecode, [verifier, usdg, treasury, feeTiers, 50, 50]);

  // traders: stock, USDG and ORRY, approvals to the R2 contracts
  const accounts = Object.fromEntries(Object.entries(R2_ROLE).map(([k, i]) => [k, c.address(i)])) as Record<keyof typeof R2_ROLE, Address>;
  for (const role of [R2_ROLE.alice, R2_ROLE.bob, R2_ROLE.carol, R2_ROLE.operator]) {
    const who = c.address(role);
    await send(R2_ROLE.deployer, stock, g.mockStockAbi as Abi, "mint", [who, 1_000n * 10n ** 18n]);
    await send(R2_ROLE.deployer, usdg, g.mockUsdgAbi as Abi, "mint", [who, 1_000_000n * 10n ** 6n]);
    await send(R2_ROLE.deployer, orry, g.mockOrryAbi as Abi, "transfer", [who, 10_000_000n * 10n ** 18n]);
    await send(role, usdg, g.mockUsdgAbi as Abi, "approve", [shield, (1n << 256n) - 1n]);
    for (const spender of [predictFactory, limitBook, paymaster]) {
      await send(role, orry, g.mockOrryAbi as Abi, "approve", [spender, (1n << 256n) - 1n]);
    }
    for (const t of [stock, usdg]) await send(role, t, g.mockUsdgAbi as Abi, "approve", [limitBook, (1n << 256n) - 1n]);
  }
  return {
    rpc,
    chainId: await c.pub.getChainId(),
    startBlock: startBlock.toString(),
    poolManager: pm,
    registry, stock, usdg, orry, stockFeed, ethFeed, staking, hook, orryPrice, feeTiers, marketFactory, stockMarket, swapRouter,
    predictFactory, limitBook, entryPoint, paymaster, shield, treasury, accounts,
  };
}

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const rpc = arg("--rpc") ?? "http://127.0.0.1:18640";
  const stack = await deployR2Stack(rpc);
  const out = arg("--out");
  if (out) writeFileSync(out, JSON.stringify(stack, null, 2));
  console.log(JSON.stringify(stack, null, 2));
}
