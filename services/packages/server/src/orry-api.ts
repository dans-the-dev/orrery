import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress, isAddress, parseAbi, type Address } from "viem";
import { z } from "zod";
import {
  NATIVE_ETH,
  iEarnVaultAbi,
  iOrryStakingAbi,
  maskAddress,
  orryPerQuoteRatio,
  orryPerWholeQuote,
  type QuoteAsset,
  type OrryAccountResponse,
  type OrryHubView,
  type OrryBurnsResponse,
  type OrryEarnResponse,
  type OrryFeature,
  type ReleaseFeature,
  type OrryLeaderboardResponse,
  type OrryStakeResponse,
} from "@orrery/shared";
import type { Config } from "./config.js";
import type { Chain } from "./chain.js";
import type { Sql } from "./db.js";
import { hubsOf, readSqrtPrice, type Hub } from "./orry-price.js";
import { agentClaimablesAt, assetOrder, claimablesAt, claimedAtHeight, earnedPerAsset, vaultsOf } from "./orry-indexer.js";

const erc20Meta = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
import { quoteChecks, quoteCredits, quoteVerification } from "./orry-quotes.js";
import { releasesFor } from "./releases.js";

/**
 * `/v1/orry/` routes (build spec §5, shapes frozen; types in `@orrery/shared` orry.ts). Every route sits behind the
 * release switch: a held feature answers the same 404 as an unknown route. Public reads are rate-limited per IP and
 * cached for `cacheMs`, so open browser tabs cannot run up RPC calls (workspace rule 7). Errors never carry RPC or
 * database detail.
 */

const READ_FAILED = "Could not read the chain right now. Try again shortly.";
const E18 = 10n ** 18n;

export function ttlCache(ms: number, max = 2_000) {
  const m = new Map<string, { at: number; v: Promise<unknown> }>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    const hit = m.get(key);
    if (hit && now - hit.at < ms) return hit.v as Promise<T>;
    if (m.size >= max) for (const [k, e] of m) if (now - e.at >= ms || m.size >= max) m.delete(k);
    const v = fn();
    m.set(key, { at: now, v });
    v.catch(() => m.delete(key));
    return v;
  };
}

const sumPair = (row: { eth: string | null; orry: string | null } | undefined) => ({ eth: row?.eth ?? "0", orry: row?.orry ?? "0" });

export interface OrryRouteDeps {
  allowPublic: (ip: string) => boolean;
  makeLimiter: (perMinute: number) => (ip: string) => boolean;
}

