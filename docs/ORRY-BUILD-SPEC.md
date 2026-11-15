# ORRY build spec (Pons edition), frozen for parallel lanes

Date: 2026-11-08 (WIB). Branch `orry/spec`. Owner of this file and of `contracts/src/orry/interfaces/**`,
`contracts/foundry.toml`, `services/packages/shared/src/orry-abi.ts`: the orchestrating session. Lanes read them and
request changes; they never edit them. Background and reasoning: `docs/ORRY-TOKEN-UTILITY.md` section 19.

## 1. Decisions this build implements

| Id | Decision | Source |
| :--- | :--- | :--- |
| R-1 | ORRY launches on Pons V2. Every Pons trading fee belongs to the owner and never enters the protocol: the Pons creator fee recipient is the owner's wallet, and no Orrery contract calls, holds or redirects Pons fees | owner, 2026-11-08 |
| R-2 | Every reward paid to users comes from Orrery's own revenue and activity: hub pool swap fees, USDG product revenue, ORRY spent in the product | owner, 2026-11-08 |
| R-3 | Build all 16 checklist items of `ORRY-TOKEN-UTILITY.md` 19.6 | owner, 2026-11-08 (all ticked) |
| R-4 | Treasury: 90% of USDG revenue buys ORRY, 10% to the owner | owner, 2026-11-08 |
| R-5 | Web adds a leaderboard of top stakers and top earners with how much they earned; wallet addresses partly hidden (`0x1234…abcd`) | owner, 2026-11-08 |
| R-6 | Hub fee about 1.00%: LP fee 0.85% in the key, hook fee 0.15% of the unspecified side, flat (no dynamic fee in this build) | delegated: recommendation A of question 16, so the owner's Pons income is not undercut by routing; constructor values, the owner may change them before deploy |
| R-7 | Rewards router: 50% of each asset to stakers, 50% burned (ORRY directly, ETH through the buyback) | delegated default (19.5), constructor value |
| R-8 | Cooldowns: plain unstake 7 days, agent stake 14 days; reward streams 7 days; Earn deposit lock 15 minutes | delegated defaults (19.5) |
| R-9 | Checkout: 625 checks per 1 USD of ORRY; verification 4 USD of ORRY; at most 25 ORRY verifications a day | delegated defaults (R-02, R-03) |
| R-10 | No proxy, no upgrade. No admin power over user deposits, stakes or rewards; withdrawals and claims never pausable | workspace rules, 19.4 |
| R-11 | Nothing is deployed to 4663 by any lane. Mainnet deploy only on the owner's word with a typed CONFIRM | workspace rules |
| R-12 | ORRY launches the same day as Orrery v1, and `OrreryTreasury` (coinless) is deployed with v1 on 4663. The v1 mainnet deploy waits on the treasury, so lane B delivers it first | owner, 2026-11-08 (T2, T11) |
| R-13 | Agent Launch comes in the second update (verified agents, stake locked 90 days, coins paired with ORRY, spoke fee 1%: creator 50, Earn LPs 20 in ORRY, burn 15, owner 15). Not built now; this build must not block it: `OrryStaking` gains `extendAgentLock` (section 3.3) | owner, 2026-11-08 (T3, T4, T6) |
| R-14 | No legal review before Earn and Stake open | owner, 2026-11-08 (T13) |
| R-15 | SNOP code (hook, vault, buyback) may be copied into Orrery; copied code still gets Orrery's own tests, invariants and mutation checks | owner, 2026-11-08 (T14) |
| R-16 | No integration with other projects: features from other projects are rebuilt as Orrery's own contracts | owner, 2026-11-08 (U1) |
| R-17 | The same-block guard (hook record, vault zap, buyback) keys on EVM `block.number`. On 4663 that is the L1 block number (about 12 s, about 120 L2 blocks), so the guard window is an L1 block: stricter for honest zaps and slices in busy trading, never weaker. Kept; no ArbSys call | delegated, 2026-11-08 (lane A point 1, lane B reading 3) |
| R-18 | Buyback hop 1 manipulation (finding F-1): `OrryBuyback` takes a constructor `maxSliceUsdgCap` (default 1,000 USDG) that bounds every slice, and before hop 1 it reads every listed ETH/USDG pool whose in-range liquidity is at least 1% of the chosen pool's and reverts `PriceMovedInBlock` unless each price is within 0.5% of the chosen pool's price (pre-trade, price terms). No ABI change | delegated, 2026-11-08 (section 3.6) |
| R-19 | Finding F-2 (1 wei `notifyRewards` restarts a stream) accepted: rewards are delayed, never lost; `notifyRewards` stays open | delegated, 2026-11-08 |
| R-20 | Finding F-3: `IOrreryTreasury` gains `OwnershipTransferStarted`, `OwnershipTransferred` and `pendingOwner()` | delegated, 2026-11-08 (interface change, ABI regenerated) |
| R-21 | Lane readings confirmed as written: lane A points 2 to 6 (zap `msg.value` mismatch reverts `ZeroAmount`; vault periods are constants; claims carry no price guard; `collect` forwards stray balances; hub initialisation open to anyone, the deploy script initialises it at the Pons pool price right after the hook); lane B readings 1, 2, 4 to 7 (B-2 on sqrtPrice with a v4 price limit and full fill; hop fee = LP fee + PoolManager protocol fee (+ hook fee in the hub); `notifyRewards` restarts only the assets paid in; `burnEth` burns its whole ORRY balance; pull window starts at the first pull; `1 USDG` from `usdg.decimals()`; `sync` below the books books nothing) | delegated, 2026-11-08 |
| R-22 | Services: ORRY's USD price composes the hub with the deepest ETH/USDG pool (pool 1 of section 2, `ORRERY_ORRY_USD_POOL_ID`); credits granted = `packs × pack size × 625/500`; check v2 is signed only while the `stake` feature is open | delegated, 2026-11-08 (lane C decisions 1 to 3) |
| R-23 | Markets for ORRY value: rebuild all four Quero groups as Orrery's own (private trading: Dark Pool, Private Swap, Stocks, Shield V2; stock markets: Baskets, Prediction markets, limit orders; leverage: Perps, Lend and Multiply, Pair trading, Funding arbitrage, Vaults; RWA issuance with investor verification, primary sales and launch tools). Plan: `docs/ORRY-MARKETS-PLAN.md` | owner, 2026-11-08 (answer "Private trading, Pasar saham, Leverage, Penerbitan RWA") |
| R-24 | Value levers: all of L1 (USDG fees to the treasury, 90% buys ORRY), L2 (staker fee tiers), L3 (pay fees in ORRY, burned), L4 (agent stake gates) and L5 (ORRY as collateral and as a market currency) | owner, 2026-11-08 (answer "Semua, termasuk ORRY jaminan") |
| R-25 | The venues are open to every wallet from the start, not agents first; this supersedes U2's agent-first order for these venues | owner, 2026-11-08 (answer "Semua orang sejak awal") |
| R-26 | Custody of stock tokens and USDG: the risk of holding them stays with the user, not with Orrery's contracts ("bebankan resiko menyimpan nya ke user jangan ke contract kita. kita hanya memberikan fasilitasnya resiko di tanggung users"). Design rule in `ORRY-MARKETS-PLAN.md` section 6, pending the owner's approval of the resolutions | owner, 2026-11-08 |
| R-27 | Custody rule approved: wallet-to-wallet settlement (pattern A), per-user accounts (B), per-market pools (C), as in `ORRY-MARKETS-PLAN.md` section 6, with invariants X-1 to X-4 | owner, 2026-11-08 (answer "Tiga pola") |
| R-28 | A time-weighted price for ORRY is added to `OrreryHook` before its mainnet deployment (section 3.1, invariants H-5 to H-8), so ORRY collateral (R-24 L5) has a manipulation-resistant price | owner, 2026-11-08 (answer "Sekarang, sebelum deploy") |
| R-29 | Market waves after v1 and the ORRY launch: R1 Dark Pool, Private Swap, Stocks; R2 Shield V2, Prediction markets, limit orders; R3 Perps, Lend and Multiply, Pair trading and arbitrage, Vaults; R4 RWA issuance with investor verification, launch tools | owner, 2026-11-08 (answer "Trading dulu") |
| R-30 | No legal review before perps, prediction markets or RWA issuance open (as T13 for Earn and Stake). Consequence, stated once: these venues open without legal advice on securities, derivatives or investor verification rules in users' countries | owner, 2026-11-08 (answer "Tanpa review", over the recommendation of a review before RWA issuance) |
| R-31 | Community Chat fees (a USD price paid in ORRY at the hub TWAP) all go to the Reward Pool. Plan: `docs/ORRY-CHAT-PLAN.md` | owner, 2026-11-08 (answer "Semua ke Reward Pool") |
| R-32 | Chat moderation: messages stay on chain; Orrery's site hides a message once enough ORRY stakers report it (on-chain `report` by stakers above a minimum stake; the count and the minimum are constructor values, guesses 5 reporters and 10,000 ORRY) | owner, 2026-11-08 (answer "Sembunyi dari laporan", over the recommended hide list kept by the treasury wallet) |
| R-33 | Reward Pool events: the treasury wallet creates events and publishes winners; payout opens after a 48 hour public check window; one event locks at most 25% of the pool's free balance; with no winner by the deadline the amount returns to the pool | owner, 2026-11-08 (answer "Jendela cek 48 jam + batas 25%") |
| R-34 | "Most active" events rank addresses by protocol fees paid in USD over the window | owner, 2026-11-08 (answer "Fee protokol yang dibayar") |
| R-35 | ORRY trades in several hub pools on one hook: ORRY/ETH and ORRY/USDG at launch, each feeding its own Earn vault and the rewards router. Plan: `docs/ORRY-PAIRS-PLAN.md`. The ORRY deployment waits for this change | owner, 2026-11-08 (answer "ETH + USDG"; outline relayed by the Orrery session, owner "A") |
| R-36 | New pairs after deployment: proposed by the treasury wallet, executable after 48 hours (within 7 days), at most 8 pairs in total, only tokens with a Chainlink USD feed on 4663; no pair, fee or vault can be changed or removed | owner, 2026-11-08 (answer "48 jam, maks 8, wajib feed") |
| R-37 | Fees from hubs other than ETH are turned into ORRY by the buyback in that hub and reach the router, which gives half to stakers and burns half; staking is unchanged | owner, 2026-11-08 (answer "Diubah jadi ORRY") |
| R-38 | SOL, HYPE and similar pairs wait for an official bridged token with depth and a Chainlink feed on 4663 (none of the 62 feeds on 4663 is SOL or HYPE, read 2026-11-08) | owner, 2026-11-08 (answer "Tunggu feed resmi") |
| R-39 | Chat order: after the ORRY launch, wave C1 (chat, Reward Pool and its events, names, tips, report moderation) runs alongside R1; wave C2 (staker rooms, weekly quests, agent promotion) runs alongside R2 | owner, 2026-11-08 (answer "Bersamaan dengan R1") |
| R-40 | Achievement Board pages show the reward per person and the recipients' leaderboard by completion time; the contract enforces the recipient cap, and no remaining-slot counter is shown (rule 4) | owner, 2026-11-08 (answer "Hadiah + daftar penerima") |
| R-41 | Mission and achievement proof is mixed: what a contract can check (stake, lock, agent verification) is claimed on chain; the rest is a completer list published by the treasury wallet with a 48 hour public check window, ordered by completion time | owner, 2026-11-08 (answer "Campuran") |
| R-42 | Achievements paying ETH, USDG or another asset show "Coming soon" until the treasury wallet deposits that asset into the Reward Pool; ORRY achievements open first | owner, 2026-11-08 (answer "Coming soon sampai disetor") |
| R-43 | No raffle in the missions list | owner, 2026-11-08 (answer "Tanpa raffle") |
| R-44 | ORRY utilities 1 to 9 (approved by the owner, relayed) and 10 to 15 (all three groups chosen: USD thresholds and pay-as-you-go checks; ORRY for x402 payments and agent gas through a paymaster; burn-to-boost and day or week passes). Plan: `docs/ORRY-UTILITIES-PLAN.md` | owner, 2026-11-08 |
| R-45 | Cashback (7) and referral rewards (8) are funded from the buyback's ORRY output: a fixed share (10%, guess, constructor value) taken before the router's 50/50 split | owner, 2026-11-08 (answer "Dari hasil buyback") |
| R-46 | Utility order follows the plan's map: USD thresholds now, before R1's tiers freeze; pay-as-you-go checks with the ORRY launch; the rest with the waves they belong to | owner, 2026-11-08 (answer "Ikuti peta usulan") |
| R-47 | Third-party attesters (utility 2) are open to anyone who stakes at least 1,000,000 ORRY as attester stake; the active set is the top 20 by that stake, recomputed each weekly epoch; no slashing. Design in `docs/ORRY-UTILITIES-PLAN.md` section 2 | owner, 2026-11-08 (answer "terbuka untuk umum dengan stake minimum 1M Orry jika bisa atau carikan konsep yg lebih baik tapi batas 20 attester saja dengan posisi teratas") |
| R-48 | Before deployment (blockers in `docs/ORRY-UPGRADE-PATHS.md`): B-1 `OrryBuyback` keeps a cashback sink for R-45 (10% of ORRY bought by slices and quote buys, sink set once by the treasury owner after 48 h, router gets everything until then); B-2 `IEarnVault.notifyRewards` so T6's Earn share can be paid into existing vaults (invariant E-7) | delegated, 2026-11-08 (implements owner decisions R-45 and T6 on immutable contracts) |
| R-49 | Orrery Data official datasets: agents, agent economy, stocks on 4663, Pons launches, ORRY economy, chain health at D1; market results and community data with R1 and C1. Plan: `docs/ORRY-DATA-PLAN.md` | owner, 2026-11-09 (all four groups) |
| R-50 | Official data is paid in ORRY only; 70% of the ORRY received is burned and 30% goes to the Reward Pool for missions (through `DataFeeSplitter`) | owner, 2026-11-09 (answer "data dari kita dibayar menggunakan ORRY dan 70% ORRY yg masuk langsung dibakar sisa 30% masuk ke reward pool untuk di bagikan sebagai misi") |
| R-51 | Third-party data providers list openly with an ORRY stake worth a USD minimum; the facilitator takes 1% of each payment | owner, 2026-11-09 (answer "Terbuka dengan stake") |
| R-52 | Data responses are signed by a separate data-signer key, never the check signer | owner, 2026-11-09 (answer "Kunci data-signer terpisah") |
| R-53 | Referral (utility 8, strengthened): the referrer earns 20% of the fees the referee actually pays (check packs, verifications, market fees) for 90 days, paid in ORRY from the cashback sink (R-45) | owner, 2026-11-09 (answer "20% selama 90 hari") |
| R-54 | The referee gets a 10% fee discount for 90 days | owner, 2026-11-09 (answer "Diskon fee 10% selama 90 hari") |
| R-55 | Referral rewards are capped at 1,000 USD of ORRY per referrer per month and claimable 30 days after they accrue | owner, 2026-11-09 (answer "1.000 USD/bulan, tahan 30 hari") |
| R-56 | Merchant referrals count twice; referrers with at least 1,000 USD of ORRY staked get 1.25 times their share | owner, 2026-11-09 (answer "Merchant x2, staker x1,25") |
| R-57 to R-62 | Business model (owner, 2026-11-09): facilitator fee 0.2% via per-merchant splitters; tiered check pricing (1,000 free a month, 0.004 then 0.002 USD, 99 USDG plan); treasury 70/30 via OWNER_BPS 3000 (supersedes R-4/T9); official data also in USDG, ORRY 20% off; agent-focused roadmap (R3, R4 deferred, reorders R-29); KPI set. Detail: `docs/ORRY-BUSINESS-MODEL.md` | owner, 2026-11-09 |
| R-63 | Build every remaining update now, including R3 (Perps, Lend and Multiply, Pair trading and arbitrage, Vaults) and R4 (RWA issuance, launch tools). Supersedes R-61's deferral of R3 and R4 for the build; opening them stays a release-switch decision | owner, 2026-11-11 (answer "Bangun juga sekarang", over the recommendation to keep R-61) |
| R-64 | Orrery Data (R-49 to R-52, R-60) and the MCP server join the update order right after Community: Community, Data and MCP, R2 with the paymaster, attesters and Credit, Agent Launch, R3, R4, Discord stage 3. New pairs (R-38) are an operations step once a feed exists, not a build | owner, 2026-11-11 (answer "Masukkan sesudah Komunitas") |
| R-65 | The updates are built in parallel sessions, three at a time, each lane in its own worktree and branch off `build/v1`; the orchestrating session reviews and merges. Nothing is deployed by any lane (R-11) | owner, 2026-11-11 (answers "Paralel di beberapa sesi", "3 sekaligus, bergiliran") |

