# Independent contract review, 2026-11-10

Reviewer: an independent session with no part in writing the code. Goal: find real bugs in the launch set before the
Robinhood Chain (4663) mainnet deployment. Nothing was deployed, sent or pushed. No file under `contracts/src/` or any
existing test was changed; the only new code is `contracts/test/review/IndependentReview20261110.t.sol`.

## 1. Scope

- Repository `orrery`, branch `build/v1`. Contracts reviewed at commit `f84afa6`; the branch moved to `cb2ce74`
  during the review (a services-only commit, `git diff f84afa6 cb2ce74 -- contracts/` is empty), so the findings apply
  to both.
- Launch set, reviewed line by line: `OrreryPolicyModule.sol`, `OrreryAttestor.sol`, `OrreryLens.sol`; `orry/OrreryTreasury.sol`,
  `OrreryHook.sol`, `EarnVault.sol`, `EarnVaultFactory.sol`, `OrryStaking.sol`, `OrryRewardsRouter.sol`,
  `OrryBuyback.sol`, `ClaimAll.sol`, `OrryLens.sol`.
- Read against `08-contract-spec.md`, `09-invariants.md`, `docs/ORRY-BUILD-SPEC.md`, `docs/ORRY-UPGRADE-PATHS.md`,
  plus the parts of the services and deploy scripts that feed the contracts (EIP-712 types in
  `services/packages/shared/src/eip712.ts`, quote signing, `deploy-orry-4663.ts`, the Earn page).
- Not reviewed: `src/markets/` (launches later) and `src/dev/`.

## 2. Findings

| Id | Severity | Where | One line |
| :-- | :-- | :-- | :-- |
| M-1 | Medium | `EarnVault.sol:327-361` | A zap's own swap fee to existing LPs is refunded to the zapper |
| M-2 | Medium | `OrreryHook.sol:324-364` | One non-transferable quote (USDG paused or a frozen router) blocks every hub's fee collection |
| M-3 | Medium | `EarnVault.sol:146-159`, `services/scripts/deploy-orry-4663.ts:346-349` | Hubs open empty; a free price move takes the first Earn deposit |
| M-4 | Medium | `OrryBuyback.sol:424-436`, `:199` | Full-cap hub hops cannot meet their own `minOut` once the hub carries any PoolManager protocol fee above about 150 pips |
| L-1 | Low | `OrryStaking.sol:240-256` | A staker that cannot take ETH can never take its ORRY rewards |

No Critical or High finding. Counts: 0 Critical, 0 High, 4 Medium, 1 Low, 9 Info.

All PoC tests live in `contracts/test/review/IndependentReview20261110.t.sol`. Each one asserts the property the code
should have and fails today; the failure is the proof. Command (the skips only shorten compilation):

```
cd contracts && heavy forge test --match-path test/review/IndependentReview20261110.t.sol \
  --skip "*/markets/**" --skip "*/fork/**" --skip "*/script/**" -vv
```

Result on 2026-11-10: 1 passed (the M-4 control), 5 failed (one per finding). A full `forge test` now reports these 5
failures too; each test turns green when its finding is fixed.

### M-1 EarnVault: a zap refunds the LP fee its swap paid to the existing LPs

Where: `EarnVault.sol:313-318` pokes the position before the zap swap; `:330-352` swaps; `:356` adds liquidity and keeps
only the first return value of `modifyLiquidity`; `:358-361` treat the whole caller delta as principal.

What happens: in Uniswap v4, `modifyLiquidity` collects every fee the position has accrued since its last touch and
returns it inside the caller delta (`callerDelta = principal + feesAccrued`). The vault pokes its position first, then
the zap swaps `amountIn / 2` through the hub, and the vault's own full-range position earns its share of that swap's
0.85% LP fee. The following `modifyLiquidity(+liq)` collects that fee, but the code reads `-added.amount0()` as the
principal, so the principal is understated by the fee and `refund0 = a0 - amount0` is overstated by exactly the fee.
The fee is paid to the zapper and never reaches `_notify`, so the existing shareholders never see it, and E-3 (fees
harvested minus paid) cannot notice because the fee never enters `harvested`.

