import type { Address, Hex } from "viem";
import { NATIVE_ETH, QUOTE_MEDIAN_WINDOW_SECONDS, decodeSlot0, iOrreryHookAbi, poolManagerAbi, poolStateSlot, orryPerQuoteRatio } from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config, OrryConfig } from "./config.js";
import type { Sql } from "./db.js";

/**
 * Hub prices from Uniswap v4 slot0 (PoolManager `extsload`, no StateView). Multi-pair (R-35): one ORRY/X hub per quote
 * X, listed by the hook. ORRY in USD comes from the ORRY/USDG hub when it has a price; otherwise the ETH hub times a
 * native ETH / USDG pool (`ORRERY_ORRY_USD_POOL_ID`), where ORRY base units per USDG base unit = hubSqrt² / usdSqrt².
 */

export interface Hub {
  position: number;
  quote: Address;
  poolId: Hex;
  usdFeed: Address;
  orryIsCurrency0: boolean;
}

const hubCache = new Map<string, Hub[]>();

/** The hook's registry (`pairCount`, `pairAt`). It only grows, so only new entries are read. */
export async function hubsOf(rc: OrryConfig, chain: Chain): Promise<Hub[]> {
  const key = rc.hook.toLowerCase();
  const known = hubCache.get(key) ?? [];
  const count = Number(await chain.public.readContract({ address: rc.hook, abi: iOrreryHookAbi, functionName: "pairCount" }));
  for (let i = known.length; i < count; i++) {
    const p = await chain.public.readContract({ address: rc.hook, abi: iOrreryHookAbi, functionName: "pairAt", args: [BigInt(i)] });
    known.push({ position: i, quote: p.quote, poolId: p.poolId, usdFeed: p.usdFeed, orryIsCurrency0: p.orryIsCurrency0 });
  }
  hubCache.set(key, known);
  return known;
}

export async function readSqrtPrice(rc: OrryConfig, chain: Chain, poolId: Hex, blockNumber?: bigint): Promise<bigint> {
  const word = await chain.public.readContract({
    address: rc.poolManager,
    abi: poolManagerAbi,
    functionName: "extsload",
    args: [poolStateSlot(poolId)],
    blockNumber,
  });
  return decodeSlot0(word).sqrtPriceX96;
}

/** ORRY base units per USDG base unit, as an exact fraction. */
export interface Ratio {
  num: bigint;
  den: bigint;
}

export const ratioOf = (hubSqrt: bigint, usdSqrt: bigint): Ratio => ({ num: hubSqrt * hubSqrt, den: usdSqrt * usdSqrt });
export const compareRatio = (a: Ratio, b: Ratio): number => {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
};

/** Median by value; for an even count the upper middle, which is the lower ORRY price of the two. */
export function medianRatio(ratios: Ratio[]): Ratio {
  if (ratios.length === 0) throw new Error("no samples");
  const sorted = [...ratios].sort(compareRatio);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** ORRY needed for `usd` USDG base units at `ratio`, rounded up so the protocol never receives less. */
export const orryForUsd = (usd: bigint, r: Ratio): bigint => (usd * r.num + r.den - 1n) / r.den;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * ORRY per USDG base unit at `block`: the ORRY/USDG hub when it has a price, else the ETH hub times the ETH/USDG pool.
 * `hubSqrt` is the hub price used, `usdSqrt` the ETH/USDG pool's (0 on the direct route). Null without a price.
 */
export async function usdRatioAt(cfg: Config, chain: Chain, block: bigint): Promise<{ ratio: Ratio; hubSqrt: bigint; usdSqrt: bigint } | null> {
  const rc = cfg.orry!;
  const hubs = await hubsOf(rc, chain);
  const usdgHub = hubs.find((h) => same(h.quote, rc.usdg));
  if (usdgHub) {
    const s = await readSqrtPrice(rc, chain, usdgHub.poolId, block);
    if (s > 0n) return { ratio: orryPerQuoteRatio(s, usdgHub.orryIsCurrency0), hubSqrt: s, usdSqrt: 0n };
  }
  const ethHub = hubs.find((h) => same(h.quote, NATIVE_ETH));
  if (!ethHub || !rc.usdPoolId) return null;
  const [hubSqrt, usdSqrt] = await Promise.all([readSqrtPrice(rc, chain, ethHub.poolId, block), readSqrtPrice(rc, chain, rc.usdPoolId, block)]);
  if (hubSqrt === 0n || usdSqrt === 0n) return null;
  return { ratio: ratioOf(hubSqrt, usdSqrt), hubSqrt, usdSqrt };
}

export type QuotePriceResult =
  | { ok: true; ratio: Ratio; basis: "spot" | "median"; samples: number }
  | { ok: false; reason: "hub_not_registered" | "no_price" | "not_enough_samples" };

/**
 * Price for a quote: the lower ORRY price of the current pools and the median of the samples of the last 30 minutes.
 * A lower ORRY price means more ORRY per USD, so the larger ratio wins.
 */
export async function quotePrice(cfg: Config, chain: Chain, sql: Sql): Promise<QuotePriceResult> {
  const rc = cfg.orry!;
  if ((await hubsOf(rc, chain)).length === 0) return { ok: false, reason: "hub_not_registered" };
  const block = await chain.public.getBlockNumber({ cacheTime: 0 }); // a fresh head: both pools read at one current block
  const spot = await usdRatioAt(cfg, chain, block);
  if (!spot) return { ok: false, reason: "no_price" };
  const rows = await sql<{ num: string; den: string }[]>`select ratio_num::text as num, ratio_den::text as den from orry_price_samples
    where sampled_at > now() - make_interval(secs => ${QUOTE_MEDIAN_WINDOW_SECONDS}) and ratio_num is not null`;
  if (rows.length < rc.minSamples) return { ok: false, reason: "not_enough_samples" };
  const median = medianRatio(rows.map((r) => ({ num: BigInt(r.num), den: BigInt(r.den) })));
  return compareRatio(spot.ratio, median) >= 0
    ? { ok: true, ratio: spot.ratio, basis: "spot", samples: rows.length }
    : { ok: true, ratio: median, basis: "median", samples: rows.length };
}

/** One sample at one block, at most every `sampleSeconds`. Returns false when nothing was stored. */
export async function sampleOnce(cfg: Config, chain: Chain, sql: Sql): Promise<boolean> {
  const rc = cfg.orry;
  if (!rc) return false;
  const [recent] = await sql`select 1 from orry_price_samples where sampled_at > now() - make_interval(secs => ${rc.sampleSeconds}) limit 1`;
  if (recent) return false;
  const block = await chain.public.getBlockNumber({ cacheTime: 0 }); // a fresh head: both pools read at one current block
  const p = await usdRatioAt(cfg, chain, block);
  if (!p) return false;
  await sql`insert into orry_price_samples (sampled_at, block_number, hub_sqrt, usd_sqrt, ratio_num, ratio_den)
    values (now(), ${block.toString()}, ${p.hubSqrt.toString()}, ${p.usdSqrt.toString()}, ${p.ratio.num.toString()}, ${p.ratio.den.toString()})`;
  await sql`delete from orry_price_samples where sampled_at < now() - interval '1 day'`;
  return true;
}
