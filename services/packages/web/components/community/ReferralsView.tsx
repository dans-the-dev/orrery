"use client";

import { useEffect, useState } from "react";
import type { Abi, Address } from "viem";
import { useReadContract } from "wagmi";
import { ACCRUAL_KINDS, cashbackRewardsAbi, referralRegistryAbi, type ReferralSummary } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { ComingSoon, NoticeLine, OrryHead, Row } from "@/components/orry/parts";
import { useCashback, useReferral, useReferralBoard } from "@/lib/community/api";
import { useCommunity, type CommunityConfig } from "@/lib/community/config";
import { isZeroAddr, referralLink, referrerFromSearch, sameAddr, usd } from "@/lib/community/logic";
import { useCommunityTx } from "@/lib/community/tx";
import { big, time } from "@/lib/orry/api";
import { useNow, useWallet } from "@/lib/orry/chain";
import { mask, orry, utc } from "@/lib/orry/format";

const registryAbi = referralRegistryAbi as Abi;
const cashbackAbi = cashbackRewardsAbi as Abi;

/** The referral rules as the product states them (services config, spec L1-14: R-53, R-54, R-55). */
const RULES =
  "For 90 days, a referrer receives 20% of every fee the referred wallet pays, settled in ORRY. Over those same 90 days the referred wallet pays 10% less in fees. Each month's rewards open for claiming 30 days after that month ends.";

const day = (t: number) => utc(t).slice(0, 10);

export function ReferralsView() {
  const { config, live } = useCommunity();
  if (!config) return null;
  return <Referrals cfg={config} referralsOpen={live("referrals")} cashbackOpen={live("cashback")} />;
}

function Referrals({ cfg, referralsOpen, cashbackOpen }: { cfg: CommunityConfig; referralsOpen: boolean; cashbackOpen: boolean }) {
  const { address } = useWallet();
  const summary = useReferral(address, referralsOpen);
  const cashback = useCashback(address, cashbackOpen);
  const months = summary.data?.months ?? cashback.data?.months ?? [];

  return (
    <>
      <OrryHead title="Share your link, take a part of every fee." lead={<p>{RULES}</p>} reading={referralsOpen ? <LinkCard /> : undefined} />
      {referralsOpen ? <LinkOffer cfg={cfg} /> : null}
      <div className="rc-grid">
        {cashbackOpen ? (
          <Months cfg={cfg} months={months} loading={Boolean(address) && (summary.isLoading || cashback.isLoading)} />
        ) : (
          <ComingSoon title="Monthly claims are on their way." text="Rewards are charted here month by month, with a single claim, once claims begin." />
        )}
        <section className="rc-side" aria-label="Your referrals">
          <h2>Your referrals</h2>
          {!address ? (
            <p className="rc-muted">Connect a wallet to see who referred it, whom it referred and its discount.</p>
          ) : !referralsOpen ? (
            <p className="rc-muted">Referral links become available shortly.</p>
          ) : (
            <Summary data={summary.data} loading={summary.isLoading} />
          )}
        </section>
      </div>
      {cashbackOpen ? <Records address={address} data={cashback.data} loading={cashback.isLoading} /> : null}
      {referralsOpen ? <Board /> : null}
    </>
  );
}

/** Your link, ready to copy. */
function LinkCard() {
  const { address, connected } = useWallet();
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const link = address && origin ? referralLink(origin, address) : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="rc-card">
      <p className="rc-card-title">Referral link</p>
      {!connected ? (
        <>
          <p className="rc-card-wait">A connected wallet gets its own link.</p>
          <WalletButton />
        </>
      ) : !address ? (
        <p className="rc-card-wait">…</p>
      ) : (
        <>
          <p className="cm-reflink mono">{link || "…"}</p>
          <button className="primary rc-go" type="button" disabled={!link} onClick={() => void copy()}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </>
      )}
    </div>
  );
}

