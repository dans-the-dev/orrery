# 09 Invariants, test plan, adversarial review brief

Date: 2026-11-06, revision 2 (after `10-spec-review.md`). Written before any contract code, against
`08-contract-spec.md` revision 2 and `14-services-spec.md`. Each line is a property a test can check. Ids are stable;
the executor maps every id to at least one test and reports the mapping.

## Accounting (A)

- **A1** For every `(account, agentId, token, day)`: `spent ≤ perDay` of the policy in force when each spend happened,
  and the sum of `ToppedUp` amounts plus `Spent` amounts for that key equals `spent` (each outflow emits exactly one of
  the two).
- **A2** Every single `topUp` amount and every single `execute` outflow per token is `≤ perTx`.
- **A3** After any `topUp`, the signer's balance of that token is `≤ floatMax` (native: up to the prepaid-gas error of
  08 §5.4).
- **A4** The account's balance of a capped token falls only through (a) operator-initiated calls, or (b) module calls
  whose decrease was recorded in `spent`. Ghost check: total outflow caused by agent calls = Σ recorded spends.
- **A5** A `topUp` of a fee-on-transfer, rebasing or otherwise non-exact token reverts; the signer receives exactly
  `amount` or nothing.
- **A6** Within any 24-hour sliding window, agent outflow per token is `≤ 2 × perDay`; within one UTC day `≤ perDay`.
- **A7** The module and the attestor never hold a token or native balance after any call (except dust sent by a third
  party, which no function can move).
- **A8** No agent call increases any allowance, operator approval, permit or credit delegation of the account, for any
  token, toward any spender (forbidden selectors and targets). Harness includes a Permit2 handler and an ERC-20 with
  `approve` / `increaseAllowance` / `permit`.
- **A9** A token that has been in a session's caps is in that session's caps until the session ends, so its outflow is
  always measured.
- **A10** `execute` reverts when the account's native balance falls and `NATIVE` is not capped.
- **A11** A `topUp` moves exactly `amount` out of the account and exactly `amount` into the signer, or reverts (CR-07).

## State machine (S)

- **S1** Effective status transitions only: `None → Active`, `Active ⇄ Paused`, `Active|Paused → Revoked`, any non-
  revoked status to `Expired` by time. `Revoked` never changes.
- **S2** No agent function succeeds unless the effective status is `Active` (not paused, not expired, epoch current).
- **S3** After `onUninstall` **or** `onInstall`, every session opened before it is effectively `Revoked` and its pending
  increase can never be applied, at constant gas regardless of how many sessions existed.
- **S4** A signer address that was ever a session signer, on any account, can never be a signer again.
- **S5** `signerOf[signer]` is set once and never changes; agent calls act only for that session.
- **S6** Every operator call except `revoke` and `cancelIncrease`, and every agent call, reverts when
  `account.isModuleInstalled(2, module, "")` is false.
- **S7** `onInstall` and `onUninstall` never revert.
- **S8** `openSession` succeeds only with the signer's EIP-712 consent for that account, agent and policy hash (CR-02).

## Policy changes and delay (P)

- **P1** The signer's authority (any cap, any target, `validUntil`, a shorter `increaseDelay`) never rises before
  `proposedAt + max(MIN_INCREASE_DELAY, increaseDelay in force at proposal)`. Covers `applyIncrease`; `openSession` can
  only create authority for a brand-new signer (S4), never raise an existing signer's.
- **P2** `decreasePolicy` accepts only true decreases (08 §5.2) with the same token list, and applies them in the same
  transaction.
- **P3** A decrease or revoke cancels any pending increase.
- **P4** `OrreryLens.validFor` is an absolute timestamp never later than the earliest moment the signer's authority can
  rise through the module; it equals `now` when a pending increase is ready and whenever the session is not Active,
  not installed, on an Unknown account, or the account shows another grant (CR-05). Owner-level grants outside the
  module are not covered (08 §9).
- **P5** Policy validity (08 §5.6) holds for every stored current and pending policy.
- **P6** `policyHash` always equals `keccak256(abi.encode(stored policy))`, and the last `PolicySet` event for a session
  carries that policy.

## Binding and identity (B)

- **B1** `openSession` succeeds only if `getAgentWallet(agentId) == account` at that moment.
- **B2** After the identity NFT transfers, `OrreryLens` reports `bound = false` and `isVerified = false` until a new fee
  is paid for the new owner; an attestation from before the new payment does not count (`observedAt >= paidAt`).
- **B3** Spending authority does not depend on `bound`; only reporting does.
- **B4** `OrreryLens.accountKind` is `Unknown` for any account that is not a known Safe (known proxy codehash, known
  singleton, Safe7579 adapter enabled and set as fallback handler); `signerIsAccountOwner` is true when the signer owns
  the Safe; `otherAccountModules` is true when the signer is an enabled Safe module, linked or not (CR-01).
