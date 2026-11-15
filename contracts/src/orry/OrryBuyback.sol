// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {ProtocolFeeLibrary} from "v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {IERC20Min} from "../interfaces/IExternal.sol";
import {IOrryBuyback} from "./interfaces/IOrryBuyback.sol";
import {IOrryBurnEvents, IOrryToken} from "./interfaces/IOrryToken.sol";
import {IOrreryHook} from "./interfaces/IOrreryHook.sol";
import {IOrreryTreasury} from "./interfaces/IOrreryTreasury.sol";

/// @title OrryBuyback
/// @notice Bounded buys of ORRY in the Orrery hub pools (`docs/ORRY-BUILD-SPEC.md` 3.6, invariants B-1 to B-3 per hub,
/// R-35 to R-37, `docs/ORRY-PAIRS-B-INTERFACES.md`).
/// `executeSlice` turns treasury USDG into ORRY for the rewards router. When the ORRY/USDG hub is registered,
/// initialized and its cap is at least the ETH path's, one hop in that hub; otherwise hop 1 sells USDG for native ETH on
/// the deepest of an immutable list of hookless ETH/USDG Uniswap v4 pools and hop 2 buys ORRY with that ETH in the ETH
/// hub, both inside one `unlock`. `burnEth` buys ORRY in the ETH hub with the ETH the rewards router sent and burns it
/// (source 4). `buyWithQuote(quote)` buys ORRY in `quote`'s own hub with the `quote` the router forwarded (R-37) and
/// sends it to the router. Hub keys and orientation come from the hook's pair registry, read live, so a pair executed
/// after deployment (R-36) needs no redeployment here.
/// @dev Per hop, measured in the transaction against the pre-trade state, with `fee` the pool's full swap fee in pips
/// (LP fee plus the PoolManager protocol fee of that direction, plus the hook's fee in the hub):
/// - input at most `reserve * fee / 2e6`, where `reserve` is the input side's virtual reserve of the in-range liquidity
///   (`L * sqrtP / 2^96` for currency1, `L * 2^96 / sqrtP` for currency0);
/// - a price limit that stops the swap once sqrtPrice has moved `fee / 2` (relative), and a revert unless the whole
///   input was swapped, so no hop moves its pool's sqrtPrice by more than half its fee (B-2);
/// - `minOut = spot output * (1e6 - fee) / 1e6 * 995 / 1000`.
/// A hub is refused when its price moved more than 1% since the start of the block (that hub's hook record).
/// Hop 1 bound (R-18, finding F-1): every slice is at most `maxSliceUsdgCap`, and before hop 1 every listed pool whose
/// in-range liquidity is at least 1% of the chosen pool's must price ETH within 0.5% of it, else `PriceMovedInBlock`.
/// Every slice, on both routes, is at most `maxSliceUsdgCap`.
/// Cashback and referral share (R-45, B-1): once the treasury owner has set `cashbackSink` (proposed, then executed after
/// `CASHBACK_DELAY`, once for good), `CASHBACK_BPS` of the ORRY bought by `executeSlice` and `buyWithQuote` goes to the
/// sink and the rest to the router; until then all of it goes to the router. `burnEth` output is always burned whole.
/// No owner, no setter. Never trades in a Pons pool (R-1): hop 1 pools have no hook and hub keys come from the hook.
contract OrryBuyback is IOrryBuyback, IOrryBurnEvents, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using ProtocolFeeLibrary for uint24;

    uint64 public constant MIN_INTERVAL = 1 hours;
    uint64 public constant CASHBACK_DELAY = 48 hours;

    uint256 private constant PIPS = 1_000_000;
    uint256 private constant BPS = 10_000;
    uint256 private constant Q96 = 0x1000000000000000000000000;
    uint256 private constant MAX_BLOCK_MOVE_BPS = 100;
    uint256 private constant MAX_POOL_SPREAD_BPS = 50;
    uint256 private constant MIN_REFERENCE_LIQUIDITY_PCT = 1;
    uint256 private constant SLIPPAGE_KEEP_PER_MILLE = 999;
    bytes32 private constant LOCK_SLOT = keccak256("orrery.orry.buyback.lock");

    uint8 private constant ACTION_SLICE = 1; // USDG -> ETH -> ORRY, to the router
    uint8 private constant ACTION_BURN = 2; // ETH -> ORRY, kept here and burned
    uint8 private constant ACTION_DIRECT = 3; // USDG -> ORRY in the USDG hub, to the router
    uint8 private constant ACTION_QUOTE = 4; // quote -> ORRY in its hub, to the router

    address public immutable treasury;
    address public immutable rewardsRouter;
    address public immutable hook;
    address public immutable orry;
    address public immutable usdg;

    IPoolManager private immutable _manager;
    uint256 private immutable _maxSliceUsdgCap;
    uint16 public immutable CASHBACK_BPS;

    /// @dev Hop 1 pools: currency0 native ETH, currency1 USDG, no hooks; only fee and tick spacing differ.
    uint256 private immutable _poolCount;
    uint24 private immutable _fee0;
    uint24 private immutable _fee1;
    uint24 private immutable _fee2;
    int24 private immutable _spacing0;
    int24 private immutable _spacing1;
    int24 private immutable _spacing2;

    uint64 public lastSliceAt;
    uint64 public lastEthBurnAt;
    mapping(address quote => uint64) public lastQuoteBuyAt;
    address public cashbackSink;
    address private _pendingSink;
    uint64 private _pendingSinkAt;

    struct Hop {
        PoolKey key;
        bool zeroForOne; // direction of this hop's swap
        uint160 sqrtPriceX96;
        uint256 reserveIn; // virtual reserve of the input side
        uint256 feePips; // full fee of this direction
    }

    constructor(
        address treasury_,
        address rewardsRouter_,
        address hook_,
        address usdg_,
        address poolManager_,
        PoolKey[] memory hop1Pools,
        uint256 maxSliceUsdgCap,
        uint16 cashbackBps
    ) {
        require(maxSliceUsdgCap != 0, "zero slice cap");
        require(cashbackBps <= BPS, "cashback bps");
        require(
            treasury_ != address(0) && rewardsRouter_ != address(0) && hook_ != address(0) && usdg_ != address(0)
                && poolManager_ != address(0),
            "zero address"
        );
        require(IOrreryHook(hook_).poolManager() == poolManager_, "hook manager");
        address orry_ = IOrreryHook(hook_).orry();
        require(orry_ != address(0) && orry_ != usdg_, "orry");
        uint256 n = hop1Pools.length;
        require(n != 0 && n <= 3, "one to three pools");
        uint24[3] memory fees;
        int24[3] memory spacings;
        for (uint256 i; i < n; ++i) {
            PoolKey memory k = hop1Pools[i];
            require(
                Currency.unwrap(k.currency0) == address(0) && Currency.unwrap(k.currency1) == usdg_
                    && address(k.hooks) == address(0) && k.fee <= LPFeeLibrary.MAX_LP_FEE,
                "hop 1 pool"
            );
            fees[i] = k.fee;
            spacings[i] = k.tickSpacing;
        }
        treasury = treasury_;
        rewardsRouter = rewardsRouter_;
        hook = hook_;
        orry = orry_;
        usdg = usdg_;
        _manager = IPoolManager(poolManager_);
        _maxSliceUsdgCap = maxSliceUsdgCap;
        CASHBACK_BPS = cashbackBps;
        _poolCount = n;
        (_fee0, _fee1, _fee2) = (fees[0], fees[1], fees[2]);
        (_spacing0, _spacing1, _spacing2) = (spacings[0], spacings[1], spacings[2]);
    }

    modifier nonReentrant() {
        bytes32 slot = LOCK_SLOT;
        assembly ("memory-safe") {
            if tload(slot) { revert(0, 0) }
            tstore(slot, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    /// @notice ETH from the rewards router (or anyone) waits here for `burnEth`.
    receive() external payable {}

    // ------------------------------------------------------------------ actions

    function executeSlice() external nonReentrant returns (uint256 orryOut) {
        uint64 last = lastSliceAt;
        if (last != 0 && block.timestamp < last + MIN_INTERVAL) revert TooSoon(last + MIN_INTERVAL);
        (bool direct, uint256 amount, Hop memory pool, Hop memory hub) = _slicePlan();
        if (amount == 0) revert NothingToBuy();
        if (direct) {
            _checkBlockMove(usdg, hub.sqrtPriceX96);
        } else {
            _checkBlockMove(address(0), hub.sqrtPriceX96);
            _checkListedPrices(pool);
        }
        lastSliceAt = uint64(block.timestamp);

        uint256 pulled = IOrreryTreasury(treasury).pullBuyback(amount);
        uint256 ethMid;
        if (direct) {
            orryOut = abi.decode(_manager.unlock(abi.encode(ACTION_DIRECT, pulled, hub, hub)), (uint256));
        } else {
            (ethMid, orryOut) = abi.decode(_manager.unlock(abi.encode(ACTION_SLICE, pulled, pool, hub)), (uint256, uint256));
        }
        emit SliceExecuted(pulled, ethMid, orryOut);
        _emitCashback(orryOut);
    }

    function burnEth() external nonReentrant returns (uint256 orryBurned) {
        uint64 last = lastEthBurnAt;
        if (last != 0 && block.timestamp < last + MIN_INTERVAL) revert TooSoon(last + MIN_INTERVAL);
        (bool ok, Hop memory hub) = _hubHop(address(0));
        if (!ok) revert NothingToBuy();
        _checkBlockMove(address(0), hub.sqrtPriceX96);
        uint256 ethIn = _min(address(this).balance, _cap(hub));
        if (ethIn == 0) revert NothingToBuy();
        lastEthBurnAt = uint64(block.timestamp);

        _manager.unlock(abi.encode(ACTION_BURN, ethIn, hub, hub));
        // everything the buyback holds in ORRY is burned, so it keeps none between calls
        orryBurned = IOrryToken(orry).balanceOf(address(this));
        IOrryToken(orry).burn(orryBurned);
        emit EthBurned(ethIn, orryBurned);
        emit Burned(4, orryBurned);
    }

    /// @notice R-37: the router's `quote` (forwarded in `distribute`) buys ORRY in that quote's own hub, one hop, and the
    /// ORRY goes to the router. Spends only this contract's balance of `quote`, at most the hop cap.
    function buyWithQuote(address quote) external nonReentrant returns (uint256 orryOut) {
        if (quote == address(0) || quote == orry || !IOrreryHook(hook).isPair(quote)) revert NotAQuote();
        uint64 last = lastQuoteBuyAt[quote];
        if (last != 0 && block.timestamp < last + MIN_INTERVAL) revert TooSoon(last + MIN_INTERVAL);
        (bool ok, Hop memory hub) = _hubHop(quote);
        if (!ok) revert NothingToBuy();
        _checkBlockMove(quote, hub.sqrtPriceX96);
        uint256 amountIn = _min(IERC20Min(quote).balanceOf(address(this)), _cap(hub));
        if (amountIn == 0) revert NothingToBuy();
        lastQuoteBuyAt[quote] = uint64(block.timestamp);

        orryOut = abi.decode(_manager.unlock(abi.encode(ACTION_QUOTE, amountIn, hub, hub)), (uint256));
        emit QuoteSwapped(quote, amountIn, orryOut);
        _emitCashback(orryOut);
    }

    // ------------------------------------------------------------------ cashback sink (R-45, B-1)

    function pendingCashbackSink() external view returns (address sink, uint64 executableAt) {
        return (_pendingSink, _pendingSinkAt);
    }

    /// @notice Treasury owner (read live): proposes the cashback sink; a new proposal replaces a pending one.
    function proposeCashbackSink(address sink) external {
        if (msg.sender != IOrreryTreasury(treasury).owner()) revert NotTreasuryOwner();
        if (cashbackSink != address(0)) revert CashbackSinkAlreadySet();
        require(sink != address(0), "zero sink");
        uint64 at = uint64(block.timestamp) + CASHBACK_DELAY;
        _pendingSink = sink;
        _pendingSinkAt = at;
        emit CashbackSinkProposed(sink, at);
    }

    /// @notice Treasury owner (read live): sets the proposed sink after CASHBACK_DELAY, for good.
    function executeCashbackSink() external {
        if (msg.sender != IOrreryTreasury(treasury).owner()) revert NotTreasuryOwner();
        if (cashbackSink != address(0)) revert CashbackSinkAlreadySet();
        address sink = _pendingSink;
        if (sink == address(0)) revert NoCashbackProposal();
        if (block.timestamp < _pendingSinkAt) revert CashbackNotReady(_pendingSinkAt);
        cashbackSink = sink;
        delete _pendingSink;
        delete _pendingSinkAt;
        emit CashbackSinkSet(sink);
    }

    /// @dev The sink's share of `orryOut`, rounded down; 0 until the sink is set.
    function _cashbackOf(uint256 orryOut) private view returns (uint256) {
        if (cashbackSink == address(0)) return 0;
        return orryOut * CASHBACK_BPS / BPS;
    }

    function _emitCashback(uint256 orryOut) private {
        uint256 cb = _cashbackOf(orryOut);
        if (cb != 0) emit CashbackPaid(cashbackSink, cb);
    }

    /// @dev Pays bought ORRY straight from the PoolManager: the sink's share, then the rest to the router.
    function _takeOrry(uint256 orryOut) private {
        uint256 cb = _cashbackOf(orryOut);
        if (cb != 0) _manager.take(Currency.wrap(orry), cashbackSink, cb);
        _manager.take(Currency.wrap(orry), rewardsRouter, orryOut - cb);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(_manager)) revert();
        (uint8 action, uint256 amountIn, Hop memory first, Hop memory hub) =
            abi.decode(data, (uint8, uint256, Hop, Hop));
        if (action == ACTION_SLICE) {
            // hop 1: USDG (currency1) to ETH (currency0); hop 2: ETH to ORRY in the ETH hub; ETH nets to zero
            uint256 ethMid = _swapExactIn(first, false, amountIn);
            uint256 orryOut = _swapExactIn(hub, hub.zeroForOne, ethMid);
            _settleErc20(usdg, amountIn);
            _takeOrry(orryOut);
            return abi.encode(ethMid, orryOut);
        }
        uint256 out = _swapExactIn(hub, hub.zeroForOne, amountIn);
        if (action == ACTION_BURN) {
            _manager.settle{value: amountIn}();
            _manager.take(Currency.wrap(orry), address(this), out);
        } else {
            // ACTION_DIRECT (USDG) and ACTION_QUOTE: the input is the hub's non-ORRY currency
            _settleErc20(Currency.unwrap(hub.zeroForOne ? hub.key.currency0 : hub.key.currency1), amountIn);
            _takeOrry(out);
        }
        return abi.encode(out);
    }

    // ------------------------------------------------------------------ views

    function maxSliceUsdg() external view returns (uint256 amount) {
        (, amount,,) = _slicePlan();
    }

    function sliceViaUsdgHub() external view returns (bool direct) {
        (direct,,,) = _slicePlan();
    }

    function maxBurnEth() external view returns (uint256) {
        (bool ok, Hop memory hub) = _hubHop(address(0));
        if (!ok) return 0;
        return _min(address(this).balance, _cap(hub));
    }

    function maxQuoteIn(address quote) external view returns (uint256) {
        if (quote == address(0) || quote == orry || !IOrreryHook(hook).isPair(quote)) return 0;
        (bool ok, Hop memory hub) = _hubHop(quote);
        if (!ok) return 0;
        return _min(IERC20Min(quote).balanceOf(address(this)), _cap(hub));
    }

    // ------------------------------------------------------------------ internals

    /// @dev The slice route and size. ETH path cap: min(hop 1 cap of the deepest listed pool, ETH hub cap expressed in
    /// USDG at hop 1 spot). Direct cap: the USDG hub's cap. The direct route is taken when the USDG hub is live and its
    /// cap is at least the ETH path's. Size: min(treasury allowance, the route's cap, the constructor cap).
    function _slicePlan() private view returns (bool direct, uint256 amount, Hop memory pool, Hop memory hub) {
        uint256 ethCap;
        (bool ethLive, Hop memory ethHub) = _hubHop(address(0));
        if (ethLive) {
            bool found;
            (found, pool) = _deepestPool();
            if (found) {
                uint256 hubCapEth = _cap(ethHub);
                // USDG worth hubCapEth at hop 1 spot: hop 1 pays less than spot, so its ETH output stays within the hub cap
                uint256 hubCapUsdg =
                    FullMath.mulDiv(FullMath.mulDiv(hubCapEth, pool.sqrtPriceX96, Q96), pool.sqrtPriceX96, Q96);
                ethCap = _min(_cap(pool), hubCapUsdg);
            }
        }
        (bool usdgLive, Hop memory usdgHub) = _hubHop(usdg);
        uint256 directCap = usdgLive ? _cap(usdgHub) : 0;
        direct = directCap != 0 && directCap >= ethCap;
        (uint256 routeCap, Hop memory routeHub) = direct ? (directCap, usdgHub) : (ethCap, ethHub);
        if (routeCap == 0) return (false, 0, pool, hub);
        hub = routeHub;
        amount = _min(IOrreryTreasury(treasury).availableForBuyback(), _min(routeCap, _maxSliceUsdgCap));
    }

    function _hop1Key(uint256 i) private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(usdg),
            fee: i == 0 ? _fee0 : i == 1 ? _fee1 : _fee2,
            tickSpacing: i == 0 ? _spacing0 : i == 1 ? _spacing1 : _spacing2,
            hooks: IHooks(address(0))
        });
    }

    /// @dev R-18: every other listed pool with in-range liquidity of at least 1% of the chosen pool's must price ETH
    /// within 0.5% of the chosen pool, pre-trade and in price terms; exactly 0.5% passes.
    function _checkListedPrices(Hop memory chosen) private view {
        PoolId chosenId = chosen.key.toId();
        uint256 chosenL = _manager.getLiquidity(chosenId);
        uint256 chosenPrice = FullMath.mulDiv(chosen.sqrtPriceX96, chosen.sqrtPriceX96, Q96);
        for (uint256 i; i < _poolCount; ++i) {
            PoolId id = _hop1Key(i).toId();
            if (PoolId.unwrap(id) == PoolId.unwrap(chosenId)) continue;
            (uint160 sqrtP,,,) = _manager.getSlot0(id);
            uint256 l = _manager.getLiquidity(id);
            if (sqrtP == 0 || l * 100 < chosenL * MIN_REFERENCE_LIQUIDITY_PCT) continue;
            uint256 price = FullMath.mulDiv(sqrtP, sqrtP, Q96);
            if (
                price * 10_000 > chosenPrice * (10_000 + MAX_POOL_SPREAD_BPS)
                    || price * 10_000 < chosenPrice * (10_000 - MAX_POOL_SPREAD_BPS)
            ) revert PriceMovedInBlock();
        }
    }

    function _deepestPool() private view returns (bool found, Hop memory best) {
        for (uint256 i; i < _poolCount; ++i) {
            (bool live, Hop memory h) = _readHop(_hop1Key(i), false, 0);
            if (live && h.reserveIn > best.reserveIn) {
                best = h;
                found = true;
            }
        }
    }

    /// @dev The hub of `quote` (address 0 = native ETH), swapping `quote` for ORRY; not live until registered and
    /// initialized.
    function _hubHop(address quote) private view returns (bool live, Hop memory h) {
        if (!IOrreryHook(hook).isPair(quote)) return (false, h);
        IOrreryHook.Pair memory p = IOrreryHook(hook).pairOf(quote);
        if (!p.initialized) return (false, h);
        PoolKey memory key = IOrreryHook(hook).hubKey(quote);
        // ORRY out: the quote is currency0 exactly when ORRY is currency1
        (live, h) = _readHop(key, !p.orryIsCurrency0, IOrreryHook(hook).protocolFeePips());
    }

    /// @dev Pre-trade state of `key` for a swap in direction `zeroForOne`; `extraFeePips` is a hook fee on the output.
    function _readHop(PoolKey memory key, bool zeroForOne, uint256 extraFeePips)
        private
        view
        returns (bool live, Hop memory h)
    {
        (uint160 sqrtP,, uint24 protocolFee, uint24 lpFee) = _manager.getSlot0(key.toId());
        uint128 liquidity = _manager.getLiquidity(key.toId());
        if (sqrtP == 0 || liquidity == 0) return (false, h);
        uint16 dirFee = zeroForOne ? protocolFee.getZeroForOneFee() : protocolFee.getOneForZeroFee();
        uint256 fee = (dirFee == 0 ? lpFee : ProtocolFeeLibrary.calculateSwapFee(dirFee, lpFee)) + extraFeePips;
        if (fee >= PIPS) return (false, h);
        h.key = key;
        h.zeroForOne = zeroForOne;
        h.sqrtPriceX96 = sqrtP;
        h.feePips = fee;
        h.reserveIn =
            zeroForOne ? FullMath.mulDiv(liquidity, Q96, sqrtP) : FullMath.mulDiv(liquidity, sqrtP, Q96);
        live = true;
    }

    function _cap(Hop memory h) private pure returns (uint256) {
        return FullMath.mulDiv(h.reserveIn, h.feePips, 2 * PIPS);
    }

    /// @dev Exact input swap with the half-fee price limit; reverts unless all of `amountIn` was swapped and the output
    /// meets `minOut` against the pre-trade spot.
    function _swapExactIn(Hop memory h, bool zeroForOne, uint256 amountIn) private returns (uint256 out) {
        // the pool state may have changed since the hop was read (hop 2 is read before hop 1 runs, but in another pool)
        (uint160 sqrtP,,,) = _manager.getSlot0(h.key.toId());
        uint256 spotOut = zeroForOne
            ? FullMath.mulDiv(FullMath.mulDiv(amountIn, sqrtP, Q96), sqrtP, Q96)
            : FullMath.mulDiv(FullMath.mulDiv(amountIn, Q96, sqrtP), Q96, sqrtP);
        // A hop of up to the cap (reserveIn * fee / 2) moves the price by up to about fee / 2, so the floor allows that
        // impact on top of the fee, then a small slack; with a fixed 0.5% slack alone, any protocol fee on the hub made
        // a full-cap hop miss its own floor (review M-4).
        uint256 minOut = spotOut * (PIPS - h.feePips) / PIPS * (2 * PIPS - h.feePips) / (2 * PIPS) * SLIPPAGE_KEEP_PER_MILLE / 1000;
        uint256 limit = zeroForOne
            ? FullMath.mulDiv(sqrtP, 2 * PIPS - h.feePips, 2 * PIPS)
            : FullMath.mulDiv(sqrtP, 2 * PIPS + h.feePips, 2 * PIPS);
        if (limit <= TickMath.MIN_SQRT_PRICE) limit = TickMath.MIN_SQRT_PRICE + 1;
        if (limit >= TickMath.MAX_SQRT_PRICE) limit = TickMath.MAX_SQRT_PRICE - 1;

        BalanceDelta d = _manager.swap(
            h.key,
            SwapParams({
                zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: uint160(limit)
            }),
            ""
        );
        int128 paid = zeroForOne ? d.amount0() : d.amount1();
        int128 got = zeroForOne ? d.amount1() : d.amount0();
        if (paid >= 0 || uint256(uint128(-paid)) != amountIn || got <= 0) revert SlippageExceeded();
        out = uint256(uint128(got));
        if (out < minOut) revert SlippageExceeded();
    }

    /// @dev Refuses `quote`'s hub when its price moved more than 1% since the start of this block (that hub's record).
    function _checkBlockMove(address quote, uint160 liveSqrtP) private view {
        (uint160 startSqrtP, uint64 blockNumber) = IOrreryHook(hook).startOfBlockSqrtPriceX96(quote);
        if (blockNumber != block.number || startSqrtP == 0) return;
        uint256 live = FullMath.mulDiv(liveSqrtP, liveSqrtP, Q96);
        uint256 start = FullMath.mulDiv(startSqrtP, startSqrtP, Q96);
        if (
            live * 10_000 > start * (10_000 + MAX_BLOCK_MOVE_BPS)
                || live * 10_000 < start * (10_000 - MAX_BLOCK_MOVE_BPS)
        ) revert PriceMovedInBlock();
    }

    /// @dev Pays `amount` of ERC-20 `token` owed to the PoolManager (sync, transfer, settle); a token that delivers less
    /// leaves the delta open and the PoolManager reverts the whole unlock.
    function _settleErc20(address token, uint256 amount) private {
        _manager.sync(Currency.wrap(token));
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Min.transfer, (address(_manager), amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
        _manager.settle();
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
