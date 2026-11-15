# ORRY services (lane C)

Implements `docs/ORRY-BUILD-SPEC.md` section 5 in `@orrery/server`, `@orrery/shared` and `@orrery/sdk`.
TypeScript types of every response: `packages/shared/src/orry.ts` (browser-safe, imported by the web app).

## Routes

All under `/v1/orry/`, JSON. Token amounts are decimal strings in base units with `decimals: 18` (ETH and ORRY).
Times named `...At`, `leavingAt` and `time` are unix seconds (numbers); `updatedAt` is ISO 8601. Errors are
`{ error }` with a 4xx or 5xx status, like every other route. Public reads are limited per IP
(`ORRERY_PUBLIC_RATE_PER_MINUTE`) and cached for `ORRERY_ORRY_CACHE_MS`.

| Route | Feature | Source of every number |
| :--- | :--- | :--- |
| `GET earn` | earn | one row per hub in the hook's order (`pairCount`, `pairAt`): its vault from the factory, the vault's `positionAmounts` and `totalShares`, its `FeesHarvested` sums (7 days, all time), the hub's slot0 as `orryPerQuote` |
| `GET stake` | stake | `OrryStaking.totalEarning`; `RewardsNotified` sums; stakers = addresses with earning stake > 0 (events) |
| `GET accounts/:address` | claim | `OrryLens.claimables` (one `earn` entry per vault), `agentClaimables` for the positions the indexer saw; claimed totals per asset from `FeesClaimed` (the vault's quote and ORRY) and `RewardsClaimed` (ETH and ORRY); every figure at one block (see below) |
| `GET leaderboard?kind=stakers\|earners&limit=1..100` | leaderboard | stakers: earning stake (plain + agent) from events; earners: claimed + pending per asset at one block per account (re-read when an event touches it, else at most every `ORRERY_ORRY_SNAPSHOT_SECONDS`), ranked by `valueOrry` at the hubs' current prices |
| `GET burns?limit=1..200` | burn | `Burned(source, amount)` from router (1), treasury (2, 3), buyback (4); any other emitter or source is ignored |
| `POST quotes/credits {buyer, packs}` | checkout | signed `CreditsQuote` |
| `POST quotes/verification {payer, agentId}` | checkout | signed `VerificationQuote` |
| `POST quotes/checks {buyer, checks}` | payg-checks and checkout | signed `CreditsQuote` whose `packs` is the number of checks (pay as you go, R-44 item 13) |

Details beyond the frozen shapes:

- Earned all time (accounts, earners board) is claimed plus pending measured at one block: the block the indexer's tables
  are complete through (its cursor, or its high-water block while a re-index has moved the cursor back; table
  `orry_height`). So it never falls between two responses across claims, harvests, notifies or a re-index. The account's
  lens fields are read at that block too, so they trail the head by about `ORRERY_CONFIRMATIONS` blocks. Reading state
  at that block needs the node to keep it: while the indexer is further behind than the node keeps recent state (a full
  node keeps a limited window; not measured on the 4663 provider), the account route answers 503 until it catches up.
- Multi-pair (R-35 to R-38): one ORRY/X hub per quote token, native ETH as `0x00…00`. The hook's registry and the
  factory's vault list only grow; services read new entries once. `earnedAllTime` and earners rows are per-asset lists
  in a fixed order: ORRY, ETH, then the other quotes in the hook's order. Quote prices for checkout come from the
  ORRY/USDG hub when it has a price, else the ETH hub times `ORRERY_ORRY_USD_POOL_ID`.
- Every response carries `decimals: 18`; each leaderboard row carries it too (the response stays an array).
- `earn.hubPrice.orryPerEth` is ORRY base units for 1 ETH, or `null` until the hub has a price.
- `earn.totalShares` is liquidity units, not a token amount.
- Leaderboard addresses are `0x1234…abcd` (lower case, U+2026). The full address is never in the body. Earners rank
  by ETH value at the hub's current price (`eth + orry / orryPerEth`), then address; without a price, by ETH then ORRY.
- `stakers` rows have `stake`; `earners` rows have `earned: {eth, orry}`.
- `burns.items` are newest first: `{ tx, block, time, source, amount }`.
- Quotes also return `signer`, `domain` (treasury EIP-712 domain), `usdValue` (USDG base units, `usdDecimals: 6`),
  `price: { orryPerUsd, basis: "spot"|"median", samples, windowSeconds: 1800 }`, and for credits `credits` (checks that
  will be granted). The buyer approves the treasury for `orryAmount` on ORRY, then sends
  `orryCalls.burnForCredits(quote)` (or `orryCalls.verifyWithOrry(quote, expectedOwner)`) from the quoted address.
  `verifyQuote` in the SDK checks a quote before sending.
- Checks bought with ORRY are granted to the buyer's address once `CreditsPaid` is `ORRERY_CONFIRMATIONS` deep. A
  buyer without an API key gets one with the existing signed rotation: `GET /v1/keys/nonce` then `POST /v1/keys/rotate`.
  `GET /v1/credits` then shows the balance (its purchase history lists x402 purchases only).
- Pay as you go (`quotes/checks`): `checks` × `ORRERY_CREDITS_PER_CHECK` credits, priced at the ORRY pack rate (625
  credits per 1 USD, rounded up: one check at 2 credits is 0.0032 USD of ORRY). The response adds `checks` and `credits`;
  `usdValue` is that price. The buyer sends it with the same `orryCalls.burnForCredits(quote)` (burn source 2). The quote
  row stores the credits (migration 014), and the indexer grants exactly those for a `checks` quote, never the pack rate of
  its `packs`. The route opens only while both `payg-checks` and `checkout` are open; `ORRERY_ORRY_MAX_CHECKS` (default
  1,000) caps one quote.
- `503` on a quote means no price yet ("ORRY prices are still being sampled. Try again in a few minutes.", or the hub
  is not registered). Quotes are limited to `ORRERY_QUOTE_RATE_PER_MINUTE` per IP.

## Release switch (runtime)

Table `releases (feature, opens_at, updated_at, updated_by)` plus `releases_audit` (migration 011). `opens_at` null holds a
feature, and a feature with no row is held. Every request decides by the server clock against the rows, cached for
`ORRERY_RELEASES_CACHE_MS` (default 2000), so a time that passes opens a feature and a row set back to null holds it again,
with no restart. A held feature's routes answer the same 404 as an unknown route.

- Names: `RELEASE_FEATURES` in `packages/shared/src/orry.ts`: the route features earn, stake, claim, burn, leaderboard,
  checkout, then agent-stake and the update items (stocks, swap, darkpool, payg-checks, facilitator, chat, achievements and the rest of
  `docs/ORRY-UTILITIES-PLAN.md`), which only the web reads.
- `GET /v1/releases` (public, never held): `{ serverTime, releases: { feature: iso | null } }`.
- Never held: `GET /v1/orry/accounts/:address` (balances, positions, claimables: what Earn withdraw, unstake, withdraw and
  claim act on), `GET /v1/credits`, `GET /v1/releases`.
- The only writer is `pnpm exec tsx scripts/releases.ts list | set <feature> <ISO time with zone|now|null>`: it writes the
  row and an audit row (who: `ORRERY_RELEASE_BY`, else OS user and host) in one transaction. There is no HTTP write route.
- `ORRERY_ORRY_FEATURES` only seeds an empty table: the listed names open at the seed time, every other known name is
  held; not set, the chain default (all held on 4663, all open elsewhere). Unknown names stop the process at start.
- `stake` open also switches signed checks to version 2, per request.
- A quote key given is always loaded, so checkout can open at runtime; it is required when the seed opens checkout, and
  quotes answer 503 while checkout is open without one.

## Check result v2

While `stake` is open, signed checks use domain version `"2"` and add `stakeActive`, `stakeLeaving`, `stakeLeavingAt`,
`stakeLockedUntil`, `stakedBy` from `OrryStaking.agentStake(agentId)` (zeros for agentId 0). SDK `verifyCheck` accepts both versions; it
takes only the version from the response and refuses a body whose fields do not match it.

## Configuration

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `ORRERY_ORRY_TOKEN` | none | Turns ORRY on; then the next eight are required |
| `ORRERY_ORRY_HOOK`, `_EARN_FACTORY`, `_STAKING`, `_ROUTER`, `_BUYBACK`, `_LENS` | none | **Placeholders: real deployment addresses** (`_EARN_FACTORY` is `IEarnVaultFactory`; the vaults come from it) |
| `ORRERY_ORRY_TREASURY` | `ORRERY_TREASURY` | `OrreryTreasury`, also the x402 `payTo` |
| `ORRERY_ORRY_CLAIM_ALL` | none | Optional |
| `ORRERY_POOL_MANAGER` | `0x8366…0951` on 4663 | Required on other chains |
| `ORRERY_ORRY_USD_POOL_ID` | none | v4 poolId of a native ETH / USDG pool: the fallback USD path while the ORRY/USDG hub has no price; optional |
| `ORRERY_ORRY_START_BLOCK` | `ORRERY_INDEXER_START_BLOCK`, else 0 | Set to the deployment block |
| `ORRERY_ORRY_FEATURES` | see above | Seed of an empty `releases` table only |
| `ORRERY_RELEASES_CACHE_MS` | 2000 | How long the API keeps the release rows |
| `ORRERY_QUOTE_SIGNER_KEY[_FILE]` | anvil key 5 on 31337 only | Required while checkout is open; must differ from the check signer, relayer and attester keys. File in `~/.secrets/orrery/<network>-quote-signer.json`, made only on the owner's word |
| `ORRERY_QUOTE_TTL_SECONDS` | 120 | 30 to 120 |
| `ORRERY_ORRY_VERIFICATION_USD` | 4000000 | USDG base units (R-9) |
| `ORRERY_ORRY_MAX_PACKS` | 100 | Per quote |
| `ORRERY_ORRY_MAX_CHECKS` | 1000 | Checks per pay-as-you-go quote |
| `ORRERY_QUOTE_RATE_PER_MINUTE` | 10 | Per IP |
| `ORRERY_ORRY_SAMPLE_SECONDS`, `ORRERY_ORRY_MIN_SAMPLES` | 60, 10 | Pool samples for the 30 minute median |
| `ORRERY_ORRY_SNAPSHOT_SECONDS`, `ORRERY_ORRY_SNAPSHOT_MAX` | 600, 500 | Pending reward reads for the earners board |
| `ORRERY_ORRY_CACHE_MS` | 10000 | Public read cache |
| `ORRERY_KEEPER_KEY[_FILE]` | anvil key 6 on 31337 only | Keeper process only; `~/.secrets/orrery/<network>-keeper.json` |
| `ORRERY_KEEPER_EVERY_MS` | 3600000 | |

## Processes

- `pnpm --filter @orrery/server indexer`: v1 indexer plus, when ORRY is configured, the ORRY indexer, the pool
  sampler and the pending-reward snapshot. Health (`ORRERY_INDEXER_HEALTH_PORT`) reports both cursors; the ORRY one is
  healthy within `ORRERY_INDEXER_MAX_LAG + ORRERY_CONFIRMATIONS` blocks of the head.
- `pnpm --filter @orrery/server keeper` (`-- --once`, `-- --dry-run`): `collect` (only while `pendingProtocolFee` of
  some currency is above 0), `harvest` on every vault, `executeSlice`, `distribute`, `burnEth`, then `buyWithQuote` for
  every non-ETH hub quote with `maxQuoteIn > 0`; each simulated first and sent only when it would do something, with
  `gasWithHeadroom` (estimate × 1.2 + 60,000).

## RPC cost on 4663 (101 ms blocks, workspace rule 7)

Per indexer step (10,000 blocks): two `eth_getLogs` (ORRY contracts; PoolManager `Swap` with the hub poolId as topic)
plus one block read per distinct block with logs when the node does not put `blockTimestamp` on logs. Idle: about 86
steps a day, so about 172 log calls. Sampler: two `eth_call` per minute (2,880 a day). Snapshot: one `eth_call` per
earning account per 10 minutes (500 accounts: 72,000 a day; lower `ORRERY_ORRY_SNAPSHOT_SECONDS` raises it). Use a
request-priced endpoint; never the relay key.

## Tests

`test/orry.unit.test.ts` and `test/orry.integration.test.ts` run against stand-ins of the frozen ABIs
(`test/contracts/OrryStandIns.sol`, compiled by `node scripts/gen-standins.mjs` into `test/generated/standins.ts`).
Ports: `ORRERY_TEST_ANVIL_PORT`, `ORRERY_TEST_PG_PORT`, `ORRERY_TEST_PG_NAME` (defaults 8546, 55432,
`orrery-pg-test`).

`test/orry.real.test.ts` runs the same services against the real contracts (lanes A and B), deployed by
`test/orry-system.ts` on its own anvil (`ORRERY_TEST_ORRY_ANVIL_PORT`, default anvil port + 1): the live 4663
PoolManager runtime set at its address, the hook at a flag address by a mined CREATE2 salt, router and buyback at
predicted addresses, real v1. It covers the indexer over real events, every route against chain reads, quotes the real
treasury accepts (`burnForCredits`, `verifyWithOrry` with the real `OrreryAttestor`), check v2 from the real staking, and
the keeper (all five jobs sent; `NothingToBuy`, `NothingToDistribute`, `PriceMovedInBlock`, `TooSoon` skips). Contract
bytecode: `node scripts/gen-abi.mjs` after `forge build` writes `test/generated/orry.ts`.

## Local stack for the web

`pnpm exec tsx scripts/dev-orry-stack.ts` starts anvil (:18656) and Postgres (:55472, Docker), deploys the same system,
sets the coin, seeds activity (Earn deposits, stakes, an agent stake with a lock, hub swaps, a keeper pass, a claim, a
credits burn through the API's quote), runs the API (:18787) and both indexers, and prints the web env (also written to
`.local/orry-stack.web.env`). Ctrl-C stops all of it. Ports: `ORRY_STACK_ANVIL_PORT`, `ORRY_STACK_PG_PORT`,
`ORRY_STACK_API_PORT`.
