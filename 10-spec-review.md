# 10 Independent spec review (2026-11-06)

A fresh-context reviewer read `08`, `09`, `14` and `02` (revision 1) with no code present and no access to the
planning session's reasoning. Findings and what the planning session did with each. All were accepted; ids `R-…` are
cited in the revised specs.

| Id | Severity | Finding | Resolution |
| :--- | :--- | :--- | :--- |
| R-C1 | Critical | Dropping a token from caps counted as a decrease but left the token unmeasured, so an allowlisted target could move it uncapped, instantly | Tokens can never be dropped from a session; set caps to 0 instead (08 §4, §5.2; 09 A9) |
| R-H1 | High | Rights granted through allowlisted calls (approve, Permit2, permit, approveDelegation, EntryPoint `withdrawTo`, other modules) escape the balance-delta check | Forbidden selectors and forbidden targets in policy validity and at call time (08 §3, §5.6; 09 A8, X3) |
| R-H2 | High | Revoke and reopen, reinstall or rebinding raised authority instantly while an old check still read as true for "agent N" | Checks are about one signer; signers are single-use globally; result carries signer, epoch, createdAt (08 §4, §9; 14 §4; 09 P1, S4) |
| R-H3 | High | A counterparty could not get from the paying address to the policy | Global `signerOf` reverse lookup, `checkBySigner`, `/v1/check/by-signer` (08 §4, §9; 14 §3, §7) |
| R-H4 | High | Any contract could call `onInstall` and pose as a capped account with a backdoor | Authority requires live `isModuleInstalled`; `OrreryLens` reports account kind against known Safe7579 and Kernel 3.1 implementations and whether the signer owns the Safe; unknown accounts get `validUntil = issuedAt` (08 §5, §9; 09 B4, S6) |
| R-M1 | Medium | Uninstall that skips `onUninstall` (Kernel, Safe adapter disable) blocks reinstall or revives sessions | `onInstall` and `onUninstall` never revert and both bump the epoch; adapter re-enable reviving sessions is documented as an operator action (08 §5.1; 09 S3, S7) |
| R-M2 | Medium | "Worst-case loss = float" was false | Bound restated: `perDay` per UTC day, `2 × perDay` per 24 h, until revoke (08 §5.4; 02 Q8 corrected) |
| R-M3 | Medium | `validFor` meant a duration in 08 and a timestamp in 14; check results missed fields; no EIP-712 domain | `validFor` is an absolute timestamp (`now` when an increase is ready); fields added; domain bound to chain and attestor (08 §9; 14 §4; 09 P4, V4) |
| R-M4 | Medium | Facilitator could lose a mined payment on retry or double-submit | Row before broadcast, recover via `AuthorizationUsed`, grant once per `(payer, nonce)`, confirmation depth (14 §2; 09 V1) |
| R-M5 | Medium | API key rotation replayable; several live keys | SIWE-style single-use message, one key per address, rotation revokes all (14 §3; 09 V3) |
| R-M6 | Medium | Prober SSRF gaps (DNS rebinding, mapped IPv6, gzip bomb, fan-out) | Connect to the validated IP per hop, wider blocked ranges, decompressed cap, max 10 services on 443 (14 §5; 09 V5) |
| R-L1 | Low | Reentrancy guard scope inconsistent | Guard on every state-changing function (08 §5; 09 X4) |
| R-L2 | Low | Outflow undefined when a balance rises; native outflow without a native cap | `d = max(0, before - after)`; revert on native outflow when `NATIVE` is not capped (08 §5.3; 09 A10, H4) |
| R-L3 | Low | `bytes4(data)` on short data | Require `data.length >= 4` |
| R-L4 | Low | `decreasePolicy` skipped validity | Validity on every policy write |
| R-L5 | Low | Double-counted events; policy only "stored"; indexer misses binding; credit race | `ToppedUp` xor `Spent`; full policy in `PolicySet`; index all identities; atomic credit decrement (08 §8; 14 §3, §6) |
| R-L6 | Low | Fee raise could hit a pending payment; treasury self-pay; stale attestation; attester spoofable | `maxFee`, treasury self-pay recorded as 0, `observedAt >= paidAt`, `attester = msg.sender` (08 §6) |
| R-L7 | Low | One hot key signs checks and posts attestations; first gas for `ensureGas` | Separate attester and check-signer key sets; operator funds first gas (08 §6, §5.5; 14 §7, §9) |

