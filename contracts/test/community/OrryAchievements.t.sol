// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommunityBase} from "./utils/CommunityBase.sol";
import {RewardPool} from "../../src/community/RewardPool.sol";
import {OrryAchievements} from "../../src/community/OrryAchievements.sol";
import {StakeUsdVerifier} from "../../src/community/verifiers/StakeUsdVerifier.sol";
import {VerifiedAgentVerifier} from "../../src/community/verifiers/VerifiedAgentVerifier.sol";
import {AlwaysVerifier, MockAttestor, MockIdentity} from "./utils/CommunityMocks.sol";

contract OrryAchievementsTest is CommunityBase {
    bytes32 internal constant RULES = keccak256("stake 100 USD");
    StakeUsdVerifier internal stakeV;

    function setUp() public override {
        super.setUp();
        stakeV = new StakeUsdVerifier(address(staking), address(price), 100e6);
        _fundPool(100_000e18);
    }

    function _onchain(uint256 reward, uint32 max) internal returns (uint256 id) {
        vm.prank(admin);
        id = ach.create(address(orry), reward, max, uint64(block.timestamp + 7 days), 3, address(stakeV), RULES);
    }

    function _listed(uint256 reward, uint32 max) internal returns (uint256 id) {
        vm.prank(admin);
        id = ach.create(address(orry), reward, max, uint64(block.timestamp + 7 days), 9, address(0), RULES);
    }

    function _accts(address a, address b) internal pure returns (address[] memory xs) {
        xs = new address[](2);
        (xs[0], xs[1]) = (a, b);
    }

    function _times(uint64 a, uint64 b) internal pure returns (uint64[] memory ts) {
        ts = new uint64[](2);
        (ts[0], ts[1]) = (a, b);
    }

    function test_constructor_wiring() public {
        vm.expectRevert("pool wiring");
        new OrryAchievements(address(pool));
        vm.expectRevert("zero address");
        new OrryAchievements(address(0));
    }

    function test_create_locks_reward_times_max() public {
        uint256 id = _onchain(1000e18, 20);
        assertEq(pool.lockedBalance(address(orry)), 20_000e18);
        assertEq(pool.achievementLocked(address(orry)), 20_000e18);
        assertEq(pool.freeBalance(address(orry)), 80_000e18);
        OrryAchievements.Achievement memory a = ach.achievementOf(id);
        assertEq(a.rewardPerUser, 1000e18);
        assertEq(a.maxRecipients, 20);
        assertEq(a.verifier, address(stakeV));
    }

    function test_create_guards() public {
        vm.prank(alice);
        vm.expectRevert(OrryAchievements.NotAdmin.selector);
        ach.create(address(orry), 1, 1, uint64(block.timestamp + 1 days), 1, address(stakeV), RULES);
        vm.startPrank(admin);
        vm.expectRevert(OrryAchievements.ZeroAmount.selector);
        ach.create(address(orry), 0, 1, uint64(block.timestamp + 1 days), 1, address(stakeV), RULES);
        vm.expectRevert(OrryAchievements.ZeroAmount.selector);
        ach.create(address(orry), uint256(type(uint128).max) + 1, 1, uint64(block.timestamp + 1 days), 1, address(stakeV), RULES);
        vm.expectRevert(OrryAchievements.BadRecipients.selector);
        ach.create(address(orry), 1, 0, uint64(block.timestamp + 1 days), 1, address(stakeV), RULES);
        vm.expectRevert(OrryAchievements.BadRecipients.selector);
        ach.create(address(orry), 1, 100_001, uint64(block.timestamp + 1 days), 1, address(stakeV), RULES);
        vm.expectRevert(OrryAchievements.BadDeadline.selector);
        ach.create(address(orry), 1, 1, uint64(block.timestamp), 1, address(stakeV), RULES);
        vm.expectRevert(OrryAchievements.BadDeadline.selector);
        ach.create(address(orry), 1, 1, uint64(block.timestamp + 365 days + 1), 1, address(stakeV), RULES);
        // a listed kind needs room for the check window before its deadline
        vm.expectRevert(OrryAchievements.BadDeadline.selector);
        ach.create(address(orry), 1, 1, uint64(block.timestamp + 48 hours), 1, address(0), RULES);
        ach.create(address(orry), 1, 1, uint64(block.timestamp + 48 hours + 1), 1, address(0), RULES);
        // 25% cap of the free balance (A-1)
        vm.expectRevert(abi.encodeWithSelector(RewardPool.AboveLockCap.selector, 25_000e18, 25_000e18 - 1));
        ach.create(address(orry), 25_000e18, 1, uint64(block.timestamp + 1 days), 1, address(stakeV), RULES);
        vm.stopPrank();
    }

    function test_onchain_claim_first_come_and_cap() public {
        uint256 id = _onchain(500e18, 2);
        staking.set(alice, 2e18 * 100 / 2); // 100 ORRY = 1 USD: 100 ORRY stake is 1 USD, below 100 USD
        vm.prank(alice);
        vm.expectRevert(OrryAchievements.ConditionNotMet.selector);
        ach.claim(id, "");
        staking.set(alice, 10_000e18); // 100 USD
        staking.set(bob, 20_000e18);
        staking.set(carol, 50_000e18);
        uint256 before = orry.balanceOf(alice);
        vm.prank(alice);
        ach.claim(id, "");
        assertEq(orry.balanceOf(alice) - before, 500e18);
        vm.prank(alice);
        vm.expectRevert(OrryAchievements.AlreadyClaimed.selector);
        ach.claim(id, "");
        vm.prank(bob);
        ach.claim(id, "");
        vm.prank(carol);
        vm.expectRevert(OrryAchievements.Full.selector);
        ach.claim(id, "");
        assertEq(ach.achievementOf(id).paid, 2);
        assertEq(pool.lockedBalance(address(orry)), 0);
    }

    function test_onchain_claim_guards() public {
        uint256 id = _onchain(500e18, 2);
        vm.expectRevert(OrryAchievements.UnknownAchievement.selector);
        ach.claim(99, "");
        uint256 lid = _listed(1e18, 1);
        vm.expectRevert(OrryAchievements.WrongKind.selector);
        ach.claim(lid, "");
        staking.set(alice, 10_000e18);
        price.setReady(false); // price not ready: the stake is worth nothing on chain
        vm.prank(alice);
        vm.expectRevert(OrryAchievements.ConditionNotMet.selector);
        ach.claim(id, "");
        price.setReady(true);
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        vm.expectRevert(OrryAchievements.PastDeadline.selector);
        ach.claim(id, "");
    }

    function test_close_returns_unpaid_slots_once() public {
        uint256 id = _onchain(500e18, 4);
        staking.set(alice, 10_000e18);
        vm.prank(alice);
        ach.claim(id, "");
        vm.expectRevert(OrryAchievements.DeadlineNotReached.selector);
        ach.close(id);
        vm.warp(block.timestamp + 7 days);
        uint256 freeBefore = pool.freeBalance(address(orry));
        assertEq(ach.close(id), 1500e18);
        assertEq(pool.freeBalance(address(orry)) - freeBefore, 1500e18);
        assertEq(pool.achievementLocked(address(orry)), 0);
        vm.expectRevert(OrryAchievements.AlreadyClosed.selector);
        ach.close(id);
    }

    function test_listed_flow() public {
        uint256 id = _listed(100e18, 3);
        uint64 t = uint64(block.timestamp);
        vm.prank(alice);
        vm.expectRevert(OrryAchievements.NotAdmin.selector);
        ach.publishCompleters(id, _accts(alice, bob), _times(t - 10, t - 5));
        vm.prank(admin);
        ach.publishCompleters(id, _accts(alice, bob), _times(t - 10, t - 5));
        assertEq(ach.listedAt(id, alice), t);
        assertEq(ach.completedAtOf(id, bob), t - 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrryAchievements.NotClaimableYet.selector, t + 48 hours));
        ach.claimListed(id);
        vm.prank(carol);
        vm.expectRevert(OrryAchievements.NotListed.selector);
        ach.claimListed(id);
        vm.warp(t + 48 hours);
        vm.prank(alice);
        ach.claimListed(id);
        vm.prank(alice);
        vm.expectRevert(OrryAchievements.AlreadyClaimed.selector);
        ach.claimListed(id);
        uint256 before = orry.balanceOf(bob);
        vm.prank(carol);
        ach.claimListedFor(id, bob);
        assertEq(orry.balanceOf(bob) - before, 100e18);
        OrryAchievements.Achievement memory a = ach.achievementOf(id);
        assertEq(a.paid, 2);
        assertEq(a.listed, 0);
        vm.warp(t + 7 days);
        vm.expectRevert(OrryAchievements.PastDeadline.selector);
        ach.claimListed(id);
        assertEq(ach.close(id), 100e18);
    }

    function test_publish_completers_guards() public {
        uint256 id = _listed(100e18, 3);
        uint64 t = uint64(block.timestamp);
        uint256 oid = _onchain(1e18, 1);
        vm.startPrank(admin);
        vm.expectRevert(OrryAchievements.WrongKind.selector);
        ach.publishCompleters(oid, _accts(alice, bob), _times(t, t));
        vm.expectRevert(OrryAchievements.BadCompleters.selector);
        ach.publishCompleters(id, _accts(alice, bob), new uint64[](1));
        vm.expectRevert(OrryAchievements.BadCompleters.selector);
        ach.publishCompleters(id, new address[](0), new uint64[](0));
        vm.expectRevert(OrryAchievements.BadCompleters.selector);
        ach.publishCompleters(id, _accts(alice, alice), _times(t, t));
        vm.expectRevert(OrryAchievements.BadCompleters.selector);
        ach.publishCompleters(id, _accts(alice, address(0)), _times(t, t));
        // out of order or in the future
        vm.expectRevert(OrryAchievements.BadCompleters.selector);
        ach.publishCompleters(id, _accts(alice, bob), _times(t, t - 1));
        vm.expectRevert(OrryAchievements.BadCompleters.selector);
        ach.publishCompleters(id, _accts(alice, bob), _times(t, t + 1));
        ach.publishCompleters(id, _accts(alice, bob), _times(t - 5, t));
        // a later batch cannot go back in time, nor exceed the cap
        address[] memory one = new address[](1);
        uint64[] memory ts = new uint64[](1);
        (one[0], ts[0]) = (carol, t - 1);
        vm.expectRevert(OrryAchievements.BadCompleters.selector);
        ach.publishCompleters(id, one, ts);
        vm.expectRevert(OrryAchievements.Full.selector);
        ach.publishCompleters(id, _accts(carol, makeAddr("dave")), _times(t, t));
        // too late: the window would end after the deadline
        vm.warp(t + 7 days - 48 hours + 1);
        ts[0] = uint64(block.timestamp);
        vm.expectRevert(OrryAchievements.PastDeadline.selector);
        ach.publishCompleters(id, one, ts);
        vm.stopPrank();
    }

    function test_unlist_in_window_frees_slot() public {
        uint256 id = _listed(100e18, 2);
        uint64 t = uint64(block.timestamp);
        vm.prank(admin);
        ach.publishCompleters(id, _accts(alice, bob), _times(t, t));
        vm.prank(alice);
        vm.expectRevert(OrryAchievements.NotAdmin.selector);
        ach.unlist(id, bob);
        vm.prank(admin);
        ach.unlist(id, bob);
        vm.prank(admin);
        vm.expectRevert(OrryAchievements.NotListed.selector);
        ach.unlist(id, bob);
        address[] memory one = new address[](1);
        uint64[] memory ts = new uint64[](1);
        (one[0], ts[0]) = (carol, t);
        vm.prank(admin);
        ach.publishCompleters(id, one, ts);
        vm.warp(t + 48 hours);
        vm.prank(admin);
        vm.expectRevert(OrryAchievements.WindowClosed.selector);
        ach.unlist(id, alice);
        vm.prank(bob);
        vm.expectRevert(OrryAchievements.NotListed.selector);
        ach.claimListed(id);
        vm.prank(alice);
        ach.claimListed(id);
        vm.prank(carol);
        ach.claimListed(id);
        vm.prank(alice);
        vm.expectRevert(OrryAchievements.WrongKind.selector);
        ach.claim(id, "");
    }

    function test_listed_claim_wrong_kind() public {
        uint256 oid = _onchain(1e18, 1);
        vm.expectRevert(OrryAchievements.WrongKind.selector);
        ach.claimListed(oid);
    }

    function test_eth_achievement_coming_soon_until_deposited() public {
        AlwaysVerifier v = new AlwaysVerifier();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(RewardPool.AboveLockCap.selector, 0.1 ether, 0));
        ach.create(address(0), 0.1 ether, 1, uint64(block.timestamp + 1 days), 1, address(v), RULES);
        vm.deal(admin, 1 ether);
        vm.prank(admin);
        pool.fund{value: 1 ether}(address(0), 1 ether);
        vm.prank(admin);
        uint256 id = ach.create(address(0), 0.1 ether, 2, uint64(block.timestamp + 1 days), 1, address(v), RULES);
        vm.prank(alice);
        ach.claim(id, "");
        assertEq(alice.balance, 0.1 ether);
    }

    function test_verified_agent_verifier() public {
        MockIdentity idr = new MockIdentity();
        MockAttestor att = new MockAttestor();
        VerifiedAgentVerifier v = new VerifiedAgentVerifier(address(idr), address(att));
        idr.set(7, alice);
        assertFalse(v.isComplete(alice, abi.encode(uint256(7))));
        att.set(7, true);
        assertTrue(v.isComplete(alice, abi.encode(uint256(7))));
        assertFalse(v.isComplete(bob, abi.encode(uint256(7))));
        assertFalse(v.isComplete(alice, ""));
        assertFalse(v.isComplete(alice, abi.encode(uint256(7), uint256(1))));
        vm.expectRevert("zero address");
        new VerifiedAgentVerifier(address(0), address(att));
    }

    function test_stake_usd_verifier() public {
        assertEq(stakeV.minStakeUsd(), 100e6);
        staking.set(alice, 10_000e18 - 1);
        assertFalse(stakeV.isComplete(alice, ""));
        staking.set(alice, 10_000e18);
        assertTrue(stakeV.isComplete(alice, ""));
        price.setReverts(true);
        assertFalse(stakeV.isComplete(alice, ""));
        price.setReverts(false);
        staking.setReverts(true);
        vm.expectRevert();
        stakeV.isComplete(alice, "");
        vm.expectRevert("zero threshold");
        new StakeUsdVerifier(address(staking), address(price), 0);
        vm.expectRevert("zero address");
        new StakeUsdVerifier(address(0), address(price), 1);
    }
}
