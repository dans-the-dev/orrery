import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { MarketsShell } from "@/components/markets/shell";
import { AssetView } from "@/components/markets/views";
import { FeatureGate } from "@/components/orry/gate";

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const s = decodeURIComponent(symbol).toUpperCase();
  return { title: `Orrery · ${s}`, description: `Buy or sell ${s} for USDG in a sealed batch at the Chainlink price.` };
}

export default async function StockPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const s = decodeURIComponent(symbol);
  return (
    <MarketsShell>
      <FeatureGate
        feature="stocks"
        held={
        <>
          <OrryHead title={s.toUpperCase()} />
          <ComingSoon title="Stocks open soon." text="Each stock's price, your holdings and its order form appear here when Stocks opens." />
        </>
        }
      >
        <Suspense>
          <AssetView symbol={s} />
        </Suspense>
      </FeatureGate>
    </MarketsShell>
  );
}
