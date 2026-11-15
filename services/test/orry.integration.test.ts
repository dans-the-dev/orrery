import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  getAbiItem,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toFunctionSelector,
  toHex,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  ORRY_FEATURES,
  RELEASE_FEATURES,
  OrryApi,
  creditsQuoteTypes,
  iEarnVaultAbi,
  iEarnVaultFactoryAbi,
  iOrryBurnEventsAbi,
  iOrryBuybackAbi,
  iOrryLensAbi,
  iOrryRewardsRouterAbi,
  iOrryStakingAbi,
  iOrreryHookAbi,
  orreryAttestorAbi,
  maskAddress,
  orreryLensAbi,
  poolManagerAbi,
  poolStateSlot,
  orryCalls,
  treasuryDomain,
  verifyCheck,
  verifyQuote,
  type CheckResponse,
  type OrryChecksQuoteResponse,
  type OrryCreditsQuoteResponse,
  type ReleasesResponse,
  type OrryVerificationQuoteResponse,
} from "@orrery/sdk";
import {
  buildApi,
  buildCheck,
  connect,
  indexOrryOnce,
  loadConfig,
  makeChain,
  migrate,
  orryLag,
  runKeeperOnce,
  sampleOnce,
  setRelease,
  snapshotAccounts,
  toJson,
  type Config,
  type Sql,
} from "@orrery/server";
import { quoteTreasuryStandInAbi, quoteTreasuryStandInBytecode, orryStandInAbi, orryStandInBytecode } from "./generated/standins.js";

const erc20Meta = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]) as Abi;
import { DATABASE_URL, RPC } from "./env.js";

/**
 * ORRY services against stand-ins of the frozen ABIs (lanes A and B are unmerged): every event is emitted with the
 * exact topics and data of `orry-abi.ts`, every view answers with an ABI-encoded result. The quote treasury stand-in
 * checks the EIP-712 quotes on chain with the type strings written in `IOrreryTreasury`.
 */

const pub = createPublicClient({ chain: foundry, transport: http(RPC) }) as PublicClient;
type W = WalletClient & { account: Account };
const w = (k: Hex) => createWalletClient({ chain: foundry, transport: http(RPC), account: privateKeyToAccount(k) }) as W;
const deployer = w("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const Q96 = 2n ** 96n;
const HUB: Hex = keccak256(toHex("hub pool"));
const USD: Hex = keccak256(toHex("eth usdg pool"));
const OTHER: Hex = keccak256(toHex("another pool"));

// in-memory keys only; nothing here is a real key
const quoteKey = generatePrivateKey();
const quoteSigner = privateKeyToAccount(quoteKey);
const checkKey = generatePrivateKey();
const checkSigner = privateKeyToAccount(checkKey);
const keeperKey = generatePrivateKey();
const buyer = w(generatePrivateKey());
const payer = w(generatePrivateKey());
const fresh = (): Address => privateKeyToAccount(generatePrivateKey()).address;
const A = fresh();
const B = fresh();
const C = fresh();
const O = fresh();

async function mined(hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash });
  expect(r.status).toBe("success");
  return r;
}

async function deploy(abi: Abi, bytecode: Hex, args: unknown[] = []): Promise<Address> {
  const hash = await deployer.deployContract({ abi, bytecode, args, chain: foundry, account: deployer.account });
  return (await mined(hash)).contractAddress!;
}

const standIn = () => deploy(orryStandInAbi as Abi, orryStandInBytecode);
const call = (to: Address, fn: string, args: unknown[]) =>
  deployer.writeContract({ address: to, abi: orryStandInAbi, functionName: fn as never, args: args as never, chain: foundry, account: deployer.account }).then(mined);

/** Every call of `fn` answers `result`. */
const answer = (to: Address, abi: Abi, fn: string, result: unknown) =>
  call(to, "setResponse", [toFunctionSelector(getAbiItem({ abi, name: fn }) as never), encodeFunctionResult({ abi, functionName: fn, result } as never)]);
/** Calls of `fn(args)` answer `result`. */
const answerFor = (to: Address, abi: Abi, fn: string, args: unknown[], result: unknown) =>
  call(to, "setResponseFor", [encodeFunctionData({ abi, functionName: fn, args } as never), encodeFunctionResult({ abi, functionName: fn, result } as never)]);
const revertWith = (to: Address, abi: Abi, fn: string, error: string, args: unknown[] = []) =>
  call(to, "setRevert", [toFunctionSelector(getAbiItem({ abi, name: fn }) as never), encodeErrorResult({ abi, errorName: error, args } as never), true]);

/** Emits `event` from the stand-in with the frozen ABI's topics and data. */
async function emit(from: Address, abi: Abi, event: string, args: Record<string, unknown>) {
  const item = getAbiItem({ abi, name: event }) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName: event, args } as never) as Hex[];
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name]) as never);
  return call(from, "emitLog", [topics, data]);
}

const slotWord = (sqrt: bigint) => `0x${sqrt.toString(16).padStart(64, "0")}` as Hex;
const mine = (n: number) => pub.request({ method: "anvil_mine" as never, params: [toHex(n)] as never });

let hook: Address, vault: Address, staking: Address, router: Address, buyback: Address, lens: Address, pm: Address, token: Address, factory: Address;
let treasury: Address, attestor: Address, orreryLens: Address;
let cfg: Config;
let sql: Sql;
let app: ReturnType<typeof buildApi>;
let baseUrl: string;
let api: OrryApi;

function env(extra: Record<string, string> = {}) {
  return {
    ORRERY_CHAIN_ID: "31337",
    ORRERY_RPC_URL: RPC,
    ORRERY_DATABASE_URL: DATABASE_URL,
    ORRERY_MODULE: orreryLens,
    ORRERY_ATTESTOR: attestor,
    ORRERY_LENS: orreryLens,
    ORRERY_REGISTRY: orreryLens,
    ORRERY_USDG: orreryLens,
    ORRERY_TREASURY: treasury,
    ORRERY_CONFIRMATIONS: "2",
    ORRERY_CHECK_SIGNER_KEY: checkKey,
    ORRERY_ORRY_TOKEN: token,
    ORRERY_ORRY_HOOK: hook,
    ORRERY_ORRY_EARN_FACTORY: factory,
    ORRERY_ORRY_STAKING: staking,
    ORRERY_ORRY_ROUTER: router,
    ORRERY_ORRY_BUYBACK: buyback,
    ORRERY_ORRY_LENS: lens,
    ORRERY_POOL_MANAGER: pm,
    ORRERY_ORRY_USD_POOL_ID: USD,
    ORRERY_QUOTE_SIGNER_KEY: quoteKey,
    ORRERY_ORRY_CACHE_MS: "0",
    ORRERY_RELEASES_CACHE_MS: "0",
    ORRERY_ORRY_MIN_SAMPLES: "5",
    ORRERY_QUOTE_RATE_PER_MINUTE: "600",
    ORRERY_PUBLIC_RATE_PER_MINUTE: "600",
    ...extra,
  };
}

