# 04 Architecture draft

> **Superseded** by `08-contract-spec.md` (contracts) and `14-services-spec.md` (services). Kept as the first
> sketch. Differences: there is no separate `PolicyRegistry`; the module stores policies and `OrreryLens` serves the reads.
> The verifier became the `prober` and `api` services; checks are sold as credit packs (Q9), not per call.

Date: 2026-11-06. Draft; Q1 = A, Q3 = A and Q2 = 4663 are now decided (`02-open-questions.md`), so the facilitator row is in scope. Increase delay minimum 1 hour (I4); fee once per agentId (I5); binding void on identity transfer (I6).

## Components (assuming Q1 = provable policy, Q3 = ERC-7579 module)

| Component | Job |
| :--- | :--- |
| `PolicyModule` (ERC-7579 validator/hook) | Enforces per-agent limits on the operator's smart account: per-transaction cap, rolling daily cap per token, target allowlist (contract + selector), expiry, pause by operator, revocation. Session key = the agent's signer. |
| `PolicyRegistry` | Public read view: for an ERC-8004 `agentId`, the bound account, policy hash, caps per token, allowlist root, last change time, pending increases. Raising a cap or widening the allowlist waits a delay; lowering or revoking is instant. |
| `OrreryAttestor` | Records verifier attestations per `agentId`: endpoint live at time T, registration file valid, owner of identity NFT matches account owner. No bond in v1 (Q5). Liveness attestations expire and are re-probed. Written by allowlisted verifier keys (capped admin power). |
| Verifier service | Off-chain: fetches the ERC-8004 registration file, probes advertised endpoints, checks domain verification, reads `PolicyRegistry`, signs and posts attestations; answers paid `GET /check/{agentRegistry}/{agentId}` over x402 with a signed result. |
| SDK (TypeScript first) | Agent side: create account + session, x402 client that checks policy before signing. Counterparty side: one call to check an agent before serving or paying. |
| Facilitator (only if Q2 picks 4663) | x402 facilitator for USDG on 4663 (`receiveWithAuthorization` / `transferWithAuthorization` quirks known from earlier work). |
| Indexer + API | Indexes policy and attestation events; feeds the dashboard and the check endpoint. Measure block rate first (4663 = 101 ms). |
| Operator dashboard | Connect wallet (EIP-6963), register / link ERC-8004 identity, set and change limits, revoke, see agent spend. |

## Check result (what a counterparty gets)

```
agentRegistry, agentId, account,
caps: [{token, perTx, perDay, spentToday}], allowlistRoot, policyChangedAt, pendingIncreaseAt,
endpointLiveAt, registrationValid, ownerMatches, verificationPaid,
validUntil, verifierSig
```

The result states numbers, not a single "trusted" flag.

## State machine (agent policy)

`None → Active → (Paused ⇄ Active) → Revoked` ; pending increases sit beside `Active` until their delay passes. Revoked
is terminal for that session key; a new session starts a new policy.

## Later phases (not v1)

- Phase 2: performance tracker over settled, policy-bound payments and trades (counted only against distinct verified
  counterparties).
- Phase 3: controlled copy with high-watermark fee and paper mode.
