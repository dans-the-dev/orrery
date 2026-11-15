#!/usr/bin/env python3
"""Mutation check for lane L3 (docs/updates/L3-R2-SPEC.md): PredictionMarket, PredictionMarketFactory, LimitOrderBook,
OrryPaymaster. Pattern of test/markets/mutate_markets.py.

Run from contracts/ (or a copy of it):  python3 mutate_r2.py
Each mutation replaces one exact snippet, runs the lane's unit tests and deterministic deep runs (not the invariant
campaigns, not the fork tests), restores the source, and prints CAUGHT or MISSED. MUT_PATH=Paymaster (a file name part)
runs one contract's mutations; MUT_SHARD=i/n splits the list across copies.
"""
import os
import re
import subprocess
import sys

TEST_ARGS = ["heavy", "forge", "test", "--match-path", "test/r2/**", "--no-match-path", "test/r2/fork/**",
             "--no-match-test", "invariant_", "--skip", "script/**"]
P = "src/markets/r2/PredictionMarket.sol"
F = "src/markets/r2/PredictionMarketFactory.sol"
L = "src/markets/r2/LimitOrderBook.sol"
A = "src/paymaster/OrryPaymaster.sol"
S = "src/markets/r2/shield/OrreryShield.sol"

MUTATIONS = [
    # ---------------------------------------------------------------- staking (PM-7, PM-1)
    (P, "stake at the lock second", "if (block.timestamp >= lockTime || status != Status.Open) revert StakingClosed();", "if (block.timestamp > lockTime || status != Status.Open) revert StakingClosed();"),
    (P, "stake ignores the lock", "if (block.timestamp >= lockTime || status != Status.Open) revert StakingClosed();", "if (status != Status.Open) revert StakingClosed();"),
    (P, "minimum stake exclusive", "if (amount < minStake) revert StakeTooSmall();", "if (amount <= minStake) revert StakeTooSmall();"),
    (P, "stake not balance checked", "if (IStakeToken(usdg).balanceOf(address(this)) - before != amount) revert InexactTransfer();\n        if (yes)", "if (yes)"),
    (P, "yes stake counted as no", "_yesPool += amount;", "_noPool += amount;"),
    # ---------------------------------------------------------------- settlement (PM-4, PM-7)
    (P, "settle before the close", "if (block.timestamp < closeTime) revert NotClosed();", ""),
    (P, "settle after the window", "if (block.timestamp >= uint256(closeTime) + SETTLE_WINDOW) revert WindowClosed();", ""),
    (P, "one-sided market settles", "if (_yesPool == 0 || _noPool == 0) {", "if (_yesPool == 0 && _noPool == 0) {"),
    (P, "round before the close accepted", "if (updatedAt < closeTime || answer <= 0) revert BadPrice();", "if (answer <= 0) revert BadPrice();"),
    (P, "non-positive answer accepted", "if (updatedAt < closeTime || answer <= 0) revert BadPrice();", "if (updatedAt < closeTime) revert BadPrice();"),
    (P, "later round accepted", "if (!prevOk || prevUpdatedAt == 0 || prevUpdatedAt >= closeTime) revert NotFirstRound();", "if (!prevOk || prevUpdatedAt == 0) revert NotFirstRound();"),
    (P, "previous round at the close accepted", "if (!prevOk || prevUpdatedAt == 0 || prevUpdatedAt >= closeTime) revert NotFirstRound();", "if (!prevOk || prevUpdatedAt == 0 || prevUpdatedAt > closeTime) revert NotFirstRound();"),
    (P, "previous round read wrong", "(bool prevOk, uint256 prevUpdatedAt) = _roundTime(roundId - 1);", "(bool prevOk, uint256 prevUpdatedAt) = _roundTime(roundId);"),
    (P, "round zero not refused", "if (roundId == 0) revert NotFirstRound();", ""),
    (P, "oracle pause ignored", "if (paused) revert StalePrice();", ""),
    (P, "corporate action ignored", "if (effectiveAt > createdAt && effectiveAt <= updatedAt) {", "if (false) {"),
    (P, "corporate action at creation refunds", "if (effectiveAt > createdAt && effectiveAt <= updatedAt) {", "if (effectiveAt >= createdAt && effectiveAt <= updatedAt) {"),
    (P, "corporate action at the round ignored", "if (effectiveAt > createdAt && effectiveAt <= updatedAt) {", "if (effectiveAt > createdAt && effectiveAt < updatedAt) {"),
    (P, "strike inclusive", "_setStatus(answer > strike ? Status.Yes : Status.No, answer, roundId);", "_setStatus(answer >= strike ? Status.Yes : Status.No, answer, roundId);"),
    (P, "outcome inverted", "_setStatus(answer > strike ? Status.Yes : Status.No, answer, roundId);", "_setStatus(answer > strike ? Status.No : Status.Yes, answer, roundId);"),
    (P, "settle twice", "if (status != Status.Open) revert NotOpen();\n        if (block.timestamp < closeTime)", "if (block.timestamp < closeTime)"),
    (P, "expire early", "if (block.timestamp < uint256(closeTime) + SETTLE_WINDOW) revert WindowOpen();", ""),
    (P, "expire a settled market", "if (status != Status.Open) revert NotOpen();\n        if (block.timestamp < uint256(closeTime) + SETTLE_WINDOW)", "if (block.timestamp < uint256(closeTime) + SETTLE_WINDOW)"),
    # ---------------------------------------------------------------- claims (PM-2, PM-3, PM-5)
    (P, "claim before settlement", "if (s == Status.Open) revert NotSettled();\n        uint256 gross", "uint256 gross"),
    (P, "claim twice", "claimed[msg.sender] = true;", ""),
    (P, "gross rounds up", "return FullMath.mulDiv(stakeWon, _yesPool + _noPool, winPool);", "return FullMath.mulDivRoundingUp(stakeWon, _yesPool + _noPool, winPool);"),
    (P, "losing side paid", "(uint256 stakeWon, uint256 winPool) = s == Status.Yes ? (_yes[account], _yesPool) : (_no[account], _noPool);", "(uint256 stakeWon, uint256 winPool) = s == Status.Yes ? (_no[account], _yesPool) : (_yes[account], _noPool);"),
    (P, "refund misses the no stake", "if (s == Status.Refund) return _yes[account] + _no[account];", "if (s == Status.Refund) return _yes[account];"),
    (P, "claimed winning stake not tracked", "_claimedStake += s == Status.Yes ? _yes[msg.sender] : _no[msg.sender];", ""),
    (P, "refund not tracked", "_claimedStake += gross;", ""),
    (P, "owed rounds down", "return FullMath.mulDivRoundingUp(winPool - _claimedStake, total, winPool);", "return FullMath.mulDiv(winPool - _claimedStake, total, winPool);"),
    (P, "owed while open ignores stakes", "if (s == Status.Open) return total;", "if (s == Status.Open) return 0;"),
    # ---------------------------------------------------------------- fees (PM-6)
    (P, "fee ignores the staker discount", "uint256 fee = FullMath.mulDiv(gross, uint256(feeBps) * (BPS - _discount(msg.sender)), BPS * BPS);", "uint256 fee = FullMath.mulDiv(gross, uint256(feeBps) * BPS, BPS * BPS);"),
    (P, "fee rounds up", "uint256 fee = FullMath.mulDiv(gross, uint256(feeBps) * (BPS - _discount(msg.sender)), BPS * BPS);", "uint256 fee = FullMath.mulDivRoundingUp(gross, uint256(feeBps) * (BPS - _discount(msg.sender)), BPS * BPS);"),
    (P, "ORRY fee discount ignored", "(bool ok, uint256 amount) = _orryFor(FullMath.mulDiv(fee, BPS - orryFeeDiscountBps, BPS));", "(bool ok, uint256 amount) = _orryFor(fee);"),
    (P, "ORRY fee not burned", "IOrryToken(orry).burnFrom(msg.sender, amount);\n                    if", "if"),
    (P, "ORRY fee burn not supply checked", "if (supply - IOrryToken(orry).totalSupply() != amount) revert InexactTransfer();\n                    orryFee = amount;", "orryFee = amount;"),
    (P, "ORRY fee also charged in USDG", "usdgFee = 0;", ""),
    (P, "USDG fee kept by the market", "_pay(treasury, usdgFee);", ""),
    (P, "fee burn source wrong", "uint8 private constant BURN_PREDICTION_FEE = 31;", "uint8 private constant BURN_PREDICTION_FEE = 30;"),
    (P, "discount read fails open", "} catch {\n            return 0;\n        }\n    }\n\n    function _orryFor", "} catch {\n            return BPS;\n        }\n    }\n\n    function _orryFor"),
    # ---------------------------------------------------------------- sweep (PM-1, L3-6)
    (P, "sweep takes what is owed", "amount = balance > o ? balance - o : 0;", "amount = balance;"),
    (P, "sweep before settlement", "if (status == Status.Open) revert NotSettled();\n        uint256 balance", "uint256 balance"),
    # ---------------------------------------------------------------- factory (PM-8, L3-2)
    (F, "anyone lists a feed", "if (msg.sender != owner) revert NotOwner();\n        if (feed == address(0))", "if (feed == address(0))"),
    (F, "a feed is listed twice", "if (feedListed[feed]) revert AlreadyListed();", ""),
    (F, "a dead feed is listed", "if (answer <= 0 || updatedAt == 0) revert BadPrice();", ""),
    (F, "market on an unlisted feed", "if (!feedListed[feed]) revert FeedNotListed();", ""),
    (F, "zero strike", "if (strike <= 0) revert BadParams();", ""),
    (F, "shortest market refused", "if (closeTime < block.timestamp + MIN_DURATION || closeTime > block.timestamp + MAX_DURATION) revert BadParams();", "if (closeTime <= block.timestamp + MIN_DURATION || closeTime > block.timestamp + MAX_DURATION) revert BadParams();"),
    (F, "longest market refused", "if (closeTime < block.timestamp + MIN_DURATION || closeTime > block.timestamp + MAX_DURATION) revert BadParams();", "if (closeTime < block.timestamp + MIN_DURATION || closeTime >= block.timestamp + MAX_DURATION) revert BadParams();"),
    (F, "market longer than the maximum", "if (closeTime < block.timestamp + MIN_DURATION || closeTime > block.timestamp + MAX_DURATION) revert BadParams();", "if (closeTime < block.timestamp + MIN_DURATION) revert BadParams();"),
    (F, "no staking lock", "lockTime: closeTime - _lockSeconds,", "lockTime: closeTime,"),
    (F, "asset not bound to the market", "asset: assetOfFeed[feed],\n                    strike", "asset: address(0),\n                    strike"),
    (F, "creation fee not burned", "IOrryToken(orry).burnFrom(msg.sender, amount);", ""),
    (F, "creation burn not supply checked", "if (supply - IOrryToken(orry).totalSupply() != amount) revert InexactTransfer();", ""),
    (F, "creation fee while the price is not ready", "if (!isReady) return 0;", ""),
    (F, "fee cap off by one", "p.feeBps > MAX_PREDICTION_FEE_BPS ||", "p.feeBps > MAX_PREDICTION_FEE_BPS + 1 ||"),
    (F, "anyone accepts ownership", "if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();", ""),
    (F, "creation burn source wrong", "uint8 private constant BURN_CREATION_FEE = 30;", "uint8 private constant BURN_CREATION_FEE = 31;"),
    # ---------------------------------------------------------------- limit orders: order checks (LO-2, LO-6)
    (L, "tip cap off by one", "o.tipBps > MAX_TIP_BPS) revert BadOrder();", "o.tipBps > MAX_TIP_BPS + 1) revert BadOrder();"),
    (L, "oversized amount accepted", "if (o.amountIn > type(uint128).max) revert BadOrder();", ""),
    (L, "expiry exclusive", "if (block.timestamp > o.expiry) revert OrderExpired();", "if (block.timestamp >= o.expiry) revert OrderExpired();"),
    (L, "expired order fills", "if (block.timestamp > o.expiry) revert OrderExpired();", ""),
    (L, "used nonce fills again", "if (nonceUsed[o.owner][o.nonce]) revert NonceUsed();\n        bytes32 orderHash", "bytes32 orderHash"),
    (L, "nonce not marked", "nonceUsed[o.owner][o.nonce] = true;\n\n        Fill memory f;", "Fill memory f;"),
    (L, "signature not checked", "if (!SignatureChecker.isValidSignatureNow(o.owner, orderHash, signature)) revert BadSignature();", ""),
    (L, "cancel twice allowed", "if (nonceUsed[msg.sender][nonce]) revert NonceUsed();\n        nonceUsed[msg.sender][nonce] = true;", "nonceUsed[msg.sender][nonce] = true;"),
    (L, "cancel marks nothing", "nonceUsed[msg.sender][nonce] = true;\n        emit NonceCancelled", "emit NonceCancelled"),
    (L, "hash misses the limit", "o.amountIn,\n                o.limitPrice,", "o.amountIn,\n                uint256(0),"),
    # ---------------------------------------------------------------- price band and limit (LO-3)
    (L, "sell limit ignored", "if (o.limitPrice > f.low) f.low = o.limitPrice;", ""),
    (L, "buy limit ignored", "} else if (o.limitPrice < f.high) {\n            f.high = o.limitPrice;\n        }", "}"),
    (L, "band twice as wide", "f.high = FullMath.mulDiv(f.price, BPS + maxDeviationBps, BPS);", "f.high = FullMath.mulDiv(f.price, BPS + 2 * maxDeviationBps, BPS);"),
    (L, "band low twice as wide", "f.low = FullMath.mulDivRoundingUp(f.price, BPS - maxDeviationBps, BPS);", "f.low = FullMath.mulDivRoundingUp(f.price, BPS - 2 * maxDeviationBps, BPS);"),
    (L, "sell realised floor removed", "if (f.out * ONE < f.low * o.amountIn || f.out * ONE > f.high * o.amountIn) revert NotFillable();", "if (f.out * ONE > f.high * o.amountIn) revert NotFillable();"),
    (L, "sell realised ceiling removed", "if (f.out * ONE < f.low * o.amountIn || f.out * ONE > f.high * o.amountIn) revert NotFillable();", "if (f.out * ONE < f.low * o.amountIn) revert NotFillable();"),
    (L, "buy realised ceiling removed", "if (o.amountIn * ONE < f.low * f.out || o.amountIn * ONE > f.high * f.out) revert NotFillable();", "if (o.amountIn * ONE < f.low * f.out) revert NotFillable();"),
    (L, "buy realised floor removed", "if (o.amountIn * ONE < f.low * f.out || o.amountIn * ONE > f.high * f.out) revert NotFillable();", "if (o.amountIn * ONE > f.high * f.out) revert NotFillable();"),
    (L, "partial fill accepted", "if (paidIn >= 0 || uint256(uint128(-paidIn)) != amountIn || gotOut <= 0) revert NotFillable();", "if (paidIn >= 0 || gotOut <= 0) revert NotFillable();"),
    # ---------------------------------------------------------------- oracle and listing (LO-6)
    (L, "unlisted asset", "if (market == address(0)) revert NotListed();", ""),
    (L, "market without a pool", "if (!listed) revert NotListed();", ""),
    (L, "stale bound one second late", "if (block.timestamp - updatedAt > maxStaleness) revert StalePrice();", "if (block.timestamp - updatedAt > maxStaleness + 1) revert StalePrice();"),
    (L, "future round accepted", "if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) revert StalePrice();", "if (answer <= 0 || updatedAt == 0) revert StalePrice();"),
    (L, "negative answer accepted", "if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) revert StalePrice();", "if (updatedAt == 0 || updatedAt > block.timestamp) revert StalePrice();"),
    (L, "zero round time accepted", "if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) revert StalePrice();", "if (answer <= 0 || updatedAt > block.timestamp) revert StalePrice();"),
    (L, "oracle pause ignored", "if (paused) revert StalePrice();", ""),
    (L, "corporate action ignored", "if (effectiveAt > updatedAt && effectiveAt <= block.timestamp) revert StalePrice();", ""),
    (L, "future corporate action blocks", "if (effectiveAt > updatedAt && effectiveAt <= block.timestamp) revert StalePrice();", "if (effectiveAt > updatedAt) revert StalePrice();"),
    # ---------------------------------------------------------------- money (LO-4, LO-5, X-1)
    (L, "fee ignores the staker discount", "uint256 fee = FullMath.mulDiv(f.notional, uint256(feeBps) * (BPS - f.discount), BPS * BPS);", "uint256 fee = FullMath.mulDiv(f.notional, uint256(feeBps) * BPS, BPS * BPS);"),
    (L, "tip zero", "f.tip = FullMath.mulDiv(f.notional, o.tipBps, BPS);", "f.tip = 0;"),
    (L, "ORRY fee discount ignored", "f.orryFee = IOrryPriceOracle(orryPrice).orryFor(FullMath.mulDiv(fee, BPS - orryFeeDiscountBps, BPS));", "f.orryFee = IOrryPriceOracle(orryPrice).orryFor(fee);"),
    (L, "ORRY fee also charged in USDG", "} else {\n            f.fee = fee;\n        }", "}\n        f.fee = fee;"),
    (L, "ORRY fee not burned", "IOrryToken(orry).burnFrom(o.owner, f.orryFee);", ""),
    (L, "ORRY burn not supply checked", "if (supply - IOrryToken(orry).totalSupply() != f.orryFee) revert InexactTransfer();", ""),
    (L, "ORRY ready ignored", "f.inOrry = o.payFeeInOrry && _orryReady();", "f.inOrry = o.payFeeInOrry;"),
    (L, "seller paid gross", "_pay(usdg, o.owner, f.out - f.fee - f.tip);", "_pay(usdg, o.owner, f.out - f.fee);"),
    (L, "buyer pull without fee", "_pull(usdg, o.owner, o.amountIn + f.fee + f.tip);", "_pull(usdg, o.owner, o.amountIn + f.tip);"),
    (L, "fee kept by the book", "_pay(usdg, treasury, f.fee);", ""),
    (L, "tip kept by the book", "_pay(usdg, msg.sender, f.tip);", ""),
    (L, "pull not balance checked", "if (IBookToken(token).balanceOf(address(this)) - before != amount) revert InexactTransfer();\n    }", "}"),
    (L, "book balance check removed", "if (\n            IBookToken(o.asset).balanceOf(address(this)) != assetBefore\n                || IBookToken(usdg).balanceOf(address(this)) != usdgBefore\n        ) revert InexactTransfer();", ""),
    (L, "callback open to anyone", "if (msg.sender != poolManager || !inSwap) revert WrongCaller();", "if (!inSwap) revert WrongCaller();"),
    (L, "callback outside a fill", "if (msg.sender != poolManager || !inSwap) revert WrongCaller();", "if (msg.sender != poolManager) revert WrongCaller();"),
    (L, "fill burn source wrong", "uint8 private constant BURN_LIMIT_FEE = 32;", "uint8 private constant BURN_LIMIT_FEE = 31;"),
    # ---------------------------------------------------------------- paymaster: validation (PA-2, PA-4)
    (A, "precharge without the buffer", "maxCostWei, _rate * (BPS + _premiumBps + _bufferBps), WEI_PER_ETH * BPS", "maxCostWei, _rate * (BPS + _premiumBps), WEI_PER_ETH * BPS"),
    (A, "precharge rounds down", "return FullMath.mulDivRoundingUp(\n            maxCostWei,", "return FullMath.mulDiv(\n            maxCostWei,"),
    (A, "cost cap exclusive", "if (maxCost > _maxCostWei) revert CostTooHigh();", "if (maxCost >= _maxCostWei) revert CostTooHigh();"),
    (A, "no cost cap", "if (maxCost > _maxCostWei) revert CostTooHigh();", ""),
    (A, "postOp gas minimum exclusive", "if (postOpGasLimit < MIN_POST_OP_GAS) revert PostOpGasTooLow();", "if (postOpGasLimit <= MIN_POST_OP_GAS) revert PostOpGasTooLow();"),
    (A, "postOp gas not checked", "if (postOpGasLimit < MIN_POST_OP_GAS) revert PostOpGasTooLow();", ""),
    (A, "short paymaster data accepted", "if (pmd.length < 52) revert PostOpGasTooLow();", ""),
    (A, "postOp limit not charged", "uint256 extraGas = postOpGasLimit + uint128(uint256(userOp.accountGasLimits)) / 10;", "uint256 extraGas = uint128(uint256(userOp.accountGasLimits)) / 10;"),
    (A, "unused-gas penalty not charged", "uint256 extraGas = postOpGasLimit + uint128(uint256(userOp.accountGasLimits)) / 10;", "uint256 extraGas = postOpGasLimit;"),
    (A, "unset rate accepted", "if (rate == 0) revert RateNotSet();", ""),
    (A, "short balance not refused", "if (bal < precharge) revert InsufficientBalance();\n        balanceOf[sender]", "balanceOf[sender]"),
    (A, "precharge not set aside", "balanceOf[sender] = bal - precharge;", ""),
    (A, "valid until ignores the cache age", "validationData = uint256(uint48(uint256(_rateAt) + _maxRateAge)) << 160;", "validationData = uint256(uint48(uint256(_rateAt) + _maxRateAge));"),
    (A, "valid until never ends", "validationData = uint256(uint48(uint256(_rateAt) + _maxRateAge)) << 160;", "validationData = 0;"),
    (A, "validate open to anyone", "external\n        onlyEntryPoint\n        returns (bytes memory context, uint256 validationData)", "external\n        returns (bytes memory context, uint256 validationData)"),
    (A, "postOp open to anyone", "function postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)\n        external\n        onlyEntryPoint", "function postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)\n        external"),
    # ---------------------------------------------------------------- paymaster: charge (PA-1, PA-3)
    (A, "postOp ignores the fresh rate", "if (ok) {\n            rate = fresh;\n            _store(fresh);", "if (ok) {\n            _store(fresh);"),
    (A, "postOp does not cache the fresh rate", "rate = fresh;\n            _store(fresh);", "rate = fresh;"),
    (A, "postOp overhead ignored", "uint256 cost = actualGasCost + (extraGas + _postOpOverheadGas) * actualUserOpFeePerGas;", "uint256 cost = actualGasCost + extraGas * actualUserOpFeePerGas;"),
    (A, "after-postOp gas ignored", "uint256 cost = actualGasCost + (extraGas + _postOpOverheadGas) * actualUserOpFeePerGas;", "uint256 cost = actualGasCost;"),
    (A, "charge rounds down", "uint256 charge = FullMath.mulDivRoundingUp(cost, rate * (BPS + _premiumBps), WEI_PER_ETH * BPS);", "uint256 charge = FullMath.mulDiv(cost, rate * (BPS + _premiumBps), WEI_PER_ETH * BPS);"),
    (A, "charge without premium", "uint256 charge = FullMath.mulDivRoundingUp(cost, rate * (BPS + _premiumBps), WEI_PER_ETH * BPS);", "uint256 charge = FullMath.mulDivRoundingUp(cost, rate * BPS, WEI_PER_ETH * BPS);"),
    (A, "charge not capped", "if (charge > precharge) charge = precharge;", ""),
    (A, "premium not split out", "uint256 base = FullMath.mulDiv(charge, BPS, BPS + _premiumBps);", "uint256 base = charge;"),
    (A, "refund lost", "balanceOf[account] += refund;", ""),
    (A, "charge booked for nobody", "pendingRecipient += base;", ""),
    # ---------------------------------------------------------------- paymaster: balances, flush, owner (PA-5, PA-6)
    (A, "deposit not balance checked", "if (IOrryToken(orry).balanceOf(address(this)) - before != amount) revert InexactTransfer();\n        balanceOf[account] += amount;", "balanceOf[account] += amount;"),
    (A, "withdraw from the recipient's balance", "uint256 bal = balanceOf[msg.sender];\n        if (bal < amount) revert InsufficientBalance();\n        balanceOf[msg.sender] = bal - amount;", "uint256 bal = balanceOf[to];\n        if (bal < amount) revert InsufficientBalance();\n        balanceOf[to] = bal - amount;"),
    (A, "withdraw keeps the balance", "balanceOf[msg.sender] = bal - amount;", ""),
    (A, "flush pays twice", "pendingRecipient = 0;\n        pendingBurn = 0;", "pendingBurn = 0;"),
    (A, "flush burns nothing", "IOrryToken(orry).burn(burned);", ""),
    (A, "flush burn not supply checked", "if (supply - IOrryToken(orry).totalSupply() != burned) revert InexactTransfer();\n            emit Burned", "emit Burned"),
    (A, "flush burn source wrong", "uint8 private constant BURN_PAYMASTER_PREMIUM = 33;", "uint8 private constant BURN_PAYMASTER_PREMIUM = 32;"),
    (A, "anyone withdraws the ETH", "function withdrawEth(address payable to, uint256 amount) external onlyOwner {", "function withdrawEth(address payable to, uint256 amount) external {"),
    (A, "anyone stakes", "function addStake(uint32 unstakeDelaySec) external payable onlyOwner {", "function addStake(uint32 unstakeDelaySec) external payable {"),
    (A, "anyone accepts ownership", "if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();", ""),
    (A, "stale ETH price accepted", "if (block.timestamp - updatedAt > _maxEthStaleness) return (false, 0);", ""),
    (A, "future ETH round accepted", "if (a <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0);", "if (a <= 0 || updatedAt == 0) return (false, 0);"),
    (A, "non-positive ETH price accepted", "if (a <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0);", "if (updatedAt == 0 || updatedAt > block.timestamp) return (false, 0);"),
    (A, "premium cap off", "p.premiumBps > MAX_PREMIUM_BPS ||", "p.premiumBps > MAX_PREMIUM_BPS + 1 ||"),
    # ---------------------------------------------------------------- shield (SH-1 to SH-5), real proofs
    (S, "account registered twice", "if (_accounts[msg.sender].npk != 0) revert AlreadyRegistered();", ""),
    (S, "zero note key accepted", "if (npk == 0 || npk >= FIELD_SIZE) revert BadKey();", "if (npk >= FIELD_SIZE) revert BadKey();"),
    (S, "note key above the field accepted", "if (npk == 0 || npk >= FIELD_SIZE) revert BadKey();", "if (npk == 0) revert BadKey();"),
    (S, "view key prefix unchecked", "if (viewKey.length != 33 || (viewKey[0] != 0x02 && viewKey[0] != 0x03)) revert BadKey();", "if (viewKey.length != 33) revert BadKey();"),
    (S, "zero deposit accepted", "if (amount == 0 || amount > type(uint128).max) revert BadAmount();", "if (amount > type(uint128).max) revert BadAmount();"),
    (S, "oversized deposit accepted", "if (amount == 0 || amount > type(uint128).max) revert BadAmount();", "if (amount == 0) revert BadAmount();"),
    (S, "zero secret accepted", "if (secretCommit == 0 || secretCommit >= FIELD_SIZE) revert NotField();", "if (secretCommit >= FIELD_SIZE) revert NotField();"),
    (S, "secret above the field accepted", "if (secretCommit == 0 || secretCommit >= FIELD_SIZE) revert NotField();", "if (secretCommit == 0) revert NotField();"),
    (S, "deposit note one byte longer", "if (encryptedNote.length > MAX_NOTE_BYTES) revert NoteTooLarge();", "if (encryptedNote.length > MAX_NOTE_BYTES + 1) revert NoteTooLarge();"),
    (S, "deposit not balance checked", "if (IShieldToken(asset).balanceOf(address(this)) - before != amount) revert InexactTransfer();", ""),
    (S, "note for the gross amount", "uint256 commitment = noteCommitment(amount - fee, secretCommit);", "uint256 commitment = noteCommitment(amount, secretCommit);"),
    (S, "deposit fee not kept", "accruedFees += fee;", ""),
    (S, "deposit discount ignored", "return FullMath.mulDiv(amount, uint256(depositFeeBps) * (BPS - _discount(depositor)), BPS * BPS);", "return FullMath.mulDiv(amount, uint256(depositFeeBps) * BPS, BPS * BPS);"),
    (S, "withdrawal discount ignored", "return FullMath.mulDiv(amount, uint256(withdrawFeeBps) * (BPS - _discount(to)), BPS * BPS);", "return FullMath.mulDiv(amount, uint256(withdrawFeeBps) * BPS, BPS * BPS);"),
    (S, "deposit fee rounds up", "return FullMath.mulDiv(amount, uint256(depositFeeBps) * (BPS - _discount(depositor)), BPS * BPS);", "return FullMath.mulDivRoundingUp(amount, uint256(depositFeeBps) * (BPS - _discount(depositor)), BPS * BPS);"),
    (S, "tiers read fails open", "} catch {\n            return 0;\n        }\n    }\n\n    function _pay", "} catch {\n            return BPS;\n        }\n    }\n\n    function _pay"),
    (S, "other asset accepted", "if (args.asset != asset) revert WrongAsset();", ""),
    (S, "send with a protocol fee accepted", "if (args.withdrawAmount != 0 || args.withdrawTo != address(0) || args.protocolFee != 0) {", "if (args.withdrawAmount != 0 || args.withdrawTo != address(0)) {"),
    (S, "withdrawal to nobody accepted", "if (args.withdrawTo == address(0) || args.withdrawAmount == 0) revert BadWithdraw();", "if (args.withdrawAmount == 0) revert BadWithdraw();"),
    (S, "protocol fee floor ignored", "if (args.protocolFee < withdrawFeeFloor(args.withdrawTo, args.withdrawAmount)) revert FeeTooLow();", ""),
    (S, "unknown kind accepted", "} else {\n            revert BadKind();\n        }", "}"),
    (S, "unknown root accepted", "if (!knownRoots[args.root]) revert UnknownRoot();", ""),
    (S, "output note one byte longer", "if (ext.encryptedOutput0.length > MAX_NOTE_BYTES || ext.encryptedOutput1.length > MAX_NOTE_BYTES) {", "if (ext.encryptedOutput0.length > MAX_NOTE_BYTES + 1 || ext.encryptedOutput1.length > MAX_NOTE_BYTES) {"),
    (S, "spent nullifier accepted", "if (nullifierSpent[args.nullifiers[i]]) revert NullifierSpent();", ""),
    (S, "output above the field accepted", "if (args.outCommitments[i] >= FIELD_SIZE) revert NotField();", ""),
    (S, "used intent accepted", "if (intentUsed[args.intentNullifier]) revert IntentUsed();", ""),
    (S, "verifier rejection swallowed", "} catch {\n            revert InvalidProof();\n        }", "} catch {}"),
    (S, "verifier false accepted", "if (!ok) revert InvalidProof();", ""),
    (S, "nullifier not marked", "nullifierSpent[args.nullifiers[i]] = true;", ""),
    (S, "intent not marked", "intentUsed[args.intentNullifier] = true;", ""),
    (S, "omitted output inserted", "if (args.outCommitments[0] != 0) {", "if (true) {"),
    (S, "protocol fee not kept", "accruedFees += args.protocolFee;", ""),
    (S, "relayer fee to the caller", "address relayer = ext.relayer == address(0) ? msg.sender : ext.relayer;", "address relayer = msg.sender;"),
    (S, "withdrawal paid to the relayer", "if (args.withdrawAmount != 0) _pay(args.withdrawTo, args.withdrawAmount);", "if (args.withdrawAmount != 0) _pay(relayer, args.withdrawAmount);"),
    (S, "flush pays twice", "accruedFees = 0;\n        _pay(treasury, amount);", "_pay(treasury, amount);"),
    (S, "domain halves swapped", "p[12] = bytes32(_domainHi);\n        p[13] = bytes32(_domainLo);", "p[12] = bytes32(_domainLo);\n        p[13] = bytes32(_domainHi);"),
    (S, "external data not bound", "try IHonkVerifier(verifier).verify(args.proof, _publicInputs(args, extDataHash(ext))) returns (bool ok) {", "try IHonkVerifier(verifier).verify(args.proof, _publicInputs(args, 0)) returns (bool ok) {"),
    (S, "left subtree not kept", "_filledSubtrees[level] = node;\n                node", "node"),
    (S, "another domain name", "keccak256(\"Orrery Shield\")", "keccak256(\"Hushwave\")"),
    (S, "tree full one leaf late", "if (index >= MAX_LEAVES) revert TreeFull();", "if (index > MAX_LEAVES) revert TreeFull();"),
]

