// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

import {RewardPool} from "../../../src/community/RewardPool.sol";
import {OrryAchievements} from "../../../src/community/OrryAchievements.sol";
import {OrryChat} from "../../../src/community/OrryChat.sol";
import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";
import {MockEarningStaking} from "../../markets/utils/MarketMocks.sol";
import {AlwaysVerifier, MockOrryPrice} from "../utils/CommunityMocks.sol";
import {PoolHandler} from "./PoolHandler.sol";

/// @notice Invariants C-2, C-3, C-4, C-7, A-1 to A-6 (`docs/updates/L1-COMMUNITY-SPEC.md` 4) under random admin and user
/// actions, plus a deterministic deep run that must reach every state.
contract PoolInvariantsTest is Test {
    MockOrry internal orry;
    RewardPool internal pool;
    OrryAchievements internal ach;
    OrryChat internal chat;
    PoolHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        orry = new MockOrry(address(this), 1e36);
        MockOrryPrice price = new MockOrryPrice();
        MockEarningStaking staking = new MockEarningStaking();
        AlwaysVerifier v = new AlwaysVerifier();
        uint256 n = vm.getNonce(address(this));
        address handlerAt = vm.computeCreateAddress(address(this), n + 3);
        address achAt = vm.computeCreateAddress(address(this), n + 1);
        pool = new RewardPool(address(orry), achAt, handlerAt, 2500, 48 hours);
        ach = new OrryAchievements(address(pool));
        chat = new OrryChat(address(orry), address(price), address(pool), address(staking), 0.01e6, 1000, 500, 1, 5);
        handler = new PoolHandler(pool, ach, chat, orry, v);
        require(address(handler) == handlerAt, "handler address");
        orry.transfer(address(handler), 1e35);

        bytes4[] memory sel = new bytes4[](18);
        sel[0] = handler.fund.selector;
        sel[1] = handler.fund.selector;
        sel[2] = handler.donateAndSync.selector;
        sel[3] = handler.post.selector;
        sel[4] = handler.createEvent.selector;
        sel[5] = handler.createEvent.selector;
        sel[6] = handler.publish.selector;
        sel[7] = handler.replace.selector;
        sel[8] = handler.claimPrize.selector;
        sel[9] = handler.claimPrize.selector;
        sel[10] = handler.expire.selector;
        sel[11] = handler.createAchievement.selector;
        sel[12] = handler.claimOnchain.selector;
        sel[13] = handler.publishCompleters.selector;
        sel[14] = handler.unlist.selector;
        sel[15] = handler.claimListed.selector;
        sel[16] = handler.closeAch.selector;
        sel[17] = handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    // ------------------------------------------------------------------ invariants

    /// C-2 and conservation: free + locked = what came in - what was paid out; the pool holds at least that.
    function invariant_books_balance() public view {
        address r = address(orry);
        uint256 books = pool.freeBalance(r) + pool.lockedBalance(r);
        assertEq(books, handler.ghostIn() - handler.ghostOut(), "books");
        assertGe(orry.balanceOf(address(pool)), books, "held");
    }

    /// C-3 per event and the locked split: locked = open and published remainders + achievement remainders.
    function invariant_locked_is_events_plus_achievements() public view {
        uint256 lockedEvents;
        for (uint256 i; i < handler.eventCount(); ++i) {
            uint256 id = handler.eventIds(i);
            RewardPool.PoolEvent memory e = pool.eventOf(id);
            uint256 original = handler.ghostOriginal(id);
            if (e.status == RewardPool.Status.Expired) {
                assertEq(handler.ghostReturned(id), original, "expired returns all");
                assertEq(e.paid, 0, "expired pays nothing");
            } else {
                assertEq(uint256(e.amount) + handler.ghostReturned(id), original, "C-3 amount");
                assertEq(e.paid, handler.ghostPaid(id), "paid");
                assertLe(e.paid, e.amount, "paid within published");
                lockedEvents += e.amount - e.paid;
            }
        }
        uint256 lockedAch;
        for (uint256 i; i < handler.achCount(); ++i) {
            uint256 id = handler.achIds(i);
            OrryAchievements.Achievement memory a = ach.achievementOf(id);
            // A-2
            assertLe(a.paid, a.maxRecipients, "A-2 count");
            assertEq(handler.achPayouts(id), uint256(a.paid) * a.rewardPerUser, "A-2 amount");
            assertLe(uint256(a.paid) + a.listed, a.maxRecipients, "listed within cap");
            if (!a.closed) lockedAch += uint256(a.maxRecipients - a.paid) * a.rewardPerUser;
        }
        assertEq(pool.achievementLocked(address(orry)), lockedAch, "A-3 achievement locked");
        assertEq(pool.lockedBalance(address(orry)), lockedEvents + lockedAch, "locked split");
    }

    /// C-4, C-7, A-1, A-5: violations recorded inside actions stay zero.
    function invariant_no_violations() public view {
        assertEq(handler.earlyPrize(), 0, "prize before window");
        assertEq(handler.earlyListedClaim(), 0, "listed claim before window");
        assertEq(handler.overCapLock(), 0, "lock above cap");
    }

    // ------------------------------------------------------------------ deterministic deep run

    function test_deep_run_reaches_every_state() public {
        uint256 seed = 42;
        for (uint256 i; i < 3000; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 pick = seed % 100;
            uint256 a = seed >> 8;
            uint256 b = seed >> 72;
            uint256 c = seed >> 136;
            if (pick < 8) handler.fund(a, b);
            else if (pick < 11) handler.donateAndSync(a);
            else if (pick < 15) handler.post(a);
            else if (pick < 25) handler.createEvent(a, b);
            else if (pick < 35) handler.publish(a, b, c);
            else if (pick < 39) handler.replace(a, b, c);
            else if (pick < 50) handler.claimPrize(a, b);
            else if (pick < 54) handler.expire(a);
            else if (pick < 62) handler.createAchievement(a, b, c, (seed >> 200) % 2 == 0);
            else if (pick < 70) handler.claimOnchain(a, b);
            else if (pick < 77) handler.publishCompleters(a, b);
            else if (pick < 79) handler.unlist(a, b);
            else if (pick < 86) handler.claimListed(a, b);
            else if (pick < 90) handler.closeAch(a);
            else handler.warp(a % 2 == 0 ? 6 hours : 3 days);
            if (i % 250 == 0) {
                invariant_books_balance();
                invariant_locked_is_events_plus_achievements();
            }
        }
        invariant_books_balance();
        invariant_locked_is_events_plus_achievements();
        invariant_no_violations();
        console2.log("events created/published/replaced", handler.nCreated(), handler.nPublished(), handler.nReplaced());
        console2.log("prizes paid / expired", handler.nPrizes(), handler.nExpired());
        console2.log("achievements created/closed", handler.nAchCreated(), handler.nAchClosed());
        console2.log("onchain claims / listed / listed claims", handler.nOnchainClaims(), handler.nListed(), handler.nListedClaims());
        console2.log("unlisted / posts / cap refusals", handler.nUnlisted(), handler.nPosts(), handler.nCapRefusals());
        assertGt(handler.nPublished(), 0);
        assertGt(handler.nReplaced(), 0);
        assertGt(handler.nPrizes(), 0);
        assertGt(handler.nExpired(), 0);
        assertGt(handler.nAchClosed(), 0);
        assertGt(handler.nOnchainClaims(), 0);
        assertGt(handler.nListedClaims(), 0);
        assertGt(handler.nUnlisted(), 0);
        assertGt(handler.nCapRefusals(), 0);
    }
}
