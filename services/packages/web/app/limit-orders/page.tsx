import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { R2Shell } from "@/components/r2/shell";
import { LimitExits, LimitOrdersView } from "@/components/r2/LimitOrdersView";

export const metadata = { title: "Orrery · Limit orders", description: "Signed limit orders for stock tokens, filled through the token's pool once it reaches your price." };

export default function LimitOrdersPage() {
  return (
    <R2Shell>
      <FeatureGate
        feature="limit-orders"
        held={
          <>
            <OrryHead title="Name your price." lead={<p>Signed buy and sell orders for stock tokens, filled when the pool reaches your price.</p>} />
            <ComingSoon title="Limit orders open soon." text="The order desk and your orders appear here when limit orders open." />
            <LimitExits />
          </>
        }
      >
        <Suspense>
          <LimitOrdersView />
        </Suspense>
      </FeatureGate>
    </R2Shell>
  );
}
