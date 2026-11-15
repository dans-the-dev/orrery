// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CreditBase} from "./CreditBase.sol";
import {OrreryAttestor} from "../../src/OrreryAttestor.sol";
import {IOrryToken} from "../../src/orry/interfaces/IOrryToken.sol";
import {AttesterRegistry} from "../../src/credit/AttesterRegistry.sol";

contract AttesterRegistryTest is CreditBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal aliceProbe = makeAddr("aliceProbe");
    address internal bobProbe = makeAddr("bobProbe");
    address internal agentOwner = makeAddr("agentOwner");

    // ------------------------------------------------------------------ constructor

    function deployRegistry(IOrryToken t, OrreryAttestor a, uint256 min, uint256 maxA, uint64 ep, uint64 un, uint64 g)
        external
        returns (AttesterRegistry)
    {
        return new AttesterRegistry(t, a, min, maxA, ep, un, g);
    }

    function test_constructor_rejectsBadParams() public {
        IOrryToken t = IOrryToken(address(orry));
        vm.expectRevert(AttesterRegistry.ZeroAddress.selector);
        this.deployRegistry(IOrryToken(address(0)), attestor, MIN_STAKE, 20, EPOCH, UNLOCK, genesis);
        vm.expectRevert(AttesterRegistry.ZeroAddress.selector);
        this.deployRegistry(t, OrreryAttestor(address(0)), MIN_STAKE, 20, EPOCH, UNLOCK, genesis);
        vm.expectRevert(AttesterRegistry.BadParams.selector);
        this.deployRegistry(t, attestor, 0, 20, EPOCH, UNLOCK, genesis);
        vm.expectRevert(AttesterRegistry.BadParams.selector);
        this.deployRegistry(t, attestor, uint256(type(uint128).max) + 1, 20, EPOCH, UNLOCK, genesis);
        vm.expectRevert(AttesterRegistry.BadParams.selector);
        this.deployRegistry(t, attestor, MIN_STAKE, 0, EPOCH, UNLOCK, genesis);
        vm.expectRevert(AttesterRegistry.BadParams.selector);
        this.deployRegistry(t, attestor, MIN_STAKE, 101, EPOCH, UNLOCK, genesis);
        vm.expectRevert(AttesterRegistry.BadParams.selector);
        this.deployRegistry(t, attestor, MIN_STAKE, 20, 1 hours - 1, UNLOCK, genesis);
        vm.expectRevert(AttesterRegistry.BadParams.selector);
        this.deployRegistry(t, attestor, MIN_STAKE, 20, EPOCH, 0, genesis);
        vm.expectRevert(AttesterRegistry.BadParams.selector);
        this.deployRegistry(t, attestor, MIN_STAKE, 20, EPOCH, UNLOCK, uint64(clock + 1));
        AttesterRegistry ok = this.deployRegistry(t, attestor, MIN_STAKE, 100, 1 hours, 1, uint64(clock));
        assertEq(ok.maxActive(), 100);
        assertEq(ok.minStake(), MIN_STAKE);
    }

    // ------------------------------------------------------------------ stake

    function test_stake_firstLockNeedsMinimumAndKey() public {
        orry.mint(alice, 2 * MIN_STAKE);
        vm.startPrank(alice);
        orry.approve(address(registry), type(uint256).max);
        vm.expectRevert(AttesterRegistry.ZeroAmount.selector);
        registry.stake(0, aliceProbe);
        vm.expectRevert(AttesterRegistry.BelowMinimum.selector);
        registry.stake(MIN_STAKE - 1, aliceProbe);
        vm.expectRevert(AttesterRegistry.BadProbeKey.selector);
        registry.stake(MIN_STAKE, address(0));
        vm.expectRevert(AttesterRegistry.BadProbeKey.selector);
        registry.stake(MIN_STAKE, alice);
        registry.stake(MIN_STAKE, aliceProbe);
        vm.expectRevert(AttesterRegistry.BadProbeKey.selector);
        registry.stake(1, aliceProbe); // a top-up passes no key
        registry.stake(5, address(0));
        vm.stopPrank();
        AttesterRegistry.Staker memory s = registry.stakerOf(alice);
        assertEq(s.amount, MIN_STAKE + 5);
        assertEq(s.probeKey, aliceProbe);
        assertEq(s.lockedAt, clock);
        assertEq(registry.probeOwner(aliceProbe), alice);
        assertEq(registry.totalStaked(), MIN_STAKE + 5);
        assertEq(orry.balanceOf(address(registry)), MIN_STAKE + 5);
        assertEq(registry.candidateCount(), 1);
    }

    function test_stake_probeKeyCannotBeReusedOrBeAStaker() public {
        stakeAs(alice, MIN_STAKE, aliceProbe);
        orry.mint(bob, MIN_STAKE);
        vm.startPrank(bob);
        orry.approve(address(registry), MIN_STAKE);
        vm.expectRevert(AttesterRegistry.ProbeKeyTaken.selector);
        registry.stake(MIN_STAKE, aliceProbe);
        vm.expectRevert(AttesterRegistry.ProbeKeyTaken.selector);
        registry.stake(MIN_STAKE, alice); // a staker is never a probe key
        vm.stopPrank();
        // a probe key cannot become a staker itself
        orry.mint(aliceProbe, MIN_STAKE);
        vm.startPrank(aliceProbe);
        orry.approve(address(registry), MIN_STAKE);
        vm.expectRevert(AttesterRegistry.ProbeKeyTaken.selector);
        registry.stake(MIN_STAKE, bobProbe);
        vm.stopPrank();
    }

    function test_stake_refusesShortTransfer() public {
        // a token that moves less than asked is refused by the balance check
        ShortOrry short = new ShortOrry();
        AttesterRegistry r =
            new AttesterRegistry(IOrryToken(address(short)), attestor, MIN_STAKE, 20, EPOCH, UNLOCK, genesis);
        short.mint(alice, 2 * MIN_STAKE);
        vm.startPrank(alice);
        short.approve(address(r), type(uint256).max);
        vm.expectRevert(AttesterRegistry.InexactTransfer.selector);
        r.stake(MIN_STAKE, aliceProbe);
        vm.stopPrank();
    }

    function test_stake_refusesFailedPull() public {
        orry.mint(alice, MIN_STAKE);
        vm.prank(alice);
        vm.expectRevert(AttesterRegistry.InexactTransfer.selector);
        registry.stake(MIN_STAKE, aliceProbe); // no allowance
    }

    function test_setProbeKey() public {
        stakeAs(alice, MIN_STAKE, aliceProbe);
        address newKey = makeAddr("newKey");
        vm.prank(bob);
        vm.expectRevert(AttesterRegistry.NotStaker.selector);
        registry.setProbeKey(newKey);
        vm.prank(alice);
        registry.setProbeKey(newKey);
        assertEq(registry.probeOwner(newKey), alice);
        assertEq(registry.probeOwner(aliceProbe), address(0));
        assertEq(registry.stakerOf(alice).probeKey, newKey);
        vm.prank(alice);
        registry.requestUnlock();
        vm.prank(alice);
        vm.expectRevert(AttesterRegistry.Unlocking.selector);
        registry.setProbeKey(aliceProbe);
    }

    // ------------------------------------------------------------------ unlock

    function test_unlock_flow_returnsToStakerOnly() public {
        stakeAs(alice, MIN_STAKE, aliceProbe);
        vm.prank(bob);
        vm.expectRevert(AttesterRegistry.NotStaker.selector);
        registry.requestUnlock();
        vm.prank(alice);
        vm.expectRevert(AttesterRegistry.NotUnlocking.selector);
        registry.withdraw();
        registry.rollEpoch();
        assertTrue(registry.isActive(0, alice));
        vm.prank(alice);
        registry.requestUnlock();
        assertFalse(registry.isActive(0, alice), "leaves the active set at once");
        assertEq(registry.activeSet(0).length, 0);
        assertEq(registry.candidateCount(), 0);
        assertEq(registry.probeOwner(aliceProbe), address(0));
        vm.prank(alice);
        vm.expectRevert(AttesterRegistry.Unlocking.selector);
        registry.requestUnlock();
        orry.mint(alice, 1);
        vm.startPrank(alice);
        orry.approve(address(registry), 1);
        vm.expectRevert(AttesterRegistry.Unlocking.selector);
        registry.stake(1, address(0));
        vm.stopPrank();
        warp(UNLOCK - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AttesterRegistry.StillLocked.selector, uint64(clock + 1)));
        registry.withdraw();
        warp(1);
        vm.prank(alice);
        registry.withdraw();
        assertEq(orry.balanceOf(alice), MIN_STAKE + 1);
        assertEq(registry.totalStaked(), 0);
        assertEq(registry.stakerOf(alice).amount, 0);
        vm.prank(alice);
        vm.expectRevert(AttesterRegistry.NotUnlocking.selector);
        registry.withdraw();
    }

    function test_unlock_removesMiddleCandidate() public {
        stakeAs(alice, MIN_STAKE, aliceProbe);
        stakeAs(bob, MIN_STAKE, bobProbe);
        address carol = makeAddr("carol");
        stakeAs(carol, MIN_STAKE, makeAddr("carolProbe"));
        vm.prank(alice);
        registry.requestUnlock();
        address[] memory c = registry.candidates();
        assertEq(c.length, 2);
        assertEq(c[0], carol);
        assertEq(c[1], bob);
        vm.prank(carol);
        registry.requestUnlock();
        c = registry.candidates();
        assertEq(c.length, 1);
        assertEq(c[0], bob);
    }

    // ------------------------------------------------------------------ epochs

    function test_rollEpoch_topByStakeThenEarlierLock() public {
        address[] memory who = new address[](25);
        for (uint256 i; i < 25; ++i) {
            who[i] = address(uint160(0x1000 + i));
            stakeAs(who[i], MIN_STAKE + (i % 5) * M, address(uint160(0x9000 + i)));
            warp(1);
        }
        address[] memory set = registry.rollEpoch();
        assertEq(set.length, 20);
        // 5 stakes at each of 5 levels; the 5 lowest-level stakers (i % 5 == 0) are out
        for (uint256 i; i < 25; ++i) {
            assertEq(registry.isActive(0, who[i]), i % 5 != 0);
        }
        for (uint256 i = 1; i < set.length; ++i) {
            AttesterRegistry.Staker memory a = registry.stakerOf(set[i - 1]);
            AttesterRegistry.Staker memory b = registry.stakerOf(set[i]);
            assertTrue(a.amount > b.amount || (a.amount == b.amount && a.lockedAt < b.lockedAt));
        }
        vm.expectRevert(AttesterRegistry.AlreadyRolled.selector);
        registry.rollEpoch();
    }

    function test_rollEpoch_tieGoesToEarlierLockThenLowerAddress() public {
        AttesterRegistry r = new AttesterRegistry(IOrryToken(address(orry)), attestor, MIN_STAKE, 1, EPOCH, UNLOCK, genesis);
        address hi = address(0xBEEF2);
        address lo = address(0xBEEF1);
        _stakeOn(r, hi, MIN_STAKE, address(0xA1));
        _stakeOn(r, lo, MIN_STAKE, address(0xA2));
        address[] memory set = r.rollEpoch();
        assertEq(set.length, 1);
        assertEq(set[0], lo, "same lock time: the lower address");
        AttesterRegistry r2 = new AttesterRegistry(IOrryToken(address(orry)), attestor, MIN_STAKE, 1, EPOCH, UNLOCK, genesis);
        _stakeOn(r2, hi, MIN_STAKE, address(0xA3));
        warp(1);
        _stakeOn(r2, lo, MIN_STAKE, address(0xA4));
        set = r2.rollEpoch();
        assertEq(set[0], hi, "earlier lock wins");
    }

    function test_rollEpoch_gasAtMaxCandidates() public {
        for (uint256 i; i < 1000; ++i) {
            stakeAs(address(uint160(0x100000 + i)), MIN_STAKE + i * M, address(uint160(0x900000 + i)));
        }
        address extra = makeAddr("extra");
        orry.mint(extra, MIN_STAKE);
        vm.startPrank(extra);
        orry.approve(address(registry), MIN_STAKE);
        vm.expectRevert(AttesterRegistry.TooManyCandidates.selector);
        registry.stake(MIN_STAKE, makeAddr("extraProbe"));
        vm.stopPrank();
        uint256 g = gasleft();
        address[] memory set = registry.rollEpoch();
        uint256 used = g - gasleft();
        emit log_named_uint("rollEpoch gas, 1000 candidates", used);
        assertLt(used, 15_000_000);
        assertEq(set.length, 20);
        assertEq(set[0], address(uint160(0x100000 + 999)));
        assertEq(set[19], address(uint160(0x100000 + 980)));
    }

    function test_epochs_advanceWeekly() public {
        assertEq(registry.currentEpoch(), 0);
        assertEq(registry.epochStart(1), genesis + EPOCH);
        warp(EPOCH - 1);
        assertEq(registry.currentEpoch(), 0);
        warp(1);
        assertEq(registry.currentEpoch(), 1);
        stakeAs(alice, MIN_STAKE, aliceProbe);
        registry.rollEpoch();
        assertTrue(registry.isActive(1, alice));
        assertFalse(registry.isActive(0, alice));
    }

    // ------------------------------------------------------------------ exclude

    function test_exclude_onlyAttestorOwner_currentAndNextEpoch() public {
        stakeAs(alice, MIN_STAKE, aliceProbe);
        stakeAs(bob, MIN_STAKE, bobProbe);
        registry.rollEpoch();
        vm.expectRevert(AttesterRegistry.NotAttestorOwner.selector);
        registry.exclude(alice, bytes32("x"));
        vm.prank(ops);
        vm.expectRevert(AttesterRegistry.NotStaker.selector);
        registry.exclude(makeAddr("nobody"), bytes32("x"));
        vm.prank(ops);
        registry.exclude(alice, keccak256("probe log 7"));
        assertFalse(registry.isActive(0, alice));
        assertTrue(registry.isActive(0, bob));
        assertEq(registry.stakerOf(alice).amount, MIN_STAKE, "stake untouched");
        warp(EPOCH);
        registry.rollEpoch();
        assertFalse(registry.isActive(1, alice), "left out of the next roll");
        assertTrue(registry.isActive(1, bob));
        warp(EPOCH);
        registry.rollEpoch();
        assertTrue(registry.isActive(2, alice), "back after that");
    }

    function test_exclude_notActiveIsNoop() public {
        stakeAs(alice, MIN_STAKE, aliceProbe);
        vm.prank(ops);
        registry.exclude(alice, bytes32(0)); // not rolled: nothing to deactivate
        registry.rollEpoch();
        assertFalse(registry.isActive(0, alice));
    }

    // ------------------------------------------------------------------ forwarding

    function test_attest_forwardsAndCountsOncePerAgentPerEpoch() public {
        uint256 agent = newVerifiedAgent(agentOwner, agentOwner);
        stakeAs(alice, MIN_STAKE, aliceProbe);
        warp(10);
        vm.prank(aliceProbe);
        vm.expectRevert(AttesterRegistry.NotRolled.selector);
        registry.attest(agent, result(uint64(clock)));
        registry.rollEpoch();
        vm.prank(alice); // the staker itself is not a probe key
        vm.expectRevert(AttesterRegistry.NotActive.selector);
        registry.attest(agent, result(uint64(clock)));
        vm.prank(aliceProbe);
        registry.attest(agent, result(uint64(clock)));
        OrreryAttestor.Attestation memory stored = attestor.getAttestation(agent);
        assertEq(stored.attester, address(registry));
        assertEq(stored.observedAt, clock);
        assertTrue(registry.counted(0, alice, agent));
        assertEq(registry.results(0, alice), 1);
        warp(60);
        vm.prank(aliceProbe);
        registry.attest(agent, result(uint64(clock)));
        assertEq(registry.results(0, alice), 1, "same agent, same epoch: counted once");
        assertEq(registry.totalResults(0), 1);
        uint256 agent2 = newVerifiedAgent(makeAddr("owner2"), makeAddr("owner2"));
        vm.prank(aliceProbe);
        registry.attest(agent2, result(uint64(clock)));
        assertEq(registry.results(0, alice), 2);
        assertEq(registry.totalResults(0), 2);
    }

    function test_attest_inactiveOrUnknownKeyRefused() public {
        uint256 agent = newVerifiedAgent(agentOwner, agentOwner);
        registry.rollEpoch(); // empty set
        stakeAs(alice, MIN_STAKE, aliceProbe);
        vm.prank(aliceProbe);
        vm.expectRevert(AttesterRegistry.NotActive.selector);
        registry.attest(agent, result(uint64(clock)));
        vm.prank(makeAddr("random"));
        vm.expectRevert(AttesterRegistry.NotActive.selector);
        registry.attest(agent, result(uint64(clock)));
    }

    function test_attest_attestorRulesStillApply() public {
        uint256 agent = newVerifiedAgent(agentOwner, agentOwner);
        stakeAs(alice, MIN_STAKE, aliceProbe);
        registry.rollEpoch();
        vm.prank(aliceProbe);
        vm.expectRevert(OrreryAttestor.BadObservedAt.selector);
        registry.attest(agent, result(uint64(clock + 1)));
        vm.prank(ops);
        attestor.setAttester(address(registry), false);
        vm.prank(aliceProbe);
        vm.expectRevert(OrreryAttestor.NotAttester.selector);
        registry.attest(agent, result(uint64(clock)));
    }

    function test_attest_excludedOrUnlockedStops() public {
        uint256 agent = newVerifiedAgent(agentOwner, agentOwner);
        stakeAs(alice, MIN_STAKE, aliceProbe);
        stakeAs(bob, MIN_STAKE, bobProbe);
        registry.rollEpoch();
        warp(1);
        vm.prank(ops);
        registry.exclude(alice, bytes32("x"));
        vm.prank(aliceProbe);
        vm.expectRevert(AttesterRegistry.NotActive.selector);
        registry.attest(agent, result(uint64(clock)));
        vm.prank(bob);
        registry.requestUnlock();
        vm.prank(bobProbe);
        vm.expectRevert(AttesterRegistry.NotActive.selector);
        registry.attest(agent, result(uint64(clock)));
    }

    function _stakeOn(AttesterRegistry r, address who, uint256 amount, address probe) internal {
        orry.mint(who, amount);
        vm.startPrank(who);
        orry.approve(address(r), amount);
        r.stake(amount, probe);
        vm.stopPrank();
    }
}

/// @notice Moves 1 less than asked.
contract ShortOrry {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a - 1;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}
