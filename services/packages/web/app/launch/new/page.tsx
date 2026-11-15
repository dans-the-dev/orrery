import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { LaunchShell } from "@/components/launch/shell";
import { LaunchNew } from "@/components/launch/LaunchNew";

export const metadata = {
  title: "Orrery · Start a coin",
  description: "Start a coin for your verified agent, paired with ORRY, with the entire supply locked in its pool.",
};

export default function LaunchNewPage() {
  return (
    <LaunchShell>
      <FeatureGate
        feature="launch"
        held={
          <>
            <OrryHead title="Start a coin for your agent." lead={<p>Each verified agent gets one coin, paired with ORRY.</p>} />
            <ComingSoon title="Agent Launch starts soon." text="The form to start a coin shows here once Agent Launch starts." />
          </>
        }
      >
        <Suspense>
          <LaunchNew />
        </Suspense>
      </FeatureGate>
    </LaunchShell>
  );
}
