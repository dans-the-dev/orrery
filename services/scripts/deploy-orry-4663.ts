/**
 * ORRY contracts on Robinhood Chain mainnet 4663 (or a local fork of it), after ORRY graduated on Pons V2.
 *
 *   tsx scripts/deploy-orry-4663.ts --orry <token> --rpc http://127.0.0.1:18548 --fork   dry run on an anvil fork (46630 keys)
 *   tsx scripts/deploy-orry-4663.ts --orry <token>                                        live: prints a summary and waits for CONFIRM
 *   tsx scripts/deploy-orry-4663.ts --execute-coin [--fork]                                48 hours later: sets the coin on the treasury
 *
 * Reads the v1 deployment (deployments/4663.json, or 4663-fork.json with --fork) for the treasury and attestor. Deploys
 * OrryStaking, OrreryHook (CREATE2 at a mined address carrying the hook's permission bits; it registers the ORRY/ETH
 * and ORRY/USDG pairs, R-35), OrryBuyback and OrryRewardsRouter (they reference each other, so their CREATE addresses
 * are predicted: finding F-4), EarnVaultFactory with the ETH and the USDG vault, ClaimAll and OrryLens over the factory;
 * initializes both hubs; proposes the coin on the treasury, which can be executed 48 hours later (spec 3.5). Constructor
 * values are the build spec's (R-6, R-7, R-8, R-18, R-35).
 *
 * Opening prices (R-21): the ETH hub at the Pons pool's sqrtPriceX96. The USDG hub at the Pons ETH price times the
 * Chainlink ETH/USD answer, with USDG taken as one dollar. With p = (ponsSqrt / 2^96)^2 ORRY wei per wei of ETH, a the
 * feed answer with d decimals, and s = 10^(18 + d - 6), ORRY wei per USDG unit is p * s / a. When USDG sorts below ORRY
 * (USDG is currency0) sqrtPriceX96 = isqrt(ponsSqrt^2 * s / a); when ORRY sorts below USDG (ORRY is currency0, the
 * price is USDG per ORRY) sqrtPriceX96 = isqrt(a * 2^384 / (ponsSqrt^2 * s)).
 * Pons is only read here: no Orrery contract receives the address of the Pons factory, its fee escrow or its hook (R-1).
 *
 * Seed (review M-3): `--seed-eth <ETH> --seed-usdg <USDG>` has the deployer deposit into both Earn pools right after
 * they open, inside 1% of the opening prices, with the matching ORRY (the deployer must hold it). A pool with no
 * liquidity can be moved for free, and the web refuses deposits into an empty pool, so Earn opens with this seed.
 * Keys are read from ~/.secrets/orrery/<keys>-<role>.json; nothing is printed but addresses.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { depositPriceBounds } from "@orrery/shared";
import {
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeDeployData,
  formatEther,
  getAddress,
  getContractAddress,
  http,
  isAddress,
  isAddressEqual,
  keccak256,
  pad,
  parseAbi,
  parseEventLogs,
  parseUnits,
  toHex,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { orreryAttestorAbi } from "@orrery/shared";
import * as rc from "../test/generated/orry.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const FORK = process.argv.includes("--fork");
const EXECUTE_COIN = process.argv.includes("--execute-coin");
// The official RPC: it accepts transactions (rpc-robinhood.blockmachine.io serves reads only and refuses eth_sendRawTransaction,
// found on the first live run 2026-11-11). Where the official name is DNS-blocked, pass --rpc https://robinhood-rpc.publicnode.com.
const RPC = arg("--rpc") ?? "https://rpc.mainnet.chain.robinhood.com";
const KEYS = arg("--keys") ?? (FORK ? "46630" : "mainnet");
const TAG = FORK ? "4663-fork" : "4663";
const DEPLOYMENTS = join(here, "../../deployments");

/** 4663 addresses: section 2 of docs/ORRY-BUILD-SPEC.md. Pons entries are read only. */
const A = {
  poolManager: getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  stateView: getAddress("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"),
  usdg: getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168"),
  registry: getAddress("0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"),
  create2Factory: getAddress("0x4e59b44847b379578588920ca78fbf26c0b4956c"),
  ponsFactory: getAddress("0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e"),
  ponsHook: getAddress("0xe5e702641ea86f4ae6cc3cdaed2b886f976be044"),
  /** Chainlink ETH/USD proxy on 4663 (docs/ORRY-R1-SPEC.md); the hook's constructor requires a fresh answer. */
  ethUsdFeed: getAddress("0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9"),
} as const;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** Hub key and fee (R-6), staking periods (R-8), router split and interval (R-7), slice cap 1,000 USDG (R-18). */
const P = {
  lpFee: 8500,
  protocolFeePips: 1500,
  tickSpacing: 200,
  plainCooldown: 7n * 86_400n,
  agentCooldown: 14n * 86_400n,
  streamPeriod: 7n * 86_400n,
  stakersBps: 5000,
  routerInterval: 3_600n,
  maxSliceUsdgCap: 1_000_000_000n,
  cashbackBps: 1000, // R-45: 10% of slice and quote buys to the cashback sink once the treasury owner sets it (B-1)
} as const;
/** Buyback hop 1: the three deepest hookless native ETH / USDG pools found by lane B (spec section 2). */
const HOP1 = [
  { id: "0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982", fee: 500, tickSpacing: 10 },
  { id: "0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32", fee: 460, tickSpacing: 9 },
  { id: "0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e", fee: 100, tickSpacing: 1 },
] as const;
const HOOK_FLAGS = 0x10c4n; // afterInitialize | beforeSwap | afterSwap | afterSwapReturnDelta
const ORRY_SUPPLY = 10n ** 27n;
const FEED_MAX_AGE = 25n * 3_600n; // the hook's FEED_MAX_AGE
const ESTIMATE_GAS = 20_000_000n; // 8 deployments + 2 createVault + 2 initialize + proposeCoin: 17.56 M measured on a 4663 fork (2026-11-08)

interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}
const poolIdOf = (k: PoolKey): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));

const pmAbi = parseAbi(["function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24 tick)"]);
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const erc20Abi = parseAbi(["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)", "function decimals() view returns (uint8)"]);
const isqrt = (n: bigint): bigint => {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
};
const ponsAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);

const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 1500 }) });
const keyFile = (role: string) => join(homedir(), ".secrets/orrery", `${KEYS}-${role}.json`);
const keyOf = (role: string) => (JSON.parse(readFileSync(keyFile(role), "utf8")) as { privateKey: Hex }).privateKey;
const deployerWallet = createWalletClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 1500 }), account: privateKeyToAccount(keyOf("deployer")) }) as WalletClient & { account: Account };
const deployer = deployerWallet.account.address;
const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
const same = (a: unknown, b: Address) => typeof a === "string" && isAddress(a) && isAddressEqual(a, b);

const chainId = await pub.getChainId();
if (chainId !== 4663) throw new Error(`Expected chain 4663, got ${chainId}`);
if (FORK) await pub.request({ method: "anvil_setBalance" as never, params: [deployer, "0xDE0B6B3A7640000"] as never }); // 1 ETH

let spent = 0n;
/** Estimate plus 20% and 60,000 gas: an exact estimate can run out when the transaction lands a second later (lane C,
 * services a552eb4). Unused gas is not charged. */
