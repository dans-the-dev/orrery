# L4 spec: third-party attesters (R-47) and Orrery Credit with an ORRY first-loss bond (U7)

Lane L4 of the 2026-11-11 update run (R-63 to R-65), branch `upd/credit` off `build/v1` 146e091. Method:
`protocol-design` (decisions, invariants before code, Foundry harness, mutation, fork tests). Nothing deployed, no
funds moved. Owner-level decisions are marked **owner**; every other decision is delegated to the lane and built on its
default. Numbers marked (guess) are constructor values with that default.

## 0. Facts measured for this spec (2026-11-11, chain 4663, `https://rpc-robinhood.blockmachine.io`, block 111,598,037)

| Fact | Command | Result |
| :--- | :--- | :--- |
| `OrreryAttestor` 0xc18a…2bd0 holds at most 5 attester keys | `cast call $A "MAX_ATTESTERS()(uint256)"` | `5` |
| Keys in use | `attesterCount()` | `1` (Orrery's own prober 0xe044…4eC0, `isAttester` true) |
| Attestor treasury | `treasury()` | `0x5b63…c54c` = `OrreryTreasury` (its `attestor()` is 0xC18a…2Bd0) |
| Attestor owner | `owner()` | `0x006d…1A3A` |
| Verification fee | `fee()` / `feeToken()` | `5000000` (5 USDG) / USDG `0x5fc5…1168` |
| ORRY set on the treasury | `OrreryTreasury.orry()` | `0x0` (coin not set; ORRY `0x8527…6aA4` is still on its Pons V2 curve) |
| How `verifyWithOrry` records a verification | `OrreryTreasury.sol:220` | calls `OrreryAttestor.payVerification` as itself; the attestor records fee 0 and moves no USDG only when `msg.sender == treasury` (`OrreryAttestor.sol:101`) |

## 1. Two findings against the plan (do not build as written)

**F1. "Active set of 20, applied each epoch with `setAttester`" cannot work.** `OrreryAttestor.MAX_ATTESTERS` is 5
(constant, contract immutable) and one key is in use. At most 4 third-party keys fit, not 20.
Resolution built here: `AttesterRegistry` takes **one** attester key on `OrreryAttestor` (set once with
`setAttester(registry, true)`) and forwards results from the probe keys of the current epoch's top 20. The weekly
"apply" becomes a permissionless `rollEpoch()` on the registry; the ops job calls it and checks state. The owner's
intent ("open to anyone with 1M ORRY, at most 20, top positions", R-47, "or find a better concept") is kept.
Consequence: `OrreryAttestor` stores the registry as the attester of a forwarded result; the registry's own event names the
staker and probe key, and the check API reads it from the indexer.

**F2. "Fee share through a splitter set with `setTreasury`" breaks verification paid in ORRY.** Once
`OrreryAttestor.treasury` is a splitter, `OrreryTreasury.verifyWithOrry` calls `payVerification` from an address that
is no longer the treasury, so the attestor tries `transferFrom(OrreryTreasury, splitter, 5 USDG)` with no allowance and
reverts `TransferFailed` (reproduced in `test/credit/fork/CreditFork.t.sol::test_fork_F2_oldPlanBreaksTreasuryRoute`).
Resolution built here: `AttesterFeeSplitter` is the attestor treasury **and** carries its own ORRY verification route
(`verifyWithOrry`, same quote signers as `OrreryTreasury` read live, its own EIP-712 domain, same 25 a day cap, burn
source 40). Switching the treasury is then an ops step paired with a services switch (section 6.4). Until that switch
nothing changes.

## 2. Decisions

| # | Decision | Default built | Level |
| :-- | :--- | :--- | :--- |
| A1 | How 20 attesters reach `OrreryAttestor` | One registry key forwards results from active probe keys (F1) | owner (confirms the R-47 "better concept") |
| A2 | Minimum stake | 1,000,000 ORRY, constructor | owner (R-47) |
| A3 | Active set | top 20 by locked stake at `rollEpoch`, ties to the earlier lock; recomputed weekly (epoch 7 days, constructor) | owner (R-47) |
| A4 | Candidate bound | at most 1,000 registered stakers (1B supply / 1M minimum), so `rollEpoch` is bounded (gas measured in tests) | delegated |
| A5 | Exit | `requestUnlock` leaves the active set at once; stake returns to its owner 14 days later (constructor) | delegated (plan) |
| A6 | Quality without slashing | the attestor owner may `exclude(staker, reasonHash)`: out of the current set and of the next roll; stake untouched; results already counted stay counted | delegated (plan, capped) |
| A7 | Earnings | a share of every USDG the splitter receives (verification fees through `setTreasury`, optionally check-pack payments by x402 `payTo`) booked to the epoch it arrives in, paid pro rata to distinct agents each attester forwarded in that epoch | owner (share) |
| A8 | Attester share | 3,000 bps of USDG received (guess, constructor) | owner |
| A9 | Results counted | one per (attester, agent, epoch), so spamming one agent earns nothing extra | delegated |
| A10 | Epoch with no results | its attester pool goes to `OrreryTreasury` by a permissionless `releaseUnused(epoch)` | delegated |
| A11 | Treasury switch (F2) | `AttesterFeeSplitter` carries the ORRY verification route; `setTreasury` only together with the services switch | owner (approves the ops step) |
| A12 | Disagreement bar | 10% of an attester's results against the majority in an epoch (guess); computed off chain by the epoch job, applied with `exclude` | owner |
| C1 | Who creates credit pools | the treasury owner, through `CreditPoolFactory` (each pool immutable) | owner |
| C2 | Custody | pattern C: one `CreditPool` per market holds its lenders' USDG and its lines' ORRY bonds, nothing else (R-27, X-3) | owner (R-27) |
| C3 | Bond | ORRY, posted by the agent's ERC-8004 owner, behind one agentId per pool | owner (U7, utility 3) |
| C4 | Line limit | lowest of: bond USD value x tier multiple; `maxLineUsdg` (guess 10,000 USDG); `maxLineBps` of the pool (guess 1,000 = 10%) | owner (numbers) |
| C5 | Tiers | multiple of the bond by principal repaid in this pool: 0 USDG 1.0x, 250 USDG 1.5x, 2,500 USDG 2x, 25,000 USDG 3x (guess, constructor) | owner |
| C6 | Minimum bond | 25 USD of ORRY at the oracle (D6's enrollment figure), checked at draw | owner |
| C7 | Interest | fixed APR per pool, simple interest per line (guess 1,200 bps); paid interest first, then principal | owner (rate) |
| C8 | Orrery's take | 1,000 bps of interest paid (guess), sent to `OrreryTreasury` in the same call (revenue split 70/30 there) | owner |
| C9 | Term | debt must be zero 30 days after the line went from zero to positive (guess); default possible 7 days later (guess); new draws never move the due date | owner |
| C10 | Default | permissionless `liquidate` after due + grace: the **whole** bond goes to the pool's lenders pro rata; unpaid debt is written off and stays owed as a recovery that later revenue repays | owner (full forfeit vs loss-sized) |
| C11 | Price risk | no liquidation on price: a fall in ORRY only lowers the limit (no new draws); default is by time only, so a TWAP move cannot trigger one | delegated |
| C12 | Repayment | the agent's x402 `payTo` is its line's `CreditRevenueRouter`; `sweep()` sends 5,000 bps (guess) of what it holds to repay, the rest to the agent wallet; anyone may also `repay` | owner (share) |
| C13 | Lender accounting | value = cash + outstanding principal; interest counts when paid (no unrealized income); shares not transferable; virtual offset 1e6 | delegated |
| C14 | Admin | factory owner = treasury owner may `retire` a pool (one way: no new deposits or draws); nothing else | delegated |
| C15 | Releases | `attesters` (registry, splitter), `credit` (lender pools, new), `credit-bond` (lines and bonds) | delegated |
| C16 | Trailing revenue cap | not in v1: the router records revenue, so a later pool can use it; v1 uses bond, tiers and caps | delegated |
| B1 | Burn sources | 40 = ORRY verification through `AttesterFeeSplitter`; 41 to 49 reserved | delegated (board) |

## 3. Contracts (`contracts/src/credit/`)

### 3.1 `AttesterRegistry`

Immutables: `orry`, `attestor` (`OrreryAttestor`), `minStake`, `maxActive` (20), `epochLength`, `unlockDelay`, `genesis`.
State per staker: `amount`, `lockedAt` (first lock), `probeKey`, `unlockAt` (0 = staked), `excludedUntilEpoch`.
`probeOwner[probeKey]`. Candidate list (swap-and-pop, at most `MAX_CANDIDATES` = 1,000). Per epoch: `rolled`,
`active[]`, `isActive[epoch][staker]`, `results[epoch][staker]`, `totalResults[epoch]`, `counted[epoch][staker][agent]`.

- `stake(amount, probeKey)`: first stake needs `amount >= minStake`, a fresh nonzero probe key not used by anyone and not
  the staker; exact balance delta check (fee-on-transfer refused). Top-up with `probeKey == 0`.
- `setProbeKey(newKey)`: change key; the old key stops forwarding at once.
- `requestUnlock()`: leaves candidates and the current active set; `unlockAt = now + unlockDelay`.
- `withdraw()`: after `unlockAt`, all to `msg.sender` (the staker), entry deleted.
- `rollEpoch()`: anyone, once per epoch index `(now - genesis) / epochLength`; picks the top `maxActive` candidates with
  `amount >= minStake`, not unlocking, `excludedUntilEpoch < epoch`, ranked by amount then earlier `lockedAt` then
  address. Emits `EpochRolled(epoch, active)`.
- `attest(agentId, a)`: `msg.sender` must be the probe key of a staker active in the current, rolled epoch; forwards to
  `OrreryAttestor.attest`; counts the agent once per epoch for that staker; emits `ResultForwarded`.
- `exclude(staker, reasonHash)`: only `OrreryAttestor.owner()`; removes from the current active set and from the next roll
  (`excludedUntilEpoch = current + 1`). Never touches stake.

### 3.2 `AttesterFeeSplitter`

Immutables: `usdg`, `treasury` (`OrreryTreasury`), `attestor`, `registry`, `shareBps`. Set as `OrreryAttestor.treasury`.

- `split()`: anyone; `fresh = balance - booked`; `toAttesters = fresh * shareBps / 10000` (down) booked to the current
  epoch; the rest transferred to `OrreryTreasury` in the same call.
- `claim(epoch)`: after the epoch has ended; pays `pool[epoch] * results[epoch][me] / totalResults[epoch]` (down) once.
- `releaseUnused(epoch)`: anyone, an ended epoch with zero results: its pool to `OrreryTreasury`.
- `verifyWithOrry(agentId, expectedOwner, orryAmount, quoteId, expiry, sig)`: EIP-712 domain
  `{name "Orrery Attester Fees", version "1"}`, type `VerificationQuote(address payer,uint256 agentId,uint256 orryAmount,
  bytes32 quoteId,uint64 expiry)`; signer must be `OrreryTreasury.isQuoteSigner`; quote once; 25 a day; `burnFrom` the
  payer with an exact supply check; then `payVerification` as the attestor's treasury (fee 0 recorded, no USDG moves).
  Reverts `CoinNotSet` while `OrreryTreasury.orry()` is zero.

### 3.3 `CreditPoolFactory`

`createPool(Params)` only by `OrreryTreasury.owner()`; records `isPool`; `retire(pool)` forwards a one-way retire.

### 3.4 `CreditPool` (one market)

Immutables: `usdg`, `orry`, `oracle` (`IOrryPriceOracle`), `identity` (ERC-8004), `attestor`, `treasury`, `factory`,
and the params (`aprBps`, `feeBps`, `repayBps`, `term`, `grace`, `minBondUsd`, `maxLineUsdg`, `maxLineBps`, tier tables).
State: `cash`, `totalPrincipal`, `totalShares`, `shares[lender]`, ORRY accumulator for seized bonds, lines by agentId
(`bondOwner`, `bond`, `principal`, `interest`, `lastAccrual`, `dueAt`, `repaid`, `recovery`, `defaulted`, `router`).

| Function | Who | Checks and effects |
| :--- | :--- | :--- |
| `deposit(assets)` | lender | not retired; shares = assets x (S + 1e6) / (V + 1), down; nonzero; pull exact |
| `withdraw(shares)` | lender | assets = shares x (V + 1) / (S + 1e6), down; at most `cash`; never paused |
| `claimOrry()` | lender | seized-bond ORRY owed to its shares |
| `postBond(agentId, amount)` | agent owner | first post sets `bondOwner = msg.sender = ownerOf(agentId)` and deploys the line's router; later posts only by `bondOwner`; not defaulted; exact pull |
| `withdrawBond(amount)` | bondOwner | debt (principal + interest) zero |
| `draw(agentId, amount)` | bondOwner, still `ownerOf` | not retired, not defaulted, `isVerified`, bond USD at least `minBondUsd`, debt + amount within the limit, amount within `cash`; USDG to `getAgentWallet(agentId)` (owner when unset); sets `dueAt` when debt was zero |
| `repay(agentId, amount)` | anyone | interest first (fee share to the treasury), then principal, then recovery; pulls only what is owed; `dueAt = 0` at zero debt |
| `liquidate(agentId)` | anyone | debt nonzero and `now > dueAt + grace`; whole bond to lenders' accumulator; principal written off; recovery = principal + interest; line defaulted (terminal) |
| `retire()` | factory | one way; blocks `deposit` and `draw` |

Value `V = cash + totalPrincipal`. Interest per line: `principal x aprBps x dt / (10000 x 365 days)`, rounded up.

### 3.5 `CreditRevenueRouter` (one per line)

Immutables: `pool`, `usdg`, `agentId`, `repayBps`. `sweep()`: anyone; `toPool = min(owed, balance x repayBps / 10000)`
repaid through `pool.repay`; the rest to the agent wallet (owner when unset) with a low-level transfer, kept for the next
sweep if that transfer fails. Records `revenue` (lifetime) for later use (C16).

## 4. Invariants (mapped to tests in section 8)

Attesters:
- **AT-1** After `rollEpoch`, at most `maxActive` stakers are active; each has `amount >= minStake`, is not unlocking and
  not excluded; no candidate left out ranks above one taken.
- **AT-2** Stake leaves only through `withdraw`, only to the staker, only after `unlockAt`.
- **AT-3** For every ended epoch, the sum claimed is at most `pool[epoch]`, each claim equals
  `floor(pool x results / totalResults)`, and an epoch with results is never released to the treasury.
- **AT-4** No function moves a staker's ORRY anywhere but back to that staker (no slashing). The registry's ORRY balance
  equals the sum of stakes.
- **AT-5** Only the probe key of a staker active in the current rolled epoch can forward; each (staker, agent, epoch) is
  counted once; `totalResults` is the sum of `results`.
- **AT-6** Every USDG the splitter receives is either booked to an epoch pool (at most `shareBps` of it) or sent to
  `OrreryTreasury` in the same `split`; the splitter's balance equals booked minus claimed minus released.
- **AT-7** The splitter's ORRY route uses each quote once, burns exactly the quoted ORRY, and records at most 25 a day.

Credit:
- **CR-1** `usdg.balanceOf(pool) >= cash` always; donations never change share value.
- **CR-2** `totalShares` is the sum of lenders' shares; `totalPrincipal` is the sum of open lines' principal.
- **CR-3** A bond leaves only to its `bondOwner` with zero debt, or to the pool's lenders on that line's default.
- **CR-4** At each draw, principal + interest of the line is at most its limit, and its limit at most every cap.
- **CR-5** Default only when debt is nonzero and the time is past `dueAt + grace`; anyone may call it.
- **CR-6** A router sends the pool at most what the line owes; the rest goes only to the agent wallet (or owner).
- **CR-7** Orrery's take is `feeBps` of interest paid, never principal, never recovery of principal.
- **CR-8** No admin function moves deposits, bonds, debt or seized ORRY; `retire` only blocks deposits and draws.
- **CR-9** Withdrawals and claims are never blocked by `retire`; a withdrawal is limited only by `cash`.
- **CR-10** ORRY held by a pool equals open bonds plus seized ORRY not yet claimed (up to rounding dust, always in the
  pool's favour).
- **CR-11** Without defaults, a lender's assets never fall: value per share is non-decreasing across deposits, draws,
  repayments and withdrawals.

## 5. Money flow and rounding

- Splitter: Orrery receives `fresh - floor(fresh x shareBps / 10000)`; claims round down, dust (at most one base unit
  per attester per epoch) stays in the splitter.
- Credit: shares round against the caller (down on deposit, down on withdraw); interest rounds up; the fee rounds down;
  seized ORRY per share rounds down, dust stays in the pool.
- Example (defaults): a 1,000 USDG line drawn for 30 days at 12% accrues 9.863014 USDG; Orrery takes 0.986301,
  lenders 8.876713.

## 6. Services

1. Migration `028_credit.sql`: attester stakes, epochs, active sets, forwarded results, fee pools and claims; credit pools,
   lender positions, lines, events. `029_credit_index.sql`: indexer cursor and read indexes.
2. `credit-config.ts`, `credit-indexer.ts`, `credit-api.ts`; bin `credit-indexer.ts`.
3. API (behind the release switch): `GET /v1/attesters`, `GET /v1/attesters/:address`, `GET /v1/attesters/epochs/:epoch`
   (`attesters`); `GET /v1/credit/pools`, `GET /v1/credit/pools/:address` (`credit`); `GET /v1/credit/lines/:agentId`
   (`credit-bond`). Positions of a wallet (`GET /v1/credit/accounts/:address`) are never held.
4. Epoch job `scripts/credit-epoch.ts`, dry run only: reads the chain and the index, prints the ranked set the next roll
   will take, each attester's results and disagreement rate against the bar, the exclusions it would propose, the
   splitter's pending split, and the treasury switch checklist (F2). It sends nothing.

## 7. Web

Routes `/dashboard/attesters`, `/dashboard/credit` in the dashboard sidebar (no top nav entry, board rule), behind
`attesters` and `credit`/`credit-bond`. Wallet brand-neutral (EIP-6963), design system "Current Limit".

## 8. Test plan

Unit per function and named revert; invariant handlers for the registry plus splitter and for the pool plus routers; a
deterministic deep run; mutation (`contracts/mutate_credit.py`); fork on 4663 against the real `OrreryAttestor`, USDG,
ORRY and ERC-8004 registry. Results in section 9.

## 9. Results (2026-11-11, branch `upd/credit`)

| Layer | Command | Result |
| :--- | :--- | :--- |
| Unit, invariant, deep run (via IR) | `heavy forge test --match-path 'test/credit/*' --no-match-path 'test/credit/fork/*'` | 67 passed, 0 failed (9 invariants, 256 runs, depth 120); deep run 4,000 actions: 64 rolls, 141 forwards, 29 attester claims, 61 draws, 8 defaults |
| `rollEpoch` at 1,000 candidates (worst order) | `test_rollEpoch_gasAtMaxCandidates -vv` | 14,654,090 gas via IR, warm slots; about 4.2 M more cold on chain, under the 32 M transaction cap |
| Mutation | `python3 mutate_credit.py` | 128 mutations: 126 caught, 2 equivalent (header of the script) |
| Fork 4663, block 111,618,325 | `forge test --match-path 'test/credit/fork/*' --fork-url <official RPC via forwarder>` | 6 passed: facts, F1, F2, attesters end to end, the splitter's ORRY route with a real burn, Credit end to end |
| Services | `tsc`, `vitest run test/credit.*` | typecheck 0; 12 passed (5 unit, 7 integration on anvil and Postgres) |
| Web | `tsc`, `copy-lint`, `vitest packages/web`, `next build` | clean, 142 files clean, 14 passed, build ok |
| Walk | `scripts/walk/credit-walk.mjs` held and open | lend, withdraw, draw, repay, stake as attester, held exits; 8 screenshots at 1440 and 375, no horizontal overflow |

Harness findings fixed during the build: the ORRY checkpoint of a lender rounded down, so the sum of claimable ORRY could
exceed what was seized by one unit per lender and the last claim would revert (CR-10, now rounded up); `rollEpoch`
cost 30 M gas at 1,000 candidates with an insertion list (now a 20-slot heap); tiers by repaid principal could be
farmed by drawing and repaying in one block (now principal times days outstanding, capped at the term).

## 10. Owner questions (relayed by the orchestrator)

A1, A7/A8, A11, A12, C1, C4, C5, C6, C7, C8, C9, C10, C12 as in section 2.
