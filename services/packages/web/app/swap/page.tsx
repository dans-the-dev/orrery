import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { MarketsShell } from "@/components/markets/shell";
import { SwapView } from "@/components/markets/views";
import { FeatureGate } from "@/components/orry/gate";

export const metadata = { title: "Orrery · Private Swap", description: "Trade stock tokens for USDG while the order stays sealed, then clear at the Chainlink price with the batch." };

export default function SwapPage() {
  return (
    <MarketsShell>
      <FeatureGate
        feature="swap"
        held={
        <>
          <OrryHead title="Swap stock tokens out of sight." lead={<p>The size of your order stays hidden until the batch closes, and the whole batch settles at a single Chainlink price.</p>} />
          <ComingSoon title="Private Swap starts soon." text="The swap ticket and your sealed orders show here once Private Swap starts." />
        </>
        }
      >
        <Suspense>
          <SwapView />
        </Suspense>
      </FeatureGate>
    </MarketsShell>
  );
}
