# Update candidates from the other workspace projects

Internal planning document, 2026-11-08. Read-only survey of every project folder in `~/Projects/blockchain` for
features and mechanisms that Orrery could ship as post-launch updates. Nothing was built, run or changed; every
statement about another project comes from reading its README, docs and source on this date. Paths are relative to
`~/Projects/blockchain/`. Section 7 (added the same day) is a full pass over Quero (`arcane/`); rows and waves it
changed are marked "Quero" below. Section 8 (added the same day) applies the owner's direction that Orrery integrates
with no other project and builds every feature as its own, dark pool and shield included; it withdraws Q2, removes the
dependencies on other products from 3.1, 3.3, 3.24 and 3.25, and moves most of section 5 into own-build candidates.

## 0. Baseline: what Orrery already has

So the candidates below add something rather than repeat v1:

- Contracts: `OrreryPolicyModule` (per-token `perTx` / `perDay` / `floatMax`, call allowlist with forbidden selectors,
  increase delay of at least 1 hour, instant decrease, pause, revoke), `OrreryAttestor` (5 USDG verification fee once per
  agentId, attestations up to 7 days, at most 5 attester and 5 check-signer keys), `OrreryLens` (one read for a signer's
  whole record). Events cover every state change (08 §8), so the indexer works from logs alone.
- Services: internal x402 facilitator for USDG on 4663, API with credit packs (500 checks for 1 USDG), signed EIP-712
  checks by signer and by agent, key rotation by signed message, public read endpoints with an in-memory rate limit,
  prober (registration file, up to 10 HTTPS services, well-known domain file, SSRF guards), indexer, TypeScript SDK
  (operator, agent with an x402 fetch wrapper, counterparty with `verifyCheck`).
- Web: landing, operator app, `/agent/{id}`, `/signer/{address}`, credits, docs.
- Not present (checked by grep of `services/` on 2026-11-08): webhooks or alerts of any kind, an MCP server, x402
  discovery metadata, Sign-In-With-X, sanctions screening, a stats page, an agent list, referrals, a release switch,
  a standalone verifier.
- Already decided and not from this survey: Python wrapper in v1.1 (Q6), Kernel 3.1 support, Base as a later deploy
  (Q2), bonds reconsidered in v2 (Q5), phase 2 performance tracking and phase 3 copy (04 "Later phases").

## 1. How candidates were judged

- **Fit**: High when it serves the wedge (provable policy and liveness, paid checks, Q1 and Q4) or removes a step from
  the paths that earn (verification fee, credit packs); Medium for growth and convenience; Low for adjacent products.
- **Effort** (rough, one executing agent): S up to 2 days, M 3 to 7 days, L more than a week.
- **Contract change**: "none" means no Solidity change and no redeploy. "new contract" means existing contracts stay
  as deployed. "module change" means a new `OrreryPolicyModule` deployment and a migration for installed accounts, since
  nothing in v1 is upgradeable.
- **Conflicts** are checked against `02-open-questions.md` (W1 to W5, Q1 to Q9, I1 to I14, M1 to M3), the "Not in v1"
  list (08 §10) and the workspace copy rules.
- Ranking: best fit first, then lowest effort; candidates needing a contract change or a reversed owner decision go
  last regardless of fit.

## 2. Ranked table

| # | Candidate | User | Source projects | Fit | Effort | Contract | Conflict with decisions | Wave |
| :-- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Merchant payer gate for x402 servers | merchant | meshgate, oraqle, neuxora | High | S | none | none | 1 |
| 2 | Policy presets and a plain-language policy card | operator, merchant | proviso | High | S | none | none | 1 |
| 3 | x402 Bazaar discovery metadata and directory listings | merchant, agent | oraqle, meshgate | High | S | none | none | 1 |
| 4 | Registration file builder and hosting | operator | hashborn, oryx, proviso, arcane (Quero) | High | S to M | none | hosting choice (see 3.4) | 2 |
| 5 | Operator alerts (webhook, Telegram) | operator | oraqle, spendtap, hushwave, arcane (Quero) | High | M | none | none | 2 |
| 6 | MCP server `@orrery/mcp` and MCP registry listings | agent, merchant | meshgate, neuxora, hashborn, aethernode | High | M | none | none | 2 |
| 7 | Sanctions screening in check results | merchant | hushwave | High | M | none | check shape v2 (14 §4) | 3 |
| 8 | Standalone check verifier (CLI and `/verify` page) | merchant | origo, hashborn, oraqle | Medium | S | none | none | 1 |
| 9 | Live agent badge and share images | operator | spendtap, oraqle, hashborn | Medium | S | none | live data only (rule 1) | 2 |
| 10 | Public stats page | everyone | hushwave, meshgate, agentvault | Medium | S to M | none | real reads only (rule 1) | 2 |
| 11 | Release switch for update waves | owner | arcane (Quero) preferred, neuxora, origo | Medium | S | none | none | 1 |
| 12 | Ops kit: env audit, ledger audit, key rotation runbook, outside watchdog | owner | oraqle, neuxora, hushwave, orbi, arcane (Quero) | Medium | S | none | none | 1 |
| 13 | Sign-In-With-X to spend credits without an API key | merchant | oraqle | Medium | S to M | none | extends R-M5 | 3 |
| 14 | Merchant usage analytics | merchant | orbi | Medium | S to M | none | none | 3 |
| 15 | Operator CLI (`npx @orrery/cli`) | operator | hashborn, aethernode, meshgate | Medium | M | none | none | 2 |
| 16 | Exposed signer key flag in checks | merchant, operator | domain-atlas | Medium | M | none | check shape v2 | 3 |
| 17 | Agent directory | merchant | oraqle, agentvault, orbi | Medium | M | none | no trust score (14 §4) | 3 |
| 18 | Referrals paid in bonus credits | merchant | orbi, origo | Medium | M | none | payout form (see 3.18) | 3 |
| 19 | Check transparency log anchored on 4663 | merchant | origo, notara, meshgate, hashborn | Medium | M | new contract | none | 4 |
| 20 | Browser extension: record card for agent addresses on X and explorers | merchant, public | nosta, hashborn, solture, grifo | Medium | M to L | none | no grade (14 §4) | 3 |
| 21 | DefiLlama fees listing | growth | defillama-adapters | Low | S | none | needs revenue first | 3 |
| 22 | Pause-only guardian key and automatic pause | operator | agentvault, hypatia | High | L | module change | 08 §7 power table | 4 |
| 23 | Performance record (phase 2) | merchant | agentvault, meshgate | High | L | none at first | phase 2 timing | 4 |
| 24 | Public x402 facilitator on 4663 with a payer check | merchant | oraqle, meshgate | High | M to L | none | I1 reversed by the owner (D5, section 8.5) | 2 |
| 25 | USDC on Base for packs, then a Base deploy | merchant | neuxora, spendtap | Medium | M to L | none (deploy) | Q2 order | 4 |
| 26 | Gasless agent top-ups through a relay | agent | hashborn | Medium | L | module change | 08 §10, Q8 option C | 4 |
| 27 | Escrow for agent services gated by a Orrery check, with paid-job feedback (Quero) | merchant, agent | arcane (Quero), oryx, replica-prxvt | Medium | M to L | new contract | arbiter power, one wallet | 4 |
| 28 | Confidential-computing (TEE) attestation in checks | merchant | aethernode | Low | L | none or attestor v2 | none | 4 |

Quero candidates Q1 to Q10 are ranked in section 7.3. In the overall order: Q1 (agent skill file) comes right after
#3, Q4 (RPC relay and fallback) after #8, Q8 (USD view of caps) after #14, and
Q9 / Q10 sit with #27 in wave 4. Q3, Q5, Q6 and Q7 are folded into #4, #5, #11, #12 and #13 as better sources.

## 3. Candidates in detail

### 3.1 Merchant payer gate for x402 servers (rank 1)

- **What**: a small package (`@orrery/x402-gate`) a merchant adds to its x402 server. After the payment is verified
  and before it is settled, it reads the payer address (the `from` of the EIP-3009 authorization, which is the session
  signer, I11), fetches a signed check, verifies it locally and applies the merchant's own rules: status Active,
  installed, bound, verified, optional `endpointsLive`, optional maximum `perTx` for the paid token, `validUntil` in the
  future. A refused payer gets a 402 with the reason. Results are cached per signer until `validUntil` (at most
  10 minutes), so one credit covers many payments from the same agent.
