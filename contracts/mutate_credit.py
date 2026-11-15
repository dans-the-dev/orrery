#!/usr/bin/env python3
"""Mutation check for lane L4 (contracts/src/credit/**), on the pattern of mutate_community.py.

Run from contracts/:  python3 mutate_credit.py            (all)   |   MUT_PATH=CreditPool python3 mutate_credit.py
Works on a copy (default ~/.cache/orrery-l4/mut, override MUT_DIR), never on this checkout: the copy is refreshed from
src/credit and test/credit, each mutation replaces one exact snippet there, runs the credit unit tests and the
deterministic deep run (not the invariant campaigns, not the fork tests) without via-IR, and prints CAUGHT or MISSED.
Equivalent or unreachable mutants, left out on purpose and explained in docs/updates/L4-CREDIT-SPEC.md section 9:
- CreditPool `ZeroShares`: with the 1e6 virtual share scale a deposit of one unit mints shares unless value per share
  rose a millionfold; kept as a guard.
- CreditPool `_distribute` with no shares: shares cannot reach zero while principal is lent out (the last withdrawal
  is above cash), so a seizure always finds shares; kept so a liquidation can never revert on a division by zero.
- Reentrancy guards: every external token is USDG or ORRY (no hooks) and state is written before each transfer.
Two listed mutants are equivalent and stay MISSED by design (2026-11-11 run: 128 mutations, 126 caught):
- "bad v accepted": `ecrecover` already returns address 0 for a v other than 27 or 28, which the caller refuses.
- "distribution rounds up": rounding the accumulator up adds less than totalShares / 1e36 ORRY wei to the sum of
  claims; shares stay far below 1e36 (USDG supply times the 1e6 share scale), so the floor of every claim is unchanged.
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("MUT_DIR", os.path.expanduser("~/.cache/orrery-l4/mut"))

R = "src/credit/AttesterRegistry.sol"
S = "src/credit/AttesterFeeSplitter.sol"
P = "src/credit/CreditPool.sol"
RT = "src/credit/CreditRevenueRouter.sol"
F = "src/credit/CreditPoolFactory.sol"

T = "test/credit/"
REG_TESTS = T + "{AttesterRegistry.t.sol,AttesterFeeSplitter.t.sol,CreditInvariants.t.sol}"
SPL_TESTS = T + "{AttesterFeeSplitter.t.sol,CreditInvariants.t.sol}"
POOL_TESTS = T + "{CreditPool.t.sol,CreditInvariants.t.sol}"
TESTS_FOR = {R: REG_TESTS, S: SPL_TESTS, P: POOL_TESTS, RT: POOL_TESTS, F: POOL_TESTS}

MUTATIONS = [
    # ---------------------------------------------------------------- AttesterRegistry (AT-1, AT-2, AT-4, AT-5)
    (R, "min stake ignored", "if (amount < minStake) revert BelowMinimum();", ""),
    (R, "min stake off by one", "if (amount < minStake) revert BelowMinimum();", "if (amount <= minStake) revert BelowMinimum();"),
    (R, "staker may be a probe key", "if (probeOwner[msg.sender] != address(0)) revert ProbeKeyTaken();", ""),
    (R, "top-up may change key", "        } else if (probeKey != address(0)) {\n            revert BadProbeKey();\n        }", "        }"),
    (R, "stake while unlocking", "        if (s.unlockAt != 0) revert Unlocking();\n        if (s.amount == 0) {", "        if (s.amount == 0) {"),
    (R, "no balance delta check", "if (orry.balanceOf(address(this)) != before + amount) revert InexactTransfer();", ""),
    (R, "total staked not counted", "        totalStaked += amount;\n", ""),
    (R, "candidate cap off", "if (_candidates.length >= MAX_CANDIDATES) revert TooManyCandidates();", "if (_candidates.length > MAX_CANDIDATES) revert TooManyCandidates();"),
    (R, "probe key zero allowed", "if (key == address(0) || key == staker) revert BadProbeKey();", "if (key == staker) revert BadProbeKey();"),
    (R, "probe key = staker allowed", "if (key == address(0) || key == staker) revert BadProbeKey();", "if (key == address(0)) revert BadProbeKey();"),
    (R, "probe key reuse allowed", "if (probeOwner[key] != address(0) || _stakers[key].amount != 0) revert ProbeKeyTaken();", "if (_stakers[key].amount != 0) revert ProbeKeyTaken();"),
    (R, "probe key may be a staker", "if (probeOwner[key] != address(0) || _stakers[key].amount != 0) revert ProbeKeyTaken();", "if (probeOwner[key] != address(0)) revert ProbeKeyTaken();"),
    (R, "old probe key kept", "        delete probeOwner[old];\n", ""),
    (R, "unlock keeps candidacy", "        _removeCandidate(msg.sender);\n        delete probeOwner[s.probeKey];", "        delete probeOwner[s.probeKey];"),
    (R, "unlock keeps probe key", "        _removeCandidate(msg.sender);\n        delete probeOwner[s.probeKey];", "        _removeCandidate(msg.sender);"),
    (R, "unlock stays active", "        _deactivate(currentEpoch(), msg.sender);\n        emit UnlockRequested", "        emit UnlockRequested"),
    (R, "unlock delay skipped", "if (block.timestamp < s.unlockAt) revert StillLocked(s.unlockAt);", ""),
    (R, "unlock delay off by one", "if (block.timestamp < s.unlockAt) revert StillLocked(s.unlockAt);", "if (block.timestamp + 1 < s.unlockAt) revert StillLocked(s.unlockAt);"),
    (R, "withdraw without request", "if (s.unlockAt == 0) revert NotUnlocking();", ""),
    (R, "withdraw keeps entry", "        delete _stakers[msg.sender];\n        totalStaked -= s.amount;", "        totalStaked -= s.amount;"),
    (R, "roll twice", "if (rolled[e]) revert AlreadyRolled();", ""),
    (R, "exclusion ignored", "if (ex != 0 && ex >= e) continue;", ""),
    (R, "exclusion one epoch short", "if (ex != 0 && ex >= e) continue;", "if (ex != 0 && ex > e) continue;"),
    (R, "rank ignores stake", "uint256 k = (uint256(s.amount) << 64) | (type(uint64).max - s.lockedAt);", "uint256 k = type(uint64).max - s.lockedAt;"),
    (R, "rank prefers later lock", "uint256 k = (uint256(s.amount) << 64) | (type(uint64).max - s.lockedAt);", "uint256 k = (uint256(s.amount) << 64) | s.lockedAt;"),
    (R, "tie to higher address", "return ka > kb || (ka == kb && a < b);", "return ka > kb || (ka == kb && a > b);"),
    (R, "heap replace never", "} else if (_above(k, c, key[0], set[0])) {", "} else if (false) {"),
    (R, "heap child pick wrong", "if (m + 1 < cap && _above(key[m], set[m], key[m + 1], set[m + 1])) ++m;", ""),
    (R, "heap push no sift", "            if (!_above(key[parent], set[parent], k, c)) break;", "            break;"),
    (R, "no final sort", "        _sortDesc(set, key, n);\n", ""),
    (R, "active flag not set", "            isActive[e][set[i]] = true;\n", ""),
    (R, "exclude by anyone", "if (msg.sender != attestor.owner()) revert NotAttestorOwner();", ""),
    (R, "exclude keeps active", "        _deactivate(e, staker);\n        emit Excluded", "        emit Excluded"),
    (R, "exclude not into next epoch", "uint64 until = uint64(e + 1);", "uint64 until = uint64(e);"),
    (R, "forward before roll", "if (!rolled[e]) revert NotRolled();", ""),
    (R, "forward from inactive", "if (staker == address(0) || !isActive[e][staker]) revert NotActive();", "if (staker == address(0)) revert NotActive();"),
    (R, "count every result", "bool fresh = !counted[e][staker][agentId];", "bool fresh = true;"),
    (R, "total not counted", "            totalResults[e] += 1;\n", ""),
    (R, "deactivate wrong one", "            if (set[i] == staker) {", "            if (set[i] != staker) {"),
    # ---------------------------------------------------------------- AttesterFeeSplitter (AT-3, AT-6, AT-7)
    (S, "share above cap", "if (shareBps_ > 5000) revert BadShare();", ""),
    (S, "split ignores booked", "uint256 fresh = usdg.balanceOf(address(this)) - booked;", "uint256 fresh = usdg.balanceOf(address(this));"),
    (S, "share rounds up", "toAttesters = fresh * shareBps / BPS;", "toAttesters = (fresh * shareBps + BPS - 1) / BPS;"),
    (S, "treasury not paid", "        _send(treasury, toTreasury);\n        emit Split", "        emit Split"),
    (S, "pool not booked", "        pool[e] += toAttesters;\n", ""),
    (S, "claim open epoch", "if (epoch >= registry.currentEpoch()) revert EpochNotEnded();\n        if (claimed[epoch][msg.sender])", "if (claimed[epoch][msg.sender])"),
    (S, "claim twice", "        claimed[epoch][msg.sender] = true;\n", ""),
    (S, "claim ignores results", "return pool[epoch] * registry.results(epoch, staker) / total;", "return pool[epoch] / total;"),
    (S, "claimable open epoch", "if (epoch >= registry.currentEpoch() || claimed[epoch][staker]) return 0;", "if (claimed[epoch][staker]) return 0;"),
    (S, "booked not reduced on claim", "        booked -= amount;\n        _send(msg.sender, amount);", "        _send(msg.sender, amount);"),
    (S, "release with results", "if (registry.totalResults(epoch) != 0) revert HasResults();", ""),
    (S, "release twice", "if (released[epoch]) revert AlreadyReleased();", ""),
    (S, "release open epoch", "if (epoch >= registry.currentEpoch()) revert EpochNotEnded();\n        if (registry.totalResults", "if (registry.totalResults"),
    (S, "quote reuse", "if (quoteUsed[quoteId]) revert QuoteUsed();", ""),
    (S, "quote not marked", "        quoteUsed[quoteId] = true;\n", ""),
    (S, "expiry ignored", "if (expiry < block.timestamp) revert QuoteExpired();", ""),
    (S, "any signer", "if (signer == address(0) || !IOrreryTreasuryView(treasury).isQuoteSigner(signer)) revert BadQuoteSignature();", "if (signer == address(0)) revert BadQuoteSignature();"),
    (S, "payer not signed", "keccak256(abi.encode(VERIFICATION_TYPEHASH, msg.sender, agentId, orryAmount, quoteId, expiry))", "keccak256(abi.encode(VERIFICATION_TYPEHASH, expectedOwner, agentId, orryAmount, quoteId, expiry))"),
    (S, "high s accepted", "if (uint256(s) > HALF_ORDER) return address(0);", ""),
    (S, "bad v accepted", "if (v != 27 && v != 28) return address(0);", ""),
    (S, "daily cap off", "if (_verifyCount >= MAX_ORRY_VERIFICATIONS_PER_DAY) revert DailyVerificationCap();", "if (_verifyCount > MAX_ORRY_VERIFICATIONS_PER_DAY) revert DailyVerificationCap();"),
    (S, "daily count not reset", "            _verifyCount = 0;\n", ""),
    (S, "burn not checked", "if (supplyBefore - IOrryToken(coin).totalSupply() != orryAmount) revert InexactBurn();", ""),
    (S, "coin unset allowed", "if (coin == address(0)) revert CoinNotSet();", ""),
    (S, "zero amount allowed", "if (orryAmount == 0) revert ZeroAmount();", ""),
    (S, "not treasury allowed", "if (attestor.treasury() != address(this)) revert NotAttestorTreasury();", ""),
    # ---------------------------------------------------------------- CreditPool (CR-1 to CR-11)
    (P, "apr cap", "if (p.aprBps == 0 || p.aprBps > 5000 || p.feeBps > 2000", "if (p.aprBps == 0 || p.feeBps > 2000"),
    (P, "fee cap", "|| p.feeBps > 2000 ||", "||"),
    (P, "tier order unchecked", "if (p.tierRepaid[i] <= p.tierRepaid[i - 1] || p.tierMultBps[i] < p.tierMultBps[i - 1]) revert BadParams();", ""),
    (P, "deposit when retired", "        if (retired) revert PoolRetired();\n        if (assets == 0) revert ZeroAmount();\n        shares", "        if (assets == 0) revert ZeroAmount();\n        shares"),
    (P, "shares round up", "shares = assets * (totalShares + VIRTUAL_SHARES) / (totalAssets() + 1);", "shares = (assets * (totalShares + VIRTUAL_SHARES) + totalAssets()) / (totalAssets() + 1);"),
    (P, "deposit counts balance", "        cash += assets;\n        totalShares += shares;", "        cash = usdg.balanceOf(address(this));\n        totalShares += shares;"),
    (P, "no deposit delta check", "if (token.balanceOf(address(this)) != before + amount) revert InexactTransfer();", ""),
    (P, "withdraw above cash", "        if (assets > cash) revert InsufficientCash();\n        _settle", "        _settle"),
    (P, "withdraw rounds up", "return shares * (totalAssets() + 1) / (totalShares + VIRTUAL_SHARES);", "return (shares * (totalAssets() + 1) + totalShares + VIRTUAL_SHARES - 1) / (totalShares + VIRTUAL_SHARES);"),
    (P, "withdraw cash not reduced", "        cash -= assets;\n        _send(usdg, msg.sender, assets);", "        _send(usdg, msg.sender, assets);"),
    (P, "withdraw more shares", "if (shares > sharesOf[msg.sender]) revert InsufficientShares();", ""),
    (P, "orry checkpoint rounds down", "return up ? (v + ACC - 1) / ACC : v / ACC;", "return v / ACC;"),
    (P, "withdraw skips settle", "        if (assets > cash) revert InsufficientCash();\n        _settle(msg.sender);", "        if (assets > cash) revert InsufficientCash();"),
    (P, "claim keeps pending", "        _orryPending[msg.sender] = 0;\n", ""),
    (P, "bond by non-owner", "if (identity.ownerOf(agentId) != msg.sender) revert NotAgentOwner();\n            l.bondOwner", "l.bondOwner"),
    (P, "takeover with bond", "if (l.bond != 0 || l.principal != 0 || l.interest != 0) revert NotBondOwner();", "if (l.principal != 0 || l.interest != 0) revert NotBondOwner();"),
    (P, "bond after default", "        Line storage l = _lines[agentId];\n        if (l.defaulted) revert LineDefaulted();\n        if (l.bondOwner != msg.sender) {", "        Line storage l = _lines[agentId];\n        if (l.bondOwner != msg.sender) {"),
    (P, "bond total not counted", "        l.bond += _u128(amount);\n        totalBonds += amount;", "        l.bond += _u128(amount);"),
    (P, "withdraw bond with debt", "if (l.principal != 0 || l.interest != 0) revert DebtOutstanding();", ""),
    (P, "withdraw bond by anyone", "        if (l.bondOwner != msg.sender) revert NotBondOwner();\n        if (amount == 0) revert ZeroAmount();\n        if (l.principal", "        if (amount == 0) revert ZeroAmount();\n        if (l.principal"),
    (P, "draw when retired", "        if (retired) revert PoolRetired();\n        if (amount == 0) revert ZeroAmount();\n        Line storage l = _lines[agentId];\n        if (l.defaulted) revert LineDefaulted();\n        if (l.bondOwner", "        if (amount == 0) revert ZeroAmount();\n        Line storage l = _lines[agentId];\n        if (l.defaulted) revert LineDefaulted();\n        if (l.bondOwner"),
    (P, "draw after default", "        if (l.defaulted) revert LineDefaulted();\n        if (l.bondOwner != msg.sender) revert NotBondOwner();\n        if (identity", "        if (l.bondOwner != msg.sender) revert NotBondOwner();\n        if (identity"),
    (P, "draw by old owner", "        if (identity.ownerOf(agentId) != msg.sender) revert NotAgentOwner();\n        if (!attestor", "        if (!attestor"),
    (P, "draw unverified", "if (!attestor.isVerified(agentId)) revert NotVerified();", ""),
    (P, "min bond ignored", "if (bondUsd < minBondUsd || bondUsd == 0) revert BondTooSmall();", "if (bondUsd == 0) revert BondTooSmall();"),
    (P, "limit off by one", "if (debt + amount > limit) revert OverLimit(limit);", "if (debt + amount > limit + 1) revert OverLimit(limit);"),
    (P, "limit ignores interest", "uint256 debt = uint256(l.principal) + l.interest;\n        if (debt + amount", "uint256 debt = uint256(l.principal);\n        if (debt + amount"),
    (P, "draw above cash", "        if (amount > cash) revert InsufficientCash();\n        if (debt == 0)", "        if (debt == 0)"),
    (P, "due date moves", "if (debt == 0) l.dueAt = uint64(block.timestamp) + term;", "l.dueAt = uint64(block.timestamp) + term;"),
    (P, "principal total not counted", "        totalPrincipal += amount;\n        cash -= amount;", "        cash -= amount;"),
    (P, "tier ignored", "limit = bondUsd * tierMultBps(l.repaidUsdDays) / BPS;", "limit = bondUsd * _tm0 / BPS;"),
    (P, "max line ignored", "if (limit > maxLineUsdg) limit = maxLineUsdg;", ""),
    (P, "pool cap ignored", "if (limit > poolCap) limit = poolCap;", ""),
    (P, "tier 3 boundary", "if (usdDays >= _tr3) return _tm3;", "if (usdDays > _tr3) return _tm3;"),
    (P, "tier 1 skipped", "if (usdDays >= _tr1) return _tm1;", ""),
    (P, "age not capped", "if (age > term) age = term;", ""),
    (P, "age ignored", "l.repaidUsdDays += _u128(toPrincipal * age / 1 days);", "l.repaidUsdDays += _u128(toPrincipal * term / 1 days);"),
    (P, "interest rounds down", "return (num + den - 1) / den;", "return num / den;"),
    (P, "interest never accrues", "        if (add != 0) l.interest += _u128(add);\n", ""),
    (P, "accrual clock not moved", "        l.lastAccrual = uint64(block.timestamp);\n    }", "    }"),
    (P, "repay principal first", "uint256 toInterest = rest < l.interest ? rest : l.interest;", "uint256 toInterest = 0;"),
    (P, "fee on whole payment", "uint256 fee = toInterest * feeBps / BPS;", "uint256 fee = paid * feeBps / BPS;"),
    (P, "fee kept in pool", "cash += paid - fee;", "cash += paid;"),
    (P, "overpay pulled", "paid = amount < owed ? amount : owed;", "paid = amount;"),
    (P, "due not cleared", "if (l.principal == 0 && l.interest == 0) l.dueAt = 0;", ""),
    (P, "repaid principal stays in total", "        totalPrincipal -= toPrincipal;\n        rest -= toPrincipal;", "        rest -= toPrincipal;"),
    (P, "liquidate early", "if (block.timestamp <= uint256(l.dueAt) + grace) revert NotDue();", ""),
    (P, "liquidate grace off by one", "if (block.timestamp <= uint256(l.dueAt) + grace) revert NotDue();", "if (block.timestamp < uint256(l.dueAt) + grace) revert NotDue();"),
    (P, "liquidate without debt", "if (principal + interest == 0) revert NothingOwed();", ""),
    (P, "no write-off", "        totalPrincipal -= principal;\n        uint256 seized", "        uint256 seized"),
    (P, "no recovery", "l.recovery += _u128(principal + interest);", ""),
    (P, "not terminal", "        l.defaulted = true;\n", ""),
    (P, "bond not seized", "        l.bond = 0;\n        totalBonds -= seized;", "        totalBonds -= seized;"),
    (P, "seized not distributed", "        _distribute(seized);\n", ""),
    (P, "distribution rounds up", "accOrryPerShare += total * ACC / s;", "accOrryPerShare += (total * ACC + s - 1) / s;"),
    (P, "retire by anyone", "if (msg.sender != factory) revert NotFactory();", ""),
    (P, "payout to bond owner", "            if (w != address(0)) return w;", ""),
    # ---------------------------------------------------------------- CreditRevenueRouter (CR-6)
    (RT, "router pays more than owed", "toPool = share < owed ? share : owed;", "toPool = share;"),
    (RT, "router repays everything", "uint256 share = bal * repayBps / BPS;", "uint256 share = bal;"),
    (RT, "router keeps remainder", "toAgent = bal - toPool;", "toAgent = 0;"),
    (RT, "router fails on blocked wallet", "            if (failed) toAgent = 0; // kept for the next sweep", "            require(!failed);"),
    # ---------------------------------------------------------------- CreditPoolFactory (CR-8)
    (F, "create by anyone", "if (msg.sender != ITreasuryOwner(treasury).owner()) revert NotTreasuryOwner();", ""),
    (F, "retire unknown pool", "if (!isPool[pool]) revert UnknownPool();", ""),
]


def sync_copy():
    os.makedirs(WORK, exist_ok=True)
    for d in ("src/credit", "test/credit"):
        dst = os.path.join(WORK, d)
        if os.path.exists(dst):
            shutil.rmtree(dst)
        shutil.copytree(os.path.join(HERE, d), dst)
    for f in ("src/OrreryAttestor.sol", "src/interfaces", "src/orry/interfaces", "src/markets/interfaces", "test/mocks"):
        src, dst = os.path.join(HERE, f), os.path.join(WORK, f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.isdir(src):
            if os.path.exists(dst):
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    lib = os.path.join(WORK, "lib")
    if not os.path.exists(lib):
        os.makedirs(lib)
        os.symlink(os.path.join(HERE, "lib/forge-std"), os.path.join(lib, "forge-std"))
        os.symlink(os.path.realpath(os.path.join(HERE, "lib/v4-periphery")), os.path.join(lib, "v4-periphery"))
    shutil.copy2(os.path.join(HERE, "foundry.toml"), os.path.join(WORK, "foundry.toml"))


def forge_env():
    env = dict(os.environ)
    env.update(
        FOUNDRY_SRC="src/credit",
        FOUNDRY_TEST="test/credit",
        FOUNDRY_VIA_IR="false",
        FOUNDRY_OUT=os.path.join(WORK, "out"),
        FOUNDRY_CACHE_PATH=os.path.join(WORK, "cache"),
        CREDIT_DEEP_STEPS=os.environ.get("CREDIT_DEEP_STEPS", "1500"),
    )
    return env


sync_copy()
env = forge_env()
only = sys.argv[1] if len(sys.argv) > 1 else None
path_filter = os.environ.get("MUT_PATH", "")
originals = {}
results = []
base = subprocess.run(["forge", "test", "--no-match-test", "invariant_", "--no-match-path", "test/credit/fork/*"], cwd=WORK, env=env, capture_output=True, text=True)
if base.returncode != 0:
    print(base.stdout[-3000:], base.stderr[-2000:])
    sys.exit("baseline fails in the copy; fix that first")
try:
    for path, name, old, new in MUTATIONS:
        if only and only not in name:
            continue
        if path_filter and path_filter not in path:
            continue
        full = os.path.join(WORK, path)
        if path not in originals:
            originals[path] = open(full).read()
        src = originals[path]
        assert src.count(old) == 1, f"snippet must occur once for: {name} (found {src.count(old)})"
        open(full, "w").write(src.replace(old, new, 1))
        args = ["forge", "test", "--match-path", TESTS_FOR[path], "--no-match-test", "invariant_"]
        run = subprocess.run(args, cwd=WORK, env=env, capture_output=True, text=True)
        out = run.stdout + run.stderr
        if "Compiler run failed" in out or "Error (" in out:
            verdict = "COMPILE"
        else:
            verdict = "CAUGHT" if run.returncode != 0 else "MISSED"
        open(full, "w").write(src)
        results.append((verdict, os.path.basename(path), name))
        print(f"{verdict:8} {os.path.basename(path):26} {name}", flush=True)
finally:
    for path, src in originals.items():
        open(os.path.join(WORK, path), "w").write(src)

caught = sum(1 for r in results if r[0] == "CAUGHT")
missed = [r for r in results if r[0] == "MISSED"]
comp = [r for r in results if r[0] == "COMPILE"]
print(f"\n{len(results)} mutations: {caught} caught, {len(missed)} missed, {len(comp)} did not compile")
for r in missed + comp:
    print("  ", r)
