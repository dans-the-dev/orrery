import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { MarketsShell } from "@/components/markets/shell";
import { DarkPoolView } from "@/components/markets/views";
import { FeatureGate } from "@/components/orry/gate";

export const metadata = { title: "Orrery · Dark Pool", description: "Stock token limit orders kept sealed, then matched against each other at the Chainlink price as every batch clears." };

export default function DarkPoolPage() {
  return (
    <MarketsShell>
      <FeatureGate
        feature="darkpool"
        held={
        <>
          <OrryHead title="Size moves quietly, at one price." lead={<p>Limit orders stay sealed until the batch clears, then match each other at the Chainlink price.</p>} />
          <ComingSoon title="Dark Pool starts soon." text="Order entry, the batch timer, the revealed book and your past orders show here once the Dark Pool starts." />
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
