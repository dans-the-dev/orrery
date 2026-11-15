import { PageGuide } from "@/components/PageGuide";
import { RewardsView } from "@/components/community/RewardsView";
import { CommunityGate } from "@/components/community/shell";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Rewards", description: "The community Reward Pool, its events, the Achievement Board and the most active wallets of the week." };

export default function RewardsPage() {
  return (
    <>
      <CommunityGate
        feature="achievements"
        held={
          <>
            <OrryHead title="Rewards from the community pool." lead={<p>Chat fees, name fees and the cut of every tip fill the Reward Pool, which pays the community&apos;s rewards.</p>} />
            <ComingSoon title="Rewards open soon." text="The pool's balances, its events and the Achievement Board appear on this page when rewards open." />
          </>
        }
      >
        <RewardsView />
      </CommunityGate>
      <PageGuide
        audience={"Everyone who uses Orrery and talks in its community."}
        steps={[
          { title: "Complete an achievement", text: "Each one pays the same reward to every wallet that completes it, in the order they complete it." },
          { title: "Win an event", text: "Winners are published first and checked in public, then each winner claims the prize." },
          { title: "Claim", text: "Rewards go straight from the pool to your wallet." },
        ]}
      />
    </>
  );
}
