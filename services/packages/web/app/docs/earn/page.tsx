import { DocsShell } from "@/components/orry/docsShell";
import { Period } from "@/components/orry/docs";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Guide to Earn", description: "The Orrery Earn guide: deposits, zaps, streamed fees, claims and withdrawals." };

export default function EarnDocs() {
  return (
    <DocsShell kicker="Guide" title="Earn" lead={<p>Choose an ORRY pool and supply one of its tokens or both. Your share collects from each swap the pool handles.</p>}>
      <FeatureGate
        feature="earn"
        held={
        <ComingSoon title="The Earn guide arrives with Earn." text="This guide shows here once Earn starts." />
        }
      >
        <>
          <h2>Inside an Earn vault</h2>
          <p>
            ORRY trades in more than one Uniswap v4 pool, ORRY with ETH and ORRY with USDG, and Orrery&apos;s own hook runs every one of them. A pool
            has one Earn vault, a single shared position spanning the pool&apos;s entire price range. Each swap pays a fee. Its liquidity cut goes to
            in range positions, including that pool&apos;s Earn vault. Its protocol cut arrives at the rewards router as ORRY or ETH, from where the
            router pays stakers and burns ORRY.
          </p>
          <p>
            A vault share is a unit of the liquidity your deposits put into that pool. Shares remain with your address and cannot pass to another.
            Tokens that reach a vault other than through a deposit leave the value of a share unchanged. On the Earn page every pool has its own card,
            and you set a withdrawal as a portion of your position in that pool.
          </p>

          <h2>How fees reach shares</h2>
          <p>
            A vault gathers its position&apos;s fees on each deposit and withdrawal, and any time someone calls <code>harvest()</code>. Gathered fees
            stream to shares over <Period name="earnStream" />, so a share earns in proportion to how long it is held. Fees come in ORRY and in the
            pool&apos;s other token. The page reports realised fees alone, for the last 7 days and for all time.
          </p>

          <h2>Actions</h2>
          <table>
            <tbody>
              <tr><td>Deposit</td><td>Supplies the pool&apos;s token and ORRY at the pool price. Anything the pool does not absorb at that ratio returns in the same transaction. <code>deposit(quoteMax, orryMax, minShares, deadline)</code>. ETH is sent as value, while USDG and ORRY use an approval.</td></tr>
              <tr><td>Zap deposit</td><td>Accepts a single token, swaps roughly half of it in the pool, and deposits the two halves. <code>zapDeposit(fromQuote, amountIn, minSwapOut, minShares, deadline)</code>.</td></tr>
              <tr><td>Withdraw</td><td>Burns shares and returns the pool&apos;s token and ORRY at the pool price, along with the fees streamed to you. <code>withdraw(shares, minQuoteOut, minOrryOut, deadline)</code>.</td></tr>
              <tr><td>Claim fees</td><td>Collects the fees streamed from that pool, in its token and ORRY, without touching your shares. <code>claimFees()</code>. Claim all, on the claim page, collects from every pool and your stake rewards at once.</td></tr>
            </tbody>
          </table>

          <h2>Timing</h2>
          <p>
            A deposit becomes withdrawable <Period name="depositLock" /> after landing. Adding to a position you already hold sets the wait to the
            share weighted average of the time remaining and a new lock. Before swapping, a zap confirms the pool price stayed steady inside the
            block, so trades in that same block cannot shift your entry.
          </p>

          <h2>Minimums on every action</h2>
          <p>
            Deposits, zaps and withdrawals each carry a floor: the fewest shares you will take, the least a zap must get back from its swap, and the
            least of each token a withdrawal must return. The page computes them from the current price and the tolerance you choose (0.5%, 1% or 2%).
          </p>
        </>
      </FeatureGate>
    </DocsShell>
  );
}
