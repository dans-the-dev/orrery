# Lane L3: wave R2 markets and the ORRY paymaster

Date: 2026-11-11 (machine clock UTC). Branch `claude/upd-r2-98f2dc` off `build/v1` 00a5c95. Status: spec and invariants
written before code; build status in section 9. Internal engineering document.

Owner decisions this lane implements: R-23 to R-30 (markets, levers, custody), R-16 (no integration, rebuild as our own),
R-44 utility 12 (paymaster), R-28 (hub TWAP), R-63 to R-65 (build now, parallel lanes, nothing deployed). Plans:
`docs/ORRY-MARKETS-PLAN.md` (R2 row: M3 Shield V2, M6 Prediction markets, M13 Limit orders; section 6 custody rule and
X-1 to X-4), `docs/ORRY-UTILITIES-PLAN.md` item 12, `docs/ORRY-UPGRADE-PATHS.md` (R2 and utility 12 rows: new
contracts, no redeploy). R1 contracts (`contracts/src/markets/*.sol`) are read only and are the pattern.

Values marked "(guess)" are delegated defaults; every one is a constructor argument and an owner question in the lane
report.

## 1. Product

| Surface | What a user does | Contract | Custody pattern (R-27) |
| :--- | :--- | :--- | :--- |
| Predict | Takes a YES or NO position in USDG on "will this asset's price be above the strike at the close"; after the close the winning side shares the pool | `PredictionMarket`, one contract per market, made by `PredictionMarketFactory` | C: each market is its own contract (X-3) |
| Limit orders | Signs a buy or sell order for a stock token at a price; a keeper fills it through the asset's Uniswap v4 pool once the pool reaches that price; nothing leaves the wallet until the fill | `LimitOrderBook` (one, for every asset with an R1 market and a listed pool) | A: pulled from and paid to the owner's wallet in the fill transaction (X-1) |
| Gas in ORRY | An agent's operator prepays a little ORRY for the agent's smart account; the account's ERC-4337 operations are then paid in ORRY priced in USD | `OrryPaymaster`, one per EntryPoint (v0.7 and v0.8) | not a market: holds prepaid ORRY only, never USDG or stock tokens (X-4) |
| Shield | Moves USDG into a private balance, sends it privately and withdraws to any address with a zero-knowledge proof | `OrreryShield` (one per asset) with the copied `HonkVerifier` | C: one pool per asset (privacy needs a shared pool, C3) |

Open to every wallet (R-25). No contract in this lane has an owner power over user funds, a pause, or an upgrade path
(R-10). Burn sources added for the indexer (`IOrryBurnEvents.Burned`): 30 prediction market creation fee, 31 prediction
fee paid in ORRY, 32 limit order fee paid in ORRY, 33 paymaster premium. Lane-numbered range (L3 = 30 to 39) so the
parallel lanes cannot collide; the orchestrator may renumber at merge (only `BURN_SOURCES` and four constants change).

## 2. Decisions taken in this lane (delegated, 2026-11-11)

