# Orrery markets for ORRY value: Quero feature map (proposal)

Date: 2026-11-08 (WIB). Status: proposal for the owner's selection; nothing is built. Internal planning document.

Owner direction, quoted (relayed by the Orrery session): "karena kita berjalan di chain robinhood tambahkan juga RWA,
Stocks seperti yg ada di update terbaru milik quero termasuk shild dan darkpool intinya semua fitur yg ada di quero dan
bisa menambah nilai jual token native kita tambahkan saja". In English: since we run on Robinhood Chain, add RWA and
stocks as in Quero's latest update, including Shield and the dark pool; in short, every Quero feature that can add to
the value of our native token.

Standing decisions that bind this plan: U1 (rebuild as Orrery's own, no integration), U3 (Quero code may be used as our
own; keep the SPDX header, note the origin), U4 (Shield is zero-knowledge first), U2 (agent markets in wave order),
T1 and R-1 (Pons fees stay the owner's), R-4 (90% of USDG revenue buys ORRY, 10% to the owner), R-7 (router: 50% to
stakers, 50% burned), the rebrand rule (Orrery's own words, overlap measured), Uniswap v4 only.

## 1. What Quero has today (local clone `arcane/` at 5c0cd94, 2026-11-08)

Read from `arcane/contracts/src/**`, `arcane/contracts/deployments/robinhood-mainnet-*.json` and `arcane/apps/web/app/rwa/**`.
"Live" means a mainnet address is recorded; "sim" means the web page is a simulation with no contract behind it.

| Quero module | Contract (lines) | State on 4663 | Fee in code |
| :--- | :--- | :--- | :--- |
| Dark pool (sealed commit-reveal batches, stock token vs USDG at the Chainlink price) | `darkpool/ArcaneDarkPool.sol` (359) | live (factory `0xfC13…C14B`) | `feeBps` per pool, at most 0.5%, immutable |
| Shield V1 (Poseidon tree, PLONK verifier, verified wallets); V2 announced | `shield/ArcaneShield.sol` (352) + verifier | live (factory `0x3072…E428`) | none in code |
| Stock swaps (batched, one contract per stock) | `swap/ArcaneBatchSwap.sol` (348) | live (17 batch swaps) | 0.1% of output to the treasury |
| Perps on stock tokens, USDG pool as counterparty | `perps/ArcanePerps.sol` (318) | live (17 assets, Chainlink feeds) | 0.06% open + 0.06% close, to the pool |
| Lend (isolated markets) and Multiply (looping) | `lend/ArcaneLend.sol` (401), `ArcaneMultiply.sol` | live (18 markets) | reserve at most 25% of interest; liquidator bonus 5% |
| Credit pools (USDG lenders, managed lines) | `pool/ArcaneCreditPool.sol` (330) | live factory, page held | manager at most 20% of interest |
| Baskets (one order for a set of stock tokens) | `basket/ArcaneBasket.sol` | live (factory `0x9B5B…FC27`) | per basket |
| Prediction markets (stock price outcomes) | `predict/ArcanePredictionMarkets.sol` (283) | live | at most 3% of the pool |
| RWA issuance (ERC-3643 style compliance, identity registry, primary sale) | `rwa/*` (5 files) | an identity registry is recorded with the credit pool factory | primary sale at most 1% |
| Investor verification (zero-knowledge credentials) | `credential/ArcaneZkCredentials.sol` + verifier | live | none |
| Vaults (ERC-4626 strategies) | `vault/ArcaneVault.sol` (177) | page is a sim | at most 2% a year + 20% of gains |
| Private swap, pair trading, funding arbitrage | none (pages are sims) | sim | none |
| Limit orders with keeper tips | `trade/ArcaneLimitOrderBook.sol` | not recorded | tip at most 1% (to the keeper) |
| Jobs escrow, bounty board, milestone raises, fee streams | `agents/ArcaneAgentEscrow.sol`, `growth/*` | live, unused (0 jobs, 0 bounties) | 1%, 1%, 0.5% of a tranche, 1% |
| Launch: token factory, curve, sales, airdrop, vesting | `launch/*`, `curve/*`, `vesting/*` | live (V2 graduation) | trade at most 2% + creator 1%; graduation at most 3% |
| NFT studio | `nft/*` | live | royalties |
| Quantum-safe account (SLH-DSA) | plan only (`5f79a7a`, `1d65b75`) | not deployed | none |

## 2. ORRY value levers

| Lever | Mechanism | Effect on ORRY | Cost to build |
| :--- | :--- | :--- | :--- |
| L1 Fee to the treasury | Every Orrery market charges its fee in USDG to `OrreryTreasury` (live with v1). R-4 sends 90% to the ORRY buyback; the router gives half the ORRY to stakers and burns half | Steady buy pressure, staker income and burn from real volume | None beyond setting the fee recipient |
| L2 Staker fee tiers | A venue reads `OrryStaking.earningBalance(account)` and lowers the fee above stake thresholds (for example 25% off from one level, 50% off from a higher one) | Holding and staking ORRY pays for active traders; locks supply | Small: one view call per trade; thresholds are constructor values |
| L3 Pay the fee in ORRY | The trader pays the fee in ORRY at a discount; it is burned (source 2 style), priced by a signed quote like ORRY checkout | Direct demand and burn per trade | Medium: quotes per trade, a second payment path in every venue |
| L4 Agent stake gate | Agent-only venues (dark pool, jobs) admit an agent only while its operator keeps an ORRY agent stake (T7) at or above a minimum | Locks supply per active agent; Sybil cost | Small: one view call at admission |
| L5 ORRY as pair or collateral | ORRY-denominated prediction markets, an ORRY collateral market in Lend | Direct use of the token | High: needs a manipulation-resistant ORRY price; v4 has no TWAP and the hub's guard covers one L1 block only |

Illustration of L1 (arithmetic, not a forecast): 1,000,000 USDG of monthly volume at a 0.3% fee is 3,000 USDG; 300 to the
owner, 2,700 buys ORRY; of that ORRY, half goes to stakers and half is burned.

Recommendation: L1 everywhere, L2 on trading venues, L4 on agent-only venues. L3 later, venue by venue, if L2 is not
enough. L5 not at launch.

## 3. Feature map

| # | Orrery feature (working name) | Quero source | ORRY levers | Holds stock tokens or USDG | Effort | Notes |
| :-- | :--- | :--- | :--- | :--- | :--- | :--- |
| M1 | Dark Pool | `ArcaneDarkPool.sol` + factory, oracle rules in `apps/api/src/lib/oracles.ts` | L1, L2, L4 (agents first) | yes, for one batch | L | already O2 (wave 6) |
| M2 | Private Swap (batched stock swaps, order size hidden until the batch clears) | `ArcaneBatchSwap.sol` | L1, L2 | yes, for one batch | M | Quero's page is a sim; the contract is live |
| M3 | Shield V2 (zero-knowledge balance and payments) | Hushwave circuits and pool, `ArcaneShield.sol`, `ArcaneZkCredentials.sol` | L1 (pool fee), L4 (stake as a proof attribute) | USDG in the pool | L | already O1 (wave 6, U4) |
| M4 | Stocks: price pages and swaps for the 195 Robinhood stock tokens | Quero `assets` pages, batch swaps | L1, L2 | yes, for one batch | M | needs a Uniswap v4 route or the batch swap; Uniswap v4 rule |
| M5 | Baskets | `ArcaneBasket.sol` | L1 (management fee), L2 | yes, held for as long as the basket exists | M | see section 4 |
| M6 | Prediction markets on stock prices | `ArcanePredictionMarkets.sol` | L1, L2; L5 later | USDG until resolution | M | |
| M7 | Perps on stocks | `ArcanePerps.sol` | L1 (a share of the pool's fees), L2 | USDG in the LP pool | L | risk engine, liquidations, oracle staleness on weekends |
| M8 | Lend and Multiply | `ArcaneLend.sol`, `ArcaneMultiply.sol` | L1 (reserve share), L2 | yes, collateral held long term | L | L5 (ORRY collateral) not at launch |
| M9 | Pair trading and funding arbitrage | none (sims) | L1, L2 | through M7 | M each, after M7 | new design, no code to reuse |
| M10 | Vaults (strategies) | `ArcaneVault.sol` | L1 (performance fee share) | yes | M | after M7 and M8 |
| M11 | RWA issuance, investor verification, primary sales | `rwa/*`, `ArcaneZkCredentials.sol` | L1 (primary sale fee), issuer listing fee in ORRY (burned) | the issued tokens | L | KYC conflicts with the policy wedge (Q1); regulated activity |
| M12 | Launch tools for agent coins: sales, airdrops, vesting, milestone raises | `launch/*`, `vesting/*`, `growth/ArcaneMilestoneRaises.sol` | L1, L4; pairs with ORRY through Agent Launch (T3) | sale proceeds | M | rides on Agent Launch (second update) |
| M13 | Limit orders with keeper tips | `ArcaneLimitOrderBook.sol` | L1, L2 | resting orders | M | after M4 |
| — | Jobs, bounty board, credit | escrow, bounty, credit pool | already O3, O4 | | | decided earlier (U2, U7) |
| — | NFT studio, fee streams, quantum-safe account | | none worth it | | | not proposed |

## 4. Facts the owner must weigh before choosing

- **Issuer powers over stock tokens and USDG** (memory note, read on chain 2026-10-27): every Robinhood stock token can be
  blocked per address, paused and burned by its issuer (`adminBurn`), and USDG can be frozen and wiped. A Orrery
  contract that holds them can be frozen as a whole, exits included. Venues that hold them only for one batch (M1, M2,
  M4) are exposed for minutes; pools that hold them for as long as they exist (M5 baskets, M8 collateral, M10 vaults) are
  exposed all the time. The owner rejected Runepad's Pair Stocks for this reason on 2026-10-27. This applies to the
  treasury too, which already holds USDG.
- **Agents first or everyone**: U2 puts agent markets in wave order after waves 1 and 2. Opening the venues to everyone
  brings more volume (more L1) but leaves the agent wedge.
- **Regulated activity**: perps, prediction markets and RWA issuance on stock prices are regulated in most places. The
  owner chose no legal review for Earn and Stake (T13); these venues would follow the same choice unless the owner says
  otherwise.
- **Effort**: every row is a protocol-design run (spec, invariants, Foundry harness, mutation, fork tests). M1, M3, M7,
  M8 and M11 are each large.

## 5. Proposed waves (after the ORRY launch and update waves 1 and 2)

| Wave | Theme | Items |
| :--- | :--- | :--- |
| R1 | Private trading | M1 Dark Pool, M2 Private Swap, M4 Stocks |
| R2 | Shield and markets | M3 Shield V2, M6 Prediction markets, M13 Limit orders |
| R3 | Leverage | M7 Perps, M8 Lend and Multiply, M9 Pair trading and arbitrage, M10 Vaults |
| R4 | Issuance | M11 RWA issuance, M12 Launch tools (with Agent Launch) |

The owner's selection and order are recorded in `02-open-questions.md` once given.

## 6. Owner decisions (2026-11-08) and the custody rule

Recorded as R-23 to R-26 in `docs/ORRY-BUILD-SPEC.md`: all four groups (R-23); all five levers, ORRY collateral
included (R-24); open to every wallet from the start (R-25); custody risk on the user, not on Orrery's contracts
(R-26), quoted: "carikan solusi terbaik untuk masalah ini, jika bisa bebankan resiko menyimpan nya ke user jangan ke
contract kita. kita hanya memberikan fasilitasnya resiko di tanggung users".

Proposed custody rule (R-26), three patterns, chosen per venue by what the product needs:

| Pattern | How it works | What an issuer block or freeze reaches | Venues |
| :--- | :--- | :--- | :--- |
| A. Wallet to wallet | Users sign EIP-712 orders; at clearing the venue pulls from each side's own wallet and pays the counterparty in the same transaction. The venue holds no stock token and no USDG between transactions. A blocked address only fails its own order, which the venue skips. Sealed batches (dark pool, private swap) keep orders hidden as commitments; a small commitment fee in ORRY (burned) deters orders that are revoked before clearing, so no USDG bond is held | the blocked user's own order only | M1 Dark Pool, M2 Private Swap, M4 Stocks, M5 Baskets (one order buys the set into the user's wallet; no basket token), M13 limit orders, M11 primary sales (buyer pays the issuer directly) and issuance (tokens go straight to holders) |
| B. Per-user account | Positions that must hold assets over time sit in an account owned by the user: an account clone made for that user, or the user's own Safe with a Orrery policy session (the v1 module). Only the user withdraws; a liquidator or a strategy acts only within its rule | that user's account only | M8 Lend collateral and Multiply, M7 Perps margin, M9 Pair trading and arbitrage, M10 Vaults (a strategy session on the user's Safe) |
| C. Per-market pool | Where the pool is the product (lenders' USDG, the perps counterparty pool, a prediction market's stakes, Shield's anonymity set), every market is its own contract; nothing pools across markets, and depositors choose the market | that one market's depositors | M8 lender side, M7 LP pool, M6 each market, M3 Shield (privacy needs a shared pool; per asset) |

Invariants this adds (X series): X-1 a pattern A venue holds zero stock tokens and zero USDG after every external call;
X-2 a per-user account pays out only to its owner, except a liquidation within its rule; X-3 no contract holds the
assets of two markets; X-4 no Orrery contract other than the treasury and pattern C pools holds USDG at rest.
UI copy follows rule 4 (no risk or doubt sentences); the isolation is structural.

## 7. Integration pass: conflicts and proposed resolutions

| # | Decisions in conflict | Resolution |
| :-- | :--- | :--- |
| C1 | R-25 (everyone) against U2 (agents first) and L4 (agent gates) | U2 stays for agent-only products (Jobs, Agent Launch); these venues open to all. L4 becomes a benefit, not a gate: an operator's agent stake already counts in `earningBalance`, so it earns the L2 fee tier |
| C2 | R-24 L5 (ORRY as collateral) against the hub's pricing: Uniswap v4 has no time-weighted price, and the hook's guard covers one L1 block | Add a price-observation buffer (time-weighted average) to `OrreryHook` before its mainnet deployment, since the hook is immutable; ORRY collateral then reads a 30 minute average with a low collateral factor and a borrow cap per market. Later instead: a second oracle mechanism, and ORRY collateral waits for it |
| C3 | R-26 against products that are pools by nature (Shield, lenders, the perps pool, prediction stakes) | Pattern C: one contract per market, so a freeze reaches one market only; Shield stays a shared pool per asset (privacy needs it) |
| C4 | R-26 ("risk on users") against rule 4 (no risk sentences anywhere a user sees) | Nothing is written to users about it; the patterns make the isolation structural |
| C5 | M11 (issuance with investor verification) against U1 and the data rules | Verification needs an identity provider (an outside service) and personal data; the on-chain proof can use our own zero-knowledge credentials. Decided when M11's wave comes |
| C6 | Uniswap v4 rule against Quero code built on V2 (lend liquidations, flywheel, launch graduation) | Ported to v4; stock swaps clear by batch matching at the Chainlink price, with any remainder routed through v4 pools |
| C7 | Regulated venues (perps, prediction markets, RWA issuance) against T13 (no legal review for Earn and Stake) | Owner decision |
| C8 | Effort against the launch order | v1 and ORRY first; then the market waves in the owner's order, each through the protocol-design method |

## 8. Owner answers to the integration pass (2026-11-08)

R-27: the three custody patterns are approved. R-28 (C2): the time-weighted price goes into `OrreryHook` before its
mainnet deployment (spec 3.1, invariants H-5 to H-8). R-29: waves R1 trading, R2 Shield and markets, R3 leverage, R4
issuance. R-30 (C7): no legal review before perps, prediction markets or RWA issuance, over the recommendation of a
review before RWA issuance; these venues open without legal advice on securities, derivatives or investor
verification rules in users' countries. C1, C3, C4, C6 and C8 follow the resolutions above; C5 waits for wave R4.
