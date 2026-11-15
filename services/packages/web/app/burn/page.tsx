import { PageGuide } from "@/components/PageGuide";
import { BurnView } from "@/components/orry/BurnView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { OrryShell } from "@/components/orry/shell";

export const metadata = { title: "Orrery · Burn", description: "Each ORRY burn on record, grouped by source and linked to its transaction." };

export default function BurnPage() {
  return (
    <OrryShell>
      <FeatureGate
        feature="burn"
        held={
        <>
          <OrryHead title="Every burn, traced to its source." lead={<p>ORRY spent on checks and verifications is burned, along with the burn share of protocol fees.</p>} />
          <ComingSoon title="The burn record starts soon." text="Each burn, grouped by source and linked to its transaction, shows here once the record starts." />
        </>
        }
      >
        <BurnView />
      </FeatureGate>
      <PageGuide
        audience={"Anyone following the ORRY supply."}
        steps={[
          { title: "Product use", text: "When a credit pack or agent verification is paid in ORRY, that ORRY burns inside the same transaction." },
          { title: "Each Distribute", text: "Every run burns half of the protocol's cut of pool fees and half of the ORRY bought with revenue." },
          { title: "Check the total", text: "Each row points to its transaction, so anyone can add up the total on chain." },
        ]}
      />
    </OrryShell>
  );
}
