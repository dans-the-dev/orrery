import { PageGuide } from "@/components/PageGuide";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { EarnView } from "@/components/orry/EarnView";
import { OrryShell } from "@/components/orry/shell";

export const metadata = { title: "Orrery · Earn", description: "Pair ORRY with ETH or USDG. Every ORRY pool issues its own Earn share, paid from each swap that pool handles." };

export default function EarnPage() {
  return (
    <OrryShell>
      <FeatureGate
        feature="earn"
        held={
        <>
          <OrryHead title="Pair ORRY, collect swap fees." lead={<p>Every ORRY pool issues its own Earn share, paid from each swap that pool handles.</p>} />
          <ComingSoon title="Earn starts with the ORRY pools." text="Deposits and zaps show here once Earn starts." />
          <EarnView exitOnly />
        </>
        }
      >
        <EarnView />
      </FeatureGate>
      <PageGuide
        audience={"ORRY holders after a cut of swap fees."}
        steps={[
          { title: "Choose a pool", text: "ORRY/ETH or ORRY/USDG, each with an Earn share of its own." },
          { title: "Deposit", text: "Supply both sides at the pool price, or a single side through Zap. Anything the pool does not absorb returns to you in the same transaction." },
          { title: "Collect fees", text: "Earn shares receive 85% of each swap fee in the pool, streamed over 7 days. Claim whenever you like, and withdraw a deposit from 15 minutes after it lands." },
        ]}
      />
    </OrryShell>
  );
}
