// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";

import {TreasuryBase} from "../utils/TreasuryBase.sol";
import {TreasuryHandler} from "./TreasuryHandler.sol";

/// @notice Invariant campaign and deterministic deep run for OrreryTreasury: T-1 to T-6 and G-2, with the real v1
/// OrreryAttestor as the verification target.
contract TreasuryInvariants is TreasuryBase {
    TreasuryHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new TreasuryHandler(treasury, usdg, orry, registry, attestor, owner, signerKey, START);
        for (uint256 i; i < h.actorCount(); ++i) {
            orry.transfer(h.actors(i), 100_000_000e18);
        }
        h.init();
        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](12);
        sels[0] = h.revenue.selector;
        sels[1] = h.sync.selector;
        sels[2] = h.withdrawOwner.selector;
        sels[3] = h.reclaim.selector;
        sels[4] = h.propose.selector;
        sels[5] = h.execute.selector;
        sels[6] = h.pull.selector;
        sels[7] = h.strangerPull.selector;
        sels[8] = h.credits.selector;
        sels[9] = h.verify.selector;
        sels[10] = h.warp.selector;
        sels[11] = h.warp.selector; // time matters for the coin delay and the windows
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    function invariant_T1_books_within_balance() public view {
        _checkT1();
    }

    function invariant_T2_usdg_leaves_only_to_owner_or_buyback() public view {
        _checkT2();
    }

    function invariant_T3_coin_set_once_after_delay() public view {
        _checkT3();
    }

    function invariant_T4_every_orry_payment_is_burned() public view {
        assertFalse(h.badT4(), "T-4");
    }

    function invariant_T5_quotes_single_use_and_signed() public view {
        assertFalse(h.badT5(), "T-5");
    }

    function invariant_T6_daily_verification_cap() public view {
        assertLe(h.maxVerificationsInADay(), 25, "T-6");
    }

    function invariant_G2_supply_never_rises() public view {
        assertFalse(h.badSupplyUp(), "G-2");
    }

    function test_deep_run_treasury() public {
        uint256 seed = 0x7ea5;
        h.propose(); // once: a later proposal would restart the 48 hours
        for (uint256 step; step < 4_000; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 a = seed;
            uint256 b = seed >> 64;
            uint256 c = seed >> 128;
            uint256 pick = seed % 100;
            if (pick < 14) h.revenue(b % 20_000e6);
            else if (pick < 18) h.sync();
            else if (pick < 22) h.withdrawOwner();
            else if (pick < 26) h.reclaim();
            else if (pick < 30) h.execute();
            else if (pick < 42) h.pull(b);
            else if (pick < 44) h.strangerPull(a);
            else if (pick < 62) h.credits(a, b % 500e18, c);
            else if (pick < 86) h.verify(a, b % 50e18, c);
            else h.warp(b % 1 hours);
            _checkAll();
        }
        string[14] memory names = [
            "revenue",
            "sync",
            "withdrawOwner",
            "reclaim",
            "propose",
            "execute",
            "pull",
            "strangerPull",
            "credits",
            "creditsRejected",
            "verify",
            "verifyRejected",
            "verifyCapped",
            "warp"
        ];
        for (uint256 i; i < names.length; ++i) {
            uint256 n = h.calls(bytes32(bytes(names[i])));
            console2.log(names[i], n);
            assertGt(n, 0, names[i]);
        }
        console2.log("USDG minted / to owner / to buyback", h.minted(), h.toOwner(), h.toBuyback());
        console2.log("most ORRY verifications in one UTC day", h.maxVerificationsInADay());
    }

    function _checkAll() internal view {
        _checkT1();
        _checkT2();
        _checkT3();
        assertFalse(h.badT4(), "T-4");
        assertFalse(h.badT5(), "T-5");
        assertLe(h.maxVerificationsInADay(), 25, "T-6");
        assertFalse(h.badSupplyUp(), "G-2");
    }

    function _checkT1() internal view {
        assertLe(treasury.ownerAccrued() + treasury.buybackReserve(), usdg.balanceOf(address(treasury)), "T-1");
    }

    /// T-2: every USDG that entered is in the treasury, with the owner, or with the buyback; the owner never got more
    /// than was accrued to it and the buyback never more than the daily bound (checked per call in the handler).
    function _checkT2() internal view {
        assertFalse(h.badT2(), "T-2 per call");
        assertEq(usdg.balanceOf(owner), h.toOwner(), "T-2 owner");
        assertEq(usdg.balanceOf(h.puller()), h.toBuyback(), "T-2 buyback");
        assertEq(usdg.balanceOf(address(treasury)) + h.toOwner() + h.toBuyback(), h.minted(), "T-2 conservation");
        if (!h.coinSet()) assertEq(h.toBuyback(), 0, "no pull while coinless");
    }

    function _checkT3() internal view {
        assertFalse(h.badT3(), "T-3");
        if (h.coinSet()) {
            assertEq(treasury.orry(), address(orry));
            assertGe(h.coinSetAt(), h.proposedAt() + 48 hours);
        } else {
            assertEq(treasury.orry(), address(0));
            assertEq(treasury.buyback(), address(0));
        }
    }
}
