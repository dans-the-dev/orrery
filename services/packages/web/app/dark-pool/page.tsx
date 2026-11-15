import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { MarketsShell } from "@/components/markets/shell";
import { DarkPoolView } from "@/components/markets/views";
import { FeatureGate } from "@/components/orry/gate";

export const metadata = { title: "Orrery · Dark Pool", description: "Sealed limit orders for stock tokens, crossed with other orders at the Chainlink price in each batch." };

export default function DarkPoolPage() {
  return (
    <MarketsShell>
      <FeatureGate
        feature="darkpool"
        held={
        <>
          <OrryHead title="Large orders, crossed at one price." lead={<p>Sealed limit orders meet other orders at the Chainlink price when each batch clears.</p>} />
          <ComingSoon title="Dark Pool opens soon." text="Limit orders, the batch clock, the revealed book and your history appear here when the Dark Pool opens." />
        </>
        }
      >
        <Suspense>
          <DarkPoolView />
        </Suspense>
      </FeatureGate>
    </MarketsShell>
  );
}
