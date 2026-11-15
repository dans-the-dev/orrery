# Orrery incident runbook (Robinhood Chain 4663)

Internal engineering document, written 2026-11-09. Setup and deploy steps live in `HOSTING-4663.md` and
`MAINNET-4663.md`; this file covers what to do when something breaks. Server 1 is SSH alias `server1`
(187.53.130.188), shared with other live projects.

State on 2026-11-09: the web is live on Vercel; on server 1 only `orrery-pg` and `orrery-discord` run, from
`/opt/orrery/compose.prelaunch.yml`. API, indexer, prober and keeper start after the mainnet deploy, from
`/opt/orrery/compose.yml`. Sections that need those services say so.

## 0. Quick reference

| Piece | Where | Health | Logs |
| :--- | :--- | :--- | :--- |
| Web | Vercel, project `orrery`, `orrery.tech` | `curl -sI https://orrery.tech/` | Vercel dashboard, `vercel logs` |
| API | `orrery-api`, behind `infra-caddy-1` as `api.orrery.tech` | `curl -s 127.0.0.1:18787/health` on server 1 | `docker logs orrery-api` |
| Indexer | `orrery-indexer` | `curl -s 127.0.0.1:18788` on server 1 (lag against the live head) | `docker logs orrery-indexer` (a failing step at most once a minute) |
| Prober | `orrery-prober`, every 6 h | its attestations on chain | `docker logs orrery-prober` |
| Keeper | `orrery-keeper`, hourly, compose profile `orry` | one JSON line per pass | `docker logs orrery-keeper` |
| Discord | `orrery-discord` | running, up more than 2 min | `docker logs orrery-discord` |
| Postgres | `orrery-pg`, volume `orrery-pg`, network `orrery-mainnet_data` (no host port) | `docker exec orrery-pg pg_isready -U orrery` | `docker logs orrery-pg` |

Compose, always from `/opt/orrery` and always with the project name:

```bash
cd /opt/orrery
# before the deploy
docker compose -p orrery-mainnet --env-file release.env -f compose.prelaunch.yml ps
# after the deploy (add --profile orry for the keeper, --profile discord for the Discord process)
docker compose -p orrery-mainnet --env-file release.env -f compose.yml ps
```

Never on server 1: stop any `orvyn-mainnet-*` container (Signalith's live backend) or `vanitypad-mainnet-wa-1` (the
WhatsApp alert gateway, also used by Oraqle); run `caddy reload --config /etc/caddy/Caddyfile` (stale bind mount, it
loads an October config and drops every newer site); run a bare `docker compose up -d` in another project's folder.

Alerts reach the team two ways:

- **WhatsApp**, from the uptime monitor `uptime-wa@orrery` (section 1): one message after 2 failing runs in a row
  (15 to 30 min after an outage starts), one when it passes again. It covers the web, the API, indexer lag, the
  containers, the keeper's last pass, the daily dump's age and relayer, attester and keeper gas.
- **Discord #alerts**, from the Discord process once the contracts are configured: indexer lag against the live chain
  head (a `chain-head` alert when the head cannot be read) and low gas on the watched wallets, at most once per six
  hours each.

Wallets (`HOSTING-4663.md` section 5; floors are `ORRERY_DISCORD_WATCH` in `discord.env`, and the WhatsApp gas
checks in `targets.json` use the same floors):

| Wallet | Address | Gas | Alert below |
| :--- | :--- | :--- | :--- |
| deployer (attestor owner, treasury owner) | `0x006dAF2633C8d87001D13F7F5D7ed7d432cF1A3A` | admin calls only | not watched |
| relayer | `0x21f7536E49Ffc5CbfFd7b976A0c73f3A0BC2C6C0` | x402 settlements, ~85,400 gas each | 0.0001 ETH |
| attester | `0xe0444a010EbAdb445aD75629E20c4C0149724eC0` | attestations, ~60,000 gas each | 0.0001 ETH |
| keeper | `0x1241C83501E865c86613c715bE40A60Be455075F` | hourly ORRY passes | 0.001 ETH |
| check signer | `0x4Cfc9f92BA05af4e7C8cb8E80416B5c7D370E117` | none, signs off chain | not watched |
| quote signer | `0x649D742f59fc1FbFD03C21f8c00220B49eD22521` | none, signs off chain | not watched |

Funds move only on the owner's word: every transfer or admin transaction below is shown to the owner as a summary
first and sent only after the owner confirms.

## 1. Monitoring and backups (installed 2026-11-09)

### 1.1 Uptime monitor

Files: `/opt/uptime-monitor/orrery/` (repo copy `ops/server1/uptime/`). Timer `uptime-wa@orrery.timer`, every
15 min at `*:07/15`, shared runner `/opt/uptime-monitor/bin/uptime-run.mjs`, alerts through `vanitypad-mainnet-wa-1`.
The drop-in `/etc/systemd/system/uptime-wa@orrery.service.d/host-probe.conf` runs `host-probe.mjs` on the host first:
it writes `probe/host.json` with the container states, the indexer health answer, the newest dump in
`/opt/orrery/backups` and the keeper's last logged pass, which the check container cannot read itself.

