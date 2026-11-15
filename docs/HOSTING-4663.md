# Hosting Orrery on 4663

> **Orrery note (2026-11-15):** this document records Runcore's own run, from the codebase Orrery was copied from,
> with the names switched to Orrery's by the rename pass. Orrery itself has no deployment, keys, X or Discord account
> yet; addresses, ids and dates below are Runcore's and serve only as a worked example of the procedure.


Internal runbook. Prepared 2026-11-09; nothing is running yet. Services go up only when the owner says deploy, after
`deploy-4663.ts` (and later `deploy-orry-4663.ts`) have written `deployments/4663.json` and `deployments/orry-4663.json`.

## 0. Go-live script (2026-11-10)

`services/scripts/go-live-4663.ts` runs sections 3, 3b and 4 below as stages: `env`, `server`, `dns`, `vercel`, `discord`,
`check`. Each mainnet stage prints what it will do and waits for a typed CONFIRM; `--dry-run` sends nothing. Launch day
after the owner funds the wallets: `deploy-4663.ts`, then `go-live-4663.ts server`, `dns`, `vercel`, `discord`, `check`;
after ORRY graduates on Pons: `deploy-orry-4663.ts --orry <token> --seed-eth <ETH> --seed-usdg <USDG>` (the seed
needs that ETH and USDG plus the matching ORRY on the deployer; Earn stays closed on the web until a pool is seeded,
review M-3), `go-live-4663.ts server` again (adds the ORRY
addresses and the keeper), `vercel`; 48 hours later `deploy-orry-4663.ts --execute-coin`. Wave R1 markets, when their wave comes: `deploy-markets-4663.ts`
(stock list in `ops/markets-4663.json`; keys `mainnet-market-keeper` and `mainnet-reveal-relay` need gas), then
`go-live-4663.ts server` and `vercel` again (adds the market keeper, the reveal relay and the factory address). Wave 3
merchant payments, after the markets (the splitters read stake discounts from the markets' FeeTiers):
`deploy-facilitator-4663.ts` (MerchantSplitterFactory at 0.2%, X402Permit2Proxy on the canonical Permit2; no owner,
nothing to configure after), then `go-live-4663.ts server` and `vercel` again (adds `ORRERY_SPLITTER_FACTORY`,
`ORRERY_X402_PERMIT2_PROXY`, `ORRERY_FEE_TIERS` and `NEXT_PUBLIC_SPLITTER_FACTORY`); the routes stay 404 until the
`facilitator` release opens, ORRY payments until `orry-x402`, the directory until `merchant-badge`.

Rehearsed end to end on 2026-11-10 on an anvil fork of 4663 (`--fork`: same compose.yml in local Docker, development
keys): v1 deploy, a real Pons launch to graduation, the ORRY deploy (26 read-backs ok), executeCoin after 48 hours,
the stack (API, indexer at lag 0, prober, keeper), every release held, then opened in launch order. Walks on the web
against it, with the real USDG and the Pons ORRY: 17 pages, a credit pack over x402 (1 USDG to the treasury, 500
credits), a pack and an agent verification paid in ORRY (625 credits; agent #1 verified), pay per check (6 credits),
Stake, Earn deposit, an unstake request, a 50% Earn withdraw, and the plain withdraw on day 7. `dns` and `discord` ran
as dry runs (the zone has no `api` record yet). Fork notes: fork through the official RPC (other endpoints keep no older
state; the official name is DNS-blocked on some ISPs, so reach it by IP), anvil with `--hardfork cancun` (the EIP-2935
blockhash contract otherwise needs state the RPC has dropped), role wallets funded on the fork, and walks with
`WALK_RPC`, `WALK_CHAIN=4663`, `WALK_CHAIN_CLOCK=1` so the page clock follows the moved chain time.

## 1. What runs where

| Piece | Where | How |
| :--- | :--- | :--- |
| Web (Next.js) | Vercel Hobby, project root `services/packages/web`, domain `orrery.tech` | `vercel deploy --prod` from the repo |
| API | server 1, container `orrery-api`, shared edge alias `orrery-api`, `api.orrery.tech` | `ops/server1/compose.yml` |
| Indexer (v1 + ORRY) | server 1, `orrery-indexer`, health on `127.0.0.1:18788` (lag against the head) | same |
| Prober (endpoint attestations, every 6 h) | server 1, `orrery-prober` | same |
| Keeper (hourly collect, distribute, buyback slices) | server 1, `orrery-keeper`, compose profile `orry` | same, only once ORRY is deployed |
| Postgres 17 | server 1, `orrery-pg`, volume `orrery-pg` | same |

## 2. RPC (workspace rule 7)

Measured 2026-11-09 from server 1, Node 24 in a container:

- 4663 block time 101 ms (859,068 blocks a day).
- `rpc.mainnet.chain.robinhood.com`: 10,000-block `eth_getLogs` answered in about 260 ms, 40 sequential calls 40 ok, no
  Cloudflare challenge this time (one was seen on 2026-10-10). Logs per query capped at 10,000, far above our contracts.
- `rpc-robinhood.blockmachine.io` keyless: only the most recent 5,000 blocks for `eth_getLogs`, fine at the head;
  CORS open, so it is also the web's default browser RPC.
- `robinhood-rpc.publicnode.com`: archive needs a token; `robinhood.api.pocket.network`: declines logs;
  `rpc-robinhood.globalstake.io`: timed out.

Load at the head: the v1 indexer makes 2 calls per 2 s loop and the ORRY indexer 3, about 216,000 calls a day, plus
API reads (cached), sampler, prober and keeper. That suits a free endpoint. `ORRERY_RPC_URL` takes a comma list
(`chain.ts`, viem fallback): official first, blockmachine second. If the official endpoint starts throttling, the
indexer health goes red on lag; then move to a request-priced provider (never a compute-unit one: `eth_getLogs` is 75
CU there). No keyed URL is ever placed in the web's `NEXT_PUBLIC_RPC_URL`.

## 3. Server 1 steps (after the v1 deploy)

1. Copy the hot keys, never from a repository:
   `ssh server1 'install -d -m 700 /opt/orrery/secrets'`, then `scp` from `~/.secrets/orrery/`:
   `mainnet-relayer.json`, `mainnet-check-signer.json`, `mainnet-attester.json`, `mainnet-quote-signer.json`,
   `mainnet-keeper.json` (mode 600). The deployer key stays on the laptop.
2. `openssl rand -hex 24 > /opt/orrery/secrets/pg-password` (600).
3. Copy `ops/server1/` to `/opt/orrery/`, fill `common.env` and `api.env` from the `.example` files with the
   addresses the deploy scripts print, and the pg password in `ORRERY_DATABASE_URL`.
4. Build the image on server 1 from the commit: `docker build -f ops/server1/services.Dockerfile -t orrery-services:<commit> services`,
   write `TAG=<commit>` to `release.env`.
5. `docker compose -p orrery-mainnet --env-file release.env -f compose.yml up -d postgres api indexer prober`.
6. Seed the release switch with every wave held: `releases.ts set <feature> null` for each feature, inside the api container:
   `docker exec orrery-api /app/node_modules/.bin/tsx /app/scripts/releases.ts set <feature> null`, then `... releases.ts list`.
7. DNS: A record `api.orrery.tech` to 187.53.130.188 (Hostinger API token, `orrery.tech` zone). Append
   `Caddyfile-block` to `/opt/phioradata/infra/Caddyfile` and reload from a `docker cp` copy (stale bind mount trap).
8. Check: `curl -s 127.0.0.1:18788` shows lag near 0; `https://api.orrery.tech/health` answers; `/v1/releases` shows all held.

After the ORRY deploy: fill the `ORRERY_ORRY_*` values, recreate api and indexer, then
`docker compose ... --profile orry up -d keeper` once the keeper wallet holds gas.

## 3a. Discord upkeep before launch (running since 2026-11-09)

`orrery-pg` and `orrery-discord` run on server 1 from `ops/server1/compose.prelaunch.yml` (project `orrery-mainnet`,
subnet 10.232.9.0/24 because the default address pools are used up). Without contract addresses the Discord process runs
the upkeep only, every 10 minutes: Discord's booster role styled with its perks, private #boosters with its pinned
welcome, feature rooms hidden until their release opens. The full `compose.yml` takes over the same container, volume
and network names at launch. Release opening for the builder rooms at T0: `releases.ts set core now`.

## 3b. Discord (stage 1 and 2)

1. Copy `~/.secrets/orrery/discord-bot.txt` to `/opt/orrery/secrets/` (600). Reset the token first if it was ever pasted
   in a chat, and save the new one with `ops/save-discord-token.sh`.
2. Fill `discord.env` from `discord.env.example`, then `docker compose ... --profile discord up -d discord` and recreate `api`.
3. In the Developer Portal set **Interactions Endpoint URL** to `https://api.orrery.tech/v1/discord/interactions`
   (Discord sends a signed PING; the API answers it only with the right public key).
4. Slash commands: `node ops/discord/register-commands.mjs 1569247955108630598 1569204585011220480` (done 2026-11-09:
   /payer, /agent, /orry, /verify).
5. Release posts are reviewed before they go out: an hour before a release opens, its card (image and caption from
   `ops/discord/cards/`, copied to `/opt/orrery/cards`) goes to the private #release-drafts; Admin or Core Team posts it
   to #announcements with `/announce <feature>` (before the API is live: `node ops/discord/announce.mjs <guild> <feature>`
   after the owner approves). At the release hour the rooms that feature opens unlock for members
   (`ops/discord/rooms.mjs`, same map as `ROOM_RELEASES`). The notifier also posts burns to #burn-tracker and alerts (indexer lag, low gas on the
   watched wallets, once per six hours each) to #alerts. `/verify` links a wallet through `orrery.tech/discord/verify`
   and gives Verified, ORRY Holder, Operator and Merchant; roles are re-checked every six hours.

