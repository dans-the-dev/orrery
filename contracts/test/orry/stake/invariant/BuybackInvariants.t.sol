// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";

import {BuybackBase} from "../utils/StakeBase.sol";
import {BuybackHandler} from "./BuybackHandler.sol";

/// @notice Invariant campaign and deterministic deep run for OrryBuyback on the 4663 PoolManager runtime (local), with
/// the ETH and USDG hubs open (R-35): B-1 to B-3 per hub, P-5, the slice route rule, the buyback holding no ORRY and
/// only the forwarded quote USDG between calls, T-1 and G-2.
contract BuybackInvariants is BuybackBase {
    BuybackHandler internal h;

    function setUp() public override {
        super.setUp();
        _setCoin(address(buyback));
        _initUsdgHub(3e18); // cap about 700 USDG, near the ETH path's: the route flips as liquidity and trades move
        h = new BuybackHandler(
            buyback,
            treasury,
            router,
            hook,
            pm,
            swapRouter,
            usdg,
            orry,
            usdgKey,
            hubKey,
            usdgHubKey,
            lpRouter,
            3e18,
            vm.getBlockTimestamp()
        );
        orry.transfer(address(h), 200_000_000e18);
        h.init();
        vm.prank(alice);
        staking.stake(1_000_000e18); // so distribute has stakers
        _revenue(50_000e6);
        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](14);
        sels[0] = h.revenue.selector;
        sels[1] = h.slice.selector;
        sels[2] = h.burn.selector;
        sels[3] = h.sendEth.selector;
        sels[4] = h.trade.selector;
        sels[5] = h.collectDistribute.selector;
        sels[6] = h.warp.selector;
        sels[7] = h.slice.selector;
        sels[8] = h.buyUsdg.selector;
        sels[9] = h.quoteFee.selector;
        sels[10] = h.tradeUsdgHub.selector;
        sels[11] = h.usdgHubLp.selector;
        sels[12] = h.buyUsdg.selector;
        sels[13] = h.cashbackSink.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    function invariant_B1_at_most_hourly() public view {
        assertFalse(h.badB1(), "B-1");
    }

    function invariant_B2_half_fee_move_per_hop() public view {
        assertFalse(h.badB2(), "B-2");
    }

    function invariant_B3_bought_orry_reaches_router_or_burn() public view {
        assertFalse(h.badB3(), "B-3");
        assertEq(usdg.balanceOf(address(buyback)), h.ghostQuoteHeld(), "buyback holds only the forwarded quote USDG");
        assertEq(orry.balanceOf(address(buyback)), 0, "buyback holds no ORRY");
        assertEq(orry.balanceOf(h.SINK()), h.cashbackPaid(), "B-1: the sink holds exactly the cashback");
    }

    function invariant_P5_and_route_rule() public view {
        assertFalse(h.badP5(), "P-5");
        assertFalse(h.badRoute(), "route rule");
    }

    function invariant_T1_and_G2() public view {
        assertLe(treasury.ownerAccrued() + treasury.buybackReserve(), usdg.balanceOf(address(treasury)), "T-1");
        assertFalse(h.badSupplyUp(), "G-2");
    }

    function test_deep_run_buyback() public {
        uint256 seed = 0xb0b;
        for (uint256 step; step < 1_500; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 a = seed;
            uint256 b = seed >> 64;
            uint256 pick = seed % 100;
            if (pick < 10) h.revenue(b);
            else if (pick < 22) h.slice();
            else if (pick < 29) h.burn();
            else if (pick < 34) h.sendEth(b);
            else if (pick < 52) h.trade(a % 2 == 0, (a >> 8) % 2 == 0, b);
            else if (pick < 58) h.collectDistribute();
            else if (pick < 64) h.buyUsdg();
            else if (pick < 68) h.quoteFee(b);
            else if (pick < 76) h.tradeUsdgHub(a % 2 == 0, b);
            else if (pick < 80) h.usdgHubLp(a % 2 == 0);
            else if (pick < 81) h.cashbackSink();
            else h.warp(b % 2 hours, a % 3);
            assertFalse(h.badB1(), "B-1");
            assertFalse(h.badB2(), "B-2");
            assertFalse(h.badB3(), "B-3");
            assertFalse(h.badSupplyUp(), "G-2");
            assertFalse(h.badP5(), "P-5");
            assertFalse(h.badRoute(), "route rule");
            assertEq(usdg.balanceOf(address(buyback)), h.ghostQuoteHeld());
            assertEq(orry.balanceOf(address(buyback)), 0);
        }
        string[12] memory names = [
            "revenue",
            "slice",
            "burn",
            "sendEth",
            "tradeHub",
            "tradeUsdg",
            "distribute",
            "warp",
            "tooSoon",
            "movedInBlock",
            "nothingToBuy",
            "slippage"
        ];
        for (uint256 i; i < names.length; ++i) {
            uint256 n = h.calls(bytes32(bytes(names[i])));
            console2.log(names[i], n);
            if (i < 10) assertGt(n, 0, names[i]);
        }
        console2.log("other reverts", h.calls("otherRevert"));
        console2.log("USDG spent / ORRY to router / ORRY burned", h.usdgSpent(), h.orryToRouter(), h.orryBurnedByBuyback());
        console2.log("largest move ppm of sqrtP: hop 1 (bound 250) / hub (bound 5000)", h.maxHop1MovePpm(), h.maxHubMovePpm());
        console2.log("largest USDG hub move ppm (bound 5000)", h.maxUsdgHubMovePpm());
        console2.log("slices direct / via ETH", h.directSlices(), h.ethPathSlices());
        console2.log("quote buys / distributes that forwarded USDG", h.quoteBuys(), h.quoteForwarded());
        assertGt(h.directSlices(), 0, "direct route reached");
        assertGt(h.ethPathSlices(), 0, "ETH path reached");
        assertGt(h.quoteBuys(), 0, "quote buys reached");
        console2.log("cashback sink set / ORRY paid to it", h.calls("sinkSet"), h.cashbackPaid());
        assertGt(h.calls("sinkSet"), 0, "the sink was set during the run");
        assertGt(h.cashbackPaid(), 0, "cashback paid after the sink was set");
    }
}
