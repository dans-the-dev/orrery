import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toHex, type Abi, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import {
  iAgentLaunchAbi,
  LAUNCH_SUPPLY,
  type LaunchAccountResponse,
  type LaunchCoinResponse,
  type LaunchCoinsResponse,
  type LaunchEligibilityResponse,
} from "@orrery/shared";
import { buildApi, connect, loadConfig, makeChain, migrate, setRelease, type Config, type Sql } from "@orrery/server";
import { indexLaunchOnce } from "../packages/server/src/launch-indexer.js";
import * as g from "../scripts/launch-generated.js";
import {
  CREATE2_FACTORY,
  SPOKE_HOOK_BITS,
  coinSalt,
  deployLaunchStack,
  launchClients,
  LAUNCH_ROLE,
  mineSpokeHookSalt,
  spokeHookInitCode,
  type LaunchStack,
} from "../scripts/launch-stack.js";
import { DATABASE_URL, LAUNCH_ANVIL_PORT } from "./env.js";
import { startAnvil } from "./orry-system.js";

/**
 * Lane L5 services (`docs/updates/L5-LAUNCH-SPEC.md`) against the real AgentLaunch, SpokeHook and OrryStaking on their own
 * anvil (the 4663 PoolManager runtime, stand-ins around them: scripts/launch-stack.ts): the salt miner, the indexer, the
 * API behind the release switch.
 */

const RPC = `http://127.0.0.1:${LAUNCH_ANVIL_PORT}`;
const E18 = 10n ** 18n;
let anvil: ChildProcess | undefined;
let s: LaunchStack;
let c: ReturnType<typeof launchClients>;
let cfg: Config;
let sql: Sql;
let app: ReturnType<typeof buildApi>;
let coin: Address;

const get = async <T>(url: string) => {
  const r = await app.inject({ method: "GET", url });
  return { status: r.statusCode, body: r.json() as T };
};
async function send(role: number, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  const w = c.wallet(role);
  const hash = await w.writeContract({ address, abi, functionName, args, chain: foundry, account: w.account } as never);
  const r = await c.pub.waitForTransactionReceipt({ hash });
  expect(r.status).toBe("success");
  return r;
}
const rpc = (method: string, params: unknown[]) => c.pub.request({ method: method as never, params: params as never });
async function warp(seconds: number) {
  await rpc("evm_increaseTime", [toHex(seconds)]);
  await rpc("evm_mine", []);
}
async function index() {
  await rpc("anvil_mine", [toHex(cfg.confirmations + 1)]);
  let r;
  do r = await indexLaunchOnce(cfg.launch!, makeChain(cfg), sql, cfg.confirmations, { range: 50n });
  while (r.lag > BigInt(cfg.confirmations));
}
async function swap(role: number, buy: boolean, amountSpecified: bigint) {
  const key = (await c.pub.readContract({ address: s.agentLaunch, abi: iAgentLaunchAbi as Abi, functionName: "poolKeyOf", args: [coin] })) as Record<string, unknown>;
  await send(role, coin, g.agentCoinAbi as Abi, "approve", [s.swapRouter, (1n << 256n) - 1n]);
  const limit = buy ? 4295128740n : 1461446703485210103287273052203988822378723970341n;
  await send(role, s.swapRouter, g.poolSwapTestAbi as Abi, "swap", [
    key,
    { zeroForOne: buy, amountSpecified, sqrtPriceLimitX96: limit },
    { takeClaims: false, settleUsingBurn: false },
    "0x",
  ]);
}

beforeAll(async () => {
  anvil = await startAnvil(LAUNCH_ANVIL_PORT);
  c = launchClients(RPC);
  s = await deployLaunchStack(RPC);
  sql = connect(DATABASE_URL);
  await migrate(sql);
  cfg = loadConfig({
    ORRERY_CHAIN_ID: "31337",
    ORRERY_RPC_URL: RPC,
    ORRERY_DATABASE_URL: DATABASE_URL,
    ORRERY_MODULE: s.module,
    ORRERY_ATTESTOR: s.attestor,
    ORRERY_LENS: s.registry,
    ORRERY_REGISTRY: s.registry,
    ORRERY_USDG: s.orry,
    ORRERY_TREASURY: s.treasury,
    ORRERY_CONFIRMATIONS: "2",
    ORRERY_ORRY_FEATURES: "",
    ORRERY_RELEASES_CACHE_MS: "0",
    ORRERY_PUBLIC_RATE_PER_MINUTE: "600",
    ORRERY_AGENT_LAUNCH: s.agentLaunch,
    ORRERY_SPOKE_ROUTER: s.spokeRouter,
    ORRERY_LAUNCH_START_BLOCK: s.startBlock,
    ORRERY_LAUNCH_CACHE_MS: "0",
  } as NodeJS.ProcessEnv);
  app = buildApi(cfg, makeChain(cfg), sql);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await sql?.end();
  anvil?.kill("SIGTERM");
});