Mapping to the owner decisions recorded on `build/v1` (`02-open-questions.md` T1 to T14): T1 = R-1 and R-2; T2 and
T11 = R-12; T3, T4, T6 = R-13; T5 = R-6; T7 = staking agent positions (3.3, re-decides Q5 for the token update); T8 =
R-9; T9 = R-4; T10 = R-7; T12 = no governance (R-10); T13 = R-14; T14 = R-15; U1 = R-16. When `orry/spec` merges into
`build/v1`, both tables stay: this R table is the build source, the T table the owner record.

## 2. Outside facts and addresses (4663)

| Item | Value | Status |
| :--- | :--- | :--- |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | verified (Pons factory `poolManager()`, SNOP spec) |
| v4 PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | read through SNOP spec, re-check |
| v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | verified by lane B (7,065 bytes of code, answered pool reads), relayed |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | verified (v1 spec) |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals | verified |
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | verified |
| OrreryAttestor (mainnet) | not deployed yet; constructor argument | open |
| ORRY | not launched yet; constructor argument (Pons token: 1e27 supply, 18 decimals, `burn`, `burnFrom`, no permit, no EIP-3009) | facts from ORVYN, re-check on ORRY |
| Pons V2 factory, FeeEscrow, MemeHook | `0x7eD5…EC7e`, `0xd3AF…Ac9e`, `0xE5e7…e044` | read-only references for fork tests; **no Orrery contract may reference them** (R-1) |
| ETH/USDG v4 pools for buyback hop 1 | 633 native ETH/USDG pools initialised, 157 without a hook (lane B, `Initialize` logs to block 108,947,868). Deepest three, all hookless: pool 1 `0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982` fee 500 / spacing 10, about 6.88 M USDG and 3,080 ETH virtual, PoolManager protocol fee 125 pips each way; pool 2 `0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32` fee 460 / 9, about 3.92 M USDG; pool 3 `0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e` fee 100 / 1, about 1.98 M USDG. Recorded in `contracts/test/fork/orry/stake/Pools4663.sol` | found by lane B, relayed; re-read depth at deploy |
| v4 libraries | `contracts/lib/v4-periphery` symlink to `~/Projects/blockchain/kya-protocol-vendor/v4-periphery-c6e4754d` (Uniswap v4-periphery c6e4754d with v4-core, permit2, solmate, openzeppelin) | in place; v4-core `PoolManager.sol` is BUSL-1.1 and pins solc 0.8.26: use it only in tests, never deploy it |
| Compiler | local `solc` 0.8.38 (our files `pragma ^0.8.26`). Tests that deploy a local PoolManager need solc 0.8.26: lanes may install it with `solc-select install 0.8.26` and say so in the report, or etch the live PoolManager runtime code from 4663 | open |
| Fork RPC | `https://rpc-robinhood.blockmachine.io` (60 req/min) or `https://rpc.mainnet.chain.robinhood.com` (answered 2026-11-08) | |

