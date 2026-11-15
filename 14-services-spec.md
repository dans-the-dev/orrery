# 14 Services spec (v1)

Date: 2026-11-06, revision 2 (after `10-spec-review.md`). Off-chain parts around the contracts in
`08-contract-spec.md`. Language for every service: TypeScript on Node (delegated: shares types and code with the SDK,
Q6). One Postgres database. Chain 4663, rehearsal on 46630.

## 1. Services at a glance

| Service | Job | Talks to |
| :--- | :--- | :--- |
| `facilitator` (internal) | Verify and settle x402 `exact` payments in USDG for our own API | 4663 RPC, Postgres |
| `api` | Sells credit packs over x402; serves paid signed checks; public read endpoints for the web app | facilitator, Postgres, prober cache, `OrreryLens` |
| `prober` | Probes verified agents' registration files and endpoints; posts attestations on-chain | ERC-8004 registry, the internet, `OrreryAttestor` |
| `indexer` | Indexes module, attestor and ERC-8004 events into Postgres | 4663 RPC |
| `web` | Operator app, public agent page, docs | api, wallets (EIP-6963) |
| `sdk` | TypeScript package for operators, agents and counterparties | contracts, api |

## 2. Facilitator (internal only in v1)

Serves only our `api`; not offered to other merchants in v1 (I1). Scheme `exact`, network `eip155:4663`, asset USDG.
Payers are EOAs (float wallets, Q8).

Settlement procedure (R-M4), idempotent per `(payer, nonce)`:

1. Verify the authorization: `to == treasury`, `value == pack price`, `validAfter <= now`, `validBefore >= now + 2 min`,
   signature valid for the USDG EIP-712 domain (name "Global Dollar", version "1").
2. Insert the row `(payer, nonce, status = pending)` **before** broadcasting; a unique key stops a second worker.
3. If `authorizationState(payer, nonce)` is already used, do not broadcast: find the transaction that used it (the
   `AuthorizationUsed` log) and continue at step 5 with that transaction.
4. Broadcast from the relayer; record the tx hash on the row. On timeout, re-read by hash and by nonce state; never
   re-broadcast a used nonce (USDG replays succeed silently and move nothing).
5. Settled only when a receipt at a defined confirmation depth (start with 10 blocks, about 1 s on 4663) holds
   `Transfer(payer → treasury, price)`. Then grant credits once (unique grant row per `(payer, nonce)`).

Relayer gas ≈ 85,400 per settlement (≈ $0.004 at 2026-11-06 prices). Relayer key in
`~/.secrets/<project>/mainnet-relayer.json`; balance alarm on low ETH.

## 3. API

| Endpoint | Auth / payment | Behaviour |
| :--- | :--- | :--- |
| `POST /v1/credits` | x402, price = pack price (guess $1 USDG) | On settlement: credits += pack size (guess 500) for the payer address. The **first** purchase by an address returns an API key (shown once, stored hashed); later purchases top up the same balance and return no key (R-M5). |
| `GET /v1/credits` | API key | Remaining credits, purchase history |
| `POST /v1/keys/rotate` | Signed SIWE-style message: domain, chainId, address, single-use server nonce, expiry ≤ 5 min | Revokes **all** keys of the address, returns one new key. One active key per address. |
| `GET /v1/check/by-signer/{address}` | API key, costs 1 credit | Signed check for the session whose signer is `address` (the address that paid you). Primary endpoint (R-H3). |
| `GET /v1/check/by-agent/{agentId}?account=` | API key, costs 1 credit | Signed check for that agent's session on that account |
| `GET /v1/agents/{agentId}`, `GET /v1/signers/{address}` | Public, rate-limited | On-chain data only (`OrreryLens` view, last on-chain attestation) for the public pages; no fresh probe, no signature |

Credits are decremented with one atomic `UPDATE ... SET credits = credits - 1 WHERE credits > 0` (R-L5). A request
that fails before a signed result exists (our RPC, prober or signer error) is not charged; a request for an unknown
signer or agent is charged, because "no session" is itself an answer. Credits do not expire.

## 4. Signed check result

EIP-712 typed data, domain `{name: "Orrery Check", version: "1", chainId, verifyingContract: OrreryAttestor}` (R-M3).
Signed by a key for which `OrreryAttestor.isCheckSigner` is true; that set is separate from the attester keys (R-L7).

```
CheckResult {
  address signer; address account; uint256 agentId; uint64 sessionEpoch; uint64 sessionCreatedAt;
  address owner; bool bound; bool installed; uint8 status; uint8 accountKind; bool signerIsAccountOwner; bool otherAccountModules;
  bool signerHasCode; uint64 paidAt;
  bytes32 policyHash; TokenView[] caps;          // token, perTx, perDay, floatMax, spentToday
  bytes32 targetsHash; uint64 policyValidUntil; uint32 increaseDelay;
  bytes32 pendingHash; uint64 pendingReadyAt;
  uint64 validFor;                               // absolute timestamp (08 §9)
  bool verified; uint64 probedAt; bool endpointsLive; bool registrationValid; bool domainVerified;
  uint64 issuedAt; uint64 validUntil; uint64 blockNumber;
}
```

