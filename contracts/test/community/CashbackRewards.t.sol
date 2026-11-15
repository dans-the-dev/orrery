// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommunityBase} from "./utils/CommunityBase.sol";
import {Mock1271} from "./utils/CommunityMocks.sol";
import {CashbackRewards} from "../../src/community/CashbackRewards.sol";
import {ReferralRegistry} from "../../src/community/ReferralRegistry.sol";
import {Months} from "../../src/community/Months.sol";

contract MonthsHarness {
    function monthOf(uint256 t) external pure returns (uint256) {
        return Months.monthOf(t);
    }

    function startOf(uint256 m) external pure returns (uint256) {
        return Months.startOf(m);
    }
}

/// @notice ReferralRegistry (RF-1), CashbackRewards (RF-2 to RF-5, L1-12, L1-13) and the calendar months.
contract CashbackRewardsTest is CommunityBase {
    uint256 internal constant JAN_2027 = 24324;
    uint256 internal constant FEB_2027_START = 1801440000;
    MonthsHarness internal months;

    function setUp() public override {
        super.setUp();
        months = new MonthsHarness();
    }

    function _cb(address account, uint128 feeUsd, uint128 rewardUsd, bytes32 ref)
        internal
        view
        returns (CashbackRewards.Accrual memory)
    {
        return CashbackRewards.Accrual(account, 1, address(0), uint64(block.timestamp), feeUsd, rewardUsd, ref);
    }

    function _rf(address referrer, address referee, uint128 feeUsd, uint128 rewardUsd, bytes32 ref)
        internal
        view
        returns (CashbackRewards.Accrual memory)
    {
        return CashbackRewards.Accrual(referrer, 2, referee, uint64(block.timestamp), feeUsd, rewardUsd, ref);
    }

    function _post(CashbackRewards.Accrual memory a) internal {
        CashbackRewards.Accrual[] memory xs = new CashbackRewards.Accrual[](1);
        xs[0] = a;
        vm.prank(publisher);
        cashback.accrue(xs);
    }

    function _postExpect(CashbackRewards.Accrual memory a, bytes memory err) internal {
        CashbackRewards.Accrual[] memory xs = new CashbackRewards.Accrual[](1);
        xs[0] = a;
        vm.prank(publisher);
        vm.expectRevert(err);
        cashback.accrue(xs);
    }

    function _m(uint256 m) internal pure returns (uint256[] memory xs) {
        xs = new uint256[](1);
        xs[0] = m;
    }

    /// @dev The buyback's cashback share arriving as a plain transfer.
    function _sinkGets(uint256 amount) internal {
        orry.transfer(address(cashback), amount);
    }

    // ------------------------------------------------------------------ months

    function test_months_known_dates() public view {
        assertEq(months.monthOf(T0), JAN_2027);
        assertEq(months.monthOf(0), 23640);
        assertEq(months.monthOf(951782400), 24001); // 2000-02-29
        assertEq(months.monthOf(4102444800), 25200); // 2100-01-01
        assertEq(months.startOf(JAN_2027), 1798761600);
        assertEq(months.startOf(JAN_2027 + 1), FEB_2027_START);
        assertEq(months.startOf(JAN_2027 + 2), 1803859200);
        assertEq(months.startOf(2024 * 12 + 1), 1706745600);
        assertEq(months.startOf(2024 * 12 + 2), 1709251200);
        assertEq(months.startOf(2100 * 12 + 2), 4107542400);
        assertEq(months.startOf(23640), 0);
    }

    function testFuzz_months_roundtrip(uint256 m) public view {
        m = bound(m, 23640, 23640 + 12 * 1000);
        uint256 s = months.startOf(m);
        uint256 e = months.startOf(m + 1);
        assertEq(months.monthOf(s), m);
        assertEq(months.monthOf(e - 1), m);
        uint256 len = (e - s) / 1 days;
        assertTrue(len >= 28 && len <= 31);
        assertEq((e - s) % 1 days, 0);
    }

    // ------------------------------------------------------------------ registry (RF-1)

    function test_link_once_never_changes() public {
        vm.prank(bob);
        registry.link(alice);
        assertEq(registry.referrerOf(bob), alice);
        assertEq(registry.linkedAt(bob), T0);
        vm.prank(bob);
        vm.expectRevert(ReferralRegistry.AlreadyLinked.selector);
        registry.link(carol);
        vm.prank(carol);
        vm.expectRevert(ReferralRegistry.SelfReferral.selector);
        registry.link(carol);
        vm.prank(carol);
        vm.expectRevert(ReferralRegistry.ZeroAddress.selector);
        registry.link(address(0));
    }

    function test_link_with_sig_eoa_and_1271() public {
        (address referee, uint256 key) = makeAddrAndKey("referee");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = registry.digestOf(referee, alice, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        // a different referrer than signed is refused
        vm.expectRevert(ReferralRegistry.BadSignature.selector);
        registry.linkWithSig(referee, carol, deadline, abi.encodePacked(r, s, v));
        registry.linkWithSig(referee, alice, deadline, abi.encodePacked(r, s, v));
        assertEq(registry.referrerOf(referee), alice);
        vm.expectRevert(ReferralRegistry.AlreadyLinked.selector);
        registry.linkWithSig(referee, alice, deadline, abi.encodePacked(r, s, v));

        (address owner, uint256 ownerKey) = makeAddrAndKey("safeOwner");
        Mock1271 safe = new Mock1271(owner);
        digest = registry.digestOf(address(safe), bob, deadline);
        (v, r, s) = vm.sign(ownerKey, digest);
        registry.linkWithSig(address(safe), bob, deadline, abi.encodePacked(r, s, v));
        assertEq(registry.referrerOf(address(safe)), bob);

        vm.warp(deadline + 1);
        vm.expectRevert(ReferralRegistry.Expired.selector);
        registry.linkWithSig(carol, bob, deadline, abi.encodePacked(r, s, v));
    }

    // ------------------------------------------------------------------ accruals (RF-2, RF-3)

    function test_accrue_bounds() public {
        CashbackRewards.Accrual[] memory xs = new CashbackRewards.Accrual[](1);
        xs[0] = _cb(alice, 100e6, 2e6, "r1");
        vm.prank(alice);
        vm.expectRevert(CashbackRewards.NotPublisher.selector);
        cashback.accrue(xs);
        // cashback ceiling 10%
        _postExpect(_cb(alice, 100e6, 10e6 + 1, "r1"), abi.encodeWithSelector(CashbackRewards.BadAccrual.selector, 0));
        _postExpect(_cb(address(0), 100e6, 1, "r1"), abi.encodeWithSelector(CashbackRewards.BadAccrual.selector, 0));
        _postExpect(_cb(alice, 100e6, 0, "r1"), abi.encodeWithSelector(CashbackRewards.BadAccrual.selector, 0));
        CashbackRewards.Accrual memory a = _cb(alice, 100e6, 1, "r1");
        a.referee = bob;
        _postExpect(a, abi.encodeWithSelector(CashbackRewards.BadAccrual.selector, 0));
        a = _cb(alice, 100e6, 1, "r1");
        a.kind = 3;
        _postExpect(a, abi.encodeWithSelector(CashbackRewards.BadAccrual.selector, 0));
        a = _cb(alice, 100e6, 1, "r1");
        a.feePaidAt = uint64(block.timestamp + 1);
        _postExpect(a, abi.encodeWithSelector(CashbackRewards.BadAccrual.selector, 0));
        a.feePaidAt = uint64(block.timestamp - 35 days - 1);
        _postExpect(a, abi.encodeWithSelector(CashbackRewards.BadAccrual.selector, 0));
        a.feePaidAt = uint64(block.timestamp - 35 days);
        _post(a);
        _post(_cb(alice, 100e6, 10e6, "r2"));
        _postExpect(_cb(alice, 100e6, 10e6, "r2"), abi.encodeWithSelector(CashbackRewards.DuplicateAccrual.selector, 0));
        assertEq(cashback.owedUsd(alice, JAN_2027), 10e6 + 1);
        assertEq(cashback.periodOf(JAN_2027).totalUsd, 10e6 + 1);
    }

    function test_referral_rules() public {
        // no link yet
        _postExpect(_rf(alice, bob, 100e6, 20e6, "f1"), abi.encodeWithSelector(CashbackRewards.BadAccrual.selector, 0));
        vm.prank(bob);
        registry.link(alice);
        // wrong referrer, above 50%, fee before the link, fee after 90 days
        _postExpect(_rf(carol, bob, 100e6, 20e6, "f1"), abi.encodeWithSelector(CashbackRewards.BadAccrual.selector, 0));
        _postExpect(_rf(alice, bob, 100e6, 50e6 + 1, "f1"), abi.encodeWithSelector(CashbackRewards.BadAccrual.selector, 0));
        CashbackRewards.Accrual memory a = _rf(alice, bob, 100e6, 50e6, "f1");
        a.feePaidAt = uint64(T0 - 1);
        _postExpect(a, abi.encodeWithSelector(CashbackRewards.BadAccrual.selector, 0));
        _post(_rf(alice, bob, 100e6, 50e6, "f1"));
        // explicit times: via-IR may reuse block.timestamp across vm.warp inside one test
        vm.warp(T0 + 90 days);
        a = _rf(alice, bob, 100e6, 20e6, "f2");
        a.feePaidAt = uint64(T0 + 90 days);
        _postExpect(a, abi.encodeWithSelector(CashbackRewards.BadAccrual.selector, 0));
        a.feePaidAt = uint64(T0 + 90 days - 1);
        _post(a);
        // cashback and referral can share a ref: the key includes the kind and the account
        a = _cb(bob, 100e6, 2e6, "f2");
        a.feePaidAt = uint64(T0 + 90 days - 1);
        _post(a);
    }

    function test_referral_monthly_cap() public {
        vm.prank(bob);
        registry.link(alice);
        vm.prank(carol);
        registry.link(alice);
        for (uint256 i; i < 2; ++i) {
            _post(_rf(alice, bob, 1000e6, 500e6, bytes32(i + 1)));
        }
        assertEq(cashback.referralUsd(alice, JAN_2027), 1000e6);
        _postExpect(_rf(alice, carol, 100e6, 1, "x"), abi.encodeWithSelector(CashbackRewards.AboveMonthlyCap.selector, alice));
        // cashback is not under the referral cap
        _post(_cb(alice, 100e6, 10e6, "own fee"));
        // next calendar month: a fresh cap
        vm.warp(FEB_2027_START);
        _post(_rf(alice, carol, 100e6, 50e6, "feb"));
        assertEq(cashback.referralUsd(alice, JAN_2027 + 1), 50e6);
    }

    // ------------------------------------------------------------------ periods (RF-4, RF-5)

    function test_open_hold_and_pro_rata() public {
        _post(_cb(alice, 1000e6, 30e6, "a")); // 30 USD
        _post(_cb(bob, 1000e6, 10e6, "b")); // 10 USD
        _sinkGets(2000e18); // 20 USD of ORRY at 100 ORRY per USD: half of the 40 USD needed
        uint256 openAt = FEB_2027_START + 30 days;
        assertEq(cashback.openableAt(JAN_2027), openAt);
        vm.expectRevert(abi.encodeWithSelector(CashbackRewards.NotOpenable.selector, openAt));
        cashback.openPeriod(JAN_2027);
        vm.prank(alice);
        vm.expectRevert(CashbackRewards.NotOpen.selector);
        cashback.claim(_m(JAN_2027));
        vm.warp(openAt);
        price.setReady(false);
        vm.expectRevert(CashbackRewards.PriceNotReady.selector);
        cashback.openPeriod(JAN_2027);
        price.setReady(true);
        assertEq(cashback.openPeriod(JAN_2027), 2000e18);
        vm.expectRevert(CashbackRewards.AlreadyOpened.selector);
        cashback.openPeriod(JAN_2027);
        assertEq(cashback.free(), 0);
        assertEq(cashback.claimable(alice, JAN_2027), 1500e18);
        uint256 a0 = orry.balanceOf(alice);
        vm.prank(alice);
        assertEq(cashback.claim(_m(JAN_2027)), 1500e18);
        assertEq(orry.balanceOf(alice) - a0, 1500e18);
        vm.prank(alice);
        vm.expectRevert(CashbackRewards.NothingToClaim.selector);
        cashback.claim(_m(JAN_2027));
        // anyone pays bob to bob
        uint256 b0 = orry.balanceOf(bob);
        vm.prank(carol);
        cashback.claimFor(bob, _m(JAN_2027));
        assertEq(orry.balanceOf(bob) - b0, 500e18);
        assertEq(cashback.totalReserved(), 0);
        vm.prank(carol);
        vm.expectRevert(CashbackRewards.NothingToClaim.selector);
        cashback.claim(_m(JAN_2027));
        vm.prank(carol);
        vm.expectRevert(CashbackRewards.NothingToClaim.selector);
        cashback.claim(new uint256[](0));
    }

    function test_full_reserve_and_free_left() public {
        _post(_cb(alice, 1000e6, 30e6, "a"));
        _sinkGets(10_000e18);
        vm.warp(FEB_2027_START + 30 days);
        assertEq(cashback.openPeriod(JAN_2027), 3000e18);
        assertEq(cashback.free(), 7000e18);
        assertEq(cashback.totalReserved(), 3000e18);
    }

    function test_empty_month_opens_without_price() public {
        vm.warp(FEB_2027_START + 30 days);
        price.setReady(false);
        assertEq(cashback.openPeriod(JAN_2027), 0);
    }

    function test_void_before_open_only() public {
        _post(_cb(alice, 1000e6, 30e6, "a"));
        _post(_cb(bob, 1000e6, 10e6, "b"));
        vm.prank(alice);
        vm.expectRevert(CashbackRewards.NotAdmin.selector);
        cashback.voidMonth(alice, JAN_2027);
        vm.prank(admin);
        cashback.voidMonth(alice, JAN_2027);
        assertEq(cashback.periodOf(JAN_2027).totalUsd, 10e6);
        vm.prank(admin);
        vm.expectRevert(CashbackRewards.NothingToClaim.selector);
        cashback.voidMonth(alice, JAN_2027);
        _sinkGets(10_000e18);
        vm.warp(FEB_2027_START + 30 days);
        cashback.openPeriod(JAN_2027);
        vm.prank(admin);
        vm.expectRevert(CashbackRewards.AlreadyOpened.selector);
        cashback.voidMonth(bob, JAN_2027);
        vm.prank(alice);
        vm.expectRevert(CashbackRewards.NothingToClaim.selector);
        cashback.claim(_m(JAN_2027));
    }

    function test_close_returns_unclaimed() public {
        _post(_cb(alice, 1000e6, 30e6, "a"));
        _post(_cb(bob, 1000e6, 10e6, "b"));
        _sinkGets(10_000e18);
        uint256 openAt = FEB_2027_START + 30 days;
        vm.warp(openAt);
        cashback.openPeriod(JAN_2027);
        vm.prank(alice);
        cashback.claim(_m(JAN_2027));
        vm.expectRevert(abi.encodeWithSelector(CashbackRewards.ClaimWindowOpen.selector, openAt + 365 days));
        cashback.closePeriod(JAN_2027);
        vm.expectRevert(CashbackRewards.NotOpen.selector);
        cashback.closePeriod(JAN_2027 + 1);
        vm.warp(openAt + 365 days);
        assertEq(cashback.closePeriod(JAN_2027), 1000e18);
        assertEq(cashback.totalReserved(), 0);
        assertEq(cashback.free(), 7000e18);
        vm.expectRevert(CashbackRewards.PeriodIsClosed.selector);
        cashback.closePeriod(JAN_2027);
        vm.prank(bob);
        vm.expectRevert(CashbackRewards.PeriodIsClosed.selector);
        cashback.claim(_m(JAN_2027));
    }

    function test_roles() public {
        vm.prank(alice);
        vm.expectRevert(CashbackRewards.NotAdmin.selector);
        cashback.setPublisher(alice);
        vm.prank(admin);
        cashback.setPublisher(carol);
        assertEq(cashback.publisher(), carol);
        vm.prank(admin);
        cashback.transferAdmin(bob);
        vm.prank(alice);
        vm.expectRevert(CashbackRewards.NotAdmin.selector);
        cashback.acceptAdmin();
        vm.prank(bob);
        cashback.acceptAdmin();
        assertEq(cashback.admin(), bob);
    }

    function test_constructor_guards() public {
        CashbackRewards.Config memory c = CashbackRewards.Config(30 days, 365 days, 90 days, 1000e6, 5000, 1000);
        vm.expectRevert(CashbackRewards.ZeroAddress.selector);
        new CashbackRewards(address(0), address(price), address(registry), admin, c);
        vm.expectRevert(CashbackRewards.ZeroAddress.selector);
        new CashbackRewards(address(orry), address(price), address(registry), address(0), c);
        c.hold = 0;
        vm.expectRevert("zero config");
        new CashbackRewards(address(orry), address(price), address(registry), admin, c);
        c.hold = 30 days;
        c.maxCashbackBps = 5001;
        vm.expectRevert("share bps");
        new CashbackRewards(address(orry), address(price), address(registry), admin, c);
        c.maxCashbackBps = 1000;
        c.maxShareBps = 10_001;
        vm.expectRevert("share bps");
        new CashbackRewards(address(orry), address(price), address(registry), admin, c);
    }
}
