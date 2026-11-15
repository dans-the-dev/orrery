# 08 Contract spec (v1)

Date: 2026-11-06, revision 3 (after the spec review and the code review, see `10-spec-review.md`). Status: ready for the executing
agent. Decisions referenced by id from `02-open-questions.md`. Chain: Robinhood Chain 4663 (Q2), development network
46630. Solidity, Foundry. No proxies: every contract here is immutable once deployed.

## 0. Product in one paragraph

An operator owns an ERC-7579 smart account that holds an agent's funds and is bound to the agent's ERC-8004 identity.
The operator installs `OrreryPolicyModule` and opens a **session** for the agent: the agent's hot wallet (an EOA, the
**signer**) may move money out of the account only through the module, within public caps. For x402 payments the agent
tops up its hot wallet (the **float**) and pays from it as any x402 client does (Q8). Anyone can read the policy on-chain
and look it up **from the paying address**; a prober adds liveness attestations; a counterparty buys signed, fresh
check results (Q4, Q9). Every claim is about one signer: "payments from this address are capped like this".

## 1. Outside dependencies (verified 2026-11-06 unless noted)

| Dependency | Address on 4663 | Used for | Notes |
| :--- | :--- | :--- | :--- |
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `ownerOf(agentId)`, `getAgentWallet(agentId)` | Code present. **Upgradeable** (behind a proxy per repo README); its admin is outside our control (I10). 46630: `0x8004A818BFB912233c491871b3d84c89A494BD9e`. |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | Verification fee, typical float token | 6 decimals, name "Global Dollar" (eth_call). Issuer can freeze and wipe. A replayed EIP-3009 nonce succeeds without moving funds (fork, 2026-09-20). Canonical address has no code on 46630; an owner-mint-only test token `0x7E95…802F` exists there (full address to confirm from the Echo project) or deploy a same-interface mock. |
| ERC-7579 accounts | Safe7579 adapter `0x7579EE8307284F293B1927136486880611F20002`; Safe 1.4.1 singletons `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` (L2) and `0x41675C099F32341bf84BFc5382aF534df5C7461a`; SafeProxyFactory 1.4.1 `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`; Kernel 3.1 factory `0xaac5…E419` | Host the module | Verified 2026-11-06: adapter `accountId()` = `rhinestone.safe7579.v1.0.0`, singleton `VERSION()` = `1.4.1`; the v1.0.0 adapter uses `initializeAccount(validators, executors, fallbacks, hooks, registryInit)` with `ModuleInit{module, initData}`; the Safe7579 launchpad is **not** deployed on 4663. Full flow proven on a 4663 fork (contracts/test/fork). Kernel 3.1: not tested yet. |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Forbidden target | Code present. |
| EntryPoint 0.7 / 0.8 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` / `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` | Forbidden targets | Code present. |

The `agentWallet` field of ERC-8004 can only be set by the identity owner with an EIP-712 or ERC-1271 proof from the new
wallet, and **is cleared automatically when the identity NFT is transferred** (spec text, read 2026-11-06). v1 uses it as
the binding: an account is bound to `agentId` iff `getAgentWallet(agentId) == account` (I6). Whether the registry emits
an event when it clears the field is not verified; the indexer re-reads it on every identity `Transfer` (14 §6).

## 2. Contracts

| Contract | Job | Admin |
| :--- | :--- | :--- |
| `OrreryPolicyModule` | ERC-7579 executor module (type 2). Sessions, caps, float top-ups, allowlisted calls, delayed increases. One deployment serves every account. | **None.** No owner, no pause, no upgrade. |
| `OrreryAttestor` | Verification fee record per agentId (I5), liveness attestations, the list of keys allowed to post attestations and to sign check results. | One owner wallet with the capped powers in section 7. |
| `OrreryLens` | Stateless view: assembles check data from the module, the attestor, the registry and the account itself; detects the account kind. | None. Known implementation addresses are constructor immutables. |

## 3. Constants

| Name | Value | Source |
| :--- | :--- | :--- |
| `MIN_INCREASE_DELAY` | 1 hour | I4 (owner) |
| `MAX_INCREASE_DELAY` | 30 days | delegated |
| `MAX_TOKENS` | 8 per session | delegated, bounds gas of balance-delta checks |
| `MAX_TARGETS` | 32 per session | delegated |
| `MAX_ATTESTERS`, `MAX_CHECK_SIGNERS` | 5 each | delegated; two separate key sets (R-L7) |
| `FEE_CAP` | 50 USDG (`50e6`) | delegated; actual fee is a guess of 5 USDG (Q4) |
| `DAY` | 86 400 s, fixed UTC buckets `block.timestamp / DAY` | delegated, see 5.4 |
| `NATIVE` | `address(0)` stands for ETH in token lists | |
| `FORBIDDEN_SELECTORS` | `approve(address,uint256)`, `increaseAllowance(address,uint256)`, `increaseApproval(address,uint256)`, `setApprovalForAll(address,bool)`, EIP-2612 and DAI-style `permit`, Permit2 `approve` and `permit` (single and batch), `approveDelegation`, `transfer`, `transferFrom`, ERC-721 and ERC-1155 `safeTransferFrom` / `safeBatchTransferFrom`, `setRelayerApproval`, `setPreSignature`, `allow(address,bool)`, `setAuthorization(address,bool)`, ERC-6909 `setOperator` and `approve(address,uint256,uint256)`, `authorizeOperator`, `approveAndCall`, `transferAndCall`, Safe AllowanceModule `setAllowance` (26 selectors, listed with signatures in the code) | R-H1, code review CR-04. This is a deny list: an allowlisted function not on it that registers a right or an order can still move value outside the caps (stated in coverage) |

## 4. Data model (`OrreryPolicyModule`)

```solidity
struct TokenCap { address token; uint128 perTx; uint128 perDay; uint128 floatMax; }
struct Target   { address target; bytes4 selector; }            // value is always 0 on allowlisted calls
struct Policy   { TokenCap[] caps; Target[] targets; uint64 validUntil; uint32 increaseDelay; }