async function catchUp() {
  await mine(3);
  let r;
  do r = await indexOrryOnce(cfg, makeChain(cfg), sql, { range: 40n });
  while (r.lag > BigInt(cfg.confirmations));
  return r;
}

const zeroClaimables = { earn: [], stakeActive: 0n, stakeLeaving: 0n, stakeReadyAt: 0n, stakeRewardsEth: 0n, stakeRewardsOrry: 0n };
const ETH: Address = "0x0000000000000000000000000000000000000000";
const USDHUB: Hex = keccak256(toHex("orry usdg hub"));
const pair = (quote: Address, poolId: Hex, orryIsCurrency0: boolean) => ({ quote, usdFeed: ETH, poolId, orryIsCurrency0, initialized: true, registeredAt: 1n });

beforeAll(async () => {
  const startBlock = await pub.getBlockNumber();
  const ins: Address[] = [];
  for (let i = 0; i < 11; i++) ins.push(await standIn()); // one at a time: one deployer nonce
  [hook, vault, staking, router, buyback, lens, pm, token, attestor, orreryLens, factory] = ins as [Address, Address, Address, Address, Address, Address, Address, Address, Address, Address, Address];
  treasury = await deploy(quoteTreasuryStandInAbi as Abi, quoteTreasuryStandInBytecode, [quoteSigner.address]);
  for (const to of [buyer.account.address, payer.account.address, privateKeyToAccount(keeperKey).address]) {
    await mined(await deployer.sendTransaction({ to, value: parseEther("1"), chain: foundry, account: deployer.account }));
  }

  // one hub so far, ORRY/ETH; spot prices: hub 1e6 ORRY per ETH, USD pool sqrt 2^81 (2^-30 USDG base units per wei)
  await answer(hook, iOrreryHookAbi as Abi, "pairCount", 1n);
  await answerFor(hook, iOrreryHookAbi as Abi, "pairAt", [0n], pair(ETH, HUB, false));
  await answer(hook, iOrreryHookAbi as Abi, "pendingProtocolFee", 0n);
  await answer(factory, iEarnVaultFactoryAbi as Abi, "vaultCount", 1n);
  await answerFor(factory, iEarnVaultFactoryAbi as Abi, "vaultAt", [0n], vault);
  await answer(factory, iEarnVaultFactoryAbi as Abi, "vaults", [vault]);
  await answer(vault, iEarnVaultAbi as Abi, "quote", ETH);
  await answer(token, erc20Meta, "symbol", "ORRY");
  await answer(token, erc20Meta, "decimals", 18);
  await answer(orreryLens, erc20Meta, "symbol", "USDG"); // ORRERY_USDG points at this stand-in
  await answer(orreryLens, erc20Meta, "decimals", 6);
  await answerFor(pm, poolManagerAbi as Abi, "extsload", [poolStateSlot(HUB)], slotWord(1000n * Q96));
  await answerFor(pm, poolManagerAbi as Abi, "extsload", [poolStateSlot(USD)], slotWord(2n ** 81n));
  await answer(vault, iEarnVaultAbi as Abi, "positionAmounts", [3n * 10n ** 18n, 4n * 10n ** 24n]);
  await answer(vault, iEarnVaultAbi as Abi, "totalShares", 12_345n);
  await answer(staking, iOrryStakingAbi as Abi, "totalEarning", 540n);
  await answer(lens, iOrryLensAbi as Abi, "claimables", zeroClaimables);
  await answer(lens, iOrryLensAbi as Abi, "agentClaimables", []);

  cfg = loadConfig({ ...env(), ORRERY_ORRY_START_BLOCK: startBlock.toString() });
  sql = connect(cfg.databaseUrl);
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrate(sql);
  app = buildApi(cfg, makeChain(cfg), sql);
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  api = new OrryApi(baseUrl);
});

afterAll(async () => {
  await app?.close();
  await sql?.end();
});

