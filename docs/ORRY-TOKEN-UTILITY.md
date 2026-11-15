# ORRY token utility for Orrery

Date: 2026-11-08, revision 2 (owner direction on earn and shared liquidity added the same day). Status: research and
design only. No contract code, no deployment, no token. Internal document: factual by design, not user-facing copy.
Every decision below is a **recommendation** until the owner answers section 18; nothing is recorded in
`02-open-questions.md` yet.

Inputs read: `README.md`, `PROGRESS.md`, `02-open-questions.md`, `03-economics.md`, `05-risks.md`, `08-contract-spec.md`,
`14-services-spec.md`, `docs/MAINNET-4663.md`, `contracts/src/OrreryAttestor.sol`, the sibling report
`docs/UPDATE-CANDIDATES.md`, the workspace memory notes, and the token, launchpad, hook and vault code of the owner's other
projects (section 8). Live reads on Robinhood Chain 4663 on 2026-11-08 are in section 1.3.

## Owner answers (2026-11-08)

Recorded in `02-open-questions.md` as T1 to T14. Question 1: Pons V2 (section 19). Question 2: **B, the same day as v1**
(not the recommendation; `OrreryTreasury` therefore ships with v1). Question 3: A. Question 4: A. Question 6: A. Question
7: superseded by section 19 (staking rewards from protocol revenue, split by question 10 and the router). Question 8: A.
Question 9: A. Question 10: 90% of USDG revenue to rewards and burn, owner keeps 10% (confirmed over an earlier 50/50 answer), router 50% stakers, 50% burn.
Question 11: A. Question 12: A. Question 13: **B, no legal review**. Question 14: not applicable on Pons. Question 15:
**copy the SNOP code; the owner says the repo is shared, no permission needed**. Question 16: A, 1% flat.

## 0. Recommendation in short

Update 2026-11-08: the owner launches ORRY on Pons V2 and keeps every Pons trading fee outside the protocol. Section 19
(Pons edition) governs wherever it differs from sections 0 to 18; the hub launch path (question 1 option A) is not taken.

The owner's direction (2026-11-08, quoted in section 2): ORRY is used to earn; Orrery runs a liquidity pool anyone can
fund with ETH or other common assets; that liquidity serves coins launched through Orrery or any Orrery feature that
can use it; liquidity providers earn a percentage of every swap through it.

Recommended design, **hub and spoke**:

1. **Orrery Earn (next update, rank 1).** One Orrery-owned Uniswap v4 pool ORRY/ETH (the hub) on a Orrery fee hook,
   and an Earn vault anyone funds with ETH, ORRY or both (USDG through a zap). The vault holds one full-range position;
   swap fees stream to depositors over 7 days. Fee 0.30% to 1% (volatility based), **85% to LPs, 15% burned as ORRY**.
   ORRY earns three ways: as half of the vault's inventory, as the currency of the boost rewards, and as stake that
   raises a depositor's boost weight up to 2.5 times. No emissions: every reward is paid from fees.
2. **Agent Launch (second update, if the owner says yes, rank 2).** Only Orrery-verified ERC-8004 agents launch coins;
   each coin's supply sits single-sided in its own v4 pool **paired with ORRY** (the spoke), locked forever. Buyers go
   ETH to ORRY through the hub, then ORRY to the coin, so **hub LPs earn on every agent-coin trade without holding any
   launched coin**. Spoke fee 1%: **50% to the agent's policy-bound account, 20% to Earn depositors in ORRY, 15% burned,
   15% to the owner**. The creator's income lands in an account whose spending caps are public, which is the Orrery
   wedge applied to launches.
3. **Trust-product uses (next update, rank 3, from revision 1).** Operators lock ORRY behind agents (shown in every
   check, also counts for the Earn boost); merchants and operators pay packs and the verification fee in ORRY, burned;
   half of USDG product revenue buys ORRY and burns it through a `OrreryTreasury` contract.

Not recommended: placing the shared vault's ETH into launched-coin pools (expected loss about 46% in 30 days on the
assumptions of section 11.4, and the house rules forbid the risk wording such a product would need), a passive staking
share of revenue, x402 swap liquidity (no volume to earn from), slashing, prober staking, on-chain governance.

ORRY launch venue: launching ORRY **directly in the Orrery hub** (single-sided supply, decaying launch fee) puts every
ORRY trade through Orrery LPs from the first block; launching on **Pons V2** is faster but its graduated pool pays LPs 0%,
so the hub would compete with it for volume. Owner question 1.

Key measured fact: Pons V2 on 4663 had **7,049 launches in the last 7 days (about 1,007 a day) and 77 graduations
(1.09%)**. Launches are plentiful; liquidity that survives is rare. The design keeps LP capital out of that churn.

## 1. Ground truth the design must respect

### 1.1 Who does what today

| Party | What they do in v1 | What they pay |
| :--- | :--- | :--- |
| Operator | Owns a Safe 1.4.1 + Safe7579 account, binds an ERC-8004 identity, installs `OrreryPolicyModule`, opens sessions with caps | 5 USDG once per agentId (M2), gas |
| Agent (signer) | Tops up its float within caps, pays x402 from the float | Gas; its payments go to third parties |
| Counterparty (merchant) | Buys credit packs over x402, calls `/v1/check/by-signer`, verifies the EIP-712 result | 1 USDG for 500 checks (M3) |
| Prober and attester | Our services | We pay about 0.0027 USD per attestation |
| Holder, LP | Do not exist yet | |

Orrery has no swap flow today. Every liquidity idea below creates its own flow or borrows one.

### 1.2 Hard constraints

- **v1 contracts are immutable.** No proxy; the module has no admin. Token-relevant levers that exist: the attestor's
  `setTreasury`, `setFee` (≤ 50 USDG), the attester and check-signer sets, and the API config.
- **The treasury verifies for free.** In `OrreryAttestor.payVerification` (lines 100 to 120) a call from the treasury moves
  no USDG and records fee 0, so a contract treasury can sell verifications for another asset with no attestor change.
- **A token must never weaken policy.** I4, caps and forbidden selectors are module constants.
- Decisions in force: Q5 no bond in v1; M1 one key as deployer, owner and treasury; single-owner wallets; Uniswap v4 for
  every pool; Robinhood Chain 4663; W2 no token before a used product; no external audit as a gate.
- **Copy rule (absolute since 2026-10-31):** no sentence anywhere a user sees that could make them doubt the project,
  including risk wording. An LP product therefore has to carry its protection in its design; it cannot rely on warnings.

### 1.3 Measured facts (2026-11-08, chain id 0x1237 = 4663)

| Fact | Value | How |
| :--- | :--- | :--- |
| Pons V2 launches, last 7 days to block 108,921,902 | **7,049** `TokenLaunched` from 5,371 deployer addresses (top deployer 84); pairs: ETH 5,701, USDG 533, TSLA 181, NVDA 108, others | `eth_getLogs` on factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` (official RPC), ABI from Sourcify |
| Pons V2 graduations, same window | **77** `PoolGraduated` (1.09% of launches); ETH graduations at exactly 4.2 ETH, USDG at 8,090 USDG | same |
| Graduated pool seed | about 204,081,633 tokens (20.4% of supply) with 4.2 ETH, so graduation FDV ≈ 20.6 ETH ≈ **46,000 USD** | `PoolGraduated` data |
| Pons V2 launch config 0 | supply 1e27, curve fee 1% (100 bps), virtual quote 1.68 ETH, graduation 4.2 ETH, **pool LP fee 0**, tick spacing 200 | `getLaunchConfig(0)` |
| Pons V2 fee policy (read for ORVYN) | hook fee 1% (100 bps) on graduated-pool swaps; 30% of fees to Pons; 50% of the rest to creator buyback when enabled; internal price impact cap 3% | `getLaunchFeePolicy` |
| Pons V2 other | max creator tax 10%; launch fee 0.0005 ETH; snipe tax 99% decaying over **3 s**; PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`; components named memeHook, graduationExecutor, graduationGuard, locker, feeEscrow, buybackVault | factory views |
| A Pons V2 token (ORVYN `0x9796…2745`) | 3,248 bytes; `burn` and `burnFrom` present; no `permit`, no EIP-3009, no `owner`, no `mint`, no `getVotes`; 1e27 supply, 18 decimals | `eth_getCode` PUSH4 scan and `eth_call` |
| Consequence | ORRY on Pons cannot pay x402 `exact`, has no permit, burns reduce supply, governance cannot use token votes | derived |
| Gas, ETH | 0.02 gwei; ETH 2,236.28 USD (Coinbase spot) | `eth_gasPrice` |
| ERC-8004 on 4663 (2026-11-06) | 21,497 agents, 1,655 owners, 1,390 new agents in 7 days, top 10 owners hold 90.3% | `03-economics.md` |
| x402, all chains (2026-11-03 summary) | about 27.8 K USD a day, about half wash | `03-economics.md` |

