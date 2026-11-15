"use client";

import Link from "next/link";
import type { Abi, Address } from "viem";
import { useBalance, useReadContracts, useSimulateContract } from "wagmi";
import { iClaimAllAbi, iEarnVaultAbi, iOrryRewardsRouterAbi, iOrryStakingAbi, iOrryTokenAbi } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { useAccountView } from "@/lib/orry/api";
import { useAccountChain, useNow, useOrryConstants, useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { assetFrac, hasFees, hasShares, useAssetMeta, useEarnPositions, type AssetMeta } from "@/lib/orry/earn";
import { amount, eth, every, orry, span, utc } from "@/lib/orry/format";
import { ExitConnect, Fig, NoticeLine, OrryHead, Row } from "./parts";

const ROUTER = ORRY.router as Address;

/** Anyone's button: splits what the rewards router holds between stakers and the burn. */
function Distribute() {
  const consts = useOrryConstants();
  const now = useNow();
  const tx = useTx();
  const { ready } = useWallet();
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: ROUTER, abi: iOrryRewardsRouterAbi, functionName: "lastDistributionAt" },
      { address: ROUTER, abi: iOrryRewardsRouterAbi, functionName: "STAKERS_BPS" },
      { address: ORRY.token as Address, abi: iOrryTokenAbi, functionName: "balanceOf", args: [ROUTER] },
    ],
    query: { refetchInterval: 15_000 },
  });
  const ethHeld = useBalance({ address: ROUTER, query: { refetchInterval: 15_000 } });
  const last = data?.[0]?.status === "success" ? Number(data[0].result) : undefined;
  const bps = data?.[1]?.status === "success" ? Number(data[1].result) : undefined;
  const rcHeld = data?.[2]?.status === "success" ? (data[2].result as bigint) : undefined;
  const next = last !== undefined && consts.distributeInterval !== undefined ? last + consts.distributeInterval : undefined;
  const waiting = next !== undefined && next > now;
  const empty = ethHeld.data?.value === 0n && rcHeld === 0n;

  async function distribute() {
    await tx.run("Distribute", async ({ send }) => {
      await send({ address: ROUTER, abi: iOrryRewardsRouterAbi as Abi, functionName: "distribute" });
      return "Distribution on record. The new rewards begin streaming to stakers.";
    });
  }

  return (
    <section className="rc-panel" aria-label="Distribute">
      <div className="rc-panel-head">
        <h2>Distribute</h2>
        <p>
          The protocol share of pool fees, along with the ORRY bought from product revenue, collects in the rewards router.
          {bps !== undefined ? ` Each distribution passes ${bps / 100}% of every asset to stakers and burns the remainder.` : ""} Any wallet may trigger it
          {consts.distributeInterval ? ` ${every(consts.distributeInterval)}` : ""}.
        </p>
      </div>
      <div className="rc-split">
        <dl className="rc-rows">
          <Row label="Held by the router">
            {ethHeld.data && rcHeld !== undefined ? `${eth(ethHeld.data.value)} ETH + ${orry(rcHeld)} ORRY` : "…"}
          </Row>
          <Row label="Last run">{last === undefined ? "…" : last === 0 ? "No run so far" : utc(last)}</Row>
          <Row label="Next run">{next === undefined ? "…" : waiting ? `In ${span(next - now)}` : "Ready"}</Row>
        </dl>
        <div className="rc-split-act">
          <button className="secondary" type="button" disabled={!ready || Boolean(tx.busy) || waiting || empty} onClick={() => void distribute()}>
            {tx.busy ? "Distributing…" : "Distribute"}
          </button>
          <NoticeLine notice={tx.notice} />
        </div>
      </div>
    </section>
  );
}

/**
 * `exitOnly` (claim center held): the Claims and withdrawals list with Claim all, for a wallet that has something to
 * claim or withdraw. Claims are never held; Distribute waits with the claim center.
 */
