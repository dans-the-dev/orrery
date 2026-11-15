# Multi-pair hubs: lane B interface draft (R-35 to R-38)

Date: 2026-11-08. Branch `orry/pairs-b`, cut from `orry/integration` 0c96dec. This is a draft for the spec owner to
review and freeze on `orry/spec`; nothing is implemented. The implementations and tests on this branch still match the
old interfaces, so only the interface files compile here: `heavy forge build
src/orry/interfaces/IOrryRewardsRouter.sol src/orry/interfaces/IOrryBuyback.sol
src/markets/interfaces/IMarketPricing.sol` gives "Compiler run successful!". `services/packages/shared/src/orry-abi.ts`
and `markets-abi.ts` are not regenerated; that belongs to the spec owner.

The hook views lane B uses are lane A's draft on `orry/pairs-a` 7c8970f, agreed with lane A without changes. Ticks are
the pool's own, oriented with `pairOf(quote).orryIsCurrency0`; the buyback works in sqrt prices, so only the price
oracle flips a tick.

## What changes

| Interface | Change | Why |
| :--- | :--- | :--- |
| `IOrryRewardsRouter` | `distribute` also forwards the router's whole balance of every registered quote other than native ETH to the buyback; new `hook()` (constructor argument); new event `QuoteForwarded(quote, amount)`; `NothingToDistribute` only when there is no ETH, no ORRY and no quote | R-37: fees from hubs other than ETH become ORRY |
| `IOrryBuyback` | New `buyWithQuote(quote)`: one hop in that quote's own hub, half-fee cap, that hub's same-block guard, minimum output, ORRY sent to the router; `lastQuoteBuyAt(quote)` and `maxQuoteIn(quote)`; `QuoteSwapped(quote, quoteIn, orryOut)`; error `NotAQuote` | R-37 |
| `IOrryBuyback` | `executeSlice` goes one hop through the ORRY/USDG hub when that hub is registered and initialized and its cap is at least the ETH path's; otherwise the ETH path as before. `SliceExecuted.ethMid` is 0 on the direct route; new view `sliceViaUsdgHub()` | Plan section 2, treasury buyback |
| `IOrryPriceOracle` (R1, parked) | Prefers the USDG hub's 30 minute mean tick once that hub has the history, else the ETH hub times ETH/USD; new views `usdg()` and `source()` (1 USDG hub, 2 ETH path, 0 not ready) | Plan section 2, ORRY price |

Unchanged: `IOrryStaking`, `IOrreryTreasury`, `IOrryToken`. `burnEth` is unchanged; it uses the ETH hub
(`hubKey(address(0))`).

## Choices in the draft (decide or change at freeze)

1. **Forwarding happens inside `distribute`**, not in a separate function. One entry point and one interval; a quote
   whose transfer fails (for example a USDG freeze on the buyback) is skipped, so ETH and ORRY still distribute.
   Alternative: a separate `forwardQuotes()`.
2. **All of a quote's fee becomes ORRY first, then the router's 50/50 split applies.** Staking has only ETH and ORRY
   streams (R-37, "staking unchanged"). ETH keeps its old route: half to stakers as ETH, half bought and burned. The
   value split is the same for both.
3. **`buyWithQuote` is anyone's**, at most once per `MIN_INTERVAL` per quote, and spends only the buyback's own balance
   of that quote. Native ETH and ORRY are refused (`NotAQuote`); ETH goes through `burnEth`.
4. **Slice route rule:** direct through the USDG hub when `cap(USDG hub) >= min(cap(hop 1), cap(ETH hub))`, otherwise
   the ETH path. `maxSliceUsdgCap` (R-18, 1,000 USDG) still bounds every slice on both routes. On the direct route it is
   not needed for F-1 (there is no hop 1), but it keeps each slice small against hub manipulation; the owner may raise it
   for the direct route at freeze.
5. **No quote-specific constructor list.** The buyback reads the hook's registry live, so a pair executed after
   deployment (R-36) is bought in without redeploying the router or the buyback.
6. **Price oracle source switch:** USDG hub first, then the ETH path, with no averaging of the two. `source()` tells
   clients which one priced a value.

## Invariants (plan section 4) and where they land

- P-5:
  - the router moves a token only when it is a registered quote other than ETH, and only to the buyback;
  - the buyback spends a quote only in that quote's own hub, and only up to that hop's cap;
  - the ORRY bought goes only to the router;
  - nothing else moves a quote (handler with a stray token: it never moves).
- B-series per hub, the existing buyback invariants run for every hub:
  - the cap holds for every hop;
  - the minimum output is against the pre-trade state;
  - the same-block guard is that hub's;
  - nothing is left in the buyback after a call except quote balances waiting for `buyWithQuote`;
  - no Pons address or selector, no mint.
- P-4 (lane A) meets lane B at the router: what `collect` pays arrives as plain ETH and ERC-20 balances and is split
  or forwarded by the next `distribute`.
- Route rule: `executeSlice` takes the direct route exactly when the rule above holds; the ETH path is unchanged when it
  does not.

## What services and the web read (lane C)

- New events: `QuoteForwarded(quote, amount)` on the router and `QuoteSwapped(quote, quoteIn, orryOut)` on the buyback.
- `SliceExecuted.ethMid` is 0 on the direct route.
- The keeper adds `buyWithQuote(quote)` for each registered non-ETH quote with `maxQuoteIn(quote) > 0`.
