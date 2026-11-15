"use client";

import { useState } from "react";
import { parseAbi, type Abi, type Address } from "viem";
import { useReadContract } from "wagmi";
import { iOrryStakingAbi } from "@orrery/shared";
import { ADDRESSES } from "@/lib/config";
import { useAccountChain, useNow, useOrryConstants, useTx, useWallet, type Notice } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { mask, parseAmount, period, orry, span, toInput, utc } from "@/lib/orry/format";
import { AmountField, NoticeLine, Row } from "./parts";

const STAKING = ORRY.staking as Address;
const stakingAbi = iOrryStakingAbi as Abi;
const registryAbi = parseAbi(["function ownerOf(uint256) view returns (address)"]);

type Run = ReturnType<typeof useTx>["run"];

/** The agent stake sentence from the copy notes, with the cooldown read from the contract. */
export function agentStakeLine(cooldown?: number) {
  return `Stake ORRY behind this agent. Merchants see the amount in every check.${cooldown ? ` Unstaking takes ${period(cooldown)}.` : ""}`;
}

/** Form: stake ORRY behind an agentId. The caller must be the agent's owner or its agent wallet. */
export function StakeForAgentForm({ run, busy, fixedAgentId }: { run: Run; busy: boolean; fixedAgentId?: bigint }) {
  const { address, ready } = useWallet();
  const me = useAccountChain(address);
  const [agentIn, setAgentIn] = useState("");
  const [amountIn, setAmountIn] = useState("");
  const agentId = fixedAgentId ?? (/^\d+$/.test(agentIn) ? BigInt(agentIn) : undefined);
  const amount = parseAmount(amountIn);

  async function stake() {
    if (!address || agentId === undefined || !amount) return;
    await run("Stake behind agent", async ({ send, step, ensureAllowance }) => {
      await ensureAllowance(address, STAKING, amount, step);
      step("Confirm the stake in your wallet.");
      await send({ address: STAKING, abi: stakingAbi, functionName: "stakeForAgent", args: [agentId, amount] });
      setAmountIn("");
      return `Staked ${orry(amount)} ORRY behind agent #${agentId}. Checks for this agent now show it.`;
    });
  }

  return (
    <div className="rc-agent-form">
      {fixedAgentId === undefined ? (
        <div className="rc-amount">
          <label htmlFor="agent-id">Agent ID</label>
          <div className="rc-amount-box">
            <input id="agent-id" inputMode="numeric" autoComplete="off" placeholder="1" value={agentIn} onChange={(e) => setAgentIn(e.target.value.replace(/\D/g, ""))} />
            <span className="rc-unit">ERC-8004</span>
          </div>
          <div className="rc-amount-foot"><span>You must be the agent&apos;s owner or its agent wallet.</span></div>
        </div>
      ) : null}
      <AmountField id={`agent-amount-${fixedAgentId ?? "any"}`} label="ORRY to stake" unit="ORRY" value={amountIn} onChange={setAmountIn} max={me.orryBalance !== undefined ? orry(me.orryBalance) : undefined} onMax={() => me.orryBalance !== undefined && setAmountIn(toInput(me.orryBalance))} />
      <button className="primary rc-go" type="button" disabled={!ready || busy || agentId === undefined || !amount} onClick={() => void stake()}>
        Stake behind agent
      </button>
    </div>
  );
}

