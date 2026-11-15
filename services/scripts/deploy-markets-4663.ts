/**
 * Wave R1 markets (Stocks, Private Swap, Dark Pool) on Robinhood Chain mainnet 4663, after the ORRY deploy.
 *
 *   tsx scripts/deploy-markets-4663.ts --rpc http://127.0.0.1:18548 --fork   dry run on an anvil fork (46630 keys)
 *   tsx scripts/deploy-markets-4663.ts                                       live: prints a summary and waits for CONFIRM
 *   [--config ops/markets-4663.json]                                         which stock tokens get a market
 *
 * Deploys OrryPriceOracle (hub TWAP times the Chainlink ETH/USD feed), FeeTiers (stake tiers in USD) and MarketFactory
 * (owner: the deployer, the treasury owner, M1), then one SealedBatchMarket per configured stock token with its real
 * Chainlink feed and, where one is configured and holds liquidity, its stock/USDG remainder pool (D-R1-5; fixed at
 * creation). Parameters are the spec's (docs/ORRY-R1-SPEC.md 2.1), as on the development network. Re-running creates
 * only the markets that do not exist yet. Keys come from ~/.secrets/orrery/<keys>-deployer.json; only addresses print.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeDeployData,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { iSealedBatchMarketAbi } from "@orrery/shared";
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
const CONFIG = arg("--config") ?? join(here, "../../ops/markets-4663.json");
const POOL_MANAGER = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
const STATE_VIEW = getAddress("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b");
const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** Spec 2.1 and L2: 4 min commit, 1 min reveal, 0.15% fee, 10 USDG minimum, 26 h staleness, 0.05 USD sealing fee in ORRY,
 * 25% off fees paid in ORRY, remainder fills within 0.5% of the clearing price. */
const PARAMS = { commitSeconds: 240, revealSeconds: 60, feeBps: 15, minNotionalUsdg: 10_000_000n, maxStaleness: 93_600, commitFeeUsd: 50_000n, orryFeeDiscountBps: 2500, maxDeviationBps: 50 };
/** Stake tiers in USD (6 decimals): 100 and 1,000 USD of earning stake take 25% and 50% off the fee. */
const TIERS: [bigint[], number[]] = [[100_000_000n, 1_000_000_000n], [2500, 5000]];
const ORACLE_MAX_AGE = 93_600n;
const ESTIMATE_GAS = 30_000_000n;

interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}
interface MarketConfig {
  symbol: string;
  token: Address;
  feed: Address;
  pool: PoolKey | null;
}
const noPool: PoolKey = { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO };
const poolIdOf = (k: PoolKey): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)"]);
const tokenAbi = parseAbi(["function symbol() view returns (string)"]);
const stateViewAbi = parseAbi(["function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)"]);

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
  console.log(`deployed ${name.padEnd(16)} ${r.contractAddress} (gas ${r.gasUsed})`);
  return { address: getAddress(r.contractAddress), block: r.blockNumber };
}
async function call(to: Address, abi: Abi, functionName: string, args: unknown[]) {
  const gas = ((await pub.estimateContractGas({ address: to, abi, functionName, args, account: wallet.account } as never)) * 12n) / 10n + 60_000n;
  const hash = await wallet.writeContract({ address: to, abi, functionName, args, chain, account: wallet.account, gas } as never);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  spent += r.gasUsed * r.effectiveGasPrice;
  console.log(`  ${functionName} ${hash} (gas ${r.gasUsed})`);
}

// ------------------------------------------------------------------ inputs

