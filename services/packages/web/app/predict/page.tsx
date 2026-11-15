import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { R2Shell } from "@/components/r2/shell";
import { PredictExits, PredictView } from "@/components/r2/PredictView";

export const metadata = { title: "Orrery · Predict", description: "Stake USDG on where a stock or ETH price closes, settled by Chainlink at the first price after the close." };

export default function PredictPage() {
  return (
    <R2Shell>
      <FeatureGate
        feature="predict"
        held={
          <>
            <OrryHead title="Call where a price closes." lead={<p>YES or NO on a stock or ETH price at a set time, settled by Chainlink.</p>} />
            <ComingSoon title="Predict opens soon." text="Markets, their pools and your positions appear here when Predict opens." />
            <PredictExits />
          </>
        }
      >
        <Suspense>
          <PredictView />
        </Suspense>
      </FeatureGate>
    </R2Shell>
  );
}
