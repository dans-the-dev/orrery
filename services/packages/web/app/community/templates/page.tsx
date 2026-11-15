import { PageGuide } from "@/components/PageGuide";
import { TemplatesView } from "@/components/community/TemplatesView";
import { CommunityGate } from "@/components/community/shell";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Templates", description: "Policy templates for agent spending limits, written by operators and sold for ORRY." };

export default function TemplatesPage() {
  return (
    <>
      <CommunityGate
        feature="template-market"
        held={
          <>
            <OrryHead title="Spending policies, written by operators." lead={<p>Policy templates for agent spending limits, priced in USD and paid in ORRY.</p>} />
            <ComingSoon title="The template market opens soon." text="Listed templates, their prices and the listing form appear on this page when the market opens." />
          </>
        }
      >
        <TemplatesView />
      </CommunityGate>
      <PageGuide
        audience={"Operators who want a tested policy, and operators who write good ones."}
        steps={[
          { title: "List", text: "Set a USD price, paste the policy JSON and give the address where the file lives. Its hash is recorded with the listing." },
          { title: "Buy", text: "Pay the price in ORRY. Part of it is burned and the rest goes to the creator, and the licence stays with your wallet." },
          { title: "Apply", text: "Check the file against its hash, then use it as the policy of your agent." },
        ]}
      />
    </>
  );
}
