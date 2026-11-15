// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOrryStaking} from "../../../src/orry/interfaces/IOrryStaking.sol";
import {OrryStaking} from "../../../src/orry/OrryStaking.sol";
import {StakeBase} from "./utils/StakeBase.sol";
import {StakingLedger} from "./utils/StakingLedger.sol";
import {FeeOrry, RejectEth, ReenterOnEth} from "./utils/StakeMocks.sol";

contract OrryStakingTest is StakeBase {
    uint256 internal agentId;
    address internal agentOwner = makeAddr("agentOwner");
    address internal agentWallet = makeAddr("agentWallet");

    function setUp() public override {
        super.setUp();
        vm.prank(agentOwner);
        agentId = registry.register(agentOwner);
        vm.prank(agentOwner);
        registry.setAgentWallet(agentId, agentWallet);
        address[2] memory ctl = [agentOwner, agentWallet];
        for (uint256 i; i < 2; ++i) {
            orry.transfer(ctl[i], 1_000_000e18);
            vm.prank(ctl[i]);
            orry.approve(address(staking), type(uint256).max);
        }
    }

    // ---------------------------------------------------------------- constructor and views

    function test_constructor_values() public view {
        assertEq(staking.PLAIN_COOLDOWN(), 7 days);
        assertEq(staking.AGENT_COOLDOWN(), 14 days);
        assertEq(staking.STREAM_PERIOD(), 7 days);
        assertEq(staking.orry(), address(orry));
        assertEq(staking.identityRegistry(), address(registry));
        assertEq(staking.totalEarning(), 0);
    }

    function test_constructor_rejects_zero() public {
        _ctorReverts(address(0), address(registry), 1, 1, 1, "zero address");
        _ctorReverts(address(orry), address(0), 1, 1, 1, "zero address");
        _ctorReverts(address(orry), address(registry), 0, 1, 1, "zero duration");
        _ctorReverts(address(orry), address(registry), 1, 0, 1, "zero duration");
        _ctorReverts(address(orry), address(registry), 1, 1, 0, "zero duration");
    }

    /// @dev try/catch rather than expectRevert: with dynamic test linking and isolate (the effective forge config) a
    /// `new` becomes `vm.deployCode`, and an expected revert there ends the test, so later checks would never run.
    function _ctorReverts(address r, address reg, uint64 a, uint64 b, uint64 c, string memory why) internal {
        try new OrryStaking(r, reg, a, b, c) returns (OrryStaking) {
            revert("constructor did not revert");
        } catch Error(string memory reason) {
            assertEq(reason, why);
        }
    }

    // ---------------------------------------------------------------- plain stake

    function test_stake_zero_reverts() public {
        vm.prank(alice);
        vm.expectRevert(IOrryStaking.ZeroAmount.selector);
        staking.stake(0);
    }

    function test_stake_books_and_emits() public {
        vm.expectEmit(address(staking));
        emit IOrryStaking.Staked(alice, 100e18);
        vm.prank(alice);
        staking.stake(100e18);
        (uint256 active, uint256 leaving, uint64 readyAt) = staking.plainStake(alice);
        assertEq(active, 100e18);
        assertEq(leaving, 0);
        assertEq(readyAt, 0);
        assertEq(staking.earningBalance(alice), 100e18);
        assertEq(staking.totalEarning(), 100e18);
        assertEq(orry.balanceOf(address(staking)), 100e18);
    }

    function test_stake_without_allowance_reverts_inexact() public {
        vm.prank(alice);
        orry.approve(address(staking), 0);
        vm.prank(alice);
        vm.expectRevert(IOrryStaking.InexactTransfer.selector);
        staking.stake(1e18);
    }

    function test_stake_fee_token_reverts_inexact() public {
        FeeOrry fee = new FeeOrry(alice, 1e24);
        OrryStaking s = new OrryStaking(address(fee), address(registry), 7 days, 14 days, 7 days);
        vm.startPrank(alice);
        fee.approve(address(s), type(uint256).max);
        vm.expectRevert(IOrryStaking.InexactTransfer.selector);
        s.stake(100e18);
        vm.expectRevert(IOrryStaking.InexactTransfer.selector);
        s.notifyRewards(100e18);
        vm.stopPrank();
    }

    function test_requestUnstake_reverts() public {
        vm.startPrank(alice);
        vm.expectRevert(IOrryStaking.ZeroAmount.selector);
        staking.requestUnstake(0);
        vm.expectRevert(IOrryStaking.InsufficientActive.selector);
        staking.requestUnstake(1);
        staking.stake(10e18);
        vm.expectRevert(IOrryStaking.InsufficientActive.selector);
        staking.requestUnstake(10e18 + 1);
        vm.stopPrank();
    }

    function test_requestUnstake_stops_earning_and_adds_restarting_clock() public {
        vm.startPrank(alice);
        staking.stake(100e18);
        uint64 ready1 = uint64(_now()) + 7 days;
        vm.expectEmit(address(staking));
        emit IOrryStaking.UnstakeRequested(alice, 40e18, ready1);
        staking.requestUnstake(40e18);
        assertEq(staking.earningBalance(alice), 60e18);
        assertEq(staking.totalEarning(), 60e18);
        vm.warp(_now() + 3 days);
        staking.requestUnstake(10e18);
        vm.stopPrank();
        (uint256 active, uint256 leaving, uint64 readyAt) = staking.plainStake(alice);
        assertEq(active, 50e18);
        assertEq(leaving, 50e18);
        assertEq(readyAt, uint64(_now()) + 7 days, "clock restarted");
    }

    function test_withdraw_reverts_and_pays_after_cooldown() public {
        vm.startPrank(alice);
        vm.expectRevert(IOrryStaking.NothingReady.selector);
        staking.withdraw();
        staking.stake(100e18);
        staking.requestUnstake(30e18);
        vm.warp(_now() + 7 days - 1);
        vm.expectRevert(IOrryStaking.NothingReady.selector);
        staking.withdraw();
        vm.warp(_now() + 1);
        uint256 before = orry.balanceOf(alice);
        vm.expectEmit(address(staking));
        emit IOrryStaking.Withdrawn(alice, 30e18);
        assertEq(staking.withdraw(), 30e18);
        assertEq(orry.balanceOf(alice), before + 30e18);
        vm.expectRevert(IOrryStaking.NothingReady.selector);
        staking.withdraw();
        vm.stopPrank();
        (uint256 active, uint256 leaving, uint64 readyAt) = staking.plainStake(alice);
        assertEq(active, 70e18);
        assertEq(leaving, 0);
        assertEq(readyAt, 0);
    }

    // ---------------------------------------------------------------- agent stake

    function test_stakeForAgent_reverts() public {
        vm.prank(agentOwner);
        vm.expectRevert(IOrryStaking.ZeroAmount.selector);
        staking.stakeForAgent(agentId, 0);
        vm.prank(alice);
        vm.expectRevert(IOrryStaking.NotAgentController.selector);
        staking.stakeForAgent(agentId, 1e18);
        vm.prank(alice);
        vm.expectRevert("ERC721NonexistentToken");
        staking.stakeForAgent(999, 1e18);
    }

    function test_stakeForAgent_by_owner() public {
        vm.expectEmit(address(staking));
        emit IOrryStaking.AgentStaked(agentId, agentOwner, agentOwner, 50e18);
        vm.prank(agentOwner);
        staking.stakeForAgent(agentId, 50e18);
        IOrryStaking.AgentPosition memory p = staking.agentStake(agentId);
        assertEq(p.staker, agentOwner);
        assertEq(p.active, 50e18);
        assertEq(staking.earningBalance(agentOwner), 50e18);
        assertEq(staking.totalEarning(), 50e18);
    }

    function test_stakeForAgent_by_wallet_is_keyed_by_owner_and_earns_for_wallet() public {
        vm.prank(agentWallet);
        staking.stakeForAgent(agentId, 20e18);
        IOrryStaking.AgentPosition memory p = staking.agentStakeOf(agentId, agentOwner);
        assertEq(p.staker, agentWallet);
        assertEq(p.active, 20e18);
        assertEq(staking.earningBalance(agentWallet), 20e18);
        assertEq(staking.earningBalance(agentOwner), 0);
        // same staker may add
        vm.prank(agentWallet);
        staking.stakeForAgent(agentId, 5e18);
        assertEq(staking.agentStake(agentId).active, 25e18);
        // the owner may not join a position held by the wallet
        vm.prank(agentOwner);
        vm.expectRevert(IOrryStaking.PositionHeldByAnotherStaker.selector);
        staking.stakeForAgent(agentId, 1e18);
    }

    function test_earning_balance_sums_plain_and_agent() public {
        vm.startPrank(agentOwner);
        staking.stake(7e18);
        staking.stakeForAgent(agentId, 3e18);
        vm.stopPrank();
        assertEq(staking.earningBalance(agentOwner), 10e18);
        assertEq(staking.totalEarning(), 10e18);
    }

    function test_agentStake_follows_current_owner() public {
        vm.prank(agentOwner);
        staking.stakeForAgent(agentId, 50e18);
        address newOwner = makeAddr("newOwner");
        vm.prank(agentOwner);
        registry.transferFrom(agentOwner, newOwner, agentId);
        assertEq(staking.agentStake(agentId).active, 0, "no longer reported for the agent");
        assertEq(staking.agentStakeOf(agentId, agentOwner).active, 50e18, "old position kept");
        // the old staker can still leave through the old owner key
        vm.prank(agentOwner);
        staking.requestAgentUnstake(agentId, agentOwner, 50e18);
        assertEq(staking.agentStakeOf(agentId, agentOwner).leaving, 50e18);
        assertEq(staking.earningBalance(agentOwner), 0);
    }

    function test_agentStake_of_burned_identity_is_empty() public view {
        IOrryStaking.AgentPosition memory p = staking.agentStake(424242);
        assertEq(p.staker, address(0));
        assertEq(p.active, 0);
    }

    function test_requestAgentUnstake_reverts() public {
        vm.prank(agentWallet);
        staking.stakeForAgent(agentId, 10e18);
        vm.prank(agentOwner); // the owner is not the staker of this position
        vm.expectRevert(IOrryStaking.NotStaker.selector);
        staking.requestAgentUnstake(agentId, agentOwner, 1e18);
        vm.startPrank(agentWallet);
        vm.expectRevert(IOrryStaking.ZeroAmount.selector);
        staking.requestAgentUnstake(agentId, agentOwner, 0);
        vm.expectRevert(IOrryStaking.InsufficientActive.selector);
        staking.requestAgentUnstake(agentId, agentOwner, 10e18 + 1);
        vm.expectRevert(IOrryStaking.NotStaker.selector);
        staking.requestAgentUnstake(agentId, alice, 1e18); // no position under that owner key
        vm.stopPrank();
    }

    function test_agent_unstake_and_withdraw_flow() public {
        vm.prank(agentWallet);
        staking.stakeForAgent(agentId, 10e18);
        uint64 leavingAt = uint64(_now()) + 14 days;
        vm.expectEmit(address(staking));
        emit IOrryStaking.AgentUnstakeRequested(agentId, agentOwner, 10e18, leavingAt);
        vm.prank(agentWallet);
        staking.requestAgentUnstake(agentId, agentOwner, 10e18);
        assertEq(staking.earningBalance(agentWallet), 0);

        vm.prank(agentOwner);
        vm.expectRevert(IOrryStaking.NotStaker.selector);
        staking.withdrawAgent(agentId, agentOwner);

        vm.warp(leavingAt - 1);
        vm.prank(agentWallet);
        vm.expectRevert(IOrryStaking.NothingReady.selector);
        staking.withdrawAgent(agentId, agentOwner);

        vm.warp(leavingAt);
        uint256 before = orry.balanceOf(agentWallet);
        vm.expectEmit(address(staking));
        emit IOrryStaking.AgentWithdrawn(agentId, agentOwner, agentWallet, 10e18);
        vm.prank(agentWallet);
        assertEq(staking.withdrawAgent(agentId, agentOwner), 10e18);
        assertEq(orry.balanceOf(agentWallet), before + 10e18);

        // the emptied position is free: the owner can now stake behind the agent
        assertEq(staking.agentStakeOf(agentId, agentOwner).staker, address(0));
        vm.prank(agentOwner);
        staking.stakeForAgent(agentId, 1e18);
        assertEq(staking.agentStake(agentId).staker, agentOwner);

        vm.prank(agentWallet);
        vm.expectRevert(IOrryStaking.NotStaker.selector);
        staking.withdrawAgent(agentId, agentOwner);
    }

    function test_partial_agent_withdraw_keeps_staker() public {
        vm.startPrank(agentOwner);
        staking.stakeForAgent(agentId, 10e18);
        staking.requestAgentUnstake(agentId, agentOwner, 4e18);
        vm.warp(_now() + 14 days);
        staking.withdrawAgent(agentId, agentOwner);
        vm.expectRevert(IOrryStaking.NothingReady.selector);
        staking.withdrawAgent(agentId, agentOwner);
        vm.stopPrank();
        IOrryStaking.AgentPosition memory p = staking.agentStake(agentId);
        assertEq(p.staker, agentOwner);
        assertEq(p.active, 6e18);
        vm.prank(agentWallet);
        vm.expectRevert(IOrryStaking.PositionHeldByAnotherStaker.selector);
        staking.stakeForAgent(agentId, 1e18);
    }

    /// S-5: an agent position reported with active A at time t keeps at least A locked until t + AGENT_COOLDOWN.
    function test_S5_reported_active_stays_locked_for_agent_cooldown() public {
        vm.prank(agentOwner);
        staking.stakeForAgent(agentId, 10e18);
        uint256 t = _now();
        uint256 reported = staking.agentStake(agentId).active;
        vm.warp(t + 1 days);
        vm.startPrank(agentOwner);
        staking.requestAgentUnstake(agentId, agentOwner, 10e18);
        vm.warp(t + 14 days); // a full cooldown after the report, but the request came later
        vm.expectRevert(IOrryStaking.NothingReady.selector);
        staking.withdrawAgent(agentId, agentOwner);
        vm.warp(t + 1 days + 14 days);
        assertEq(staking.withdrawAgent(agentId, agentOwner), reported);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- agent lock (R-13, S-6)

    function test_extendAgentLock_reverts() public {
        assertEq(staking.MAX_AGENT_LOCK(), 365 days);
        vm.prank(agentWallet);
        staking.stakeForAgent(agentId, 10e18);
        uint64 until = uint64(_now() + 90 days);
        vm.prank(agentOwner); // not the staker of this position
        vm.expectRevert(IOrryStaking.NotStaker.selector);
        staking.extendAgentLock(agentId, until);
        vm.prank(alice);
        vm.expectRevert(IOrryStaking.NotStaker.selector);
        staking.extendAgentLock(agentId, until);
        vm.startPrank(agentWallet);
        vm.expectRevert(IOrryStaking.LockTooLong.selector);
        staking.extendAgentLock(agentId, uint64(_now() + 365 days + 1));
        staking.extendAgentLock(agentId, uint64(_now() + 365 days)); // the edge is allowed
        vm.expectRevert(IOrryStaking.LockNotExtended.selector);
        staking.extendAgentLock(agentId, uint64(_now() + 365 days));
        vm.expectRevert(IOrryStaking.LockNotExtended.selector);
        staking.extendAgentLock(agentId, until);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert("ERC721NonexistentToken");
        staking.extendAgentLock(999, until);
    }

    function test_lock_blocks_unstake_until_it_ends() public {
        vm.startPrank(agentOwner);
        staking.stakeForAgent(agentId, 10e18);
        uint64 until = uint64(_now() + 90 days);
        vm.expectEmit(address(staking));
        emit IOrryStaking.AgentLockExtended(agentId, agentOwner, until);
        staking.extendAgentLock(agentId, until);
        assertEq(staking.agentStake(agentId).lockedUntil, until);
        assertEq(staking.earningBalance(agentOwner), 10e18, "a lock changes no earning");
        vm.expectRevert(abi.encodeWithSelector(IOrryStaking.AgentStakeLocked.selector, until));
        staking.requestAgentUnstake(agentId, agentOwner, 1e18);
        staking.stakeForAgent(agentId, 5e18); // adding stays possible
        vm.warp(until - 1);
        vm.expectRevert(abi.encodeWithSelector(IOrryStaking.AgentStakeLocked.selector, until));
        staking.requestAgentUnstake(agentId, agentOwner, 1e18);
        vm.warp(until);
        staking.requestAgentUnstake(agentId, agentOwner, 15e18);
        vm.stopPrank();
        assertEq(staking.agentStake(agentId).leaving, 15e18);
    }

    function test_lock_leaves_earlier_leaving_withdrawable() public {
        vm.startPrank(agentOwner);
        staking.stakeForAgent(agentId, 10e18);
        staking.requestAgentUnstake(agentId, agentOwner, 4e18);
        staking.extendAgentLock(agentId, uint64(_now() + 200 days));
        vm.warp(_now() + 14 days);
        assertEq(staking.withdrawAgent(agentId, agentOwner), 4e18, "leaving is not active");
        vm.stopPrank();
        assertEq(staking.agentStake(agentId).active, 6e18);
    }

    function test_lock_does_not_follow_the_identity() public {
        vm.prank(agentOwner);
        staking.stakeForAgent(agentId, 10e18);
        uint64 until = uint64(_now() + 30 days);
        vm.prank(agentOwner);
        staking.extendAgentLock(agentId, until);
        address newOwner = makeAddr("newOwner");
        vm.prank(agentOwner);
        registry.transferFrom(agentOwner, newOwner, agentId);
        // the reported position is the new owner's fresh one, unlocked and empty
        assertEq(staking.agentStake(agentId).lockedUntil, 0);
        vm.prank(agentOwner);
        vm.expectRevert(IOrryStaking.NotStaker.selector);
        staking.extendAgentLock(agentId, until + 1);
        // the old position keeps its own lock (S-6)
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(IOrryStaking.AgentStakeLocked.selector, until));
        staking.requestAgentUnstake(agentId, agentOwner, 1e18);
        vm.warp(until);
        vm.prank(agentOwner);
        staking.requestAgentUnstake(agentId, agentOwner, 10e18);
    }

    // ---------------------------------------------------------------- rewards

    function test_notify_zero_reverts() public {
        vm.expectRevert(IOrryStaking.ZeroAmount.selector);
        staking.notifyRewards(0);
    }

    function test_notify_sets_rate_and_keeps_remainder_unstreamed() public {
        uint256 period = 7 days;
        uint256 amount = 10 ether + 123;
        vm.expectEmit(address(staking));
        emit IOrryStaking.RewardsNotified(address(this), amount, 0, uint64(_now() + period));
        staking.notifyRewards{value: amount}(0);
        StakingLedger.Ledger memory l = StakingLedger.read(address(staking), 0);
        assertEq(l.rate, amount / period);
        assertEq(l.unstreamed, amount % period);
        assertEq(l.periodFinish, _now() + period);
        StakingLedger.Ledger memory r = StakingLedger.read(address(staking), 1);
        assertEq(r.periodFinish, 0, "ORRY stream untouched by an ETH-only notify");
    }

    function test_notify_restart_carries_scheduled_remainder() public {
        vm.prank(alice);
        staking.stake(1e18);
        _notify(0, 700e18);
        vm.warp(_now() + 3 days);
        StakingLedger.Ledger memory before = StakingLedger.read(address(staking), 1);
        uint256 remaining = before.rate * (before.periodFinish - _now());
        _notify(0, 70e18);
        StakingLedger.Ledger memory l = StakingLedger.read(address(staking), 1);
        uint256 total = remaining + before.unstreamed + 70e18;
        assertEq(l.rate, total / 7 days);
        assertEq(l.unstreamed, total % 7 days);
    }

    function test_single_staker_receives_the_stream() public {
        vm.prank(alice);
        staking.stake(100e18);
        _notify(7 ether, 700e18);
        vm.warp(_now() + 7 days);
        (uint256 e, uint256 r) = staking.pendingRewards(alice);
        // everything except the division remainder (kept unstreamed) and accumulator rounding
        assertApproxEqAbs(e, 7 ether, 7 days);
        assertApproxEqAbs(r, 700e18, 7 days);
        uint256 ethBefore = alice.balance;
        uint256 rcBefore = orry.balanceOf(alice);
        vm.expectEmit(address(staking));
        emit IOrryStaking.RewardsClaimed(alice, alice, e, r);
        vm.prank(alice);
        (uint256 ce, uint256 cr) = staking.claimRewards();
        assertEq(ce, e);
        assertEq(cr, r);
        assertEq(alice.balance, ethBefore + e);
        assertEq(orry.balanceOf(alice), rcBefore + r);
        _assertLedger(7 ether, 700e18, ce, cr);
    }

    function test_two_stakers_pro_rata_and_late_joiner() public {
        vm.prank(alice);
        staking.stake(300e18);
        _notify(7 ether, 0);
        vm.warp(_now() + 1 days);
        vm.prank(bob);
        staking.stake(100e18); // joins after one day: earns nothing of day one
        vm.warp(_now() + 6 days);
        (uint256 ea,) = staking.pendingRewards(alice);
        (uint256 eb,) = staking.pendingRewards(bob);
        uint256 perDay = 1 ether;
        assertApproxEqRel(ea, perDay + 6 * perDay * 3 / 4, 1e12);
        assertApproxEqRel(eb, 6 * perDay / 4, 1e12);
        assertLe(ea + eb, 7 ether);
    }

    function test_unstake_request_stops_earning_at_once() public {
        vm.prank(alice);
        staking.stake(100e18);
        vm.prank(bob);
        staking.stake(100e18);
        _notify(7 ether, 0);
        vm.warp(_now() + 1 days);
        vm.prank(alice);
        staking.requestUnstake(100e18);
        (uint256 atRequest,) = staking.pendingRewards(alice);
        vm.warp(_now() + 6 days);
        (uint256 later,) = staking.pendingRewards(alice);
        assertEq(later, atRequest);
        (uint256 eb,) = staking.pendingRewards(bob);
        assertApproxEqRel(eb, 0.5 ether + 6 ether, 1e12);
    }

    function test_rewards_with_nobody_earning_return_to_unstreamed() public {
        _notify(7 ether, 0);
        vm.warp(_now() + 2 days);
        vm.prank(alice);
        staking.stake(1e18); // streams 2 days into unstreamed first
        StakingLedger.Ledger memory l = StakingLedger.read(address(staking), 0);
        assertEq(l.unstreamed, 7 ether % 7 days + l.rate * 2 days);
        vm.warp(_now() + 5 days);
        (uint256 e,) = staking.pendingRewards(alice);
        assertApproxEqAbs(e, l.rate * 5 days, 1e3);
        // the next notify streams the kept part again
        _notify(1, 0);
        vm.warp(_now() + 7 days);
        (uint256 e2,) = staking.pendingRewards(alice);
        assertApproxEqAbs(e2, 7 ether, 7 days * 2);
        vm.prank(alice);
        (uint256 ce,) = staking.claimRewards();
        _assertLedger(7 ether + 1, 0, ce, 0);
    }

    function test_claimFor_pays_account_only() public {
        vm.prank(alice);
        staking.stake(100e18);
        _notify(1 ether, 10e18);
        vm.warp(_now() + 7 days);
        (uint256 e, uint256 r) = staking.pendingRewards(alice);
        uint256 bobEth = bob.balance;
        uint256 aliceEth = alice.balance;
        vm.expectEmit(address(staking));
        emit IOrryStaking.RewardsClaimed(alice, bob, e, r);
        vm.prank(bob);
        staking.claimFor(alice);
        assertEq(bob.balance, bobEth);
        assertEq(alice.balance, aliceEth + e);
        (e, r) = staking.pendingRewards(alice);
        assertEq(e + r, 0);
    }

    function test_claim_with_nothing_returns_zero() public {
        vm.recordLogs();
        vm.prank(alice);
        (uint256 e, uint256 r) = staking.claimRewards();
        assertEq(e + r, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        (e, r) = staking.claimFor(bob);
        assertEq(e + r, 0);
    }

    /// Review L-1: an address that refuses ETH keeps its ETH owed (nothing reverts), and claimRewardsTo pays it elsewhere.
    function test_claim_to_contract_refusing_eth_keeps_eth_owed() public {
        RejectEth rej = new RejectEth();
        orry.transfer(address(rej), 10e18);
        rej.call(address(orry), abi.encodeCall(orry.approve, (address(staking), type(uint256).max)));
        rej.call(address(staking), abi.encodeCall(staking.stake, (10e18)));
        _notify(1 ether, 0);
        vm.warp(_now() + 1 days);
        (uint256 owedEth,) = staking.pendingRewards(address(rej));
        assertGt(owedEth, 0);
        (uint256 e, uint256 r) = staking.claimFor(address(rej));
        assertEq(e + r, 0, "nothing moved");
        (uint256 still,) = staking.pendingRewards(address(rej));
        assertEq(still, owedEth, "the ETH stays owed");
        address payee = makeAddr("payee");
        rej.call(address(staking), abi.encodeCall(staking.claimRewardsTo, (payee)));
        assertEq(payee.balance, owedEth, "claimRewardsTo paid it elsewhere");
        (still,) = staking.pendingRewards(address(rej));
        assertEq(still, 0);
        vm.expectRevert(IOrryStaking.ZeroAddress.selector);
        staking.claimRewardsTo(address(0));
        // others are unaffected
        vm.prank(alice);
        staking.stake(1e18);
        vm.prank(alice);
        staking.claimRewards();
    }

    function test_reentrant_claim_is_blocked() public {
        ReenterOnEth re = new ReenterOnEth();
        orry.transfer(address(re), 10e18);
        re.call(address(orry), abi.encodeCall(orry.approve, (address(staking), type(uint256).max)));
        re.call(address(staking), abi.encodeCall(staking.stake, (10e18)));
        _notify(1 ether, 0);
        vm.warp(_now() + 7 days);
        re.arm(address(staking), abi.encodeCall(staking.claimRewards, ()));
        (uint256 e,) = staking.pendingRewards(address(re));
        uint256 before = address(re).balance;
        re.call(address(staking), abi.encodeCall(staking.claimRewards, ()));
        assertTrue(re.tried());
        assertFalse(re.innerOk(), "inner claim must fail");
        assertEq(address(re).balance, before + e, "paid once");
    }

    function test_plain_eth_transfer_refused() public {
        (bool ok,) = address(staking).call{value: 1}("");
        assertFalse(ok);
    }

    // ---------------------------------------------------------------- helpers

    /// S-4 exact: notified = claimed + owed + scheduled (incl. not yet accrued) + unstreamed, per asset.
    function _assertLedger(uint256 notifiedEth, uint256 notifiedOrry, uint256 paidEth, uint256 paidOrry) internal view {
        uint256[2] memory notified = [notifiedEth, notifiedOrry];
        uint256[2] memory paid = [paidEth, paidOrry];
        for (uint256 i; i < 2; ++i) {
            StakingLedger.Ledger memory l = StakingLedger.read(address(staking), i);
            uint256 rest = l.periodFinish > l.lastUpdate ? l.rate * (l.periodFinish - l.lastUpdate) : 0;
            assertEq(notified[i], paid[i] + l.owed + l.unstreamed + rest, "S-4 ledger");
        }
    }
}