originals = {}
results = []
errors = []
only = sys.argv[1] if len(sys.argv) > 1 else None
shard_i, shard_n = (int(x) for x in os.environ.get("MUT_SHARD", "0/1").split("/"))
path_filter = os.environ.get("MUT_PATH", "")
try:
    for idx, (path, name, old, new) in enumerate(MUTATIONS):
        if only and only not in name:
            continue
        if path_filter and path_filter not in path:
            continue
        if idx % shard_n != shard_i:
            continue
        if path not in originals:
            originals[path] = open(path).read()
        src = originals[path]
        assert src.count(old) == 1, f"snippet must occur once for: {name} (found {src.count(old)})"
        open(path, "w").write(src.replace(old, new, 1))
        run = subprocess.run(TEST_ARGS, capture_output=True, text=True)
        out = run.stdout + run.stderr
        failed = sorted(set(re.findall(r"^\[FAIL.*?\]\s+(\w+)\(", out, re.M)))
        compile_error = "Compiler run failed" in out
        open(path, "w").write(src)
        if not failed and not compile_error and "Suite result" not in out:
            # the run itself broke (disk, memory, toolchain): neither caught nor missed
            print(f"{idx:3d} ERROR   {os.path.basename(path)}: {name}: {out.strip().splitlines()[-1:] }", flush=True)
            errors.append(name)
            continue
        results.append((name, failed, compile_error))
        print(f"{idx:3d} " + ("CAUGHT  " if failed or compile_error else "MISSED  ") + f"{os.path.basename(path)}: {name}"
              + (f"  by {', '.join(failed[:3])}" if failed else (" (compile error)" if compile_error else "")), flush=True)
finally:
    for path, src in originals.items():
        open(path, "w").write(src)

caught = sum(1 for _, f, c in results if f or c)
print(f"\n{caught}/{len(results)} mutations caught" + (f", {len(errors)} runs broke: {errors}" if errors else ""))
sys.exit(0 if caught == len(results) and not errors else 1)
