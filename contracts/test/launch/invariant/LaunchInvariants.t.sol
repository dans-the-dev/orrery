// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";

import {AgentCoin} from "../../../src/launch/AgentCoin.sol";
import {LaunchBase} from "../utils/LaunchBase.sol";
import {LaunchHandler} from "./LaunchHandler.sol";

/// @notice LA-1 to LA-14 over random sequences (`invariant_*`) and over one deterministic deep run of weighted actions
/// (`test_deep_run`), which prints how far it reached and asserts that every kind of action happened.
contract LaunchInvariantsTest is LaunchBase {
    using PoolIdLibrary for PoolKey;

    LaunchHandler internal handler;
    uint256 internal supply0;
    uint256 internal owner0;

    function setUp() public override {
        super.setUp();
        address[] memory actors = new address[](4);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        actors[3] = dave;
        handler = new LaunchHandler(al, hook, orry, staking, registry, attestor, module, swapRouter, PM, actors, clock);
        // plain stakes so the early window has buyers: 5, 50, 300 and 2,000 USD
        uint256[4] memory usd = [uint256(5e6), 50e6, 300e6, 2_000e6];
        for (uint256 i; i < 4; ++i) {
            vm.prank(actors[i]);
            staking.stake(usd[i] * 100e18 / 1e6);
        }
        supply0 = orry.totalSupply();
        owner0 = orry.balanceOf(ownerWallet);
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](11);
        sel[0] = LaunchHandler.launch.selector;
        sel[1] = LaunchHandler.buyEarly.selector;
        sel[2] = LaunchHandler.buyEarly.selector;
        sel[3] = LaunchHandler.buy.selector;
        sel[4] = LaunchHandler.buy.selector;
        sel[5] = LaunchHandler.sell.selector;
        sel[6] = LaunchHandler.sell.selector;
        sel[7] = LaunchHandler.distribute.selector;
        sel[8] = LaunchHandler.claimCreator.selector;
        sel[9] = LaunchHandler.flushEarn.selector;
        sel[10] = LaunchHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    // ---------------------------------------------------------------- invariants

    function invariant_LA1_claims_match_undistributed_fees() public view {
        _checkLA1();
    }

    function invariant_LA2_orry_held_is_owed() public view {
        _checkLA2();
    }

    function invariant_LA3_every_fee_is_accounted() public view {
        _checkLA3();
    }

    function invariant_LA4_hook_holds_nothing() public view {
        _checkLA4();
    }

    function invariant_LA6_LA8_liquidity_and_coins() public view {
        _checkLA6LA8();
    }

    function invariant_ghost_flags() public view {
        _checkFlags();
    }

    function _checkLA1() internal view {
        uint256 undistributed;
        for (uint256 i; i < handler.coinCount(); ++i) {
            address coin = handler.coinList(i);
            undistributed += hook.feesOf(_key(coin).toId()) - al.distributedOf(coin);
        }
        assertEq(_claims(address(al)), undistributed, "LA-1");
    }

    function _checkLA2() internal view {
        uint256 owed = al.earnPending();
        for (uint256 i; i < handler.coinCount(); ++i) {
            owed += al.creatorOwed(handler.coinList(i));
        }
        assertEq(orry.balanceOf(address(al)), owed, "LA-2");
    }

    function _checkLA3() internal view {
        uint256 distributed;
        uint256 owed = al.earnPending();
        for (uint256 i; i < handler.coinCount(); ++i) {
            address coin = handler.coinList(i);
            distributed += al.distributedOf(coin);
            owed += al.creatorOwed(coin);
        }
        uint256 burned = supply0 - orry.totalSupply();
        uint256 ownerPaid = orry.balanceOf(ownerWallet) - owner0;
        assertEq(distributed, handler.creatorPaid() + owed + vault.notified() + ownerPaid + burned, "LA-3 sum");
        // the owner share and the burn follow the 15/15 split within one unit of rounding per distribution
        assertLe(ownerPaid, distributed * 1500 / 10_000 + 1, "LA-3 owner");
        assertGe(burned, distributed * 1500 / 10_000, "LA-3 burn");
    }

    function _checkLA4() internal view {
        assertEq(orry.balanceOf(address(hook)), 0, "LA-4 ORRY");
        assertEq(_claims(address(hook)), 0, "LA-4 claims");
    }

    function _checkLA6LA8() internal view {
        for (uint256 i; i < handler.coinCount(); ++i) {
            address coin = handler.coinList(i);
            _assertOnePosition(coin);
            AgentCoin c = AgentCoin(coin);
            uint256 held = c.balanceOf(address(PM)) + c.balanceOf(address(al)) + c.balanceOf(address(hook));
            for (uint256 j; j < handler.actorCount(); ++j) {
                held += c.balanceOf(handler.actors(j));
            }
            assertEq(held, 1_000_000_000e18, "LA-8");
            assertEq(c.totalSupply(), 1_000_000_000e18, "LA-7");
        }
    }

    function _checkFlags() internal view {
        assertFalse(handler.feeMismatch(), "LA-5 fee rule");
        assertFalse(handler.earlyViolation(), "LA-12 allowance");
        assertFalse(handler.publicEarlyBuyAccepted(), "LA-11 early window");
        assertFalse(handler.payoutViolation(), "LA-13 creator payout");
    }

    function _checkAll() internal view {
        _checkLA1();
        _checkLA2();
        _checkLA3();
        _checkLA4();
        _checkLA6LA8();
        _checkFlags();
    }

    // ---------------------------------------------------------------- deterministic deep run

    function test_deep_run() public {
        uint256 seed = 0x5eed;
        for (uint256 i; i < 2_500; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 a = seed % 100;
            uint256 r1 = uint256(keccak256(abi.encode(seed, 1)));
            uint256 r2 = uint256(keccak256(abi.encode(seed, 2)));
            uint256 r3 = uint256(keccak256(abi.encode(seed, 3)));
            if (a < 4) handler.launch(r1, r2 % 3 == 0 ? 0 : r2);
            else if (a < 16) handler.buyEarly(r1, r2, r3);
            else if (a < 40) handler.buy(r1, r2, r3, r3 % 4 == 0);
            else if (a < 60) handler.sell(r1, r2, r3, r3 % 5 == 0);
            else if (a < 70) handler.distribute(r1);
            else if (a < 76) handler.claimCreator(r1);
            else if (a < 79) handler.flushEarn();
            else if (a < 80) handler.toggleWallet(r1);
            else handler.warp(r1 % 5 == 0 ? r2 : r2 % 120);
            if (i % 250 == 0) _checkAll();
        }
        for (uint256 i; i < handler.coinCount(); ++i) {
            handler.distribute(i);
        }
        _checkAll();
        console2.log("coins", handler.nLaunch());
        console2.log("early buys", handler.nEarly(), "refused", handler.nEarlyRefused());
        console2.log("public buys", handler.nBuy(), "sells", handler.nSell());
        console2.log("distributions", handler.nDistribute(), "claims", handler.nClaim());
        console2.log("earn flushes", handler.nFlush(), "earn notified", vault.notified());
        assertGe(handler.nLaunch(), 4, "launches reached");
        assertGt(handler.nEarly(), 0, "early buys reached");
        assertGt(handler.nEarlyRefused(), 0, "early refusals reached");
        assertGt(handler.nBuy(), 100, "buys reached");
        assertGt(handler.nSell(), 100, "sells reached");
        assertGt(handler.nDistribute(), 10, "distributions reached");
        assertGt(handler.nClaim(), 0, "claims reached");
        assertGt(handler.nFlush(), 0, "earn flushes reached");
    }
}
