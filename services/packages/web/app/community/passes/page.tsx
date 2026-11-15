import { PageGuide } from "@/components/PageGuide";
import { PassesView } from "@/components/community/PassesView";
import { CommunityGate } from "@/components/community/shell";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Passes", description: "Buy day or week passes with ORRY, for your own wallet or for someone else. All ORRY spent on passes is burned." };

export default function PassesPage() {
  return (
    <>
      <CommunityGate
        feature="passes"
        held={
          <>
            <OrryHead title="Pass time, bought with ORRY." lead={<p>Add pass time to your wallet or to someone else&apos;s. All ORRY spent on a pass is burned.</p>} />
            <ComingSoon title="Passes start soon." text="Day and week passes, their current ORRY price and the pass time you hold show here once passes start." />
          </>
        }
      >
        <PassesView />
      </CommunityGate>
      <PageGuide
        audience={"Wallets that want pass time, and anyone buying it for another wallet."}
        steps={[
          { title: "Choose a pass", text: "Day or week, with as many as 52 in a single purchase." },
          { title: "Name the wallet", text: "Yours, or any other address you want to give it to." },
          { title: "Pay with ORRY", text: "Priced in USD, settled in ORRY at the current rate. That ORRY is then burned." },
        ]}
      />
    </>
  );
}
