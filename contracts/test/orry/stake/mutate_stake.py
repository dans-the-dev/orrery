#!/usr/bin/env python3
"""Mutation check for lane B (OrryStaking, OrryRewardsRouter, OrreryTreasury, OrryBuyback), on the pattern of
contracts/mutate.py.

Run from contracts/:  python3 test/orry/stake/mutate_stake.py
Each mutation replaces one exact snippet, runs the lane B unit tests and the three deterministic deep runs (not the long
invariant campaigns, not the fork test), restores the source, and prints CAUGHT or MISSED.
Parallel runs: copy contracts/ once per shard and set MUT_SHARD=i/n (and MUT_FROM=k to start at mutation k) in each.
MUT_PATH=OrreryTreasury (a file name part) runs only that contract's mutations.
"""
import os
import re
import subprocess
import sys

# lane A's files do not compile against the multi-pair hook interface yet (orry/spec d01fb2c): skip them
SKIP = ["--skip", "src/orry/OrreryHook.sol", "--skip", "src/orry/EarnVault.sol", "--skip", "src/orry/ClaimAll.sol",
        "--skip", "src/orry/OrryLens.sol", "--skip", "test/orry/earn/**", "--skip", "test/orry/integration/**",
        "--skip", "test/fork/orry/earn/**", "--skip", "test/markets/**", "--skip", "script/**"]
TEST_ARGS = ["heavy", "forge", "test", "--match-path", "test/orry/stake/**", "--no-match-test", "invariant_"] + SKIP
S = "src/orry/OrryStaking.sol"
R = "src/orry/OrryRewardsRouter.sol"
T = "src/orry/OrreryTreasury.sol"
B = "src/orry/OrryBuyback.sol"

