// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {DataFeeSplitter} from "../../src/data/DataFeeSplitter.sol";
import {IDataFeeSplitter} from "../../src/data/interfaces/IDataFeeSplitter.sol";
import {IOrryBurnEvents} from "../../src/orry/interfaces/IOrryToken.sol";
import {
    DataOrry,
    DataRewardPool,
    DataTreasury,
    OtherTokenPool,
    ReenteringPool,
    RefusingPool,
    ShortBurnOrry,
    ShortPool
} from "./DataMocks.sol";

/// @notice Unit tests for `DataFeeSplitter` (`docs/updates/L2-DATA-MCP-SPEC.md` 2.1, invariants DS-1 to DS-7).
contract DataFeeSplitterTest is Test {
    DataOrry orry;
    DataTreasury treasury;
    DataRewardPool rewardPool;
    DataFeeSplitter s;
    address owner = makeAddr("treasuryOwner");
    address stranger = makeAddr("stranger");
    uint256 t0 = 1_800_000_000;

    function setUp() public {
        vm.warp(t0);
        orry = new DataOrry();
        treasury = new DataTreasury(owner);
        rewardPool = new DataRewardPool(address(orry));
        s = new DataFeeSplitter(address(orry), address(treasury));
    }

    function _pay(uint256 a) internal {
        orry.mint(address(s), a);
    }

    function _setPool(address p) internal {
        vm.prank(owner);
        s.proposePool(p);
        vm.warp(t0 + 48 hours);
        vm.prank(owner);
        s.executePool();
    }

    function deploy(address r, address t) external returns (address) {
        return address(new DataFeeSplitter(r, t));
    }

    // ---------------------------------------------------------------- constructor and constants

    function test_constants() public view {
        assertEq(s.BURN_BPS(), 7000);
        assertEq(s.BURN_SOURCE(), 11, "8 to 10 belong to L1, 7 to the MerchantSplitter");
        assertEq(s.POOL_DELAY(), 48 hours);
        assertEq(s.orry(), address(orry));
        assertEq(s.treasury(), address(treasury));
        assertEq(s.pool(), address(0));
    }

    function test_constructor_rejects_zero_addresses() public {
        vm.expectRevert(IDataFeeSplitter.ZeroAddress.selector);
        this.deploy(address(0), address(treasury));
        vm.expectRevert(IDataFeeSplitter.ZeroAddress.selector);
        this.deploy(address(orry), address(0));
    }

    // ---------------------------------------------------------------- split before the pool (DS-1, DS-4, DS-7)

    function test_split_burns_70_percent_and_holds_30_until_the_pool_is_set() public {
        _pay(1000e18);
        uint256 supply = orry.totalSupply();
        vm.expectEmit(address(s));
        emit IOrryBurnEvents.Burned(11, 700e18);
        vm.expectEmit(address(s));
        emit IDataFeeSplitter.Split(1000e18, 700e18, 300e18);
        vm.prank(stranger);
        (uint256 burned, uint256 toPool) = s.split();
        assertEq(burned, 700e18);
        assertEq(toPool, 300e18);
        assertEq(supply - orry.totalSupply(), 700e18, "burned, not moved");
        assertEq(orry.balanceOf(address(s)), 300e18);
        assertEq(s.poolOwed(), 300e18);
    }

    function test_burn_rounds_down_and_the_pool_gets_the_dust() public {
        _pay(9);
        (uint256 burned, uint256 toPool) = s.split();
        assertEq(burned, 6, "floor(9 * 0.7) = 6");
        assertEq(toPool, 3);
        _pay(1);
        (burned, toPool) = s.split();
        assertEq(burned, 0, "floor(0.7) = 0: nothing burned, no Burned event needed");
        assertEq(toPool, 1);
        assertEq(s.poolOwed(), 4);
    }

    function test_split_of_one_wei_emits_no_burn_event() public {
        _pay(1);
        vm.recordLogs();
        s.split();
        assertEq(vm.getRecordedLogs().length, 1, "only Split");
    }

    function test_second_split_counts_only_fresh_orry() public {
        _pay(100);
        s.split();
        _pay(10);
        (uint256 burned, uint256 toPool) = s.split();
        assertEq(burned, 7);
        assertEq(toPool, 3);
        assertEq(s.poolOwed(), 33);
        assertEq(orry.balanceOf(address(s)), 33);
    }

    function test_nothing_to_split_reverts() public {
        vm.expectRevert(IDataFeeSplitter.NothingToSplit.selector);
        s.split();
        _pay(10);
        s.split();
        vm.expectRevert(IDataFeeSplitter.NothingToSplit.selector);
        s.split(); // the booking waits for the pool; it is not "fresh"
    }

    function test_short_burn_token_is_refused() public {
        ShortBurnOrry bad = new ShortBurnOrry();
        DataFeeSplitter s2 = new DataFeeSplitter(address(bad), address(treasury));
        bad.mint(address(s2), 100);
        vm.expectRevert(IDataFeeSplitter.InexactBurn.selector);
        s2.split();
    }

    function test_preview_matches_split() public {
        _pay(12345);
        (uint256 rec, uint256 b, uint256 tp, uint256 owedAfter) = s.previewSplit();
        assertEq(rec, 12345);
        (uint256 burned, uint256 toPool) = s.split();
        assertEq(b, burned);
        assertEq(tp, toPool);
        assertEq(owedAfter, s.poolOwed());
        _pay(10);
        (rec, b, tp, owedAfter) = s.previewSplit();
        assertEq(rec, 10, "the booking held for the pool is not counted as received");
        assertEq(b, 7);
        assertEq(owedAfter, s.poolOwed() + 3);
        s.split();
        _setPool(address(rewardPool));
        _pay(10);
        (,,, owedAfter) = s.previewSplit();
        assertEq(owedAfter, 0, "with a pool everything booked is sent");
    }

    // ---------------------------------------------------------------- pool set once, 48 h, by the treasury owner (DS-5)

    function test_pool_flow_and_held_share_is_sent_on_the_next_split() public {
        _pay(1000);
        s.split();
        vm.expectEmit(address(s));
        emit IDataFeeSplitter.PoolProposed(address(rewardPool), uint64(t0 + 48 hours));
        vm.prank(owner);
        s.proposePool(address(rewardPool));
        (address p, uint64 at) = s.pendingPool();
        assertEq(p, address(rewardPool));
        assertEq(at, t0 + 48 hours);

        vm.warp(t0 + 48 hours - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IDataFeeSplitter.PoolNotReady.selector, uint64(t0 + 48 hours)));
        s.executePool();

        vm.warp(t0 + 48 hours);
        vm.expectEmit(address(s));
        emit IDataFeeSplitter.PoolSet(address(rewardPool));
        vm.prank(owner);
        s.executePool();
        assertEq(s.pool(), address(rewardPool));
        (p, at) = s.pendingPool();
        assertEq(p, address(0));
        assertEq(at, 0);

        // the 300 held since before the pool existed goes on the next split, even with nothing fresh
        vm.expectEmit(address(s));
        emit IDataFeeSplitter.PoolFunded(address(rewardPool), 300);
        vm.prank(stranger);
        s.split();
        assertEq(orry.balanceOf(address(rewardPool)), 300);
        assertEq(rewardPool.freeBalance(address(orry)), 300, "booked by the pool, not only transferred");
        assertEq(s.poolOwed(), 0);
        assertEq(orry.balanceOf(address(s)), 0);
        assertEq(orry.allowance(address(s), address(rewardPool)), 0, "exact approval used up");
    }

    function test_with_pool_split_sends_30_percent_at_once() public {
        _setPool(address(rewardPool));
        _pay(1000);
        (uint256 burned, uint256 toPool) = s.split();
        assertEq(burned, 700);
        assertEq(toPool, 300);
        assertEq(orry.balanceOf(address(rewardPool)), 300);
        assertEq(s.poolOwed(), 0);
    }

    function test_only_the_treasury_owner_of_the_moment_proposes_and_executes() public {
        vm.prank(stranger);
        vm.expectRevert(IDataFeeSplitter.NotTreasuryOwner.selector);
        s.proposePool(address(rewardPool));
        vm.prank(owner);
        s.proposePool(address(rewardPool));
        vm.warp(t0 + 48 hours);
        vm.prank(stranger);
        vm.expectRevert(IDataFeeSplitter.NotTreasuryOwner.selector);
        s.executePool();
        // ownership moved on the treasury: the old owner is out, the new one is in
        address next = makeAddr("nextOwner");
        treasury.setOwner(next);
        vm.prank(owner);
        vm.expectRevert(IDataFeeSplitter.NotTreasuryOwner.selector);
        s.executePool();
        vm.prank(next);
        s.executePool();
        assertEq(s.pool(), address(rewardPool));
    }

    function test_pool_is_set_once() public {
        _setPool(address(rewardPool));
        DataRewardPool other = new DataRewardPool(address(orry));
        vm.startPrank(owner);
        vm.expectRevert(IDataFeeSplitter.PoolAlreadySet.selector);
        s.proposePool(address(other));
        vm.expectRevert(IDataFeeSplitter.PoolAlreadySet.selector);
        s.executePool();
        vm.stopPrank();
    }

    function test_new_proposal_replaces_and_restarts_the_delay() public {
        vm.prank(owner);
        s.proposePool(address(rewardPool));
        vm.warp(t0 + 47 hours);
        DataRewardPool other = new DataRewardPool(address(orry));
        vm.prank(owner);
        s.proposePool(address(other));
        vm.warp(t0 + 48 hours);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IDataFeeSplitter.PoolNotReady.selector, uint64(t0 + 95 hours)));
        s.executePool();
        vm.warp(t0 + 95 hours);
        vm.prank(owner);
        s.executePool();
        assertEq(s.pool(), address(other));
    }

    function test_execute_without_proposal_reverts() public {
        vm.prank(owner);
        vm.expectRevert(IDataFeeSplitter.NoPoolProposal.selector);
        s.executePool();
    }

    function test_proposal_rejects_zero_wrong_token_and_non_pools() public {
        vm.startPrank(owner);
        vm.expectRevert(IDataFeeSplitter.ZeroAddress.selector);
        s.proposePool(address(0));
        OtherTokenPool otp = new OtherTokenPool();
        vm.expectRevert(IDataFeeSplitter.WrongPool.selector);
        s.proposePool(address(otp));
        vm.expectRevert(IDataFeeSplitter.WrongPool.selector);
        s.proposePool(makeAddr("eoa"));
        vm.expectRevert(IDataFeeSplitter.WrongPool.selector);
        s.proposePool(address(orry)); // a contract without orry()
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- hostile or broken pools (DS-6)

    function test_refusing_pool_blocks_no_burn_and_keeps_the_booking() public {
        RefusingPool rp = new RefusingPool(address(orry));
        _setPool(address(rp));
        _pay(1000);
        uint256 supply = orry.totalSupply();
        (uint256 burned,) = s.split();
        assertEq(burned, 700);
        assertEq(supply - orry.totalSupply(), 700, "the burn happened");
        assertEq(s.poolOwed(), 300, "booking kept");
        assertEq(orry.allowance(address(s), address(rp)), 0, "allowance withdrawn");
        // the pool recovers: the next split sends the booking without fresh ORRY
        rp.setRefuse(false);
        s.split();
        assertEq(s.poolOwed(), 0);
        assertEq(orry.balanceOf(address(rp)), 300);
    }

    function test_pool_that_pulls_less_is_refused() public {
        ShortPool sp = new ShortPool(address(orry));
        _setPool(address(sp));
        _pay(1000);
        vm.expectRevert(IDataFeeSplitter.InexactFunding.selector);
        s.split();
    }

    function test_reentry_from_the_pool_is_blocked() public {
        ReenteringPool rp = new ReenteringPool(address(orry));
        rp.setSplitter(address(s));
        _setPool(address(rp));
        _pay(1000);
        s.split();
        assertFalse(rp.reentered(), "nested split refused by the guard");
        assertEq(orry.balanceOf(address(rp)), 300);
        assertEq(s.poolOwed(), 0);
    }

    // ---------------------------------------------------------------- fuzz (DS-1, DS-2)

    function testFuzz_split_conserves_and_burns_exactly(uint96 a, uint96 b, bool poolBetween) public {
        uint256 supply0 = orry.totalSupply();
        _pay(a);
        if (a != 0) s.split();
        if (poolBetween) _setPool(address(rewardPool));
        _pay(b);
        if (b != 0 || (poolBetween && s.poolOwed() != 0)) s.split();
        uint256 burnedTotal = uint256(a) * 7000 / 10000 + uint256(b) * 7000 / 10000;
        assertEq(orry.totalSupply(), supply0 + uint256(a) + b - burnedTotal, "burned exactly floor(70%) of each split");
        assertEq(
            uint256(a) + b,
            burnedTotal + orry.balanceOf(address(rewardPool)) + s.poolOwed(),
            "received = burned + funded + owed (nothing unsplit)"
        );
        assertEq(orry.balanceOf(address(s)), s.poolOwed());
    }
}
