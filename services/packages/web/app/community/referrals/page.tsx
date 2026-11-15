import { PageGuide } from "@/components/PageGuide";
import { ReferralsView } from "@/components/community/ReferralsView";
import { CommunityGate } from "@/components/community/shell";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Referrals", description: "Share your link, earn ORRY from the fees of the people you bring, and claim your cashback." };

export default function ReferralsPage() {
  return (
    <>
      <CommunityGate
        feature={["referrals", "cashback"]}
        held={
          <>
            <OrryHead title="Bring people to Orrery, earn from their fees." lead={<p>Referrers earn ORRY from the fees of the people they bring, and those people pay less.</p>} />
            <ComingSoon title="Referrals open soon." text="Your referral link, your rewards by month and the claim appear on this page when referrals open." />
          </>
        }
      >
        <ReferralsView />
      </CommunityGate>
      <PageGuide
        audience={"Anyone who brings operators, merchants or traders to Orrery."}
        steps={[
          { title: "Share your link", text: "A wallet that opens it and links to you stays your referee. The link is set once." },
          { title: "Earn by month", text: "Rewards add up in USD through each calendar month and become claimable 30 days after it ends." },
          { title: "Claim", text: "Every open month is claimed in one transaction, paid in ORRY." },
        ]}
      />
    </>
  );
}
