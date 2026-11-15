import { PageGuide } from "@/components/PageGuide";
import { ReferralsView } from "@/components/community/ReferralsView";
import { CommunityGate } from "@/components/community/shell";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Referrals", description: "Hand out your link, earn ORRY on the fees paid by the people who arrive through it, and collect your cashback." };

export default function ReferralsPage() {
  return (
    <>
      <CommunityGate
        feature={["referrals", "cashback"]}
        held={
          <>
            <OrryHead title="Invite people, earn on what they pay." lead={<p>You earn ORRY on the fees of everyone you refer, and they pay lower fees too.</p>} />
            <ComingSoon title="Referrals start soon." text="Your link, your monthly rewards and the claim show here once referrals start." />
          </>
        }
      >
        <ReferralsView />
      </CommunityGate>
      <PageGuide
        audience={"Anyone who introduces operators, merchants or traders to Orrery."}
        steps={[
          { title: "Hand out your link", text: "A wallet that follows it and links to you remains your referee. That link is recorded once." },
          { title: "Earn month by month", text: "Rewards build up in USD over each calendar month, and open for claiming 30 days after the month closes." },
          { title: "Claim", text: "A single transaction collects every open month, paid out in ORRY." },
        ]}
      />
    </>
  );
}