## 2. The owner's direction and how this report reads it

Quoted (owner, 2026-11-08): "jika bisa token native nya akan digunakan untuk earn dan kita memiliki liquidity pool yg
bisa di isi oleh semua orang dengan eth/asset lain yg biasa digunakan ke coin coin yg di launch pada project ini jika
potensi di jadikan launchpad atau fitur lain di project ini yg bisa menggunakan liquidity user bisa mendapatkan income
dari persentase swap atau transaksi setiap orang di liquidity".

| Part | Reading | Where it lands |
| :--- | :--- | :--- |
| ORRY is used to earn | ORRY is LP inventory, the reward currency and the boost stake; rewards come from fees, not emissions | Sections 5, 12 (Earn) |
| A pool anyone can fund with ETH or common assets | One Earn vault taking ETH, ORRY, or USDG and WETH through a zap | Section 4 option C |
| Paired against coins launched through Orrery, or any feature using user liquidity | Launched coins pair with ORRY, so all their trades route through the hub the vault funds | Sections 3, 4 |
| LPs earn a percentage of every swap or transaction | 85% of every hub swap fee; 20% of every spoke swap fee as boost rewards | Section 6 |

## 3. Does a launchpad or another liquidity feature fit Orrery?

| Candidate | Who it serves | Flow it would earn from | Fit with the KYA wedge | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **Agent Launch**: coins launched only by Orrery-verified ERC-8004 agents; creator fees go to the agent's policy-bound account; the coin page shows the agent's live Orrery record | Operators, their communities, traders | Launch trading; 4663 already runs about 1,007 Pons launches a day | High for the story: holders can read the agent's treasury caps, liveness and stake. Medium for the business: it adds a speculative product next to a trust product | **Recommended as phase 2**, gated (section 12) |
| **ORRY hub pool and Earn vault** | Holders, LPs | All ORRY trading, plus the ORRY leg of every agent-coin trade | Neutral: it is token infrastructure | **Recommended, phase 1** |
| x402 swap-to-pay: an agent pays in ETH, the facilitator swaps to USDG through a Orrery pool | Agents, merchants | Agent payments on 4663 | Fits payments, but agents already hold USDG floats (Q8), x402 is about 27.8 K USD a day on all chains, and Uniswap's own ETH/USDG v4 pools on 4663 are deeper. At 1% of all x402 volume and 0.30% fee: about 0.83 USD a day | Not recommended |
| Settlement liquidity for merchants (instant USDG before finality) | Merchants | None: 4663 settles in about 1 s at 10 confirmations | None | Not recommended |
| Credit to agents from LP money | Agents | Interest | `UPDATE-CANDIDATES.md` section 5 rejects credit for v1; lending risk | Not recommended |
| Agent-to-agent payments in ORRY | Agents | Payments | ORRY has no EIP-3009 (1.3) | Not possible today |

Why Agent Launch fits better than a generic launchpad: Orrery's product is proof that an agent's spending is capped and
its endpoints are live. On a launch, the same proof answers the question every buyer of an agent coin has: can the team
behind it drain what the coin earns? With creator fees paid into the agent's bound Safe and spent only through
`OrreryPolicyModule` sessions, the answer is on-chain and in every check. Nothing else on 4663 offers that; Pons, SNOP and
Fomo launch any coin for anyone.

What it costs the trust product: a launched coin can still fall to zero, and its page carries the Orrery record. Copy
must keep checks factual (amounts, caps, liveness), never a verdict, so a falling coin is not read as a failed check.

## 4. Shared pool design options

| Option | How it works | LP exposure | ORRY demand | Built pieces | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| A. Per-coin pools, outside LPs choose | Each launched coin opens its own v4 pool; its supply sits single-sided and locked; any LP may add a position per coin | Only to the coins an LP picks | None unless coins pair with ORRY | Origo `PoolVault`, Hashborn `HashbornLaunchpadV4`, Elysium `ShapeManager` | Kept as the base of every option |
| B. One shared ETH (or USDG) vault feeding many coin pools through a hook | Depositors' ETH is placed as liquidity in launched coins' pools (single-sided ETH sits below price, so it buys coins as they are sold) | Every launched coin, adverse selection on each dump | Indirect | SNOP `PlpVault` (vault shell), SNOP DAMM hook | **Not recommended**: expected loss about 46% in 30 days (11.4); needs risk wording the copy rule forbids |
| B'. Same with caps | B with at most 1% of the vault per coin, 20% in total, only graduated coins older than 7 days with volume, exit rule | Bounded but still one-directional | Indirect | as B | Possible later with 30 days of launch data; not in a first version |
| **C. Hub and spoke** | Shared Earn vault funds only ORRY/ETH; launched coins pair with ORRY; spoke liquidity is the coin's own locked supply plus buyers' ORRY | ORRY and ETH only (impermanent loss on one asset the project stands behind) | Pair asset, vault inventory, boost stake, permanent lock in graduated spokes | Elysium `StakeVault`, SNOP `SnopStake`, SNOP DAMM hook, Hashborn `LaunchFeeHook` | **Recommended** |
| D. Revenue vault without market making | Depositors' USDG sits in an ERC-4626 vault; protocol income is paid in (SNOP PLP model) | None from trading | None | SNOP `PlpVault`, `SnopFeeCollector` | Not recommended: the deposit does no work, so the income is a plain revenue share |

Option C is the only one where depositors earn from every launched coin's trading and never hold a launched coin. The
pairing does the routing: a buyer who starts in ETH must pass through the hub to reach any spoke.

## 5. Where ORRY fits