enum Status { None, Active, Paused, Revoked }

struct Session {
    address signer;         // agent hot wallet (EOA), receives float
    Status  status;
    uint64  epoch;          // account epoch at opening
    uint64  createdAt;
    uint64  policyChangedAt;
    bytes32 policyHash;     // keccak256(abi.encode(Policy))
}
struct Pending  { bytes32 policyHash; uint64 readyAt; }          // queued increase, at most one per session
struct SignerRef { address account; uint256 agentId; }

mapping(address => mapping(uint256 => Session)) sessions;  // account => agentId
mapping(address => mapping(uint256 => Policy))  policies;
mapping(address => mapping(uint256 => Pending)) pending;   // plus the full pending Policy
mapping(address => mapping(uint256 => Policy))  pendingPolicy;
mapping(address => mapping(uint256 => mapping(address => mapping(uint256 => uint256)))) spent; // account, agentId, token, day
mapping(address => SignerRef) signerOf;   // signer => (account, agentId); GLOBAL, set once, never cleared
mapping(address => uint64)    epoch;      // account => epoch, +1 on every install and every uninstall
```

Rules:

- **A signer is single-use, globally** (R-H2, R-H3): once an address has been the signer of any session on any account,
  it can never be a signer again. `signerOf` is the public reverse lookup from a paying address to its session.
- **Effective status** of a session: `Revoked` if `session.epoch != epoch[account]`, else `Expired` if
  `now > policy.validUntil` (reported only; stored status unchanged), else the stored status. Every check in this spec
  and in `OrreryLens` uses the effective status.
- **A token, once in a session's caps, stays in the caps for the life of the session** (R-C1). Policies can lower its
  caps to 0 but never drop the entry, so its outflow is always measured.

## 5. Functions

All functions revert with named errors. One module-wide reentrancy guard covers **every** state-changing function
(R-L1). Operator functions use `msg.sender` as `account` (the operator calls through its own account: Safe
`execTransaction` or a Kernel user operation). Agent functions are called by the signer directly and act on its account
via `IERC7579Account(account).executeFromExecutor(mode = single call, revert on failure, ...)`; the module builds the
mode itself, so the agent can never select batch or delegatecall.

**Installed** means `IERC7579Account(account).isModuleInstalled(2, address(this), "")` returns true, read live on every
operator and agent call (R-H4, R-M1). The module's own flag is not trusted for authority.

### 5.1 Module lifecycle

| Function | Checks | Effects |
| :--- | :--- | :--- |
| `onInstall(bytes)` | never reverts | `epoch[msg.sender] += 1` (any session from before this install stays effectively `Revoked`, even if `onUninstall` never ran); `ModuleInstalled(account, newEpoch)` |
| `onUninstall(bytes)` | never reverts | `epoch[msg.sender] += 1`; `AllSessionsRevoked(account, oldEpoch)`. O(1), no loop |
| `isModuleType(uint256 t)` | | `t == 2` |
| `isInitialized(address a)` | | `epoch[a] % 2 == 1` (odd after an install, even after an uninstall); informational only |

A Safe that disables and later re-enables the Safe7579 adapter without calling `onUninstall` gets its old sessions back,
because the adapter keeps its module list. That is an operator action on the operator's own account, equivalent to
unpause. While the adapter is disabled `installed` may still read true (the fallback still answers); `OrreryLens` reports
`accountKind = Unknown` because the adapter is no longer an enabled module (CR-08).

`onInstall` and `onUninstall` are deliberately outside the reentrancy guard so they never revert; each only bumps
`epoch[msg.sender]`.

### 5.2 Operator (caller = account)

| Function | Checks | Effects |
| :--- | :--- | :--- |
| `openSession(agentId, signer, Policy p, signerConsent)` | installed; `getAgentWallet(agentId) == msg.sender` (`NotBound`); no session for agentId with effective status other than `Revoked` (`SessionExists`); `signer != 0`, `signer.code.length == 0`, `signer != msg.sender`, `signerOf[signer].account == 0` (`SignerUsed`); `p` valid (5.6); `signerConsent` is the signer's 65-byte ECDSA signature (low s) over EIP-712 `SessionConsent(address account,uint256 agentId,bytes32 policyHash)` in domain `{name: "Orrery Policy Module", version: "1", chainId, verifyingContract: module}` (`InvalidSignerConsent`, CR-02) | session `Active`, `epoch = epoch[account]`, policy and hash stored, old pending cleared, `signerOf[signer] = (account, agentId)`, `SessionOpened` + `PolicySet` |
| `decreasePolicy(agentId, Policy p)` | installed; effective status `Active` or `Paused`; `p` valid (5.6); `p` is a decrease (below) | applied at once, pending cleared, `PolicyDecreased` + `PolicySet` |
| `proposeIncrease(agentId, Policy p)` | installed; effective status not `Revoked`; `p` valid; `p` keeps every current token; `p` is not a decrease | `pendingPolicy = p`, `pending = {hash, now + max(MIN_INCREASE_DELAY, current.increaseDelay)}`, replaces older pending, `IncreaseProposed(readyAt)` + `PolicySet(pending)` |
| `applyIncrease(agentId)` | installed; pending exists; `now >= readyAt`; effective status not `Revoked`; pending policy still valid (5.6) | policy = pending, `PolicyIncreased` + `PolicySet` |
| `cancelIncrease(agentId)` | pending exists | cleared, `IncreaseCancelled` |
| `pause(agentId)` / `unpause(agentId)` | installed; Active / Paused | status flip, events. Unpause restores the same caps, so it is instant |
| `revoke(agentId)` | effective status not `Revoked` | `Revoked`, pending cleared, `SessionRevoked`. Works even when not installed |

A **decrease** means: the same token list (same tokens, any order), every `perTx`, `perDay`, `floatMax` ≤ the old value,
the target set a subset, `validUntil` not later, `increaseDelay` not shorter. Anything else is an increase, including
shortening `increaseDelay`, extending `validUntil` and adding a token. Dropping a token is never allowed (rule above).

### 5.3 Agent (caller = signer)

Common checks: `(account, agentId) = signerOf[msg.sender]` exists (`UnknownSigner`); installed on `account`
(`NotInstalled`); session signer is `msg.sender` and effective status is `Active` (`NotActive`, `Expired`).

| Function | Extra checks | Effects |
| :--- | :--- | :--- |
| `topUp(token, amount)` | token in caps (`TokenNotAllowed`); `0 < amount <= perTx`; `spent[day] + amount <= perDay` (`DailyCapExceeded`); `balanceOf(signer) + amount <= floatMax` (`FloatExceeded`; native uses `signer.balance`) | `spent[day] += amount`; account executes `token.transfer(signer, amount)` (or native send); require the signer's balance rose by exactly `amount` **and** the account's fell by exactly `amount` (CR-07); `ToppedUp` |
| `execute(target, data)` | `data.length >= 4` (R-L3); `(target, bytes4(data))` in targets (`TargetNotAllowed`); target not forbidden and selector not forbidden (5.6, re-checked at call time because installed modules can change) | snapshot the account's balance of every capped token and of native; account executes the call with value 0; for each capped token `d = max(0, before - after)` (R-L2) must satisfy `d <= perTx` and `spent[day] + d <= perDay`, then `spent[day] += d` with a `Spent` event; if native decreased and `NATIVE` is not capped, revert (`NativeOutflow`); `Executed` |

Coverage, stated in every check result: `execute` measures outflow of **capped tokens and native only**. Allowlisted
targets that can move other assets of the account (vault shares, unlisted tokens) do so outside the caps; the operator
should cap every token an allowlisted target can move. Granting rights (approvals, permits, delegations) through an
allowlisted call is blocked by the forbidden selectors and targets (R-H1).

### 5.4 Day buckets and the loss bound

Spend is tracked per fixed UTC day. **Worst case with a stolen signer key, per token: `perDay` within one UTC day and at
most `2 × perDay` within any 24-hour window, until the operator revokes** (R-M2). `floatMax` limits how much sits in the
hot wallet at one moment, not the total loss; repeated top-ups are bounded only by `perDay`. For `NATIVE`, the
`signer.balance` read inside the call is already reduced by the transaction's prepaid gas; the error is at most
`gasLimit × gasPrice` (about $1 at 30 M gas and 0.02 gwei) and is accepted.

### 5.5 Gas for the agent

The signer pays gas in ETH for `topUp` and `execute`; x402 payments cost the payer no gas (the facilitator settles).
The **first** ETH for gas must come from the operator (a `topUp` itself needs gas). After that the policy may list
`NATIVE` so the SDK's `ensureGas()` tops up ETH within `perTx`, `perDay` and `floatMax`. On 4663 at 0.02 gwei a `topUp`
costs well under a cent (re-measure in E1).

### 5.6 Policy validity

Checked on `openSession`, `decreasePolicy`, `proposeIncrease` and `applyIncrease` (R-L4):

- `caps.length` in 1..`MAX_TOKENS`, unique tokens, `perTx <= perDay`, `floatMax <= perDay`;
- `targets.length <= MAX_TARGETS`, unique pairs;
- no target equal to: a capped token, the module, the account, the IdentityRegistry, the attestor, Permit2, either
  EntryPoint, the Safe7579 adapter, any address for which `account.isModuleInstalled(t, target, "")` is true for
  `t` in 1..4, or any Safe-level module (`isModuleEnabled(target)`, CR-06). Safe7579 may revert on types 3 and 4 with
  an empty context; those then read as not installed (not verified on fork);
- no selector in `FORBIDDEN_SELECTORS`;
- `validUntil > now`; `increaseDelay` in `MIN_INCREASE_DELAY..MAX_INCREASE_DELAY`.

## 6. `OrreryAttestor`

```solidity
struct Verification { address ownerAtPayment; uint64 paidAt; uint128 feePaid; }
struct Attestation  { uint64 observedAt; uint64 expiresAt; bool endpointsLive; bool registrationValid;
                      bool domainVerified; bytes32 registrationHash; address attester; }
