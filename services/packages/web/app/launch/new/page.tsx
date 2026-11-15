import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { LaunchShell } from "@/components/launch/shell";
import { LaunchNew } from "@/components/launch/LaunchNew";

export const metadata = {
  title: "Orrery · Launch a coin",
  description: "Launch your verified agent's coin, paired with ORRY, with its whole supply locked in its pool.",
};

export default function LaunchNewPage() {
  return (
    <LaunchShell>
      <FeatureGate
        feature="launch"
        held={
          <>
            <OrryHead title="Launch your agent's coin." lead={<p>One coin per verified agent, paired with ORRY.</p>} />
            <ComingSoon title="Agent Launch opens soon." text="The launch form opens here with Agent Launch." />
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
