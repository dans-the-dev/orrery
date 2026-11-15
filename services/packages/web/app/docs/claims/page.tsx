import { DocsShell } from "@/components/orry/docsShell";
import { DistributeEvery, Period, StakersShare } from "@/components/orry/docs";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon } from "@/components/orry/parts";
import { PaygDocs } from "@/components/orry/slots";

export const metadata = { title: "Orrery · Guide to claims", description: "The guide to Claim all, Distribute, burns, the leaderboard and paying with ORRY." };

export default function ClaimsDocs() {
  return (
    <DocsShell kicker="Guide" title="Claiming and burning" lead={<p>Collecting every reward together, and tracing each burn of ORRY.</p>}>
      <FeatureGate
        feature="claim"
        held={
        <ComingSoon title="The claims guide arrives with the claim center." text="This guide shows here once the claim center starts." />
        }
      >
        <>
          <h2>Claim all</h2>
          <p>
            In the claim center you see Earn fees from each pool, your stake rewards, and every withdrawal that is ready or still on its way.{" "}
            <strong>Claim all</strong> is one transaction to <code>ClaimAll.claimAll()</code>. It calls <code>claimFor(you)</code> on staking and on
            each Earn vault, then pays every asset a single time: ORRY, ETH, and then the other token of each pool. Every one of those calls pays the
            address it names and no other. Separate buttons beside it claim each item alone.
          </p>

          <h2>Distribute</h2>
          <p>
            Into the rewards router go the protocol cut of fees from the ORRY pools and the ORRY bought with Orrery&apos;s USDG revenue.{" "}
            <code>distribute()</code> passes <StakersShare /> of each asset to stakers, streamed over <Period name="stakeStream" />, and burns what
            remains. ORRY burns as it is, and ETH first buys ORRY in the pool. Anyone may run it, <DistributeEvery />.
          </p>

          <h2>Burns</h2>
          <table>
            <tbody>
              <tr><td>Rewards router · ORRY share</td><td>ORRY burned by the router on each Distribute.</td></tr>
              <tr><td>ORRY credit pack purchases</td><td>ORRY spent on credit packs at checkout, burned inside that transaction.</td></tr>
              <tr><td>ORRY agent verifications</td><td>ORRY spent on an agent verification, burned inside that transaction.</td></tr>
              <tr><td>Rewards router · ETH share bought back</td><td>Router ETH buys ORRY in the pool, and every bit of that ORRY is burned.</td></tr>
              <tr><td>Orrery fee on ORRY merchant payments</td><td>The 0.2% Orrery keeps when a merchant payment in ORRY is forwarded, burned on that forward.</td></tr>
            </tbody>
          </table>

          <h2>Leaderboard</h2>
          <p>
            Stakers are ordered by ORRY at stake, counting solo stake and stake behind agents. Earners are ordered by the total from Earn and Stake,
            claimed or not yet claimed, per asset, and valued in ORRY at each pool&apos;s price. Each address shows its first six and last four
            characters.
          </p>

          <h2>Paying with ORRY</h2>
          <p>
            1 USD worth of ORRY buys 625 credits, where 1 USDG buys 500. All ORRY spent this way is burned. The credits page requests a signed quote from
            the API, priced off the ORRY pool, and your wallet then calls the treasury with{" "}
            <code>burnForCredits(packs, orryAmount, quoteId, expiry, sig)</code> or{" "}
            <code>verifyWithOrry(agentId, expectedOwner, orryAmount, quoteId, expiry, sig)</code>. A quote is good for one use, up
            to its expiry.
          </p>
          <PaygDocs />
        </>
      </FeatureGate>
    </DocsShell>
  );
}