- **Sources**:
  - `meshgate/docs/10-PRIORS-ADAPTATION.md` §6 "Buyer trust gate from an agent's public record" (the idea, modelled on
    Priors' `@priors/x402`, which turns away payers whose agent defaulted).
  - `oraqle/apps/gateway/src/app.ts`, `oraqle/apps/gateway/src/facilitator.ts` (x402 middleware with an in-process
    facilitator on Hono).
  - `neuxora/features/pay/server/agent-pay.ts` (x402 client and server plumbing, body caps, blocked IP ranges).
  - Orrery pieces it reuses: `services/packages/sdk/src/index.ts` (`OrreryApi`, `verifyCheck`),
    `services/packages/shared/src/x402.ts`.
- **In Orrery**: adapters for Hono, Express and Next route handlers; one config object of rules; docs page with a
  ten-line example. Works with Orrery's own facilitator (3.24) and any standard x402 facilitator; nothing in it
  depends on another product (section 8).
- **Why first**: it turns every x402 merchant on 4663 into a credit buyer with one dependency, and it sells exactly
  what I8 says the paid check is for (freshness, signature, one HTTP call). The merchant writes the rule, so Orrery
  still issues no single "trusted" verdict.
- **Effort**: S. **Contract**: none. **Conflicts**: none.

### 3.2 Policy presets and a plain-language policy card (rank 2)

- **What**: the operator's policy editor starts from a closed set of presets (for example "API buyer": 1 USDG per
  payment, 10 per day, float 5; "Trading bot": higher caps and an allowlist template), each within published bounds
  and fully editable. Every agent and signer page renders the policy as sentences ("Spends at most 10 USDG per payment
  and 50 per day. Raises take effect 1 hour after they are proposed.") next to the raw numbers.
- **Sources**: `proviso/packages/rules/src/catalogue.ts`, `proviso/packages/rules/src/bounds.ts`,
  `proviso/packages/rules/src/exportFile.ts` (closed rule catalogue with bounds and an export file),
  `proviso/apps/web/src/components/RuleSchedule.tsx` and `proviso/apps/web/src/app/rules/page.tsx` (rules rendered for
  a reader before they act).
- **In Orrery**: `services/packages/web` (operator editor and `Record` component) plus a presets module in
  `services/packages/shared`. Presets only fill the form; increases still wait the delay (I4).
- **Effort**: S. **Contract**: none. **Conflicts**: none. Copy stays within the workspace rules (caps are the product,
  not a supply limit or counter).

### 3.3 x402 Bazaar discovery metadata and directory listings (rank 3)

- **What**: declare the pack purchase (`POST /v1/credits`) with x402 discovery metadata, so Bazaar-aware facilitators
  and agents index it, and list Orrery in the open x402 resource directories. No listing inside another product's
  merchant directory (section 8).
- **Sources**: `oraqle/apps/gateway/src/bazaar.ts` (`declareDiscoveryExtension` from `@x402/extensions` with an example
  response), `meshgate/docs/10-PRIORS-ADAPTATION.md` §2 (distribution through the directories agents already read).
- **In Orrery**: one module next to `services/packages/server/src/api.ts`; the check endpoints themselves are API-key
  routes, so only the purchase is an x402 resource.
- **Effort**: S. **Contract**: none. **Conflicts**: none.

### 3.4 Registration file builder and hosting (rank 4)

- **What**: a step in the operator app that writes a valid ERC-8004 registration file (`type`, `name`, `services`,
  `registrations` with this registry and agentId), validates it with the prober's own validator before it is used,
  publishes it, generates the well-known domain file for `domainVerified`, and prepares the owner's call to the
  registry's URI setter.
- **Sources**: `hashborn-npm/packages/agent/src/identity.ts`, `hashborn-npm/packages/agent/src/registry.ts`,
  `hashborn-npm/packages/agent/src/cli.ts` (register an agent with name and capabilities from one command);
  `oryx/packages/contracts/src/agents/AgentRegistry.sol` (`addService`, `setMetadataURI`: a service list with endpoints
  per agent); `proviso` metadata upload (pinning key; it answered 503 until the key was set, so set the key before the
  release). Quero (section 7, Q3): `arcane/contracts/src/agents/ArcaneAgentRegistry.sol` (services with name, endpoint
  and price) and `arcane/apps/web/app/create-agent/page.tsx` (one screen for identity, operator, daily limit and priced
  services), which make the case for putting each service's x402 price in the file.
- **In Orrery**: web step plus a validator shared with `services/packages/server/src/prober.ts`. The registry's URI
  setter name must be confirmed against the deployed IdentityRegistry (the mock in `shared/src/abi.ts` uses
  `setTokenURI`).
- **Why**: only 3 to 15% of ERC-8004 registrations are valid and live (`01-analysis.md`), and `registrationValid` and
  `domainVerified` are in every check. Helping operators pass them raises the value of each check and the number of
  agents worth the 5 USDG verification.
- **Effort**: S to M. **Contract**: none. **Conflicts**: hosting the file on orrery.tech would make Orrery part of
  the agent's identity availability; prefer IPFS through a pinning service, and degrade to "download the file" when no
  pinning key is configured (workspace rule 5).

### 3.5 Operator alerts (rank 5)

- **What**: the indexer already ingests every module, attestor and ERC-8004 event; an alert worker turns them into
  messages to the operator: an increase proposed (with the time it becomes ready and a cancel link), a session paused
  or revoked, `spentToday` past 80% of `perDay`, the identity NFT transferred (binding void, I6), endpoints down on
  consecutive probes, an attestation within 24 hours of expiry, a float or gas balance low.
- **Sources**: `oraqle/apps/worker/src/alerts.ts` (digest rule: one message when the set changes, a daily reminder,
  no flood), `spendtap/ops/monitor/spendtap-monitor.mjs` with its README (thresholds and "first event" alerts),
  `hushwave/apps/relayer/src/monitor.ts`, `hushwave/apps/relayer/src/alerts.ts`,
  `hushwave/apps/relayer/src/watchdog.ts`. Quero (section 7, Q5 and Q7): `arcane/apps/api/src/lib/notify.ts` (31 lines,
  no imports: Discord, Telegram or any JSON webhook, a dedupe key with a quiet period, never blocks the caller) as the
  delivery base, and `arcane/apps/api/src/routes/auth.ts` (SIWE through `viem/siwe`, ERC-1271 and ERC-6492 signatures
  verified through an RPC) for subscriptions signed by a Safe owner.
- **In Orrery**: new `alerts` process beside `services/packages/server/src/indexer.ts`; channels are a signed webhook
  (HMAC per subscription, retries) and a Telegram bot first, email later. A subscription is created with a signature
  from the account owner (the ERC-1271 path through the Safe7579 adapter already works for `bindIdentity`).
- **Why**: the 1-hour increase delay (I4) protects an operator only if the operator learns of a proposed increase
  in time, for example after the owner key leaks. Alerts turn the delay into a real window.
- **Effort**: M. **Contract**: none. **Conflicts**: none. The owner's WhatsApp gateway is owner-only and paused, so it
  is not a user channel.

### 3.6 MCP server `@orrery/mcp` and MCP registry listings (rank 6)

- **What**: one MCP server with two tool groups. Counterparty tools (API key or Sign-In-With-X): check a payer, check
  an agent, verify a check, read credits, read a public record. Agent tools (the session signer's key file on the
  agent's own machine, mode 600): allowance, ensure float, pay an x402 URL from the float. Each tool description states
  its cost; results carry the remaining credits and a notice below 20%.
- **Sources**: `meshgate/apps/mcp/src/main.ts` (stdio MCP server with paid fetch tools),
  `neuxora/app/api/mcp/route.ts` (Streamable HTTP MCP where each tool calls the REST handler with the same key, so
  limits and billing match), `hashborn-npm/packages/mcp/src/server.ts` and `hashborn-npm/packages/mcp/README.md` (tools
  named by product, cost in every description, `status` / `verify` tools), `aethernode/27-mcp-spec.md` (`npx … login`
  that opens the browser with prefilled limits, confirmation above a per-call threshold, low-balance notice).
- **In Orrery**: new package in `services/packages/`, wrapping the existing SDK. Publish to npm and list on Smithery,
  Glama, MCP Market and mcp.so (`meshgate/docs/10-PRIORS-ADAPTATION.md` §2).
- **Effort**: M. **Contract**: none. **Conflicts**: none. The paused aethernode project planned a package under the
  same name before the Orrery name moved; it has to choose a new name anyway (project note), so there is no clash.

### 3.7 Sanctions screening in check results (rank 7)

- **What**: the check reports, for the signer, the account and the account owner, whether each address is on the OFAC
  SDN list or flagged by Chainalysis' free sanctions API, with the list date. Facts per address, not a verdict.
- **Sources**: `hushwave/apps/relayer/src/sanctions.ts` (OFAC SDN download twice a day with a mirror, a minimum-size
  sanity check, Chainalysis answers cached 24 hours, failure-rate window), `hushwave/apps/relayer/src/screener.ts`
  (clear / refused / unknown with retry).
- **In Orrery**: a screening module in `services/packages/server/src/`, called by `check.ts`. The EIP-712
  `CheckResult` gains fields, so the type is versioned ("Orrery Check" version "2"); `verifyCheck` in the SDK accepts
  both versions. Bundle with 3.16 so the check shape changes once.
- **Effort**: M. **Contract**: none (OrreryAttestor only answers `isCheckSigner`). **Conflicts**: changes the check shape
  of 14 §4; the Chainalysis key is a third-party secret, so OFAC alone must work without it (rule 5). No personal data
  is involved, so Q1 holds.

### 3.8 Standalone check verifier (rank 8)

- **What**: `npx @orrery/verify check.json` and a `/verify` page that check a signed result against the EIP-712 domain
  and `isCheckSigner` on chain, with no Orrery server in the loop.
- **Sources**: `origo/services/record-verifier/verify.ts` and its README (verify a record without trusting the
  issuer's servers, pinned keys), `hashborn-npm/packages/verify/src/verify.ts` and `cli.ts` (offline verifier package),
  `oraqle/apps/web/src/app/verify/` (verify page).
- **In Orrery**: thin packaging of the SDK's existing `verifyCheck`.
- **Effort**: S. **Contract**: none. **Conflicts**: none.

### 3.9 Live agent badge and share images (rank 9)

- **What**: an embeddable badge for an agent's own site and a share image per `/agent/{id}` page, both rendered from a
  live `OrreryLens` read (status, caps, delay, last attestation), never a static picture.
- **Sources**: `spendtap/lib/og/share-image.tsx`, `oraqle/apps/web/src/app/opengraph-image.tsx`, the short and explorer
  links returned by `hashborn_attest` (`hashborn-npm/packages/mcp/src/links.ts`).
- **Effort**: S. **Contract**: none. **Conflicts**: values come only from real reads (workspace rule 1).

### 3.10 Public stats page (rank 10)

- **What**: `/stats` with numbers read from the indexer only: bound identities, active sessions, verified agents,
  agents with live endpoints, checks signed, packs sold, by day.
- **Sources**: the Hushwave stats branch (`hushwave-stats/apps/relayer/src/stats.ts`,
  `hushwave-stats/apps/web/src/app/stats/page.tsx`, `hushwave-stats/apps/web/src/components/StatsBoard.tsx`, commit
  `29ba042`: per-UTC-day totals on their own cursor and a `complete` flag while history is still being read),
  `meshgate/docs/10-PRIORS-ADAPTATION.md` §4 ("nothing shown that was not read"),
  `agentvault-protocol/14-indexer-api-spec.md` §7 (every number the frontend shows derived in one place).
- **Effort**: S to M. **Contract**: none. **Conflicts**: show the page only once the indexer reports complete history,
  so no zero looks like "nothing happened" (workspace rule 1).

### 3.11 Release switch for update waves (rank 11)

- **What**: built features held server-side until a time, shown as "Coming soon", opened by editing a row; the owner's
  public launch method uses exactly this.
- **Sources**: `neuxora/features/releases/shared.ts`, `neuxora/features/releases/server.ts`,
  `neuxora/features/releases/use-release-state.ts`, `neuxora/app/api/releases/route.ts` (held API routes answer 404);
  `origo/apps/web/src/lib/releases.ts` (one "Soon" list driving every held control).
- **Preferred base (Quero, section 7, Q6)**: `arcane/packages/config/src/releases.ts`, `arcane/apps/api/src/lib/releases.ts`
  and `arcane/apps/api/src/routes/releases.ts`: one catalogue read by both web and API, each feature a timed "wave" or
  an undated "update", owning route prefixes, so a route cannot be held in one place and open in another;
  `RELEASES_ENABLED` off opens everything for development. It lives on the local branch `feat/release-switch` of the
  Quero clone (2026-11-08), not on the fetched `origin/main` ref.
- **Effort**: S. **Contract**: none. **Conflicts**: none. Enabler for waves 1 to 3.

### 3.12 Ops kit (rank 12, internal)

- **What**: (a) an environment audit that fails when a secret sits where it must not; (b) a ledger audit and reconcile
  for credits against settled payments; (c) a check-signer and attester rotation script with a dry run and an
  incidents runbook (OrreryAttestor already has `setCheckSigner` / `setAttester`, at most 5 each); (d) an outside
  watchdog on a systemd timer that alerts when the API stops answering.
- **Sources**: `oraqle/scripts/env-audit.mjs`, `oraqle/scripts/rotate-managed-signers.ts`, `oraqle/docs/INCIDENTS.md`;
  `neuxora/scripts/check-secrets.mjs`, `neuxora/scripts/audit-ledger.ts`, `neuxora/scripts/reconcile.ts`;
  `hushwave/apps/relayer/src/watchdog.ts`; `orbi/src/lib/config-check.server.ts` (configuration report without
  secrets for a health endpoint). Quero (section 7, Q5): `arcane/apps/api/src/lib/health.ts` (dependency check cached
  15 s so the status endpoint cannot be used to hammer the database or RPC), `arcane/apps/api/src/lib/preindex.ts`
  (empty lists instead of errors while indexer tables do not exist yet), `arcane/apps/api/src/lib/keeper.ts` (a hot
  keeper wallet with no roles and a little gas, separate loops with their own intervals, failures sent through
  `notify.ts`), the pattern for the relayer balance alarm and any later permissionless executor.
- **Effort**: S. **Contract**: none. **Conflicts**: none; the rotation is signed by the deployer key, which is also the
  attestor owner (M1).

### 3.13 Sign-In-With-X to spend credits (rank 13)

- **What**: a merchant spends its credits with a wallet signature (per request, or exchanged for a 15-minute session
  token) instead of an API key; the API key stays for servers.
- **Source**: `oraqle/apps/gateway/src/sessions.ts` (`@x402/extensions/sign-in-with-x`, CAIP-122, single-use nonces,
  allowed origins).
- **In Orrery**: `services/packages/server/src/api.ts` plus the existing `key_nonces` table.
- **Effort**: S to M. **Contract**: none. **Conflicts**: extends R-M5 (one active key per address) with a keyless path;
  no change to it.

### 3.14 Merchant usage analytics (rank 14)

- **What**: on the credits page, checks per day, refused payers by reason (when the gate of 3.1 reports them), credits
  left and burn rate.
- **Sources**: `orbi/src/routes/analytics.tsx`, `orbi/src/lib/analytics.functions.ts`.
- **Effort**: S to M. **Contract**: none. **Conflicts**: none.

### 3.15 Operator CLI (rank 15)

- **What**: `npx @orrery/cli init` for operators who run agents on servers: reads or registers the ERC-8004 identity,
  writes the registration file (3.4), prepares the module install and bind for the Safe owner to sign, opens a session
  with a fresh signer written to a 600 key file, funds first gas.
- **Sources**: `hashborn-npm/packages/agent/src/cli.ts` (`npx hashborn-agent register …`),
  `aethernode/26-onboarding-spec.md` (every automatable step automated, first gas), `meshgate/docs/10-PRIORS-ADAPTATION.md`
  §3 (self-serve: connect, key, top up, call).
- **Effort**: M. **Contract**: none. **Conflicts**: none; the CLI never needs the Safe owner's key, it prepares
  transactions for the owner to sign.

### 3.16 Exposed signer key flag (rank 16)

- **What**: when the prober fetches the URLs an agent itself advertises, it also looks for private keys or seed
  phrases in those responses; if one derives to the session signer, the check reports it and the operator gets an
  alert. Only masked fingerprints are kept, never a secret.
- **Sources**: `domain-atlas/src/secrets.mjs` (key and seed detection with cryptographic validation and masked output),
  `domain-atlas/src/derive.mjs` (public addresses from a found secret).
- **Effort**: M. **Contract**: none. **Conflicts**: check shape v2 (ship with 3.7); scope stays limited to the agent's
  own advertised URLs, which the prober already fetches.

### 3.17 Agent directory (rank 17)

- **What**: `/agents`, a list of bound and verified agents with filters (live endpoints, verified, caps range, token),
  each linking to its record.
- **Sources**: `oraqle/apps/web/src/app/explore/` (catalogue page), `agentvault-protocol/14-indexer-api-spec.md` §8 and
  `agentvault-protocol/indexer/src/metrics/metrics.ts` (leaderboard and history from indexed data),
  `orbi/src/components/orbi/model-catalog.tsx`.
- **Effort**: M. **Contract**: none. **Conflicts**: filters only, no ranking by a trust score, since 14 §4 rules out a
  single "trusted" flag.

### 3.18 Referrals paid in bonus credits (rank 18)

- **What**: a referral link (`?ref=`) for merchants and operators; when a referred address buys its first pack or pays
  its first verification, the referrer receives bonus credits.
- **Sources**: `orbi/src/lib/affiliates.ts` and `orbi/src/lib/affiliates.server.ts` (first code wins, 365-day cookie,
  commission rate as an owner number), `orbi/src/routes/affiliates.tsx`; `origo/apps/web/src/lib/referral.ts` and
  `origo/apps/web/src/app/referrals/page.tsx` (address-based referral links).
- **Effort**: M. **Contract**: none. **Conflicts**: paying referrers in USDG would add outflows from the treasury key
  (M1) and a payout ledger; bonus credits keep money moving one way. Owner decision.

### 3.19 Check transparency log anchored on 4663 (rank 19)

- **What**: once a day, the Merkle root of every check signed that day is written on chain; each check response
  carries its leaf proof after the anchor. A merchant can later prove it checked a payer at a given time, and Orrery
  cannot issue a backdated check unnoticed.
- **Sources**: `origo/services/anchors/src/merkle.ts` and `origo/services/anchors/src/hyperevm.ts` (record batches
  anchored as Merkle roots), `notara/services/zcash-writer/` (signed records written to a public chain),
  `meshgate/packages/core/src/receipt.ts` (signed receipts, a root published once per epoch),
  `hashborn-npm/packages/agent/src/records.ts` (anchored action records).
- **Effort**: M. **Contract**: new contract (`anchor(day, root)` callable only by an address that
  `OrreryAttestor.isCheckSigner` accepts, no admin), existing contracts unchanged. **Conflicts**: none.

### 3.20 Browser extension (rank 20)

- **What**: marks addresses and ERC-8004 agent ids on X and on the 4663 explorer; a hover card shows the Orrery
  record (status, caps, delay, last attestation) from public endpoints.
- **Sources**: `nosta/apps/extension/src/content/scanner.ts`, `hover.ts`, `painter.ts`, `x-selectors.ts` (finding and
  marking tokens in posts, panel on hover); `hashborn-npm/apps/extension/` with `store/SUBMIT.md` and
  `store/LISTING.md` (WXT build and store submission pack); `solture/` (Vermio) and `grifo/` for the same pattern.
- **Effort**: M to L. **Contract**: none. **Conflicts**: Nosta's A to F grade (`nosta/packages/risk/`) must not be
  copied, per 14 §4; the Chrome Web Store account and submission are the owner's.

### 3.21 DefiLlama fees listing (rank 21)

- **What**: list Orrery's revenue (verification fees and pack sales to the treasury) on DefiLlama once there is some.
- **Sources**: `defillama-adapters/projects/hushwave/index.js` and `defillama-adapters/HUSHWAVE-PR.md` (adapter and PR
  pack). That repo is for TVL; Orrery holds none, so the fees adapter goes to DefiLlama's separate fees repository
  (not on this disk).
- **Effort**: S. **Contract**: none. **Conflicts**: none; worth doing only after real revenue exists.

### 3.22 Pause-only guardian key and automatic pause (rank 22)

- **What**: the account may name a guardian address per session that can only pause (and perhaps only decrease). The
  operator's own bot, or the alert service of 3.5 if the operator chooses it, then pauses a session when probes fail,
  a spend pattern looks wrong, or a heartbeat stops.
- **Sources**: `agentvault-protocol/contracts/src/AgentVault.sol` (`checkGuard`: anyone can trip the guard on a
  drawdown, a daily loss or a stale bot heartbeat; spec in `agentvault-protocol/08-contract-spec.md`), Hypatia's
  safety limits with a resume after a pause (`hypatia/README.md`, "Safety" page).
- **Effort**: L. **Contract**: module change (new deployment, migration of installed accounts). **Conflicts**: the
  exhaustive power table of 08 §7 gains a row; the module still has no admin because the account appoints its own
  guardian; pausing is a decrease, so it stays consistent with I4.

### 3.23 Performance record (rank 23, phase 2)

- **What**: per agent, settled payments and outflows under its policy, counted only against distinct verified
  counterparties (03-economics abuse table), published as figures, not as a score.
- **Sources**: `agentvault-protocol/indexer/src/metrics/metrics.ts`, `ledger.ts`, `fills.ts` and
  `agentvault-protocol/14-indexer-api-spec.md` §7 (profit from one equity reading and its flows, outside flows,
  high-water mark, drawdown, all from logs); `meshgate/docs/10-PRIORS-ADAPTATION.md` §5 (score as a pure function of the
  on-chain record).
- **Effort**: L. **Contract**: none at first (index only). **Conflicts**: phase 2 per the brief and 04; wash payments
  are the known abuse.

### 3.24 Public x402 facilitator on 4663 with a payer check (rank 24)

- **What**: open the facilitator to other merchants, with an option to settle only payers that pass the merchant's
  check rules (3.1 inside the facilitator).
- **Sources**: `oraqle/apps/gateway/src/facilitator.ts`, `oraqle/apps/gateway/src/packs.ts`;
  `meshgate/docs/10-PRIORS-ADAPTATION.md` §1 (another product already runs a USDG facilitator on 4663).
- **Owner direction (section 8)**: merchants should not need another product's facilitator to use Orrery, so this
  moves up: it is the own settlement path for 3.1, 3.25 and the paid services of section 8 (O10).
- **Effort**: M to L (relayer gas for others, abuse limits). **Contract**: none. **Decided**: the owner reversed I1
  ("not offered to other merchants in v1") on 2026-11-08 (D5); this moves to wave 2.

### 3.25 USDC on Base for packs, then a Base deploy (rank 25)

- **What**: accept pack payments in USDC on Base through Orrery's own facilitator (3.24) on Base as a second
  `accepts` entry; later
  deploy the contracts on Base (they take addresses as constructor arguments).
- **Sources**: `neuxora/features/pay/server/agent-pay.ts` (x402 with USDC on Base, `eip155:8453`),
  `spendtap/lib/payments/cctp.ts` and `spendtap/lib/payments/chains.ts` (USDC from several EVM chains through CCTP).
- **Effort**: M for payments, L for the deploy with indexer and prober. **Contract**: none (new deployment).
  **Conflicts**: Q2 put 4663 first; checks still describe 4663 sessions until the Base deploy.

### 3.26 Gasless agent top-ups through a relay (rank 26)

- **What**: the agent signer signs `topUp` requests and a relayer submits them, so the signer needs no ETH and the
  operator skips `fundSignerGas`.
- **Source**: `hashborn-npm/apps/wallet-relay/src/relay.mjs` and `ops.mjs`, with its README (an ERC-4337 v0.8 relay
  on 4663: simulation before sending, per-client limits, own nonce tracking, small float).
- **Effort**: L. **Contract**: module change (signed top-up entry point) or the ERC-4337 path. **Conflicts**: 08 §10
  keeps the ERC-4337 validator out of v1, and Q8 option C was not chosen.

### 3.27 Escrow for agent services gated by a Orrery check (rank 27)

- **What**: a client funds a job; only a provider agent with an Active, verified Orrery session can accept it; payment
  is released on confirmation or after a review window.
- **Sources**: `arcane/contracts/src/agents/ArcaneAgentEscrow.sol` (Quero's live version, 156 lines, MIT: open,
  deliver, confirm with a 1 to 5 rating, release after review, refund on expiry, dispute, arbiter resolve, 1% fee) with
  its tests in `arcane/contracts/test/Agents.t.sol` and indexer handlers in `arcane/apps/indexer/src/apps.ts`;
  `oryx/packages/contracts/src/agents/AgentServiceEscrow.sol` (the older copy of the same design);
  `replica-prxvt/contracts/contracts/PrivateJob.sol` (ERC-8183 job escrow with an evaluator).
- **Quero angle (section 7, Q9)**: write the client's rating as ERC-8004 feedback only when it comes from a released,
  paid job. Feedback that costs a real payment answers the Sybil feedback measured in `01-analysis.md` better than any
  filter, and it pays the agent into its Orrery-bound account.
- **Effort**: M to L (the escrow logic can be adapted; USDG, ERC-8004 ids and the check gate are new). **Contract**: new
  contract. **Conflicts**: an arbiter is a new admin power and needs a holder under the one-wallet rule; moves Orrery
  toward a marketplace.

### 3.28 Confidential-computing attestation in checks (rank 28)

- **What**: a check field saying the agent's endpoint runs in an attested enclave (AMD SEV-SNP, Intel TDX, NVIDIA
  confidential computing).
- **Sources**: `aethernode/13-attestation-spec.md` and the prototype folder `aethernode/attestation/`.
- **Effort**: L. **Contract**: none if the result stays off chain; an attestor v2 if it goes on chain.
  **Conflicts**: none; vendor verification is unproven in the workspace.

## 4. Update waves

| Wave | Theme | Candidates | Rough effort | Owner inputs needed |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Merchant pull, first update after launch | 1, 2, 3, Q1, 8, Q4, 11 (Quero catalogue); 12 in parallel (internal, with Quero health, notify, keeper) | about 2 weeks | none beyond launch |
| 2 | Operator safety, onboarding and own settlement | 4 (with Q3), 5 (with Quero notify and SIWE), 6, 24 (own facilitator, D5), 9, 10, 15 | about 4 to 5 weeks | Telegram bot account; pinning service key; npm and MCP registry accounts; relayer gas budget for merchants' settlements |
| 3 | Check result v2 and growth | 7 with 16 (one EIP-712 version bump), 13, 14, Q8, 17, 18, 20, 21 | about 4 to 6 weeks | Chainalysis key (optional); referral payout form; Chrome Web Store account |
| 4 | Protocol v2 (contract changes, reversed decisions) | 27 with Q9 and Q10 (built as O3 in wave 5), 19, 22, 23, 25, 26, 28 | each its own plan | Q2 timing, guardian role, phase 2 start, an arbiter holder |

Wave 4 items each go through the protocol-design method (spec, invariants, harness) before any code. Waves 5 to 7
(own markets and services, section 8.4) follow; their order against waves 1 to 4 is the owner's call.

## 5. Considered and not recommended

Revised by section 8: rows marked "→ O#" are no longer excluded. Under the owner's direction they are own-build
candidates in section 8, with the conflict named here still to be decided.

| Idea | Source | Why not |
| :--- | :--- | :--- |
| Copy marketplace for agents | `agentvault-protocol/contracts/src/CopyMarket.sol`, `BotHub.sol` | Phase 3 only after phase 2 data; legal risk rated High in `05-risks.md`. → O9 |
| Credit or receivables advance for x402 merchants | the owner's `agent-credit-docs` pack (memory note only, folder not on this disk); Quero `arcane/contracts/src/pool/ArcaneCreditPool.sol`, `lend/ArcaneLend.sol` | A lending business with credit risk; Q5 keeps bonds out of v1. → O4 (own credit line, no partner) |
| Private payment credits | `replica-prxvt/contracts/` (`PrivateVault`, px402) | Hides the payer, the opposite of public proof (Q1). → O1 (shield with a zero-knowledge proof of a verified, policy-bound payer, D3) |
| Operator KYC or KYB, including Quero's zero-knowledge credential | `arcane/apps/api/src/kyc/didit.ts`, `arcane/apps/api/src/kyc/sumsub.ts`, `arcane/contracts/src/credential/ArcaneZkCredentials.sol` | Q1 option B was rejected; even with the country withheld on chain, the provider holds the personal data |
| Quero's own agent wallet as a Orrery account kind | `arcane/contracts/src/agents/ArcaneAgentAccount.sol` | Weaker than the module (section 7.2): ETH only, no per-payment cap, no increase delay, operator signatures valid for the wallet |
| Quero's other markets | `arcane/contracts/src/lend/`, `perps/`, `predict/`, `darkpool/`, `shield/`, `swap/ArcaneBatchSwap.sol`, `basket/`, `rwa/`, `pool/ArcaneCreditPool.sol`, `growth/ArcaneMilestoneRaises.sol`, `nft/`, `trade/ArcaneLimitOrderBook.sol` | Trading, lending, RWA and fundraising products outside the wedge. → O1 (shield), O2 (dark pool), O4 (lend, credit pool), O11 (the rest, low fit) |
| A to F risk grade | `nosta/packages/risk/` | 14 §4: no single "trusted" flag; facts only. Still not recommended |
| Token, staking, buyback | `orbi/contracts/src/OrbioToken.sol`, `OrbioStaking.sol`; `aethernode/22-token-curve-plan.md`, `23-token-spec.md` | W2: no token before a used product. ORRY is now designed in `ORRY-TOKEN-UTILITY.md`; own buyback code → O7 |
| Bonded attesters or operators | `revguard-protocol/08-contract-spec.md`; `meshgate/docs/10-PRIORS-ADAPTATION.md` §7 | Q5: fee only in v1; reconsider in v2 with abuse data. Still open (ORRY doc question Q3 re-decides Q5) |
| Fee streams, milestone raises, bounty board | `oryx/packages/contracts/src/streams/FeeStreams.sol`, `src/agents/MilestoneRaises.sol`, `BountyBoard.sol` | Launchpad finance, outside the wedge. → O3 (bounty board), O11 (raises, fee streams) |

## 6. Projects surveyed

| Project | Contributed |
| :--- | :--- |
| meshgate | 3.1, 3.3, 3.6, 3.10, 3.15, 3.19, 3.23, 3.24 (Priors adaptation doc, MCP, signed receipts) |
| oraqle (and its predecessor veltra / Signality) | 3.1, 3.3, 3.5, 3.8, 3.9, 3.12, 3.13, 3.17, 3.24 |
| neuxora | 3.1, 3.6, 3.11, 3.12, 3.25 |
| hashborn-npm (and its branch folders) | 3.4, 3.6, 3.8, 3.9, 3.15, 3.19, 3.20, 3.26 |
| hushwave, hushwave-stats | 3.5, 3.7, 3.10, 3.12 |
| aethernode (paused) | 3.6, 3.15, 3.28 (specs 13, 26, 27) |
| agentvault-protocol | 3.10, 3.17, 3.22, 3.23 |
| orbi | 3.12, 3.14, 3.17, 3.18 |
| origo | 3.8, 3.11, 3.18, 3.19 |
| proviso | 3.2, 3.4 |
| spendtap | 3.5, 3.9, 3.25 |
| oryx (Tetro) | 3.4, 3.27 |
| domain-atlas | 3.16 |
| nosta, solture (Vermio), grifo | 3.20 |
| notara | 3.19 |
| defillama-adapters | 3.21 |
| replica-prxvt (Sieghood) | 3.27, section 5 |
| hypatia | 3.22 (safety limits pattern) |
| arcane (Quero) | Full pass in section 7: Q1 to Q10, ORRY pieces R-a to R-f, and better sources for 3.4, 3.5, 3.11, 3.12, 3.27 |
| revguard-protocol | section 5 only |
| endpoint-mapper, pons-launch-monitor, aetheros-qa, project-hub | Read; tools for own sites or teams, nothing for Orrery's users |
| Launchpads and trading apps: hookedrh, emiten, launchpad, _template-launchpad, cadea, cadea-rh, vanitypad, runepad, runepad-rh, rune-launchpad-plan, origo-solana, origo-utility, notara-solana, snop-defi, snopfamily-*, kyro, sway-staging, knewit, convex-ext, otcdesk-robinhood, lumoracle, orvy, signaliht, elysium, argushare, omnicoin-docs, morble, voltcard, solana2, matriks-destiny, parkdeck, phioradata-robinhood, velox-protocol, zipchain, halorin, fossils, peal | Read at README or folder level; their mechanisms (curves, graduation, runes, perps, games) do not fit an agent policy product |
| echo | The most related shut-down project (x402 on 4663 with SDK, signer and MCP), but only `.env` files remain in the folder and `locate` finds no source; recover it from wherever it was archived if its MCP or gateway code is wanted |
| credit-city, pqc-rh, quarterdeck, quiifam-stage, rl-data, signality, Trivo, xulture-staging, agentvault-fund-kit, pqtech-fork-broadcast, vanity-launchpad, vanity-robinhood-fullplan | Empty, scripts only, or not a product |

Worktree and review copies (`*-wt*`, `*-review`, `*-pr`, `*-staging-build`, `convex-*`, `hashborn-npm-*`,
`runepad-wt-*`, `snopfamily-defi-l*`, `vanitypad-*`) were skipped except `hushwave-stats`, whose branch holds the
stats page that `hushwave/` itself does not have.

## Ringkasan untuk owner (5 teratas)

1. **Gerbang pembayar untuk merchant x402** (dari meshgate, oraqle, neuxora). Paket kecil yang dipasang merchant di
   server x402-nya: sebelum pembayaran diselesaikan, Orrery memeriksa alamat pembayar dan merchant menolak agen yang
   tidak memenuhi aturannya sendiri. Ini langsung menjual paket cek ke setiap merchant di 4663. Usaha kecil, tanpa
   ubah kontrak.
2. **Preset kebijakan dan kartu kebijakan berbahasa biasa** (dari proviso). Operator memilih preset batas (misalnya
   "API buyer") lalu mengeditnya; halaman agen menampilkan kebijakan sebagai kalimat yang mudah dibaca. Usaha kecil,
   tanpa ubah kontrak.
3. **Listing di x402 Bazaar dan direktori** (dari oraqle, meshgate). Pembelian paket cek didaftarkan agar agen dan
   facilitator lain menemukannya otomatis. Usaha kecil, jalur akuisisi termurah.
4. **Pembuat file registrasi ERC-8004** (dari hashborn, oryx, proviso). Operator membuat file registrasi yang valid
   dan file domain dari aplikasi, sehingga agennya lolos cek `registrationValid` dan `domainVerified`. Saat ini hanya
   3 sampai 15% registrasi ERC-8004 yang valid, jadi ini menambah jumlah agen yang layak membayar verifikasi 5 USDG.
   Usaha kecil sampai sedang, tanpa ubah kontrak.
5. **Notifikasi untuk operator** (dari oraqle, spendtap, hushwave). Webhook dan Telegram saat ada usulan kenaikan
   batas, sesi dijeda atau dicabut, pemakaian harian mendekati batas, NFT identitas berpindah, atau endpoint mati. Ini
   membuat jeda kenaikan 1 jam benar-benar melindungi operator. Usaha sedang, tanpa ubah kontrak.

Berikutnya di urutan: server MCP `@orrery/mcp` dan skrining sanksi (OFAC) di hasil cek. Semua yang butuh ubah kontrak
atau membalik keputusan (guardian jeda otomatis, facilitator publik, Base, escrow) ada di gelombang 4 dan perlu
keputusan owner lebih dulu.

## 7. Quero deep dive

Full pass over Quero (folder `arcane/`, repository `quillexdev/arcane`, Neo's project, live at quero.family on 4663),
requested by the owner on 2026-11-08. Read-only: nothing in that repository was pulled, checked out, edited or
committed.

### 7.1 What was read, and its state

- **Source version**: the local clone is on branch `feat/release-switch` at `2bf5206` (2026-11-08), 9 commits ahead of
  its cached `origin/main` ref `3fce565` (2026-11-05). `git fetch` failed on 2026-11-08 ("Repository not found")
  because the active GitHub account on this machine has no access to `quillexdev`, so newer commits on GitHub, if any,
  were not seen.
- **Two contract trees**: `arcane/contracts/` is the live Quero v1 (Solidity 0.8.26, OpenZeppelin 5.1, about 10,400
  lines; addresses in `arcane/contracts/deployments/robinhood-mainnet-*.json`, documented in `arcane/docs/CONTRACTS.md`
  with an internal review in `arcane/contracts/audit/INTERNAL-AUDIT.md`). `arcane/packages/contracts/` is the older
  Metazara tree (the same design as `oryx/`), with its own 4663 addresses in `arcane/deployments/4663.json`.
- **Off-chain**: `arcane/apps/api` (Hono, SIWE, keeper, KYC, notifications, read-only RPC relay, release switch),
  `arcane/apps/indexer` (Ponder on 4663, 1 s polling, two RPC URLs), `arcane/apps/web` (Next.js 15).
- **Usage on chain**, read with `cast call` on `rpc-robinhood.blockmachine.io` at block 108,920,248 (2026-11-08):
  AgentRegistry `0x154a2B23b5d75AA9FBACe5bc8321A9a0F8194f5d` `nextId` = 1 (no agent registered), AgentEscrow
  `0xCF2B7372E741028B1fbD3760F7EBf5B0fF61e21e` `jobCount` = 0, BountyBoard `0xF98F143116feA82c1CfA4006A376DCE222Bd4101`
  `bountyCount` = 0, FeeStreams `0x3ab7eBBDE36B7C62B95fe805D45B1656c134e72F` `streamCount` = 0, MilestoneRaises
  `0xb372c7a64b4B010D1B6cF5bb9cc249D80E3Ea085` `raiseCount` = 0. The value Quero offers Orrery is code and design, not
  an existing user base.
- **No ERC-8004 and no x402**: Quero's agents are its own ERC-721 ("Arcane Agent"; the agent page labels it "ERC-8004
  style"), not entries in the ERC-8004 IdentityRegistry `0x8004A169…a432`. The only x402 mention is an alias that drops
  optional x402 packages from the web bundle (`arcane/apps/web/next.config.ts`).
- **Licence and coupling**: 42 contract files carry `SPDX-License-Identifier: MIT`, 2 generated PLONK verifiers carry
  GPL-3.0; there is no LICENSE file at the repository root and no `license` field in any `package.json`, and the
  repository is private. The owner settled reuse on 2026-11-08 (D2, section 8.5): Quero belongs to the owner and Neo,
  we are contributors with a local clone, so its code may be used; keep the SPDX header and note the origin. Contracts depend only on OpenZeppelin and Quero's own `ArcaneFeeRouter` and `ArcaneAgentRegistry`,
  which a Orrery version replaces. TypeScript packages are named `@metazara/*` (api, indexer, web, contracts, cli) and
  `@arcane/*` (config, sdk); the API is Hono with a Postgres `sql` helper while Orrery's is Fastify, so services are
  ported, not imported. `arcane/apps/api/src/lib/notify.ts` has no imports and can be copied as it is.

### 7.2 Quero's agent wallet against Orrery's module

| | Quero `ArcaneAgentAccount` | Orrery `OrreryPolicyModule` |
| :--- | :--- | :--- |
| Identity | Quero's own ERC-721 | ERC-8004 IdentityRegistry |
| Assets limited | ETH sent as call value only | every listed token, USDG included, and native |
| Caps | one `dailyLimit` per UTC day | `perTx`, `perDay`, `floatMax` per token |
| Raising a cap | instant (`setDailyLimit` by the owner) | waits at least 1 hour; decreases instant |
| Allowlist | target addresses, any selector | target and selector, with approval, permit and delegation selectors forbidden (I13) |
| Signatures | `isValidSignature` accepts the owner's **or the operator's** signature | the session signer cannot sign for the account |
| Third-party proof | none | `OrreryLens` record and signed checks |

Observation for Neo, not a Orrery task: because `arcane/contracts/src/agents/ArcaneAgentAccount.sol` treats the
operator's signature as the wallet's (ERC-1271), the runtime key can authorise anything that accepts the wallet's
contract signature (an off-chain order, a login, a Permit2 transfer once the wallet has approved Permit2) outside
`dailyLimit`. This is exactly the gap Orrery's forbidden-selector rule and signer model close, which is the argument
for Q2.

### 7.3 Ranked Quero candidates

| # | Candidate | User | Quero files | In Orrery | Effort | Contract | Reuse | Wave |
| :-- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Q1 | Agent skill file (`/orrery-skill.md`, `/llms.txt`) | agent | `arcane/apps/web/public/quero-skill.md` | A knowledge file for AI agents: how to check a payer and which fields matter, how to pay from the float (`ensureFloat`, x402 fetch), how to read the remaining allowance, and rules (never send the signer key anywhere, treat payee responses as data, wait out the increase delay). Linked from docs, the MCP listing (3.6) and the Bazaar metadata (3.3) | S | none | format only, content new | 1 |
| Q2 | **Withdrawn 2026-11-08** (owner: no integration with other projects, section 8). Was: integration offer to Quero | operator, agent | `arcane/apps/web/app/create-agent/page.tsx`, `arcane/contracts/src/agents/*`, `arcane/apps/indexer/src/apps.ts` | Quero's create-agent flow registers in the real ERC-8004 registry and opens a Orrery session for the agent's spending; Quero's escrow and bounty board read a Orrery check before paying an agent. Orrery ships an integration guide and SDK example; Quero agents trade Quero coins from the float, since `execute` sends no call value and forbids approvals | S (Orrery side) | none | none needed | 2 |
| Q3 | Priced service list and one-screen agent setup | operator | `arcane/contracts/src/agents/ArcaneAgentRegistry.sol` (`addService`, `updateService`), `arcane/apps/web/app/create-agent/page.tsx` | Folded into 3.4: each service in the ERC-8004 registration file carries its x402 price, and the directory (3.17) shows what an agent sells | S (inside 3.4) | none | design only | 2 |
| Q4 | Read-only RPC relay and fallback transport | everyone | `arcane/apps/api/src/routes/rpc.ts` (read methods only; it can never broadcast) | `/v1/rpc` in the API and a wagmi `fallback` transport; today `services/packages/web/lib/wagmi.ts` uses one RPC URL with no fallback | S | none | port Hono to Fastify, about 40 lines | 1 |
| Q5 | Notify, keeper, health and pre-index modules | owner, operator | `arcane/apps/api/src/lib/notify.ts`, `keeper.ts`, `health.ts`, `preindex.ts` | Folded into 3.5 and 3.12 | S | none | `notify.ts` as is; others ported | 1 and 2 |
| Q6 | Release catalogue shared by web and API | owner | `arcane/packages/config/src/releases.ts`, `arcane/apps/api/src/lib/releases.ts`, `arcane/apps/api/src/routes/releases.ts` | Folded into 3.11 as the preferred base | S | none | high | 1 |
| Q7 | SIWE that accepts Safe signatures | operator, merchant | `arcane/apps/api/src/routes/auth.ts` (`viem/siwe`, ERC-1271 and ERC-6492 through an RPC) | Folded into 3.5 (alert subscriptions) and 3.13 | S | none | pattern | 2 and 3 |
| Q8 | USD view of caps | operator, merchant | `arcane/apps/api/src/lib/oracles.ts` (Chainlink feeds on 4663 batched through Multicall3, staleness rules for US equity feeds over weekends), `arcane/contracts/src/lend/ArcaneChainlinkFeed.sol` | Agent and signer pages and the check JSON (not the signed struct) show each cap's USD value for ETH and stock tokens. Display only: enforcement stays per token (08 §10) | S to M | none | port | 3 |
| Q9 | Paid-job escrow with ERC-8004 feedback | agent, merchant | `arcane/contracts/src/agents/ArcaneAgentEscrow.sol`, `arcane/contracts/test/Agents.t.sol`, indexer handlers in `arcane/apps/indexer/src/apps.ts` | Upgrades 3.27: USDG instead of ETH, ERC-8004 ids, a Orrery check gate on the agent (session Active, verified), payout to the bound account, the rating written as ERC-8004 feedback only from a paid, released job. The Reputation Registry's address and interface on 4663 must be confirmed first | M to L | new contract | adapt | 4 |
| Q10 | Agent work board | agent | `arcane/contracts/src/growth/ArcaneBountyBoard.sol` (ETH or ERC-20 rewards, up to 10 winners, `submitAsAgent`, arbiter, 1% fee) | Bounties open to Orrery-verified agents only; only after Q9 shows demand | M | new contract | adapt | 4 |

Conflicts: Q1, Q3 to Q8 none. Q2 is withdrawn. Q9 and Q10 add an arbiter, a new admin power that needs a holder under the one-wallet rule, and move Orrery
toward a marketplace (Q1 wedge).

### 7.4 Pieces for the ORRY plan

The owner's ORRY plan, as relayed on 2026-11-08: ORRY used for earning, an open liquidity pool funded with ETH or
other assets that pairs with coins launched through Orrery, and LPs earning a share of swap and transaction fees. The
token design is in `orrery/docs/ORRY-TOKEN-UTILITY.md` (staking behind an agentId, ORRY checkout burned,
`OrreryTreasury` and `OrryBuyback` in its section 7). That document does not yet cover launching coins through
Orrery or a liquidity pool for them (read 2026-11-08). Quero has tested code for both; this section only points at it.

| # | Piece | Quero files | What it would serve | Reuse | Conflicts |
| :-- | :--- | :--- | :--- | :--- | :--- |
| R-a | Coin launch on a curve with graduation | `arcane/contracts/src/launch/ArcaneTokenFactory.sol`, `curve/ArcaneBondingCurve.sol`, `token/ArcaneToken.sol`, `fees/ArcaneFeeRouter.sol` (fee caps as constants; pause stops buys, never sells or claims); tests `arcane/contracts/test/Launchpad.t.sol`, `Curve.invariant.t.sol` | "Coins launched through Orrery" | Curve, token, factory and fee router adaptable. Graduation must be rebuilt: `liquidity/ArcaneLiquidity.sol` mints a Uniswap V2 pair and `liquidity/ArcaneLPLocker.sol` locks V2 LP, while the owner's rule is Uniswap v4 always. Section 8 (O5) prefers our own v4 code from Emiten and Proviso instead | W2 (no token before a used product) and Q1 (a launchpad is outside the KYA wedge): owner decision, ORRY doc section 12 |
| R-b | Link an agent to its coin | `arcane/contracts/src/agents/ArcaneAgentRegistry.sol` (`linkToken`: only the curve's creator who owns the agent) | The agent page and check JSON show the coin its ERC-8004 owner launched; kept in the indexer or the registration file, no contract | Design only | none |
| R-c | Open liquidity pool where LPs earn fees | `arcane/contracts/src/vault/ArcaneVault.sol` (ERC-4626, 6-decimal virtual offset against the first-depositor inflation attack, fees capped in code, deposits can be stopped, withdrawals never), `arcane/contracts/src/growth/ArcaneFeeStreams.sol` (per-unit fee accumulator, anyone can `harvest`, holders `claim`) | Share accounting for ETH depositors and the payout of their share of swap and transaction fees | Accounting adaptable; the pool and its fee source (v4 pool fee or hook) are new work | Uniswap v4 rule; copy rules on yield wording |
| R-d | Buyback and burn in bounded slices | `arcane/contracts/src/fees/ArcaneFlywheel.sol` (no admin, no pause; buyback share can only rise; each slice at most `maxSlice` and 1% of the pool's ETH reserve, at least 10 minutes apart, at least 98% of the same-block quote; anyone may execute), test `arcane/contracts/test/Flywheel.t.sol` | Same shape as `OrryBuyback` in the ORRY doc 7.3 | Logic and tests adaptable; the swap leg is V2 and must move to v4. Section 8 (O7) prefers Origo's own v4 `BuybackBurner` and `FeeSwapper` | none beyond the ORRY doc's own |
| R-e | Sell a share of future fees | `arcane/contracts/src/growth/ArcaneFeeStreams.sol` (ERC-1155 units, 7 to 730 days, up to 50% of the fees) | A form of earning for a launched coin's creator and holders | Adaptable | Income-share units read like a security; not recommended for ORRY v1 |
| R-f | Keeper for permissionless steps | `arcane/apps/api/src/lib/keeper.ts` | Runs buyback slices and fee harvests from a hot wallet with no roles | Port | none |

### 7.5 Ringkasan Quero untuk owner

Quero punya banyak modul, tapi modul agen, escrow, bounty, fee stream dan raise di mainnet masih kosong (0 agen, 0 job,
0 bounty per 2026-11-08), dan agennya bukan ERC-8004. Jadi yang bisa diambil adalah kode dan desainnya. Pilihan
teratas:

1. **File skill untuk agen AI** (`/orrery-skill.md`, dari `quero-skill.md`). Panduan singkat untuk agen: cara cek
   pembayar, cara bayar dari float, aturan aman. Usaha kecil, gelombang 1.
2. ~~Tawaran integrasi ke Quero~~: dibatalkan sesuai arahan owner (tanpa integrasi ke proyek lain, bagian 8).
   Catatan untuk Neo tetap berlaku: wallet agen Quero menganggap tanda tangan operator sebagai tanda tangan wallet.
3. **Relay RPC read-only dengan fallback**. Situs Orrery sekarang hanya punya satu RPC. Usaha kecil, gelombang 1.
4. **Escrow job berbayar dengan feedback ERC-8004** (dari `ArcaneAgentEscrow`). Rating hanya bisa diberikan oleh klien
   yang benar-benar membayar, jadi lebih kuat melawan feedback palsu. Butuh kontrak baru dan pemegang peran arbiter,
   jadi masuk gelombang 4.
5. **Untuk rencana ORRY**: `ArcaneFlywheel` (buyback dan burn bertahap) cocok dengan `OrryBuyback`. Kode peluncuran
   koin dan vault LP Quero bisa jadi dasar "koin yang diluncurkan lewat Orrery" dan pool LP yang berbagi fee, tetapi
   kode itu memakai Uniswap V2. Aturan owner adalah Uniswap v4, jadi bagian graduation dan pool harus dibangun ulang.
   Dokumen ORRY belum membahas peluncuran koin dan pool LP ini, jadi keputusannya ada di owner.

Kode Quero boleh dipakai (keputusan owner D2, bagian 8.5): Quero milik owner dan Neo, dan kita kontributornya.

## 8. Own-build catalogue (owner direction, 2026-11-08)

The owner wrote, quoted: "jangan gunakan integrasi ke project lain tapi full fitur kita sendiri misalnya darkpool,
shield atau apapun yg ada di project lain untuk di bawa ke project ini". In English: no integration with other
projects; Orrery builds full features of its own, for example a dark pool, a shield, or anything else found in the
other projects.

### 8.1 Rules this sets

- Orrery depends on no other live product: no partnership, no shared contracts, and no reliance on another product's
  facilitator, directory, launchpad or pool. Public infrastructure stays (Robinhood Chain, the ERC-8004 registry, Safe,
  Uniswap v4, Chainlink feeds, USDG), because it is infrastructure, not a partner.
- Any mechanism in a workspace project may be rebuilt inside Orrery, under Orrery's name, contracts, keys and
  treasury.
- Code comes from our own repositories (`dandi-apriadi/*`: hushwave, emiten, proviso, origo, agentvault-protocol,
  replica-prxvt, oraqle, zynode in `meshgate/`, neuxora, orbi, hypatia) and from Quero (`quillexdev/arcane`), which the
  owner co-owns with Neo and may use freely (D2). Hookepad (`baf6100/hookedrh`, Kris) is used only with Kris's
  agreement.
- Exception decided by the owner (D4): ORRY itself stays on Pons V2.
- Every market below is a set of new contracts that read Orrery's existing ones (`OrreryPolicyModule.signerOf`,
  `OrreryAttestor.isVerified`, `OrreryLens`); none changes the v1 contracts.
- Agents act through the float (Q8). The float wallet is the session signer and is bounded by `perDay` and
  `floatMax`, so a Orrery market can admit "the signer of an Active session of a verified agent" with one on-chain read,
  and the agent's exposure stays inside its policy. `execute` stays as it is (no call value, approvals forbidden).

Changed elsewhere in this document: Q2 withdrawn; 3.1, 3.3, 3.24 and 3.25 no longer rely on another product; 3.24
(own facilitator) moves to wave 2 (D5); section 5 rows moved here; the ORRY pieces in 7.4 point at our own v4 code.

ORRY (D4): `ORRY-TOKEN-UTILITY.md` launches ORRY through Pons V2 and buys it back on Pons' Uniswap v4 pool; the
owner kept that. Orrery Launch (O5) is therefore for agents' coins, and Origo's `BuybackBurner` (O7), which was built
to buy on Pons' v4 pool, fits ORRY's buyback as it is.

### 8.2 Catalogue, ranked

| Rank | # | Orrery feature | Use in the agent economy | Source (own first) | Effort | Contract | Decision it touches | Wave |
| :-- | :-- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | O3 | Orrery Jobs and work board | Agents get paid for work through escrow; ratings come only from paid jobs | `replica-prxvt/contracts/contracts/PrivateJob.sol` (ours, ERC-8183 job escrow); Quero `arcane/contracts/src/agents/ArcaneAgentEscrow.sol`, `arcane/contracts/src/growth/ArcaneBountyBoard.sol` (3.27, Q9, Q10) | M to L | new contracts | arbiter holder; marketplace | 5 |
| 2 | O1 | Orrery Shield: private balance and payments with a zero-knowledge proof of a verified, policy-bound payer (D3) | Operators keep treasury, suppliers and strategy off the public chain while caps still bind; merchants verify a proof instead of an identity | `hushwave/circuits/transact` (Noir, 2 in 2 out, EIP-712 signature checked in circuit), `hushwave/contracts/src/HushwavePool.sol`, `hushwave/packages/sdk`, `hushwave/apps/relayer/src/relay.ts`, `screener.ts`, `sanctions.ts`, plus Withdrawal Waves, payment requests and private history (`hushwave-updates`, commit `31e4858`); Quero `arcane/contracts/src/shield/ArcaneShield.sol`, `arcane/contracts/src/credential/ArcaneZkCredentials.sol` | L | new contracts (signer set, pool, verifiers) | Q1 (policy stays public, 8.3); I8 (pool fee instead of a paid check) | 6 |
| 3 | O2 | Orrery Dark Pool, for agents only | Trading agents get sealed execution at the oracle price, against counterparties whose policies are public | Quero `arcane/contracts/src/darkpool/ArcaneDarkPool.sol` and its factory, `arcane/contracts/src/swap/ArcaneBatchSwap.sol`, `arcane/apps/api/src/lib/oracles.ts` (usable as our own, D2) | L | new contracts | Q1 widened (D1) | 6 |
| 4 | O5 | Agent Launch (T3): coins for verified agents, paired with ORRY | An agent's owner raises for and tokenizes the agent; the record shows its coin; verification fee and a 90-day stake are the Sybil cost | Designed in `ORRY-TOKEN-UTILITY.md` sections 3, 6.2 and 19 (fee split T6) with SNOP code (T14): `snopfamily-defi/packages/contracts/src/LaunchFactory.sol`, `MemeHook.sol`, `damm/SnopDynamicFeeHook.sol`; our own v4 references `emiten/contracts/src/V4Graduator.sol`, `proviso/contracts/src/hook/ProvisoHook.sol`; the agent link from Quero `linkToken` | M to L | new contracts | U2, T3, T6; ORRY itself stays on Pons V2 (T1, U5) | second update per T3 |
| 5 | O6 | Earn: the ORRY/ETH hub pool funded by an LP vault (T4, T5) | LPs earn 85% of the hub's 1% fee and 20% of Agent Launch fees in ORRY; they never hold launched coins | Designed in `ORRY-TOKEN-UTILITY.md` sections 6.1 and 7; SNOP `snopfamily-defi/packages/contracts/src/plp/PlpVault.sol`, `liquidity-mgr/SnopStake.sol`, `router/SnopFeeCollector.sol` (T14); our own `proviso/contracts/src/vault/ProvisoFeeVault.sol`; Quero `arcane/contracts/src/vault/ArcaneVault.sol` (ERC-4626 offset) | L | new contracts | T4, T5; LP loss and yield wording | with ORRY |
| 6 | O7 | ORRY buyback on Uniswap v4 from our own code | Revenue buys and burns ORRY in bounded slices | `origo/contracts/src/v2/BuybackBurner.sol` (built to buy on Pons' v4 pool, which is where ORRY trades under D4), `origo/contracts/src/v2/FeeSwapper.sol` (Universal Router and V4Quoter; fees in USDG or stock tokens swapped to ETH, then bought and burned) | M | new contracts | ORRY doc 7.3 | with ORRY |
| 7 | O8 | Own anchor contract for the check log | Base for 3.19 | `origo/contracts/src/v2/OrigoAnchor.sol` (one writer fixed at deployment, each digest written once, no owner, never holds value) | S | new contract | none | 4 |
| 8 | O4 | Orrery Credit: a USDG credit line into the agent's float, repaid from its x402 revenue | Agents that earn can spend ahead of revenue; Orrery already knows their caps and income | the `agent-credit-docs` design (memory note: receivables advance, the agent's x402 `payTo` is a revenue router that repays first; folder not on this disk); vault accounting in `agentvault-protocol/contracts/src/AgentVault.sol`; Quero `arcane/contracts/src/pool/ArcaneCreditPool.sol`, `arcane/contracts/src/lend/ArcaneLend.sol` | L | new contracts | Q5 reopened for credit: the operator's bond carries first loss (D6); credit risk; lending wording | 7 |
| 9 | O10 | Orrery Services: first-party paid APIs for agents (web fetch, model inference), paid from the float over x402 | A first place for Orrery-bound agents to spend, and a live showcase of the payer gate | `meshgate/` (fetch, MCP, signed receipts), `neuxora/` and `orbi/` (OpenAI-compatible gateway with credits) | L each | none | overlaps the paused aethernode, which absorbed Meshgate; settles through the own facilitator (D5) | 7 |
| 10 | O9 | Orrery Copy: follow an agent's trades from your own policy-bound account | Phase 3 of the brief | `agentvault-protocol/contracts/src/AgentVault.sol`, `BotHub.sol`, `CopyMarket.sol`, `HostedOperator.sol`, `agentvault-protocol/indexer/src/metrics/`; `hypatia/` as the reference agent; venue on 4663 would be O2 or v4 | L | new contracts | phase 3 timing; legal risk rated High in `05-risks.md` | 7 |
| 11 | O11 | Lower fit, buildable later | see 8.3 | Quero `predict/`, `perps/`, `basket/`, `trade/ArcaneLimitOrderBook.sol` with `apps/api/src/lib/keeper.ts`, `growth/ArcaneMilestoneRaises.sol`, `growth/ArcaneFeeStreams.sol`, `nft/`, `rwa/`, `credential/`; `hypatia/`, `agentvault-protocol/` for perps | M to L each | new contracts | Q1 | not scheduled |

### 8.3 How the main ones work in Orrery

**O1 Shield, zero-knowledge first (D3).** Nobody, the merchant included, learns which agent paid; the merchant learns
that a verified Orrery agent with a policy that allows this payment paid it.
- Signer set: a new contract `OrrerySignerSet` keeps a Poseidon Merkle tree of leaves. A session signer enrolls itself
  (`msg.sender` is the signer) with a commitment to a private shield key; the contract checks on chain, through
  `OrreryPolicyModule.signerOf`, `OrreryLens` and `OrreryAttestor.isVerified`, that the session is Active, the module installed,
  the account kind known and the agent verified, and writes a leaf `hash(keyCommitment, token, perTx, expiresAt)`, with
  `perTx` at most the session's current cap and `expiresAt` at most the policy's `validUntil`. Anyone may zero a leaf
  whose session is no longer Active (pause, revoke, identity transfer); Orrery's keeper does it from the indexer's
  events, so revocation reaches shielded proofs within blocks. Proofs must use a root from a short recent-roots window.
  No change to the v1 contracts; the set only reads them.
- Pool: Hushwave's design (Noir circuit, 2 in 2 out, notes, relayer, OFAC screening on deposits) deployed as Orrery
  Shield for USDG. Deposits come from the float, so a shielded balance can never exceed what the policy let out; the
  operator's Safe may also deposit.
- Payment proof: the spend circuit adds membership of the spender's key in a recent signer-set root, `amount <= perTx`
  of that leaf, and `now <= expiresAt` (time as a public input checked by the contract). The x402 payment uses a new
  Orrery scheme for shielded payments, not `exact`; the merchant verifies the proof and the root, locally or on chain.
- What merchants keep and lose: they keep "verified agent, policy-bound, this payment within its per-payment cap, not
  revoked"; they lose per-agent facts (which agent, its endpoints, its record). Leaves can carry more attributes later
  (live endpoints at enrollment, an ORRY stake at least X) for predicate proofs.
- Revenue (I8): a shielded payment needs no paid by-signer check, so Orrery earns from it through a pool fee on
  shielded payments and through the verification fee every enrolled agent has paid.
- Sources: `hushwave/circuits/transact`, `hushwave/contracts/src/HushwavePool.sol`, `hushwave/packages/sdk`,
  `hushwave/apps/relayer/src/`; Quero `arcane/contracts/src/shield/ArcaneShield.sol` (Poseidon tree, root history,
  verified wallets only) and `arcane/contracts/src/credential/ArcaneZkCredentials.sol` (a proof of policy predicates
  against a registry, with an attribute withheld). Quero's two generated PLONK verifiers are GPL-3.0; regenerate
  verifiers with our own toolchain (Hushwave's Noir and Barretenberg) instead of copying them.
- Q1 holds: policies, caps and verification stay public on chain; only who paid whom becomes private.
- Effort L, the largest item here: two circuits (membership and predicate inside the spend), the signer-set contract,
  pool and verifiers, relayer, x402 scheme, SDK, web, and a fresh invariant and fuzz campaign.

**O2 Dark Pool.**
- Sealed commit-reveal batches per stock token against USDG, crossed at the Chainlink price on 4663 with limit prices
  and pro-rata fills (Quero's design). There is no AMM leg, so the Uniswap v4 rule does not apply.
- Admission: `commit` requires `msg.sender` to be the signer of an Active session of a verified agent, read from
  `OrreryPolicyModule.signerOf` and `OrreryAttestor.isVerified`. Funds come from the float, so the policy bounds exposure.
- Why it is Orrery's: an agent-only venue where every counterparty's policy is public exists nowhere else on 4663,
  and each trader is a verified agent (fee) and a likely check buyer.
- Effort L: contracts adapted from Quero's (usable as our own, D2), a keeper for settlement, oracle staleness rules
  (Quero's weekend rule for US equity feeds), SDK, web.

**O3 Jobs.** As 3.27 with Q9 and Q10, now built as Orrery's own: USDG escrow, ERC-8004 ids, a Orrery check gate on the
agent, payout to the bound account, ratings written as ERC-8004 feedback only from paid jobs, and a work board where
only verified agents submit. Our own `PrivateJob.sol` (ERC-8183) is the starting point for the job lifecycle.

**O5 Agent Launch and O6 Earn.** Decided in the ORRY session (T3 to T6 in `02-open-questions.md`) and designed in
`ORRY-TOKEN-UTILITY.md`; this document only lists them. In short: verified agents launch coins paired with ORRY,
with a 90-day stake and a 1% swap fee split creator 50%, Earn LPs 20% in ORRY, burn 15%, owner 15%; the Earn vault
funds only the ORRY/ETH hub pool, so LPs never hold launched coins. ORRY itself stays on Pons V2 (T1, U5).
One fact from our own code worth carrying over: Emiten chose a hookless v4 pool because the Uniswap app and the
aggregators on 4663 did not route hooked pools when measured on 2026-10-18 (`emiten/contracts/src/V4Graduator.sol`);
hooked spoke pools need that re-measured before launch.

**O4 Credit.** The agent's x402 `payTo` becomes a Orrery revenue router; a share of each payment repays the line
first. First loss is the operator's bond (D6): the operator locks USDG behind the agentId before the agent may borrow,
as the owner chose earlier in the `agent-credit-docs` design (a 25 USD enrollment bond covering the first tier). The
limit is the lowest of a multiple of trailing revenue, a figure grown by repaid dollar-days, a share of the pool and the
bond at the first tier. Lenders deposit USDG into an ERC-4626 pool and are paid after the bond is used up. This reopens
Q5 ("no bond in v1") for credit only; the bond is new money at risk, so it needs its own invariants (a bond only ever
pays the pool for that agent's default, never anything else).

**O11, one line each.** Prediction markets: agents forecast stock prices, a venue rather than identity. Perps: an
agent trading venue with a heavy risk engine. Baskets: an index token of agent coins, after O5. Limit orders with
keeper tips: resting orders for agents on v4, after O5 and a v4 port. Milestone raises and fee streams: fundraising for
agent builders, after O5. NFT studio, RWA issuance and KYC: no agent use, and KYC conflicts with Q1.

### 8.4 Waves 5 to 7

| Wave | Theme | Items | Owner inputs |
| :--- | :--- | :--- | :--- |
| 5 | Agents earn | O3 Jobs and work board; O8 if 3.19 has not shipped | arbiter holder |
| 6 | Own markets | O1 Shield (ZK first, D3), O2 Dark Pool; O5 Agent Launch, O6 Earn and O7 Buyback follow the ORRY plan's own schedule (T2, T3) | Shield pool fee |
| 7 | Finance and services | O4 Credit (operator bond, D6), O10 Services (own facilitator, D5), O9 Copy | bond size and credit limits; lending and copy review |

Each item goes through the protocol-design method before any code (spec, invariants, Foundry harness, mutation,
fork tests). Order (D1): waves 1 and 2 first, because every market above admits agents through the checks and records
they build, then waves 5 to 7; wave 3 and 4 items can run alongside as capacity allows.

### 8.5 Owner decisions (2026-11-08)

Asked one by one with options; the owner's answers, applied to this document and recorded in `02-open-questions.md`
as U2 to U7 (with notes on Q1, Q5 and I1).

| # | Question | Owner's answer | Effect here |
| :-- | :--- | :--- | :--- |
| D1 | Widen Q1 to a set of agent markets? | Yes, in wave order: waves 1 and 2 first, then the markets of waves 5 to 7 | Q1 widened; 8.4 order fixed |
| D2 | How to use Quero's code (dark pool, escrow, bounty board)? | "We have the clone on this laptop and we are contributors; the project belongs to me and Neo, so its code can be used" | Quero code counts as our own source; no clean-room needed (7.1, 8.1, O2, O3) |
| D3 | Shield privacy scope? | Zero-knowledge proof directly, not disclosure first | O1 redesigned ZK-first (8.3) |
| D4 | ORRY launch venue? | Keep Pons V2, as in `ORRY-TOKEN-UTILITY.md` | An explicit exception to 8.1; O5 Launch is for agent coins only; O7 fits Pons' v4 pool as built |
| D5 | Open Orrery's facilitator to merchants (I1)? | Yes | I1 reversed; 3.24 moves to wave 2 |
| D6 | Who carries first loss in Orrery Credit? | The operator's bond | Q5 reopened for credit only; O4 updated |

### 8.6 Ringkasan untuk owner

Arahan owner sudah diterapkan: Orrery tidak bergantung pada proyek lain. Tawaran integrasi ke Quero dibatalkan,
ketergantungan pada facilitator dan direktori produk lain dihapus, dan facilitator Orrery sendiri naik prioritas.
Semua fitur dari proyek lain sekarang dihitung sebagai fitur Orrery sendiri, dengan kode dari repo kita lebih dulu.
Lima teratas:

1. **Orrery Jobs**: escrow kerja dan papan tugas. Agen dibayar untuk pekerjaan dan rating hanya dari job yang dibayar.
   Dasar: `PrivateJob` milik kita plus desain escrow Quero. Gelombang 5.
2. **Orrery Shield**: saldo dan pembayaran privat dari kode Hushwave kita yang sudah live di 4663, langsung dengan
   bukti ZK (D3). Merchant tidak tahu agen mana yang membayar, hanya bahwa pembayarnya agen terverifikasi yang
   kebijakannya mengizinkan pembayaran itu. Pencabutan sesi berlaku dalam hitungan blok. Ini item terbesar.
   Gelombang 6.
3. **Orrery Dark Pool**: pool tertutup khusus agen terverifikasi untuk token saham, harga dari Chainlink, tanpa AMM.
   Kode Quero boleh dipakai (D2). Gelombang 6.
4. **Agent Launch** (keputusan T3 dan T6 dari sesi ORRY): koin untuk agen terverifikasi, dipasangkan dengan ORRY,
   stake 90 hari. Desainnya ada di dokumen ORRY; ORRY sendiri tetap di Pons V2.
5. **Earn** (T4 dan T5): vault LP yang hanya mendanai pool hub ORRY/ETH; LP tidak pernah memegang koin yang
   diluncurkan. Desainnya ada di dokumen ORRY.

Berikutnya: buyback ORRY dari kode Origo kita (memang dibuat untuk pool v4 Pons), kredit untuk agen dengan jaminan
operator sebagai penanggung kerugian pertama (D6), layanan berbayar milik Orrery, dan copy trading.

Keputusan owner 2026-11-08 (bagian 8.5): Q1 diperluas dengan urutan gelombang 1 dan 2 dulu (D1); kode Quero boleh
dipakai (D2); Shield langsung ZK (D3); ORRY tetap di Pons V2 (D4); facilitator Orrery dibuka untuk merchant dan naik
ke gelombang 2 (D5); kredit memakai jaminan operator (D6). Semuanya sudah dicatat di `02-open-questions.md` sebagai
U2 sampai U7.
