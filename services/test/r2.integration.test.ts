import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, toHex, type Abi, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import {
  LIMIT_ORDER_DOMAIN,
  iPredictionMarketAbi,
  LIMIT_ORDER_TYPES,
  type LimitOrdersResponse,
  type PaymasterResponse,
  type PredictMarketsResponse,
  type R2AccountResponse,
} from "@orrery/shared";
import { buildApi, connect, loadConfig, makeChain, migrate, setRelease, type Config, type Sql } from "@orrery/server";
import { indexR2Once } from "../packages/server/src/r2-indexer.js";
import { R2Keeper } from "../packages/server/src/r2-keeper.js";
import { loadR2KeeperKey } from "../packages/server/src/r2-config.js";
import * as g from "../scripts/r2-generated.js";
import { deployR2Stack, r2Clients, R2_ROLE, type R2Stack } from "../scripts/r2-stack.js";
import { DATABASE_URL, R2_ANVIL_PORT } from "./env.js";
import { startAnvil } from "./orry-system.js";
import { accountKeyTypedData, commitmentOf, deriveAccountKeys, encryptNote, ownerHash, randomField, secretCommit, ShieldedWallet, eventFromJson } from "../packages/web/lib/r2/shield/index.js";
import type { ShieldEventsResponse, ShieldInfo } from "@orrery/shared";

/**
 * Lane L3 services (`docs/updates/L3-R2-SPEC.md` section 7) against the real R2 contracts on their own anvil, with the
 * R1 test stand-ins around them (scripts/r2-stack.ts): indexer, API behind the release switch, keeper.
 */

const RPC = `http://127.0.0.1:${R2_ANVIL_PORT}`;
const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
let anvil: ChildProcess | undefined;
let s: R2Stack;
let c: ReturnType<typeof r2Clients>;
let cfg: Config;
let sql: Sql;
let app: ReturnType<typeof buildApi>;
let keeper: R2Keeper;

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
const chainNow = async () => (await c.pub.getBlock()).timestamp;
async function index() {
  await rpc("anvil_mine", [toHex(cfg.confirmations + 1)]);
  let r;
  do r = await indexR2Once(cfg.r2!, makeChain(cfg), sql, cfg.confirmations, { range: 50n });
  while (r.lag > BigInt(cfg.confirmations));
}

beforeAll(async () => {
  anvil = await startAnvil(R2_ANVIL_PORT);
  c = r2Clients(RPC);
  s = await deployR2Stack(RPC);
  sql = connect(DATABASE_URL);
  await migrate(sql);
  cfg = loadConfig({
    ORRERY_CHAIN_ID: "31337",
    ORRERY_RPC_URL: RPC,
    ORRERY_DATABASE_URL: DATABASE_URL,
    ORRERY_MODULE: s.registry,
    ORRERY_ATTESTOR: s.registry,
    ORRERY_LENS: s.registry,
    ORRERY_REGISTRY: s.registry,
    ORRERY_USDG: s.usdg,
    ORRERY_TREASURY: s.treasury,
    ORRERY_CONFIRMATIONS: "2",
    ORRERY_ORRY_FEATURES: "",
    ORRERY_RELEASES_CACHE_MS: "0",
    ORRERY_PUBLIC_RATE_PER_MINUTE: "600",
    ORRERY_PREDICT_FACTORY: s.predictFactory,
    ORRERY_LIMIT_BOOK: s.limitBook,
    ORRERY_PAYMASTERS: s.paymaster,
    ORRERY_SHIELD: s.shield,
    ORRERY_R2_START_BLOCK: s.startBlock,
    ORRERY_R2_CACHE_MS: "0",
  } as NodeJS.ProcessEnv);
  app = buildApi(cfg, makeChain(cfg), sql);
  keeper = new R2Keeper(cfg.r2!, makeChain(cfg), loadR2KeeperKey({ ORRERY_CHAIN_ID: "31337" } as NodeJS.ProcessEnv), sql, { flushEveryMs: 0 });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await sql?.end();
  anvil?.kill("SIGTERM");
});

