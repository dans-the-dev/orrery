#!/usr/bin/env python3
"""Mutation check for lane L5's Agent Launch contracts (AgentLaunch, SpokeHook), on the pattern of mutate_data.py.

Run from contracts/ (or a copy of it):  python3 mutate_launch.py        (RANGE=0:10 python3 mutate_launch.py runs a slice)
Each mutation replaces one exact snippet, runs the launch tests (unit, invariant and the deterministic deep run; the fork
suite skips without a fork URL), restores the source, and prints CAUGHT or MISSED. The unmutated suite runs first and must
pass, so a compile error that has nothing to do with a mutation can never count as a catch. Mutants marked EXPLAINED in the
lane report are equivalent or defensive (see docs/updates/L5-LAUNCH-SPEC.md section 10).
"""
import os
import re
import subprocess
import sys
import time

TEST_ARGS = ["heavy", "forge", "test", "--match-path", "test/launch/*"]
A = "src/launch/AgentLaunch.sol"
H = "src/launch/SpokeHook.sol"
R = "src/launch/SpokeRouter.sol"

MUTATIONS = [
    # ---------------------------------------------------------------- hook: fee
    (H, "base fee changed", "uint24 public constant BASE_FEE = 10_000;", "uint24 public constant BASE_FEE = 9_000;"),
    (H, "fee rounds up", "        fee = amount * pips / PIPS;", "        fee = (amount * pips + PIPS - 1) / PIPS;"),
    (H, "fee not counted per pool", "        _spokes[id].fees += fee;\n", ""),
    (H, "fee minted to the hook", "mint(launch, uint256(uint160(orry)), fee)", "mint(address(this), uint256(uint160(orry)), fee)"),
    (H, "specified side inverted", "        if ((params.amountSpecified < 0) != params.zeroForOne) {", "        if ((params.amountSpecified < 0) == params.zeroForOne) {"),
    (H, "unspecified side charged twice", "        if ((params.amountSpecified < 0) == params.zeroForOne) return (IHooks.afterSwap.selector, 0);\n", ""),
    (H, "launch fee on AgentLaunch's own buys", "return buy && sender != launch ? feeAt(id, block.timestamp) : BASE_FEE;", "return buy ? feeAt(id, block.timestamp) : BASE_FEE;"),
    (H, "launch fee on sells", "return buy && sender != launch ? feeAt(id, block.timestamp) : BASE_FEE;", "return sender != launch ? feeAt(id, block.timestamp) : BASE_FEE;"),
    (H, "decay one second longer", "(uint256(startFeePips - BASE_FEE) * (decayWindow - elapsed)) / decayWindow", "(uint256(startFeePips - BASE_FEE) * (decayWindow - elapsed + 1)) / decayWindow"),
    (H, "decay ends late", "        if (elapsed >= decayWindow) return BASE_FEE;\n", "        if (elapsed > decayWindow + 5) return BASE_FEE;\n"),
    (H, "decay measured from the opening", "        uint256 open = _spokes[poolId].publicOpenAt;", "        uint256 open = _spokes[poolId].openedAt;"),
    # ---------------------------------------------------------------- hook: early window and access
    (H, "early window not enforced", "            if (block.timestamp < open) revert EarlyAccessOnly(open);\n", ""),
    (H, "early window blocks AgentLaunch", "        if (params.zeroForOne && sender != launch) {", "        if (params.zeroForOne) {"),
    (H, "early window blocks sells", "        if (params.zeroForOne && sender != launch) {", "        if (sender != launch) {"),
    (H, "no early window", "        uint64 open = nowTs + earlyWindow;", "        uint64 open = nowTs;"),
    (H, "isEarly one second long", "        return s.openedAt != 0 && block.timestamp < s.publicOpenAt;", "        return s.openedAt != 0 && block.timestamp <= s.publicOpenAt;"),
    (H, "anyone opens a spoke", "        if (sender != launch) revert NotLaunch();\n        if (\n", "        if (\n"),
    (H, "any LP fee accepted", "Currency.unwrap(key.currency0) != orry || key.fee != 0 || key.tickSpacing", "Currency.unwrap(key.currency0) != orry || key.tickSpacing"),
    (H, "any currency0 accepted", "Currency.unwrap(key.currency0) != orry || key.fee != 0", "key.fee != 0"),
    (H, "any tick spacing accepted", " || key.tickSpacing != TICK_SPACING\n", "\n"),
    (H, "outside liquidity accepted", "        if (sender != launch) revert NotLaunch();\n        return IHooks.beforeAddLiquidity.selector;", "        return IHooks.beforeAddLiquidity.selector;"),
    (H, "start fee bound loosened", "if (startFeePips_ < BASE_FEE || startFeePips_ > MAX_START_FEE) revert BadParameters();", "if (startFeePips_ > MAX_START_FEE) revert BadParameters();"),
    (H, "decay bound loosened", "if (decayWindow_ == 0 || decayWindow_ > MAX_DECAY_WINDOW || earlyWindow_ > MAX_EARLY_WINDOW) {", "if (decayWindow_ == 0 || earlyWindow_ > MAX_EARLY_WINDOW) {"),
    (H, "early bound loosened", "if (decayWindow_ == 0 || decayWindow_ > MAX_DECAY_WINDOW || earlyWindow_ > MAX_EARLY_WINDOW) {", "if (decayWindow_ == 0 || decayWindow_ > MAX_DECAY_WINDOW) {"),
    (H, "start fee bound off by one", "if (startFeePips_ < BASE_FEE || startFeePips_ > MAX_START_FEE) revert BadParameters();", "if (startFeePips_ < BASE_FEE || startFeePips_ >= MAX_START_FEE) revert BadParameters();"),
    # ---------------------------------------------------------------- launch: constants (T3, T6)
    (A, "creator share changed", "uint16 public constant CREATOR_BPS = 5000;", "uint16 public constant CREATOR_BPS = 4000;"),
    (A, "earn share changed", "uint16 public constant EARN_BPS = 2000;", "uint16 public constant EARN_BPS = 2500;"),
    (A, "owner share changed", "uint16 public constant OWNER_BPS = 1500;", "uint16 public constant OWNER_BPS = 1000;"),
    (A, "lock period shortened", "uint64 public constant LOCK_PERIOD = 90 days;", "uint64 public constant LOCK_PERIOD = 89 days;"),
    (A, "earn interval removed", "uint64 public constant EARN_INTERVAL = 1 hours;", "uint64 public constant EARN_INTERVAL = 0;"),
    (A, "burn source changed", "uint8 public constant BURN_SOURCE = 50;", "uint8 public constant BURN_SOURCE = 51;"),
    # ---------------------------------------------------------------- launch: gates (LA-9, LA-10)
    (A, "anyone launches", "        if (caller != agentOwner && (wallet == address(0) || caller != wallet)) return (Gate.NotController, 0, 0);\n", ""),
    (A, "second coin per agent", "        if (_coinOfAgent[agentId] != address(0)) return (Gate.AlreadyLaunched, 0, 0);\n", ""),
    (A, "unverified agents launch", "        if (!IAttestorVerified(attestor).isVerified(agentId)) return (Gate.NotVerified, 0, 0);\n", ""),
    (A, "unbound wallet accepted", "if (wallet == address(0) || !IPolicyModuleInstalled(policyModule).isInstalledOn(wallet)) {\n            return (Gate.WalletNotBound, 0, 0);", "if (wallet == address(0)) {\n            return (Gate.WalletNotBound, 0, 0);"),
    (A, "price failure ignored", "        if (!ok) return (Gate.PriceNotReady, 0, 0);\n", ""),
    (A, "stake must exceed the minimum", "        if (usd < minStakeUsd) return (Gate.StakeTooLow, usd, minStakeUsd);", "        if (usd <= minStakeUsd) return (Gate.StakeTooLow, usd, minStakeUsd);"),
    (A, "stake gate removed", "        if (usd < minStakeUsd) return (Gate.StakeTooLow, usd, minStakeUsd);\n", ""),
    (A, "lock must exceed 90 days", "        if (pos.lockedUntil < needed) return (Gate.LockTooShort, pos.lockedUntil, needed);", "        if (pos.lockedUntil <= needed) return (Gate.LockTooShort, pos.lockedUntil, needed);"),
    (A, "lock gate removed", "        if (pos.lockedUntil < needed) return (Gate.LockTooShort, pos.lockedUntil, needed);\n", ""),
    (A, "gate result ignored", "        if (g == Gate.Ok) return;\n", "        return;\n"),
    # ---------------------------------------------------------------- launch: the launch itself (LA-6, LA-7, LA-15, LA-16)
    (A, "coin below ORRY accepted", "        if (uint160(coin) <= uint160(orry)) revert CoinSortsBelowOrry();\n", ""),
    (A, "first buy cap removed", "        if (bought > cap) revert FirstBuyTooLarge(bought, cap);\n", ""),
    (A, "first buy slippage ignored", "        if (bought < minCoinOut) revert SlippageExceeded(bought, minCoinOut);\n\n        PoolId", "\n        PoolId"),
    (A, "first buy coins kept", "        if (bought > 0) _transfer(coin, msg.sender, bought);\n", ""),
    (A, "position upper edge moved", "                tickUpper: START_TICK,", "                tickUpper: START_TICK + TICK_SPACING,"),
    (A, "position lower edge moved", "                tickLower: MIN_TICK,", "                tickLower: MIN_TICK + TICK_SPACING,"),
    (A, "liquidity rounds up", "uint256 liq = FullMath.mulDiv(SUPPLY, 1 << 96, sqrtStart - sqrtMin);", "uint256 liq = FullMath.mulDivRoundingUp(SUPPLY, 1 << 96, sqrtStart - sqrtMin) + 1;"),
    (A, "launch record not kept", "        _coinOfAgent[agentId] = coin;\n", ""),
    (A, "name length unchecked", "uint256 internal constant MAX_NAME_BYTES = 32;", "uint256 internal constant MAX_NAME_BYTES = 33;"),
    (A, "control characters accepted", "            if (c < 0x20 || c == 0x7f) revert InvalidName();\n", ""),
    (A, "predictCoin uses another salt", "uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _coinSalt(caller, salt), codeHash)))", "uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))"),
    (A, "start tick off the grid accepted", "            p.startTick % TICK_SPACING != 0 || p.startTick <= MIN_TICK", "            p.startTick <= MIN_TICK"),
    (A, "first buy cap bound loosened", " || p.maxFirstBuyBps > MAX_FIRST_BUY_BPS", ""),
    (A, "hook of another launcher accepted", "            ISpokeHook(hook_).launch() != address(this) || ", "            "),
    # ---------------------------------------------------------------- launch: early access (LA-12)
    (A, "early buy after the window", "        if (!ISpokeHook(hook).isEarly(l.poolId)) revert EarlyWindowClosed();\n", ""),
    (A, "early buy without a stake", "        if (usd < earlyMinUsd) revert NotEarlyEligible(usd, earlyMinUsd);\n", ""),
    (A, "early allowance unchecked", "        if (bought + coinsOut > allowance) revert OverEarlyAllowance(allowance, bought, coinsOut);\n", ""),
    (A, "early purchases not counted", "        _earlyBought[coin][msg.sender] = bought + coinsOut;\n", ""),
    (A, "early allowance not capped", "        uint256 w = usd < earlyFullUsd ? usd : earlyFullUsd;", "        uint256 w = usd;"),
    (A, "early slippage ignored", "        if (coinsOut < minCoinOut) revert SlippageExceeded(coinsOut, minCoinOut);\n        uint256 bought", "        uint256 bought"),
    (A, "early deadline ignored", "        if (block.timestamp > deadline) revert DeadlinePassed();\n", ""),
    (A, "allowance view ignores purchases", "        return bought >= allowance ? 0 : allowance - bought;", "        return allowance;"),
    # ---------------------------------------------------------------- launch: fees (LA-1 to LA-3, LA-13)
    (A, "distributed not recorded", "        _distributed[coin] = taken;\n", ""),
    (A, "creator share not accrued", "        _creatorOwed[coin] += creator;\n", ""),
    (A, "earn share not accrued", "        earnPending += earn;\n", ""),
    (A, "owner share not paid", "            _transfer(orry, ownerWallet, ownerPart);\n", ""),
    (A, "burn skipped", "        IOrryToken(orry).burn(amount);\n", ""),
    (A, "Burned event missing", "        emit Burned(BURN_SOURCE, amount);\n", ""),
    (A, "owner share kept when the treasury has no owner", "            burned += ownerPart;\n            ownerPart = 0;", "            ownerPart = 0;"),
    (A, "earn flushed at any time", " || block.timestamp < uint256(lastEarnAt) + EARN_INTERVAL", ""),
    (A, "refused earn keeps the allowance", "            _approve(orry, earnVault, 0);\n            return 0;", "            return 0;"),
    (A, "refused earn drops the share", "        } catch {\n            _approve(orry, earnVault, 0);", "        } catch {\n            earnPending = 0;\n            _approve(orry, earnVault, 0);"),
    (A, "refusing vault blocks distribution", "        } catch {\n            _approve(orry, earnVault, 0);\n            return 0;\n        }", "        } catch {\n            revert InexactTransfer();\n        }"),
    (A, "creator paid to an unbound wallet", "        if (wallet == address(0) || !IPolicyModuleInstalled(policyModule).isInstalledOn(wallet)) {\n            revert CreatorWalletNotBound(wallet);", "        if (wallet == address(0)) {\n            revert CreatorWalletNotBound(wallet);"),
    (A, "creator share paid to the caller", "        _transfer(orry, wallet, amount);", "        _transfer(orry, msg.sender, amount);"),
    (A, "creator share paid twice", "        _creatorOwed[coin] = 0;\n        _transfer(orry, wallet, amount);", "        _transfer(orry, wallet, amount);"),
    (A, "claim skips the split", "        _split(coin, l.poolId);\n        _flushEarn();\n        amount = _creatorOwed[coin];", "        amount = _creatorOwed[coin];"),
    (A, "pending view ignores distributions", "        return ISpokeHook(hook).feesOf(l.poolId) - _distributed[coin];", "        return ISpokeHook(hook).feesOf(l.poolId);"),
    (A, "callback open to anyone", "        if (msg.sender != poolManager) revert NotPoolManager();\n        (Action action", "        (Action action"),
    (A, "paging returns everything", "        uint256 end = count > n - from ? n : from + count;", "        uint256 end = n;"),
    # ---------------------------------------------------------------- router
    (R, "router ignores the deadline", "        if (block.timestamp > deadline) revert DeadlinePassed();\n", ""),
    (R, "router ignores the minimum", "        if (out < minOut) revert SlippageExceeded(out, minOut);\n", ""),
    (R, "router trades unknown coins", "        if (launch.launchOf(coin).creator == address(0)) revert UnknownCoin();\n", ""),
    (R, "router callback open to anyone", "        if (msg.sender != poolManager) revert NotPoolManager();\n", ""),
    (R, "router pays the output to itself", "        pm.take(Currency.wrap(tokenOut), account, out);", "        pm.take(Currency.wrap(tokenOut), address(this), out);"),
    (R, "router buys in the wrong direction", "                zeroForOne: isBuy,", "                zeroForOne: !isBuy,"),
    # ---------------------------------------------------------------- defensive (expected to be explained if missed)
    (A, "intake exactness unchecked", "        if (IOrryToken(orry).balanceOf(address(this)) - before != amount) revert InexactTransfer();\n", ""),
    (A, "burn exactness unchecked", "        if (supply - IOrryToken(orry).totalSupply() != amount) revert InexactTransfer();\n", ""),
    (A, "fill check removed", "        if (uint256(-int256(s.amount0())) != orryIn) revert NotFilled();\n", ""),
    (A, "distribute reentrancy guard removed", "function distribute(address coin) external nonReentrant returns", "function distribute(address coin) external returns"),
]

