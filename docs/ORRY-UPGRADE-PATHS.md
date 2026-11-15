# ORRY upgrade paths: forward compatibility of the launch contracts

Date: 2026-11-08 (WIB). Requested by the Orrery session for the public launch plan (owner: core features at launch,
the rest as updates "tanpa bertentangan dengan kontrak sebelumnya"). Every launch contract is immutable (R-10), so a
later item must plug into an existing extension point or be a new contract. Anything that would need a redeploy is a
blocker, to be changed before deployment.

Launch set: v1 `OrreryAttestor`, `OrreryPolicyModule`, `OrreryLens`, `OrreryTreasury`; ORRY `OrreryHook` (pair registry),
`EarnVaultFactory` and its vaults, `OrryStaking`, `OrryRewardsRouter`, `OrryBuyback`, `ClaimAll`, `OrryLens`.

## 1. Extension points the launch set already has

| Point | Who | What it allows later |
| :--- | :--- | :--- |
| `OrreryHook.proposePair` / `executePair` | treasury owner, 48 h, max 8, feed | new ORRY/X hubs; router and buyback pick them up from the registry (R-36, P-5) |
| `EarnVaultFactory.createVault(quote)` | anyone, once per registered pair | a vault for each new hub |
| `OrreryHook.consult(quote, window)`, start-of-block record | read | ORRY price for any later contract (R-28) |
| `OrryStaking.earningBalance`, `agentStakeOf`, `extendAgentLock` | read; staker | stake gates, tiers (in USD with the price oracle), Agent Launch's 90 day lock (R-13) |
| `OrryStaking.notifyRewards` | anyone | any later contract can add ETH or ORRY rewards for stakers |
| `OrreryTreasury` revenue in USDG | anyone sends USDG | every later fee in USDG becomes revenue (10% owner, 90% buyback) |
| `OrreryTreasury.setQuoteSigner`, quote-priced burns | owner | ORRY-priced products through quotes (checkout, verification) |
| `OrreryAttestor.setAttester`, `setTreasury`, `setCheckSigner` | attestor owner | attester keys, fee recipient (a splitter later), check keys |
| `OrreryLens`, `OrreryPolicyModule.signerOf`, `OrreryAttestor.isVerified` | read | admission of agents to any later market |
| `IOrryBurnEvents.Burned(source, amount)` | any contract | new burn sources for the indexer |

## 2. Matrix

