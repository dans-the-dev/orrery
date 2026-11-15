// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {CashbackRewards} from "../../../src/community/CashbackRewards.sol";
import {ReferralRegistry} from "../../../src/community/ReferralRegistry.sol";
import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";

/// @notice Bounded actions on ReferralRegistry and CashbackRewards for RF-1 to RF-5. The handler is the admin and the
/// publisher; it keeps its own clock.
contract CashbackHandler is Test {
    CashbackRewards public sink;
    ReferralRegistry public registry;
    MockOrry public orry;

    uint256 public now_;
    address[] public actors;
    uint256[] public months; // months that received accruals
    mapping(uint256 => bool) internal _knownMonth;

    uint256 public ghostIn; // ORRY sent to the sink
    uint256 public ghostOut; // ORRY claimed
    mapping(address => address) public firstReferrer;
    mapping(uint256 month => uint256) public ghostClaimed;
    mapping(uint256 month => uint256) public ghostReturned;
    uint256 internal _refNonce;

    uint256 public nLinks;
    uint256 public nCashback;
    uint256 public nReferral;
    uint256 public nCapRefusals;
    uint256 public nOpened;
    uint256 public nClaims;
    uint256 public nClosed;
    uint256 public nVoided;
    uint256 public earlyClaim;

    constructor(CashbackRewards sink_, ReferralRegistry registry_, MockOrry orry_) {
        sink = sink_;
        registry = registry_;
        orry = orry_;
        now_ = block.timestamp;
        for (uint256 i; i < 6; ++i) {
            actors.push(address(uint160(0xB000 + i)));
        }
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function warp(uint256 secs) public {
        now_ += bound(secs, 1 hours, 20 days);
        vm.warp(now_);
    }

    function link(uint256 a, uint256 b) public {
        address referee = _actor(a);
        address referrer = _actor(b);
        vm.prank(referee);
        try registry.link(referrer) {
            firstReferrer[referee] = referrer;
            ++nLinks;
        } catch {}
    }

    function buybackShare(uint256 amount) public {
        amount = bound(amount, 1, 5_000e18);
        orry.transfer(address(sink), amount);
        ghostIn += amount;
    }

    function _note(uint256 m) internal {
        if (!_knownMonth[m]) {
            _knownMonth[m] = true;
            months.push(m);
        }
    }

    function accrueCashback(uint256 who, uint256 feeSeed) public {
        uint128 fee = uint128(bound(feeSeed, 1e6, 10_000e6));
        CashbackRewards.Accrual[] memory xs = new CashbackRewards.Accrual[](1);
        xs[0] = CashbackRewards.Accrual(_actor(who), 1, address(0), uint64(now_), fee, fee / 50, bytes32(++_refNonce));
        if (xs[0].rewardUsd == 0) return;
        sink.accrue(xs);
        _note(sink.currentMonth());
        ++nCashback;
    }

    function accrueReferral(uint256 who, uint256 feeSeed, uint256 shareSeed) public {
        address referee = _actor(who);
        address referrer = registry.referrerOf(referee);
        if (referrer == address(0)) return;
        uint64 at = registry.linkedAt(referee);
        if (now_ >= at + 90 days) return;
        uint128 fee = uint128(bound(feeSeed, 1e6, 3_000e6));
        uint128 reward = uint128(uint256(fee) * bound(shareSeed, 1, 5000) / 10_000);
        if (reward == 0) return;
        CashbackRewards.Accrual[] memory xs = new CashbackRewards.Accrual[](1);
        xs[0] = CashbackRewards.Accrual(referrer, 2, referee, uint64(now_), fee, reward, bytes32(++_refNonce));
        try sink.accrue(xs) {
            _note(sink.currentMonth());
            ++nReferral;
        } catch {
            ++nCapRefusals;
        }
    }

    function voidMonth(uint256 who, uint256 mSeed) public {
        if (months.length == 0) return;
        try sink.voidMonth(_actor(who), months[mSeed % months.length]) {
            ++nVoided;
        } catch {}
    }

    function open(uint256 mSeed) public {
        if (months.length == 0) return;
        try sink.openPeriod(months[mSeed % months.length]) {
            ++nOpened;
        } catch {}
    }

    function claim(uint256 who, uint256 mSeed) public {
        if (months.length == 0) return;
        uint256 m = months[mSeed % months.length];
        address a = _actor(who);
        uint256[] memory ms = new uint256[](1);
        ms[0] = m;
        try sink.claimFor(a, ms) returns (uint256 amount) {
            if (now_ < sink.openableAt(m)) ++earlyClaim;
            ghostOut += amount;
            ghostClaimed[m] += amount;
            ++nClaims;
        } catch {}
    }

    function close(uint256 mSeed) public {
        if (months.length == 0) return;
        uint256 m = months[mSeed % months.length];
        try sink.closePeriod(m) returns (uint256 returned) {
            ghostReturned[m] += returned;
            ++nClosed;
        } catch {}
    }

    function monthCount() external view returns (uint256) {
        return months.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}
