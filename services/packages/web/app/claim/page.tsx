import { PageGuide } from "@/components/PageGuide";
import { ClaimView } from "@/components/orry/ClaimView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { OrryShell } from "@/components/orry/shell";

export const metadata = { title: "Orrery · Claim", description: "Claim Earn fees and stake rewards in one transaction." };

export default function ClaimPage() {
  return (
    <OrryShell>
      <FeatureGate
        feature="claim"
        held={
        <>
          <OrryHead title="Every reward in one place." lead={<p>Earn fees and stake rewards collect here, ready to claim together.</p>} />
          <ComingSoon title="The claim center opens soon." text="Distribute and the claim totals appear on this page when the claim center opens." />
          <ClaimView exitOnly />
        </>
        }
      >
        <ClaimView />
      </FeatureGate>
      <PageGuide
        audience={"Everyone with an Earn position or a stake."}
        steps={[
          { title: "See what is owed", text: "Earn fees and stake rewards, in ETH and ORRY, in one list." },
          { title: "Claim all at once", text: "One transaction pays every reward you have, or claim each one on its own." },
          { title: "Run Distribute", text: "Anyone can run it once an hour: half of what the rewards router holds goes to stakers, the other half is burned." },
        ]}
      />
    </OrryShell>
  );
}
