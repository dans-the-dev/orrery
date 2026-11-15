"use client";

import { useQuery } from "@tanstack/react-query";
import type { LaunchAccountResponse, LaunchCoinResponse, LaunchCoinsResponse, LaunchEligibilityResponse } from "@runcore/shared";
import type { Address } from "viem";
import { API_URL } from "../config";

/** Reads of the `/v1/launch/` routes (lane L5). A held route answers 404, which the pages never reach: they render their
 * held state from the release switch instead. */

export class LaunchApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string): Promise<T> {
  if (!API_URL) throw new LaunchApiError(0, "The Runcore API is not configured in this build.");
  const r = await fetch(`${API_URL}${path}`, { headers: { accept: "application/json" } });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new LaunchApiError(r.status, body.error ?? `Request failed (${r.status}).`);
  return body;
}

const live = { refetchInterval: 5_000, retry: 1 } as const;

export const useLaunchCoins = (enabled = true) =>
  useQuery({ queryKey: ["launch", "coins"], queryFn: () => call<LaunchCoinsResponse>("/v1/launch/coins"), enabled: Boolean(API_URL) && enabled, ...live });

export const useLaunchCoin = (coin?: string) =>
  useQuery({
    queryKey: ["launch", "coin", coin?.toLowerCase()],
    queryFn: () => call<LaunchCoinResponse>(`/v1/launch/coins/${coin}`),
    enabled: Boolean(API_URL && coin),
    ...live,
  });

export const useLaunchEligibility = (agentId?: string, caller?: Address) =>
  useQuery({
    queryKey: ["launch", "agent", agentId, caller?.toLowerCase()],
    queryFn: () => call<LaunchEligibilityResponse>(`/v1/launch/agents/${agentId}${caller ? `?caller=${caller}` : ""}`),
    enabled: Boolean(API_URL && agentId && /^\d{1,30}$/.test(agentId)),
    ...live,
  });

export const useLaunchAccount = (address?: Address) =>
  useQuery({
    queryKey: ["launch", "account", address?.toLowerCase()],
    queryFn: () => call<LaunchAccountResponse>(`/v1/launch/accounts/${address}`),
    enabled: Boolean(API_URL && address),
    ...live,
  });
