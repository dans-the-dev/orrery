// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {IAgentLaunch} from "./interfaces/IAgentLaunch.sol";

/// @notice Buys and sells launched coins against ORRY in their spoke pool for the Orrery web pages
/// (`docs/updates/L5-LAUNCH-SPEC.md` L5-15). Exact input only, with the caller's minimum output and deadline. The input
/// moves from the caller straight into the PoolManager and the output straight to the caller, so the router never holds a
/// token. It is an ordinary public caller to `SpokeHook`: it pays the public fee and is refused in the early window like
/// any other router. No owner, no state.
contract SpokeRouter is IUnlockCallback {
    address public immutable poolManager;
    address public immutable orry;
    IAgentLaunch public immutable launch;

    event Traded(address indexed coin, address indexed account, bool buy, uint256 amountIn, uint256 amountOut);

    error NotPoolManager();
    error UnknownCoin();
    error ZeroAmount();
    error DeadlinePassed();
    error SlippageExceeded(uint256 out, uint256 minOut);
    error NotFilled();
    error TransferFailed();

    constructor(address launch_) {
        launch = IAgentLaunch(launch_);
        poolManager = IAgentLaunch(launch_).poolManager();
        orry = IAgentLaunch(launch_).orry();
    }

    /// @notice Pays exactly `orryIn` ORRY (approve this router first) for at least `minCoinsOut` coins.
    function buy(address coin, uint256 orryIn, uint256 minCoinsOut, uint256 deadline) external returns (uint256 out) {
        out = _trade(coin, true, orryIn, minCoinsOut, deadline);
    }

    /// @notice Sells exactly `coinsIn` coins (approve this router first) for at least `minOrryOut` ORRY.
    function sell(address coin, uint256 coinsIn, uint256 minOrryOut, uint256 deadline) external returns (uint256 out) {
        out = _trade(coin, false, coinsIn, minOrryOut, deadline);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != poolManager) revert NotPoolManager();
        (address coin, bool isBuy, uint256 amountIn, address account) = abi.decode(data, (address, bool, uint256, address));
        IPoolManager pm = IPoolManager(poolManager);
        PoolKey memory key = launch.poolKeyOf(coin);
        BalanceDelta d = pm.swap(
            key,
            SwapParams({
                zeroForOne: isBuy,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: isBuy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 paid, int128 got) = isBuy ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        if (uint256(-int256(paid)) != amountIn) revert NotFilled();
        (address tokenIn, address tokenOut) = isBuy ? (orry, coin) : (coin, orry);
        pm.sync(Currency.wrap(tokenIn));
        _transferFrom(tokenIn, account, poolManager, amountIn);
        pm.settle();
        uint256 out = uint256(int256(got));
        pm.take(Currency.wrap(tokenOut), account, out);
        return abi.encode(out);
    }

    function _trade(address coin, bool isBuy, uint256 amountIn, uint256 minOut, uint256 deadline)
        private
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (amountIn == 0) revert ZeroAmount();
        if (launch.launchOf(coin).creator == address(0)) revert UnknownCoin();
        out = abi.decode(IPoolManager(poolManager).unlock(abi.encode(coin, isBuy, amountIn, msg.sender)), (uint256));
        if (out < minOut) revert SlippageExceeded(out, minOut);
        emit Traded(coin, msg.sender, isBuy, amountIn, out);
    }

    function _transferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
