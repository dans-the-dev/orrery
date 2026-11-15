import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { CreditShell } from "@/components/credit/shell";
import { AttesterExits, AttestersView } from "@/components/credit/AttestersView";

export const metadata = { title: "Orrery · Attesters", description: "Stake ORRY to probe agents and sign their results on Orrery's record, and share the verification fees." };

export default function AttestersPage() {
  return (
    <CreditShell>
      <FeatureGate
        feature="attesters"
        held={
          <>
            <OrryHead title="Sign agent results on Orrery's record." lead={<p>Stake ORRY, probe agents each week, share the verification fees.</p>} />
            <ComingSoon title="Attesters open soon." text="This week's set, the fee pool and your stake appear here when attesters open." />
            <AttesterExits />
          </>
        }
      >
        <AttestersView />
      </FeatureGate>
    </CreditShell>
  );
}