| Role | Mechanism | Demand created |
| :--- | :--- | :--- |
| Pair asset of every agent coin | Spoke pools are ORRY/coin; graduation thresholds are set in ORRY | Every agent-coin buy needs ORRY; a graduated spoke keeps at least 20.4% of its graduation quote locked forever even if every holder sells (11.3) |
| Hub inventory | The Earn vault holds ORRY and ETH in one full-range position | Half of Earn TVL is ORRY held out of circulation |
| Reward currency | Boost rewards (20% of spoke fees, plus the launch position's fees if ORRY launches in the hub) are paid in ORRY | Earning in ORRY without new supply |
| Boost stake | Stake in `OrryStake` raises an LP's weight: `w = min(L, 0.4·L + 0.6·T·S/ST)` (L the LP's shares, T total shares, S the LP's stake, ST total stake), at most 2.5 times; same formula family as Curve's boost | LPs who want a larger share lock ORRY |
| Agent stake | R-01: locked ORRY behind an agentId, reported in checks; also a launch gate (an agent needs a minimum stake locked 90 days to launch) | Lock that grows with verified agents and launches |
| Burn | 15% of hub fees, 15% of spoke fees, ORRY checkout, verification in ORRY, buyback from USDG revenue | Sinks in proportion to use |
| Not | Passive staking yield from revenue; emissions | Section 9 R-05 |

## 6. Fee split per swap

### 6.1 Hub (ORRY/ETH), every swap

| Item | Value |
| :--- | :--- |
| Fee | Base 0.30%, rising with volatility to at most 1.00% (SNOP DAMM formula family); modelled average 0.40% |
| To LPs (all in-range positions pro rata, native v4 LP fee) | 85% |
| To burn (hook fee, ORRY side burned, ETH side buys ORRY and burns in the next slice) | 15% |
| Fees of the protocol-held launch position (only if ORRY launches in the hub) | Collected weekly: 50% to the boost pool, 50% to the owner (owner question 14) |

### 6.2 Spoke (ORRY/agent coin), every swap after the launch window

| Item | Value |
| :--- | :--- |
| Launch window | Fee starts high at opening and falls to 1% over a short window (Hashborn `LaunchFeeHook` pattern); 4663's Pons snipe tax is 99% over 3 s |
| Fee | 1.00%, taken on the ORRY side |
| Creator (the agent's bound Safe) | 50% |
| Earn boost pool (paid to depositors in ORRY by boosted weight) | 20% |
| Burn | 15% |
| Owner (operations) | 15% |

### 6.3 One 100 USD purchase of an agent coin starting from ETH

| Leg | Fee | Where it goes |
| :--- | ---: | :--- |
| ETH to ORRY in the hub (0.40%) | 0.40 | 0.34 Earn LPs, 0.06 burned |
| ORRY to coin in the spoke (1% of 99.60) | 0.996 | 0.498 creator account, 0.199 Earn boost pool, 0.149 burned, 0.149 owner |
| Total | 1.40 (1.4%) | LPs 0.54, creator 0.50, burned 0.21, owner 0.15 |

Comparison: a Pons V2 trade pays 1% on the curve or the graduated pool, 30% of it to Pons and 70% to the creator; its
graduated pool pays LPs nothing.

## 7. Protecting LP capital

| Threat | Protection in the design |
| :--- | :--- |
| Launched coin goes to zero | Option C: the shared vault never holds a launched coin. Spoke liquidity is the coin's own supply and buyers' ORRY |
| Rug by liquidity removal | Spoke supply position held by the launch contract forever (Origo `PoolVault`, Hashborn `HashbornLaunchpadV4`: no code path decreases it); fixed supply, no mint, no owner on the coin |
| Rug by creator dump | No creator allocation; creator first buy capped (Hashborn `maxFirstBuyBps`); creator fee income lands in a policy-bound account (public per-day caps) |
| Snipers at launch | Decaying launch fee per pool (Hashborn `LaunchFeeHook`); optional fair window for identities registered before the opening (Hashborn fair mode) |
| Impermanent loss in the hub | Exposure to ORRY only; dynamic fee rises with volatility; protocol 15% burn supports the ORRY side. IL itself remains (table 11.1) and is described factually ("your share holds ORRY and ETH") |
| JIT fee sniping in the vault | Deposit lock 15 minutes, share-weighted (SNOP `PlpVault` D-05) |
| Sandwich on zaps and claims | Caller's `minOut` plus a same-block price guard and a floor at the start-of-block price (Elysium `StakeVault`) |
| Inflation attack on vault shares | Shares are liquidity units the vault added itself (SNOP `SnopStake`, Elysium `StakeVault`); ERC-4626 decimals offset if built as 4626 |
| Admin abuse | No owner power over vault assets or positions; withdrawals never pausable (SNOP PLP D-04, D-07) |
| Caps per coin | Not needed under option C (zero vault exposure). Under B' only: at most 1% of the vault per coin and 20% in total |
| Price manipulation of boost or burns | Boost weights from time-weighted shares and stake; burn slices bounded as R-04 (section 9) |

## 8. Pieces the owner's projects already built

Paths are under `~/Projects/blockchain/`. SNOP (`snopfamily-defi`, checkout of `quillexdev/snopfamily` main 23a979d,
2026-11-06) belongs to Neo's organisation: reusing its code needs the owner's word, and the workspace rule for separate
projects says to write independent code with its own tests. The others are the owner's own repositories.

| Piece | Path | What it does | Use here |
| :--- | :--- | :--- | :--- |
| Dynamic-fee v4 hook | `snopfamily-defi/packages/contracts/src/damm/SnopDynamicFeeHook.sol`; spec `snopfamily-defi/docs/liquidity/SPEC-liquidity.md` section 4; `docs/liquidity/DECISIONS.md` D-06 | Volatility-based fee, 10% protocol as ERC-6909 claims, LPs 90%, hook holds no tokens, flags `0x10C4` | Hub fee hook |
| LP vault (ERC-4626) | `snopfamily-defi/packages/contracts/src/plp/PlpVault.sol`, `IPlpVault.sol`; spec `snopfamily-defi/docs/plp/SPEC.md` | USDG vault, income through `collect`, deposit lock 900 s, withdrawals never pausable, decimals offset 12 | Vault shell, deposit lock |
| Full-range LP staking (v3) | `snopfamily-defi/packages/contracts/src/liquidity-mgr/SnopStake.sol`, `SnopZap.sol`, `SnopLadderManager.sol`, `SnopRangeOrderManager.sol` | One shared position, fees streamed 7 days, no lock, zap from one coin | Earn vault accounting, zap |
| Fee collector and price source | `snopfamily-defi/packages/contracts/src/router/SnopFeeCollector.sol`, `SnopChainlinkSource.sol`, `SnopRouter.sol` | Fee tokens to USDG bounded by Chainlink, Dutch auctions, router with integrator fee | Fee conversion pattern |
| Launchpad with v4 graduation | `snopfamily-defi/packages/contracts/src/LaunchFactory.sol`, `BondingCurve.sol`, `GraduationExecutor.sol`, `GraduationGuard.sol`, `LaunchLocker.sol`, `MemeHook.sol`, `FeeEscrow.sol`, `BuybackVault.sol`, `HolderFeeDistributor.sol`, `PoolSwapRouter.sol` | Curve then v4 pool, hook fee and creator tax, protocol share, buyback, holder fee sharing; same component names as the live Pons V2 factory | Reference for spokes |
| Earn vault on v4 (Elysium chain, development network only) | `elysium/delta/contracts/src/StakeVault.sol`, `StakeFactory.sol`; spec `elysium/delta/SPEC.md`, `elysium/delta/INVARIANTS.md` | One full-range v4 position per pool, shares = liquidity units, fees streamed 7 days, paid in one asset behind a same-block guard and floor | Earn vault (closest fit) |
| Shaped single-coin positions | `elysium/delta/contracts/src/ShapeManager.sol`, `ShapeLens.sol` | 1 to 40 bins, Spot, Curve, Bid-Ask shapes; keeper re-centre with guards | ORRY-only range positions (later) |
| On-chain pool stats | `elysium/delta/contracts/src/PoolStatsHook.sol`, `BasinRouter.sol` | Reserves, volume, LP fees per pool in storage, no indexer needed | Earn page figures |
| Single-sided launch in v4 | `origo/contracts/src/v2/LaunchpadV4.sol`, `PoolVault.sol`, `LaunchTokenV4.sol` | Whole supply in one position from the start price to the last tick, held forever, fees split creator and treasury | Hub launch of ORRY, spoke launches |
| Curve then v4 graduation | `origo/contracts/src/v2/CurveV3.sol`, `LaunchpadV3.sol` | Clone per coin, no admin, sells always open | Alternative spoke shape |
| Buyback route to a Pons pool | `origo/contracts/src/v2/FeeSwapper.sol`, `BuybackBurner.sol` | USDG or stock tokens to ETH on v4, then buy and burn in a Pons v4 pool | R-04 route if ORRY launches on Pons |
| Launch with identity-gated fair mode | `hashborn-npm-agent-launch/contracts/src/HashbornLaunchpadV4.sol`, `LaunchFeeHook.sol` | Fixed supply, native ETH v4 pool, single-sided position held forever, first-buy cap, 80/20 fee split, decaying launch fee, fair window per registered identity, no owner | Agent Launch core |
| Bonding curve and v4 graduation tests | `hookedrh/contracts/BondingCurve.sol`, `TokenFactory.sol`, `HookedToken.sol`, `hookedrh/test/foundry/GraduationV4.t.sol` | Reelo; front-run of pool init with or without liquidity | Test cases for spokes |
| Coinless buyback | `agentvault-protocol/contracts/src/FeeCollector.sol` | Hourly bounded buyback, token half kept in `reserved` until `proposeCoin`/`executeCoin` (48 h) | `OrreryTreasury` coinless mode |
| v4 median price source | `raffle-protocol/contracts/src/ObservedPriceSource.sol` | Median tick of samples in a window, fails closed (prototype) | Quote and boost price checks |
| Token, buyback, rewards specs | `aethernode/23-token-spec.md` (sections 4 to 6), `aethernode/25-missions-spec.md` | Bounded buyback slices, 7 day reward streams, Merkle seasons with 72 h checks | Boost epochs, burn slices |
| Deposit that pays credits | `nexora-mainnet-build/contracts/src/NeuxoraVault.sol` | USDG lent through ERC-4626, principal kept, interest buys credits | Possible merchant option (later) |

## 9. Long list, evaluated

Effort: S (days), M (one to two weeks with tests), L (own planning cycle).

| Id | Use case | Who | Demand | Effort | Contract | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| R-17 | Orrery Earn: ORRY/ETH hub pool and Earn vault, 85% LPs, 15% burn | LP, holder | lock (inventory), sink | M | hub hook, `EarnVault` | **Package, rank 1** |
| R-18 | ORRY boost for Earn rewards | LP, holder | lock | S to M | `OrryStake` + `BoostDistributor` | **Package, rank 1 (with R-17)** |
| R-19 | Agent Launch: verified-agent coins paired with ORRY | Operator, trader | pair asset, permanent lock, sink | L | `AgentLaunch`, spoke hook mode | **Package, rank 2 (second update)** |
| R-01 | Staked agents, shown in checks | Operator | lock | S to M | `OrryStake` | **Package, rank 3** |
| R-02 | ORRY checkout for packs, burned | Merchant | sink | S to M | `OrreryTreasury` | **Package, rank 3** |
| R-03 | Verification fee in ORRY, burned | Operator | sink | S | `OrreryTreasury` | **Package, rank 3** |
| R-04 | Buyback and burn from USDG revenue | Holder | sink | M | `OrreryTreasury` + `OrryBuyback` | **Package, rank 3** |
| R-20 | Shared vault ETH placed in launched-coin pools (option B or B') | LP | indirect | L | vault + hook | Not now |
| R-21 | ORRY-only shaped range positions in the hub | Holder | lock | M | `ShapeManager`-like | Later |
| R-22 | x402 swap-to-pay liquidity | Agent | flow | M | facilitator | Not recommended |
| R-05 | Passive staking share of fees | Holder | lock | M | rewards contract | Not recommended |
| R-06 | Slashable operator bond | Operator | lock, sink | L | stake with slasher | Not now (section 10) |
| R-07 | Prober or attester staking | Prober | lock | L | attestor v2 | Not now |
| R-08 | Reputation tiers and higher limits | Operator | lock | S | none beyond R-01 | Folded into R-01 (service limits only) |
| R-09 | Governance of fee parameters | Holder | lock | L | governor | Not now |
| R-10 | Missions and seasons in ORRY | All | flow | M | Merkle distributor | Later |
| R-11 | Stake ORRY, earn check credits (Orbi) | Merchant | lock | M | in `OrryStake` | Later |
| R-12 | Mandatory stake to be verified | Operator | lock | S | | Not recommended |
| R-13 | x402 payments in ORRY | Agent | flow | L | | Not possible today |
| R-14 | Paid featured placement, burned | Operator | sink | S | | Not recommended |
| R-15 | Stake-backed credit or insurance | Merchant | lock | L | | Not recommended |
| R-16 | Referral rewards in ORRY | All | flow | M | | Not recommended (bonus credits instead) |

### 9.1 Detail of the package items

**R-17 Orrery Earn.** Hub pool ORRY/ETH (native ETH) on the Orrery hook (6.1). `EarnVault`: deposit ETH, ORRY or both
(a single asset is zapped: half swapped in the hub with the caller's `minOut` and a same-block guard); shares are the
liquidity units the vault added; fees stream over 7 days; claims pay in ORRY, ETH or both; deposit lock 15 minutes; no
owner power over assets; withdrawals never pausable. Demand: half of TVL held as ORRY. USDG link: none (fees are in
pool assets). Conflicts: none (v4, 4663, one owner key for the hook's single setter at most). Risks: IL on ORRY, toxic
arbitrage flow, fragmentation with the Pons pool if ORRY launches there.

**R-18 Boost.** Weekly epochs. The boost pool (20% of spoke fees, plus 50% of the launch position's fees if ORRY launches
in the hub) is shared by `w` (section 5) from time-weighted vault shares and `OrryStake` stake (agent and plain positions
of the same address both count). A published script computes the table, which is public 72 hours before the Merkle root is
posted; claims open 72 hours after posting (aethernode `25` pattern); unclaimed after 180 days returns to later epochs.
The root's total is capped by the epoch's pool. Before Agent Launch exists the boost pool is only the launch position's
fees (hub launch) or empty (Pons launch); boost is then a later switch.

**R-19 Agent Launch.** `AgentLaunch.launch(agentId, name, symbol, ...)`: caller is `ownerOf(agentId)` or its bound account;
`OrreryAttestor.isVerified(agentId)`; `OrryStake` shows at least the launch minimum active for the agent, and the launch
locks it for 90 days. Deploys a fixed-supply coin, opens a ORRY/coin v4 pool on the Orrery hook in spoke mode at a
start price, puts the whole supply in one single-sided position held forever (Origo, Hashborn), runs the creator's capped
first buy. Spoke fees as 6.2; the creator share is paid to `getAgentWallet(agentId)` (the bound Safe) and nowhere else.
The coin page shows the agent's Orrery record. Conflicts: none with v1 contracts (reads only); a new product line, owner
question 3. Risks: legal (launchpad), brand (falling coins next to a Orrery record), snipers, wash volume to farm the
boost pool (bounded: wash traders pay 1.4% to recycle 0.2% to themselves through boost, a net loss).

**R-01, R-02, R-03, R-04** (unchanged from revision 1):
- R-01 Staked agents: `OrryStake` per agentId, no admin, no slashing, no rewards, 14 day unbonding; checks report
  `stakeActive`, `stakeLeaving`, `stakeLeavingAt`, `stakedBy` (check v2, bundled with the sanctions and exposed-key fields
  of `UPDATE-CANDIDATES.md` wave 3); perks are service-level (attestations every 6 hours, 25 services probed, directory
  filter, payer-gate `minStake`). Re-decides Q5; the Q5 reasons (dispute process, USDG freeze) do not apply to an ORRY
  lock without slashing.
- R-02 Checkout: 625 checks per 1 USD of ORRY (+25%), off-chain quote from a 30 minute median of hub or Pons pool samples
  (lower of spot and median), signed by a new `quote-signer` key, `burnFrom` in `OrreryTreasury.burnForCredits`, daily cap
  per buyer. Safe because the protocol pays out nothing against the quote.
- R-03 Verification in ORRY: 4 USD of ORRY, burned, then `payVerification` called by the treasury contract (fee recorded
  0), at most 25 a day.
- R-04 Buyback: `OrreryTreasury` as attestor treasury and API `payTo`, 50% of USDG revenue to a reserve, coinless until
  ORRY is set (48 h), `OrryBuyback` slices hourly at most, each hop capped at `0.5 × fee × R` from in-transaction pool
  state (a sandwich only pays above `fee × R`), all bought ORRY burned.

**R-20 Shared vault into launched coins: why not.** Single-sided ETH in a coin/ETH pool sits below the price and buys the
coin as it is sold; launched coins mostly fall (1.09% of Pons launches graduate). Section 11.4 puts the expected loss of a
full-range allocation at 46% in 30 days on stated assumptions, and breaking even on 1,000 USD would need about 186,000 USD
of volume through that one coin. Under the copy rule the product could not tell depositors this. Revisit as B' only with
30 days of Agent Launch data.

**R-05 Passive staking share: why not.** Pays holders for holding, the clearest "profit from others' efforts" pattern;
early float sits with snipers (Xulture: 32 snipers, about 41% of supply in 30 s). Boost (R-18) pays only for liquidity that
works. Owner question 7 keeps it open.

**R-06, R-07, R-09** as revision 1: no operator breach is provable on-chain today (section 10); outside probers need an
attestor v2 and a dispute quorum; an early concentrated float makes votes easy to capture and conflicts with M1 to M3.

## 10. Why slashing waits

| Candidate breach | Provable on-chain now? | Problem |
| :--- | :--- | :--- |
| Signer spends beyond caps through the module | Cannot happen | Enforced by the module (70 unit and regression tests, invariant campaign, 4,000-action deep run, 49/49 mutations, `contracts/README.md`) |
| Signer has hidden powers on the account | No | 08 §9: no read can see them; proof needs traces a contract cannot verify |
| Float above `floatMax` | Readable live | Griefable: anyone can send USDG to the signer |
| Registration file misrepresents the agent | No | Off-chain facts |
| Visible grants while staked (`signerIsAccountOwner`, `otherAccountModules`, `signerHasCode`) | Readable live through `OrreryLens` | A leaked signer key can set `signerHasCode` (EIP-7702) and burn the operator's stake; a v2 candidate with that case excluded |

v2 path if abuse data asks for it: anyone may call, only live `OrreryLens` conditions the operator alone controls, slashed
ORRY burned (no reward to the caller), capped per event, stated in the check.

## 11. Economics with numbers

### 11.1 Impermanent loss of a full-range position

| ORRY price change | 0.1x | 0.25x | 0.5x | 2x | 4x | 10x |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| LP value against holding both assets | −42.5% | −20.0% | −5.7% | −5.7% | −20.0% | −42.5% |
| LP value against the deposit (in ETH terms) | 31.6% | 50.0% | 70.7% | 141.4% | 200.0% | 316.2% |

### 11.2 Hub income (assumptions: Orrery hub takes 60% of ORRY volume because its 0.30% base fee undercuts the Pons
pool's 1%; average fee 0.40%; 85% LPs, 15% burn)

| Total ORRY volume per day | LP income per year | Burned per year | Fee return at TVL 50 K / 250 K / 1 M USD |
| ---: | ---: | ---: | :--- |
| 10,000 USD | 7,446 | 1,314 | 15% / 3% / 1% |
| 100,000 USD | 74,460 | 13,140 | 149% / 30% / 7% |
| 1,000,000 USD | 744,600 | 131,400 | 1,489% / 298% / 74% |

Returns are trailing fee figures at constant volume, before IL; volume after a launch usually decays, and TVL rises
until returns fall. The Earn page should show realised fees over the last 7 days, never a projected rate.

### 11.3 Agent Launch (assumptions: spoke fee 1%, split 50/20/15/15; 80% of spoke volume enters through the hub)

| Spoke volume per day | Creators per year | Earn boost per year | Burned per year | Owner per year | Extra hub fees per year (LPs / burn) |
| ---: | ---: | ---: | ---: | ---: | :--- |
| 10,000 USD | 18,250 | 7,300 | 5,475 | 5,475 | 9,928 / 1,752 |
| 100,000 USD | 182,500 | 73,000 | 54,750 | 54,750 | 99,280 / 17,520 |
| 1,000,000 USD | 1,825,000 | 730,000 | 547,500 | 547,500 | 992,800 / 175,200 |

Permanent lock: a graduated pool seeded like Pons (20.4% of supply with 4.2 ETH of quote) keeps at least 0.857 ETH of
quote even if every holder sells, 20.4% of its graduation quote. With ORRY as the quote:

| Agent Launch activity | Launches per day | Graduations per day (1.09%) | ORRY locked for good per year, at graduation value |
| :--- | ---: | ---: | ---: |
| 1% of Pons V2's measured activity | 10 | 0.11 | about 77,000 USD |
| 5% | 50 | 0.55 | about 385,000 USD |

Gating to verified agents shrinks the launch count: 4663 adds about 1,390 ERC-8004 agents a week, most from a few owners.
Treat 1% of Pons activity as the realistic case.

### 11.4 Option B: shared vault inside launched coins

Assumptions: after 30 days, 80% of coins trade at 0.1x and 20% at 2x; a full-range position is worth `√r` of its start
value. Expected value 0.8 × 0.316 + 0.2 × 1.414 = 0.536, a loss of 46.4% before fees. To break even on 1,000 USD at a 50%
liquidity share and a 0.5% LP fee, one coin needs about 186,000 USD of volume in 30 days, 186 times the allocation.

### 11.5 Trust-product flows (from revision 1)

Assumptions: verification 5 USDG, pack 1 USDG for 500 checks; 30% of checks bought with ORRY at 625 per USD; 20% of
verifications in ORRY at 4 USD; 50% of USDG revenue to buyback; attestation gas 1 USD per agent a year; relayer
0.004 USD per pack. Cases from `03-economics.md`.

| Case | USDG revenue without the package | USDG in with it | ORRY burned per year | Owner net of costs | Owner gives up |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Low (165 verifications, 1.2 M checks) | 3,225 | 2,340 | 1,878 | 993 | 2,055 |
| Mid (1,697 verifications, 12 M checks) | 32,485 | 23,588 | 18,912 | 10,025 | 20,691 |
| High (1,697 verifications, 240 M checks) | 488,485 | 342,788 | 287,952 | 168,348 | 317,091 |

At a 90% buyback share the mid case leaves the owner about 590 USD net; at 25%, about 15,900.

### 11.6 Reading

- The trust product's own flows are small (mid case about 19,000 USD of burns a year). Liquidity is where ORRY volume
  can be large, which is why the owner's direction moves the centre of the design.
- Earn pays LPs from real fees, so its size follows ORRY trading. A token's trading usually peaks in its first days;
  Agent Launch is what can keep volume through the hub afterwards.
- Supply effects: at a 500 K USD FDV, the mid trust case burns 3.8% a year; Agent Launch at 100,000 USD a day of spoke
  volume burns about 72,000 USD a year (spoke 54,750 plus hub 17,520), 14% of that FDV, and locks more through
  graduations. All figures hold price constant.

## 12. Recommended package

| Phase | Ships | Contents | Owner inputs |
| :--- | :--- | :--- | :--- |
| 1, next update | Right after ORRY trades (hub launch) or after Pons graduation plus 24 h | R-17 Earn, R-18 boost (switch on when the boost pool has a source), R-01 staked agents, R-02 and R-03 checkout, R-04 buyback | Q1, Q2, Q4, Q5, Q7 to Q15 |
| 2, second update | When the hub holds at least 20 ETH on its ETH side (guess), so a 0.1 ETH buy moves the hub price about 1% | R-19 Agent Launch | Q3, Q6, Q13 |
| Later | With data | R-21 ORRY-only ranges, R-10 missions, R-11 stake-for-credits, B' caps, slashing (10), probers | own planning cycles |

Why this order: Earn exists for the owner's direction and needs nothing but ORRY; Agent Launch needs a deep hub first and
is a new product line; the trust uses are cheap and keep ORRY tied to what Orrery sells.

## 13. Contract surface

No change to `OrreryPolicyModule`, `OrreryAttestor` or `OrreryLens`. New contracts, immutable, no proxy:

| Contract | Phase | Job | Admin |
| :--- | :--- | :--- | :--- |
| `OrreryHook` | 1 (hub), 2 (spoke mode) | v4 hook: dynamic fee for the hub, launch-decay then 1% for spokes, protocol part as ERC-6909 claims, burn path, spoke split | None, or one setter for the owner's operations address |
| `OrryLaunch` | 1, only if ORRY launches in the hub | Deploys ORRY (fixed supply, 1B as on Pons unless the owner picks another, `burn`, no mint, no owner), opens the hub at a start price, puts the supply in one position held forever, collects its fees weekly | None |
| `EarnVault` | 1 | Full-range hub position, shares as liquidity units, 7 day fee stream, zap with guards, 15 minute deposit lock | None over assets |
| `OrryStake` | 1 | Agent positions (per agentId) and plain positions; 14 day unbonding; time-weighted checkpoints for boost | None |
| `BoostDistributor` | 1 (switch), 2 | Weekly Merkle epochs, root total ≤ epoch pool, 72 h before claims, 180 day sweep | Owner posts roots within the bound |
| `OrreryTreasury` | 1 | Attestor treasury and `payTo`; USDG split; coinless mode; `burnForCredits`; `verifyWithOrry` | Owner: withdraw own share, set coin once (48 h), quote signers (max 3) |
| `OrryBuyback` | 1 | Permissionless bounded slices USDG to ETH to ORRY, burn all | None |
| `AgentLaunch` | 2 | Gate (verified, stake locked 90 days), coin deploy, spoke pool, supply position held forever, creator first-buy cap, creator fees to the bound Safe | None |

Services: API quotes and credits from events; check v2 with stake fields; prober frequency for staked agents; indexer for
stake, vault, hook, launch, burn events and pool samples (request-priced RPC per workspace rule 7); keeper for slices,
weekly collects and boost tables (owner-funded gas); web pages Earn, Stake, Launch, Burn behind the release switch
(`UPDATE-CANDIDATES.md` 3.11).

Effort, rough: phase 1 four to five weeks including invariant, mutation and fork tests (hook and vault are the heavy
parts; Elysium `StakeVault` and SNOP DAMM are close references); phase 2 three to four weeks (Hashborn and Origo launch
contracts are close references).

## 14. Invariants

Earn and hook
- E-1: `EarnVault` assets leave only to a share holder redeeming their own shares, or into the hub position during a
  deposit or zap in the same call.
- E-2: Share price changes only through fees and pool price; deposits and withdrawals leave it unchanged up to rounding,
  and rounding never favours the caller.
- E-3: No address can move vault assets or block withdrawals; locked shares (15 minutes) cannot be redeemed or
  transferred early.
- E-4: For every hub swap, LP fee plus protocol fee equals the charged fee; the protocol fee is at most 15% of it and is
  only ever burned (directly or after a bounded buy).
- E-5: For every spoke swap after its launch window, creator, boost, burn and owner parts sum to the fee, in the fixed
  50/20/15/15 ratio; the creator part reaches only `getAgentWallet(agentId)` as recorded at launch.
- E-6: No code path decreases the liquidity of a launch supply position (hub launch and spokes).
- E-7: The fee never exceeds 1% in the hub and never exceeds the launch window's starting fee in a spoke.

Boost
- B-1: An epoch's claims never exceed its root total, which never exceeds the epoch's pool; each leaf is claimed once.
- B-2: A root is accepted only after the epoch closed and 72 hours after its table was published; claims open 72 hours
  after the root.

Stake (from revision 1)
- ST-1: ORRY leaves `OrryStake` only to a position's staker, only after its `leavingAt`.
- ST-2: Positions sum to the contract's credited balance.
- ST-3: A check that reports `active = A` at time t implies at least A stays locked until t + 14 days.
- ST-4: A launch-locked stake cannot enter `leaving` before its 90 day lock ends.
- ST-5: No privileged function.

Treasury and buyback (from revision 1)
- TR-1: `ownerAccrued + buybackReserve ≤ USDG balance`.
- TR-2: USDG leaves only to the owner (≤ `ownerAccrued`) or the executor (≤ the daily pull bound).
- TR-3: Coin and executor set at most once, at least 48 hours after the proposal.
- TR-4: After the coin is set the reserve only falls through `pullBuyback`.
- TR-5: Every `CreditsPaid` and `VerificationBurned` comes with an equal fall in ORRY total supply in the same call;
  quotes are single-use and unexpired.
- TR-6: At most 25 `verifyWithOrry` per UTC day. TR-7: the treasury holds no ORRY after a call.
- BB-1 to BB-3: hourly at most, each hop within half its fee of price movement, everything bought is burned.

Global
- G-1: Orrery never mints ORRY after creation.
- G-2: v1 invariants unchanged; the SDK refuses session targets equal to any new contract.

Tests: invariant campaigns for every set above, mutation runs, fork tests on 4663 against the real PoolManager
`0x8366…0951`, the ETH/USDG v4 pools, a real Pons V2 token (if ORRY launches there), launch-time front-running of pool
initialisation (the Reelo `GraduationV4.t.sol` cases), JIT liquidity against the vault, and a sandwich at the real fee.

## 15. Launch sequence relative to the token

Path A, ORRY launches in the Orrery hub (owner question 1, option A):

| Step | When | What |
| :--- | :--- | :--- |
| L0 | Owner CONFIRM of `deploy-4663.ts` | v1 live, treasury = owner wallet (M1) |
| L1 | Before the token | Build and fork-test `OrreryHook` (hub mode), `OrryLaunch`, `EarnVault`, `OrryStake`, `OrreryTreasury`, `OrryBuyback`; deploy `OrreryTreasury` coinless and point the attestor and API to it (Q9) |
| T0 | After v1 has its first real users (W2) | `OrryLaunch` creates ORRY and the hub; decaying launch fee; team wallets get no allocation |
| T0 + 24 h | Opening volatility passed | `EarnVault` opens; `proposeCoin` on the treasury; staked agents and check v2 |
| T0 + 72 h | Coin delay over | Checkout and verification in ORRY; buyback slices; burn page |
| Phase 2 | Hub ETH side at least 20 ETH | `AgentLaunch` and spoke mode; boost epochs start |

Path B, ORRY launches on Pons V2 (option B): as revision 1 (curve, graduation, 24 h of price samples), then the hub pool
is created and seeded by the first Earn deposits after graduation plus 24 hours; the Pons pool keeps its 1% fee with 0% to
LPs, and Earn competes for volume with a lower fee.

Every use is announced only when its wave is open; until then the site lists it as Coming soon, the same wording
everywhere (workspace rule 1).

## 16. Risks and conflicts

| Area | Risk | Handling |
| :--- | :--- | :--- |
| Legal | A launchpad, LP rewards and a burn tied to revenue; passive revenue share would read as an investment contract in several jurisdictions | No passive share; rewards only for liquidity that works or for use; counsel review before Earn and Agent Launch open (Q13) |
| Legal | Related-party income: the owner's 15% of spoke fees and 50% of launch-position fees | Recorded internally; fixed and visible on chain |
| Copy rule | LP products carry IL, which the UI may not describe as risk | Design keeps LPs out of launched coins (option C); the Earn page states composition and realised fees only |
| Market | Volume decays after launch; Pons runs about 1,007 launches a day | Agent Launch is gated and differentiated; returns shown as realised, never projected |
| Manipulation | Wash trading in spokes to farm the boost pool | Wash pays 1.4% to recycle 0.2% (net loss); boost weighted by liquidity and stake, not by trading |
| Manipulation | A creator wash-trades its own coin to fake volume (it gets 50% of the fee back to its agent account, up to 0.2% more through boost) | Net cost 0.3% of the faked volume, so fake volume is cheap; the coin page shows distinct traders and the creator account's share of volume, and the indexer flags coins whose volume comes mostly from addresses linked to the creator |
| Manipulation | JIT liquidity and sandwiches on the vault | 15 minute deposit lock; same-block guards; `minOut` |
| Snipers | Launch blocks of ORRY and agent coins | Decaying launch fee per pool; optional fair window |
| Brand | A falling agent coin next to a Orrery record | Checks stay factual; the coin page shows facts, never a verdict |
| Fragmentation | ORRY on Pons plus the hub (path B) | Path A avoids it |
| Dependency | Pons fee, burn semantics, transfer restrictions (path B) | Read on the live token before deploying |
| Code reuse | SNOP code belongs to Neo's organisation | Owner's word first; independent code with own tests |
| Decision Q5 | R-01 adds a stake | Owner question 8 |
| Decision M1 | Treasury becomes a contract | Same key; `setTreasury` can revert it; Q9 |
| Decision W2 | Token before a used product | Token after v1 has real users |
| Decision I4 | Token must not weaken policy | No token path touches module constants |

## 17. Copy notes

- Earn: "Add ETH, ORRY or both. Your share earns from every swap in the ORRY pool." Show realised fees over the last
  7 days and the vault's composition.
- Boost: "Stake ORRY to raise your share of Earn rewards, up to 2.5 times."
- Agent Launch: "Launch a coin for your verified agent. Its fees go to the agent's account, which runs on public limits."
- Stake: "Stake ORRY behind this agent. Merchants see the amount in every check. Unstaking takes 14 days."
- Checkout: "625 checks per 1 USD of ORRY. ORRY used here is burned."
- Never: projected rates, APY forecasts, price talk, "guarantee", risk or caution lines, disclaimers, admin powers.

## 18. Owner decisions

1. **Where does ORRY launch?**
   - A. In the Orrery hub pool: supply single-sided and held forever, decaying launch fee, Earn opens 24 hours later (Recommended): every ORRY trade pays Orrery LPs; needs about two more weeks of build before T0.
   - B. Pons V2 now: fastest; its pool pays LPs 0%, the hub competes for volume.
   - C. Pons V2 with a 1% creator tax (the aethernode choice): as B, plus related-party income on protocol buys.
2. **When does the token launch?**
   - A. After v1 is live and has its first verified agents and pack buyers (Recommended): keeps W2.
   - B. The same day as v1.
   - C. Before v1: reverses W2.
3. **Does Orrery get a launchpad?**
   - A. Agent Launch as phase 2: verified agents only, stake locked 90 days, coins paired with ORRY (Recommended).
   - B. Agent Launch with coins paired with ETH: simpler for traders, no ORRY pair demand, hub LPs earn nothing from launches.
   - C. No launchpad: Earn earns only from ORRY trading.
4. **How is the shared pool built?**
   - A. Hub and spoke: the Earn vault funds ORRY/ETH only; launched coins use their own locked supply (Recommended): LPs never hold launched coins.
   - B. A shared ETH vault that also places liquidity in launched coins, capped at 1% per coin and 20% in total: deeper coin markets, expected losses on falling coins.
   - C. Per-coin pools only, no shared vault.
5. **Hub fee?**
   - A. 0.30% base, rising with volatility to at most 1%, 85% LPs and 15% burned (Recommended).
   - B. 1% flat, 90% LPs and 10% burned: more per trade, less routed volume.
   - C. 0.30% flat, 85/15.
6. **Spoke fee split (1% per swap)?**
   - A. Creator 50%, Earn boost 20%, burn 15%, owner 15% (Recommended).
   - B. Creator 70%, burn 15%, owner 15%: Pons-like for creators, nothing for LPs.
   - C. Creator 40%, Earn boost 30%, burn 15%, owner 15%.
7. **How does ORRY earn?**
   - A. As Earn inventory and boost stake, rewards in ORRY from fees, no emissions (Recommended).
   - B. A plus a passive staking share of fees: counsel first, yield framing.
   - C. Emission rewards: needs a reserved allocation, which a Pons launch cannot have.
8. **Do operators stake ORRY behind agents (re-decides Q5)?**
   - A. Yes, a lock with 14 day unbonding, no slashing, reported in checks, counting for boost (Recommended).
   - B. A slashable bond: needs the v2 design of section 10 first.
   - C. No.
9. **ORRY for checks and verification?**
   - A. Packs at 625 checks per 1 USD of ORRY and verification at 4 USD of ORRY, both burned, verification capped at 25 a day (Recommended).
   - B. Packs only.
   - C. USDG only.
10. **USDG revenue buyback share, all burned?**
    - A. 50%, all burned (Recommended): mid case burns about 11,800 USD a year, owner nets about 10,000.
    - B. 25%, all burned.
    - C. 90% with half to stakers (aethernode D-52): owner nets about 590 at mid; revenue share framing.
11. **When does the treasury become `OrreryTreasury`?**
    - A. Before the token, in coinless mode (Recommended).
    - B. After ORRY trades.
    - C. Never; buyback by hand.
12. **Governance?**
    - A. None on-chain; the owner keeps fees and prices (Recommended).
    - B. Off-chain signal polls weighted by stake, later.
    - C. On-chain governor.
13. **Counsel review?**
    - A. Before Earn and Agent Launch open (Recommended).
    - B. No review.
14. **Fees of the protocol-held ORRY launch position (path A only)?**
    - A. 50% to the boost pool, 50% to the owner (Recommended): LPs earn from the launch's own liquidity, the owner has an operations income.
    - B. 100% burned.
    - C. 100% to the owner.
15. **May Orrery reuse SNOP code (Neo's organisation)?**
    - A. Use it as reference only; write independent contracts with their own tests (Recommended).
    - B. Copy with Neo's permission.
16. **Hub pool fee next to the Pons pool (Pons edition, section 19)?**
    - A. 1% flat: routing splits by depth, so the owner's Pons creator income is not undercut (Recommended).
    - B. 0.30% to 1% dynamic: more routed volume for hub LPs, less volume and creator income on the Pons pool.

## 19. Pons edition (owner, 2026-11-08): ORRY launches on Pons V2

Owner, quoted: "saya berencana launch token nya di pons pastikan smartcontract nya bisa mencover itu agar liquidity
provider bisa mendapatkan passive income dengan aman dan semua tombol claim nya ada". This settles question 1 as option B
(Pons V2) and asks for passive income for LPs, safely, with every claim button present. Path B of section 15 applies.

### 19.1 Pons facts that shape the contracts (read on 4663, 2026-11-08)

| Fact | Value | Source |
| :--- | :--- | :--- |
| Creator fee recipient | A launch parameter (`launchToken` params `creatorFeeRecipient`), any address, so a contract can receive it from the first trade | factory ABI (Sourcify) |
| Changing it later | `setCreatorFeeRecipient` / `transferCreatorFeeRecipient` behind a 259,200 s (3 day) timelock and a 3 day execution window | `CREATOR_FEE_RECIPIENT_TIMELOCK`, `..._EXECUTION_WINDOW` |
| Creator tax | `creatorTaxBps` at launch, at most 10% (`maxCreatorTaxBps` 1000), paid to the creator side | factory views |
| Where creator fees land | FeeEscrow `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`: `credit(recipient)` (ETH), `creditToken`; the recipient takes them with `claim()` / `claimToken(token)` as `msg.sender` | FeeEscrow ABI |
| Sweeping fees out of the hook | MemeHook `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` `sweepPoolFees(poolId, minConversionQuoteOut, minBuybackTokensOut)`; in the SNOP code with the same component names, quote-side sweeps are permissionless and token-side conversion is operator-only (`snopfamily-defi/packages/contracts/src/MemeHook.sol` line 117 to 132); to confirm on the live hook by fork test | MemeHook ABI, SNOP source |
| Split of the 1% hook fee | 30% Pons (`protocolFeeShareBps` 3000), the rest to the creator side; with `buybackEnabled`, half of the creator side buys the token, locked in BuybackVault `0x42df…219c` and vested to the creator recipient over five years | `getLaunchFeePolicy`, BuybackVault ABI |
| Graduated pool | Uniswap v4, LP fee 0, liquidity locked; outside LPs earn nothing there | `getLaunchConfig(0)` |

Owner rule, quoted (2026-11-08): "perlu di ingat trading fee dari pons adalah hak milik owner dan tidak akan di masukkan ke
protokol, semua fee yg di berikan ke user didapat dari pendapatan dan aktivitas di protokol". So the Pons creator fee
recipient is the owner's own wallet, the creator tax and the Pons buyback setting are the owner's own choices, and no
Orrery contract touches Pons fees (same rule as aethernode D-52). Every reward paid to users comes from Orrery's own
revenue and activity: the hub pool's swap fees, USDG product revenue (verification fees, check packs) and ORRY used
inside the product.

Consequence: on Pons, ORRY LPs and stakers can only be paid from (a) fees of Orrery's own ORRY/ETH pool and (b) a share
of Orrery's USDG revenue. The Pons graduated pool pays LPs 0% and its fees stay with Pons and the owner.

Side effect to decide: a Orrery hub with a lower fee than the Pons pool's 1% draws routed volume away from the Pons
pool, which lowers the owner's Pons creator income. Matching the Pons fee (1%) keeps routing split by depth instead of by
fee (question 16).

### 19.2 Money flow

```
Pons curve and graduated pool (1% fee, plus creator tax)
  ├─ 30% of the fee ─► Pons
  └─ creator side ───► the owner's wallet (creator fee recipient)        never enters the protocol

Orrery ORRY/ETH hub pool (opens after graduation)
  ├─ 85% of every swap fee ─► LP fee to in-range positions (EarnVault and anyone else)
  └─ 15% of every swap fee ─► OrryRewardsRouter
Orrery USDG revenue (verification fees, check packs) ─► OrreryTreasury
  ├─ owner share (default 50%) ─► the owner
  └─ reward share (default 50%) ─► OrryBuyback: USDG to ETH to ORRY on v4 ─► OrryRewardsRouter
OrryRewardsRouter
  ├─ staking rewards (default 50% of what it receives, streamed 7 days to ORRY stakers)
  └─ burn (default 50%)
ORRY spent on checks and verification ─► burned
```

### 19.3 Contracts (no change to the v1 contracts)

| Contract | Job | Claim and exit buttons it serves |
| :--- | :--- | :--- |
| `OrryRewardsRouter` | Receives only protocol money: the hub hook's 15% part and the ORRY bought with the treasury's reward share. `distribute()` (anyone, at most hourly): splits by constructor bps into staking rewards and burn. Touches no Pons contract | **Distribute** (anyone) |
| `OrreryHook` (hub mode) | Dynamic fee (question 16), 85% LPs, 15% to `OrryRewardsRouter`; no tokens held | none (fees reach LPs natively) |
| `EarnVault` | Deposit ETH, ORRY or both (zap with `minOut` and same-block guard); one full-range hub position; shares as liquidity units; LP fees streamed 7 days; 15 minute deposit lock | **Deposit**, **Withdraw** (any time after the lock, never pausable), **Claim fees** (ETH and ORRY) |
| `OrryStaking` | Plain stake and stake behind an agentId (R-01, reported in checks); rewards in ETH and ORRY from `OrryRewardsRouter`, streamed 7 days; unstake cooldown (default 7 days for plain, 14 days for agent stake) | **Stake**, **Request unstake**, **Withdraw** (after cooldown), **Claim rewards** |
| `ClaimAll` and `OrryLens` | One call claims every reward of the caller (each contract's `claimFor(account)` pays only `account`); one view lists every claimable and every ready withdrawal | **Claim all**, the claim center page |
| `OrreryTreasury` and `OrryBuyback` | As R-02 to R-04: USDG product revenue split into the owner share and the reward share; ORRY checkout and verification burns; bounded buyback of the reward share on v4 (Origo `FeeSwapper` / `BuybackBurner` route), with the ORRY bought sent to `OrryRewardsRouter` | **Run buyback slice** (anyone), **Withdraw owner share** |

Boost (R-18) and Agent Launch (R-19) stay for later; staking rewards replace boost as the ORRY earning path for now.

### 19.4 Safety requirements for every contract above

- No owner or admin power can move user deposits, stakes or accrued rewards; deposits may be paused, withdrawals and
  claims never.
- Every split, fee bound, stream period and cooldown is a constructor constant; the owner can only withdraw the owner
  share and set the token address once.
- Rewards stream over 7 days, so depositing just before a harvest earns nothing extra; deposit lock 15 minutes.
- Balance-delta accounting on every intake; reentrancy guard on every state-changing function; vault shares are
  liquidity units the vault added (no inflation attack).
- No Orrery contract calls, holds or redirects Pons fees (owner rule, 19.1).
- Tests: unit, fuzz and invariant campaigns with mutation checks; fork tests on 4663 with a real Pons launch on a fork
  (curve trades, graduation, then the hub pool opened next to the Pons pool), the hub pool's initialisation front-run,
  JIT liquidity against the vault, a sandwich at the real fee, and the buyback route into ORRY.

### 19.5 Deploy-time parameters (constructor values, decided before mainnet deploy; defaults)

| Parameter | Default (recommendation) |
| :--- | :--- |
| Pons launch settings | creator fee recipient = the owner's wallet; creator tax and Pons buyback: the owner's choice (outside the protocol) |
| Hub fee | 1% flat to leave the owner's Pons income unchanged by routing, or 0.30% to 1% dynamic to win routed volume (question 16); 85% LPs, 15% to the rewards router |
| Treasury split of USDG revenue | owner 50%, reward share 50% (bought into ORRY) |
| Rewards router split | staking rewards 50%, burn 50% |
| Cooldowns | plain unstake 7 days, agent stake 14 days, deposit lock 15 minutes, reward stream 7 days |

Rough size at the mid product case and 100,000 USD a day of ORRY volume through the hub (60% share, 0.40% average fee):
hub protocol part about 13,100 USD a year and the treasury reward share about 11,800 USD a year reach the router, so
stakers receive about 12,500 USD a year and about 12,500 USD of ORRY is burned; hub LPs earn about 74,500 USD a year
(table 11.2). At a 1% hub fee, LP income per routed dollar rises 2.5 times but the hub's routed share falls.

Legal, stated once: staking rewards paid from protocol revenue to passive holders are the pattern counsel flagged in
aethernode (O-6); counsel review before the Stake page opens is recommended (question 13).

### 19.6 Feature checklist

- [ ] 1. `OrryRewardsRouter`: protocol money only (hub 15% part, treasury reward share), Distribute button, split to stakers and burn
- [ ] 2. ORRY/ETH hub pool on `OrreryHook` and `EarnVault` (deposit, withdraw, claim fees, claim rewards)
- [ ] 3. `OrryStaking`: stake ORRY, ETH rewards, unstake and withdraw, agent stake in checks
- [ ] 4. `ClaimAll` and `OrryLens`: one Claim all button, one claim center view
- [ ] 5. Test suite: unit, fuzz, invariant, mutation
- [ ] 6. Fork tests against live Pons (fee path, graduation, hub init, JIT, sandwich)
- [ ] 7. Keeper: daily harvest, stream notifications, buyback slices
- [ ] 8. ORRY checkout for packs and verification in ORRY (burned)
- [ ] 9. `OrreryTreasury` coinless mode and USDG buyback, burned
- [ ] 10. Check result v2 with agent stake fields
- [ ] 11. Indexer and API: events, pool stats, claimables, quotes
- [ ] 12. Web: Earn page
- [ ] 13. Web: Stake page and agent stake panel
- [ ] 14. Web: Claim center page
- [ ] 15. Web: Burn page and Earn statistics
- [ ] 16. Docs pages for Earn, Stake and claims

### 19.7 Parallel build lanes once the checklist is ticked

| Lane | Items | Folder (own git worktree and branch) | Starts |
| :--- | :--- | :--- | :--- |
| Spec freeze | interfaces and invariants for items 1 to 4 and 9 | `orrery/docs/` (this session) | first, about half a day |
| A. Earn contracts | 1, 2, 4, 5, 6 | `contracts/src/orry/` and `contracts/test/orry/` | after the freeze |
| B. Stake and treasury contracts | 3, 8 (contract side), 9 | same project, separate files | after the freeze |
| C. Services | 7, 8 (API side), 10, 11 | `services/packages/server`, `indexer`, `sdk` | after the freeze, against the frozen ABIs |
| D. Web | 12 to 16 | `services/packages/web` | after the freeze; coordinate with the session redesigning the web app |

## 20. Summary for the owner

The centre of the next update is Orrery Earn: one ORRY/ETH pool on Uniswap v4 that anyone funds with ETH, ORRY or both,
paying 85% of every swap fee to depositors and burning 15%; staking ORRY raises a depositor's share up to 2.5 times. The
second update adds Agent Launch: only verified agents launch coins, paired with ORRY, so every agent-coin trade passes
through the Earn pool and pays its depositors without them ever holding a launched coin; creators' fees go to the agent's
account with public limits. The trust uses of revision 1 (stake behind agents, checkout in ORRY, buyback) stay as the
third block. The questions that gate the build are 1 (launch venue), 3 (launchpad yes or no) and 4 (pool design).
