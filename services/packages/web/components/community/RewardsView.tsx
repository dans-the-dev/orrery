"use client";

import { useState, type ReactNode } from "react";
import { encodeAbiParameters, parseAbi, type Abi, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { REWARD_KINDS, orryAchievementsAbi, rewardPoolAbi, type CommunityAchievement, type CommunityRewardEvent } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { ComingSoon, NoticeLine, OrryHead, Row } from "@/components/orry/parts";
import { useMostActive, useRecipients, useRewards, type RewardsResponse } from "@/lib/community/api";
import { assetAmount, useAssetMeta, type AssetMeta } from "@/lib/community/assets";
import { useCommunity, type CommunityConfig } from "@/lib/community/config";
import { isZeroAddr, sameAddr, usd } from "@/lib/community/logic";
import { useCommunityTx } from "@/lib/community/tx";
import { big, time } from "@/lib/orry/api";
import { useNow, useWallet } from "@/lib/orry/chain";
import { COMING_SOON } from "@/lib/orry/config";
import { mask, period, span, utc } from "@/lib/orry/format";

const poolAbi = rewardPoolAbi as Abi;
const achievementsAbi = orryAchievementsAbi as Abi;
/** The two verifiers' own views: VerifiedAgentVerifier has `attestor`, StakeUsdVerifier has `minStakeUsd`. */
const verifierAbi = parseAbi(["function attestor() view returns (address)", "function minStakeUsd() view returns (uint256)"]);

const kindName = (kind: number, name?: string) => name || REWARD_KINDS[kind] || "Reward";

export function RewardsView() {
  const { config } = useCommunity();
  const rewards = useRewards(true);
  const data = rewards.data;
  const assets = [...(data?.pool ?? []).map((p) => p.asset), ...(data?.events ?? []).map((e) => e.asset), ...(data?.achievements ?? []).map((a) => a.asset)];
  const meta = useAssetMeta(assets, config?.addresses.orry ?? null);
  if (!config) return null;
  return (
    <>
      <OrryHead
        title="Rewards from the community pool."
        lead={<p>Chat fees, name fees and the cut of every tip fill the Reward Pool. It pays bug bounties, the most active wallets of each week and the achievements below.</p>}
        reading={<PoolCard data={data} error={rewards.isError} meta={meta} />}
      />
      <Events cfg={config} events={data?.events} loading={rewards.isLoading} meta={meta} />
      <Board cfg={config} data={data} loading={rewards.isLoading} meta={meta} />
      <MostActive />
    </>
  );
}

function PoolCard({ data, error, meta }: { data?: RewardsResponse; error: boolean; meta: (a: string) => AssetMeta | undefined }) {
  const pool = (data?.pool ?? []).filter((p) => big(p.free) + big(p.locked) > 0n);
  return (
    <div className="rc-card">
      <p className="rc-card-title">Reward Pool</p>
      {!data ? (
        <p className="rc-card-wait">{error ? "Pool balances appear here in a moment." : "…"}</p>
      ) : pool.length === 0 ? (
        <p className="rc-card-wait">Balances appear here as fees reach the pool.</p>
      ) : (
        <dl className="rc-rows">
          {pool.map((p) => {
            const m = meta(p.asset);
            const locked = big(p.locked);
            return (
              <Row key={p.asset} label={m?.symbol ?? mask(p.asset)} hint={locked > 0n && m ? `${assetAmount(locked, m)} set aside for open rewards` : undefined}>
                {assetAmount(big(p.free) + locked, m) || "…"}
              </Row>
            );
          })}
        </dl>
      )}
    </div>
  );
}

function Events({ cfg, events, loading, meta }: { cfg: CommunityConfig; events?: CommunityRewardEvent[]; loading: boolean; meta: (a: string) => AssetMeta | undefined }) {
  const list = events ?? [];
  return (
    <section className="rc-panel" aria-label="Events">
      <div className="rc-panel-head">
        <h2>Events</h2>
        <p>
          Bug bounties, the week&apos;s most active wallets and quests. Winners are published with a public check
          {cfg.checkWindowSeconds > 0 ? ` of ${period(cfg.checkWindowSeconds)}` : ""}, then each winner claims the prize.
        </p>
      </div>
      {loading ? (
        <p className="rc-muted">…</p>
      ) : list.length === 0 ? (
        <p className="rc-muted">Events appear here when the next one opens.</p>
      ) : (
        <ul className="cm-events">
          {list.map((e) => (
            <EventRow key={e.id} cfg={cfg} event={e} meta={meta(e.asset)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EventRow({ cfg, event: e, meta }: { cfg: CommunityConfig; event: CommunityRewardEvent; meta?: AssetMeta }) {
  const { address, ready } = useWallet();
  const now = useNow(5000);
  const tx = useCommunityTx();
  const pool = cfg.addresses.pool as Address;
  const published = e.status === "published";
  const mine = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: pool, abi: rewardPoolAbi, functionName: "prizeOf", args: [BigInt(e.id), address ?? "0x0000000000000000000000000000000000000000"] },
      { address: pool, abi: rewardPoolAbi, functionName: "claimed", args: [BigInt(e.id), address ?? "0x0000000000000000000000000000000000000000"] },
    ],
    query: { enabled: Boolean(address && published) },
  });
  const prize = mine.data?.[0]?.status === "success" ? (mine.data[0].result as bigint) : 0n;
  const claimed = mine.data?.[1]?.status === "success" ? Boolean(mine.data[1].result) : false;
  const deadline = time(e.deadline);
  const payableAt = e.payableAt ? time(e.payableAt) : 0;

  const status =
    e.status === "open"
      ? deadline > now
        ? `Open until ${utc(deadline)}`
        : "Ended. The amount returns to the pool"
      : e.status === "published"
        ? payableAt > now
          ? `Winners published. Prizes claimable in ${span(payableAt - now)}`
          : "Winners published. Prizes claimable now"
        : "Ended. The amount went back to the pool";

  async function claim() {
    await tx.run("Claim prize", async ({ send }) => {
      await send({ address: pool, abi: poolAbi, functionName: "claim", args: [BigInt(e.id)] });
      return `Claimed ${assetAmount(prize, meta)}.`;
    });
  }

  return (
    <li className="cm-event">
      <div className="cm-event-main">
        <div>
          <strong>{kindName(e.kind, e.kindName)}</strong>
          <span>{status}</span>
        </div>
        <span className="cm-amount">{assetAmount(big(e.amount), meta) || "…"}</span>
      </div>
      {e.winners.length > 0 ? (
        <ol className="cm-winners">
          {e.winners.map((w) => (
            <li key={w.address}>
              <span className="mono">{sameAddr(w.address, address) ? "You" : mask(w.address)}</span>
              <span className="mono">{assetAmount(big(w.amount), meta)}</span>
              <span>{w.paid ? "Paid" : ""}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {prize > 0n ? (
        <div className="rc-claim cm-claim">
          <div>
            <p className="rc-claim-label">{claimed ? "Your prize, claimed" : "Your prize"}</p>
            <p className="rc-claim-value">{assetAmount(prize, meta)}</p>
          </div>
          {claimed ? null : (
            <button className="primary" type="button" disabled={!ready || Boolean(tx.busy) || payableAt > now} onClick={() => void claim()}>
              {payableAt > now ? `Claimable in ${span(payableAt - now)}` : tx.busy ? "Claiming…" : "Claim"}
            </button>
          )}
        </div>
      ) : null}
      <NoticeLine notice={tx.notice} />
    </li>
  );
}

function Board({ cfg, data, loading, meta }: { cfg: CommunityConfig; data?: RewardsResponse; loading: boolean; meta: (a: string) => AssetMeta | undefined }) {
  const { connected } = useWallet();
  const list = data?.achievements ?? [];
  const held = (asset: string) => {
    if (sameAddr(asset, cfg.addresses.orry)) return false;
    const p = data?.pool.find((x) => sameAddr(x.asset, asset));
    return !p || big(p.free) + big(p.locked) === 0n;
  };
  return (
    <section className="rc-panel" aria-label="Achievement Board">
      <div className="rc-panel-head">
        <h2>Achievement Board</h2>
        <p>Each achievement pays the same reward to every wallet that completes it, first come first served. Recipients are listed in the order they completed it.</p>
      </div>
      {!cfg.addresses.achievements ? (
        <p className="rc-muted">Achievements: {COMING_SOON}.</p>
      ) : loading ? (
        <p className="rc-muted">…</p>
      ) : list.length === 0 ? (
        <p className="rc-muted">Achievements appear here when the first one opens.</p>
      ) : (
        <ul className="cm-achievements">
          {list.map((a) => (
            <AchievementRow key={a.id} cfg={cfg} a={a} meta={meta(a.asset)} held={held(a.asset)} />
          ))}
        </ul>
      )}
      {!connected && list.length > 0 ? (
        <div className="rc-connect">
          <p>Connect a wallet to claim the achievements you completed.</p>
          <WalletButton />
        </div>
      ) : null}
    </section>
  );
}

function AchievementRow({ cfg, a, meta, held }: { cfg: CommunityConfig; a: CommunityAchievement; meta?: AssetMeta; held: boolean }) {
  const { address, ready } = useWallet();
  const now = useNow(5000);
  const tx = useCommunityTx();
  const [showRecipients, setShowRecipients] = useState(false);
  const [agentIn, setAgentIn] = useState("");
  const board = cfg.addresses.achievements as Address;
  const me = address ?? ("0x0000000000000000000000000000000000000000" as Address);
  const verifier = a.verifier && !isZeroAddr(a.verifier) ? (a.verifier as Address) : undefined;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: board, abi: orryAchievementsAbi, functionName: "claimed", args: [BigInt(a.id), me] },
      { address: board, abi: orryAchievementsAbi, functionName: "listedAt", args: [BigInt(a.id), me] },
    ],
    query: { enabled: Boolean(address) },
  });
  const condition = useReadContracts({
    allowFailure: true,
    contracts: verifier
      ? [
          { address: verifier, abi: verifierAbi, functionName: "attestor" },
          { address: verifier, abi: verifierAbi, functionName: "minStakeUsd" },
        ]
      : [],
    query: { enabled: Boolean(verifier), staleTime: Infinity },
  });
  const claimed = reads.data?.[0]?.status === "success" ? Boolean(reads.data[0].result) : false;
  const listedAt = reads.data?.[1]?.status === "success" ? Number(reads.data[1].result as bigint) : 0;
  const needsAgent = condition.data?.[0]?.status === "success";
  const minStake = condition.data?.[1]?.status === "success" ? (condition.data[1].result as bigint) : undefined;
  const deadline = time(a.deadline);
  const ended = a.closed || deadline <= now;
  const claimableAt = listedAt > 0 ? listedAt + cfg.checkWindowSeconds : 0;
  const agentId = /^\d+$/.test(agentIn) ? BigInt(agentIn) : undefined;

  const how = verifier
    ? needsAgent
      ? "Own an agent that Orrery has verified, then claim with its agent ID."
      : minStake !== undefined
        ? `Hold an earning stake worth ${usd(minStake)} or more, then claim.`
        : "Meet the condition on chain, then claim."
    : `Orrery lists the wallets that complete it. Each can claim${cfg.checkWindowSeconds > 0 ? ` ${period(cfg.checkWindowSeconds)}` : ""} after its listing.`;

  async function claim() {
    const label = "Claim reward";
    await tx.run(label, async ({ send }) => {
      if (verifier) {
        const data = needsAgent && agentId !== undefined ? encodeAbiParameters([{ type: "uint256" }], [agentId]) : "0x";
        await send({ address: board, abi: achievementsAbi, functionName: "claim", args: [BigInt(a.id), data] });
      } else {
        await send({ address: board, abi: achievementsAbi, functionName: "claimListed", args: [BigInt(a.id)] });
      }
      return `Claimed ${assetAmount(big(a.rewardPerUser), meta)}.`;
    });
  }

  let action: ReactNode = null;
  if (held) action = <span className="cm-state">{COMING_SOON}</span>;
  else if (claimed) action = <span className="cm-state">Claimed</span>;
  else if (ended || !address) action = null;
  else if (verifier) {
    action = (
      <div className="cm-claim-row">
        {needsAgent ? (
          <div className="rc-inline">
            <label className="cm-label" htmlFor={`cm-agent-${a.id}`}>
              Agent ID
            </label>
            <input id={`cm-agent-${a.id}`} inputMode="numeric" autoComplete="off" placeholder="1" value={agentIn} onChange={(e) => setAgentIn(e.target.value.replace(/\D/g, ""))} />
          </div>
        ) : null}
        <button className="primary" type="button" disabled={!ready || Boolean(tx.busy) || (needsAgent && agentId === undefined)} onClick={() => void claim()}>
          {tx.busy ? "Claiming…" : "Claim"}
        </button>
      </div>
    );
  } else if (listedAt > 0) {
    action =
      claimableAt > now ? (
        <span className="cm-state">Claimable in {span(claimableAt - now)}</span>
      ) : (
        <button className="primary" type="button" disabled={!ready || Boolean(tx.busy)} onClick={() => void claim()}>
          {tx.busy ? "Claiming…" : "Claim"}
        </button>
      );
  }

  return (
    <li className="cm-achievement">
      <div className="cm-event-main">
        <div>
          <strong>{kindName(a.kind, a.kindName)}</strong>
          <span>{how}</span>
          <span>{ended ? "Ended" : `Until ${utc(deadline)}`}</span>
        </div>
        <div className="cm-reward">
          <span className="cm-amount">{held ? COMING_SOON : assetAmount(big(a.rewardPerUser), meta) || "…"}</span>
          {held ? null : <small>per wallet</small>}
        </div>
      </div>
      <div className="cm-achievement-foot">
        <button type="button" className="cm-link" aria-expanded={showRecipients} onClick={() => setShowRecipients((s) => !s)}>
          {showRecipients ? "Hide recipients" : "Recipients"}
        </button>
        {action}
      </div>
      {showRecipients ? <Recipients id={a.id} meta={meta} /> : null}
      <NoticeLine notice={tx.notice} />
    </li>
  );
}

function Recipients({ id, meta }: { id: number; meta?: AssetMeta }) {
  const q = useRecipients(id, true);
  const rows = q.data?.recipients ?? [];
  if (q.isLoading) return <p className="rc-muted">…</p>;
  if (rows.length === 0) return <p className="rc-muted">{q.isError ? "Recipients appear here in a moment." : "The first wallet to complete it appears here."}</p>;
  return (
    <table className="rc-table cm-recipients">
      <thead>
        <tr>
          <th scope="col" className="rank">Order</th>
          <th scope="col">Address</th>
          <th scope="col">Completed</th>
          <th scope="col" className="num">Reward</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.rank}-${r.address}`}>
            <td className="rank mono">{r.rank}</td>
            <td className="mono">{mask(r.address)}</td>
            <td className="mono">{utc(time(r.completedAt))}</td>
            <td className="num mono">{assetAmount(big(r.amount), meta)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MostActive() {
  const q = useMostActive(true);
  const d = q.data;
  const rows = d?.rows ?? [];
  return (
    <section className="rc-panel rc-board" aria-label="Most active, 7 days">
      <div className="rc-panel-head">
        <h2>Most active, 7 days</h2>
        <p>
          Ranked by protocol fees paid in USD over the last 7 days, read from the chain.
          {d?.from && d?.to ? ` ${utc(time(d.from))} to ${utc(time(d.to))}.` : ""}
        </p>
        {d?.rules ? (
          <details className="cm-rules">
            <summary>Ranking rules</summary>
            <pre className="mono">{prettyRules(d.rules)}</pre>
          </details>
        ) : null}
      </div>
      {q.isLoading ? (
        <p className="rc-muted">…</p>
      ) : rows.length === 0 ? (
        <p className="rc-muted">{q.isError ? "The ranking appears here in a moment." : "The ranking fills as wallets pay fees this week."}</p>
      ) : (
        <table className="rc-table">
          <thead>
            <tr>
              <th scope="col" className="rank">Rank</th>
              <th scope="col">Address</th>
              <th scope="col" className="num">Fees paid</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.rank}-${r.address}`} className={r.rank <= 3 ? "is-top" : undefined}>
                <td className="rank mono">{r.rank}</td>
                <td className="mono">{mask(r.address)}</td>
                <td className="num mono" data-label="Fees paid">
                  {usd(big(r.feesUsd))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d?.rulesHash ? <p className="cm-hash mono">Rules hash {d.rulesHash}</p> : null}
    </section>
  );
}

function prettyRules(rules: string): string {
  try {
    return JSON.stringify(JSON.parse(rules), null, 2);
  } catch {
    return rules;
  }
}
