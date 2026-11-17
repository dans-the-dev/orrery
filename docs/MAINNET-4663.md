# Mainnet 4663: deployment runbook and pre-launch evidence

> **Note:** Earlier addresses, ids and dates below serve as a reference example of the procedure; see `deployments/4663.json` for Orrery's live mainnet addresses.


Internal engineering document. Status on 2026-11-07: the code path to mainnet is rehearsed; the live deployment waits
for the owner's inputs and the owner's CONFIRM.

## 1. Deployment script

`services/scripts/deploy-4663.ts` deploys OrreryAttestor (fee 5 USDG), OrreryPolicyModule and OrreryLens against the real 4663
contracts (ERC-8004 IdentityRegistry `0x8004A169…a432`, USDG `0x5fc5360D…d168`, Permit2, EntryPoint 0.7 and 0.8, the
Safe7579 v1.0.0 adapter `0x7579EE83…0002`, the Safe 1.4.1 singletons and the SafeProxy 1.4.1 runtime codehash), sets the
check-signer and attester keys, deploys `OrreryTreasury` in coinless mode (owner decisions T2 and T11: 30% of USDG revenue
to the treasury owner (20% operations, 10% owner; R-57), 70% held for the ORRY buyback, no quote signer until ORRY launches) and points the attestor's fee
at it with `setTreasury`, hands the attestor to the owner's wallet when `--owner` names another wallet (two-step, the owner
calls `acceptOwnership`) and writes `deployments/4663.json`. The API's `ORRERY_TREASURY` is the treasury contract.

- Keys: `~/.secrets/orrery/mainnet-<role>.json` for `deployer`, `check-signer`, `attester` (not created yet).
- Flags: `--rpc` (default `https://rpc-robinhood.blockmachine.io`), `--owner` and `--treasury-owner` (both default to the
  deployer, M1), `--fork` for a dry run on an anvil fork, `--keys` to pick another key set. The old `--treasury` flag is
  refused with a message, since the attestor's treasury is now the contract.
- Gate: before any transaction it checks chain id 4663 and code at the registry, USDG, adapter and Permit2, prints a
  summary (deployer and balance, owner, treasury, fee, check signer, attester, gas estimate) and reads stdin. Anything
  other than `CONFIRM` prints "Not confirmed. Nothing was sent." and exits 1.
- After deployment it reads back fee, treasury, both key roles, the module's registry and the lens's Safe proxy
  codehash, then the treasury's owner, `pendingOwner` (0), USDG, attestor, `orry` and `buyback` (both 0, coinless) and
  `OWNER_BPS` (3000); any mismatch stops the script before the deployment record is written.

## 2. Evidence, 2026-11-07

| Check | Result |
| :--- | :--- |
| Fork dry run (anvil fork of 4663) | attestor, module, lens deployed; two role calls; read-back all correct; Safe proxy codehash known `true` |
| Live gate on the real 4663 RPC | summary printed; answer `no` gave "Not confirmed. Nothing was sent."; no transaction sent |
| Live cost estimate | ~7,000,000 gas (6.63 M measured on 46630) at 0.02 gwei = ~0.00014 ETH (before the treasury) |
| Fork dry run with the treasury (2026-11-08) | attestor 1,232,448, module 3,455,361, lens 1,877,634, treasury 1,499,598, setCheckSigner 70,191, setAttester 70,301, setTreasury 30,482 gas: 8.24 M in all (estimate 9 M, ~0.00018 ETH at 0.02 gwei); every read-back correct, treasury coinless |
| Operator flow on a real Safe (web app, 4663 fork) | see section 3 |
| First-visit walk on 46630 live (web app, fresh wallet) | see `REHEARSAL-46630.md`, section "First-visit walk" |

## 3. Operator flow through a real Safe 1-of-1 (4663 fork, web app)

Set up with `services/scripts/setup-safe-fork.ts`: Safe 1.4.1 proxy `0xD9861397…1590` from the real factory, owner
`0xE8676dEB…86aD` (fresh fork mnemonic; the default anvil accounts carry EIP-7702 delegations on 4663), Safe7579 v1.0.0
enabled as module and fallback handler and initialised empty, ERC-8004 agent 22479 registered in the real registry.
The operator page then ran every step with the owner's wallet:

