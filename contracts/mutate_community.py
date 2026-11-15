#!/usr/bin/env python3
"""Mutation check for lane L1 Community (contracts/src/community/**), on the pattern of test/markets/mutate_markets.py.

Run from contracts/:  python3 mutate_community.py
Each mutation replaces one exact snippet, runs the community unit tests and deterministic deep runs that cover that file
(not the invariant campaigns, not the fork tests), restores the source, and prints CAUGHT or MISSED.
MUT_PATH=Cashback (a file name part) runs only that contract's mutations; an argument filters by mutation name.
Equivalent mutants left out on purpose (documented in docs/updates/L1-COMMUNITY-SPEC.md 6 and the lane report):
- RewardPool's reentrancy guard: every payout sets `claimed` (or reduces the books) before the transfer, so removing the
  guard changes no outcome; it stays as defence in depth.
"""
import os
import re
import subprocess
import sys

D = "src/community/"
P = D + "RewardPool.sol"
A = D + "OrryAchievements.sol"
SV = D + "verifiers/StakeUsdVerifier.sol"
AV = D + "verifiers/VerifiedAgentVerifier.sol"
B = D + "OrryPriced.sol"
C = D + "OrryChat.sol"
N = D + "OrryNames.sol"
BO = D + "OrryBoost.sol"
S = D + "OrryPasses.sol"
K = D + "TemplateMarket.sol"
R = D + "ReferralRegistry.sol"
W = D + "CashbackRewards.sol"
MO = D + "Months.sol"

T = "test/community/"
POOL_TESTS = T + "{RewardPool.t.sol,OrryAchievements.t.sol,OrryChat.t.sol,PaidUtilities.t.sol,invariant/PoolInvariants.t.sol}"
ACH_TESTS = T + "{OrryAchievements.t.sol,invariant/PoolInvariants.t.sol}"
CHAT_TESTS = T + "{OrryChat.t.sol,invariant/PoolInvariants.t.sol}"
PAID_TESTS = T + "{OrryChat.t.sol,PaidUtilities.t.sol,OrryAchievements.t.sol}"
CASH_TESTS = T + "{CashbackRewards.t.sol,invariant/CashbackInvariants.t.sol}"
TESTS_FOR = {P: POOL_TESTS, A: ACH_TESTS, SV: ACH_TESTS, AV: ACH_TESTS, B: PAID_TESTS, C: CHAT_TESTS, N: PAID_TESTS,
             BO: PAID_TESTS, S: PAID_TESTS, K: PAID_TESTS, R: CASH_TESTS, W: CASH_TESTS, MO: CASH_TESTS}

