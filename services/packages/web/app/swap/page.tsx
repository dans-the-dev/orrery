import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { MarketsShell } from "@/components/markets/shell";
import { SwapView } from "@/components/markets/views";
import { FeatureGate } from "@/components/orry/gate";

export const metadata = { title: "Orrery · Private Swap", description: "Swap stock tokens for USDG with the order sealed until the batch clears at the Chainlink price." };

export default function SwapPage() {
  return (
    <MarketsShell>
      <FeatureGate
        feature="swap"
        held={
        <>
          <OrryHead title="Swap stock tokens with your order sealed." lead={<p>Nobody sees the amount before the batch closes. It then settles at one Chainlink price.</p>} />
          <ComingSoon title="Private Swap opens soon." text="The swap form and your sealed orders appear here when Private Swap opens." />
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