export function ClaimView({ exitOnly = false }: { exitOnly?: boolean }) {
  const { address, ready } = useWallet();
  const me = useAccountChain(address);
  const earn = useEarnPositions(address);
  const account = useAccountView(address);
  const metaOf = useAssetMeta();
  const now = useNow();
  const tx = useTx();
  const busy = Boolean(tx.busy);

  // What Claim all pays right now, per asset (ORRY, ETH, then each other quote), from the contract itself.
  const sim = useSimulateContract({
    address: ORRY.claimAll,
    abi: iClaimAllAbi,
    functionName: "claimAll",
    account: address,
    query: { enabled: Boolean(address && ORRY.claimAll), refetchInterval: 12_000 },
  });
  const paid = (sim.data?.result as readonly { asset: Address; amount: bigint }[] | undefined)?.map((p) => ({ ...p, meta: metaOf(p.asset) }));
  const loaded = paid !== undefined && paid.every((p) => p.meta) && earn.loaded && me.rewardsEth !== undefined;
  const anyReady = (paid ?? []).some((p) => p.amount > 0n);
  const fig = (v: bigint, m?: AssetMeta) => (m ? amount(v, { decimals: m.decimals, frac: assetFrac(m.symbol) }) : undefined);

  const leaving = me.stakeLeaving ?? 0n;
  const stakeReady = leaving > 0n && me.stakeReadyAt > 0 && me.stakeReadyAt <= now;
  const agentsLeaving = (account.data?.agents ?? []).filter((a) => a.leaving > 0n);
  // Pools where this wallet has a share or fees; a pool it never joined adds no rows.
  const held = earn.positions.filter((p) => hasShares(p) || hasFees(p));

  async function claimAll() {
    await tx.run("Claim all", async ({ send }) => {
      await send({ address: ORRY.claimAll as Address, abi: iClaimAllAbi as Abi, functionName: "claimAll" });
      void sim.refetch();
      earn.refetch();
      return "All fees and rewards went to your wallet.";
    });
  }
  const call = (label: string, address: Address, abi: Abi, functionName: string, args?: readonly unknown[], done?: string) =>
    tx.run(label, async ({ send }) => {
      await send({ address, abi, functionName, args });
      void sim.refetch();
      earn.refetch();
      return done ?? `${label} is on record.`;
    });

  const holds = anyReady || leaving > 0n || agentsLeaving.length > 0 || held.length > 0;
  if (exitOnly && !address) return <ExitConnect text="Connect the wallet that holds the position to collect fees, rewards or withdrawals." />;
  if (exitOnly && !tx.notice && (!loaded || !holds)) return null;

  const readyList = (
    <ul className="rc-assets" aria-label="Claimable by asset">
      {(paid ?? []).map((p) => (
        <li key={p.asset}>
          <Fig v={loaded ? fig(p.amount, p.meta) : undefined} unit={p.meta?.symbol} />
        </li>
      ))}
    </ul>
  );

  return (
    <>
      {exitOnly ? null : <OrryHead
        title="All your fees and rewards, on one chart."
        lead={<p>Fees from each Earn pool and rewards from Stake are gathered on this page. Collect them in a single transaction, or item by item.</p>}
        reading={
          <div className="rc-card">
            <p className="rc-card-title">Claimable now</p>
            {!address ? (
              <>
                <p className="rc-card-wait">Connect a wallet to see what it can collect.</p>
                <WalletButton />
              </>
            ) : (
              <>
                {paid ? readyList : <p className="rc-big"><Fig v={undefined} /></p>}
                <button className="primary rc-go" type="button" disabled={!ready || busy || !loaded || !anyReady} onClick={() => void claimAll()}>
                  {tx.busy === "Claim all" ? "Claiming…" : "Claim all"}
                </button>
                <dl className="rc-rows">
                  <Row label="Total earned" hint="Earn plus Stake, collected or pending">
                    {account.data
                      ? account.data.earnedAllTime.length
                        ? account.data.earnedAllTime.map((e) => `${amount(e.amount, { decimals: e.decimals, frac: assetFrac(e.symbol) })} ${e.symbol}`).join(" + ")
                        : "None so far"
                      : account.isError
                        ? "Loads in a moment"
                        : "…"}
                  </Row>
                </dl>
              </>
            )}
          </div>
        }
      />}

      {address ? (
        <section className="rc-panel" aria-label="Pending payouts">
          <div className="rc-panel-head">
            <h2>Pending payouts</h2>
          </div>
          <ul className="rc-claims">
            {exitOnly ? (
              <li>
                <div>
                  <strong>All claimable</strong>
                  <span>{loaded ? (paid ?? []).map((p) => `${fig(p.amount, p.meta)} ${p.meta?.symbol}`).join(" + ") : "…"}</span>
                </div>
                <button className="primary" type="button" disabled={!ready || busy || !anyReady} onClick={() => void claimAll()}>
                  {tx.busy === "Claim all" ? "Claiming…" : "Claim all"}
                </button>
              </li>
            ) : null}
            {held.map((p) => (
              <li key={`fees-${p.vault}`}>
                <div>
                  <strong>{`Earn fees · ORRY / ${p.quote.symbol}`}</strong>
                  <span>{p.feesQuote !== undefined ? `${fig(p.feesQuote, p.quote)} ${p.quote.symbol} + ${orry(p.feesOrry)} ORRY` : "…"}</span>
                </div>
                <button className="secondary" type="button" disabled={!ready || busy || !hasFees(p)} onClick={() => void call("Claim fees", p.vault, iEarnVaultAbi as Abi, "claimFees", undefined, `The ORRY / ${p.quote.symbol} fees went to your wallet.`)}>
                  Claim fees
                </button>
              </li>
            ))}
            <li>
              <div>
                <strong>Stake rewards</strong>
                <span>{me.rewardsEth !== undefined ? `${eth(me.rewardsEth)} ETH + ${orry(me.rewardsOrry)} ORRY` : "…"}</span>
              </div>
              <button className="secondary" type="button" disabled={!ready || busy || ((me.rewardsEth ?? 0n) === 0n && (me.rewardsOrry ?? 0n) === 0n)} onClick={() => void call("Claim rewards", ORRY.staking as Address, iOrryStakingAbi as Abi, "claimRewards", undefined, "The rewards went to your wallet.")}>
                Claim rewards
              </button>
            </li>
            <li>
              <div>
                <strong>Plain stake on its way out</strong>
                <span>{leaving > 0n ? `${orry(leaving)} ORRY · ${stakeReady ? "withdrawable" : `withdrawable in ${span(me.stakeReadyAt - now)}`}` : "No pending unstake"}</span>
              </div>
              <button className="secondary" type="button" disabled={!ready || busy || !stakeReady} onClick={() => void call("Withdraw", ORRY.staking as Address, iOrryStakingAbi as Abi, "withdraw", undefined, "The ORRY went back to your wallet.")}>
                Withdraw
              </button>
            </li>
            {agentsLeaving.map((a) => {
              const r = a.leavingAt > 0 && a.leavingAt <= now;
              return (
                <li key={`${a.agentId}-${a.owner}`}>
                  <div>
                    <strong>Agent #{a.agentId.toString()} stake on its way out</strong>
                    <span>{`${orry(a.leaving)} ORRY · ${r ? "withdrawable" : `withdrawable in ${span(a.leavingAt - now)}`}`}</span>
                  </div>
                  <button className="secondary" type="button" disabled={!ready || busy || !r} onClick={() => void call("Agent withdraw", ORRY.staking as Address, iOrryStakingAbi as Abi, "withdrawAgent", [a.agentId, a.owner], `The stake on agent #${a.agentId} went back to your wallet.`)}>
                    Withdraw
                  </button>
                </li>
              );
            })}
            {held.length === 0 ? (
              <li>
                <div>
                  <strong>Earn positions</strong>
                  <span>{earn.loaded ? "None so far" : "…"}</span>
                </div>
                <Link className="secondary" href="/earn">Open Earn</Link>
              </li>
            ) : null}
            {held.map((p) => (
              <li key={`pos-${p.vault}`}>
                <div>
                  <strong>{`Earn position · ORRY / ${p.quote.symbol}`}</strong>
                  <span>{p.shares === undefined ? "…" : p.shares === 0n ? "No share" : p.unlockAt > now ? `Withdrawable in ${span(p.unlockAt - now)}` : "Withdrawable"}</span>
                </div>
                <Link className="secondary" href="/earn">Open Earn</Link>
              </li>
            ))}
          </ul>
          <NoticeLine notice={tx.notice} />
        </section>
      ) : null}

      {exitOnly ? null : <Distribute />}
    </>
  );
}
