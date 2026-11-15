"use client";

import Link from "next/link";
import { useReleases } from "@/lib/orry/releases";
import { AgentStakePanel } from "./AgentStake";
import { ComingSoon } from "./parts";
import { OrryCheckout } from "./OrryCheckout";

/** Credits page slot: ORRY checkout when open, the held state otherwise. */
export function OrryCheckoutSlot({ packSize, creditsPerCheck }: { packSize?: number; creditsPerCheck?: number }) {
  const { ready, isLive } = useReleases();
  if (!ready) return null;
  if (isLive("checkout")) return <OrryCheckout packSize={packSize} creditsPerCheck={creditsPerCheck} />;
  return <ComingSoon title="Pay for checks and verification with ORRY." text="ORRY checkout appears here when it opens. ORRY used here is burned." />;
}

/** Operator page slot: the agent stake panel for the agent in view. */
export function AgentStakeSlot({ agentId }: { agentId: bigint }) {
  const { ready, isLive } = useReleases();
  if (!ready) return null;
  if (isLive("agent-stake")) return <AgentStakePanel agentId={agentId} />;
  // Held: the stake form waits, but an existing stake behind this agent keeps its unstake and withdraw.
  return (
    <>
      <ComingSoon title="Stake ORRY behind this agent." text="Merchants will see the amount in every check. Agent stake appears here when staking opens." />
      <AgentStakePanel agentId={agentId} exitOnly />
    </>
  );
}

/** Operator page: pay the verification in ORRY on the credits page. */
export function VerifyWithOrryLink({ agentId }: { agentId: bigint }) {
  const { isLive } = useReleases();
  if (!isLive("checkout")) return null;
  return (
    <Link className="secondary" href={`/credits?agent=${agentId.toString()}#orry`}>
      Pay verification in ORRY
    </Link>
  );
}

/** Claims guide: the pay-as-you-go line, shown once single checks paid in ORRY are open. */
export function PaygDocs() {
  const { isLive } = useReleases();
  if (!isLive("payg-checks") || !isLive("checkout")) return null;
  return (
    <p>
      Single checks work the same way: ask for a quote with <code>{"{ buyer, checks }"}</code> and send it with <code>burnForCredits</code>, where{" "}
      <code>packs</code> is the number of checks. Each check is priced at the same 625 credits per 1 USD of ORRY, and its credits reach your
      address once the payment confirms.
    </p>
  );
}

/** Docs index: links to the ORRY guides that are open. */
export function OrryDocsLinks() {
  const { isLive } = useReleases();
  const guides = [
    { href: "/docs/earn", label: "Earn", text: "Deposits, zaps, fee streams and withdrawals.", open: isLive("earn") },
    { href: "/docs/stake", label: "Stake", text: "Rewards from Orrery's revenue, unstaking, and stake behind an agent.", open: isLive("stake") },
    { href: "/docs/claims", label: "Claims and burns", text: "Claim all, Distribute, burns, the leaderboard and ORRY checkout.", open: isLive("claim") },
  ].filter((g) => g.open);
  if (guides.length === 0) return null;
  return (
    <>
      <h2>ORRY</h2>
      <table>
        <tbody>
          {guides.map((g) => (
            <tr key={g.href}>
              <td><Link href={g.href}>{g.label}</Link></td>
              <td>{g.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
