import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress, isAddress, type Abi, type Address } from "viem";
import {
  attesterFeeSplitterAbi,
  attesterRegistryAbi,
  creditPoolAbi,
  type AttesterAccount,
  type AttesterEpochResponse,
  type AttestersResponse,
  type AttesterView,
  type CreditAccountResponse,
  type CreditLineView,
  type CreditLinesResponse,
  type CreditPoolParams,
  type CreditPoolView,
  type CreditPoolsResponse,
  type ReleaseFeature,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { releasesFor } from "./releases.js";

/**
 * Lane L4 routes (`docs/updates/L4-CREDIT-SPEC.md` 6). Attesters behind `attesters`, pools behind `credit`, lines and
 * bonds behind `credit-bond`; a held feature answers 404 like an unknown route. A wallet's own positions are never
 * held. Live contract state is read from the chain (cached `cacheMs`); the index names the contracts and the results.
 */

export interface CreditRouteDeps {
  allowPublic: (ip: string) => boolean;
}

const REG = attesterRegistryAbi as Abi;
const SPL = attesterFeeSplitterAbi as Abi;
const POOL = creditPoolAbi as Abi;
const lower = (a: string) => a.toLowerCase();
const num = (v: unknown) => Number(v as bigint);
const str = (v: unknown) => (v as bigint).toString();

interface StakerTuple {
  amount: bigint;
  lockedAt: bigint;
  unlockAt: bigint;
  probeKey: Address;
  excludedUntilEpoch: bigint;
}

interface LineTuple {
  bondOwner: Address;
  router: Address;
  bond: bigint;
  principal: bigint;
  interest: bigint;
  recovery: bigint;
  repaidUsdDays: bigint;
  lastAccrual: bigint;
  dueAt: bigint;
  defaulted: boolean;
}

export function registerCreditRoutes(app: FastifyInstance, cfg: Config, chain: Chain, sql: Sql, deps: CreditRouteDeps): void {
  const c = cfg.credit;
  if (!c) return;
  const releases = releasesFor(sql, cfg.releaseSeed, cfg.releasesCacheMs);
  const gate = (feature: ReleaseFeature) => async (req: FastifyRequest, reply: FastifyReply) => {
    let open = false;
    try {
      open = await releases.isOpen(feature);
    } catch {
      return reply.code(503).send({ error: "Try again in a moment." });
    }
    if (!open) return reply.callNotFound();
    if (!deps.allowPublic(req.ip)) return reply.code(429).send({ error: "Too many requests. Try again in a minute." });
  };
  const limited = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!deps.allowPublic(req.ip)) return reply.code(429).send({ error: "Too many requests. Try again in a minute." });
  };
  const cache = new Map<string, { at: number; value: unknown }>();
  async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < c!.cacheMs) return hit.value as T;
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 2_000) cache.delete(cache.keys().next().value as string);
    return value;
  }
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    chain.public.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  // ------------------------------------------------------------------ attesters

  async function registryInfo() {
    const r = c!.registry!;
    const [minStake, maxActive, epochLength, unlockDelay, genesis, epoch] = await Promise.all([
      read<bigint>(r, REG, "minStake"),
      read<bigint>(r, REG, "maxActive"),
      read<bigint>(r, REG, "epochLength"),
      read<bigint>(r, REG, "unlockDelay"),
      read<bigint>(r, REG, "genesis"),
      read<bigint>(r, REG, "currentEpoch"),
    ]);
    return { minStake, maxActive: num(maxActive), epochLength: num(epochLength), unlockDelay: num(unlockDelay), genesis: num(genesis), epoch };
  }

  async function attesterView(staker: Address, epoch: bigint, ranks: Map<string, number>): Promise<AttesterView | null> {
    const r = c!.registry!;
    const [s, active, results] = await Promise.all([
      read<StakerTuple>(r, REG, "stakerOf", [staker]),
      read<boolean>(r, REG, "isActive", [epoch, staker]),
      read<bigint>(r, REG, "results", [epoch, staker]),
    ]);
    if (s.amount === 0n) return null;
    return {
      staker: getAddress(staker),
      probeKey: getAddress(s.probeKey),
      amount: s.amount.toString(),
      lockedAt: num(s.lockedAt),
      unlockAt: num(s.unlockAt),
      excludedUntilEpoch: num(s.excludedUntilEpoch),
      active,
      results: num(results),
      rank: ranks.get(lower(staker)) ?? null,
    };
  }

  if (c.registry) {
    const r = c.registry;
    app.get("/v1/attesters", { preHandler: gate("attesters") }, async (): Promise<AttestersResponse> =>
      cached("attesters", async () => {
        const info = await registryInfo();
        const [rolled, candidates, active, totalResults] = await Promise.all([
          read<boolean>(r, REG, "rolled", [info.epoch]),
          read<Address[]>(r, REG, "candidates"),
          read<Address[]>(r, REG, "activeSet", [info.epoch]),
          read<bigint>(r, REG, "totalResults", [info.epoch]),
        ]);
        const ranks = new Map(active.map((a, i) => [lower(a), i + 1]));
        const views = (await Promise.all(candidates.slice(0, 200).map((a) => attesterView(a, info.epoch, ranks)))).filter((v): v is AttesterView => v !== null);
        views.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0));
        let shareBps = 0;
        let epochPool = 0n;
        if (c.splitter) {
          [shareBps, epochPool] = await Promise.all([read<number>(c.splitter, SPL, "shareBps").then(Number), read<bigint>(c.splitter, SPL, "pool", [info.epoch])]);
        }
        return {
          registry: getAddress(r),
          splitter: c.splitter ? getAddress(c.splitter) : null,
          minStake: info.minStake.toString(),
          maxActive: info.maxActive,
          epochLength: info.epochLength,
          unlockDelay: info.unlockDelay,
          genesis: info.genesis,
          epoch: num(info.epoch),
          epochEndsAt: info.genesis + (num(info.epoch) + 1) * info.epochLength,
          rolled,
          shareBps,
          epochPool: epochPool.toString(),
          totalResults: num(totalResults),
          attesters: views,
        };
      }),
    );

    app.get<{ Params: { epoch: string } }>("/v1/attesters/epochs/:epoch", { preHandler: gate("attesters") }, async (req, reply) => {
      if (!/^\d{1,9}$/.test(req.params.epoch)) return reply.code(400).send({ error: "Pass an epoch number." });
      const e = BigInt(req.params.epoch);
      return cached(`epoch:${e}`, async (): Promise<AttesterEpochResponse> => {
        const info = await registryInfo();
        const [rolled, active, totalResults] = await Promise.all([
          read<boolean>(r, REG, "rolled", [e]),
          read<Address[]>(r, REG, "activeSet", [e]),
          read<bigint>(r, REG, "totalResults", [e]),
        ]);
        let pool = 0n;
        let claimed = 0n;
        let released = false;
        if (c.splitter) {
          [pool, claimed, released] = await Promise.all([
            read<bigint>(c.splitter, SPL, "pool", [e]),
            read<bigint>(c.splitter, SPL, "claimedTotal", [e]),
            read<boolean>(c.splitter, SPL, "released", [e]),
          ]);
        }
        const counted = await sql<{ staker: string; n: string }[]>`select staker, count(*)::text as n from attester_results where epoch = ${e.toString()} and counted group by staker`;
        const byStaker = new Map(counted.map((x) => [x.staker, BigInt(x.n)]));
        for (const a of active) if (!byStaker.has(lower(a))) byStaker.set(lower(a), await read<bigint>(r, REG, "results", [e, a]));
        const rows = [...byStaker.entries()].map(([staker, n]) => ({
          staker: getAddress(staker),
          results: Number(n),
          share: totalResults === 0n ? "0" : ((pool * n) / totalResults).toString(),
        }));
        rows.sort((a, b) => b.results - a.results);
        const start = info.genesis + Number(e) * info.epochLength;
        return { epoch: Number(e), startsAt: start, endsAt: start + info.epochLength, rolled, pool: pool.toString(), claimed: claimed.toString(), released, totalResults: num(totalResults), active: rows };
      });
    });

    app.get<{ Params: { address: string } }>("/v1/attesters/:address", { preHandler: gate("attesters") }, async (req, reply) => {
      if (!isAddress(req.params.address)) return reply.code(400).send({ error: "Pass a 0x address." });
      const a = await attesterAccount(getAddress(req.params.address));
      if (!a.staker && a.claimable.length === 0) return reply.code(404).send({ error: "This address has no attester stake." });
      return a;
    });
  }

  async function attesterAccount(address: Address): Promise<AttesterAccount> {
    const r = c!.registry!;
    const info = await registryInfo();
    const active = await read<Address[]>(r, REG, "activeSet", [info.epoch]);
    const view = await attesterView(address, info.epoch, new Map(active.map((x, i) => [lower(x), i + 1])));
    const claimable: { epoch: number; amount: string }[] = [];
    if (c!.splitter) {
      const epochs = await sql<{ epoch: string }[]>`select distinct epoch::text from attester_results where staker = ${lower(address)} and counted and epoch < ${info.epoch.toString()} order by epoch desc limit 12`;
      for (const { epoch } of epochs) {
        const amt = await read<bigint>(c!.splitter, SPL, "claimable", [BigInt(epoch), address]);
        if (amt > 0n) claimable.push({ epoch: Number(epoch), amount: amt.toString() });
      }
    }
    return { staker: view, claimable };
  }

  // ------------------------------------------------------------------ credit

  async function poolView(pool: Address, index: number, rawParams: Record<string, unknown>): Promise<CreditPoolView> {
    const [retired, totalAssets, cash, totalPrincipal, totalShares, totalBonds] = await Promise.all([
      read<boolean>(pool, POOL, "retired"),
      read<bigint>(pool, POOL, "totalAssets"),
      read<bigint>(pool, POOL, "cash"),
      read<bigint>(pool, POOL, "totalPrincipal"),
      read<bigint>(pool, POOL, "totalShares"),
      read<bigint>(pool, POOL, "totalBonds"),
    ]);
    const [count] = await sql<{ n: string }[]>`select count(*)::text as n from credit_lines where pool = ${lower(pool)}`;
    return {
      pool: getAddress(pool),
      index,
      retired,
      params: paramsView(rawParams),
      totalAssets: totalAssets.toString(),
      cash: cash.toString(),
      totalPrincipal: totalPrincipal.toString(),
      totalShares: totalShares.toString(),
      totalBonds: totalBonds.toString(),
      utilizationBps: totalAssets === 0n ? 0 : Number((totalPrincipal * 10_000n) / totalAssets),
      lines: Number(count?.n ?? 0),
    };
  }

  async function lineView(pool: Address, agentId: bigint): Promise<CreditLineView> {
    const [l, limit, owed, payout] = await Promise.all([
      read<LineTuple>(pool, POOL, "lineOf", [agentId]),
      read<bigint>(pool, POOL, "limitOf", [agentId]),
      read<bigint>(pool, POOL, "owedOf", [agentId]),
      read<Address>(pool, POOL, "payoutOf", [agentId]),
    ]);
    const mult = await read<number>(pool, POOL, "tierMultBps", [l.repaidUsdDays]);
    return {
      pool: getAddress(pool),
      agentId: agentId.toString(),
      bondOwner: getAddress(l.bondOwner),
      router: getAddress(l.router),
      payout: getAddress(payout),
      bond: str(l.bond),
      principal: str(l.principal),
      interest: str(l.interest),
      recovery: str(l.recovery),
      repaidUsdDays: str(l.repaidUsdDays),
      dueAt: num(l.dueAt),
      defaulted: l.defaulted,
      limit: limit.toString(),
      owed: owed.toString(),
      tierMultBps: Number(mult),
    };
  }

  if (c.factory) {
    const factory = c.factory;
    app.get("/v1/credit/pools", { preHandler: gate("credit") }, async (): Promise<CreditPoolsResponse> =>
      cached("pools", async () => {
        const rows = await sql<{ pool: string; pool_index: number; params: Record<string, unknown> }[]>`select pool, pool_index, params from credit_pools order by pool_index limit 100`;
        return { factory: getAddress(factory), pools: await Promise.all(rows.map((p) => poolView(p.pool as Address, p.pool_index, p.params))) };
      }),
    );

    app.get<{ Params: { address: string } }>("/v1/credit/pools/:address", { preHandler: gate("credit") }, async (req, reply) => {
      if (!isAddress(req.params.address)) return reply.code(400).send({ error: "Pass a 0x address." });
      const [row] = await sql<{ pool: string; pool_index: number; params: Record<string, unknown> }[]>`select pool, pool_index, params from credit_pools where pool = ${lower(req.params.address)}`;
      if (!row) return reply.code(404).send({ error: "No pool at that address." });
      return cached(`pool:${row.pool}`, () => poolView(row.pool as Address, row.pool_index, row.params));
    });

    app.get<{ Params: { agentId: string } }>("/v1/credit/lines/:agentId", { preHandler: gate("credit-bond") }, async (req, reply) => {
      if (!/^\d{1,30}$/.test(req.params.agentId)) return reply.code(400).send({ error: "Pass an agent id." });
      const id = BigInt(req.params.agentId);
      return cached(`lines:${id}`, async (): Promise<CreditLinesResponse> => {
        const rows = await sql<{ pool: string }[]>`select pool from credit_lines where agent_id = ${id.toString()} order by opened_block`;
        return { agentId: id.toString(), lines: await Promise.all(rows.map((r) => lineView(r.pool as Address, id))) };
      });
    });

    // never held: a wallet's own lender positions and attester stake
    app.get<{ Params: { address: string } }>("/v1/credit/accounts/:address", { preHandler: limited }, async (req, reply): Promise<CreditAccountResponse | void> => {
      if (!isAddress(req.params.address)) return reply.code(400).send({ error: "Pass a 0x address." });
      const address = getAddress(req.params.address);
      const pools = await sql<{ pool: string }[]>`select pool from credit_lenders where lender = ${lower(address)} order by pool`;
      const positions = await Promise.all(
        pools.map(async ({ pool }) => {
          const p = pool as Address;
          const [shares, value, orryClaimable] = await Promise.all([
            read<bigint>(p, POOL, "sharesOf", [address]),
            read<bigint>(p, POOL, "valueOf", [address]),
            read<bigint>(p, POOL, "orryClaimable", [address]),
          ]);
          return { pool: getAddress(p), shares: shares.toString(), value: value.toString(), orryClaimable: orryClaimable.toString() };
        }),
      );
      const attester = c.registry ? await attesterAccount(address) : null;
      return { address, positions: positions.filter((x) => x.shares !== "0" || x.orryClaimable !== "0"), attester };
    });
  }

}

function paramsView(p: Record<string, unknown>): CreditPoolParams {
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    aprBps: Number(p.aprBps),
    feeBps: Number(p.feeBps),
    repayBps: Number(p.repayBps),
    maxLineBps: Number(p.maxLineBps),
    term: Number(p.term),
    grace: Number(p.grace),
    minBondUsd: String(p.minBondUsd),
    maxLineUsdg: String(p.maxLineUsdg),
    tierUsdDays: arr(p.tierRepaid),
    tierMultBps: arr(p.tierMultBps).map(Number),
  };
}
