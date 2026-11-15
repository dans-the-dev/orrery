import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { R2Shell } from "@/components/r2/shell";
import { GasExits, GasView } from "@/components/r2/GasView";

export const metadata = { title: "Orrery · Gas in ORRY", description: "Top up a smart account with ORRY and its ERC-4337 operations draw on that balance at the USD price of gas." };

export default function GasPage() {
  return (
    <R2Shell>
      <FeatureGate
        feature="paymaster"
        held={
          <>
            <OrryHead title="Agent gas, settled in ORRY." lead={<p>An ORRY balance paid in advance covers each operation a smart account sends, priced at the USD cost of gas.</p>} />
            <ComingSoon title="Gas in ORRY starts soon." text="Top ups, balances and the paymaster address show here once it starts." />
            <GasExits />
          </>
        }
      >
        <GasView />
      </FeatureGate>
    </R2Shell>
  );
}
