# 03 Economics

Date: 2026-11-06. Inputs are **summary** figures from `01-analysis.md` (Artemis 24 h snapshot of 2026-11-03, cumulative
reports). Recompute from x402scan / Artemis before any public number.

## Size of the payment flow today

| Input | Value |
| :--- | :--- |
| x402 volume, last 24 h (all chains) | $27.8 K |
| x402 transactions, last 24 h | 369.5 K |
| Average payment | ≈ $0.075 |
| Share reported as wash / self-trading (early 2026) | ≈ 50% |
| Genuine volume per day (if half is wash) | ≈ $14 K |

## Revenue model scenarios before the decisions (yearly, illustrative)

Kept for the record; the decided model is in the next section.

| Model | Assumption | Revenue / year | Verdict |
| :--- | :--- | :--- | :--- |
| A. Fee on agent spend, 0.5% | We capture 10% of all x402 volume ($2.78 K/day) | ≈ $5 K | Does not fund anything |
| A'. Same, 1%, 100% of market | Unrealistic upper bound | ≈ $101 K | Still small; volume must grow 10 to 100x |
| B. Paid verification check via x402, $0.002 per check | 1 M checks / month (counterparties checking agents before paying or serving) | ≈ $24 K | Scales with agent traffic, priced like the market's own micro-payments |
| B'. Same at 20 M checks / month | If checks become a default step in SDKs and facilitators | ≈ $480 K | Needs distribution through facilitators |
| C. Operator plans, $29 / month | 200 paying operators (dashboard, alerts, multiple agents, verified badge) | ≈ $70 K | Classic SaaS; slower, steadier |
| D. Bond / attestation fee, $5 one time per verified agent | 20 K agents verified (≈ 1% of claimed 2 M registrations) | ≈ $100 K once | Doubles as Sybil cost |

Gas on 4663 or Base is cents or less per policy write; not material at these sizes (re-measure before deploy).

## v1 model after the decisions (Q2 4663, Q4 paid checks + fee, Q5 no bond, Q9 credit packs), 2026-11-06

Measured inputs: ERC-8004 on 4663 has 21,497 agents, 1,655 distinct owners, 1,482 owners with exactly one agent, top
10 owners hold 90.3%; 1,390 new agents in the last 7 days (`01-analysis.md`, verified). Gas 0.02 gwei, ETH $2,246.

| Line | Unit economics | Example volume | Revenue / year |
| :--- | :--- | :--- | :--- |
| Verification fee, 5 USDG (guess), once per agentId and owner (I5) | Operator pays gas to call `payVerification`; we pay nothing per fee | 10% of today's 1,655 owners verify one agent: 165 | ≈ $825 once |
| Same | | 30% of owners, plus 100 new operators a month | ≈ $8.5 K in the first year |
| Credit pack, $1 for 500 checks (guess) | Settlement gas ≈ $0.004 per pack (85,400 gas); margin ≈ $0.996 per pack | 1 M checks a month = 2,000 packs | ≈ $24 K |
| Same | | 20 M checks a month (checks built into SDKs and facilitators) | ≈ $480 K |

Costs that recur:

| Cost | Size at today's prices | Covered by |
| :--- | :--- | :--- |
| On-chain `attest` per verified agent, at most daily (≈ 60,000 gas, to measure in E3) | ≈ $0.0027 each, ≈ $1 per agent per year | The one-time fee covers about 5 years at today's gas; recheck if gas or ETH rises 5x |
| Relayer gas for pack settlements | ≈ $0.004 per pack | Pack price |
| Prober, API, indexer hosting | Marginal on an existing server (hosting decision open) | Packs |

Reading for 4663: the fee line is small because the real operator base is about 1,500 today; the product's revenue
depends on check volume, which depends on counterparties (merchants, lenders, x402 sellers) adopting the check. Free
reads of `OrreryLens` are possible (I8), so the paid check must stay worth its price through freshness and convenience.
Growth beyond this needs more agents on 4663 or a second chain later.

## Reading

- Fees on spend (model A) only matter if agent payment volume grows by two orders of magnitude. Keep a small hook for it,
  do not depend on it.
- The party that pays for trust is the one taking the risk: the merchant serving an agent, the protocol extending credit,
  the user copying a strategy. B and D charge that party or make the agent pay to be trusted.
- D has a second job: a cost per verified identity is the cheapest Sybil filter available. A refundable, slashable
  bond is stronger but needs a dispute process; not in v1 (Q5).

## Abuse scenarios

| Scenario | Effect | Counter |
| :--- | :--- | :--- |
| Mass-verify fake agents to farm a badge | Badge loses meaning | Per-agent fee (no bond in v1), live endpoint check repeated on a schedule, attestations expire |
| Operator sets a high cap, shows "capped" badge | Badge says nothing | Verifier output states the actual cap numbers, not a yes/no badge |
| Operator raises caps right after a counterparty checked them | Counterparty relied on stale data | Increases wait at least 1 hour (I4), decreases are instant; check result carries `validUntil` |
| Wash payments to fake a track record (phase 2) | Inflated performance | Count only payments to distinct, verified counterparties; weight by verified, paid identities |
