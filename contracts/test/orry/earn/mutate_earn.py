#!/usr/bin/env python3
"""Mutation check for lane A (OrreryHook, EarnVault, EarnVaultFactory, ClaimAll, OrryLens), on the pattern of contracts/mutate.py.

Run from contracts/:  python3 test/orry/earn/mutate_earn.py        (RANGE=0:26 python3 ... runs a slice)
Each mutation replaces one exact snippet, runs the lane A unit tests and the deterministic deep run (not the long
invariant campaign), restores the source, and prints CAUGHT or MISSED. The unmutated suite runs first and must pass,
so a compile error that has nothing to do with a mutation can never count as a catch.
"""
import os
import re
import subprocess
import sys
import time

TEST_ARGS = ["heavy", "forge", "test", "--match-path", "{test/orry/earn/**,test/review/**}", "--no-match-test", "invariant_"]
H = "src/orry/OrreryHook.sol"
V = "src/orry/EarnVault.sol"
C = "src/orry/ClaimAll.sol"
L = "src/orry/OrryLens.sol"
F = "src/orry/EarnVaultFactory.sol"

MUTATIONS = [
    # ---------------------------------------------------------------- hook: keys, fees, collect (H-1 to H-4, P-4)
    (H, "unregistered quote initializes", "            !h.registered || key.fee != LP_FEE", "            key.fee != LP_FEE"),
    (H, "LP fee not checked", " || key.fee != LP_FEE || key.tickSpacing", " || key.tickSpacing"),
    (H, "tick spacing not checked", " || key.tickSpacing != TICK_SPACING\n", "\n"),
    (H, "initialized flag never set", "        h.initialized = true;\n", ""),
    (H, "key with ORRY as currency1 not recognised", "        if (c1 == orry) return c0;\n", ""),
    (H, "key with ORRY as currency0 not recognised", "        if (c0 == orry) return c1;\n", ""),
    (H, "every hub shares the ETH hub's record and oracle", "        Hub storage h = _hubs[_quoteOf(key)];", "        Hub storage h = _hubs[address(0)];"),
    (H, "fee off by one", "uint256 fee = abs * protocolFeePips / PIPS;", "uint256 fee = abs * protocolFeePips / PIPS + 1;"),
    (H, "fee rounds up", "uint256 fee = abs * protocolFeePips / PIPS;", "uint256 fee = (abs * protocolFeePips + PIPS - 1) / PIPS;"),
    (H, "fee on the specified side", "bool specifiedIs0 = (params.amountSpecified < 0) == params.zeroForOne;", "bool specifiedIs0 = (params.amountSpecified < 0) != params.zeroForOne;"),
    (H, "fee claims not minted", "IPoolManager(poolManager).mint(address(this), uint256(uint160(Currency.unwrap(c))), fee);", ""),
    (H, "fee not charged to the swapper", "return (IHooks.afterSwap.selector, int128(int256(fee)));", "return (IHooks.afterSwap.selector, 0);"),
    (H, "start price overwritten every swap", "bool newBlock = h.start.blockNumber != bn;", "bool newBlock = true;"),
    (H, "start price never recorded", "bool newBlock = h.start.blockNumber != bn;", "bool newBlock = false;"),
    (H, "start price recorded as zero", "if (newBlock) h.start = StartOfBlock(sqrtPriceX96, bn);", "if (newBlock) h.start = StartOfBlock(0, bn);"),
    (H, "onlyPoolManager removed", "if (msg.sender != poolManager) revert NotPoolManager();", ""),
    (H, "fees sent elsewhere", "pm.take(Currency.wrap(c), rewardsRouter, claim);", "pm.take(Currency.wrap(c), address(0xdead), claim);"),
    (H, "collect skips the claims", "if (claim != 0) IPoolManager(poolManager).unlock(", "if (false) IPoolManager(poolManager).unlock("),
    (H, "collect pays ORRY only", "        uint256 n = _quotes.length + 1;", "        uint256 n = 1;"),
    (H, "stray tokens kept", "                IERC20(c).safeTransfer(rewardsRouter, stray);\n", ""),
    (H, "stray ETH kept", "                (bool ok,) = rewardsRouter.call{value: stray}(\"\");\n                require(ok, \"eth\");\n", ""),
    (H, "collect event leaves out the stray part", "        paid = claim + stray;", "        paid = claim;"),
    (H, "one currency's failure blocks the others (M-2)", "            } catch {\n                emit ProtocolFeeCollectFailed(c);\n            }", "            } catch (bytes memory e) {\n                assembly { revert(add(e, 32), mload(e)) }\n            }"),
    (H, "collectOne open to anyone", "        if (msg.sender != address(this)) revert NotSelf();\n", ""),
    (H, "hook reentrancy guard removed", "require(locked == 0);", ""),
    (H, "unused callback answers", "function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {\n        revert HookNotImplemented();", "function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {\n        return IHooks.beforeInitialize.selector;"),
    (H, "zero router accepted", "rewardsRouter_ != address(0)", "true"),
    (H, "zero treasury accepted", "\n                && treasury_ != address(0),", ","),
    (H, "protocol fee cap off by one", "protocolFeePips_ < 100_000", "protocolFeePips_ <= 100_000"),
    (H, "zero tick spacing accepted", "require(tickSpacing_ > 0, \"tick spacing\");", ""),
    (H, "ETH feed not checked at construction", "        if (!_feedAnswers(ethUsdFeed_)) revert FeedNotAnswering();\n", ""),
    (H, "USDG not checked at construction", "        if (usdg_ == orry_ || usdg_.code.length == 0) revert BadQuote();\n", ""),
    # ---------------------------------------------------------------- hook: pair registry (P-1, P-2, R-36)
    (H, "pair admin check removed", "if (msg.sender != pairAdmin()) revert NotPairAdmin();", ""),
    (H, "pair admin is the treasury contract", "return IOrreryTreasury(treasury).owner();", "return treasury;"),
    (H, "propose accepts a registered pair", "        if (_hubs[quote].registered) revert PairAlreadyRegistered();\n", ""),
    (H, "propose accepts ORRY as quote", "if (quote == orry || quote.code.length == 0) revert BadQuote();", "if (quote.code.length == 0) revert BadQuote();"),
    (H, "propose accepts an address without code", "if (quote == orry || quote.code.length == 0) revert BadQuote();", "if (quote == orry) revert BadQuote();"),
    (H, "propose skips the cap", "        if (_quotes.length >= MAX_PAIRS) revert TooManyPairs();\n        if (!_feedAnswers(usdFeed))", "        if (!_feedAnswers(usdFeed))"),
    (H, "propose skips the feed", "        if (!_feedAnswers(usdFeed)) revert FeedNotAnswering();\n", ""),
    (H, "no delay", "uint64 executableAt = uint64(block.timestamp) + PAIR_DELAY;", "uint64 executableAt = uint64(block.timestamp);"),
    (H, "execute without a proposal", "        if (p.executableAt == 0) revert NoPairProposal();\n", ""),
    (H, "execute ignores the delay", "        if (block.timestamp < p.executableAt) revert PairNotReady(p.executableAt);\n", ""),
    (H, "execute delay off by one", "if (block.timestamp < p.executableAt)", "if (block.timestamp + 1 < p.executableAt)"),
    (H, "execute ignores the window", "        if (block.timestamp > uint256(p.executableAt) + PAIR_WINDOW) revert PairProposalExpired();\n", ""),
    (H, "window off by one", "if (block.timestamp > uint256(p.executableAt) + PAIR_WINDOW)", "if (block.timestamp >= uint256(p.executableAt) + PAIR_WINDOW)"),
    (H, "execute skips the cap", "        if (_quotes.length >= MAX_PAIRS) revert TooManyPairs();\n        if (!_feedAnswers(p.usdFeed))", "        if (!_feedAnswers(p.usdFeed))"),
    (H, "execute skips the feed", "        if (!_feedAnswers(p.usdFeed)) revert FeedNotAnswering();\n", ""),
    (H, "proposal not cleared", "        delete _proposals[quote];\n", ""),
    (H, "feed age off by one", "block.timestamp - updatedAt <= FEED_MAX_AGE", "block.timestamp - updatedAt < FEED_MAX_AGE"),
    (H, "feed answer zero accepted", "return answer > 0 && updatedAt != 0", "return answer >= 0 && updatedAt != 0"),
    (H, "feed never updated accepted", "answer > 0 && updatedAt != 0 && updatedAt", "answer > 0 && updatedAt"),
    (H, "feed without code tried", "        if (feed.code.length == 0) return false;\n", ""),
    (H, "currency order flipped at registration", "bool orryIs0 = uint160(orry) < uint160(quote);", "bool orryIs0 = uint160(orry) > uint160(quote);"),
    (H, "feed not stored", "        h.usdFeed = usdFeed;\n", ""),
    (H, "registeredAt not stored", "        h.registeredAt = uint64(block.timestamp);\n", ""),
    (H, "pair not listed", "        _quotes.push(quote);\n", ""),
    (H, "pool not mapped to its quote", "        _poolQuote[id] = PoolQuote(quote, true);\n", ""),
    (H, "isPair always true", "        return _hubs[quote].registered;", "        return true;"),
    (H, "unknown quote views answer", "        if (!h.registered) revert UnknownPair();", ""),
    # ---------------------------------------------------------------- hook: price observations (R-28, H-5 to H-8)
    (H, "seconds weighted by the previously stored tick (spec wording)", "l.tickCumulative += int56(tick) * int56(uint56(nowTs - l.timestamp));", "l.tickCumulative += int56(l.tick) * int56(uint56(nowTs - l.timestamp));"),
    (H, "cumulative step ignores elapsed time", "l.tickCumulative += int56(tick) * int56(uint56(nowTs - l.timestamp));", "l.tickCumulative += int56(tick);"),
    (H, "latest tick not stored", "            l.tick = tick;\n", ""),
    (H, "latest timestamp not stored", "            l.timestamp = nowTs;\n            if (nowTs", "            if (nowTs"),
    (H, "latest not written back", "        h.latest = l;\n    }", "    }"),
    (H, "latest updated on every swap", "if (l.timestamp != nowTs) _observe(h, l, nowTs, tick);", "_observe(h, l, nowTs, tick);"),
    (H, "latest never updated", "if (l.timestamp != nowTs) _observe(h, l, nowTs, tick);", ""),
    (H, "new second does not read slot0", "if (newBlock || l.timestamp != nowTs) {", "if (newBlock) {"),
    (H, "checkpoint interval off by one", "if (nowTs - l.newestTimestamp >= OBSERVATION_INTERVAL) {", "if (nowTs - l.newestTimestamp > OBSERVATION_INTERVAL) {"),
    (H, "checkpoint on every update", "if (nowTs - l.newestTimestamp >= OBSERVATION_INTERVAL) {", "if (true) {"),
    (H, "checkpoint never written", "if (nowTs - l.newestTimestamp >= OBSERVATION_INTERVAL) {", "if (false) {"),
    (H, "checkpoint timestamp off by one", "h.ring[next] = Checkpoint(nowTs, l.tickCumulative);", "h.ring[next] = Checkpoint(nowTs - 1, l.tickCumulative);"),
    (H, "checkpoint cumulative dropped", "h.ring[next] = Checkpoint(nowTs, l.tickCumulative);", "h.ring[next] = Checkpoint(nowTs, 0);"),
    (H, "ring position not advanced", "                l.newest = next;\n", ""),
    (H, "ring count not capped", "if (l.count < OBSERVATION_CARDINALITY) ++l.count;", "++l.count;"),
    (H, "ring count never grows", "if (l.count < OBSERVATION_CARDINALITY) ++l.count;", ""),
    (H, "ring wraps one early", "uint16 next = (l.newest + 1) % OBSERVATION_CARDINALITY;", "uint16 next = (l.newest + 1) % (OBSERVATION_CARDINALITY - 1);"),
    (H, "newest checkpoint time not kept", "                l.newestTimestamp = nowTs;\n", ""),
    (H, "oracle arithmetic checked (reverts at the 2106 wrap)", "    function _observe(Hub storage h, Latest memory l, uint32 nowTs, int24 tick) private {\n        unchecked {", "    function _observe(Hub storage h, Latest memory l, uint32 nowTs, int24 tick) private {\n        {"),
    (H, "first entry without the initial tick", "h.latest = Latest(nowTs, 0, tick, 0, 1, nowTs);", "h.latest = Latest(nowTs, 0, 0, 0, 1, nowTs);"),
    (H, "first entry not counted", "h.latest = Latest(nowTs, 0, tick, 0, 1, nowTs);", "h.latest = Latest(nowTs, 0, tick, 0, 0, nowTs);"),
    (H, "first checkpoint not written", "        h.ring[0] = Checkpoint(nowTs, 0);\n", ""),
    (H, "window 0 accepted", "if (window == 0 || window > MAX_WINDOW) revert OracleWindowTooLong();", "if (window > MAX_WINDOW) revert OracleWindowTooLong();"),
    (H, "max window off by one", "if (window == 0 || window > MAX_WINDOW) revert OracleWindowTooLong();", "if (window == 0 || window >= MAX_WINDOW) revert OracleWindowTooLong();"),
    (H, "not-ready check removed", "if (h.ring[oldest].timestamp > target) revert OracleNotReady();", ""),
    (H, "now below the window not checked", "if (l.count == 0 || nowTs < window) revert OracleNotReady();", "if (l.count == 0) revert OracleNotReady();"),
    (H, "uninitialized hub answers", "if (l.count == 0 || nowTs < window) revert OracleNotReady();", "if (nowTs < window) revert OracleNotReady();"),
    (H, "oldest checkpoint always slot 0", "uint256 oldest = l.count < OBSERVATION_CARDINALITY ? 0 : (uint256(l.newest) + 1) % OBSERVATION_CARDINALITY;", "uint256 oldest = 0;"),
    (H, "search excludes a checkpoint at the target", ".timestamp <= target) lo = mid;", ".timestamp < target) lo = mid;"),
    (H, "consult uses the oldest checkpoint", "Checkpoint memory c = h.ring[(oldest + lo) % OBSERVATION_CARDINALITY];", "Checkpoint memory c = h.ring[oldest];"),
    (H, "running cumulative ignores the open interval", "int56 cumNow = l.tickCumulative + int56(tickNow) * int56(uint56(nowTs - l.timestamp));", "int56 cumNow = l.tickCumulative;"),
    (H, "open interval weighted by the stored tick", "int56 cumNow = l.tickCumulative + int56(tickNow) * int56(uint56(nowTs - l.timestamp));", "int56 cumNow = l.tickCumulative + int56(l.tick) * int56(uint56(nowTs - l.timestamp));"),
    (H, "mean truncates toward zero", "if (delta < 0 && delta % secs != 0) --q;", ""),
    (H, "mean floors exact negatives too", "if (delta < 0 && delta % secs != 0) --q;", "if (delta < 0) --q;"),
    (H, "actualWindow reported as the window", "actualWindow = nowTs - c.timestamp;", "actualWindow = window;"),
    # ---------------------------------------------------------------- vault: lock, slippage, value
    (V, "lock check removed", "if (block.timestamp < until) revert SharesLocked(until);", ""),
    (V, "lock not stored", "_unlockAt[msg.sender] = until;", ""),
    (V, "lock ignores held shares", "uint256 lock = (remaining * held + uint256(DEPOSIT_LOCK) * minted) / (held + minted);", "uint256 lock = DEPOSIT_LOCK;"),
    (V, "lock ignores the remaining lock", "uint256 remaining = until > block.timestamp ? until - block.timestamp : 0;", "uint256 remaining = 0;"),
    (V, "minShares ignored", "if (shares < minShares) revert SlippageExceeded();", ""),
    (V, "withdraw minimums ignored", "if (quoteOut < minQuoteOut || orryOut < minOrryOut) revert SlippageExceeded();", ""),
    (V, "minSwapOut ignored", "if (out < op.minSwapOut) revert SlippageExceeded();", ""),
    (V, "deadline off by one", "if (block.timestamp > deadline) revert DeadlinePassed();", "if (block.timestamp > deadline + 1) revert DeadlinePassed();"),
    (V, "InsufficientShares removed", "if (shares > held) revert InsufficientShares();", ""),
    (V, "zero withdraw accepted", "if (shares == 0) revert ZeroAmount();", ""),
    (V, "deposit value not checked", "        if (msg.value != (quote == address(0) ? quoteMax : 0)) revert ValueMismatch();\n", ""),
    (V, "zap value not checked", "        if (msg.value != (native ? amountIn : 0)) revert ValueMismatch();\n", ""),
    (V, "hub check removed", "if (sqrtPriceX96 == 0) revert HubNotInitialized();", ""),
    # ---------------------------------------------------------------- vault: currency order and payouts
    (V, "zap swaps the wrong way", "bool zeroForOne = fromQuote != _orryIs0;", "bool zeroForOne = fromQuote == _orryIs0;"),
    (V, "inputs ignore the pool's currency order", "return _orryIs0 ? (r, q) : (q, r);", "return (q, r);"),
    (V, "outputs ignore the pool's currency order", "return _orryIs0 ? (a1, a0) : (a0, a1);", "return (a0, a1);"),
    (V, "ERC-20 quote payout dropped", "            IERC20(quote).safeTransfer(to, quoteAmount);\n", ""),
    (V, "settle pays every token in ORRY", "IERC20(Currency.unwrap(c)).safeTransfer(address(_pm), owed);", "IERC20(orry).safeTransfer(address(_pm), owed);"),
    (V, "guard reads the ETH hub", "IOrreryHook(hook).startOfBlockSqrtPriceX96(quote);", "IOrreryHook(hook).startOfBlockSqrtPriceX96(address(0));"),
    # ---------------------------------------------------------------- vault: notified rewards (B-2, E-7)
    (V, "notified ORRY feeds the quote stream", "        _restream(_streams[1], received);\n        emit RewardsNotified", "        _restream(_streams[0], received);\n        emit RewardsNotified"),
    (V, "notified ORRY never streamed", "        _restream(_streams[1], received);\n        emit RewardsNotified", "        emit RewardsNotified"),
    (V, "notify pulls nothing", "uint256 received = _pull(orry, orryAmount);", "uint256 received = orryAmount;"),
    (V, "notify skips the global update", "        _updateGlobal();\n        _restream(_streams[1], received);", "        _restream(_streams[1], received);"),
    (V, "notify accepts zero", "        if (received == 0) revert ZeroAmount();\n        _updateGlobal();", "        _updateGlobal();"),
    # ---------------------------------------------------------------- vault: same-block guard
    (V, "block guard removed", "if (_movedTooFar(live, start)) revert PriceMovedInBlock();", ""),
    (V, "block guard ten times looser", "scaled * BPS > uint256(start) * (BPS + MAX_BLOCK_MOVE_BPS)", "scaled * BPS > uint256(start) * (BPS + 10 * MAX_BLOCK_MOVE_BPS)"),
    (V, "block guard lower side removed", "\n            || scaled * BPS < uint256(start) * (BPS - MAX_BLOCK_MOVE_BPS);", ";"),
    (V, "block guard on sqrt price", "uint256 scaled = FullMath.mulDiv(live, live, start);", "uint256 scaled = live;"),
    (V, "block guard ignores the block", "if (bn != uint64(block.number)) return;", "if (false) return;"),
    (V, "guard checked after the zap swap", "            _checkBlockMove();\n            BalanceDelta d = _pm.swap(", "            BalanceDelta d = _pm.swap("),
    # ---------------------------------------------------------------- vault: accounting
    (V, "no harvest before a deposit", "if (totalShares != 0) {\n                (, BalanceDelta fees)", "if (false) {\n                (, BalanceDelta fees)"),
    (V, "withdraw principal includes fees", "r.amount0 = _u(all.amount0()) - r.fees0;", "r.amount0 = _u(all.amount0());"),
    (V, "withdraw fees not streamed", "            r.fees0 = _u(fees.amount0());\n            r.fees1 = _u(fees.amount1());\n            r.amount0", "            r.amount0"),
    (V, "refund ignores what was used", "r.refund0 = a0 - r.amount0;", "r.refund0 = a0;"),
    (V, "the add's fees go back to the zapper (M-1)", "        r.fees0 += _u(addFees.amount0());\n        r.fees1 += _u(addFees.amount1());\n", ""),
    (V, "principal counts the add's fees", "r.amount0 = _u(addFees.amount0() - added.amount0());", "r.amount0 = _u(-added.amount0());"),
    (V, "deposit price bounds ignored (M-3)", "        if (entryPrice < op.minSqrtPriceX96 || entryPrice > op.maxSqrtPriceX96) revert PriceOutOfBounds();\n", ""),
    (V, "upper price bound ignored", "entryPrice < op.minSqrtPriceX96 || entryPrice > op.maxSqrtPriceX96", "entryPrice < op.minSqrtPriceX96"),
    (V, "lower price bound ignored", "entryPrice < op.minSqrtPriceX96 || entryPrice > op.maxSqrtPriceX96", "entryPrice > op.maxSqrtPriceX96"),
    (V, "refunds dropped", "        _pay(msg.sender, refundQ, refundR);\n", ""),
    (V, "harvested not recorded", "s.harvested += fees;", ""),
    (V, "remainder not rolled", "uint256 left = block.timestamp < s.periodFinish ? s.rate * (s.periodFinish - block.timestamp) : 0;", "uint256 left = 0;"),
    (V, "queued not restreamed", "uint256 fresh = fees + s.queued;", "uint256 fresh = fees;"),
    (V, "zero-share time dropped", "else s.queued += emitted / PRECISION;", ""),
    (V, "restart keeps the old lastUpdate", "s.periodFinish = uint64(block.timestamp) + STREAM_PERIOD;\n        s.lastUpdate = uint64(block.timestamp);", "s.periodFinish = uint64(block.timestamp) + STREAM_PERIOD;"),
    (V, "stream period doubled on restart", "s.periodFinish = uint64(block.timestamp) + STREAM_PERIOD;", "s.periodFinish = uint64(block.timestamp) + 2 * STREAM_PERIOD;"),
    (V, "stream past the finish", "uint256 t = block.timestamp < s.periodFinish ? block.timestamp : s.periodFinish;\n            uint256 last", "uint256 t = block.timestamp;\n            uint256 last"),
    (V, "deposit does not settle the account first", "_notify(fq, fr);\n        _updateAccount(msg.sender);\n        uint256 held", "_notify(fq, fr);\n        uint256 held"),
    (V, "withdraw does not settle the account first", "_updateAccount(msg.sender);\n        _shares[msg.sender] = held - shares;", "_shares[msg.sender] = held - shares;"),
    (V, "claim skips the global update", "_updateGlobal();\n        _updateAccount(account);", "_updateAccount(account);"),
    (V, "owed quote not cleared", "_owed[account][0] = 0;", ""),
    (V, "paid not recorded", "_streams[0].paid += quoteAmount;", ""),
    (V, "claim pays the caller", "        _pay(account, quoteAmount, orryAmount);", "        _pay(msg.sender, quoteAmount, orryAmount);"),
    (V, "withdraw keeps the fees", "(uint256 feeQ, uint256 feeR) = _takeOwed(msg.sender);", "(uint256 feeQ, uint256 feeR) = (uint256(0), uint256(0));"),
    (V, "pending view ignores live accrual", "if (t > s.lastUpdate && totalShares != 0) ps += s.rate * (t - s.lastUpdate) / totalShares;", ""),
    (V, "preview rounds up", "a0 = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, _sqrtUpper, liq, false);", "a0 = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, _sqrtUpper, liq, true);"),
    # ---------------------------------------------------------------- vault: access and ETH
    (V, "callback caller not checked", "require(msg.sender == address(_pm));\n        Op memory op", "Op memory op"),
    (V, "receive accepts anyone", "receive() external payable {\n        require(msg.sender == address(_pm));", "receive() external payable {"),
    (V, "vault reentrancy guard removed", "require(locked == 0);", ""),
    (V, "failed ETH payout ignored", "if (!ok) revert EthTransferFailed();", ""),
    # ---------------------------------------------------------------- factory (P-6)
    (F, "second vault per quote allowed", "        if (_vaultOf[quote] != address(0)) revert VaultExists();\n", ""),
    (F, "vault not recorded", "        _vaultOf[quote] = vault;\n", ""),
    (F, "vault not listed", "        _vaults.push(vault);\n", ""),
    (F, "salt ignores the quote", "return bytes32(uint256(uint160(quote)));", "return bytes32(0);"),
    (F, "prediction uses another salt", "address(this), _salt(quote), initHash", "address(this), bytes32(uint256(1)), initHash"),
    # ---------------------------------------------------------------- claim all and lens
    (C, "claimAll skips staking", "(uint256 stakeEth, uint256 stakeOrry) = IOrryStaking(staking).claimFor(msg.sender);", "(uint256 stakeEth, uint256 stakeOrry) = (uint256(0), uint256(0));"),
    (C, "claimAll skips the vaults", "(uint256 q, uint256 r) = IEarnVault(vaults[i]).claimFor(msg.sender);", "(uint256 q, uint256 r) = (uint256(0), uint256(0));"),
    (C, "ETH vault fees left out of the ETH total", "                paid[1].amount += q;\n", ""),
    (C, "vault ORRY left out of the ORRY total", "            paid[0].amount += r;\n", ""),
    (C, "other quotes reported as zero", "paid[k] = Paid(quotes[i], q);", "paid[k] = Paid(quotes[i], 0);"),
    (L, "staker filter removed", "if (p.staker != staker || staker == address(0)) continue;", "if (staker == address(0)) continue;"),
    (L, "agent always reported", "reportedForAgent: owners[i] != address(0) && _currentOwner(registry, agentIds[i]) == owners[i]", "reportedForAgent: true"),
    (L, "zero owner reported", "reportedForAgent: owners[i] != address(0) && ", "reportedForAgent: "),
    (L, "length check removed", "require(agentIds.length == owners.length, \"length\");", ""),
    (L, "position from the whole vault", "(e.positionQuote, e.positionOrry) = vault.previewWithdraw(e.shares);", "(e.positionQuote, e.positionOrry) = vault.positionAmounts();"),
    (L, "vault quote not read", "            e.quote = vault.quote();\n", ""),
    (L, "earn list left empty", "for (uint256 i; i < vaults.length; ++i) {\n            IEarnVault vault", "for (uint256 i; i < 0; ++i) {\n            IEarnVault vault"),
    (L, "stake rewards not read", "(c.stakeRewardsEth, c.stakeRewardsOrry) = stake.pendingRewards(account);", ""),
]

only = sys.argv[1:]  # optional substrings to run a subset
# optional RANGE=a:b (python slice of MUTATIONS) to split a run across copies of contracts/ in parallel
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
        # non-greedy up to "] name(": a failure reason may itself hold brackets such as "[1e24]"
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