describe("ORRY indexer", () => {
  it("indexes every contract's events and only the hub's swaps, at the confirmation depth", async () => {
    const S = iOrryStakingAbi as Abi;
    await emit(staking, S, "Staked", { account: A, amount: 100n });
    await emit(staking, S, "Staked", { account: B, amount: 300n });
    await emit(staking, S, "UnstakeRequested", { account: B, amount: 50n, readyAt: 1n });
    await emit(staking, S, "AgentStaked", { agentId: 7n, owner: O, staker: C, amount: 200n });
    await emit(staking, S, "AgentUnstakeRequested", { agentId: 7n, owner: O, amount: 20n, readyAt: 2n });
    await emit(staking, S, "AgentStaked", { agentId: 8n, owner: O, staker: A, amount: 10n });
    await emit(staking, S, "AgentLockExtended", { agentId: 8n, owner: O, lockedUntil: 1_900_000_000n });
    await emit(staking, S, "RewardsNotified", { from: router, ethAmount: 10n ** 15n, orryAmount: 10n ** 18n, periodFinish: 3n });
    await emit(staking, S, "RewardsClaimed", { account: B, caller: B, ethAmount: 0n, orryAmount: 5n * 10n ** 18n });
    const V = iEarnVaultAbi as Abi;
    await emit(vault, V, "Deposited", { account: A, quoteIn: 1n, orryIn: 2n, shares: 77n, unlockAt: 4n });
    await emit(vault, V, "FeesHarvested", { quoteAmount: 10n ** 15n, orryAmount: 2n * 10n ** 18n, periodFinish: 5n });
    await emit(vault, V, "FeesHarvested", { quoteAmount: 3n * 10n ** 15n, orryAmount: 4n * 10n ** 18n, periodFinish: 6n });
    await emit(vault, V, "RewardsNotified", { from: B, orryAmount: 7n * 10n ** 18n });
    await emit(vault, V, "RewardsNotified", { from: C, orryAmount: 5n * 10n ** 18n });
    await emit(vault, V, "FeesClaimed", { account: A, caller: A, quoteAmount: 10n ** 15n, orryAmount: 0n });
    await emit(vault, V, "Withdrawn", { account: A, shares: 7n, quoteOut: 1n, orryOut: 1n });
    await emit(hook, iOrreryHookAbi as Abi, "ProtocolFeesCollected", { currency: ETH, amount: 9n });
    await emit(router, [...iOrryRewardsRouterAbi, ...iOrryBurnEventsAbi] as Abi, "Burned", { source: 1, amount: 10n });
    await emit(buyback, [...iOrryBuybackAbi, ...iOrryBurnEventsAbi] as Abi, "Burned", { source: 4, amount: 20n });
    // a source an emitter may not use, and a burn from a contract that never burns: both ignored by the burn totals
    await emit(router, iOrryBurnEventsAbi as Abi, "Burned", { source: 2, amount: 999n });
    await emit(hook, iOrryBurnEventsAbi as Abi, "Burned", { source: 1, amount: 999n });
    const swap = { sender: A, amount0: -5n, amount1: 7n, sqrtPriceX96: 1000n * Q96, liquidity: 1n, tick: 0, fee: 8500 };
    await emit(pm, poolManagerAbi as Abi, "Swap", { id: HUB, ...swap });
    await emit(pm, poolManagerAbi as Abi, "Swap", { id: OTHER, ...swap });
    await call(vault, "emitLog", [[keccak256(toHex("SomethingElse()"))], "0x"]);

    const r = await catchUp();
    expect(r.lag).toBe(2n);
    const l = await orryLag(sql);
    expect(l?.lag).toBe(2n);

    const byEvent = await sql<{ source: string; event: string; n: number }[]>`select source, event, count(*)::int as n from orry_events group by 1, 2 order by 1, 2`;
    const seen = Object.fromEntries(byEvent.map((e) => [`${e.source}.${e.event}`, e.n]));
    expect(seen).toMatchObject({
      "staking.Staked": 2, "staking.AgentStaked": 2, "staking.AgentLockExtended": 1, "staking.AgentUnstakeRequested": 1, "staking.RewardsNotified": 1,
      "vault.FeesHarvested": 2, "vault.RewardsNotified": 2, "vault.Deposited": 1, "vault.Withdrawn": 1, "vault.unknown": 1, "hook.ProtocolFeesCollected": 1, "pool.Swap": 1,
    });
    const [sw] = await sql<{ id: string }[]>`select args->>'id' as id from orry_events where source = 'pool'`;
    expect(sw!.id).toBe(HUB);

    const stakers = await sql<{ address: string; plain_active: string; plain_leaving: string; agent_active: string }[]>`select * from orry_stakers order by address`;
    const st = Object.fromEntries(stakers.map((s) => [s.address, [s.plain_active, s.plain_leaving, s.agent_active]]));
    expect(st[A.toLowerCase()]).toEqual(["100", "0", "10"]);
    expect(st[B.toLowerCase()]).toEqual(["250", "50", "0"]);
    expect(st[C.toLowerCase()]).toEqual(["0", "0", "180"]);
    const [pos] = await sql`select staker, active::text, leaving::text from orry_agent_positions where agent_id = 7`;
    expect(pos).toMatchObject({ staker: C.toLowerCase(), active: "180", leaving: "20" });
    const [lock] = await sql`select locked_until::text from orry_agent_positions where agent_id = 8`;
    expect(lock!.locked_until).toBe("1900000000");
    const [shares] = await sql`select shares::text from orry_earn_shares where address = ${A.toLowerCase()} and vault = ${vault.toLowerCase()}`;
    expect(shares!.shares).toBe("70");
    const [paidEth] = await sql`select amount::text from orry_claimed where address = ${A.toLowerCase()} and asset = ${ETH}`;
    expect(paidEth!.amount).toBe("1000000000000000");
  });

  it("does not index past head minus the confirmation depth", async () => {
    await emit(router, iOrryBurnEventsAbi as Abi, "Burned", { source: 1, amount: 1n });
    await indexOrryOnce(cfg, makeChain(cfg), sql);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from orry_events where event = 'Burned' and args->>'amount' = '1'`;
    expect(n!.n).toBe(0);
    await catchUp();
    const [m] = await sql<{ n: number }[]>`select count(*)::int as n from orry_events where event = 'Burned' and args->>'amount' = '1'`;
    expect(m!.n).toBe(1);
  });
});

describe("ORRY public reads", () => {
  it("earn: vault amounts, realised fees and notified rewards over 7 days and all time, hub price", async () => {
    // the first harvest and the first notified reward happened 8 days ago
    for (const ev of ["FeesHarvested", "RewardsNotified"]) {
      await sql`update orry_events set block_time = now() - interval '8 days' where (block_number, log_index) =
        (select block_number, log_index from orry_events where source = 'vault' and event = ${ev} order by block_number, log_index limit 1)`;
    }
    const e = await api.earn();
    expect(e.decimals).toBe(18);
    expect(e.hubs).toEqual([{
      quote: { address: ETH, symbol: "ETH", decimals: 18 },
      poolId: HUB,
      initialized: true,
      vault: getAddress(vault),
      tvl: { quote: "3000000000000000000", orry: "4000000000000000000000000" },
      totalShares: "12345",
      fees7d: { quote: "3000000000000000", orry: "4000000000000000000" },
      feesAllTime: { quote: "4000000000000000", orry: "6000000000000000000" },
      notified7d: "5000000000000000000",
      notifiedAllTime: "12000000000000000000",
      orryPerQuote: "1000000000000000000000000",
    }]);
    expect(Date.parse(e.updatedAt)).toBeGreaterThan(0);
  });

  it("stake: total earning from the chain, notified rewards, stakers", async () => {
    expect(await api.stake()).toMatchObject({
      decimals: 18,
      totalEarning: "540",
      rewards7d: { eth: "1000000000000000", orry: "1000000000000000000" },
      rewardsAllTime: { eth: "1000000000000000", orry: "1000000000000000000" },
      stakers: 3,
    });
  });

  it("leaderboard of stakers: ranked, masked, never a full address", async () => {
    const r = await fetch(`${baseUrl}/v1/orry/leaderboard?kind=stakers&limit=10`);
    const text = await r.text();
    for (const a of [A, B, C]) {
      expect(text.toLowerCase()).not.toContain(a.toLowerCase().slice(2));
    }
    const rows = JSON.parse(text);
    expect(rows.map((x: { stake: string }) => x.stake)).toEqual(["250", "180", "110"]);
    expect(rows[0]).toEqual({ rank: 1, address: `${B.toLowerCase().slice(0, 6)}…${B.toLowerCase().slice(-4)}`, decimals: 18, stake: "250" });
    for (const row of rows) expect(row.address).toMatch(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/);
  });

  it("leaderboard of earners: claimed plus pending per asset, ranked by value in ORRY at the hub prices", async () => {
    await answerFor(lens, iOrryLensAbi as Abi, "claimables", [C], { ...zeroClaimables, stakeRewardsEth: 2n * 10n ** 15n });
    await catchUp(); // pending is read at the indexer's cursor block, so it must pass the answer's block
    expect(await snapshotAccounts(cfg, makeChain(cfg), sql)).toBe(3);
    expect(await snapshotAccounts(cfg, makeChain(cfg), sql)).toBe(0); // nothing dirty, nothing stale
    const rows = await api.leaderboard("earners", 10);
    // C: 2e15 wei = 2e21 ORRY at 1e6 ORRY per ETH; A: 1e15 wei = 1e21 ORRY; B: 5e18 ORRY
    const earned = (orry: string, eth: string) => [
      { asset: getAddress(token), symbol: "ORRY", decimals: 18, amount: orry },
      { asset: ETH, symbol: "ETH", decimals: 18, amount: eth },
    ];
    expect(rows.map((r) => r.earned)).toEqual([earned("0", "2000000000000000"), earned("0", "1000000000000000"), earned("5000000000000000000", "0")]);
    expect(rows.map((r) => r.valueOrry)).toEqual(["2000000000000000000000", "1000000000000000000000", "5000000000000000000"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(JSON.stringify(rows).toLowerCase()).not.toContain(C.toLowerCase().slice(2));
  });

  it("accounts: lens claimables, agent positions, earned all time", async () => {
    await answerFor(lens, iOrryLensAbi as Abi, "agentClaimables", [C, [7n], [O]], [
      { agentId: 7n, owner: O, active: 180n, leaving: 20n, leavingAt: 999n, reportedForAgent: true },
    ]);
    await catchUp();
    const c = await api.account(C);
    expect(c).toMatchObject({
      address: C,
      decimals: 18,
      stakeRewardsEth: "2000000000000000",
      earn: [],
      agentPositions: [{ agentId: "7", owner: O, active: "180", leaving: "20", leavingAt: 999, reportedForAgent: true }],
      earnedAllTime: [
        { asset: getAddress(token), symbol: "ORRY", decimals: 18, amount: "0" },
        { asset: ETH, symbol: "ETH", decimals: 18, amount: "2000000000000000" },
      ],
    });
    // Earn positions come from the lens, one per vault
    await answerFor(lens, iOrryLensAbi as Abi, "claimables", [A], {
      ...zeroClaimables,
      earn: [{ vault, quote: ETH, shares: 70n, unlockAt: 4n, feesQuote: 5n, feesOrry: 6n, positionQuote: 7n, positionOrry: 8n }],
    });
    await catchUp();
    const a = await api.account(A);
    expect(a.earn).toEqual([{ vault: getAddress(vault), quote: { address: ETH, symbol: "ETH", decimals: 18 }, shares: "70", unlockAt: 4, fees: { quote: "5", orry: "6" }, position: { quote: "7", orry: "8" } }]);
    expect(a.earnedAllTime.map((x) => [x.symbol, x.amount])).toEqual([["ORRY", "6"], ["ETH", "1000000000000005"]]);
    expect((await fetch(`${baseUrl}/v1/orry/accounts/0x1234`)).status).toBe(400);
  });

  it("burns: totals by source, only valid sources counted", async () => {
    const b = await api.burns(10);
    expect(b.bySource).toEqual({ "1": "11", "2": "0", "3": "0", "4": "20", "5": "0", "6": "0", "7": "0" });
    expect(b.total).toBe("31");
    expect(b.items[0]).toMatchObject({ source: 1, amount: "1" });
    expect(b.items.every((i) => /^0x[0-9a-f]{64}$/.test(i.tx) && i.time > 0 && i.block > 0)).toBe(true);
    expect((await fetch(`${baseUrl}/v1/orry/burns?limit=0`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/v1/orry/leaderboard?kind=whales`)).status).toBe(400);
  });
});