const withHeadroom = (estimate: bigint) => (estimate * 12n) / 10n + 60_000n;
async function confirm(question: string) {
  if (FORK) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  if (answer.trim() !== "CONFIRM") {
    console.log("Not confirmed. Nothing was sent.");
    process.exit(1);
  }
}
async function deploy(name: string, abi: Abi, code: Hex, args: unknown[]): Promise<{ address: Address; block: bigint }> {
  const data = encodeDeployData({ abi, bytecode: code, args });
  const gas = withHeadroom(await pub.estimateGas({ account: deployerWallet.account, data }));
  const hash = await deployerWallet.deployContract({ abi, bytecode: code, args, chain, account: deployerWallet.account, gas });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deployment failed (${hash})`);
  spent += r.gasUsed * r.effectiveGasPrice;
  console.log(`deployed ${name.padEnd(9)} ${r.contractAddress} (${hash}, gas ${r.gasUsed})`);
  return { address: r.contractAddress, block: r.blockNumber };
}
async function call(to: Address, abi: Abi, functionName: string, args: unknown[], value = 0n) {
  const gas = withHeadroom(await pub.estimateContractGas({ address: to, abi, functionName, args, value, account: deployerWallet.account } as never));
  const hash = await deployerWallet.writeContract({ address: to, abi, functionName, args, value, chain, account: deployerWallet.account, gas } as never);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  spent += r.gasUsed * r.effectiveGasPrice;
  console.log(`  ${functionName} ${hash} (gas ${r.gasUsed})`);
  return r;
}

// ------------------------------------------------------------------ 48 hours later: set the coin

if (EXECUTE_COIN) {
  const file = join(DEPLOYMENTS, `orry-${TAG}.json`);
  const d = JSON.parse(readFileSync(file, "utf8")) as { treasury: Address; orry: Address; buyback: Address; coinExecutableAt: string };
  const [owner, setCoin] = await Promise.all([read<Address>(d.treasury, rc.orreryTreasuryAbi as Abi, "owner"), read<Address>(d.treasury, rc.orreryTreasuryAbi as Abi, "orry")]);
  if (!same(owner, deployer)) throw new Error(`The treasury owner is ${owner}, not this deployer key.`);
  if (!same(setCoin, ZERO)) throw new Error(`The coin is already set (${setCoin}). Nothing was sent.`);
  const now = (await pub.getBlock()).timestamp;
  if (now < BigInt(d.coinExecutableAt)) {
    console.log(`The coin can be set from ${new Date(Number(d.coinExecutableAt) * 1000).toISOString()} (chain time now ${new Date(Number(now) * 1000).toISOString()}). Nothing was sent.`);
    process.exit(1);
  }
  console.log(`Set the coin on OrreryTreasury ${d.treasury} (chain 4663${FORK ? ", fork" : ""})
  orry    ${d.orry}
  buyback  ${d.buyback}`);
  await confirm("Type CONFIRM to set the coin on mainnet: ");
  await call(d.treasury, rc.orreryTreasuryAbi as Abi, "executeCoin", []);
  const [r, b, avail] = await Promise.all([
    read<Address>(d.treasury, rc.orreryTreasuryAbi as Abi, "orry"),
    read<Address>(d.treasury, rc.orreryTreasuryAbi as Abi, "buyback"),
    read<bigint>(d.treasury, rc.orreryTreasuryAbi as Abi, "availableForBuyback"),
  ]);
  console.log(`read back: orry ${r}, buyback ${b}, available for buyback ${avail} (USDG base units)`);
  if (!same(r, d.orry) || !same(b, d.buyback)) throw new Error("Coin read-back does not match.");
  process.exit(0);
}

// ------------------------------------------------------------------ checks before anything is sent

const orryArg = arg("--orry");
if (!orryArg || !isAddress(orryArg)) throw new Error("--orry <token address> is required (the ORRY token launched on Pons).");
const orry = getAddress(orryArg);
const v1File = join(DEPLOYMENTS, `${TAG}.json`);
if (!existsSync(v1File)) throw new Error(`${v1File} not found: deploy v1 and the treasury first (scripts/deploy-4663.ts).`);
const v1 = JSON.parse(readFileSync(v1File, "utf8")) as { attestor: Address; treasury: Address };

for (const [name, a] of Object.entries({ poolManager: A.poolManager, stateView: A.stateView, usdg: A.usdg, registry: A.registry, create2Factory: A.create2Factory, ethUsdFeed: A.ethUsdFeed, treasury: v1.treasury, attestor: v1.attestor, orry })) {
  const code = await pub.getCode({ address: a });
  if (!code || code === "0x") throw new Error(`${name} has no code at ${a}`);
}
const [supply, decimals] = await Promise.all([read<bigint>(orry, erc20Abi as Abi, "totalSupply"), read<number>(orry, erc20Abi as Abi, "decimals")]);
if (supply > ORRY_SUPPLY || decimals !== 18) throw new Error(`ORRY has supply ${supply} and ${decimals} decimals; expected at most 1e27 and 18.`);

const [tOwner, tPending, tCoin, aTreasury] = await Promise.all([
  read<Address>(v1.treasury, rc.orreryTreasuryAbi as Abi, "owner"),
  read<Address>(v1.treasury, rc.orreryTreasuryAbi as Abi, "pendingOwner"),
  read<Address>(v1.treasury, rc.orreryTreasuryAbi as Abi, "orry"),
  read<Address>(v1.attestor, orreryAttestorAbi as Abi, "treasury"),
]);
if (!same(tOwner, deployer)) throw new Error(`The treasury owner is ${tOwner}; proposeCoin needs that key, not ${deployer}.`);
if (!same(tPending, ZERO)) throw new Error(`The treasury has a pending owner (${tPending}); finish or cancel that first.`);
if (!same(tCoin, ZERO)) throw new Error(`The treasury coin is already set (${tCoin}).`);
if (!same(aTreasury, v1.treasury)) throw new Error(`The attestor's treasury is ${aTreasury}, not OrreryTreasury ${v1.treasury}.`);

// the Pons pool ORRY graduated into gives the hub's starting price
const lt = await read<{ phase: number; exists: boolean; pairToken: Address; poolFee: number; tickSpacing: number; creatorFeeRecipient: Address }>(A.ponsFactory, ponsAbi as Abi, "getLaunchedToken", [orry]);
if (!lt.exists) throw new Error("ORRY is not a Pons V2 launch.");
if (lt.phase !== 2) throw new Error(`ORRY has not graduated into its Pons pool yet (phase ${lt.phase}, need 2).`);
if (!same(lt.pairToken, ZERO)) throw new Error(`ORRY is paired with ${lt.pairToken} on Pons; the hub expects native ETH.`);
const ponsKey: PoolKey = { currency0: ZERO, currency1: orry, fee: lt.poolFee, tickSpacing: lt.tickSpacing, hooks: A.ponsHook };
const [ponsSqrtPrice] = await read<readonly [bigint, number, number, number]>(A.stateView, stateViewAbi as Abi, "getSlot0", [poolIdOf(ponsKey)]);
if (ponsSqrtPrice === 0n) throw new Error(`No Pons pool at the derived key (fee ${lt.poolFee}, spacing ${lt.tickSpacing}).`);

// the ETH/USD feed must answer for the hook's constructor, and gives the USDG hub's opening price (see the header)
const [feedRound, feedDecimals] = await Promise.all([
  read<readonly [bigint, bigint, bigint, bigint, bigint]>(A.ethUsdFeed, feedAbi as Abi, "latestRoundData"),
  read<number>(A.ethUsdFeed, feedAbi as Abi, "decimals"),
]);
const [, ethUsd, , feedUpdatedAt] = feedRound;
const nowTs = (await pub.getBlock()).timestamp;
if (ethUsd <= 0n || feedUpdatedAt === 0n || feedUpdatedAt > nowTs || nowTs - feedUpdatedAt > FEED_MAX_AGE) {
  throw new Error(`The ETH/USD feed ${A.ethUsdFeed} does not answer (answer ${ethUsd}, updated ${feedUpdatedAt}, now ${nowTs}); the hook's constructor would revert. Nothing was sent.`);
}
const usdgScale = 10n ** BigInt(18 + Number(feedDecimals) - 6);
const orryBelowUsdg = BigInt(orry) < BigInt(A.usdg);
const usdgHubSqrtPrice = orryBelowUsdg
  ? isqrt((ethUsd * (1n << 384n)) / (ponsSqrtPrice * ponsSqrtPrice * usdgScale))
  : isqrt((ponsSqrtPrice * ponsSqrtPrice * usdgScale) / ethUsd);

// hop 1 pools: recorded ids must match their keys, and only pools with liquidity are listed
const hop1: { key: PoolKey; liquidity: bigint }[] = [];
for (const p of HOP1) {
  const key: PoolKey = { currency0: ZERO, currency1: A.usdg, fee: p.fee, tickSpacing: p.tickSpacing, hooks: ZERO };
  if (poolIdOf(key) !== p.id) throw new Error(`Recorded ETH/USDG pool ${p.id} does not match its key.`);
  const liquidity = await read<bigint>(A.stateView, stateViewAbi as Abi, "getLiquidity", [p.id]);
  if (liquidity > 0n) hop1.push({ key, liquidity });
}
if (hop1.length === 0) throw new Error("None of the recorded ETH/USDG pools has liquidity.");
const usdPool = hop1.reduce((a, b) => (b.liquidity > a.liquidity ? b : a));
const quoteSigner = arg("--quote-signer") ?? (existsSync(keyFile("quote-signer")) ? privateKeyToAccount(keyOf("quote-signer")).address : undefined);
if (quoteSigner && !isAddress(quoteSigner)) throw new Error("--quote-signer must be an address.");

// Seed amounts (review M-3) and the ORRY they need at the opening prices, 2% over for rounding (the rest comes back).
const seedEth = arg("--seed-eth") ? parseUnits(arg("--seed-eth")!, 18) : 0n;
const seedUsdg = arg("--seed-usdg") ? parseUnits(arg("--seed-usdg")!, 6) : 0n;
const Q192 = 1n << 192n;
const seedOrryEth = (seedEth * ponsSqrtPrice * ponsSqrtPrice) / Q192;
const seedOrryUsdg = orryBelowUsdg
  ? (seedUsdg * Q192) / (usdgHubSqrtPrice * usdgHubSqrtPrice)
  : (seedUsdg * usdgHubSqrtPrice * usdgHubSqrtPrice) / Q192;
const seedOrry = ((seedOrryEth + seedOrryUsdg) * 102n) / 100n;
if (seedEth || seedUsdg) {
  const [haveOrry, haveUsdg] = await Promise.all([read<bigint>(orry, erc20Abi as Abi, "balanceOf", [deployer]), read<bigint>(A.usdg, erc20Abi as Abi, "balanceOf", [deployer])]);
  if (haveOrry < seedOrry || haveUsdg < seedUsdg) {
    console.log(`The seed needs ${formatEther(seedOrry)} ORRY and ${Number(seedUsdg) / 1e6} USDG on ${deployer}; it holds ${formatEther(haveOrry)} ORRY and ${Number(haveUsdg) / 1e6} USDG. Nothing was sent.`);
    process.exit(1);
  }
}

const price = await pub.getGasPrice();
const balance = await pub.getBalance({ address: deployer });
console.log(`ORRY deployment on chain 4663${FORK ? " (fork)" : ""}
  deployer         ${deployer} (balance ${formatEther(balance)} ETH), treasury owner
  ORRY            ${orry} (supply ${supply}, Pons pool fee ${lt.poolFee}, spacing ${lt.tickSpacing}, creator fees to ${lt.creatorFeeRecipient})
  treasury         ${v1.treasury} (coinless; the coin is proposed now and set 48 hours later)
  hubs             ETH/ORRY and USDG/ORRY, LP fee ${P.lpFee} pips + hook fee ${P.protocolFeePips} pips, spacing ${P.tickSpacing}
                   ETH hub at the Pons price; USDG hub at sqrtPriceX96 ${usdgHubSqrtPrice} (ETH/USD ${Number(ethUsd) / 10 ** Number(feedDecimals)}, feed age ${nowTs - feedUpdatedAt} s)
  pair admin       the treasury owner (new pairs after 48 hours, at most 8, R-36)
  staking          cooldowns ${P.plainCooldown / 86_400n} and ${P.agentCooldown / 86_400n} days, streams ${P.streamPeriod / 86_400n} days
  router           ${P.stakersBps / 100}% to stakers, the rest burned, at most hourly
  buyback          slice cap ${Number(P.maxSliceUsdgCap) / 1e6} USDG, hop 1 pools ${hop1.length} (${hop1.map((h) => `${h.key.fee}/${h.key.tickSpacing}`).join(", ")}), cashback ${P.cashbackBps / 100}% once a sink is set (none at deploy)
  quote signer     ${quoteSigner ?? "none (ORRY checkout stays closed until setQuoteSigner)"}
  Earn seed        ${seedEth || seedUsdg ? `${formatEther(seedEth)} ETH and ${Number(seedUsdg) / 1e6} USDG with up to ${formatEther(seedOrry)} ORRY, within 1% of the opening prices` : "none: Earn stays closed on the web until a pool is seeded"}
  gas estimate     ~${ESTIMATE_GAS} gas at ${price} wei = ~${formatEther(ESTIMATE_GAS * price)} ETH`);
if (!FORK && balance < ESTIMATE_GAS * price + seedEth) {
  console.log(`Deployer balance is below the estimate. Send at least ${formatEther(ESTIMATE_GAS * price * 2n)} ETH to ${deployer} on 4663 first. Nothing was sent.`);
  process.exit(1);
}
await confirm("Type CONFIRM to deploy ORRY on mainnet: ");

// ------------------------------------------------------------------ deployment

const staking = await deploy("staking", rc.orryStakingAbi as Abi, rc.orryStakingBytecode, [orry, A.registry, P.plainCooldown, P.agentCooldown, P.streamPeriod]);

// the hook goes through the CREATE2 factory at this nonce; the buyback and the router are the next two CREATE nonces
const nonce = await pub.getTransactionCount({ address: deployer, blockTag: "pending" });
const buybackAt = getContractAddress({ from: deployer, nonce: BigInt(nonce + 1) });
const routerAt = getContractAddress({ from: deployer, nonce: BigInt(nonce + 2) });
const hookInit = encodeDeployData({ abi: rc.orreryHookAbi as Abi, bytecode: rc.orreryHookBytecode, args: [A.poolManager, orry, routerAt, v1.treasury, P.lpFee, P.protocolFeePips, P.tickSpacing, A.usdg, A.ethUsdFeed] });
const initHash = keccak256(hookInit);
let salt: Hex = "0x";
let hookAt: Address = ZERO;
for (let i = BigInt(keccak256(toHex("orrery.orry.hook"))) >> 192n; ; i++) {
  salt = pad(toHex(i), { size: 32 });
  hookAt = getContractAddress({ opcode: "CREATE2", from: A.create2Factory, salt, bytecodeHash: initHash });
  if ((BigInt(hookAt) & 0x3fffn) === HOOK_FLAGS) break;
}
if ((await pub.getCode({ address: hookAt })) !== undefined) throw new Error(`Code already at the mined hook address ${hookAt}. Nothing more was sent.`);
{
  const hookData = concat([salt, hookInit]);
  const hookGas = withHeadroom(await pub.estimateGas({ account: deployerWallet.account, to: A.create2Factory, data: hookData }));
  const hash = await deployerWallet.sendTransaction({ to: A.create2Factory, data: hookData, gas: hookGas, chain, account: deployerWallet.account });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success" || !(await pub.getCode({ address: hookAt }))) throw new Error(`hook deployment failed (${hash})`);
  spent += r.gasUsed * r.effectiveGasPrice;
  console.log(`deployed hook      ${hookAt} (${hash}, gas ${r.gasUsed}, salt ${salt})`);
}
const buyback = await deploy("buyback", rc.orryBuybackAbi as Abi, rc.orryBuybackBytecode, [v1.treasury, routerAt, hookAt, A.usdg, A.poolManager, hop1.map((h) => h.key), P.maxSliceUsdgCap, P.cashbackBps]);
const router = await deploy("router", rc.orryRewardsRouterAbi as Abi, rc.orryRewardsRouterBytecode, [orry, staking.address, buyback.address, hookAt, P.stakersBps, P.routerInterval]);
if (!isAddressEqual(buyback.address, buybackAt) || !isAddressEqual(router.address, routerAt)) {
  throw new Error(`Address prediction failed (buyback ${buyback.address} vs ${buybackAt}, router ${router.address} vs ${routerAt}): the hook points at the wrong router. Do not use these contracts.`);
}
const factory = await deploy("factory", rc.earnVaultFactoryAbi as Abi, rc.earnVaultFactoryBytecode, [hookAt]);
await call(factory.address, rc.earnVaultFactoryAbi as Abi, "createVault", [ZERO]);
await call(factory.address, rc.earnVaultFactoryAbi as Abi, "createVault", [A.usdg]);
const vaultEth = await read<Address>(factory.address, rc.earnVaultFactoryAbi as Abi, "vaultOf", [ZERO]);
const vaultUsdg = await read<Address>(factory.address, rc.earnVaultFactoryAbi as Abi, "vaultOf", [A.usdg]);
console.log(`  ETH vault  ${vaultEth}\n  USDG vault ${vaultUsdg}`);
const claimAll = await deploy("claimAll", rc.claimAllAbi as Abi, rc.claimAllBytecode, [factory.address, staking.address]);
const lens = await deploy("lens", rc.orryLensAbi as Abi, rc.orryLensBytecode, [factory.address, staking.address]);

// both hubs open at their prices (header); an earlier initialization by someone else is reported, not fatal (R-21)
const hubKey = await read<PoolKey>(hookAt, rc.orreryHookAbi as Abi, "hubKey", [ZERO]);
const usdgHubKey = await read<PoolKey>(hookAt, rc.orreryHookAbi as Abi, "hubKey", [A.usdg]);
const hubPoolId = poolIdOf(hubKey);
const usdgHubPoolId = poolIdOf(usdgHubKey);
const [hubBefore] = await read<readonly [bigint, number, number, number]>(A.stateView, stateViewAbi as Abi, "getSlot0", [hubPoolId]);
const [usdgHubBefore] = await read<readonly [bigint, number, number, number]>(A.stateView, stateViewAbi as Abi, "getSlot0", [usdgHubPoolId]);
if (hubBefore === 0n) await call(A.poolManager, pmAbi as Abi, "initialize", [hubKey, ponsSqrtPrice]);
else console.log(`  ETH hub already initialized by someone else at sqrtPriceX96 ${hubBefore} (Pons ${ponsSqrtPrice}); arbitrage brings it to the market price`);
if (usdgHubBefore === 0n) await call(A.poolManager, pmAbi as Abi, "initialize", [usdgHubKey, usdgHubSqrtPrice]);
else console.log(`  USDG hub already initialized by someone else at sqrtPriceX96 ${usdgHubBefore} (planned ${usdgHubSqrtPrice}); arbitrage brings it to the market price`);

// Earn seed (review M-3): deposits bounded by the opening prices, so a pool moved in between makes them revert.
const seeded: Record<string, string> = {};
if (seedEth || seedUsdg) {
  const vaultAbi = rc.earnVaultAbi as Abi;
  const deadline = (await pub.getBlock()).timestamp + 900n;
  if (seedEth) {
    const b = depositPriceBounds(ponsSqrtPrice, 100);
    const rMax = (seedOrryEth * 102n) / 100n;
    await call(orry, erc20Abi as Abi, "approve", [vaultEth, rMax]);
    await call(vaultEth, vaultAbi, "deposit", [seedEth, rMax, 0n, b.min, b.max, deadline], seedEth);
    seeded.eth = seedEth.toString();
  }
  if (seedUsdg) {
    const b = depositPriceBounds(usdgHubSqrtPrice, 100);
    const rMax = (seedOrryUsdg * 102n) / 100n;
    await call(orry, erc20Abi as Abi, "approve", [vaultUsdg, rMax]);
    await call(A.usdg, erc20Abi as Abi, "approve", [vaultUsdg, seedUsdg]);
    await call(vaultUsdg, vaultAbi, "deposit", [seedUsdg, rMax, 0n, b.min, b.max, deadline]);
    seeded.usdg = seedUsdg.toString();
  }
}

// the treasury learns the coin and its buyback (executable after COIN_DELAY), and the quote signer when there is one
const proposal = await call(v1.treasury, rc.orreryTreasuryAbi as Abi, "proposeCoin", [orry, buyback.address]);
const proposed = parseEventLogs({ abi: rc.orreryTreasuryAbi as Abi, logs: proposal.logs, eventName: "CoinProposed" })[0] as unknown as { args: { executableAt: bigint } } | undefined;
if (!proposed) throw new Error("proposeCoin emitted no CoinProposed event.");
if (quoteSigner) await call(v1.treasury, rc.orreryTreasuryAbi as Abi, "setQuoteSigner", [quoteSigner, true]);

// ------------------------------------------------------------------ read back

const checks: [string, boolean][] = [];
const expect = (label: string, ok: boolean) => checks.push([label, ok]);
interface Pair { quote: Address; usdFeed: Address; poolId: Hex; orryIsCurrency0: boolean; initialized: boolean; registeredAt: bigint }
const [hRouter, hOrry, hPm, hTreasury, hAdmin, hLp, hFee, hCount] = await Promise.all(
  ["rewardsRouter", "orry", "poolManager", "treasury", "pairAdmin", "LP_FEE", "protocolFeePips", "pairCount"].map((f) => read<unknown>(hookAt, rc.orreryHookAbi as Abi, f)),
);
const pairEth = await read<Pair>(hookAt, rc.orreryHookAbi as Abi, "pairOf", [ZERO]);
const pairUsdg = await read<Pair>(hookAt, rc.orreryHookAbi as Abi, "pairOf", [A.usdg]);
expect("hook router", same(hRouter, router.address));
expect("hook orry", same(hOrry, orry));
expect("hook pool manager", same(hPm, A.poolManager));
expect("hook treasury and pair admin", same(hTreasury, v1.treasury) && same(hAdmin, deployer));
expect("hook fees", Number(hLp) === P.lpFee && Number(hFee) === P.protocolFeePips);
expect("two pairs registered (R-35)", BigInt(hCount as bigint) === 2n);
expect("ETH pair", pairEth.initialized && same(pairEth.usdFeed, A.ethUsdFeed) && pairEth.poolId === hubPoolId && !pairEth.orryIsCurrency0);
expect("USDG pair", pairUsdg.initialized && same(pairUsdg.usdFeed, ZERO) && pairUsdg.poolId === usdgHubPoolId && pairUsdg.orryIsCurrency0 === orryBelowUsdg);
expect("ETH hub key", same(hubKey.currency0, ZERO) && same(hubKey.currency1, orry) && hubKey.fee === P.lpFee && hubKey.tickSpacing === P.tickSpacing && same(hubKey.hooks, hookAt));
const [u0, u1] = orryBelowUsdg ? [orry, A.usdg] : [A.usdg, orry];
expect("USDG hub key", same(usdgHubKey.currency0, u0) && same(usdgHubKey.currency1, u1) && usdgHubKey.fee === P.lpFee && usdgHubKey.tickSpacing === P.tickSpacing && same(usdgHubKey.hooks, hookAt));
const [bTreasury, bRouter, bHook, bOrry, bUsdg] = await Promise.all(["treasury", "rewardsRouter", "hook", "orry", "usdg"].map((f) => read<unknown>(buyback.address, rc.orryBuybackAbi as Abi, f)));
expect("buyback wiring", same(bTreasury, v1.treasury) && same(bRouter, router.address) && same(bHook, hookAt) && same(bOrry, orry) && same(bUsdg, A.usdg));
const [bCashBps, bSink] = await Promise.all(["CASHBACK_BPS", "cashbackSink"].map((f) => read<unknown>(buyback.address, rc.orryBuybackAbi as Abi, f)));
expect("buyback cashback 10%, sink unset (B-1)", Number(bCashBps) === P.cashbackBps && same(bSink, ZERO));
const [rOrry, rStaking, rBuyback, rBps, rInterval] = await Promise.all(["orry", "staking", "buyback", "STAKERS_BPS", "MIN_INTERVAL"].map((f) => read<unknown>(router.address, rc.orryRewardsRouterAbi as Abi, f)));
expect("router wiring", same(rOrry, orry) && same(rStaking, staking.address) && same(rBuyback, buyback.address) && Number(rBps) === P.stakersBps && BigInt(rInterval as bigint) === P.routerInterval);
expect("router hook", same(await read<Address>(router.address, rc.orryRewardsRouterAbi as Abi, "hook"), hookAt));
const [sOrry, sRegistry, sPlain, sAgent, sStream] = await Promise.all(["orry", "identityRegistry", "PLAIN_COOLDOWN", "AGENT_COOLDOWN", "STREAM_PERIOD"].map((f) => read<unknown>(staking.address, rc.orryStakingAbi as Abi, f)));
expect("staking wiring", same(sOrry, orry) && same(sRegistry, A.registry) && BigInt(sPlain as bigint) === P.plainCooldown && BigInt(sAgent as bigint) === P.agentCooldown && BigInt(sStream as bigint) === P.streamPeriod);
const [fHook, fCount, fPredEth, fPredUsdg] = await Promise.all([
  read<Address>(factory.address, rc.earnVaultFactoryAbi as Abi, "hook"),
  read<bigint>(factory.address, rc.earnVaultFactoryAbi as Abi, "vaultCount"),
  read<Address>(factory.address, rc.earnVaultFactoryAbi as Abi, "predictVault", [ZERO]),
  read<Address>(factory.address, rc.earnVaultFactoryAbi as Abi, "predictVault", [A.usdg]),
]);
expect("factory wiring and both vaults", same(fHook, hookAt) && fCount === 2n && same(fPredEth, vaultEth) && same(fPredUsdg, vaultUsdg));
for (const [name, v, q] of [["ETH vault", vaultEth, ZERO], ["USDG vault", vaultUsdg, A.usdg]] as const) {
  const [vHook, vOrry, vQuote] = await Promise.all(["hook", "orry", "quote"].map((f) => read<unknown>(v, rc.earnVaultAbi as Abi, f)));
  expect(`${name} wiring`, same(vHook, hookAt) && same(vOrry, orry) && same(vQuote, q));
}
for (const [name, addr, abi] of [["claimAll", claimAll.address, rc.claimAllAbi], ["lens", lens.address, rc.orryLensAbi]] as const) {
  const [e, s] = await Promise.all(["earnFactory", "staking"].map((f) => read<unknown>(addr, abi as Abi, f)));
  expect(`${name} wiring`, same(e, factory.address) && same(s, staking.address));
}
const [hubSqrt] = await read<readonly [bigint, number, number, number]>(A.stateView, stateViewAbi as Abi, "getSlot0", [hubPoolId]);
const [usdgHubSqrt] = await read<readonly [bigint, number, number, number]>(A.stateView, stateViewAbi as Abi, "getSlot0", [usdgHubPoolId]);
expect("ETH hub price set", hubSqrt !== 0n);
expect("USDG hub price set", usdgHubSqrt !== 0n);
for (const [name, q, before] of [["ETH", ZERO, hubBefore], ["USDG", A.usdg, usdgHubBefore]] as const) {
  const [obsNewest, obsCount] = await read<readonly [number, number]>(hookAt, rc.orreryHookAbi as Abi, "observationIndex", [q]);
  expect(`${name} hub oracle started (R-28)`, before !== 0n || (Number(obsNewest) === 0 && Number(obsCount) === 1));
}
expect("treasury coin still unset", same(await read<Address>(v1.treasury, rc.orreryTreasuryAbi as Abi, "orry"), ZERO));
if (quoteSigner) expect("quote signer", (await read<boolean>(v1.treasury, rc.orreryTreasuryAbi as Abi, "isQuoteSigner", [quoteSigner])) === true);
for (const [label, ok] of checks) console.log(`read back ${ok ? "ok  " : "FAIL"} ${label}`);
console.log(`ETH hub sqrtPriceX96 ${hubSqrt} (Pons ${ponsSqrtPrice}); USDG hub sqrtPriceX96 ${usdgHubSqrt} (planned ${usdgHubSqrtPrice}); coin executable at ${new Date(Number(proposed.args.executableAt) * 1000).toISOString()}`);
console.log(`spent ${formatEther(spent)} ETH`);
if (checks.some(([, ok]) => !ok)) throw new Error("A read-back does not match. Do not configure the API or the web; check the deployment above.");

const out = {
  chainId: 4663, deployBlock: staking.block.toString(), orry, treasury: v1.treasury, attestor: v1.attestor,
  staking: staking.address, hook: hookAt, hookSalt: salt, buyback: buyback.address, router: router.address, earnFactory: factory.address,
  vaultEth, vaultUsdg, claimAll: claimAll.address, lens: lens.address, ethUsdFeed: A.ethUsdFeed,
  hubKey, hubPoolId, usdgHubKey, usdgHubPoolId, ponsPoolKey: ponsKey, usdPoolId: poolIdOf(usdPool.key), hop1Pools: hop1.map((h) => h.key), params: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v.toString()])),
  quoteSigner: quoteSigner ?? null, seeded, coinExecutableAt: proposed.args.executableAt.toString(), deployer, spentEth: formatEther(spent),
};
mkdirSync(DEPLOYMENTS, { recursive: true });
writeFileSync(join(DEPLOYMENTS, `orry-${TAG}.json`), JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
console.log(`wrote deployments/orry-${TAG}.json
API (features stay held until ORRERY_ORRY_FEATURES opens them):
  ORRERY_ORRY_TOKEN=${orry} ORRERY_ORRY_HOOK=${hookAt} ORRERY_ORRY_EARN_FACTORY=${factory.address} ORRERY_ORRY_STAKING=${staking.address}
  ORRERY_ORRY_ROUTER=${router.address} ORRERY_ORRY_BUYBACK=${buyback.address} ORRERY_ORRY_LENS=${lens.address} ORRERY_ORRY_CLAIM_ALL=${claimAll.address}
  ORRERY_ORRY_TREASURY=${v1.treasury} ORRERY_ORRY_USD_POOL_ID=${poolIdOf(usdPool.key)} ORRERY_ORRY_START_BLOCK=${staking.block}
web:
  NEXT_PUBLIC_ORRY_TOKEN=${orry} NEXT_PUBLIC_ORRY_EARN_FACTORY=${factory.address} NEXT_PUBLIC_ORRY_STAKING=${staking.address}
  NEXT_PUBLIC_ORRY_CLAIM_ALL=${claimAll.address} NEXT_PUBLIC_ORRY_REWARDS_ROUTER=${router.address} NEXT_PUBLIC_ORRY_TREASURY=${v1.treasury}
Next: scripts/deploy-orry-4663.ts --execute-coin${FORK ? " --fork" : ""} after the time above.`);