MUTATIONS = [
    # ---------------------------------------------------------------- RewardPool (C-2, C-3, C-4, C-7, C-8)
    (P, "lock cap ignored", "if (amount > cap) revert AboveLockCap(amount, cap);", ""),
    (P, "lock cap counts locked", "return _free[asset] * MAX_LOCK_BPS / BPS;", "return (_free[asset] + _locked[asset]) * MAX_LOCK_BPS / BPS;"),
    (P, "fund without balance delta", "if (IERC20Pool(asset).balanceOf(address(this)) - before != amount) revert InexactTransfer();", ""),
    (P, "eth fund mismatch accepted", "if (msg.value != amount) revert EthAmountMismatch();", ""),
    (P, "sync books the whole balance", "booked = held - books;", "booked = held;"),
    (P, "publish after the deadline", "if (block.timestamp >= e.deadline) revert PastDeadline();", ""),
    (P, "duplicate winners accepted", "if (w == address(0) || amounts[i] == 0 || prizeOf[id][w] != 0) revert BadWinners();", "if (w == address(0) || amounts[i] == 0) revert BadWinners();"),
    (P, "prizes above the locked amount", "if (sum > e.amount) revert AboveLocked();", ""),
    (P, "remainder not returned", "_free[e.asset] += returned;", ""),
    (P, "max winners off by one", "if (n == 0 || n > MAX_WINNERS || n != amounts.length) revert BadWinners();", "if (n == 0 || n > MAX_WINNERS + 1 || n != amounts.length) revert BadWinners();"),
    (P, "replace twice", "if (e.replaced) revert AlreadyReplaced();", ""),
    (P, "replace after the window", "if (block.timestamp >= e.payableAt) revert WindowClosed();", ""),
    (P, "replace keeps old prizes", "delete prizeOf[id][old[i]];", ""),
    (P, "window not restarted on replace", "e.payableAt = uint64(block.timestamp) + CHECK_WINDOW;", "if (e.payableAt == 0) e.payableAt = uint64(block.timestamp) + CHECK_WINDOW;"),
    (P, "prize before the window", "if (block.timestamp < e.payableAt) revert NotPayableYet(e.payableAt);", ""),
    (P, "prize paid twice", "claimed[id][winner] = true;", ""),
    (P, "claimFor pays the caller", "return _payPrize(id, winner, winner);", "return _payPrize(id, winner, msg.sender);"),
    (P, "expire before the deadline", "if (block.timestamp < e.deadline) revert DeadlineNotReached();", ""),
    (P, "expire sends to the admin", "_free[e.asset] += amount;\n        emit EventExpired", "_send(e.asset, admin, amount);\n        emit EventExpired"),
    (P, "expire a published event", "if (e.status != Status.Open) revert BadStatus();\n        if (block.timestamp < e.deadline)", "if (block.timestamp < e.deadline)"),
    (P, "achievement hooks open", "if (msg.sender != achievements) revert NotAchievements();", ""),
    (P, "admin gate open", "if (msg.sender != admin) revert NotAdmin();", ""),
    (P, "admin accepted by anyone", "if (msg.sender != pendingAdmin || msg.sender == address(0)) revert NotAdmin();", ""),
    (P, "deadline unbounded", "if (deadline <= block.timestamp || deadline > block.timestamp + MAX_DURATION) revert BadDeadline();", "if (deadline <= block.timestamp) revert BadDeadline();"),
    (P, "achievement payout keeps its lock", "achievementLocked[asset] -= amount;\n        _locked[asset] -= amount;\n        _send", "_locked[asset] -= amount;\n        _send"),
    (P, "release keeps the lock", "achievementLocked[asset] -= amount;\n        _locked[asset] -= amount;\n        _free[asset] += amount;", "_locked[asset] -= amount;\n        _free[asset] += amount;"),
    # ---------------------------------------------------------------- OrryAchievements (A-1 to A-6)
    (A, "verifier ignored", "if (!IAchievementVerifier(a.verifier).isComplete(msg.sender, data)) revert ConditionNotMet();", ""),
    (A, "recipient cap off by one", "if (a.paid >= a.maxRecipients) revert Full();", "if (a.paid > a.maxRecipients) revert Full();"),
    (A, "on-chain claim twice", "if (claimed[id][msg.sender]) revert AlreadyClaimed();", ""),
    (A, "on-chain claim after the deadline", "if (block.timestamp >= a.deadline) revert PastDeadline();\n        if (claimed[id][msg.sender])", "if (claimed[id][msg.sender])"),
    (A, "listed beyond the cap", "if (a.paid + a.listed + n > a.maxRecipients) revert Full();", ""),
    (A, "listed out of order", "if (t < last || t > block.timestamp) revert BadCompleters();", "if (t > block.timestamp) revert BadCompleters();"),
    (A, "listed in the future", "if (t < last || t > block.timestamp) revert BadCompleters();", "if (t < last) revert BadCompleters();"),
    (A, "listed duplicate", "if (acct == address(0) || listedAt[id][acct] != 0 || claimed[id][acct]) revert BadCompleters();", "if (acct == address(0)) revert BadCompleters();"),
    (A, "listed claim before the window", "if (block.timestamp < claimableAt) revert NotClaimableYet(claimableAt);", ""),
    (A, "listed claim by an unlisted address", "if (at == 0) revert NotListed();\n        if (claimed[id][account])", "if (claimed[id][account])"),
    (A, "listed claim after the deadline", "if (block.timestamp >= a.deadline) revert PastDeadline();\n        uint64 at = listedAt[id][account];", "uint64 at = listedAt[id][account];"),
    (A, "close twice", "if (a.closed) revert AlreadyClosed();", ""),
    (A, "close before the deadline", "if (block.timestamp < a.deadline) revert DeadlineNotReached();", ""),
    (A, "close returns every slot", "returned = uint256(a.maxRecipients - a.paid) * a.rewardPerUser;", "returned = uint256(a.maxRecipients - a.paid - (a.paid > 0 ? 1 : 0)) * a.rewardPerUser;"),
    (A, "unlist after the window", "if (block.timestamp >= at + pool.CHECK_WINDOW()) revert WindowClosed();", ""),
    (A, "unlist keeps the slot", "a.listed -= 1;\n        emit CompleterUnlisted", "emit CompleterUnlisted"),
    (A, "lock only one reward", "pool.lockForAchievement(asset, rewardPerUser * maxRecipients);", "pool.lockForAchievement(asset, rewardPerUser);"),
    (A, "listed window past the deadline", "if (claimableAt > a.deadline) revert PastDeadline();", ""),
    (A, "anyone creates", "if (msg.sender != pool.admin()) revert NotAdmin();", ""),
    (A, "listed deadline without room for the window", "uint64 minEnd = uint64(block.timestamp) + (verifier == address(0) ? pool.CHECK_WINDOW() : 0);", "uint64 minEnd = uint64(block.timestamp);"),
    (SV, "stake threshold exclusive", "return StakeUsd.valueOf(staking, orryPrice, account) >= minStakeUsd;", "return StakeUsd.valueOf(staking, orryPrice, account) > minStakeUsd;"),
    (SV, "stake valued while the price is not ready", "if (!r) return 0;", ""),
    (AV, "agent owner not checked", "if (!ok || ret.length < 32 || abi.decode(ret, (address)) != account) return false;", "if (!ok || ret.length < 32) return false;"),
    (AV, "verification not checked", "return IAttestorVerified(attestor).isVerified(agentId);", "return true;"),
    (AV, "agent id length not checked", "if (data.length != 32) return false;", "if (data.length < 32) return false;"),
    # ---------------------------------------------------------------- OrryPriced (shared by chat, names, boost, passes, market)
    (B, "max price ignored", "if (amount > maxOrry) revert PriceAboveMax(amount, maxOrry);", ""),
    (B, "ready ignored", "if (!_ready()) revert PriceNotReady();\n        try", "try"),
    (B, "pull not delta checked", "if (orry.balanceOf(to) - before != amount) revert InexactTransfer();", ""),
    (B, "burn not supply checked", "if (supply - orry.totalSupply() != amount) revert InexactTransfer();", ""),
    (B, "burn skipped", "orry.burn(amount);", ""),
    (B, "burn event amount wrong", "emit Burned(source, amount);", "emit Burned(source, amount / 2);"),
    # ---------------------------------------------------------------- OrryChat (C-1, C-5, C-6)
    (C, "post fee not charged", "_toPool(msg.sender, fee);\n        id = ++messageCount;", "id = ++messageCount;"),
    (C, "room stake ignored", "if (s < r.minStakeUsd) revert BelowRoomStake(s, r.minStakeUsd);", ""),
    (C, "text bound off by one", "if (len == 0 || len > maxTextBytes) revert BadText();", "if (len == 0 || len > maxTextBytes + 1) revert BadText();"),
    (C, "empty text accepted", "if (len == 0 || len > maxTextBytes) revert BadText();", "if (len > maxTextBytes) revert BadText();"),
    (C, "reply to an unknown message", "if (replyTo != 0 && authorOf[replyTo] == address(0)) revert UnknownMessage();", ""),
    (C, "unknown room accepted", "if (!r.exists) revert UnknownRoom();", ""),
    (C, "self tip accepted", "if (author == msg.sender) revert SelfTip();", ""),
    (C, "tip cut rounded up", "uint256 cut = amount * tipCutBps / BPS;", "uint256 cut = (amount * tipCutBps + BPS - 1) / BPS;"),
    (C, "tip cut to the author", "_toPool(msg.sender, cut);\n        emit Tipped", "_pull(msg.sender, author, cut);\n        emit Tipped"),
    (C, "report twice", "if (reported[id][msg.sender]) revert AlreadyReported();", ""),
    (C, "report without stake", "if (staking.earningBalance(msg.sender) < reportMinStake) revert BelowReportStake();", ""),
    (C, "hidden at the wrong count", "if (n == hideThreshold) emit Hidden(id, n);", "if (n + 1 == hideThreshold) emit Hidden(id, n);"),
    (C, "anyone creates rooms", "if (msg.sender != pool.admin()) revert NotAdmin();", ""),
    (C, "author not stored", "authorOf[id] = msg.sender;", ""),
    # ---------------------------------------------------------------- OrryNames (C-6)
    (N, "uppercase accepted", "bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f;", "bool ok = (c >= 0x41 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f;"),
    (N, "no maximum length", "if (b.length < MIN_LENGTH || b.length > MAX_LENGTH) return false;", "if (b.length < MIN_LENGTH) return false;"),
    (N, "name taken ignored", "if (holder != address(0)) revert NameTaken();", ""),
    (N, "old name not freed", "delete ownerOfKey[oldKey];", ""),
    (N, "name fee not paid", "_pull(msg.sender, address(pool), fee);\n        pool.sync", "pool.sync"),
    # ---------------------------------------------------------------- OrryBoost (C-6)
    (BO, "boost days unbounded", "if (days_ == 0 || days_ > MAX_DAYS) revert BadDays();\n        uint256 cost", "uint256 cost"),
    (BO, "boost does not stack", "uint64 start = current > block.timestamp ? current : uint64(block.timestamp);\n        until = start + uint64(days_) * 1 days;", "uint64 start = uint64(block.timestamp);\n        until = start + uint64(days_) * 1 days;"),
    (BO, "agent priced as a post", "if (kind == KIND_AGENT) return agentUsdPerDay;", "if (kind == KIND_AGENT) return postUsdPerDay;"),
    (BO, "boost burn source", "uint8 public constant BURN_SOURCE = 8;", "uint8 public constant BURN_SOURCE = 9;"),
    (BO, "boost price for one day", "uint256 cost = _quote(usdPerDay(kind) * days_, maxOrry);", "uint256 cost = _quote(usdPerDay(kind), maxOrry);"),
    # ---------------------------------------------------------------- OrryPasses (C-6)
    (S, "week lasts a day", "if (kind == KIND_WEEK) return (weekPassUsd, 7 days);", "if (kind == KIND_WEEK) return (weekPassUsd, 1 days);"),
    (S, "pass does not stack", "uint64 start = current > block.timestamp ? current : uint64(block.timestamp);\n        until = start + duration * uint64(count);", "uint64 start = uint64(block.timestamp);\n        until = start + duration * uint64(count);"),
    (S, "pass count unbounded", "if (count == 0 || count > MAX_COUNT) revert BadCount();\n        (uint256 usd, uint64 duration)", "(uint256 usd, uint64 duration)"),
    (S, "pass for the zero address", "if (account == address(0)) revert ZeroAddress();", ""),
    (S, "pass priced for one unit", "uint256 cost = _quote(usd * count, maxOrry);", "uint256 cost = _quote(usd, maxOrry);"),
    # ---------------------------------------------------------------- TemplateMarket (C-6)
    (K, "creator buys own template", "if (t.creator == msg.sender) revert OwnTemplate();", ""),
    (K, "licence bought twice", "if (licensed[id][msg.sender]) revert AlreadyLicensed();", ""),
    (K, "delisted template sold", "if (!t.listed) revert NotListed();", ""),
    (K, "nothing burned", "uint256 burned = paid * burnBps / BPS;", "uint256 burned = 0;"),
    (K, "creator paid the whole price", "_pull(msg.sender, t.creator, paid - burned);", "_pull(msg.sender, t.creator, paid);"),
    (K, "anyone reprices", "if (t.creator != msg.sender) revert NotCreator();", ""),
    (K, "no minimum price", "if (priceUsd < minPriceUsd || priceUsd > maxPriceUsd) revert BadPrice();", "if (priceUsd > maxPriceUsd) revert BadPrice();"),
    # ---------------------------------------------------------------- ReferralRegistry (RF-1)
    (R, "self link", "if (referee == referrer) revert SelfReferral();", ""),
    (R, "link changed", "if (referrerOf[referee] != address(0)) revert AlreadyLinked();", ""),
    (R, "signature not checked", "if (!SignatureChecker.isValidSignatureNow(referee, digest, signature)) revert BadSignature();", ""),
    (R, "expired signature accepted", "if (block.timestamp > deadline) revert Expired();", ""),
    (R, "digest ignores the referrer", "bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(LINK_TYPEHASH, referee, referrer, deadline)));", "bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(LINK_TYPEHASH, referee, address(0), deadline)));"),
    # ---------------------------------------------------------------- CashbackRewards (RF-2 to RF-5)
    (W, "cashback ceiling ignored", "if (uint256(r.rewardUsd) * BPS > uint256(r.feeUsd) * MAX_CASHBACK_BPS) revert BadAccrual(i);", ""),
    (W, "referral share ceiling ignored", "if (uint256(r.rewardUsd) * BPS > uint256(r.feeUsd) * MAX_SHARE_BPS) revert BadAccrual(i);", ""),
    (W, "referral link not checked", "if (registry.referrerOf(r.referee) != r.account) revert BadAccrual(i);", ""),
    (W, "fee before the link", "if (r.feePaidAt < at || r.feePaidAt >= at + REFERRAL_WINDOW) revert BadAccrual(i);", "if (r.feePaidAt >= at + REFERRAL_WINDOW) revert BadAccrual(i);"),
    (W, "referral window inclusive", "if (r.feePaidAt < at || r.feePaidAt >= at + REFERRAL_WINDOW) revert BadAccrual(i);", "if (r.feePaidAt < at || r.feePaidAt > at + REFERRAL_WINDOW) revert BadAccrual(i);"),
    (W, "monthly cap ignored", "if (used > MONTHLY_CAP_USD) revert AboveMonthlyCap(r.account);", ""),
    (W, "cap use not recorded", "referralUsd[r.account][month] = used;", ""),
    (W, "duplicate accepted", "if (seen[key]) revert DuplicateAccrual(i);", ""),
    (W, "lag unbounded", "if (r.feePaidAt > block.timestamp || r.feePaidAt + MAX_LAG < block.timestamp) revert BadAccrual(i);", "if (r.feePaidAt > block.timestamp) revert BadAccrual(i);"),
    (W, "future fee accepted", "if (r.feePaidAt > block.timestamp || r.feePaidAt + MAX_LAG < block.timestamp) revert BadAccrual(i);", "if (r.feePaidAt + MAX_LAG < block.timestamp) revert BadAccrual(i);"),
    (W, "unknown kind accepted", "} else {\n                revert BadAccrual(i);\n            }", "}"),
    (W, "cashback with a referee", "if (r.referee != address(0)) revert BadAccrual(i);", ""),
    (W, "open before the hold", "if (block.timestamp < at) revert NotOpenable(at);", ""),
    (W, "hold not applied", "return Months.startOf(month + 1) + HOLD;", "return Months.startOf(month + 1);"),
    (W, "reserve not capped by free", "reserve = needed < f ? needed : f;", "reserve = needed;"),
    (W, "month claimed twice", "if (usd == 0 || claimedMonth[account][month]) revert NothingToClaim();", "if (usd == 0) revert NothingToClaim();"),
    (W, "claim not pro rata", "uint256 amount = FullMath.mulDiv(usd, p.reserve, p.totalUsd);", "uint256 amount = orryPrice.orryFor(usd);"),
    (W, "claim keeps the reservation", "totalReserved -= amount;\n            total += amount;", "total += amount;"),
    (W, "close before the window", "if (block.timestamp < at) revert ClaimWindowOpen(at);", ""),
    (W, "close twice", "if (p.closed) revert PeriodIsClosed();\n        uint256 at", "uint256 at"),
    (W, "claim after close", "if (p.closed) revert PeriodIsClosed();\n            uint256 usd", "uint256 usd"),
    (W, "void after opening", "if (p.openedAt != 0) revert AlreadyOpened();\n        uint256 usd = owedUsd", "uint256 usd = owedUsd"),
    (W, "void keeps the total", "p.totalUsd -= uint128(usd);", ""),
    (W, "publisher gate open", "if (msg.sender != publisher) revert NotPublisher();", ""),
    (W, "claimFor pays the caller", "if (!orry.transfer(account, total)) revert TransferFailed();", "if (!orry.transfer(msg.sender, total)) revert TransferFailed();"),
    (W, "open twice", "if (p.openedAt != 0) revert AlreadyOpened();\n        uint256 at = openableAt(month);", "uint256 at = openableAt(month);"),
    (W, "open while the price is not ready", "if (!_ready()) revert PriceNotReady();", ""),
    (W, "close returns nothing", "totalReserved -= returned;", ""),
    (W, "admin gate open", "if (msg.sender != admin) revert NotAdmin();", ""),
    (MO, "first day of month off by one", "uint256 doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5; // day 1 of the month", "uint256 doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + 1;"),
    (MO, "century leap rule dropped", "uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;", "uint256 doe = yoe * 365 + yoe / 4 + doy;"),
    (MO, "january and february in the wrong year", "if (m <= 2) y += 1;", ""),
]

