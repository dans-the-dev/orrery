// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {IOrreryHook} from "../../../../src/orry/interfaces/IOrreryHook.sol";

/// @notice Test-only stand-in for lane A's multi-pair `OrreryHook` (frozen interface, orry/spec d01fb2c), so lane B's
/// router and buyback run against the same views, fees and guard: a registry of ORRY/X hubs keyed by quote (address 0 =
/// native ETH), registered at construction or by `proposePair` and `executePair` after the delay; a start-of-block price
/// record per hub in `beforeSwap`; the protocol fee of the unspecified side taken as ERC-6909 claims in `afterSwap` with
/// `afterSwapReturnDelta`; `collect` pays every currency's claims to the router. The oracle views are stubs (consult
/// reverts OracleNotReady); lane B's contracts do not read them. Deploy with `deployCodeTo` at an address carrying
/// exactly `FLAGS`. Feeds are not checked here (lane A's hook checks them).
contract TestHubHook is IOrreryHook, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 public constant FLAGS = Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    uint8 public constant MAX_PAIRS = 8;
    uint64 public constant PAIR_DELAY = 48 hours;
    uint64 public constant PAIR_WINDOW = 7 days;
    uint64 public constant FEED_MAX_AGE = 25 hours;
    uint32 public constant OBSERVATION_INTERVAL = 60;
    uint16 public constant OBSERVATION_CARDINALITY = 64;
    uint32 public constant MAX_WINDOW = 3780;

    uint24 public immutable LP_FEE;
    uint24 public immutable protocolFeePips;
    int24 public immutable TICK_SPACING;
    address public immutable poolManager;
    address public immutable orry;
    address public immutable rewardsRouter;
    address public immutable treasury;
    address internal immutable _admin;

    address[] internal _quotes;
    mapping(address quote => Pair) internal _pair;
    mapping(PoolId => address) internal _quoteOfPool;
    mapping(address quote => uint160) internal _startSqrtP;
    mapping(address quote => uint64) internal _startBlock;
    mapping(address quote => address) internal _pendingFeed;
    mapping(address quote => uint64) internal _pendingAt;

    constructor(
        address poolManager_,
        address orry_,
        address rewardsRouter_,
        uint24 lpFee,
        uint24 feePips,
        int24 spacing,
        address treasury_,
        address admin_,
        address[] memory launchQuotes
    ) {
        poolManager = poolManager_;
        orry = orry_;
        rewardsRouter = rewardsRouter_;
        LP_FEE = lpFee;
        protocolFeePips = feePips;
        TICK_SPACING = spacing;
        treasury = treasury_;
        _admin = admin_;
        for (uint256 i; i < launchQuotes.length; ++i) {
            _register(launchQuotes[i], address(0));
        }
    }

    modifier onlyManager() {
        if (msg.sender != poolManager) revert NotPoolManager();
        _;
    }

    // ------------------------------------------------------------------ pairs

    function pairAdmin() public view returns (address) {
        return _admin;
    }

    function proposePair(address quote, address usdFeed) external {
        if (msg.sender != _admin) revert NotPairAdmin();
        if (quote == orry || quote.code.length == 0) revert BadQuote();
        if (_pair[quote].registeredAt != 0) revert PairAlreadyRegistered();
        if (_quotes.length >= MAX_PAIRS) revert TooManyPairs();
        _pendingFeed[quote] = usdFeed;
        _pendingAt[quote] = uint64(block.timestamp) + PAIR_DELAY;
        emit PairProposed(quote, usdFeed, _pendingAt[quote]);
    }

    function executePair(address quote) external {
        if (msg.sender != _admin) revert NotPairAdmin();
        uint64 at = _pendingAt[quote];
        if (at == 0) revert NoPairProposal();
        if (block.timestamp < at) revert PairNotReady(at);
        if (block.timestamp > at + PAIR_WINDOW) revert PairProposalExpired();
        if (_quotes.length >= MAX_PAIRS) revert TooManyPairs();
        address feed = _pendingFeed[quote];
        delete _pendingAt[quote];
        delete _pendingFeed[quote];
        _register(quote, feed);
    }

    function pendingPair(address quote) external view returns (address usdFeed, uint64 executableAt) {
        return (_pendingFeed[quote], _pendingAt[quote]);
    }

    function _register(address quote, address feed) internal {
        PoolKey memory key = _keyOf(quote);
        PoolId id = key.toId();
        _pair[quote] = Pair({
            quote: quote,
            usdFeed: feed,
            poolId: id,
            orryIsCurrency0: Currency.unwrap(key.currency0) == orry,
            initialized: false,
            registeredAt: uint64(block.timestamp == 0 ? 1 : block.timestamp)
        });
        _quoteOfPool[id] = quote;
        _quotes.push(quote);
        emit PairRegistered(quote, id, feed);
    }

    function _keyOf(address quote) internal view returns (PoolKey memory key) {
        (address c0, address c1) = quote < orry ? (quote, orry) : (orry, quote);
        key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), LP_FEE, TICK_SPACING, IHooks(address(this)));
    }

    function pairCount() external view returns (uint256) {
        return _quotes.length;
    }

    function pairAt(uint256 index) external view returns (Pair memory) {
        return _pair[_quotes[index]];
    }

    function pairOf(address quote) public view returns (Pair memory p) {
        p = _pair[quote];
        if (p.registeredAt == 0) revert UnknownPair();
    }

    function isPair(address quote) public view returns (bool) {
        return _pair[quote].registeredAt != 0;
    }

    function hubKey(address quote) external view returns (PoolKey memory) {
        if (!isPair(quote)) revert UnknownPair();
        return _keyOf(quote);
    }

    function quoteOfPool(PoolId poolId) external view returns (address quote, bool known) {
        quote = _quoteOfPool[poolId];
        known = isPair(quote) && PoolId.unwrap(_pair[quote].poolId) == PoolId.unwrap(poolId);
    }

    // ------------------------------------------------------------------ per hub

    function startOfBlockSqrtPriceX96(address quote) external view returns (uint160, uint64) {
        return (_startSqrtP[quote], _startBlock[quote]);
    }

    function latestObservation(address) external pure returns (uint32, int56, int24) {
        return (0, 0, 0);
    }

    function observation(address, uint256) external pure returns (uint32, int56) {
        return (0, 0);
    }

    function observationIndex(address) external pure returns (uint16, uint16) {
        return (0, 0);
    }

    function consult(address, uint32) external pure returns (int24, uint32) {
        revert OracleNotReady();
    }

    // ------------------------------------------------------------------ hook callbacks

    function afterInitialize(address, PoolKey calldata key, uint160 sqrtPriceX96, int24)
        external
        onlyManager
        returns (bytes4)
    {
        address quote = _quoteOfPool[key.toId()];
        Pair storage p = _pair[quote];
        if (p.registeredAt == 0 || PoolId.unwrap(p.poolId) != PoolId.unwrap(key.toId())) revert WrongPoolKey();
        p.initialized = true;
        emit HubInitialized(quote, key.toId(), sqrtPriceX96);
        return IHooks.afterInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        onlyManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        address quote = _quoteOfPool[key.toId()];
        if (_startBlock[quote] != block.number) {
            (uint160 sqrtP,,,) = IPoolManager(poolManager).getSlot0(key.toId());
            _startSqrtP[quote] = sqrtP;
            _startBlock[quote] = uint64(block.number);
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyManager
        returns (bytes4, int128)
    {
        bool specifiedIs0 = (params.amountSpecified < 0) == params.zeroForOne;
        (Currency c, int128 amt) = specifiedIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        uint256 abs = amt < 0 ? uint256(uint128(-amt)) : uint256(uint128(amt));
        uint256 fee = abs * protocolFeePips / 1e6;
        if (fee != 0) {
            IPoolManager(poolManager).mint(address(this), c.toId(), fee);
            emit ProtocolFeeTaken(key.toId(), Currency.unwrap(c), fee);
        }
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    // ------------------------------------------------------------------ fees

    function pendingProtocolFee(address currency) public view returns (uint256) {
        return IPoolManager(poolManager).balanceOf(address(this), uint256(uint160(currency)));
    }

    function collect() external {
        IPoolManager(poolManager).unlock("");
    }

    /// @dev Not used by these tests; present for the interface.
    function collectOne(address) external pure returns (uint256) {
        return 0;
    }

    function unlockCallback(bytes calldata) external onlyManager returns (bytes memory) {
        IPoolManager pm = IPoolManager(poolManager);
        _pay(pm, orry);
        for (uint256 i; i < _quotes.length; ++i) {
            _pay(pm, _quotes[i]);
        }
        return "";
    }

    function _pay(IPoolManager pm, address currency) internal {
        uint256 amount = pendingProtocolFee(currency);
        if (amount == 0) return;
        pm.burn(address(this), uint256(uint160(currency)), amount);
        pm.take(Currency.wrap(currency), rewardsRouter, amount);
        emit ProtocolFeesCollected(currency, amount);
    }
}