| Item | Touches | How it plugs in | Redeploy or migration |
| :--- | :--- | :--- | :--- |
| R1 Dark Pool, Private Swap, Stocks | treasury (fees), staking and hook (reads) | new contracts (`SealedBatchMarket`, factory, `FeeTiers`, `OrryPriceOracle`) | none |
| R2 Shield V2, Prediction, limit orders | treasury, attestor and module (reads) | new contracts | none |
| R3 Perps, Lend and Multiply, Pair trading, Vaults | treasury, hook TWAP (ORRY collateral), module (user Safes for vaults) | new contracts | none |
| R4 RWA issuance, launch tools | treasury | new contracts | none |
| Community Chat, Reward Pool, events, Achievement Board | staking (staker rooms, verifiers), hook TWAP (USD fees) | new contracts; chat fees go straight to the pool (R-31) | none |
| 1 Stake for a check quota | staking (read) | services | none |
| 2 Third-party attesters | `OrreryAttestor` | `AttesterRegistry` (new) plus `setAttester` per epoch by the attestor owner (ops job); the fee share through a splitter set with `setTreasury` (the treasury itself only pays the owner or the buyback, T-2) | none |
| 3 Credit bond in ORRY | none at launch | new Credit contracts | none |
| 4 Facilitator discount, 6 merchant badge | staking (read) | services | none |
| 5 Agent Launch priority | staking (read) | Agent Launch contracts | none |
| 7 Cashback, 8 referral (R-45: 10% of the buyback's ORRY before the 50/50 split) | buyback (output), router | **cannot be added later**: the router's split is fixed, the hook's router is fixed, and the treasury sets its buyback once | **blocker B-1** |
| 9 Template market, 14 burn-to-boost, 15 passes | none | new contracts burning ORRY | none |
| 10 USD thresholds | `FeeTiers` (new, R1) and services | price oracle over the hook TWAP | none |
| 11 x402 in ORRY via Permit2 | none on chain; the agent's float wallet approves Permit2 (the module forbids approvals on the account, I13) | facilitator (services) | none |
| 12 Paymaster accepting ORRY | hook TWAP (read) | new paymaster on EntryPoint 0.7/0.8; the account's policy must allow ORRY transfers to it | none |
| 13 Pay-as-you-go checks | treasury `burnForCredits` | the API issues a quote for one check and grants by the stored quote (the event's `packs` is the quote's own unit) | none |
| Agent Launch (T3 to T6) | staking lock (exists); Earn LPs paid 20% of spoke fees in ORRY (T6) | separate spoke hook and launch contracts | **blocker B-2**: a vault cannot take outside rewards today |
| Credit (U7) | treasury, module | new contracts; x402 `payTo` routing in services | none |
| Shield V2 (U4) | attestor, module, lens (reads) | new contracts | none |

## 3. Blockers to fix before deployment

| # | Change | Why it cannot wait |
| :-- | :--- | :--- |
| B-1 | `OrryBuyback` sends a fixed `CASHBACK_BPS` (1000 = 10%, constructor value) of the ORRY it buys in `executeSlice` and `buyWithQuote` to a `cashbackSink`, set once by the treasury owner after a 48 hour delay; until it is set, all of it goes to the router as today (`burnEth` output stays fully burned). The sink (cashback and referral payer) is built with C1 | the router, the buyback and the treasury's buyback link are permanent; R-45 needs its share at the split |
| B-2 | `IEarnVault.notifyRewards(uint256 orryAmount)`: anyone pays ORRY in; it is streamed to the vault's shareholders over `STREAM_PERIOD` like harvested fees (new invariant E-7: notified ORRY is paid out to shares only) | vaults come from a fixed factory implementation; without it, T6's 20% for Earn LPs would need new vaults and an LP migration |

## 4. Launch readiness (updated 2026-11-09)

- `OrreryTreasury`: in `build/v1` (e6c8aab, constructor tests fixed in 50852ee), fork dry run done.
- ORRY launch candidate: `orry/integration` 86fb0d3 = multi-pair contracts with B-1 and B-2 (`orry/pairs-int` a5c86bc),
  services with the multi-hub pass and the runtime release switch (`orry/services` 104905a), web with multi-pair Earn
  and the release switch (`orry/web` e52abc2), spec to R-52. Checks on 86fb0d3: forge 477 passed, 0 failed, 6 skipped;
  OrrySystem 5/5; all ABI checks and the no-Pons scan pass; services typecheck 0 and vitest 96/96 (real multi-pair suite
  13/13 on 104905a); web lint clean, tests 7/7, build 17/17. Fork dry run of the deploy script with a real Pons launch on
  `orry/pairs-int` c0cb3d9 (same contract sources): 25 of 25 read-backs, 17.96 M gas, `executeCoin` after 48 h. First
  visit walks on the local stack: everything held, then open and hold again without reload; never-held exits work.
- Owner steps left: merge into `build/v1` (owner's yes), the ORRY launch on Pons and its graduation, funds for the
  deploy (about 0.0004 ETH at 0.02 gwei), the live run with CONFIRM, then `executeCoin` 48 h later, and the keeper and
  quote-signer keys if checkout opens on day one.
- Before `executeCoin` (48 h): Earn, Stake, Claim, Burn and the leaderboard work right after deployment; ORRY checkout
  and treasury slices wait for `executeCoin`; TWAP-priced items need 30 minutes of hub history.