- **B5** The lens never shows an attestation older than the current payment, expired, or from a removed attester, and
  never shows a newer session's data for a replaced signer (CR-03).

## Access (X)

- **X1** Only the account itself can call operator functions for its sessions.
- **X2** Only the session's signer can call agent functions, and only for its own session.
- **X3** `execute` cannot call a target outside the allowlist or any forbidden target (capped token, module, account,
  IdentityRegistry, attestor, Permit2, EntryPoints, Safe7579 adapter, any installed module), nor a forbidden selector,
  nor with value, nor with `data.length < 4`.
- **X4** Reentrancy: no state-changing module function can be entered while another is executing.
- **X5** Attestor: only attester keys write attestations, with `attester = msg.sender`; only for verified agents;
  expiry ≤ 7 days ahead; at most 5 attesters and 5 check signers; fee ≤ 50 USDG, never above the payer's `maxFee`, never
  applied to a payment already made.

## Hostile tokens and targets (H)

- **H1** A token whose `transfer` returns false, returns nothing, or reverts leaves no spend recorded.
- **H2** A token whose `balanceOf` lies cannot let `execute` move a capped token unrecorded beyond what its reported
  balance shows; check results state coverage.
- **H3** A malicious allowlisted target that pulls capped tokens through an old approval is counted by balance delta
  and reverts the call when over cap.
- **H4** A target that sends tokens in and out within one call is measured on net decrease only (`max(0, before -
  after)`); a balance rise records nothing and does not revert.

## Fees (F)

- **F1** `payVerification` moves exactly `fee` USDG from payer to treasury (balance delta), or reverts; when the payer is
  the treasury it records a fee of 0.
- **F2** Paying twice for the same `(agentId, owner)` reverts.

## Services (V), tested in E6 to E8

- **V1** Exactly one credit grant per settled `Transfer(payer → treasury, price)`; retries, timeouts and replays never
  grant twice and never lose a mined payment.
- **V2** Credits never go below 0 under parallel requests.
- **V3** One active API key per payer address; rotation needs a single-use SIWE-style message and revokes all old keys.
- **V4** A signed check verifies only under its own EIP-712 domain (chainId, `OrreryAttestor` address) and only for a key
  that `isCheckSigner` returns true for.
- **V5** The prober never connects to a private, loopback, link-local, metadata or IPv4-mapped address, at any redirect
  hop, and never reads more than its decompressed size cap.

## Test plan

| Layer | What | Proof expected |
| :--- | :--- | :--- |
| Unit | Every function, every named revert, every event | `forge test` counts per contract |
| Invariant harness | Handler with bounded actions: open, decrease, propose, apply, cancel, pause, unpause, revoke, install, uninstall (with and without the `onUninstall` call), topUp, execute (honest, hostile, approval-granting and Permit2 targets), warp across days and delays, NFT transfer, set agent wallet, pay fee, attest. Ghost state for A1, A4, A8, P1 | Deep run prints counts per state; asserts each status and each revert path reached > 0 times |
| Mutation | At least: `<` vs `<=` in caps, skip `spent +=`, apply increase without delay, decrease check inverted, token drop allowed in decrease, forbidden-selector check removed, `isModuleInstalled` check removed, missing `bound` check, float check removed, reentrancy guard removed from an operator function, fee recorded before transfer, uninstall or install without epoch bump, `signerOf` overwritable | Every mutation fails a test |
| Fork (4663) | Real IdentityRegistry and USDG: `setAgentWallet` via ERC-1271 from a Safe7579 account, `openSession`, topUp USDG, NFT transfer clears binding; real Safe7579 `executeFromExecutor`; Safe adapter disable and re-enable | Pass with block number recorded |
| Fork (4663) | Kernel 3.1 account same flow, plus uninstall where `onUninstall` reverts | Pass, or recorded as unsupported |
| Services | V1 to V5 with a 4663 fork and `MockUSDG` | Named tests per id |
| Static analysis | Slither if installed | Findings triaged; "not run" if absent |

## Adversarial review brief (for a fresh-context session, after the code exists)

Give the reviewer only the contracts, `08-contract-spec.md` and this file. Ask: can an agent signer move more than the
caps allow, in any token, in any window, or grant itself rights to move them later? Can its authority rise before
`validFor`? Can a counterparty be shown a check result that is stale, about the wrong signer, or about an account that
is not what it claims, without the result admitting it? Can anyone other than the account or its signer change a
session? Can a hostile token or target break accounting? Can fees or credits be lost or double-granted? Report each
finding with a failing test. The spec-level review of 2026-11-06 is in `10-spec-review.md`.
