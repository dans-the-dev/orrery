#!/usr/bin/env python3
"""Mutation check for Orrery contracts (protocol-design template, several source files).

Run from contracts/:  python3 mutate.py
Each mutation replaces one exact snippet, runs the unit tests and the deterministic deep run (not the long invariant
campaign), restores the source, and prints CAUGHT or MISSED.
"""
import re
import subprocess

TEST_ARGS = ["heavy", "forge", "test", "--no-match-test", "invariant_"]
M = "src/OrreryPolicyModule.sol"
A = "src/OrreryAttestor.sol"
L = "src/OrreryLens.sol"

MUTATIONS = [
    (M, "per-tx cap off by one", "if (amount > cap.perTx) revert PerTxExceeded();", "if (amount > cap.perTx + 1) revert PerTxExceeded();"),
    (M, "daily cap off by one (topUp)", "if (newSpent > cap.perDay) revert DailyCapExceeded();\n        uint256 before", "if (newSpent > cap.perDay + 1) revert DailyCapExceeded();\n        uint256 before"),
    (M, "topUp does not record spend", "_spent[account][agentId][token][day] = newSpent;", ""),
    (M, "execute does not record spend", "_spent[account][agentId][cap.token][day] = newSpent;", ""),
    (M, "execute per-tx check removed", "if (d > cap.perTx) revert PerTxExceeded();", ""),
    (M, "apply increase without delay", "if (block.timestamp < pend.readyAt) revert IncreaseNotReady();", ""),
    (M, "decrease check inverted", "if (!_isDecrease(cur, p)) revert NotDecrease();", "if (_isDecrease(cur, p) && false) revert NotDecrease();"),
    (M, "token substitution counted as decrease", "if (!found) return false;", "if (!found) continue;"),
    (M, "propose may drop a token", "_requireKeepsTokens(cur, p);", ""),
    (M, "forbidden selector check removed", "if (isForbiddenSelector(sel)) revert ForbiddenSelector(sel);", ""),
    (M, "permit2 not forbidden", "|| target == attestor || target == permit2 ||", "|| target == attestor ||"),
    (M, "capped token allowed as target", "if (caps[i].token == target) revert ForbiddenTarget(target);", ""),
    (M, "installed-module targets allowed", "if (_isModuleInstalled(account, typeId, target)) revert ForbiddenTarget(target);", ""),
    (M, "agent call skips install check", "agentId = r.agentId;\n        _requireInstalled(account);", "agentId = r.agentId;"),
    (M, "binding check removed", "if (identityRegistry.getAgentWallet(agentId) != account) revert NotBound();", ""),
    (M, "float check removed", "if (before + amount > cap.floatMax) revert FloatExceeded();", ""),
    (M, "exact-transfer check removed", "if (_balanceOf(token, msg.sender) != before + amount || _balanceOf(token, account) + amount != accountBefore) {\n            revert InexactTransfer();\n        }", ""),
    (M, "reentrancy guard removed", "if (_lock != 1) revert Reentrancy();", ""),
    (M, "uninstall without epoch bump", "epoch[msg.sender] = old + 1;", ""),
    (M, "install without epoch bump", "epoch[msg.sender] = e;", ""),
    (M, "epoch ignored in effective status", "if (s.epoch != epoch[account]) return Status.Revoked;", ""),
    (M, "signer reuse allowed", "if (_signerOf[signer].account != address(0)) revert SignerUsed();", ""),
    (M, "decrease keeps pending increase", "_clearPending(account, agentId);\n\n        emit PolicyDecreased", "\n        emit PolicyDecreased"),
    (M, "short calldata check removed", "if (data.length < 4) revert ShortCalldata();", ""),
    (M, "native outflow check removed", "if (!nativeCapped && account.balance < nativeBefore) revert NativeOutflow();", ""),
    (M, "signer consent not checked", "if (_recover(consentDigest(account, agentId, h), signerConsent) != signer) revert InvalidSignerConsent();", ""),
    (M, "consent digest ignores policy", "abi.encode(SESSION_CONSENT_TYPEHASH, account, agentId, policyHash)", "abi.encode(SESSION_CONSENT_TYPEHASH, account, agentId, bytes32(0))"),
    (M, "account-side top-up delta removed", "_balanceOf(token, msg.sender) != before + amount || _balanceOf(token, account) + amount != accountBefore", "_balanceOf(token, msg.sender) != before + amount"),
    (M, "Safe-level module targets allowed", "if (_isSafeModule(account, target)) revert ForbiddenTarget(target);", ""),
    (M, "relayer approval not forbidden", "|| selector == SEL_SET_RELAYER_APPROVAL", ""),
    (M, "expiry check removed", "if (block.timestamp > pol.validUntil) revert Expired();", ""),
    (A, "fee transfer skipped", "} else if (f != 0) {", "} else if (false) {"),
    (A, "fee delta check removed", "if (feeToken.balanceOf(t) != before + f) revert InexactTransfer();", ""),
    (A, "verification ignores owner change", "return abi.decode(ret, (address)) == v.ownerAtPayment;", "return true;"),
    (A, "maxFee ignored", "if (f > maxFee) revert FeeChanged();", ""),
    (A, "attester taken from calldata", "stored.attester = msg.sender;", ""),
    (A, "stale observation accepted", "if (a.observedAt < v.paidAt || a.observedAt > block.timestamp) revert BadObservedAt();", "if (a.observedAt > block.timestamp) revert BadObservedAt();"),
    (A, "attestation TTL doubled", "a.expiresAt > block.timestamp + MAX_ATTESTATION_TTL", "a.expiresAt > block.timestamp + MAX_ATTESTATION_TTL * 2"),
    (A, "attester key cap removed", "if (attesterCount >= MAX_ATTESTERS) revert TooManyKeys();", ""),
    (A, "expectedOwner ignored", "if (agentOwner != expectedOwner) revert OwnerChanged();", ""),
    (A, "old attestation kept on payment", "uint64(block.timestamp), recorded);\n        delete _attestations[agentId];", "uint64(block.timestamp), recorded);"),
    (A, "fee cap removed", "if (newFee > feeCap) revert FeeAboveCap();", ""),
    (L, "validFor ignores a ready increase", "v.validFor = pend.readyAt <= nowTs ? nowTs : pend.readyAt;", "v.validFor = pend.readyAt;"),
    (L, "replaced signer shown as active", "if (module.getSession(account, agentId).signer != signer) {", "if (false) {"),
    (L, "fallback handler not checked", "if (fb.length != 32 || address(uint160(uint256(bytes32(fb)))) != safe7579Adapter) {", "if (false) {"),
    (L, "signer as hidden Safe module not flagged", "if (signer != address(0) && ISafeMin(account).isModuleEnabled(signer)) otherModules = true;", ""),
    (L, "validFor window kept when not active", ") v.validFor = nowTs;", ") {}"),
    (L, "stale attestation shown", "if (a.observedAt >= v.paidAt && a.expiresAt > block.timestamp && attestor.isAttester(a.attester)) {", "if (true) {"),
    (L, "expired shown as active", "if ((st == OrreryPolicyModule.Status.Active || st == OrreryPolicyModule.Status.Paused) && block.timestamp > p.validUntil)", "if (false)"),
]

originals = {}
results = []
try:
    for path, name, old, new in MUTATIONS:
        if path not in originals:
            originals[path] = open(path).read()
        src = originals[path]
        assert src.count(old) == 1, f"snippet must occur once for: {name} (found {src.count(old)})"
        open(path, "w").write(src.replace(old, new, 1))
        run = subprocess.run(TEST_ARGS, capture_output=True, text=True)
        out = run.stdout + run.stderr
        failed = sorted(set(re.findall(r"\[FAIL[^\]]*\] (\w+)", out)))
        compile_error = "Compiler run failed" in out
        results.append((name, failed, compile_error))
        open(path, "w").write(src)
        print(("CAUGHT  " if failed or compile_error else "MISSED  ") + name + (f"  by {', '.join(failed[:3])}" if failed else (" (compile error)" if compile_error else "")), flush=True)
finally:
    for path, src in originals.items():
        open(path, "w").write(src)

caught = sum(1 for _, f, c in results if f or c)
print(f"\n{caught}/{len(results)} mutations caught")