MUTATIONS = [
    # ---------------------------------------------------------------- staking
    (S, "unstake keeps earning", "_earning[msg.sender] -= amount;\n        totalEarning -= amount;\n        emit UnstakeRequested", "emit UnstakeRequested"),
    (S, "agent unstake keeps earning", "_earning[msg.sender] -= amount;\n        totalEarning -= amount;\n        emit AgentUnstakeRequested", "emit AgentUnstakeRequested"),
    (S, "plain withdraw before readyAt", "if (amount == 0 || block.timestamp < p.readyAt) revert NothingReady();", "if (amount == 0) revert NothingReady();"),
    (S, "agent withdraw before leavingAt", "if (amount == 0 || block.timestamp < pos.leavingAt) revert NothingReady();", "if (amount == 0) revert NothingReady();"),
    (S, "agent cooldown is the plain one", "uint64(block.timestamp) + AGENT_COOLDOWN", "uint64(block.timestamp) + PLAIN_COOLDOWN"),
    (S, "second request keeps the old clock", "p.readyAt = readyAt;", "if (p.readyAt == 0) p.readyAt = readyAt;"),
    (S, "agent controller not checked", "if (msg.sender != agentOwner && msg.sender != IIdentityRegistry(identityRegistry).getAgentWallet(agentId)) {\n            revert NotAgentController();\n        }", ""),
    (S, "second staker joins a position", "} else if (staker != msg.sender) {\n            revert PositionHeldByAnotherStaker();\n        }", "}"),
    (S, "anyone requests an agent unstake", "if (msg.sender != pos.staker) revert NotStaker();\n        if (block.timestamp < pos.lockedUntil)", "if (block.timestamp < pos.lockedUntil)"),
    (S, "anyone withdraws an agent position", "if (msg.sender != staker) revert NotStaker();", ""),
    (S, "emptied position keeps its staker", "if (pos.active == 0) pos.staker = address(0);", ""),
    (S, "stake skips settling the account", "_accrue(msg.sender);\n        _pullOrry(amount);\n        Plain storage p", "_pullOrry(amount);\n        Plain storage p"),
    (S, "time with nobody earning is lost", "s.unstreamed += streamed; // nobody earning: kept for the next period", "streamed;"),
    (S, "division remainder dropped", "s.unstreamed = total - rate * STREAM_PERIOD;", "s.unstreamed = 0;"),
    (S, "scheduled remainder dropped on restart", "uint256 total = scheduled + s.unstreamed + amount;", "uint256 total = s.unstreamed + amount;"),
    (S, "owed not reduced on claim", "_streams[ETH].owed -= ethAmount;", ""),
    (S, "accrued not cleared on claim", "acc[ETH] = 0;", ""),
    (S, "claimFor pays the caller", "return _claim(account, account);", "return _claim(account, msg.sender);"),
    (S, "intake balance-delta check removed", "if (IOrryToken(orry).balanceOf(address(this)) - before != amount) revert InexactTransfer();", ""),
    (S, "staking reentrancy guard removed", "            if tload(slot) { revert(0, 0) }\n            tstore(slot, 1)", "            tstore(slot, 1)"),
    (S, "an ETH-only notify restarts ORRY", "if (orryAmount != 0) _restart(_streams[ORRY], orryAmount);", "_restart(_streams[ORRY], orryAmount);"),
    (S, "per-token rounds up", "s.perToken += FullMath.mulDiv(streamed, PRECISION, total);", "s.perToken += FullMath.mulDiv(streamed, PRECISION, total) + 1e18;"),
    (S, "agentStake ignores the current owner", "pos = _agent[agentId][agentOwner];\n        } catch {}", "pos = _agent[agentId][address(0)];\n        } catch {}"),
    (S, "agent lock not enforced", "if (block.timestamp < pos.lockedUntil) revert AgentStakeLocked(pos.lockedUntil);", ""),
    (S, "agent lock may shrink", "if (lockedUntil <= pos.lockedUntil) revert LockNotExtended();", ""),
    (S, "agent lock unbounded", "if (lockedUntil > block.timestamp + MAX_AGENT_LOCK) revert LockTooLong();", ""),
    (S, "anyone extends an agent lock", "if (msg.sender != pos.staker) revert NotStaker();\n        if (lockedUntil <= pos.lockedUntil)", "if (lockedUntil <= pos.lockedUntil)"),
    (S, "lock keyed by the caller", "AgentPosition storage pos = _agent[agentId][agentOwner];\n        if (msg.sender != pos.staker) revert NotStaker();\n        if (lockedUntil", "AgentPosition storage pos = _agent[agentId][msg.sender];\n        if (msg.sender != pos.staker) revert NotStaker();\n        if (lockedUntil"),
    (S, "notify of nothing accepted", "if (msg.value == 0 && orryAmount == 0) revert ZeroAmount();", ""),
    # ---------------------------------------------------------------- router
    (R, "stakers part rounds up", "uint256 ethToStakers = eth * STAKERS_BPS / BPS;", "uint256 ethToStakers = (eth * STAKERS_BPS + BPS - 1) / BPS;"),
    (R, "router interval removed", "if (last != 0 && block.timestamp < last + MIN_INTERVAL) revert TooSoon(last + MIN_INTERVAL);", ""),
    (R, "ORRY half not burned", "IOrryToken(orry).burn(orryBurned);", ""),
    (R, "ETH half kept", "(bool ok,) = buyback.call{value: ethToBuyback}(\"\");", "(bool ok,) = buyback.call{value: 0}(\"\");"),
    (R, "empty distribute accepted", "if (eth == 0 && rc == 0 && !forwarded) revert NothingToDistribute();", ""),
    (R, "forwarded quotes not counted as work", "if (eth == 0 && rc == 0 && !forwarded) revert NothingToDistribute();", "if (eth == 0 && rc == 0) revert NothingToDistribute();"),
    (R, "quote forwarding removed", "bool forwarded = _forwardQuotes();", "bool forwarded = false;"),
    (R, "quote forwarded to the staking contract", "quote.call(abi.encodeCall(IERC20Min.transfer, (buyback, amount)))", "quote.call(abi.encodeCall(IERC20Min.transfer, (staking, amount)))"),
    (R, "half of a quote forwarded", "quote.call(abi.encodeCall(IERC20Min.transfer, (buyback, amount)))", "quote.call(abi.encodeCall(IERC20Min.transfer, (buyback, amount / 2)))"),
    (R, "a failed quote transfer stops distribute", "if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) continue;", "require(ok && (ret.length == 0 || abi.decode(ret, (bool))), \"quote\");"),
    (R, "native ETH treated as an ERC-20 quote", "if (quote == address(0) || quote == orry) continue;", "if (quote == orry) continue;"),
    # ---------------------------------------------------------------- treasury
    (T, "owner share rounds up", "toOwner = fresh * OWNER_BPS / BPS;", "toOwner = (fresh * OWNER_BPS + BPS - 1) / BPS;"),
    (T, "sync counts the reserve twice", "uint256 booked = ownerAccrued + buybackReserve;", "uint256 booked = ownerAccrued;"),
    (T, "reclaim after the coin is set", "if (orry != address(0)) revert CoinAlreadySet();\n        _sync();\n        uint256 amount = buybackReserve;", "_sync();\n        uint256 amount = buybackReserve;"),
    (T, "coin delay skipped", "if (block.timestamp < executableAt) revert ProposalNotReady(executableAt);", ""),
    (T, "coin window not enforced", "if (block.timestamp > uint256(executableAt) + COIN_WINDOW) revert ProposalExpired();", ""),
    (T, "coin set twice", "if (orry != address(0)) revert CoinAlreadySet();\n        uint64 executableAt = _executableAt;", "uint64 executableAt = _executableAt;"),
    (T, "pull while coinless", "if (orry == address(0)) revert CoinNotSet();\n        address to = buyback;", "address to = buyback;"),
    (T, "pull by anyone", "if (msg.sender != to) revert NotBuyback();", ""),
    (T, "daily pull bound doubled", "uint256 cap = windowBase * PULL_BPS_PER_DAY / BPS;", "uint256 cap = windowBase * PULL_BPS_PER_DAY * 2 / BPS;"),
    (T, "window pulls not recorded", "_windowPulled += pulled;", ""),
    (T, "window resets on every pull", "if (_windowStart == 0 || block.timestamp >= uint256(_windowStart) + 1 days) {\n            _windowStart = uint64(block.timestamp);", "if (true) {\n            _windowStart = uint64(block.timestamp);"),
    (T, "whole-reserve rule widened", "if (reserve <= _wholeUnit) return reserve;", "if (reserve <= _wholeUnit * 1000) return reserve;"),
    (T, "quote reuse allowed", "if (quoteUsed[quoteId]) revert QuoteUsed();", ""),
    (T, "quote not marked used", "quoteUsed[quoteId] = true;", ""),
    (T, "quote expiry ignored", "if (expiry < block.timestamp) revert QuoteExpired();", ""),
    (T, "any signer accepted", "if (signer == address(0) || !isQuoteSigner[signer]) revert BadQuoteSignature();", "if (signer == address(0)) revert BadQuoteSignature();"),
    (T, "malleable high-s signature accepted", "if (uint256(s) > HALF_ORDER) return address(0);", ""),
    (T, "buyer not bound in the quote", "keccak256(abi.encode(CREDITS_TYPEHASH, msg.sender, packs, orryAmount, quoteId, expiry))", "keccak256(abi.encode(CREDITS_TYPEHASH, tx.origin, packs, orryAmount, quoteId, expiry))"),
    (T, "inexact burn unchecked", "if (supplyBefore - IOrryToken(coin).totalSupply() != amount) revert InexactBurn();", ""),
    (T, "verification cap off by one", "if (_verifyCount >= MAX_ORRY_VERIFICATIONS_PER_DAY) revert DailyVerificationCap();", "if (_verifyCount > MAX_ORRY_VERIFICATIONS_PER_DAY) revert DailyVerificationCap();"),
    (T, "verification cap never resets", "_verifyCount = 0;", ""),
    (T, "quote signer cap removed", "if (_signerCount >= MAX_QUOTE_SIGNERS) revert TooManySigners();", ""),
    (T, "owner withdraw keeps its accrual", "ownerAccrued = 0;\n        address to = owner;", "address to = owner;"),
    (T, "acceptOwnership by anyone", "if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();", ""),
    (T, "pending owner not cleared", "owner = msg.sender;\n        pendingOwner = address(0);", "owner = msg.sender;"),
    (T, "ownership start not announced", "emit OwnershipTransferStarted(msg.sender, newOwner);", ""),
    (T, "ownership transfer not announced", "emit OwnershipTransferred(owner, msg.sender);", ""),
    (T, "verification pays with maxFee 0", "payVerification(agentId, expectedOwner, IOrreryAttestorPay(attestor).fee());", "payVerification(agentId, expectedOwner, 0);"),
    # ---------------------------------------------------------------- buyback
    (B, "slice interval removed", "uint64 last = lastSliceAt;\n        if (last != 0 && block.timestamp < last + MIN_INTERVAL) revert TooSoon(last + MIN_INTERVAL);", "uint64 last = lastSliceAt;"),
    (B, "burn interval removed", "uint64 last = lastEthBurnAt;\n        if (last != 0 && block.timestamp < last + MIN_INTERVAL) revert TooSoon(last + MIN_INTERVAL);", "uint64 last = lastEthBurnAt;"),
    (B, "same-block guard off", "if (blockNumber != block.number || startSqrtP == 0) return;", "return;"),
    (B, "same-block threshold ten times wider", "uint256 private constant MAX_BLOCK_MOVE_BPS = 100;", "uint256 private constant MAX_BLOCK_MOVE_BPS = 1000;"),
    (B, "hop cap doubled", "return FullMath.mulDiv(h.reserveIn, h.feePips, 2 * PIPS);", "return FullMath.mulDiv(h.reserveIn, h.feePips, PIPS);"),
    (B, "price limit removed (sell ETH)", "? FullMath.mulDiv(sqrtP, 2 * PIPS - h.feePips, 2 * PIPS)", "? TickMath.MIN_SQRT_PRICE + 1"),
    (B, "price limit removed (sell USDG)", ": FullMath.mulDiv(sqrtP, 2 * PIPS + h.feePips, 2 * PIPS);", ": TickMath.MAX_SQRT_PRICE - 1;"),
    (B, "full-fill check removed", "if (paid >= 0 || uint256(uint128(-paid)) != amountIn || got <= 0) revert SlippageExceeded();", "if (got <= 0) revert SlippageExceeded();"),
    (B, "minimum output ignored", "if (out < minOut) revert SlippageExceeded();", ""),
    (B, "slippage tolerance 10%", "uint256 private constant SLIPPAGE_KEEP_PER_MILLE = 999;", "uint256 private constant SLIPPAGE_KEEP_PER_MILLE = 900;"),
    (B, "floor without the cap's price impact (M-4)", "spotOut * (PIPS - h.feePips) / PIPS * (2 * PIPS - h.feePips) / (2 * PIPS) * SLIPPAGE_KEEP_PER_MILLE / 1000", "spotOut * (PIPS - h.feePips) / PIPS * 995 / 1000"),
    (B, "hub fee without the hook fee", "(live, h) = _readHop(key, !p.orryIsCurrency0, IOrreryHook(hook).protocolFeePips());", "(live, h) = _readHop(key, !p.orryIsCurrency0, 0);"),
    (B, "hub orientation flipped", "(live, h) = _readHop(key, !p.orryIsCurrency0, IOrreryHook(hook).protocolFeePips());", "(live, h) = _readHop(key, p.orryIsCurrency0, IOrreryHook(hook).protocolFeePips());"),
    (B, "PoolManager protocol fee ignored", "uint256 fee = (dirFee == 0 ? lpFee : ProtocolFeeLibrary.calculateSwapFee(dirFee, lpFee)) + extraFeePips;", "uint256 fee = lpFee + extraFeePips;"),
    (B, "shallowest pool chosen", "if (live && h.reserveIn > best.reserveIn) {", "if (live && (best.reserveIn == 0 || h.reserveIn < best.reserveIn)) {"),
    (B, "bought ORRY kept by the buyback", "_manager.take(Currency.wrap(orry), rewardsRouter, orryOut - cb);", "_manager.take(Currency.wrap(orry), address(this), orryOut - cb);"),
    (B, "burnEth burns nothing", "IOrryToken(orry).burn(orryBurned);", ""),
    (B, "ETH burn not capped", "uint256 ethIn = _min(address(this).balance, _cap(hub));", "uint256 ethIn = address(this).balance;"),
    (B, "hub cap converted the wrong way", "FullMath.mulDiv(FullMath.mulDiv(hubCapEth, pool.sqrtPriceX96, Q96), pool.sqrtPriceX96, Q96);", "FullMath.mulDiv(FullMath.mulDiv(hubCapEth, Q96, pool.sqrtPriceX96), Q96, pool.sqrtPriceX96);"),
    (B, "R-18 slice cap ignored", "amount = _min(IOrreryTreasury(treasury).availableForBuyback(), _min(routeCap, _maxSliceUsdgCap));", "amount = _min(IOrreryTreasury(treasury).availableForBuyback(), routeCap);"),
    (B, "R-18 listed-pool check skipped", "_checkListedPrices(pool);\n        }\n        lastSliceAt", "}\n        lastSliceAt"),
    (B, "R-18 spread ten times wider", "uint256 private constant MAX_POOL_SPREAD_BPS = 50;", "uint256 private constant MAX_POOL_SPREAD_BPS = 500;"),
    (B, "R-18 dead pools count as references", "if (sqrtP == 0 || l * 100 < chosenL * MIN_REFERENCE_LIQUIDITY_PCT) continue;", "if (sqrtP == 0) continue;"),
    (B, "R-18 spread checked on one side only", "\n                    || price * 10_000 < chosenPrice * (10_000 - MAX_POOL_SPREAD_BPS)", ""),
    (B, "treasury allowance ignored", "amount = _min(IOrreryTreasury(treasury).availableForBuyback(), _min(routeCap, _maxSliceUsdgCap));", "amount = _min(routeCap, _maxSliceUsdgCap);"),
    # ---------------------------------------------------------------- multi-pair (R-35 to R-37)
    (B, "route rule inverted", "direct = directCap != 0 && directCap >= ethCap;", "direct = directCap != 0 && directCap <= ethCap;"),
    (B, "route always direct", "direct = directCap != 0 && directCap >= ethCap;", "direct = directCap != 0;"),
    (B, "route never direct", "direct = directCap != 0 && directCap >= ethCap;", "direct = false;"),
    (B, "ETH path cap ignores hop 1", "ethCap = _min(_cap(pool), hubCapUsdg);", "ethCap = hubCapUsdg;"),
    (B, "direct slice skips the USDG hub guard", "_checkBlockMove(usdg, hub.sqrtPriceX96);", ""),
    (B, "buyWithQuote takes native ETH", "if (quote == address(0) || quote == orry || !IOrreryHook(hook).isPair(quote)) revert NotAQuote();", "if (quote == orry || !IOrreryHook(hook).isPair(quote)) revert NotAQuote();"),
    (B, "buyWithQuote takes an unregistered token", "if (quote == address(0) || quote == orry || !IOrreryHook(hook).isPair(quote)) revert NotAQuote();", "if (quote == address(0) || quote == orry) revert NotAQuote();"),
    (B, "buyWithQuote uncapped", "uint256 amountIn = _min(IERC20Min(quote).balanceOf(address(this)), _cap(hub));", "uint256 amountIn = IERC20Min(quote).balanceOf(address(this));"),
    (B, "buyWithQuote skips its hub guard", "_checkBlockMove(quote, hub.sqrtPriceX96);", ""),
    (B, "buyWithQuote checks the ETH hub guard", "_checkBlockMove(quote, hub.sqrtPriceX96);", "_checkBlockMove(address(0), hub.sqrtPriceX96);"),
    (B, "buyWithQuote interval not recorded", "lastQuoteBuyAt[quote] = uint64(block.timestamp);", ""),
    (B, "maxQuoteIn uncapped", "return _min(IERC20Min(quote).balanceOf(address(this)), _cap(hub));", "return IERC20Min(quote).balanceOf(address(this));"),
    (B, "quote settled short", "_settleErc20(Currency.unwrap(hub.zeroForOne ? hub.key.currency0 : hub.key.currency1), amountIn);", "_settleErc20(Currency.unwrap(hub.zeroForOne ? hub.key.currency0 : hub.key.currency1), amountIn - 1);"),
    # ---------------------------------------------------------------- cashback sink (B-1, R-45)
    (B, "cashback before the sink is set", "if (cashbackSink == address(0)) return 0;\n        return orryOut * CASHBACK_BPS / BPS;", "return orryOut * CASHBACK_BPS / BPS;"),
    (B, "cashback share doubled", "return orryOut * CASHBACK_BPS / BPS;", "return orryOut * CASHBACK_BPS * 2 / BPS;"),
    (B, "cashback rounded up", "return orryOut * CASHBACK_BPS / BPS;", "return (orryOut * CASHBACK_BPS + BPS - 1) / BPS;"),
    (B, "router also paid the cashback", "_manager.take(Currency.wrap(orry), rewardsRouter, orryOut - cb);", "_manager.take(Currency.wrap(orry), rewardsRouter, orryOut);"),
    (B, "cashback not paid to the sink", "if (cb != 0) _manager.take(Currency.wrap(orry), cashbackSink, cb);", "if (cb != 0) _manager.take(Currency.wrap(orry), rewardsRouter, cb);"),
    (B, "cashback delay not enforced", "if (block.timestamp < _pendingSinkAt) revert CashbackNotReady(_pendingSinkAt);", ""),
    (B, "cashback delay off by one", "if (block.timestamp < _pendingSinkAt) revert CashbackNotReady(_pendingSinkAt);", "if (block.timestamp <= _pendingSinkAt) revert CashbackNotReady(_pendingSinkAt);"),
    (B, "sink proposed again after set", "if (cashbackSink != address(0)) revert CashbackSinkAlreadySet();\n        require(sink != address(0)", "require(sink != address(0)"),
    (B, "sink executed again after set", "if (cashbackSink != address(0)) revert CashbackSinkAlreadySet();\n        address sink = _pendingSink;", "address sink = _pendingSink;"),
    (B, "anyone proposes the sink", "if (msg.sender != IOrreryTreasury(treasury).owner()) revert NotTreasuryOwner();\n        if (cashbackSink != address(0)) revert CashbackSinkAlreadySet();\n        require", "if (cashbackSink != address(0)) revert CashbackSinkAlreadySet();\n        require"),
    (B, "anyone executes the sink", "if (msg.sender != IOrreryTreasury(treasury).owner()) revert NotTreasuryOwner();\n        if (cashbackSink != address(0)) revert CashbackSinkAlreadySet();\n        address sink", "if (cashbackSink != address(0)) revert CashbackSinkAlreadySet();\n        address sink"),
    (B, "zero sink accepted", "require(sink != address(0), \"zero sink\");", ""),
    (B, "proposal keeps the old delay", "_pendingSinkAt = at;", "if (_pendingSinkAt == 0) _pendingSinkAt = at;"),
    (B, "pending sink not cleared", "delete _pendingSink;\n        delete _pendingSinkAt;", ""),
    (B, "cashback event missing", "if (cb != 0) emit CashbackPaid(cashbackSink, cb);", ""),
    (B, "burnEth pays cashback", "_manager.settle{value: amountIn}();\n            _manager.take(Currency.wrap(orry), address(this), out);", "_manager.settle{value: amountIn}();\n            _takeOrry(out);"),
    (B, "cashback bps unchecked", "require(cashbackBps <= BPS, \"cashback bps\");", ""),
    (S, "an ETH-refusing staker loses its ORRY too (L-1)", "                acc[ETH] = ethAmount;\n                _streams[ETH].owed += ethAmount;\n                ethAmount = 0;", "                revert EthTransferFailed();"),
    (S, "claimRewardsTo pays the caller", "return _claim(msg.sender, to);", "return _claim(msg.sender, msg.sender);"),
]