Scenario: the vault holds most of the hub liquidity. Every zap of size Z gives the zapper back about
`Z / 2 * 0.85% * vaultShareOfHubLiquidity`. A buyer who wants ORRY can zap, wait the 15-minute lock and withdraw, and
pays about 0.15% (hook fee) instead of 1.00% on the swapped half; the LPs lose that income systematically.

PoC: `ReviewZapFeeLeak.test_M1_zapSwapLpFeeReachesExistingLps`. Bob holds all hub liquidity. A plain 4 ETH sell lets
`harvest()` collect 0.033999999999999999 ETH of fees; an 8 ETH zap (4 ETH swapped) lets it collect 0, and the zapper's
refund is exactly 0.033999999999999999 ETH.

Fix: take the second return value of the add, `(BalanceDelta added, BalanceDelta addFees) = _pm.modifyLiquidity(...)`,
add `addFees` to `r.fees0` and `r.fees1`, and compute the principal as `-(added - addFees)`. Alternatively poke again
after the swap and before the add. Add a test that the fee harvested after a zap equals the swap's LP fee times the
vault's share of in-range liquidity.

### M-2 OrreryHook.collect is all or nothing across every registered quote

Where: `OrreryHook.sol:324-352` (`collect`), `:355-364` (`unlockCallback`): one `unlock` burns and `take`s the claims of
ORRY and every registered quote to `rewardsRouter`, then `safeTransfer`s strays of each.

What happens: if any one currency cannot be transferred to the router, the whole call reverts and no currency is
collected. USDG is a launch pair; `08-contract-spec.md` section 1 records that its issuer can freeze and wipe, and a 4663 read
of 2026-10-27 (workspace notes) also found a pause; Robinhood stock tokens (the likely later pairs, since they have Chainlink feeds on 4663 as R-36
requires) can be paused and can block addresses. While USDG is paused, the ETH and ORRY fees of every hub stay in the
PoolManager. If the issuer ever freezes the router address, the block is permanent: pairs cannot be removed (R-36),
the router is immutable in the hook, and there is no per-currency path. The router itself already handles a failing
quote by skipping it (`OrryRewardsRouter.sol:96-113`); the hook does not.

PoC: `ReviewCollectAllOrNothing.test_M2_pausedQuoteDoesNotBlockEthAndOrryFees`. ETH, ORRY and USDG claims accrue;
USDG is replaced in place by the same ERC-20 with an issuer pause (balances kept) and paused; `collect()` reverts and
the router receives 0 of 0.0067 ETH and 0 ORRY.

Fix: collect each currency independently, either `collect(address currency)` or a loop where each currency runs in
its own `unlock` through an external self-call wrapped in `try`, skipping and emitting an event for a failure. Keep
the stray transfer inside the same per-currency `try`. The same pattern would help `ClaimAll` (see I-1).

### M-3 Hubs open empty, and the first Earn deposit can be taken by a free price move

Where: `services/scripts/deploy-orry-4663.ts:346-349` initializes both hubs and adds no liquidity (`go-live-4663.ts`
does not either). `EarnVault.deposit` (`EarnVault.sol:146-159`) has no price bound besides `minShares`; the zap's
same-block guard (`:381-386`) only compares against the first swap of the current block. The Earn page takes the deposit
ratio from the hub price (`services/packages/web/components/orry/EarnView.tsx:98-110`) and `minShares` from a
simulation of the same state (`:143-145`).

What happens: a swap in a v4 pool with no liquidity moves the price to the swapper's limit and costs nothing. Anyone
can park an empty hub at any price before the first deposit, in an earlier block so the same-block guard does not see
it. The first depositor adds liquidity at that price (the page shows that price and the simulation agrees with it),
then the attacker trades the hub back to the market price against that liquidity. With the price moved by a factor k,
the depositor keeps `2 sqrt(k) / (1 + k)` of the deposit's value: 80% at k = 4, about 20% at k = 100. The same exposure
returns whenever a hub becomes empty again (every LP withdrew), and the hub TWAP for that period is meaningless (I-5).

