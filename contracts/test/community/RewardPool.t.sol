// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommunityBase} from "./utils/CommunityBase.sol";
import {RewardPool} from "../../src/community/RewardPool.sol";
import {IRewardPool} from "../../src/community/interfaces/IRewardPool.sol";
import {FeeOrry, RejectEth} from "../orry/stake/utils/StakeMocks.sol";

contract RewardPoolTest is CommunityBase {
    bytes32 internal constant RULES = keccak256("most active, 7 days, fees paid");

    function _event(uint256 amount) internal returns (uint256 id) {
        vm.prank(admin);
        id = pool.createEvent(address(orry), amount, uint64(block.timestamp + 7 days), 1, RULES);
    }

    function _one(address w, uint256 a) internal pure returns (address[] memory ws, uint256[] memory as_) {
        ws = new address[](1);
        as_ = new uint256[](1);
        (ws[0], as_[0]) = (w, a);
    }

    function _two(address w1, uint256 a1, address w2, uint256 a2)
        internal
        pure
        returns (address[] memory ws, uint256[] memory as_)
    {
        ws = new address[](2);
        as_ = new uint256[](2);
        (ws[0], as_[0], ws[1], as_[1]) = (w1, a1, w2, a2);
    }

    // ------------------------------------------------------------------ constructor and funding

    function test_constructor_guards() public {
        vm.expectRevert(RewardPool.ZeroAddress.selector);
        new RewardPool(address(0), address(1), admin, 2500, 48 hours);
        vm.expectRevert(RewardPool.ZeroAddress.selector);
        new RewardPool(address(orry), address(0), admin, 2500, 48 hours);
        vm.expectRevert(RewardPool.ZeroAddress.selector);
        new RewardPool(address(orry), address(1), address(0), 2500, 48 hours);
        vm.expectRevert("lock bps");
        new RewardPool(address(orry), address(1), admin, 0, 48 hours);
        vm.expectRevert("lock bps");
        new RewardPool(address(orry), address(1), admin, 10_001, 48 hours);
        vm.expectRevert("check window");
        new RewardPool(address(orry), address(1), admin, 2500, 0);
        vm.expectRevert("check window");
        new RewardPool(address(orry), address(1), admin, 2500, 31 days);
        assertEq(pool.MAX_LOCK_BPS(), 2500);
        assertEq(pool.CHECK_WINDOW(), 48 hours);
        assertEq(pool.admin(), admin);
        assertEq(pool.orry(), address(orry));
        assertEq(pool.achievements(), address(ach));
    }

    function test_fund_books_exact_and_emits() public {
        vm.expectEmit(true, true, false, true, address(pool));
        emit IRewardPool.Funded(address(orry), alice, 1000e18);
        vm.prank(alice);
        pool.fund(address(orry), 1000e18);
        assertEq(pool.freeBalance(address(orry)), 1000e18);
        assertEq(orry.balanceOf(address(pool)), 1000e18);
    }

    function test_fund_reverts() public {
        vm.prank(alice);
        vm.expectRevert(IRewardPool.ZeroAmount.selector);
        pool.fund(address(orry), 0);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(IRewardPool.EthAmountMismatch.selector);
        pool.fund{value: 1}(address(orry), 5);
        vm.prank(alice);
        vm.expectRevert(IRewardPool.EthAmountMismatch.selector);
        pool.fund{value: 1}(address(0), 2);
        FeeOrry fee = new FeeOrry(alice, 1e24);
        vm.startPrank(alice);
        fee.approve(address(pool), type(uint256).max);
        vm.expectRevert(IRewardPool.InexactTransfer.selector);
        pool.fund(address(fee), 1000e18);
        vm.stopPrank();
    }

    function test_fund_eth_and_sync() public {
        vm.deal(alice, 3 ether);
        vm.prank(alice);
        pool.fund{value: 1 ether}(address(0), 1 ether);
        assertEq(pool.freeBalance(address(0)), 1 ether);
        vm.prank(alice);
        (bool ok,) = address(pool).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(pool.sync(address(0)), 2 ether);
        assertEq(pool.freeBalance(address(0)), 3 ether);
        assertEq(pool.sync(address(0)), 0);
        vm.prank(alice);
        orry.transfer(address(pool), 7e18);
        vm.expectEmit(true, true, false, true, address(pool));
        emit IRewardPool.Funded(address(orry), bob, 7e18);
        vm.prank(bob);
        assertEq(pool.sync(address(orry)), 7e18);
    }

    // ------------------------------------------------------------------ events

    function test_createEvent_cap_and_books() public {
        _fundPool(1000e18);
        assertEq(pool.lockCap(address(orry)), 250e18);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(RewardPool.AboveLockCap.selector, 250e18 + 1, 250e18));
        pool.createEvent(address(orry), 250e18 + 1, uint64(block.timestamp + 1 days), 1, RULES);
        uint256 id = _event(250e18);
        assertEq(id, 1);
        assertEq(pool.freeBalance(address(orry)), 750e18);
        assertEq(pool.lockedBalance(address(orry)), 250e18);
        RewardPool.PoolEvent memory e = pool.eventOf(id);
        assertEq(e.amount, 250e18);
        assertEq(e.rulesHash, RULES);
        assertEq(uint8(e.status), uint8(RewardPool.Status.Open));
        // the cap follows the free balance that is left
        assertEq(pool.lockCap(address(orry)), 187.5e18);
    }

    function test_createEvent_guards() public {
        _fundPool(1000e18);
        vm.prank(alice);
        vm.expectRevert(RewardPool.NotAdmin.selector);
        pool.createEvent(address(orry), 1, uint64(block.timestamp + 1 days), 1, RULES);
        vm.startPrank(admin);
        vm.expectRevert(IRewardPool.ZeroAmount.selector);
        pool.createEvent(address(orry), 0, uint64(block.timestamp + 1 days), 1, RULES);
        vm.expectRevert(RewardPool.BadDeadline.selector);
        pool.createEvent(address(orry), 1, uint64(block.timestamp), 1, RULES);
        vm.expectRevert(RewardPool.BadDeadline.selector);
        pool.createEvent(address(orry), 1, uint64(block.timestamp + 365 days + 1), 1, RULES);
        pool.createEvent(address(orry), 1, uint64(block.timestamp + 365 days), 1, RULES);
        vm.expectRevert(abi.encodeWithSelector(RewardPool.AboveLockCap.selector, 1, 0));
        pool.createEvent(address(usdg), 1, uint64(block.timestamp + 1 days), 1, RULES);
        vm.stopPrank();
    }

    function test_publish_window_and_claim() public {
        _fundPool(1000e18);
        uint256 id = _event(200e18);
        (address[] memory ws, uint256[] memory as_) = _two(alice, 120e18, bob, 50e18);
        vm.prank(admin);
        pool.publishWinners(id, ws, as_);
        // 30 returned to the free balance at once
        assertEq(pool.freeBalance(address(orry)), 830e18);
        assertEq(pool.lockedBalance(address(orry)), 170e18);
        RewardPool.PoolEvent memory e = pool.eventOf(id);
        assertEq(e.amount, 170e18);
        assertEq(e.payableAt, block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(RewardPool.NotPayableYet.selector, e.payableAt));
        vm.prank(alice);
        pool.claim(id);
        vm.warp(e.payableAt);
        uint256 before = orry.balanceOf(alice);
        vm.prank(alice);
        assertEq(pool.claim(id), 120e18);
        assertEq(orry.balanceOf(alice) - before, 120e18);
        vm.prank(alice);
        vm.expectRevert(RewardPool.NothingToClaim.selector);
        pool.claim(id);
        vm.prank(carol);
        vm.expectRevert(RewardPool.NothingToClaim.selector);
        pool.claim(id);
        // anyone pays bob to bob
        before = orry.balanceOf(bob);
        vm.prank(carol);
        pool.claimFor(id, bob);
        assertEq(orry.balanceOf(bob) - before, 50e18);
        assertEq(pool.lockedBalance(address(orry)), 0);
        assertEq(pool.eventOf(id).paid, 170e18);
    }

    function test_publish_guards() public {
        _fundPool(1000e18);
        uint256 id = _event(100e18);
        (address[] memory ws, uint256[] memory as_) = _one(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(RewardPool.NotAdmin.selector);
        pool.publishWinners(id, ws, as_);
        vm.startPrank(admin);
        vm.expectRevert(RewardPool.BadStatus.selector);
        pool.publishWinners(99, ws, as_);
        (address[] memory w2, uint256[] memory a2) = _two(alice, 10e18, alice, 10e18);
        vm.expectRevert(RewardPool.BadWinners.selector);
        pool.publishWinners(id, w2, a2);
        (w2, a2) = _two(alice, 10e18, address(0), 10e18);
        vm.expectRevert(RewardPool.BadWinners.selector);
        pool.publishWinners(id, w2, a2);
        (w2, a2) = _two(alice, 10e18, bob, 0);
        vm.expectRevert(RewardPool.BadWinners.selector);
        pool.publishWinners(id, w2, a2);
        vm.expectRevert(RewardPool.BadWinners.selector);
        pool.publishWinners(id, new address[](0), new uint256[](0));
        vm.expectRevert(RewardPool.BadWinners.selector);
        pool.publishWinners(id, ws, new uint256[](2));
        (w2, a2) = _two(alice, 60e18, bob, 40e18 + 1);
        vm.expectRevert(RewardPool.AboveLocked.selector);
        pool.publishWinners(id, w2, a2);
        address[] memory many = new address[](101);
        uint256[] memory amts = new uint256[](101);
        for (uint256 i; i < 101; ++i) {
            many[i] = address(uint160(1000 + i));
            amts[i] = 1;
        }
        vm.expectRevert(RewardPool.BadWinners.selector);
        pool.publishWinners(id, many, amts);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(RewardPool.PastDeadline.selector);
        pool.publishWinners(id, ws, as_);
        vm.stopPrank();
    }

    function test_publish_exactly_max_winners() public {
        _fundPool(1000e18);
        uint256 id = _event(100e18);
        address[] memory many = new address[](100);
        uint256[] memory amts = new uint256[](100);
        for (uint256 i; i < 100; ++i) {
            many[i] = address(uint160(1000 + i));
            amts[i] = 1e18;
        }
        vm.prank(admin);
        pool.publishWinners(id, many, amts);
        assertEq(pool.winnersOf(id).length, 100);
    }

    function test_replace_once_restarts_window() public {
        _fundPool(1000e18);
        uint256 id = _event(100e18);
        (address[] memory ws, uint256[] memory as_) = _two(alice, 60e18, bob, 40e18);
        vm.prank(admin);
        pool.publishWinners(id, ws, as_);
        vm.warp(block.timestamp + 47 hours);
        (address[] memory w2, uint256[] memory a2) = _two(carol, 50e18, bob, 30e18);
        vm.prank(alice);
        vm.expectRevert(RewardPool.NotAdmin.selector);
        pool.replaceWinners(id, w2, a2);
        vm.prank(admin);
        pool.replaceWinners(id, w2, a2);
        assertEq(pool.prizeOf(id, alice), 0);
        assertEq(pool.prizeOf(id, carol), 50e18);
        assertEq(pool.prizeOf(id, bob), 30e18);
        assertEq(pool.freeBalance(address(orry)), 920e18);
        RewardPool.PoolEvent memory e = pool.eventOf(id);
        assertEq(e.payableAt, block.timestamp + 48 hours);
        assertTrue(e.replaced);
        vm.prank(admin);
        vm.expectRevert(RewardPool.AlreadyReplaced.selector);
        pool.replaceWinners(id, w2, a2);
        vm.warp(e.payableAt);
        vm.prank(alice);
        vm.expectRevert(RewardPool.NothingToClaim.selector);
        pool.claim(id);
        vm.prank(carol);
        pool.claim(id);
    }

    function test_replace_guards() public {
        _fundPool(1000e18);
        uint256 id = _event(100e18);
        (address[] memory ws, uint256[] memory as_) = _one(alice, 60e18);
        vm.prank(admin);
        vm.expectRevert(RewardPool.BadStatus.selector);
        pool.replaceWinners(id, ws, as_);
        vm.prank(admin);
        pool.publishWinners(id, ws, as_);
        (address[] memory w2, uint256[] memory a2) = _one(bob, 60e18 + 1);
        vm.prank(admin);
        vm.expectRevert(RewardPool.AboveLocked.selector);
        pool.replaceWinners(id, w2, a2);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        vm.expectRevert(RewardPool.WindowClosed.selector);
        pool.replaceWinners(id, ws, as_);
    }

    function test_expire_returns_to_free_not_admin() public {
        _fundPool(1000e18);
        uint256 id = _event(250e18);
        vm.expectRevert(RewardPool.DeadlineNotReached.selector);
        pool.expire(id);
        vm.warp(block.timestamp + 7 days);
        uint256 adminBefore = orry.balanceOf(admin);
        vm.prank(carol);
        pool.expire(id);
        assertEq(pool.freeBalance(address(orry)), 1000e18);
        assertEq(pool.lockedBalance(address(orry)), 0);
        assertEq(orry.balanceOf(admin), adminBefore);
        vm.expectRevert(RewardPool.BadStatus.selector);
        pool.expire(id);
        (address[] memory ws, uint256[] memory as_) = _one(alice, 1e18);
        vm.prank(admin);
        vm.expectRevert(RewardPool.BadStatus.selector);
        pool.publishWinners(id, ws, as_);
    }

    function test_expire_refused_after_publish() public {
        _fundPool(1000e18);
        uint256 id = _event(100e18);
        (address[] memory ws, uint256[] memory as_) = _one(alice, 100e18);
        vm.prank(admin);
        pool.publishWinners(id, ws, as_);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(RewardPool.BadStatus.selector);
        pool.expire(id);
    }

    function test_eth_event_claimTo_for_contract_winner() public {
        vm.deal(admin, 10 ether);
        vm.prank(admin);
        pool.fund{value: 4 ether}(address(0), 4 ether);
        vm.prank(admin);
        uint256 id = pool.createEvent(address(0), 1 ether, uint64(block.timestamp + 1 days), 2, RULES);
        RejectEth rejector = new RejectEth();
        (address[] memory ws, uint256[] memory as_) = _one(address(rejector), 1 ether);
        vm.prank(admin);
        pool.publishWinners(id, ws, as_);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(RewardPool.EthTransferFailed.selector);
        pool.claimFor(id, address(rejector));
        vm.prank(address(rejector));
        vm.expectRevert(RewardPool.ZeroAddress.selector);
        pool.claimTo(id, address(0));
        vm.prank(address(rejector));
        pool.claimTo(id, carol);
        assertEq(carol.balance, 1 ether);
        assertEq(pool.lockedBalance(address(0)), 0);
        assertEq(pool.freeBalance(address(0)), 3 ether);
    }

    function test_achievement_hooks_only_from_achievements() public {
        vm.expectRevert(RewardPool.NotAchievements.selector);
        pool.lockForAchievement(address(orry), 1);
        vm.expectRevert(RewardPool.NotAchievements.selector);
        pool.releaseAchievement(address(orry), 1);
        vm.expectRevert(RewardPool.NotAchievements.selector);
        pool.payAchievement(address(orry), alice, 1);
    }

    function test_admin_two_step() public {
        vm.prank(alice);
        vm.expectRevert(RewardPool.NotAdmin.selector);
        pool.transferAdmin(alice);
        vm.prank(admin);
        pool.transferAdmin(bob);
        assertEq(pool.admin(), admin);
        vm.prank(alice);
        vm.expectRevert(RewardPool.NotAdmin.selector);
        pool.acceptAdmin();
        vm.prank(bob);
        pool.acceptAdmin();
        assertEq(pool.admin(), bob);
        assertEq(pool.pendingAdmin(), address(0));
        vm.prank(admin);
        vm.expectRevert(RewardPool.NotAdmin.selector);
        pool.transferAdmin(admin);
    }

    function test_nothing_else_moves_funds() public {
        _fundPool(1000e18);
        // no function other than the payouts sends assets: a stray call with value is booked by sync only
        uint256 bal = orry.balanceOf(address(pool));
        vm.prank(admin);
        pool.transferAdmin(alice);
        assertEq(orry.balanceOf(address(pool)), bal);
    }
}