/** Opened from someone's link: link this wallet to them, once, if it has no referrer yet. Never to the wallet itself. */
function LinkOffer({ cfg }: { cfg: CommunityConfig }) {
  const { address, ready, connected } = useWallet();
  const tx = useCommunityTx();
  const registry = cfg.addresses.referrals as Address;
  const [search, setSearch] = useState("");
  useEffect(() => setSearch(window.location.search), []);
  const ref = referrerFromSearch(search, address);
  const current = useReadContract({ address: registry, abi: referralRegistryAbi, functionName: "referrerOf", args: address ? [address] : undefined, query: { enabled: Boolean(address && ref) } });
  const [done, setDone] = useState(false);

  if (!ref) return null;
  if (connected && (current.data === undefined || !isZeroAddr(current.data)) && !done) return null;

  async function link() {
    if (!ref) return;
    const ok = await tx.run("Link", async ({ send }) => {
      await send({ address: registry, abi: registryAbi, functionName: "link", args: [ref] });
      return `Referrer on record · ${mask(ref)}. Fees cost you 10% less for the next 90 days.`;
    });
    if (ok) setDone(true);
  }

  return (
    <section className="rc-claim cm-offer" aria-label="Referral link">
      <div>
        <p className="rc-claim-label">Invited by {mask(ref)}</p>
        <p className="cm-offer-text">Accept the invite and this wallet pays 10% less in fees for 90 days.</p>
        <NoticeLine notice={tx.notice} />
      </div>
      {connected ? (
        done ? null : (
          <button className="primary" type="button" disabled={!ready || Boolean(tx.busy)} onClick={() => void link()}>
            {tx.busy ? "Linking…" : "Link"}
          </button>
        )
      ) : (
        <WalletButton />
      )}
    </section>
  );
}

function Summary({ data, loading }: { data?: ReferralSummary; loading: boolean }) {
  const now = useNow(30_000);
  if (loading) return <p className="rc-muted">…</p>;
  if (!data) return <p className="rc-muted">Referral figures load in a moment.</p>;
  const discountUntil = data.discountUntil ? time(data.discountUntil) : 0;
  return (
    <dl className="rc-rows">
      <Row label="Referred by" hint={data.linkedAt ? `Linked ${day(time(data.linkedAt))}` : undefined}>
        {data.referrer && !isZeroAddr(data.referrer) ? mask(data.referrer) : "None"}
      </Row>
      <Row label="Wallets referred">{data.referees.toLocaleString("en-US")}</Row>
      {discountUntil > 0 ? <Row label="Fee discount">{discountUntil > now ? `10% through ${day(discountUntil)}` : `Ended ${day(discountUntil)}`}</Row> : null}
    </dl>
  );
}