PoC: `ReviewEmptyHubFirstDeposit.test_M3_firstDepositIntoEmptyHubKeepsItsValue`. The hub is moved to 4x for 0 ETH and 0
ORRY; Alice deposits 10 ETH at the page's ratio (50 ETH of value at the fair price); after the back-run and every fee
she earned, her position is worth 40.09 ETH; the attacker gained 9.88 ETH.

Fix: seed each hub with protocol-owned liquidity in the same transaction that initializes it (a small one-shot helper
that calls `initialize` and then `EarnVault.deposit` with a checked `minShares`), before Earn opens. In the contract,
add a price bound to `deposit` and `zapDeposit` (for example `minSqrtPriceX96` and `maxSqrtPriceX96`, checked inside
`unlockCallback` against `slot0`), and have the page compare the hub price with the Pons pool and Chainlink before it
offers a deposit. The contract change must happen before deployment, as the vaults are immutable.

### M-4 Buyback: full-cap hub hops fail their own minOut under any meaningful protocol fee

Where: `OrryBuyback.sol:424-426` sizes a hop at `reserveIn * fee / 2e6`; `:436` sets
`minOut = spotOut * (1e6 - fee) / 1e6 * 995 / 1000`; `:199` makes `burnEth` always spend `min(balance, cap)`.

What happens: an input of `reserve * fee / 2` moves the price by about `fee / 2`, so the output is about
`spot * (1 - fee) * (1 - fee / 2)`. The `minOut` slack is a fixed 0.5%. In the hub `fee` = 0.85% LP + 0.15% hook =
1.00%, so the price impact uses up the whole slack and a full-cap hop passes with a margin of about 0.008% of the
output. Any PoolManager protocol fee on the hub raises `fee` above 1% and the full-cap hop then reverts
`SlippageExceeded`. The 4663 PoolManager's fee controller already charges 125 pips each way on the ETH/USDG pools
(spec section 2), and the PoolManager allows up to 1000 pips. Measured threshold on the hub: 150 pips passes, 175 pips
fails. Once the router has sent more than one cap of ETH, every `burnEth` call reverts and the ETH half of the rewards
waits in the buyback for as long as the protocol fee stays; `buyWithQuote` and a slice whose hub cap binds use the same
sizing and `minOut` (not separately tested). There is no owner to change the terms. The same arithmetic means a hub fee
above 1% chosen at deployment (R-6 says the owner may change the fee values before deploy) breaks every full-cap hop.

PoC: `ReviewBuybackCapVersusMinOut.test_M4_burnEthStillWorksWithASmallProtocolFeeOnTheHub` (200 pips each way on the
hub: `burnEth` reverts `SlippageExceeded`); `test_M4_controlWithoutProtocolFee` passes. A scan from 0 to 300 pips in
steps of 25 found the first failure at 175.

Fix: let `minOut` cover the impact the cap allows, for example `spotOut * (1e6 - fee) / 1e6 * (2e6 - fee) / 2e6 * 999 /
1000`, or halve the cap to `reserve * fee / 4e6` so the 0.5% slack covers it. Add tests at the cap for protocol fees of
0 to 1000 pips each way, for the hub and for hop 1.

### L-1 OrryStaking: ORRY rewards are tied to a successful ETH payment

Where: `OrryStaking.sol:240-256`. `_claim` pays ORRY and ETH together and reverts when the ETH call fails.

What happens: a staker address that cannot receive ETH (a contract without `receive`, a vault, some smart wallets) can
never take its ORRY rewards either, and no function sends them elsewhere; `ClaimAll` reverts for it as well. The
existing test `test_claim_to_contract_refusing_eth_reverts_its_own_call` covers only the ETH side.

