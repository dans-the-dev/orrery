# Lane L5: Agent Launch (R-13, T3 to T6) and launch priority (utility 5)

Date: 2026-11-11 (machine clock UTC). Branch `upd/launch` off `build/v1` 146e091. Status: spec, decisions and invariants
written before code; build status in section 10. Internal engineering document.

Owner decisions this lane implements: T3 (launchpad in the second update: verified agents only, stake locked 90 days,
coins paired with ORRY), T4 (hub and spoke: LPs never hold launched coins), T6 (spoke fee 1% per swap: creator 50% to the
agent's policy-bound account, Earn LPs 20% in ORRY, burn 15%, owner 15%), R-13 (`OrryStaking.extendAgentLock` is the
90 day lock), R-44 utility 5 (launch priority weighted by stake), R-46 and utility 10 (thresholds in USD at the TWAP),
R-10 (launch contracts immutable), R-15 and R-16 (Orrery's own contracts, no calls into other projects' deployments),
R-63 to R-65 (build now, parallel lanes, nothing deployed). Plans: `docs/ORRY-TOKEN-UTILITY.md` R-19, 6.2, 9.1, 11.3;
`docs/ORRY-UPGRADE-PATHS.md` (Agent Launch row: separate spoke hook and launch contracts; B-2 `IEarnVault.notifyRewards`);
`docs/ORRY-UTILITIES-PLAN.md` item 5.

Read only and used: `OrryStaking` (`agentStake`, `earningBalance`), `IEarnVault.notifyRewards` (B-2), `OrreryTreasury.owner`,
`OrreryAttestor.isVerified`, `OrreryPolicyModule.isInstalledOn`, the ERC-8004 `IdentityRegistry` (`ownerOf`, `getAgentWallet`),
the R1 `OrryPriceOracle` (`usdValue`), the Uniswap v4 PoolManager on 4663
(`0x8366a39CC670B4001A1121B8F6A443A643e40951`).

Reference code copied in part, SPDX kept, origin noted in the file headers: the owner's Hashborn launchpad
(`~/Projects/blockchain/hashborn-npm/contracts/src/HashbornLaunchpadV4.sol` and `LaunchFeeHook.sol`, MIT; the board's path
`hashborn-npm-agent-launch/` exists only as build output on `/mnt/shared`, the sources are in `hashborn-npm/`). Nothing calls
a Hashborn, SNOP, Pons or other project's deployment.

Values marked "(guess)" are delegated defaults; every one is a constructor argument and an owner question in the lane report.

## 1. Product