if ((await pub.getChainId()) !== 4663) throw new Error("not chain 4663");
const v1File = join(DEPLOYMENTS, `${TAG}.json`);
const orryFile = join(DEPLOYMENTS, `orry-${TAG}.json`);
if (!existsSync(v1File) || !existsSync(orryFile)) throw new Error(`deployments/${TAG}.json and orry-${TAG}.json are needed: deploy v1 and ORRY first.`);
const v1 = JSON.parse(readFileSync(v1File, "utf8")) as { treasury: Address; usdg: Address; treasuryOwner: Address };
const r = JSON.parse(readFileSync(orryFile, "utf8")) as { orry: Address; hook: Address; staking: Address; ethUsdFeed: Address };
if (v1.treasuryOwner.toLowerCase() !== deployer.toLowerCase()) throw new Error(`The treasury owner is ${v1.treasuryOwner}; the market factory owner must be that key, not ${deployer}.`);
const usdg = getAddress(v1.usdg);
const markets = (JSON.parse(readFileSync(CONFIG, "utf8")) as { markets: MarketConfig[] }).markets;
const nowTs = (await pub.getBlock()).timestamp;
const plan: (MarketConfig & { poolUsed: PoolKey; note: string })[] = [];
for (const m of markets) {
  if (!isAddress(m.token) || !isAddress(m.feed)) throw new Error(`${m.symbol}: token and feed must be addresses`);
  const [code, symbol, feedDecimals, round] = await Promise.all([
    pub.getCode({ address: m.token }),
    read<string>(m.token, tokenAbi as Abi, "symbol"),
    read<number>(m.feed, feedAbi as Abi, "decimals"),
    read<readonly [bigint, bigint, bigint, bigint, bigint]>(m.feed, feedAbi as Abi, "latestRoundData"),
  ]);
  if (!code || code === "0x") throw new Error(`${m.symbol}: no token code at ${m.token}`);
  if (Number(feedDecimals) !== 8 || round[1] <= 0n) throw new Error(`${m.symbol}: feed ${m.feed} answers ${round[1]} with ${feedDecimals} decimals`);
  const age = nowTs - round[3];
  let poolUsed = noPool;
  let note = `feed age ${age} s${age > ORACLE_MAX_AGE ? " (stale now: markets hours, batches wait)" : ""}`;
  if (m.pool) {
    const k = { ...m.pool, currency0: getAddress(m.pool.currency0), currency1: getAddress(m.pool.currency1), hooks: getAddress(m.pool.hooks) };
    const pair = [k.currency0.toLowerCase(), k.currency1.toLowerCase()].sort().join();
    if (pair !== [m.token.toLowerCase(), usdg.toLowerCase()].sort().join()) throw new Error(`${m.symbol}: the pool is not ${symbol}/USDG`);
    const liq = await read<bigint>(STATE_VIEW, stateViewAbi as Abi, "getLiquidity", [poolIdOf(k)]);
    if (liq > 0n) {
      poolUsed = k;
      note += `, remainder pool fee ${k.fee} (liquidity ${liq})`;
    } else note += ", configured pool holds no liquidity: none used";
  }
  plan.push({ ...m, poolUsed, note: `${symbol}: ${note}` });
}

const out = FORK || !existsSync(join(DEPLOYMENTS, `markets-${TAG}.json`)) ? null : (JSON.parse(readFileSync(join(DEPLOYMENTS, `markets-${TAG}.json`), "utf8")) as { factory: Address });
const price = await pub.getGasPrice();
const balance = await pub.getBalance({ address: deployer });
console.log(`Wave R1 markets on chain 4663${FORK ? " (fork)" : ""}
  owner            ${deployer} (balance ${formatEther(balance)} ETH), the treasury owner
  oracle           ORRY price: hub ${r.hook} TWAP times ETH/USD ${r.ethUsdFeed}, max age ${ORACLE_MAX_AGE} s
  fee tiers        ${TIERS[0].map((t) => Number(t) / 1e6)} USD of stake -> ${TIERS[1].map((b) => b / 100)}% off
  params           ${PARAMS.commitSeconds} s commit, ${PARAMS.revealSeconds} s reveal, fee ${PARAMS.feeBps / 100}%, min ${Number(PARAMS.minNotionalUsdg) / 1e6} USDG, sealing fee ${Number(PARAMS.commitFeeUsd) / 1e6} USD of ORRY
  markets          ${plan.map((p) => p.note).join("\n                   ")}
  ${out ? `factory exists   ${out.factory}: only missing markets are created` : `gas estimate     ~${ESTIMATE_GAS} gas at ${price} wei = ~${formatEther(ESTIMATE_GAS * price)} ETH`}`);