1. Account kind detected: "Safe, 1-of-1, owned by this wallet".
2. Install module: done (Safe `execTransaction` through the adapter).
3. Bind identity: `personal_sign` by the owner, wrapped by the page as the adapter's ERC-1271 signature, accepted by the
   real registry's `setAgentWallet`.
4. Open session (10 / 50 / 20 USDG, expiry 2026-12-31, 1 h delay, signer consent from the agent signer): Active,
   0.00 of 50.00.
5. Pay verification with real USDG (balance written into the fork): Verified.
6. Signer record: "Safe with the Safe7579 adapter", other grants "None found", "Limits hold for at least 59 min 48 s".

## 4. Owner inputs (2026-11-08) and what remains

Decided (`02-open-questions.md` M1 to M3): deployer = attestor owner = treasury owner; fee 5 USDG; packs 500 credits for 1 USDG.
Check pricing (R-58, services only): 1,000 free checks per address per month, then 2 credits (0.004 USDG) a check, 1 credit
(0.002 USDG) past 100,000 checks in a month, and a 99 USDG platform plan (30 days, 49,500 credits, 1 credit a check).
The attestor's fee treasury is the `OrreryTreasury` contract (T2, T11), owned by the deployer.

Mainnet keys created 2026-11-08 by `services/scripts/keys.ts --network mainnet` (600 files, backup copy checked byte
for byte, INDEX entries written):

| Role | Address | ETH to send on 4663 |
| :--- | :--- | :--- |
| deployer (owner, treasury owner) | `0x006dAF2633C8d87001D13F7F5D7ed7d432cF1A3A` | 0.0003 (deploy ~0.00018 at 0.02 gwei, treasury included) |
| relayer (hot, API server) | `0x21f7536E49Ffc5CbfFd7b976A0c73f3A0BC2C6C0` | 0.0002 (~85,400 gas per pack settlement, ~110 packs) |
| attester (hot, API server) | `0xe0444a010EbAdb445aD75629E20c4C0149724eC0` | 0.0002 (~60,000 gas per attestation, ~160) |
| check-signer (hot, API server) | `0x4Cfc9f92BA05af4e7C8cb8E80416B5c7D370E117` | none, signs off-chain only |

The deploy script refuses before the CONFIRM prompt while the deployer holds less than the estimate (tested with 0 ETH:
"Nothing was sent."). Live command, from `services/`: `npx tsx scripts/deploy-4663.ts`.

Still open: funding the three wallets above, hosting (web on Vercel Hobby at orreryagent.com, API, indexer, prober and
Postgres on server 1; orreryagent.com DNS is on the Hostinger token that owns it, now parked), then the owner types
CONFIRM. The X account @OrreryHQ exists and is verified (2026-11-08).

Engineering items that stay open and are not gates: Kernel 3.1 support, Slither, a second independent review.

## Deployed on mainnet, 2026-11-11

`deploy-4663.ts` run live by the owner (typed CONFIRM) at block 111,123,400; record `deployments/4663.json`. Read back
on chain: all four contracts have code, every receipt succeeded, fee 5 USDG, check signer and attester set, treasury
coinless with owner = deployer and OWNER_BPS 3000. Gas spent 0.000165 ETH.

| Contract | Address | Transaction |
| :--- | :--- | :--- |
| OrreryAttestor | `0xc18a0dc74f5326786f5ade357354159c63282bd0` | `0x4db8b05aa485e7b832244e89b120b6b3bb313d5f09a279589c3d244f025c712b` |
| OrreryPolicyModule | `0x2934c34afd7b5410d05ddd638982eed1d49f0d4c` | `0xd7045c840940e5557306c21231026b401fef0926107b6e1d9140a20bafadfa08` |
| OrreryLens | `0xc10bb949d79d906e042d940cf5226c9f2c783ed9` | `0x1e1a1bb37811314b5ce372faebdffad3a06d9f423d36b244fcd2c77c8835f2ed` |
| OrreryTreasury | `0x5b633d7ec2749104d53b67dc47210dbe538ac54c` | `0xb377c33282123b627284c5cadd2de6bcd5bdd9444c4a082875f0e326056c3412` |

