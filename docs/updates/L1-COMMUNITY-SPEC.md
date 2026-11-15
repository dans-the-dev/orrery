# L1 Community: spec, decisions, invariants

Date: 2026-11-11 (WIB). Lane L1 of the 2026-11-11 run (board `~/.claude/orchestrator/PAPAN-2026-11-11-orrery-updates.md`).
Branch `claude/upd-community-80ba98` off `build/v1` 00a5c95. Nothing deployed, no funds moved, no keys made.

Sources: `docs/ORRY-CHAT-PLAN.md` (C1, C2, missions, Achievement Board), `docs/ORRY-UTILITIES-PLAN.md` items 7, 8 (with
section 3), 9, 14, 15, decisions R-31 to R-34, R-39 to R-45, R-53 to R-56 in `docs/ORRY-BUILD-SPEC.md` section 1, blocker
B-1 in `contracts/src/orry/OrryBuyback.sol` (read only). Launch contracts are not touched (R-10).

## 1. What is built

| Contract (`contracts/src/community/`) | Job | Plan item |
| :--- | :--- | :--- |
| `RewardPool` | per-asset pool; events engine (create, publish winners, 48 h check window, one replacement, expire); custody for achievements | C1, R-31, R-33, R-42, R-50 |
| `OrryAchievements` | Achievement Board: reward per user, recipient cap, on-chain (verifier) and listed kinds, first come first served, leftovers back to the pool | R-40 to R-43, weekly quests (C2) |
| `verifiers/StakeUsdVerifier` | condition "earning stake worth at least X USD" | R-41 |
| `verifiers/VerifiedAgentVerifier` | condition "owns an agent verified by `OrreryAttestor`" | R-41 |
| `OrryChat` | rooms (open and staker rooms), `post`, `tip`, `report` with hide threshold | C1, C2, R-31, R-32 |
| `OrryNames` | one unique name per address, paid in ORRY at a USD price to the pool | C1 |
| `OrryBoost` | burn-to-boost a post, an agent (agent promotion) or a template listing for 24 h units | utility 14, C2 promotion |
| `OrryPasses` | day and week passes paid in ORRY and burned | utility 15 |
| `TemplateMarket` | policy templates sold for ORRY at a USD price, part burned, rest to the creator | utility 9 |
| `ReferralRegistry` | referee to referrer link, set once (by the referee, or by its EIP-712 or EIP-1271 signature) | utility 8, RF-1 |
| `CashbackRewards` | the B-1 cashback sink: cashback and referral accruals in USD, monthly claim periods, 30 day hold, pro rata | utilities 7, 8, R-45, R-53 to R-56 |
| `interfaces/IRewardPool` | funding interface for lane L2's `DataFeeSplitter` (committed first, d76cb86) | R-50 |

