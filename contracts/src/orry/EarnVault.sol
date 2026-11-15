// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IEarnVault} from "./interfaces/IEarnVault.sol";
import {IOrreryHook} from "./interfaces/IOrreryHook.sol";

/// @title EarnVault
/// @notice Orrery Earn for one hub (`docs/ORRY-BUILD-SPEC.md` 3.2, R-35): one full-range position in the ORRY/`quote`
/// hub pool, owned by this vault in the PoolManager (salt 0). Created by `EarnVaultFactory`, one per hub (P-6). Shares
/// are the liquidity units the vault added for each account, so the share price is fixed and a donation or a first
/// deposit cannot move it. The position's swap fees are harvested into two reward streams (quote, ORRY) that pay
/// shares over `STREAM_PERIOD`. Every mint locks the account's shares, share-weighted, for `DEPOSIT_LOCK`. No owner, no
/// pause, no sweep. Amounts cross the API as (quote, ORRY); inside, the PoolManager's currency order is used.
/// @dev Every token movement runs through `unlockCallback`; the vault settles its net PoolManager delta from its own
/// balance and computes what the caller is owed by arithmetic, never from balances, so tokens sent here outside these
/// paths are never counted (E-6).
contract EarnVault is IEarnVault, IUnlockCallback {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    uint64 public constant DEPOSIT_LOCK = 15 minutes;
    uint64 public constant STREAM_PERIOD = 7 days;
    uint16 public constant MAX_BLOCK_MOVE_BPS = 100;

    uint256 private constant PRECISION = 1e36;
    uint256 private constant BPS = 10_000;
    /// @dev keccak256("orrery.earn.lock") - 1, transient slot of the reentrancy lock.
    bytes32 private constant LOCK_SLOT = 0xbfa5f81b0316ad2e19624337d8b7b34e85f8c9dc7fe5714cb6f27c9c78569aff;

    uint8 private constant HARVEST = 0;
    uint8 private constant DEPOSIT = 1;
    uint8 private constant WITHDRAW = 2;

    address public immutable hook;
    address public immutable orry;
    address public immutable quote;
    bool private immutable _orryIs0;
    IPoolManager private immutable _pm;
    PoolId private immutable _poolId;
    uint24 private immutable _fee;
    int24 private immutable _tickSpacing;
    int24 private immutable _tickLower;
    int24 private immutable _tickUpper;
    uint160 private immutable _sqrtLower;
    uint160 private immutable _sqrtUpper;

    /// @dev One stream per asset (0 = quote, 1 = ORRY). `rate` and `perShare` carry PRECISION.
    struct Stream {
        uint256 rate;
        uint256 perShare;
        uint256 queued; // streamed while no shares existed, restreamed with the next notify
        uint256 harvested; // all fees and notified rewards ever added
        uint256 paid; // all fees ever paid to accounts
        uint64 periodFinish;
        uint64 lastUpdate;
    }

    /// @dev Amounts in the PoolManager's currency order (0, 1).
    struct Op {
        uint8 action;
        uint256 in0; // currency0 the caller brought (already received)
        uint256 in1; // currency1 the caller brought (already received)
        uint256 liquidity; // WITHDRAW: liquidity to remove
        uint256 swapIn; // zap: amount swapped through the hub, 0 for none
        bool zeroForOne; // zap: true sells currency0
        uint256 minSwapOut;
        uint160 minSqrtPriceX96; // deposits: the hub price must be inside these bounds when the deposit enters (M-3)
        uint160 maxSqrtPriceX96;
    }

    struct Result {
        uint256 fees0;
        uint256 fees1;
        uint256 liquidity; // DEPOSIT: liquidity added
        uint256 amount0; // DEPOSIT: currency0 into the position; WITHDRAW: currency0 principal out
        uint256 amount1;
        uint256 refund0; // DEPOSIT: caller's currency0 not used
        uint256 refund1;
    }

    uint256 public totalShares;
    mapping(address => uint256) private _shares;
    mapping(address => uint64) private _unlockAt;

    Stream[2] internal _streams;
    mapping(address => uint256[2]) internal _perSharePaid;
    mapping(address => uint256[2]) internal _owed;

    modifier nonReentrant() {
        bytes32 slot = LOCK_SLOT;
        uint256 locked;
        assembly ("memory-safe") {
            locked := tload(slot)
        }
        require(locked == 0);
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    /// @dev Reverts `UnknownPair` (from the hook) unless `quote_` is a registered pair.
    constructor(address hook_, address quote_) {
        IOrreryHook h = IOrreryHook(hook_);
        IOrreryHook.Pair memory pair = h.pairOf(quote_);
        hook = hook_;
        orry = h.orry();
        quote = quote_;
        _orryIs0 = pair.orryIsCurrency0;
        _pm = IPoolManager(h.poolManager());
        _poolId = pair.poolId;
        _fee = h.LP_FEE();
        _tickSpacing = h.TICK_SPACING();
        _tickLower = TickMath.minUsableTick(_tickSpacing);
        _tickUpper = TickMath.maxUsableTick(_tickSpacing);
        _sqrtLower = TickMath.getSqrtPriceAtTick(_tickLower);
        _sqrtUpper = TickMath.getSqrtPriceAtTick(_tickUpper);
    }

    /// @dev ETH arrives only from the PoolManager (`take`, native quote only); anything else is refused.
    receive() external payable {
        require(msg.sender == address(_pm));
    }

    // ---------------------------------------------------------------- deposits

    /// @dev A zero side gives zero liquidity, which reverts `ZeroAmount` inside the unlock.
    function deposit(
        uint256 quoteMax,
        uint256 orryMax,
        uint256 minShares,
        uint160 minSqrtPriceX96,
        uint160 maxSqrtPriceX96,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 shares) {
        _checkDeadline(deadline);
        if (msg.value != (quote == address(0) ? quoteMax : 0)) revert ValueMismatch();
        _requireHub();
        uint256 quoteIn = quote == address(0) ? msg.value : _pull(quote, quoteMax);
        uint256 orryIn = _pull(orry, orryMax);
        (uint256 in0, uint256 in1) = _toPool(quoteIn, orryIn);
        shares = _deposit(Op(DEPOSIT, in0, in1, 0, 0, false, 0, minSqrtPriceX96, maxSqrtPriceX96), minShares);
    }

    /// @dev `fromQuote` on a native vault takes `msg.value == amountIn`; every other zap takes `msg.value == 0`. An
    /// amount of 0 or 1 swaps nothing and adds zero liquidity, which reverts `ZeroAmount` inside the unlock.
    function zapDeposit(
        bool fromQuote,
        uint256 amountIn,
        uint256 minSwapOut,
        uint256 minShares,
        uint160 minSqrtPriceX96,
        uint160 maxSqrtPriceX96,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 shares) {
        _checkDeadline(deadline);
        bool native = fromQuote && quote == address(0);
        if (msg.value != (native ? amountIn : 0)) revert ValueMismatch();
        _requireHub();
        uint256 received = native ? msg.value : _pull(fromQuote ? quote : orry, amountIn);
        (uint256 in0, uint256 in1) = fromQuote ? _toPool(received, 0) : _toPool(0, received);
        // selling currency0 is zeroForOne; the quote is currency0 exactly when ORRY is not
        bool zeroForOne = fromQuote != _orryIs0;
        shares = _deposit(
            Op(DEPOSIT, in0, in1, 0, received / 2, zeroForOne, minSwapOut, minSqrtPriceX96, maxSqrtPriceX96), minShares
        );
    }

    function _deposit(Op memory op, uint256 minShares) private returns (uint256 shares) {
        Result memory r = _run(op);
        shares = r.liquidity;
        if (shares < minShares) revert SlippageExceeded();
        (uint256 fq, uint256 fr) = _fromPool(r.fees0, r.fees1);
        _notify(fq, fr);
        _updateAccount(msg.sender);
        uint256 held = _shares[msg.sender];
        uint64 until = _lockAfterMint(_unlockAt[msg.sender], held, shares);
        _unlockAt[msg.sender] = until;
        _shares[msg.sender] = held + shares;
        totalShares += shares;
        (uint256 usedQ, uint256 usedR) = _fromPool(r.amount0, r.amount1);
        emit Deposited(msg.sender, usedQ, usedR, shares, until);
        (uint256 refundQ, uint256 refundR) = _fromPool(r.refund0, r.refund1);
        _pay(msg.sender, refundQ, refundR);
    }

    // ---------------------------------------------------------------- withdrawals and fees

    function withdraw(uint256 shares, uint256 minQuoteOut, uint256 minOrryOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 quoteOut, uint256 orryOut)
    {
        _checkDeadline(deadline);
        if (shares == 0) revert ZeroAmount();
        uint256 held = _shares[msg.sender];
        if (shares > held) revert InsufficientShares();
        uint64 until = _unlockAt[msg.sender];
        if (block.timestamp < until) revert SharesLocked(until);

        Result memory r = _run(Op(WITHDRAW, 0, 0, shares, 0, false, 0, 0, 0));
        (quoteOut, orryOut) = _fromPool(r.amount0, r.amount1);
        if (quoteOut < minQuoteOut || orryOut < minOrryOut) revert SlippageExceeded();
        (uint256 fq, uint256 fr) = _fromPool(r.fees0, r.fees1);
        _notify(fq, fr);
        _updateAccount(msg.sender);
        _shares[msg.sender] = held - shares;
        totalShares -= shares;
        (uint256 feeQ, uint256 feeR) = _takeOwed(msg.sender);
        emit Withdrawn(msg.sender, shares, quoteOut, orryOut);
        if (feeQ != 0 || feeR != 0) emit FeesClaimed(msg.sender, msg.sender, feeQ, feeR);
        _pay(msg.sender, quoteOut + feeQ, orryOut + feeR);
    }

    function harvest() external nonReentrant returns (uint256 quoteAmount, uint256 orryAmount) {
        if (totalShares == 0) return (0, 0);
        Result memory r = _run(Op(HARVEST, 0, 0, 0, 0, false, 0, 0, 0));
        (quoteAmount, orryAmount) = _fromPool(r.fees0, r.fees1);
        _notify(quoteAmount, orryAmount);
    }

    /// @notice Anyone: pays ORRY into the ORRY stream, which streams it to shares over STREAM_PERIOD like harvested
    /// fees (B-2, E-7). The amount counted is what arrived (balance delta). With no shares it waits in the stream and
    /// restreams with the next deposit, as fees do.
    function notifyRewards(uint256 orryAmount) external nonReentrant {
        uint256 received = _pull(orry, orryAmount);
        if (received == 0) revert ZeroAmount();
        _updateGlobal();
        _restream(_streams[1], received);
        emit RewardsNotified(msg.sender, received);
    }

    function claimFees() external nonReentrant returns (uint256 quoteAmount, uint256 orryAmount) {
        return _claim(msg.sender);
    }

    function claimFor(address account) external nonReentrant returns (uint256 quoteAmount, uint256 orryAmount) {
        return _claim(account);
    }

    function _claim(address account) private returns (uint256 quoteAmount, uint256 orryAmount) {
        _updateGlobal();
        _updateAccount(account);
        (quoteAmount, orryAmount) = _takeOwed(account);
        if (quoteAmount == 0 && orryAmount == 0) return (0, 0);
        emit FeesClaimed(account, msg.sender, quoteAmount, orryAmount);
        _pay(account, quoteAmount, orryAmount);
    }

    // ---------------------------------------------------------------- views

    function sharesOf(address account) external view returns (uint256) {
        return _shares[account];
    }

    function unlockAt(address account) external view returns (uint64) {
        return _unlockAt[account];
    }

    function pendingFees(address account) external view returns (uint256 quoteAmount, uint256 orryAmount) {
        return (_pendingOf(account, 0), _pendingOf(account, 1));
    }

    function positionAmounts() external view returns (uint256 quoteAmount, uint256 orryAmount) {
        return previewWithdraw(totalShares);
    }

    /// @notice Principal `shares` would withdraw at the current price, rounded down as the PoolManager rounds a
    /// removal; streamed fees come on top.
    function previewWithdraw(uint256 shares) public view returns (uint256 quoteAmount, uint256 orryAmount) {
        (uint160 sqrtPriceX96, int24 tick,,) = _pm.getSlot0(_poolId);
        if (sqrtPriceX96 == 0 || shares == 0) return (0, 0);
        require(shares <= type(uint128).max);
        uint128 liq = uint128(shares);
        uint256 a0;
        uint256 a1;
        if (tick < _tickLower) {
            a0 = SqrtPriceMath.getAmount0Delta(_sqrtLower, _sqrtUpper, liq, false);
        } else if (tick < _tickUpper) {
            a0 = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, _sqrtUpper, liq, false);
            a1 = SqrtPriceMath.getAmount1Delta(_sqrtLower, sqrtPriceX96, liq, false);
        } else {
            a1 = SqrtPriceMath.getAmount1Delta(_sqrtLower, _sqrtUpper, liq, false);
        }
        return _fromPool(a0, a1);
    }

    // ---------------------------------------------------------------- PoolManager

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(_pm));
        Op memory op = abi.decode(data, (Op));
        PoolKey memory key = _key();
        Result memory r;
        if (op.action == WITHDRAW) {
            (BalanceDelta all, BalanceDelta fees) = _pm.modifyLiquidity(key, _params(-int256(op.liquidity)), "");
            r.fees0 = _u(fees.amount0());
            r.fees1 = _u(fees.amount1());
            r.amount0 = _u(all.amount0()) - r.fees0;
            r.amount1 = _u(all.amount1()) - r.fees1;
        } else {
            if (totalShares != 0) {
                (, BalanceDelta fees) = _pm.modifyLiquidity(key, _params(0), "");
                r.fees0 = _u(fees.amount0());
                r.fees1 = _u(fees.amount1());
            }
            if (op.action == DEPOSIT) _addLiquidity(key, op, r);
        }
        _settle(key.currency0);
        _settle(key.currency1);
        return abi.encode(r);
    }

    /// @dev Inside the unlock: optional zap swap behind the same-block guard and `minSwapOut`, then the most liquidity
    /// the amounts allow at the price after the swap. The caller gets back what the position did not take.
    function _addLiquidity(PoolKey memory key, Op memory op, Result memory r) private {
        uint256 a0 = op.in0;
        uint256 a1 = op.in1;
        // The caller's own price bounds, from a reference outside this hub (the web uses the Pons pool and the
        // Chainlink feed): an empty or thin hub moved for free before a deposit makes it revert instead of losing
        // value to the move (review M-3).
        (uint160 entryPrice,,,) = _pm.getSlot0(_poolId);
        if (entryPrice < op.minSqrtPriceX96 || entryPrice > op.maxSqrtPriceX96) revert PriceOutOfBounds();
        if (op.swapIn != 0) {
            _checkBlockMove();
            BalanceDelta d = _pm.swap(
                key,
                SwapParams({
                    zeroForOne: op.zeroForOne,
                    amountSpecified: -int256(op.swapIn),
                    sqrtPriceLimitX96: op.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            uint256 out;
            if (op.zeroForOne) {
                a0 -= _u(-d.amount0());
                out = _u(d.amount1());
                a1 += out;
            } else {
                a1 -= _u(-d.amount1());
                out = _u(d.amount0());
                a0 += out;
            }
            if (out < op.minSwapOut) revert SlippageExceeded();
        }
        (uint160 sqrtPriceX96,,,) = _pm.getSlot0(_poolId);
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, _sqrtLower, _sqrtUpper, a0, a1);
        if (liq == 0) revert ZeroAmount();
        // The add also collects every fee the position earned since the poke above, including the LP fee of this
        // zap's own swap; it belongs to the existing shareholders (review M-1), so it joins `fees` and the principal is
        // the caller delta without it.
        (BalanceDelta added, BalanceDelta addFees) = _pm.modifyLiquidity(key, _params(int256(uint256(liq))), "");
        r.fees0 += _u(addFees.amount0());
        r.fees1 += _u(addFees.amount1());
        r.liquidity = liq;
        r.amount0 = _u(addFees.amount0() - added.amount0());
        r.amount1 = _u(addFees.amount1() - added.amount1());
        r.refund0 = a0 - r.amount0;
        r.refund1 = a1 - r.amount1;
    }

    /// @dev Pays a negative net delta from the vault's balance, takes a positive one to the vault.
    function _settle(Currency c) private {
        int256 d = _pm.currencyDelta(address(this), c);
        if (d > 0) {
            _pm.take(c, address(this), uint256(d));
        } else if (d < 0) {
            uint256 owed = uint256(-d);
            if (Currency.unwrap(c) == address(0)) {
                _pm.settle{value: owed}();
            } else {
                _pm.sync(c);
                IERC20(Currency.unwrap(c)).safeTransfer(address(_pm), owed);
                _pm.settle();
            }
        }
    }

    function _checkBlockMove() private view {
        (uint160 start, uint64 bn) = IOrreryHook(hook).startOfBlockSqrtPriceX96(quote);
        if (bn != uint64(block.number)) return;
        (uint160 live,,,) = _pm.getSlot0(_poolId);
        if (_movedTooFar(live, start)) revert PriceMovedInBlock();
    }

    /// @dev Price is the square of the sqrt price: compares (live / start)^2 with 1 +- MAX_BLOCK_MOVE_BPS / 10_000.
    function _movedTooFar(uint160 live, uint160 start) private pure returns (bool) {
        if (uint256(live) >= 2 * uint256(start) || 2 * uint256(live) <= uint256(start)) return true;
        uint256 scaled = FullMath.mulDiv(live, live, start);
        return scaled * BPS > uint256(start) * (BPS + MAX_BLOCK_MOVE_BPS)
            || scaled * BPS < uint256(start) * (BPS - MAX_BLOCK_MOVE_BPS);
    }

    function _run(Op memory op) private returns (Result memory) {
        return abi.decode(_pm.unlock(abi.encode(op)), (Result));
    }

    // ---------------------------------------------------------------- reward streams

    function _updateGlobal() private {
        uint256 supply = totalShares;
        for (uint256 i; i < 2; ++i) {
            Stream storage s = _streams[i];
            uint256 t = block.timestamp < s.periodFinish ? block.timestamp : s.periodFinish;
            uint256 last = s.lastUpdate;
            if (t > last) {
                uint256 emitted = s.rate * (t - last);
                if (supply != 0) s.perShare += emitted / supply;
                else s.queued += emitted / PRECISION;
                s.lastUpdate = uint64(t);
            }
        }
    }

    function _updateAccount(address account) private {
        uint256 sh = _shares[account];
        for (uint256 i; i < 2; ++i) {
            uint256 ps = _streams[i].perShare;
            if (sh != 0) _owed[account][i] += FullMath.mulDiv(sh, ps - _perSharePaid[account][i], PRECISION);
            _perSharePaid[account][i] = ps;
        }
    }

    /// @dev New fees, plus anything queued while no shares existed, plus the unstreamed remainder of the running
    /// period, stream again over a fresh STREAM_PERIOD.
    function _notify(uint256 feesQuote, uint256 feesOrry) private {
        _updateGlobal();
        if (feesQuote != 0 || feesOrry != 0) {
            emit FeesHarvested(feesQuote, feesOrry, uint64(block.timestamp) + STREAM_PERIOD);
        }
        _restream(_streams[0], feesQuote);
        _restream(_streams[1], feesOrry);
    }

    function _restream(Stream storage s, uint256 fees) private {
        s.harvested += fees;
        uint256 fresh = fees + s.queued;
        if (fresh == 0) return;
        uint256 left = block.timestamp < s.periodFinish ? s.rate * (s.periodFinish - block.timestamp) : 0;
        s.queued = 0;
        s.rate = (left + fresh * PRECISION) / STREAM_PERIOD;
        s.periodFinish = uint64(block.timestamp) + STREAM_PERIOD;
        s.lastUpdate = uint64(block.timestamp);
    }

    function _takeOwed(address account) private returns (uint256 quoteAmount, uint256 orryAmount) {
        quoteAmount = _owed[account][0];
        orryAmount = _owed[account][1];
        if (quoteAmount != 0) {
            _owed[account][0] = 0;
            _streams[0].paid += quoteAmount;
        }
        if (orryAmount != 0) {
            _owed[account][1] = 0;
            _streams[1].paid += orryAmount;
        }
    }

    function _pendingOf(address account, uint256 i) private view returns (uint256) {
        Stream storage s = _streams[i];
        uint256 ps = s.perShare;
        uint256 t = block.timestamp < s.periodFinish ? block.timestamp : s.periodFinish;
        if (t > s.lastUpdate && totalShares != 0) ps += s.rate * (t - s.lastUpdate) / totalShares;
        return _owed[account][i] + FullMath.mulDiv(_shares[account], ps - _perSharePaid[account][i], PRECISION);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev SNOP PlpVault D-05 rule: the new lock is the share-weighted average of the remaining lock on the shares
    /// held and DEPOSIT_LOCK on the new shares, rounded down.
    function _lockAfterMint(uint64 until, uint256 held, uint256 minted) private view returns (uint64) {
        uint256 remaining = until > block.timestamp ? until - block.timestamp : 0;
        uint256 lock = (remaining * held + uint256(DEPOSIT_LOCK) * minted) / (held + minted);
        return uint64(block.timestamp + lock);
    }

    function _pull(address token, uint256 amount) private returns (uint256 received) {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
    }

    /// @dev Pays ORRY first, then the quote (native ETH by call).
    function _pay(address to, uint256 quoteAmount, uint256 orryAmount) private {
        if (orryAmount != 0) IERC20(orry).safeTransfer(to, orryAmount);
        if (quoteAmount == 0) return;
        if (quote == address(0)) {
            (bool ok,) = to.call{value: quoteAmount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(quote).safeTransfer(to, quoteAmount);
        }
    }

    /// @dev (quote, ORRY) to the PoolManager's (currency0, currency1).
    function _toPool(uint256 q, uint256 r) private view returns (uint256, uint256) {
        return _orryIs0 ? (r, q) : (q, r);
    }

    /// @dev (currency0, currency1) to (quote, ORRY).
    function _fromPool(uint256 a0, uint256 a1) private view returns (uint256, uint256) {
        return _orryIs0 ? (a1, a0) : (a0, a1);
    }

    function _checkDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert DeadlinePassed();
    }

    function _requireHub() private view {
        (uint160 sqrtPriceX96,,,) = _pm.getSlot0(_poolId);
        if (sqrtPriceX96 == 0) revert HubNotInitialized();
    }

    function _key() private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(_orryIs0 ? orry : quote),
            currency1: Currency.wrap(_orryIs0 ? quote : orry),
            fee: _fee,
            tickSpacing: _tickSpacing,
            hooks: IHooks(hook)
        });
    }

    function _params(int256 liquidityDelta) private view returns (ModifyLiquidityParams memory) {
        return ModifyLiquidityParams({
            tickLower: _tickLower,
            tickUpper: _tickUpper,
            liquidityDelta: liquidityDelta,
            salt: bytes32(0)
        });
    }

    function _u(int128 x) private pure returns (uint256) {
        return uint256(uint128(x));
    }
}
