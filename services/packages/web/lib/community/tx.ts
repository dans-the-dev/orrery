"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BaseError, ContractFunctionRevertedError, erc20Abi, parseAbi, type Abi, type Address, type Hex } from "viem";
import { useConnection, usePublicClient, useWriteContract } from "wagmi";
import { big } from "../orry/api";
import { explain, type Notice } from "../orry/chain";
import { span, utc } from "../orry/format";
import { usd } from "./logic";

/**
 * Writes from the connected wallet to the community contracts. Same flow as the ORRY pages (simulate, send, wait for the
 * receipt, refresh every read), with the ORRY address taken from the community config and plain messages for the
 * community contracts' errors.
 */

/** Custom errors of the community contracts, so a revert decodes to its name. */
export const communityErrorsAbi = parseAbi([
  "error ZeroAddress()",
  "error PriceNotReady()",
  "error PriceAboveMax(uint256 orryNeeded, uint256 maxOrry)",
  "error InexactTransfer()",
  "error UnknownRoom()",
  "error BelowRoomStake(uint256 stakeUsd, uint256 minStakeUsd)",
  "error BadText()",
  "error UnknownMessage()",
  "error SelfTip()",
  "error ZeroAmount()",
  "error BelowReportStake()",
  "error AlreadyReported()",
  "error BadName()",
  "error NameTaken()",
  "error SameName()",
  "error BadKind()",
  "error BadDays()",
  "error BadCount()",
  "error BadPrice()",
  "error UnknownTemplate()",
  "error NotCreator()",
  "error NotListed()",
  "error AlreadyLicensed()",
  "error OwnTemplate()",
  "error SelfReferral()",
  "error AlreadyLinked()",
  "error BadStatus()",
  "error NotPayableYet(uint64 payableAt)",
  "error NothingToClaim()",
  "error WrongKind()",
  "error PastDeadline()",
  "error AlreadyClaimed()",
  "error Full()",
  "error ConditionNotMet()",
  "error NotClaimableYet(uint64 claimableAt)",
  "error NotOpen()",
  "error PeriodIsClosed()",
  "error NotOpenable(uint256 openableAt)",
  "error AlreadyOpened()",
]);

/** A contract ABI with the community errors added, for writes. */
export const withErrors = (abi: Abi): Abi => [...abi, ...communityErrorsAbi];

const until = (t: unknown) => Number(t ?? 0) - Math.floor(Date.now() / 1000);

const ERRORS: Record<string, (a: readonly unknown[]) => string> = {
  ZeroAddress: () => "Enter a wallet address.",
  PriceNotReady: () => "The ORRY price is not ready yet. Try again in a moment.",
  PriceAboveMax: () => "The ORRY price moved since the quote. Send it again at the new price.",
  InexactTransfer: () => "The ORRY transfer did not match the amount.",
  UnknownRoom: () => "That room was not found.",
  BelowRoomStake: (a) => `This room is for wallets with ${usd(big(a[1]))} or more earning in Stake. Yours is ${usd(big(a[0]))}.`,
  BadText: () => "The message is empty or longer than the room allows.",
  UnknownMessage: () => "That message was not found.",
  SelfTip: () => "Tips go to other people's messages.",
  ZeroAmount: () => "Enter an amount above zero.",
  BelowReportStake: () => "Reporting needs more ORRY earning in Stake.",
  AlreadyReported: () => "You already reported this message.",
  BadName: () => "Use 3 to 20 characters: a to z, 0 to 9 and underscore.",
  NameTaken: () => "That name belongs to another wallet.",
  SameName: () => "That is already your name.",
  BadDays: () => "Boost between 1 and 30 days at a time.",
  BadCount: () => "Buy between 1 and 52 passes at a time.",
  BadPrice: () => "The price is outside the market's range.",
  UnknownTemplate: () => "That template was not found.",
  NotCreator: () => "Only the template's creator can change it.",
  NotListed: () => "This template is not for sale right now.",
  AlreadyLicensed: () => "This wallet already holds a licence for the template.",
  OwnTemplate: () => "This template is yours.",
  SelfReferral: () => "A wallet links to someone else's referral link.",
  AlreadyLinked: () => "This wallet already has a referrer.",
  BadStatus: () => "This event has no prize to claim.",
  NotPayableYet: (a) => (until(a[0]) > 0 ? `This prize is claimable in ${span(until(a[0]))}.` : "This prize is claimable in a moment."),
  NothingToClaim: () => "Nothing is waiting to claim here.",
  WrongKind: () => "This achievement is claimed another way.",
  PastDeadline: () => "This achievement has ended.",
  AlreadyClaimed: () => "This wallet already claimed it.",
  Full: () => "Every reward of this achievement has been claimed.",
  ConditionNotMet: () => "This wallet does not meet the condition yet.",
  NotClaimableYet: (a) => (until(a[0]) > 0 ? `Claimable in ${span(until(a[0]))}.` : "Claimable in a moment."),
  NotOpen: () => "This month opens for claims soon.",
  PeriodIsClosed: () => "The claim period for this month has ended.",
  NotOpenable: (a) => `This month opens on ${utc(Number(a[0] ?? 0))}.`,
  AlreadyOpened: () => "This month is already open.",
};

function explainCommunity(e: unknown, fallback: string): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
    const f = name ? ERRORS[name] : undefined;
    if (f && reverted instanceof ContractFunctionRevertedError) return f(reverted.data?.args ?? []);
  }
  return explain(e, fallback);
}

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export interface TxSteps {
  send: (c: Call) => Promise<Hex>;
  step: (t: string) => void;
  /** Approves `amount` of ORRY to `spender` unless the allowance already covers it. */
  approve: (token: Address, spender: Address, amount: bigint) => Promise<void>;
}
export type Run = (label: string, fn: (h: TxSteps) => Promise<string | void>) => Promise<boolean>;

export function useCommunityTx() {
  const pub = usePublicClient();
  const qc = useQueryClient();
  const { address: account } = useConnection();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function send(c: Call): Promise<Hex> {
    if (!pub) throw new Error("No connection to the network.");
    const call = { ...c, abi: withErrors(c.abi) };
    // Simulating first surfaces the contract's own error before the wallet opens.
    await pub.simulateContract({ ...call, account } as never).catch((e) => {
      if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) throw e;
    });
    const hash = await writeContractAsync(call as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("The transaction reverted.");
    return hash;
  }

  const run: Run = async (label, fn) => {
    setBusy(label);
    setNotice({ tone: "", text: `${label}: confirm in your wallet.` });
    const step = (t: string) => setNotice({ tone: "", text: t });
    const approve = async (token: Address, spender: Address, amount: bigint) => {
      if (!pub || !account) throw new Error("Connect a wallet first.");
      const current = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, spender] });
      if (current >= amount) return;
      step("Approve ORRY in your wallet.");
      await send({ address: token, abi: erc20Abi as Abi, functionName: "approve", args: [spender, amount] });
    };
    try {
      const done = await fn({ send, step, approve });
      setNotice({ tone: "ok", text: done || `${label}: done.` });
      await qc.invalidateQueries();
      return true;
    } catch (e) {
      setNotice({ tone: "error", text: explainCommunity(e, `${label} did not go through.`) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  return { run, busy, notice, setNotice };
}