| Surface | What a user does | Contract |
| :--- | :--- | :--- |
| Launch | The owner of a Orrery-verified ERC-8004 agent (or the agent's bound account) launches one coin for the agent: fixed supply, the whole supply in one locked Uniswap v4 position paired with ORRY, an optional first buy in the same transaction | `AgentLaunch` (one), `AgentCoin` (one per launch) |
| Early access | For the first minutes after a launch only ORRY stakers may buy, each up to an allowance that grows with the USD value of their stake | `AgentLaunch.buyEarly`, `SpokeHook` |
| Trade | After the early window anyone buys and sells through any v4 router. Every swap pays 1% on the ORRY side; buys in the first seconds after the public opening pay a launch fee that falls to 1% | `SpokeHook` |
| Fees | Anyone runs `distribute(coin)`: 50% accrues for the agent, 20% streams to Earn LPs in ORRY, 15% is burned, 15% goes to the owner. `claimCreatorFees(coin)` (anyone) pays the agent's share to the agent's policy-bound account and nowhere else | `AgentLaunch` |

Burn source for the indexer: 50 spoke fee burn (`IOrryBurnEvents.Burned(50, amount)`). 51 to 59 stay free.

## 2. Decisions taken in this lane (delegated, 2026-11-11)

| Id | Decision | Why |
| :-- | :--- | :--- |
| L5-1 | Two new contracts and one token: `SpokeHook` (v4 hook, address mined for its permission bits, deployed first through the CREATE2 factory `0x4e59b448…956C` with the predicted `AgentLaunch` address), `AgentLaunch` (launches, early buys, fee split, creator claims), `AgentCoin` (plain fixed-supply ERC-20, no owner, no mint, no burn, no pause, no transfer hook). `OrreryHook` is not touched (R-10); its spoke mode in the old plan becomes `SpokeHook` | UPGRADE-PATHS: "separate spoke hook and launch contracts" |
| L5-2 | Pool: ORRY is always currency0, the coin currency1. The coin is CREATE2 from `AgentLaunch` with salt `keccak256(caller, salt)`; `launch` reverts `CoinSortsBelowOrry` when the coin's address is below ORRY's, so the web mines a salt with `predictCoin` (about two tries). Key: `fee 0` (static LP fee 0), tick spacing 200, hooks `SpokeHook` | one orientation halves the code paths and the tests; LP fee 0 because the whole fee is the hook's (L5-4) |
| L5-3 | Supply 1,000,000,000 × 1e18. The pool opens at `START_TICK` (25,000, guess: 12.18 coins per ORRY, a start value of about 82.1 M ORRY for the whole supply, which equals Pons V2's 1.68 ETH virtual quote at ORRY's graduation price of about 2.06e-8 ETH). The whole supply goes into one position `[MIN_TICK, START_TICK]`, single-sided in the coin, held by `AgentLaunch` forever: it has no code path that removes liquidity. Rounding dust (a few wei) stays in `AgentLaunch` | Hashborn D-59 pattern; behaves as a constant-product curve with a virtual ORRY reserve equal to the start value |
| L5-4 | The 1% fee is a hook fee on the ORRY side of every swap, not an LP fee: ORRY specified (buy exact in, sell exact out) through `beforeSwapReturnDelta` on the specified amount; ORRY unspecified (buy exact out, sell exact in) through `afterSwapReturnDelta` on the pool's ORRY amount. `fee = floor(orryAmount × feePips / 1e6)`. The hook mints the fee as ERC-6909 claims of ORRY straight to `AgentLaunch` and counts it per pool (`feesOf(poolId)`); it holds nothing itself | T6 says "in ORRY"; Earn and burn need ORRY, a coin-side LP fee would need a swap per collection |
| L5-5 | Launch fee against snipers (Hashborn D-60 pattern): a buy that is not `AgentLaunch`'s own pays `feeAt(t)`: `START_FEE` (800,000 pips = 80%, guess) at the public opening, falling linearly to 1% over `DECAY_WINDOW` (60 s, guess); 1% from then on. Sells always pay 1% | 4663 makes about ten blocks a second; the first public block is where bots buy |
| L5-6 | Early access (utility 5): from the opening to `publicOpenAt = openedAt + EARLY_WINDOW` (600 s, guess; 0 allowed), the hook refuses every buy whose PoolManager caller is not `AgentLaunch`; sells stay open. `AgentLaunch.buyEarly(coin, orryIn, minCoinOut, deadline)` lets an address buy at 1% up to `allowance = SUPPLY × EARLY_MAX_BPS / 10000 × min(stakeUsd, EARLY_FULL_USD) / EARLY_FULL_USD` coins in that window, where `stakeUsd = OrryPriceOracle.usdValue(OrryStaking.earningBalance(msg.sender))` and `stakeUsd ≥ EARLY_MIN_USD`. Guesses: `EARLY_MAX_BPS` 50 (0.5% of supply), `EARLY_FULL_USD` 1,000 USD, `EARLY_MIN_USD` 10 USD. Linear weighting, so splitting a stake over several addresses buys nothing more than the same stake in one (the per-address cap only binds above `EARLY_FULL_USD`); a stake must sit in its 7 day cooldown before it can move, so the same ORRY cannot serve two addresses in one window | "allocation or early access weighted by stake"; the buyer is `msg.sender` of `AgentLaunch`, not `tx.origin`, so Safes and smart accounts take part |
| L5-7 | Launch gate, all checked in `launch`: caller is `ownerOf(agentId)` or `getAgentWallet(agentId)`; `OrreryAttestor.isVerified(agentId)`; `getAgentWallet(agentId)` is non-zero and `OrreryPolicyModule.isInstalledOn(wallet)`; the agent's reported stake `OrryStaking.agentStake(agentId)` has `active` worth at least `MIN_STAKE_USD` (100 USD, guess) at `OrryPriceOracle.usdValue` and `lockedUntil ≥ now + 90 days`; the agent has no coin yet. The creator locks the stake with `extendAgentLock` before launching (two transactions; `extendAgentLock` accepts only the staker as caller) | T3; R-13 says the lock is `extendAgentLock`, which only the staker can call, so the launch reads the lock instead of setting it |
| L5-8 | One coin per agentId, ever | a verified agent is the scarce resource; a second coin dilutes the first's holders. A later contract can allow more |
| L5-9 | Creator first buy inside `launch`: `orryIn` ORRY pulled from the caller (balance-delta checked), swapped exact in at 1% before anyone else can trade, at least `minCoinOut` and at most `MAX_FIRST_BUY_BPS` of the supply (500 = 5%, guess); the coins go to the caller | Hashborn D-58 pattern |
| L5-10 | Fee split in `distribute(coin)` (anyone): redeem the coin's undistributed claims (`feesOf(poolId) − distributed[coin]`) from the PoolManager, then creator `floor(50%)` accrues to `creatorOwed[coin]`, Earn `floor(20%)` accrues to `earnPending`, owner `floor(15%)` is sent to `OrreryTreasury.owner()` read live, the rest (15% plus dust) is burned with a supply-delta check (`Burned(50, amount)`). `earnPending` is paid to the ORRY/ETH `EarnVault` with `notifyRewards` at most once per `EARN_INTERVAL` (1 hour) by any `distribute` or `flushEarn` | T6; the Earn interval stops many coins from restarting the vault's 7 day stream every block (the router's `MIN_INTERVAL` rule) |
| L5-11 | Creator fees: `claimCreatorFees(coin)` (anyone) distributes first, then pays `creatorOwed[coin]` to `getAgentWallet(agentId)` read live, only while `OrreryPolicyModule.isInstalledOn(wallet)`; otherwise it reverts `CreatorWalletNotBound` and the fees wait. The agent's share follows the identity: a new owner's bound account receives later fees | T6: "the agent's policy-bound account and nowhere else" |
| L5-12 | Outside liquidity is refused (`beforeAddLiquidity`: only `AgentLaunch`); only `AgentLaunch` initializes pools on the hook (`beforeInitialize`), with the exact key shape of L5-2. Donations are not blocked: they would only add to a position nobody collects | the pool's only liquidity is the locked launch position, so no LP can be front-run, JIT-ed or rugged; LP fee is 0, so outside LPs could only lose |
| L5-13 | No owner, no pause, no setter in any L5 contract. Every number is an immutable set at construction within a hard bound; T6's split and the 90 day lock are constants | R-10, T12 |
| L5-14 | Earn share goes to one vault: the ORRY/ETH `EarnVault` given at construction (its `orry()` must equal ORRY). The USDG hub's vault gets none | most agent-coin buyers enter through the ETH hub; one vault keeps one stream. Owner question |
| L5-15 | `SpokeRouter` (added while building the web pages): exact-in `buy` and `sell` for launched coins with the caller's minimum output and deadline; the input moves from the caller straight into the PoolManager and the output straight to the caller; no owner, no state. It is an ordinary public caller to the hook (refused in the early window, pays the launch fee) | the coin page needs a router to trade after the early window; v4's own test routers are not for production and no v4 router on 4663 was checked for hooked-pool support |
| L5-16 | A vault that refuses `notifyRewards` never blocks a distribution: the Earn share stays in `earnPending`, the allowance is cleared, the next `distribute` or `flushEarn` retries | the burn, the owner share and the creator share must not wait on the vault |

Not in L5: boost (R-18), a bonding curve with graduation (the spoke is a v4 pool from the first block), fair-mode identity
windows (utility 5 replaces it with stake), coin metadata on chain beyond name and symbol (the agent's ERC-8004 record is the
coin's page), a buyback of launched coins, more than one Earn vault, more than one coin per agent.

## 3. `SpokeHook`

- Permissions (address bits): `beforeInitialize` (13), `beforeAddLiquidity` (11), `beforeSwap` (7), `afterSwap` (6),
  `beforeSwapReturnDelta` (3), `afterSwapReturnDelta` (2): mask `0x28CC`. Checked in the constructor with
  `Hooks.validateHookPermissions`; every other callback reverts `HookNotImplemented`.
- Constructor: `poolManager`, `orry`, `launch` (the `AgentLaunch` address, predicted by the deployer), `startFeePips`
  (`BASE_FEE ≤ x ≤ 990,000`), `decayWindow` (1 s to 1 hour), `earlyWindow` (0 to 1 day). Constants: `BASE_FEE` 10,000 pips,
  `TICK_SPACING` 200, `LP_FEE` 0.
- `beforeInitialize(sender, key, ·)`: `sender == launch`, `key.currency0 == orry`, `key.fee == 0`, `key.tickSpacing == 200`,
  `key.hooks == this`; records `openedAt` and `publicOpenAt = now + earlyWindow`.
- `beforeAddLiquidity(sender, ·)`: `sender == launch` (`NotLaunch`).
- `beforeSwap(sender, key, params, ·)`: `buy = params.zeroForOne`. A buy with `sender != launch` before `publicOpenAt` reverts
  `EarlyAccessOnly`. `pips = (buy && sender != launch) ? feeAt(poolId, now) : BASE_FEE`. If ORRY is the specified side
  (`zeroForOne == (amountSpecified < 0)`), fee = `|amountSpecified| × pips / 1e6`, minted to `launch`, returned as the
  specified delta; the pips are kept in transient storage for `afterSwap` otherwise. Never reverts a sell.
- `afterSwap(·, key, params, delta, ·)`: if ORRY is the unspecified side, fee = `|delta.amount0()| × pips / 1e6` with the
  pips of this swap, minted to `launch`, returned as the unspecified delta.
- Views: `feeAt(poolId, t)`, `feesOf(poolId)`, `openedAt`, `publicOpenAt`, `isEarly(poolId)`.
- Events: `SpokeOpened(poolId, openedAt, publicOpenAt)`, `SpokeFee(poolId, fee, pips)`.

## 4. `AgentLaunch`

- Constructor: `poolManager`, `orry`, `hook`, `identityRegistry`, `attestor`, `policyModule`, `staking`, `orryPrice`,
  `earnVault`, `treasury`, `Params {startTick 25_000, maxFirstBuyBps 500, minStakeUsd 100e6, earlyMaxBps 50,
  earlyFullUsd 1_000e6, earlyMinUsd 10e6}` (guesses). Checks: non-zero addresses, `hook.launch() == this`,
  `hook.orry() == orry`, `earnVault.orry() == orry`, `startTick` a multiple of 200 inside `(MIN_TICK, MAX_TICK)`,
  `0 < maxFirstBuyBps ≤ 2000`, `0 < earlyMaxBps ≤ 500`, `earlyMinUsd ≤ earlyFullUsd`, `earlyFullUsd > 0`.
- `launch(agentId, name, symbol, salt, orryIn, minCoinOut)`: gate L5-7; name 1 to 32 bytes, symbol 1 to 10, no control
  characters; deploys `AgentCoin` (CREATE2, coin address above ORRY); `initialize(key, sqrtPrice(START_TICK))`; in one
  `unlock`: add the position with `liquidity = floor(SUPPLY × 2^96 / (sqrtStart − sqrtMin))`, then the first buy, then
  settle (coin: position amount minus coins bought; ORRY: `orryIn`) and keep the bought coins for the caller. Emits
  `Launched(coin, agentId, creator, poolId, liquidity, pooled, orryIn, coinsOut, publicOpenAt, name, symbol)`.
- `buyEarly(coin, orryIn, minCoinOut, deadline)`: `now ≤ deadline`, `now < publicOpenAt` (`EarlyWindowClosed`), stake value
  rule L5-6 (`PriceNotReady` when the oracle is not ready), exact-in swap inside `unlock`, `coinsOut ≥ minCoinOut`,
  `earlyBought[coin][caller] + coinsOut ≤ allowance` (`OverEarlyAllowance`). Emits `EarlyBuy(coin, buyer, orryIn, coinsOut)`.
- `distribute(coin)`, `flushEarn()`, `claimCreatorFees(coin)`: L5-10, L5-11. `distribute` returns quietly when nothing is
  pending, so a keeper can call it on every coin.
- Views: `launchOf(coin)`, `coinOfAgent(agentId)`, `launchCount`, `coins(from, count)`, `poolKeyOf(coin)`,
  `pendingFees(coin)`, `creatorOwed(coin)`, `earnPending`, `earlyAllowance(coin, account)`, `canLaunch(agentId, caller)`
  (first failing gate as an enum, for the web), `predictCoin(caller, salt, name, symbol)`, `liquidityForSupply()`.
- Events: `Launched`, `EarlyBuy`, `FeesDistributed(coin, total, creator, earn, owner, burned)`, `EarnNotified(amount)`,
  `CreatorFeesClaimed(coin, agentId, wallet, amount)`, `Burned(50, amount)`.
- Reentrancy guard on every external state-changing function. ORRY intake balance-delta checked (`InexactTransfer`).

## 5. Money flow of one 100 USD buy from ETH (owner numbers T5, T6)

| Leg | Fee | Where |
| :--- | ---: | :--- |
| ETH to ORRY in the hub (1%, T5) | 1.000 | 0.850 hub LPs, 0.150 rewards router |
| ORRY to coin in the spoke (1% of 99.0) | 0.990 | 0.495 agent account, 0.198 Earn LPs (ORRY), 0.1485 burned, 0.1485 owner |

## 6. Hostile cases and the answer

| Case | Answer |
| :--- | :--- |
| Front-run the pool init without liquidity: someone initializes the spoke key first | the key's hook refuses any initializer but `AgentLaunch` (`NotLaunch`); the coin does not exist before `launch` either |
| Front-run with liquidity: someone opens a coin/ORRY pool on another hook or fee at a bad price, with liquidity | a different key and pool id; `launch` opens its own key at `START_TICK` in the same transaction as the position and the first buy |
| Add liquidity to the spoke to sandwich or to sell into early buyers | refused (`NotLaunch`) |
| Snipe the first public block | `feeAt` starts at `START_FEE`; early buyers are stakers with an allowance |
| Buy in the early window through any router | the hook refuses buys from any PoolManager caller but `AgentLaunch` |
| Creator dumps | no creator allocation; the first buy is capped at 5% and pays 1% |
| Rug by liquidity removal | no remove path in `AgentLaunch`; no outside position exists |
| Grief the Earn stream with tiny distributions | Earn is notified at most once an hour |
| Creator fees sent elsewhere | only `getAgentWallet(agentId)` with the policy module installed can receive them |
| Wash trading for the creator share | a wash trade pays 1% and returns 0.5% to the creator: a loss |

## 7. Invariants (each a test; `contracts/test/launch/`)

Accounting
- LA-1 `IERC6909(pm).balanceOf(launch, ORRY) == Σ_coins (hook.feesOf(pool) − distributed[coin])` after every call.
- LA-2 `ORRY.balanceOf(launch) == Σ creatorOwed + earnPending` after every call (nothing else is ever held).
- LA-3 Every distribution: `creator + earn + owner + burned == amount`, `creator == floor(amount × 5000 / 10000)`,
  `earn == floor(amount × 2000 / 10000)`, `owner == floor(amount × 1500 / 10000)`; total supply falls by `burned`.
- LA-4 `Σ fees minted by the hook == Σ hook.feesOf`; the hook's own ORRY balance and claims stay 0.
- LA-5 Every swap not from `AgentLaunch` pays `floor(orryAmount × feeAt(t) / 1e6)` (buys) or `floor(orryAmount × 1% )`
  (sells), on the ORRY side; `feeAt` is non-increasing in time, ≤ `START_FEE`, and equals 1% from `publicOpenAt + DECAY`.

Liquidity and supply
- LA-6 Each spoke's liquidity equals the launch liquidity forever; no other position exists in the pool.
- LA-7 Each coin's total supply is `SUPPLY`; after `launch`, `launch`'s coin balance is the rounding dust only.
- LA-8 The pool's coins plus all holders' coins equal `SUPPLY` (no mint, no burn).

Access and gates
- LA-9 `launch` succeeds only when every L5-7 gate holds; each failing gate reverts with its own error.
- LA-10 One coin per agentId.
- LA-11 Before `publicOpenAt` every buy not from `AgentLaunch` reverts; a sell never reverts in the hook.
- LA-12 Early buys per address and coin never exceed the allowance computed at the buy; a non-staker cannot buy early.
- LA-13 Creator fees leave only to `getAgentWallet(agentId)` with the module installed.
- LA-14 No function moves liquidity, coins held for others, `creatorOwed` or `earnPending` except as written; no owner,
  no pause.

Launch
- LA-15 First buy `≤ maxFirstBuyBps × SUPPLY`, `≥ minCoinOut`, charged 1%.
- LA-16 The pool opens at exactly `START_TICK`; the position spans `[MIN_TICK, START_TICK]`.

## 8. Test plan

Unit (`AgentLaunch.t.sol`, `SpokeHook.t.sol`): every named revert, every gate, both ORRY sides of the fee for buys and sells
exact in and exact out, the fee curve, the early window and the allowance, distribution rounding, the Earn interval, creator
claims to a bound and an unbound wallet, identity transfer, hostile init with and without liquidity, outside liquidity,
salt mining for the CREATE2 factory. Invariant campaign with a handler (launches, early buys, public buys and sells exact in
and out, distributions, claims, time) and a deterministic deep run that reports how many coins, swaps, distributions and
claims it reached. Mutation script `contracts/mutate_launch.py`: every mutant caught or explained. Fork test on 4663
(`test/launch/fork/LaunchFork.t.sol`): the real PoolManager, the real ORRY, the real `OrreryAttestor`, `OrreryPolicyModule` and
ERC-8004 registry, a real Safe 1.4.1 with Safe7579 as the agent account; `OrryStaking`, `OrreryHook` hub, `EarnVault`,
`OrryPriceOracle` deployed from source on the fork.

## 9. Owner questions (defaults are in the constructor)

1. Start price `START_TICK` 25,000 (about 82.1 M ORRY start value, Pons-like) or another.
2. Minimum agent stake to launch: 100 USD of ORRY locked 90 days.
3. Creator first buy cap: 5% of supply.
4. Launch fee against snipers: 80% falling to 1% over 60 s after the public opening.
5. Early window 10 minutes; allowance 0.5% of supply at 1,000 USD of stake, linear, minimum 10 USD.
6. One coin per agent, ever.
7. Earn share to the ORRY/ETH vault only (not the USDG hub's vault).
8. Owner share paid to `OrreryTreasury.owner()` (the owner wallet, follows the treasury's ownership).

## 10. Build status (2026-11-11)

Contracts (`contracts/src/launch/`): `AgentLaunch`, `SpokeHook`, `SpokeRouter`, `AgentCoin`, interfaces. Tests
(`contracts/test/launch/`): unit (`AgentLaunch.t.sol` 35 + 1, `SpokeHook.t.sol` 16, `SpokeRouter.t.sol` 6), invariant
campaign and deterministic deep run (`invariant/`), fork suite on 4663 (`fork/LaunchFork.t.sol`, 3). Mutation script
`contracts/mutate_launch.py`. Numbers, the mutation table and what is unverified are in the lane report
`~/.claude/orchestrator/laporan/rc-L5-launch.md`.

Facts measured on the 4663 fork (block 111,621,851, official RPC through a local forwarder): the PoolManager sets no
protocol fee on a new spoke (`slot0.protocolFee` 0); the real ORRY token burns with `burn`; the real OrreryAttestor verifies
an agent paid in real USDG; the real OrreryPolicyModule answers installed for a Safe 1.4.1 with Safe7579; the spoke hook's
salt mined for the CREATE2 factory `0x4e59b448…956C` was 573.

Services: migration `030_launch.sql` (031 unused), `launch-config.ts`, `launch-indexer.ts`, `launch-api.ts`,
`bin/launch-indexer.ts`, shared `launch.ts` with generated ABIs, `scripts/launch-stack.ts` (salt miner and deploy pair),
`scripts/launch-gen-abi.mjs`, `test/launch.integration.test.ts`. Web: `/launch`, `/launch/new`, `/launch/[coin]` behind
the `launch` release (the early window panel also behind `launch-priority`); a dashboard sidebar link while `launch` is open.

Mutation (`contracts/mutate_launch.py`, 91 mutants): 89 caught, 2 explained. Explained: the fill check in `_swapIn`
(the launch position spans to the lowest usable tick, so a buy reaches the price limit only past about 5e45 ORRY, far
beyond ORRY's 1e27 supply) and the reentrancy guard on `distribute` (ORRY and the coin have no transfer callbacks; the
vault and the PoolManager are Orrery's and Uniswap's own contracts). The intake and burn exactness checks are caught by
`HostileOrry.t.sol` (a transfer-fee token and a short burn swapped in place).