PoC: `ReviewStakingClaimBundle.test_L1_orryRewardsReachAStakerThatRefusesEth` (1,000 ORRY of rewards owed, 0 paid).

Fix: add `claimRewardsTo(address to)` paying the caller's rewards to a chosen address, or keep the ETH owed and pay the
ORRY when the ETH transfer fails.

### Info

- I-1 `ClaimAll.sol:26-50`: one vault whose `claimFor` reverts (a paused quote, an ETH-refusing caller) reverts the
  whole one-click claim; per-contract claims still work.
- I-2 `OrryRewardsRouter.sol:65-72`: `distribute()` succeeds when only quote tokens were forwarded, which starts the
  hourly interval, so ETH or ORRY arriving just after it wait up to an hour. Delay only.
- I-3 `OrreryTreasury.sol:210-216`: the 25 ORRY verifications a day are global. Anyone holding quotes can use them up
  at about 4 USD each (about 100 USD a day) and block ORRY verification for everyone that day; the USDG path is
  unaffected.
- I-4 `OrreryAttestor.sol:100-120`: `payVerification` has no reentrancy guard and writes `_verifications` after the
  external `transferFrom`. Safe with USDG (immutable fee token, no transfer hooks); worth a guard if the token ever
  differs.
- I-5 `OrreryHook.sol:287-314`: `consult` over an empty or thin hub is free to move (see M-3). Later consumers (ORRY as
  collateral, the paymaster, USD thresholds) should require in-range liquidity and check `actualWindow`.
- I-6 `OrryStaking.sol:127-139, 182-190`: the agent wallet can take an agent's position first (the owner then gets
  `PositionHeldByAnotherStaker`) and set a lock of up to 365 days; an emptied position keeps its lock for the next
  staker. Both are as specified (R-13 note), but the stake page should show `lockedUntil` before an owner stakes.
- I-7 `OrreryPolicyModule.sol:625-628` and `OrreryLens.sol:204-205`: as the spec says (5.6), Safe7579 may answer
  `isModuleInstalled` for types 3 and 4 with an empty context as false, so an installed fallback or hook module is not
  refused as a target, and the lens lists only executors and validators. Not verified on a fork here.
- I-8 `EarnVault.sol:473-477`: the share-weighted lock lets an account holding a large unlocked position deposit and
  withdraw new shares well before 15 minutes. This is the SNOP D-05 rule as specified.
- I-9 `EarnVault.sol:437-446`, `OrryStaking.sol:292-299`: every harvest or notify restarts a 7-day stream, so payouts
  decay over time instead of finishing in 7 days (accepted as R-19; rewards are delayed, never lost).

## 3. Slither triage

Slither 0.11.6, installed with `uv tool install slither-analyzer`, run once per launch-set file in solc mode
(`--compile-force-framework solc`, solc 0.8.38 with `--via-ir --optimize --evm-version cancun`, the foundry remappings,
`--exclude-dependencies --filter-paths lib/`). Results restricted to `src/`, deduplicated. 210 results in total: 9 High,
60 Medium, 79 Low, 62 Informational (by detector instance). Every High and Medium result:

| Detector (count) | Where | Verdict | Reason |
| :-- | :-- | :-- | :-- |
| reentrancy-balance (7, High) | `OrreryPolicyModule.topUp` (4), `OrreryAttestor.payVerification`, `OrryRewardsRouter.distribute`, `OrryStaking._pullOrry` | False positive | These are balance-delta checks that read before and after the call on purpose; a reentrant balance change makes them revert, never pass. Module, router and staking hold a reentrancy lock; the attestor's fee token is immutable USDG (I-4). |
| weak-prng (2, High) | `OrreryHook.consult`, `OrreryHook._observe` | False positive | `%` is the ring index and the floor-rounding test, not randomness. |
| incorrect-equality (19, Medium) | Treasury, vault, buyback, router, attestor, lens | False positive | Comparisons with 0 for "nothing to do" exits, the ERC-20 return-value check and exact balance-delta checks. No path is gated on a strict equality an attacker can break to their benefit; a donation can only turn a "nothing to do" revert into a normal run. |
| reentrancy-no-eth (5, Medium) | `EarnVault.withdraw`, `OrreryAttestor.payVerification`, `OrryRewardsRouter.distribute`, `OrryStaking.stake`, `stakeForAgent` | False positive | The external call is the trusted PoolManager, USDG, an admin-listed quote or ORRY, and every function except the attestor's holds a reentrancy lock. |
| uninitialized-local (13, Medium) | various | False positive | Zero is the intended starting value. |
| unused-return (21, Medium) | `getSlot0` tuple fields, `settle()`, `unlock()`, `executeFromExecutor`, `getModulesPaginated` cursor, `modifyLiquidity` fees | False positive, with one exception | The ignored values are unused tuple fields or are enforced by the PoolManager's delta accounting. The exception is `EarnVault.sol:356`, the ignored `feesAccrued` of the add, which is finding M-1. `OrreryLens` reads the first 10 Safe modules by design (spec 9). |
| divide-before-multiply (2, Medium) | `OrryBuyback._swapExactIn` `minOut`, `OrryStaking._restart` | False positive | `minOut` rounds down by a few wei (looser, harmless); `_restart` keeps the division remainder as `unstreamed` on purpose. The real `minOut` problem is the slack, not the rounding (M-4). |

Low and Informational (timestamp, calls-loop, low-level-calls, naming, missing-zero-check on constructor immutables and
on `transferOwnership(0)` which cancels a transfer by design, benign reentrancy and events) were read and contain
nothing beyond the items above.

Side effect to note: the first trial run used Slither's Foundry mode, which runs `forge clean` in `contracts/`. That
removed the gitignored `out/` and `cache/` once; no source changed. All later runs used solc mode, which writes nothing
in the repository.

## 4. Checked and found sound

- `OrreryPolicyModule`: one module-wide lock on every state-changing function; O(1) revocation through the epoch on
  install and uninstall; signer single use and consent (typehash, domain name, version, chainId and module address match
  the SDK; low `s` enforced; replay blocked by `SignerUsed`); decrease versus increase classification, including the
  same token set, target subset, `validUntil` and `increaseDelay`; pending cleared on decrease, revoke and reopen; a
  re-proposal never brings `readyAt` forward; `topUp` exactness on both sides; `execute` measures every capped token and
  refuses native outflow when native is not capped; value is always 0; all 26 forbidden selectors match `cast sig`.
- `OrreryAttestor`: fee cap derived from decimals, `expectedOwner` and `maxFee`, treasury balance-delta, attestation order
  and TTL, key caps, two-step ownership.
- `OrreryLens`: a replaced signer is reported Revoked without the newer session's data; `validFor` is `now` in every case
  the spec lists; Safe detection checks the codehash, singleton, adapter module and fallback slot.
- `OrreryTreasury`: the EIP-712 type strings and domain match `services/packages/shared/src/eip712.ts`; quote ids are
  single use across both quote types; expiry is inclusive; at most 3 signers; burns are checked by the supply delta;
  the split rounds the owner's part down; the pull window is at most 10% of its base per 24 hours (all of it at 1 USDG
  or less); the coin is set once, after 48 hours and within 7 days; reclaim only while coinless; ORRY verification
  pays as the treasury (fee recorded 0, no USDG moves) and stays within 25 a day.
- `OrreryHook`: permission bits checked in the constructor (0x10C4); only registered keys with the exact fee and
  spacing can initialize, and v4 refuses a second initialization; `unlockCallback` is reachable only through the hook's
  own `unlock`; the `afterSwapReturnDelta` fee sign is right for exact-input and exact-output swaps; the TWAP uses the
  pre-swap tick, cannot be moved within the same second, cannot overflow, and `consult` floors toward negative infinity;
  pair proposals respect delay, window, cap and feed freshness.
