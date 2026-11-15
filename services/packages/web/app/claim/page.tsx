import { PageGuide } from "@/components/PageGuide";
import { ClaimView } from "@/components/orry/ClaimView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { OrryShell } from "@/components/orry/shell";

export const metadata = { title: "Orrery · Claim", description: "Collect Earn fees and stake rewards together, in a single transaction." };

export default function ClaimPage() {
  return (
    <OrryShell>
      <FeatureGate
        feature="claim"
        held={
        <>
          <OrryHead title="All your rewards, on one chart." lead={<p>Earn fees and stake rewards gather on this page, and one claim takes them all.</p>} />
          <ComingSoon title="The claim center starts soon." text="Distribute and your claim totals show here once the claim center starts." />
          <ClaimView exitOnly />
        </>
        }
      >
        <ClaimView />
      </FeatureGate>
      <PageGuide
        audience={"Anyone holding an Earn position or a stake."}
        steps={[
          { title: "See what you are owed", text: "A single list of Earn fees and stake rewards, in ETH and ORRY." },
          { title: "Claim together or apart", text: "One transaction collects every reward, or you can take each one separately." },
          { title: "Run Distribute", text: "Open to anyone, at most once per hour. It sends half the rewards router balance to stakers and burns the other half." },
        ]}
      />
    </OrryShell>
  );
}
