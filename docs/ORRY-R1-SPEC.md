# Wave R1 build spec: Dark Pool, Private Swap, Stocks

Date: 2026-11-08 (WIB). Branch `orry/spec`. Status: spec and invariants for review; no code. Decisions: R-23 to R-30
in `docs/ORRY-BUILD-SPEC.md`; background in `docs/ORRY-MARKETS-PLAN.md`. Values marked "(guess)" are delegated
defaults the owner may change before deployment; they are constructor arguments.

## 1. Product

| Surface | What a user does | Contract |
| :--- | :--- | :--- |
| Stocks | Browses the Robinhood stock tokens on 4663 with live prices and their own holdings, and buys or sells one through the next batch | `SealedBatchMarket` (one per stock token) |
| Private Swap | Swaps a stock token for USDG or back with the order size hidden until the batch clears; a fill or a refund in one step | same market, `swap` mode: any unmatched part fills against a Uniswap v4 pool when one is listed for the token (R1b, after measurement), otherwise stays unfilled and nothing moves |
| Dark Pool | Places limit orders for size; crosses only with other orders at the oracle price; no price impact | same market, `limit` mode |

One venue serves all three: sealed commit and reveal batches per stock token against USDG, cleared at the Chainlink
price, settled wallet to wallet (custody pattern A, R-27). Open to every wallet (R-25). Source: Quero
`arcane/contracts/src/darkpool/ArcaneDarkPool.sol` and `swap/ArcaneBatchSwap.sol` (U3; keep their SPDX header and note
the origin), changed where this spec says so; Quero's internal balances are removed.

## 2. Contracts

All under `contracts/src/markets/`, interfaces frozen in `contracts/src/markets/interfaces/`.

### 2.1 `SealedBatchMarket` (one per stock token)

- Constructor: `asset` (stock token), `usdg`, `priceFeed` (Chainlink aggregator for the asset in USD), `treasury`
  (`OrreryTreasury`), `feeTiers`, `orryPrice`, `orry`, `params`: `commitSeconds` 240 (guess), `revealSeconds` 60
  (guess), `feeBps` 15 = 0.15% per side (guess, at most 50), `minNotionalUsdg` 10 USDG (guess), `maxStaleness` per the
  feed's heartbeat plus the market-hours rule (2.3), `commitFeeUsd` 0.05 USD of ORRY (guess, 0 disables).
- Batches: batch `n` has a commit window, then a reveal window; times derive from a fixed `start` and the two lengths.
- `commit(bytes32 commitment)`: during the commit window; stores `commitment` for (`batch`, `msg.sender`), one per
  address per batch; when `commitFeeUsd > 0` it burns ORRY worth `commitFeeUsd` at `orryPrice` from the sender
  (balance-delta checked; `Burned(5, amount)`), or charges nothing while `orryPrice` is not ready. At most
  `MAX_ORDERS` (64) commitments per batch; a full batch reverts `BatchFull` (the web offers the next batch).
- `reveal(Order order, bytes32 salt)`: during the reveal window; `keccak256(abi.encode(batch, msg.sender, order,
  salt))` must equal the commitment (`revealFor(account, order, salt)` does the same for `account`, so an opt-in relay
  that holds the salt can reveal; the commitment binds the account); `order = {sellAsset, amountIn, limitPrice, mode, payFeeInOrry}`; rejects
  `amountIn × price < minNotionalUsdg` at the last feed price. Nothing is transferred.
