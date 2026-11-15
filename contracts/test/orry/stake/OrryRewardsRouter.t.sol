// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOrryRewardsRouter} from "../../../src/orry/interfaces/IOrryRewardsRouter.sol";
import {IOrryBurnEvents} from "../../../src/orry/interfaces/IOrryToken.sol";
import {OrryRewardsRouter} from "../../../src/orry/OrryRewardsRouter.sol";
import {OrryStaking} from "../../../src/orry/OrryStaking.sol";
import {TestHubHook} from "./utils/TestHubHook.sol";
import {StakeBase} from "./utils/StakeBase.sol";
import {MockOrry, RejectEth} from "./utils/StakeMocks.sol";

contract OrryRewardsRouterTest is StakeBase {
    function setUp() public override {
        super.setUp();
        vm.prank(alice);
        staking.stake(1_000e18);
    }

    function _fund(uint256 eth, uint256 rc) internal {
        vm.deal(address(router), address(router).balance + eth);
        orry.transfer(address(router), rc);
    }

    function test_constructor_values_and_checks() public {
        assertEq(router.STAKERS_BPS(), 5000);
        assertEq(router.MIN_INTERVAL(), 1 hours);
        assertEq(router.orry(), address(orry));
        assertEq(router.staking(), address(staking));
        assertEq(router.buyback(), buybackAddr);
        assertEq(router.lastDistributionAt(), 0);
        address h = router.hook();
        _ctorReverts(address(orry), buybackAddr, h, 10_001, 1 hours, "bps above 10000");
        _ctorReverts(address(orry), address(0), h, 5000, 1 hours, "zero address");
        _ctorReverts(address(orry), buybackAddr, h, 5000, 0, "zero interval");
        MockOrry other = new MockOrry(address(this), 1e18);
        _ctorReverts(address(other), buybackAddr, h, 5000, 1 hours, "staking token");
        _ctorReverts(address(orry), buybackAddr, address(0), 5000, 1 hours, "zero address");
        // a hook of another token
        address[] memory none = new address[](0);
        TestHubHook otherHook =
            new TestHubHook(address(0xdead), address(other), address(0), 8500, 1500, 200, address(treasury), owner, none);
        _ctorReverts(address(orry), buybackAddr, address(otherHook), 5000, 1 hours, "hook token");
        assertEq(router.hook(), h);
    }

    /// @dev try/catch rather than expectRevert: with dynamic test linking and isolate (the effective forge config) a
    /// `new` becomes `vm.deployCode`, and an expected revert there ends the test, so later checks would never run.
    function _ctorReverts(address r, address bb, address h, uint16 bps, uint64 interval, string memory why) internal {
        try new OrryRewardsRouter(r, address(staking), bb, h, bps, interval) returns (OrryRewardsRouter) {
            revert("constructor did not revert");
        } catch Error(string memory reason) {
            assertEq(reason, why);
        }
    }

    function test_nothing_to_distribute() public {
        vm.expectRevert(IOrryRewardsRouter.NothingToDistribute.selector);
        router.distribute();
    }

    /// RR-1 and RR-2 on odd amounts: exact floor split, nothing left in the router.
    function test_distribute_splits_exactly() public {
        uint256 eth = 3 ether + 7;
        uint256 rc = 1_000e18 + 3;
        _fund(eth, rc);
        uint256 supply = orry.totalSupply();
        uint256 sinkBefore = buybackAddr.balance;
        uint256 stakingEth = address(staking).balance;
        uint256 stakingRc = orry.balanceOf(address(staking));
        uint256 ethSt = eth * 5000 / 10_000;
        uint256 rcSt = rc * 5000 / 10_000;

        vm.expectEmit(address(router));
        emit IOrryBurnEvents.Burned(1, rc - rcSt);
        vm.expectEmit(address(router));
        emit IOrryRewardsRouter.Distributed(ethSt, rcSt, eth - ethSt, rc - rcSt);
        router.distribute();

        assertEq(address(router).balance, 0, "RR-1 eth");
        assertEq(orry.balanceOf(address(router)), 0, "RR-1 orry");
        assertEq(address(staking).balance - stakingEth, ethSt, "RR-2 eth to stakers");
        assertEq(orry.balanceOf(address(staking)) - stakingRc, rcSt, "RR-2 orry to stakers");
        assertEq(buybackAddr.balance - sinkBefore, eth - ethSt, "RR-2 eth to buyback");
        assertEq(supply - orry.totalSupply(), rc - rcSt, "RR-2 orry burned");
        assertEq(orry.allowance(address(router), address(staking)), 0);
        assertEq(router.lastDistributionAt(), _now());
    }

    function test_distribute_at_most_once_per_interval() public {
        _fund(1 ether, 0);
        router.distribute();
        _fund(1 ether, 0);
        uint64 next = uint64(_now() + 1 hours);
        vm.warp(next - 1);
        vm.expectRevert(abi.encodeWithSelector(IOrryRewardsRouter.TooSoon.selector, next));
        router.distribute();
        vm.warp(next);
        router.distribute();
        assertEq(address(router).balance, 0);
    }

    function test_distribute_eth_only_and_orry_only() public {
        _fund(2 ether, 0);
        router.distribute();
        assertEq(address(router).balance, 0);
        vm.warp(_now() + 1 hours);
        _fund(0, 10e18);
        uint256 supply = orry.totalSupply();
        router.distribute();
        assertEq(orry.balanceOf(address(router)), 0);
        assertEq(supply - orry.totalSupply(), 5e18);
    }

    function test_dust_skips_notify() public {
        _fund(1, 1);
        uint256 stakingEth = address(staking).balance;
        router.distribute(); // stakers' parts round to zero; notify would revert ZeroAmount
        assertEq(address(staking).balance, stakingEth);
        assertEq(buybackAddr.balance, 1);
        assertEq(orry.balanceOf(address(router)), 0);
    }

    function test_all_to_stakers_and_all_burned() public {
        OrryRewardsRouter allStake = new OrryRewardsRouter(address(orry), address(staking), buybackAddr, router.hook(), 10_000, 1 hours);
        vm.deal(address(allStake), 1 ether);
        orry.transfer(address(allStake), 4e18);
        allStake.distribute();
        assertEq(buybackAddr.balance, 0);
        OrryRewardsRouter allBurn = new OrryRewardsRouter(address(orry), address(staking), buybackAddr, router.hook(), 0, 1 hours);
        vm.deal(address(allBurn), 1 ether);
        orry.transfer(address(allBurn), 4e18);
        uint256 supply = orry.totalSupply();
        uint256 stakingEth = address(staking).balance;
        allBurn.distribute();
        assertEq(address(staking).balance, stakingEth);
        assertEq(supply - orry.totalSupply(), 4e18);
        assertEq(buybackAddr.balance, 1 ether);
    }

    function test_buyback_refusing_eth_reverts() public {
        RejectEth rej = new RejectEth();
        OrryRewardsRouter r = new OrryRewardsRouter(address(orry), address(staking), address(rej), router.hook(), 5000, 1 hours);
        vm.deal(address(r), 1 ether);
        vm.expectRevert(IOrryRewardsRouter.EthTransferFailed.selector);
        r.distribute();
    }

    function test_stakers_receive_the_router_part() public {
        _fund(2 ether, 200e18);
        router.distribute();
        vm.warp(_now() + 7 days);
        (uint256 e, uint256 r) = staking.pendingRewards(alice);
        assertApproxEqAbs(e, 1 ether, 7 days);
        assertApproxEqAbs(r, 100e18, 7 days);
    }

    function test_accepts_eth_from_anyone() public {
        (bool ok,) = address(router).call{value: 1}("");
        assertTrue(ok);
    }
}
