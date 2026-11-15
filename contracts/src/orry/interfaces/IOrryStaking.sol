// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice ORRY staking (`docs/ORRY-BUILD-SPEC.md` 3.3). Two kinds of positions, both earning for their staker:
/// a plain stake per address, and a stake behind an ERC-8004 agentId that Orrery checks report. Rewards are ETH and
/// ORRY paid in by anyone (in practice the rewards router), streamed over `STREAM_PERIOD` pro rata to active stake.
/// Requesting an unstake stops earning at once; the amount stays locked until its cooldown ends. No owner, no pause.
interface IOrryStaking {
    struct AgentPosition {
        address staker; // who staked it and receives it back
        uint128 active; // earning and locked; can only start leaving through requestAgentUnstake
        uint128 leaving; // not earning, still locked until leavingAt
        uint64 leavingAt; // 0 when nothing is leaving
        uint64 lockedUntil; // set only by the staker through extendAgentLock; no unstake request before it (T3 launch gate)
    }

    event Staked(address indexed account, uint256 amount);
    event UnstakeRequested(address indexed account, uint256 amount, uint64 readyAt);
    event Withdrawn(address indexed account, uint256 amount);
    event AgentStaked(uint256 indexed agentId, address indexed owner, address indexed staker, uint256 amount);
    event AgentUnstakeRequested(uint256 indexed agentId, address indexed owner, uint256 amount, uint64 readyAt);
    event AgentWithdrawn(uint256 indexed agentId, address indexed owner, address indexed staker, uint256 amount);
    event AgentLockExtended(uint256 indexed agentId, address indexed owner, uint64 lockedUntil);
    event RewardsNotified(address indexed from, uint256 ethAmount, uint256 orryAmount, uint64 periodFinish);
    event RewardsClaimed(address indexed account, address indexed caller, uint256 ethAmount, uint256 orryAmount);

    error ZeroAmount();
    error NotAgentController();
    error NotStaker();
    error PositionHeldByAnotherStaker();
    error InsufficientActive();
    error NothingReady();
    error InexactTransfer();
    error EthTransferFailed();
    error AgentStakeLocked(uint64 lockedUntil);
    error LockNotExtended();
    error LockTooLong();
    error ZeroAddress();

    function PLAIN_COOLDOWN() external view returns (uint64); // 7 days
    function AGENT_COOLDOWN() external view returns (uint64); // 14 days
    function STREAM_PERIOD() external view returns (uint64); // 7 days
    function MAX_AGENT_LOCK() external view returns (uint64); // 365 days ahead of now

    function orry() external view returns (address);
    function identityRegistry() external view returns (address);

    // plain stake
    function stake(uint256 amount) external;
    function requestUnstake(uint256 amount) external;
    function withdraw() external returns (uint256 amount);

    // stake behind an agent; caller must be ownerOf(agentId) or getAgentWallet(agentId); the position is keyed by
    // (agentId, ownerOf(agentId) at stake time), so it stops being reported for the agent if the identity moves
    function stakeForAgent(uint256 agentId, uint256 amount) external;
    function requestAgentUnstake(uint256 agentId, address owner, uint256 amount) external;
    function withdrawAgent(uint256 agentId, address owner) external returns (uint256 amount);
    /// @notice Staker of position (agentId, ownerOf(agentId)) only: sets `lockedUntil` later than it is now and at most
    /// MAX_AGENT_LOCK ahead. While now < lockedUntil, requestAgentUnstake reverts `AgentStakeLocked`. The second update's
    /// Agent Launch reads it as its "stake locked 90 days" gate (T3); nothing else in this build uses it.
    function extendAgentLock(uint256 agentId, uint64 lockedUntil) external;

    // rewards
    /// @notice Anyone adds rewards: `msg.value` ETH and `orryAmount` ORRY (transferFrom, balance-delta checked).
    /// Restarts the stream: rate = (scheduled remainder + unstreamed + new) / STREAM_PERIOD for each asset.
    function notifyRewards(uint256 orryAmount) external payable;
    function claimRewards() external returns (uint256 ethAmount, uint256 orryAmount);
    /// @notice Anyone: pays `account`'s rewards to `account` and nowhere else.
    function claimFor(address account) external returns (uint256 ethAmount, uint256 orryAmount);

    /// @notice The caller's rewards, paid to `to` (for a staker that cannot take ETH).
    function claimRewardsTo(address to) external returns (uint256 ethAmount, uint256 orryAmount);

    // views
    function earningBalance(address account) external view returns (uint256); // plain active + agent active as staker
    function totalEarning() external view returns (uint256);
    function plainStake(address account) external view returns (uint256 active, uint256 leaving, uint64 readyAt);
    /// @notice The position reported for the agent: the one recorded for the current ownerOf(agentId).
    function agentStake(uint256 agentId) external view returns (AgentPosition memory);
    function agentStakeOf(uint256 agentId, address owner) external view returns (AgentPosition memory);
    function pendingRewards(address account) external view returns (uint256 ethAmount, uint256 orryAmount);
}
