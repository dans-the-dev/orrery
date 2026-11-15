// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OrreryAttestor} from "../../../src/OrreryAttestor.sol";
import {IOrreryTreasury} from "../../../src/orry/interfaces/IOrreryTreasury.sol";
import {IOrryBurnEvents} from "../../../src/orry/interfaces/IOrryToken.sol";
import {OrreryTreasury} from "../../../src/orry/OrreryTreasury.sol";
import {TreasuryBase} from "./utils/TreasuryBase.sol";
import {HalfBurnOrry} from "./utils/StakeMocks.sol";

contract OrreryTreasuryTest is TreasuryBase {
    address internal puller = makeAddr("buybackPuller");
    uint256 internal agentId;
    address internal agentOwner = makeAddr("agentOwner");

    function setUp() public override {
        super.setUp();
        vm.prank(agentOwner);
        agentId = registry.register(agentOwner);
        vm.prank(alice);
        orry.approve(address(treasury), type(uint256).max);
    }

    // ---------------------------------------------------------------- constructor

    function test_constructor_values() public view {
        assertEq(treasury.OWNER_BPS(), 1000);
        assertEq(treasury.COIN_DELAY(), 48 hours);
        assertEq(treasury.COIN_WINDOW(), 7 days);
        assertEq(treasury.PULL_BPS_PER_DAY(), 1000);
        assertEq(treasury.MAX_ORRY_VERIFICATIONS_PER_DAY(), 25);
        assertEq(treasury.MAX_QUOTE_SIGNERS(), 3);
        assertEq(treasury.usdg(), address(usdg));
        assertEq(treasury.attestor(), address(attestor));
        assertEq(treasury.owner(), owner);
        assertEq(treasury.orry(), address(0));
        assertEq(treasury.buyback(), address(0));
        assertTrue(treasury.isQuoteSigner(quoteSigner));
    }

    function test_constructor_checks() public {
        address[] memory four = new address[](4);
        for (uint256 i; i < 4; ++i) four[i] = address(uint160(100 + i));
        _ctorReverts(owner, 1000, four, abi.encodeWithSelector(IOrreryTreasury.TooManySigners.selector));
        address[] memory zero = new address[](1);
        _ctorReverts(owner, 1000, zero, abi.encodeWithSelector(IOrreryTreasury.ZeroAddress.selector));
        _ctorReverts(address(0), 1000, new address[](0), abi.encodeWithSelector(IOrreryTreasury.ZeroAddress.selector));
        _ctorReverts(owner, 10_001, new address[](0), abi.encodeWithSignature("Error(string)", "bps above 10000"));
    }

    /// @dev try/catch rather than expectRevert: with dynamic test linking and isolate (the effective forge config) a
    /// `new` becomes `vm.deployCode`, and an expected revert there ends the test, so later checks would never run.
    function _ctorReverts(address o, uint16 bps, address[] memory signers, bytes memory expected) internal {
        try new OrreryTreasury(address(usdg), address(attestor), o, bps, signers) returns (OrreryTreasury) {
            revert("constructor did not revert");
        } catch (bytes memory data) {
            assertEq(data, expected);
        }
    }

    // ---------------------------------------------------------------- sync and the owner share

    function test_sync_splits_new_revenue_only() public {
        _revenue(999);
        vm.expectEmit(address(treasury));
        emit IOrreryTreasury.Synced(99, 900);
        treasury.sync();
        assertEq(treasury.ownerAccrued(), 99);
        assertEq(treasury.buybackReserve(), 900);
        vm.recordLogs();
        treasury.sync();
        assertEq(vm.getRecordedLogs().length, 0, "nothing new, no event");
        _revenue(100e6);
        treasury.sync();
        assertEq(treasury.ownerAccrued(), 99 + 10e6);
        assertEq(treasury.buybackReserve(), 900 + 90e6);
    }

    function test_withdrawOwnerShare() public {
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.NotOwner.selector);
        treasury.withdrawOwnerShare();
        vm.prank(owner);
        vm.expectRevert(IOrreryTreasury.ZeroAmount.selector);
        treasury.withdrawOwnerShare();
        _revenue(50e6);
        vm.expectEmit(address(treasury));
        emit IOrreryTreasury.OwnerShareWithdrawn(owner, 5e6);
        vm.prank(owner);
        treasury.withdrawOwnerShare(); // syncs first
        assertEq(usdg.balanceOf(owner), 5e6);
        assertEq(treasury.ownerAccrued(), 0);
        assertEq(treasury.buybackReserve(), 45e6);
        assertEq(usdg.balanceOf(address(treasury)), 45e6);
    }

    function test_reclaimReserve_only_while_coinless() public {
        _revenue(100e6);
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.NotOwner.selector);
        treasury.reclaimReserve();
        vm.expectEmit(address(treasury));
        emit IOrreryTreasury.ReserveReclaimed(90e6);
        vm.prank(owner);
        treasury.reclaimReserve();
        assertEq(treasury.buybackReserve(), 0);
        assertEq(treasury.ownerAccrued(), 100e6);
        vm.prank(owner);
        vm.expectRevert(IOrreryTreasury.ZeroAmount.selector);
        treasury.reclaimReserve();
        _setCoin(puller);
        _revenue(10e6);
        vm.prank(owner);
        vm.expectRevert(IOrreryTreasury.CoinAlreadySet.selector);
        treasury.reclaimReserve();
    }

    // ---------------------------------------------------------------- coin set once (T-3)

    function test_proposeCoin_checks() public {
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.NotOwner.selector);
        treasury.proposeCoin(address(orry), puller);
        vm.startPrank(owner);
        vm.expectRevert(IOrreryTreasury.ZeroAddress.selector);
        treasury.proposeCoin(address(0), puller);
        vm.expectRevert(IOrreryTreasury.ZeroAddress.selector);
        treasury.proposeCoin(address(orry), address(0));
        vm.expectEmit(address(treasury));
        emit IOrreryTreasury.CoinProposed(address(orry), puller, uint64(_now() + 48 hours));
        treasury.proposeCoin(address(orry), puller);
        vm.stopPrank();
    }

    function test_executeCoin_timing() public {
        vm.prank(owner);
        vm.expectRevert(IOrreryTreasury.NoProposal.selector);
        treasury.executeCoin();
        uint256 t0 = _now();
        vm.prank(owner);
        treasury.proposeCoin(address(orry), puller);
        uint64 at = uint64(t0 + 48 hours);
        vm.warp(at - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IOrreryTreasury.ProposalNotReady.selector, at));
        treasury.executeCoin();
        vm.warp(at);
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.NotOwner.selector);
        treasury.executeCoin();
        vm.expectEmit(address(treasury));
        emit IOrreryTreasury.CoinSet(address(orry), puller);
        vm.prank(owner);
        treasury.executeCoin();
        assertEq(treasury.orry(), address(orry));
        assertEq(treasury.buyback(), puller);
        vm.startPrank(owner);
        vm.expectRevert(IOrreryTreasury.CoinAlreadySet.selector);
        treasury.executeCoin();
        vm.expectRevert(IOrreryTreasury.CoinAlreadySet.selector);
        treasury.proposeCoin(address(orry), alice);
        vm.stopPrank();
    }

    function test_executeCoin_expires_and_new_proposal_restarts_delay() public {
        uint256 t0 = _now();
        vm.prank(owner);
        treasury.proposeCoin(address(orry), puller);
        vm.warp(t0 + 48 hours + 7 days + 1);
        vm.prank(owner);
        vm.expectRevert(IOrreryTreasury.ProposalExpired.selector);
        treasury.executeCoin();
        vm.warp(t0 + 48 hours + 7 days); // last second of the window still works
        vm.prank(owner);
        treasury.proposeCoin(address(orry), alice); // replaces and restarts the 48 hours
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IOrreryTreasury.ProposalNotReady.selector, uint64(t0 + 96 hours + 7 days))
        );
        treasury.executeCoin();
        vm.warp(t0 + 96 hours + 7 days);
        vm.prank(owner);
        treasury.executeCoin();
        assertEq(treasury.buyback(), alice);
    }

    // ---------------------------------------------------------------- pullBuyback (T-2)

    function test_pullBuyback_coinless_and_access() public {
        _revenue(100e6);
        vm.prank(puller);
        vm.expectRevert(IOrreryTreasury.CoinNotSet.selector);
        treasury.pullBuyback(1);
        assertEq(treasury.availableForBuyback(), 0);
        _setCoin(puller);
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.NotBuyback.selector);
        treasury.pullBuyback(1);
        vm.prank(puller);
        vm.expectRevert(IOrreryTreasury.ZeroAmount.selector);
        treasury.pullBuyback(0);
    }

    function test_pullBuyback_daily_bound() public {
        _setCoin(puller);
        _revenue(1_000e6); // reserve 900 USDG
        assertEq(treasury.availableForBuyback(), 90e6);
        vm.expectEmit(address(treasury));
        emit IOrreryTreasury.BuybackPulled(puller, 60e6);
        vm.prank(puller);
        assertEq(treasury.pullBuyback(60e6), 60e6);
        assertEq(treasury.availableForBuyback(), 30e6);
        _revenue(1_000e6); // the window base stays the reserve at the window start
        assertEq(treasury.availableForBuyback(), 30e6);
        vm.prank(puller);
        assertEq(treasury.pullBuyback(1_000e6), 30e6, "capped at what is left");
        vm.prank(puller);
        vm.expectRevert(IOrreryTreasury.ZeroAmount.selector);
        treasury.pullBuyback(1);
        assertEq(usdg.balanceOf(puller), 90e6);
        vm.warp(_now() + 1 days);
        uint256 reserve = treasury.buybackReserve();
        assertEq(reserve, 900e6 - 90e6 + 900e6);
        assertEq(treasury.availableForBuyback(), reserve / 10, "new window, new base");
        vm.prank(puller);
        treasury.pullBuyback(type(uint256).max);
        assertEq(treasury.buybackReserve(), reserve - reserve / 10);
    }

    function test_pullBuyback_whole_reserve_at_one_usdg_or_less() public {
        _setCoin(puller);
        _revenue(1_111_111); // reserve 1,000,000 = 1 USDG
        assertEq(treasury.availableForBuyback(), 1e6);
        vm.prank(puller);
        assertEq(treasury.pullBuyback(5e6), 1e6);
        assertEq(treasury.buybackReserve(), 0);
        assertEq(treasury.ownerAccrued(), 111_111);
    }

    // ---------------------------------------------------------------- burnForCredits (T-4, T-5)

    function test_burnForCredits_happy() public {
        _setCoin(puller);
        bytes32 q = keccak256("q1");
        uint64 exp = uint64(_now() + 120);
        bytes memory sig = _creditsSig(signerKey, address(treasury), alice, 3, 25e18, q, exp);
        uint256 supply = orry.totalSupply();
        vm.expectEmit(address(treasury));
        emit IOrreryTreasury.CreditsPaid(alice, 3, 25e18, q);
        vm.expectEmit(address(treasury));
        emit IOrryBurnEvents.Burned(2, 25e18);
        vm.prank(alice);
        treasury.burnForCredits(3, 25e18, q, exp, sig);
        assertEq(supply - orry.totalSupply(), 25e18, "T-4");
        assertTrue(treasury.quoteUsed(q));
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.QuoteUsed.selector);
        treasury.burnForCredits(3, 25e18, q, exp, sig);
    }

    function test_burnForCredits_rejections() public {
        bytes32 q = keccak256("q2");
        uint64 exp = uint64(_now() + 120);
        bytes memory sig = _creditsSig(signerKey, address(treasury), alice, 1, 1e18, q, exp);
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.CoinNotSet.selector);
        treasury.burnForCredits(1, 1e18, q, exp, sig);
        _setCoin(puller);
        exp = uint64(_now() + 120);
        sig = _creditsSig(signerKey, address(treasury), alice, 1, 1e18, q, exp);
        vm.startPrank(alice);
        vm.expectRevert(IOrreryTreasury.ZeroAmount.selector);
        treasury.burnForCredits(0, 1e18, q, exp, sig);
        vm.expectRevert(IOrreryTreasury.ZeroAmount.selector);
        treasury.burnForCredits(1, 0, q, exp, sig);
        // tampered amount, other buyer, wrong signer, malformed signature
        vm.expectRevert(IOrreryTreasury.BadQuoteSignature.selector);
        treasury.burnForCredits(1, 1e18 - 1, q, exp, sig);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(IOrreryTreasury.BadQuoteSignature.selector);
        treasury.burnForCredits(1, 1e18, q, exp, sig);
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        bytes memory bad = _creditsSig(strangerKey, address(treasury), alice, 1, 1e18, q, exp);
        vm.startPrank(alice);
        vm.expectRevert(IOrreryTreasury.BadQuoteSignature.selector);
        treasury.burnForCredits(1, 1e18, q, exp, bad);
        vm.expectRevert(IOrreryTreasury.BadQuoteSignature.selector);
        treasury.burnForCredits(1, 1e18, q, exp, hex"1234");
        // a quote signed for another treasury (domain) fails
        bytes memory otherDomain = _creditsSig(signerKey, address(0xBEEF), alice, 1, 1e18, q, exp);
        vm.expectRevert(IOrreryTreasury.BadQuoteSignature.selector);
        treasury.burnForCredits(1, 1e18, q, exp, otherDomain);
        vm.stopPrank();
        // expired: expiry == now accepted, one second later refused
        vm.warp(exp + 1);
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.QuoteExpired.selector);
        treasury.burnForCredits(1, 1e18, q, exp, sig);
        uint64 nowExp = uint64(_now());
        bytes memory edge = _creditsSig(signerKey, address(treasury), alice, 1, 1e18, keccak256("edge"), nowExp);
        vm.prank(alice);
        treasury.burnForCredits(1, 1e18, keccak256("edge"), nowExp, edge);
        // a disabled signer's quotes fail
        vm.prank(owner);
        treasury.setQuoteSigner(quoteSigner, false);
        bytes32 q3 = keccak256("q3");
        bytes memory s3 = _creditsSig(signerKey, address(treasury), alice, 1, 1e18, q3, nowExp);
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.BadQuoteSignature.selector);
        treasury.burnForCredits(1, 1e18, q3, nowExp, s3);
    }

    /// The malleable twin of a valid signature (s' = n - s, v flipped) recovers the same signer and must be refused, as
    /// must a 64-byte signature and an out-of-range v.
    function test_signature_malleability_and_shape_refused() public {
        _setCoin(puller);
        bytes32 q = keccak256("m1");
        uint64 exp = uint64(_now() + 120);
        bytes memory sig = _creditsSig(signerKey, address(treasury), alice, 1, 1e18, q, exp);
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory twin = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domain(address(treasury)),
                keccak256(abi.encode(CREDITS_TYPEHASH, alice, uint32(1), uint256(1e18), q, exp))
            )
        );
        assertEq(ecrecover(digest, v == 27 ? 28 : 27, r, bytes32(n - uint256(s))), quoteSigner, "the twin recovers");
        vm.startPrank(alice);
        vm.expectRevert(IOrreryTreasury.BadQuoteSignature.selector);
        treasury.burnForCredits(1, 1e18, q, exp, twin);
        vm.expectRevert(IOrreryTreasury.BadQuoteSignature.selector);
        treasury.burnForCredits(1, 1e18, q, exp, abi.encodePacked(r, s)); // 64 bytes
        vm.expectRevert(IOrreryTreasury.BadQuoteSignature.selector);
        treasury.burnForCredits(1, 1e18, q, exp, abi.encodePacked(r, s, uint8(29)));
        vm.expectRevert(IOrreryTreasury.BadQuoteSignature.selector);
        treasury.burnForCredits(1, 1e18, q, exp, abi.encodePacked(sig, uint8(0))); // 66 bytes
        treasury.burnForCredits(1, 1e18, q, exp, sig); // the original still works once
        vm.stopPrank();
    }

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly ("memory-safe") {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    function test_burn_that_misses_supply_reverts_inexact() public {
        HalfBurnOrry half = new HalfBurnOrry(alice, 1e24);
        address[] memory signers = new address[](1);
        signers[0] = quoteSigner;
        OrreryTreasury t = new OrreryTreasury(address(usdg), address(attestor), owner, 1000, signers);
        vm.prank(owner);
        t.proposeCoin(address(half), puller);
        vm.warp(_now() + 48 hours);
        vm.prank(owner);
        t.executeCoin();
        vm.prank(alice);
        half.approve(address(t), type(uint256).max);
        uint64 exp = uint64(_now() + 60);
        bytes memory sig = _creditsSig(signerKey, address(t), alice, 1, 10e18, keccak256("h"), exp);
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.InexactBurn.selector);
        t.burnForCredits(1, 10e18, keccak256("h"), exp, sig);
    }

    // ---------------------------------------------------------------- verifyWithOrry (T-4, T-6) on the real attestor

    function test_verifyWithOrry_records_fee_zero_and_moves_no_usdg() public {
        _setCoin(puller);
        _revenue(500e6);
        treasury.sync();
        uint256 treasuryUsdg = usdg.balanceOf(address(treasury));
        uint256 aliceUsdg = usdg.balanceOf(alice);
        uint256 supply = orry.totalSupply();
        bytes32 q = keccak256("v1");
        uint64 exp = uint64(_now() + 120);
        bytes memory sig = _verificationSig(signerKey, address(treasury), alice, agentId, 8e18, q, exp);
        vm.expectEmit(address(attestor));
        emit OrreryAttestor.VerificationPaid(agentId, address(treasury), agentOwner, 0);
        vm.expectEmit(address(treasury));
        emit IOrreryTreasury.VerificationBurned(agentId, alice, 8e18, q);
        vm.expectEmit(address(treasury));
        emit IOrryBurnEvents.Burned(3, 8e18);
        vm.prank(alice);
        treasury.verifyWithOrry(agentId, agentOwner, 8e18, q, exp, sig);
        assertTrue(attestor.isVerified(agentId));
        OrreryAttestor.Verification memory v = attestor.getVerification(agentId);
        assertEq(v.feePaid, 0);
        assertEq(v.ownerAtPayment, agentOwner);
        assertEq(usdg.balanceOf(address(treasury)), treasuryUsdg, "no USDG moved");
        assertEq(usdg.balanceOf(alice), aliceUsdg);
        assertEq(supply - orry.totalSupply(), 8e18);
        assertEq(treasury.ownerAccrued() + treasury.buybackReserve(), treasuryUsdg);
    }

    function test_verifyWithOrry_rejections_roll_back_the_burn() public {
        bytes32 q = keccak256("v2");
        uint64 exp = uint64(_now() + 120);
        bytes memory sig = _verificationSig(signerKey, address(treasury), alice, agentId, 8e18, q, exp);
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.CoinNotSet.selector);
        treasury.verifyWithOrry(agentId, agentOwner, 8e18, q, exp, sig);
        _setCoin(puller);
        exp = uint64(_now() + 120);
        sig = _verificationSig(signerKey, address(treasury), alice, agentId, 8e18, q, exp);
        uint256 supply = orry.totalSupply();
        vm.startPrank(alice);
        vm.expectRevert(IOrreryTreasury.ZeroAmount.selector);
        treasury.verifyWithOrry(agentId, agentOwner, 0, q, exp, sig);
        vm.expectRevert(IOrreryTreasury.BadQuoteSignature.selector);
        treasury.verifyWithOrry(agentId + 1, agentOwner, 8e18, q, exp, sig);
        vm.expectRevert(OrreryAttestor.OwnerChanged.selector);
        treasury.verifyWithOrry(agentId, bob, 8e18, q, exp, sig);
        vm.stopPrank();
        assertEq(orry.totalSupply(), supply, "reverted call burns nothing");
        assertFalse(treasury.quoteUsed(q));
        vm.prank(alice);
        treasury.verifyWithOrry(agentId, agentOwner, 8e18, q, exp, sig);
        bytes32 q2 = keccak256("v3");
        bytes memory sig2 = _verificationSig(signerKey, address(treasury), alice, agentId, 8e18, q2, exp);
        vm.prank(alice);
        vm.expectRevert(OrreryAttestor.AlreadyVerified.selector);
        treasury.verifyWithOrry(agentId, agentOwner, 8e18, q2, exp, sig2);
    }

    function test_verifyWithOrry_daily_cap_per_utc_day() public {
        _setCoin(puller);
        // move to the start of a UTC day so the 26 calls share one day
        uint256 dayStart = (_now() / 1 days + 1) * 1 days;
        vm.warp(dayStart);
        uint64 exp = uint64(dayStart + 1 days);
        for (uint256 i; i < 26; ++i) {
            vm.prank(agentOwner);
            uint256 id = registry.register(agentOwner);
            bytes32 q = keccak256(abi.encode("cap", i));
            bytes memory sig = _verificationSig(signerKey, address(treasury), alice, id, 1e18, q, exp);
            if (i == 25) vm.expectRevert(IOrreryTreasury.DailyVerificationCap.selector);
            vm.prank(alice);
            treasury.verifyWithOrry(id, agentOwner, 1e18, q, exp, sig);
        }
        vm.warp(dayStart + 1 days - 1);
        vm.prank(agentOwner);
        uint256 id2 = registry.register(agentOwner);
        bytes32 q2 = keccak256("late");
        bytes memory sig2 = _verificationSig(signerKey, address(treasury), alice, id2, 1e18, q2, exp);
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.DailyVerificationCap.selector);
        treasury.verifyWithOrry(id2, agentOwner, 1e18, q2, exp, sig2);
        vm.warp(dayStart + 1 days); // next UTC day
        vm.prank(alice);
        treasury.verifyWithOrry(id2, agentOwner, 1e18, q2, exp, sig2);
    }

    // ---------------------------------------------------------------- signers and ownership

    function test_setQuoteSigner() public {
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.NotOwner.selector);
        treasury.setQuoteSigner(alice, true);
        vm.startPrank(owner);
        vm.expectRevert(IOrreryTreasury.ZeroAddress.selector);
        treasury.setQuoteSigner(address(0), true);
        vm.expectEmit(address(treasury));
        emit IOrreryTreasury.QuoteSignerSet(alice, true);
        treasury.setQuoteSigner(alice, true);
        treasury.setQuoteSigner(bob, true);
        vm.expectRevert(IOrreryTreasury.TooManySigners.selector);
        treasury.setQuoteSigner(carol, true);
        treasury.setQuoteSigner(alice, true); // already on: no-op
        treasury.setQuoteSigner(bob, false);
        treasury.setQuoteSigner(carol, true);
        vm.stopPrank();
        assertTrue(treasury.isQuoteSigner(carol));
        assertFalse(treasury.isQuoteSigner(bob));
    }

    function test_two_step_ownership() public {
        assertEq(treasury.pendingOwner(), address(0));
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.NotOwner.selector);
        treasury.transferOwnership(alice);
        vm.expectEmit(address(treasury));
        emit IOrreryTreasury.OwnershipTransferStarted(owner, bob);
        vm.prank(owner);
        treasury.transferOwnership(bob);
        assertEq(treasury.pendingOwner(), bob);
        vm.prank(alice);
        vm.expectRevert(IOrreryTreasury.NotOwner.selector);
        treasury.acceptOwnership();
        assertEq(treasury.owner(), owner, "unchanged until accepted");
        vm.expectEmit(address(treasury));
        emit IOrreryTreasury.OwnershipTransferred(owner, bob);
        vm.prank(bob);
        treasury.acceptOwnership();
        assertEq(treasury.owner(), bob);
        assertEq(treasury.pendingOwner(), address(0));
        _revenue(10e6);
        vm.prank(owner);
        vm.expectRevert(IOrreryTreasury.NotOwner.selector);
        treasury.withdrawOwnerShare();
        vm.prank(bob);
        treasury.withdrawOwnerShare();
        assertEq(usdg.balanceOf(bob), 1e6);
        vm.prank(bob);
        vm.expectRevert(IOrreryTreasury.NotOwner.selector);
        treasury.acceptOwnership(); // pending cleared
    }

    function test_transfer_to_zero_cancels_and_constructor_emits() public {
        vm.prank(owner);
        treasury.transferOwnership(bob);
        vm.expectEmit(address(treasury));
        emit IOrreryTreasury.OwnershipTransferStarted(owner, address(0));
        vm.prank(owner);
        treasury.transferOwnership(address(0));
        assertEq(treasury.pendingOwner(), address(0));
        vm.prank(bob);
        vm.expectRevert(IOrreryTreasury.NotOwner.selector);
        treasury.acceptOwnership();
        vm.expectEmit();
        emit IOrreryTreasury.OwnershipTransferred(address(0), alice);
        new OrreryTreasury(address(usdg), address(attestor), alice, 1000, new address[](0));
    }
}
