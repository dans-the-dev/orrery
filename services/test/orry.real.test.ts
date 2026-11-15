import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeEventLog, getAddress, isAddressEqual, keccak256, encodeAbiParameters, toHex, type Abi, type Address, type Hex, type Log } from "viem";
import { foundry } from "viem/chains";
import { NATIVE_ETH, OrryApi, maskAddress, orryCalls, orryPerEthFromSqrt, verifyCheck, verifyQuote, type CheckResponse } from "@orrery/sdk";
import { buildApi, buildCheck, connect, indexOrryOnce, loadConfig, makeChain, migrate, orryLag, runKeeperOnce, sampleOnce, sendSimulated, snapshotAccounts, toJson, type Config, type KeeperStep, type Sql } from "@orrery/server";
import * as rc from "./generated/orry.js";
import { DATABASE_URL, ORRY_ANVIL_PORT } from "./env.js";
import { POOL_MANAGER, ROLE, anvilKey, apiEnv, deployOrrySystem, deposit, depositUsdg, hubSwaps, mine, pmAbi, rpcCall, send, setCoin, startAnvil, usdgHubSwaps, warp, type OrrySystem } from "./orry-system.js";

/**
 * ORRY services against the real contracts of lanes A and B (merged on orry/integration), on a local anvil with the
 * live 4663 PoolManager runtime at its own address: every claim the stand-in suite (`orry.integration.test.ts`) could
 * only make against the frozen ABIs. Wiring as in `contracts/test/orry/integration/OrrySystem.t.sol`; see
 * `./orry-system.ts`. Own anvil (this suite moves chain time by days), the shared test Postgres.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RPC = `http://127.0.0.1:${ORRY_ANVIL_PORT}`;
const E18 = 10n ** 18n;
const keeperKey = anvilKey(ROLE.keeper);

let anvil: ChildProcess | undefined;
let s: OrrySystem;
let cfg: Config;
let sql: Sql;
let app: ReturnType<typeof buildApi>;
let baseUrl: string;
let api: OrryApi;
let supply0: bigint;
let lockedUntil: bigint;

const chain = () => makeChain(cfg);
const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  s.pub.readContract({ address, abi, functionName, args }) as Promise<T>;
const orrySupply = () => read<bigint>(s.token, rc.mockOrryAbi as Abi, "totalSupply");

async function catchUp() {
  await mine(s, cfg.confirmations + 1);
  let r;
  do r = await indexOrryOnce(cfg, chain(), sql, { range: 50n });
  while (r.lag > BigInt(cfg.confirmations));
  return r;
}

/** Steps by action; `harvest` is the ETH vault's and `harvestU` the USDG vault's (the keeper harvests every vault). */
const byAction = (steps: KeeperStep[]) =>
  Object.fromEntries(steps.map((x) => [x.action === "harvest" && isAddressEqual(x.target, s.vaultU) ? "harvestU" : x.action, x]));

/** Every log of the ORRY contracts (both Earn vaults under "vault"), decoded with the implementations' own ABIs (not the
 * frozen ones the indexer uses), and the swaps of both hubs. */
async function chainLogs(toBlock: bigint) {
  const sources = [
    ["hook", s.hook, rc.orreryHookAbi],
    ["factory", s.earnFactory, rc.earnVaultFactoryAbi],
    ["vault", s.vault, rc.earnVaultAbi],
    ["vault", s.vaultU, rc.earnVaultAbi],
    ["staking", s.staking, rc.orryStakingAbi],
    ["router", s.router, rc.orryRewardsRouterAbi],
    ["treasury", s.treasury, rc.orreryTreasuryAbi],
    ["buyback", s.buyback, rc.orryBuybackAbi],
  ] as const;
  const out: { source: string; event: string; args: Record<string, unknown>; log: Log }[] = [];
  for (const [source, address, abi] of sources) {
    for (const log of await s.pub.getLogs({ address, fromBlock: s.startBlock, toBlock })) {
      const d = decodeEventLog({ abi: abi as Abi, data: log.data, topics: log.topics });
      out.push({ source, event: d.eventName!, args: d.args as unknown as Record<string, unknown>, log });
    }
  }
  const swaps = await s.pub.getLogs({
    address: POOL_MANAGER,
    event: { type: "event", name: "Swap", inputs: [
      { name: "id", type: "bytes32", indexed: true }, { name: "sender", type: "address", indexed: true }, { name: "amount0", type: "int128" },
      { name: "amount1", type: "int128" }, { name: "sqrtPriceX96", type: "uint160" }, { name: "liquidity", type: "uint128" }, { name: "tick", type: "int24" },
      { name: "fee", type: "uint24" },
    ] },
    args: { id: [s.hubPoolId, s.usdgHubPoolId] },
    fromBlock: s.startBlock,
    toBlock,
  });
  for (const log of swaps) out.push({ source: "pool", event: "Swap", args: log.args as Record<string, unknown>, log });
  return out.sort((x, y) => (x.log.blockNumber === y.log.blockNumber ? x.log.logIndex! - y.log.logIndex! : x.log.blockNumber! < y.log.blockNumber! ? -1 : 1));
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const amountOf = (list: { asset: string; amount: string }[], asset: string) => BigInt(list.find((x) => x.asset.toLowerCase() === asset.toLowerCase())?.amount ?? "0");
type LensEarn = { earn: { vault: Address; quote: Address; feesQuote: bigint; feesOrry: bigint }[]; stakeRewardsEth: bigint; stakeRewardsOrry: bigint };
/** A pool's current sqrtPriceX96 (PoolManager `extsload` of its slot0). */
async function sqrtOf(id: Hex): Promise<bigint> {
  const abi = [{ type: "function", name: "extsload", stateMutability: "view", inputs: [{ name: "slot", type: "bytes32" }], outputs: [{ name: "", type: "bytes32" }] }] as const;
  return BigInt(await read<Hex>(POOL_MANAGER, abi as Abi, "extsload", [keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n]))])) & ((1n << 160n) - 1n);
}
/** The amount sent with the B-2 `notifyRewards` call on the USDG vault. */
const NOTIFIED = 250_000n * E18;
/** ORRY base units per quote base unit at a hub's sqrt price, as a ratio (the API's `orryPerQuoteRatio`). */
const hubRatio = (sqrt: bigint, orryIsCurrency0: boolean) => (orryIsCurrency0 ? { num: 1n << 192n, den: sqrt * sqrt } : { num: sqrt * sqrt, den: 1n << 192n });
/** Earned per asset (ETH, USDG, ORRY): claimed (the chain's logs) plus pending (the lens), for one account. */
function earnedOf(logs: { source: string; event: string; args: Record<string, unknown>; log: Log }[], who: Address, c: LensEarn) {
  const mine = (event: string) => logs.filter((l) => l.event === event && isAddressEqual(l.args.account as Address, who));
  const feesIn = (vault: Address) => mine("FeesClaimed").filter((l) => isAddressEqual(l.log.address, vault));
  const pend = (vault: Address) => c.earn.filter((x) => isAddressEqual(x.vault, vault));
  const v = (l: { args: Record<string, unknown> }, k: string) => l.args[k] as bigint;
  return {
    eth: sum(feesIn(s.vault).map((l) => v(l, "quoteAmount"))) + sum(mine("RewardsClaimed").map((l) => v(l, "ethAmount"))) + sum(pend(s.vault).map((x) => x.feesQuote)) + c.stakeRewardsEth,
    usdg: sum(feesIn(s.vaultU).map((l) => v(l, "quoteAmount"))) + sum(pend(s.vaultU).map((x) => x.feesQuote)),
    orry: sum([...mine("FeesClaimed"), ...mine("RewardsClaimed")].map((l) => v(l, "orryAmount"))) + sum(c.earn.map((x) => x.feesOrry)) + c.stakeRewardsOrry,
  };
}