describe("release switch", () => {
  it("holds every R2 route as an unknown route until its release opens, except the account view", async () => {
    for (const f of ["predict", "limit-orders", "paymaster"]) await setRelease(sql, f, null, "test");
    const unknown = await app.inject({ method: "GET", url: "/v1/nothing-here" });
    for (const url of ["/v1/r2/predict", "/v1/r2/limit-orders", "/v1/r2/paymaster"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(404);
      // the 404 of an unknown route: same shape, only the path in the message differs
      expect(r.body).toBe(unknown.body.replace("/v1/nothing-here", url));
    }
    expect((await app.inject({ method: "POST", url: "/v1/r2/limit-orders", payload: {} })).statusCode).toBe(404);
    expect((await get(`/v1/r2/accounts/${s.accounts.alice}`)).status).toBe(200);
    for (const f of ["predict", "limit-orders", "paymaster"]) await setRelease(sql, f, new Date(0), "test");
    const opened = await app.inject({ method: "GET", url: "/v1/r2/predict" });
    expect(opened.statusCode).toBe(200);
  });
});

describe("prediction markets", () => {
  let market: Address;

  it("indexes a market and its stakes, then the keeper settles it at the first round after the close", async () => {
    const close = (await chainNow()) + 7200n;
    await send(R2_ROLE.alice, s.predictFactory, g.predictionMarketFactoryAbi as Abi, "create", [s.stockFeed, 360_00000000n, close]);
    market = (await c.pub.readContract({ address: s.predictFactory, abi: g.predictionMarketFactoryAbi as Abi, functionName: "marketAt", args: [0n] })) as Address;
    for (const [role, yes, amount] of [[R2_ROLE.alice, true, 100n], [R2_ROLE.carol, true, 300n], [R2_ROLE.bob, false, 600n]] as const) {
      await send(role, s.usdg, g.mockUsdgAbi as Abi, "approve", [market, (1n << 256n) - 1n]);
      await send(role, market, iPredictionMarketAbi as Abi, "stake", [yes, amount * E6]);
    }
    await index();
    const list = await get<PredictMarketsResponse>("/v1/r2/predict");
    expect(list.status).toBe(200);
    const m = list.body.markets.find((x) => x.market === market.toLowerCase())!;
    expect(m).toMatchObject({ status: "open", yesPool: "400000000", noPool: "600000000", stakers: 3, strike: "36000000000", feeBps: 200, decimals: 8 });
    expect(m.asset).toBe(s.stock.toLowerCase());
    expect(m.latest?.answer).toBe("35825000000");

    // nothing to do before the close
    expect((await keeper.passOnce()).filter((x) => x.job === "settle")).toHaveLength(0);
    await warp(7200 - 100);
    await send(R2_ROLE.deployer, s.stockFeed, g.mockFeedAbi as Abi, "push", [370_00000000n, await chainNow()]);
    await warp(130);
    expect((await keeper.passOnce()).find((x) => x.job === "settle")?.reason).toBe("no round after the close yet");
    await send(R2_ROLE.deployer, s.stockFeed, g.mockFeedAbi as Abi, "push", [361_00000000n, await chainNow()]);
    await send(R2_ROLE.deployer, s.stockFeed, g.mockFeedAbi as Abi, "push", [355_00000000n, (await chainNow()) + 1n]);
    await warp(5);
    const steps = await keeper.passOnce();
    expect(steps.find((x) => x.job === "settle")?.status).toBe("sent");
    await index();
    const after = (await get<PredictMarketsResponse>("/v1/r2/predict")).body.markets.find((x) => x.market === market.toLowerCase())!;
    expect(after.status).toBe("yes"); // the first round after the close was 361 > 360, not the later 355
    expect(after.settlePrice).toBe("36100000000");
  });

  it("shows positions and claims on the account view", async () => {
    await send(R2_ROLE.alice, market, iPredictionMarketAbi as Abi, "claim", [false]);
    await index();
    const acc = await get<R2AccountResponse>(`/v1/r2/accounts/${s.accounts.alice}`);
    const p = acc.body.predict.find((x) => x.market === market.toLowerCase())!;
    expect(p).toMatchObject({ yes: "100000000", no: "0", claimed: true, payout: "245000000" });
    const one = await get<{ status: string }>(`/v1/r2/predict/${market}`);
    expect(one.status).toBe(200);
    expect((await get(`/v1/r2/predict/0x000000000000000000000000000000000000dEaD`)).status).toBe(404);
    expect((await get(`/v1/r2/predict/nope`)).status).toBe(400);
  });
});

describe("limit orders", () => {
  const sign = async (o: Record<string, unknown>) => {
    const w = c.wallet(R2_ROLE.alice);
    return w.signTypedData({
      account: w.account,
      domain: { ...LIMIT_ORDER_DOMAIN, chainId: 31337, verifyingContract: s.limitBook },
      types: LIMIT_ORDER_TYPES,
      primaryType: "Order",
      message: o as never,
    });
  };
  let hash: string;

  it("stores a signed order after checking it, and refuses bad ones", async () => {
    const expiry = Number(await chainNow()) + 86_400;
    const order = { owner: s.accounts.alice, asset: s.stock, sellAsset: true, amountIn: E18, limitPrice: 350n * E6, tipBps: 20, payFeeInOrry: false, nonce: 7n, expiry: BigInt(expiry) };
    const signature = await sign(order);
    const body = { ...order, amountIn: E18.toString(), limitPrice: (350n * E6).toString(), nonce: "7", expiry, signature };
    const r = await app.inject({ method: "POST", url: "/v1/r2/limit-orders", payload: body });
    expect(r.statusCode).toBe(201);
    hash = r.json().hash;
    expect((await app.inject({ method: "POST", url: "/v1/r2/limit-orders", payload: body })).statusCode).toBe(409);
    const wrong = await app.inject({ method: "POST", url: "/v1/r2/limit-orders", payload: { ...body, limitPrice: "1" } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("Signature and order fields disagree.");
    const unlisted = await app.inject({ method: "POST", url: "/v1/r2/limit-orders", payload: { ...body, asset: s.usdg } });
    expect(unlisted.json().error).toBe("Limit orders are not offered for this asset.");
    const late = await app.inject({ method: "POST", url: "/v1/r2/limit-orders", payload: { ...body, expiry: expiry + 40 * 86_400 } });
    expect(late.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/r2/limit-orders", payload: { ...body, tipBps: 500 } })).statusCode).toBe(400);
    const list = await get<LimitOrdersResponse>(`/v1/r2/limit-orders?owner=${s.accounts.alice}`);
    expect(list.body.orders).toHaveLength(1);
    expect(list.body.orders[0]).toMatchObject({ hash, status: "open", tipBps: 20 });
    expect(list.body.feeBps).toBe(10);
  });

  it("the keeper fills it through the pool and the indexer records the fill", async () => {
    const before = (await c.pub.readContract({ address: s.usdg, abi: g.mockUsdgAbi as Abi, functionName: "balanceOf", args: [s.accounts.alice] })) as bigint;
    const steps = await keeper.passOnce();
    const fill = steps.find((x) => x.job === "fill");
    expect(fill?.status).toBe("sent");
    await index();
    const list = await get<LimitOrdersResponse>(`/v1/r2/limit-orders?owner=${s.accounts.alice}`);
    const o = list.body.orders[0]!;
    expect(o.status).toBe("filled");
    expect(BigInt(o.fill!.amountOut)).toBeGreaterThan(350n * E6);
    const after = (await c.pub.readContract({ address: s.usdg, abi: g.mockUsdgAbi as Abi, functionName: "balanceOf", args: [s.accounts.alice] })) as bigint;
    expect(after - before).toBe(BigInt(o.fill!.amountOut) - BigInt(o.fill!.usdgFee) - BigInt(o.fill!.tip));
    // filled once: the next pass has nothing to fill
    expect((await keeper.passOnce()).filter((x) => x.job === "fill")).toHaveLength(0);
  });
});

describe("paymaster", () => {
  it("shows the cached rate and an account's prepaid ORRY and charged operations", async () => {
    const pm = await get<PaymasterResponse>("/v1/r2/paymaster");
    expect(pm.status).toBe(200);
    expect(pm.body.paymasters[0]).toMatchObject({ paymaster: s.paymaster.toLowerCase(), premiumBps: 1000, version: "0.8" });
    expect(BigInt(pm.body.paymasters[0]!.rate!)).toBeGreaterThan(10n ** 24n);
    const agent = s.accounts.agent;
    await send(R2_ROLE.operator, s.paymaster, g.orryPaymasterAbi as Abi, "deposit", [agent, 5_000n * E18]);
    const op = {
      sender: agent, nonce: 0n, initCode: "0x", callData: "0x", accountGasLimits: toHex(0, { size: 32 }), preVerificationGas: 0n,
      gasFees: toHex(0, { size: 32 }), paymasterAndData: (s.paymaster + toHex(100_000n, { size: 16 }).slice(2) + toHex(150_000n, { size: 16 }).slice(2)) as Hex,
      signature: "0x",
    };
    await send(R2_ROLE.deployer, s.entryPoint, g.mockEntryPointAbi as Abi, "run", [s.paymaster, op, 10n ** 15n, 2n * 10n ** 14n, 10n ** 9n]);
    await index();
    const acc = await get<R2AccountResponse>(`/v1/r2/accounts/${agent}`);
    const gas = acc.body.gas[0]!;
    expect(gas.ops).toBe(1);
    expect(BigInt(gas.balance) + BigInt(gas.charged)).toBe(5_000n * E18);
    // the keeper flushes what the operation earned (premium burned, the rest to the recipient)
    const steps = await keeper.passOnce();
    expect(steps.find((x) => x.job === "flush")?.status).toBe("sent");
    expect(getAddress(agent)).toBe(agent);
  });

  it("refreshes the cached rate once it is half its usable age", async () => {
    await warp(1900);
    await send(R2_ROLE.deployer, s.ethFeed, g.mockFeedAbi as Abi, "push", [2235_00000000n, await chainNow()]);
    const steps = await keeper.passOnce();
    expect(steps.find((x) => x.job === "refresh")?.status).toBe("sent");
  });
});

describe("shield", () => {
  it("indexes a deposit, serves the event stream (never held) and the pool info behind its release", async () => {
    const w = c.wallet(R2_ROLE.carol);
    const keys = deriveAccountKeys(await w.signTypedData({ account: w.account, ...accountKeyTypedData(31337) }));
    await send(R2_ROLE.carol, s.shield, g.orreryShieldAbi as Abi, "register", [keys.npk, keys.viewKey]);
    const fee = (await c.pub.readContract({ address: s.shield, abi: g.orreryShieldAbi as Abi, functionName: "depositFee", args: [s.accounts.carol, 100n * E6] })) as bigint;
    expect(fee).toBe(500_000n);
    const note = { asset: BigInt(s.usdg), amount: 100n * E6 - fee, blinding: randomField(), ownerHash: ownerHash(s.accounts.carol, keys.npk) };
    await send(R2_ROLE.carol, s.shield, g.orreryShieldAbi as Abi, "deposit", [100n * E6, secretCommit(note), encryptNote(keys.viewKey, note)]);
    await index();

    await setRelease(sql, "shield", null, "test");
    expect((await app.inject({ method: "GET", url: "/v1/r2/shield" })).statusCode).toBe(404);
    const ev = await get<ShieldEventsResponse>("/v1/r2/shield/events");
    expect(ev.status).toBe(200);
    expect(ev.body.done).toBe(true);
    expect(ev.body.events).toHaveLength(1);
    expect(ev.body.events[0]).toMatchObject({ type: "Deposited", amount: "100000000", fee: "500000", leafIndex: 0, commitment: commitmentOf(note).toString() });
    // the client rebuilds the note and the tree root the pool knows
    const wallet = new ShieldedWallet(s.accounts.carol, keys);
    wallet.apply(ev.body.events.map((e) => eventFromJson(e as Record<string, unknown>)));
    expect(wallet.balance()).toBe(99_500_000n);
    expect(await c.pub.readContract({ address: s.shield, abi: g.orreryShieldAbi as Abi, functionName: "knownRoots", args: [wallet.tree.root()] })).toBe(true);
    const next = await get<ShieldEventsResponse>(`/v1/r2/shield/events?after=${ev.body.cursor}`);
    expect(next.body.events).toHaveLength(0);
    expect((await get("/v1/r2/shield/events?after=nope")).status).toBe(400);

    await setRelease(sql, "shield", new Date(0), "test");
    const info = await get<ShieldInfo>("/v1/r2/shield");
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ pool: s.shield.toLowerCase(), asset: s.usdg.toLowerCase(), depositFeeBps: 50, withdrawFeeBps: 50, leaves: 1, deposits: 1 });
  });
});