The first attempt sent nothing: rpc-robinhood.blockmachine.io refuses eth_sendRawTransaction; the scripts now default to
the official RPC (253082e). Next: fund relayer and attester (owner), source verification on Blockscout,
`go-live-4663.ts server`, `dns`, `vercel`, `discord`, `check`.

## Go-live, 2026-11-11

- Source verified on Sourcify, exact match (creation and runtime), solc 0.8.38+commit.1835d247, for all four contracts:
  https://repo.sourcify.dev/4663/0xc18a0dc74f5326786f5ade357354159c63282bd0 (attestor), .../0x2934c34afd7b5410d05ddd638982eed1d49f0d4c
  (module), .../0xc10bb949d79d906e042d940cf5226c9f2c783ed9 (lens), .../0x5b633d7ec2749104d53b67dc47210dbe538ac54c (treasury).
  The standard JSON from `forge verify-contract --show-standard-json-input` works as is with 0.8.38; the bytecode's
  CBOR tail reads `0x000826`, which is 0.8.38 in hex, not 0.8.26. Blockscout picked the Sourcify results up by itself
  within a minute: all four show as verified there (contract name, sources, compiler; flagged partial because the
  metadata hash differs from the sources at HEAD, the bytecode matches). Read through its API from the browser pane
  after the owner passed the Cloudflare check.
