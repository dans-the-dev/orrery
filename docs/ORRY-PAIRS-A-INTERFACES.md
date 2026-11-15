# Multi-pair hubs: lane A interface draft (R-35 to R-38)

Date: 2026-11-08. Branch `orry/pairs-a`, cut from `orry/integration` 0c96dec. Draft for the spec owner to review and
freeze on `orry/spec`; nothing is implemented. The implementations and tests on this branch still match the old
interfaces, so only the interface files compile here: `forge build src/orry/interfaces/{IOrreryHook,IEarnVault,IEarnVaultFactory,IOrryClaims}.sol`
gives "Compiler run successful!". `services/packages/shared/src/orry-abi.ts` is not regenerated; that belongs to the spec owner.

## What changes

| Interface | Change | Why |
| :--- | :--- | :--- |
| `IOrreryHook` | Hubs keyed by quote token X (address 0 = native ETH). `Pair` struct and registry (`pairCount`, `pairAt`, `pairOf`, `isPair`, `hubKey(quote)`, `quoteOfPool`); `proposePair` and `executePair` by the pair admin with `PAIR_DELAY` 48 h, `PAIR_WINDOW` 7 d, `MAX_PAIRS` 8, `FEED_MAX_AGE`; per-hub `startOfBlockSqrtPriceX96(quote)` and oracle (`latestObservation`, `observation`, `observationIndex`, `consult` with a quote argument); `pendingProtocolFee(currency)`; `collect()` pays every currency | R-35, R-36, P-1 to P-4 |
| `IEarnVault` | Quote-generic: `quote()`; `deposit(quoteMax, orryMax, minShares, deadline)`; `zapDeposit(fromQuote, ...)`; every amount is (quote, ORRY) whatever the pool's currency order; `ValueMismatch` and `HubNotInitialized` errors | one vault per hub (P-6) |
| `IEarnVaultFactory` (new) | `createVault(quote)` by anyone once the hook lists the pair, CREATE2 with salt = quote; `vaultOf`, `predictVault`, `vaultCount`, `vaultAt`, `vaults` | the hook does not need to know the factory, so the mined hook address has no circular dependency |
| `IClaimAll` | `earnFactory()` replaces `earnVault()`; `claimAll()` returns and emits `Paid[]` (ORRY, native ETH, then each other quote) | rewards now come in up to 9 assets |
| `IOrryLens` | `earnFactory()`; `Claimables.earn` is an `EarnPosition[]` with one entry per vault | one card per pair on the Earn page |

Removed, so lanes B, C and the web must follow: `hubRegistered()`, `hubKey()`, `hubPoolId()`, `startOfBlockSqrtPriceX96()`,
`pendingProtocolFees()`, the no-argument oracle views and `consult(window)`, `collect()` return values, the events
`HubRegistered` and `ProtocolFeesCollected(ethAmount, orryAmount)`, the error `HubAlreadyRegistered` (the PoolManager
itself refuses a second initialization of a key), the vault's ETH-named parameters and event fields, `HubNotRegistered`,
and `earnVault()` with the single-vault fields of `Claimables`. Unchanged: `IOrryStaking`, `IOrreryTreasury`,
`IOrryToken`. `IOrryRewardsRouter` and `IOrryBuyback` are lane B's draft.

## Choices made in the draft (1 to 6 accepted by the spec owner, 2026-11-08)

1. **Pair admin = `IOrreryTreasury(treasury).owner()`, read live.** It follows the treasury's two-step ownership transfer,
   so there is no second key to rotate (one wallet). Alternative: an immutable address, which a key rotation would leave
   behind.
2. **`executePair` by the pair admin only**, as `executeCoin` on the treasury. Alternative: anyone after the delay.
3. **Launch pairs in the constructor, without delay or feed check for USDG.** The hook constructor would take
   `(poolManager, orry, rewardsRouter, treasury, lpFee, protocolFeePips, tickSpacing, usdg, ethUsdFeed)` and register
   ETH (feed checked) and USDG (`usdFeed` 0: Orrery's unit; the plan's list of 62 feeds on 4663 has no USDG feed, read
   through the plan, re-check before deploy). Every later pair must bring a feed.
4. **A feed "answers"** when `latestRoundData()` gives `answer > 0` and `updatedAt` within `FEED_MAX_AGE` = 25 hours (the
   24 hour heartbeat plus one hour). It is checked at `proposePair` and again at `executePair`, never during a swap.
5. **What the hook cannot check:** that the feed belongs to the token (no feed registry on 4663), and whether the token
   charges a transfer fee, rebases or calls back. The 48 hour delay is the public check. A fee-on-transfer token would make
   the vault's balance-delta check revert its deposits; nothing can be stolen that way, but the pair would be unusable
   and, under R-36, permanent.
6. **Fee claims are per currency, not per hub.** ERC-6909 claims are one balance per currency, so the ORRY fees of every
   hub share one balance. Each quote belongs to exactly one hub, so P-4 holds per currency: `collect()` pays every claim
   to the router, one `ProtocolFeesCollected(currency, amount)` each. The router finds ERC-20 balances itself (no callback).
7. **Oracle ticks are the pool's own ticks**, with `Pair.orryIsCurrency0` for orientation (ORRY's address decides it for
   ERC-20 quotes; ETH is always currency0). Agreed with lane B (2026-11-08): their price oracle flips the tick when
   needed, and their buyback uses sqrt prices. Lane B relies on, unchanged: `isPair(address(0))` and `hubKey(address(0))`
   for ETH, `pairCount` and `pairAt`, `startOfBlockSqrtPriceX96(quote)` with block 0 before a block's first swap,
   `consult(quote, 1800)` reverting `OracleNotReady` while history is short, the same `LP_FEE` and `protocolFeePips` for
   every hub, and `collect()` paying ERC-20 quotes to the router as plain balances.
8. **Vault value checks:** a native ETH vault takes `msg.value == quoteMax` (or `amountIn` on a quote zap); an ERC-20 vault
   requires `msg.value == 0`. A mismatch reverts `ValueMismatch`. This replaces R-21's `ZeroAmount` reading, since the
   interface changes anyway.
9. **ClaimAll returns `Paid[]`** in a fixed layout (ORRY, native ETH, then other quotes in factory order, zeros
   included), so a client can read it without matching assets.

## Invariants (plan section 4) and where they land

P-1 and P-2 on the hook's registry (only registered keys initialize; only `executePair` registers, after the delay and
within the window; never more than 8; no function changes or removes a pair or its fee). P-3 per-hub same-block record and
observations (H-5 to H-8 per hub, plus "a swap in hub X never changes hub Y's state"). P-4 `collect` pays exactly the
claims per currency. P-5 is lane B's (router and buyback). P-6 one vault per quote from the factory, and each vault only
ever holds its own hub's position (E-1 to E-6 per vault).
