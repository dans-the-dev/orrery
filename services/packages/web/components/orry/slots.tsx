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
  return <ComingSoon title="Checks and verification, paid in ORRY." text="ORRY checkout is added to this page once it begins. Every ORRY spent on it is burned." />;
}

/** Operator page slot: the agent stake panel for the agent in view. */
export function AgentStakeSlot({ agentId }: { agentId: bigint }) {
  const { ready, isLive } = useReleases();
  if (!ready) return null;
  if (isLive("agent-stake")) return <AgentStakePanel agentId={agentId} />;
  // Held: the stake form waits, but an existing stake behind this agent keeps its unstake and withdraw.
  return (
    <>
      <ComingSoon title="Put ORRY stake on this agent." text="Merchants see that stake in each check of the agent. The form is added here once agent stake begins." />
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
      Verify in ORRY
    </Link>
  );
}

/** Claims guide: the pay-as-you-go line, shown once single checks paid in ORRY are open. */
export function PaygDocs() {
  const { isLive } = useReleases();
  if (!isLive("payg-checks") || !isLive("checkout")) return null;
  return (
    <p>
      Buying single checks follows the same path. Request a quote with <code>{"{ buyer, checks }"}</code>, then submit it through <code>burnForCredits</code> with{" "}
      <code>packs</code> set to the number of checks. Pricing stays at 625 credits per 1 USD of ORRY, and the credits are added to your
      address when the block confirms.
    </p>
  );
}

/** Docs index: links to the ORRY guides that are open. */
export function OrryDocsLinks() {
  const { isLive } = useReleases();
  const guides = [
    { href: "/docs/earn", label: "Earn", text: "How deposits, zaps, streamed fees and withdrawals work.", open: isLive("earn") },
    { href: "/docs/stake", label: "Stake", text: "Revenue rewards, the unstake path and stake placed on an agent.", open: isLive("stake") },
    { href: "/docs/claims", label: "Claims and burns", text: "Collecting everything at once, distribution, burns, rankings and the ORRY checkout.", open: isLive("claim") },
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
