import { PageGuide } from "@/components/PageGuide";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { EarnView } from "@/components/orry/EarnView";
import { OrryShell } from "@/components/orry/shell";

export const metadata = { title: "Orrery · Earn", description: "Add ORRY with ETH or USDG. Each ORRY pool has its own Earn share, earning from every swap in that pool." };

export default function EarnPage() {
  return (
    <OrryShell>
      <FeatureGate
        feature="earn"
        held={
        <>
          <OrryHead title="Add ORRY with ETH or USDG." lead={<p>Each ORRY pool has its own Earn share, earning from every swap in that pool.</p>} />
          <ComingSoon title="Earn opens with the ORRY pools." text="Deposits and zaps appear on this page when Earn opens." />
          <EarnView exitOnly />
        </>
        }
      >
        <EarnView />
      </FeatureGate>
      <PageGuide
        audience={"ORRY holders who want a share of swap fees."}
        steps={[
          { title: "Pick a pool", text: "ORRY/ETH or ORRY/USDG. Each pool has its own Earn share." },
          { title: "Deposit", text: "Add both sides at the pool price, or one side with Zap. What the pool cannot take comes back in the same transaction." },
          { title: "Collect fees", text: "85% of every swap fee in the pool streams to Earn shares over 7 days. Claim any time; a deposit can be withdrawn 15 minutes after it lands." },
        ]}
      />
    </OrryShell>
  );
}