- `go-live-4663.ts` stages run by the owner with CONFIRM: server (API, indexer, prober; key files had to be chowned to
  uid 1000, fixed in 3f42edb), dns (api.orreryagent.com A record and Caddy block), vercel (7 production variables, deployed
  from a clean archive of 3f42edb because `vercel` is not on the owner's terminal PATH), discord (interactions endpoint
  to https://api.orreryagent.com). Check: API healthy on 4663, indexer lag 0, X gate pass.
- Release `core` opened by the owner's instruction ("saya mau itu dibuka sekarang"). Every other release held.
- Live on orreryagent.com: Signer lookup reads the mainnet lens, Credits shows the API's pricing, Operator ready.
- Still owner: relayer 0x21f7…C6C0 and attester 0xe044…4eC0 hold 0 ETH; credit purchases and attestations need about
  0.0002 ETH each.

## First live purchase, 2026-11-11

- Role wallets funded by the owner with `fund-roles-4663.ts` (relayer and attester 0.0002 ETH each).
- `fund-usdg-4663.ts` (owner CONFIRM): 1.2 USDG for the test buyer `0xD661f4ea1c60E3080Dc39679DcA48D8E8d1dAF7F` through the
  Uniswap V2 router on 4663, about 0.000584 ETH.
- `buy-credits-4663.ts` (owner approved in chat): one pack over x402, settled by the relayer in
  `0xc23d6efb85d3e0f10b5756e502b4811247a195c732b5f0011515424d6f9f8c97` (success). Treasury USDG 0 -> 1, buyer
  1.2 -> 0.2, API credits 500 with one purchase, payments row `settled`. The credit purchase path is live end to end.


## Core checks without funds, 2026-11-11

- `scripts/check-core-4663.ts` against api.orreryagent.com, buyer `0xD661…AF7F`: 18 of 18 passed. Key rotation by a signed
  message (a used nonce and a nonce for another address are refused), credits kept across rotation (500, one purchase),
  bad or missing key refused, checks by signer and by agent answer, the check signature recovers to an active check
  signer on the attestor, a check about another address fails the payer pin, bad input 400, checks metered (free
  monthly allowance used first: 1000 -> 993, credits untouched). A non-agent's check carries no window
  (`validUntil = issuedAt`, by design: a negative answer is not cached). The rotated key is in
  `~/.secrets/orrery/mainnet-buyer-api.json` (backed up, INDEX line). Not exercised live: credits spent after the free
  1000, and a 402 at zero credits (unit and 46630 tested).
- Held routes refused by the API: `/v1/orry/*`, `/v1/markets`, `/v1/merchants/*`, `/v1/x402/supported` answer 404.
- First-visit walk on orreryagent.com with a fresh never-funded wallet (`mainnet-walk.json`, `0x2d8D…7788`, signing only
  against a local fork): 19 routes at 1440x900 and at 375x812 (touch), no horizontal overflow on the phone; nav shows
  ORRY, Markets and Merchants with Soon; held pages show their Coming soon state. Dashboard walk: sidebar Overview,
  Agents, Merchant Soon, Positions Soon, Orders Soon, every section renders, no console errors.
  The walk logged RPC 429s from rpc-robinhood.blockmachine.io; a rerun alone (no parallel walk, no fork on the same
  RPC) had 0 of 1 calls rate-limited and the signer record resolved in 4 s, so the 429s came from the test setup.
  Remaining console noise: `/earn`, `/stake` and `/claim` request `/v1/orry/earn`, `/v1/orry/stake` and
  `/v1/orry/accounts/<address>` while ORRY is held and log the 404s.
- Server 1: api, indexer, prober, discord and postgres up 9 hours; indexer lag 0 (head 111,430,702); API 0 errors in
  6 hours; the prober has no agent to probe yet.
- Discord: the bot container started at 19:34:16Z, before the key files were chowned (19:41 restart of api and indexer),
  so it logged `mode: upkeep only` (EACCES on relayer.json) and still runs without the notifier and the 6-hourly role
  sync. Upkeep and welcomes run. Fix: restart the discord service (owner's call; the notifier then posts due drafts to
  #release-drafts). The upkeep also asks for the OrreryBot role to be dragged to the top of Server Settings > Roles.
- Discord restarted on the owner's word at 04:45:25Z: full mode, no `upkeep only` line, 0 errors in the first 10
  minutes, roles checked (0 linked wallets). The notifier posted the core draft to #release-drafts, opened the core rooms
  (operators, agent-builders, merchants, showcase) and raised `low-gas-keeper` in #alerts: the mainnet keeper
  `0x1241…075F` is on `ORRERY_DISCORD_WATCH` (server `discord.env`, min 0.001 ETH) and holds 0 ETH because it has no
  work until ORRY deploys; the alert repeats every six hours until it is funded or taken off the list.
- Keeper taken off the watch on the owner's word at 05:53Z: `discord.env` backed up to `discord.env.bak-2026-11-11`,
  the keeper entry removed (relayer and attester stay, min 0.0001 ETH each), the bot recreated on the same image
  (`orrery-services:67fb5b2`; `restart` alone keeps the old environment). It goes back on the watch when ORRY deploys
  (`ORRY-DEPLOY-4663.md` step 7).

## Support replies on Discord and X, 2026-11-11

Owner, quoted: "Saya butuh 1 sesi khusus untuk handle social kita yg bertugas membalas pertanyaan secara otomatis atau
bertanya dulu ke saya sebelum jawab". Decisions: Discord and X; answers from the docs and greetings are sent at once,
everything else waits for approval in #reply-queue; Hypatia's Anthropic key until Orrery has its own.

- Code: `services/packages/server/src/support*.ts`, `src/bin/support.ts`, migration 039 (commits 9ababdf, 962e38f,
  f6a2584). Tests: support unit 8/8, support integration 10/10, migrations 1/1.
- Live draft check with the real knowledge base, 8 sample questions: how-to, pricing, "is it on Base?", staking (coming
  soon, no date) and a greeting were drafted as answers; a missing-credits payment, a price prediction, an audit question
  and a prompt-injection attempt were all labelled for the owner.
- Deployed 08:03Z on server 1: image `orrery-services:f6a2584` built from the commit, loaded with `docker load`;
  `release.env` gained `SUPPORT_TAG=f6a2584` (TAG stays `67fb5b2`; api, indexer, prober and discord untouched);
  `compose.yml` and `release.env` backed up as `*.bak-2026-11-11`. Logs: knowledge base 28,435 characters with no page
  missing, gateway ready (so Message Content Intent is on), 40 channels read. Migration 039 applied; #reply-queue created
  in TEAM with the same permission overwrites as #release-drafts.
- X on since 12:56 UTC: app "ORRERY MONITORING" in the X developer console (pay per use, credits topped up by the owner),
  OAuth 1.0a token for @OrreryHQ (id 2118601949905883136) with `x-access-level: read-write`, server copy
  `secrets/support/x-api.json` holds only the four OAuth 1.0a values. The account had no mentions yet, so the start is kept
  as a time (`x_start_time`) and the first mention is answered (support image 82f8a0b, `SUPPORT_TAG=82f8a0b`).
  Operations: `RUNBOOK-INCIDENTS.md` 7.1.
- 13:2xZ: X reading turned off by the owner ("tidak perlu membaca semua tag atau comment dari X, cukup fokuskan untuk post
  saja"): the server copy of `x-api.json` was removed and support recreated (`x: false`); Discord replies continue. The
  keys stay in `~/.secrets/orrery/x-api.json` for posting.
- 13:32Z: mainnet proof posted on X with the owner's approval, https://x.com/OrreryHQ/status/2120509919078035533 (the
  four contracts, verified on Blockscout, plus the credit purchase `0xc23d…8c97`; files and check report in
  `docs/launch/verify/`). The API refused it (403 "Crypto addresses are prohibited for the first 7 days after
  authentication", token made 2026-11-11), so it was posted from the owner's logged-in browser. Posts with an address go
  through the API from about 2026-11-18.
- 08:31Z: image `410d759` (natural voice without a greeting opener, never "free", public rooms in the knowledge base,
  server nickname "Orrery Team"), `SUPPORT_TAG=410d759`. Gateway ready, rooms text 1,594 characters, nickname set.
- Room access checked for an ordinary member: #general, #help and #ideas are open to @everyone; #bug-reports to the
  Member role, which the required onboarding question gives every member (5 of 6 people hold it, the sixth is the
  owner's admin account).
- First replies: Mrk's two questions in #general (00:13Z and 00:16Z, before the bot started) were answered at 08:35Z on
  the owner's approval in chat, as replies to his messages (items 1 and 2, logged in #reply-queue with the undo).


## Web deploy, 2026-11-11 (owner: "Deploy sekarang")

- orreryagent.com now serves build/v1 faef3ab (Vercel `dpl_Cy8S6nmRg9X9AvXFxNGpfCxdSkeh`, orrery-qm3k3ibxn). Rollback target: the
  previous production deployment `dpl_E7C7y6JPeAZtZFnrJ1xPQ1xomxmb` (orrery-57bica8m5), `vercel rollback` or promote it.
- New: the top nav shows open sections inline and every held section in one "Coming soon" menu; the pages of the merged
  update lanes (Community, Data, Predict, Limit orders, Gas, Shield) are on the site in their held state. The API image on
  server 1 is unchanged (67fb5b2); held pages call no route it lacks.
- Checked on the live site, 32 pages at 1440 and 375 px, first visit without a wallet: 0 horizontal overflow, 0 text under
  12 px, 0 console errors or failed requests; header X link, CA pill and the menu groups present.

## Dashboard credits deploy, 2026-11-11 12:29 to 12:40 UTC (owner: "deploy sekarang")

- Built from a clean worktree of build/v1 1af25bb (the shared checkout had another session's uncommitted edits, which are
  not in this release). Image `orrery-services:1af25bb`, loaded on server 1; ONLY the `api` container moved to it
  (indexer, prober and discord stay on 67fb5b2, support on 410d759). Rollback:
  `TAG=67fb5b2 docker compose -p orrery-mainnet up -d --no-deps api` (the added tables do not bother the old image).
- Migrations 016, 020, 021, 024 to 030 and 040 ran on mainnet at start; rehearsed first on a copy of the mainnet
  database (pg_dump, local Postgres): all applied, re-run applies nothing, credit_grants and api_keys intact; the copy
  was deleted.
- Live checks with the test buyer: the sign-in message says it reads only; that signature is refused by key rotation;
  the session reads credits 500, 7 checks this month, the 1 USDG pack with its transaction; it cannot run a check (401);
  sign-out ends it (401). Release switch unchanged (only `core` open). Public pricing 200; CORS preflight from
  orreryagent.com 204 with the origin allowed.
- Web: orreryagent.com now serves 1af25bb (Vercel `dpl_F6Wp7tJGmurTqB28vgL2kshZ9GCw`, orrery-91x4o7hea); rollback to
  `dpl_Cy8S6nmRg9X9AvXFxNGpfCxdSkeh`. Audit of 33 live pages at 1440 and 375 px: 0 overflow, 0 text under 12 px,
  0 console errors.

## Web deploy, 2026-11-11 13:34 to 13:40 UTC (owner: "deploy jika sudah aman")

- orreryagent.com now serves build/v1 1d6ef81 (Vercel `dpl_9uQ7MCQKvi4KDHBrHZiB2vntpQ1X`, orrery-bctzdje12). Built from a
  clean worktree with `vercel deploy --prod --skip-domain`, then `vercel promote`. Rollback target: the previous
  production deployment `dpl_F6Wp7tJGmurTqB28vgL2kshZ9GCw` (orrery-91x4o7hea, 1af25bb), `vercel rollback` or promote it.
  The API, indexer and release switch are untouched (only `core` open); no env variable was added (`ORRERY_TRADE_LINKS`
  is unset, so the Pons default applies).
- In this release (445934f, 267853c, 1e4ece4, 1d6ef81; nothing else changed under `services/packages/web`, `sdk` or
  `shared` since 1af25bb): the operator workspace in Dashboard, Agents with one-click account, agent and signer; the
  standalone Operator and Credits pages removed, `/operator` and `/credits` redirect into the dashboard; site nav Home,
  Dashboard, Signer lookup, Docs; "Trade on Pons" beside the CA pill; payer lookup by transaction hash; the signed check
  tool and public price list in Dashboard, Credits; Docs and the landing name the published `@orrery-tech/sdk` (0.1.0).
- Before the promote: services typecheck, web lint, unit tests 28 passed, next build; `scripts/walk/operator-setup.mjs`
  on an anvil fork of 4663 with the real v1 contracts, 12 steps done; `check-core-4663.ts` on mainnet, all 18 passed.
  The staged deployment sits behind Vercel Authentication, so it was not opened before the promote.
- Checked on the live site without a wallet, at desktop width and 375 px: `/operator` and `/credits` answer 307 into the
  dashboard with the query string kept; `/api/ca` answers the CA and the Pons link; the hero shows the CA pill and the
  button with the Pons mark; the Credits connect screen lists the prices from the live API; 15 routes answer 200; no
  horizontal overflow; Docs shows `pnpm add @orrery-tech/sdk viem`. Not exercised on mainnet with a funded wallet:
  creating an account, registering an agent and opening a session from the live page (fork only).

## Live walk of the operator flow on mainnet, 2026-11-11 14:04 to 14:22 UTC (owner typed CONFIRM for each run)

First run of the whole core loop on 4663 from the live site, with the walk wallet as operator
(`services/scripts/walk/operator-live-4663.mjs`, wallet requests gated by `guarded-wallet.mjs`).

- Funding (owner, CONFIRM): `fund-roles-4663.ts --roles walk --target 0.0004` and `fund-usdg-4663.ts --to walk --usdg 7.2`
  (about 0.00352 ETH through the Uniswap V2 router). Deployer after both: 0.00681 ETH.
- From orreryagent.com/dashboard/agents: account (Safe 1.4.1 with the Safe7579 adapter and the policy module)
  `0xE40b3C7c5fFb16d2dD849905f1efEE1ef43e3628` in two transactions, ERC-8004 agent **#25431**, identity bound, signer
  `0x35de05B6a78A58c49e2A5c656bd29AF9F8470819` created on the page, session opened from the Small preset (1 / 10 / 5 USDG,
  expiry 2026-12-11), 1 USDG added to the account, 0.0002 ETH sent to the signer, verification paid (5 USDG; `isVerified` true).
- The agent, from the saved key file through the SDK: top-up of 0.5 USDG through the module, tx
  `0xb40c130c5086ba3ae06976bdb9e88a634c81c7413a927b4a1183ff6ef8c9e64e` (block 111,765,163, gas 165,083); a top-up above the
  float ceiling is refused before anything is sent.
- Public record `/signer/0x35de…0819`: Active, agent #25431, its account and owner. Dashboard, Credits with the same wallet:
  sign-in, API key issued, a signed check of the new signer verified in the browser (Session Active, "USDG today 0.50 of
  10.00, per payment 1.00", check signer 0x4Cfc…E117), and one credit pack bought over x402 from the dashboard (1 USDG,
  balance 500 credits). Policy refusals: none. Console errors: none.
- Left on mainnet as the walk wallet's own: the account with 0.5 USDG, the signer with 0.5 USDG and its ETH, the session.
  Walk wallet `0x2d8D41Ff24caC608DCf8a9080b15FA908e6b7788`: 0.2 USDG, 0.00017 ETH. Spent in all: 6 USDG to Orrery's own
  attestor and treasury, about 0.000026 ETH of gas. Keys: `~/.secrets/orrery/mainnet-walk-agent.env`,
  `mainnet-walk-api.json` (backed up, indexed).

Found by this walk:

1. **The agent's RPC could not publish transactions.** `https://rpc-robinhood.blockmachine.io` (the web's read endpoint)
   answers `eth_sendRawTransaction` with "publishing transactions not supported by this endpoint". It was the RPC the
   dashboard wrote into every agent key file and the default of the SDK (`@orrery-tech/sdk` 0.1.0), so an agent using either
   failed on its first top-up. Fixed in the tree: `AGENT_RPC_URL` in `packages/web/lib/config.ts` and
   `ORRERY_MAINNET.rpcUrl` in `packages/sdk/src/quick.ts` are `https://robinhood-rpc.publicnode.com`, which published every
   transaction of this walk. The walk's key file had its RPC line changed by hand to match. Until the web is redeployed the
   live dashboard still writes the old RPC; the published SDK needs 0.1.1.
2. Two faults of the walk's own tooling, fixed before the next run and never the site's: with two RPCs behind a fallback a
   mined transfer was reported as failed ("nonce too low" from the second node), and the policy's ABI for `payVerification`
   had the wrong integer width. Rehearsed on a fork of the then-current mainnet state before the owner's next CONFIRM.

## Web deploy, 2026-11-11 14:24 to 14:27 UTC (owner: "Ya, commit dan deploy")

- orreryagent.com now serves build/v1 92fba30 (Vercel `dpl_CCWdj72yQ78snXNVH8Y9gVHq6qYc`, orrery-b1ho761e6), built from a clean
  worktree with `vercel deploy --prod --skip-domain` and promoted. Rollback target: `dpl_9uQ7MCQKvi4KDHBrHZiB2vntpQ1X`
  (orrery-bctzdje12, 1d6ef81). Only 3a15ddb changed the web since 1d6ef81: agent key files carry an RPC that publishes
  transactions. API, indexer, release switch and Vercel env untouched (`NEXT_PUBLIC_AGENT_RPC_URL` unset, the default applies).
- Checked on the live site: a throwaway wallet that may sign and send nothing opened an agent without a session, created a
  signer on the page and downloaded the key file; it reads `ORRERY_RPC_URL=https://robinhood-rpc.publicnode.com`, chain 4663
  and the v1 module (the file and the throwaway key were deleted). Nine routes answer as before, `/operator` and `/credits`
  redirect into the dashboard, no console errors.
- Still open: `@orrery-tech/sdk` 0.1.0 on npm keeps the old default RPC until 0.1.1 is published (prepared on
  `sdk/npm-publish`, the owner publishes). A key file saved from the dashboard before this deploy has the old RPC line.
