"use client";

import Link from "next/link";
import { useState } from "react";
import type { Abi, Address } from "viem";
import { iOrryStakingAbi } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { useAccountView, useStakeStats } from "@/lib/orry/api";
import { useAccountChain, useNow, useOrryConstants, useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { ago, eth, parseAmount, pct, period, orry, span, toInput } from "@/lib/orry/format";
import { AgentPositionRow, StakeForAgentForm, agentStakeLine } from "./AgentStake";
import { useReleases } from "@/lib/orry/releases";
import { AmountField, ComingSoon, ExitConnect, Fig, NoticeLine, OrryHead, Row, Segmented } from "./parts";

type Mode = "stake" | "unstake" | "withdraw";
const STAKING = ORRY.staking as Address;
const stakingAbi = iOrryStakingAbi as Abi;

export function StakeReading() {
  const { data, isError } = useStakeStats();
  const now = useNow(5000);
  return (
    <div className="rc-card">
      <p className="rc-card-title">
        Staked ORRY
        {data?.updatedAt ? <span>{ago(data.updatedAt, now)}</span> : null}
      </p>
      {isError && !data ? (
        <p className="rc-card-wait">Stake readings load in a moment.</p>
      ) : (
        <>
          <p className="rc-big">
            <Fig v={data ? orry(data.totalEarning) : undefined} unit="ORRY" />
          </p>
          <dl className="rc-rows">
            <Row label="Stakers">{data ? data.stakers.toLocaleString("en-US") : "…"}</Row>
            <Row label="Rewards · 7 days">{data ? `${eth(data.rewards7d.eth)} ETH + ${orry(data.rewards7d.orry)} ORRY` : "…"}</Row>
            <Row label="Rewards · since launch">{data ? `${eth(data.rewardsAllTime.eth)} ETH + ${orry(data.rewardsAllTime.orry)} ORRY` : "…"}</Row>
          </dl>
        </>
      )}
    </div>
  );
}

/**
 * `exitOnly` (staking held): this wallet's stake, Request unstake, Withdraw, Claim rewards and its agent stakes'
 * unstake and withdraw, shown when it holds any of them. The stake forms wait. Unstake and withdraw are never held.
 */
export function StakeView({ exitOnly = false }: { exitOnly?: boolean }) {
  const { address, ready, connected } = useWallet();
  const me = useAccountChain(address);
  const account = useAccountView(address);
  const stats = useStakeStats();
  const consts = useOrryConstants();
  const now = useNow();
  const tx = useTx();
  const agentTx = useTx();
  const [mode, setMode] = useState<Mode>(exitOnly ? "unstake" : "stake");
  const [stakeIn, setStakeIn] = useState("");
  const [unstakeIn, setUnstakeIn] = useState("");
  const busy = Boolean(tx.busy);

  const leaving = me.stakeLeaving ?? 0n;
  const readyNow = leaving > 0n && me.stakeReadyAt > 0 && me.stakeReadyAt <= now;
  const hasRewards = Boolean((me.rewardsEth ?? 0n) > 0n || (me.rewardsOrry ?? 0n) > 0n);

  async function stake() {
    const a = parseAmount(stakeIn);
    if (!address || !a) return;
    await tx.run("Stake", async ({ send, step, ensureAllowance }) => {
      await ensureAllowance(address, STAKING, a, step);
      step("Sign the stake in your wallet.");
      await send({ address: STAKING, abi: stakingAbi, functionName: "stake", args: [a] });
      setStakeIn("");
      return `Stake on record · ${orry(a)} ORRY. Rewards reach it from the next stream on.`;
    });
  }
  async function requestUnstake() {
    const a = parseAmount(unstakeIn);
    if (!a) return;
    await tx.run("Request unstake", async ({ send }) => {
      await send({ address: STAKING, abi: stakingAbi, functionName: "requestUnstake", args: [a] });
      setUnstakeIn("");
      return `Unstake request on record · ${orry(a)} ORRY.${consts.plainCooldown ? ` Withdrawal opens in ${period(consts.plainCooldown)}.` : ""}`;
    });
  }
  async function withdraw() {
    await tx.run("Withdraw", async ({ send }) => {
      await send({ address: STAKING, abi: stakingAbi, functionName: "withdraw" });
      return "The ORRY went back to your wallet.";
    });
  }
  async function claimRewards() {
    await tx.run("Claim rewards", async ({ send }) => {
      await send({ address: STAKING, abi: stakingAbi, functionName: "claimRewards" });
      return "The rewards went to your wallet.";
    });
  }

  const agents = account.data?.agents ?? [];
  // Stake behind an agent is its own release (agent-stake); its unstake and withdraw are never held.
  const agentOpen = useReleases().isLive("agent-stake") && !exitOnly;
  const holds = (me.stakeActive ?? 0n) > 0n || leaving > 0n || hasRewards || agents.length > 0;

  if (exitOnly && !connected) return <ExitConnect text="Connect the staking wallet to unstake, withdraw or collect rewards." />;
  if (exitOnly && !tx.notice && !agentTx.notice && (me.stakeActive === undefined || !holds)) return null;

  return (
    <>
      {exitOnly ? null : (
        <OrryHead
          title={<>Stake ORRY and take part in what Orrery earns.</>}
          lead={<p>The protocol fee from each ORRY pool and the revenue from Orrery products flow to stakers in ETH and ORRY, streamed across all active stake.</p>}
          reading={<StakeReading />}
        />
      )}

      <div className="rc-grid">
        <section className="rc-desk" aria-label="Stake actions">
          <Segmented
            label="Stake actions"
            value={mode}
            onChange={setMode}
            options={[
              ...(exitOnly ? [] : [{ id: "stake" as Mode, label: "Stake" }]),
              { id: "unstake", label: "Request unstake" },
              { id: "withdraw", label: "Withdraw" },
            ]}
          />
          {mode === "stake" ? (
            <div className="rc-desk-body">
              <AmountField id="stake-in" label="Amount to stake" unit="ORRY" value={stakeIn} onChange={setStakeIn} max={me.orryBalance !== undefined ? orry(me.orryBalance) : undefined} onMax={() => me.orryBalance !== undefined && setStakeIn(toInput(me.orryBalance))} />
              <button className="primary rc-go" type="button" disabled={!ready || busy || !parseAmount(stakeIn)} onClick={() => void stake()}>
                {tx.busy === "Stake" ? "Staking…" : "Stake"}
              </button>
            </div>
          ) : null}
          {mode === "unstake" ? (
            <div className="rc-desk-body">
              <p className="rc-desk-note">
                ORRY in a request leaves the reward stream right away{consts.plainCooldown ? ` and becomes withdrawable ${period(consts.plainCooldown)} after` : ""}. Another request joins the pending amount and restarts the wait.
              </p>
              <AmountField id="unstake-in" label="Amount to unstake" unit="ORRY" value={unstakeIn} onChange={setUnstakeIn} max={me.stakeActive !== undefined ? orry(me.stakeActive) : undefined} onMax={() => me.stakeActive !== undefined && setUnstakeIn(toInput(me.stakeActive))} />
              <button className="primary rc-go" type="button" disabled={!ready || busy || !parseAmount(unstakeIn) || (me.stakeActive !== undefined && (parseAmount(unstakeIn) ?? 0n) > me.stakeActive)} onClick={() => void requestUnstake()}>
                {tx.busy === "Request unstake" ? "Requesting…" : "Request unstake"}
              </button>
            </div>
          ) : null}
          {mode === "withdraw" ? (
            <div className="rc-desk-body">
              <dl className="rc-rows rc-rows-tight">
                <Row label="Pending withdrawal">{leaving > 0n ? `${orry(leaving)} ORRY` : "No request"}</Row>
                {leaving > 0n ? <Row label="Ready">{readyNow ? "Now" : `In ${span(me.stakeReadyAt - now)}`}</Row> : null}
              </dl>
              <button className="primary rc-go" type="button" disabled={!ready || busy || !readyNow} onClick={() => void withdraw()}>
                {tx.busy === "Withdraw" ? "Withdrawing…" : "Withdraw"}
              </button>
            </div>
          ) : null}
          {!connected ? (
            <div className="rc-connect">
              <p>A connected wallet is needed to stake.</p>
              <WalletButton />
            </div>
          ) : null}
          <NoticeLine notice={tx.notice} />
        </section>

        <section className="rc-side" aria-label="Stake position">
          <h2>Stake position</h2>
          {!address ? (
            <p className="rc-muted">Connect a wallet to see its stake and rewards.</p>
          ) : (
            <>
              <dl className="rc-rows">
                <Row label="Earning" hint={stats.data?.totalEarning && me.earning ? `${pct(me.earning, stats.data.totalEarning)} of total stake` : undefined}>
                  <Fig v={orry(me.earning)} unit="ORRY" />
                </Row>
                <Row label="Plain stake">{me.stakeActive !== undefined ? `${orry(me.stakeActive)} ORRY` : "…"}</Row>
                <Row label="Leaving">{leaving > 0n ? `${orry(leaving)} ORRY · ${readyNow ? "withdrawable" : `withdrawable in ${span(me.stakeReadyAt - now)}`}` : "None"}</Row>
              </dl>
              <div className="rc-claim">
                <div>
                  <p className="rc-claim-label">Rewards to collect</p>
                  <p className="rc-claim-value">
                    <Fig v={eth(me.rewardsEth)} unit="ETH" />
                    <Fig v={orry(me.rewardsOrry)} unit="ORRY" />
                  </p>
                </div>
                <button className="primary" type="button" disabled={!ready || busy || !hasRewards} onClick={() => void claimRewards()}>
                  {tx.busy === "Claim rewards" ? "Claiming…" : "Claim rewards"}
                </button>
              </div>
            </>
          )}
          <div className="rc-explain">
            <p>
              Each reward is paid out across {consts.stakeStream ? period(consts.stakeStream) : "the streaming window"} and split over active stake by size.
              A stake placed on an agent earns on the same terms, and it is shown in every check of that agent.
            </p>
            <Link className="lp-link" href="/docs/stake">How staking works</Link>
          </div>
        </section>
      </div>

      {!exitOnly && !agentOpen ? (
        <ComingSoon title="Agent stake is on its way." text="A stake placed on an agent is shown to merchants in each check. The form is added here once agent stake begins." />
      ) : null}
      {!agentOpen && agents.length === 0 ? null : (
      <section className="rc-panel rc-agents" aria-label="Agent stake">
        <div className="rc-panel-head">
          <h2>{agentOpen ? "Stake on an agent" : "Agent stakes"}</h2>
          <p>{agentStakeLine(consts.agentCooldown)}</p>
        </div>
        <div className="rc-agents-grid">
          {agentOpen ? <StakeForAgentForm run={agentTx.run} busy={Boolean(agentTx.busy)} /> : null}
          <div>
            <h3>Agent stakes from this wallet</h3>
            {!address ? (
              <p className="rc-muted">Connect a wallet to see the agents it stakes on.</p>
            ) : agents.length === 0 ? (
              <p className="rc-muted">{account.isLoading ? "…" : "This address has no agent stake."}</p>
            ) : (
              <ul className="rc-agent-list">
                {agents.map((a) => (
                  <AgentPositionRow key={`${a.agentId}-${a.owner}`} {...a} run={agentTx.run} busy={Boolean(agentTx.busy)} />
                ))}
              </ul>
            )}
          </div>
        </div>
        <NoticeLine notice={agentTx.notice} />
      </section>
      )}
    </>
  );
}
