"use client";

import { useQuery } from "@tanstack/react-query";
import { isAddress, type Address, type Hex } from "viem";
import { API_URL } from "../config";
import { useReleases } from "./releases";

/**
 * Reads from the ORRY API (docs/ORRY-BUILD-SPEC.md section 5). Amounts arrive as decimal strings in base units; the
 * parsers below turn them into bigints and accept numbers or strings for counts and times.
 */

export interface Pair {
  eth: bigint;
  orry: bigint;
}
/** (quote, ORRY) amounts of one hub or vault, base units of each. */
export interface QuotePair {
  quote: bigint;
  orry: bigint;
}
export interface QuoteAsset {
  address: Address;
  symbol: string;
  decimals: number;
}
/** An amount of one asset; ORRY is an asset too. */
export interface AssetAmount extends QuoteAsset {
  amount: bigint;
}
/** One ORRY/X hub and its Earn vault (multi-pair, lane C's OrryHubView). */
export interface EarnHub {
  quote: QuoteAsset;
  initialized: boolean;
  vault?: Address;
  tvl: QuotePair;
  totalShares: bigint;
  fees7d: QuotePair;
  feesAllTime: QuotePair;
  /** ORRY added to this vault's LPs as rewards (RewardsNotified), last 7 days and all time; 0 without a vault. */
  notified7d: bigint;
  notifiedAllTime: bigint;
  /** ORRY base units per 1 whole quote token, or undefined until the hub has a price. */
  orryPerQuote?: bigint;
}
export interface EarnStats {
  hubs: EarnHub[];
  updatedAt?: number;
}
export interface StakeStats {
  totalEarning: bigint;
  rewards7d: Pair;
  rewardsAllTime: Pair;
  stakers: number;
  updatedAt?: number;
}
export interface AgentPosition {
  agentId: bigint;
  owner: Address;
  active: bigint;
  leaving: bigint;
  leavingAt: number;
  reportedForAgent: boolean;
}
export interface AccountEarn {
  vault: Address;
  quote: QuoteAsset;
  shares: bigint;
  unlockAt: number;
  fees: QuotePair;
  position: QuotePair;
}
export interface AccountView {
  /** One entry per vault, in the factory's order. */
  earn: AccountEarn[];
  stakeActive: bigint;
  stakeLeaving: bigint;
  stakeReadyAt: number;
  stakeRewardsEth: bigint;
  stakeRewardsOrry: bigint;
  agents: AgentPosition[];
  /** Claimed plus pending, Earn and Stake, per asset: ORRY, ETH, then the other quotes. */
  earnedAllTime: AssetAmount[];
}
export interface BoardRow {
  rank: number;
  address: string;
  stake?: bigint;
  earned?: AssetAmount[];
  /** The ranking key of earners: everything earned, valued in ORRY at the hubs' current prices. */
  valueOrry?: bigint;
}
export interface BurnItem {
  tx: Hex;
  block: number;
  time: number;
  source: number;
  amount: bigint;
}
export interface Burns {
  total: bigint;
  bySource: Record<1 | 2 | 3 | 4 | 5 | 6 | 7, bigint>;
  items: BurnItem[];
}
export interface Quote {
  orryAmount: bigint;
  quoteId: Hex;
  expiry: number;
  sig: Hex;
  packs?: number;
  agentId?: bigint;
  /** Credits granted (credits and checks quotes). */
  credits?: bigint;
  /** Checks bought (pay-as-you-go quotes). */
  checks?: number;
  /** The contract the quote is signed for (EIP-712 verifyingContract). */
  treasury?: Address;
}

type J = Record<string, unknown>;

export const big = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return 0n;
};
const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
};
/** Unix seconds from seconds, milliseconds or an ISO string. */
export const time = (v: unknown): number => {
  if (typeof v === "string" && !/^\d+$/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
  }
  const n = num(v);
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
};
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
const quotePair = (v: unknown): QuotePair => {
  const o = (v ?? {}) as J;
  return { quote: big(o.quote), orry: big(o.orry) };
};
const quoteAsset = (v: unknown): QuoteAsset => {
  const o = (v ?? {}) as J;
  return { address: (isAddress(String(o.address)) ? o.address : ZERO_ADDR) as Address, symbol: String(o.symbol ?? ""), decimals: num(o.decimals) || 18 };
};
const assetAmounts = (v: unknown): AssetAmount[] =>
  (Array.isArray(v) ? (v as J[]) : []).map((a) => ({ ...quoteAsset({ address: a.asset, symbol: a.symbol, decimals: a.decimals }), amount: big(a.amount) }));
const pair = (v: unknown): Pair => {
  const o = (v ?? {}) as J;
  return { eth: big(o.eth), orry: big(o.orry) };
};
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function get<T>(path: string): Promise<T> {
  if (!API_URL) throw new ApiError(0, "no api");
  const r = await fetch(`${API_URL}${path}`, { headers: { accept: "application/json" } });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new ApiError(r.status, body.error ?? `Request failed (${r.status}).`);
  return body;
}

