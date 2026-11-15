import { DocsShell } from "@/components/orry/docsShell";
import { DistributeEvery, Period, StakersShare } from "@/components/orry/docs";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon } from "@/components/orry/parts";
import { PaygDocs } from "@/components/orry/slots";

export const metadata = { title: "Orrery · Claims guide", description: "Claim all, Distribute, burns, the leaderboard and ORRY checkout." };

export default function ClaimsDocs() {
  return (
    <DocsShell kicker="Guide" title="Claims and burns" lead={<p>Every reward in one place, and where burned ORRY comes from.</p>}>
      <FeatureGate
        feature="claim"
        held={
        <ComingSoon title="The claims guide opens with the claim center." text="This guide appears here when the claim center opens." />
        }
      >
        <>
          <h2>Claim all</h2>
          <p>
            The claim center lists your Earn fees from every pool, your stake rewards and every withdrawal that is ready or on its way.{" "}
            <strong>Claim all</strong> sends one transaction to <code>ClaimAll.claimAll()</code>, which calls <code>claimFor(you)</code> on staking and
            on every Earn vault, and pays each asset once: ORRY, ETH, then each pool&apos;s other token. Each of those calls pays only the address it
            names. Single buttons for each claim sit next to it.
          </p>

          <h2>Distribute</h2>
          <p>
            The rewards router collects the protocol part of the ORRY pools&apos; fees and the ORRY bought with Orrery&apos;s USDG revenue.{" "}
            <code>distribute()</code> sends <StakersShare /> of each asset to stakers, where it streams over <Period name="stakeStream" />, and burns
            the rest: ORRY directly, ETH after buying ORRY in the pool. Anyone can run it <DistributeEvery />.
          </p>

          <h2>Burns</h2>
          <table>
            <tbody>
              <tr><td>Protocol fees, ORRY share</td><td>ORRY the router burns on Distribute.</td></tr>
              <tr><td>Credit packs paid in ORRY</td><td>ORRY paid at checkout for credit packs, burned in the same transaction.</td></tr>
              <tr><td>Verifications paid in ORRY</td><td>ORRY paid for an agent verification, burned in the same transaction.</td></tr>
              <tr><td>Protocol fees, ETH share</td><td>ETH from the router buys ORRY in the pool, and all of it is burned.</td></tr>
            </tbody>
          </table>

          <h2>Leaderboard</h2>
          <p>
            Top stakers rank by ORRY staked, plain and behind agents. Top earners rank by everything earned from Earn and Stake, claimed and still
            pending, per asset, valued in ORRY at each pool&apos;s price. Addresses show their first six and last four characters.
          </p>

          <h2>Pay with ORRY</h2>
          <p>
            625 credits per 1 USD of ORRY, against 500 per USDG. ORRY used here is burned. The credits page asks the API for a signed quote priced from the ORRY pool, then
            your wallet sends <code>burnForCredits(packs, orryAmount, quoteId, expiry, sig)</code> or{" "}
            <code>verifyWithOrry(agentId, expectedOwner, orryAmount, quoteId, expiry, sig)</code> to the treasury. Each quote works once and only
            before its expiry.
          </p>
          <PaygDocs />
        </>
      </FeatureGate>
    </DocsShell>
  );
}
