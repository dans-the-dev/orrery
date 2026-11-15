"use client";

import { useQuery } from "@tanstack/react-query";
import type { AttestersResponse, CreditAccountResponse, CreditLinesResponse, CreditPoolsResponse } from "@orrery/shared";
import { API_URL } from "../config";
import { get } from "../orry/api";
import type { OrryFeature } from "../orry/config";

/** Lane L4 pages (docs/updates/L4-CREDIT-SPEC.md 7). Each opens with its release switch feature. */
export const CREDIT_ROUTES: { feature: Extract<OrryFeature, "credit" | "attesters">; href: string; label: string }[] = [
  { feature: "credit", href: "/credit", label: "Credit" },
  { feature: "attesters", href: "/attesters", label: "Attesters" },
];

const live = { refetchInterval: 15_000, staleTime: 5_000 } as const;

export const useAttesters = () =>
  useQuery({ queryKey: ["credit", "attesters"], queryFn: () => get<AttestersResponse>("/v1/attesters"), enabled: Boolean(API_URL), ...live });
export const useCreditPools = () =>
  useQuery({ queryKey: ["credit", "pools"], queryFn: () => get<CreditPoolsResponse>("/v1/credit/pools"), enabled: Boolean(API_URL), ...live });
export const useCreditLines = (agentId?: string) =>
  useQuery({ queryKey: ["credit", "lines", agentId], queryFn: () => get<CreditLinesResponse>(`/v1/credit/lines/${agentId}`), enabled: Boolean(API_URL && agentId), ...live });
export const useCreditAccount = (address?: string) =>
  useQuery({ queryKey: ["credit", "account", address], queryFn: () => get<CreditAccountResponse>(`/v1/credit/accounts/${address}`), enabled: Boolean(API_URL && address), ...live });

/** Basis points as a percent with up to two decimals. */
export const bps = (v: number) => `${(v / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
/** Seconds as whole days. */
export const days = (s: number) => `${Math.round(s / 86400)} days`;
