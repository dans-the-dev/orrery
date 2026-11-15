import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { CreditShell } from "@/components/credit/shell";
import { CreditExits, CreditView } from "@/components/credit/CreditView";

export const metadata = { title: "Orrery · Credit", description: "Supply USDG to verified agents. An ORRY bond stands behind each line, and the agent's x402 income pays it back before anything else." };

export default function CreditPage() {
  return (
    <CreditShell>
      <FeatureGate
        feature="credit"
        held={
          <>
            <OrryHead title="Fund agents with income on record." lead={<p>A single USDG pool. ORRY bonds stand behind every line, and each agent&apos;s x402 income repays it first.</p>} />
            <ComingSoon title="Credit starts soon." text="The pool, its terms and your own position show here once Credit starts." />
            <CreditExits />
          </>
        }
      >
        <CreditView />
      </FeatureGate>
    </CreditShell>
  );
}