## 4. Vercel steps (after the v1 deploy)

1. `vercel link` in the repo root, new project `orrery`, root directory `services/packages/web`, framework Next.js
   (the pnpm workspace is in `services/`).
2. Production env: `NEXT_PUBLIC_CHAIN_ID=4663`, `NEXT_PUBLIC_API_URL=https://api.orrery.tech`,
   `NEXT_PUBLIC_MODULE`, `NEXT_PUBLIC_ATTESTOR`, `NEXT_PUBLIC_LENS`, `NEXT_PUBLIC_REGISTRY` from `deployments/4663.json`;
   ORRY addresses after the ORRY deploy. `NEXT_PUBLIC_RPC_URL` stays unset (keyless default).
   `ORRERY_CA=0x85272EA3aE8685C768045dba5455fE305C706aA4` is the ORRY token for the hero's CA pill: a server-side variable (no `NEXT_PUBLIC_` prefix),
   read by `/api/ca` at request time; already needed now that ORRY is live on Pons (`ORRY-DEPLOY-4663.md` section 0).
3. `vercel deploy --prod`, then add `orrery.tech` and `www.orrery.tech` to the project and point DNS at Vercel.
4. Hard gate before T0: on the live domain every route's header X button links to `https://x.com/OrreryHQ` and
   `twitter:site` is `@OrreryHQ`.
5. First-visit walk on mainnet from the landing with a fresh wallet.

## 5. Wallets that need gas

| Wallet | Address | Why |
| :--- | :--- | :--- |
| deployer | `0x006dAF2633C8d87001D13F7F5D7ed7d432cF1A3A` | v1 deploy (about 0.0002 ETH), ORRY deploy (about 0.0004 ETH) |
| relayer | `0x21f7536E49Ffc5CbfFd7b976A0c73f3A0BC2C6C0` | x402 settlements |
| attester | `0xe0444a010EbAdb445aD75629E20c4C0149724eC0` | attestations from the prober |
| keeper | `0x1241C83501E865c86613c715bE40A60Be455075F` | hourly ORRY keeper passes |
| quote signer | `0x649D742f59fc1FbFD03C21f8c00220B49eD22521` | signs quotes only, no gas |
