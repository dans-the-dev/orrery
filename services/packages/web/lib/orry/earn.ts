"use client";

import { erc20Abi, type Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { iEarnVaultAbi, iEarnVaultFactoryAbi } from "@orrery/shared";
import { ORRY } from "./config";

/**
 * Multi-pair Earn (R-35 to R-38): one vault per ORRY/X hub, listed by the Earn vault factory on chain. Read from the
 * chain so withdrawals and fee claims never depend on the Earn release or the API.
 */

export const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as Address;
const ZERO = NATIVE_ETH;

export interface QuoteMeta {
  address: Address;
  symbol: string;
  decimals: number;
  isEth: boolean;
}
export interface EarnVaultInfo {
  vault: Address;
  quote: QuoteMeta;
}

/** Every Earn vault the factory created, in the factory's order, with its quote token's symbol and decimals. */
export function useVaults(): { vaults: EarnVaultInfo[]; loaded: boolean } {
  const factory = ORRY.earnFactory;
  const list = useReadContract({ address: factory ?? ZERO, abi: iEarnVaultFactoryAbi, functionName: "vaults", query: { enabled: Boolean(factory), staleTime: 60_000, refetchInterval: 60_000 } });
  const vaults = (list.data as readonly Address[] | undefined) ?? [];
  const quotes = useReadContracts({
    allowFailure: true,
    contracts: vaults.map((v) => ({ address: v, abi: iEarnVaultAbi, functionName: "quote" as const })),
    query: { enabled: vaults.length > 0, staleTime: Infinity },
  });
  const quoteAddrs = vaults.map((_, i) => (quotes.data?.[i]?.status === "success" ? (quotes.data[i].result as Address) : undefined));
  const meta = useReadContracts({
    allowFailure: true,
    contracts: quoteAddrs.flatMap((q) => [
      { address: q ?? ZERO, abi: erc20Abi, functionName: "symbol" as const },
      { address: q ?? ZERO, abi: erc20Abi, functionName: "decimals" as const },
    ]),
    query: { enabled: quoteAddrs.some((q) => q && q !== NATIVE_ETH), staleTime: Infinity },
  });
  const out: EarnVaultInfo[] = [];
  vaults.forEach((vault, i) => {
    const q = quoteAddrs[i];
    if (!q) return;
    if (q === NATIVE_ETH) return void out.push({ vault, quote: { address: q, symbol: "ETH", decimals: 18, isEth: true } });
    const sym = meta.data?.[i * 2];
    const dec = meta.data?.[i * 2 + 1];
    if (sym?.status !== "success" || dec?.status !== "success") return;
    out.push({ vault, quote: { address: q, symbol: String(sym.result), decimals: Number(dec.result), isEth: false } });
  });
  return { vaults: out, loaded: !factory || (list.isFetched && (vaults.length === 0 || out.length === vaults.length)) };
}

export interface EarnPosition extends EarnVaultInfo {
  shares?: bigint;
  unlockAt: number;
  feesQuote?: bigint;
  feesOrry?: bigint;
}

/** This account's share, unlock time and fees in every vault. */
export function useEarnPositions(account?: Address): { positions: EarnPosition[]; loaded: boolean; refetch: () => void } {
  const { vaults, loaded } = useVaults();
  const a = account ?? ZERO;
  const { data, isFetched, refetch } = useReadContracts({
    allowFailure: true,
    contracts: vaults.flatMap((v) => [
      { address: v.vault, abi: iEarnVaultAbi, functionName: "sharesOf" as const, args: [a] as const },
      { address: v.vault, abi: iEarnVaultAbi, functionName: "unlockAt" as const, args: [a] as const },
      { address: v.vault, abi: iEarnVaultAbi, functionName: "pendingFees" as const, args: [a] as const },
    ]),
    query: { enabled: Boolean(account) && vaults.length > 0, refetchInterval: 12_000 },
  });
  const positions = vaults.map((v, i) => {
    const s = data?.[i * 3];
    const u = data?.[i * 3 + 1];
    const f = data?.[i * 3 + 2];
    const fees = f?.status === "success" ? (f.result as readonly [bigint, bigint]) : undefined;
    return {
      ...v,
      shares: s?.status === "success" ? (s.result as bigint) : undefined,
      unlockAt: u?.status === "success" ? Number(u.result) : 0,
      feesQuote: fees?.[0],
      feesOrry: fees?.[1],
    };
  });
  return { positions, loaded: loaded && (!account || vaults.length === 0 || isFetched), refetch: () => void refetch() };
}

export const hasShares = (p: EarnPosition) => (p.shares ?? 0n) > 0n;
export const hasFees = (p: EarnPosition) => (p.feesQuote ?? 0n) > 0n || (p.feesOrry ?? 0n) > 0n;

export interface AssetMeta {
  symbol: string;
  decimals: number;
}
/** Symbol and decimals of every asset ORRY pays in: ORRY, ETH (the zero address) and each vault's quote token. */
export function useAssetMeta(): (asset: Address) => AssetMeta | undefined {
  const { vaults } = useVaults();
  return (asset) => {
    const a = asset.toLowerCase();
    if (a === NATIVE_ETH) return { symbol: "ETH", decimals: 18 };
    if (ORRY.token && a === ORRY.token.toLowerCase()) return { symbol: "ORRY", decimals: 18 };
    const q = vaults.find((v) => v.quote.address.toLowerCase() === a)?.quote;
    return q ? { symbol: q.symbol, decimals: q.decimals } : undefined;
  };
}

/** Display digits per asset: ETH five, ORRY and stable quotes two. */
export const assetFrac = (symbol: string) => (symbol === "ETH" ? 5 : 2);