## 3. Contracts (all under `contracts/src/orry/`, interfaces frozen in `interfaces/`)

### 3.1 `OrreryHook` (lane A) implements `IOrreryHook`, `IHooks`

- Constructor: `poolManager`, `orry`, `rewardsRouter`, `lpFee` (8500), `protocolFeePips` (1500), `tickSpacing` (200).
  Address mined for flags afterInitialize | beforeSwap | afterSwap | afterSwapReturnDelta (deploy script uses CREATE2
  with a mined salt; tests use `deployCodeTo`).
- `afterInitialize`: accepts exactly one key: currency0 = native ETH, currency1 = `orry`, fee = `lpFee`, tickSpacing
  = `tickSpacing`, hooks = this. Any other key or a second pool reverts (`WrongPoolKey`, `HubAlreadyRegistered`).
- `beforeSwap`: records `startOfBlockSqrtPriceX96` the first time it runs in a block (price before that swap). Never
  reverts for arithmetic reasons. "Block" is EVM `block.number`, the L1 block number on 4663 (R-17).
- Price observations (R-28): the hook keeps a time-weighted tick for the hub. State: `latest` (timestamp, tick
  cumulative, tick) and a ring of `OBSERVATION_CARDINALITY` (64) checkpoints `(timestamp, tickCumulative)`.
  `afterInitialize` writes the first entry (cumulative 0, the initial tick). In `beforeSwap`, when `block.timestamp`
  differs from `latest.timestamp`, the hook reads the pre-swap tick from the PoolManager and sets
  `latest.cumulative += preSwapTick × (now − latest.timestamp)`, `latest.tick = preSwapTick`, `latest.timestamp = now`
  (the pre-swap tick is the tick held since the last swap, as in Uniswap v3; corrected 2026-11-08 after lane A showed
  the earlier `latest.tick` form contradicts H-6);
  when the newest checkpoint is at least `OBSERVATION_INTERVAL` (60 s) old, it also writes `latest` as a new checkpoint
  (overwriting the oldest once the ring is full). So the cumulative is exact at one-second resolution, and checkpoints
  are spaced at least 60 s apart (the ring spans at least 63 minutes).
