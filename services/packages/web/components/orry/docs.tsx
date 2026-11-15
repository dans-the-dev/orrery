"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useReadContract } from "wagmi";
import { iOrryRewardsRouterAbi } from "@orrery/shared";
import { useOrryConstants } from "@/lib/orry/chain";
import { COMING_SOON, ORRY } from "@/lib/orry/config";
import { useReleases } from "@/lib/orry/releases";
import { every, period } from "@/lib/orry/format";

const DOCS = [
  { href: "/docs/earn", label: "Earn", feature: "earn" as const },
  { href: "/docs/stake", label: "Stake", feature: "stake" as const },
  { href: "/docs/claims", label: "Claims and burns", feature: "claim" as const },
  { href: "/docs/merchants", label: "Merchants", feature: "facilitator" as const },
];

export function DocsTabs() {
  const path = usePathname();
  const releases = useReleases();
  const isLive = (f: (typeof DOCS)[number]["feature"]) => !releases.ready || releases.isLive(f);
  return (
    <nav className="rc-tabs" aria-label="ORRY guides">
      <Link href="/docs">Docs</Link>
      {DOCS.map((d) => (
        <Link key={d.href} href={d.href} aria-current={path === d.href ? "page" : undefined} className={isLive(d.feature) ? undefined : "is-held"}>
          {d.label}
          {isLive(d.feature) ? null : <small>{COMING_SOON}</small>}
        </Link>
      ))}
    </nav>
  );
}

type Name = "depositLock" | "earnStream" | "plainCooldown" | "agentCooldown" | "stakeStream" | "distributeInterval";
const FALLBACK: Record<Name, string> = {
  depositLock: "the deposit lock",
  earnStream: "the stream period",
  plainCooldown: "the unstake cooldown",
  agentCooldown: "the agent cooldown",
  stakeStream: "the stream period",
  distributeInterval: "the distribute interval",
};

/** A period set in a contract constructor, read from the chain and written out in words. */
export function Period({ name }: { name: Name }) {
  const c = useOrryConstants();
  const v = c[name];
  return <>{v ? period(v) : FALLBACK[name]}</>;
}

/** "once an hour" style wording of the distribute interval, read from the chain. */
export function DistributeEvery() {
  const c = useOrryConstants();
  return <>{c.distributeInterval ? every(c.distributeInterval) : "once per interval"}</>;
}

/** The router's staker share, read from the chain. */
export function StakersShare() {
  const { data } = useReadContract({ address: ORRY.router, abi: iOrryRewardsRouterAbi, functionName: "STAKERS_BPS", query: { enabled: Boolean(ORRY.router), staleTime: Infinity } });
  return <>{data !== undefined ? `${Number(data) / 100}%` : "the stakers' share"}</>;
}
