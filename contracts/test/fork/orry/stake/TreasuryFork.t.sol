// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";

import {OrreryAttestor} from "../../../../src/OrreryAttestor.sol";
import {IIdentityRegistry, IERC20Min} from "../../../../src/interfaces/IExternal.sol";
import {IOrreryTreasury} from "../../../../src/orry/interfaces/IOrreryTreasury.sol";
import {OrreryTreasury} from "../../../../src/orry/OrreryTreasury.sol";
import {MockOrry} from "../../../orry/stake/utils/StakeMocks.sol";
import {QuoteSigning} from "../../../orry/stake/utils/TreasuryBase.sol";

interface IRegistryRegister {
    function register(string memory agentURI) external returns (uint256);
}

/// @notice OrreryTreasury as it ships with Orrery v1 (R-12): coinless, on a fork of 4663 with the real USDG and the
/// real ERC-8004 IdentityRegistry, deployed in the order of `docs/ORRY-BUILD-SPEC.md` 3.5: OrreryAttestor (treasury =
/// owner wallet) -> OrreryTreasury(usdg, attestor, owner, 1000, signers) -> attestor.setTreasury(treasury) from the
/// deployer -> read-backs. Then the v1 revenue paths (verification fee, x402 pack payment) and the owner's powers.
/// Run: forge test --match-path 'test/fork/orry/stake/TreasuryFork.t.sol' --fork-url https://rpc.mainnet.chain.robinhood.com
contract TreasuryForkTest is QuoteSigning {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    IERC20Min internal usdg = IERC20Min(USDG);
    OrreryAttestor internal attestor;
    OrreryTreasury internal treasury;

    address internal ownerWallet = makeAddr("ownerWallet");
    address internal user = makeAddr("user");
    address internal quoteSigner;
    uint256 internal signerKey;

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url of Robinhood Chain 4663");
        (quoteSigner, signerKey) = makeAddrAndKey("quoteSigner");
        // this contract plays the deployer, which is the attestor owner (M1)
        attestor = new OrreryAttestor(IIdentityRegistry(IDENTITY_REGISTRY), usdg, address(this), ownerWallet, 5e6);
        address[] memory signers = new address[](1);
        signers[0] = quoteSigner;
        treasury = new OrreryTreasury(address(usdg), address(attestor), ownerWallet, 1000, signers);
        attestor.setTreasury(address(treasury));
        deal(address(usdg), user, 1_000e6);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function test_fork_v1_deploy_readbacks() public view {
        assertEq(attestor.treasury(), address(treasury));
        assertEq(treasury.orry(), address(0));
        assertEq(treasury.buyback(), address(0));
        assertEq(treasury.OWNER_BPS(), 1000);
        assertEq(treasury.usdg(), USDG);
        assertEq(treasury.attestor(), address(attestor));
        assertEq(treasury.owner(), ownerWallet);
        assertEq(treasury.pendingOwner(), address(0)); // R-20 read-back
        assertTrue(treasury.isQuoteSigner(quoteSigner));
        assertEq(treasury.availableForBuyback(), 0);
        assertEq(usdg.decimals(), 6);
    }

    function test_fork_v1_revenue_splits_and_owner_powers() public {
        // a verification fee paid in USDG through the attestor lands in the treasury
        vm.startPrank(user);
        uint256 agentId = IRegistryRegister(IDENTITY_REGISTRY).register("ipfs://orrery-treasury-fork");
        (bool ok,) = address(usdg).call(abi.encodeWithSignature("approve(address,uint256)", address(attestor), 5e6));
        require(ok);
        attestor.payVerification(agentId, user, 5e6);
        // an x402 pack payment is a plain USDG transfer to the treasury (payTo)
        require(usdg.transfer(address(treasury), 10e6));
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(treasury)), 15e6);
        assertEq(attestor.getVerification(agentId).feePaid, 5e6);

        uint256 g = gasleft();
        treasury.sync();
        console2.log("sync gas", g - gasleft());
        assertEq(treasury.ownerAccrued(), 1.5e6);
        assertEq(treasury.buybackReserve(), 13.5e6);

        // coinless: no ORRY path and no pull
        vm.expectRevert(IOrreryTreasury.CoinNotSet.selector);
        treasury.pullBuyback(1);
        bytes memory sig = _creditsSig(signerKey, address(treasury), user, 1, 1e18, keccak256("q"), uint64(_now() + 60));
        vm.prank(user);
        vm.expectRevert(IOrreryTreasury.CoinNotSet.selector);
        treasury.burnForCredits(1, 1e18, keccak256("q"), uint64(_now() + 60), sig);

        // the owner takes its share, and while coinless may reclaim the reserve
        vm.prank(ownerWallet);
        g = gasleft();
        treasury.withdrawOwnerShare();
        console2.log("withdrawOwnerShare gas", g - gasleft());
        assertEq(usdg.balanceOf(ownerWallet), 1.5e6);
        vm.prank(user);
        vm.expectRevert(IOrreryTreasury.NotOwner.selector);
        treasury.reclaimReserve();
        vm.prank(ownerWallet);
        treasury.reclaimReserve();
        vm.prank(ownerWallet);
        treasury.withdrawOwnerShare();
        assertEq(usdg.balanceOf(ownerWallet), 15e6);
        assertEq(usdg.balanceOf(address(treasury)), 0);
    }

    function test_fork_coin_set_later_then_bounded_pull() public {
        deal(address(usdg), address(treasury), 10_000e6);
        MockOrry orry = new MockOrry(address(this), 1e27);
        address buyback = makeAddr("buybackStandIn");
        uint256 t0 = _now();
        vm.prank(ownerWallet);
        treasury.proposeCoin(address(orry), buyback);
        vm.warp(t0 + 48 hours - 1);
        vm.prank(ownerWallet);
        vm.expectRevert(abi.encodeWithSelector(IOrreryTreasury.ProposalNotReady.selector, uint64(t0 + 48 hours)));
        treasury.executeCoin();
        vm.warp(t0 + 48 hours);
        vm.prank(ownerWallet);
        treasury.executeCoin();
        vm.prank(ownerWallet);
        vm.expectRevert(IOrreryTreasury.CoinAlreadySet.selector);
        treasury.reclaimReserve();
        assertEq(treasury.availableForBuyback(), 900e6, "10% of the 9,000 USDG reserve");
        vm.prank(buyback);
        assertEq(treasury.pullBuyback(type(uint256).max), 900e6);
        assertEq(usdg.balanceOf(buyback), 900e6);
        vm.prank(buyback);
        vm.expectRevert(IOrreryTreasury.ZeroAmount.selector);
        treasury.pullBuyback(1);
    }
}