only = sys.argv[1:]  # optional substrings to run a subset
if os.environ.get("RANGE"):
    a, b = os.environ["RANGE"].split(":")
    MUTATIONS = MUTATIONS[int(a or 0):int(b) if b else None]
originals = {}
results = []
start = time.time()
if os.environ.get("BASELINE", "1") != "0":
    base = subprocess.run(TEST_ARGS, capture_output=True, text=True)
    if base.returncode != 0:
        print(base.stdout[-3000:] + base.stderr[-3000:])
        sys.exit("baseline: the unmutated suite does not pass; no mutation result would mean anything")
    print("baseline passes", flush=True)
try:
    for path, name, old, new in MUTATIONS:
        if only and not any(o in name for o in only):
            continue
        if path not in originals:
            originals[path] = open(path).read()
        src = originals[path]
        assert src.count(old) == 1, f"snippet must occur once for: {name} (found {src.count(old)})"
        open(path, "w").write(src.replace(old, new, 1))
        run = subprocess.run(TEST_ARGS, capture_output=True, text=True)
        out = run.stdout + run.stderr
        failed = sorted(set(re.findall(r"^\[FAIL.*?\] (\w+)\(", out, re.M)))
        if not failed and re.search(r"Encountered a total of [1-9]\d* failing", out):
            failed = ["(unparsed failing test)"]
        compile_error = "Compiler run failed" in out
        results.append((name, failed, compile_error))
        open(path, "w").write(src)
        print(("CAUGHT  " if failed or compile_error else "MISSED  ") + name + (f"  by {', '.join(failed[:3])}" if failed else (" (compile error)" if compile_error else "")), flush=True)
finally:
    for path, src in originals.items():
        open(path, "w").write(src)

caught = sum(1 for _, f, c in results if f or c)
print(f"\n{caught}/{len(results)} mutations caught in {int(time.time() - start)} s")
sys.exit(0 if caught == len(results) else 1)