/** Rewards by month: what each owes in USD, when it opens, and the claim of every open month in one transaction. */
function Months({ cfg, months, loading }: { cfg: CommunityConfig; months: ReferralSummary["months"]; loading: boolean }) {
  const { address, ready, connected } = useWallet();
  const now = useNow(30_000);
  const tx = useCommunityTx();
  const sink = cfg.addresses.cashback as Address;
  const due = months.filter((m) => !m.claimed && big(m.claimable) > 0n && time(m.openableAt) <= now);
  const total = due.reduce((s, m) => s + big(m.claimable), 0n);

  async function claim() {
    const list = due.map((m) => BigInt(m.month));
    await tx.run("Claim rewards", async ({ send }) => {
      await send({ address: sink, abi: cashbackAbi, functionName: "claim", args: [list] });
      return `${orry(total)} ORRY went to your wallet.`;
    });
  }
  async function open(month: number) {
    await tx.run("Open month", async ({ send }) => {
      await send({ address: sink, abi: cashbackAbi, functionName: "openPeriod", args: [BigInt(month)] });
      return "Month opened. Its rewards can be claimed now.";
    });
  }

  return (
    <section className="rc-desk" aria-label="Monthly rewards">
      <div className="rc-desk-body">
        <h2 className="cm-desk-title">Monthly rewards</h2>
        {!address ? (
          connected ? (
            <p className="rc-muted">…</p>
          ) : (
            <div className="rc-connect">
              <p>Rewards are charted for a connected wallet.</p>
              <WalletButton />
            </div>
          )
        ) : loading ? (
          <p className="rc-muted">…</p>
        ) : months.length === 0 ? (
          <p className="rc-muted">Each month is charted here as soon as a fee earns this wallet a reward.</p>
        ) : (
          <ul className="rc-claims">
            {months.map((m) => {
              const opens = time(m.openableAt);
              const claimable = big(m.claimable);
              const state = m.claimed
                ? "Claimed"
                : opens > now
                  ? `Opens ${day(opens)}`
                  : claimable > 0n
                    ? `${orry(claimable)} ORRY to claim`
                    : null;
              return (
                <li key={m.month}>
                  <div>
                    <strong>{m.label}</strong>
                    <span>{usd(big(m.owedUsd))} accrued</span>
                  </div>
                  {state ? (
                    <span className="cm-state">{state}</span>
                  ) : (
                    <button className="secondary" type="button" disabled={!ready || Boolean(tx.busy)} onClick={() => void open(m.month)}>
                      Open month
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {address && months.length > 0 ? (
          <div className="rc-claim">
            <div>
              <p className="rc-claim-label">Claimable now</p>
              <p className="rc-claim-value">{orry(total)} ORRY</p>
            </div>
            <button className="primary" type="button" disabled={!ready || Boolean(tx.busy) || due.length === 0} onClick={() => void claim()}>
              {tx.busy === "Claim rewards" ? "Claiming…" : "Claim"}
            </button>
          </div>
        ) : null}
        <NoticeLine notice={tx.notice} />
      </div>
    </section>
  );
}

function Records({ address, data, loading }: { address?: Address; data?: { records: { feeUsd: string; rewardUsd: string; feePaidAt: string; kind: number }[] }; loading: boolean }) {
  const rows = data?.records ?? [];
  return (
    <section className="rc-panel" aria-label="Reward ledger">
      <div className="rc-panel-head">
        <h2>Reward ledger</h2>
        <p>One row per Orrery fee, with the reward it brought this wallet, whether as cashback on its own fees or as the referrer.</p>
      </div>
      {!address ? (
        <p className="rc-muted">The ledger fills in for a connected wallet.</p>
      ) : loading ? (
        <p className="rc-muted">…</p>
      ) : rows.length === 0 ? (
        <p className="rc-muted">Rows are added as the underlying fees are paid.</p>
      ) : (
        <table className="rc-table">
          <thead>
            <tr>
              <th scope="col">Paid</th>
              <th scope="col">From</th>
              <th scope="col" className="num">Fee</th>
              <th scope="col" className="num">Reward</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.feePaidAt}-${i}`}>
                <td className="mono">{utc(time(r.feePaidAt))}</td>
                <td>{r.kind === ACCRUAL_KINDS.referral ? "Referral" : "Cashback"}</td>
                <td className="num mono">{usd(big(r.feeUsd))}</td>
                <td className="num mono">{usd(big(r.rewardUsd))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Board() {
  const { address } = useWallet();
  const q = useReferralBoard(true);
  const rows = q.data?.rows ?? [];
  const hasTier = rows.some((r) => r.tier);
  return (
    <section className="rc-panel rc-board" aria-label="Referral leaderboard">
      <div className="rc-panel-head">
        <h2>Top referrers</h2>
        <p>Sorted by referred volume in USD. Each address is shortened to its first and last characters.</p>
      </div>
      {q.isLoading ? (
        <p className="rc-muted">…</p>
      ) : rows.length === 0 ? (
        <p className="rc-muted">{q.isError ? "Rankings load in a moment." : "Referrers are ranked here once their referred wallets pay fees."}</p>
      ) : (
        <table className="rc-table">
          <thead>
            <tr>
              <th scope="col" className="rank">Rank</th>
              <th scope="col">Address</th>
              <th scope="col" className="num">Referees</th>
              <th scope="col" className="num">Referred volume</th>
              {hasTier ? <th scope="col">Tier</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.rank}-${r.address}`} className={r.rank <= 3 ? "is-top" : undefined}>
                <td className="rank mono">{r.rank}</td>
                <td className="mono">{sameAddr(r.address, address) ? "You" : mask(r.address)}</td>
                <td className="num mono" data-label="Referees">
                  {r.referees.toLocaleString("en-US")}
                </td>
                <td className="num mono" data-label="Referred volume">
                  {usd(big(r.volumeUsd))}
                </td>
                {hasTier ? <td data-label="Tier">{r.tier ?? ""}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