- `EarnVault`: shares are liquidity units, so a donation or a first deposit cannot move the share price; `withdraw`
  separates fees through `feesAccrued`; settlement only pays the vault's own deltas and the checked `a0 - amount0`
  subtraction stops a deposit from spending other LPs' fee balances; streams never promise more than emitted (rounding
  down, queued while no shares exist); ETH is accepted only from the PoolManager; reentrancy lock everywhere.
- `OrryStaking`: accrued rewards never exceed `owed`, so `owed -= claimed` cannot underflow; rewards with no earners
  wait in `unstreamed`; an unstake request stops earning at once and starts the cooldown; agent positions are keyed by
  the current owner and the lock only grows (S-6); intake by balance delta; no owner.
- `OrryRewardsRouter`: exact 50/50 split, exact approval, failing quotes skipped, nothing left after `distribute`.
- `OrryBuyback`: hop direction and input currency are right for all four actions; ETH nets to zero inside a slice;
  every hop must swap its full input inside a half-fee price limit; the cross-pool spread check and the 1,000 USDG slice
  cap (R-18); the cashback sink is set once after 48 hours; `burnEth` burns its whole ORRY balance.
- `ClaimAll`, `OrryLens`, `EarnVaultFactory`: pay or read for `msg.sender` only; one CREATE2 vault per registered quote.

## 5. Not verified

- `src/markets/` was not reviewed.
- Safe7579 behaviour for `isModuleInstalled` types 3 and 4 with an empty context (I-7) was not checked on a fork.
- Who controls the PoolManager protocol fee on 4663, and whether it would ever set one on a hooked pool (M-4), was not
  checked.
- The full repository suites were not rerun; only the new review file was compiled and run.

## 6. Fixes (2026-11-10, same day)

All five findings are fixed in the launch contracts before any mainnet deployment. The proof tests in
`contracts/test/review/IndependentReview20261110.t.sol` now pass and stay in the suite as regressions (M-1 and M-3 were
rewritten to assert the fixed behaviour).

| Id | Fix |
| :-- | :-- |
| M-1 | `EarnVault._addLiquidity` takes the fees returned by the add (`addFees`) into `r.fees`, so they stream to the existing shareholders; the principal is the caller delta without them. `test_zap_from_quote` and `test_zap_from_orry` now expect the zap's LP fee to stay in the vault. |
| M-2 | `OrreryHook.collect()` collects each currency in its own `unlock` through `collectOne(currency)` (self-only, `NotSelf`), inside `try`; a currency that cannot move emits `ProtocolFeeCollectFailed(currency)` and the others are paid. |
| M-3 | `EarnVault.deposit` and `zapDeposit` take `minSqrtPriceX96` and `maxSqrtPriceX96`; the hub price must be inside them when the deposit enters (`PriceOutOfBounds`). The web passes 2% around the hub's 30 minute mean (`hook.consult`) and refuses deposits into a pool with no shares; `deploy-orry-4663.ts --seed-eth --seed-usdg` seeds both pools right after they open, within 1% of the opening prices. |
| M-4 | `OrryBuyback._swapExactIn` floor: `spotOut * (1 - fee) * (1 - fee / 2) * 0.999`, covering the impact a full-cap hop may cause. Regression sweeps protocol fees of 0 to 1000 pips (hub burn and an ETH slice). |
| L-1 | `OrryStaking._claim` pays ORRY and keeps ETH owed when the ETH send fails (no revert); `claimRewardsTo(to)` pays the caller's rewards elsewhere. |

Interface changes (launch contracts, not deployed anywhere but the development network): `IEarnVault.deposit` and
`zapDeposit` signatures, `IOrreryHook.collectOne` and `ProtocolFeeCollectFailed`, `IOrryStaking.claimRewardsTo` and
`ZeroAddress`. `packages/shared/src/orry-abi.ts` regenerated from the interfaces; SDK `earnDeposit` and `earnZap` take
the bounds, `claimStakeRewardsTo` added. The 46630 development deployment still runs the earlier contracts.
