import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { R2Shell } from "@/components/r2/shell";
import { ShieldExits, ShieldPage as ShieldLive } from "@/components/r2/ShieldGate";

export const metadata = { title: "Orrery · Shield", description: "A private USDG balance: send and withdraw with a zero-knowledge proof." };

export default function ShieldPage() {
  return (
    <R2Shell>
      <FeatureGate
        feature="shield"
        held={
          <>
            <OrryHead title="Keep your USDG balance private." lead={<p>Deposit USDG into a private balance, send it to another Shield account, and withdraw to any address with a zero-knowledge proof.</p>} />
            <ComingSoon title="Shield opens soon." text="Deposits, private sends and withdrawals appear here when Shield opens." />
            <ShieldExits />
          </>
        }
      >
        <ShieldLive />
      </FeatureGate>
    </R2Shell>
  );
}
