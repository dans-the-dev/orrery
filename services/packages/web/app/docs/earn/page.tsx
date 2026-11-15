import { DocsShell } from "@/components/orry/docsShell";
import { Period } from "@/components/orry/docs";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Earn guide", description: "How Orrery Earn works: deposits, zaps, fee streams, claims and withdrawals." };

export default function EarnDocs() {
  return (
    <DocsShell kicker="Guide" title="Earn" lead={<p>Pick an ORRY pool and add its tokens, one or both. Your share earns from every swap in that pool.</p>}>
      <FeatureGate
        feature="earn"
        held={
        <ComingSoon title="The Earn guide opens with Earn." text="This guide appears here when Earn opens." />
        }
      >
        <>
          <h2>What Earn holds</h2>
          <p>
            ORRY trades in several pools on Uniswap v4, all run by Orrery&apos;s own hook: ORRY with ETH and ORRY with USDG. Each pool has its own
            Earn vault, one shared position across the pool&apos;s full price range. Every swap pays a fee. The liquidity part goes to positions in
            range, that pool&apos;s Earn vault included. The protocol part reaches the rewards router as ORRY or ETH, and the router pays stakers and
            burns ORRY.
          </p>
          <p>
            Your shares in a vault are units of the liquidity your deposits added to that pool. They stay with your address and do not move to anyone
            else. Tokens sent to a vault outside a deposit never change what a share is worth. The Earn page shows each pool as its own card, and your
            withdrawal is set as a share of your position in that pool.
          </p>

          <h2>Fees stream to shares</h2>
          <p>
            Each vault collects its position&apos;s fees on every deposit and withdrawal, and whenever anyone calls <code>harvest()</code>. Collected
            fees stream to shares over <Period name="earnStream" />, so each share earns for the time it is held. Fees arrive in ORRY and the
            pool&apos;s other token. The page shows realised fees only: the last 7 days and all time.
          </p>

          <h2>Buttons</h2>
          <table>
            <tbody>
              <tr><td>Deposit</td><td>Adds the pool&apos;s token and ORRY at the pool price. Whatever the pool cannot take at that ratio comes back in the same transaction. <code>deposit(quoteMax, orryMax, minShares, deadline)</code>. ETH goes in as value; USDG and ORRY through an approval.</td></tr>
              <tr><td>Zap deposit</td><td>Takes one token, swaps about half in the pool and deposits both halves. <code>zapDeposit(fromQuote, amountIn, minSwapOut, minShares, deadline)</code>.</td></tr>
              <tr><td>Withdraw</td><td>Burns shares and pays the pool&apos;s token and ORRY at the pool price, with your streamed fees. <code>withdraw(shares, minQuoteOut, minOrryOut, deadline)</code>.</td></tr>
              <tr><td>Claim fees</td><td>Pays that pool&apos;s streamed fees in its token and ORRY and leaves your shares in place. <code>claimFees()</code>. Claim all on the claim page pays every pool and your stake rewards together.</td></tr>
            </tbody>
          </table>

          <h2>Timing</h2>
          <p>
            A deposit can be withdrawn <Period name="depositLock" /> after it lands. When you add to an existing position, the wait is the share
            weighted average of what was left and a fresh lock. Zaps check that the pool price held steady within the block before they swap, which
            keeps same-block trades from moving your entry.
          </p>

          <h2>Price limits</h2>
          <p>
            Every deposit, zap and withdrawal carries a minimum: the shares you accept, the tokens a zap must receive from its swap, the two tokens
            a withdrawal must pay. The page sets them from the live price and the limit you pick (0.5%, 1% or 2%).
          </p>
        </>
      </FeatureGate>
    </DocsShell>
  );
}
