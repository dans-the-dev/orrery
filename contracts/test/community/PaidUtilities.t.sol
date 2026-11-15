// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommunityBase} from "./utils/CommunityBase.sol";
import {ShortBurnOrry} from "./utils/CommunityMocks.sol";
import {OrryPriced} from "../../src/community/OrryPriced.sol";
import {OrryNames} from "../../src/community/OrryNames.sol";
import {OrryBoost} from "../../src/community/OrryBoost.sol";
import {OrryPasses} from "../../src/community/OrryPasses.sol";
import {TemplateMarket} from "../../src/community/TemplateMarket.sol";
import {IOrryBurnEvents} from "../../src/orry/interfaces/IOrryToken.sol";

/// @notice OrryNames, OrryBoost, OrryPasses and TemplateMarket (L1-7 to L1-10).
contract PaidUtilitiesTest is CommunityBase {
    // ------------------------------------------------------------------ names

    function test_names_unique_fee_to_pool() public {
        vm.prank(alice);
        uint256 fee = names.setName("alice_01", type(uint256).max);
        assertEq(fee, 100e18);
        assertEq(pool.freeBalance(address(orry)), 100e18);
        assertEq(names.nameOf(alice), "alice_01");
        assertEq(names.ownerOf("alice_01"), alice);
        vm.prank(bob);
        vm.expectRevert(OrryNames.NameTaken.selector);
        names.setName("alice_01", type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(OrryNames.SameName.selector);
        names.setName("alice_01", type(uint256).max);
        // changing frees the old name for the same fee
        vm.prank(alice);
        names.setName("alice", type(uint256).max);
        assertEq(names.ownerOf("alice_01"), address(0));
        assertEq(pool.freeBalance(address(orry)), 200e18);
        vm.prank(bob);
        names.setName("alice_01", type(uint256).max);
        assertEq(names.ownerOf("alice_01"), bob);
    }

    function test_names_charset_and_bounds() public {
        assertTrue(names.isValid("abc"));
        assertTrue(names.isValid("a_b_c_0123456789_xyz"));
        assertFalse(names.isValid("ab"));
        assertFalse(names.isValid("a_b_c_0123456789_xyz0"));
        assertFalse(names.isValid("Alice"));
        assertFalse(names.isValid("al ice"));
        assertFalse(names.isValid("al-ice"));
        assertFalse(names.isValid(unicode"alicé"));
        assertFalse(names.isValid("ali`e"));
        assertFalse(names.isValid("ali{e"));
        assertFalse(names.isValid("ali/e"));
        assertFalse(names.isValid("ali:e"));
        assertFalse(names.isValid("ali@e"));
        assertFalse(names.isValid("ali^e"));
        vm.prank(alice);
        vm.expectRevert(OrryNames.BadName.selector);
        names.setName("A1ice", type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrryPriced.PriceAboveMax.selector, 100e18, 99e18));
        names.setName("alice", 99e18);
        vm.expectRevert("zero fee");
        new OrryNames(address(orry), address(price), address(pool), 0);
        vm.expectRevert("pool orry");
        new OrryNames(address(usdg), address(price), address(pool), 1);
        vm.expectRevert(OrryPriced.ZeroAddress.selector);
        new OrryNames(address(orry), address(price), address(0), 1);
    }

    // ------------------------------------------------------------------ boost

    function test_boost_burns_and_stacks() public {
        assertEq(boost.quote(2, 3), 1500e18);
        uint256 supply = orry.totalSupply();
        vm.expectEmit(true, false, false, true, address(boost));
        emit IOrryBurnEvents.Burned(8, 1500e18);
        vm.prank(alice);
        uint64 until = boost.boost(2, 42, 3, type(uint256).max);
        assertEq(until, block.timestamp + 3 days);
        assertEq(supply - orry.totalSupply(), 1500e18);
        assertTrue(boost.isBoosted(2, 42));
        assertFalse(boost.isBoosted(1, 42));
        vm.warp(block.timestamp + 1 days);
        vm.prank(bob);
        until = boost.boost(2, 42, 1, type(uint256).max);
        assertEq(until, T0 + 4 days);
        vm.warp(T0 + 10 days);
        assertFalse(boost.isBoosted(2, 42));
        vm.prank(bob);
        until = boost.boost(2, 42, 1, type(uint256).max);
        assertEq(until, T0 + 11 days);
        assertEq(boost.usdPerDay(1), 0.5e6);
        assertEq(boost.usdPerDay(3), 2e6);
        assertEq(orry.balanceOf(address(boost)), 0);
    }

    function test_boost_guards() public {
        vm.startPrank(alice);
        vm.expectRevert(OrryBoost.BadKind.selector);
        boost.boost(0, 1, 1, type(uint256).max);
        vm.expectRevert(OrryBoost.BadKind.selector);
        boost.boost(4, 1, 1, type(uint256).max);
        vm.expectRevert(OrryBoost.BadDays.selector);
        boost.boost(1, 1, 0, type(uint256).max);
        vm.expectRevert(OrryBoost.BadDays.selector);
        boost.boost(1, 1, 31, type(uint256).max);
        boost.boost(1, 1, 30, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OrryPriced.PriceAboveMax.selector, 50e18, 1));
        boost.boost(1, 1, 1, 1);
        vm.stopPrank();
        vm.expectRevert(OrryBoost.BadDays.selector);
        boost.quote(1, 0);
        vm.expectRevert("zero price");
        new OrryBoost(address(orry), address(price), 0, 1, 1);
    }

    function test_short_burn_refused() public {
        ShortBurnOrry sb = new ShortBurnOrry(alice, 1e27);
        OrryBoost b2 = new OrryBoost(address(sb), address(price), 1e6, 1e6, 1e6);
        vm.startPrank(alice);
        sb.approve(address(b2), type(uint256).max);
        vm.expectRevert(OrryPriced.InexactTransfer.selector);
        b2.boost(1, 1, 1, type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ passes

    function test_passes_burn_and_stack_for_any_account() public {
        assertEq(passes.quote(2, 2), 1000e18);
        uint256 supply = orry.totalSupply();
        vm.prank(alice);
        uint64 until = passes.buy(bob, 1, 3, type(uint256).max);
        assertEq(until, T0 + 3 days);
        assertEq(supply - orry.totalSupply(), 300e18);
        assertTrue(passes.hasPass(bob));
        assertFalse(passes.hasPass(alice));
        vm.prank(bob);
        until = passes.buy(bob, 2, 1, type(uint256).max);
        assertEq(until, T0 + 10 days);
        vm.warp(T0 + 10 days);
        assertFalse(passes.hasPass(bob));
    }

    function test_passes_guards() public {
        vm.startPrank(alice);
        vm.expectRevert(OrryPriced.ZeroAddress.selector);
        passes.buy(address(0), 1, 1, type(uint256).max);
        vm.expectRevert(OrryPasses.BadCount.selector);
        passes.buy(alice, 1, 0, type(uint256).max);
        vm.expectRevert(OrryPasses.BadCount.selector);
        passes.buy(alice, 1, 53, type(uint256).max);
        passes.buy(alice, 2, 52, type(uint256).max);
        vm.expectRevert(OrryPasses.BadKind.selector);
        passes.buy(alice, 3, 1, type(uint256).max);
        vm.expectRevert(OrryPasses.BadKind.selector);
        passes.buy(alice, 0, 1, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OrryPriced.PriceAboveMax.selector, 100e18, 0));
        passes.buy(alice, 1, 1, 0);
        vm.stopPrank();
        vm.expectRevert(OrryPasses.BadCount.selector);
        passes.quote(1, 0);
        vm.expectRevert("zero price");
        new OrryPasses(address(orry), address(price), 1, 0);
    }

    // ------------------------------------------------------------------ template market

    function test_market_sale_burns_share_and_pays_creator() public {
        vm.prank(alice);
        uint256 id = market.list(25e6, keccak256("policy v1"), "ipfs://policy-v1");
        assertEq(market.quote(id), 2500e18);
        uint256 supply = orry.totalSupply();
        uint256 a0 = orry.balanceOf(alice);
        uint256 b0 = orry.balanceOf(bob);
        vm.prank(bob);
        uint256 paid = market.buy(id, type(uint256).max);
        assertEq(paid, 2500e18);
        assertEq(supply - orry.totalSupply(), 500e18);
        assertEq(orry.balanceOf(alice) - a0, 2000e18);
        assertEq(b0 - orry.balanceOf(bob), 2500e18);
        assertTrue(market.licensed(id, bob));
        vm.prank(bob);
        vm.expectRevert(TemplateMarket.AlreadyLicensed.selector);
        market.buy(id, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(TemplateMarket.OwnTemplate.selector);
        market.buy(id, type(uint256).max);
    }

    function test_market_creator_controls() public {
        vm.prank(alice);
        uint256 id = market.list(1e6, bytes32(0), "");
        vm.prank(bob);
        vm.expectRevert(TemplateMarket.NotCreator.selector);
        market.setPrice(id, 2e6);
        vm.prank(bob);
        vm.expectRevert(TemplateMarket.NotCreator.selector);
        market.setListed(id, false);
        vm.startPrank(alice);
        vm.expectRevert(TemplateMarket.BadPrice.selector);
        market.setPrice(id, 1e6 - 1);
        vm.expectRevert(TemplateMarket.BadPrice.selector);
        market.setPrice(id, 1000e6 + 1);
        market.setPrice(id, 1000e6);
        market.setListed(id, false);
        vm.expectRevert(TemplateMarket.UnknownTemplate.selector);
        market.setPrice(7, 1e6);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(TemplateMarket.NotListed.selector);
        market.buy(id, type(uint256).max);
        vm.prank(alice);
        market.setListed(id, true);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrryPriced.PriceAboveMax.selector, 100_000e18, 1));
        market.buy(id, 1);
        vm.prank(bob);
        vm.expectRevert(TemplateMarket.UnknownTemplate.selector);
        market.buy(9, 1);
        vm.expectRevert(TemplateMarket.UnknownTemplate.selector);
        market.quote(9);
        vm.prank(alice);
        vm.expectRevert(TemplateMarket.BadPrice.selector);
        market.list(0, bytes32(0), "");
        vm.expectRevert("burn bps");
        new TemplateMarket(address(orry), address(price), 10_001, 1, 2);
        vm.expectRevert("bounds");
        new TemplateMarket(address(orry), address(price), 0, 3, 2);
        vm.expectRevert("bounds");
        new TemplateMarket(address(orry), address(price), 0, 0, 2);
    }
}