- `consult(window)` (view, `window` between 1 and `MAX_WINDOW` = 60 × 63 s; 0 reverts `OracleWindowTooLong`): `cumNow = latest.cumulative + tickNow ×
  (now − latest.timestamp)` with `tickNow` the current pool tick; finds the newest checkpoint with `timestamp ≤ now −
  window` (binary search over the ring) and returns `meanTick = floor((cumNow − cumThen) / (now − tThen))` (rounded
  toward negative infinity) and `actualWindow = now − tThen` (at least `window`). Reverts `OracleNotReady` when the
  oldest checkpoint is newer than `now − window`, and `OracleWindowTooLong` above `MAX_WINDOW`. `observation(i)` and
  `latestObservation()` expose the raw data.
- The oracle never makes a swap revert: no arithmetic overflow is reachable (|tick| ≤ 887272, int56 cumulative), and
  it costs at most one warm write per second plus one checkpoint per minute.
- `afterSwap`: protocol fee = `|unspecified amount| × protocolFeePips / 1e6`, rounded down, taken as ERC-6909 claims
  (`poolManager.mint`) and returned through `afterSwapReturnDelta`. Swaps through the hook by the buyback pay it too.
- `collect()`: anyone; burns claims for ETH and ORRY, takes them, sends to `rewardsRouter`; emits
  `ProtocolFeesCollected`. Reentrancy-safe.