originals = {}
results = []
only = sys.argv[1] if len(sys.argv) > 1 else None
path_filter = os.environ.get("MUT_PATH", "")
try:
    for idx, (path, name, old, new) in enumerate(MUTATIONS):
        if only and only not in name:
            continue
        if path_filter and path_filter not in path:
            continue
        if path not in originals:
            originals[path] = open(path).read()
        src = originals[path]
        assert src.count(old) == 1, f"snippet must occur once for: {name} (found {src.count(old)})"
        open(path, "w").write(src.replace(old, new, 1))
        args = ["heavy", "forge", "test", "--match-path", TESTS_FOR[path], "--no-match-test", "invariant_"]
        run = subprocess.run(args, capture_output=True, text=True)
        out = run.stdout + run.stderr
        failed = sorted(set(re.findall(r"^\[FAIL.*?\]\s+(\w+)\(", out, re.M)))
        compile_error = "Compiler run failed" in out
        results.append((name, failed, compile_error))
        open(path, "w").write(src)
        print(f"{idx:3d} " + ("CAUGHT  " if failed or compile_error else "MISSED  ") + name
              + (f"  by {', '.join(failed[:3])}" if failed else (" (compile error)" if compile_error else "")), flush=True)
finally:
    for path, src in originals.items():
        open(path, "w").write(src)

caught = sum(1 for _, f, c in results if f or c)
print(f"\n{caught}/{len(results)} mutations caught")
sys.exit(0 if caught == len(results) else 1)
