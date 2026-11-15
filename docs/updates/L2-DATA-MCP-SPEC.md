# L2 spec: Orrery Data and the MCP server

Date: 2026-11-11 (UTC). Lane L2 of the 2026-11-11 update run (board `~/.claude/orchestrator/PAPAN-2026-11-11-orrery-updates.md`).
Owner decisions implemented: R-49 to R-52 (`docs/ORRY-DATA-PLAN.md`), R-60 (`docs/ORRY-BUSINESS-MODEL.md`), R-63 to R-65,
and `docs/UPDATE-CANDIDATES.md` section 3.6 (MCP server). Internal engineering document: factual, not product copy.
Nothing here is deployed; no key was made; no transaction was sent.

## 0. Facts measured for this spec (2026-11-11, chain 4663, `https://rpc-robinhood.blockmachine.io`)

| Fact | Value | How | Status |
| :--- | :--- | :--- | :--- |
| Head, gas price | block 111,496,835; 20,004,000 wei (0.020004 gwei) | `cast block-number`, `cast gas-price` | verified |
| ETH/USD feed `0x78F3…D3A9` | 2,069.88 USD (answer 206,987,890,662, 8 decimals), updatedAt 1,794,376,580 | `latestRoundData()` | verified |
| One x402 settlement | about 0.004 USD (100,000 gas assumed × 0.020004 gwei × 2,069.88 USD); the test measures the real gas (section 9) | derived | estimate |
| Stock token (TSLA `0x322F…3b2d`) | beacon proxy; beacon = issuer registry `0xe10b…1b00`; implementation `0xb354…5aE2`; events `UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)`, `OraclePaused()`, `OracleUnpaused()`, `Paused()`, `Unpaused()`, `TransferWithScaledUI(...)` | EIP-1967 beacon slot, `implementation()`, Sourcify exact match | verified |
| Issuer registry `0xe10b…1b00` | events `Blocked(address indexed account)`, `Unblocked(address indexed account)`, `Paused()`, `Unpaused()` | Sourcify exact match | verified |
| Pons V2 factory `0x7eD5…EC7e` | events `TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)`, `PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)`; view `getLaunchedToken(token)` | Sourcify exact match (139 ABI entries) | verified |
| ORRY launch record | curve `0xe8b0…0420`, pair native ETH, threshold 4.2 ETH, phase 0; curve holds 0.0394 ETH and 978,486,479.87 ORRY | `getLaunchedToken`, `cast balance` | verified |
| Pons curve ABI | not on Sourcify; curve progress is taken as the quote the curve holds over the graduation threshold | derived | derived |
| Hookless TSLA/USDG pools | fee 500 pool initialised with no in-range liquidity; deep stock pools (lane M-1: 52 with ≥ 1,000 USDG per 1% move) carry hooks, so their ids need `Initialize` logs | computed pool ids + `extsload` | verified (partial) |
| Full-range `eth_getLogs` | refused by every keyless endpoint reachable here (blockmachine: last 5,000 blocks; publicnode: archive needs a token); the official RPC is DNS-sinkholed on this ISP | curl | verified |
| Burn sources in use | 1 router, 2 packs, 3 verification, 4 buyback ETH half, 5 and 6 SealedBatchMarket, 7 MerchantSplitter; L1 took 8 boost, 9 passes, 10 template market (message from rc-community, 2026-11-11) | grep of `contracts/src` | verified |

## 1. Decisions (lane, delegated unless marked owner)