| Check | Stage | Passes when |
| :--- | :--- | :--- |
| web / | prelaunch | `https://orrery.tech/` answers 200 and contains `orrery` |
| web /discord/verify | prelaunch | 200 and contains `Verify your wallet.` |
| discord container | prelaunch | `orrery-discord` running, not restarting, up at least 120 s |
| api /health | launch | `https://api.orrery.tech/health` gives `ok: true`, `chainId: 4663` |
| api /v1/releases | launch | 200 with `serverTime` and `releases` |
| database backup | prelaunch | the newest dump in `/opt/orrery/backups` is at most 26 h old |
| indexer lag | launch | indexer health 200 with `ok: true`, and its cursor within 600 blocks (about a minute) of the live head read from the official RPC and blockmachine (the higher answer); the ORRY cursor within 610 |
| prober container | launch | `orrery-prober` running, up at least 120 s |
| relayer gas | launch | `0x21f7…C6C0` holds at least 0.0001 ETH (first RPC that answers) |
| attester gas | launch | `0xe044…4eC0` holds at least 0.0001 ETH |
| keeper container | orry | `orrery-keeper` running, up at least 120 s |
| keeper last pass | orry | the keeper logged a pass in the last 75 min (it passes hourly) |
| keeper gas | orry | `0x1241…075F` holds at least 0.001 ETH |

`targets.json` holds `"stage": "prelaunch"`, so the launch and orry checks are held (the relayer, attester and
keeper hold no ETH yet and would alert at once). Turn the launch checks on once the API answers, the indexer is near
the head (`HOSTING-4663.md` section 3, step 8) and the relayer and attester are funded, not before, or the first runs
alert:

```bash
ssh server1 "sed -i 's/\"stage\": \"prelaunch\"/\"stage\": \"launch\"/' /opt/uptime-monitor/orrery/targets.json && systemctl start uptime-wa@orrery.service && journalctl -u uptime-wa@orrery.service -n 15 --no-pager -o cat"
```

After the ORRY deploy, once the keeper runs and holds gas:

```bash
ssh server1 "sed -i 's/\"stage\": \"launch\"/\"stage\": \"orry\"/' /opt/uptime-monitor/orrery/targets.json && systemctl start uptime-wa@orrery.service && journalctl -u uptime-wa@orrery.service -n 20 --no-pager -o cat"
```

Make the same edit in `ops/server1/uptime/targets.json` so the repo copy matches. To see what a later stage would
say before turning it on (runs the check directly; no state change, no message; `CHECK_STAGE=orry` for the keeper):

```bash
ssh server1 'node /opt/uptime-monitor/orrery/host-probe.mjs /opt/uptime-monitor/orrery && docker run --rm --memory 128m --network vanitypad-mainnet -e CHECK_STAGE=launch -v /opt/uptime-monitor/orrery:/opt/uptime-monitor/orrery:ro node:24-alpine node /opt/uptime-monitor/orrery/check-live.mjs'
```

One WhatsApp test message (marked TEST, state untouched) proves the whole alert path; one was sent 2026-11-09 and the
gateway accepted it:

```bash
ssh server1 'docker run --rm --memory 128m --network vanitypad-mainnet -v /opt/uptime-monitor/bin:/opt/uptime-monitor/bin:ro -v /opt/uptime-monitor/orrery:/opt/uptime-monitor/orrery -v /opt/uptime-monitor/secrets/wa-token:/secrets/wa-token:ro node:24-alpine node /opt/uptime-monitor/bin/uptime-run.mjs /opt/uptime-monitor/orrery --test'
```

Operate:

```bash
systemctl list-timers 'uptime-wa@*'                       # next and last run
journalctl -u uptime-wa@orrery.service -n 30 --no-pager  # one line per pass, the full table on a failure
cat /opt/uptime-monitor/orrery/state/state.json          # fails in a row, down or not
systemctl start uptime-wa@orrery.service                 # one run now, through the same state
systemctl stop uptime-wa@orrery.timer                    # planned maintenance; start it again afterwards
```

If alerts stop arriving with HTTP 401 in the journal, the gateway was recreated with a new token: see memory note
`reference_uptime_wa_monitors.md` (re-copy `/opt/uptime-monitor/secrets/wa-token`).

The monitor runs on server 1 itself, so a full server 1 outage sends nothing. The web check still covers Vercel.

### 1.2 Database backup