Additions by the planning session while applying the review: `transfer` and `transferFrom` are also forbidden
selectors (an allowlisted transfer of an unlisted token would be uncapped); signers must be EOAs
(`signer.code.length == 0`).

Reviewer's "checked and sound" list: module-built call mode (no batch or delegatecall path), O(1) epoch revocation,
operator calls through Safe `execTransaction` or a Kernel user operation, module-owned storage, exact-amount `topUp`,
the facilitator's `Transfer`-log rule, increase-delay arithmetic, the 2× window statement, the indexer call budget.

Not re-reviewed after the fixes: revision 2 has not had a second independent pass. The adversarial review after the
code exists (09, last section) remains required.

## Code review (2026-11-06)

A fresh-context reviewer read the contracts, `08` and `09`, and wrote a failing Foundry test for every High and Medium
finding (`contracts/test/review/`). All were accepted and fixed; the review tests now pass as regression tests.

| Id | Severity | Finding | Resolution |
| :--- | :--- | :--- | :--- |
| CR-01 | High | A Safe owner can write a module entry for the signer by delegatecall without linking it; Safe 1.4.1 `isModuleEnabled` and `execTransactionFromModule` only test `modules[x] != 0`, so the lens certified a capped Safe7579 while the signer could drain it | Lens flags the signer as a Safe module (linked or not); 08 §9 states what no read can exclude (hidden entries for other contracts, pre-signed transactions) |
| CR-02 | Medium | Any account could bind a victim's public hot wallet as its signer, burning the address (single-use) and misattributing its payments | `openSession` requires the signer's EIP-712 consent over account, agent and policy hash |
| CR-03 | Medium | After an identity transfer and a new payment the lens showed the previous owner's attestation as current | Payment deletes earlier attestations; the lens shows only current, unexpired attestations from active attesters; `paidAt` exposed |
| CR-04 | Medium | The forbidden-selector list missed deferred-pull grants (relayer approvals, pre-signatures, Comet `allow`, Morpho `setAuthorization`, ERC-6909, DAI permit and others) | 12 selectors added; 08 states the list is a deny list |
| CR-05 | Medium | `validFor` promised a window for a paused session that can unpause at once | `validFor = now` whenever the session is not Active or the account shows any other grant |
| CR-06 | Low | Installed-module target check ignored Safe-level modules | Safe `isModuleEnabled(target)` also forbids a target |
| CR-07 | Low | `topUp` measured only the signer's side | The account must also fall by exactly `amount` |
| CR-08 | Low | The fallback handler was not checked | Lens requires the fallback-handler slot to hold the adapter |
| CR-09 | Low | Fee payer could not pin the owner it pays for | `payVerification(agentId, expectedOwner, maxFee)` |
| CR-10 | Low | The Arbitrum sequencer may set timestamps somewhat ahead; the 1-hour delay trusts the Robinhood Chain sequencer | Recorded in `05-risks.md` |
| Info | | Paused and expired read as Paused; a replaced signer's view showed the new session's data; signer may gain code via EIP-7702; `feeCap` cast unchecked | Expired now covers paused; replaced signers return a bare Revoked view; `signerHasCode` reported and closes the window; decimals capped at 30 |

Not changed, by design: `onInstall` and `onUninstall` stay outside the reentrancy guard so they never revert (they only
bump the caller's epoch). Any ERC-7579 validator sets `otherAccountModules`, so accounts that rely on a 4337 validator
get no signed window; this keeps the claim conservative.
