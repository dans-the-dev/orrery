// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {ISpokeHook} from "./interfaces/ISpokeHook.sol";

/// @notice Agent Launch spoke hook (`docs/updates/L5-LAUNCH-SPEC.md` 3, decisions L5-2, L5-4 to L5-6, L5-12).
/// The falling launch fee follows the owner's Hashborn `LaunchFeeHook` (`hashborn-npm/contracts/src/LaunchFeeHook.sol`,
/// MIT, D-60); the fee itself is taken on the ORRY side as a hook fee instead of an LP fee, like Orrery's own
/// `OrreryHook` (H-2), and the identity fair window is replaced by an early window for `AgentLaunch` buys.
/// @dev Permission bits (`0x28CC`): beforeInitialize, beforeAddLiquidity, beforeSwap, afterSwap, beforeSwapReturnDelta,
/// afterSwapReturnDelta. ORRY is currency0 in every spoke, so a buy is zeroForOne and ORRY is the specified side exactly
/// when `zeroForOne == (amountSpecified < 0)`. Nothing here reverts a sell.
contract SpokeHook is ISpokeHook, IHooks {
    using PoolIdLibrary for PoolKey;

    uint24 public constant BASE_FEE = 10_000;
    uint24 public constant MAX_START_FEE = 990_000;
    uint32 public constant MAX_DECAY_WINDOW = 1 hours;
    uint32 public constant MAX_EARLY_WINDOW = 1 days;
    int24 public constant TICK_SPACING = 200;
    uint256 internal constant PIPS = 1_000_000;

    address public immutable poolManager;
    address public immutable orry;
    address public immutable launch;
    uint24 public immutable startFeePips;
    uint32 public immutable decayWindow;
    uint32 public immutable earlyWindow;

    struct Spoke {
        uint64 openedAt;
        uint64 publicOpenAt;
        uint256 fees;
    }

    mapping(PoolId => Spoke) internal _spokes;

    constructor(
        address poolManager_,
        address orry_,
        address launch_,
        uint24 startFeePips_,
        uint32 decayWindow_,
        uint32 earlyWindow_
    ) {
        if (poolManager_ == address(0) || orry_ == address(0) || launch_ == address(0)) revert BadParameters();
        if (startFeePips_ < BASE_FEE || startFeePips_ > MAX_START_FEE) revert BadParameters();
        if (decayWindow_ == 0 || decayWindow_ > MAX_DECAY_WINDOW || earlyWindow_ > MAX_EARLY_WINDOW) {
            revert BadParameters();
        }
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: true,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: true,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
        poolManager = poolManager_;
        orry = orry_;
        launch = launch_;
        startFeePips = startFeePips_;
        decayWindow = decayWindow_;
        earlyWindow = earlyWindow_;
    }

    modifier onlyPoolManager() {
        if (msg.sender != poolManager) revert NotPoolManager();
        _;
    }

    // ---------------------------------------------------------------- views

    function openedAt(PoolId poolId) external view returns (uint64) {
        return _spokes[poolId].openedAt;
    }

    function publicOpenAt(PoolId poolId) external view returns (uint64) {
        return _spokes[poolId].publicOpenAt;
    }

    function feesOf(PoolId poolId) external view returns (uint256) {
        return _spokes[poolId].fees;
    }

    function isEarly(PoolId poolId) external view returns (bool) {
        Spoke storage s = _spokes[poolId];
        return s.openedAt != 0 && block.timestamp < s.publicOpenAt;
    }

    /// @dev `startFeePips` at `publicOpenAt` (and before it), falling linearly to BASE_FEE at `publicOpenAt + decayWindow`.
    function feeAt(PoolId poolId, uint256 timestamp) public view returns (uint24) {
        uint256 open = _spokes[poolId].publicOpenAt;
        if (open == 0) return BASE_FEE;
        uint256 elapsed = timestamp > open ? timestamp - open : 0;
        if (elapsed >= decayWindow) return BASE_FEE;
        return uint24(BASE_FEE + (uint256(startFeePips - BASE_FEE) * (decayWindow - elapsed)) / decayWindow);
    }

    // ---------------------------------------------------------------- hook callbacks

    /// @dev Only `launch` opens a spoke, and only with the spoke key shape (L5-2).
    function beforeInitialize(address sender, PoolKey calldata key, uint160) external onlyPoolManager returns (bytes4) {
        if (sender != launch) revert NotLaunch();
        if (
            Currency.unwrap(key.currency0) != orry || key.fee != 0 || key.tickSpacing != TICK_SPACING
                || address(key.hooks) != address(this)
        ) revert WrongPoolKey();
        PoolId id = key.toId();
        uint64 nowTs = uint64(block.timestamp);
        uint64 open = nowTs + earlyWindow;
        _spokes[id].openedAt = nowTs;
        _spokes[id].publicOpenAt = open;
        emit SpokeOpened(id, nowTs, open);
        return IHooks.beforeInitialize.selector;
    }

    /// @dev The launch position is the only liquidity a spoke ever has (L5-12).
    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != launch) revert NotLaunch();
        return IHooks.beforeAddLiquidity.selector;
    }

    /// @dev Early window check for buys; the fee when ORRY is the specified side (buy exact in, sell exact out).
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        if (params.zeroForOne && sender != launch) {
            uint64 open = _spokes[id].publicOpenAt;
            if (block.timestamp < open) revert EarlyAccessOnly(open);
        }
        if ((params.amountSpecified < 0) != params.zeroForOne) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        uint256 amount =
            params.amountSpecified < 0 ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        uint256 fee = _take(id, amount, _pips(id, sender, params.zeroForOne));
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    /// @dev The fee when ORRY is the unspecified side (buy exact out, sell exact in), on the pool's ORRY amount.
    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        if ((params.amountSpecified < 0) == params.zeroForOne) return (IHooks.afterSwap.selector, 0);
        PoolId id = key.toId();
        int128 r = delta.amount0();
        uint256 amount = r < 0 ? uint256(-int256(r)) : uint256(int256(r));
        uint256 fee = _take(id, amount, _pips(id, sender, params.zeroForOne));
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    // ---------------------------------------------------------------- unused callbacks

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    // ---------------------------------------------------------------- internals

    /// @dev A public buy pays the launch fee of this second; `launch`'s own swaps and every sell pay BASE_FEE.
    function _pips(PoolId id, address sender, bool buy) private view returns (uint24) {
        return buy && sender != launch ? feeAt(id, block.timestamp) : BASE_FEE;
    }

    /// @dev Mints `floor(amount * pips / 1e6)` ORRY claims to `launch`; the returned delta charges the swapper.
    function _take(PoolId id, uint256 amount, uint24 pips) private returns (uint256 fee) {
        fee = amount * pips / PIPS;
        if (fee == 0) return 0;
        IPoolManager(poolManager).mint(launch, uint256(uint160(orry)), fee);
        _spokes[id].fees += fee;
        emit SpokeFee(id, fee, pips);
    }
}
