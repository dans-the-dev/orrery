// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @notice Uniswap v4 hook of Agent Launch spoke pools (`docs/updates/L5-LAUNCH-SPEC.md` 3). Every spoke is ORRY
/// (currency0) / agent coin (currency1), LP fee 0, tick spacing 200, opened only by `launch`. The hook takes the swap fee
/// on the ORRY side of every swap (1%; a falling launch fee on public buys right after the public opening), mints it as
/// ERC-6909 ORRY claims straight to `launch` and counts it per pool. Until `publicOpenAt` only `launch` may buy (early
/// access for stakers); sells are never refused. Only `launch` may add liquidity. No owner, no setter, no pause; holds no
/// tokens and no claims.
interface ISpokeHook {
    event SpokeOpened(PoolId indexed poolId, uint64 openedAt, uint64 publicOpenAt);
    event SpokeFee(PoolId indexed poolId, uint256 fee, uint24 pips);

    error NotPoolManager();
    error NotLaunch();
    error WrongPoolKey();
    error EarlyAccessOnly(uint64 publicOpenAt);
    error HookNotImplemented();
    error BadParameters();

    /// @notice 1% in pips: every sell, every `launch` swap, every buy from `publicOpenAt + decayWindow` on.
    function BASE_FEE() external view returns (uint24);
    /// @notice 990,000 pips: the highest `startFeePips` accepted.
    function MAX_START_FEE() external view returns (uint24);
    function TICK_SPACING() external view returns (int24);

    function poolManager() external view returns (address);
    function orry() external view returns (address);
    /// @notice The `AgentLaunch` contract: the only pool opener, the only liquidity provider, the receiver of every fee.
    function launch() external view returns (address);
    /// @notice A public buy's fee at `publicOpenAt`, in pips; falls linearly to BASE_FEE over `decayWindow`.
    function startFeePips() external view returns (uint24);
    function decayWindow() external view returns (uint32);
    /// @notice Seconds from a pool's opening during which only `launch` may buy.
    function earlyWindow() external view returns (uint32);

    function openedAt(PoolId poolId) external view returns (uint64);
    function publicOpenAt(PoolId poolId) external view returns (uint64);
    /// @notice ORRY fees minted to `launch` for this pool so far.
    function feesOf(PoolId poolId) external view returns (uint256);
    /// @notice A public buy's fee in `poolId` at `timestamp`, in pips; BASE_FEE for a pool this hook never opened.
    function feeAt(PoolId poolId, uint256 timestamp) external view returns (uint24);
    /// @notice True while `poolId` is open and inside its early window.
    function isEarly(PoolId poolId) external view returns (bool);
}
