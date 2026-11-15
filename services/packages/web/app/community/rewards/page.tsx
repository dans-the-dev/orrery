import { PageGuide } from "@/components/PageGuide";
import { RewardsView } from "@/components/community/RewardsView";
import { CommunityGate } from "@/components/community/shell";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Rewards", description: "The community Reward Pool, its events, the Achievement Board and this week's busiest wallets." };

export default function RewardsPage() {
  return (
    <>
      <CommunityGate
        feature="achievements"
        held={
          <>
            <OrryHead title="What the community pool pays out." lead={<p>Fees from chat and usernames, plus a cut of each tip, flow into the Reward Pool, and the pool funds every community reward.</p>} />
            <ComingSoon title="Rewards start soon." text="Pool balances, its events and the Achievement Board show here once rewards start." />
          </>
        }
      >
        <RewardsView />
      </CommunityGate>
      <PageGuide
        audience={"Orrery users who take part in its community."}
        steps={[
          { title: "Earn an achievement", text: "Every wallet that reaches one gets the same reward, paid in the order the wallets reach it." },
          { title: "Place in an event", text: "The winners list goes up first for anyone to check, and then each winner collects the prize." },
          { title: "Claim", text: "The pool pays straight into your wallet." },
        ]}
      />
    </>
  );
}
