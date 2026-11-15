import { DocsShell } from "@/components/orry/docsShell";
import { Period, StakersShare } from "@/components/orry/docs";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Guide to staking", description: "The ORRY staking guide: where rewards come from, how unstaking runs, and staking behind an agent." };

export default function StakeDocs() {
  return (
    <DocsShell kicker="Guide" title="Stake" lead={<p>Revenue Orrery earns comes back to stakers in ETH and ORRY.</p>}>
      <FeatureGate
        feature="stake"
        held={
        <ComingSoon title="The Stake guide arrives with staking." text="This guide shows here once staking starts." />
        }
      >
        <>
          <h2>The source of rewards</h2>
          <p>
            Two flows fund rewards, both from Orrery&apos;s own business: the protocol cut of each swap fee in the ORRY pools, and ORRY bought with
            the USDG Orrery takes in from check credits and agent verifications. Both land in the rewards router. Whenever someone runs Distribute,
            the router passes <StakersShare /> of each asset to stakers and burns what remains.
          </p>
          <p>
            Each new reward streams to every active stake over <Period name="stakeStream" />, weighted by stake size. Earning starts when a stake
            lands and stops when it is requested back.
          </p>

          <h2>Staking on your own</h2>
          <table>
            <tbody>
              <tr><td>Stake</td><td>Moves ORRY out of your wallet into the stake, and earning begins. <code>stake(amount)</code>.</td></tr>
              <tr><td>Request unstake</td><td>Takes an amount out of earning straight away. You can withdraw it <Period name="plainCooldown" /> later. Another request adds to the amount and restarts that wait. <code>requestUnstake(amount)</code>.</td></tr>
              <tr><td>Withdraw</td><td>Returns the requested ORRY to your wallet when the wait is over. <code>withdraw()</code>.</td></tr>
              <tr><td>Claim rewards</td><td>Collects the ETH and ORRY streamed to you so far. <code>claimRewards()</code>.</td></tr>
            </tbody>
          </table>

          <h2>Staking behind an agent</h2>
          <p>
            ORRY can be staked behind a single agent, and merchants see that amount in each reading of it. Unstaking it takes <Period name="agentCooldown" />.
          </p>
          <p>
            Either the agent&apos;s owner or its agent wallet calls <code>stakeForAgent(agentId, amount)</code>. The address that staked owns the
            position, it earns just as a solo stake does, and it is recorded against whoever owns the agent at that moment. Signed readings of the agent
            show it through four fields: <code>stakeActive</code>, <code>stakeLeaving</code>, <code>stakeLeavingAt</code> and <code>stakedBy</code>.
          </p>
          <table>
            <tbody>
              <tr><td>Back an agent</td><td>Puts ORRY into the agent&apos;s position. Each position has a single staker, who may keep adding to it.</td></tr>
              <tr><td>Agent unstake</td><td>Shifts an amount from earning to leaving. <code>requestAgentUnstake(agentId, owner, amount)</code>.</td></tr>
              <tr><td>Agent withdraw</td><td>Returns the leaving ORRY to the staker when the wait is over. <code>withdrawAgent(agentId, owner)</code>.</td></tr>
            </tbody>
          </table>
          <p>If an agent identity changes hands, the earlier position remains with the staker, who keeps the right to unstake and withdraw it.</p>
        </>
      </FeatureGate>
    </DocsShell>
  );
}
