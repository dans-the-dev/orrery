import { PageGuide } from "@/components/PageGuide";
import { BurnView } from "@/components/orry/BurnView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { OrryShell } from "@/components/orry/shell";

export const metadata = { title: "Orrery · Burn", description: "Every ORRY burn, by source, with its transaction." };

export default function BurnPage() {
  return (
    <OrryShell>
      <FeatureGate
        feature="burn"
        held={
        <>
          <OrryHead title="Where burned ORRY comes from." lead={<p>ORRY paid for checks and verifications is burned, and so is the burn share of the protocol&apos;s fees.</p>} />
          <ComingSoon title="The burn record opens soon." text="Every burn, by source and with its transaction, appears on this page when it opens." />
        </>
        }
      >
        <BurnView />
      </FeatureGate>
      <PageGuide
        audience={"Anyone tracking ORRY supply."}
        steps={[
          { title: "Use the product", text: "Credit packs and agent verifications paid in ORRY are burned in the same transaction." },
          { title: "Distribute runs", text: "Half of the protocol's share of pool fees, and half of the ORRY bought with revenue, is burned each run." },
          { title: "Verify it", text: "Every row links to its transaction, so the total can be checked on the chain." },
        ]}
      />
    </OrryShell>
  );
}
