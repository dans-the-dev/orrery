// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommunityBase} from "./utils/CommunityBase.sol";
import {OrryChat} from "../../src/community/OrryChat.sol";
import {OrryPriced} from "../../src/community/OrryPriced.sol";
import {RewardPool} from "../../src/community/RewardPool.sol";
import {FeeOrry} from "../orry/stake/utils/StakeMocks.sol";

contract OrryChatTest is CommunityBase {
    uint256 internal constant FEE = 1e18; // 0.01 USD at 100 ORRY per USD

    function _post(address who, uint256 room, uint256 replyTo, string memory text) internal returns (uint256) {
        vm.prank(who);
        return chat.post(room, replyTo, text, type(uint256).max);
    }

    function test_constructor_guards() public {
        address r = address(orry);
        address p = address(price);
        address pl = address(pool);
        address s = address(staking);
        vm.expectRevert(OrryPriced.ZeroAddress.selector);
        new OrryChat(address(0), p, pl, s, 1, 1, 0, 1, 1);
        vm.expectRevert(OrryPriced.ZeroAddress.selector);
        new OrryChat(r, address(0), pl, s, 1, 1, 0, 1, 1);
        vm.expectRevert(OrryPriced.ZeroAddress.selector);
        new OrryChat(r, p, address(0), s, 1, 1, 0, 1, 1);
        vm.expectRevert(OrryPriced.ZeroAddress.selector);
        new OrryChat(r, p, pl, address(0), 1, 1, 0, 1, 1);
        vm.expectRevert("pool orry");
        new OrryChat(address(usdg), p, pl, s, 1, 1, 0, 1, 1);
        vm.expectRevert("zero fee");
        new OrryChat(r, p, pl, s, 0, 1, 0, 1, 1);
        vm.expectRevert("text bound");
        new OrryChat(r, p, pl, s, 1, 0, 0, 1, 1);
        vm.expectRevert("text bound");
        new OrryChat(r, p, pl, s, 1, 4097, 0, 1, 1);
        vm.expectRevert("tip cut");
        new OrryChat(r, p, pl, s, 1, 1, 10_001, 1, 1);
        vm.expectRevert("moderation");
        new OrryChat(r, p, pl, s, 1, 1, 0, 0, 1);
        vm.expectRevert("moderation");
        new OrryChat(r, p, pl, s, 1, 1, 0, 1, 0);
        assertEq(chat.roomCount(), 1);
        (bool exists, uint256 min) = chat.roomOf(0);
        assertTrue(exists);
        assertEq(min, 0);
    }

    function test_post_pays_exact_fee_to_pool() public {
        assertEq(chat.postFee(), FEE);
        uint256 before = orry.balanceOf(alice);
        vm.expectEmit(true, true, true, true, address(chat));
        emit OrryChat.Posted(1, 0, alice, 0, FEE, "gm");
        uint256 id = _post(alice, 0, 0, "gm");
        assertEq(id, 1);
        assertEq(before - orry.balanceOf(alice), FEE);
        assertEq(pool.freeBalance(address(orry)), FEE);
        assertEq(orry.balanceOf(address(pool)), FEE);
        assertEq(chat.authorOf(1), alice);
        // the fee follows the price
        price.set(250e12);
        assertEq(chat.postFee(), 2.5e18);
        _post(bob, 0, 1, "reply");
        assertEq(pool.freeBalance(address(orry)), FEE + 2.5e18);
    }

    function test_post_guards() public {
        vm.prank(alice);
        vm.expectRevert(OrryChat.UnknownRoom.selector);
        chat.post(1, 0, "x", type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(OrryChat.BadText.selector);
        chat.post(0, 0, "", type(uint256).max);
        bytes memory big = new bytes(1001);
        for (uint256 i; i < big.length; ++i) big[i] = "a";
        vm.prank(alice);
        vm.expectRevert(OrryChat.BadText.selector);
        chat.post(0, 0, string(big), type(uint256).max);
        assembly {
            mstore(big, 1000)
        }
        _post(alice, 0, 0, string(big));
        vm.prank(alice);
        vm.expectRevert(OrryChat.UnknownMessage.selector);
        chat.post(0, 2, "x", type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrryPriced.PriceAboveMax.selector, FEE, FEE - 1));
        chat.post(0, 0, "x", FEE - 1);
        price.setReady(false);
        vm.prank(alice);
        vm.expectRevert(OrryPriced.PriceNotReady.selector);
        chat.post(0, 0, "x", type(uint256).max);
        price.setReady(true);
        price.setReverts(true);
        vm.prank(alice);
        vm.expectRevert(OrryPriced.PriceNotReady.selector);
        chat.post(0, 0, "x", type(uint256).max);
    }

    function test_staker_room() public {
        vm.prank(alice);
        vm.expectRevert(OrryChat.NotAdmin.selector);
        chat.createRoom(50e6, "stakers");
        vm.prank(admin);
        uint256 room = chat.createRoom(50e6, "stakers");
        assertEq(room, 1);
        staking.set(alice, 5000e18 - 100e12); // just under 50 USD
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrryChat.BelowRoomStake.selector, 50e6 - 1, 50e6));
        chat.post(room, 0, "hi", type(uint256).max);
        staking.set(alice, 5000e18);
        _post(alice, room, 0, "hi");
        // the price falls, the same stake is worth less: refused (C-5 reads the stake at that block)
        price.set(200e12);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrryChat.BelowRoomStake.selector, 25e6, 50e6));
        chat.post(room, 0, "hi again", type(uint256).max);
        // oracle down: the stake reads as 0, the room refuses, open rooms still need a price
        price.setReady(false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrryChat.BelowRoomStake.selector, 0, 50e6));
        chat.post(room, 0, "x", type(uint256).max);
    }

    function test_tip_splits_exactly() public {
        uint256 id = _post(alice, 0, 0, "useful guide");
        uint256 a0 = orry.balanceOf(alice);
        uint256 b0 = orry.balanceOf(bob);
        uint256 p0 = pool.freeBalance(address(orry));
        vm.prank(bob);
        chat.tip(id, 1000e18);
        assertEq(orry.balanceOf(alice) - a0, 950e18);
        assertEq(b0 - orry.balanceOf(bob), 1000e18);
        assertEq(pool.freeBalance(address(orry)) - p0, 50e18);
        // dust tips: the cut rounds down, the author gets the rest
        vm.prank(bob);
        chat.tip(id, 19);
        assertEq(pool.freeBalance(address(orry)) - p0, 50e18);
        vm.prank(alice);
        vm.expectRevert(OrryChat.SelfTip.selector);
        chat.tip(id, 1);
        vm.prank(bob);
        vm.expectRevert(OrryChat.ZeroAmount.selector);
        chat.tip(id, 0);
        vm.prank(bob);
        vm.expectRevert(OrryChat.UnknownMessage.selector);
        chat.tip(9, 1);
    }

    function test_report_and_hide() public {
        uint256 id = _post(alice, 0, 0, "spam");
        vm.prank(bob);
        vm.expectRevert(OrryChat.BelowReportStake.selector);
        chat.report(id);
        vm.expectRevert(OrryChat.UnknownMessage.selector);
        chat.report(5);
        for (uint256 i; i < 5; ++i) {
            address r = address(uint160(0x5000 + i));
            staking.set(r, 10_000e18);
            if (i == 4) {
                vm.expectEmit(true, false, false, true, address(chat));
                emit OrryChat.Hidden(id, 5);
            }
            vm.prank(r);
            chat.report(id);
            if (i == 0) {
                vm.prank(r);
                vm.expectRevert(OrryChat.AlreadyReported.selector);
                chat.report(id);
            }
            assertEq(chat.isHidden(id), i == 4);
        }
        assertEq(chat.reportsOf(id), 5);
        // the message stays: it can still be tipped and replied to
        _post(bob, 0, id, "reply to a hidden message");
    }

    function test_fee_token_refused() public {
        FeeOrry fee = new FeeOrry(address(this), 1e27);
        address achAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        RewardPool p2 = new RewardPool(address(fee), achAt, admin, 2500, 48 hours);
        OrryChat c2 =
            new OrryChat(address(fee), address(price), address(p2), address(staking), 0.01e6, 1000, 500, 1, 1);
        fee.approve(address(c2), type(uint256).max);
        vm.expectRevert(OrryPriced.InexactTransfer.selector);
        c2.post(0, 0, "x", type(uint256).max);
    }
}
