// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @notice Uniswap v4 hook of Orrery's ORRY hub pools (`docs/ORRY-BUILD-SPEC.md` 3.1, R-35 to R-38). One hub per
/// registered quote token X: the pool ORRY/X with LP fee `LP_FEE` (static, in the key), tick spacing `TICK_SPACING`,
/// currencies sorted by address (native ETH is address 0, so it is always currency0). ORRY/ETH and ORRY/USDG are
/// registered at construction; the pair admin adds more with `proposePair` and, after `PAIR_DELAY` and within
/// `PAIR_WINDOW`, `executePair`, up to `MAX_PAIRS` in total, each with a Chainlink X/USD feed that answers. Nothing can
/// change or remove a registered pair or its fees. Permissions: afterInitialize, beforeSwap, afterSwap,
/// afterSwapReturnDelta. Every hub keeps its own same-block price record and its own price observations. The hook takes
/// `protocolFeePips` of the unspecified side of every hub swap as ERC-6909 claims; `collect` pays every currency's
/// claims to the rewards router. No owner, no setter, no pause. Holds no ERC-20 and no native balance between calls.
interface IOrreryHook {
    /// @notice A registered pair. `usdFeed` is the Chainlink X/USD aggregator; address 0 only for the construction-time
    /// USDG pair (the unit Orrery prices in). `initialized` turns true when the PoolManager initializes the hub.
    struct Pair {
        address quote;
        address usdFeed;
        PoolId poolId;
        bool orryIsCurrency0;
        bool initialized;
        uint64 registeredAt;
    }

    event PairProposed(address indexed quote, address indexed usdFeed, uint64 executableAt);
    event PairRegistered(address indexed quote, PoolId indexed poolId, address usdFeed);
    event HubInitialized(address indexed quote, PoolId indexed poolId, uint160 sqrtPriceX96);
    event ProtocolFeeTaken(PoolId indexed poolId, address indexed currency, uint256 amount);
    event ProtocolFeesCollected(address indexed currency, uint256 amount);
    event ProtocolFeeCollectFailed(address indexed currency);

    error NotPoolManager();
    error NotSelf();
    error NotPairAdmin();
    error WrongPoolKey();
    error HookNotImplemented();
    error UnknownPair();
    error PairAlreadyRegistered();
    error NoPairProposal();
    error PairNotReady(uint64 executableAt);
    error PairProposalExpired();
    error TooManyPairs();
    error BadQuote();
    error FeedNotAnswering();
    error OracleNotReady();
    error OracleWindowTooLong();

    /// @notice LP fee in pips written in every hub key (8500 = 0.85%).
    function LP_FEE() external view returns (uint24);
    /// @notice Hook fee in pips of the unspecified amount (1500 = 0.15%); LP_FEE + this is about 1.00%.
    function protocolFeePips() external view returns (uint24);
    function TICK_SPACING() external view returns (int24);

    function poolManager() external view returns (address);
    function orry() external view returns (address);
    function rewardsRouter() external view returns (address);

    // ---------------------------------------------------------------- pairs (R-35, R-36)

    function MAX_PAIRS() external view returns (uint8); // 8, the construction-time pairs included
    function PAIR_DELAY() external view returns (uint64); // 48 hours from proposal to the earliest execution
    function PAIR_WINDOW() external view returns (uint64); // 7 days after PAIR_DELAY to execute, then it expires
    function FEED_MAX_AGE() external view returns (uint64); // a feed "answers" when updated within this (25 hours)

    /// @notice The OrreryTreasury given at construction; its current owner is the pair admin.
    function treasury() external view returns (address);
    /// @notice `IOrreryTreasury(treasury).owner()`, read live, so it follows the treasury's two-step ownership transfer.
    function pairAdmin() external view returns (address);

    /// @notice Pair admin: proposes ORRY/`quote` with its Chainlink `quote`/USD feed. Reverts unless `quote` is a
    /// contract other than ORRY, not registered, the pair count is below MAX_PAIRS and the feed answers. A new proposal
    /// for the same quote replaces the old one and restarts the delay.
    function proposePair(address quote, address usdFeed) external;
    /// @notice Pair admin: registers a proposed pair after PAIR_DELAY and before PAIR_DELAY + PAIR_WINDOW; checks the
    /// count and the feed again.
    function executePair(address quote) external;
    /// @notice The open proposal for `quote` (zeros when none).
    function pendingPair(address quote) external view returns (address usdFeed, uint64 executableAt);

    function pairCount() external view returns (uint256);
    /// @notice Registered pairs in registration order (index below pairCount()).
    function pairAt(uint256 index) external view returns (Pair memory);
    /// @notice Reverts UnknownPair when `quote` is not registered.
    function pairOf(address quote) external view returns (Pair memory);
    function isPair(address quote) external view returns (bool);
    /// @notice The hub key of `quote` (reverts UnknownPair).
    function hubKey(address quote) external view returns (PoolKey memory);
    /// @notice The quote of a hub pool; `known` false for any other pool.
    function quoteOfPool(PoolId poolId) external view returns (address quote, bool known);

    // ---------------------------------------------------------------- per hub

    /// @notice Hub price before the first swap of the current block, and that block (0 when no swap happened yet).
    /// Vault zaps and buyback hops compare the live price of that hub against it (same-block guard).
    function startOfBlockSqrtPriceX96(address quote) external view returns (uint160 sqrtPriceX96, uint64 blockNumber);

    // time-weighted price of each hub (R-28, spec 3.1, H-5 to H-8 per hub). Ticks are the hub pool's own ticks
    // (currency1 per currency0); `pairOf(quote).orryIsCurrency0` gives the orientation.
    function OBSERVATION_INTERVAL() external view returns (uint32); // 60 seconds between checkpoints at least
    function OBSERVATION_CARDINALITY() external view returns (uint16); // 64 checkpoints in each hub's ring
    function MAX_WINDOW() external view returns (uint32); // 60 x 63 = 3780 seconds
    function latestObservation(address quote)
        external
        view
        returns (uint32 timestamp, int56 tickCumulative, int24 tick);
    function observation(address quote, uint256 index) external view returns (uint32 timestamp, int56 tickCumulative);
    function observationIndex(address quote) external view returns (uint16 newest, uint16 count);
    /// @notice Mean tick of the `quote` hub since its newest checkpoint at or before now - window; actualWindow >=
    /// window. Reverts UnknownPair, OracleWindowTooLong (0 or above MAX_WINDOW) or OracleNotReady.
    function consult(address quote, uint32 window) external view returns (int24 meanTick, uint32 actualWindow);

    // ---------------------------------------------------------------- fees

    /// @notice Protocol fees in `currency` (a quote or ORRY) held as ERC-6909 claims and not yet collected. ORRY
    /// claims from every hub share one balance.
    function pendingProtocolFee(address currency) external view returns (uint256);

    /// @notice Anyone: redeems the claims of ORRY and of every registered quote and pays them to `rewardsRouter`
    /// (native ETH by call, ERC-20s by PoolManager `take`, no callback); emits one ProtocolFeesCollected per currency
    /// paid.
    function collect() external;

    /// @dev Only the hook itself calls it, from `collect`.
    function collectOne(address currency) external returns (uint256 paid);
}
