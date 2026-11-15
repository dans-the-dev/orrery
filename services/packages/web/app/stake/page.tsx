import { PageGuide } from "@/components/PageGuide";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { StakeView } from "@/components/orry/StakeView";
import { OrryShell } from "@/components/orry/shell";

export const metadata = { title: "Orrery · Stake", description: "Stake ORRY and receive ETH and ORRY from Orrery's own revenue." };

export default function StakePage() {
  return (
    <OrryShell>
      <FeatureGate
        feature="stake"
        held={
        <>
          <OrryHead title="Stake ORRY, share Orrery's revenue." lead={<p>Stakers receive ETH and ORRY from Orrery&apos;s own revenue.</p>} />
          <ComingSoon title="Staking opens soon." text="New stakes and stake behind an agent appear on this page when staking opens." />
          <StakeView exitOnly />
        </>
        }
      >
        <StakeView />
      </FeatureGate>
      <PageGuide
        audience={"ORRY holders who want a share of Orrery's revenue."}
        steps={[
          { title: "Stake ORRY", text: "Your stake starts earning from the next reward that arrives." },
          { title: "Receive rewards", text: "ETH and ORRY from pool fees and from ORRY bought with product revenue stream to every active stake over 7 days." },
          { title: "Leave when you want", text: "Request unstake, then withdraw 7 days later. Stake behind an agent waits 14 days and shows in that agent's checks." },
        ]}
      />
    </OrryShell>
  );
}
