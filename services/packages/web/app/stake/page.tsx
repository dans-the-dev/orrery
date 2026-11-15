import { PageGuide } from "@/components/PageGuide";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { StakeView } from "@/components/orry/StakeView";
import { OrryShell } from "@/components/orry/shell";

export const metadata = { title: "Orrery · Stake", description: "Stake ORRY to receive ETH and ORRY drawn from what Orrery itself earns." };

export default function StakePage() {
  return (
    <OrryShell>
      <FeatureGate
        feature="stake"
        held={
        <>
          <OrryHead title="Stake ORRY, take part in what Orrery earns." lead={<p>Revenue Orrery earns comes back to stakers in ETH and ORRY.</p>} />
          <ComingSoon title="Staking starts soon." text="New stakes, and stake placed behind an agent, show here once staking starts." />
          <StakeView exitOnly />
        </>
        }
      >
        <StakeView />
      </FeatureGate>
      <PageGuide
        audience={"ORRY holders who want part of what Orrery earns."}
        steps={[
          { title: "Stake ORRY", text: "Earning begins with the next reward to arrive after you stake." },
          { title: "Receive rewards", text: "Pool fees and ORRY bought with product revenue reach every active stake in ETH and ORRY, streamed over 7 days." },
          { title: "Step out on your schedule", text: "Ask to unstake, then withdraw 7 days on. Stake placed behind an agent takes 14 days and appears in that agent's readings." },
        ]}
      />
    </OrryShell>
  );
}
