// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";

import {AgentCoin} from "../../src/launch/AgentCoin.sol";
import {SpokeRouter} from "../../src/launch/SpokeRouter.sol";
import {LaunchBase} from "./utils/LaunchBase.sol";

/// @notice `SpokeRouter`: exact-in buys and sells for the web pages, a public caller to the hook (early window, launch fee),
/// holding nothing.
contract SpokeRouterTest is LaunchBase {
    using PoolIdLibrary for PoolKey;

    SpokeRouter internal router;

    function setUp() public override {
        super.setUp();
        router = new SpokeRouter(address(al));
        vm.prank(bob);
        orry.approve(address(router), type(uint256).max);
    }

    function test_wiring() public view {
        assertEq(router.poolManager(), address(PM));
        assertEq(router.orry(), address(orry));
        assertEq(address(router.launch()), address(al));
    }

    function test_buy_and_sell_round_trip() public {
        (address coin,) = _launchOpen(alice);
        uint256 rc0 = orry.balanceOf(bob);
        vm.prank(bob);
        uint256 coins = router.buy(coin, 10_000e18, 1, block.timestamp);
        assertEq(AgentCoin(coin).balanceOf(bob), coins);
        assertEq(rc0 - orry.balanceOf(bob), 10_000e18, "exact input");
        assertEq(hook.feesOf(_key(coin).toId()), 100e18, "public 1% after the decay");
        vm.startPrank(bob);
        AgentCoin(coin).approve(address(router), type(uint256).max);
        uint256 back = router.sell(coin, coins, 1, block.timestamp);
        vm.stopPrank();
        assertApproxEqRel(back, 9_801e18, 0.0001e18);
        assertEq(orry.balanceOf(address(router)), 0, "holds no ORRY");
        assertEq(AgentCoin(coin).balanceOf(address(router)), 0, "holds no coins");
    }

    function test_router_pays_the_launch_fee_and_is_refused_early() public {
        (uint256 id,) = _agent(alice);
        address coin = _launch(id, alice, 0);
        vm.prank(bob);
        vm.expectRevert();
        router.buy(coin, 1_000e18, 0, block.timestamp);
        _warp(EARLY);
        uint256 f0 = hook.feesOf(_key(coin).toId());
        vm.prank(bob);
        router.buy(coin, 1_000e18, 0, block.timestamp);
        assertEq(hook.feesOf(_key(coin).toId()) - f0, 800e18, "the router is a public caller");
    }

    function test_sells_open_in_the_early_window() public {
        (uint256 id,) = _agent(alice);
        address coin = _launch(id, alice, 10_000e18);
        vm.startPrank(alice);
        AgentCoin(coin).approve(address(router), type(uint256).max);
        uint256 out = router.sell(coin, AgentCoin(coin).balanceOf(alice) / 2, 1, block.timestamp);
        vm.stopPrank();
        assertGt(out, 0);
    }

    function test_guards() public {
        (address coin,) = _launchOpen(alice);
        vm.startPrank(bob);
        vm.expectRevert(SpokeRouter.DeadlinePassed.selector);
        router.buy(coin, 1e18, 0, block.timestamp - 1);
        vm.expectRevert(SpokeRouter.ZeroAmount.selector);
        router.buy(coin, 0, 0, block.timestamp);
        vm.expectRevert(SpokeRouter.UnknownCoin.selector);
        router.buy(address(0xBEEF), 1e18, 0, block.timestamp);
        (bool ok, bytes memory ret) =
            address(router).call(abi.encodeCall(SpokeRouter.buy, (coin, 1_000e18, type(uint256).max, block.timestamp)));
        assertFalse(ok);
        assertEq(bytes4(ret), SpokeRouter.SlippageExceeded.selector);
        vm.stopPrank();
        vm.expectRevert(SpokeRouter.NotPoolManager.selector);
        router.unlockCallback(abi.encode(coin, true, uint256(1), bob));
    }

    function test_cannot_spend_another_accounts_approval() public {
        (address coin,) = _launchOpen(alice);
        // bob approved the router; carol calls buy: carol pays, not bob
        uint256 bob0 = orry.balanceOf(bob);
        vm.prank(carol);
        vm.expectRevert(); // carol never approved the router
        router.buy(coin, 1_000e18, 0, block.timestamp);
        assertEq(orry.balanceOf(bob), bob0);
    }
}
