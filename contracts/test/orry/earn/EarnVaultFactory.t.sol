// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EarnVault} from "../../../src/orry/EarnVault.sol";
import {EarnVaultFactory} from "../../../src/orry/EarnVaultFactory.sol";
import {IEarnVaultFactory} from "../../../src/orry/interfaces/IEarnVaultFactory.sol";
import {PairsBase} from "./PairsBase.sol";
import {MockFeed, MockToken} from "./mocks/EarnMocks.sol";

/// @dev One Earn vault per hub (P-6): permissionless, deterministic, never twice, only for registered pairs.
contract EarnVaultFactoryTest is PairsBase {
    event VaultCreated(address indexed quote, address indexed vault);

    function test_constructor_and_wiring() public {
        assertEq(factory.hook(), address(hook));
        assertEq(factory.vaultCount(), 0);
        assertEq(factory.vaults().length, 0);
        // try/catch rather than expectRevert before `new` (forge isolate mode)
        bool ok;
        try new EarnVaultFactory(address(0)) {
            ok = true;
        } catch {}
        assertFalse(ok, "zero hook refused");
    }

    function test_create_both_launch_vaults() public {
        address pe = factory.predictVault(address(0));
        address pu = factory.predictVault(address(usdg));
        assertTrue(pe != pu);
        vm.expectEmit(true, true, false, false, address(factory));
        emit VaultCreated(address(0), pe);
        vm.prank(carol); // anyone
        address ve = factory.createVault(address(0));
        address vu = factory.createVault(address(usdg));
        assertEq(ve, pe, "CREATE2 address as predicted");
        // pinned independently: CREATE2 from the factory, salt = the quote, init code = vault code + (hook, quote)
        bytes32 initHash = keccak256(abi.encodePacked(type(EarnVault).creationCode, abi.encode(address(hook), address(0))));
        address want = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), bytes32(0), initHash))))
        );
        assertEq(ve, want, "salt is the quote (0 for native ETH)");
        bytes32 initU =
            keccak256(abi.encodePacked(type(EarnVault).creationCode, abi.encode(address(hook), address(usdg))));
        bytes32 saltU = bytes32(uint256(uint160(address(usdg))));
        assertEq(pu, address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), saltU, initU))))));
        assertEq(vu, pu);
        assertEq(factory.vaultOf(address(0)), ve);
        assertEq(factory.vaultOf(address(usdg)), vu);
        assertEq(factory.vaultCount(), 2);
        assertEq(factory.vaultAt(0), ve);
        assertEq(factory.vaultAt(1), vu);
        address[] memory all = factory.vaults();
        assertEq(all.length, 2);
        assertEq(all[0], ve);
        assertEq(all[1], vu);
        assertEq(EarnVault(payable(ve)).quote(), address(0));
        assertEq(EarnVault(payable(vu)).quote(), address(usdg));
        assertEq(EarnVault(payable(vu)).hook(), address(hook));
        assertEq(EarnVault(payable(vu)).orry(), address(orry));
        vm.expectRevert();
        factory.vaultAt(2);
    }

    function test_same_address_whoever_calls() public {
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        address a = factory.createVault(address(usdg));
        vm.revertToState(snap);
        vm.prank(bob);
        address b = factory.createVault(address(usdg));
        assertEq(a, b);
    }

    function test_never_twice_and_only_registered_pairs() public {
        factory.createVault(address(0));
        vm.expectRevert(IEarnVaultFactory.VaultExists.selector);
        factory.createVault(address(0));
        vm.expectRevert(IEarnVaultFactory.UnknownPair.selector);
        factory.createVault(address(orry));
        MockToken t = newToken("T", 18, address(uint160(0x50) << 152 | 0x99));
        MockFeed f = new MockFeed(1e8);
        vm.expectRevert(IEarnVaultFactory.UnknownPair.selector);
        factory.createVault(address(t));
        vm.prank(admin);
        hook.proposePair(address(t), address(f));
        vm.expectRevert(IEarnVaultFactory.UnknownPair.selector); // proposed is not registered
        factory.createVault(address(t));
        wait(48 hours);
        f.set(1e8, vm.getBlockTimestamp());
        vm.prank(admin);
        hook.executePair(address(t));
        address v = factory.createVault(address(t));
        assertEq(EarnVault(payable(v)).quote(), address(t));
        assertEq(factory.vaultCount(), 2, "the ETH vault and the new pair's");
    }

    /// @dev P-6: a factory vault holds only its own hub's position; deposits in one move nothing in another.
    function test_vaults_hold_only_their_own_hub() public {
        initHub(address(usdg));
        EarnVault ve = factoryVault(address(0));
        EarnVault vu = factoryVault(address(usdg));
        uint256 se = depositInto(ve, alice, 2 ether);
        uint256 su = depositInto(vu, alice, 6000e6);
        assertEq(ve.totalShares(), se);
        assertEq(vu.totalShares(), su);
        (uint256 qe, uint256 re) = ve.positionAmounts();
        (uint256 qu, uint256 ru) = vu.positionAmounts();
        assertApproxEqRel(qe, 2 ether, 1e15);
        assertApproxEqRel(qu, 6000e6, 1e15);
        assertApproxEqRel(re, ru, 0.01e18, "same ORRY value on both sides");
        // a USDG deposit leaves the ETH vault untouched
        depositInto(vu, bob, 3000e6);
        (uint256 qe2, uint256 re2) = ve.positionAmounts();
        assertEq(qe2, qe);
        assertEq(re2, re);
        assertEq(ve.totalShares(), se);
        assertEq(address(ve).balance, 0);
        assertEq(usdg.balanceOf(address(ve)), 0);
        assertEq(usdg.balanceOf(address(vu)), 0);
    }
}
