import { PageGuide } from "@/components/PageGuide";
import { PassesView } from "@/components/community/PassesView";
import { CommunityGate } from "@/components/community/shell";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Passes", description: "Day and week passes paid in ORRY, for your wallet or as a gift. Every ORRY paid is burned." };

export default function PassesPage() {
  return (
    <>
      <CommunityGate
        feature="passes"
        held={
          <>
            <OrryHead title="Day and week passes, paid in ORRY." lead={<p>Pass time for your wallet or for another one. Every ORRY paid for a pass is burned.</p>} />
            <ComingSoon title="Passes open soon." text="Day and week passes, their live price in ORRY and your pass time appear on this page when passes open." />
          </>
        }
      >
        <PassesView />
      </CommunityGate>
      <PageGuide
        audience={"Wallets that want pass time, and anyone who wants to give it."}
        steps={[
          { title: "Pick a pass", text: "A day pass or a week pass, up to 52 in one purchase." },
          { title: "Choose the wallet", text: "Your own, or any other wallet as a gift." },
          { title: "Pay in ORRY", text: "The price is set in USD and paid in ORRY at the live price. The ORRY is burned." },
        ]}
      />
    </>
  );
}