- No owner, no setter, no pause, no other callbacks (they revert `HookNotImplemented`).

### 3.2 `EarnVault` (lane A) implements `IEarnVault`

- One full-range position (ticks at the min and max usable for `tickSpacing`), owned by the vault in the PoolManager
  directly (salt 0) through `unlock` callbacks. Shares = liquidity units the vault added (internal ledger), so donations
  never move the share price and the first depositor cannot inflate it.
- Fees: `harvest()` pokes the position (`modifyLiquidity` with 0), adds collected ETH and ORRY to two reward streams
  with a reward-per-share accumulator; each stream runs `STREAM_PERIOD`, new fees roll the remainder into a fresh
  period; time with zero shares keeps its rewards for the next period. `deposit`, `zapDeposit`, `withdraw` call
  `harvest` first and settle the account's accrued rewards before shares change.
- Lock: on every mint the account's `unlockAt` becomes the share-weighted average of its remaining lock and
  `now + DEPOSIT_LOCK` (SNOP `PlpVault` D-05 rule). `withdraw` before `unlockAt` reverts `SharesLocked`.
- Zap and same-block guard: zaps swap through the hub with the caller's `minSwapOut`, and revert `PriceMovedInBlock`
  when the live price is more than `MAX_BLOCK_MOVE_BPS` (100) from `startOfBlockSqrtPriceX96` of the current block.
- ETH refunds and payouts use a call with a reentrancy guard; a failing recipient reverts its own call only.
- No owner, no pause, no sweep. ORRY or ETH sent to the vault outside these paths is never counted.

### 3.3 `OrryStaking` (lane B) implements `IOrryStaking`

- Constructor: `orry`, `identityRegistry`, `PLAIN_COOLDOWN` (7 days), `AGENT_COOLDOWN` (14 days), `STREAM_PERIOD`
  (7 days).
- Earning balance of an address = plain `active` + the `active` of every agent position whose `staker` is that
  address (kept as a running total per staker, no loops).
- `stakeForAgent(agentId, amount)`: caller is `ownerOf(agentId)` or `getAgentWallet(agentId)`; position key
  `(agentId, ownerOf(agentId))`; a position has one staker (`PositionHeldByAnotherStaker` otherwise); adding by the
  same staker is allowed.
- `requestUnstake` / `requestAgentUnstake`: moves amount from active to leaving at once (stops earning), sets
  `readyAt = now + cooldown`; a further request adds and restarts the clock. `withdraw` / `withdrawAgent` pay the
  staker after `readyAt`. Agent requests work even after the identity moved (the old owner key is passed).
- Rewards: `notifyRewards` (anyone, ETH by value, ORRY by `transferFrom` with balance-delta) per asset sets
  `rate = (scheduled remainder + unstreamed + amount) / STREAM_PERIOD`, keeps the division remainder unstreamed;
  rewards for time with `totalEarning == 0` return to unstreamed. `claimFor(account)` pays only `account`.
- Intake of stake by `transferFrom` with balance-delta; a token with a transfer fee reverts `InexactTransfer`.
- `extendAgentLock(agentId, lockedUntil)` (R-13): staker of the position keyed by the current `ownerOf(agentId)`
  only; `lockedUntil` must be later than the stored value (`LockNotExtended`) and at most `MAX_AGENT_LOCK` (365 days)
  ahead (`LockTooLong`); while `now < lockedUntil`, `requestAgentUnstake` reverts `AgentStakeLocked`. It changes no
  earning and no reward. A lock does not survive the identity moving: the new owner's position is a fresh one.
- No owner. Nothing can move a position except its staker after its cooldown.

### 3.4 `OrryRewardsRouter` (lane B) implements `IOrryRewardsRouter`

