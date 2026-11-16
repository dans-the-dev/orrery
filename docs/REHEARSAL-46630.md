# Rehearsal on Robinhood Chain 46630 (development network)

> **Orrery note (2026-11-15):** this document records Runcore's own run, from the codebase Orrery was copied from,
> with the names switched to Orrery's by the rename pass. Orrery itself has no deployment, keys, X or Discord account
> yet; addresses, ids and dates below are Runcore's and serve only as a worked example of the procedure.


Prepared 2026-11-07. Internal runbook. Status: **live run done on 2026-11-07 after the owner's go; everything passed.**

## What exists on 46630 (eth_getCode, 2026-11-07)

| Contract | Address | Present |
| :--- | :--- | :--- |
| ERC-8004 IdentityRegistry / ReputationRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` / `0x8004B663056A597Dffe9eCcC1965A193B7388713` | yes (proxies) |
| Safe 1.4.1 singletons, SafeProxyFactory 1.4.1 | `0x29fc…C762`, `0x4167…461a`, `0x4e1D…ec67` | yes |
| Permit2, EntryPoint 0.7 / 0.8 | canonical | yes |
| **Safe7579 adapter v1.0.0** | `0x7579EE8307284F293B1927136486880611F20002` | **no** |

The Safe7579 adapter is not deployed on 46630, and its runtime code cannot simply be copied there: it stores the address
of a helper it deploys in its constructor (`UTIL` immutable), which would be empty on 46630. The rehearsal therefore
uses `DevAccount7579` (owner EOA, ERC-1271 by owner signature, single-call executor) as the account. The Safe path
itself is proven on a 4663 fork (`contracts/test/fork`). Deploying Safe7579 on 46630 from its v1.0.0 sources is
possible later if the owner wants the rehearsal on a real Safe.

USDG on 46630: the test token is owner-mint only, so the rehearsal deploys `DevUSDG` (same 6 decimals, EIP-712 domain
and EIP-3009 behaviour as USDG on 4663, including the silent replay).

## Keys (`~/.secrets/orrery/`, 600, backed up to Private Keys with INDEX entries)

| Role | Address | Needs ETH |
| :--- | :--- | :--- |
| deployer (also attestor owner and treasury for the rehearsal) | `0x6fd177871089445a88E931f026a3e01c4D0b4A67` | 0.001 |
| relayer (x402 settlements) | `0xd9E900E8fC5F21D9199684EBD2D99752C9bdb990` | 0.0005 |
| attester (prober) | `0xA5EbCC8C2447231Be1ED888eCA6b97E48a986B52` | 0.0003 |
| check-signer | `0xBfd4aec4667beb385E892fAcD57778Ce389401B4` | none (signs off-chain) |
| operator (owns the development account) | `0xA163D7ffeF50a0589C337fE61F92EAf41fE64415` | 0.0005 |
| agent-signer | `0x4C4bd566516eAe906ad5029317758C58E4A2a606` | 0.0003 |
| merchant | `0x23adA34a13c988754B3bcB37d883737668b1C46A` | none (pays by signature) |

Funding from the testnet bank: 0.0026 ETH in total. The bank held 0.0126 ETH on 46630 on 2026-11-07.

## Cost

Dry run gas (fork): deployments 7,740,905 (DevUSDG 665,803, OrreryAttestor 1,227,510, OrreryPolicyModule 3,455,133, OrreryLens
1,808,810, DevAccount7579 583,649); setup and session about 1.6 M more. Live gas price 0.01 gwei; the live estimate for
the DevUSDG deployment was 672,254 gas, within 1% of the fork, so the L1 data share is small. Expected total about
0.0001 ETH. Funding above leaves a wide margin; leftovers are swept back to the bank after the rehearsal.

## Steps

```bash
cd orrery/services
# 1. fund the five gas wallets from the bank (owner go)
node ~/bin/testnet-bank/testnet-bank.mjs send robinhood-testnet 0x6fd177871089445a88E931f026a3e01c4D0b4A67 0.001
node ~/bin/testnet-bank/testnet-bank.mjs send robinhood-testnet 0xd9E900E8fC5F21D9199684EBD2D99752C9bdb990 0.0005
node ~/bin/testnet-bank/testnet-bank.mjs send robinhood-testnet 0xA5EbCC8C2447231Be1ED888eCA6b97E48a986B52 0.0003
node ~/bin/testnet-bank/testnet-bank.mjs send robinhood-testnet 0xA163D7ffeF50a0589C337fE61F92EAf41fE64415 0.0005
node ~/bin/testnet-bank/testnet-bank.mjs send robinhood-testnet 0x4C4bd566516eAe906ad5029317758C58E4A2a606 0.0003
# 2. deploy, agent, binding, session, verification, one top-up (live)
pnpm exec tsx scripts/rehearse-46630.ts --rpc https://rpc.testnet.chain.robinhood.com
# 3. services: Postgres (launch config orrery-pg), API against 46630 (orrery-api-46630), then
pnpm exec tsx scripts/exercise-api.ts --deployment ../deployments/46630.json
# 4. web against 46630: NEXT_PUBLIC_CHAIN_ID=46630 and the addresses from deployments/46630.json
```

## Dry run result (fork of 46630 at block 149,847,331)

- Deployments and the whole session flow passed against the **real** ERC-8004 registry: register, setAgentURI with an
  inline registration file, setAgentWallet through ERC-1271 from the account, install, open session with signer
  consent, verification fee, top-up. Lens: Active, bound, installed, verified, 3.50 USDG spent.
- Services against the fork: a pack sold over x402 (500 credits, key issued); the agent paid over x402 from its float;
  the merchant's signed check verified (signature valid, verified, registration valid, endpoints live after a real
  internet probe of `https://orreryagent.com/`, attestation written); the indexer reached lag 0 with 11 event kinds.

