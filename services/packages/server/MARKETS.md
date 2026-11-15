# Wave R1 market services (lane M-2)

Implements `docs/ORRY-R1-SPEC.md` section 5 in `@orrery/server`, `@orrery/shared` and `@orrery/sdk`. JSON shapes:
`packages/shared/src/markets.ts` (browser-safe). Frozen contract ABIs: `packages/shared/src/markets-abi.ts`.

## Routes

All under `/v1/markets`, JSON, `{ error }` on failure, limited per IP (`ORRERY_PUBLIC_RATE_PER_MINUTE`) and cached for
`ORRERY_MARKETS_CACHE_MS`. Open while any of the features `stocks`, `swap`, `darkpool` is open; otherwise every route
answers the 404 of an unknown route.

| Route | Source |
| :--- | :--- |
| `GET /v1/markets` | markets the factory created (indexed), each with its constructor values, the latest answer of its Chainlink feed (Multicall3 where the chain has it), and the phase computed from the market's own `revealEnd(0)` and `revealEnd(1)` at the latest block time |
| `GET /v1/markets/:market` | the same for one market |
| `GET /v1/markets/fee-tiers?account=0x…` | each FeeTiers contract the markets use (L2): tiers with `minStakeUsd` (USDG base units) and `discountBps`, `active` = the ORRY price oracle is ready (every discount is 0 otherwise), and with `account` that address's `stakeUsd` and `discountBps` now |
| `GET /v1/markets/:market/batches?limit=1..100&before=<batch>` | batches with at least one commit, newest first: windows, status, counts, commit fees burned, clearing result |
| `GET /v1/markets/:market/batches/:batch` | one batch, plus its revealed orders once the reveal window has ended (accounts masked `0x1234…abcd`) |
| `GET /v1/markets/accounts/:address/orders?limit=1..200&before=<block>` | one wallet's commitments, newest first, with status, terms once revealed, and fill |
| `POST /v1/markets/relay/reveals` | opt-in reveal relay: `{market, batch, account, order, salt}`; queued only when the order and salt hash to the account's commitment on chain and the batch's reveal window has not closed; 202 with the relay status, never the salt; 30 per minute per IP |
| `GET /v1/markets/relay/reveals/:market/:batch/:account` | the relay status: queued, sent (`tx`), revealed (another transaction revealed it first), failed (`reason`) |

`/v1/orry/burns` also counts `Burned` sources 5 (commit fee) and 6 (fee paid in ORRY) from markets the factory
created; a market the factory never created is never counted.

Each market row carries its remainder pool (`remainderPool.poolId` from `MarketCreated`, `listed` from
`remainderPool()`), `params.maxDeviationBps` and `params.orryFeeDiscountBps` (L3, from `orryFeeDiscountBps()`); a cleared batch's result carries `assetViaPool` and `usdgViaPool`,
read from `result(batch)` at the clearing block (R1b, spec section 7).

Batch and order statuses are measured at the indexer's height (the time of the block its tables are complete through),
so an order never reads "missed" while its reveal is still reaching the confirmation depth. Countdowns use the latest
block time (`chainTime`, `phase.endsAt`).

Stock list: on-chain only. Markets from `MarketFactory`, name, symbol and decimals from the token, price from the feed.
The Robinhood asset list API (`api.robinhood.com/rhj/assets`) is not used: the Robinhood Chain Terms of Service limit
use of the services to testing and development (2.4) and bar incorporating Robinhood Materials into a third-party app
(5.2); no document grants product use (checked 2026-11-08). No logos.

## Release switch

`ORRERY_ORRY_FEATURES` gains `stocks`, `swap`, `darkpool` (the relay routes open with `swap` or `darkpool`). Not set: held on 4663, open elsewhere. The market features
need `ORRERY_MARKET_FACTORY`; the ORRY features need the ORRY addresses; each group opens only with its own
contracts configured.