export async function post<T>(path: string, payload: unknown): Promise<T> {
  if (!API_URL) throw new ApiError(0, "no api");
  const r = await fetch(`${API_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new ApiError(r.status, body.error ?? `Request failed (${r.status}).`);
  return body;
}

export const parseEarn = (o: J): EarnStats => ({
  hubs: ((o.hubs ?? []) as J[]).map((h) => ({
    quote: quoteAsset(h.quote),
    initialized: h.initialized === true,
    vault: isAddress(String(h.vault)) ? (h.vault as Address) : undefined,
    tvl: quotePair(h.tvl),
    totalShares: big(h.totalShares),
    fees7d: quotePair(h.fees7d),
    feesAllTime: quotePair(h.feesAllTime),
    notified7d: big(h.notified7d),
    notifiedAllTime: big(h.notifiedAllTime),
    orryPerQuote: h.orryPerQuote === null || h.orryPerQuote === undefined ? undefined : big(h.orryPerQuote) || undefined,
  })),
  updatedAt: o.updatedAt === undefined ? undefined : time(o.updatedAt),
});

export const parseStake = (o: J): StakeStats => ({
  totalEarning: big(o.totalEarning),
  rewards7d: pair(o.rewards7d),
  rewardsAllTime: pair(o.rewardsAllTime),
  stakers: num(o.stakers),
  updatedAt: o.updatedAt === undefined ? undefined : time(o.updatedAt),
});

export const parseAccount = (o: J): AccountView => {
  const c = ((o.claimables as J | undefined) ?? o) as J;
  const agents = ((o.agents ?? o.agentPositions ?? []) as J[]).map((a) => ({
    agentId: big(a.agentId),
    owner: (isAddress(String(a.owner)) ? a.owner : "0x0000000000000000000000000000000000000000") as Address,
    active: big(a.active),
    leaving: big(a.leaving),
    leavingAt: time(a.leavingAt),
    reportedForAgent: a.reportedForAgent !== false,
  }));
  return {
    earn: ((c.earn ?? []) as J[]).map((e) => ({
      vault: (isAddress(String(e.vault)) ? e.vault : ZERO_ADDR) as Address,
      quote: quoteAsset(e.quote),
      shares: big(e.shares),
      unlockAt: time(e.unlockAt),
      fees: quotePair(e.fees),
      position: quotePair(e.position),
    })),
    stakeActive: big(c.stakeActive),
    stakeLeaving: big(c.stakeLeaving),
    stakeReadyAt: time(c.stakeReadyAt),
    stakeRewardsEth: big(c.stakeRewardsEth),
    stakeRewardsOrry: big(c.stakeRewardsOrry),
    agents,
    earnedAllTime: assetAmounts(o.earnedAllTime),
  };
};

export const parseBoard = (o: unknown): BoardRow[] => {
  const rows = (Array.isArray(o) ? o : (((o as J)?.items ?? (o as J)?.rows ?? []) as unknown[])) as J[];
  return rows.map((r, i) => ({
    rank: num(r.rank) || i + 1,
    address: String(r.address ?? ""),
    stake: r.stake === undefined ? undefined : big(r.stake),
    earned: r.earned === undefined ? undefined : assetAmounts(r.earned),
    valueOrry: r.valueOrry === undefined ? undefined : big(r.valueOrry),
  }));
};

export const parseBurns = (o: J): Burns => {
  const by = (o.bySource ?? {}) as J;
  return {
    total: big(o.total),
    bySource: { 1: big(by["1"]), 2: big(by["2"]), 3: big(by["3"]), 4: big(by["4"]), 5: big(by["5"]), 6: big(by["6"]), 7: big(by["7"]) },
    items: ((o.items ?? []) as J[]).map((i) => ({ tx: String(i.tx) as Hex, block: num(i.block), time: time(i.time), source: num(i.source), amount: big(i.amount) })),
  };
};

/** `{kind, quote: {...}, signature, domain, credits?}` from the quote routes; a flat quote is read too. */
export const parseQuote = (o: J): Quote => {
  const q = ((o.quote as J | undefined) ?? o) as J;
  const vc = (o.domain as J | undefined)?.verifyingContract;
  return {
    orryAmount: big(q.orryAmount),
    quoteId: String(q.quoteId) as Hex,
    expiry: time(q.expiry),
    sig: String(o.signature ?? q.signature ?? o.sig) as Hex,
    packs: q.packs === undefined ? undefined : num(q.packs),
    agentId: q.agentId === undefined ? undefined : big(q.agentId),
    credits: o.credits === undefined ? undefined : big(o.credits),
    checks: o.checks === undefined ? undefined : num(o.checks),
    treasury: isAddress(String(vc)) ? (vc as Address) : undefined,
  };
};

const live = { refetchInterval: 15_000, retry: 1 } as const;

// Earn and stake figures are read only while their feature is open: the API answers 404 for a held route, and a held page
// shows its Coming soon state (withdrawals and claims read the never-held account route instead).
export const useEarnStats = () => {
  const open = useReleases().isOpen("earn");
  return useQuery({ queryKey: ["orry", "earn"], queryFn: async () => parseEarn(await get<J>("/v1/orry/earn")), enabled: Boolean(API_URL) && open, ...live });
};
export const useStakeStats = () => {
  const open = useReleases().isOpen("stake");
  return useQuery({ queryKey: ["orry", "stake"], queryFn: async () => parseStake(await get<J>("/v1/orry/stake")), enabled: Boolean(API_URL) && open, ...live });
};
export const useAccountView = (address?: Address) =>
  useQuery({
    queryKey: ["orry", "account", address?.toLowerCase()],
    queryFn: async () => parseAccount(await get<J>(`/v1/orry/accounts/${address}`)),
    enabled: Boolean(API_URL && address),
    ...live,
  });
export const useBoard = (kind: "stakers" | "earners", limit = 50) =>
  useQuery({ queryKey: ["orry", "leaderboard", kind, limit], queryFn: async () => parseBoard(await get<unknown>(`/v1/orry/leaderboard?kind=${kind}&limit=${limit}`)), enabled: Boolean(API_URL), ...live });
export const useBurns = (limit = 25) => useQuery({ queryKey: ["orry", "burns", limit], queryFn: async () => parseBurns(await get<J>(`/v1/orry/burns?limit=${limit}`)), enabled: Boolean(API_URL), ...live });