if (!FORK && !out && balance < ESTIMATE_GAS * price) {
  console.log(`Deployer balance is below the estimate. Send at least ${formatEther(ESTIMATE_GAS * price * 2n)} ETH to ${deployer} on 4663 first. Nothing was sent.`);
  process.exit(1);
}
if (!FORK) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Type CONFIRM to deploy the markets on mainnet: ");
  rl.close();
  if (answer.trim() !== "CONFIRM") {
    console.log("Not confirmed. Nothing was sent.");
    process.exit(1);
  }
}

// ------------------------------------------------------------------ deploy

let factory: Address;
let oracle: Address;
let feeTiers: Address;
let startBlock: bigint;
if (out) {
  factory = out.factory;
  const prev = JSON.parse(readFileSync(join(DEPLOYMENTS, `markets-${TAG}.json`), "utf8")) as { oracle: Address; feeTiers: Address; startBlock: string };
  ({ oracle, feeTiers } = prev);
  startBlock = BigInt(prev.startBlock);
} else {
  // the markets indexer starts here, before the factory, so it sees every MarketCreated
  startBlock = await pub.getBlockNumber();
  oracle = (await deploy("orryPriceOracle", rc.orryPriceOracleAbi as Abi, rc.orryPriceOracleBytecode as Hex, [r.hook, usdg, r.ethUsdFeed, ORACLE_MAX_AGE])).address;
  feeTiers = (await deploy("feeTiers", rc.feeTiersAbi as Abi, rc.feeTiersBytecode as Hex, [r.staking, oracle, TIERS[0], TIERS[1]])).address;
  factory = (await deploy("marketFactory", rc.marketFactoryAbi as Abi, rc.marketFactoryBytecode as Hex, [deployer, usdg, v1.treasury, feeTiers, oracle, r.orry, POOL_MANAGER, PARAMS])).address;
}
const created: Record<string, Address> = {};
for (const p of plan) {
  let m = await read<Address>(factory, rc.marketFactoryAbi as Abi, "marketOf", [p.token]);
  if (m === ZERO) {
    await call(factory, rc.marketFactoryAbi as Abi, "create", [p.token, p.feed, p.poolUsed]);
    m = await read<Address>(factory, rc.marketFactoryAbi as Abi, "marketOf", [p.token]);
  }
  created[p.symbol] = m;
  console.log(`  market ${p.symbol.padEnd(5)} ${m}`);
}

// read back: every market is the factory's, for its asset, with nothing held
const checks: [string, boolean][] = [];
for (const p of plan) {
  const m = created[p.symbol]!;
  const [asset, owner] = await Promise.all([read<Address>(m, iSealedBatchMarketAbi as Abi, "asset"), read<Address>(factory, rc.marketFactoryAbi as Abi, "owner")]);
  checks.push([`${p.symbol} market asset`, asset.toLowerCase() === p.token.toLowerCase()]);
  checks.push([`factory owner`, owner.toLowerCase() === deployer.toLowerCase()]);
}
for (const [label, ok] of checks) console.log(`read back ${ok ? "ok  " : "FAIL"} ${label}`);
console.log(`spent ${formatEther(spent)} ETH`);
if (checks.some(([, ok]) => !ok)) throw new Error("A read-back does not match. Do not configure the API or the web; check the deployment above.");
writeFileSync(
  join(DEPLOYMENTS, `markets-${TAG}.json`),
  JSON.stringify({ chainId: 4663, startBlock: startBlock.toString(), oracle, feeTiers, factory, markets: created, params: { ...PARAMS, minNotionalUsdg: PARAMS.minNotionalUsdg.toString(), commitFeeUsd: PARAMS.commitFeeUsd.toString() } }, null, 2) + "\n",
);
console.log(`wrote deployments/markets-${TAG}.json
API and indexer: ORRERY_MARKET_FACTORY=${factory} ORRERY_MARKETS_START_BLOCK=${startBlock}; web: NEXT_PUBLIC_MARKET_FACTORY=${factory}`);
