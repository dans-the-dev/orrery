// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {IOrryBuyback} from "../../../src/orry/interfaces/IOrryBuyback.sol";
import {IOrryRewardsRouter} from "../../../src/orry/interfaces/IOrryRewardsRouter.sol";
import {IOrryBurnEvents} from "../../../src/orry/interfaces/IOrryToken.sol";
import {MockERC20} from "../../mocks/Mocks.sol";
import {BuybackBase} from "./utils/StakeBase.sol";

/// @notice A quote token whose transfers can be switched off (an issuer freeze on the router or the buyback).
contract FreezableToken is MockERC20 {
    bool public frozen;

    constructor() MockERC20("Freezable", "FRZ", 18) {}

    function setFrozen(bool f) external {
        frozen = f;
    }

    function transfer(address to, uint256 a) external override returns (bool) {
        require(!frozen, "frozen");
        _move(msg.sender, to, a);
        return true;
    }
}

/// @notice Multi-pair hubs on the lane B side (R-35 to R-37, `docs/ORRY-PAIRS-B-INTERFACES.md`): the router forwards
/// registered quotes to the buyback (P-5), `buyWithQuote` buys ORRY in each quote's own hub within that hub's cap and
/// guard (B-1 to B-3 per hub), and the treasury slice takes the route rule.
contract PairsTest is BuybackBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant HUB_FEE = 10_000; // LP 8500 + hook 1500 pips, no PoolManager protocol fee locally

    MockERC20 internal xqt; // a quote registered after deployment (R-36)
    PoolKey internal xHubKey;

    function setUp() public override {
        super.setUp();
        _setCoin(address(buyback));
        _revenue(10_000e6); // reserve 9,000 USDG: 900 may leave today
        usdg.approve(address(lpRouter), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Registers XQT through the pair admin's proposal and the 48 hour delay, then opens its hub at about 448.6
    /// ORRY per XQT (1 XQT = 1 USD) with full-range liquidity.
    function _addXqtPair() internal {
        xqt = new MockERC20("Extra Quote", "XQT", 18);
        vm.prank(owner);
        hook.proposePair(address(xqt), address(0xfeed));
        vm.warp(_now() + 48 hours);
        vm.prank(owner);
        hook.executePair(address(xqt));
        xHubKey = hook.hubKey(address(xqt));
        bool xIs0 = Currency.unwrap(xHubKey.currency0) == address(xqt);
        pm.initialize(xHubKey, TickMath.getSqrtPriceAtTick(xIs0 ? int24(61000) : int24(-61000)));
        xqt.mint(address(this), 10_000_000e18);
        xqt.approve(address(lpRouter), type(uint256).max);
        xqt.approve(address(swapRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            xHubKey,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(200),
                tickUpper: TickMath.maxUsableTick(200),
                liquidityDelta: int256(uint256(2e24)), // about 94,000 XQT and 42 M ORRY
                salt: 0
            }),
            ""
        );
    }

    function _reserveIn(PoolKey memory key, bool zeroForOne) internal view returns (uint256) {
        (uint160 s,,,) = pm.getSlot0(key.toId());
        uint128 l = pm.getLiquidity(key.toId());
        return zeroForOne ? FullMath.mulDiv(l, Q96, s) : FullMath.mulDiv(l, s, Q96);
    }

    /// @dev Independent cap of a quote hub: 0.5 x fee x the quote side's virtual reserve.
    function _quoteCap(PoolKey memory key, address quote) internal view returns (uint256) {
        bool quoteIs0 = Currency.unwrap(key.currency0) == quote;
        return _reserveIn(key, quoteIs0) * HUB_FEE / 2e6;
    }

    function _ethPathCap() internal view returns (uint256) {
        uint256 cap1 = _reserveIn(usdgKey, false) * 500 / 2e6;
        uint160 s = _sqrtP(usdgKey);
        uint256 hubUsdg = FullMath.mulDiv(FullMath.mulDiv(_reserveIn(hubKey, true) * HUB_FEE / 2e6, s, Q96), s, Q96);
        return cap1 < hubUsdg ? cap1 : hubUsdg;
    }

    function _swapQuote(PoolKey memory key, address quote, uint256 amountIn) internal {
        bool zeroForOne = Currency.unwrap(key.currency0) == quote;
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ---------------------------------------------------------------- router (P-5)

    function test_router_forwards_registered_quotes_to_the_buyback() public {
        _addXqtPair();
        usdg.mint(address(router), 500e6);
        xqt.mint(address(router), 70e18);
        vm.expectEmit(address(router));
        emit IOrryRewardsRouter.QuoteForwarded(address(usdg), 500e6);
        vm.expectEmit(address(router));
        emit IOrryRewardsRouter.QuoteForwarded(address(xqt), 70e18);
        router.distribute();
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(xqt.balanceOf(address(router)), 0);
        assertEq(usdg.balanceOf(address(buyback)), 500e6);
        assertEq(xqt.balanceOf(address(buyback)), 70e18);
    }

    function test_router_splits_eth_and_orry_as_before_while_forwarding() public {
        usdg.mint(address(router), 100e6);
        vm.deal(address(router), 2 ether);
        orry.transfer(address(router), 1_000e18);
        uint256 supply = orry.totalSupply();
        router.distribute();
        assertEq(supply - orry.totalSupply(), 500e18, "half of the ORRY burned");
        assertEq(address(buyback).balance, 1 ether, "half of the ETH to the buyback");
        assertEq(usdg.balanceOf(address(buyback)), 100e6, "the quote forwarded whole");
    }

    function test_router_never_moves_a_token_that_is_not_a_quote() public {
        MockERC20 stray = new MockERC20("Stray", "STR", 18);
        stray.mint(address(router), 1e18);
        vm.expectRevert(IOrryRewardsRouter.NothingToDistribute.selector);
        router.distribute();
        orry.transfer(address(router), 10e18);
        router.distribute();
        assertEq(stray.balanceOf(address(router)), 1e18, "P-5: a stray token stays");
    }

    function test_router_skips_a_quote_whose_transfer_fails() public {
        FreezableToken frz = new FreezableToken();
        vm.prank(owner);
        hook.proposePair(address(frz), address(0xfeed));
        vm.warp(_now() + 48 hours);
        vm.prank(owner);
        hook.executePair(address(frz));
        frz.mint(address(router), 5e18);
        frz.setFrozen(true);
        usdg.mint(address(router), 10e6);
        router.distribute();
        assertEq(frz.balanceOf(address(router)), 5e18, "kept for the next call");
        assertEq(usdg.balanceOf(address(buyback)), 10e6, "the other quote still forwarded");
        // nothing else to do: a frozen quote alone is nothing to distribute
        vm.warp(_now() + 1 hours);
        vm.expectRevert(IOrryRewardsRouter.NothingToDistribute.selector);
        router.distribute();
        frz.setFrozen(false);
        router.distribute();
        assertEq(frz.balanceOf(address(buyback)), 5e18);
    }

    // ---------------------------------------------------------------- buyWithQuote (R-37, B per hub)

    function test_buy_with_usdg_in_the_usdg_hub_sends_orry_to_the_router() public {
        _initUsdgHub(2e18);
        usdg.mint(address(buyback), 1_000e6); // more than the hub cap (about 470 USDG)
        uint256 cap = _quoteCap(usdgHubKey, address(usdg));
        uint160 pre = _sqrtP(usdgHubKey);
        uint160 ethHubPre = _sqrtP(hubKey);
        assertLt(cap, 1_000e6);
        assertEq(buyback.maxQuoteIn(address(usdg)), cap);
        vm.recordLogs();
        uint256 out = buyback.buyWithQuote(address(usdg));
        uint256 spent = 1_000e6 - usdg.balanceOf(address(buyback));
        assertEq(spent, cap, "B-1: min(balance, cap)");
        assertEq(orry.balanceOf(address(router)), out, "ORRY to the router");
        assertEq(orry.balanceOf(address(buyback)), 0);
        uint160 post = _sqrtP(usdgHubKey);
        uint256 moved = post > pre ? post - pre : pre - post;
        assertLe(moved * 2e6, uint256(pre) * HUB_FEE, "B-2: at most half the fee");
        assertEq(_sqrtP(hubKey), ethHubPre, "the ETH hub is untouched");
        assertEq(buyback.lastQuoteBuyAt(address(usdg)), _now());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(buyback) && logs[i].topics[0] == IOrryBuyback.QuoteSwapped.selector) {
                seen = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), address(usdg));
                (uint256 qIn, uint256 rOut) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(qIn, spent);
                assertEq(rOut, out);
            }
        }
        assertTrue(seen, "QuoteSwapped");
    }

    function test_buy_with_a_pair_added_after_deployment() public {
        _addXqtPair();
        xqt.mint(address(buyback), 50e18);
        uint256 out = buyback.buyWithQuote(address(xqt));
        assertGt(out, 0);
        assertEq(xqt.balanceOf(address(buyback)), 0, "50 XQT is under the cap");
        assertEq(orry.balanceOf(address(router)), out);
    }

    function test_buy_with_quote_refusals() public {
        _initUsdgHub(2e18);
        vm.expectRevert(IOrryBuyback.NotAQuote.selector);
        buyback.buyWithQuote(address(0));
        vm.expectRevert(IOrryBuyback.NotAQuote.selector);
        buyback.buyWithQuote(address(orry));
        MockERC20 stray = new MockERC20("Stray", "STR", 18);
        vm.expectRevert(IOrryBuyback.NotAQuote.selector);
        buyback.buyWithQuote(address(stray));
        assertEq(buyback.maxQuoteIn(address(stray)), 0);
        vm.expectRevert(IOrryBuyback.NothingToBuy.selector);
        buyback.buyWithQuote(address(usdg)); // no balance
        usdg.mint(address(buyback), 10e6);
        buyback.buyWithQuote(address(usdg));
        usdg.mint(address(buyback), 10e6);
        vm.expectRevert(abi.encodeWithSelector(IOrryBuyback.TooSoon.selector, uint64(_now() + 1 hours)));
        buyback.buyWithQuote(address(usdg));
        vm.warp(_now() + 1 hours);
        buyback.buyWithQuote(address(usdg));
    }

    function test_buy_with_quote_needs_an_initialized_hub() public {
        // the USDG pair is registered at launch but its hub is not initialized here
        usdg.mint(address(buyback), 10e6);
        assertEq(buyback.maxQuoteIn(address(usdg)), 0);
        vm.expectRevert(IOrryBuyback.NothingToBuy.selector);
        buyback.buyWithQuote(address(usdg));
    }

    function test_interval_is_per_quote() public {
        _initUsdgHub(2e18);
        _addXqtPair();
        usdg.mint(address(buyback), 10e6);
        xqt.mint(address(buyback), 10e18);
        buyback.buyWithQuote(address(usdg));
        buyback.buyWithQuote(address(xqt)); // not blocked by the USDG buy
    }

    function test_same_block_guard_is_per_hub() public {
        _initUsdgHub(2e18);
        usdg.mint(address(buyback), 100e6);
        vm.roll(vm.getBlockNumber() + 1);
        // a 3% push of the ETH hub in this block does not stop a USDG-hub buy
        _swap(hubKey, true, 3 ether);
        buyback.buyWithQuote(address(usdg));
        // a push of the USDG hub itself does
        vm.warp(_now() + 1 hours);
        vm.roll(vm.getBlockNumber() + 1);
        usdg.mint(address(buyback), 100e6);
        _swapQuote(usdgHubKey, address(usdg), 3_000e6);
        vm.expectRevert(IOrryBuyback.PriceMovedInBlock.selector);
        buyback.buyWithQuote(address(usdg));
    }

    function test_full_loop_hub_fees_become_orry_split_by_the_router() public {
        _initUsdgHub(4e18);
        // trading in the USDG hub leaves USDG and ORRY fee claims in the hook
        usdg.mint(address(this), 10_000e6);
        usdg.approve(address(swapRouter), type(uint256).max);
        _swapQuote(usdgHubKey, address(usdg), 5_000e6);
        uint256 feeUsdg = hook.pendingProtocolFee(address(usdg));
        assertEq(feeUsdg, 0, "a USDG-in swap pays its hook fee in ORRY (unspecified side)");
        uint256 feeRc = hook.pendingProtocolFee(address(orry));
        assertGt(feeRc, 0);
        // the other direction pays USDG
        orry.approve(address(swapRouter), type(uint256).max);
        bool usdgIs0 = Currency.unwrap(usdgHubKey.currency0) == address(usdg);
        swapRouter.swap(
            usdgHubKey,
            SwapParams({
                zeroForOne: !usdgIs0,
                amountSpecified: -int256(1_000_000e18),
                sqrtPriceLimitX96: !usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        feeUsdg = hook.pendingProtocolFee(address(usdg));
        assertGt(feeUsdg, 0);
        hook.collect();
        // P-4 at the router, P-5 onward
        router.distribute();
        assertEq(usdg.balanceOf(address(buyback)), feeUsdg);
        vm.roll(vm.getBlockNumber() + 1);
        uint256 out = buyback.buyWithQuote(address(usdg));
        assertEq(orry.balanceOf(address(router)), out);
        vm.warp(_now() + 1 hours);
        uint256 supply = orry.totalSupply();
        router.distribute();
        assertEq(supply - orry.totalSupply(), out - out * 5000 / 10_000, "half of the bought ORRY burned");
    }

    // ---------------------------------------------------------------- treasury slice route rule

    function test_slice_takes_the_eth_path_while_the_usdg_hub_is_not_open() public {
        assertFalse(buyback.sliceViaUsdgHub());
        vm.recordLogs();
        buyback.executeSlice();
        (,, uint256 ethMid,) = _sliceEvent();
        assertGt(ethMid, 0, "two hops");
    }

    function test_slice_takes_the_eth_path_when_the_usdg_hub_is_shallower() public {
        _initUsdgHub(2e18);
        assertLt(_quoteCap(usdgHubKey, address(usdg)), _ethPathCap());
        assertFalse(buyback.sliceViaUsdgHub());
        uint160 usdgHubPre = _sqrtP(usdgHubKey);
        vm.recordLogs();
        buyback.executeSlice();
        (,, uint256 ethMid,) = _sliceEvent();
        assertGt(ethMid, 0);
        assertEq(_sqrtP(usdgHubKey), usdgHubPre, "the USDG hub is untouched");
    }

    function test_slice_goes_direct_through_a_deeper_usdg_hub() public {
        _initUsdgHub(4e18);
        uint256 directCap = _quoteCap(usdgHubKey, address(usdg));
        assertGe(directCap, _ethPathCap());
        assertTrue(buyback.sliceViaUsdgHub());
        uint256 expected = treasury.availableForBuyback();
        if (directCap < expected) expected = directCap;
        if (1_000e6 < expected) expected = 1_000e6;
        assertEq(buyback.maxSliceUsdg(), expected);
        uint160 hop1Pre = _sqrtP(usdgKey);
        uint160 ethHubPre = _sqrtP(hubKey);
        uint160 pre = _sqrtP(usdgHubKey);
        vm.recordLogs();
        uint256 out = buyback.executeSlice();
        (bool seen, uint256 usdgIn, uint256 ethMid, uint256 orryOut) = _sliceEvent();
        assertTrue(seen);
        assertEq(usdgIn, expected);
        assertEq(ethMid, 0, "one hop");
        assertEq(orryOut, out);
        assertEq(orry.balanceOf(address(router)), out);
        assertEq(_sqrtP(usdgKey), hop1Pre, "hop 1 pools untouched");
        assertEq(_sqrtP(hubKey), ethHubPre, "the ETH hub untouched");
        uint160 post = _sqrtP(usdgHubKey);
        assertLe((post > pre ? post - pre : pre - post) * 2e6, uint256(pre) * HUB_FEE, "B-2 on the USDG hub");
    }

    function test_direct_slice_is_capped_at_the_constructor_cap() public {
        _initUsdgHub(40e18); // cap about 9,400 USDG
        _revenue(1_000_000e6);
        assertEq(buyback.maxSliceUsdg(), 1_000e6, "maxSliceUsdgCap holds on the direct route");
    }

    function test_direct_slice_uses_the_usdg_hub_guard() public {
        _initUsdgHub(4e18);
        vm.roll(vm.getBlockNumber() + 1);
        _swap(hubKey, true, 3 ether); // the ETH hub moved: irrelevant on the direct route
        buyback.executeSlice();
        vm.warp(_now() + 1 days); // a new daily pull window
        vm.roll(vm.getBlockNumber() + 1);
        assertGt(buyback.maxSliceUsdg(), 0);
        usdg.mint(address(this), 10_000e6);
        usdg.approve(address(swapRouter), type(uint256).max);
        _swapQuote(usdgHubKey, address(usdg), 5_000e6);
        vm.expectRevert(IOrryBuyback.PriceMovedInBlock.selector);
        buyback.executeSlice();
    }

    function _sliceEvent() internal returns (bool seen, uint256 usdgIn, uint256 ethMid, uint256 orryOut) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(buyback) && logs[i].topics[0] == IOrryBuyback.SliceExecuted.selector) {
                (usdgIn, ethMid, orryOut) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                seen = true;
            }
        }
    }
}
