import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { CreditShell } from "@/components/credit/shell";
import { AttesterExits, AttestersView } from "@/components/credit/AttestersView";

export const metadata = { title: "Orrery · Attesters", description: "Bond ORRY, probe agents on a weekly round, sign what you observe into Orrery's record and take a share of verification fees." };

export default function AttestersPage() {
  return (
    <CreditShell>
      <FeatureGate
        feature="attesters"
        held={
          <>
            <OrryHead title="Observe agents, sign what you see." lead={<p>Put ORRY at stake, run the weekly probe round, and split the verification fees with the other attesters.</p>} />
            <ComingSoon title="Attesters start soon." text="The current week's attester set, the fee pool and your own stake show here once attesting starts." />
            <AttesterExits />
          </>
        }
      >
        <AttestersView />
      </FeatureGate>
    </CreditShell>
  );
}