originals = {}
results = []
only = sys.argv[1] if len(sys.argv) > 1 else None
shard_i, shard_n = (int(x) for x in os.environ.get("MUT_SHARD", "0/1").split("/"))
start = int(os.environ.get("MUT_FROM", "0"))
path_filter = os.environ.get("MUT_PATH", "")
try:
    for idx, (path, name, old, new) in enumerate(MUTATIONS):
        if only and only not in name:
            continue
        if path_filter and path_filter not in path:
            continue
        if idx < start or idx % shard_n != shard_i:
            continue
        if path not in originals:
            originals[path] = open(path).read()
        src = originals[path]
        assert src.count(old) == 1, f"snippet must occur once for: {name} (found {src.count(old)})"
        open(path, "w").write(src.replace(old, new, 1))
        run = subprocess.run(TEST_ARGS, capture_output=True, text=True)
        out = run.stdout + run.stderr
        # a failure reason may itself contain "]" (forge prints large numbers as "123 [1.2e2]"), so match up to the test name
        failed = sorted(set(re.findall(r"^\[FAIL.*?\]\s+(\w+)\(", out, re.M)))
        compile_error = "Compiler run failed" in out
        results.append((name, failed, compile_error))
        open(path, "w").write(src)
        print(("CAUGHT  " if failed or compile_error else "MISSED  ") + name
              + (f"  by {', '.join(failed[:3])}" if failed else (" (compile error)" if compile_error else "")), flush=True)
finally:
    for path, src in originals.items():
        open(path, "w").write(src)

caught = sum(1 for _, f, c in results if f or c)
print(f"\n{caught}/{len(results)} mutations caught")
sys.exit(0 if caught == len(results) else 1)