`validUntil = issuedAt` when status is not Active, `installed` is false, `bound` is false, `accountKind` is Unknown,
`signerIsAccountOwner`, `otherAccountModules` or `signerHasCode` is true (the on-chain `validFor` is then already `now`);
otherwise `min(validFor, probedAt + 10 min)`. The JSON response adds the full target list, the pending policy, the
registration file URL and a `coverage` field: "outflow of the listed tokens and native from this account by this
signer". There is no single "trusted" flag.

## 5. Prober

- Scope: agents with `isVerified == true`.
- Every 6 hours, and on demand when a paid check finds the cached probe older than 10 minutes: resolve `tokenURI`
  (`ipfs://` via a gateway, `https://` direct), validate the registration file (ERC-8004 shape: `type`, `name`,
  `services`, `registrations` containing this `agentRegistry` + `agentId`), probe at most **10** advertised HTTPS
  services on port 443 (GET, 5 s timeout, 2xx = live), check the optional well-known domain file.
- On-chain `attest` only when the result changed or the last attestation is older than 24 hours; `expiresAt = now + 7
  days`; `observedAt` = probe time.
- SSRF guards (R-M6): resolve once, validate the IP, then **connect to that IP** (SNI and Host set to the name); repeat
  at every redirect hop (max 3); refuse private, loopback, link-local, CGNAT, multicast, `0.0.0.0/8`, metadata, IPv6
  ULA (`fc00::/7`), IPv6 link-local and IPv4-mapped (`::ffff:0:0/96`) ranges and non-canonical IP literals; cap the
  **decompressed** body at 256 KB; one probe per host per minute; no cookies or credentials.

## 6. Indexer

- Block rate on 4663 is 101 ms (≈ 859,000 blocks a day, workspace rule 7). Poll `eth_getLogs` filtered by address in
  ranges of at most 10,000 blocks (some Pocket backends reject larger ranges, seen 2026-11-06), about 86 calls a day at
  idle.
- Sources: module and attestor events (policies come from `PolicySet` logs alone, R-L5); ERC-8004 `Transfer` and
  `MetadataSet` for **every** agentId (binding comes before the session); on each identity `Transfer`, re-read
  `getAgentWallet` (the clear may emit nothing). Full ERC-8004 history on 4663 is 21,497 mints so far (measured).
- RPC: request-priced keyless endpoints that serve history: Pocket (`robinhood.api.pocket.network`), then globalstake or
  blockmachine. `robinhood-rpc.publicnode.com` keeps only ~100 blocks of logs. The official RPC challenges Node clients
  from servers.
- Health: lag against chain head, not "backfill finished". Progress-based watchdog. Never share a key with a public
  relay.

## 7. SDK (`@orrery/sdk`, TypeScript, viem)

| Part | Functions |
| :--- | :--- |
| Operator | `installModule(account)`, `bindIdentity(agentId, account)` (ERC-1271 proof for `setAgentWallet`), `openSession` (generates a fresh signer and has it sign the EIP-712 `SessionConsent`; signers are single-use), `decreasePolicy`, `proposeIncrease`, `applyIncrease`, `pause`, `revoke`, `payVerification(agentId, expectedOwner, maxFee)`, `fundSignerGas(amount)` (the first ETH must come from the operator) |
| Agent | `ensureGas()` (after the first funding, tops up `NATIVE` if capped), `ensureFloat(token, needed)`, an x402 fetch wrapper that calls `ensureFloat` before paying, `getAllowance()` (remaining today, float headroom) |
| Counterparty | `buyCredits()`, `checkPayer(address)` (primary), `checkAgent(agentId, account)`, `verifyCheck(result)` (EIP-712 domain and `isCheckSigner` on-chain), `readOnChain(signer)` via `OrreryLens` |

Supported accounts in v1: Safe with the Safe7579 adapter; Kernel 3.1 if E1 passes. Python wrapper in v1.1 (Q6).

## 8. Web

Next.js, hosted per the owner's hosting decision. Wallet connect by EIP-6963, brand-neutral, picker only when more
than one wallet is present. Chain 4663 by default.

| Page | Content |
| :--- | :--- |
| Landing | What a check proves, how a counterparty checks the address that paid it, SDK snippet, pricing (pack price and verification fee as configured) |
| Operator app | Accounts and agents, bind identity, open session with a policy editor (caps per token, float ceiling, targets, expiry, increase delay ≥ 1 hour), pending increases with countdown, pause, revoke, spend per day from the indexer, pay verification |
| Agent page `/agent/{agentId}`, signer page `/signer/{address}` | Public on-chain data: owner, bound account, account kind, caps, targets, increase delay, last attestation |
| Credits | Buy a pack (x402 from the connected wallet), see balance, rotate key |
| Docs | SDK guide, check result fields, x402 examples |

Copy rules: English, no disclaimers, no "testnet" (46630 is "development network"), no admin-power or risk sentences,
numbers only from real reads. Design pass per the workspace no-slop and web3-design skills before any UI code.

## 9. Keys and wallets

`~/.secrets/<project>/`: `46630-deployer.json`, `46630-relayer.json`, `46630-attester.json`, `46630-check-signer.json`,
and the same set for `mainnet-` when the owner approves. The attester key (posts attestations) and the check-signer key
(signs results) are separate so one leak does not forge both (R-L7). Attestor owner and treasury: the owner's own
wallet (one-wallet rule). Test wallets funded from the testnet bank and swept back after tests.
