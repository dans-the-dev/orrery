import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { MarketsShell } from "@/components/markets/shell";
import { StocksView } from "@/components/markets/views";
import { FeatureGate } from "@/components/orry/gate";

export const metadata = { title: "Orrery · Stocks", description: "Stock tokens on Robinhood Chain with live Chainlink prices, traded against USDG in sealed batches." };

export default function StocksPage() {
  return (
    <MarketsShell>
      <FeatureGate
        feature="stocks"
        held={
        <>
          <OrryHead title="Stock tokens on Robinhood Chain." lead={<p>Live Chainlink prices, your holdings, and a sealed order for any listed stock.</p>} />
          <ComingSoon title="Stocks open soon." text="The stock list, prices and the trade page for each stock appear here when Stocks opens." />
        </>
        }
      >
        <Suspense>
          <StocksView />
        </Suspense>
      </FeatureGate>
    </MarketsShell>
  );
}