| Id | Decision | Why |
| :-- | :--- | :--- |
| L3-1 | Prediction markets are parimutuel (YES pool, NO pool) in USDG, as Quero's `ArcanePredictionMarkets` (MIT, origin noted), rebuilt as one contract per market (pattern C) instead of one contract for all markets | R-27 pattern C; a USDG freeze or wipe reaches one market only |
| L3-2 | Anyone may create a market on a listed feed; the factory owner (the treasury owner key) only lists feeds, add only, each bound to its asset (or none for a non-stock feed). Creation burns `creationFeeUsd` of ORRY (1 USD, guess; 0 disables; nothing while the ORRY price is not ready) | R-25; a burn per market deters junk and is lever L3; the owner cannot change or remove a market |
| L3-3 | A market settles at the first Chainlink round published at or after its close: the settler names it and the contract checks that the round before it predates the close (Quero rule). YES wins only strictly above the strike | no settler can pick a price |
| L3-4 | Refund in full, no fee: one side empty at the close; not settled within `SETTLE_WINDOW` (7 days); or a corporate action of the bound stock token (`effectiveAt` after the market was created and at or before the settlement round). `settle` reverts while the token reports `oraclePaused` | a split or multiplier change makes the strike meaningless (D-R1-2 pattern) |
| L3-5 | The fee is taken per claim from the winner's gross payout: `floor(gross × feeBps × (10000 − discount) / 10000²)` (200 bps guess, at most 300), discount from `FeeTiers` read at claim (L2). With `payFeeInOrry` the claimer burns ORRY worth the fee less `orryFeeDiscountBps` (2500, guess) and receives the gross (L3, source 31). Without discounts the total fee equals Quero's fee on the whole pool | levers L1, L2, L3 |
| L3-6 | Dust and donations of a settled market are swept to the treasury by anyone (`sweep`): balance minus what the unclaimed stakes are still owed (rounded up) | no stuck USDG beyond what users are owed |
| L3-7 | Limit orders are EIP-712 signed (EOA or ERC-1271 smart account), never escrowed. A keeper calls `fill`; the book pulls the input from the owner's wallet, swaps it in the asset's v4 pool inside one `unlock`, pays the output, the fee and the keeper tip, and ends holding nothing (pattern A, X-1). Quero's `ArcaneLimitOrderBook` escrowed funds; that part is not taken | R-27 pattern A |
| L3-8 | The asset list, its Chainlink feed and its v4 pool are read from the R1 `MarketFactory` (`marketOf(asset)` then the market's `priceFeed()` and `remainderPool()`), so the book has no owner and no list of its own | no new admin; an asset is fillable exactly when R1 lists it with a pool |
| L3-9 | A fill is all or nothing at a realised price that meets the order's limit and sits within `maxDeviationBps` (100, guess) of a fresh Chainlink price (`maxStaleness` 90,000 s, guess); a feed the token reports `oraclePaused` blocks fills | a keeper cannot push the pool to the limit and take the gap; partial fills are a later option |
| L3-10 | Limit order fee `feeBps` (10, guess, at most 50) of the USDG notional to the treasury (L1) with the `FeeTiers` discount (L2), or in ORRY burned (L3, source 32); the tip (0 to 100 bps of the notional, the owner's choice) goes to the keeper in USDG. A buyer pays fee and tip on top; a seller receives proceeds net of them | as R1 2.4 |
| L3-11 | The paymaster works from a prepaid ORRY balance per smart account: anyone deposits ORRY for an account (an operator's float wallet funds its agent); only the account withdraws its own balance. No `approve` is needed from the account, which the KYA module forbids (I13) | agents' Safes cannot approve; a transfer-from in validation would also need them to |
| L3-12 | Price: gas cost in ETH × Chainlink ETH/USD → USD → `OrryPriceOracle.orryFor` (hub TWAP, R-28) plus `premiumBps` (1000 = 10%, guess). Validation reads only the paymaster's own storage: a rate cached by `refreshRate()` (anyone; the keeper calls it at half of `maxRateAge`) and the sender's balance, and returns `validUntil = cachedAt + maxRateAge` (3600 s, guess) for the EntryPoint to enforce; it moves `maxCost × rate × (1 + premium + bufferBps)` (buffer 2000, guess) from the balance into the operation's context. `postOp` reads the fresh rate in try blocks (falls back to the validation rate), charges `actualGasCost + (postOp gas limit + call gas limit / 10 + postOpOverheadGas) × fee per gas` at that rate plus the premium, never above the precharge, and returns the rest. Revised 2026-11-11 after two findings: ERC-7562 forbids `TIMESTAMP` and unstaked oracle reads in validation (so no oracle in validation), and the real EntryPoint v0.7 and v0.8 charge postOp gas and a 10% unused-gas penalty after reporting `actualGasCost` (the fork test showed the first version charging 72% of the ETH spent) | ERC-4337 safety: a withdrawal inside the operation cannot take the precharge; postOp cannot revert |
| L3-13 | The base part of each charge accrues for `orryRecipient` (immutable; guess: the wallet that funds the ETH deposit) and the premium part is burned (source 33); `flush()` by anyone does both | lever L3; the funder of the ETH is paid back in ORRY |
| L3-14 | Paymaster owner (two-step; the treasury owner key) manages only the paymaster's own ETH at the EntryPoint: deposit, withdraw, stake, unlock, withdraw stake. It can neither touch prepaid balances nor change the price rule. One paymaster per EntryPoint; `maxCostWei` per operation (0.002 ETH, guess) | ERC-7562: a paymaster that reads the oracle's storage in validation must be staked (STO-033) |
| L3-15 | Shield V2 copies Hushwave's `transact` circuit (Noir, 2 in, 2 out, EIP-712 signature checked in circuit), its generated `HonkVerifier` and `LibPoseidon2Yul` unchanged (SPDX kept, origin noted), and rebuilds the pool as `OrreryShield`: one asset per contract, domain "Orrery Shield", no owner, no pause, no screener, immutable fees (deposit 50 bps, withdraw 50 bps, guesses, at most 100) paid to the treasury (L1), with the `FeeTiers` discount of the depositor and of the withdrawal recipient (L2). Deposits enter the note tree at once | R-16 and U3; the domain separator is a public input of the circuit, so the same verifier serves a new pool |

## 3. `PredictionMarketFactory` and `PredictionMarket`

### 3.1 Factory

- Constructor: `owner` (treasury owner key), `usdg`, `treasury`, `feeTiers`, `orryPrice`, `orry`, params
  `{feeBps 200, lockSeconds 1800, minStake 1e6, creationFeeUsd 1e6, orryFeeDiscountBps 2500}` (all guesses; `feeBps ≤
  300`, `lockSeconds ≥ 60` and below `MIN_DURATION`, `minStake > 0`, discount ≤ 10000).
- `listFeed(feed, asset)`: owner only, add only; the feed must answer `latestRoundData` with a positive answer;
  `asset` is the stock token whose corporate actions void a market (address 0 for none). Emits `FeedListed`.
- `create(feed, strike, closeTime)`: anyone; feed listed, `strike > 0`, `closeTime` in `[now + MIN_DURATION (1 h),
  now + MAX_DURATION (120 d)]`; burns `creationFeeUsd` of ORRY from the caller at `orryPrice` (balance-delta checked on
  total supply, `Burned(30, amount)`), nothing while the price is not ready; deploys a `PredictionMarket` with `new`;
  emits `MarketCreated(market, feed, asset, strike, closeTime, lockTime, creator)`.
- `transferOwnership` / `acceptOwnership` (two-step). No other owner function.

### 3.2 Market (immutables from the factory, no owner)

- `stake(bool yes, uint256 amount)`: before `lockTime`; `amount ≥ minStake`; pulls USDG (balance-delta checked);
  adds to the side and the account's stake.
- `settle(uint80 roundId)`: anyone, once, after `closeTime`, before `closeTime + SETTLE_WINDOW`:
  - one side empty → `Refund`;
  - else the round must have `updatedAt ≥ closeTime`, a positive answer, and round `roundId − 1` must exist with
    `0 < updatedAt < closeTime`; the bound asset must not report `oraclePaused` (`StalePrice`); if the asset's
    `effectiveAt` is in `(createdAt, round.updatedAt]` → `Refund`; else `Yes` when `answer > strike`, otherwise `No`.
- `expire()`: anyone, at or after `closeTime + SETTLE_WINDOW` while `Open` → `Refund`.
- `claim(bool payFeeInOrry)`: once per account after settlement. Refund: the account's stakes. Yes or No:
  `gross = floor(stake × total / winningPool)`; fee per L3-5; pays `gross − fee` and sends the fee to the treasury, or
  burns the ORRY fee from the caller (allowance and balance needed; falls back to USDG while the price is not ready).
- `sweep()`: anyone, after settlement: `balance − owed` to the treasury, where `owed` is the unclaimed stakes (Refund) or
  `ceil(unclaimedWinningStake × total / winningPool)` (Yes or No).
- Views: `info()`, `stakeOf(account)`, `claimable(account)` (gross and fee before discount choice), `status()`.

### 3.3 Invariants (PM)

- PM-1 Solvency: at every point the market's USDG balance is at least `owed` (all stakes while open; the formula above
  after settlement).
- PM-2 Conservation per settled market: Σ payouts + Σ USDG fees + swept ≤ total staked + donations, and the residue
  after every winner claimed is below one base unit per winning account plus donations.
- PM-3 A claim pays at most once per account; after settlement no stake changes.
- PM-4 Outcome: Yes iff the settlement round's answer > strike; the round is the first with `updatedAt ≥ closeTime`.
- PM-5 Refund pays exactly the account's stakes, no fee.
- PM-6 Fees: USDG fee = `floor(gross × feeBps × (10000 − d) / 10000²)`; an ORRY fee burns exactly that ORRY (supply
  falls by it) and the claimer then gets the full gross.
- PM-7 Status moves only Open → {Yes, No, Refund}, once; staking stops at `lockTime`.
- PM-8 The factory owner cannot change, settle or remove a market; a market holds only its own stakes (X-3).

## 4. `LimitOrderBook`

- Constructor: `usdg`, `marketFactory` (R1), `poolManager`, `treasury`, `feeTiers`, `orryPrice`, `orry`,
  `feeBps 10`, `maxDeviationBps 100`, `maxStaleness 90000`, `orryFeeDiscountBps 2500` (guesses; `feeBps ≤ 50`,
  `maxDeviationBps ≤ 1000`).
- `Order {owner, asset, sellAsset, amountIn, limitPrice, tipBps, payFeeInOrry, nonce, expiry}`, EIP-712 domain
  ("Orrery Limit Orders", "1", chain id, book). `limitPrice` in USDG base units per 1e18 asset base units (R1's unit);
  sell: lowest accepted gross price; buy: highest. `amountIn`: asset (sell) or USDG spent in the swap, fee and tip
  excluded (buy). `tipBps ≤ 100`, `expiry ≤ now + 30 days` at fill.
- `fill(order, signature)`: anyone (the keeper); checks signature (ECDSA with low s, or ERC-1271 when `owner` has code),
  `nonce` unused, not expired, asset listed in R1 with a pool, a fresh positive feed price (`now − updatedAt ≤
  maxStaleness`, not `oraclePaused`); marks the nonce used; pulls the input (buy: `amountIn + fee + tip`, or `amountIn +
  tip` when the fee is in ORRY; sell: `amountIn`), balance-delta checked; swaps exact input in the pool with a price
  limit at the tighter of the order limit and the oracle band; reverts `NotFillable` unless the whole `amountIn` traded
  and the realised price meets both; pays the output to the owner (sell: net of fee and tip), the tip to `msg.sender`,
  the USDG fee to the treasury or burns the ORRY fee from the owner (source 32); asserts the book's asset and USDG
  balances are unchanged (X-1). Emits `OrderFilled(orderHash, owner, asset, sellAsset, amountIn, amountOut, fee,
  orryFee, tip, keeper)`.
- `cancel(nonce)` / `cancelMany(nonces)`: the owner marks its own nonces used. `nonceUsed(owner, nonce)`,
  `hashOrder(order)` views. No owner, no pause, no setter.

Invariants (LO):

- LO-1 After every external call the book's balances of every asset it touched and of USDG are unchanged (X-1).
- LO-2 A fill happens only with a valid owner signature for the exact order; a nonce fills at most once; a cancelled
  nonce never fills.
- LO-3 Realised gross price meets the limit (sell: USDG out × 1e18 ≥ limit × asset in; buy: USDG in × 1e18 ≤ limit ×
  asset out) and is within `maxDeviationBps` of the fresh oracle price.
- LO-4 Conservation per fill: sell: owner receives `out − fee − tip`, treasury `fee`, keeper `tip`; buy: owner pays
  exactly `amountIn + fee + tip` and receives all the asset the pool returned.
- LO-5 Fee = `floor(notional × feeBps × (10000 − d) / 10000²)`; tip = `floor(notional × tipBps / 10000)`; ORRY fee
  burned exactly.
- LO-6 No fill after expiry, for an unlisted asset, on a stale or paused feed, or partly.

## 5. `OrryPaymaster` (utility 12)

- Constructor: `entryPoint` (v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` or v0.8
  `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` on 4663, both checked with `eth_getCode`, section 8), `orry`,
  `orryPrice`, `ethUsdFeed`, `owner`, `orryRecipient`, params `{premiumBps 1000, bufferBps 2000, maxCostWei 2e15,
  postOpOverheadGas 10000, maxRateAge 3600, maxEthStaleness 7200}` (guesses; `premiumBps ≤ 5000`, `bufferBps ≤ 10000`).
  `MIN_POST_OP_GAS` 120,000: a smaller postOp gas limit in `paymasterAndData` is refused.
- `deposit(account, amount)`: anyone; pulls ORRY from the caller (balance-delta checked) and credits `balanceOf[account]`.
  `withdraw(to, amount)`: the account itself, from its own free balance.
- `refreshRate()`: anyone; caches `rate = orryFor(USD of 1 ETH)` from a fresh, positive ETH/USD answer and the hub TWAP.
- `validatePaymasterUserOp(op, hash, maxCost)`: only the EntryPoint; `maxCost ≤ maxCostWei`; postOp gas limit ≥
  `MIN_POST_OP_GAS`; a cached rate exists; `precharge = ceil(maxCost × rate × (10000 + premiumBps + bufferBps) / (1e18 ×
  10000))`; reverts (`InsufficientBalance`) when the sender's balance is short; moves the precharge out of the balance;
  context = (sender, precharge, rate, postOp gas limit + call gas limit / 10); `validationData = validUntil << 160`.
- `postOp(mode, context, actualGasCost, feePerGas)`: only the EntryPoint; the fresh rate when the oracle answers (and
  cached), else the context's; `cost = actualGasCost + (extraGas + postOpOverheadGas) × feePerGas`; `charge =
  min(precharge, ceil(cost × rate × (10000 + premiumBps) / (1e18 × 10000)))`; premium part `charge − floor(charge × 10000
  / (10000 + premiumBps))` to `pendingBurn`, the rest to `pendingRecipient`; refund `precharge − charge`. Every external
  read is in a try block.
- `flush()`: anyone; transfers `pendingRecipient` to `orryRecipient`, burns `pendingBurn` (`Burned(33, amount)`).
- Owner (two-step): `depositEth()` (payable, into the EntryPoint), `withdrawEth(to, amount)`, `addStake(delay)`,
  `unlockStake()`, `withdrawStake(to)`.

Invariants (PA):

- PA-1 Between operations, ORRY held = Σ balances + pendingRecipient + pendingBurn (exact; balance-delta checked
  deposits).
- PA-2 A balance falls only by the owner's withdraw or by a validated operation's charge; a charge is at most the
  precharge, and the precharge is at most what the balance held.
- PA-3 Price: `charge × 1e18 × 10000 ≥ cost × rate × (10000 + premiumBps)` (rounded up for the protocol) unless capped by
  the precharge; on the real EntryPoints the charge covers the ETH the paymaster's deposit actually lost, plus the premium.
- PA-4 Only the EntryPoint calls validate and postOp; postOp cannot revert; validation touches only the paymaster's own
  storage and returns the cache's `validUntil`.
- PA-5 The owner can move only the paymaster's ETH at the EntryPoint; no function moves another account's ORRY balance
  except that account's withdraw and the operation charge.
- PA-6 `flush` burns exactly `pendingBurn` (total supply falls by it) and pays exactly `pendingRecipient`.

## 6. `OrreryShield` (Shield V2)

- Copied unchanged from Hushwave (`hushwave/` at 94ae19f, MIT): `circuits/transact` (Noir), `HonkVerifier.sol`
  (generated by Barretenberg from that circuit), `LibPoseidon2Yul.sol`. The circuit's public inputs: root, two
  nullifiers, two output commitments, asset, kind, withdraw amount, withdraw recipient, relayer fee, protocol fee, intent
  nullifier, domain separator (two halves), external data hash.
- `OrreryShield(verifier, asset, treasury, feeTiers, depositFeeBps 50, withdrawFeeBps 50)`; one asset; no owner, no
  pause, no screener, no block list (the asset's own issuer controls still apply to its transfers).
- `register(npk, viewKey)`, `deposit(amount, secretCommit, encryptedNote)` (fee with the depositor's tier, note of
  `amount − fee` inserted at once), `transact(args, ext)` (send: no protocol fee; withdraw: `protocolFee ≥
  floor(amount × withdrawFeeBps × (10000 − d(withdrawTo)) / 10000²)`), `flushFees()` (anyone, accrued fees to the treasury).

Built (2026-11-11, lane L3 second run):
- `contracts/src/markets/r2/shield/`: `OrreryShield.sol`, the circuit (`circuit/`, Noir), `verifier/HonkVerifier.sol`
  (Apache-2.0, Aztec) and `vendor/LibPoseidon2Yul.sol` (MIT), each with an origin line. Rebuilding the copied circuit with
  the Hushwave toolchain image (`hushwave-zk:rc5`: `nargo compile`, `bb write_vk -t evm`, `bb write_solidity_verifier`)
  gives a verifier identical byte for byte and the same ACIR bytecode as the copies.
- `Deposited(depositor, amount, fee, secretCommit, commitment, leafIndex, encryptedNote)` carries the secret commitment, so
  a wallet rebuilds its deposit note from the pool's own net amount even if the staker discount changed between its fee
  read and the deposit.
- The verifier compiles only with the legacy pipeline (via-IR stops on "too deep in the stack"): `foundry.toml` gains one
  compilation restriction for that file. Its two external libraries (`ZKTranscriptLib`, `RelationsLib`) are deployed and
  linked with it (18,783 bytes of runtime for the verifier itself).
- Gas on 4663 (fork, real USDG): a private send 4,103,505, a withdrawal 4,167,183 (the proof check dominates).
- Client: Hushwave's SDK ported to `services/packages/web/lib/r2/shield/` (keys, notes, tree, encryption, transaction
  builder, prover; the key-derivation domain and labels are Orrery's). Proofs run in the browser with `@aztec/bb.js`
  5.0.0 and `@noir-lang/noir_js` 1.0.0-rc.5, on one thread unless the page is cross-origin isolated.
- Submission: the user's own wallet sends `transact` (relayer fee 0). The submitting address is visible on chain; which
  note it spends is not. A relayer service that pays gas for a fee (Hushwave's model) is a follow-up, not built.

Invariants (SH):

- SH-1 Pool balance ≥ Σ note values in the tree that are not spent + accrued fees (value conserved by every proof:
  inputs = outputs + withdraw + relayer fee + protocol fee).
- SH-2 A nullifier and an intent nullifier are spent at most once; only known roots are accepted.
- SH-3 Only a valid proof for exactly the submitted public inputs moves notes or funds.
- SH-4 Deposit fee and withdrawal protocol fee are at least the tiered rate; fees reach only the treasury.
- SH-5 No function can stop withdrawals; no address can take pool funds.

## 7. Services and web

- Migrations 024 (prediction), 025 (limit orders), 026 (paymaster), 027 (shield): events at the confirmation depth and
  derived tables, as `004_markets.sql`.
- Indexer `r2-indexer.ts`: the factory and every market it made, the book, the paymasters, the shield; one
  `eth_getLogs` per address set per range, cursor `r2` in `indexer_state`.
- API `r2-api.ts`: `GET /v1/r2/predict` (markets, pools, status, odds), `GET /v1/r2/predict/:market`, `GET
  /v1/r2/limit-orders/:owner` (fills and cancellations), `POST /v1/r2/limit-orders` (stores a signed order for the
  keeper after checking its signature and fields), `GET /v1/r2/paymaster/:account`, `GET /v1/r2/shield`. Routes answer 404
  while their release is held. User balances and positions (`/v1/r2/accounts/:address`) are never held.
- Keepers: `r2-keeper.ts` settles predict markets at the first round after the close (and expires unsettled ones) and
  fills stored limit orders that simulate successfully; it never sends a transaction that fails simulation.
- Releases (appended): `predict`, `limit-orders`, `shield`; `paymaster` exists.
- Web: `/predict`, `/limit-orders`, `/gas` (paymaster balance and deposit), `/shield`, in design 03 (Current Limit),
  behind the release switch, nav entries appended.

## 8. Outside facts (4663)

| Item | Value | Status |
| :--- | :--- | :--- |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032`, 16,035 bytes, code hash `0x8db5ff69…82fc58` | verified 2026-11-11, `cast codesize` at block 111,494,986 |
| EntryPoint v0.8 | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`, 21,738 bytes, `eip712Domain()` = ("ERC4337", "1", 4663, itself) | verified 2026-11-11 |
| ETH/USD feed | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` "ETH / USD", 8 decimals, answer 2,069.88 updated 34 min before the read | verified 2026-11-11 |
| ORRY | `0x85272EA3aE8685C768045dba5455fE305C706aA4`, symbol ORRY, total supply 1e27, on its Pons curve | verified 2026-11-11 |
| ERC-4337 bundlers serving 4663 | not checked | UNVERIFIED: the paymaster needs a bundler that accepts staked paymasters reading an oracle (ERC-7562 STO-033) |

## 9. Build status (2026-11-11)

| Part | State |
| :--- | :--- |
| Prediction markets, limit order book, paymaster | built, unit 96 + fuzz + 3 invariant campaigns and deep runs passing; fork 8 of 8 on 4663; mutation in the report |
| Services | indexer, API, keeper, migrations 024 to 026; integration 7 of 7 against the real contracts on anvil |
| Web | `/predict`, `/limit-orders`, `/gas` live behind their releases, `/shield` held; local walk with screenshots |
| Shield V2 | built in the second run: contract, copied circuit and verifier, real-proof unit, invariant, mutation and fork tests, services (events stream, info), `/shield` with the browser prover |

Final numbers and commands are in `~/.claude/orchestrator/laporan/rc-L3-r2.md`.
