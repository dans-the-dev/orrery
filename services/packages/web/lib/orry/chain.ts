"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hex } from "viem";
import { useBalance, useConnection, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { iEarnVaultAbi, iEarnVaultFactoryAbi, iOrryRewardsRouterAbi, iOrryStakingAbi, iOrryTokenAbi } from "@orrery/shared";
import { activeChain } from "../config";
import { ORRY } from "./config";
import { span, utc } from "./format";

export function useNow(step = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), step);
    return () => clearInterval(t);
  }, [step]);
  return now;
}

/** Connected, on the right chain, with an address. */
export function useWallet() {
  const { address, isConnected, chainId } = useConnection();
  const ready = Boolean(isConnected && address && chainId === activeChain.id);
  return { address: ready ? (address as Address) : undefined, connected: isConnected, ready };
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** Periods set in the constructors: lock, cooldowns, stream, distribute interval. Read once. Earn periods come from the
 * factory's first vault (every vault is built with the same constants). */
export function useOrryConstants() {
  const { data: firstVault } = useReadContract({ address: ORRY.earnFactory ?? ZERO, abi: iEarnVaultFactoryAbi, functionName: "vaultAt", args: [0n], query: { enabled: Boolean(ORRY.earnFactory), staleTime: Infinity } });
  const v = (firstVault as Address | undefined) ?? ZERO;
  const s = ORRY.staking ?? ZERO;
  const r = ORRY.router ?? ZERO;
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: v, abi: iEarnVaultAbi, functionName: "DEPOSIT_LOCK" },
      { address: v, abi: iEarnVaultAbi, functionName: "STREAM_PERIOD" },
      { address: s, abi: iOrryStakingAbi, functionName: "PLAIN_COOLDOWN" },
      { address: s, abi: iOrryStakingAbi, functionName: "AGENT_COOLDOWN" },
      { address: s, abi: iOrryStakingAbi, functionName: "STREAM_PERIOD" },
      { address: r, abi: iOrryRewardsRouterAbi, functionName: "MIN_INTERVAL" },
    ],
    query: { staleTime: Infinity, enabled: Boolean(firstVault || ORRY.staking || ORRY.router) },
  });
  const n = (i: number) => {
    const x = data?.[i];
    return x && x.status === "success" ? Number(x.result as bigint | number) : undefined;
  };
  return {
    depositLock: firstVault ? n(0) : undefined,
    earnStream: firstVault ? n(1) : undefined,
    plainCooldown: ORRY.staking ? n(2) : undefined,
    agentCooldown: ORRY.staking ? n(3) : undefined,
    stakeStream: ORRY.staking ? n(4) : undefined,
    distributeInterval: ORRY.router ? n(5) : undefined,
  };
}

/** Live stake, rewards and balances of one address, straight from the contracts (fresh after every transaction). Earn
 * positions, one per vault, come from useEarnPositions (lib/orry/earn.ts). */
export function useAccountChain(address?: Address) {
  const s = ORRY.staking ?? ZERO;
  const t = ORRY.token ?? ZERO;
  const a = address ?? ZERO;
  const { data, refetch, isFetched } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: s, abi: iOrryStakingAbi, functionName: "plainStake", args: [a] },
      { address: s, abi: iOrryStakingAbi, functionName: "pendingRewards", args: [a] },
      { address: s, abi: iOrryStakingAbi, functionName: "earningBalance", args: [a] },
      { address: t, abi: iOrryTokenAbi, functionName: "balanceOf", args: [a] },
    ],
    query: { enabled: Boolean(address), refetchInterval: 12_000 },
  });
  const ethBal = useBalance({ address, query: { enabled: Boolean(address), refetchInterval: 12_000 } });
  const ok = <T,>(i: number, has: unknown): T | undefined => {
    const x = data?.[i];
    return has && x && x.status === "success" ? (x.result as T) : undefined;
  };
  const plain = ok<readonly [bigint, bigint, bigint | number]>(0, ORRY.staking);
  const rewards = ok<readonly [bigint, bigint]>(1, ORRY.staking);
  return {
    loaded: isFetched,
    refetch: () => {
      void refetch();
      void ethBal.refetch();
    },
    stakeActive: plain?.[0],
    stakeLeaving: plain?.[1],
    stakeReadyAt: Number(plain?.[2] ?? 0),
    rewardsEth: rewards?.[0],
    rewardsOrry: rewards?.[1],
    earning: ok<bigint>(2, ORRY.staking),
    orryBalance: ok<bigint>(3, ORRY.token),
    ethBalance: ethBal.data?.value,
  };
}

const until = (t: unknown) => Number(t ?? 0) - Math.floor(Date.now() / 1000);