## What the live run adds, and what it does not

Adds: real block times and confirmations, real RPC behaviour under the indexer, gas actually charged, public explorer
records. Does not cover: a Safe account (adapter absent on 46630), Kernel, hosting (services run on this machine),
mainnet prices.

## After the rehearsal

Sweep leftover ETH back to the bank (`testnet-bank.mjs sweep`), keep the deployment record in `deployments/46630.json`,
stop Postgres and the API.

## Live result (2026-11-07, block 149,848,290 onwards)

| Contract | Address |
| :--- | :--- |
| DevUSDG | `0x79e01698c2c5bbb3230222dca6157cadc2cbc2ff` |
| OrreryAttestor | `0x20f83a67b71d6d65c35488c4eb8d369b3f0efd9a` |
| OrreryPolicyModule | `0xfbbc06cd0ae2d7ab5f23247ceda6377941080397` |
| OrreryLens | `0x8e2aeffeeeb14a978e2c24d512725fe1ee4adfd7` |
| DevAccount7579 | `0x09af12ebb8c9989f5faa249b231e5206d0a9e034` |
| ERC-8004 agent | id 320 in `0x8004A818…BD9e`, owner operator, `agentWallet` = the account |

- Deploy and session flow: 18 transactions, all successful; gas cost 0.00009319434 ETH. Lens: Active, bound,
  installed, verified, 3.50 USDG spent.
- Services against 46630 (API, Postgres and the exercise script on this machine): merchant pack settled over x402
  (`0x9d3910…87d5`), the agent paid from its float over x402 (`0x59a30c…e7aa`), the merchant's signed check verified
  (status Active, verified, registration valid, endpoints live after a public probe of `https://orreryagent.com/`), the
  prober attested on-chain (`0xd81014…474a`), the indexer reached lag 0 with 11 event kinds.
- Web app against 46630: the landing console and the signer record read the live session; the credits page loaded the
  pack price from the API. A layout bug found here and fixed: focusing the console input at 1024 px scrolled the hero
  sideways (`overflow: hidden` made it a scroll container); the hero now uses `overflow: clip`.
- Funding: 0.0026 ETH sent from the bank; afterwards everything above 0.0001 ETH per role wallet was swept back
  (5 sweeps). Bank 0.0126 -> 0.0120 ETH; 0.0005 ETH stays in the five role wallets as a working reserve for this
  deployment. Postgres, API and web stopped.

## First-visit walk (2026-11-07, 16:00 UTC)

A fresh wallet `0x1a912bDF…fcE6` (`~/.secrets/orrery/46630-walk.json`, 10 DevUSDG, no ETH) walked the web app on 46630
as a first-time visitor. Its key stayed in a local signing proxy (`services/scripts/wallet-proxy.ts`, refuses 4663 and
1); the page saw one EIP-6963 wallet that forwarded to the proxy.

1. Landing: the hero console checked the agent signer `0x4C4b…a606` from the live chain: Active, 3.50 of 50.00 USDG
   today, endpoints live.
2. Full record: account, agent #320, bound, installed, verified, last probe, caps, "None. This signer can only top up
   its float." Account kind "Not recognised" (DevAccount7579), so the record shows "Limits can change now", as specified.
3. Credits: Connect wallet connected straight to the one wallet, no picker. Buy 500 checks: one EIP-3009 signature,
   settled by the relayer in `0xce6b0cba…e4af` (status 1); the wallet kept 0 ETH and went from 10 to 9 USDG; the API key
   was shown once; balance 500.
4. Run signed check on the agent signer: Active, signature valid (check signer `0xBfd4…01B4`), account, 3.50 of 50.00,
   endpoints live; balance 499.
5. Console: only the expected 402 challenge and dev-server HMR reconnects. At 375 px no element wider than the viewport.