describe("ORRY checkout quotes", () => {
  it("refuses to quote before the 30 minute window holds enough samples", async () => {
    const r = await fetch(`${baseUrl}/v1/orry/quotes/credits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ buyer: buyer.account.address, packs: 1 }) });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toMatch(/sampled/);
  });

  it("samples the ETH path (no ORRY/USDG hub yet) at most once per interval", async () => {
    expect(await sampleOnce(cfg, makeChain(cfg), sql)).toBe(true);
    expect(await sampleOnce(cfg, makeChain(cfg), sql)).toBe(false);
    const [s] = await sql`select hub_sqrt::text, usd_sqrt::text, ratio_num::text, ratio_den::text from orry_price_samples`;
    expect(s).toEqual({
      hub_sqrt: (1000n * Q96).toString(), usd_sqrt: (2n ** 81n).toString(),
      ratio_num: (1000n * Q96 * 1000n * Q96).toString(), ratio_den: (2n ** 162n).toString(),
    });
  });

  async function samples(hubSqrt: bigint) {
    await sql`delete from orry_price_samples`;
    const usd = 2n ** 81n;
    for (let i = 0; i < 6; i++) {
      await sql`insert into orry_price_samples (sampled_at, block_number, hub_sqrt, usd_sqrt, ratio_num, ratio_den)
        values (now() - make_interval(mins => ${i * 4}), 1, ${hubSqrt.toString()}, ${usd.toString()}, ${(hubSqrt * hubSqrt).toString()}, ${(usd * usd).toString()})`;
    }
    // older than the window: never counted
    const old = 10_000n * Q96;
    await sql`insert into orry_price_samples (sampled_at, block_number, hub_sqrt, usd_sqrt, ratio_num, ratio_den)
      values (now() - interval '31 minutes', 1, ${old.toString()}, ${usd.toString()}, ${(old * old).toString()}, ${(usd * usd).toString()})`;
  }

  const quote = (packs: number) =>
    fetch(`${baseUrl}/v1/orry/quotes/credits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ buyer: buyer.account.address, packs }) });

  it("prices at the lower ORRY price of spot and the 30 minute median", async () => {
    // median ORRY dearer than spot (fewer ORRY per ETH): spot is lower, spot is used
    await samples(900n * Q96);
    let q = (await (await quote(1)).json()) as OrryCreditsQuoteResponse;
    expect(q.price.basis).toBe("spot");
    expect(q.quote.orryAmount).toBe((10n ** 12n * 2n ** 30n).toString()); // 1 USDG at 1e6 × 2^30 ORRY units per USDG unit
    expect(q.price.orryPerUsd).toBe((10n ** 12n * 2n ** 30n).toString());
    // spot pumped above the median (a buyer pushing ORRY up to pay less): the median is lower and is used
    await samples(1100n * Q96);
    q = (await (await quote(1)).json()) as OrryCreditsQuoteResponse;
    expect(q.price).toMatchObject({ basis: "median", samples: 6, windowSeconds: 1800 });
    expect(q.quote.orryAmount).toBe((121n * 10n ** 10n * 2n ** 30n).toString());
  });

  let paid: OrryCreditsQuoteResponse;

  it("signs a credits quote the treasury accepts once, and checks are granted once after confirmation", async () => {
    const r = await quote(2);
    expect(r.status).toBe(200);
    paid = (await r.json()) as OrryCreditsQuoteResponse;
    const head = await pub.getBlock();
    expect(paid.quote.expiry - Number(head.timestamp)).toBeLessThanOrEqual(120);
    expect(paid).toMatchObject({ kind: "credits", credits: "1250", signer: quoteSigner.address, usdValue: "2000000", usdDecimals: 6, decimals: 18 });
    expect(paid.domain).toEqual(treasuryDomain(31337, getAddress(treasury)));
    expect(await verifyQuote(pub, treasury, paid, { sender: buyer.account.address })).toEqual({ ok: true });
    expect((await verifyQuote(pub, treasury, paid, { sender: payer.account.address })).reason).toBe("quote is for another address");

    await mined(await buyer.sendTransaction({ to: treasury, data: orryCalls.burnForCredits(paid), chain: foundry, account: buyer.account }));
    await expect(buyer.sendTransaction({ to: treasury, data: orryCalls.burnForCredits(paid), chain: foundry, account: buyer.account })).rejects.toThrow();
    expect((await verifyQuote(pub, treasury, paid)).reason).toBe("quote already used");

    await catchUp();
    const [acct] = await sql`select credits::text from credit_accounts where address = ${buyer.account.address.toLowerCase()}`;
    expect(acct!.credits).toBe("1250");
    const [g] = await sql`select matched, credits::text from orry_credit_grants where quote_id = ${paid.quote.quoteId.toLowerCase()}`;
    expect(g).toEqual({ matched: true, credits: "1250" });

    // re-indexing the same blocks grants nothing twice
    await sql`update indexer_state set last_block = ${(cfg.orry!.startBlock).toString()} where id = 'orry'`;
    await catchUp();
    const [again] = await sql`select credits::text from credit_accounts where address = ${buyer.account.address.toLowerCase()}`;
    expect(again!.credits).toBe("1250");
    const derived = await sql`select address, (plain_active + agent_active)::text as earning from orry_stakers order by address`;
    expect(Object.fromEntries(derived.map((d) => [d.address, d.earning]))).toEqual({
      [A.toLowerCase()]: "110", [B.toLowerCase()]: "250", [C.toLowerCase()]: "180",
    });
    const [shares] = await sql`select shares::text from orry_earn_shares where address = ${A.toLowerCase()}`;
    expect(shares!.shares).toBe("70");
    const [paidEth] = await sql`select amount::text from orry_claimed where address = ${A.toLowerCase()} and asset = ${ETH}`;
    expect(paidEth!.amount).toBe("1000000000000000");

    // the buyer takes an API key with the signed rotation message and sees the checks
    const n = (await (await fetch(`${baseUrl}/v1/keys/nonce?address=${buyer.account.address}`)).json()) as { nonce: string; message: string };
    const signature = await buyer.signMessage({ account: buyer.account, message: n.message });
    const k = (await (
      await fetch(`${baseUrl}/v1/keys/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: buyer.account.address, nonce: n.nonce, signature }) })
    ).json()) as { apiKey: string };
    const c = (await (await fetch(`${baseUrl}/v1/credits`, { headers: { authorization: `Bearer ${k.apiKey}` } })).json()) as { credits: string };
    expect(c.credits).toBe("1250");
  });

  it("a CreditsPaid for a quote the API never issued grants nothing", async () => {
    const head = await pub.getBlock();
    const forged = { buyer: buyer.account.address, packs: 50, orryAmount: 1n, quoteId: keccak256(toHex("not issued")), expiry: head.timestamp + 60n };
    const signature = await quoteSigner.signTypedData({ domain: treasuryDomain(31337, treasury), types: creditsQuoteTypes, primaryType: "CreditsQuote", message: forged });
    const data = encodeFunctionData({
      abi: quoteTreasuryStandInAbi,
      functionName: "burnForCredits",
      args: [forged.packs, forged.orryAmount, forged.quoteId, forged.expiry, signature],
    });
    await mined(await buyer.sendTransaction({ to: treasury, data, chain: foundry, account: buyer.account }));
    await catchUp();
    const [g] = await sql`select matched, credits::text from orry_credit_grants where quote_id = ${forged.quoteId}`;
    expect(g).toEqual({ matched: false, credits: "0" });
    const [acct] = await sql`select credits::text from credit_accounts where address = ${buyer.account.address.toLowerCase()}`;
    expect(acct!.credits).toBe("1250");
  });

  let paidChecks: OrryChecksQuoteResponse;

  it("a pay-as-you-go checks quote grants its stored credits once, never the pack rate of its packs", async () => {
    const r = await fetch(`${baseUrl}/v1/orry/quotes/checks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ buyer: buyer.account.address, checks: 3 }) });
    expect(r.status).toBe(200);
    const q = (paidChecks = (await r.json()) as OrryChecksQuoteResponse);
    // 3 checks × 2 credits at 625 credits per 1 USD of ORRY: 9,600 USDG base units, at the median price of the last samples
    expect(q).toMatchObject({ kind: "checks", checks: 3, credits: "6", usdValue: "9600", quote: { buyer: buyer.account.address, packs: 3 } });
    expect(q.quote.orryAmount).toBe((9_600n * 121n * 10n ** 4n * 2n ** 30n).toString());
    expect(await verifyQuote(pub, treasury, q, { sender: buyer.account.address })).toEqual({ ok: true });
    expect((await verifyQuote(pub, treasury, q, { sender: payer.account.address })).reason).toBe("quote is for another address");
    await mined(await buyer.sendTransaction({ to: treasury, data: orryCalls.burnForCredits(q), chain: foundry, account: buyer.account }));
    await catchUp();
    const [acct] = await sql`select credits::text from credit_accounts where address = ${buyer.account.address.toLowerCase()}`;
    expect(acct!.credits).toBe("1256"); // 6, not orryCreditsFor(3 packs) = 1,875
    const [g] = await sql`select matched, kind, credits::text from orry_credit_grants where quote_id = ${q.quote.quoteId.toLowerCase()}`;
    expect(g).toEqual({ matched: true, kind: "checks", credits: "6" });
    // re-indexing grants nothing twice
    await sql`update indexer_state set last_block = ${(cfg.orry!.startBlock).toString()} where id = 'orry'`;
    await catchUp();
    const [again] = await sql`select credits::text from credit_accounts where address = ${buyer.account.address.toLowerCase()}`;
    expect(again!.credits).toBe("1256");
  });

  it("an expired quote is refused on chain and by the SDK", async () => {
    const head = await pub.getBlock();
    const old = { buyer: buyer.account.address, packs: 1, orryAmount: 5n, quoteId: keccak256(toHex("old")), expiry: head.timestamp - 1n };
    const signature = await quoteSigner.signTypedData({ domain: treasuryDomain(31337, treasury), types: creditsQuoteTypes, primaryType: "CreditsQuote", message: old });
    await expect(
      pub.simulateContract({ address: treasury, abi: quoteTreasuryStandInAbi, functionName: "burnForCredits", args: [1, 5n, old.quoteId, old.expiry, signature], account: buyer.account }),
    ).rejects.toThrow(/QuoteExpired/);
    const unused = (await (await quote(1)).json()) as OrryCreditsQuoteResponse;
    expect((await verifyQuote(pub, treasury, unused, { now: BigInt(unused.quote.expiry) + 1n })).reason).toBe("expired quote");
    const edited: OrryCreditsQuoteResponse = { ...unused, quote: { ...unused.quote, orryAmount: "1" } };
    expect((await verifyQuote(pub, treasury, edited)).reason).toBe("signed by another key");
  });

  it("signs a verification quote; the burn is indexed as source 3", async () => {
    const q = (await (
      await fetch(`${baseUrl}/v1/orry/quotes/verification`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payer: payer.account.address, agentId: "7" }) })
    ).json()) as OrryVerificationQuoteResponse;
    expect(q).toMatchObject({ kind: "verification", usdValue: "4000000", quote: { payer: payer.account.address, agentId: "7" } });
    expect(await verifyQuote(pub, treasury, q, { sender: payer.account.address })).toEqual({ ok: true });
    await mined(await payer.sendTransaction({ to: treasury, data: orryCalls.verifyWithOrry(q, O), chain: foundry, account: payer.account }));
    await catchUp();
    const [used] = await sql`select used_tx from orry_quotes where quote_id = ${q.quote.quoteId.toLowerCase()}`;
    expect(used!.used_tx).toMatch(/^0x/);
    const b = await api.burns(5);
    expect(b.bySource["3"]).toBe(q.quote.orryAmount);
    expect(BigInt(b.bySource["2"])).toBe(BigInt(paid.quote.orryAmount) + 1n + BigInt(paidChecks.quote.orryAmount));
  });

  it("prices from the ORRY/USDG hub directly once it is registered and has a price", async () => {
    // ORRY/USDG hub: ORRY is currency0 when its address sorts first; 1 USDG base unit = 2^40 ORRY base units here
    const orryFirst = BigInt(token) < BigInt(orreryLens);
    const sqrt = orryFirst ? 2n ** 76n : 2n ** 116n; // currency1/currency0 = 2^-40 or 2^40 (in Q192)
    await answerFor(hook, iOrreryHookAbi as Abi, "pairAt", [1n], pair(orreryLens, USDHUB, orryFirst));
    await answer(hook, iOrreryHookAbi as Abi, "pairCount", 2n);
    await answerFor(pm, poolManagerAbi as Abi, "extsload", [poolStateSlot(USDHUB)], slotWord(sqrt));
    await sql`delete from orry_price_samples`;
    expect(await sampleOnce(cfg, makeChain(cfg), sql)).toBe(true);
    const [s] = await sql`select usd_sqrt::text, div(ratio_num, ratio_den)::text as r from orry_price_samples`;
    expect(s).toEqual({ usd_sqrt: "0", r: (2n ** 40n).toString() });
    for (let i = 1; i < 5; i++) {
      await sql`insert into orry_price_samples (sampled_at, block_number, hub_sqrt, usd_sqrt, ratio_num, ratio_den)
        values (now() - make_interval(mins => ${i}), 1, ${sqrt.toString()}, 0, ${(2n ** 40n).toString()}, 1)`;
    }
    const q = (await (await quote(1)).json()) as OrryCreditsQuoteResponse;
    expect(q.quote.orryAmount).toBe((10n ** 6n * 2n ** 40n).toString()); // 1 USDG
    expect(q.price).toMatchObject({ basis: "spot", orryPerUsd: (10n ** 6n * 2n ** 40n).toString() });
    // the Earn route now lists both hubs; the USDG hub has no vault yet
    let e = await api.earn();
    expect(e.hubs.map((h) => [h.quote.symbol, h.vault === null, h.initialized])).toEqual([["ETH", false, true], ["USDG", true, true]]);
    expect(e.hubs[1]!.orryPerQuote).toBe((10n ** 6n * 2n ** 40n).toString());

    // the factory creates the USDG vault: its events are indexed, its fees are paid in USDG, and the USDG hub's swaps count
    const usdgVault = await standIn();
    await answer(usdgVault, iEarnVaultAbi as Abi, "quote", orreryLens);
    await answer(usdgVault, iEarnVaultAbi as Abi, "positionAmounts", [5_000_000n, 9n * 10n ** 18n]);
    await answer(usdgVault, iEarnVaultAbi as Abi, "totalShares", 33n);
    await answerFor(factory, iEarnVaultFactoryAbi as Abi, "vaultAt", [1n], usdgVault);
    await answer(factory, iEarnVaultFactoryAbi as Abi, "vaults", [vault, usdgVault]);
    await answer(factory, iEarnVaultFactoryAbi as Abi, "vaultCount", 2n);
    const V = iEarnVaultAbi as Abi;
    await emit(usdgVault, V, "Deposited", { account: B, quoteIn: 1_000_000n, orryIn: 1n, shares: 33n, unlockAt: 9n });
    await emit(usdgVault, V, "FeesHarvested", { quoteAmount: 40_000n, orryAmount: 3n, periodFinish: 9n });
    await emit(usdgVault, V, "FeesClaimed", { account: B, caller: B, quoteAmount: 12_000n, orryAmount: 2n });
    const swap = { sender: A, amount0: -5n, amount1: 7n, sqrtPriceX96: sqrt, liquidity: 1n, tick: 0, fee: 8500 };
    await emit(pm, poolManagerAbi as Abi, "Swap", { id: USDHUB, ...swap });
    await catchUp();
    const [paidUsdg] = await sql`select amount::text from orry_claimed where address = ${B.toLowerCase()} and asset = ${orreryLens.toLowerCase()}`;
    expect(paidUsdg!.amount).toBe("12000");
    const [bShares] = await sql`select shares::text from orry_earn_shares where address = ${B.toLowerCase()} and vault = ${usdgVault.toLowerCase()}`;
    expect(bShares!.shares).toBe("33");
    const [hubSwaps] = await sql<{ n: number }[]>`select count(*)::int as n from orry_events where source = 'pool' and args->>'id' = ${USDHUB}`;
    expect(hubSwaps!.n).toBe(1);
    e = await api.earn();
    expect(e.hubs[1]).toMatchObject({
      quote: { address: getAddress(orreryLens), symbol: "USDG", decimals: 6 }, vault: getAddress(usdgVault),
      tvl: { quote: "5000000", orry: (9n * 10n ** 18n).toString() }, totalShares: "33", feesAllTime: { quote: "40000", orry: "3" },
      notified7d: "0", notifiedAllTime: "0", // the ETH vault's notified ORRY stays on the ETH hub
    });
    // B's earned all time lists USDG after ORRY and ETH; the earners board values it at the USDG hub's price
    const b = await api.account(B);
    expect(b.earnedAllTime.map((x) => [x.symbol, x.amount])).toEqual([["ORRY", "5000000000000000002"], ["ETH", "0"], ["USDG", "12000"]]);
    await sql`update orry_accounts set snapshot_at = now() - interval '1 day'`;
    await snapshotAccounts(cfg, makeChain(cfg), sql);
    const row = (await api.leaderboard("earners", 10)).find((r) => r.address === maskAddress(B))!;
    expect(row.valueOrry).toBe((5n * 10n ** 18n + 2n + 12_000n * 2n ** 40n).toString());
  });

  it("rejects malformed quote requests", async () => {
    const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/v1/orry/quotes/credits", { buyer: buyer.account.address, packs: 0 })).status).toBe(400);
    expect((await post("/v1/orry/quotes/credits", { buyer: buyer.account.address, packs: 101 })).status).toBe(400);
    expect((await post("/v1/orry/quotes/credits", { buyer: "0x12", packs: 1 })).status).toBe(400);
    expect((await post("/v1/orry/quotes/credits", { buyer: buyer.account.address, packs: 1, orryAmount: "1" })).status).toBe(400);
    expect((await post("/v1/orry/quotes/verification", { payer: payer.account.address, agentId: "-1" })).status).toBe(400);
    expect((await post("/v1/orry/quotes/checks", { buyer: buyer.account.address, checks: 0 })).status).toBe(400);
    expect((await post("/v1/orry/quotes/checks", { buyer: buyer.account.address, checks: 1_001 })).status).toBe(400);
    expect((await post("/v1/orry/quotes/checks", { buyer: buyer.account.address, checks: 1.5 })).status).toBe(400);
    expect((await post("/v1/orry/quotes/checks", { buyer: buyer.account.address, checks: 1, credits: "100" })).status).toBe(400);
  });
});