## Configuration

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `ORRERY_MARKET_FACTORY` | none | Turns markets on. **Placeholder: the real deployment address** |
| `ORRERY_MARKETS_START_BLOCK` | `ORRERY_INDEXER_START_BLOCK`, else 0 | Set to the factory's deployment block |
| `ORRERY_MULTICALL3` | `0xcA11…CA11` on 4663, none elsewhere | `off` reads each feed on its own |
| `ORRERY_MARKETS_CACHE_MS` | 10000 | Public read cache |
| `ORRERY_MARKET_KEEPER_KEY[_FILE]` | anvil key 7 on 31337 only | Market keeper only; `~/.secrets/orrery/<network>-market-keeper.json`, made only on the owner's word |
| `ORRERY_MARKET_KEEPER_LOOKBACK` | 12 | Batches looked back over at start |
| `ORRERY_MARKET_KEEPER_POLL_MS` | 250 | Head polling once a window has ended (keeper and relay) |
| `ORRERY_RELAY_KEY[_FILE]` | anvil key 8 on 31337 only | Reveal relay process only; its own role, not the x402 `ORRERY_RELAYER_KEY`; `~/.secrets/orrery/<network>-reveal-relay.json`, made only on the owner's word |

## Processes

- `pnpm --filter @orrery/server indexer`: also runs the markets indexer when the factory is set; its health
  (`markets` in the health JSON) is lag against the head, like the others.
- `pnpm --filter @orrery/server market-keeper` (`-- --once`, `-- --dry-run`): sleeps until the next reveal window ends
  (chain time), then polls the head and sends `clear(batch, roundHint)` for every batch with at least one revealed order
  once its window is over. `roundHint` is the feed's newest round with `updatedAt <= revealEnd`, walked back within the
  proxy's phase. Every clear is simulated first; `StalePrice`, `BadRound`, `AlreadyCleared`, `Expired` end the attempt
  for that batch (it expires, nothing moved), `WrongPhase` retries at the next block.

- `pnpm --filter @orrery/server market-relay` (`-- --once`, `-- --dry-run`): sends `revealFor(account, order, salt)` for
  every queued order once its batch's reveal window opens, simulated first. An order the indexer saw revealed by another
  transaction is marked `revealed`; `BadReveal`, `BelowMinimum`, `ZeroAmount` fail it; any other revert retries until
  the window closes, then it fails. Gas is bounded by commitments: at most one reveal per committed order.

## Reveal relay

Opt-in (spec section 5): the trader hands the order and salt to Orrery's server, which then knows the order before the
batch closes. The API only checks and queues; the relay process holds the key. The salt is stored until the reveal (it is
public once revealed) and no route returns it. `orderCommitment`, `newSalt`, `marketCalls.revealFor` and
`MarketsApi.relayReveal` / `relayStatus` in the SDK.

## RPC cost on 4663 (101 ms blocks, workspace rule 7)

Indexer: per step of up to 10,000 blocks, one `eth_getLogs` for the factory and one for all markets, a contract read set
per new market, and one block read per distinct block with logs when the node does not put `blockTimestamp` on logs.
API: one Multicall3 `eth_call` for every feed per cache period, one block read per new indexer height. Keeper: one block
read per pass (every 30 s idle, every 250 ms in the second after a reveal window ends), two reads per ended batch, a few
feed reads per batch with orders. Use a request-priced endpoint; never the relay key.

## Tests

`test/markets.integration.test.ts` against stand-ins of the frozen ABIs (lane M-1's contracts are not merged): the SDK
commitment against Solidity's `abi.encode`, the indexer and every route, burns 5 and 6, the release switch, `roundHintFor`
the keeper (sent with the hint, skipped on empty, cleared, `StalePrice`, retried on `WrongPhase`, dry run), and the relay
(queue checks, revealFor from the relay key in the reveal window, wallet revealed first, final revert, window closed). Own anvil
(`ORRERY_TEST_MARKETS_ANVIL_PORT`, default anvil port + 2). Against the real bytecode: after M-1 lands.
