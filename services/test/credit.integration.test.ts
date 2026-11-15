import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toHex, type Abi, type Address } from "viem";
import type { AttestersResponse, AttesterEpochResponse, CreditAccountResponse, CreditLinesResponse, CreditPoolsResponse } from "@orrery/shared";
import { buildApi, connect, loadConfig, makeChain, migrate, setRelease, type Config, type Sql } from "@orrery/server";
import { indexCreditOnce } from "../packages/server/src/credit-indexer.js";
import { planEpoch } from "../packages/server/src/credit-epoch.js";
import * as g from "../scripts/credit-generated.js";
import { CREDIT_ROLE, creditClients, creditSend, deployCreditStack, seedCreditStack, type CreditStack } from "../scripts/credit-stack.js";
import { CREDIT_ANVIL_PORT, DATABASE_URL } from "./env.js";
import { startAnvil } from "./orry-system.js";

/**
 * Lane L4 services (`docs/updates/L4-CREDIT-SPEC.md` 6) against the real L4 contracts and the real `OrreryAttestor` on
 * their own anvil: indexer, API behind the release switch, the epoch job's plan.
 */

const RPC = `http://127.0.0.1:${CREDIT_ANVIL_PORT}`;
const E6 = 10n ** 6n;
let anvil: ChildProcess | undefined;
let s: CreditStack;
let c: ReturnType<typeof creditClients>;
let cfg: Config;
let sql: Sql;
let app: ReturnType<typeof buildApi>;
let agent: bigint;

const get = async <T>(url: string) => {
  const r = await app.inject({ method: "GET", url });
  return { status: r.statusCode, body: r.json() as T };
};
const rpc = (method: string, params: unknown[]) => c.pub.request({ method: method as never, params: params as never });
async function warp(seconds: number) {
  await rpc("evm_increaseTime", [toHex(seconds)]);
  await rpc("evm_mine", []);
}
async function index() {
  await rpc("anvil_mine", [toHex(cfg.confirmations + 1)]);
  let r;
  do r = await indexCreditOnce(cfg.credit!, makeChain(cfg), sql, cfg.confirmations, 50n);
  while (r.lag > BigInt(cfg.confirmations));
}

beforeAll(async () => {
  anvil = await startAnvil(CREDIT_ANVIL_PORT);
  c = creditClients(RPC);
  s = await deployCreditStack(RPC, { epochLength: 3600 });
  ({ agent } = await seedCreditStack(RPC, s));
  sql = connect(DATABASE_URL);
  await migrate(sql);
  await sql`delete from indexer_state where id = 'credit'`;
  await sql`truncate credit_events, attester_results, credit_pools, credit_lines, credit_lenders`;
  cfg = loadConfig({
    ORRERY_CHAIN_ID: "31337",
    ORRERY_RPC_URL: RPC,
    ORRERY_DATABASE_URL: DATABASE_URL,
    ORRERY_MODULE: s.identity,
    ORRERY_ATTESTOR: s.attestor,
    ORRERY_LENS: s.identity,
    ORRERY_REGISTRY: s.identity,
    ORRERY_USDG: s.usdg,
    ORRERY_TREASURY: s.treasury,
    ORRERY_CONFIRMATIONS: "2",
    ORRERY_ORRY_FEATURES: "",
    ORRERY_ATTESTER_REGISTRY: s.registry,
    ORRERY_ATTESTER_SPLITTER: s.splitter,
    ORRERY_CREDIT_FACTORY: s.factory,
    ORRERY_CREDIT_START_BLOCK: s.startBlock.toString(),
    ORRERY_CREDIT_CACHE_MS: "0",
    ORRERY_RELEASES_CACHE_MS: "0",
  });
  app = buildApi(cfg, makeChain(cfg), sql);
  await index();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await sql?.end();
  anvil?.kill("SIGTERM");
});

describe("L4 indexer", () => {
  it("finds the pool, its line and router, the lender and the forwarded results", async () => {
    const pools = await sql<{ pool: string }[]>`select pool from credit_pools`;
    expect(pools.map((p) => p.pool)).toEqual([s.pool.toLowerCase()]);
    const lines = await sql<{ agent_id: string; router: string }[]>`select agent_id::text, router from credit_lines`;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.agent_id).toBe(agent.toString());
    const swept = await sql<{ n: string }[]>`select count(*)::text as n from credit_events where source = 'router' and event = 'Swept'`;
    expect(swept[0]!.n).toBe("1"); // a router found mid-range is read in the same range
    const results = await sql<{ staker: string }[]>`select staker from attester_results order by block_number`;
    expect(results.map((x) => x.staker)).toEqual([c.address(CREDIT_ROLE.attesterA).toLowerCase(), c.address(CREDIT_ROLE.attesterB).toLowerCase()]);
  });
});

