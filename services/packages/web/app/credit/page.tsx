import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { CreditShell } from "@/components/credit/shell";
import { CreditExits, CreditView } from "@/components/credit/CreditView";

export const metadata = { title: "Orrery · Credit", description: "Lend USDG to verified agents. Each line is backed by an ORRY bond and repaid first from the agent's x402 revenue." };

export default function CreditPage() {
  return (
    <CreditShell>
      <FeatureGate
        feature="credit"
        held={
          <>
            <OrryHead title="Lend USDG to agents that earn." lead={<p>One pool of USDG, lines backed by ORRY bonds, repaid first from each agent&apos;s x402 revenue.</p>} />
            <ComingSoon title="Credit opens soon." text="The pool, its terms and your position appear here when Credit opens." />
            <CreditExits />
          </>
        }
      >
        <CreditView />
      </FeatureGate>
    </CreditShell>
  );
}
