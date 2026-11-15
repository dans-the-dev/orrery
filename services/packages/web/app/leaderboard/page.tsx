import { PageGuide } from "@/components/PageGuide";
import { LeaderboardView } from "@/components/orry/LeaderboardView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { OrryShell } from "@/components/orry/shell";

export const metadata = { title: "Orrery · Leaderboard", description: "The largest ORRY stakers and the biggest earners, ranked." };

export default function LeaderboardPage() {
  return (
    <OrryShell>
      <FeatureGate
        feature="leaderboard"
        held={
        <>
          <OrryHead title="Who leads in stake and earnings." />
          <ComingSoon title="The leaderboard starts soon." text="The leading stakers and earners, with the total each has earned, show here once it starts." />
        </>
        }
      >
        <LeaderboardView />
      </FeatureGate>
      <PageGuide
        audience={"Stakers and anyone with an Earn deposit."}
        steps={[
          { title: "Top stakers", text: "Ordered by ORRY at stake at this moment, counting plain stake and stake behind agents." },
          { title: "Top earners", text: "Ordered by total earned through Earn and Stake, claimed or not yet claimed, valued in ORRY." },
          { title: "Move up", text: "Stake, or add to Earn. The board updates as new blocks land." },
        ]}
      />
    </OrryShell>
  );
}
