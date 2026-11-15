// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOrryStaking} from "../../../src/orry/interfaces/IOrryStaking.sol";
import {IClaimAll, IOrryLens} from "../../../src/orry/interfaces/IOrryClaims.sol";
import {ClaimAll} from "../../../src/orry/ClaimAll.sol";
import {EarnVault} from "../../../src/orry/EarnVault.sol";
import {OrryLens} from "../../../src/orry/OrryLens.sol";
import {PairsBase} from "./PairsBase.sol";
import {MockFeed, MockToken} from "./mocks/EarnMocks.sol";

/// @dev ClaimAll and the lens over every factory vault (ETH, USDG and a third pair) plus staking.
contract ClaimAllLensTest is PairsBase {
    event ClaimedAll(address indexed account, IClaimAll.Paid[] paid);

    address internal constant TKN_AT = address(uint160(0xE) << 156 | 0x33); // above ORRY

    MockToken internal tkn;
    EarnVault internal ve;
    EarnVault internal vu;
    EarnVault internal vt;

    function setUp() public override {
        super.setUp();
        initHub(address(usdg));
        tkn = newToken("TKN", 8, TKN_AT);
        registerPair(address(tkn), new MockFeed(60_000e8));
        initHub(address(tkn), 5e6);
        ve = factoryVault(address(0));
        vu = factoryVault(address(usdg));
        vt = factoryVault(address(tkn));
        depositInto(ve, alice, 10 ether);
        depositInto(ve, bob, 10 ether);
        depositInto(vu, alice, 30_000e6);
        depositInto(vt, alice, 0.5e8);
        for (uint256 i; i < 3; ++i) {
            swapIn(address(0), true, 1 ether);
            swapIn(address(0), false, 4e24);
            swapIn(address(usdg), true, 3000e6);
            swapIn(address(usdg), false, 4e24);
            swapIn(address(tkn), true, 0.05e8);
            swapIn(address(tkn), false, 4e24);
        }
        ve.harvest();
        vu.harvest();
        vt.harvest();
        wait(2 days);
        vm.deal(address(staking), 10 ether);
        orry.transfer(address(staking), 1e24);
        staking.setOwed(alice, 0.3 ether, 5e22);
    }

    function test_wiring() public view {
        assertEq(claimAll.earnFactory(), address(factory));
        assertEq(claimAll.staking(), address(staking));
        assertEq(lens.earnFactory(), address(factory));
        assertEq(lens.staking(), address(staking));
    }

    /// @dev try/catch rather than expectRevert before `new`, so every case runs in any forge mode (isolate included).
    function test_constructors_reject_zero() public {
        bool ok;
        try new ClaimAll(address(0), address(staking)) {
            ok = true;
        } catch {}
        assertFalse(ok, "ClaimAll zero factory");
        try new ClaimAll(address(factory), address(0)) {
            ok = true;
        } catch {}
        assertFalse(ok, "ClaimAll zero staking");
        try new OrryLens(address(0), address(staking)) {
            ok = true;
        } catch {}
        assertFalse(ok, "lens zero factory");
        try new OrryLens(address(factory), address(0)) {
            ok = true;
        } catch {}
        assertFalse(ok, "lens zero staking");
        assertTrue(address(new ClaimAll(address(factory), address(staking))) != address(0), "valid arguments deploy");
    }

    function test_claimAll_pays_every_vault_and_staking_to_the_caller() public {
        (uint256 e0, uint256 e1) = ve.pendingFees(alice);
        (uint256 u0, uint256 u1) = vu.pendingFees(alice);
        (uint256 t0, uint256 t1) = vt.pendingFees(alice);
        assertTrue(e0 > 0 && e1 > 0 && u0 > 0 && u1 > 0 && t0 > 0 && t1 > 0, "every vault earned both sides");
        uint256 eth = alice.balance;
        uint256 r = orry.balanceOf(alice);
        uint256 us = usdg.balanceOf(alice);
        uint256 tk = tkn.balanceOf(alice);

        IClaimAll.Paid[] memory want = new IClaimAll.Paid[](4);
        want[0] = IClaimAll.Paid(address(orry), e1 + u1 + t1 + 5e22);
        want[1] = IClaimAll.Paid(address(0), e0 + 0.3 ether);
        want[2] = IClaimAll.Paid(address(usdg), u0);
        want[3] = IClaimAll.Paid(address(tkn), t0);
        vm.expectEmit(true, false, false, true, address(claimAll));
        emit ClaimedAll(alice, want);
        vm.prank(alice);
        IClaimAll.Paid[] memory paid = claimAll.claimAll();
        assertEq(paid.length, 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(paid[i].asset, want[i].asset);
            assertEq(paid[i].amount, want[i].amount);
        }
        assertEq(alice.balance - eth, want[1].amount);
        assertEq(orry.balanceOf(alice) - r, want[0].amount);
        assertEq(usdg.balanceOf(alice) - us, u0);
        assertEq(tkn.balanceOf(alice) - tk, t0);
        assertEq(address(claimAll).balance, 0, "holds nothing");
        assertEq(orry.balanceOf(address(claimAll)), 0);
        assertEq(usdg.balanceOf(address(claimAll)), 0);
        (uint256 b0,) = ve.pendingFees(bob);
        assertGt(b0, 0, "bob untouched");
    }

    function test_claimAll_with_nothing_lists_zeros() public {
        vm.prank(carol);
        IClaimAll.Paid[] memory paid = claimAll.claimAll();
        assertEq(paid.length, 4);
        assertEq(paid[0].asset, address(orry));
        assertEq(paid[1].asset, address(0));
        assertEq(paid[2].asset, address(usdg));
        assertEq(paid[3].asset, address(tkn));
        for (uint256 i; i < 4; ++i) {
            assertEq(paid[i].amount, 0);
        }
    }

    function test_claimables_match_sources() public {
        staking.setPlain(alice, 7e24, 2e24, uint64(block.timestamp + 3 days));
        IOrryLens.Claimables memory c = lens.claimables(alice);
        assertEq(c.earn.length, 3);
        EarnVault[3] memory vs = [ve, vu, vt];
        for (uint256 i; i < 3; ++i) {
            IOrryLens.EarnPosition memory e = c.earn[i];
            assertEq(e.vault, address(vs[i]));
            assertEq(e.quote, vs[i].quote());
            assertEq(e.shares, vs[i].sharesOf(alice));
            assertEq(e.unlockAt, vs[i].unlockAt(alice));
            (uint256 f0, uint256 f1) = vs[i].pendingFees(alice);
            assertEq(e.feesQuote, f0);
            assertEq(e.feesOrry, f1);
            (uint256 p0, uint256 p1) = vs[i].previewWithdraw(e.shares);
            assertEq(e.positionQuote, p0);
            assertEq(e.positionOrry, p1);
            assertGt(e.shares, 0);
        }
        assertEq(c.stakeActive, 7e24);
        assertEq(c.stakeLeaving, 2e24);
        assertEq(c.stakeReadyAt, block.timestamp + 3 days);
        assertEq(c.stakeRewardsEth, 0.3 ether);
        assertEq(c.stakeRewardsOrry, 5e22);

        c = lens.claimables(carol);
        assertEq(c.earn.length, 3, "one entry per vault, empty ones included");
        for (uint256 i; i < 3; ++i) {
            assertEq(c.earn[i].shares + c.earn[i].feesQuote + c.earn[i].positionQuote, 0);
        }
        assertEq(c.stakeActive + c.stakeRewardsEth, 0);
    }

    function test_agentClaimables_filters_and_flags() public {
        address oA = makeAddr("ownerA");
        address oB = makeAddr("ownerB");
        address oC = makeAddr("ownerC");
        address oD = makeAddr("ownerD");
        registry.setOwner(1, oA);
        registry.setOwner(2, oB);
        registry.setOwner(3, makeAddr("newOwner")); // identity moved since the stake
        // agent 4: never registered (ownerOf reverts like a burned token)
        staking.setAgent(1, oA, IOrryStaking.AgentPosition(alice, 5e24, 0, 0, uint64(block.timestamp + 90 days)));
        staking.setAgent(2, oB, IOrryStaking.AgentPosition(bob, 1e24, 0, 0, 0));
        staking.setAgent(3, oC, IOrryStaking.AgentPosition(alice, 2e24, 1e24, uint64(block.timestamp + 14 days), 0));
        staking.setAgent(4, oD, IOrryStaking.AgentPosition(alice, 3e24, 0, 0, 0));

        uint256[] memory ids = new uint256[](5);
        address[] memory owners = new address[](5);
        (ids[0], ids[1], ids[2], ids[3], ids[4]) = (1, 2, 3, 4, 9);
        (owners[0], owners[1], owners[2], owners[3], owners[4]) = (oA, oB, oC, oD, oA);

        IOrryLens.AgentClaimable[] memory list = lens.agentClaimables(alice, ids, owners);
        assertEq(list.length, 3, "only alice's positions");
        assertEq(list[0].agentId, 1);
        assertEq(list[0].owner, oA);
        assertEq(list[0].active, 5e24);
        assertTrue(list[0].reportedForAgent);
        assertEq(list[1].agentId, 3);
        assertEq(list[1].leaving, 1e24);
        assertEq(list[1].leavingAt, block.timestamp + 14 days);
        assertFalse(list[1].reportedForAgent, "identity moved");
        assertEq(list[2].agentId, 4);
        assertFalse(list[2].reportedForAgent, "unknown identity");

        assertEq(lens.agentClaimables(address(0), ids, owners).length, 0, "empty positions never match");
        address[] memory short = new address[](4);
        vm.expectRevert();
        lens.agentClaimables(alice, ids, short);
        address[] memory long = new address[](6);
        vm.expectRevert();
        lens.agentClaimables(alice, ids, long);
    }

    function test_agent_with_zero_owner_is_never_reported() public {
        staking.setAgent(5, address(0), IOrryStaking.AgentPosition(alice, 1, 0, 0, 0));
        uint256[] memory ids = new uint256[](1);
        address[] memory owners = new address[](1);
        ids[0] = 5;
        IOrryLens.AgentClaimable[] memory list = lens.agentClaimables(alice, ids, owners);
        assertEq(list.length, 1);
        assertFalse(list[0].reportedForAgent);
    }
}
