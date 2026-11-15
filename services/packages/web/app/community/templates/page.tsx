import { PageGuide } from "@/components/PageGuide";
import { TemplatesView } from "@/components/community/TemplatesView";
import { CommunityGate } from "@/components/community/shell";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Templates", description: "Ready-made agent policies, written by operators and bought with ORRY." };

export default function TemplatesPage() {
  return (
    <>
      <CommunityGate
        feature="template-market"
        held={
          <>
            <OrryHead title="Orbits other operators have plotted." lead={<p>Agent policy templates with a USD price, paid for in ORRY.</p>} />
            <ComingSoon title="The template market starts soon." text="Templates for sale, their prices and the form to list your own show here once the market starts." />
          </>
        }
      >
        <TemplatesView />
      </CommunityGate>
      <PageGuide
        audience={"Operators looking for a proven policy, and operators with one worth selling."}
        steps={[
          { title: "List", text: "Pick a USD price, paste the policy JSON and point to where the file is hosted. The listing records the file's hash." },
          { title: "Buy", text: "Pay in ORRY. One part is burned, the remainder goes to the author, and your wallet keeps the licence." },
          { title: "Apply", text: "Compare the file with its recorded hash, then set it as your agent's policy." },
        ]}
      />
    </>
  );
}
