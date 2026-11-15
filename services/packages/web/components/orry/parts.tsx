"use client";

/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { motion } from "framer-motion";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { COMING_SOON, EXPLORER_URL, ORRY_ROUTES } from "@/lib/orry/config";
import { useReleases } from "@/lib/orry/releases";
import { WalletButton } from "../WalletButton";
import type { Notice } from "@/lib/orry/chain";
import { FlowStrip, type FlowNode } from "../motion/Flow";

/** Each ORRY page's object and its mechanism, words only. */
const PAGE_ART: Record<string, { art?: string; flow?: { nodes: FlowNode[]; accent: string; label: string } }> = {
  "/earn": { art: "orry-earn", flow: { nodes: ["ORRY paired with ETH or USDG", "Pool", "Swap fees", "Earn share"], accent: "Earn share", label: "A deposit joins the pool, and the pool's swap fees stream to each Earn share" } },
  "/stake": { art: "orry-stake", flow: { nodes: ["ORRY", "Stake", "Fees plus buybacks", "Rewards"], accent: "Rewards", label: "Pool fees and buybacks flow to staked ORRY as rewards" } },
  "/claim": { art: "orry-claim", flow: { nodes: [["Earn fees", "Stake rewards"], "Claim", "Wallet"], accent: "Claim", label: "One claim moves Earn fees and Stake rewards to the wallet together" } },
  "/leaderboard": { art: "orry-leaderboard" },
  "/burn": { art: "orry-burn", flow: { nodes: [["ORRY spent at checkout", "Fee portion set to burn"], "Burned"], accent: "Burned", label: "Checkout ORRY and the burn portion of protocol fees leave supply for good" } },
};

/** Second row of navigation across the ORRY pages. Held pages stay listed, marked "Coming soon". */
export function OrryTabs() {
  const path = usePathname();
  const releases = useReleases();
  return (
    <nav className="rc-tabs" aria-label="ORRY">
      {ORRY_ROUTES.map((r) => {
        const live = !releases.ready || releases.isLive(r.feature);
        const current = path === r.href;
        return (
          <Link key={r.href} href={r.href} aria-current={current ? "page" : undefined} className={live ? undefined : "is-held"}>
            {r.label}
            {live ? null : <small>{COMING_SOON}</small>}
            {current ? <motion.span className="rc-tab-line" layoutId="rc-tab-line" transition={{ type: "spring", stiffness: 380, damping: 34 }} aria-hidden="true" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** Page header: copy on the left, one live reading on the right. */
export function OrryHead({ kicker, title, lead, reading }: { kicker?: string; title: ReactNode; lead?: ReactNode; reading?: ReactNode }) {
  const page = PAGE_ART[usePathname()];
  const art = !reading && page?.art;
  return (
    <>
      <header className={`rc-head${art ? " has-art" : ""}`}>
        <div className="rc-head-copy">
          {kicker ? <p className="kicker">{kicker}</p> : null}
          <h1><span className="rl"><span>{title}</span></span></h1>
          {lead ? <div className="page-head-lead">{lead}</div> : null}
        </div>
        {reading ? <div className="rc-reading">{reading}</div> : null}
        {art ? <img className="rc-head-art" src={`/art/${art}.webp`} alt="" aria-hidden="true" width={600} height={600} /> : null}
      </header>
      {page?.flow ? <FlowStrip className="rc-flow" nodes={page.flow.nodes} accent={page.flow.accent} label={page.flow.label} /> : null}
    </>
  );
}

/** Under a held page: the prompt that lets a wallet reach its position, withdrawals and claims. */
export function ExitConnect({ text }: { text: string }) {
  return (
    <div className="rc-connect rc-exit-connect">
      <p>{text}</p>
      <WalletButton />
    </div>
  );
}

/** The held state, worded the same on every page. */
export function ComingSoon({ title, text }: { title: string; text: string }) {
  return (
    <section className="rc-soon">
      <p className="rc-soon-mark">{COMING_SOON}</p>
      <h2>{title}</h2>
      <p>{text}</p>
    </section>
  );
}

/** Label and value in one hairline row; values in tabular mono. */
export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rc-row">
      <dt>
        {label}
        {hint ? <small>{hint}</small> : null}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Figure with its unit, or an ellipsis while the read is on its way. */
export function Fig({ v, unit }: { v?: string; unit?: string }) {
  if (v === undefined || v === "") return <span className="rc-fig is-wait" aria-label="Loading">…</span>;
  return (
    <span className="rc-fig">
      {v}
      {unit ? <em>{unit}</em> : null}
    </span>
  );
}

export function AmountField({
  label,
  unit,
  value,
  onChange,
  max,
  onMax,
  hint,
  id,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  max?: string;
  onMax?: () => void;
  hint?: ReactNode;
  id: string;
}) {
  return (
    <div className="rc-amount">
      <label htmlFor={id}>{label}</label>
      <div className="rc-amount-box">
        <input id={id} inputMode="decimal" autoComplete="off" placeholder="0.0" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))} />
        <span className="rc-unit">{unit}</span>
      </div>
      <div className="rc-amount-foot">
        <span>{hint}</span>
        {max !== undefined && onMax ? (
          <button type="button" className="rc-max" onClick={onMax}>
            Max {max}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Text tabs for the actions of one desk; underline marks the current one. */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="rc-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Price limit for trades through the pool, in basis points. */
export function SlippagePicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="rc-slip">
      <span>Price limit</span>
      {[50, 100, 200].map((bps) => (
        <button key={bps} type="button" aria-pressed={value === bps} onClick={() => onChange(bps)}>
          {bps / 100}%
        </button>
      ))}
    </div>
  );
}

export function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p className={`rc-notice ${notice.tone}`} role="status" aria-live="polite">
      {notice.text}
    </p>
  );
}

export function TxLink({ hash }: { hash: string }) {
  const short = `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  return EXPLORER_URL ? (
    <a className="mono rc-tx" href={`${EXPLORER_URL}/tx/${hash}`} target="_blank" rel="noreferrer">
      {short}
    </a>
  ) : (
    <span className="mono rc-tx">{short}</span>
  );
}