export function registerOrryRoutes(app: FastifyInstance, cfg: Config, chain: Chain, sql: Sql, deps: OrryRouteDeps): void {
  const cache = ttlCache(cfg.orry?.cacheMs ?? 10_000);
  const allowQuote = deps.makeLimiter(cfg.orry?.quoteRatePerMinute ?? 10);

  // The runtime release switch, decided per request by the server clock (releases.ts); a held feature's routes answer the
  // 404 of an unknown route. Routes a user needs to get their money out (balances, positions, claimables) have no feature.
  const releases = releasesFor(sql, cfg.releaseSeed, cfg.releasesCacheMs);
  // A route with several features opens only when all of them are open (pay-as-you-go checks also need checkout).
  const gate = (feature: OrryFeature | ReleaseFeature[], limit: (ip: string) => boolean = deps.allowPublic) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!cfg.orry) return reply.callNotFound();
    let open = true;
    try {
      for (const f of Array.isArray(feature) ? feature : [feature]) if (!(await releases.isOpen(f))) open = false;
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
    if (!open) return reply.callNotFound();
    if (!limit(req.ip)) return reply.code(429).send({ error: "Too many requests. Try again in a minute." });
  };
  const neverHeld = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!cfg.orry) return reply.callNotFound();
    if (!deps.allowPublic(req.ip)) return reply.code(429).send({ error: "Too many requests. Try again in a minute." });
  };

  async function guarded<T>(reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
  }

  // ---------------------------------------------------------------- hubs, assets and prices (multi-pair, R-35)
  const metaCache = new Map<string, QuoteAsset>();
  /** Symbol and decimals of an asset: native ETH is "ETH", 18; every other is the token's own, read once. */
  async function assetMeta(address: string): Promise<QuoteAsset> {
    const key = address.toLowerCase();
    const hit = metaCache.get(key);
    if (hit) return hit;
    const meta =
      key === NATIVE_ETH.toLowerCase()
        ? { address: NATIVE_ETH, symbol: "ETH", decimals: 18 }
        : {
            address: getAddress(key),
            symbol: await chain.public.readContract({ address: key as Address, abi: erc20Meta, functionName: "symbol" }),
            decimals: Number(await chain.public.readContract({ address: key as Address, abi: erc20Meta, functionName: "decimals" })),
          };
    metaCache.set(key, meta);
    return meta;
  }

  /** Each hub's current sqrt price; zero until it has one. */
  async function hubPrices(): Promise<{ hub: Hub; sqrt: bigint }[]> {
    const rc = cfg.orry!;
    const hubs = await hubsOf(rc, chain);
    const sqrts = await Promise.all(hubs.map((h) => readSqrtPrice(rc, chain, h.poolId)));
    return hubs.map((hub, i) => ({ hub, sqrt: sqrts[i]! }));
  }

  // ---------------------------------------------------------------- Earn
  app.get("/v1/orry/earn", { preHandler: gate("earn") }, async (_req, reply) =>
    guarded(reply, () =>
      cache("earn", async (): Promise<OrryEarnResponse> => {
        const rc = cfg.orry!;
        const [prices, vaults, fees] = await Promise.all([
          hubPrices(),
          vaultsOf(rc, chain, sql),
          // per vault: harvested fees (FeesHarvested) and ORRY notified to its reward stream (RewardsNotified)
          sql<{ vault: string; q7: string | null; r7: string | null; q: string | null; r: string | null; n7: string | null; n: string | null }[]>`select
            address as vault,
            sum((args->>'quoteAmount')::numeric) filter (where event = 'FeesHarvested' and block_time > now() - interval '7 days')::text as q7,
            sum((args->>'orryAmount')::numeric) filter (where event = 'FeesHarvested' and block_time > now() - interval '7 days')::text as r7,
            sum((args->>'quoteAmount')::numeric) filter (where event = 'FeesHarvested')::text as q,
            sum((args->>'orryAmount')::numeric) filter (where event = 'FeesHarvested')::text as r,
            sum((args->>'orryAmount')::numeric) filter (where event = 'RewardsNotified' and block_time > now() - interval '7 days')::text as n7,
            sum((args->>'orryAmount')::numeric) filter (where event = 'RewardsNotified')::text as n
            from orry_events where source = 'vault' and event in ('FeesHarvested', 'RewardsNotified') group by address`,
        ]);
        const byQuote = new Map(vaults.map((v) => [v.quote.toLowerCase(), v.vault]));
        const feesOf = new Map(fees.map((f) => [f.vault, f]));
        const hubs = await Promise.all(
          prices.map(async ({ hub, sqrt }): Promise<OrryHubView> => {
            const quote = await assetMeta(hub.quote);
            const vault = byQuote.get(hub.quote.toLowerCase()) ?? null;
            const [amounts, shares] = vault
              ? await Promise.all([
                  chain.public.readContract({ address: vault, abi: iEarnVaultAbi, functionName: "positionAmounts" }),
                  chain.public.readContract({ address: vault, abi: iEarnVaultAbi, functionName: "totalShares" }),
                ])
              : [[0n, 0n] as const, 0n];
            const f = vault ? feesOf.get(vault.toLowerCase()) : undefined;
            const orryPerQuote = orryPerWholeQuote(sqrt, hub.orryIsCurrency0, quote.decimals);
            return {
              quote,
              poolId: hub.poolId,
              initialized: sqrt > 0n,
              vault: vault ? getAddress(vault) : null,
              tvl: { quote: amounts[0].toString(), orry: amounts[1].toString() },
              totalShares: shares.toString(),
              fees7d: { quote: f?.q7 ?? "0", orry: f?.r7 ?? "0" },
              feesAllTime: { quote: f?.q ?? "0", orry: f?.r ?? "0" },
              notified7d: f?.n7 ?? "0",
              notifiedAllTime: f?.n ?? "0",
              orryPerQuote: orryPerQuote === null ? null : orryPerQuote.toString(),
            };
          }),
        );
        return { decimals: 18, hubs, updatedAt: new Date().toISOString() };
      }),
    ),
  );

  // ---------------------------------------------------------------- Stake
  app.get("/v1/orry/stake", { preHandler: gate("stake") }, async (_req, reply) =>
    guarded(reply, () =>
      cache("stake", async (): Promise<OrryStakeResponse> => {
        const rc = cfg.orry!;
        const [totalEarning, [rewards], [count]] = await Promise.all([
          chain.public.readContract({ address: rc.staking, abi: iOrryStakingAbi, functionName: "totalEarning" }),
          sql<{ eth7: string | null; orry7: string | null; eth: string | null; orry: string | null }[]>`select
            sum((args->>'ethAmount')::numeric) filter (where block_time > now() - interval '7 days')::text as eth7,
            sum((args->>'orryAmount')::numeric) filter (where block_time > now() - interval '7 days')::text as orry7,
            sum((args->>'ethAmount')::numeric)::text as eth, sum((args->>'orryAmount')::numeric)::text as orry
            from orry_events where source = 'staking' and event = 'RewardsNotified'`,
          sql<{ n: string }[]>`select count(*)::text as n from orry_stakers where plain_active + agent_active > 0`,
        ]);
        return {
          decimals: 18,
          totalEarning: totalEarning.toString(),
          rewards7d: sumPair({ eth: rewards?.eth7 ?? null, orry: rewards?.orry7 ?? null }),
          rewardsAllTime: sumPair(rewards),
          stakers: Number(count?.n ?? 0),
          updatedAt: new Date().toISOString(),
        };
      }),
    ),
  );

  // ---------------------------------------------------------------- one address (claim center)
  app.get<{ Params: { address: string } }>("/v1/orry/accounts/:address", { preHandler: neverHeld }, async (req, reply) => {
    if (!isAddress(req.params.address)) return reply.code(400).send({ error: "Pass a 0x address." });
    const address = getAddress(req.params.address);
    return guarded(reply, () =>
      cache(`acct:${address.toLowerCase()}`, async (): Promise<OrryAccountResponse> => {
        const rc = cfg.orry!;
        const a = address.toLowerCase();
        // Every number at one block, the block the indexer's tables are complete through, so earned all time (claimed
        // from events plus pending from the lens) holds a fresh claim in exactly one of its two terms.
        const { claimed, positions } = await sql.begin("isolation level repeatable read", async (tx) => ({
          claimed: await claimedAtHeight(tx, rc, a),
          positions: await tx<{ agent_id: string; owner: string }[]>`select agent_id::text, owner from orry_agent_positions
            where staker = ${a} and (active > 0 or leaving > 0) order by orry_agent_positions.agent_id limit 100`,
        }));
        if (claimed.height === null) throw new Error("the ORRY indexer has not run yet");
        const at = claimed.height;
        const [c, agents] = await Promise.all([
          claimablesAt(rc, chain, address, at),
          positions.length
            ? agentClaimablesAt(rc, chain, address, positions.map((p) => BigInt(p.agent_id)), positions.map((p) => getAddress(p.owner)), at)
            : Promise.resolve([]),
        ]);
        const order = assetOrder(rc, (await hubsOf(rc, chain)).map((h) => h.quote));
        const earned = earnedPerAsset(rc, order, claimed.claimed, c);
        return {
          address,
          decimals: 18,
          earn: await Promise.all(
            c.earn.map(async (e) => ({
              vault: e.vault,
              quote: await assetMeta(e.quote),
              shares: e.shares.toString(),
              unlockAt: Number(e.unlockAt),
              fees: { quote: e.feesQuote.toString(), orry: e.feesOrry.toString() },
              position: { quote: e.positionQuote.toString(), orry: e.positionOrry.toString() },
            })),
          ),
          stakeActive: c.stakeActive.toString(),
          stakeLeaving: c.stakeLeaving.toString(),
          stakeReadyAt: Number(c.stakeReadyAt),
          stakeRewardsEth: c.stakeRewardsEth.toString(),
          stakeRewardsOrry: c.stakeRewardsOrry.toString(),
          agentPositions: agents.map((p) => ({
            agentId: p.agentId.toString(),
            owner: p.owner,
            active: p.active.toString(),
            leaving: p.leaving.toString(),
            leavingAt: Number(p.leavingAt),
            reportedForAgent: p.reportedForAgent,
          })),
          earnedAllTime: await Promise.all(
            [...earned].map(async ([asset, amount]) => {
              const m = await assetMeta(asset);
              return { asset: m.address, symbol: m.symbol, decimals: m.decimals, amount: amount.toString() };
            }),
          ),
          updatedAt: new Date().toISOString(),
        };
      }),
    );
  });

  // ---------------------------------------------------------------- leaderboard (R-5: addresses masked)
  app.get<{ Querystring: { kind?: string; limit?: string } }>("/v1/orry/leaderboard", { preHandler: gate("leaderboard") }, async (req, reply) => {
    const kind = req.query.kind ?? "stakers";
    if (kind !== "stakers" && kind !== "earners") return reply.code(400).send({ error: "Pass kind=stakers or kind=earners." });
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return reply.code(400).send({ error: "Pass a limit from 1 to 100." });
    return guarded(reply, () =>
      cache(`lb:${kind}:${limit}`, async (): Promise<OrryLeaderboardResponse> => {
        if (kind === "stakers") {
          const rows = await sql<{ address: string; stake: string }[]>`select address, (plain_active + agent_active)::text as stake
            from orry_stakers where plain_active + agent_active > 0 order by plain_active + agent_active desc, address asc limit ${limit}`;
          return rows.map((r, i) => ({ rank: i + 1, address: maskAddress(r.address), decimals: 18, stake: r.stake }));
        }
        // Earners rank by value in ORRY at the hubs' current prices (ORRY counts 1:1; an asset whose hub has no price
        // counts 0). orry_earned is claimed plus pending at one block per account, written by snapshotAccounts.
        const rc = cfg.orry!;
        const weights: [string, string, string][] = [[rc.token.toLowerCase(), "1", "1"]];
        for (const { hub, sqrt } of await hubPrices()) {
          if (sqrt === 0n) continue;
          const r = orryPerQuoteRatio(sqrt, hub.orryIsCurrency0);
          weights.push([hub.quote.toLowerCase(), r.num.toString(), r.den.toString()]);
        }
        const ranked = await sql<{ address: string; value: string }[]>`select e.address, floor(sum(e.amount * w.num / w.den))::text as value
          from orry_earned e left join (select * from jsonb_to_recordset(${sql.json(weights.map(([asset, num, den]) => ({ asset, num, den })))})
            as x(asset text, num numeric, den numeric)) w on w.asset = e.asset
          group by e.address having sum(e.amount) > 0
          order by coalesce(sum(e.amount * w.num / w.den), 0) desc, e.address asc limit ${limit}`;
        const lists = ranked.length
          ? await sql<{ address: string; asset: string; amount: string }[]>`select address, asset, amount::text from orry_earned
              where address in ${sql(ranked.map((r) => r.address))}`
          : [];
        const order = assetOrder(rc, (await hubsOf(rc, chain)).map((h) => h.quote));
        return Promise.all(
          ranked.map(async (r, i) => {
            const mine = new Map(lists.filter((l) => l.address === r.address).map((l) => [l.asset, l.amount]));
            const earned = await Promise.all(
              order.map(async (asset) => {
                const m = await assetMeta(asset);
                return { asset: m.address, symbol: m.symbol, decimals: m.decimals, amount: mine.get(asset) ?? "0" };
              }),
            );
            return { rank: i + 1, address: maskAddress(r.address), decimals: 18 as const, earned, valueOrry: r.value ?? "0" };
          }),
        );
      }),
    );
  });

  // ---------------------------------------------------------------- burns
  app.get<{ Querystring: { limit?: string } }>("/v1/orry/burns", { preHandler: gate("burn") }, async (req, reply) => {
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return reply.code(400).send({ error: "Pass a limit from 1 to 200." });
    return guarded(reply, () =>
      cache(`burns:${limit}`, async (): Promise<OrryBurnsResponse> => {
        // A Burned event counts only with the source its emitter may use: router 1, treasury 2 or 3, buyback 4, and a
        // market the factory created 5 (commit fee) or 6 (fee paid in ORRY), a merchant splitter 7 (facilitator fee in ORRY).
        const burns = () => sql`(
          select tx_hash, block_number, log_index, block_time, args->>'source' as source, args->>'amount' as amount from orry_events
          where event = 'Burned' and ((source = 'router' and args->>'source' = '1') or (source = 'treasury' and args->>'source' in ('2', '3'))
            or (source = 'buyback' and args->>'source' = '4'))
          union all
          select tx_hash, block_number, log_index, block_time, args->>'source', args->>'amount' from market_events
          where event = 'Burned' and args->>'source' in ('5', '6') and address in (select market from markets)
          union all
          select tx_hash, block_number, log_index, block_time, args->>'source', args->>'amount' from facilitator_events
          where event = 'Burned' and args->>'source' = '7' and address in (select splitter from merchants)
        ) b`;
        const [totals, items] = await Promise.all([
          sql<{ source: string; amount: string }[]>`select source, sum(amount::numeric)::text as amount from ${burns()} group by 1`,
          sql<{ tx_hash: string; block_number: string; t: string; source: string; amount: string }[]>`select tx_hash, block_number::text,
            extract(epoch from block_time)::bigint::text as t, source, amount
            from ${burns()} order by b.block_number desc, b.log_index desc limit ${limit}`,
        ]);
        const bySource = { "1": "0", "2": "0", "3": "0", "4": "0", "5": "0", "6": "0", "7": "0" };
        let total = 0n;
        for (const t of totals) {
          bySource[t.source as keyof typeof bySource] = t.amount;
          total += BigInt(t.amount);
        }
        return {
          decimals: 18,
          total: total.toString(),
          bySource,
          items: items.map((r) => ({
            tx: r.tx_hash as `0x${string}`,
            block: Number(r.block_number),
            time: Number(r.t),
            source: Number(r.source) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
            amount: r.amount,
          })),
        };
      }),
    );
  });

  // ---------------------------------------------------------------- quotes (checkout)
  const address = z.string().refine((v) => isAddress(v), "not an address");
  const creditsBody = z.object({ buyer: address, packs: z.number().int().min(1) }).strict();
  const verificationBody = z
    .object({ payer: address, agentId: z.union([z.string().regex(/^\d{1,78}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]) })
    .strict();

  app.post("/v1/orry/quotes/credits", { preHandler: gate("checkout", allowQuote) }, async (req, reply) => {
    const body = creditsBody.safeParse(req.body);
    const max = cfg.orry!.maxPacksPerQuote;
    if (!body.success || body.data.packs > max) {
      return reply.code(400).send({ error: `Send { buyer: 0x address, packs: 1 to ${max} }.` });
    }
    return guarded(reply, async () => {
      const r = await quoteCredits(cfg, chain, sql, getAddress(body.data.buyer) as Address, body.data.packs);
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return r.body;
    });
  });

  const checksBody = z.object({ buyer: address, checks: z.number().int().min(1) }).strict();
  app.post("/v1/orry/quotes/checks", { preHandler: gate(["payg-checks", "checkout"], allowQuote) }, async (req, reply) => {
    const body = checksBody.safeParse(req.body);
    const max = cfg.orry!.maxChecksPerQuote;
    if (!body.success || body.data.checks > max) {
      return reply.code(400).send({ error: `Send { buyer: 0x address, checks: 1 to ${max} }.` });
    }
    return guarded(reply, async () => {
      const r = await quoteChecks(cfg, chain, sql, getAddress(body.data.buyer) as Address, body.data.checks);
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return r.body;
    });
  });

  app.post("/v1/orry/quotes/verification", { preHandler: gate("checkout", allowQuote) }, async (req, reply) => {
    const body = verificationBody.safeParse(req.body);
    if (!body.success || BigInt(body.data.agentId) >= 2n ** 256n) {
      return reply.code(400).send({ error: "Send { payer: 0x address, agentId: number or decimal string }." });
    }
    return guarded(reply, async () => {
      const r = await quoteVerification(cfg, chain, sql, getAddress(body.data.payer) as Address, BigInt(body.data.agentId));
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return r.body;
    });
  });
}