/** Plain messages for the contracts' custom errors. */
const ERRORS: Record<string, (args: readonly unknown[]) => string> = {
  SharesLocked: (a) => (until(a[0]) > 0 ? `Your shares unlock in ${span(until(a[0]))}.` : "Your shares unlock in a moment. Try again shortly."),
  PriceMovedInBlock: () => "The pool price moved in this block. Try again in a moment.",
  SlippageExceeded: () => "The price moved past your limit. Try again or raise the limit.",
  DeadlinePassed: () => "The transaction waited too long. Send it again.",
  InsufficientShares: () => "That is more than your shares.",
  ZeroAmount: () => "Enter an amount above zero.",
  HubNotRegistered: () => "The ORRY pool opens soon. Deposits start then.",
  NothingReady: () => "Nothing is ready to withdraw yet.",
  InsufficientActive: () => "That is more than your active stake.",
  NotAgentController: () => "Only the agent's owner or its agent wallet can stake behind it.",
  NotStaker: () => "Only the address that staked can move this stake.",
  PositionHeldByAnotherStaker: () => "Another address already stakes behind this agent.",
  AgentStakeLocked: (a) => `This agent stake is locked until ${utc(Number(a[0] ?? 0))}.`,
  InexactTransfer: () => "The token transfer did not match the amount.",
  TooSoon: (a) => (until(a[0]) > 0 ? `Distribute already ran recently. Next run in ${span(until(a[0]))}.` : "Distribute already ran recently. Try again in a moment."),
  NothingToDistribute: () => "Nothing is waiting to distribute.",
  QuoteExpired: () => "The quote expired. Get a new one.",
  QuoteUsed: () => "This quote was already used. Get a new one.",
  BadQuoteSignature: () => "The quote was not accepted. Get a new one.",
  CoinNotSet: () => "ORRY payments open soon.",
  DailyVerificationCap: () => "ORRY verifications for today are complete. Pay in USDG or come back after 00:00 UTC.",
  InexactBurn: () => "The burn did not match the amount.",
  EthTransferFailed: () => "The ETH payout did not go through to your address.",
  // Sealed batch markets (wave R1).
  WrongPhase: () => "This batch moved to its next window. Seal the order in the next batch.",
  AlreadyCommitted: () => "This wallet already has an order sealed in this batch. The next batch opens shortly.",
  BatchFull: () => "This batch is full. Seal the order in the next batch.",
  BadReveal: () => "The reveal did not match the sealed order.",
  BelowMinimum: () => "The order is below the market's minimum size.",
  AlreadyCleared: () => "This batch has cleared.",
  Expired: () => "This batch closed without a price, so nothing moved.",
  BadRound: () => "The price round did not match the batch.",
  StalePrice: () => "The stock price has not updated for this batch yet.",
  DeviationTooHigh: () => "The pool price is too far from the batch price for this clearing.",
  // Merchant payment addresses (wave 3).
  SplitterExists: () => "This payment address is already set up.",
  NothingToForward: () => "Nothing is waiting to forward.",
};

export function explain(e: unknown, fallback: string): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      const f = ERRORS[reverted.data.errorName];
      if (f) return f(reverted.data.args ?? []);
    }
    if (/reject|denied/i.test(e.shortMessage + e.message)) return "Request closed in the wallet.";
    if (/insufficient funds/i.test(e.message)) return "Not enough ETH for this amount and the gas.";
    return `${fallback} ${e.shortMessage}`.trim();
  }
  const msg = e instanceof Error ? e.message : "";
  if (/reject|denied/i.test(msg)) return "Request closed in the wallet.";
  return msg ? `${fallback} ${msg.split("\n")[0]}` : fallback;
}

export type Notice = { tone: "ok" | "error" | ""; text: string } | null;

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

/**
 * Sends contract calls in order from the connected wallet and waits for each receipt. Every read refreshes after.
 * `approve` steps are skipped when the allowance already covers the amount.
 */
export function useTx() {
  const pub = usePublicClient();
  const qc = useQueryClient();
  const { address: account } = useConnection();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function send(c: Call): Promise<Hex> {
    if (!pub) throw new Error("No connection to the network.");
    // Simulating first surfaces the contract's own error before the wallet opens.
    await pub.simulateContract({ ...c, account } as never).catch((e) => {
      if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) throw e;
    });
    const hash = await writeContractAsync(c as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("The transaction reverted.");
    return hash;
  }

  async function ensureAllowance(owner: Address, spender: Address, amount: bigint, step: (t: string) => void) {
    if (!pub || !ORRY.token) throw new Error("ORRY is not configured.");
    const current = await pub.readContract({ address: ORRY.token, abi: iOrryTokenAbi, functionName: "allowance", args: [owner, spender] });
    if (current >= amount) return;
    step("Approve ORRY in your wallet.");
    await send({ address: ORRY.token, abi: iOrryTokenAbi as Abi, functionName: "approve", args: [spender, amount] });
  }

  async function run(label: string, fn: (h: { send: typeof send; step: (t: string) => void; ensureAllowance: typeof ensureAllowance }) => Promise<string | void>) {
    setBusy(label);
    setNotice({ tone: "", text: `${label}: confirm in your wallet.` });
    try {
      const done = await fn({ send, step: (t) => setNotice({ tone: "", text: t }), ensureAllowance });
      setNotice({ tone: "ok", text: done || `${label}: done.` });
      await qc.invalidateQueries();
      return true;
    } catch (e) {
      setNotice({ tone: "error", text: explain(e, `${label} did not go through.`) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  return { run, busy, notice, setNotice };
}