| Id | Decision | Why |
| :-- | :--- | :--- |
| D-1 | `DataFeeSplitter` emits `Burned(11, amount)`. The data plan's `Burned(7)` is wrong against the code: 7 is the MerchantSplitter's x402 fee (`MerchantSplitter.sol:17`), 8 to 10 belong to L1 | burn page and indexer need one source per contract kind |
| D-2 | Official data is sold in packs of calls, not per on-chain payment. A pack is `ORRERY_DATA_PACK_CALLS` calls (1,000, guess) at `ORRERY_DATA_CALL_USD` each (1,000 base units = 0.001 USD, the plan's guess), so 1 USDG a pack. One x402 payment buys a pack; calls are spent with the address's Orrery API key (the same key as checks) | one settlement costs about 0.004 USD of gas, four times a 0.001 USD call; the public facilitator's own minimum is 0.01 USDG (`ORRERY_FACILITATOR_MIN_AMOUNT`) |
| D-3 | R-60 supersedes R-50's "ORRY only": a pack is paid in USDG at full price to `OrreryTreasury` (EIP-3009, settled by the API's relayer as credit packs are) or in ORRY at 20% off (`ORRERY_DATA_ORRY_DISCOUNT_BPS` 2000, owner number) through the existing `X402Permit2Proxy` to `DataFeeSplitter` | owner R-60 |
| D-4 | The ORRY amount is `orryForUsd(packUsd × (10,000 − 2,000) / 10,000)` at `quotePrice` (the lower ORRY price of the hub now and the 30 minute median of samples, as ORRY checkout); it is stored as a quote (`data_orry_quotes`, 120 s) and named in the requirement's `extra.quoteId`; settlement accepts only an unexpired, unused quote of exactly that amount | the price moves; a stored quote is the checkout pattern already reviewed |
| D-5 | Staker discount (plan section 3, "as everywhere"): the price stays fixed so x402 amounts stay fixed; the discount is paid as calls. Calls granted = `packCalls × 10,000 / (10,000 − d)`, `d` = `FeeTiers.discountBps(payer)` capped at 9,000, read at settlement | an x402 amount is set before the payer is known |
| D-6 | Third-party providers (R-51) are paid through a second `MerchantSplitterFactory` deployment with `feeBps = 100` (1%, its cap), the same audited code as R-57's 0.2% factory. USDG fees go to `OrreryTreasury`, ORRY fees are burned as `Burned(7)`; the indexer tells data fees from merchant fees by the splitter's factory | no new money contract; the 1% is enforced by the splitter, not by a route |
| D-7 | Provider payments settle at `/v1/data/x402/{supported,verify,settle}`, which first requires `payTo == registry.splitterOf(provider)` for a provider listed and active, then calls `verifyPublic` / `settlePublic` from `facilitator-public.ts` unchanged with that factory. The public `/v1/x402/*` keeps its 0.2% factory only | the wave 3 facilitator is read-only for this lane |
| D-8 | `DataProviderRegistry` (new contract): a provider lists itself (`msg.sender`) with an https endpoint, a name, a description and a declared price per call; listing and updating need `FeeTiers.stakeUsd(provider) ≥ minStakeUsd` (constructor, default 100 USD = the merchant badge level `ORRERY_MERCHANT_BADGE_USD`, guess); `isActive` reads the stake live, so a provider that unstakes drops out without anyone acting. The registry creates the provider's splitter in the 1% factory on first listing. No owner, no setter | open listing with stake (R-51) |
| D-9 | `DataFeeSplitter` (new contract): `split()` by anyone burns `floor(70%)` of the ORRY received since the last split and books the rest for the Reward Pool; while the pool is unset the 30% waits in the splitter (`poolOwed`); the pool is proposed by the treasury owner (read live from `OrreryTreasury.owner()`), executable after 48 h, set once; the proposal checks `pool.orry() == orry`. Funding uses L1's `IRewardPool.fund(orry, amount)` (commit d76cb86 on L1's branch: pull with `transferFrom`, balance-delta checked) | R-50, DA-3; the 48 h set-once pattern is `OrryBuyback`'s cashback sink |
| D-10 | Data responses are EIP-712 signed by the data-signer key (R-52): domain `{name: "Orrery Data", version: "1", chainId}` (no verifying contract), type `DataResponse(string dataset,bytes32 queryHash,bytes32 recordsHash,uint64 asOfBlock,uint64 issuedAt)`. `recordsHash = keccak256(utf8(JSON.stringify(records)))`, `queryHash` likewise over the normalised query. Records hold only strings, safe integers, booleans and null (every amount is a decimal string), so any client that keeps the served JSON reproduces the hash. Key `ORRERY_DATA_SIGNER_KEY[_FILE]`; the config refuses a value equal to the check signer, relayer, attester or quote signer key; on 31337 it is the anvil mnemonic's index 11 (index 10 is the test harness's session signer) | R-52 |
| D-11 | DA-1 refined: an event record names `block`, `tx` and `logIndex` of the log it describes; a snapshot record names the `block` its state was read at; an aggregate names `fromBlock` and `toBlock`; a prober record (a Orrery system record) names its probe time and, when attested, the attestation transaction. The plan's sentence covered event records only | snapshots have no transaction |
| D-12 | Chainlink: only derived feed state is served (`live`, `paused` from the token's `oraclePaused()`, `stale` when the round is older than the 24 h heartbeat plus 1 h), its `updatedAt`, and the pool's spread to the feed in basis points. The raw answer is never in a record (plan section 1) | Chainlink terms not checked |
| D-13 | Stock pools for dataset 4 come from configuration (`ORRERY_DATA_STOCKS`, `SYMBOL:token:feed[:poolId]`, defaults on 4663: TSLA, AAPL, SPY with their feeds and no pool) plus the R1 markets table when R1 is deployed; a stock without a known pool is served without a liquidity record. Discovery of hooked pools needs `Initialize` logs from an archive endpoint (section 0); an ops step, not a guess | no number without a source (workspace rule 1) |
| D-14 | Release names appended: `data` (official datasets, packs, the data page), `data-providers` (registry, provider settlement, provider page), `mcp` (the MCP section of the site and its listing metadata). ORRY payment for data needs `data` and the existing `orry-x402` | runtime switch |
| D-15 | Gas roles: the data keeper (`split()` and provider `forward`) uses `ORRERY_DATA_KEEPER_KEY[_FILE]` (anvil key 9 on 31337), its own role so its nonces never race the ORRY keeper or the relayer | one key per role |
| D-16 | MCP: one stdio server `@orrery/mcp` on the official `@modelcontextprotocol/sdk` (as the reference packages in the workspace). Counterparty tools use `ORRERY_API_KEY`; agent tools use the session signer's key file `ORRERY_AGENT_KEY_FILE`, which must be mode 600 (refused otherwise); a payment above `ORRERY_MCP_MAX_PAYMENT_USD` (1 USD, guess) needs `confirm: true`; every tool description states its cost; results carry remaining credits or calls and a notice below 20% of a pack. Registry metadata (`server.json`, `smithery.yaml`) is written, not published; the package stays `private` | section 3.6 |

## 2. Contracts (`contracts/src/data/`)

### 2.1 `DataFeeSplitter` implements `IDataFeeSplitter`

- Constructor: `orry`, `treasury` (`OrreryTreasury`, for `owner()`). Constants: `BURN_BPS = 7000`, `BURN_SOURCE = 11`,
  `POOL_DELAY = 48 hours`. Zero addresses revert `ZeroAddress`.
- State: `pool` (zero until set), `poolOwed` (ORRY booked for the pool, not yet sent), pending proposal `(address, uint64)`.
- `split()` (anyone, non-reentrant): `fresh = balanceOf(this) − poolOwed`; `burnAmount = fresh × 7000 / 10000` (rounded
  down), `poolAmount = fresh − burnAmount`; `burn(burnAmount)` and checks the balance fell by exactly `burnAmount`
  (`InexactBurn`); `poolOwed += poolAmount`; if `pool != 0` and `poolOwed > 0`: `approve(pool, poolOwed)`,
  `IRewardPool(pool).fund(orry, poolOwed)`, checks the balance fell by exactly that amount, `poolOwed = 0`. Emits
  `Burned(11, burnAmount)` when non-zero, `Split(fresh, burnAmount, poolAmount)`, `PoolFunded(pool, amount)`. Reverts
  `NothingToSplit` when `fresh == 0` and nothing is owed to a set pool.
- `previewSplit()` view: `(fresh, burnAmount, poolAmount, poolOwedAfter)`.
- `proposePool(pool)` (treasury owner): reverts `NotTreasuryOwner`, `PoolAlreadySet`, `ZeroAddress`, `WrongPool` when
  `pool.orry() != orry`; a new proposal replaces a pending one; emits `PoolProposed(pool, executableAt)`.
- `executePool()` (treasury owner): after `executableAt`; sets `pool` for good; emits `PoolSet(pool)`. `NoPoolProposal`,
  `PoolNotReady(executableAt)`.
- No other function moves ORRY. Other tokens sent here stay here (nothing sends them; documented).

### 2.2 `DataProviderRegistry` implements `IDataProviderRegistry`

- Constructor: `stakeValue` (`FeeTiers`, `stakeUsd(address)`), `providerFactory` (`MerchantSplitterFactory` at 1%),
  `minStakeUsd` (default 100,000,000 = 100 USD, guess). `FEE_BPS` of the factory must be 100 (`WrongFactory`).
- `list(endpoint, name, description, priceUsdg)`: `msg.sender` is the provider; not listed yet (`AlreadyListed`);
  `stakeUsd ≥ minStakeUsd` (`StakeTooLow(have, need)`); `_check` inputs: endpoint starts with `https://`, 12 to 200 bytes,
  no space or control byte (`BadEndpoint`); name 2 to 40 bytes (`BadName`); description at most 280 bytes
  (`BadDescription`); price above 0 (`BadPrice`). Creates the splitter when the factory has none. Stores
  `{listedAt, updatedAt, contentHash, priceUsdg}`; emits `Listed(provider, splitter, endpoint, name, description, priceUsdg)`.
- `update(...)`: listed only (`NotListed`), same checks including the stake; emits `Updated(...)`.
- `unlist()`: listed only; deletes; emits `Unlisted(provider)`. Always possible (no stake check).
- Views: `listing(provider)`, `isListed`, `isActive` (listed and stake now at least the minimum; a reverting stake read
  counts as 0), `splitterOf(provider)` (the factory's), `providerCount` (listed now).
- No owner, no setter, no pause.

## 3. Invariants (each mapped to a test in section 8)

Accounting (splitter)
- DS-1 Every `split()` burns exactly `floor(fresh × 7000 / 10000)` and books `fresh − burn` for the pool (DA-3).
- DS-2 Conservation: ORRY received = burned + funded to the pool + `poolOwed` + unsplit balance, at all times.
- DS-3 `balanceOf(splitter) ≥ poolOwed` always; ORRY leaves only by `burn` in `split` or `fund` to the set pool.
- DS-4 While `pool == 0`, the ORRY booked for the pool never leaves the splitter.
- DS-5 Once set, the pool never changes; it is set only by the treasury owner of that moment, at least 48 h after the
  proposal it executes, and only for a contract whose `orry()` is ORRY.
- DS-6 `split()` is permissionless and cannot be blocked by anyone but the pool itself reverting (then nothing moves).
- DS-7 Every burn emits `Burned(11, amount)` with the exact amount burned; no other burn source is used.

Registry
- DR-1 A listing exists only for an address that called `list` itself, with stake at least the minimum at that moment.
- DR-2 `isActive(p)` is true exactly when `p` is listed and `stakeUsd(p) ≥ minStakeUsd` now.
- DR-3 A listed provider's payment address is `factory.splitterOf(provider)`, which exists after `list`, and pays only
  that provider (factory property R-57).
- DR-4 Only the provider changes or removes its listing; `unlist` always succeeds for a listed provider.
- DR-5 Inputs out of bounds revert with a named error; nothing stores a non-https endpoint.
- DR-6 `providerCount` equals the number of listed addresses.

Service (tests in `services/test/data*.test.ts`)
- DA-1 Every event record names a block, transaction and log index that hold that event; snapshots name their block (D-11).
- DA-2 Every data response is signed by the data signer, never by the check signer; config refuses shared keys.
- DA-4 No dataset reads a third-party API: the data modules call only the chain RPC and Postgres (static test).
- DA-5 A pack grants calls once per payment (idempotent per payer and nonce); a failed payment grants nothing.
- DA-6 An ORRY pack is accepted only for an unexpired, unused quote of exactly its amount, paid to `DataFeeSplitter`.
- DA-7 A data call is answered only when the key's account had a call left, and spends exactly one.
- DA-8 Provider settlement accepts only `payTo == registry.splitterOf(provider)` for an active provider.
- DA-9 Held releases answer 404 on every data route, as unknown routes do.

## 4. Money flow and rounding

| Path | Payer pays | Lands at | Then |
| :--- | :--- | :--- | :--- |
| Data pack in USDG | `packCalls × callUsd` (1 USDG) | `OrreryTreasury` (revenue, its own `sync` split) | calls granted to the payer |
| Data pack in ORRY | `orryForUsd(price × 0.8)`, rounded up | `DataFeeSplitter` | `split()`: 70% burned (floor), 30% to the Reward Pool (or held until set) |
| Third-party data call | the provider's own x402 price | the provider's splitter (1% factory) | `forward`: 1% less stake discount to the treasury (USDG) or burned (ORRY, source 7), rest to the provider |

## 5. Services

- `services/packages/shared/src/data.ts`: dataset ids, record and response types, EIP-712 domain and types,
  `dataRecordsHash`, `dataQueryHash`, `verifyDataResponse`, contract ABIs (generated between markers by
  `services/scripts/data-gen-abi.ts`).
- `services/packages/server/src/data-config.ts` (own config block, read by `config.ts`), `data-sign.ts`, `data-packs.ts`
  (402, settle, grants, quotes), `data-datasets.ts` (the seven datasets), `data-indexer.ts` (registry, splitter, stock,
  Pons events and payment blocks), `data-api.ts` (routes), `data-keeper.ts` (split and provider forward).
  Bins: `bin/data-indexer.ts`, `bin/data-keeper.ts`.
- Migrations: `020_data.sql` (accounts, grants, quotes), `021_data_index.sql` (events, providers, payment blocks, probe
  history with a trigger on `probes`, so the prober needs no change).
- Routes (all behind the release switch):
  `GET /v1/data` catalogue and prices; `GET /v1/data/signer`; `GET /v1/data/account` (key); `POST /v1/data/packs`
  (x402: buys a pack); `GET /v1/data/datasets/:id` (key, or x402 that buys a pack and answers);
  `GET /v1/data/providers`, `GET /v1/data/providers/:address`; `GET /v1/data/x402/supported`, `POST /v1/data/x402/verify`,
  `POST /v1/data/x402/settle`.

Datasets (D1)

| Id | Plan # | Records | Source |
| :--- | :-- | :--- | :--- |
| `agents` | 1 | ERC-8004 registrations, verifications, attestations, policy changes, queued increases (events); probe history | chain (`chain_events`), Orrery prober (`data_probe_history`) |
| `agent-economy` | 2 | settled x402 payments with merchant, payer, asset, amount, tx and block; `view=daily` volume per day; `view=merchants` top merchants | facilitator settlements |
| `stock-actions` | 3 | multiplier changes, token and oracle pauses, issuer block and unblock (events); `view=state` per stock | chain |
| `stock-liquidity` | 4 | per configured pool: price, in-range liquidity, USDG depth for a 1% move, spread to the feed (bps) | chain |
| `pons-launches` | 5 | launches and graduations (events); `view=curves` quote held over threshold for recent launches | chain |
| `orry-economy` | 6 | burns by source, fees collected, stake totals, hub price samples, leaderboard (masked) | chain + ORRY indexer |
| `chain-health` | 7 | head, ms per block over the last 1,000 blocks, base fee, each indexer's lag | chain + Orrery indexers |

## 6. Web (`services/packages/web`, existing design system "Current Limit")

- `/data`: what Orrery Data is, the seven datasets with live record counts, pack price in USDG and ORRY (live quote),
  buy a pack with a wallet (x402 through the browser), a sample signed response with its verification, MCP section
  (release `mcp`).
- `/data/providers`: active providers (stake, price, endpoint, 30 day volume), list or update your endpoint (wallet
  transaction to the registry), stake requirement in USD.
- Both behind the release switch; the nav entry appears only when `data` is open.

## 7. Not in this lane

D2 datasets 8 and 9 (with R1 and C1 data in production); a hosted MCP endpoint; publishing to npm or MCP registries;
the stock pool discovery run on mainnet (needs an archive RPC); any deploy.

## 8. Test plan

| Layer | File | Covers |
| :--- | :--- | :--- |
| Unit | `contracts/test/data/DataFeeSplitter.t.sol` | DS-1..DS-7, every named revert, events |
| Unit | `contracts/test/data/DataProviderRegistry.t.sol` | DR-1..DR-6, every named revert, splitter creation |
| Invariant | `contracts/test/data/DataInvariants.t.sol` + handler | DS-2, DS-3, DS-4, DS-5, DR-2, DR-6 under random actions, deterministic deep run |
| Mutation | `contracts/mutate_data.py` | every guard and rounding line above |
| Fork 4663 | `contracts/test/fork/data/DataFork.t.sol` | the registry with the real factory code path, stock and Pons event shapes and views on the live chain |
| Service | `services/test/data.integration.test.ts` | DA-1, DA-2, DA-4..DA-9 on anvil and Postgres (ports 18620+, 55441) |
| MCP | `services/packages/mcp/test/*.test.ts` | tool list, costs in descriptions, key file mode, payment cap, data purchase and query against the local stack |

## 9. Results (2026-11-11)

| Check | Command | Result |
| :--- | :--- | :--- |
| Contract unit, fuzz, invariant, deep run | `heavy forge test --match-path 'test/data/*'` | 34 passed, 0 failed; invariant 256 runs x 120 depth (30,720 calls, 0 reverts); deep run 4,000 actions: 562 splits, 339 pool fundings, 88 listings, pool set |
| Mutation | `python3 mutate_data.py` | 59 of 60 caught in the full run (805 s); the miss ("preview ignores the booking") got an assertion in `test_preview_matches_split` and is caught (1/1); log `contracts/mutate_data.out` |
| Fork 4663 | `heavy forge test --match-path 'test/fork/data/*' --fork-url https://rpc-robinhood.blockmachine.io` | 5 passed: real ORRY burn (supply down exactly 700e18), pool set by the real `OrreryTreasury` owner `0x006d…1A3A`, 1% of real USDG to the real treasury, TSLA multiplier and feed reads, ORRY's Pons launch record (curve progress 93 bps) |
| Services, data | `vitest run test/data.integration.test.ts test/data.unit.test.ts` | 17 + 6 passed (DA-1, DA-2, DA-4 to DA-9, D-5) |
| MCP | `vitest run packages/mcp/test` | 7 passed against the local stack |
| Web | `tsc --noEmit`, `scripts/copy-lint.mjs`, `vitest run packages/web` | exit 0; 108 files clean; 7 passed |
| Local walk | `scripts/data-local-stack.ts` + web dev on 3202 | `/data` and `/data/providers` at 1440 and 375 px (no horizontal scroll); a signed `chain-health` and a signed `orry-economy` burn (source 11) verified in the browser |

## 10. Owner questions (relayed by the orchestrator)

1. Pack size and price: 1,000 calls for 1 USDG (0.001 USD a call, the plan's guess). Keep?
2. Provider stake minimum: 100 USD of staked ORRY (the merchant badge level). Keep, or higher for data?
3. Staker discount on data packs as extra calls (D-5), capped at 90%. Keep, or no staker discount on data?
4. MCP payment confirmation threshold: 1 USD per call. Keep?
5. Stock pools for dataset 4: run the discovery once with an archive RPC key (server 1's), or name the pools by hand?
