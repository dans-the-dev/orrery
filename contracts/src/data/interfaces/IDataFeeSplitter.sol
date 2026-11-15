// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOrryBurnEvents} from "../../orry/interfaces/IOrryToken.sol";

/// @notice Funding side of the Community Reward Pool, as lane L1 froze it in
/// `contracts/src/community/interfaces/IRewardPool.sol` (L1 commit d76cb86): `fund` pulls exactly `amount` with
/// `transferFrom` and books it into the pool's free balance (balance-delta checked). Only the two functions this lane
/// calls are declared here; when L1 merges, this declaration can be replaced by an import of `IRewardPool`.
interface IRewardPoolFunding {
    function orry() external view returns (address);
    function fund(address asset, uint256 amount) external payable;
}

/// @notice Payee of official Orrery Data bought in ORRY (R-50, R-60; `docs/updates/L2-DATA-MCP-SPEC.md` 2.1). Anyone
/// calls `split()`: 70% of the ORRY received since the last split is burned (`Burned(11, amount)`, rounded down) and the
/// rest is booked for the Reward Pool. The pool is proposed by the `OrreryTreasury` owner, executable after 48 hours,
/// and set once; until then the pool's share waits here and nothing else can move it.
interface IDataFeeSplitter is IOrryBurnEvents {
    event Split(uint256 received, uint256 burned, uint256 toPool);
    event PoolFunded(address indexed pool, uint256 amount);
    event PoolProposed(address indexed pool, uint64 executableAt);
    event PoolSet(address indexed pool);

    error ZeroAddress();
    error NothingToSplit();
    error InexactBurn();
    error InexactFunding();
    error NotTreasuryOwner();
    error PoolAlreadySet();
    error WrongPool();
    error NoPoolProposal();
    error PoolNotReady(uint64 executableAt);

    function BURN_BPS() external view returns (uint16);
    function BURN_SOURCE() external view returns (uint8);
    function POOL_DELAY() external view returns (uint64);
    function orry() external view returns (address);
    function treasury() external view returns (address);
    /// @notice The Reward Pool, zero until set.
    function pool() external view returns (address);
    /// @notice ORRY booked for the pool and not sent yet (it waits while the pool is unset).
    function poolOwed() external view returns (uint256);
    function pendingPool() external view returns (address pool_, uint64 executableAt);

    /// @notice Anyone: burns 70% of the ORRY received since the last split and books the rest for the pool; sends
    /// everything booked to the pool once it is set.
    function split() external returns (uint256 burned, uint256 toPool);
    /// @notice What `split()` would do now.
    function previewSplit() external view returns (uint256 received, uint256 burned, uint256 toPool, uint256 owedAfter);

    /// @notice Treasury owner (read live): proposes the Reward Pool; a new proposal replaces a pending one.
    function proposePool(address pool_) external;
    /// @notice Treasury owner: sets the proposed pool after `POOL_DELAY`, for good.
    function executePool() external;
}
