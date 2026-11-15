// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {RewardPool} from "../../../src/community/RewardPool.sol";
import {OrryAchievements} from "../../../src/community/OrryAchievements.sol";
import {OrryChat} from "../../../src/community/OrryChat.sol";
import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";
import {AlwaysVerifier} from "../utils/CommunityMocks.sol";

/// @notice Bounded actions on RewardPool, OrryAchievements and the chat fee path, with ghost books for C-2, C-3, C-7,
/// A-1 to A-6. The handler is the pool admin. Its own clock (`now_`) avoids via-IR reusing block.timestamp.
contract PoolHandler is Test {
    RewardPool public pool;
    OrryAchievements public ach;
    OrryChat public chat;
    MockOrry public orry;
    AlwaysVerifier public verifier;

    uint256 public now_;
    address[] public actors;

    // ghost books (ORRY)
    uint256 public ghostIn; // booked through fund, sync and chat fees
    uint256 public ghostOut; // prizes and achievement payouts
    mapping(uint256 id => uint256) public ghostOriginal;
    mapping(uint256 id => uint256) public ghostReturned;
    mapping(uint256 id => uint256) public ghostPaid;
    uint256[] public eventIds;
    uint256[] public achIds;
    mapping(uint256 id => uint256) public achPayouts; // ORRY paid for an achievement

    // reach counters
    uint256 public nCreated;
    uint256 public nPublished;
    uint256 public nReplaced;
    uint256 public nPrizes;
    uint256 public nExpired;
    uint256 public nAchCreated;
    uint256 public nOnchainClaims;
    uint256 public nListed;
    uint256 public nUnlisted;
    uint256 public nListedClaims;
    uint256 public nAchClosed;
    uint256 public nPosts;
    uint256 public nCapRefusals;

    // violations seen inside actions
    uint256 public earlyPrize;
    uint256 public earlyListedClaim;
    uint256 public overCapLock;

    constructor(RewardPool pool_, OrryAchievements ach_, OrryChat chat_, MockOrry orry_, AlwaysVerifier v) {
        pool = pool_;
        ach = ach_;
        chat = chat_;
        orry = orry_;
        verifier = v;
        now_ = block.timestamp;
        for (uint256 i; i < 6; ++i) {
            address a = address(uint160(0xA000 + i));
            actors.push(a);
            vm.startPrank(a);
            orry.approve(address(pool), type(uint256).max);
            orry.approve(address(chat), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function warp(uint256 secs) public {
        now_ += bound(secs, 1, 5 days);
        vm.warp(now_);
    }

    function fund(uint256 amount, uint256 who) public {
        amount = bound(amount, 1, 1_000_000e18);
        address a = _actor(who);
        orry.transfer(a, amount);
        vm.prank(a);
        pool.fund(address(orry), amount);
        ghostIn += amount;
    }

    function donateAndSync(uint256 amount) public {
        amount = bound(amount, 1, 100_000e18);
        orry.transfer(address(pool), amount);
        ghostIn += pool.sync(address(orry));
    }

    function post(uint256 who) public {
        address a = _actor(who);
        orry.transfer(a, 10e18);
        vm.prank(a);
        chat.post(0, 0, "gm", type(uint256).max);
        ghostIn += chat.postFee();
        ++nPosts;
    }

    function createEvent(uint256 amountSeed, uint256 durSeed) public {
        uint256 cap = pool.lockCap(address(orry));
        uint256 amount = bound(amountSeed, 1, cap + cap / 10 + 1);
        uint64 deadline = uint64(now_ + bound(durSeed, 1 hours, 20 days));
        vm.prank(address(this));
        try pool.createEvent(address(orry), amount, deadline, 1, bytes32(amountSeed)) returns (uint256 id) {
            if (amount > cap) ++overCapLock;
            eventIds.push(id);
            ghostOriginal[id] = amount;
            ++nCreated;
        } catch {
            ++nCapRefusals;
        }
    }

    function _pickEvent(uint256 s) internal view returns (uint256) {
        if (eventIds.length == 0) return 0;
        return eventIds[s % eventIds.length];
    }

    /// @dev Targeted picker: the first event from a random start whose status is `want` (else a random one).
    function _pickEvent(uint256 s, RewardPool.Status want) internal view returns (uint256) {
        uint256 n = eventIds.length;
        if (n == 0) return 0;
        for (uint256 i; i < n; ++i) {
            uint256 id = eventIds[(s + i) % n];
            if (pool.eventOf(id).status == want) return id;
        }
        return eventIds[s % n];
    }

    struct Listing {
        uint256 id;
        address account;
    }

    Listing[] public listings;

    function _list(uint256 n, uint256 total, uint256 seed) internal view returns (address[] memory ws, uint256[] memory as_) {
        ws = new address[](n);
        as_ = new uint256[](n);
        uint256 left = total;
        for (uint256 i; i < n; ++i) {
            ws[i] = actors[(seed + i) % actors.length];
            uint256 share = i == n - 1 ? left : left / (n - i);
            if (share == 0) share = 1;
            as_[i] = share;
            left = left > share ? left - share : 0;
        }
    }

    function publish(uint256 idSeed, uint256 nSeed, uint256 fracSeed) public {
        uint256 id = _pickEvent(idSeed, RewardPool.Status.Open);
        if (id == 0) return;
        RewardPool.PoolEvent memory e = pool.eventOf(id);
        if (e.status != RewardPool.Status.Open || now_ >= e.deadline) return;
        uint256 n = bound(nSeed, 1, actors.length);
        uint256 total = e.amount * bound(fracSeed, 50, 100) / 100;
        if (total < n) return;
        (address[] memory ws, uint256[] memory as_) = _list(n, total, idSeed);
        uint256 sum;
        for (uint256 i; i < n; ++i) sum += as_[i];
        if (sum > e.amount) return;
        pool.publishWinners(id, ws, as_);
        ghostReturned[id] += e.amount - sum;
        ++nPublished;
    }

    function replace(uint256 idSeed, uint256 nSeed, uint256 fracSeed) public {
        uint256 id = _pickEvent(idSeed, RewardPool.Status.Published);
        if (id == 0) return;
        RewardPool.PoolEvent memory e = pool.eventOf(id);
        if (e.status != RewardPool.Status.Published || e.replaced || now_ >= e.payableAt) return;
        uint256 n = bound(nSeed, 1, actors.length);
        uint256 total = e.amount * bound(fracSeed, 50, 100) / 100;
        if (total < n) return;
        (address[] memory ws, uint256[] memory as_) = _list(n, total, idSeed + 1);
        uint256 sum;
        for (uint256 i; i < n; ++i) sum += as_[i];
        if (sum > e.amount) return;
        pool.replaceWinners(id, ws, as_);
        ghostReturned[id] += e.amount - sum;
        ++nReplaced;
    }

    function claimPrize(uint256 idSeed, uint256 who) public {
        uint256 id = _pickEvent(idSeed, RewardPool.Status.Published);
        if (id == 0) return;
        address w = _actor(who);
        RewardPool.PoolEvent memory e = pool.eventOf(id);
        try pool.claimFor(id, w) returns (uint256 amount) {
            if (now_ < e.payableAt) ++earlyPrize;
            ghostOut += amount;
            ghostPaid[id] += amount;
            ++nPrizes;
        } catch {}
    }

    function expire(uint256 idSeed) public {
        uint256 id = _pickEvent(idSeed, RewardPool.Status.Open);
        if (id == 0) return;
        RewardPool.PoolEvent memory e = pool.eventOf(id);
        try pool.expire(id) {
            ghostReturned[id] += e.amount;
            ++nExpired;
        } catch {}
    }

    function createAchievement(uint256 rewardSeed, uint256 maxSeed, uint256 durSeed, bool listed) public {
        uint256 cap = pool.lockCap(address(orry));
        uint32 max = uint32(bound(maxSeed, 1, 8));
        uint256 reward = bound(rewardSeed, 1, cap / max + 2);
        uint64 deadline = uint64(now_ + bound(durSeed, 3 days, 20 days));
        try ach.create(
            address(orry), reward, max, deadline, 2, listed ? address(0) : address(verifier), bytes32(rewardSeed)
        ) returns (uint256 id) {
            if (reward * max > cap) ++overCapLock;
            achIds.push(id);
            ++nAchCreated;
        } catch {
            ++nCapRefusals;
        }
    }

    function _pickAch(uint256 s) internal view returns (uint256) {
        if (achIds.length == 0) return 0;
        return achIds[s % achIds.length];
    }

    /// @dev Targeted picker: the first open achievement of the wanted kind from a random start (else a random one).
    function _pickAch(uint256 s, bool listed) internal view returns (uint256) {
        uint256 n = achIds.length;
        if (n == 0) return 0;
        for (uint256 i; i < n; ++i) {
            uint256 id = achIds[(s + i) % n];
            OrryAchievements.Achievement memory a = ach.achievementOf(id);
            if ((a.verifier == address(0)) == listed && !a.closed && a.deadline > now_) return id;
        }
        return achIds[s % n];
    }

    function claimOnchain(uint256 idSeed, uint256 who) public {
        uint256 id = _pickAch(idSeed, false);
        if (id == 0) return;
        address a = _actor(who);
        vm.prank(a);
        try ach.claim(id, "") returns (uint256 amount) {
            ghostOut += amount;
            achPayouts[id] += amount;
            ++nOnchainClaims;
        } catch {}
    }

    function publishCompleters(uint256 idSeed, uint256 who) public {
        uint256 id = _pickAch(idSeed, true);
        if (id == 0) return;
        address[] memory accts = new address[](1);
        uint64[] memory ts = new uint64[](1);
        accts[0] = _actor(who);
        OrryAchievements.Achievement memory a = ach.achievementOf(id);
        ts[0] = a.lastCompletedAt > now_ ? a.lastCompletedAt : uint64(now_);
        try ach.publishCompleters(id, accts, ts) {
            listings.push(Listing(id, accts[0]));
            ++nListed;
        } catch {}
    }

    function unlist(uint256 idSeed, uint256) public {
        if (listings.length == 0) return;
        Listing memory l = listings[listings.length - 1 - idSeed % (listings.length < 3 ? listings.length : 3)];
        try ach.unlist(l.id, l.account) {
            ++nUnlisted;
        } catch {}
    }

    function claimListed(uint256 idSeed, uint256) public {
        if (listings.length == 0) return;
        Listing memory l = listings[idSeed % listings.length];
        (uint256 id, address a) = (l.id, l.account);
        uint64 at = ach.listedAt(id, a);
        try ach.claimListedFor(id, a) returns (uint256 amount) {
            if (at == 0 || now_ < at + pool.CHECK_WINDOW()) ++earlyListedClaim;
            ghostOut += amount;
            achPayouts[id] += amount;
            ++nListedClaims;
        } catch {}
    }

    function closeAch(uint256 idSeed) public {
        uint256 id = _pickAch(idSeed);
        if (id == 0) return;
        try ach.close(id) {
            ++nAchClosed;
        } catch {}
    }

    function eventCount() external view returns (uint256) {
        return eventIds.length;
    }

    function achCount() external view returns (uint256) {
        return achIds.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}