/** The suite runs against the multi-pair contracts (R-35 to R-38) once `node scripts/gen-abi.mjs` has their bytecode
 * (`EarnVaultFactory` among them); until lane A's orry/pairs-int lands, the generated file holds the single-hub build,
 * which the multi-pair services no longer read, so the whole suite is skipped. */
const MULTI_PAIR = "earnVaultFactoryBytecode" in rc;

describe.skipIf(!MULTI_PAIR)("ORRY against the real contracts", () => {
beforeAll(async () => {
  anvil = await startAnvil(ORRY_ANVIL_PORT);
  s = await deployOrrySystem(RPC);
  supply0 = await orrySupply();
  cfg = loadConfig(
    apiEnv(s, DATABASE_URL, {
      ORRERY_CONFIRMATIONS: "2",
      ORRERY_ORRY_CACHE_MS: "0",
      ORRERY_ORRY_MIN_SAMPLES: "1",
      ORRERY_ORRY_SAMPLE_SECONDS: "5",
      ORRERY_QUOTE_RATE_PER_MINUTE: "600",
      ORRERY_PUBLIC_RATE_PER_MINUTE: "600",
    }),
  );
  expect(cfg.orryFeatures.size).toBe(6); // 31337: every feature open
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
  anvil?.kill("SIGTERM");
});

describe("keeper against the real contracts", () => {
  it("skips every job on an idle system with the contracts' own reasons, and sends nothing", async () => {
    const before = await s.pub.getBlockNumber();
    const steps = byAction(await runKeeperOnce(cfg, chain(), keeperKey));
    expect(steps.collect).toMatchObject({ status: "skipped", reason: "nothing to do" });
    expect(steps.harvest).toMatchObject({ status: "skipped" });
    expect(steps.harvestU).toMatchObject({ status: "skipped" });
    expect(steps.buyWithQuote).toMatchObject({ status: "skipped", reason: "nothing to do", quote: getAddress(s.usdg) });
    expect(steps.executeSlice).toMatchObject({ status: "skipped", reason: "NothingToBuy" });
    expect(steps.distribute).toMatchObject({ status: "skipped", reason: "NothingToDistribute" });
    expect(steps.burnEth).toMatchObject({ status: "skipped", reason: "NothingToBuy" });
    expect(await s.pub.getBlockNumber()).toBe(before);
  });
});

describe("ORRY indexer over real events", () => {
  it("derives stakers, the agent position with its lock, and Earn shares exactly as the contracts hold them", async () => {
    await deposit(s, ROLE.alice, 30n * E18);
    await deposit(s, ROLE.bob, 30n * E18);
    await depositUsdg(s, ROLE.bob, 8_000n * 10n ** 6n);
    await depositUsdg(s, ROLE.carol, 4_000n * 10n ** 6n);
    await send(s, ROLE.bob, s.staking, rc.orryStakingAbi as Abi, "stake", [5_000_000n * E18]);
    await send(s, ROLE.carol, s.staking, rc.orryStakingAbi as Abi, "stake", [10_000_000n * E18]);
    await send(s, ROLE.operator, s.staking, rc.orryStakingAbi as Abi, "stakeForAgent", [s.agentId, 2_500_000n * E18]);
    lockedUntil = (await s.pub.getBlock()).timestamp + 30n * 86400n;
    await send(s, ROLE.operator, s.staking, rc.orryStakingAbi as Abi, "extendAgentLock", [s.agentId, lockedUntil]);
    await send(s, ROLE.bob, s.staking, rc.orryStakingAbi as Abi, "requestUnstake", [1_000_000n * E18]);
    await hubSwaps(s, 20);
    await usdgHubSwaps(s, 10);
    await catchUp();

    const stakers = await sql<{ address: string; plain_active: string; plain_leaving: string; agent_active: string }[]>`select * from orry_stakers`;
    const byAddr = Object.fromEntries(stakers.map((x) => [x.address, x]));
    for (const role of [ROLE.bob, ROLE.carol, ROLE.operator]) {
      const who = s.address(role);
      const [active, leaving] = await read<[bigint, bigint, bigint]>(s.staking, rc.orryStakingAbi as Abi, "plainStake", [who]);
      const earning = await read<bigint>(s.staking, rc.orryStakingAbi as Abi, "earningBalance", [who]);
      const row = byAddr[who.toLowerCase()]!;
      expect([BigInt(row.plain_active), BigInt(row.plain_leaving)]).toEqual([active, leaving]);
      expect(BigInt(row.plain_active) + BigInt(row.agent_active)).toBe(earning);
    }
    expect(BigInt(byAddr[s.address(ROLE.bob).toLowerCase()]!.plain_leaving)).toBe(1_000_000n * E18);

    const pos = await read<{ staker: Address; active: bigint; leaving: bigint; leavingAt: bigint; lockedUntil: bigint }>(
      s.staking, rc.orryStakingAbi as Abi, "agentStakeOf", [s.agentId, s.address(ROLE.operator)],
    );
    const [row] = await sql`select staker, active::text, leaving::text, locked_until::text from orry_agent_positions where agent_id = ${s.agentId.toString()}`;
    expect(row).toEqual({ staker: pos.staker.toLowerCase(), active: pos.active.toString(), leaving: pos.leaving.toString(), locked_until: pos.lockedUntil.toString() });
    expect(pos.lockedUntil).toBe(lockedUntil);

    // Earn shares per vault, both vaults
    const held: [number, Address][] = [[ROLE.alice, s.vault], [ROLE.bob, s.vault], [ROLE.bob, s.vaultU], [ROLE.carol, s.vaultU]];
    for (const [role, vault] of [...held, [ROLE.alice, s.vaultU] as [number, Address], [ROLE.carol, s.vault] as [number, Address]]) {
      const shares = await read<bigint>(vault, rc.earnVaultAbi as Abi, "sharesOf", [s.address(role)]);
      const [row] = await sql`select shares::text from orry_earn_shares where address = ${s.address(role).toLowerCase()} and vault = ${vault.toLowerCase()}`;
      expect(row?.shares ?? "0", `${role} ${vault}`).toBe(shares.toString());
      expect(shares > 0n).toBe(held.some(([r, v]) => r === role && v === vault));
    }
    const vaults = await sql`select position, vault, quote from orry_vaults order by position`;
    expect(vaults).toEqual([
      { position: 0, vault: s.vault.toLowerCase(), quote: NATIVE_ETH.toLowerCase() },
      { position: 1, vault: s.vaultU.toLowerCase(), quote: s.usdg.toLowerCase() },
    ]);

    const [swaps] = await sql<{ n: number }[]>`select count(*)::int as n from orry_events where source = 'pool'`;
    const last = (await orryLag(sql))!.last;
    expect(swaps!.n).toBe((await chainLogs(last)).filter((l) => l.source === "pool").length);
    expect(swaps!.n).toBe(30);
  });
});

describe("keeper against the real contracts, with a coin set", () => {
  it("refuses the slice and the ETH burn in the block of a hub move (PriceMovedInBlock)", async () => {
    await setCoin(s);
    await mine(s);
    // 3 ETH into a hub of about 60 ETH moves the price well past the 1% start-of-block bound
    await send(s, ROLE.deployer, s.trader, rc.hubActorAbi as Abi, "swap", [s.hubKey, true, -(3n * E18)]);
    const steps = byAction(await runKeeperOnce(cfg, chain(), keeperKey, { dryRun: true }));
    expect(steps.executeSlice).toMatchObject({ status: "skipped", reason: "PriceMovedInBlock" });
    expect(steps.burnEth).toMatchObject({ status: "skipped", reason: "PriceMovedInBlock" });
    expect(steps.collect).toMatchObject({ status: "skipped", reason: "dry run" });
    expect(steps.distribute).toMatchObject({ status: "skipped", reason: "NothingToDistribute" });
  });

  it("one pass sends collect, both harvests, executeSlice, distribute, burnEth and buyWithQuote to the real contracts", async () => {
    await mine(s);
    const reserve0 = await read<bigint>(s.treasury, rc.orreryTreasuryAbi as Abi, "buybackReserve");
    const steps = byAction(await runKeeperOnce(cfg, chain(), keeperKey));
    for (const a of ["collect", "harvest", "harvestU", "executeSlice", "distribute", "burnEth", "buyWithQuote"]) expect(steps[a], a).toMatchObject({ status: "sent" });
    expect(isAddressEqual(steps.harvestU!.target, s.vaultU)).toBe(true);
    expect(steps.buyWithQuote!.quote).toBe(getAddress(s.usdg));
    for (const a of ["executeSlice", "burnEth", "buyWithQuote"]) expect(BigInt(steps[a]!.result![0]!), a).toBeGreaterThan(0n);
    // the router passed everything on (ETH, and the USDG fees whole to the buyback); the ORRY it holds now is exactly what
    // the quote buy, last in the pass, paid it (no cashback sink); the buyback kept no ORRY; the slice used the reserve
    expect(await s.pub.getBalance({ address: s.router })).toBe(0n);
    expect(await read<bigint>(s.usdg, rc.mockOrryAbi as Abi, "balanceOf", [s.router])).toBe(0n);
    expect(await read<bigint>(s.token, rc.mockOrryAbi as Abi, "balanceOf", [s.router])).toBe(BigInt(steps.buyWithQuote!.result![0]!));
    expect(await read<bigint>(s.token, rc.mockOrryAbi as Abi, "balanceOf", [s.buyback])).toBe(0n);
    expect(await read<bigint>(s.treasury, rc.orreryTreasuryAbi as Abi, "buybackReserve")).toBeLessThan(reserve0);
    const burnReceipt = await s.pub.getTransactionReceipt({ hash: steps.burnEth!.txHash! });
    const burned = burnReceipt.logs
      .filter((l) => isAddressEqual(l.address, s.buyback))
      .map((l) => decodeEventLog({ abi: rc.orryBuybackAbi as Abi, data: l.data, topics: l.topics }))
      .find((d) => d.eventName === "Burned");
    expect(burned?.args).toMatchObject({ source: 4, amount: BigInt(steps.burnEth!.result![0]!) });
  });

  it("the keeper binary's --once pass right after skips the timed jobs with TooSoon", async () => {
    const env = { ...process.env, ...apiEnv(s, DATABASE_URL, { ORRERY_CONFIRMATIONS: "2" }) };
    const { stdout } = await promisify(execFile)("pnpm", ["exec", "tsx", join(here, "../packages/server/src/bin/keeper.ts"), "--once"], { env, cwd: join(here, "..") });
    const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop()!;
    const steps = byAction((JSON.parse(line) as { steps: KeeperStep[] }).steps);
    for (const a of ["executeSlice", "distribute", "burnEth"]) expect(steps[a], a).toMatchObject({ status: "skipped", reason: "TooSoon" });
    expect(stdout).not.toContain(keeperKey.slice(2));
  });
});

describe("gas headroom on the senders", () => {
  it("a hub swap estimated before an oracle checkpoint falls due runs out of gas at the exact estimate, and lands with sendSimulated", async () => {
    const w = s.wallet(ROLE.deployer);
    const swap = { address: s.trader, abi: rc.hubActorAbi as Abi, functionName: "swap", args: [s.hubKey, true, -(10n ** 17n)] } as const;
    /** A fresh checkpoint now; the next swap estimated at this block, mined 61 s later when the next one is due. */
    async function landLater(sendIt: () => Promise<Hex>) {
      await send(s, ROLE.deployer, s.trader, rc.hubActorAbi as Abi, "swap", [s.hubKey, false, -(10n ** 21n)]);
      await rpcCall(s, "evm_setAutomine", [false]);
      try {
        const hash = await sendIt();
        await rpcCall(s, "evm_increaseTime", [toHex(61)]);
        await rpcCall(s, "evm_mine", []);
        return await s.pub.waitForTransactionReceipt({ hash });
      } finally {
        await rpcCall(s, "evm_setAutomine", [true]);
      }
    }
    await warp(s, 61); // the next swap writes a checkpoint, so the one after it starts with a fresh one
    const exact = await landLater(async () => {
      const gas = await s.pub.estimateContractGas({ ...swap, account: w.account } as never);
      return w.writeContract({ ...swap, gas, chain: foundry, account: w.account } as never);
    });
    expect(exact.status).toBe("reverted");
    await warp(s, 61);
    const keeperSend = await landLater(() => sendSimulated(chain(), anvilKey(ROLE.deployer), swap as never));
    expect(keeperSend.status).toBe("success");
  });
});

describe("public reads answer the chain's own numbers", () => {
  it("after claims and a withdrawal: earn, stake, accounts, both leaderboards and burns", async () => {
    // B-2: anyone may add ORRY to a vault's reward stream; it streams to the USDG vault's holders (bob and carol)
    await send(s, ROLE.deployer, s.token, rc.mockOrryAbi as Abi, "approve", [s.vaultU, NOTIFIED]);
    await send(s, ROLE.deployer, s.vaultU, rc.earnVaultAbi as Abi, "notifyRewards", [NOTIFIED]);
    await warp(s, 2 * 86400);
    await send(s, ROLE.carol, s.staking, rc.orryStakingAbi as Abi, "claimRewards");
    await send(s, ROLE.bob, s.claimAll, rc.claimAllAbi as Abi, "claimAll");
    const aliceShares = await read<bigint>(s.vault, rc.earnVaultAbi as Abi, "sharesOf", [s.address(ROLE.alice)]);
    const ts = (await s.pub.getBlock()).timestamp;
    await send(s, ROLE.alice, s.vault, rc.earnVaultAbi as Abi, "withdraw", [aliceShares / 2n, 0n, 0n, ts + 600n]);
    await catchUp();
    expect(await snapshotAccounts(cfg, chain(), sql)).toBeGreaterThan(0);
    const last = (await orryLag(sql))!.last;
    const logs = await chainLogs(last);
    const of = (source: string, event: string) => logs.filter((l) => l.source === source && l.event === event);
    const a = (l: { args: Record<string, unknown> }, k: string) => l.args[k] as bigint;

    // earn: both hubs in the hook's order, each with its vault's own numbers
    const e = await api.earn();
    expect(e.hubs.map((h) => [h.quote.address, h.vault, h.poolId, h.initialized])).toEqual([
      [NATIVE_ETH, getAddress(s.vault), s.hubPoolId, true],
      [getAddress(s.usdg), getAddress(s.vaultU), s.usdgHubPoolId, true],
    ]);
    const [ethHub, usdgHub] = e.hubs as [(typeof e.hubs)[0], (typeof e.hubs)[0]];
    for (const [hub, vault, poolId, decimals] of [[ethHub, s.vault, s.hubPoolId, 18], [usdgHub, s.vaultU, s.usdgHubPoolId, 6]] as const) {
      const [tvlQ, tvlR] = await read<[bigint, bigint]>(vault, rc.earnVaultAbi as Abi, "positionAmounts");
      expect(hub.tvl).toEqual({ quote: tvlQ.toString(), orry: tvlR.toString() });
      expect(hub.totalShares).toBe((await read<bigint>(vault, rc.earnVaultAbi as Abi, "totalShares")).toString());
      const harvested = of("vault", "FeesHarvested").filter((l) => isAddressEqual(l.log.address, vault));
      expect(harvested.length, vault).toBeGreaterThan(0);
      expect(hub.feesAllTime).toEqual({ quote: sum(harvested.map((l) => a(l, "quoteAmount"))).toString(), orry: sum(harvested.map((l) => a(l, "orryAmount"))).toString() });
      const lastSwap = of("pool", "Swap").filter((l) => l.args.id === poolId).at(-1)!;
      const r = hubRatio(a(lastSwap, "sqrtPriceX96"), hub === ethHub ? false : s.usdgHubOrryFirst); // ETH (address 0) is always currency0
      expect(hub.orryPerQuote).toBe(((r.num * 10n ** BigInt(decimals)) / r.den).toString());
    }
    expect(ethHub.orryPerQuote).toBe(orryPerEthFromSqrt(a(of("pool", "Swap").filter((l) => l.args.id === s.hubPoolId).at(-1)!, "sqrtPriceX96")).toString());
    // B-2: rewards notified to a vault are indexed as its events and stream to its holders, never as harvested fees; /earn
    // shows them on that vault's hub only
    expect(of("vault", "RewardsNotified").map((l) => [l.log.address.toLowerCase(), l.args.from, a(l, "orryAmount")])).toEqual([[s.vaultU.toLowerCase(), getAddress(s.address(ROLE.deployer)), NOTIFIED]]);
    expect([usdgHub.notified7d, usdgHub.notifiedAllTime]).toEqual([NOTIFIED.toString(), NOTIFIED.toString()]);
    expect([ethHub.notified7d, ethHub.notifiedAllTime]).toEqual(["0", "0"]);

    // stake
    const st = await api.stake();
    expect(st.totalEarning).toBe((await read<bigint>(s.staking, rc.orryStakingAbi as Abi, "totalEarning")).toString());
    const notified = of("staking", "RewardsNotified");
    expect(notified.length).toBeGreaterThan(0);
    expect(st.rewardsAllTime).toEqual({ eth: sum(notified.map((l) => a(l, "ethAmount"))).toString(), orry: sum(notified.map((l) => a(l, "orryAmount"))).toString() });
    expect(st.stakers).toBe(3);

    // accounts: the lens fields at the indexer's cursor block, agent positions, claimed (the chain's own logs) plus pending
    const lensAt = <T>(functionName: string, args: unknown[]) =>
      s.pub.readContract({ address: s.lens, abi: rc.orryLensAbi as Abi, functionName, args, blockNumber: last }) as Promise<T>;
    type Lens = Omit<LensEarn, "earn"> & {
      earn: (LensEarn["earn"][number] & { shares: bigint; unlockAt: bigint; positionQuote: bigint; positionOrry: bigint })[];
      stakeActive: bigint; stakeLeaving: bigint; stakeReadyAt: bigint;
    };
    for (const role of [ROLE.alice, ROLE.bob, ROLE.carol, ROLE.operator]) {
      const who = s.address(role);
      const acct = await api.account(who);
      const c = await lensAt<Lens>("claimables", [who]);
      for (const k of ["stakeActive", "stakeLeaving", "stakeRewardsEth", "stakeRewardsOrry"] as const) {
        expect((acct as unknown as Record<string, string>)[k], `${role} ${k}`).toBe(c[k].toString());
      }
      expect(acct.earn.map((x) => [x.vault, x.quote.address, x.shares, x.unlockAt, x.fees.quote, x.fees.orry, x.position.quote, x.position.orry])).toEqual(
        c.earn.map((x) => [getAddress(x.vault), getAddress(x.quote), x.shares.toString(), Number(x.unlockAt), x.feesQuote.toString(), x.feesOrry.toString(), x.positionQuote.toString(), x.positionOrry.toString()]),
      );
      expect(acct.stakeReadyAt).toBe(Number(c.stakeReadyAt));
      const earned = earnedOf(logs, who, c);
      expect([NATIVE_ETH, s.usdg, s.token].map((k) => amountOf(acct.earnedAllTime, k)), role.toString()).toEqual([earned.eth, earned.usdg, earned.orry]);
    }
    // bob claimed in both vaults through ClaimAll; carol earns USDG fees and the notified ORRY in the USDG vault
    const bobClaims = of("vault", "FeesClaimed").filter((l) => isAddressEqual(l.args.account as Address, s.address(ROLE.bob)));
    expect(new Set(bobClaims.map((l) => l.log.address.toLowerCase()))).toEqual(new Set([s.vault.toLowerCase(), s.vaultU.toLowerCase()]));
    const carolLens = await lensAt<Lens>("claimables", [s.address(ROLE.carol)]);
    expect(earnedOf(logs, s.address(ROLE.carol), carolLens).usdg).toBeGreaterThan(0n);
    const op = await api.account(s.address(ROLE.operator));
    const [agentRow] = await lensAt<{ agentId: bigint; owner: Address; active: bigint; leaving: bigint; leavingAt: bigint; reportedForAgent: boolean }[]>(
      "agentClaimables", [s.address(ROLE.operator), [s.agentId], [s.address(ROLE.operator)]],
    );
    expect(op.agentPositions).toEqual([{
      agentId: agentRow!.agentId.toString(), owner: agentRow!.owner, active: agentRow!.active.toString(), leaving: agentRow!.leaving.toString(),
      leavingAt: Number(agentRow!.leavingAt), reportedForAgent: agentRow!.reportedForAgent,
    }]);
    expect(agentRow!.active).toBe(2_500_000n * E18);

    // leaderboard of stakers: earning balance from the chain, masked addresses only
    const r = await fetch(`${baseUrl}/v1/orry/leaderboard?kind=stakers&limit=10`);
    const text = await r.text();
    const people = [ROLE.alice, ROLE.bob, ROLE.carol, ROLE.operator].map((role) => s.address(role));
    for (const p of people) expect(text.toLowerCase()).not.toContain(p.toLowerCase().slice(2));
    const earning = await Promise.all(people.map(async (p) => ({ p, v: await read<bigint>(s.staking, rc.orryStakingAbi as Abi, "earningBalance", [p]) })));
    const expectStakers = earning.filter((x) => x.v > 0n).sort((x, y) => (y.v > x.v ? 1 : y.v < x.v ? -1 : 0));
    expect(JSON.parse(text)).toEqual(expectStakers.map((x, i) => ({ rank: i + 1, address: maskAddress(x.p), decimals: 18, stake: x.v.toString() })));

    // leaderboard of earners: claimed plus pending, both at the cursor block, valued at the hub price
    const earners = await api.leaderboard("earners", 10);
    const [rEth, rUsdg] = [hubRatio(await sqrtOf(s.hubPoolId), false), hubRatio(await sqrtOf(s.usdgHubPoolId), s.usdgHubOrryFirst)];
    const value = await Promise.all(people.map(async (p) => {
      const x = earnedOf(logs, p, await lensAt<Lens>("claimables", [p]));
      return { p, ...x, worth: x.orry + (x.eth * rEth.num) / rEth.den + (x.usdg * rUsdg.num) / rUsdg.den };
    }));
    const expectEarners = value.filter((x) => x.eth + x.usdg + x.orry > 0n).sort((x, y) => (y.worth > x.worth ? 1 : y.worth < x.worth ? -1 : 0));
    expect(earners.map((r) => [r.address, r.earned!.map((x) => x.asset), amountOf(r.earned!, NATIVE_ETH), amountOf(r.earned!, s.usdg), amountOf(r.earned!, s.token)])).toEqual(
      expectEarners.map((x) => [maskAddress(x.p), [getAddress(s.token), NATIVE_ETH, getAddress(s.usdg)], x.eth, x.usdg, x.orry]), // ORRY, ETH, then hub quotes
    );
    // the API floors the sum, the test sums floors: at most one unit per valued asset apart
    for (const [i, r] of earners.entries()) {
      const d = BigInt(r.valueOrry!) - expectEarners[i]!.worth;
      expect(d >= 0n && d <= 2n, `${r.address} ${r.valueOrry} vs ${expectEarners[i]!.worth}`).toBe(true);
    }

    // burns: router (1) and buyback (4) so far, exactly the chain's Burned logs, newest first
    const b = await api.burns(50);
    const burnLogs = logs.filter((l) => l.event === "Burned").reverse();
    expect(b.items.map((i) => [i.tx, i.block, i.source, i.amount])).toEqual(burnLogs.map((l) => [l.log.transactionHash, Number(l.log.blockNumber), Number(l.args.source), a(l, "amount").toString()]));
    expect(new Set(b.items.map((i) => i.source))).toEqual(new Set([1, 4]));
    expect(b.total).toBe((supply0 - (await orrySupply())).toString());
  });
});

describe("quotes the API signs, accepted by the real treasury", () => {
  /** ORRY base units for `usd` USDG base units at the ORRY/USDG hub's current slot0 (the USDG hub prices quotes once it
   * exists; the ETH hub and the ETH/USDG pool only without one), rounded up (one sample: spot = median). */
  async function expectedOrry(usd: bigint) {
    const r = hubRatio(await sqrtOf(s.usdgHubPoolId), s.usdgHubOrryFirst);
    return (usd * r.num + r.den - 1n) / r.den;
  }

  it("credits: burnForCredits accepts the quote once, burns it (source 2), and the checks are granted once", async () => {
    await sql`delete from orry_price_samples`;
    expect(await sampleOnce(cfg, chain(), sql)).toBe(true);
    const carol = s.wallet(ROLE.carol);
    const q = await api.quoteCredits(carol.account.address, 2);
    expect(q).toMatchObject({ kind: "credits", credits: "1250", usdValue: "2000000", signer: s.address(ROLE.quoteSigner) });
    expect(q.domain).toEqual({ name: "Orrery Treasury", version: "1", chainId: 31337, verifyingContract: getAddress(s.treasury) });
    expect(q.quote.orryAmount).toBe((await expectedOrry(2_000_000n)).toString());
    expect(await verifyQuote(s.pub, s.treasury, q, { sender: carol.account.address, now: (await s.pub.getBlock()).timestamp })).toEqual({ ok: true });

    const supply = await orrySupply();
    const hash = await carol.sendTransaction({ to: s.treasury, data: orryCalls.burnForCredits(q), chain: foundry, account: carol.account });
    expect((await s.pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    expect(supply - (await orrySupply())).toBe(BigInt(q.quote.orryAmount));
    await expect(carol.sendTransaction({ to: s.treasury, data: orryCalls.burnForCredits(q), chain: foundry, account: carol.account })).rejects.toThrow();
    expect((await verifyQuote(s.pub, s.treasury, q)).reason).toBe("quote already used");

    await catchUp();
    const [acct] = await sql`select credits::text from credit_accounts where address = ${carol.account.address.toLowerCase()}`;
    expect(acct!.credits).toBe("1250");
    const [g] = await sql`select matched, credits::text, tx_hash from orry_credit_grants where quote_id = ${q.quote.quoteId.toLowerCase()}`;
    expect(g).toEqual({ matched: true, credits: "1250", tx_hash: hash });
    const [burn] = (await api.burns(1)).items;
    expect(burn).toMatchObject({ tx: hash, source: 2, amount: q.quote.orryAmount });
  });

  it("pay as you go: a checks quote goes through the same burnForCredits and grants checks × credits per check", async () => {
    const carol = s.wallet(ROLE.carol);
    const q = await api.quoteChecks(carol.account.address, 3);
    // 3 checks × 2 credits at 625 credits per 1 USD of ORRY: 6 / 625 USD = 9,600 USDG base units
    expect(q).toMatchObject({ kind: "checks", checks: 3, credits: "6", usdValue: "9600", quote: { packs: 3 } });
    expect(q.quote.orryAmount).toBe((await expectedOrry(9_600n)).toString());
    expect(await verifyQuote(s.pub, s.treasury, q, { sender: carol.account.address, now: (await s.pub.getBlock()).timestamp })).toEqual({ ok: true });
    const supply = await orrySupply();
    const hash = await carol.sendTransaction({ to: s.treasury, data: orryCalls.burnForCredits(q), chain: foundry, account: carol.account });
    expect((await s.pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    expect(supply - (await orrySupply())).toBe(BigInt(q.quote.orryAmount));
    await catchUp();
    const [acct] = await sql`select credits::text from credit_accounts where address = ${carol.account.address.toLowerCase()}`;
    expect(acct!.credits).toBe("1256");
    const [g] = await sql`select matched, kind, credits::text from orry_credit_grants where quote_id = ${q.quote.quoteId.toLowerCase()}`;
    expect(g).toEqual({ matched: true, kind: "checks", credits: "6" });
  });

  it("verification: verifyWithOrry pays agent 2 through the real OrreryAttestor and burns (source 3)", async () => {
    const payer = s.wallet(ROLE.agentOwner2);
    expect(await read<boolean>(s.attestor, [{ type: "function", name: "isVerified", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }], "isVerified", [s.agentId2])).toBe(false);
    const q = await api.quoteVerification(payer.account.address, s.agentId2);
    expect(q).toMatchObject({ kind: "verification", usdValue: "4000000" });
    expect(q.quote.orryAmount).toBe((await expectedOrry(4_000_000n)).toString());
    expect(await verifyQuote(s.pub, s.treasury, q, { sender: payer.account.address, now: (await s.pub.getBlock()).timestamp })).toEqual({ ok: true });
    const hash = await payer.sendTransaction({ to: s.treasury, data: orryCalls.verifyWithOrry(q, payer.account.address), chain: foundry, account: payer.account });
    expect((await s.pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    expect(await read<boolean>(s.attestor, [{ type: "function", name: "isVerified", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }], "isVerified", [s.agentId2])).toBe(true);
    await catchUp();
    const [row] = await sql`select used_tx from orry_quotes where quote_id = ${q.quote.quoteId.toLowerCase()}`;
    expect(row!.used_tx).toBe(hash);
    const [burn] = (await api.burns(1)).items;
    expect(burn).toMatchObject({ tx: hash, source: 3, amount: q.quote.orryAmount });
  });

  it("the real treasury refuses a quote past its expiry, and so does verifyQuote", async () => {
    const carol = s.wallet(ROLE.carol);
    const q = await api.quoteCredits(carol.account.address, 1);
    const head = (await s.pub.getBlock()).timestamp;
    expect(BigInt(q.quote.expiry) - head).toBeLessThanOrEqual(120n);
    await warp(s, 121);
    await expect(
      s.pub.simulateContract({ address: s.treasury, abi: rc.orreryTreasuryAbi as Abi, functionName: "burnForCredits", args: [q.quote.packs, BigInt(q.quote.orryAmount), q.quote.quoteId, BigInt(q.quote.expiry), q.signature], account: carol.account }),
    ).rejects.toThrow(/QuoteExpired/);
    expect((await verifyQuote(s.pub, s.treasury, q, { now: (await s.pub.getBlock()).timestamp })).reason).toBe("expired quote");
  });
});

describe("check result v2 from the real staking", () => {
  it("carries agent 1's position (active, leaving, lock, staker) and verifies against the real attestor", async () => {
    const signed = await buildCheck(cfg, chain(), sql, { signer: s.address(ROLE.sessionSigner) });
    expect(signed.domain.version).toBe("2");
    const res = toJson(signed) as CheckResponse;
    const pos = await read<{ staker: Address; active: bigint; leaving: bigint; leavingAt: bigint; lockedUntil: bigint }>(
      s.staking, rc.orryStakingAbi as Abi, "agentStake", [s.agentId],
    );
    const v = await verifyCheck(s.pub, s.attestor, res, { now: BigInt(res.result.issuedAt as string) });
    expect(v).toMatchObject({ ok: true, version: "2" });
    expect(v.result).toMatchObject({
      agentId: s.agentId, stakeActive: pos.active, stakeLeaving: pos.leaving, stakeLeavingAt: pos.leavingAt, stakeLockedUntil: lockedUntil, stakedBy: getAddress(s.address(ROLE.operator)),
    });
    expect(pos.active).toBe(2_500_000n * E18);
    const tampered = { ...res, result: { ...res.result, stakeLockedUntil: "0" } };
    expect((await verifyCheck(s.pub, s.attestor, tampered, { now: BigInt(res.result.issuedAt as string) })).ok).toBe(false);
  });
});

describe("earned all time across a harvest, a distribute, a claim and a re-index", () => {
  it("never decreases between responses, on the account and the earners leaderboard, and is claimed plus pending at one block", async () => {
    const who = s.address(ROLE.bob);
    type Pair = { asset: string; amount: string }[];
    const seen: { at: string; account: Pair; board: Pair }[] = [];
    async function look(at: string) {
      // the snapshot job's periodic re-read runs at this moment
      await sql`update orry_accounts set snapshot_at = now() - interval '1 day'`;
      await snapshotAccounts(cfg, chain(), sql);
      const account = (await api.account(who)).earnedAllTime;
      const row = (await api.leaderboard("earners", 100)).find((r) => r.address === maskAddress(who));
      expect(row, at).toBeDefined();
      seen.push({ at, account, board: row!.earned! });
    }

    await catchUp();
    await look("indexed");
    // harvest and distribute (Earn fees and stake rewards enter their streams), not indexed yet
    await hubSwaps(s, 4);
    await usdgHubSwaps(s, 4);
    await warp(s, 3600);
    await mine(s);
    const steps = byAction(await runKeeperOnce(cfg, chain(), keeperKey));
    expect(steps.harvest).toMatchObject({ status: "sent" });
    expect(steps.harvestU).toMatchObject({ status: "sent" });
    expect(steps.distribute).toMatchObject({ status: "sent" });
    await look("harvested and distributed, not indexed");
    // the claim, read before the indexer passes its block
    const pending = await read<LensEarn>(s.lens, rc.orryLensAbi as Abi, "claimables", [who]);
    expect(sum(pending.earn.filter((x) => isAddressEqual(x.vault, s.vault)).map((x) => x.feesQuote)) + pending.stakeRewardsEth).toBeGreaterThan(0n);
    expect(sum(pending.earn.filter((x) => isAddressEqual(x.vault, s.vaultU)).map((x) => x.feesQuote))).toBeGreaterThan(0n);
    const claim = await send(s, ROLE.bob, s.claimAll, rc.claimAllAbi as Abi, "claimAll");
    await look("claimed, not indexed");
    await catchUp();
    await look("claim indexed");
    // re-index from before the claim: the cursor goes back; the derived tables keep every event they hold
    await sql`update indexer_state set last_block = ${(claim.blockNumber - 1n).toString()} where id = 'orry'`;
    await look("cursor moved back");
    await indexOrryOnce(cfg, chain(), sql, { range: 30n });
    await look("re-indexing");
    await catchUp();
    await look("re-indexed");

    for (let i = 1; i < seen.length; i++) {
      for (const view of ["account", "board"] as const) {
        for (const k of [NATIVE_ETH, s.usdg, s.token]) {
          const [x, y] = [amountOf(seen[i - 1]![view], k), amountOf(seen[i]![view], k)];
          expect(y >= x, `${view} ${k} fell from ${x} to ${y}: "${seen[i - 1]!.at}" then "${seen[i]!.at}"`).toBe(true);
        }
      }
    }

    // claimed (the chain's own logs up to the cursor) plus pending read at the cursor block, on both views
    const at = (await orryLag(sql))!.last;
    const c = (await s.pub.readContract({ address: s.lens, abi: rc.orryLensAbi as Abi, functionName: "claimables", args: [who], blockNumber: at })) as LensEarn;
    const truth = earnedOf(await chainLogs(at), who, c);
    expect(truth.usdg).toBeGreaterThan(0n);
    for (const view of [seen.at(-1)!.account, seen.at(-1)!.board]) {
      expect([amountOf(view, NATIVE_ETH), amountOf(view, s.usdg), amountOf(view, s.token)]).toEqual([truth.eth, truth.usdg, truth.orry]);
    }

    // a second snapshot writer that already stored a later block (two indexers during a deploy) is never overwritten
    await sql`update orry_earned set amount = 1 where address = ${who.toLowerCase()} and asset = ${NATIVE_ETH.toLowerCase()}`;
    await sql`update orry_accounts set earned_block = 9000000000000000000 where address = ${who.toLowerCase()}`;
    await sql`update orry_accounts set snapshot_at = now() - interval '1 day'`;
    await snapshotAccounts(cfg, chain(), sql);
    const [kept] = await sql`select amount::text from orry_earned where address = ${who.toLowerCase()} and asset = ${NATIVE_ETH.toLowerCase()}`;
    expect(kept!.amount).toBe("1");
    await sql`update orry_accounts set earned_block = null where address = ${who.toLowerCase()}`;
    await snapshotAccounts(cfg, chain(), sql);
  });
});

describe("the whole run", () => {
  it("the indexer's record equals the chain's logs, and the burn ledger equals the supply drop", async () => {
    await catchUp();
    const last = (await orryLag(sql))!.last;
    const logs = await chainLogs(last);
    const count = (xs: { source: string; event: string }[]) => {
      const m: Record<string, number> = {};
      for (const x of xs) m[`${x.source}.${x.event}`] = (m[`${x.source}.${x.event}`] ?? 0) + 1;
      return m;
    };
    const rows = await sql<{ source: string; event: string }[]>`select source, event from orry_events`;
    expect(count(rows)).toEqual(count(logs));
    for (const ev of ["Deposited", "Withdrawn", "FeesHarvested", "FeesClaimed", "RewardsNotified"]) expect(count(logs)[`vault.${ev}`], ev).toBeGreaterThan(0);
    expect(count(logs)["factory.VaultCreated"]).toBe(2);
    expect(count(logs)["hook.PairRegistered"]).toBe(2);
    // B-1: the quote buy ran; with no cashback sink set, no CashbackPaid
    expect(count(logs)["buyback.QuoteSwapped"]).toBeGreaterThan(0);
    expect(count(logs)["buyback.CashbackPaid"]).toBeUndefined();
    for (const ev of ["Staked", "UnstakeRequested", "AgentStaked", "AgentLockExtended", "RewardsNotified", "RewardsClaimed"]) expect(count(logs)[`staking.${ev}`], ev).toBeGreaterThan(0);
    for (const k of ["router.Burned", "treasury.Burned", "treasury.CreditsPaid", "treasury.VerificationBurned", "buyback.Burned", "hook.ProtocolFeesCollected", "pool.Swap"]) expect(count(logs)[k], k).toBeGreaterThan(0);

    const b = await api.burns(200);
    const bySource = { 1: 0n, 2: 0n, 3: 0n, 4: 0n } as Record<number, bigint>;
    for (const l of logs.filter((x) => x.event === "Burned")) bySource[Number(l.args.source)]! += l.args.amount as bigint;
    expect(b.bySource).toEqual({ "1": bySource[1]!.toString(), "2": bySource[2]!.toString(), "3": bySource[3]!.toString(), "4": bySource[4]!.toString(), "5": "0", "6": "0", "7": "0" });
    expect(BigInt(b.total)).toBe(supply0 - (await orrySupply()));
    for (const k of [1, 2, 3, 4]) expect(bySource[k], `source ${k}`).toBeGreaterThan(0n);
  });
});

});
