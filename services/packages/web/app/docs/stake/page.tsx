import { DocsShell } from "@/components/orry/docsShell";
import { Period, StakersShare } from "@/components/orry/docs";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Stake guide", description: "How ORRY staking works: rewards from Orrery's revenue, unstaking, and stake behind an agent." };

export default function StakeDocs() {
  return (
    <DocsShell kicker="Guide" title="Stake" lead={<p>Stake ORRY and receive ETH and ORRY from Orrery&apos;s own revenue.</p>}>
      <FeatureGate
        feature="stake"
        held={
        <ComingSoon title="The Stake guide opens with staking." text="This guide appears here when staking opens." />
        }
      >
        <>
          <h2>Where rewards come from</h2>
          <p>
            Rewards come from Orrery&apos;s own activity: the protocol part of every swap fee in the ORRY pools, and ORRY bought with the USDG that
            Orrery earns from check credits and agent verifications. Both reach the rewards router. When anyone runs Distribute, the router sends{" "}
            <StakersShare /> of each asset to stakers and burns the rest.
          </p>
          <p>
            New rewards stream over <Period name="stakeStream" /> to every active stake, in proportion to its size. A stake earns from the moment it
            lands until it is requested back.
          </p>

          <h2>Plain stake</h2>
          <table>
            <tbody>
              <tr><td>Stake</td><td>Locks ORRY from your wallet and starts earning. <code>stake(amount)</code>.</td></tr>
              <tr><td>Request unstake</td><td>Moves an amount out of earning at once. It is ready to withdraw <Period name="plainCooldown" /> later; a further request adds to it and starts the wait again. <code>requestUnstake(amount)</code>.</td></tr>
              <tr><td>Withdraw</td><td>Sends the requested ORRY back to you once it is ready. <code>withdraw()</code>.</td></tr>
              <tr><td>Claim rewards</td><td>Pays your streamed ETH and ORRY. <code>claimRewards()</code>.</td></tr>
            </tbody>
          </table>

          <h2>Stake behind an agent</h2>
          <p>
            Stake ORRY behind this agent. Merchants see the amount in every check. Unstaking takes <Period name="agentCooldown" />.
          </p>
          <p>
            The agent&apos;s owner or its agent wallet stakes with <code>stakeForAgent(agentId, amount)</code>. The position belongs to the address that
            staked, earns rewards like a plain stake, and is recorded for the agent&apos;s owner at that moment. Signed checks for the agent carry it in
            four fields: <code>stakeActive</code>, <code>stakeLeaving</code>, <code>stakeLeavingAt</code> and <code>stakedBy</code>.
          </p>
          <table>
            <tbody>
              <tr><td>Stake behind agent</td><td>Adds ORRY to the agent&apos;s position. One staker per position; the same staker can add more.</td></tr>
              <tr><td>Agent unstake</td><td>Moves an amount out of earning and into leaving. <code>requestAgentUnstake(agentId, owner, amount)</code>.</td></tr>
              <tr><td>Agent withdraw</td><td>Sends the leaving ORRY back to the staker once ready. <code>withdrawAgent(agentId, owner)</code>.</td></tr>
            </tbody>
          </table>
          <p>When an agent identity moves to a new owner, its earlier position stays with its staker, who can still unstake and withdraw it.</p>
        </>
      </FeatureGate>
    </DocsShell>
  );
}