describe("L4 API behind the release switch", () => {
  it("holds every route until its feature opens; a wallet's account is never held", async () => {
    expect((await get("/v1/attesters")).status).toBe(404);
    expect((await get("/v1/credit/pools")).status).toBe(404);
    expect((await get(`/v1/credit/lines/${agent}`)).status).toBe(404);
    const acct = await get<CreditAccountResponse>(`/v1/credit/accounts/${c.address(CREDIT_ROLE.lender)}`);
    expect(acct.status).toBe(200);
    expect(acct.body.positions).toHaveLength(1);
    expect(acct.body.positions[0]!.value).toBe((25_000n * E6).toString());
  });

  it("attesters: ranked set, results and the epoch pool", async () => {
    await setRelease(sql, "attesters", new Date(0), "l4-test");
    const r = await get<AttestersResponse>("/v1/attesters");
    expect(r.status).toBe(200);
    expect(r.body.rolled).toBe(true);
    expect(r.body.attesters.map((a) => a.rank)).toEqual([1, 2]);
    expect(r.body.attesters[0]!.staker).toBe(c.address(CREDIT_ROLE.attesterA));
    expect(r.body.attesters[0]!.results).toBe(1);
    expect(r.body.epochPool).toBe("3000000"); // 30% of two 5 USDG verifications
    expect(r.body.minStake).toBe((1_000_000n * 10n ** 18n).toString());
    const e = await get<AttesterEpochResponse>("/v1/attesters/epochs/0");
    expect(e.body.active).toHaveLength(2);
    expect(e.body.active[0]!.share).toBe("1500000");
    expect((await get("/v1/attesters/epochs/x")).status).toBe(400);
    expect((await get("/v1/attesters/0x0000000000000000000000000000000000000abc")).status).toBe(404);
  });

  it("claimable shows after the epoch ends, and claim pays it", async () => {
    await warp(3600);
    const before = await get<CreditAccountResponse>(`/v1/credit/accounts/${c.address(CREDIT_ROLE.attesterA)}`);
    expect(before.body.attester?.claimable).toEqual([{ epoch: 0, amount: "1500000" }]);
    await creditSend(RPC, CREDIT_ROLE.attesterA, s.splitter, g.AttesterFeeSplitter.abi as Abi, "claim", [0n]);
    const after = await get<CreditAccountResponse>(`/v1/credit/accounts/${c.address(CREDIT_ROLE.attesterA)}`);
    expect(after.body.attester?.claimable).toEqual([]);
  });

  it("credit: pools and lines with live accounting", async () => {
    await setRelease(sql, "credit", new Date(0), "l4-test");
    const pools = await get<CreditPoolsResponse>("/v1/credit/pools");
    expect(pools.status).toBe(200);
    const p = pools.body.pools[0]!;
    expect(p.params.aprBps).toBe(1200);
    expect(p.params.tierMultBps).toEqual([10_000, 15_000, 20_000, 30_000]);
    expect(p.lines).toBe(1);
    expect(BigInt(p.totalPrincipal)).toBeLessThan(900n * E6); // the router repaid part of the 900 drawn
    expect(p.utilizationBps).toBeGreaterThan(0);
    expect((await get(`/v1/credit/lines/${agent}`)).status).toBe(404); // lines stay behind credit-bond
    await setRelease(sql, "credit-bond", new Date(0), "l4-test");
    const lines = await get<CreditLinesResponse>(`/v1/credit/lines/${agent}`);
    expect(lines.status).toBe(200);
    const l = lines.body.lines[0]!;
    expect(l.bond).toBe((150_000n * 10n ** 18n).toString());
    expect(l.limit).toBe((1_500n * E6).toString());
    expect(l.tierMultBps).toBe(10_000);
    expect(l.defaulted).toBe(false);
    expect((await get(`/v1/credit/pools/${s.pool}`)).status).toBe(200);
    expect((await get("/v1/credit/pools/0x0000000000000000000000000000000000000abc")).status).toBe(404);
  });
});

describe("L4 epoch job (dry run)", () => {
  it("plans the roll and the split, and reports the treasury checklist", async () => {
    // new revenue in epoch 1, no roll yet
    const op = c.address(CREDIT_ROLE.operator2);
    await creditSend(RPC, CREDIT_ROLE.ops, s.usdg, g.CreditUsdg.abi as Abi, "mint", [s.splitter, 7n * E6]);
    await index();
    const plan = await planEpoch(cfg.credit!, makeChain(cfg), sql);
    expect(plan.epoch).toBe(1);
    expect(plan.rolled).toBe(false);
    expect(plan.txs.map((t) => t.fn)).toEqual(["split", "rollEpoch"]);
    expect(plan.nextSet.map((x) => x.toLowerCase())).toEqual([c.address(CREDIT_ROLE.attesterA).toLowerCase(), c.address(CREDIT_ROLE.attesterB).toLowerCase()]);
    expect(plan.checklist.find((x) => x.item.includes("attester key"))?.ok).toBe(true);
    expect(plan.checklist.find((x) => x.item.includes("is the splitter"))?.ok).toBe(true);
    expect(plan.checklist.find((x) => x.item.includes("coin is set"))?.ok).toBe(false);
    expect(op).toBeTruthy();
  });

  it("proposes an exclusion when an attester disagrees with the majority", async () => {
    await creditSend(RPC, CREDIT_ROLE.ops, s.registry, g.AttesterRegistry.abi as Abi, "rollEpoch");
    // three probers would be needed for a majority with two disagreeing; fake a third view via direct rows
    await sql`insert into attester_results (block_number, log_index, epoch, staker, agent_id, probe_key, observed_at, endpoints_live, registration_valid, domain_verified, counted, block_time) values
      (999000001, 0, 1, '0xa1', 77, '0xp1', 1, true, true, false, true, now()),
      (999000001, 1, 1, '0xa2', 77, '0xp2', 1, true, true, false, true, now()),
      (999000001, 2, 1, '0xbad', 77, '0xp3', 1, false, true, false, true, now())`;
    const plan = await planEpoch(cfg.credit!, makeChain(cfg), sql);
    const ex = plan.txs.find((t) => t.fn === "exclude");
    expect(ex?.args[0]).toBe("0xbad");
    expect(ex?.who).toBe("attestor owner");
    await sql`delete from attester_results where block_number = 999000001`;
  });
});
