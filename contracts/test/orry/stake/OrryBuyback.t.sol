// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IProtocolFees} from "v4-core/src/interfaces/IProtocolFees.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {Vm} from "forge-std/Vm.sol";

import {IOrryBuyback} from "../../../src/orry/interfaces/IOrryBuyback.sol";
import {IOrryBurnEvents} from "../../../src/orry/interfaces/IOrryToken.sol";
import {OrryBuyback} from "../../../src/orry/OrryBuyback.sol";
import {OrreryTreasury} from "../../../src/orry/OrreryTreasury.sol";
import {BuybackBase} from "./utils/StakeBase.sol";
import {TestHubHook} from "./utils/TestHubHook.sol";

contract OrryBuybackTest is BuybackBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant SLICE_CAP = 1_000e6; // R-18 default

    function setUp() public override {
        super.setUp();
        _setCoin(address(buyback));
        _revenue(10_000e6); // reserve 9,000 USDG; 900 USDG may leave today
    }

    // ---------------------------------------------------------------- independent math

    function _reserveIn(PoolKey memory key, bool zeroForOne) internal view returns (uint256) {
        (uint160 s,,,) = pm.getSlot0(key.toId());
        uint128 l = pm.getLiquidity(key.toId());
        return zeroForOne ? FullMath.mulDiv(l, Q96, s) : FullMath.mulDiv(l, s, Q96);
    }

    function _hubCapEth() internal view returns (uint256) {
        return _reserveIn(hubKey, true) * (8500 + 1500) / 2e6;
    }

    function _expectedSlice() internal view returns (uint256) {
        uint256 cap1 = _reserveIn(usdgKey, false) * 500 / 2e6;
        uint160 s = _sqrtP(usdgKey);
        uint256 hubUsdg = FullMath.mulDiv(FullMath.mulDiv(_hubCapEth(), s, Q96), s, Q96);
        uint256 a = treasury.availableForBuyback();
        if (cap1 < a) a = cap1;
        if (hubUsdg < a) a = hubUsdg;
        if (SLICE_CAP < a) a = SLICE_CAP;
        return a;
    }

    /// B-2: |sqrtP after - sqrtP before| <= sqrtP before * fee / 2e6.
    function _assertHalfFeeMove(uint160 pre, uint160 post, uint256 feePips, string memory what) internal pure {
        uint256 moved = post > pre ? post - pre : pre - post;
        assertLe(moved * 2e6, uint256(pre) * feePips, what);
    }

    // ---------------------------------------------------------------- constructor and views

    function test_constructor_values() public view {
        assertEq(buyback.treasury(), address(treasury));
        assertEq(buyback.rewardsRouter(), address(router));
        assertEq(buyback.hook(), address(hook));
        assertEq(buyback.orry(), address(orry));
        assertEq(buyback.usdg(), address(usdg));
        assertEq(buyback.MIN_INTERVAL(), 1 hours);
        assertEq(buyback.lastSliceAt(), 0);
        assertEq(buyback.lastEthBurnAt(), 0);
    }

    function test_constructor_rejects_bad_pools() public {
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = usdgKey;
        keys[0].hooks = IHooks(address(hook));
        _ctorReverts(keys, address(pm), 1_000e6, 1000, "hop 1 pool");
        keys[0] = hubKey; // a pool of another pair (a Pons or hub pool) is refused
        _ctorReverts(keys, address(pm), 1_000e6, 1000, "hop 1 pool");
        keys[0] = usdgKey;
        keys[0].fee = 0x800000; // dynamic fee
        _ctorReverts(keys, address(pm), 1_000e6, 1000, "hop 1 pool");
        _ctorReverts(new PoolKey[](0), address(pm), 1_000e6, 1000, "one to three pools");
        _ctorReverts(new PoolKey[](4), address(pm), 1_000e6, 1000, "one to three pools");
        keys[0] = usdgKey;
        _ctorReverts(keys, address(pm), 0, 1000, "zero slice cap");
        _ctorReverts(keys, address(0xBEEF), 1_000e6, 1000, "hook manager");
        _ctorReverts(keys, address(pm), 1_000e6, 10_001, "cashback bps");
    }

    /// @dev try/catch rather than expectRevert: with dynamic test linking and isolate (the effective forge config) a
    /// `new` becomes `vm.deployCode`, and an expected revert there ends the test, so later checks would never run.
    function _ctorReverts(PoolKey[] memory keys, address manager, uint256 cap, uint16 cashbackBps, string memory why)
        internal
    {
        try new OrryBuyback(address(treasury), address(router), address(hook), address(usdg), manager, keys, cap, cashbackBps)
        returns (OrryBuyback) {
            revert("constructor did not revert");
        } catch Error(string memory reason) {
            assertEq(reason, why);
        }
    }

    function test_views_match_independent_math() public {
        uint256 expected = _expectedSlice();
        assertGt(expected, 0);
        assertEq(buyback.maxSliceUsdg(), expected);
        assertLt(expected, treasury.availableForBuyback(), "hop 1 cap binds in this setup");
        assertEq(buyback.maxBurnEth(), 0);
        vm.deal(address(buyback), 10 ether);
        assertEq(buyback.maxBurnEth(), _hubCapEth());
    }

    // ---------------------------------------------------------------- executeSlice

    function test_slice_buys_orry_for_the_router() public {
        treasury.sync();
        uint256 amount = _expectedSlice();
        uint160 p1 = _sqrtP(usdgKey);
        uint160 p2 = _sqrtP(hubKey);
        uint256 routerRc = orry.balanceOf(address(router));
        uint256 reserve = treasury.buybackReserve();
        uint256 buybackEth = address(buyback).balance;

        vm.recordLogs();
        uint256 out = buyback.executeSlice();

        assertGt(out, 0);
        assertEq(orry.balanceOf(address(router)) - routerRc, out, "B-3: all ORRY bought reaches the router");
        assertEq(treasury.buybackReserve(), reserve - amount, "pulled exactly the slice");
        assertEq(usdg.balanceOf(address(buyback)), 0);
        assertEq(orry.balanceOf(address(buyback)), 0);
        assertEq(address(buyback).balance, buybackEth, "slice ETH nets to zero inside the PoolManager");
        _assertHalfFeeMove(p1, _sqrtP(usdgKey), 500, "B-2 hop 1");
        _assertHalfFeeMove(p2, _sqrtP(hubKey), 10_000, "B-2 hop 2");
        assertEq(buyback.lastSliceAt(), _now());

        // the event carries the same numbers; hop 1 gave at least its minimum against the pre-trade spot
        (uint256 usdgIn, uint256 ethMid, uint256 orryOut) = _sliceEvent();
        assertEq(usdgIn, amount);
        assertEq(orryOut, out);
        uint256 spotEth = FullMath.mulDiv(FullMath.mulDiv(amount, Q96, p1), Q96, p1);
        assertGe(ethMid, spotEth * (1e6 - 500) / 1e6 * 995 / 1000);
        uint256 spotRc = FullMath.mulDiv(FullMath.mulDiv(ethMid, p2, Q96), p2, Q96);
        assertGe(out, spotRc * (1e6 - 10_000) / 1e6 * 995 / 1000);
    }

    function test_slice_at_most_hourly() public {
        buyback.executeSlice();
        uint64 next = uint64(_now() + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(IOrryBuyback.TooSoon.selector, next));
        buyback.executeSlice();
        vm.warp(next);
        vm.roll(vm.getBlockNumber() + 1);
        buyback.executeSlice();
    }

    function test_slice_nothing_to_buy_when_coinless_or_drained() public {
        (OrryBuyback b,) = _altBuyback(_one(usdgKey), false, 0);
        vm.expectRevert(IOrryBuyback.NothingToBuy.selector);
        b.executeSlice();
        (OrryBuyback b2,) = _altBuyback(_one(usdgKey), true, 0);
        assertEq(b2.maxSliceUsdg(), 0);
        vm.expectRevert(IOrryBuyback.NothingToBuy.selector);
        b2.executeSlice();
    }

    function test_slice_refused_when_hub_moved_in_block() public {
        _swap(hubKey, true, 2 ether); // about 4% in price, this block
        vm.expectRevert(IOrryBuyback.PriceMovedInBlock.selector);
        buyback.executeSlice();
        vm.deal(address(buyback), 1 ether);
        vm.expectRevert(IOrryBuyback.PriceMovedInBlock.selector);
        buyback.burnEth();
        vm.roll(vm.getBlockNumber() + 1); // the move belongs to an earlier block now
        buyback.executeSlice();
        buyback.burnEth();
    }

    function test_small_move_in_block_is_allowed() public {
        _swap(hubKey, true, 0.2 ether); // about 0.4% in price
        buyback.executeSlice();
    }

    function test_slice_reverts_when_liquidity_ends_before_the_cap() public {
        // narrow pool: in range now, but its liquidity ends five ticks above the price, below the half-fee move
        PoolKey memory narrow = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), 3000, 60, IHooks(address(0)));
        pm.initialize(narrow, TickMath.getSqrtPriceAtTick(-199205));
        lpRouter.modifyLiquidity{value: 100 ether}(
            narrow, ModifyLiquidityParams({tickLower: -199260, tickUpper: -199200, liquidityDelta: 1e16, salt: 0}), ""
        );
        (OrryBuyback b,) = _altBuyback(_one(narrow), true, 1_000_000e6);
        // the slice (hop 1 cap, about 709 USDG) is larger than the 118 USDG that reach the end of the range
        assertGt(b.maxSliceUsdg(), 500e6);
        vm.expectRevert(IOrryBuyback.SlippageExceeded.selector);
        b.executeSlice();
    }

    /// Review M-4 across the PoolManager's whole protocol fee range: a full-cap ETH slice still fills.
    function test_full_cap_slice_fills_at_every_protocol_fee() public {
        PoolKey memory k = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), 10_000, 60, IHooks(address(0)));
        pm.initialize(k, TickMath.getSqrtPriceAtTick(USDG_TICK));
        _addFullRange(k, 1e15, 100 ether);
        vm.prank(address(0)); // the etched PoolManager has no owner in storage
        IProtocolFees(address(pm)).setProtocolFeeController(address(this));
        uint24[5] memory pips = [uint24(125), 175, 300, 500, 1000];
        for (uint256 i; i < pips.length; ++i) {
            uint256 snap = vm.snapshotState();
            IProtocolFees(address(pm)).setProtocolFee(k, uint24(pips[i] | (pips[i] << 12)));
            (OrryBuyback b,) = _altBuyback(_one(k), true, 100_000e6);
            b.executeSlice();
            vm.revertToState(snap);
        }
    }

    /// Review M-4: a full-cap hop moves the price by up to about fee / 2, and the floor now allows exactly that on top of
    /// the fee, so even a 3% pool (1.5% impact, more than the old fixed 0.5% slack) fills at the cap.
    function test_slice_at_the_cap_fills_on_a_high_fee_pool() public {
        PoolKey memory dear = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), 30_000, 60, IHooks(address(0)));
        pm.initialize(dear, TickMath.getSqrtPriceAtTick(USDG_TICK));
        _addFullRange(dear, 1e15, 100 ether);
        (OrryBuyback b,) = _altBuyback(_one(dear), true, 100_000e6);
        b.executeSlice();
    }

    /// B-2 when liquidity thins out past a narrow range: without the half-fee price limit this hop would move sqrtPrice
    /// about 0.3% (twice the bound) while still meeting the 0.5% minimum, so only the limit refuses it.
    function test_price_limit_refuses_a_hop_into_thinner_liquidity() public {
        PoolKey memory thin = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), 3000, 10, IHooks(address(0)));
        pm.initialize(thin, TickMath.getSqrtPriceAtTick(USDG_TICK));
        _addFullRange(thin, 4e15, 100 ether);
        lpRouter.modifyLiquidity{value: 10 ether}(
            thin, ModifyLiquidityParams({tickLower: USDG_TICK, tickUpper: USDG_TICK + 10, liquidityDelta: 6e15, salt: 0}), ""
        );
        (OrryBuyback b,) = _altBuyback(_one(thin), true, 100_000e6);
        vm.expectRevert(IOrryBuyback.SlippageExceeded.selector);
        b.executeSlice();
    }

    /// B-2 on the ETH-selling side with a hub whose fee is under 1% (LP 0.30%, no hook fee: bound 0.15% of sqrtP): the
    /// hub's liquidity thins 20 ticks below the price. Without the price limit the burn would move sqrtPrice about 0.6%
    /// and still meet the 0.5% minimum; the limit stops it and the partial fill is refused.
    function test_price_limit_refuses_a_hub_burn_into_thinner_liquidity() public {
        address hookAt = address(
            uint160(0x6666) << 144 | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        deployCodeTo(
            "TestHubHook.sol:TestHubHook",
            abi.encode(address(pm), address(orry), address(router), uint24(3000), uint24(0), int24(10), address(treasury), owner, _ethOnly()),
            hookAt
        );
        PoolKey memory cheapHub = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(orry)), 3000, 10, IHooks(hookAt));
        pm.initialize(cheapHub, TickMath.getSqrtPriceAtTick(HUB_TICK));
        _addFullRange(cheapHub, 1e22, 20 ether);
        lpRouter.modifyLiquidity{value: 1 ether}(
            cheapHub, ModifyLiquidityParams({tickLower: HUB_TICK - 20, tickUpper: HUB_TICK + 20, liquidityDelta: 9e22, salt: 0}), ""
        );
        OrryBuyback b = new OrryBuyback(address(treasury), address(router), hookAt, address(usdg), address(pm), _one(usdgKey), 1_000e6, 1000);
        vm.deal(address(b), 1 ether);
        vm.expectRevert(IOrryBuyback.SlippageExceeded.selector);
        b.burnEth();
    }

    /// A hop that fills 99.7% (liquidity ends just short of the full move) is refused with SlippageExceeded, not left
    /// to fail later in settlement.
    function test_partial_fill_is_refused_with_slippage_error() public {
        PoolKey memory edge = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), 500, 1, IHooks(address(0)));
        int24 upper = USDG_TICK;
        // start so that the capped slice needs 1/0.997 of the distance to the range's upper edge
        uint160 start = uint160(FullMath.mulDiv(TickMath.getSqrtPriceAtTick(upper), 1e9, 1e9 + 249_125));
        pm.initialize(edge, start);
        lpRouter.modifyLiquidity{value: 100 ether}(
            edge, ModifyLiquidityParams({tickLower: upper - 100, tickUpper: upper, liquidityDelta: 5e16, salt: 0}), ""
        );
        (OrryBuyback b,) = _altBuyback(_one(edge), true, 100_000e6);
        vm.expectRevert(IOrryBuyback.SlippageExceeded.selector);
        b.executeSlice();
    }

    /// The PoolManager protocol fee (125 pips each way on the 4663 ETH/USDG pools) is part of the hop fee.
    function test_hop_fee_includes_the_pool_manager_protocol_fee() public {
        vm.prank(address(0)); // the etched PoolManager has no owner in storage
        IProtocolFees(address(pm)).setProtocolFeeController(address(this));
        IProtocolFees(address(pm)).setProtocolFee(usdgKey, uint24(125 | (125 << 12)));
        uint256 pf = 125;
        uint256 fee1 = pf + 500 - (pf * 500) / 1e6; // ProtocolFeeLibrary.calculateSwapFee
        uint256 cap1 = _reserveIn(usdgKey, false) * fee1 / 2e6;
        uint160 s = _sqrtP(usdgKey);
        uint256 hubUsdg = FullMath.mulDiv(FullMath.mulDiv(_hubCapEth(), s, Q96), s, Q96);
        uint256 expected = treasury.availableForBuyback();
        if (cap1 < expected) expected = cap1;
        if (hubUsdg < expected) expected = hubUsdg;
        if (SLICE_CAP < expected) expected = SLICE_CAP;
        assertEq(buyback.maxSliceUsdg(), expected);
        uint160 pre = _sqrtP(usdgKey);
        buyback.executeSlice();
        _assertHalfFeeMove(pre, _sqrtP(usdgKey), fee1, "B-2 with the protocol fee");
    }

    function test_slice_uses_the_deepest_listed_pool() public {
        PoolKey memory shallow = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), 3000, 60, IHooks(address(0)));
        pm.initialize(shallow, TickMath.getSqrtPriceAtTick(USDG_TICK));
        _addFullRange(shallow, 1e15, 100 ether);
        PoolKey[] memory keys = new PoolKey[](2);
        keys[0] = shallow;
        keys[1] = usdgKey;
        (OrryBuyback b,) = _altBuyback(keys, true, 10_000e6);
        uint160 sShallow = _sqrtP(shallow);
        uint160 sDeep = _sqrtP(usdgKey);
        b.executeSlice();
        assertEq(_sqrtP(shallow), sShallow, "shallow pool untouched");
        assertGt(_sqrtP(usdgKey), sDeep, "deepest pool traded");
    }

    function test_slice_nothing_to_buy_before_the_hub_exists() public {
        address hookAt = address(
            uint160(0x5555) << 144 | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        deployCodeTo(
            "TestHubHook.sol:TestHubHook",
            abi.encode(address(pm), address(orry), address(router), uint24(8500), uint24(1500), int24(200), address(treasury), owner, _ethOnly()),
            hookAt
        );
        OrryBuyback b = new OrryBuyback(address(treasury), address(router), hookAt, address(usdg), address(pm), _one(usdgKey), 1_000e6, 1000);
        assertEq(b.maxSliceUsdg(), 0);
        assertEq(b.maxBurnEth(), 0);
        vm.expectRevert(IOrryBuyback.NothingToBuy.selector);
        b.executeSlice();
        vm.deal(address(b), 1 ether);
        vm.expectRevert(IOrryBuyback.NothingToBuy.selector);
        b.burnEth();
    }

    /// With a deep hop 1 pool and a large constructor cap, the hub cap (converted to USDG at hop 1 spot) is the binding
    /// term, and the slice still moves the hub by at most half its fee.
    function test_hub_cap_binds_when_it_is_the_smallest() public {
        _addFullRange(usdgKey, 1e17, 2_500 ether); // hop 1 cap about 1,700 USDG
        PoolKey[] memory keys = _one(usdgKey);
        OrreryTreasury t = new OrreryTreasury(address(usdg), address(attestor), owner, 1000, new address[](0));
        OrryBuyback b = new OrryBuyback(address(t), address(router), address(hook), address(usdg), address(pm), keys, 1e15, 1000);
        vm.prank(owner);
        t.proposeCoin(address(orry), address(b));
        vm.warp(_now() + 48 hours);
        vm.prank(owner);
        t.executeCoin();
        usdg.mint(address(t), 100_000e6);
        uint160 s1 = _sqrtP(usdgKey);
        uint256 hubUsdg = FullMath.mulDiv(FullMath.mulDiv(_hubCapEth(), s1, Q96), s1, Q96);
        uint256 cap1 = _reserveIn(usdgKey, false) * 500 / 2e6;
        assertLt(hubUsdg, cap1, "hub cap is the smaller one");
        assertEq(b.maxSliceUsdg(), hubUsdg);
        uint160 h0 = _sqrtP(hubKey);
        b.executeSlice();
        _assertHalfFeeMove(h0, _sqrtP(hubKey), 10_000, "B-2 hub at its cap");
    }

    // ---------------------------------------------------------------- hop 1 bound (R-18, F-1)

    function test_slice_bounded_by_the_constructor_cap() public {
        PoolKey[] memory keys = _one(usdgKey);
        OrreryTreasury t = new OrreryTreasury(address(usdg), address(attestor), owner, 1000, new address[](0));
        OrryBuyback b = new OrryBuyback(address(t), address(router), address(hook), address(usdg), address(pm), keys, 100e6, 1000);
        vm.prank(owner);
        t.proposeCoin(address(orry), address(b));
        vm.warp(_now() + 48 hours);
        vm.prank(owner);
        t.executeCoin();
        usdg.mint(address(t), 10_000e6);
        assertEq(b.maxSliceUsdg(), 100e6);
        t.sync();
        uint256 reserve = t.buybackReserve();
        b.executeSlice();
        assertEq(t.buybackReserve(), reserve - 100e6);
    }

    /// JIT liquidity makes the shallowest listed pool the deepest, then pushes it: the deep pool (now a reference with
    /// more than 1% of the chosen pool's liquidity) disagrees by more than 0.5% and the slice is refused.
    function test_jit_on_the_shallowest_pool_is_refused() public {
        PoolKey memory shallow = _listedPool(3000, 60, USDG_TICK, 1e15);
        PoolKey[] memory keys = new PoolKey[](2);
        keys[0] = usdgKey;
        keys[1] = shallow;
        (OrryBuyback b,) = _altBuyback(keys, true, 100_000e6);
        // JIT: ten times the deep pool's liquidity around the price, so the shallow pool is chosen
        lpRouter.modifyLiquidity{value: 1_000 ether}(
            shallow, ModifyLiquidityParams({tickLower: USDG_TICK - 600, tickUpper: USDG_TICK + 600, liquidityDelta: 4.7e17, salt: 0}), ""
        );
        // without a push the prices agree and the slice works (capped)
        uint256 snap = vm.snapshotState();
        assertEq(b.maxSliceUsdg(), SLICE_CAP);
        b.executeSlice();
        assertGt(_sqrtP(shallow), TickMath.getSqrtPriceAtTick(USDG_TICK), "the JIT pool was the one traded");
        vm.revertToState(snap);
        // push the chosen pool about 1% in price
        _swapToLimit(shallow, uint160(uint256(_sqrtP(shallow)) * 1005 / 1000));
        vm.expectRevert(IOrryBuyback.PriceMovedInBlock.selector);
        b.executeSlice();
    }

    /// A listed pool with under 1% of the chosen pool's liquidity is not a reference, whatever its price.
    function test_dead_pool_is_ignored() public {
        PoolKey memory dead = _listedPool(3000, 60, USDG_TICK + 1200, 1e14); // about 13% away, 0.2% of the liquidity
        PoolKey[] memory keys = new PoolKey[](2);
        keys[0] = usdgKey;
        keys[1] = dead;
        (OrryBuyback b,) = _altBuyback(keys, true, 100_000e6);
        b.executeSlice();
    }

    /// The 0.5% spread between listed pools, in price terms, both sides: 0.4% passes, 0.6% is refused.
    function test_listed_pool_spread_bound_both_sides() public {
        int24[4] memory offsets = [int24(40), int24(-40), int24(60), int24(-60)];
        for (uint256 i; i < 4; ++i) {
            uint256 snap = vm.snapshotState();
            PoolKey memory other = _listedPool(3000, 1, USDG_TICK + offsets[i], 1e15); // 2% of the deep pool's liquidity
            PoolKey[] memory keys = new PoolKey[](2);
            keys[0] = usdgKey;
            keys[1] = other;
            (OrryBuyback b,) = _altBuyback(keys, true, 100_000e6);
            if (i >= 2) vm.expectRevert(IOrryBuyback.PriceMovedInBlock.selector);
            b.executeSlice();
            vm.revertToState(snap);
        }
    }

    function test_unlockCallback_only_from_the_manager() public {
        vm.expectRevert();
        buyback.unlockCallback("");
    }

    // ---------------------------------------------------------------- burnEth

    function test_burnEth_burns_what_it_buys() public {
        vm.expectRevert(IOrryBuyback.NothingToBuy.selector);
        buyback.burnEth();
        vm.deal(address(buyback), 10 ether);
        uint256 cap = _hubCapEth();
        uint256 supply = orry.totalSupply();
        uint160 p = _sqrtP(hubKey);
        vm.recordLogs();
        uint256 burned = buyback.burnEth();
        assertGt(burned, 0);
        assertEq(supply - orry.totalSupply(), burned, "B-3: all of it burned");
        assertEq(orry.balanceOf(address(buyback)), 0);
        assertEq(address(buyback).balance, 10 ether - cap, "only the hub cap is spent; the rest waits");
        _assertHalfFeeMove(p, _sqrtP(hubKey), 10_000, "B-2 hub");
        (uint256 ethIn, uint256 rcBurned, uint256 burnEvent) = _burnEvents();
        assertEq(ethIn, cap);
        assertEq(rcBurned, burned);
        assertEq(burnEvent, burned);
        uint64 next = uint64(_now() + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(IOrryBuyback.TooSoon.selector, next));
        buyback.burnEth();
        vm.warp(next);
        vm.roll(vm.getBlockNumber() + 1);
        buyback.burnEth();
    }

    function test_burnEth_also_burns_orry_sent_to_the_buyback() public {
        vm.deal(address(buyback), 0.1 ether);
        orry.transfer(address(buyback), 5e18);
        uint256 supply = orry.totalSupply();
        uint256 burned = buyback.burnEth();
        assertGt(burned, 5e18);
        assertEq(supply - orry.totalSupply(), burned);
        assertEq(orry.balanceOf(address(buyback)), 0);
    }

    // ---------------------------------------------------------------- the whole money path

    function test_protocol_money_path_end_to_end() public {
        vm.prank(alice);
        staking.stake(1_000_000e18);
        // a trader uses the hub; the hook takes its protocol fee in both directions
        address trader = makeAddr("trader");
        vm.deal(trader, 50 ether);
        orry.transfer(trader, 50_000_000e18);
        vm.startPrank(trader);
        orry.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap{value: 5 ether}(
            hubKey,
            _params(true, 5 ether),
            _settings(),
            ""
        );
        swapRouter.swap(hubKey, _params(false, 4_000_000e18), _settings(), "");
        vm.stopPrank();
        uint256 feeEth = hook.pendingProtocolFee(address(0));
        uint256 feeRc = hook.pendingProtocolFee(address(orry));
        assertGt(feeEth, 0);
        assertGt(feeRc, 0);
        hook.collect();
        assertEq(address(router).balance, feeEth);
        assertEq(orry.balanceOf(address(router)), feeRc);

        // the treasury's reward share buys ORRY for the router
        vm.roll(vm.getBlockNumber() + 1);
        uint256 bought = buyback.executeSlice();
        uint256 routerRc = orry.balanceOf(address(router));
        assertEq(routerRc, feeRc + bought);

        // the router splits: half to stakers, ORRY half burned, ETH half to the buyback, which burns it next
        uint256 supply = orry.totalSupply();
        router.distribute();
        assertEq(address(router).balance, 0);
        assertEq(orry.balanceOf(address(router)), 0);
        assertEq(supply - orry.totalSupply(), routerRc - routerRc / 2);
        assertEq(address(buyback).balance, feeEth - feeEth / 2);
        uint256 burned = buyback.burnEth();
        assertGt(burned, 0);

        vm.warp(_now() + 7 days);
        (uint256 e, uint256 r) = staking.pendingRewards(alice);
        assertApproxEqAbs(e, feeEth / 2, 7 days);
        assertApproxEqAbs(r, routerRc / 2, 7 days);
        vm.prank(alice);
        staking.claimRewards();
    }

    // ---------------------------------------------------------------- helpers

    function _listedPool(uint24 fee, int24 spacing, int24 tick, uint128 liquidity) internal returns (PoolKey memory key) {
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), fee, spacing, IHooks(address(0)));
        pm.initialize(key, TickMath.getSqrtPriceAtTick(tick));
        _addFullRange(key, liquidity, 1_000 ether);
    }

    function _swapToLimit(PoolKey memory key, uint160 limit) internal {
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(100_000_000e6), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _one(PoolKey memory k) internal pure returns (PoolKey[] memory keys) {
        keys = new PoolKey[](1);
        keys[0] = k;
    }

    /// @dev A second treasury and buyback over `keys`; the coin is set when `coin`, then `revenue` USDG arrives.
    function _altBuyback(PoolKey[] memory keys, bool coin, uint256 revenue)
        internal
        returns (OrryBuyback b, OrreryTreasury t)
    {
        t = new OrreryTreasury(address(usdg), address(attestor), owner, 1000, new address[](0));
        b = new OrryBuyback(address(t), address(router), address(hook), address(usdg), address(pm), keys, 1_000e6, 1000);
        if (coin) {
            vm.prank(owner);
            t.proposeCoin(address(orry), address(b));
            vm.warp(_now() + 48 hours);
            vm.prank(owner);
            t.executeCoin();
        }
        usdg.mint(address(t), revenue);
    }

    function _sliceEvent() internal returns (uint256 usdgIn, uint256 ethMid, uint256 orryOut) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(buyback) && logs[i].topics[0] == IOrryBuyback.SliceExecuted.selector) {
                (usdgIn, ethMid, orryOut) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
        }
    }

    function _burnEvents() internal returns (uint256 ethIn, uint256 rcBurned, uint256 burnedSource4) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(buyback)) continue;
            if (logs[i].topics[0] == IOrryBuyback.EthBurned.selector) {
                (ethIn, rcBurned) = abi.decode(logs[i].data, (uint256, uint256));
            } else if (logs[i].topics[0] == IOrryBurnEvents.Burned.selector) {
                assertEq(logs[i].topics[1], bytes32(uint256(4)));
                burnedSource4 = abi.decode(logs[i].data, (uint256));
            }
        }
    }

    function _params(bool zeroForOne, uint256 amountIn) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }

    function _settings() internal pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    function _ethOnly() internal pure returns (address[] memory q) {
        q = new address[](1);
    }
}
