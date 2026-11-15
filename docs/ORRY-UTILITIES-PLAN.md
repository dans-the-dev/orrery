# ORRY utilities (proposal)

Date: 2026-11-08 (WIB). Status: proposal. Built since: item 13 pay-as-you-go checks (2026-11-10, services and web, release
`payg-checks`, held). Relayed by the Orrery session: the owner approved
utilities 1 to 9 ("A") and asked for more, quoted: "tambahkan utility lain yg membuat users tetap membeli walau harga
nya sudah naik. utility yg membuat sejumlah kecil ORRY bernilai". Items 10 to 15 are the Orrery session's proposals
for that ask. The principle behind them: price every use in USD and pay it in ORRY at the hub TWAP (R-28), so the ORRY
needed per action follows the price and a small balance keeps covering actions after a rise.

## Map

| # | Utility | Mechanism | Contract or service | Proposed wave |
| :-- | :--- | :--- | :--- | :--- |
| 1 | Stake for a monthly free check quota (merchants) | quota by USD value of stake | services (reads `OrryStaking`) | with update wave 2 (facilitator) |
| 2 | Third-party attesters | stake ORRY to run an attester, earn part of the verification fee; no slashing (owner) | new `AttesterRegistry` + `OrreryAttestor` role use | with Credit (wave 7) |
| 3 | Credit operator first-loss bond in ORRY | bond posted in ORRY (U7) | Credit contracts | wave 7 (Credit) |
| 4 | Facilitator fee discount for ORRY stakers or payers | discount tier by USD stake | facilitator (services) | update wave 2 |
| 5 | Agent Launch priority by stake | allocation or early access weighted by stake | Agent Launch | second update (T3) |
| 6 | Verified merchant badge and directory | gated by a USD stake | services + web | update wave 2 |
| 7 | ORRY cashback | a small share of USDG fees returned in ORRY from buyback output | router or buyback change | with R1 |
| 8 | Referral rewards in ORRY | for a fixed period after sign-up | services + Reward Pool | with C1 |
| 9 | Policy template market | templates sold for ORRY, part burned | new `TemplateMarket` | with C2 |
| 10 | USD thresholds everywhere | stake tiers, gates and quotas by USD value at the TWAP | `FeeTiers` (R1) and every gate | now, before R1 contracts freeze their tiers |
| 11 | ORRY as an x402 payment asset | micro payments through the own facilitator; Permit2 since the Pons token has no EIP-3009 | facilitator | update wave 2 |
| 12 | ERC-4337 paymaster accepting ORRY | agents pay operation gas in small ORRY amounts | new paymaster (EntryPoint 0.7 and 0.8 on 4663) | with R2 |
| 13 | Pay-as-you-go checks | one signed check paid in ORRY at a USD price | treasury quote path + API | with ORRY launch (services only) |
| 14 | Burn-to-boost | burn a USD amount of ORRY to boost a post, agent or listing for 24 h | `OrryChat.promote` generalised | with C1 |
| 15 | Day or week passes | premium features paid in ORRY and burned | services + a small burn contract | with C1 |

## 1. Owner answers (2026-11-08)

R-44: utilities 1 to 15, all three small-amount groups. R-45: cashback and referrals from 10% (guess) of the buyback's
ORRY output before the 50/50 split. R-46: order as in the map. R-47: attesters as below.

## 2. Third-party attesters (R-47)

An attester probes registered agents' endpoints and writes liveness results on chain through `OrreryAttestor`; checks
show them. Today Orrery's own key is the only one.

- Entry: anyone locks at least 1,000,000 ORRY in `AttesterRegistry` (the owner's figure) and registers a probe key.
- Active set: the top 20 by locked stake, recomputed at the start of each weekly epoch; ties go to the earlier lock. Only
  active attesters' results count and earn.
- Earnings: a share of the verification fee and of paid checks for the agents whose results an attester signed in the
  epoch, split by results signed; the share is a constructor value (guess 30% of those fees), the rest stays revenue.
- Quality without slashing: several active attesters probe each agent; an attester whose results disagree with the
  majority more than a bar (guess 10% of its results in an epoch) is left out of the next epoch's active set, and the
  treasury wallet can remove a key that signs for an agent it never probed (proof from probe logs). Nothing is taken from
  the stake.
- Exit: leaving or falling out of the top 20 stops new earnings; the stake unlocks 14 days after the request.
- Orrery's own attester stays active and outside the 20.
- Invariants (draft): AT-1 at most 20 active per epoch, all at or above the minimum, ranked by stake; AT-2 a stake leaves
  only to its owner after the cooldown; AT-3 fee shares paid equal the epoch's results signed times the rate; AT-4 no
  function takes stake.

## 3. Referral program, strengthened (R-53 to R-56)

Relayed by the Orrery session (owner: "Apakah program referal kita bisa di perkuat?", then "A" for all eight points);
numbers chosen by the owner in the orchestrating session.

| Point | Rule |
| :--- | :--- |
| Trigger | Paid activity, not sign-up (Orrery is wallet-only): the referrer earns 20% (R-53) of each fee the referee pays (check packs, verifications, market fees) for 90 days from the link, valued in USD at payment and paid in ORRY at the TWAP |
| Referee | 10% fee discount for 90 days (R-54) |
| Weights | merchant and integration referrals count twice; a referrer with at least 1,000 USD of ORRY earning stake gets 1.25 times (R-56); the largest share is 20% x 2 x 1.25 = 50% of a fee, so self-referral always loses money (it also pays 90% of the fee itself) |
| Attribution | `ReferralRegistry`: the referee's link to a referrer is fixed at its first paid action (an on-chain `link` by the referee, or a referrer field in a signed quote), never changed afterwards; a referrer cannot refer itself (same address) |
| Funding | the cashback sink (R-45, B-1) only, never the treasury owner's share; campaigns may add Reward Pool ORRY. When the sink holds less than the accrued rewards of a claim period, rewards are paid pro rata |
| Limits | at most 1,000 USD of ORRY per referrer per calendar month (R-55); each accrual claimable 30 days later; referees funded directly by their referrer are left out by the indexer (heuristic, published rule) |
| Claim | `ReferralRewards.claim()`; `ClaimAll` holds no funds, so a later stateless ClaimAll version can include it without any migration |
| Tiers (guess) | by referred volume over 90 days: 1,000 USD, 10,000 USD and 50,000 USD; a referral leaderboard with masked addresses; the top tier gets the Discord "Ambassador" role |
| Discord | `/referral` returns the member's personal link (the existing interactions endpoint, `services/packages/server/src/discord.ts` on `build/v1`) |

Invariants (draft): RF-1 a link is set once and never changes; RF-2 a reward is at most 50% of the fee it comes from and
only from fees paid within 90 days of the link; RF-3 per referrer per month, paid plus accrued is at most 1,000 USD at
accrual prices; RF-4 an accrual becomes claimable only 30 days later; RF-5 rewards come only from the cashback sink or
an explicit Reward Pool campaign. Wave: with C1 (the sink and the Reward Pool), per R-46.