`orrery-pg-backup.timer` runs `/usr/local/bin/orrery-pg-backup` daily at 03:47 UTC (repo copy
`ops/server1/backup/`): `pg_dump -Fc` inside `orrery-pg` over the local socket (no password used), checked with
`pg_restore --list`, mode 600, into `/opt/orrery/backups/orrery-<UTC time>.dump`; 14 days kept, pruned only after
a successful dump. Same disk as the database: it covers a bad change or a deletion, not the loss of server 1. The
WhatsApp check `database backup` alerts when the newest dump is older than 26 h.

Off-server copy (owner's choice 2026-11-09: the Fedora laptop): the user timer `orrery-backup-pull.timer` in
`~/.config/systemd/user/` (repo copy `ops/server1/backup/orrery-backup-pull.{service,timer}`) pulls every finished dump
not yet copied with `rsync -a --ignore-existing` over SSH into `~/Backups/orrery-db` (folder 700, files 600) and
keeps 30 days. It runs daily at 11:30 WIB (04:30 UTC), 5 min after each login and at the next start after a missed
run; it runs only while the laptop is on Fedora, and server 1's 14 days cover the gaps. It is a pull, so server 1
holds no credential for the laptop. First copy 2026-11-09, sha256 equal to the server's dump.

```bash
systemctl --user list-timers orrery-backup-pull.timer --no-pager
systemctl --user start orrery-backup-pull.service && journalctl --user -u orrery-backup-pull.service -n 3 --no-pager -o cat
ls -l ~/Backups/orrery-db/
```

To restore from a laptop copy when server 1 has none, send the newest one back (or name an older file), then follow
section 8 (with no other dump there, it is the one `DUMP` picks):

```bash
scp -p "$(ls -1t ~/Backups/orrery-db/orrery-*.dump | head -1)" server1:/opt/orrery/backups/
```

```bash
systemctl list-timers orrery-pg-backup.timer --no-pager
journalctl -u orrery-pg-backup.service -n 5 --no-pager -o cat   # last line: file, bytes, tables, dumps kept
systemctl start orrery-pg-backup.service                        # one dump now
orrery-pg-restore-test                                          # restore the newest dump into a throwaway container
```

`orrery-pg-restore-test [file]` starts `orrery-pg-restoretest` (no network, 256 MB), restores, prints the exact row
count of every table next to the live count, and removes the container and its volume on exit. First run,
2026-11-09: 27 tables restored, 0 missing, counts equal (`discord_posts` 4, `schema_migrations` 6, the rest empty
before launch).

## 2. The web is down (orrery.tech)

Signal: WhatsApp `web /` or `web /discord/verify` FAIL.

1. From the laptop: `curl -sI https://orrery.tech/ | head -3` and `dig +short @1.1.1.1 orrery.tech` (expected
   `76.76.21.21`; `www` is a CNAME to `cname.vercel-dns.com`). Ask 1.1.1.1: the laptop's ISP resolver rewrites
   missing names to its own addresses.
2. Vercel answers 5xx, or the page lost its content after a deploy: roll back, then fix forward.

   ```bash
   cd ~/Projects/blockchain/orrery
   vercel ls orrery -e production --status READY      # table on stderr, URLs on stdout, newest first
   PREV=$(vercel ls orrery -e production --status READY 2>/dev/null | sed -n 2p)
   echo "$PREV" && vercel rollback "$PREV"
   ```

   Project `dandiapriandimamonto-1782/orrery`.

3. DNS answer wrong or missing: the `orrery.tech` zone is on Hostinger (API token, memory note
   `feedback_hostinger_api_for_dns.md`, never hPanel). Restore the apex A record to `76.76.21.21` and `www` to
   `cname.vercel-dns.com`; check the domain has not expired.
4. Vercel itself is down (https://www.vercel-status.com): nothing to change; the API on server 1 keeps serving
   integrators and on-chain limits keep holding.
5. Only server 1 sees the failure (the laptop and 1.1.1.1 are fine): server 1's resolver or egress; the site is up.
   Check with `docker run --rm curlimages/curl -sI https://orrery.tech/`.

Pages that render but show no live data point at the API (section 3).

### 2.1 Change the CA shown on orrery.tech

The hero's CA pill (`components/ContractAddress.tsx`) shows the ORRY token from `/api/ca`, which reads the Vercel
production env `ORRERY_CA` at request time (cached 60 s at the edge). Since 2026-11-10 it is
`0x85272EA3aE8685C768045dba5455fE305C706aA4` (Pons launch, `ORRY-DEPLOY-4663.md` section 0). An unset or invalid
value (wrong length, or mixed case with a wrong checksum) hides the pill instead of showing a wrong address. To change
it, set the variable and rebuild the current production deployment from the same source, no code change:

```bash
cd ~/Projects/blockchain/orrery/services
export VERCEL_ORG_ID=team_wRfsbfi0dD9R8aLIlSrQAvRX VERCEL_PROJECT_ID=prj_eBjksRcLg5Q0qQSYIkNUM44XTird
vercel env rm ORRERY_CA production --yes
printf '%s' 0x85272EA3aE8685C768045dba5455fE305C706aA4 | vercel env add ORRERY_CA production
vercel redeploy "$(vercel ls orrery -e production --status READY 2>/dev/null | sed -n 1p)"
curl -s https://orrery.tech/api/ca      # {"ca":"0x85272EA3aE8685C768045dba5455fE305C706aA4"} within a minute
```

## 3. The API is down (api.orrery.tech)

After the deploy only. Path: internet, `infra-caddy-1` (block `api.orrery.tech` in
`/opt/phioradata/infra/Caddyfile`), `orrery-api:8787` on network `infra_default`, then `orrery-pg`.

While the API is down, signed checks, credit purchases (x402 settlement), the release schedule and `/verify` in
Discord stop. Limits on chain keep being enforced by OrreryPolicyModule.

1. `docker ps -a --filter name=orrery- --format '{{.Names}}\t{{.Status}}'`
2. `curl -s 127.0.0.1:18787/health` on server 1 (skips Caddy).
   - Fails: container side, step 3.
   - Answers: edge side, step 4.
3. Container side:
   - `docker logs --tail 100 orrery-api`; `docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}}' orrery-api`
     (limit 384 MB).
   - Postgres down or unhealthy: start it first (`cd /opt/orrery && docker compose -p orrery-mainnet --env-file release.env -f compose.yml up -d postgres`), then the API.
   - Start again: `cd /opt/orrery && docker compose -p orrery-mainnet --env-file release.env -f compose.yml up -d api`
   - A bad release: go back to the previous image, which stays on the server.

     ```bash
     cd /opt/orrery
     docker images orrery-services --format '{{.Tag}}\t{{.CreatedAt}}'      # newest first
     PREV=$(docker images orrery-services --format '{{.Tag}}' | sed -n 2p)
     cp release.env release.env.bak-$(date -u +%Y%m%dT%H%MZ) && echo "TAG=$PREV" > release.env
     docker compose -p orrery-mainnet --env-file release.env -f compose.yml up -d api indexer prober
     ```

4. Edge side:
   - DNS: `dig +short @1.1.1.1 api.orrery.tech` must be `187.53.130.188`.
   - Caddy reaches the API: `docker exec infra-caddy-1 wget -qO- http://orrery-api:8787/health`.
     If not, check the alias: `docker inspect -f '{{json .NetworkSettings.Networks.infra_default.Aliases}}' orrery-api`
     must list `orrery-api`; fix with
     `docker network disconnect infra_default orrery-api && docker network connect --alias orrery-api infra_default orrery-api`.
   - Caddy lost the site (another session reloaded from the stale mount): confirm the block is in the host file
     (`grep -n api.orrery.tech /opt/phioradata/infra/Caddyfile`), then reload from a copy, the only safe way:

     ```bash
     docker cp /opt/phioradata/infra/Caddyfile infra-caddy-1:/tmp/Caddyfile.current
     docker exec infra-caddy-1 caddy reload --config /tmp/Caddyfile.current --adapter caddyfile
     ```

     Other sessions edit that file too: re-read it right before any edit.

## 4. The indexer lags

After the deploy only. Judge the indexer by its lag against the live chain head, never by whether a backfill
finished. 600 blocks is about a minute at 101 ms per block.

- `curl -s 127.0.0.1:18788` gives `{ok, head, last, lag, orry: {ok, last, lag}}`. `head` is the live chain head the
  indexer reads (cached 3 s), so `lag` keeps growing when the cursor is stuck. HTTP 503 when the lag passes 600 blocks
  (the ORRY cursor gets `confirmations` on top) or when the head cannot be read (`head: null`). The Discord #alerts
  lag uses the same live head (since commit 6bee7c1).
- An independent reading from other RPC calls: `systemctl start uptime-wa@orrery.service; journalctl -u uptime-wa@orrery.service -n 12 --no-pager -o cat`
  (the monitor reads the head itself; the table shows `lag N blocks (head H)` or the failure), or by hand:

  ```bash
  curl -s 127.0.0.1:18788; echo
  curl -s -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' https://rpc.mainnet.chain.robinhood.com; echo
  ```

  Compare `last` with the hex head (`printf '%d\n' 0x...`).

Cause and action:

1. **Catching up after an outage.** The lag falls by up to 10,000 blocks per loop. That is progress: leave it running
   and watch the lag fall; do not restart it.
2. **RPC throttled or down.** `head: null` in the health answer means the indexer cannot read the chain. The indexer
   retries every 5 s and logs a failing step at most once a minute, with URLs replaced by `[url]`:
   `docker logs --since 15m orrery-indexer | grep 'indexer step failed'`. Test the endpoints from server 1:

   ```bash
   for u in https://rpc.mainnet.chain.robinhood.com https://rpc-robinhood.blockmachine.io; do
     curl -s -m 10 -o /dev/null -w "$u %{http_code} %{time_total}s\n" -H 'content-type: application/json' \
       --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$u"
   done
   ```

   If the official endpoint throttles or shows a Cloudflare challenge, put blockmachine first in `ORRERY_RPC_URL`
   in `/opt/orrery/common.env` and recreate the services that read it
   (`cd /opt/orrery && docker compose -p orrery-mainnet --env-file release.env -f compose.yml up -d --force-recreate api indexer prober`, adding `--profile orry` and `keeper`,
   `--profile discord` and `discord` when they run). Blockmachine serves `eth_getLogs` for the most recent 5,000 blocks
   only: fine at the head, not for a backfill from further behind. If both fail for long, move to a request-priced
   provider (never compute-unit pricing, where `eth_getLogs` costs 75 CU); its keyed URL goes in `common.env` only,
   never in the web's `NEXT_PUBLIC_RPC_URL`.
3. **Loop stuck** (live head moves, `last` does not, RPCs answer): `docker restart orrery-indexer`. It resumes from
   `indexer_state`; inserts are idempotent.
4. **Container down or restarting**: `docker logs --tail 100 orrery-indexer`, OOM flag as in section 3, Postgres
   health.

While it lags: new verifications are not probed (the prober reads `VerificationPaid` from `chain_events`), ORRY
credit purchases are granted late, Discord role checks use old data. Nothing on chain is affected.

## 5. The keeper fails

After the ORRY deploy only (`--profile orry`). Signal: WhatsApp `keeper container` or `keeper last pass` (no pass
in 75 min) FAIL, or `keeper gas`. Each pass logs one line:
`{"at":…,"chainId":4663,"steps":[{"action":"collect|harvest|executeSlice|distribute|burnEth|buyWithQuote","status":"sent|skipped|failed","reason":…,"txHash":…}]}`,
or `"steps":[{"error":…}]` when the pass could not list its jobs (usually the RPC).

```bash
docker logs --since 3h orrery-keeper | tail -n 3
docker exec orrery-keeper /app/node_modules/.bin/tsx src/bin/keeper.ts --once --dry-run   # simulate one pass, send nothing
```

| What the log shows | Meaning | Action |
| :--- | :--- | :--- |
| `skipped`, `nothing to do` | normal | none |
| `skipped`, a revert name | the simulation reverts, so nothing was sent | normal for a cooldown; if every pass shows it while fees pile up, read the error in the contract |
| `failed`, insufficient funds or gas | keeper wallet empty | section 6 |
| `failed`, `reverted on chain` | sent and reverted, gas spent | look the tx up on the explorer; if it repeats, `docker stop orrery-keeper` to stop spending, then investigate |
| `error` in steps | RPC | section 4, step 2 |
| no line for more than 75 min | process hung | `docker restart orrery-keeper` |

A stopped keeper defers work (fee collection, harvests, buyback slices, distribution); the next pass picks it up.

## 6. Relayer, attester or keeper gas runs low

Signal: WhatsApp `relayer gas`, `attester gas` or `keeper gas` FAIL, Discord #alerts low gas, keeper `failed` steps, settlement failures (`broadcast_failed`), or `probe failed`
in the prober log.

Check (laptop or server 1):

```bash
for a in 0x21f7536E49Ffc5CbfFd7b976A0c73f3A0BC2C6C0 0xe0444a010EbAdb445aD75629E20c4C0149724eC0 0x1241C83501E865c86613c715bE40A60Be455075F; do
  echo "$a $(cast balance --ether $a --rpc-url https://rpc.mainnet.chain.robinhood.com)"
done
```

Effect when empty, and what to do after the top-up:

- **Relayer**: credit purchases fail before broadcast. The facilitator deletes the pending payment row and moves no
  USDG, so buyers can simply retry. Nothing to restart after the top-up.
- **Attester**: new and refreshed attestations fail (`probe failed`); existing ones expire after 7 days. After the
  top-up, `docker restart orrery-prober` runs a pass now instead of in up to 6 h.
- **Keeper**: passes fail and the work waits. After the top-up, `docker restart orrery-keeper` runs a pass now.

Top-up: the owner sends ETH on 4663 from the owner's own wallet. Sizing from `MAINNET-4663.md`: 0.0002 ETH covers
about 110 relayer settlements or 160 attestations at 0.02 gwei. Size the keeper from its recent passes (one tx per
`sent` step).

## 7. The Discord bot is down

Signal: WhatsApp `discord container` FAIL (not running, restarting, or up less than 2 min, which catches a crash
loop).

1. `docker logs --tail 50 orrery-discord`
2. Token rejected (401 from Discord): the owner resets the token in the Developer Portal; save it with
   `ops/save-discord-token.sh` on the laptop; copy it over and restart:

   ```bash
   scp ~/.secrets/orrery/discord-bot.txt server1:/opt/orrery/secrets/discord-bot.txt
   ssh server1 'chown 1000:1000 /opt/orrery/secrets/discord-bot.txt && chmod 600 /opt/orrery/secrets/discord-bot.txt && docker restart orrery-discord orrery-support'
   ```

   The containers run as uid 1000, so the token file stays owned by 1000 (owned by root, the bot logs EACCES and drops to
   `upkeep only`, seen 2026-11-11). After the deploy the API mounts the same token for interactions:
   `docker restart orrery-api` too.
3. Database errors: section 3 Postgres step, then restart the Discord process.
4. Start it again:
   - before the deploy: `cd /opt/orrery && docker compose -p orrery-mainnet --env-file release.env -f compose.prelaunch.yml up -d discord`
   - after: `cd /opt/orrery && docker compose -p orrery-mainnet --env-file release.env -f compose.yml --profile discord up -d discord`

While it is down: no welcomes, room upkeep, release drafts, burn posts or #alerts. `/verify` and the slash commands
are answered by the API (interactions endpoint), not by this container.

### 7.1 Support replies (#reply-queue)

Container `orrery-support` (compose profile `support`, image `SUPPORT_TAG` in `release.env`, settings in `support.env`,
keys in `secrets/support/`). It reads public Discord messages (gateway) and @OrreryHQ mentions (X, every 5 minutes),
drafts a reply with Claude from the live site and API, and:

- sends answers from the docs (`faq`) and greetings at once, at most 40 a day and 3 per author per hour, each shown in
  #reply-queue as "Sent automatically";
- leaves everything else in #reply-queue for an Admin or Core Team member: ✅ sends, ❌ skips, a reply to the post with
  new text replaces the draft, and ❌ on a sent item deletes the reply. Items that need the owner ping the Admin role at
  most every 15 minutes. Staff messages (Admin, Core Team, Moderator) and the TEAM rooms are never read.

| Problem | Fix |
|---|---|
| Logs `gateway closed 4014` | Message Content Intent is off: Developer Portal > OrreryBot > Bot > Privileged Gateway Intents; the process retries every 10 minutes by itself |
| Turn automatic replies off at once | set `ORRERY_SUPPORT_AUTO=` (empty) in `/opt/orrery/support.env`, then recreate (below); every draft then waits for ✅ |
| Change a limit | edit `support.env` (`ORRERY_SUPPORT_AUTO_MAX_DAY`, `..._AUTO_MAX_AUTHOR_HOUR`, `..._MAX_DRAFTS_DAY`), then recreate |
| Enable X | off since 2026-11-11 by the owner's choice (posts only, no reading of mentions or comments). To turn reading back on: the owner saves `~/.secrets/orrery/x-api.json` (`apiKey`, `apiSecret`, `accessToken`, `accessSecret`); copy it to `secrets/support/x-api.json` (600, `chown 1000:1000`), then recreate. The token must be OAuth 1.0a with `x-access-level: read-write` on `GET /2/users/me`; a token made while the app was Read only stays read only until it is regenerated. The first pass only records where to start (`x_since_id`, or `x_start_time` while the account has no mentions), so older mentions are not answered. X bills every read and post against the console balance; a 402 "credits depleted" in the log means the balance is empty |
| Swap the Anthropic key (Hypatia's key is in use until Orrery has its own) | the new key to `secrets/support/anthropic.env` as `ANTHROPIC_API_KEY=...` (600, `chown 1000:1000`), then `docker restart orrery-support` |
| Drafting fails (`Drafting failed` in the queue) | `docker logs --tail 50 orrery-support`; a 401 is the key, a 429 is the account's rate limit; items still reach the queue without a draft |

Recreate (a plain `restart` keeps the old environment):

```bash
ssh server1 'cd /opt/orrery && docker compose -p orrery-mainnet --env-file release.env -f compose.yml --profile support up -d --no-deps --force-recreate support'
```

Numbers for a day: `docker exec orrery-pg psql -U orrery -d orrery -c "select category, status, decided_by = 'auto' as auto, count(*) from support_items where created_at > now() - interval '1 day' group by 1, 2, 3 order by 1, 2"`.

## 8. The database needs a restore

Dumps: `/opt/orrery/backups/orrery-<UTC time>.dump`, daily, 14 days. A dump is one consistent snapshot: the
indexer cursors and the chain-derived tables (`chain_events`, `indexer_state`, `orry_*`) match, and the indexers
replay from the restored cursor.

Lost on restore, everything written after the dump in tables the chain does not hold: `payments`, `credit_accounts`
and `credit_grants` (x402 credit packs), `api_keys`, `key_nonces`, `probes`, `orry_quotes`, `discord_links`,
`discord_posts`, `discord_nonces`, `releases` and `releases_audit`.

1. Pick the dump, before taking any new one:

   ```bash
   ls -lt /opt/orrery/backups/
   DUMP=$(ls -1t /opt/orrery/backups/orrery-*.dump | head -1)   # or set DUMP to an older file by name
   orrery-pg-restore-test "$DUMP"                                 # proves it restores; touches nothing live
   ```

2. Keep the current state too, even if broken: `systemctl start orrery-pg-backup.service`.
3. Stop every writer (a missing one is fine):
   `docker stop orrery-api orrery-indexer orrery-prober orrery-keeper orrery-discord`
4. Recreate the database and restore into it:

   ```bash
   docker exec orrery-pg psql -U orrery -d postgres -c 'drop database orrery with (force)' -c 'create database orrery owner orrery'
   docker exec -i orrery-pg pg_restore -U orrery -d orrery --no-owner --exit-on-error < "$DUMP"
   ```

   If the volume itself is gone: `cd /opt/orrery && docker compose -p orrery-mainnet --env-file release.env -f compose.yml up -d postgres` (or `compose.prelaunch.yml` before the deploy)
   creates an empty database; restore into it
   before any other service starts (each service runs migrations on start).
5. Start the writers again with the compose file for the current stage (section 0), then check: API health, indexer
   lag falling (section 4), `/v1/releases`.
6. Put back what the dump lost:
   - Release schedule: compare `/v1/releases` with the owner's schedule and re-apply the difference with the release
     switch inside the API container (`HOSTING-4663.md` section 3, step 6):

     ```bash
     docker exec orrery-api /app/node_modules/.bin/tsx /app/scripts/releases.ts list
     ```

     then `releases.ts set` with the feature and its time (ISO 8601 with a zone, `now`, or `null` to hold it) in the
     same `docker exec` form. Every change leaves a row in `releases_audit`.
   - Discord links made after the dump: those members run `/verify` again.
   - Credit packs sold after the dump: the USDG transfers are on chain (relayer `0x21f7…C6C0` transactions after the
     dump time). There is no re-grant tool yet: list payer, nonce, amount and tx, and restore those credits only
     after the main Orrery session reviews the list.
   - Attestations: unaffected (on chain); the prober re-probes on its next pass.

## 9. A hot key leaked

Hot keys on server 1 (`/opt/orrery/secrets`, root, 600): relayer, check signer, attester, quote signer (after ORRY),
keeper (after ORRY), `discord-bot.txt`, `pg-password`. The owner key (deployer, attestor owner and treasury owner)
lives only on the laptop in `~/.secrets/orrery/mainnet-deployer.json` and signs every rotation below.

| Key | What a holder can do | Contained by |
| :--- | :--- | :--- |
| check signer | sign checks for any payer | `attestor.setCheckSigner(old, false)`: the SDK accepts a check only while `isCheckSigner(signer)` is true, so this stops it at once |
| attester | write or clear attestations | `attestor.setAttester(old, false)`: OrreryLens counts an attestation only while `isAttester(a.attester)`, so its attestations stop counting at once |
| quote signer | sign ORRY quotes, so ORRY verifications at a price of its choosing (capped per day on chain); credit quotes it signs grant nothing, since the API grants only quotes it stored | `treasury.setQuoteSigner(old, false)` |
| relayer | spend its ETH. It cannot move users' USDG: every transfer needs the payer's signed authorization to a fixed recipient | new key, no contract call |
| keeper | spend its ETH; its calls are open to anyone | new key, no contract call |

Caps: 5 check signers, 5 attesters, 3 quote signers enabled at once. Revoke first: a short gap in service is
cheaper than an attacker's signatures being accepted.

### 9.1 On the laptop: retire the leaked key, make a new one

Keys are never deleted; the leaked file is renamed in both copies, and `keys.ts` creates only the missing role,
copies it to the Private Keys folder and appends the indexes.

```bash
cd ~/Projects/blockchain/orrery
ROLE=check-signer        # one of: check-signer, attester, quote-signer, relayer, keeper
D=$(date -u +%Y%m%d)
S=~/.secrets/orrery
B="/mnt/shared/Home/Desktop/Private Keys/.secrets/orrery"
OLD=$(jq -r .address $S/mainnet-$ROLE.json)
mv $S/mainnet-$ROLE.json $S/mainnet-$ROLE.leaked-$D.json
mv "$B/mainnet-$ROLE.json" "$B/mainnet-$ROLE.leaked-$D.json"
echo "mainnet-$ROLE.leaked-$D.json | $OLD | leaked, revoked $D | $D" >> "$B/INDEX.txt"
(cd services && npx tsx scripts/keys.ts --network mainnet)
NEW=$(jq -r .address $S/mainnet-$ROLE.json)
echo "old $OLD new $NEW"
```

### 9.2 On chain: revoke the old key, enable the new one (owner key)

Simulate each call with `cast call` first (no output and no revert means it would pass), show the owner the
summary (contract, function, old and new address), then send.

```bash
RPC=https://rpc.mainnet.chain.robinhood.com
OWNER=$S/mainnet-deployer.json
ATTESTOR=$(jq -r .attestor deployments/4663.json)
TREASURY=$(jq -r .treasury deployments/4663.json)
cast call $ATTESTOR 'owner()(address)' --rpc-url $RPC          # must be the deployer, 0x006dAF26…1A3A
```

Check signer:

```bash
cast call $ATTESTOR 'setCheckSigner(address,bool)' $OLD false --from $(jq -r .address $OWNER) --rpc-url $RPC
cast send $ATTESTOR 'setCheckSigner(address,bool)' $OLD false --private-key "$(jq -r .privateKey $OWNER)" --rpc-url $RPC
cast send $ATTESTOR 'setCheckSigner(address,bool)' $NEW true --private-key "$(jq -r .privateKey $OWNER)" --rpc-url $RPC
cast call $ATTESTOR 'isCheckSigner(address)(bool)' $OLD --rpc-url $RPC   # false
cast call $ATTESTOR 'isCheckSigner(address)(bool)' $NEW --rpc-url $RPC   # true
```

Attester: the same with `setAttester(address,bool)` and `isAttester(address)(bool)` on `$ATTESTOR`.

Quote signer: the same with `setQuoteSigner(address,bool)` and `isQuoteSigner(address)(bool)` on `$TREASURY`.

Relayer or keeper: no contract call. The owner funds `$NEW` (section 6 sizing). What is left on the old key can be
swept, keeping 0.00001 ETH for the transfer's own gas (an attacker may get there first):

```bash
VALUE=$(( $(cast balance $OLD --rpc-url $RPC) - 10000000000000 ))
cast send $NEW --value $VALUE --private-key "$(jq -r .privateKey $S/mainnet-$ROLE.leaked-$D.json)" --rpc-url $RPC
```

### 9.3 On server 1: install the new key and restart what reads it

Every process loads the three v1 hot keys (relayer, check signer, attester) at start, so those rotations recreate
every running service; the quote signer is read by the API only, the keeper key by the keeper only.

```bash
scp $S/mainnet-$ROLE.json server1:/opt/orrery/secrets/mainnet-$ROLE.json
ssh server1 "chown root:root /opt/orrery/secrets/mainnet-$ROLE.json && chmod 600 /opt/orrery/secrets/mainnet-$ROLE.json"
# relayer, check signer, attester (add keeper and discord when they run, with their profiles):
ssh server1 'cd /opt/orrery && docker compose -p orrery-mainnet --env-file release.env -f compose.yml up -d --force-recreate api indexer prober'
# quote signer:
ssh server1 'cd /opt/orrery && docker compose -p orrery-mainnet --env-file release.env -f compose.yml up -d --force-recreate api'
# keeper:
ssh server1 'cd /opt/orrery && docker compose -p orrery-mainnet --env-file release.env -f compose.yml --profile orry up -d --force-recreate keeper'
```

### 9.4 Verify and record

- API health answers; the next signed check, quote or settlement uses `$NEW`.
- Attester only: re-attest every verified agent now under the new key (old attestations stopped counting at revoke):
  `docker exec orrery-pg psql -U orrery -d orrery -c 'update probes set attested_at = null'` then
  `docker restart orrery-prober` (about 60,000 gas per agent on the new attester).
- Relayer, attester or keeper: replace the old address in `ORRERY_DISCORD_WATCH` in `/opt/orrery/discord.env` and
  `ops/server1/discord.env.example`, then recreate the Discord process.
- Update the address tables in `HOSTING-4663.md` section 5, `MAINNET-4663.md` section 4 and section 0 here.

Other secrets on server 1:

- `discord-bot.txt`: section 7, step 2.
- `pg-password`: the database has no host port and sits on its own network. Rotate on server 1 (the password goes
  through stdin, never a command line):

  ```bash
  cd /opt/orrery/secrets
  (umask 077; openssl rand -hex 24 > pg-password.new)
  printf "alter role orrery password '%s';\n" "$(cat pg-password.new)" | docker exec -i orrery-pg psql -U orrery -d orrery -q
  mv pg-password pg-password.old-$(date -u +%Y%m%d) && mv pg-password.new pg-password
  ```

  Then put the new password in `ORRERY_DATABASE_URL` in `/opt/orrery/common.env` and recreate every service that
  reads it: before the deploy
  `cd /opt/orrery && docker compose -p orrery-mainnet --env-file release.env -f compose.prelaunch.yml up -d --force-recreate discord`,
  after it the same with `-f compose.yml` and `api indexer prober` (plus keeper and discord with their profiles). Open connections keep working until then.
- The owner key itself (laptop): move both contracts to a fresh owner wallet at once with the two-step
  `transferOwnership(new)` on the attestor and the treasury, then `acceptOwnership()` from the new wallet.
