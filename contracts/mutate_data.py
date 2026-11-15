#!/usr/bin/env python3
"""Mutation check for lane L2's data contracts (DataFeeSplitter, DataProviderRegistry), on the pattern of
test/facilitator/mutate_facilitator.py.

Run from contracts/:  python3 mutate_data.py        (RANGE=0:10 python3 mutate_data.py runs a slice)
Each mutation replaces one exact snippet, runs the data tests (unit, fuzz, invariant and the deterministic deep run),
restores the source, and prints CAUGHT or MISSED. The unmutated suite runs first and must pass, so a compile error that
has nothing to do with a mutation can never count as a catch.
"""
import os
import re
import subprocess
import sys
import time

TEST_ARGS = ["heavy", "forge", "test", "--match-path", "test/data/*"]
S = "src/data/DataFeeSplitter.sol"
R = "src/data/DataProviderRegistry.sol"

MUTATIONS = [
    # ---------------------------------------------------------------- splitter: the split
    (S, "burn share changed", "uint16 public constant BURN_BPS = 7000;", "uint16 public constant BURN_BPS = 6000;"),
    (S, "burn rounds up", "            burned = fresh * BURN_BPS / BPS;", "            burned = (fresh * BURN_BPS + BPS - 1) / BPS;"),
    (S, "burn skipped", "                t.burn(burned);\n", ""),
    (S, "burn delta check removed", "                if (t.balanceOf(address(this)) != bal - burned) revert InexactBurn();\n", ""),
    (S, "Burned event missing", "                emit Burned(BURN_SOURCE, burned);\n", ""),
    (S, "wrong burn source", "uint8 public constant BURN_SOURCE = 11;", "uint8 public constant BURN_SOURCE = 7;"),
    (S, "pool share not booked", "            poolOwed = owed;\n", ""),
    (S, "booking counted as fresh", "uint256 fresh = bal - owed;", "uint256 fresh = bal;"),
    (S, "pool share burned too", "            toPool = fresh - burned;", "            toPool = 0;"),
    (S, "empty split allowed", "        if (fresh == 0 && (p == address(0) || owed == 0)) revert NothingToSplit();\n", ""),
    (S, "pool never funded", "        if (p != address(0) && owed != 0) _fund(t, p, owed);", "        if (p != address(0) && owed != 0 && false) _fund(t, p, owed);"),
    (S, "funding delta check removed", "            if (before - t.balanceOf(address(this)) != owed) revert InexactFunding();\n", ""),
    (S, "booking kept after funding", "            poolOwed = 0;\n            emit PoolFunded", "            emit PoolFunded"),
    (S, "PoolFunded event missing", "            emit PoolFunded(p, owed);\n", ""),
    (S, "refused funding keeps the allowance", "            t.approve(p, 0);\n", ""),
    (S, "refusing pool blocks the burn", "        } catch {\n            t.approve(p, 0);\n        }", "        } catch {\n            revert InexactFunding();\n        }"),
    (S, "reentrancy guard removed", "function split() external nonReentrant returns", "function split() external returns"),
    (S, "preview ignores the booking", "        received = IOrryToken(orry).balanceOf(address(this)) - poolOwed;", "        received = IOrryToken(orry).balanceOf(address(this));"),
    (S, "preview says nothing is sent", "        owedAfter = pool == address(0) ? poolOwed + toPool : 0;", "        owedAfter = poolOwed + toPool;"),
    # ---------------------------------------------------------------- splitter: the pool
    (S, "anyone proposes", "        if (msg.sender != IOrreryTreasury(treasury).owner()) revert NotTreasuryOwner();\n        if (pool != address(0)) revert PoolAlreadySet();\n        if (pool_", "        if (pool != address(0)) revert PoolAlreadySet();\n        if (pool_"),
    (S, "anyone executes", "        if (msg.sender != IOrreryTreasury(treasury).owner()) revert NotTreasuryOwner();\n        if (pool != address(0)) revert PoolAlreadySet();\n        address p", "        if (pool != address(0)) revert PoolAlreadySet();\n        address p"),
    (S, "delay ignored", "        if (block.timestamp < _pendingPoolAt) revert PoolNotReady(_pendingPoolAt);\n", ""),
    (S, "delay shortened", "uint64 public constant POOL_DELAY = 48 hours;", "uint64 public constant POOL_DELAY = 47 hours;"),
    (S, "pool re-proposed after set", "        if (pool != address(0)) revert PoolAlreadySet();\n        if (pool_ == address(0))", "        if (pool_ == address(0))"),
    (S, "pool re-executed after set", "        if (pool != address(0)) revert PoolAlreadySet();\n        address p = _pendingPool;", "        address p = _pendingPool;"),
    (S, "zero pool accepted", "        if (pool_ == address(0)) revert ZeroAddress();\n", ""),
    (S, "pool token not checked", "        if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != uint256(uint160(orry))) revert WrongPool();\n", ""),
    (S, "pool token mismatch accepted", "abi.decode(ret, (uint256)) != uint256(uint160(orry))", "abi.decode(ret, (uint256)) == 0"),
    (S, "proposal not cleared", "        delete _pendingPool;\n", ""),
    (S, "execute without proposal", "        if (p == address(0)) revert NoPoolProposal();\n", ""),
    (S, "zero token accepted", "        if (orry_ == address(0) || treasury_ == address(0)) revert ZeroAddress();", "        if (treasury_ == address(0)) revert ZeroAddress();"),
    # ---------------------------------------------------------------- registry
    (R, "fee constant changed", "uint16 public constant FEE_BPS = 100;", "uint16 public constant FEE_BPS = 20;"),
    (R, "any factory accepted", "        if (IMerchantSplitterFactory(providerFactory_).FEE_BPS() != FEE_BPS) revert WrongFactory();\n", ""),
    (R, "zero minimum accepted", "        if (minStakeUsd_ == 0) revert ZeroMinStake();\n", ""),
    (R, "listed twice", "        if (_listings[msg.sender].listedAt != 0) revert AlreadyListed();\n", ""),
    (R, "list without stake", "        _requireStake(msg.sender);\n        bytes32 h", "        bytes32 h"),
    (R, "update without stake", "        _requireStake(msg.sender);\n        l.contentHash", "        l.contentHash"),
    (R, "stake must exceed the minimum", "        if (have < minStakeUsd) revert StakeTooLow(have, minStakeUsd);", "        if (have <= minStakeUsd) revert StakeTooLow(have, minStakeUsd);"),
    (R, "splitter not created", "        if (!f.isSplitter(splitter)) f.create(msg.sender);\n", ""),
    (R, "count not raised", "        ++providerCount;\n", ""),
    (R, "count not lowered", "        --providerCount;\n", ""),
    (R, "unlist keeps the listing", "        delete _listings[msg.sender];\n", ""),
    (R, "update of a stranger", "        if (l.listedAt == 0) revert NotListed();\n", ""),
    (R, "unlist of a stranger", "        if (_listings[msg.sender].listedAt == 0) revert NotListed();\n        delete", "        delete"),
    (R, "http accepted", " || bytes8(e[:8]) != bytes8(\"https://\")", ""),
    (R, "short endpoint accepted", "uint256 private constant MIN_ENDPOINT = 12;", "uint256 private constant MIN_ENDPOINT = 9;"),
    (R, "long endpoint accepted", "uint256 private constant MAX_ENDPOINT = 200;", "uint256 private constant MAX_ENDPOINT = 201;"),
    (R, "space in endpoint accepted", "if (uint8(e[i]) <= 0x20 || uint8(e[i]) == 0x7f) revert BadEndpoint();", "if (uint8(e[i]) < 0x20 || uint8(e[i]) == 0x7f) revert BadEndpoint();"),
    (R, "DEL in endpoint accepted", "if (uint8(e[i]) <= 0x20 || uint8(e[i]) == 0x7f) revert BadEndpoint();", "if (uint8(e[i]) <= 0x20) revert BadEndpoint();"),
    (R, "short name accepted", "uint256 private constant MIN_NAME = 2;", "uint256 private constant MIN_NAME = 1;"),
    (R, "long name accepted", "uint256 private constant MAX_NAME = 40;", "uint256 private constant MAX_NAME = 41;"),
    (R, "control byte in name accepted", "            if (uint8(n[i]) < 0x20 || uint8(n[i]) == 0x7f) revert BadName();\n", ""),
    (R, "long description accepted", "uint256 private constant MAX_DESCRIPTION = 280;", "uint256 private constant MAX_DESCRIPTION = 281;"),
    (R, "zero price accepted", "        if (priceUsdg == 0) revert BadPrice();\n", ""),
    (R, "active ignores the stake", "return isListed(provider) && _stakeUsd(provider) >= minStakeUsd;", "return isListed(provider);"),
    (R, "failing stake read counts as staked", "        } catch {\n            return 0;\n        }", "        } catch {\n            return type(uint256).max;\n        }"),
    (R, "update keeps the old price", "        l.priceUsdg = priceUsdg;\n", ""),
    (R, "update keeps the old time", "        l.updatedAt = uint64(block.timestamp);\n", ""),
    (R, "hash leaves out the description", "return keccak256(abi.encode(endpoint, name, description, priceUsdg));", "return keccak256(abi.encode(endpoint, name, priceUsdg));"),
    (R, "update keeps the old hash", "        l.contentHash = _check(endpoint, name, description, priceUsdg);", "        _check(endpoint, name, description, priceUsdg);"),
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
