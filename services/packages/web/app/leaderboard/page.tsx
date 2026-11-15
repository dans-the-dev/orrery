import { PageGuide } from "@/components/PageGuide";
import { LeaderboardView } from "@/components/orry/LeaderboardView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { OrryShell } from "@/components/orry/shell";

export const metadata = { title: "Orrery · Leaderboard", description: "Top ORRY stakers and top earners." };

export default function LeaderboardPage() {
  return (
    <OrryShell>
      <FeatureGate
        feature="leaderboard"
        held={
        <>
          <OrryHead title="Top stakers and top earners." />
          <ComingSoon title="The leaderboard opens soon." text="Top stakers and top earners, with what each has earned, appear on this page when it opens." />
        </>
        }
      >
        <LeaderboardView />
      </FeatureGate>
      <PageGuide
        audience={"Stakers and Earn depositors."}
        steps={[
          { title: "Top stakers", text: "Ranked by ORRY staked right now, plain and behind agents." },
          { title: "Top earners", text: "Ranked by everything earned from Earn and Stake, claimed or still pending, valued in ORRY." },
          { title: "Climb it", text: "Stake or add to Earn; the board refreshes as the chain moves." },
        ]}
      />
    </OrryShell>
  );
}