describe("runtime release switch", () => {
  const BY = "test";
  const status = (method: string, path: string) =>
    fetch(`${baseUrl}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined }).then(async (r) => ({ status: r.status, body: await r.text() }));
  const unknown = () => status("GET", "/v1/orry/nothing-here");
  const gated: [string, string, string][] = [
    ["GET", "/v1/orry/earn", "earn"], ["GET", "/v1/orry/stake", "stake"], ["GET", "/v1/orry/leaderboard", "leaderboard"],
    ["GET", "/v1/orry/burns", "burn"], ["POST", "/v1/orry/quotes/credits", "checkout"], ["POST", "/v1/orry/quotes/verification", "checkout"],
    ["POST", "/v1/orry/quotes/checks", "payg-checks"], ["POST", "/v1/orry/quotes/checks", "checkout"],
  ];
  const openAll = async () => {
    for (const f of [...ORRY_FEATURES, "payg-checks"]) await setRelease(sql, f, new Date(0), BY);
  };

  it("GET /v1/releases lists every known feature, seeded open on 31337, with the server's clock", async () => {
    const r = (await (await fetch(`${baseUrl}/v1/releases`)).json()) as ReleasesResponse;
    expect(Object.keys(r.releases).sort()).toEqual([...RELEASE_FEATURES].sort());
    expect(Math.abs(Date.parse(r.serverTime) - Date.now())).toBeLessThan(5_000);
    for (const f of RELEASE_FEATURES) expect(Date.parse(r.releases[f]!), f).toBeLessThanOrEqual(Date.parse(r.serverTime));
  });

  it("a held feature answers the 404 of an unknown route, a time that passes opens it without a restart, null holds it again", async () => {
    await setRelease(sql, "burn", null, BY);
    const miss = await unknown();
    const held = await status("GET", "/v1/orry/burns");
    expect(held.status).toBe(404);
    expect(held.body).toBe(miss.body.replace("/v1/orry/nothing-here", "/v1/orry/burns"));
    expect(((await (await fetch(`${baseUrl}/v1/releases`)).json()) as ReleasesResponse).releases.burn).toBeNull();
    // scheduled: held until the server clock reaches the time, then open, with nothing else changed
    await setRelease(sql, "burn", new Date(Date.now() + 1_500), BY);
    expect((await status("GET", "/v1/orry/burns")).status).toBe(404);
    await new Promise((r) => setTimeout(r, 1_700));
    expect((await status("GET", "/v1/orry/burns")).status).toBe(200);
    await setRelease(sql, "burn", null, BY);
    expect((await status("GET", "/v1/orry/burns")).status).toBe(404);
    await openAll();
  });

  it("every gated route follows its own feature, and a feature with no row is held", async () => {
    for (const [method, path, feature] of gated) {
      await setRelease(sql, feature, null, BY);
      expect((await status(method, path)).status, `${path} held`).toBe(404);
      await setRelease(sql, feature, new Date(0), BY);
      expect((await status(method, path)).status, `${path} open`).not.toBe(404);
    }
    await sql`delete from releases where feature = 'leaderboard'`;
    expect((await status("GET", "/v1/orry/leaderboard")).status).toBe(404);
    await openAll();
  });

  it("never held: balances and positions, purchased credits and the schedule stay reachable with every feature held", async () => {
    for (const f of RELEASE_FEATURES) await setRelease(sql, f, null, BY);
    const acct = await status("GET", `/v1/orry/accounts/${A}`);
    expect(acct.status).toBe(200);
    expect(JSON.parse(acct.body)).toMatchObject({ address: A, decimals: 18 });
    expect((await status("GET", "/v1/credits")).status).toBe(401); // reachable: asks for the buyer's API key
    expect((await status("GET", "/v1/releases")).status).toBe(200);
    expect((await status("GET", "/v1/orry/earn")).status).toBe(404);
    await openAll();
  });

  it("every change leaves an audit row with the old and new time and who made it", async () => {
    const before = new Date("2030-01-01T00:00:00Z");
    await setRelease(sql, "chat", before, "ops@host");
    await setRelease(sql, "chat", null, "ops@host");
    const rows = await sql<{ opens_at: Date | null; previous: Date | null; changed_by: string }[]>`select opens_at, previous, changed_by
      from releases_audit where feature = 'chat' order by id desc limit 2`;
    expect(rows.map((r) => [r.opens_at?.toISOString() ?? null, r.previous?.toISOString() ?? null, r.changed_by])).toEqual([
      [null, before.toISOString(), "ops@host"],
      [before.toISOString(), null, "ops@host"], // held by the previous test
    ]);
    await expect(setRelease(sql, "chats", null, BY)).rejects.toThrow(/Unknown feature/);
  });

  it("the admin script sets and lists rows, and refuses unknown names and times without a zone", async () => {
    const run = (...args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        execFile("pnpm", ["exec", "tsx", "scripts/releases.ts", ...args], {
          cwd: new URL("..", import.meta.url).pathname,
          env: { ...process.env, ORRERY_DATABASE_URL: DATABASE_URL, ORRERY_RELEASE_BY: "cli-test" },
        }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }));
      });
    const held = await run("set", "burn", "null");
    expect(held.code).toBe(0);
    expect(held.out).toMatch(/^burn\s+held\s+null\s+cli-test$/m);
    expect((await status("GET", "/v1/orry/burns")).status).toBe(404);
    expect((await run("set", "burn", "2099-01-01T00:00:00Z")).out).toMatch(/^burn\s+scheduled\s+2099-01-01T00:00:00.000Z/m);
    expect((await status("GET", "/v1/orry/burns")).status).toBe(404);
    expect((await run("set", "burn", "2026-01-01T00:00:00+07:00")).out).toMatch(/^burn\s+open\s+2025-12-31T17:00:00.000Z/m);
    expect((await status("GET", "/v1/orry/burns")).status).toBe(200);
    expect((await run("set", "burns", "now")).code).toBe(2);
    expect((await run("set", "burn", "2026-11-09T13:00")).code).toBe(1);
    expect((await run("delete", "burn")).code).toBe(2);
    expect((await run("list")).out).toMatch(/^earn\s+open/m);
  });
});

describe("check result v2", () => {
  const signer = privateKeyToAccount(generatePrivateKey()).address;

  beforeAll(async () => {
    const view = {
      signer, account: A, agentId: 7n, sessionEpoch: 1n, sessionCreatedAt: 1n, owner: O, bound: true, installed: true, status: 1,
      accountKind: 1, signerIsAccountOwner: false, otherAccountModules: false, signerHasCode: false, policyHash: keccak256("0x01"),
      caps: [{ token: A, perTx: 1n, perDay: 2n, floatMax: 3n, spentToday: 0n }], targets: [], policyValidUntil: 2n ** 40n,
      increaseDelay: 3600, pendingHash: `0x${"00".repeat(32)}` as Hex, pendingReadyAt: 0n, validFor: 2n ** 40n, verified: false, paidAt: 0n,
      attestation: { observedAt: 0n, expiresAt: 0n, endpointsLive: false, registrationValid: false, domainVerified: false, registrationHash: `0x${"00".repeat(32)}` as Hex, attester: A },
    };
    await answerFor(orreryLens, orreryLensAbi as Abi, "checkBySigner", [signer], view);
    await answer(attestor, orreryAttestorAbi as Abi, "isCheckSigner", false);
    await answerFor(attestor, orreryAttestorAbi as Abi, "isCheckSigner", [checkSigner.address], true);
    await answerFor(staking, iOrryStakingAbi as Abi, "agentStake", [7n], { staker: C, active: 5n * 10n ** 18n, leaving: 10n ** 18n, leavingAt: 1234n, lockedUntil: 5678n });
  });

  it("signs version 2 with the agent's stake while stake is open; the SDK verifies it", async () => {
    const signed = await buildCheck(cfg, makeChain(cfg), sql, { signer });
    expect(signed.domain.version).toBe("2");
    const res = toJson(signed) as CheckResponse;
    const v = await verifyCheck(pub, attestor, res, { now: BigInt(res.result.issuedAt as string) });
    expect(v).toMatchObject({ ok: true, version: "2" });
    expect(v.result).toMatchObject({ stakeActive: 5n * 10n ** 18n, stakeLeaving: 10n ** 18n, stakeLeavingAt: 1234n, stakeLockedUntil: 5678n, stakedBy: C });
    const unlocked = { ...res, result: { ...res.result, stakeLockedUntil: "0" } };
    expect((await verifyCheck(pub, attestor, unlocked, { now: BigInt(res.result.issuedAt as string) })).ok).toBe(false);

    const tampered = { ...res, result: { ...res.result, stakeActive: "1" } };
    expect((await verifyCheck(pub, attestor, tampered, { now: BigInt(res.result.issuedAt as string) })).ok).toBe(false);
    const { stakeActive: _a, stakeLeaving: _b, stakeLeavingAt: _c, stakeLockedUntil: _e, stakedBy: _d, ...v1Fields } = res.result;
    const downgraded = { ...res, result: v1Fields, domain: { ...res.domain, version: "1" } };
    expect((await verifyCheck(pub, attestor, downgraded, { now: BigInt(res.result.issuedAt as string) })).ok).toBe(false);
    expect((await verifyCheck(pub, attestor, { ...res, domain: { ...res.domain, version: "3" } })).reason).toBe("unknown check version");
    expect((await verifyCheck(pub, attestor, { ...res, result: v1Fields })).reason).toBe("fields do not match the check version");
  });

  it("signs version 1 while stake is held, and version 1 still verifies", async () => {
    await setRelease(sql, "stake", null, "test");
    const signed = await buildCheck(cfg, makeChain(cfg), sql, { signer });
    await setRelease(sql, "stake", new Date(0), "test");
    expect(signed.domain.version).toBe("1");
    expect("stakeActive" in signed.result).toBe(false);
    const res = toJson(signed) as CheckResponse;
    expect(await verifyCheck(pub, attestor, res, { now: BigInt(res.result.issuedAt as string) })).toMatchObject({ ok: true, version: "1" });
  });
});

describe("keeper", () => {
  it("simulates each job and sends only those that would do something", async () => {
    await answerFor(hook, iOrreryHookAbi as Abi, "pendingProtocolFee", [ETH], 10n ** 15n);
    await answer(vault, iEarnVaultAbi as Abi, "harvest", [0n, 0n]);
    await answerFor(buyback, iOrryBuybackAbi as Abi, "maxQuoteIn", [orreryLens], 100n); // the USDG hub's quote waits in the buyback
    await answerFor(buyback, iOrryBuybackAbi as Abi, "buyWithQuote", [orreryLens], 7n);
    await answer(buyback, iOrryBuybackAbi as Abi, "executeSlice", 5n * 10n ** 18n);
    await revertWith(router, iOrryRewardsRouterAbi as Abi, "distribute", "NothingToDistribute");
    await revertWith(buyback, iOrryBuybackAbi as Abi, "burnEth", "TooSoon", [1_700_000_000n]);
    const count = (to: Address, abi: Abi, fn: string) =>
      pub.readContract({ address: to, abi: orryStandInAbi, functionName: "callCount", args: [toFunctionSelector(getAbiItem({ abi, name: fn }) as never)] });

    const dry = await runKeeperOnce(cfg, makeChain(cfg), keeperKey, { dryRun: true });
    expect(dry.map((s) => s.status)).toEqual(Array(7).fill("skipped")); // collect, harvest x2 (two vaults), slice, distribute, burnEth, buyWithQuote
    expect(await count(hook, iOrreryHookAbi as Abi, "collect")).toBe(0n);

    const steps = await runKeeperOnce(cfg, makeChain(cfg), keeperKey);
    expect(steps.map((s) => [s.action, s.status])).toEqual([
      ["collect", "sent"], ["harvest", "skipped"], ["harvest", "skipped"], ["executeSlice", "sent"], ["distribute", "skipped"], ["burnEth", "skipped"], ["buyWithQuote", "sent"],
    ]);
    expect(steps[1]).toMatchObject({ target: getAddress(vault), reason: "nothing to do" });
    expect(steps[4]!.reason).toBe("NothingToDistribute");
    expect(steps[5]!.reason).toBe("TooSoon");
    expect(steps[6]).toMatchObject({ quote: getAddress(orreryLens), result: ["7"] });
    // collect is not even simulated while the hook holds no protocol fee
    await answerFor(hook, iOrreryHookAbi as Abi, "pendingProtocolFee", [ETH], 0n);
    const idle = await runKeeperOnce(cfg, makeChain(cfg), keeperKey, { dryRun: true });
    expect(idle[0]).toMatchObject({ action: "collect", status: "skipped", reason: "nothing to do" });
    expect(await count(hook, iOrreryHookAbi as Abi, "collect")).toBe(1n);
    expect(await count(vault, iEarnVaultAbi as Abi, "harvest")).toBe(0n);
    expect(await count(buyback, iOrryBuybackAbi as Abi, "executeSlice")).toBe(1n);
    const tx = await pub.getTransaction({ hash: steps[0]!.txHash! });
    expect(tx.from.toLowerCase()).toBe(privateKeyToAccount(keeperKey).address.toLowerCase());
  });
});
