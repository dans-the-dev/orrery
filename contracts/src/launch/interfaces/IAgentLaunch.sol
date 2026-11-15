// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @notice Agent Launch (`docs/updates/L5-LAUNCH-SPEC.md` 4, R-13, T3 to T6, utility 5). A Orrery-verified ERC-8004 agent
/// launches one coin: fixed supply, the whole supply in one Uniswap v4 position paired with ORRY on `SpokeHook`, held by
/// this contract forever. Stakers buy first in the early window, each up to an allowance weighted by the USD value of their
/// ORRY stake. The 1% spoke fee (ORRY) is split by anyone: 50% for the agent's policy-bound account, 20% streamed to Earn
/// LPs, 15% to the owner, 15% burned. No owner, no pause, no setter.
interface IAgentLaunch {
    struct Params {
        int24 startTick; // pool opening tick, coins per ORRY (25_000, guess)
        uint16 maxFirstBuyBps; // creator first buy cap, share of supply (500, guess)
        uint128 minStakeUsd; // agent stake to launch, USDG base units (100e6, guess)
        uint16 earlyMaxBps; // early allowance at full weight, share of supply (50, guess)
        uint128 earlyFullUsd; // stake value for the full early allowance (1_000e6, guess)
        uint128 earlyMinUsd; // stake value below which an address cannot buy early (10e6, guess)
    }

    struct Launch {
        uint256 agentId;
        address creator; // the caller of `launch`
        PoolId poolId;
        uint128 liquidity;
        uint64 launchedAt;
    }

    /// @notice The first launch gate that fails (`canLaunch`), in the order `launch` checks them.
    enum Gate {
        Ok,
        NotController,
        AlreadyLaunched,
        NotVerified,
        WalletNotBound,
        PriceNotReady,
        StakeTooLow,
        LockTooShort
    }

    event Launched(
        address indexed coin,
        uint256 indexed agentId,
        address indexed creator,
        PoolId poolId,
        uint128 liquidity,
        uint256 pooled,
        uint256 firstBuyOrry,
        uint256 firstBuyCoins,
        uint64 publicOpenAt,
        string name,
        string symbol
    );
    event EarlyBuy(address indexed coin, address indexed buyer, uint256 orryIn, uint256 coinsOut);
    event FeesDistributed(
        address indexed coin, uint256 total, uint256 creator, uint256 earn, uint256 owner, uint256 burned
    );
    event EarnNotified(uint256 amount);
    event CreatorFeesClaimed(address indexed coin, uint256 indexed agentId, address indexed wallet, uint256 amount);

    error ZeroAddress();
    error BadParameters();
    error Reentrancy();
    error NotPoolManager();
    error NotController();
    error AlreadyLaunched();
    error NotVerified();
    error WalletNotBound();
    error PriceNotReady();
    error StakeTooLow(uint256 stakeUsd, uint256 minUsd);
    error LockTooShort(uint64 lockedUntil, uint64 needed);
    error InvalidName();
    error CoinSortsBelowOrry();
    error FirstBuyTooLarge(uint256 coins, uint256 cap);
    error SlippageExceeded(uint256 coins, uint256 minCoins);
    error NotFilled();
    error InexactTransfer();
    error UnknownCoin();
    error DeadlinePassed();
    error EarlyWindowClosed();
    error ZeroAmount();
    error NotEarlyEligible(uint256 stakeUsd, uint256 minUsd);
    error OverEarlyAllowance(uint256 allowance, uint256 bought, uint256 wanted);
    error CreatorWalletNotBound(address wallet);
    error NothingToClaim();

    function SUPPLY() external view returns (uint256);
    function LOCK_PERIOD() external view returns (uint64); // 90 days (T3)
    function CREATOR_BPS() external view returns (uint16); // 5000 (T6)
    function EARN_BPS() external view returns (uint16); // 2000 (T6)
    function OWNER_BPS() external view returns (uint16); // 1500 (T6); the burn takes the rest
    function EARN_INTERVAL() external view returns (uint64); // 1 hour between Earn notifications
    function BURN_SOURCE() external view returns (uint8); // 50

    function poolManager() external view returns (address);
    function orry() external view returns (address);
    function hook() external view returns (address);
    function identityRegistry() external view returns (address);
    function attestor() external view returns (address);
    function policyModule() external view returns (address);
    function staking() external view returns (address);
    function orryPrice() external view returns (address);
    function earnVault() external view returns (address);
    function treasury() external view returns (address);
    function params() external view returns (Params memory);

    /// @notice Launches the coin of `agentId`. Caller: `ownerOf(agentId)` or `getAgentWallet(agentId)`. Gates: verified,
    /// bound account with the policy module, stake worth `minStakeUsd` locked at least LOCK_PERIOD ahead, no coin yet.
    /// `orryIn` (may be 0) is the caller's first buy, pulled and swapped at 1% before anyone else can trade; it must buy at
    /// least `minCoinOut` and at most `maxFirstBuyBps` of the supply. `salt` with the caller fixes the coin's address, which
    /// must sort above ORRY (`predictCoin`).
    function launch(
        uint256 agentId,
        string calldata name,
        string calldata symbol,
        bytes32 salt,
        uint256 orryIn,
        uint256 minCoinOut
    ) external returns (address coin);

    /// @notice Early access (utility 5): before the pool's `publicOpenAt`, buys `coin` with `orryIn` ORRY at 1% for the
    /// caller, within the caller's stake-weighted allowance.
    function buyEarly(address coin, uint256 orryIn, uint256 minCoinOut, uint256 deadline) external returns (uint256 coinsOut);

    /// @notice Anyone: redeems `coin`'s undistributed fees and splits them (50 creator, 20 Earn, 15 owner, 15 burn).
    function distribute(address coin) external returns (uint256 amount);
    /// @notice Anyone: pays `earnPending` to the Earn vault when EARN_INTERVAL has passed since the last payment.
    function flushEarn() external returns (uint256 amount);
    /// @notice Anyone: distributes, then pays `coin`'s creator share to `getAgentWallet(agentId)` while it has the policy
    /// module installed; reverts otherwise and the share waits.
    function claimCreatorFees(address coin) external returns (uint256 amount);

    // views
    function launchOf(address coin) external view returns (Launch memory);
    function coinOfAgent(uint256 agentId) external view returns (address);
    function launchCount() external view returns (uint256);
    function coins(uint256 from, uint256 count) external view returns (address[] memory);
    function poolKeyOf(address coin) external view returns (PoolKey memory);
    /// @notice Fees the hook took for `coin` that are not distributed yet.
    function pendingFees(address coin) external view returns (uint256);
    function distributedOf(address coin) external view returns (uint256);
    function creatorOwed(address coin) external view returns (uint256);
    function earnPending() external view returns (uint256);
    function lastEarnAt() external view returns (uint64);
    function earlyBought(address coin, address account) external view returns (uint256);
    /// @notice Coins `account` may still buy early in `coin` now; 0 outside the early window or below `earlyMinUsd`.
    function earlyAllowance(address coin, address account) external view returns (uint256);
    /// @notice The first gate `launch(agentId)` by `caller` would fail now (`Gate.Ok` when none).
    function canLaunch(uint256 agentId, address caller) external view returns (Gate);
    function predictCoin(address caller, bytes32 salt, string calldata name, string calldata symbol)
        external
        view
        returns (address);
    /// @notice Liquidity of every launch position.
    function launchLiquidity() external view returns (uint128);
}