USD prices are USDG base units (6 decimals), converted to ORRY with the R1 `OrryPriceOracle` (`IOrryPriceOracle.orryFor`,
the hub's 30 minute mean tick, R-28); every paid call takes a caller `maxOrry` and reverts above it. While the oracle is not
ready, paid calls revert `PriceNotReady` (no fallback price). Burns emit `IOrryBurnEvents.Burned(source, amount)` with new
sources 8 (boost), 9 (passes), 10 (template market). Source 7 is already `MerchantSplitter`; `ORRY-DATA-PLAN.md` section 3 also
names 7 for `DataFeeSplitter` (finding sent to lane L2).

## 2. Decisions taken in this lane (delegated by the brief; numbers are constructor values)

| Id | Decision | Default (guess unless sourced) |
| :--- | :--- | :--- |
| L1-1 | The admin of pool, achievements, chat rooms and the cashback sink is one address, the treasury wallet (R-33), held by `RewardPool` and read live by the others; transferable two step (`transferAdmin`, `acceptAdmin`), so a key can be rotated. `CashbackRewards` has its own two-step admin and a publisher key the admin sets | treasury wallet |
| L1-2 | Event: `publishWinners` before the deadline, at most `MAX_WINNERS` unique winners, sum at most the locked amount; the unpublished remainder returns to the free balance at once. One replacement during the check window, sum at most the published sum, and it restarts the 48 h window | `MAX_WINNERS` 100, `CHECK_WINDOW` 48 h (R-33), `MAX_LOCK_BPS` 2500 (R-33) |
| L1-3 | A prize is pulled by its winner (`claim`, `claimTo`) or pushed to the winner by anyone (`claimFor`); no sweep of unclaimed prizes, so a published prize always belongs to its winner | none |
| L1-4 | Event deadline at most `MAX_DURATION` ahead, so nothing is locked for ever | 365 days |
| L1-5 | Achievements: `rewardPerUser x maxRecipients` locked at creation through the pool (same 25% cap). On-chain kinds pay on `claim(id, data)` when the verifier says yes in that block. Listed kinds: the admin publishes completers in non-decreasing completion time, total at most `maxRecipients`, no later than `deadline - CHECK_WINDOW`; each becomes claimable 48 h after its batch; the admin may unlist an address during its 48 h window (to fix a mistake), which frees the slot. Claims stop at the deadline; `close` returns every unpaid slot to the free balance | `MAX_RECIPIENTS` 100,000 |
| L1-6 | Chat: room 0 is open; the admin creates further rooms with a USD minimum earning stake (staker rooms, C2); rooms are never edited or deleted. Text 1 to `maxTextBytes` bytes. The author of each post is stored (tips and reports need it); the text is only in the event. Self tips revert. Report gate is ORRY (R-32 names 10,000 ORRY), not USD | post 0.01 USD, 1,000 bytes, tip cut 500 bps, 5 reporters, 10,000 ORRY (R-32 guesses) |
| L1-7 | Names: `[a-z0-9_]`, 3 to 20 bytes, lowercase only (no case or look-alike duplicates); changing frees the old name; no transfer, no expiry | 1 USD (plan guess) |
| L1-8 | Boost: kinds 1 post, 2 agent (agent promotion, C2), 3 template listing; 1 to 30 days per call; days stack from the later of now and the current end; targets are not checked on chain (a boost of nothing only burns the payer's ORRY; the site shows real targets only) | post 0.50 USD, agent 5 USD, template 2 USD per 24 h |
| L1-9 | Passes: one premium pass, bought as day or week units (1 to 52 per call), for any account (gifts); perks are a services config: CSV export of the holder's own history and a pass badge in chat | day 1 USD, week 5 USD |
| L1-10 | Template market: price 1 to 1,000 USD per licence; the creator lists, reprices, delists, relists; a buyer holds one licence per template; `burnBps` of each sale is burned and the rest goes to the creator; creators cannot buy their own | burn 2000 bps, min 1 USD, max 1,000 USD |
| L1-11 | Referral link: set once by the referee (`link`) or by its signature (`linkWithSig`, EIP-712, EIP-1271 for Safe accounts) relayed by anyone; never changed; no self link | none |
| L1-12 | Cashback and referral accruals are computed by the services indexer from fees actually paid and posted on chain by a publisher key: each record carries the payer or referee, the fee in USD, the time it was paid and its source reference (idempotent). On chain: reward at most `MAX_SHARE_BPS` of its fee (cashback at most `MAX_CASHBACK_BPS`); a referral record must match the registry link and fall in `[linkedAt, linkedAt + 90 days)`; referral USD per referrer per calendar month at most `MONTHLY_CAP_USD` | 5000 bps (RF-2), cashback ceiling 1000 bps, 90 days (R-53), 1,000 USD (R-55) |
| L1-13 | Claim periods are UTC calendar months of the accrual. A month opens 30 days after it ends (`HOLD`, R-55: every accrual waits at least 30 days). Opening (anyone) prices the month's USD total in ORRY at the oracle and reserves `min(needed, free)`: pro rata when short. The admin may void an account's month before it opens. Unclaimed reserve returns to the free balance `CLAIM_WINDOW` after opening | `HOLD` 30 days (R-55), `CLAIM_WINDOW` 365 days |
| L1-14 | Rates that are services config, not contract values: referral 20% (R-53), referee discount 10% for 90 days (R-54), merchant weight 2 and staker weight 1.25 at 1,000 USD of stake (R-56), cashback 2% of USDG fees, tiers 1,000 / 10,000 / 50,000 USD (plan guesses) | as listed |
| L1-15 | "Most active" (R-34) and every mission ranking count protocol fees paid in USD from indexed chain data; the services publish the ranking, its inputs and the rules hash, the admin publishes winners | none |

## 3. Admin powers, complete list

Admin (treasury wallet): create events and achievements within the 25% cap; publish winners or completers; one winner
replacement per event and unlisting during a check window; create chat rooms; transfer the admin role (two step).
Cashback admin: set the publisher key; void an account's month before it opens; transfer its role (two step).
Publisher: post accruals within the caps above.
Nobody can: withdraw or move pool or sink funds other than the payouts above, change any fee, price, cap or window after
deployment, edit or delete a message, a name, a link, a licence or a pass, or pause anything.

## 4. Invariants (written before the code; ids map to tests in `contracts/test/community/`)

Reward Pool and events
- C-1 A message is only an event plus its author; no function edits or deletes one; each post pays exactly
  `orryFor(postFeeUsd)` to the pool and nothing above the caller's maximum.
- C-2 For every asset: `free + locked` equals what the pool booked, and the pool holds at least that much.
- C-3 An event's locked amount ends as paid prizes plus amounts returned to the free balance (remainder at publish, the
  rest at expiry); paid never exceeds published.
- C-4 Only the admin creates events and publishes winners; a prize leaves only to its winner (or the winner's chosen
  address) and only after its check window.
- C-5 A staker-room post succeeds only when the poster's earning stake is worth at least the room minimum at that block.
- C-6 Names are unique; name fees and tip cuts reach the pool exactly; boost, pass and template burns equal what was
  charged times their burn share.
- C-7 An event locks at most `MAX_LOCK_BPS` of the asset's free balance at creation.
- C-8 At most one prize per address per event.

Achievements
- A-1 Locked at creation = `rewardPerUser x maxRecipients`, at most 25% of the free balance of that asset.
- A-2 Paid at most `maxRecipients x rewardPerUser`; one payout per address per achievement.
- A-3 After the deadline every unpaid slot returns to the free balance, once.
- A-4 An on-chain claim pays only when its verifier condition holds at that block.
- A-5 A listed claim pays only after its check window, before the deadline, to a listed address.
- A-6 Nothing else moves pool assets (C-2 extended per asset).

Referrals and cashback
- RF-1 A link is set once and never changes; no self link.
- RF-2 A reward is at most 50% of the fee it comes from (cashback at most its own ceiling) and a referral reward only from
  a fee paid within 90 days of the link, to the linked referrer.
- RF-3 Per referrer per calendar month, referral USD accrued is at most 1,000 USD.
- RF-4 An accrual becomes claimable only 30 days after its month ends (so at least 30 days after it accrued).
- RF-5 Rewards come only from the sink's ORRY (buyback share or a Reward Pool campaign payout); reserved plus free
  equals the sink's balance; claims never exceed a month's reserve; each account claims a month once.

## 5. Owner questions (guessed numbers, all constructor or config values)

1. Chat post fee 0.01 USD, text 1,000 bytes, tip cut 5%, reports 5 stakers of 10,000 ORRY (R-32 guesses): keep? Should
   the report gate be a USD value like other gates (utility 10)?
2. Name fee 1 USD, 3 to 20 characters `[a-z0-9_]`: keep?
3. Boost per 24 h: post 0.50 USD, agent 5 USD, template 2 USD: keep?
4. Passes: day 1 USD, week 5 USD; perks CSV export and a chat badge: keep, or other perks?
5. Template market: 20% burned, 80% to the creator, price 1 to 1,000 USD: keep?
6. Cashback rate 2% of USDG fees, on-chain ceiling 10%: keep?
7. Unclaimed cashback and referral reserve returns to the sink after 365 days: keep?
8. Event deadline at most 365 days ahead, at most 100 winners per event, at most 100,000 recipients per achievement: keep?
9. Referral tiers 1,000 / 10,000 / 50,000 USD over 90 days (plan guess): keep?

## 6. Status (2026-11-11)

Built and committed on `claude/upd-community-80ba98`; nothing deployed. Full evidence in the lane report
`~/.claude/orchestrator/laporan/rc-L1-community.md`.

| Layer | Result |
| :--- | :--- |
| Unit (`contracts/test/community/*.t.sol`) | 60 tests, all pass |
| Invariants (`invariant/`) | pool: 3 invariants x 256 runs x 120 depth; cashback: 3 x 256 x 120; both pass. Deterministic deep runs (3,000 weighted actions each) reach every state (published, replaced, paid, expired, closed, listed, unlisted, cap refusals; links, voids, opened, claimed, closed) |
| Mutation (`contracts/mutate_community.py`) | 130 of 130 caught (`contracts/mutate_community.out`). Left out as equivalent: RewardPool's reentrancy guard (every payout sets its flag or reduces the books before the transfer) |
| Fork, 4663 (`fork/CommunityFork.t.sol`) | 4 of 4 pass against the launched ORRY token, the real PoolManager, USDG, ETH/USD feed and ETH/USDG pools, with `OrreryHook`, `OrryStaking`, `OrreryTreasury`, `OrryRewardsRouter`, `OrryBuyback` and `OrryPriceOracle` deployed from source: `burn` and `burnFrom` on the real token, chat fee at the real TWAP, staker room on real staking, boost and template burns, achievement and event payouts, and B-1 end to end (sink set after 48 h, a slice pays 10% to `CashbackRewards`, accruals, the month opens pro rata) |
| Services | typecheck clean; `community-abi` and `community-ledger` unit 16/16; `community.integration` 8/8 (real contracts on anvil, indexer into Postgres, API behind the release switch, publisher) |
| Web | lint and copy-lint clean (121 files), web tests 14/14, `next build` passes with the five `/community` routes; local walk at 1440 and 375 px on the seeded stack, a post sent through the walk wallet, indexed and shown |

Gaps (not built in this lane, outside its paths): the referee discount (R-54) must be applied where prices are made
(`orry-quotes.ts`, `facilitator.ts`; helper `refereeDiscountUntil` in `community-ledger.ts`); the Discord `/referral`
command (`discord.ts`); the indexer heuristic that leaves out referees funded by their referrer (plan section 3, Limits)
is not implemented; market fees paid in ORRY are not counted in R-34 (no USD value is recorded at payment).