/** One agent position held by the connected staker, with its unstake and withdraw buttons. */
export function AgentPositionRow({
  agentId,
  owner,
  active,
  leaving,
  leavingAt,
  reportedForAgent,
  run,
  busy,
  bare = false,
  lockedUntil,
}: {
  agentId: bigint;
  owner: Address;
  active: bigint;
  leaving: bigint;
  leavingAt: number;
  reportedForAgent: boolean;
  run: Run;
  busy: boolean;
  /** Only the buttons, for a panel that already shows the figures. */
  bare?: boolean;
  /** Lock end in unix seconds when the caller already read it; otherwise read here from the position. */
  lockedUntil?: number;
}) {
  const { ready } = useWallet();
  const now = useNow();
  const [amountIn, setAmountIn] = useState("");
  const amount = parseAmount(amountIn);
  const readyNow = leaving > 0n && leavingAt > 0 && leavingAt <= now;
  // The API's account view carries no lock, so the position is read from the contract when the caller has none.
  const { data: onChain } = useReadContract({
    address: STAKING,
    abi: iOrryStakingAbi,
    functionName: "agentStakeOf",
    args: [agentId, owner],
    query: { enabled: lockedUntil === undefined, refetchInterval: 30_000 },
  });
  const lockEnd = lockedUntil ?? Number(onChain?.lockedUntil ?? 0);
  const locked = lockEnd > now;

  async function unstake() {
    if (!amount) return;
    await run("Agent unstake", async ({ send }) => {
      await send({ address: STAKING, abi: stakingAbi, functionName: "requestAgentUnstake", args: [agentId, owner, amount] });
      setAmountIn("");
      return `Unstake requested for ${orry(amount)} ORRY behind agent #${agentId}.`;
    });
  }
  async function withdraw() {
    await run("Agent withdraw", async ({ send }) => {
      await send({ address: STAKING, abi: stakingAbi, functionName: "withdrawAgent", args: [agentId, owner] });
      return `Withdrawn from agent #${agentId} to your wallet.`;
    });
  }

  return (
    <li className="rc-agent">
      {bare ? null : (
        <>
          <div className="rc-agent-head">
            <strong>Agent #{agentId.toString()}</strong>
            <span>{reportedForAgent ? "Shown in this agent's checks" : `Recorded for the earlier owner ${mask(owner)}`}</span>
          </div>
          <dl className="rc-rows rc-rows-tight">
            <Row label="Active">{orry(active)} ORRY</Row>
            <Row label="Leaving">{leaving > 0n ? `${orry(leaving)} ORRY, ${readyNow ? "ready now" : `ready in ${span(leavingAt - now)}`}` : "None"}</Row>
            {locked ? <Row label="Lock">Locked until {utc(lockEnd)}</Row> : null}
          </dl>
        </>
      )}
      <div className="rc-agent-actions">
        {active > 0n ? (
          <div className="rc-inline">
            <input aria-label={`ORRY to unstake from agent ${agentId}`} inputMode="decimal" placeholder="Amount" value={amountIn} onChange={(e) => setAmountIn(e.target.value.replace(/[^\d.]/g, ""))} />
            <button type="button" className="rc-max" onClick={() => setAmountIn(toInput(active))}>All</button>
            <button className="secondary" type="button" disabled={!ready || busy || locked || !amount || amount > active} onClick={() => void unstake()} title={locked ? `Locked until ${utc(lockEnd)}` : undefined}>
              Request unstake
            </button>
          </div>
        ) : null}
        <button className="secondary" type="button" disabled={!ready || busy || !readyNow} onClick={() => void withdraw()}>
          Withdraw
        </button>
      </div>
    </li>
  );
}

/**
 * Operator page panel: the stake reported for one agent, and the buttons to add to it or take it back. `exitOnly`
 * (staking held) drops the add form and shows the panel only to the address that staked, for unstake and withdraw.
 */
export function AgentStakePanel({ agentId, exitOnly = false }: { agentId: bigint; exitOnly?: boolean }) {
  const { address } = useWallet();
  const now = useNow();
  const consts = useOrryConstants();
  const tx = useTx();
  const { data: pos } = useReadContract({ address: STAKING, abi: iOrryStakingAbi, functionName: "agentStake", args: [agentId], query: { refetchInterval: 15_000 } });
  const { data: owner } = useReadContract({ address: ADDRESSES.registry, abi: registryAbi, functionName: "ownerOf", args: [agentId], query: { enabled: Boolean(ADDRESSES.registry) } });
  const staker = pos && !/^0x0{40}$/i.test(pos.staker) ? pos.staker : undefined;
  const mine = Boolean(staker && address && staker.toLowerCase() === address.toLowerCase());
  if (exitOnly && !(mine && pos && (pos.active > 0n || pos.leaving > 0n))) return null;

  return (
    <section className="rc-panel" aria-label="Agent stake">
      <div className="rc-panel-head">
        <h2>Agent stake</h2>
        <p>{agentStakeLine(consts.agentCooldown)}</p>
      </div>
      <dl className="rc-rows">
        <Row label="Agent">#{agentId.toString()}</Row>
        <Row label="Active">{pos ? `${orry(pos.active)} ORRY` : "…"}</Row>
        <Row label="Leaving">{pos ? (pos.leaving > 0n ? `${orry(pos.leaving)} ORRY, ${Number(pos.leavingAt) <= now ? "ready now" : `ready in ${span(Number(pos.leavingAt) - now)}`}` : "None") : "…"}</Row>
        <Row label="Staker">{pos ? (staker ? <span className="mono">{mask(staker)}{mine ? " (you)" : ""}</span> : "No stake yet") : "…"}</Row>
        {pos && Number(pos.lockedUntil) > now ? <Row label="Lock">Locked until {utc(Number(pos.lockedUntil))}</Row> : null}
      </dl>
      {exitOnly || (staker && !mine) ? null : <StakeForAgentForm run={tx.run} busy={Boolean(tx.busy)} fixedAgentId={agentId} />}
      {mine && pos && owner ? (
        <ul className="rc-agent-list">
          <AgentPositionRow agentId={agentId} owner={owner} active={pos.active} leaving={pos.leaving} leavingAt={Number(pos.leavingAt)} reportedForAgent run={tx.run} busy={Boolean(tx.busy)} bare lockedUntil={Number(pos.lockedUntil)} />
        </ul>
      ) : null}
      <NoticeLine notice={tx.notice as Notice} />
    </section>
  );
}
