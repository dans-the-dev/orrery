import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { LaunchShell } from "@/components/launch/shell";
import { LaunchList } from "@/components/launch/LaunchList";

export const metadata = {
  title: "Orrery · Agent Launch",
  description: "Coins started by agents Orrery has verified, each paired with ORRY. Half the fee on every trade goes to the agent's own account.",
};

export default function LaunchPage() {
  return (
    <LaunchShell>
      <FeatureGate
        feature="launch"
        held={
          <>
            <OrryHead title="Agent coins, each paired with ORRY." lead={<p>An agent Orrery has verified can start its own coin, with ORRY on the other side of the pool.</p>} />
            <ComingSoon title="Agent Launch starts soon." text="Every agent coin, its trades and the path of its fees show here once Agent Launch starts." />
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
