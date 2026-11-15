// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CreditBase} from "./CreditBase.sol";
import {OrreryAttestor} from "../../src/OrreryAttestor.sol";
import {IERC20Min} from "../../src/interfaces/IExternal.sol";
import {IOrryBurnEvents} from "../../src/orry/interfaces/IOrryToken.sol";
import {AttesterRegistry} from "../../src/credit/AttesterRegistry.sol";
import {AttesterFeeSplitter, IAttestorTreasuryView} from "../../src/credit/AttesterFeeSplitter.sol";

contract AttesterFeeSplitterTest is CreditBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal aliceProbe = makeAddr("aliceProbe");
    address internal bobProbe = makeAddr("bobProbe");

    bytes32 internal constant VERIFICATION_TYPEHASH =
        keccak256("VerificationQuote(address payer,uint256 agentId,uint256 orryAmount,bytes32 quoteId,uint64 expiry)");

    function deploySplitter(IERC20Min u, address t, IAttestorTreasuryView a, AttesterRegistry r, uint16 share)
        external
        returns (AttesterFeeSplitter)
    {
        return new AttesterFeeSplitter(u, t, a, r, share);
    }

    function test_constructor_rejects() public {
        IERC20Min u = IERC20Min(address(usdg));
        IAttestorTreasuryView a = IAttestorTreasuryView(address(attestor));
        vm.expectRevert(AttesterFeeSplitter.ZeroAddress.selector);
        this.deploySplitter(IERC20Min(address(0)), address(treasury), a, registry, 3000);
        vm.expectRevert(AttesterFeeSplitter.ZeroAddress.selector);
        this.deploySplitter(u, address(0), a, registry, 3000);
        vm.expectRevert(AttesterFeeSplitter.ZeroAddress.selector);
        this.deploySplitter(u, address(treasury), IAttestorTreasuryView(address(0)), registry, 3000);
        vm.expectRevert(AttesterFeeSplitter.ZeroAddress.selector);
        this.deploySplitter(u, address(treasury), a, AttesterRegistry(address(0)), 3000);
        vm.expectRevert(AttesterFeeSplitter.BadShare.selector);
        this.deploySplitter(u, address(treasury), a, registry, 5001);
        assertEq(this.deploySplitter(u, address(treasury), a, registry, 5000).shareBps(), 5000);
    }

    function test_verificationFee_landsInSplitter_andSplits70_30() public {
        uint256 agent = newVerifiedAgent(makeAddr("op"), makeAddr("op"));
        assertEq(attestor.getVerification(agent).feePaid, 5 * U);
        assertEq(usdg.balanceOf(address(splitter)), 5 * U);
        vm.expectEmit(address(splitter));
        emit AttesterFeeSplitter.Split(0, 5 * U, 1_500_000, 3_500_000);
        (uint256 toA, uint256 toT) = splitter.split();
        assertEq(toA, 1_500_000);
        assertEq(toT, 3_500_000);
        assertEq(usdg.balanceOf(address(treasury)), 3_500_000);
        assertEq(splitter.booked(), 1_500_000);
        assertEq(splitter.pool(0), 1_500_000);
        vm.expectRevert(AttesterFeeSplitter.NothingToSplit.selector);
        splitter.split();
    }

    function test_split_roundsTowardTreasury() public {
        usdg.mint(address(splitter), 7);
        (uint256 toA, uint256 toT) = splitter.split();
        assertEq(toA, 2); // 7 * 0.3 = 2.1, down
        assertEq(toT, 5);
    }

    function test_claim_proRataByDistinctAgents() public {
        stakeAs(alice, MIN_STAKE, aliceProbe);
        stakeAs(bob, 2 * MIN_STAKE, bobProbe);
        uint256 a1 = newVerifiedAgent(makeAddr("o1"), makeAddr("o1"));
        uint256 a2 = newVerifiedAgent(makeAddr("o2"), makeAddr("o2"));
        uint256 a3 = newVerifiedAgent(makeAddr("o3"), makeAddr("o3"));
        registry.rollEpoch();
        warp(10);
        vm.startPrank(aliceProbe);
        registry.attest(a1, result(uint64(clock)));
        registry.attest(a2, result(uint64(clock)));
        vm.stopPrank();
        warp(10);
        vm.prank(bobProbe);
        registry.attest(a3, result(uint64(clock)));
        splitter.split(); // 15 USDG in: 4.5 to the epoch 0 pool
        assertEq(splitter.pool(0), 4_500_000);
        vm.prank(alice);
        vm.expectRevert(AttesterFeeSplitter.EpochNotEnded.selector);
        splitter.claim(0);
        assertEq(splitter.claimable(0, alice), 0);
        warp(EPOCH);
        assertEq(splitter.claimable(0, alice), 3_000_000);
        assertEq(splitter.claimable(0, bob), 1_500_000);
        vm.prank(alice);
        assertEq(splitter.claim(0), 3_000_000);
        vm.prank(alice);
        vm.expectRevert(AttesterFeeSplitter.AlreadyClaimed.selector);
        splitter.claim(0);
        assertEq(splitter.claimable(0, alice), 0);
        vm.prank(bob);
        splitter.claim(0);
        assertEq(usdg.balanceOf(alice), 3_000_000);
        assertEq(usdg.balanceOf(bob), 1_500_000);
        assertEq(splitter.booked(), 0);
        assertEq(splitter.claimedTotal(0), 4_500_000);
        vm.prank(makeAddr("nobody"));
        vm.expectRevert(AttesterFeeSplitter.NothingToClaim.selector);
        splitter.claim(0);
        vm.expectRevert(AttesterFeeSplitter.HasResults.selector);
        splitter.releaseUnused(0);
    }

    function test_releaseUnused_onlyEndedEpochWithoutResults() public {
        newVerifiedAgent(makeAddr("o1"), makeAddr("o1"));
        splitter.split();
        vm.expectRevert(AttesterFeeSplitter.EpochNotEnded.selector);
        splitter.releaseUnused(0);
        warp(EPOCH);
        uint256 before = usdg.balanceOf(address(treasury));
        assertEq(splitter.releaseUnused(0), 1_500_000);
        assertEq(usdg.balanceOf(address(treasury)) - before, 1_500_000);
        assertEq(splitter.booked(), 0);
        vm.expectRevert(AttesterFeeSplitter.AlreadyReleased.selector);
        splitter.releaseUnused(0);
        assertEq(splitter.claimable(0, alice), 0);
    }

    function test_split_blockedTreasuryReverts() public {
        usdg.mint(address(splitter), U);
        usdg.setBlocked(address(treasury), true);
        vm.expectRevert(AttesterFeeSplitter.TransferFailed.selector);
        splitter.split();
    }

    function test_revenueBookedToTheEpochOfTheSplit() public {
        usdg.mint(address(splitter), 10 * U);
        warp(EPOCH);
        splitter.split();
        assertEq(splitter.pool(0), 0);
        assertEq(splitter.pool(1), 3 * U);
    }

    // ------------------------------------------------------------------ ORRY verification route (F2)

    function _quote(address payer, uint256 agentId, uint256 amount, bytes32 id, uint64 expiry, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(VERIFICATION_TYPEHASH, payer, agentId, amount, id, expiry));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", splitter.domainSeparator(), sh)));
        return abi.encodePacked(r, s, v);
    }

    function _newAgent(address owner) internal returns (uint256 id) {
        vm.prank(owner);
        id = identity.register(owner);
    }

    function test_verifyWithOrry_burnsAndRecordsFeeFree() public {
        treasury.setOrry(address(orry));
        address payer = makeAddr("payer");
        uint256 id = _newAgent(payer);
        orry.mint(payer, 500 * M);
        uint64 exp = uint64(clock + 120);
        bytes memory sig = _quote(payer, id, 500 * M, "q1", exp, signerPk);
        vm.prank(payer);
        orry.approve(address(splitter), 500 * M);
        uint256 supply = orry.totalSupply();
        vm.expectEmit(address(splitter));
        emit IOrryBurnEvents.Burned(40, 500 * M);
        vm.prank(payer);
        splitter.verifyWithOrry(id, payer, 500 * M, "q1", exp, sig);
        assertEq(supply - orry.totalSupply(), 500 * M);
        assertTrue(attestor.isVerified(id));
        assertEq(attestor.getVerification(id).feePaid, 0);
        assertEq(usdg.balanceOf(address(splitter)), 0);
        assertTrue(splitter.quoteUsed("q1"));
        assertEq(splitter.verificationsToday(), 1);
        vm.prank(payer);
        vm.expectRevert(AttesterFeeSplitter.QuoteUsed.selector);
        splitter.verifyWithOrry(id, payer, 500 * M, "q1", exp, sig);
    }

    function test_verifyWithOrry_refusals() public {
        address payer = makeAddr("payer");
        uint256 id = _newAgent(payer);
        uint64 exp = uint64(clock + 120);
        bytes memory sig = _quote(payer, id, 5 * M, "q", exp, signerPk);
        vm.startPrank(payer);
        vm.expectRevert(AttesterFeeSplitter.CoinNotSet.selector);
        splitter.verifyWithOrry(id, payer, 5 * M, "q", exp, sig);
        vm.stopPrank();
        treasury.setOrry(address(orry));
        vm.startPrank(payer);
        vm.expectRevert(AttesterFeeSplitter.ZeroAmount.selector);
        splitter.verifyWithOrry(id, payer, 0, "q", exp, sig);
        vm.expectRevert(AttesterFeeSplitter.BadQuoteSignature.selector);
        splitter.verifyWithOrry(id, payer, 6 * M, "q", exp, sig); // amount differs from the signed one
        bytes memory other = _quote(payer, id, 5 * M, "q", exp, 0xB0B);
        vm.expectRevert(AttesterFeeSplitter.BadQuoteSignature.selector);
        splitter.verifyWithOrry(id, payer, 5 * M, "q", exp, other);
        vm.expectRevert(AttesterFeeSplitter.BadQuoteSignature.selector);
        splitter.verifyWithOrry(id, payer, 5 * M, "q", exp, hex"00");
        vm.stopPrank();
        // a quote for another payer does not work for this one
        vm.prank(makeAddr("thief"));
        vm.expectRevert(AttesterFeeSplitter.BadQuoteSignature.selector);
        splitter.verifyWithOrry(id, payer, 5 * M, "q", exp, sig);
        warp(121);
        vm.prank(payer);
        vm.expectRevert(AttesterFeeSplitter.QuoteExpired.selector);
        splitter.verifyWithOrry(id, payer, 5 * M, "q", exp, sig);
    }

    function test_verifyWithOrry_highSAndBadVRefused() public {
        treasury.setOrry(address(orry));
        address payer = makeAddr("payer");
        uint256 id = _newAgent(payer);
        uint64 exp = uint64(clock + 120);
        bytes memory sig = _quote(payer, id, 5 * M, "q", exp, signerPk);
        (bytes32 r, bytes32 s) = (bytes32(_slice(sig, 0)), bytes32(_slice(sig, 32)));
        uint8 v = uint8(sig[64]);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory twin = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.prank(payer);
        vm.expectRevert(AttesterFeeSplitter.BadQuoteSignature.selector);
        splitter.verifyWithOrry(id, payer, 5 * M, "q", exp, twin);
        bytes memory badV = abi.encodePacked(r, s, uint8(29));
        vm.prank(payer);
        vm.expectRevert(AttesterFeeSplitter.BadQuoteSignature.selector);
        splitter.verifyWithOrry(id, payer, 5 * M, "q", exp, badV);
    }

    function test_verifyWithOrry_dailyCap() public {
        treasury.setOrry(address(orry));
        address payer = makeAddr("payer");
        orry.mint(payer, 100 * M);
        vm.prank(payer);
        orry.approve(address(splitter), type(uint256).max);
        uint64 exp = uint64(clock + 120);
        for (uint256 i; i < 25; ++i) {
            uint256 id = _newAgent(payer);
            bytes32 q = bytes32(i + 1);
            bytes memory sig = _quote(payer, id, M, q, exp, signerPk);
            vm.prank(payer);
            splitter.verifyWithOrry(id, payer, M, q, exp, sig);
        }
        uint256 id26 = _newAgent(payer);
        bytes memory sig26 = _quote(payer, id26, M, bytes32(uint256(99)), exp, signerPk);
        vm.prank(payer);
        vm.expectRevert(AttesterFeeSplitter.DailyVerificationCap.selector);
        splitter.verifyWithOrry(id26, payer, M, bytes32(uint256(99)), exp, sig26);
        warp(1 days);
        assertEq(splitter.verificationsToday(), 0);
        sig26 = _quote(payer, id26, M, bytes32(uint256(99)), uint64(clock + 120), signerPk);
        vm.prank(payer);
        splitter.verifyWithOrry(id26, payer, M, bytes32(uint256(99)), uint64(clock + 120), sig26);
        assertEq(splitter.verificationsToday(), 1);
    }

    function test_verifyWithOrry_refusedWhileNotTheAttestorTreasury() public {
        treasury.setOrry(address(orry));
        vm.prank(ops);
        attestor.setTreasury(address(treasury));
        address payer = makeAddr("payer");
        uint256 id = _newAgent(payer);
        uint64 exp = uint64(clock + 120);
        bytes memory sig = _quote(payer, id, M, "q", exp, signerPk);
        vm.prank(payer);
        vm.expectRevert(AttesterFeeSplitter.NotAttestorTreasury.selector);
        splitter.verifyWithOrry(id, payer, M, "q", exp, sig);
    }

    function test_verifyWithOrry_shortBurnRefused() public {
        ShortBurnOrry sb = new ShortBurnOrry();
        treasury.setOrry(address(sb));
        address payer = makeAddr("payer");
        uint256 id = _newAgent(payer);
        sb.mint(payer, 10 * M);
        uint64 exp = uint64(clock + 120);
        bytes memory sig = _quote(payer, id, M, "q", exp, signerPk);
        vm.prank(payer);
        vm.expectRevert(AttesterFeeSplitter.InexactBurn.selector);
        splitter.verifyWithOrry(id, payer, M, "q", exp, sig);
    }

    /// @notice F2 in the spec: with the splitter as treasury, the old treasury route is refused by the attestor.
    function test_F2_treasuryAsPayerNowPaysUsdg() public {
        address payer = makeAddr("payer");
        uint256 id = _newAgent(payer);
        vm.prank(address(treasury)); // what OrreryTreasury.verifyWithOrry does
        vm.expectRevert(OrreryAttestor.TransferFailed.selector);
        attestor.payVerification(id, payer, uint128(5 * U));
    }

    function _slice(bytes memory b, uint256 at) internal pure returns (uint256 x) {
        assembly {
            x := mload(add(add(b, 32), at))
        }
    }
}

/// @notice burnFrom that burns one unit less than asked.
contract ShortBurnOrry {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
        totalSupply += a;
    }

    function burnFrom(address f, uint256 a) external {
        balanceOf[f] -= a - 1;
        totalSupply -= a - 1;
    }
}