describe("deploy helpers", () => {
  it("mines a CREATE2 salt whose hook address carries exactly the spoke bits, and the stack used it", () => {
    expect((BigInt(s.hook) & 0x3fffn) === SPOKE_HOOK_BITS).toBe(true);
    const init = spokeHookInitCode({ poolManager: s.poolManager, orry: s.orry, launch: s.agentLaunch, startFeePips: 800_000, decayWindow: 60, earlyWindow: 600 });
    const mined = mineSpokeHookSalt(init, CREATE2_FACTORY);
    expect(mined.address.toLowerCase()).toBe(s.hook.toLowerCase());
    expect(mined.salt).toBe(s.hookSalt);
    // a different launch address gives a different salt and address, still with the bits
    const other = mineSpokeHookSalt(spokeHookInitCode({ poolManager: s.poolManager, orry: s.orry, launch: s.orry, startFeePips: 800_000, decayWindow: 60, earlyWindow: 600 }));
    expect((BigInt(other.address) & 0x3fffn) === SPOKE_HOOK_BITS).toBe(true);
    expect(other.address).not.toBe(mined.address);
  });
});

describe("release switch", () => {
  it("holds every launch route as an unknown route until `launch` opens", async () => {
    await setRelease(sql, "launch", null, "test");
    const unknown = await app.inject({ method: "GET", url: "/v1/nothing-here" });
    for (const url of ["/v1/launch/coins", `/v1/launch/agents/${s.agentId}`, `/v1/launch/accounts/${s.accounts.bob}`]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(404);
      expect(r.body).toBe(unknown.body.replace("/v1/nothing-here", url.split("?")[0]!));
    }
    await setRelease(sql, "launch", new Date(0), "test");
    expect((await get("/v1/launch/coins")).status).toBe(200);
  });
});