- Constructor: `orry`, `staking`, `buyback`, `STAKERS_BPS` (5000), `MIN_INTERVAL` (1 hour).
- `distribute()`: at most once per interval; for ETH and ORRY balances: stakers part = `floor(balance × STAKERS_BPS
  / 10000)` to `staking.notifyRewards`; ORRY rest burned with `burn` (emits `Burned(1, amount)`); ETH rest sent to the
  buyback. Reverts `NothingToDistribute` when both are zero.

### 3.5 `OrreryTreasury` (lane B) implements `IOrreryTreasury`

- Constructor: `usdg`, `attestor`, `owner`, `OWNER_BPS` (1000), quote signer list (≤ 3).
- `sync()`: `new = balance − ownerAccrued − buybackReserve`; owner part `floor(new × OWNER_BPS / 10000)`, rest to the
  reserve. Called by every function that reads balances.
- Coinless mode until `executeCoin` (48 hours after `proposeCoin`, within the 7 day window, one time): before it,
  `pullBuyback`, `burnForCredits` and `verifyWithOrry` revert `CoinNotSet`, and the owner may `reclaimReserve` into
  `ownerAccrued`. After it, the reserve only falls through `pullBuyback` (buyback only): at most `PULL_BPS_PER_DAY`
  (10%) of the reserve measured at the window start per 24 hours, or all of it when it is 1 USDG or less.
- `burnForCredits` / `verifyWithOrry`: EIP-712 quotes as in the interface, signer must be an active quote signer,
  `quoteId` single-use, `expiry ≥ now`; `burnFrom(caller, orryAmount)` and require total supply fell by exactly that
  (`InexactBurn`); emit `Burned(2|3, amount)`. Verification then calls `OrreryAttestor.payVerification(agentId,
  expectedOwner, attestor.fee())` from the treasury (fee recorded 0, no USDG moves), at most 25 per UTC day.
- Owner: `withdrawOwnerShare`, `reclaimReserve` (coinless only), `proposeCoin`, `setQuoteSigner`, two-step ownership.
- Ships with v1 (R-12). Deploy order on 4663, in `services/scripts/deploy-4663.ts` (orchestrator owns that file for
  this change): OrreryAttestor (treasury = owner wallet, as today) → `OrreryTreasury(usdg, attestor, owner, 1000,
  signers)` → `attestor.setTreasury(treasury)` from the deployer (it is the attestor owner, M1) → read-backs (treasury
  set, `orry() == 0`, `OWNER_BPS == 1000`) → API `ORRERY_TREASURY` = the treasury contract. `proposeCoin(orry,
  buyback)` happens later, after the Pons curve graduates and the hub and buyback exist. Read-backs also check
  `pendingOwner() == 0` (R-20).
- ORRY deploy (later, `contracts/script/orry/**`, orchestrator): router, buyback and hook reference each other
  (finding F-4), so the script precomputes CREATE addresses (`vm.computeCreateAddress`) and deploys the hook with a
  mined CREATE2 salt; it initialises the hub at the Pons pool's `slot0` right after the hook (R-21).

### 3.6 `OrryBuyback` (lane B) implements `IOrryBuyback`

- Constructor: `treasury`, `rewardsRouter`, `hook` (gives the hub key and ORRY), `usdg`, `poolManager`, an immutable
  list of up to three ETH/USDG v4 pool keys (hop 1).
- `executeSlice()`: at most hourly; amount = min(`treasury.availableForBuyback()`, hop 1 cap, hop 2 cap); pulls exactly
  that; hop 1 USDG to ETH on the deepest listed pool, hop 2 ETH to ORRY in the hub (both inside one `unlock`); sends
  the ORRY to `rewardsRouter`. Cap per hop: input at most `0.5 × fee × reserve of the input side` of that pool, read
  in the transaction; `minOut` = pre-trade spot output × (1 − fee) × 0.995. Reverts `PriceMovedInBlock` if the hub price
  moved more than 1% since the start of the block.
- Hop 1 bound (R-18, finding F-1): hop 1 pools carry no hook, so a permissionless slice could be bundled with JIT
  liquidity that pushes the chosen pool and inflates its cap. Every slice is also capped by the constructor
  `maxSliceUsdgCap` (default 1,000 USDG, 6 decimals: `1_000e6`), and `maxSliceUsdg()` includes it. Before hop 1, every
  listed pool with in-range liquidity of at least 1% of the chosen pool's must price ETH within 0.5% of the chosen pool
  (pre-trade, in price terms), else `PriceMovedInBlock`. A bundle then moves the chosen pool at most 0.5% unless it
  moves every listed pool, which costs the other pools' LP fees. Tests: the F-1 test that showed the attack paying
  (hub 800 ETH) must now show it not paying; add a test where JIT liquidity makes the shallowest pool the deepest and
  pushes it; add a test where a dead pool (liquidity under 1%) is ignored.
- `burnEth()`: at most hourly; its ETH balance (capped by the hub hop cap) buys ORRY in the hub; burns all of it
  (`Burned(4, amount)`). Unspent ETH waits for the next call.
- Holds nothing between calls except ETH waiting for `burnEth`. No owner. Never trades in a Pons pool (R-1).

### 3.7 `ClaimAll` and `OrryLens` (lane A)

- `ClaimAll.claimAll()`: calls `earnVault.claimFor(msg.sender)` and `staking.claimFor(msg.sender)`; returns totals.
- `OrryLens`: pure reads composing the claim center view (`IOrryLens`).