```

| Function | Who | Checks | Effects |
| :--- | :--- | :--- | :--- |
| `payVerification(agentId, expectedOwner, maxFee)` | anyone | agent exists; `ownerOf == expectedOwner` (`OwnerChanged`, CR-09); not currently verified (`AlreadyVerified`); `fee <= maxFee` (`FeeChanged`, R-L6) | pulls `fee` USDG from caller to `treasury`; balance-delta check of the treasury, skipped when caller is the treasury (fee then recorded as 0); stores `ownerOf(agentId)` and `paidAt`; **deletes any earlier attestation** (CR-03); `VerificationPaid` |
| `isVerified(agentId)` view | | | `paidAt != 0 && ownerOf(agentId) == ownerAtPayment` (I5) |
| `attest(agentId, Attestation a)` | attester key | `isVerified`; `paidAt <= a.observedAt <= now`; `observedAt` newer than stored; `now < a.expiresAt <= now + 7 days` | stored with `attester = msg.sender` (calldata value ignored); `Attested` |
| `clearAttestation(agentId)` | attester key or owner | | deleted, `AttestationCleared` |
| `setAttester(addr, bool)` / `setCheckSigner(addr, bool)` | owner | at most 5 active in each set | event |
| `isCheckSigner(addr)` view | | | used by anyone verifying a signed check offline |
| `setFee(uint128)` | owner | `<= FEE_CAP` | applies to future payments only |
| `setTreasury(addr)` | owner | non-zero | event |
| `transferOwnership` (2-step) | owner | | |

The attestor holds no balance: `payVerification` sends straight to `treasury`. A previous owner's attestation stops
counting after a transfer because `isVerified` turns false and a new attestation needs `observedAt >= paidAt`.

## 7. Admin powers, exhaustive

| Power | Holder | Cap |
| :--- | :--- | :--- |
| Add or remove attester keys | Attestor owner | max 5 active |
| Add or remove check-signer keys | Attestor owner | max 5 active |
| Set verification fee | Attestor owner | ≤ 50 USDG; never retroactive; payers protect themselves with `maxFee` |
| Set treasury | Attestor owner | non-zero |
| Write or clear attestations | Attester keys | only for paid, current agents; expiry ≤ 7 days |

Nobody can: move funds from any account, change or pause a session, override caps or delays, upgrade any contract, or
take fees already paid back. The module has no admin. The account's own owner keeps full control of the account; the
module limits the **signer**, not the operator.

## 8. Events

`ModuleInstalled(account, epoch)`, `AllSessionsRevoked(account, oldEpoch)`,
`SessionOpened(account, agentId, signer, epoch)`, `PolicySet(account, agentId, bool isPending, Policy policy, bytes32 hash)`
(full policy in the log, so the indexer works from logs alone, R-L5), `PolicyDecreased`, `IncreaseProposed(account,
agentId, hash, readyAt)`, `PolicyIncreased`, `IncreaseCancelled`, `SessionPaused`, `SessionUnpaused`, `SessionRevoked`,
`ToppedUp(account, agentId, token, amount, day, spentToday)` (top-ups emit only this), `Spent(account, agentId, token,
amount, day, spentToday)` (`execute` outflows only), `Executed(account, agentId, target, selector)`,
`VerificationPaid(agentId, payer, owner, fee)`, `Attested(agentId, attester, observedAt, expiresAt)`,
`AttestationCleared`, `AttesterSet`, `CheckSignerSet`, `FeeSet`, `TreasurySet`.

## 9. `OrreryLens`

`checkBySigner(signer)` and `checkByAgent(agentId, account)` return the same view:

| Field | Meaning |
| :--- | :--- |
| `signer`, `account`, `agentId`, `sessionEpoch`, `createdAt` | Who the claim is about (R-H2, R-H3) |
| `bound` | `getAgentWallet(agentId) == account` |
| `owner` | `ownerOf(agentId)` |
| `installed` | live `isModuleInstalled` |
| `status` | effective status (`None`, `Active`, `Paused`, `Revoked`, `Expired`) |
| `accountKind` | `Safe7579` or `Unknown`: the account's runtime codehash is a known Safe proxy codehash, the singleton read through `getStorageAt(0, 1)` is a known Safe singleton, the Safe7579 adapter is an enabled module, and the fallback-handler slot holds the adapter (CR-08). Kernel 3.1 is reported `Unknown` until it is tested |
| `otherAccountModules` | Any enabled Safe module other than the adapter (first 10 of the list), the signer itself as a Safe module even when it is not linked into the list (CR-01), any ERC-7579 executor other than this module, or any ERC-7579 validator on the adapter |

What the view cannot exclude: an owner can still give the signer power outside the module in ways no read can see (a
module entry for some other contract written by delegatecall without linking it, pre-signed Safe transactions). The
claim is therefore "this module limits this signer, and the account shows no other known grant", and the operator remains
able to override it, as the owner of any account can. A Safe guard that forbids DELEGATECALL would narrow this; not in v1.
| `signerIsAccountOwner` | for a Safe, `isOwner(signer)`; must be false for the claim to mean anything |
| `signerHasCode` | the signer has code now (for example an EIP-7702 delegation set after opening) |
| `caps` with `spentToday`, `targets`, `validUntil`, `increaseDelay` | Current policy |
| `pending` | hash, `readyAt`, full pending policy |
| `validFor` (absolute timestamp) | The earliest moment the signer's authority can rise through the module: `now` if a pending increase is ready, `pending.readyAt` if one is waiting, else `now + increaseDelay` (R-M3). It is `now` whenever the status is not Active, the module is not installed, the account kind is Unknown, `otherAccountModules`, `signerIsAccountOwner` or `signerHasCode` (CR-05) |
| `verified`, `paidAt`, `attestation` | From the attestor. The attestation is shown only when `observedAt >= paidAt`, it has not expired, and its attester is still active (CR-03) |

A signed check (14 §4) sets `validUntil = issuedAt` when `status != Active`, `installed == false`, `bound == false`,
`accountKind == Unknown`, `signerIsAccountOwner` or `otherAccountModules`, so such a result never claims a future window; otherwise `validUntil = min(validFor,
probedAt + 10 min)`.

## 10. Not in v1

Bonds and slashing (Q5). Rolling windows. Per-recipient limits on float spending (Q8). ERC-4337 validator path.
Validation Registry integration. Measuring assets the policy does not list. Phase 2 performance tracking and phase 3
copy. Deployment beyond 4663 and 46630 (contracts are chain-agnostic; addresses are constructor arguments).

## 11. Open points for the executor to verify, not to decide

1. Confirm the Safe7579 adapter and Kernel 3.1 on 4663 against vendor docs; record versions and the addresses `OrreryLens`
   needs (Safe singletons, adapter, Kernel implementation).
2. Confirm `executeFromExecutor` mode encoding (single call, revert on failure) and `isModuleInstalled` on both.
3. Confirm Kernel 3.1 behaviour when `onUninstall` reverts or is skipped (the reviewer believes it is called with an
   excessively-safe call); the epoch-on-install rule must hold either way.
4. Confirm IdentityRegistry `getAgentWallet` on 4663 by fork test: set via ERC-1271 from a Safe7579 account, transfer
   the NFT, assert it reads zero; record whether an event is emitted on the clear.
5. Confirm USDG `transfer` from a smart account works with no extra hooks (issuer freeze aside).
6. Compute every selector in `FORBIDDEN_SELECTORS` with `cast sig` and list it in code with its signature.
