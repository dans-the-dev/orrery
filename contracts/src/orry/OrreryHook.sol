// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IOrreryHook} from "./interfaces/IOrreryHook.sol";
import {IOrreryTreasury} from "./interfaces/IOrreryTreasury.sol";

/// @dev The part of Chainlink's AggregatorV3Interface the pair check reads.
interface IUsdFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title OrreryHook
/// @notice Hook of Orrery's ORRY hub pools (`docs/ORRY-BUILD-SPEC.md` 3.1, R-35 to R-38,
/// `docs/ORRY-PAIRS-A-INTERFACES.md`). One hub per registered quote token: ORRY/ETH and ORRY/USDG from construction,
/// up to MAX_PAIRS in total through `proposePair` and `executePair` by the treasury's owner under a 48 hour delay. Each
/// hub records its price before the first swap of each block and keeps a time-weighted tick (R-28); every hub swap
/// pays `protocolFeePips` of its unspecified side as ERC-6909 claims, which `collect` pays to the rewards router.
/// No owner, no setter, no pause; nothing changes or removes a registered pair.
/// @dev Address bits: afterInitialize | beforeSwap | afterSwap | afterSwapReturnDelta (0x10C4); the deployer mines
/// the address. `block.number` on an Arbitrum chain is the L1 block number, so "block" here spans every L2 block that
/// shares one L1 block number (about 12 seconds on 4663, R-17).
contract OrreryHook is IOrreryHook, IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeERC20 for IERC20;

    uint256 private constant PIPS = 1_000_000;
    /// @dev keccak256("orrery.hook.lock") - 1, transient slot of the reentrancy lock.
    bytes32 private constant LOCK_SLOT = 0x8dcd7ee880ae1af3aa82b473aa0d9b00de2a56b3775316aadff2d118300437e0;

    uint8 public constant MAX_PAIRS = 8;
    uint64 public constant PAIR_DELAY = 48 hours;
    uint64 public constant PAIR_WINDOW = 7 days;
    uint64 public constant FEED_MAX_AGE = 25 hours;

    uint32 public constant OBSERVATION_INTERVAL = 60;
    uint16 public constant OBSERVATION_CARDINALITY = 64;
    /// @dev A full ring spans at least 63 intervals, so any window up to this always finds a checkpoint.
    uint32 public constant MAX_WINDOW = OBSERVATION_INTERVAL * (OBSERVATION_CARDINALITY - 1);

    uint24 public immutable LP_FEE;
    uint24 public immutable protocolFeePips;
    int24 public immutable TICK_SPACING;
    address public immutable poolManager;
    address public immutable orry;
    address public immutable rewardsRouter;
    address public immutable treasury;

    struct StartOfBlock {
        uint160 sqrtPriceX96;
        uint64 blockNumber;
    }

    /// @dev The running observation and the ring bookkeeping in one slot, so the per-second update reads one slot.
    /// `newestTimestamp` repeats `ring[newest].timestamp`.
    struct Latest {
        uint32 timestamp;
        int56 tickCumulative;
        int24 tick;
        uint16 newest;
        uint16 count;
        uint32 newestTimestamp;
    }

    struct Checkpoint {
        uint32 timestamp;
        int56 tickCumulative;
    }

    /// @dev Everything about one hub, keyed by its quote. The first slot packs the registry fields.
    struct Hub {
        address usdFeed;
        bool registered;
        bool orryIs0;
        bool initialized;
        uint64 registeredAt;
        PoolId poolId;
        StartOfBlock start;
        Latest latest;
        Checkpoint[OBSERVATION_CARDINALITY] ring;
    }

    struct Proposal {
        address usdFeed;
        uint64 executableAt;
    }

    struct PoolQuote {
        address quote;
        bool known;
    }

    mapping(address quote => Hub) private _hubs;
    address[] private _quotes;
    mapping(PoolId => PoolQuote) private _poolQuote;
    mapping(address quote => Proposal) private _proposals;

    modifier onlyPoolManager() {
        if (msg.sender != poolManager) revert NotPoolManager();
        _;
    }

    modifier onlyPairAdmin() {
        if (msg.sender != pairAdmin()) revert NotPairAdmin();
        _;
    }

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

    /// @param usdg_ registered as the second launch pair with no feed (Orrery's pricing unit, R-35).
    /// @param ethUsdFeed_ Chainlink ETH/USD on this chain; it must answer, as every later pair's feed must.
    constructor(
        address poolManager_,
        address orry_,
        address rewardsRouter_,
        address treasury_,
        uint24 lpFee_,
        uint24 protocolFeePips_,
        int24 tickSpacing_,
        address usdg_,
        address ethUsdFeed_
    ) {
        require(
            poolManager_ != address(0) && orry_ != address(0) && rewardsRouter_ != address(0)
                && treasury_ != address(0),
            "zero address"
        );
        // v4 caps a static LP fee at 100% and tick spacing at [1, 32767]; the protocol part stays below 10%.
        require(lpFee_ <= PIPS && protocolFeePips_ < 100_000, "fee");
        require(tickSpacing_ > 0, "tick spacing");
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: true,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
        poolManager = poolManager_;
        orry = orry_;
        rewardsRouter = rewardsRouter_;
        treasury = treasury_;
        LP_FEE = lpFee_;
        protocolFeePips = protocolFeePips_;
        TICK_SPACING = tickSpacing_;

        if (!_feedAnswers(ethUsdFeed_)) revert FeedNotAnswering();
        if (usdg_ == orry_ || usdg_.code.length == 0) revert BadQuote();
        _register(address(0), ethUsdFeed_);
        _register(usdg_, address(0));
    }

    // ---------------------------------------------------------------- pairs

    function pairAdmin() public view returns (address) {
        return IOrreryTreasury(treasury).owner();
    }

    function proposePair(address quote, address usdFeed) external onlyPairAdmin {
        if (_hubs[quote].registered) revert PairAlreadyRegistered();
        if (quote == orry || quote.code.length == 0) revert BadQuote();
        if (_quotes.length >= MAX_PAIRS) revert TooManyPairs();
        if (!_feedAnswers(usdFeed)) revert FeedNotAnswering();
        uint64 executableAt = uint64(block.timestamp) + PAIR_DELAY;
        _proposals[quote] = Proposal(usdFeed, executableAt);
        emit PairProposed(quote, usdFeed, executableAt);
    }

    function executePair(address quote) external onlyPairAdmin {
        Proposal memory p = _proposals[quote];
        if (p.executableAt == 0) revert NoPairProposal();
        if (block.timestamp < p.executableAt) revert PairNotReady(p.executableAt);
        if (block.timestamp > uint256(p.executableAt) + PAIR_WINDOW) revert PairProposalExpired();
        if (_quotes.length >= MAX_PAIRS) revert TooManyPairs();
        if (!_feedAnswers(p.usdFeed)) revert FeedNotAnswering();
        delete _proposals[quote];
        _register(quote, p.usdFeed);
    }

    function pendingPair(address quote) external view returns (address usdFeed, uint64 executableAt) {
        Proposal memory p = _proposals[quote];
        return (p.usdFeed, p.executableAt);
    }

    function pairCount() external view returns (uint256) {
        return _quotes.length;
    }

    function pairAt(uint256 index) external view returns (Pair memory) {
        return _pair(_quotes[index]);
    }

    function pairOf(address quote) external view returns (Pair memory) {
        _requirePair(quote);
        return _pair(quote);
    }

    function isPair(address quote) external view returns (bool) {
        return _hubs[quote].registered;
    }

    function hubKey(address quote) external view returns (PoolKey memory) {
        Hub storage h = _requirePair(quote);
        return _key(quote, h.orryIs0);
    }

    function quoteOfPool(PoolId poolId) external view returns (address quote, bool known) {
        PoolQuote memory q = _poolQuote[poolId];
        return (q.quote, q.known);
    }

    // ---------------------------------------------------------------- per-hub views

    function startOfBlockSqrtPriceX96(address quote) external view returns (uint160 sqrtPriceX96, uint64 blockNumber) {
        StartOfBlock memory s = _requirePair(quote).start;
        return (s.sqrtPriceX96, s.blockNumber);
    }

    function latestObservation(address quote)
        external
        view
        returns (uint32 timestamp, int56 tickCumulative, int24 tick)
    {
        Latest memory l = _requirePair(quote).latest;
        return (l.timestamp, l.tickCumulative, l.tick);
    }

    function observation(address quote, uint256 index)
        external
        view
        returns (uint32 timestamp, int56 tickCumulative)
    {
        Checkpoint memory c = _requirePair(quote).ring[index];
        return (c.timestamp, c.tickCumulative);
    }

    function observationIndex(address quote) external view returns (uint16 newest, uint16 count) {
        Latest memory l = _requirePair(quote).latest;
        return (l.newest, l.count);
    }

    /// @notice Mean tick of the `quote` hub, rounded toward negative infinity, since its newest checkpoint at or before
    /// `now - window`; `actualWindow` is the time since that checkpoint (at least `window`). Reverts `UnknownPair`,
    /// `OracleWindowTooLong` for a window of 0 or above `MAX_WINDOW`, and `OracleNotReady` when no checkpoint is old
    /// enough yet (or the hub is not initialized).
    function consult(address quote, uint32 window) external view returns (int24 meanTick, uint32 actualWindow) {
        Hub storage h = _requirePair(quote);
        if (window == 0 || window > MAX_WINDOW) revert OracleWindowTooLong();
        Latest memory l = h.latest;
        uint32 nowTs = uint32(block.timestamp);
        if (l.count == 0 || nowTs < window) revert OracleNotReady();
        uint32 target = nowTs - window;
        uint256 oldest = l.count < OBSERVATION_CARDINALITY ? 0 : (uint256(l.newest) + 1) % OBSERVATION_CARDINALITY;
        if (h.ring[oldest].timestamp > target) revert OracleNotReady();
        // newest checkpoint at or before `target`; positions count from the oldest, timestamps increase with them
        uint256 lo;
        uint256 hi = l.count - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (h.ring[(oldest + mid) % OBSERVATION_CARDINALITY].timestamp <= target) lo = mid;
            else hi = mid - 1;
        }
        Checkpoint memory c = h.ring[(oldest + lo) % OBSERVATION_CARDINALITY];
        // the current tick has held since `l.timestamp`: only a swap moves it, and a swap would have updated `l`
        (, int24 tickNow,,) = IPoolManager(poolManager).getSlot0(h.poolId);
        int56 cumNow = l.tickCumulative + int56(tickNow) * int56(uint56(nowTs - l.timestamp));
        actualWindow = nowTs - c.timestamp;
        int56 delta = cumNow - c.tickCumulative;
        int56 secs = int56(uint56(actualWindow));
        int56 q = delta / secs;
        if (delta < 0 && delta % secs != 0) --q;
        meanTick = int24(q);
    }

    // ---------------------------------------------------------------- fees

    function pendingProtocolFee(address currency) public view returns (uint256) {
        return IPoolManager(poolManager).balanceOf(address(this), uint256(uint160(currency)));
    }

    /// @notice Anyone: pays the claims of ORRY and of every registered quote to `rewardsRouter`. Tokens or ETH that
    /// reached this contract outside the fee path go along with them, so the hook never keeps a balance (H-3). Each
    /// currency is collected on its own: one that cannot move (a paused token, a frozen router) is skipped with
    /// `ProtocolFeeCollectFailed` and the others are still paid (review M-2).
    function collect() external nonReentrant {
        uint256 n = _quotes.length + 1;
        for (uint256 i; i < n; ++i) {
            address c = i == 0 ? orry : _quotes[i - 1];
            try this.collectOne(c) returns (uint256 paid) {
                if (paid != 0) emit ProtocolFeesCollected(c, paid);
            } catch {
                emit ProtocolFeeCollectFailed(c);
            }
        }
    }

    /// @dev Only this contract, from `collect`: one currency's claim through its own unlock, then its stray balance.
    function collectOne(address c) external returns (uint256 paid) {
        if (msg.sender != address(this)) revert NotSelf();
        uint256 claim = pendingProtocolFee(c);
        if (claim != 0) IPoolManager(poolManager).unlock(abi.encode(c, claim));
        uint256 stray = c == address(0) ? address(this).balance : IERC20(c).balanceOf(address(this));
        if (stray != 0) {
            if (c == address(0)) {
                (bool ok,) = rewardsRouter.call{value: stray}("");
                require(ok, "eth");
            } else {
                IERC20(c).safeTransfer(rewardsRouter, stray);
            }
        }
        paid = claim + stray;
    }

    /// @dev Only reachable from this contract's own `unlock` in `collectOne`: the PoolManager calls back its unlocker.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (address c, uint256 claim) = abi.decode(data, (address, uint256));
        IPoolManager pm = IPoolManager(poolManager);
        pm.burn(address(this), uint256(uint160(c)), claim);
        pm.take(Currency.wrap(c), rewardsRouter, claim);
        return "";
    }

    // ---------------------------------------------------------------- hook callbacks

    /// @dev Accepts only a registered pair's key; writes that hub's first observation and checkpoint (cumulative 0 at
    /// the initial tick). The PoolManager itself refuses a second initialization of the same key.
    function afterInitialize(address, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick)
        external
        onlyPoolManager
        returns (bytes4)
    {
        address quote = _quoteOf(key);
        Hub storage h = _hubs[quote];
        if (
            !h.registered || key.fee != LP_FEE || key.tickSpacing != TICK_SPACING
                || address(key.hooks) != address(this)
        ) revert WrongPoolKey();
        h.initialized = true;
        uint32 nowTs = uint32(block.timestamp);
        h.latest = Latest(nowTs, 0, tick, 0, 1, nowTs);
        h.ring[0] = Checkpoint(nowTs, 0);
        emit HubInitialized(quote, h.poolId, sqrtPriceX96);
        return IHooks.afterInitialize.selector;
    }

    /// @dev Reads the hub's slot0 at most once, records its start-of-block price once per block and its observation
    /// once per second. Nothing here can revert a swap (H-4): the oracle arithmetic is unchecked and cannot overflow
    /// (see `_observe`), and the ring index is taken modulo its length. Only registered hubs reach this: any other key
    /// failed `afterInitialize`.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        Hub storage h = _hubs[_quoteOf(key)];
        uint64 bn = uint64(block.number);
        uint32 nowTs = uint32(block.timestamp);
        Latest memory l = h.latest;
        bool newBlock = h.start.blockNumber != bn;
        if (newBlock || l.timestamp != nowTs) {
            (uint160 sqrtPriceX96, int24 tick,,) = IPoolManager(poolManager).getSlot0(key.toId());
            if (newBlock) h.start = StartOfBlock(sqrtPriceX96, bn);
            if (l.timestamp != nowTs) _observe(h, l, nowTs, tick);
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @dev Fee = floor(|unspecified| * protocolFeePips / 1e6) of the unspecified currency, minted to this hook as
    /// claims and charged to the swapper through the returned delta (H-2).
    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        bool specifiedIs0 = (params.amountSpecified < 0) == params.zeroForOne;
        (Currency c, int128 unspecified) =
            specifiedIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        uint256 abs = unspecified < 0 ? uint256(-int256(unspecified)) : uint256(int256(unspecified));
        uint256 fee = abs * protocolFeePips / PIPS;
        if (fee == 0) return (IHooks.afterSwap.selector, 0);
        IPoolManager(poolManager).mint(address(this), uint256(uint160(Currency.unwrap(c))), fee);
        emit ProtocolFeeTaken(key.toId(), Currency.unwrap(c), fee);
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    // ---------------------------------------------------------------- unused callbacks

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
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

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    // ---------------------------------------------------------------- internals

    /// @dev Registers ORRY/`quote`. Callers have checked the cap, the feed and that the pair is new: the constructor
    /// registers two distinct quotes, and `executePair` runs only for a proposal, which exists only for an unregistered
    /// quote and is deleted when executed.
    function _register(address quote, address usdFeed) private {
        Hub storage h = _hubs[quote];
        bool orryIs0 = uint160(orry) < uint160(quote);
        PoolId id = _key(quote, orryIs0).toId();
        h.usdFeed = usdFeed;
        h.registered = true;
        h.orryIs0 = orryIs0;
        h.registeredAt = uint64(block.timestamp);
        h.poolId = id;
        _quotes.push(quote);
        _poolQuote[id] = PoolQuote(quote, true);
        emit PairRegistered(quote, id, usdFeed);
    }

    /// @dev A feed answers when it has code and its latest round is positive and no older than FEED_MAX_AGE.
    function _feedAnswers(address feed) private view returns (bool) {
        if (feed.code.length == 0) return false;
        try IUsdFeed(feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            return answer > 0 && updatedAt != 0 && updatedAt <= block.timestamp
                && block.timestamp - updatedAt <= FEED_MAX_AGE;
        } catch {
            return false;
        }
    }

    /// @dev First swap of a new second in hub `h`. `tick` is the pool tick before this swap, which has held since
    /// `l.timestamp` (only swaps move a hub's tick, and the first swap of every second runs this), so it is the tick
    /// that weights the elapsed seconds. Overflow is unreachable: |tick| <= 887272 < 2^20 and seconds < 2^32 give steps
    /// below 2^52, and the int56 cumulative holds over 1,000 years at the extreme tick; uint32 deltas stay correct
    /// across the 2106 wrap. The ring index wraps modulo its length.
    function _observe(Hub storage h, Latest memory l, uint32 nowTs, int24 tick) private {
        unchecked {
            l.tickCumulative += int56(tick) * int56(uint56(nowTs - l.timestamp));
            l.tick = tick;
            l.timestamp = nowTs;
            if (nowTs - l.newestTimestamp >= OBSERVATION_INTERVAL) {
                uint16 next = (l.newest + 1) % OBSERVATION_CARDINALITY;
                h.ring[next] = Checkpoint(nowTs, l.tickCumulative);
                l.newest = next;
                if (l.count < OBSERVATION_CARDINALITY) ++l.count;
                l.newestTimestamp = nowTs;
            }
        }
        h.latest = l;
    }

    /// @dev The quote of a key holding ORRY; a key without ORRY maps to a quote that is never registered.
    function _quoteOf(PoolKey calldata key) private view returns (address) {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (c0 == orry) return c1;
        if (c1 == orry) return c0;
        return orry; // ORRY is never a registered quote
    }

    function _requirePair(address quote) private view returns (Hub storage h) {
        h = _hubs[quote];
        if (!h.registered) revert UnknownPair();
    }

    function _pair(address quote) private view returns (Pair memory) {
        Hub storage h = _hubs[quote];
        return Pair({
            quote: quote,
            usdFeed: h.usdFeed,
            poolId: h.poolId,
            orryIsCurrency0: h.orryIs0,
            initialized: h.initialized,
            registeredAt: h.registeredAt
        });
    }

    function _key(address quote, bool orryIs0) private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(orryIs0 ? orry : quote),
            currency1: Currency.wrap(orryIs0 ? quote : orry),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }
}