## 4. Invariants (each needs a test; lane in brackets)

Hook [A]
- H-1 Only the one registered hub pool can use the hook; a second initialize reverts.
- H-2 For every swap, the hook's claims grow by exactly `floor(|unspecified| × protocolFeePips / 1e6)`.
- H-3 After `collect`, the hook holds no claims, no ETH and no ORRY; everything went to `rewardsRouter`.
- H-4 The hook never reverts a swap for an arithmetic reason in `beforeSwap`.

Earn [A]
- E-1 Vault assets leave only to an account redeeming its own shares, as fee payouts to the account they accrued to,
  or into the hub position during a deposit or zap of the same call.
- E-2 Withdrawing all shares in any order returns every account at least its pro-rata liquidity (rounding never
  favours the caller); the sum paid never exceeds what the position and streams hold.
- E-3 Fees paid to all accounts never exceed fees harvested; harvested minus paid equals the unpaid stream balance.
- E-4 A deposit made after a harvest earns nothing from fees harvested before it beyond its streamed share.
- E-5 Locked shares cannot be withdrawn; nothing else can be stopped by anyone.
- E-6 Donated ETH or ORRY never changes any account's withdrawable amount.

Staking [B]
- S-1 Contract ORRY balance ≥ Σ(active + leaving) + unpaid ORRY rewards.
- S-2 A position's ORRY leaves only to its staker, only after `readyAt`.
- S-3 `totalEarning` = Σ earning balances at all times.
- S-4 Rewards paid ≤ rewards notified, per asset; notified − paid = unpaid streams + unstreamed.
- S-5 An agent position reported with `active = A` at time t keeps at least A locked until t + AGENT_COOLDOWN.
- S-6 While `now < lockedUntil`, an agent position's `active` cannot fall; `lockedUntil` only grows and never exceeds
  `now + MAX_AGENT_LOCK` at the moment it is set.

Router [B]
- RR-1 After `distribute` the router holds no ETH and no ORRY.
- RR-2 Stakers receive exactly `floor(x × STAKERS_BPS / 10000)` of each asset; the rest is burned or sent to the
  buyback; nothing goes anywhere else.

Treasury [B]
- T-1 `ownerAccrued + buybackReserve ≤ USDG balance`.
- T-2 USDG leaves only to the owner (≤ `ownerAccrued`) or the buyback (≤ the daily pull bound).
- T-3 Coin and buyback set at most once, ≥ 48 hours after the proposal.
- T-4 Every `CreditsPaid` and `VerificationBurned` comes with an equal fall in ORRY total supply in the same call.
- T-5 A quoteId is accepted at most once; expired or unsigned quotes revert.
- T-6 At most 25 `verifyWithOrry` per UTC day.

Buyback [B]
- B-1 At most one slice and one ETH burn per hour.
- B-2 Each hop moves its pool's price by at most half of that pool's fee, against the pre-trade state.
- B-3 All ORRY bought by `executeSlice` reaches the router; all ORRY bought by `burnEth` is burned.

Global [A and B]
- G-1 No Orrery contract has code paths that call a Pons contract (R-1); a test greps the sources for the three Pons
  addresses and for `IFeeEscrow`-like calls.
- G-2 No contract mints ORRY.

- H-5 [A] Checkpoint timestamps strictly increase around the ring and are at least `OBSERVATION_INTERVAL` apart; at
  most one `latest` update per `block.timestamp`.
- H-6 [A] `latest.cumulative` equals the exact sum of the pool's tick times seconds held since initialization (ghost
  model at one-second resolution, every swap path, donations and liquidity changes included).
- H-7 [A] `consult(window)` returns exactly floor((cumNow − cumThen) / (now − tThen)) for the newest checkpoint at or
  before `now − window`, `actualWindow ≥ window`, and reverts only with `OracleNotReady` or `OracleWindowTooLong`.
- H-8 [A] Manipulation bound: a price pushed within one block and restored in the same block moves no checkpoint and no
  `consult` result; a price held for `h` seconds moves the cumulative by at most `push × (h + 1)` and a
  `window`-second mean tick by at most `push × (h + 1) / window` plus one tick for flooring
  (tested with pushes of 10% and 50% held 1, 12 and 60 s against a 30 minute window).

## 5. Services (lane C), frozen API shapes

All new routes under `/v1/orry/`, JSON, amounts as decimal strings in base units plus a `decimals` field.

| Route | Returns |
| :--- | :--- |
| `GET /v1/orry/earn` | `{ tvl: {eth, orry}, totalShares, fees7d: {eth, orry}, feesAllTime: {eth, orry}, hubPrice: {orryPerEth}, updatedAt }` |
| `GET /v1/orry/stake` | `{ totalEarning, rewards7d: {eth, orry}, rewardsAllTime: {eth, orry}, stakers, updatedAt }` |
| `GET /v1/orry/accounts/:address` | the `IOrryLens.Claimables` fields, agent positions, and `earnedAllTime: {eth, orry}` (claimed + pending, Earn and Stake) |
| `GET /v1/orry/leaderboard?kind=stakers|earners&limit=50` | `[{ rank, address: "0x1234…abcd", stake?, earned?: {eth, orry} }]`; full address never returned (R-5) |
| `GET /v1/orry/burns?limit=` | `{ total, bySource: {"1","2","3","4"}, items: [{tx, block, time, source, amount}] }` |
| `POST /v1/orry/quotes/credits` `{buyer, packs}` | signed `CreditsQuote` (expiry ≤ 2 minutes, price from a 30 minute median of hub `slot0` samples, lower of spot and median) |
| `POST /v1/orry/quotes/verification` `{payer, agentId}` | signed `VerificationQuote` |