- `clear(uint256 batch, uint80 roundHint)`: anyone, once after the reveal window and before `start + EXPIRY` (1 day);
  the clearing price is the Chainlink answer of round `roundHint`, which must be the latest round with `updatedAt ≤
  revealEnd` (either `roundHint` is the feed's latest round, or round `roundHint + 1` of the same phase has `updatedAt >
  revealEnd`), with `revealEnd − updatedAt ≤ maxStaleness` and a positive answer. Then, in one transaction:
  1. For every revealed order whose limit the price satisfies, pull its input from the owner's wallet (`transferFrom`,
     balance-delta checked) inside a try block; a failed pull (allowance, balance, an issuer block or pause) drops that
     order only.
  2. Cross the pulled buy and sell volumes at the price; the larger side fills pro rata (every order on it at the same
     fraction, rounded down, dust to the treasury).
  3. Pay each filled order its output and refund its unfilled input to the same wallet, net of fees; fees in USDG go to
     the treasury; fees paid in ORRY (2.4) are burned.
  4. Assert the market holds no asset and no USDG (X-1).
  If the asset is paused or the feed cannot price the batch before `EXPIRY`, the batch expires: nothing was pulled, so
  nothing is owed. `clear` never reverts because one order fails.
- No owner, no pause, no setter, no withdrawal function (it never holds anything). Not upgradeable.

### 2.2 `MarketFactory`

- Owner: the treasury owner key (one wallet, M1). `create(asset, priceFeed)` deploys one `SealedBatchMarket` per stock
  token (ERC-1167 clone or `new`), at most one per asset (X-3), with the factory's fixed parameters; emits
  `MarketCreated`. The owner can only add markets; it cannot change, pause or remove one.

### 2.3 Prices

- Stock prices: the Chainlink USD feed of each token on 4663 (feed list
  `https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json`, 8 decimals, 24 h heartbeat, 0.5%
  deviation; to be re-read on chain before deployment). Market-hours rule from Quero `apps/api/src/lib/oracles.ts`: on
  weekends and US market holidays the feed is stale by design, so batches do not clear; they expire and nothing moves.
- ORRY in USD (`orryPrice`, contract `OrryPriceOracle`): the hub's mean tick over 30 minutes from
  `OrreryHook.consult` (R-28) times the Chainlink ETH/USD feed on 4663 (address to verify). `ready()` is false while
  the hub has under 30 minutes of history or the ETH feed is stale.

### 2.4 Fees and ORRY levers (R-24)

| Lever | Rule |
| :--- | :--- |
| L1 | Fee `feeBps` of each side's filled notional in USDG: the buyer pays it on top, the seller receives proceeds net of it; it goes to `OrreryTreasury`, which sends 90% to the ORRY buyback (R-4) |
| L2 | `FeeTiers.discountBps(account)` values `OrryStaking.earningBalance(account)` (plain stake plus agent stakes as staker, C1) in USD at `orryPrice` (utility 10, R-44, R-46): at least 100 USD of stake gives 25% off, at least 1,000 USD gives 50% off (guesses, constructor values); 0 while the oracle is not ready |
| L3 | With `payFeeInOrry`, the order's fee is charged in ORRY at `orryPrice` with a further `orryFeeDiscountBps` off (constructor value, 2500 = 25%, guess; readable on chain), pulled at clearing and burned (`Burned(6, amount)`); if `orryPrice` is not ready the fee falls back to USDG |
| L4 | none in R1 (open to everyone) |
| commit fee | `commitFeeUsd` in ORRY, burned at commit (spam and free-option deterrent, 2.5) |

New burn sources for the indexer: 5 (commit fee), 6 (fee paid in ORRY).

### 2.5 Known limits of wallet-to-wallet settlement (stated for the owner; not shown to users)

- A trader can drop out after the price is fixed by revoking the allowance or moving the balance before `clear`; the
  others' fills are recomputed without that order. The commit fee is the cost of doing so; repeated failures by one
  address can be shown in the indexer.
- An issuer block on one trader drops only that trader's order; a pause on the asset expires the batch.

## 3. Invariants (each needs a test)

- DP-1 After every external call the market's asset and USDG balances are zero (X-1).
- DP-2 Every fill is at the clearing price, which satisfies both orders' limits; the price is the hinted Chainlink round,
  the latest at or before `revealEnd`, fresh and positive.
- DP-3 Conservation per batch: asset received by buyers equals asset taken from filled sellers; USDG received by sellers
  plus USDG fees equals USDG taken from filled buyers; refunds equal pulled minus used.
- DP-4 Pro rata: on the larger side every order fills at the same fraction (to 1 base unit); the smaller side fills in
  full.
- DP-5 An order executes at most once; only an order whose commitment was made in that batch's commit window by the same
  address and revealed in its reveal window can execute.
- DP-6 A failed pull (any reason) drops only that order; `clear` never reverts on one order.
- DP-7 Fees: USDG fee = `floor(notional × feeBps × (1 − discount) / 1e4)`; the discount is read at clearing; ORRY fees
  and commit fees are burned exactly (total supply falls by the amount, G-2).
- DP-8 Batch timing is monotonic; a batch clears at most once; after `EXPIRY` it can no longer clear.
- DP-9 One market per asset; the factory owner cannot change a market (X-3).
- DP-10 No Pons address or selector in runtime code (G-1); no mint (G-2).

## 4. Tests and proofs

Unit tests per function and named revert; an invariant campaign with a handler that commits, reveals, revokes,
blocks (mock issuer controls: block, pause), moves the oracle and clears, with ghost balances; a deterministic deep run
with counts per state; mutation checks per invariant; fork tests on 4663 with real stock tokens, their real Chainlink
feeds and the real issuer controls exercised by impersonating the role holder (block one trader, pause the asset), and
the hub oracle for ORRY fees.

## 5. Services and web

- Indexer and API: markets, batch phases and countdowns, revealed orders after the reveal window, clearing results,
  per-wallet order history, burn sources 5 and 6, stock list with prices (on-chain feeds; the Robinhood asset list API
  only if its terms allow product use: lane C checks and reports). Keeper: `clear` at the first block after each
  reveal window with the right `roundHint`.
- Reveal: the web keeps the order and salt in the browser and reveals for the user; an opt-in API relay can reveal on
  the user's behalf (the order is then known to Orrery's server before the batch closes; the user chooses).
- Web: `/stocks` (list and asset pages), `/swap` (Private Swap), `/dark-pool` (limit orders, batches, history);
  release switch features `stocks`, `swap`, `darkpool`; copy rules (no risk or doubt sentences; Orrery's own words,
  overlap with Quero measured).

## 6. Lanes

| Lane | Owns | Work |
| :--- | :--- | :--- |
| M-1 contracts | `contracts/src/markets/**` (not `interfaces/`), `contracts/test/markets/**`, `contracts/test/fork/markets/**` | `SealedBatchMarket`, `MarketFactory`, `FeeTiers`, `OrryPriceOracle`; tests and proofs of section 4; measure v4 stock/USDG pools for R1b |
| M-2 services | `services/**` except `packages/web` | indexer, API, keeper, SDK for section 5; check the asset list terms |
| M-3 web | `services/packages/web` | section 5 pages |
| orchestrator | this spec, `contracts/src/markets/interfaces/**`, ABIs in `services/packages/shared/src/markets-abi.ts`, the deploy script, integration | |

Open before code: the ETH/USD and stock feed addresses on 4663 (M-1 reads them on chain); whether stock/USDG v4 pools
with depth exist (R1b).

## 7. Decisions after lane M-1's measurements (2026-11-08, delegated)

Measured by lane M-1 on 4663 (block about 109.15 M, relayed): ETH/USD proxy `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`
(8 decimals); 33 equity feeds, 24/5, 24 h heartbeat, 0.5% (for example TSLA `0x4A1166a659A55625345e9515b32adECea5547C38`,
AAPL `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0`); 9,734 stock/USDG v4 pools initialized, 1,532 with liquidity, 52
with at least 1,000 USDG of depth per 1% move (SPY fee 500 about 448 k; AAPL, TSLA, MSFT, NVDA 10 k to 35 k); issuer
block, pause and USDG freeze apply to zero-amount transfers too; the role holders are EOAs.

| # | Decision |
| :-- | :--- |
| D-R1-1 | Markets emit `Burned(5, amount)` and `Burned(6, amount)`: `ISealedBatchMarket` now extends `IOrryBurnEvents` |
| D-R1-2 | `clear` reverts `StalePrice` while the asset reports `oraclePaused`, or when its `uiMultiplier` changed after the round's `updatedAt`; amounts and the feed price are related through the multiplier the token reports at clearing (M-1 confirms the token's convention on chain and documents it) |
| D-R1-3 | DP-1 reads: `clear`, `reveal`, `revealFor` and `commit` leave the market's asset and USDG balances exactly as they found them (a donation stays where it is and blocks nothing) |
| D-R1-4 | Before any pull, `clear` probes each order with a zero-amount transfer; a paused asset drops every order and the batch clears with no fill; a blocked trader drops only that trader's order. This replaces "expires" for those cases; a feed that cannot price the batch still leads to expiry |
| D-R1-5 | R1b is in: a market may have one v4 stock/USDG pool, fixed at creation (`IMarketFactory.create(asset, priceFeed, remainderPool)`). In `clear`, after crossing, the unmatched part of Swap-mode orders trades against that pool in one `unlock`, with a price limit at each order's limit and at the clearing price ± `maxDeviationBps` (50, guess), whichever is tighter; what does not fill is refunded. A permissionless `clear` bundled with a pool push can move the fill at most `maxDeviationBps` from the oracle price (DP-11) |

- DP-11 A remainder fill is at a price within both the order's limit and `maxDeviationBps` of the clearing price; the
  market holds nothing after it (DP-1); the pool leg pays no fee to Orrery beyond `feeBps`.
