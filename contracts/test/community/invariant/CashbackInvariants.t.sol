// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

import {CashbackRewards} from "../../../src/community/CashbackRewards.sol";
import {ReferralRegistry} from "../../../src/community/ReferralRegistry.sol";
import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";
import {MockOrryPrice} from "../utils/CommunityMocks.sol";
import {CashbackHandler} from "./CashbackHandler.sol";

/// @notice RF-1 to RF-5 (`docs/updates/L1-COMMUNITY-SPEC.md` 4) under random links, accruals, buyback shares, voids,
/// openings, claims and closings, plus a deterministic deep run that must reach every state.
contract CashbackInvariantsTest is Test {
    MockOrry internal orry;
    MockOrryPrice internal price;
    ReferralRegistry internal registry;
    CashbackRewards internal sink;
    CashbackHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        orry = new MockOrry(address(this), 1e36);
        price = new MockOrryPrice();
        registry = new ReferralRegistry();
        uint256 n = vm.getNonce(address(this));
        address handlerAt = vm.computeCreateAddress(address(this), n + 1);
        sink = new CashbackRewards(
            address(orry),
            address(price),
            address(registry),
            handlerAt,
            CashbackRewards.Config(30 days, 365 days, 90 days, 1000e6, 5000, 1000)
        );
        handler = new CashbackHandler(sink, registry, orry);
        require(address(handler) == handlerAt, "handler address");
        vm.prank(address(handler));
        sink.setPublisher(address(handler));
        orry.transfer(address(handler), 1e35);

        bytes4[] memory sel = new bytes4[](12);
        sel[0] = handler.link.selector;
        sel[1] = handler.buybackShare.selector;
        sel[2] = handler.accrueCashback.selector;
        sel[3] = handler.accrueReferral.selector;
        sel[4] = handler.accrueReferral.selector;
        sel[5] = handler.voidMonth.selector;
        sel[6] = handler.open.selector;
        sel[7] = handler.claim.selector;
        sel[8] = handler.claim.selector;
        sel[9] = handler.close.selector;
        sel[10] = handler.warp.selector;
        sel[11] = handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// RF-5: the sink holds exactly what came in minus what was claimed; reserved never exceeds it.
    function invariant_rf5_books() public view {
        uint256 bal = orry.balanceOf(address(sink));
        assertEq(bal, handler.ghostIn() - handler.ghostOut(), "conservation");
        assertEq(sink.free() + sink.totalReserved(), bal, "free + reserved");
        uint256 left;
        for (uint256 i; i < handler.monthCount(); ++i) {
            uint256 m = handler.months(i);
            CashbackRewards.Period memory p = sink.periodOf(m);
            assertLe(handler.ghostClaimed(m), p.reserve, "claims within reserve");
            assertEq(p.left + handler.ghostClaimed(m) + handler.ghostReturned(m), p.reserve, "reserve split");
            left += p.left;
        }
        assertEq(left, sink.totalReserved(), "total reserved");
    }

    /// RF-1 and RF-3: links never change; referral USD per referrer per month stays within the cap.
    function invariant_rf1_rf3() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            assertEq(registry.referrerOf(a), handler.firstReferrer(a), "RF-1");
            assertTrue(registry.referrerOf(a) != a, "self link");
            for (uint256 j; j < handler.monthCount(); ++j) {
                assertLe(sink.referralUsd(a, handler.months(j)), 1000e6, "RF-3");
            }
        }
    }

    /// RF-4: no claim succeeded before its month could open.
    function invariant_rf4_hold() public view {
        assertEq(handler.earlyClaim(), 0, "RF-4");
    }

    function test_deep_run_reaches_every_state() public {
        uint256 seed = 7;
        for (uint256 i; i < 3000; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 pick = seed % 100;
            uint256 a = seed >> 8;
            uint256 b = seed >> 72;
            uint256 c = seed >> 136;
            if (pick < 8) handler.link(a, b);
            else if (pick < 16) handler.buybackShare(a);
            else if (pick < 34) handler.accrueCashback(a, b);
            else if (pick < 56) handler.accrueReferral(a, b, c);
            else if (pick < 58) handler.voidMonth(a, b);
            else if (pick < 66) handler.open(a);
            else if (pick < 82) handler.claim(a, b);
            else if (pick < 86) handler.close(a);
            else handler.warp(a % 3 == 0 ? 20 days : 2 days);
            if (i % 250 == 0) invariant_rf5_books();
        }
        invariant_rf5_books();
        invariant_rf1_rf3();
        invariant_rf4_hold();
        console2.log("links / cashback / referral", handler.nLinks(), handler.nCashback(), handler.nReferral());
        console2.log("cap refusals / voided", handler.nCapRefusals(), handler.nVoided());
        console2.log("opened / claims / closed", handler.nOpened(), handler.nClaims(), handler.nClosed());
        assertGt(handler.nReferral(), 0);
        assertGt(handler.nCapRefusals(), 0);
        assertGt(handler.nVoided(), 0);
        assertGt(handler.nOpened(), 0);
        assertGt(handler.nClaims(), 0);
        assertGt(handler.nClosed(), 0);
    }
}