- Credits from ORRY: grant `packs × ORRERY_PACK_SIZE × 625/500` checks once per `quoteId` on `CreditsPaid` after the
  confirmation depth (as the x402 path).
- Check result v2: EIP-712 domain version "2", `CheckResult` gains `stakeActive`, `stakeLeaving`, `stakeLeavingAt`,
  `stakeLockedUntil`, `stakedBy` (from `OrryStaking.agentStake`); v1 stays verifiable; SDK `verifyCheck` accepts both.
- Keeper (new `services/packages/server/src/keeper.ts` + bin): hourly `collect`, `distribute`, `harvest`,
  `executeSlice`, `burnEth`, each only when it would do something (simulate first), gas from a keeper key
  `~/.secrets/orrery/<network>-keeper.json` (created only on the owner's word).
- Indexer: events of every contract in section 3, hub pool swaps from PoolManager `Swap` filtered by hub poolId,
  request-priced RPC, lag-based health (workspace rule 7).
- Release switch: env `ORRERY_ORRY_FEATURES` (comma list: earn, stake, claim, burn, leaderboard, checkout); default
  all off on 4663, all on on 46630 and local; held routes answer 404.

## 6. Web (lane D)

Routes: `/earn`, `/stake`, `/claim`, `/burn`, `/leaderboard`, docs pages `/docs/earn`, `/docs/stake`, `/docs/claims`;
agent stake panel on the operator page; ORRY checkout on the credits page. Every page behind
`NEXT_PUBLIC_ORRY_FEATURES` (same names); a held feature shows "Coming soon", same wording everywhere.
Copy rules: English; no projected rates or APY; realised figures only (7 day fees, all-time earned); no risk, caution
or disclaimer lines; no "testnet" (46630 is "development network"); no em or en dashes in prose; addresses masked on
the leaderboard; numbers only from the API or chain reads. Copy lines to use: `ORRY-TOKEN-UTILITY.md` section 17.

## 7. Tests and proofs

| Lane | Command (from the lane's worktree) | Must show |
| :--- | :--- | :--- |
| A, B | `cd contracts && heavy forge test --match-path 'test/orry/<lane>/**'` | all pass, counts |
| A, B | invariant campaigns (256 runs × 120 depth at least) and a deterministic deep run per contract set | invariants of section 4 hold, state counts above zero |
| A, B | mutation script under `contracts/test/orry/<lane>/mutate_<lane>.py` (pattern of `contracts/mutate.py`) | every mutation caught |
| A | fork test: real Pons V2 launch on a 4663 fork, buy to graduation, open the hub next to the Pons pool, deposits, swaps, harvest, claims, JIT and sandwich attempts | pass |
| B | fork test: treasury coinless then coin set, slice through a real ETH/USDG v4 pool and the hub, router distribute, staking streams | pass |
| A, B | the v1 suite still passes: `cd contracts && heavy forge test --no-match-path 'test/fork/*'` | unchanged counts |
| C | `cd services && pnpm test` (vitest; Docker Postgres and anvil as the v1 globalSetup) | pass |
| D | `pnpm --filter web build`, lint, and a browser walk of every new route against a local stack | screenshots read back |

## 8. Lanes and ownership

| Lane | Session | Owns (writes only these) | Mandatory skills |
| :--- | :--- | :--- | :--- |
| A | `orry-earn` | `contracts/src/orry/OrreryHook.sol`, `EarnVault.sol`, `ClaimAll.sol`, `OrryLens.sol`, `contracts/test/orry/earn/**`, `contracts/test/fork/orry/earn/**` | `karpathy-guidelines`, `security-and-hardening` |
| B | `orry-stake` | `contracts/src/orry/OrryStaking.sol`, `OrryRewardsRouter.sol`, `OrreryTreasury.sol`, `OrryBuyback.sol`, `contracts/test/orry/stake/**`, `contracts/test/fork/orry/stake/**` | `karpathy-guidelines`, `security-and-hardening` |
| C | `orry-services` | `services/packages/server/**`, `services/packages/sdk/**`, `services/packages/shared/**` except `orry-abi.ts`, `services/scripts/**`, `services/test/**` | `api-and-interface-design`, `security-and-hardening` |
| D | `orry-web` | `services/packages/web/**` | `no-slop-design`, `web3-design`, `ui-ux-pro-max` |
| Spec, integration | this session | interfaces, this file, `foundry.toml`, `orry-abi.ts`, deploy script `contracts/script/orry/**`, the treasury step of `services/scripts/deploy-4663.ts` (lane C does not edit that file), merges | `protocol-design`, `delegate-sessions` |

Lane B order (R-12): `OrreryTreasury` first, complete with unit, invariant, mutation and fork tests and a local commit,
then a short Progress message to the orchestrator, then staking, router and buyback. Code copied from SNOP (R-15) is
allowed in lanes A and B; it is still tested to the same standard and its source file is named in the report.

Rules for every lane: own worktree and branch cut from `orry/spec`; commit locally on that branch, never push, never
merge; nothing deployed anywhere outside a fork or local anvil; no keys created; big builds through `heavy`; contracts
lanes use mocks of the other lane's interfaces until both are merged; a needed interface change is a message to the
orchestrator, not an edit.
