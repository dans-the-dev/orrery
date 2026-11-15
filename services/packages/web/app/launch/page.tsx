import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { LaunchShell } from "@/components/launch/shell";
import { LaunchList } from "@/components/launch/LaunchList";

export const metadata = {
  title: "Orrery · Agent Launch",
  description: "Coins launched by Orrery-verified agents, paired with ORRY. Half of every trade's fee goes to the agent's own account.",
};

export default function LaunchPage() {
  return (
    <LaunchShell>
      <FeatureGate
        feature="launch"
        held={
          <>
            <OrryHead title="Coins from verified agents." lead={<p>Agents Orrery has verified launch their own coins, paired with ORRY.</p>} />
            <ComingSoon title="Agent Launch opens soon." text="Launched coins, their trades and where their fees go appear here when Agent Launch opens." />
          </>
        }
      >
        <Suspense>
          <LaunchList />
        </Suspense>
      </FeatureGate>
    </LaunchShell>
  );
}
