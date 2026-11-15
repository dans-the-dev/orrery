# 02 Open questions and decisions

Each decision is recorded with its date and whether the owner made it or delegated it. Dependency order.

## Decided by workspace rules (no question needed)

| Id | Decision | Source |
| :--- | :--- | :--- |
| W1 | Planning session stops at spec, invariants and handoff brief; another agent writes code | Owner rule 2026-10-30 |
| W2 | No token before a used product | Brief section 7 and workspace practice |
| W3 | No external audit as a gate; layered tests instead | Workspace rule |
| W4 | Wallet connect via EIP-6963, brand-neutral; English shipped text; no disclaimers in UI | Workspace conventions |
| W5 | Build on ERC-8004 + x402, no competing standard | Brief section 7 |

## Q1. What does "KYA" mean in this product (the wedge)?

| Option | What it is | Consequence |
| :--- | :--- | :--- |
| A. Provable policy + liveness (recommended) | Public, on-chain proof of an agent's spending caps and allowlist tied to its ERC-8004 id, plus repeated endpoint checks; paid check API | Crypto-native, no personal data, differs from wallet vendors who keep limits private |
| B. Operator identity (KYC of the agent's owner) | Verify the human or business behind an agent, attest on-chain | Competes with Skyfire / KYAPay, holds personal data, compliance load |
| C. Data product only | Index and score ERC-8004 agents (live, Sybil-filtered), sell the index | Fastest, no contracts, but no wallet and easy to copy |

Decision: **A. Provable policy + liveness** (owner, 2026-11-06). Widened on 2026-11-08 to agent markets on top of
this wedge, in wave order (U2).

## Q2. Starting chain

| Option | Consequence |
| :--- | :--- |
| A. Robinhood Chain 4663 first (workspace default) | ERC-8004 deployed there (verified); payment token USDG; own x402 facilitator needed; agent activity unmeasured |
| B. Base first | Most ERC-8004 and x402 activity; USDC with mainstream facilitators; leaves workspace default |
| C. Both at launch | Most reach, double deploy and indexing cost |

Decision: **B. Robinhood Chain 4663 first** (owner, 2026-11-06; overrides the recommendation of Base). Consequence: the
v1 payment token is USDG, an own x402 facilitator is in scope, and early demand depends on agent activity on 4663, which
is unmeasured. Keep contracts chain-agnostic so Base is a later deploy, not a rewrite.

## Q3. Wallet base

| Option | Consequence |
| :--- | :--- |
| A. ERC-7579 policy module on existing smart accounts (recommended) | Works with Safe (7579 adapter), Kernel, Nexus; we write one module; interoperates with Smart Sessions |
| B. Own minimal smart account | Full control, more code to secure, users must move to our account |
| C. Server-side policy (MPC, custodial) | Fastest to ship, custody and trust load, nothing provable on-chain |

Decision: **A. ERC-7579 policy module** (owner, 2026-11-06).

On-chain check on 4663 (`eth_getCode`, 2026-11-06), addresses taken from memory of vendor docs, so the code found is
present but its identity must be confirmed against vendor docs before deploy: SafeL2 1.4.1 `0x29fc…C762` (24,421 bytes),
Safe7579 adapter `0x7579…0002` (20,014 bytes), Kernel 3.1 factory `0xaac5…E419` (989 bytes), EntryPoint 0.7
`0x0000…a032` and 0.8 `0x4337…f108`, Permit2: code present. Rhinestone Smart Sessions at `0x0000…37DE`: **no code**
(may live at another address or not be deployed on 4663). v1 therefore ships its own policy module and does not depend
on Smart Sessions.

## Q4. Revenue model

| Option | Consequence |
| :--- | :--- |
| A. Paid checks over x402 + one-time verification fee (recommended) | Charges the party needing trust; fee doubles as Sybil cost |
| B. Fee on agent spend (bps) | Near zero at today's volume (`03-economics.md`) |
| C. Operator subscription | Steady but slow; needs a dashboard worth paying for |
| D. Free at start | Adoption first, revenue decided later |

Decision: **A. Paid checks over x402 + one-time verification fee** (owner, 2026-11-06). On 4663 both are paid in USDG.
Prices ($0.002 per check, $5 per verification) are **(guess)** until the economics are reworked with 4663 data.

## Q5. Operator bond

Refundable, slashable bond per verified agent vs flat fee only. Depends on Q1 and Q4.
Decision: **fee only in v1, no bond** (owner, 2026-11-06). Bond reconsidered in v2 with abuse data. Revisited on
2026-11-08 for the token update (T7, ORRY stake) and for Orrery Credit (U7, operator bond as first loss); v1 is
unchanged.

## Q6. SDK languages in v1

TypeScript only vs TypeScript + Python. Decision: **TypeScript first**, Python as a thin wrapper in v1.1 (owner, 2026-11-06).

## Q7. Name

Working folder name `orrery`. Candidates checked 2026-11-06 by RDAP (registry answers, nothing bought):

| Name | Available | Taken | Collision search |
| :--- | :--- | :--- | :--- |
| Proofcap | proofcap.xyz, proofcap.app, proofcap.family | proofcap.com | none found |
| Vowline | vowline.xyz, vowline.family | .com, .app | "Vow" agent skill exists |
| Mandato | mandato.xyz, mandato.family | .com, .app, .ai | generic word |

First decision: Proofcap (owner, 2026-11-06), **superseded the same day**.

Decision: **Orrery**, domain **orrery.tech** (owner, 2026-11-06). The owner already holds orrery.tech (Hostinger,
DNS parked: A 2.57.91.91, NS dns-parking.com, checked 2026-11-06) and released the name from the paused aethernode
project the same day, together with the X handle @orrerytech (still to register; @Orrery is taken) and the GitHub
repo name `orrery`. The ORRY ticker comes with the name but is unused: no token in v1 (W2).

## Integration pass (2026-11-06)

Pairs of decisions that touch the same money or state, tested against each other.

| Id | Conflict | Resolution | Status |
| :--- | :--- | :--- | :--- |
| I1 | Q2 (4663) + Q4 (paid checks over x402): no mainstream facilitator serves 4663 | Own x402 facilitator for USDG on 4663 is in v1 scope | delegated (follows from owner decisions); opened to other merchants by U6 (owner, 2026-11-08) |
| I2 | Q2 + Q4: USDG has no code on 46630 | Same-interface mock token on 46630 for development | delegated |
| I3 | Q3 (ERC-7579) + Q2: Smart Sessions has no code at its known address on 4663 | Own policy module; confirm Safe7579 and Kernel identities on 4663 before relying on them | delegated |
| I4 | Q1 (fresh proof) vs operator flexibility: a cap raised right after a check makes the check stale | Increases and allowlist widening wait a delay, **minimum 1 hour**, operator may set longer; decreases and revoke are instant; check result carries the delay and `validUntil` | **owner, 2026-11-06** |
| I5 | Q4 (one-time fee) vs Q1 (recurring liveness probes) | Fee paid once per `agentId`, valid for the identity's life; a new fee only when the ERC-8004 identity NFT changes owner; probes run at our cost | **owner, 2026-11-06** |
| I6 | ERC-8004 identity NFT is transferable vs policy binding to an account | Binding is void when `ownerOf(agentId)` no longer matches the bound account's owner; check reports `ownerMatches = false` until re-linked and re-verified (I5 fee applies) | delegated |
| I7 | Q4 paid checks vs SDK pre-signing checks by the agent itself | Agent-side policy enforcement is on-chain and free; only third-party check results (signed, with liveness data) are paid | delegated |

## Q8. How the agent pays x402 from a policy-bound account

x402 `exact` payments are EIP-3009 signatures that the facilitator executes directly on the token, which bypasses any
module.

| Option | Consequence |
| :--- | :--- |
| A. Float wallet (recommended) | Module tops up the agent's hot wallet within daily caps and a float ceiling; agent pays x402 normally. Works with any facilitator and token; no per-payee allowlist on float spending |
| B. Pre-authorised payments via ERC-1271 | Each payment registered on-chain first; strict per-payee control; two transactions per payment; needs USDG ERC-1271 support (not verified) |
| C. ERC-4337 validator | Timestamp is banned in validation, daily caps hard; needs a bundler on 4663 |

Decision: **A. Float wallet** (owner, 2026-11-06).

Correction (2026-11-06, review R-M2): the option table first said "worst-case loss = float". That was wrong. With a
stolen signer key the loss per token is bounded by `perDay` per UTC day (`2 × perDay` over any 24 hours) until the
operator revokes; `floatMax` only limits what sits in the hot wallet at one moment.

## Integration pass 2 (after the spec, 2026-11-06)

| Id | Conflict | Resolution | Status |
| :--- | :--- | :--- | :--- |
| I8 | Q4 paid checks vs Q1 public on-chain policy: anyone can read `OrreryLens` for free | The paid check sells what the chain cannot give: a fresh live probe, a signed result with `validUntil`, and one HTTP call without an RPC. Revenue expectations in `03-economics.md` model B are an upper bound; a free third-party checker is possible | delegated, owner informed |
| I9 | Q8 float vs brief's "allowlist contract / address" | Allowlist applies to `execute` calls only; float spending (x402 payees) is bounded by `floatMax` and daily caps, not by payee. Check result states both | delegated (follows from Q8) |
| I10 | I6 binding via ERC-8004 `agentWallet` vs registry upgradeability | The registry is upgradeable by its maintainers; a change to `getAgentWallet` semantics would change our `bound` flag. Pin behaviour in fork tests and re-run them before each deploy | delegated |

## Q9. Check pricing vs settlement gas

Measured 2026-11-06: `eth_gasPrice` on 4663 = 0.02 gwei, ETH = $2,246 (Coinbase spot). A USDG `transferWithAuthorization`
settlement uses about 85,400 gas (measured on a 4663 fork, 2026-09-20, Echo project), so **one settlement costs about
$0.004**, more than the guessed $0.002 per check. The facilitator pays that gas.

| Option | Consequence |
| :--- | :--- |
| A. Prepaid credit packs (recommended) | One x402 payment buys a pack (e.g. $1 for 500 checks); gas once per pack; needs a credit balance per buyer |
| B. $0.01 per check, paid per call | Pure x402, about $0.006 margin, 5x dearer for buyers, exposed to gas rises |
| C. Both | Most flexible, two paths to build and test |

Decision: **A. Prepaid credit packs** (owner, 2026-11-06). Pack size and price stay **(guess)**: $1 for 500 checks.

## Integration pass 3 (independent spec review, 2026-11-06)

Full list in `10-spec-review.md`. Decisions taken while applying it, all delegated (they implement Q1, Q3, Q8 and I4
rather than change them):

| Id | Decision |
| :--- | :--- |
| I11 | A check is a claim about one **signer** (the paying address), not about "agent N". Signers are single-use across all accounts; a public reverse lookup maps signer to session. No activation delay on new sessions is needed because a new session always has a new signer. |
| I12 | Tokens can never be dropped from a session's caps (lower to 0 instead). |
| I13 | Allowlisted calls may not grant rights: approval, permit and delegation selectors, `transfer`/`transferFrom`, Permit2, EntryPoints, the Safe7579 adapter and installed modules are forbidden targets or selectors. |
| I14 | Authority requires the account to report the module installed, live. Checks name the account kind (known Safe7579 or Kernel 3.1, else Unknown) and give Unknown accounts no validity window. |

## Mainnet inputs (owner, 2026-11-08)

| # | Decision |
| :--- | :--- |
| M1 | The mainnet deployer is also the OrreryAttestor owner and the treasury (one key, `~/.secrets/orrery/mainnet-deployer.json`, `0x006dAF26…1A3A`); no `acceptOwnership` step. |
| M2 | Verification fee 5 USDG, once per agentId (owner may change it later, contract cap 50 USDG). |
| M3 | Check packs: 500 checks for 1 USDG (API config `ORRERY_PACK_PRICE=1000000`, `ORRERY_PACK_SIZE=500`). |

## Owner direction on updates (2026-11-08)

| # | Decision |
| :--- | :--- |
| U1 | No integration with other projects: features from other projects are rebuilt as Orrery's own (owner, quoted: "jangan gunakan integrasi ke project lain tapi full fitur kita sendiri misalnya darkpool, shield atau apapun yg ada di project lain untuk di bawa ke project ini"). Catalogue in `docs/UPDATE-CANDIDATES.md` section 8. |
| U2 | Q1 widened: Orrery becomes a set of agent markets (Jobs, Shield, Dark Pool, Agent Launch, Earn liquidity, Credit) on top of the policy wedge, in wave order: update waves 1 and 2 (payer gate, alerts, MCP, own facilitator) first, then the markets of waves 5 to 7. `docs/UPDATE-CANDIDATES.md` 8.4 and 8.5 (D1). |
| U3 | Quero's code (`quillexdev/arcane`: dark pool, escrow, bounty board and the rest) may be used as Orrery's own: the project belongs to the owner and Neo and we are contributors with a local clone. Keep the SPDX header and note the origin (D2). |
| U4 | Orrery Shield is zero-knowledge first: a merchant learns only that a verified, policy-bound Orrery agent paid within its per-payment cap, not which agent. Design in `docs/UPDATE-CANDIDATES.md` 8.3 (signer set `OrrerySignerSet`, recent-roots window, pool fee instead of a paid check) (D3). |
| U5 | ORRY stays on Pons V2, confirming T1; it is the one stated exception to U1 (D4). |
| U6 | Orrery's x402 facilitator is opened to other merchants. Supersedes I1's "not offered to other merchants in v1"; it moves to update wave 2 (D5). |
| U7 | Orrery Credit: the operator's bond carries first loss before pool lenders. Revisits Q5 (no bond in v1) for credit only, as T7 does for staking (D6). |

## ORRY token (owner, 2026-11-08; design in `docs/ORRY-TOKEN-UTILITY.md`, sections 18 and 19)

| # | Decision |
| :--- | :--- |
| T1 | ORRY launches on Pons V2. Pons trading fees (creator fee recipient = the owner's wallet, creator tax, Pons buyback) belong to the owner and never enter the protocol; every reward paid to users comes from Orrery's own revenue and activity. |
| T2 | ORRY launches the same day as Orrery v1. |
| T3 | Orrery gets a launchpad, Agent Launch, in the second update: verified agents only, stake locked 90 days, coins paired with ORRY. |
| T4 | Shared liquidity is hub and spoke: the Earn vault funds the ORRY/ETH hub pool only; launched coins use their own locked supply, so LPs never hold launched coins. |
| T5 | Hub pool fee 1% flat next to the Pons pool: 85% to LPs, 15% to `OrryRewardsRouter`. |
| T6 | Agent Launch fee 1% per swap: creator (the agent's policy-bound account) 50%, Earn LPs 20% in ORRY, burn 15%, owner 15%. |
| T7 | Operators may lock ORRY behind an agent: 14 day unbonding, no slashing, shown in check results, earns staking rewards. Revisits Q5 (no bond in v1) for the token update only. |
| T8 | Check packs and the verification fee can be paid in ORRY: 625 checks per 1 USD of ORRY, verification 4 USD of ORRY, all burned, verification in ORRY capped at 25 a day. |
| T9 | 90% of USDG product revenue buys ORRY for rewards and burn; the owner keeps 10% (owner confirmed 2026-11-08 over an earlier 50/50 answer; same as R-4 in `docs/ORRY-BUILD-SPEC.md` on branch `orry/spec`). |
| T10 | `OrryRewardsRouter` split: 50% to stakers (streamed 7 days), 50% burned. |
| T11 | `OrreryTreasury` is deployed with v1, before the token, in coinless mode. |
| T12 | No on-chain governance; the owner keeps fees and prices, contract splits are constructor constants. |
| T13 | No legal review before Earn and Stake open (owner's choice). |
| T14 | SNOP code (hook, vault, buyback) may be copied into Orrery; the owner says the repo is shared, no permission needed. Copied code still gets Orrery's own tests, invariants and mutation checks. |

## ORRY token utility (owner, 2026-11-08)

Full reasoning in `docs/ORRY-TOKEN-UTILITY.md` (section 19 governs); build spec `docs/ORRY-BUILD-SPEC.md`.

| # | Decision |
| :--- | :--- |
| R-1 | ORRY launches on Pons V2. Pons trading fees belong to the owner and never enter the protocol (owner: "trading fee dari pons adalah hak milik owner dan tidak akan di masukkan ke protokol") |
| R-2 | Every reward paid to users comes from Orrery's own revenue and activity |
| R-3 | All 16 checklist items of `ORRY-TOKEN-UTILITY.md` 19.6 are built, in four parallel lanes |
| R-4 | Treasury: 90% of USDG revenue buys ORRY, 10% to the owner |
| R-5 | Leaderboard of top stakers and earners with their earnings, addresses partly hidden |
| R-6 to R-9 | Delegated defaults: hub fee about 1% flat (0.85% LPs, 0.15% protocol), router 50% stakers and 50% burned, cooldowns 7 and 14 days, checkout 625 checks per USD and verification 4 USD of ORRY; constructor or config values the owner may change before deploy |
| Q5 | Re-decided by R-3: operators may stake ORRY behind agents (a lock without slashing, reported in checks) |
| R-17 to R-22 | Delegated from the lane reports (2026-11-08), detail in `docs/ORRY-BUILD-SPEC.md` section 1: same-block guard on the L1 block number; buyback slice cap 1,000 USDG and a 0.5% cross-pool check against hop 1 manipulation (F-1); open `notifyRewards` kept (F-2); treasury ownership events (F-3); lane readings confirmed; USD price from the deepest ETH/USDG pool |