describe("agent launch", () => {
  it("reports what the launch form needs", async () => {
    const e = await get<LaunchEligibilityResponse>(`/v1/launch/agents/${s.agentId}?caller=${s.accounts.alice}`);
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ gate: "ok", owner: s.accounts.alice.toLowerCase(), agentWallet: s.accounts.aliceWallet.toLowerCase(), coin: null, verified: true, walletBound: true });
    expect(e.body.stake.usd).toBe("200000000");
    expect(e.body.needs).toMatchObject({ minStakeUsd: "100000000", maxFirstBuyBps: 500 });
    const stranger = await get<LaunchEligibilityResponse>(`/v1/launch/agents/${s.agentId}?caller=${s.accounts.carol}`);
    expect(stranger.body.gate).toBe("not-controller");
    expect((await get(`/v1/launch/agents/abc`)).status).toBe(400);
  });

  it("indexes a launch, its early buys, public trades, the fee split and the creator claim", async () => {
    for (const role of [LAUNCH_ROLE.alice, LAUNCH_ROLE.bob]) await send(role, s.orry, g.mockOrryAbi as Abi, "approve", [s.agentLaunch, (1n << 256n) - 1n]);
    const salt: Hex = await coinSalt(c.pub, s.agentLaunch, s.orry, s.accounts.alice, "Walk Agent", "WALK");
    coin = (await c.pub.readContract({ address: s.agentLaunch, abi: iAgentLaunchAbi as Abi, functionName: "predictCoin", args: [s.accounts.alice, salt, "Walk Agent", "WALK"] })) as Address;
    await send(LAUNCH_ROLE.alice, s.agentLaunch, iAgentLaunchAbi as Abi, "launch", [BigInt(s.agentId), "Walk Agent", "WALK", salt, 10_000n * E18, 0n]);
    // bob has 300 USD staked: an early allowance of 0.15% of supply
    const acc = await get<LaunchAccountResponse>(`/v1/launch/accounts/${s.accounts.bob}`);
    await index();
    const acc2 = await get<LaunchAccountResponse>(`/v1/launch/accounts/${s.accounts.bob}`);
    expect(acc.status).toBe(200);
    expect(acc2.body.stakeUsd).toBe("300000000");
    expect(acc2.body.early[0]).toMatchObject({ coin: coin.toLowerCase(), symbol: "WALK", allowance: (LAUNCH_SUPPLY * 50n * 300n / (10_000n * 1000n)).toString(), bought: "0" });
    const deadline = (await c.pub.getBlock()).timestamp + 600n;
    await send(LAUNCH_ROLE.bob, s.agentLaunch, iAgentLaunchAbi as Abi, "buyEarly", [coin, 5_000n * E18, 1n, deadline]);

    await warp(700);
    await swap(LAUNCH_ROLE.carol, true, -(20_000n * E18));
    await swap(LAUNCH_ROLE.carol, false, -(100_000n * E18));
    await send(LAUNCH_ROLE.carol, s.orry, g.mockOrryAbi as Abi, "approve", [s.spokeRouter, (1n << 256n) - 1n]);
    const dl = (await c.pub.getBlock()).timestamp + 300n;
    await send(LAUNCH_ROLE.carol, s.spokeRouter, g.spokeRouterAbi as Abi, "buy", [coin, 1_000n * E18, 1n, dl]);
    await index();

    const list = await get<LaunchCoinsResponse>("/v1/launch/coins");
    expect(list.status).toBe(200);
    const v = list.body.coins.find((x) => x.coin === coin.toLowerCase())!;
    expect(v).toMatchObject({ agentId: s.agentId, name: "Walk Agent", symbol: "WALK", creator: s.accounts.alice.toLowerCase(), firstBuyOrry: (10_000n * E18).toString(), earlyBuys: 1, trades: 5 });
    expect(BigInt(v.volumeOrry)).toBeGreaterThan(30_000n * E18);
    expect(BigInt(v.priceOrry)).toBeGreaterThan(0n);
    expect(list.body.totals.coins).toBe(1);

    const page = await get<LaunchCoinResponse>(`/v1/launch/coins/${coin}`);
    expect(page.status).toBe(200);
    expect(page.body.trades.map((t) => t.kind)).toEqual(["buy", "sell", "buy", "early"]);
    expect(page.body.trades[0]!.account).toBe(s.accounts.carol.toLowerCase()); // through SpokeRouter: the trader
    expect(page.body.trades[1]!.account).toBe(s.swapRouter.toLowerCase()); // another router: the router
    expect(page.body.trades[3]!.account).toBe(s.accounts.bob.toLowerCase());
    expect(page.body.live).toMatchObject({ early: false, feePips: 10_000, walletBound: true, agentWallet: s.accounts.aliceWallet.toLowerCase(), creatorOwed: "0" });
    expect(BigInt(page.body.live!.sqrtPriceX96)).toBeGreaterThan(0n);
    expect(page.body.coin.priceOrry).toBe(
      ((10n ** 18n << 192n) / (BigInt(page.body.live!.sqrtPriceX96) * BigInt(page.body.live!.sqrtPriceX96))).toString(),
    );
    const pending = BigInt(page.body.live!.pendingFees);
    expect(pending).toBeGreaterThan(0n);

    await send(LAUNCH_ROLE.carol, s.agentLaunch, iAgentLaunchAbi as Abi, "distribute", [coin]);
    await send(LAUNCH_ROLE.carol, s.agentLaunch, iAgentLaunchAbi as Abi, "claimCreatorFees", [coin]);
    await index();
    const after = await get<LaunchCoinResponse>(`/v1/launch/coins/${coin}`);
    const creator = (pending * 5000n) / 10_000n;
    const earn = (pending * 2000n) / 10_000n;
    const owner = (pending * 1500n) / 10_000n;
    expect(after.body.coin).toMatchObject({
      feesDistributed: pending.toString(),
      creatorFees: creator.toString(),
      earnFees: earn.toString(),
      ownerFees: owner.toString(),
      burned: (pending - creator - earn - owner).toString(),
      creatorClaimed: creator.toString(),
    });
    expect(after.body.live!.pendingFees).toBe("0");
    const walletBalance = (await c.pub.readContract({ address: s.orry, abi: g.mockOrryAbi as Abi, functionName: "balanceOf", args: [s.accounts.aliceWallet] })) as bigint;
    expect(walletBalance).toBe(creator);
    const burnRows = await sql<{ n: string }[]>`select count(*)::text as n from launch_events where event = 'Burned' and (args->>'source') = '50'`;
    expect(Number(burnRows[0]!.n)).toBe(1);
  });

  it("answers 404 for an address that is not a launched coin and 400 for a bad address", async () => {
    expect((await get(`/v1/launch/coins/${s.orry}`)).status).toBe(404);
    expect((await get(`/v1/launch/coins/0x1234`)).status).toBe(400);
    expect((await get(`/v1/launch/accounts/nope`)).status).toBe(400);
  });

  it("re-indexing the same range changes nothing", async () => {
    const before = await sql`select * from launch_coins order by coin`;
    await sql`update indexer_state set last_block = ${s.startBlock} where id = 'launch'`;
    await index();
    const again = await sql`select * from launch_coins order by coin`;
    expect(again).toEqual(before);
  });
});
