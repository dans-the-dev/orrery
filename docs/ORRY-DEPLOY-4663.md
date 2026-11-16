# ORRY on 4663: deployment runbook and dry-run evidence

> **Orrery note (2026-11-15):** this document records Runcore's own run, from the codebase Orrery was copied from,
> with the names switched to Orrery's by the rename pass. Orrery itself has no deployment, keys, X or Discord account
> yet; addresses, ids and dates below are Runcore's and serve only as a worked example of the procedure.


Internal engineering document. Status on 2026-11-08: the script is written and dry-run on a fork of 4663 with a real
Pons V2 launch. A live run, spending funds and merging into `build/v1` each wait for the owner's word; a live run also
waits for the owner's typed CONFIRM.

## 0. ORRY on Pons V2 (launched 2026-11-10)

Read on 4663 on 2026-11-11 (`getLaunchedToken` on the Pons factory, ERC-20 views, the mint log):

| Field | Value |
| :--- | :--- |
| Token (CA) | `0x85272EA3aE8685C768045dba5455fE305C706aA4`, name ORRERY, symbol ORRY, 18 decimals, supply 1e27 |
| Launch | tx `0x7376fc70dda82fffc500c2cfcb183e43993f6287a0099ec9749ca9886963ae28`, block 111,068,678, 2026-11-10 17:49:33 UTC, from the owner's wallet `0x9257A3e0F735B10f12E73284F89ab98881DC6e60` with 0.0105 ETH (launch fee 0.0005 plus a first buy) |
| Curve | `0xe8b016eD5e5b6f47BDF475f516C571439bfF0420`, phase 0 (on the curve), graduation at 4.2 ETH |
| Pair | native ETH (`pairToken` 0), so `deploy-orry-4663.ts` accepts it once it graduates |
| Creator fee recipient | `0x9257A3e0F735B10f12E73284F89ab98881DC6e60` (the owner's wallet, R-1) |
| Creator tax / buyback | 100 bps (1%) / off |
| Pool after graduation | LP fee 0, tick spacing 200 |

ORRY launched before v1 (step 1 below has not run yet); steps 3 to 5 are unchanged. The deploy command once it
graduates (phase 2):

    npx tsx scripts/deploy-orry-4663.ts --orry 0x85272EA3aE8685C768045dba5455fE305C706aA4

The CA shown on orreryagent.com comes from the Vercel production env `ORRERY_CA` (server side, read at request time by
`/api/ca`; see `RUNBOOK-INCIDENTS.md` section 2.1). Services keep `ORRERY_ORRY_TOKEN` empty until the ORRY deploy:
setting it turns ORRY on and requires the eight addresses that deploy prints.

## 1. Order on launch day

1. v1 and `OrreryTreasury` (coinless) are live: `services/scripts/deploy-4663.ts` (see `MAINNET-4663.md`).
2. The owner launches ORRY on Pons V2 from the owner's wallet, with the creator fee recipient set to that wallet (R-1).
   Pons fees never reach a Orrery contract.
3. ORRY graduates into its Pons pool (phase 2). The hub needs that pool's price, so nothing below runs before it.
4. `services/scripts/deploy-orry-4663.ts --orry <token>`: deploys the ORRY contracts with the ORRY/ETH and
   ORRY/USDG hubs (R-35), initializes both hubs, proposes the coin on the treasury.
5. 48 hours later (within the 7 day window): `services/scripts/deploy-orry-4663.ts --execute-coin`.
6. API and web get the printed addresses; every ORRY feature stays held until `ORRERY_ORRY_FEATURES` and
   `NEXT_PUBLIC_ORRY_FEATURES` open it (release switch).
7. The keeper gets work: fund it (`services/scripts/fund-roles-4663.ts --roles keeper --target 0.001`, owner's CONFIRM),
   then put it back on the Discord gas watch, which it was taken off on 2026-11-11 while it had nothing to do: append
   `,keeper=0x1241C83501E865c86613c715bE40A60Be455075F:0.001` to `ORRERY_DISCORD_WATCH` in `/opt/orrery/discord.env`
   and recreate the bot (`TAG=<running tag> docker compose -p orrery-mainnet up -d --no-deps discord`; a plain
   `restart` keeps the old environment).

## 2. `deploy-orry-4663.ts`

- Inputs: `--orry` (required), `--rpc` (default `https://rpc-robinhood.blockmachine.io`), `--fork` (anvil fork, 46630
  keys, no prompt), `--keys`, `--quote-signer <address>` (else the address of `~/.secrets/orrery/<keys>-quote-signer.json`
  when that file exists; without one, ORRY checkout stays closed until `setQuoteSigner`). It reads
  `deployments/4663.json` (or `4663-fork.json`) for the treasury and the attestor.
- Gate, before any transaction: chain 4663; code at the PoolManager, StateView, USDG, registry, CREATE2 factory,
  Chainlink ETH/USD proxy `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`, treasury, attestor and ORRY; the feed answers
  (answer > 0, updated within 25 hours, as the hook's constructor requires); ORRY supply at most 1e27 with 18 decimals; treasury owned by this deployer, no pending
  owner, coin unset; the attestor's treasury is the treasury contract; ORRY is a Pons V2 launch in phase 2 paired with
  native ETH, and its Pons pool (derived from `getLaunchedToken` and the Pons hook) has a price; the recorded ETH/USDG
  pool ids match their keys, and only pools with liquidity are listed for hop 1. Then a summary, a balance check
  against the gas estimate, and `CONFIRM` on mainnet.
- Deploys, in this order: `OrryStaking`; `OrreryHook(poolManager, orry, router, treasury, 8500, 1500, 200, USDG,
  ETH/USD)` through the CREATE2 factory `0x4e59…956C` at a salt mined for the permission bits `0x10C4`, with the router
  address predicted (the hook registers the ETH and USDG pairs; the treasury owner is the pair admin, R-36);
  `OrryBuyback` and `OrryRewardsRouter(orry, staking, buyback, hook, 5000, 1 hour)` at the next two CREATE nonces
  (finding F-4; the script stops if a prediction misses); `EarnVaultFactory(hook)`, then `createVault(ETH)` and
  `createVault(USDG)`; `ClaimAll` and `OrryLens` over the factory. Then `PoolManager.initialize` for both hubs (each
  skipped with a note if someone initialized it first: R-21), `treasury.proposeCoin(orry, buyback)`, and
  `setQuoteSigner` when a signer is known.
- Opening prices: the ETH hub at the Pons pool's sqrtPriceX96. The USDG hub at the Pons ETH price times the Chainlink
  ETH/USD answer, USDG taken as one dollar: with p = (ponsSqrt / 2^96)^2 ORRY wei per wei of ETH, a the answer with d
  decimals and s = 10^(18 + d - 6), ORRY wei per USDG unit is p * s / a. USDG below ORRY in address order (USDG is
  currency0): sqrtPriceX96 = isqrt(ponsSqrt^2 * s / a). ORRY below USDG (ORRY is currency0, the price is USDG per
  ORRY): sqrtPriceX96 = isqrt(a * 2^384 / (ponsSqrt^2 * s)).
- Constructor values: hub LP fee 8500 and hook fee 1500 pips, spacing 200 (R-6); cooldowns 7 and 14 days, streams 7
  days (R-8); router 50% to stakers, hourly (R-7); buyback slice cap 1,000 USDG and the three hop 1 pools of spec
  section 2 (R-18).
- Read-back after deployment, any mismatch stops the script before the record is written: hook router, ORRY,
  PoolManager, treasury and pair admin, fees, two pairs registered, each pair's feed, pool id, currency order and
  initialization, both hub keys; buyback, router (with its hook) and staking wiring; the factory, its two vaults at their
  predicted addresses and each vault's hook, ORRY and quote; ClaimAll and lens on the factory; both hub prices set and
  both oracles started (R-28); treasury coin still unset; quote signer when set. It writes `deployments/orry-4663.json`
  and prints the API and web variables (`ORRERY_ORRY_EARN_FACTORY` and `NEXT_PUBLIC_ORRY_EARN_FACTORY` name the
  vaults' factory).
- `--execute-coin`: reads `deployments/orry-4663.json`, refuses before `coinExecutableAt` ("Nothing was sent."),
  checks the owner and that the coin is unset, asks for `CONFIRM` on mainnet, calls `executeCoin`, reads back `orry`
  and `buyback`.

`services/scripts/fork-pons-launch.ts` is a dry-run helper only: on an anvil fork it launches "Orrery" (ORRY) on the
real Pons factory with the deployer key, buys from impersonated fresh addresses until graduation and creates the Pons
pool. It refuses any endpoint that is not anvil on chain 4663.

## 3. Dry run, 2026-11-09 (anvil fork of 4663 at block 109,378,648), multi-pair hubs with B-1 and B-2

Branch `orry/pairs-int` at 057a029 (integration 8421c32 + `orry/pairs-a` + `orry/pairs-b` 89680e1 + `orry/services`
0748be0), artifacts regenerated with `node services/scripts/gen-abi.mjs`.

| Step | Result |
| :--- | :--- |
| v1 and treasury (`deploy-4663.ts --fork`) | attestor 1,232,448, module 3,455,361, lens 1,877,634, treasury 1,499,598 gas; read-backs correct |
| Pons launch (`fork-pons-launch.ts`) | token `0x95b5…2161` (above USDG in address order, so USDG is currency0 of the USDG hub), launch fee 0.0005 ETH, 4.5 ETH offered on the curve, graduated; Pons pool fee 0, spacing 200 |
| ORRY deploy | staking 1,725,256; hook 2,643,492; buyback 2,886,984 (with the B-1 cashback sink, 10%, unset); router 709,397; factory 3,382,361; createVault ETH 2,544,351; createVault USDG 2,527,479; ClaimAll 440,368; lens 808,183; initialize ETH hub 110,271; initialize USDG hub 110,606; proposeCoin 72,654 gas: 17.96 M in all (estimate 20 M, about 0.018 ETH at the fork's 1 gwei; about 0.0004 ETH at 0.02 gwei) |
| Opening prices | ETH hub at the Pons sqrtPriceX96 552276925551777206824881611623729; USDG hub at 11695750100523126813732087710900618701 (ETH/USD 2,229.76, feed age 267 s) |
| Read-back | 25 of 25 ok (including "buyback cashback 10%, sink unset (B-1)") |
| `--execute-coin` before 48 hours | "The coin can be set from …. Nothing was sent." |
| `--execute-coin` after 48 hours | `executeCoin` 69,879 gas; treasury `orry` and `buyback` read back |
| Smoke | owner deposit 0.01 ETH + ORRY into the ETH vault (341,880 gas; position 0.00999 ETH and 485,908 ORRY) |

The earlier run on 2026-11-08 (block 109,356,400, before B-1) measured 17.56 M with 24 read-backs; B-1 adds about
280,000 gas to the buyback and B-2 about 40,000 to each vault.

## 4. Still open before a live run

- The owner's word for the live run and the funds: this step costs about 0.0004 ETH at 0.02 gwei on top of v1; the
  script refuses before the prompt while the deployer holds less than its 20 M gas estimate.
- A quote signer key (`keys.ts` role `quote-signer`) if ORRY checkout should open on day one; and a keeper key for the
  keeper process. Neither exists yet.
- API and web configuration from the printed variables; features open one by one with the release switch.
