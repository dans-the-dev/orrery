import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { R2Shell } from "@/components/r2/shell";
import { GasExits, GasView } from "@/components/r2/GasView";

export const metadata = { title: "Orrery · Gas in ORRY", description: "Prepay ORRY for a smart account and its ERC-4337 operations are paid from it at the USD price of gas." };

export default function GasPage() {
  return (
    <R2Shell>
      <FeatureGate
        feature="paymaster"
        held={
          <>
            <OrryHead title="Pay your agents' gas in ORRY." lead={<p>Prepaid ORRY covers a smart account&apos;s operations at the USD price of gas.</p>} />
            <ComingSoon title="Gas in ORRY opens soon." text="Funding, balances and the paymaster address appear here when it opens." />
            <GasExits />
          </>
        }
      >
        <GasView />
      </FeatureGate>
    </R2Shell>
  );
}
