// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {EarnBase, EarnVaultHarness} from "../EarnBase.sol";
import {HubActor} from "../mocks/EarnMocks.sol";
import {EarnHandler} from "./EarnHandler.sol";
import {OracleCheck} from "../OracleGhost.sol";

/// @dev Two hubs on one hook at once, one handler and one vault each: ORRY/ETH (ORRY is currency1) and ORRY/USDG
/// with USDG above ORRY's address (ORRY is currency0), so both orientations run side by side. Shared setup and
/// checks for the invariant campaign and the deterministic deep run.
abstract contract EarnInvariantBase is EarnBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    EarnHandler internal hE; // ETH hub
    EarnHandler internal hU; // USDG hub
    EarnVaultHarness internal vaultU;
    HubActor internal jitActor;
    HubActor internal traderU;

    function usdgAt() internal pure override returns (address) {
        return USDG_HIGH;
    }

    function setUp() public virtual override {
        super.setUp(); // kind ETH: `vault` is the ETH vault
        PM.initialize(hook.hubKey(address(usdg)), openingSqrtPrice(address(usdg)));
        vaultU = new EarnVaultHarness(address(hook), address(usdg));
        jitActor = new HubActor(PM);
        traderU = new HubActor(PM);
        vm.deal(address(jitActor), 1e6 ether);
        orry.transfer(address(jitActor), 4e25);
        usdg.mint(address(jitActor), 1e18);
        usdg.mint(address(traderU), 1e18);
        orry.transfer(address(traderU), 4e25);
        address[4] memory actors = [alice, bob, carol, makeAddr("dave")];
        orry.transfer(actors[3], 4e25);
        for (uint256 i; i < 4; ++i) {
            vm.startPrank(actors[i]);
            orry.approve(address(vault), type(uint256).max);
            orry.approve(address(vaultU), type(uint256).max);
            usdg.approve(address(vaultU), type(uint256).max);
            vm.stopPrank();
        }
        vm.deal(address(trader), 1e6 ether);
        hE = new EarnHandler(PM, vault, hook, usdg, router, trader, jitActor, actors, 1e18);
        hU = new EarnHandler(PM, vaultU, hook, usdg, router, traderU, jitActor, actors, USDG_PER_ETH);
        hE.setOther(address(usdg));
        hU.setOther(address(0));
        orry.transfer(address(hE), 1.5e25); // for donations and notified rewards
        orry.transfer(address(hU), 1.5e25);
        // starting positions so swaps have liquidity
        depositBalanced(alice, 10 ether);
        uint256 qa = 30_000e6;
        uint256 rc = _orryForUsdg(qa) * 101 / 100;
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(alice);
        vaultU.deposit(qa, rc, 0, 0, type(uint160).max, ts);
    }

    function _orryForUsdg(uint256 qa) internal view returns (uint256) {
        (uint160 p,,,) = PM.getSlot0(hook.hubKey(address(usdg)).toId());
        assertTrue(hook.pairOf(address(usdg)).orryIsCurrency0, "setup: ORRY is currency0 in the USDG hub");
        return qa * (1 << 96) / p * (1 << 96) / p;
    }

    function _sumShares(EarnHandler h) internal view returns (uint256 s) {
        for (uint256 i; i < 4; ++i) s += h.vault().sharesOf(h.actorAt(i));
    }

    function _liquidity(EarnHandler h) internal view returns (uint128 liq) {
        (liq,,) = PM.getPositionInfo(hook.pairOf(h.quote()).poolId, address(h.vault()), LOWER, UPPER, bytes32(0));
    }

    function _quoteBal(EarnHandler h, address who) internal view returns (uint256) {
        return h.isEth() ? who.balance : usdg.balanceOf(who);
    }

    function checkVault(EarnHandler h) internal view {
        EarnVaultHarness v = h.vault();
        // shares are the position's liquidity units
        assertEq(uint256(_liquidity(h)), v.totalShares(), "position liquidity == totalShares");
        assertEq(_sumShares(h), v.totalShares(), "sum of shares");

        // E-1 / E-3: the vault holds exactly the donations plus harvested minus paid, per asset
        (,,, uint256 h0, uint256 p0,) = v.streamState(0);
        (,,, uint256 h1, uint256 p1,) = v.streamState(1);
        assertLe(p0, h0, "E-3 quote paid <= harvested");
        assertLe(p1, h1, "E-3 ORRY paid <= harvested");
        assertEq(_quoteBal(h, address(v)), h.donatedQuote() + h0 - p0, "E-1 vault quote");
        assertEq(orry.balanceOf(address(v)), h.donatedOrry() + h1 - p1, "E-1 vault ORRY");

        // E-3: what accounts are owed plus what is still to stream never exceeds harvested minus paid
        uint256[2] memory owed;
        for (uint256 i; i < 4; ++i) {
            (uint256 a, uint256 b) = v.pendingFees(h.actorAt(i));
            owed[0] += a;
            owed[1] += b;
        }
        uint256 dust = 10 + 4 * h.vaultCalls();
        for (uint256 i; i < 2; ++i) {
            (,, uint256 queued, uint256 hv, uint256 pd,) = v.streamState(i);
            uint256 promised = owed[i] + queued + v.scheduledLeft(i);
            assertLe(promised, hv - pd, "E-3 promised <= harvested - paid");
            assertLe(hv - pd - promised, dust, "E-3 rounding dust bounded");
        }

        assertFalse(h.h1Broken(), "H-1");
        assertFalse(h.h2Broken(), "H-2");
        assertFalse(h.h3Broken(), "H-3 / P-4");
        assertFalse(h.e2Broken(), "E-2");
        assertFalse(h.e5Broken(), "E-5 locked shares left");
        assertFalse(h.e6Broken(), "E-6");
        assertFalse(h.claimBlocked(), "E-5 a claim or an unlocked withdrawal failed");
        assertFalse(h.e7Broken(), "E-7 notified ORRY moved principal or pending fees, or a notify failed");
        checkOracle(h);
    }

    /// @dev H-5 to H-7 against the hub's ghost, and the handler's H-5, H-8 and P-3 flags.
    function checkOracle(EarnHandler h) internal view {
        assertEq(OracleCheck.verify(h.ghost(), hook), "", "oracle vs ghost");
        assertFalse(h.h5Broken(), "H-5 latest changed twice in one second");
        assertFalse(h.h8Broken(), "H-8 same-block push and restore moved the oracle");
        assertFalse(h.p3Broken(), "P-3 an action in one hub moved the other hub");
    }

    function checkAll() internal view {
        checkVault(hE);
        checkVault(hU);
        // the hook holds no balance between calls (H-3); G-2 supply fixed; P-1 pair count fixed
        assertEq(address(hook).balance, 0, "hook ETH");
        assertEq(orry.balanceOf(address(hook)), 0, "hook ORRY");
        assertEq(usdg.balanceOf(address(hook)), 0, "hook USDG");
        assertEq(orry.totalSupply(), hE.initialSupply(), "G-2 no ORRY minted");
        assertEq(hook.pairCount(), 2, "P-1 no pair appears without the admin");
    }

    function checkOracles() internal view {
        checkOracle(hE);
        checkOracle(hU);
    }

    function checkExit(uint256 seed) internal {
        hE.exitAll(seed);
        hU.exitAll(seed + 1);
        assertEq(_liquidity(hE), 0);
        assertEq(_liquidity(hU), 0);
        checkAll();
        EarnHandler[2] memory hs = [hE, hU];
        for (uint256 i; i < 2; ++i) {
            EarnVaultHarness v = hs[i].vault();
            (,,, uint256 h0, uint256 p0,) = v.streamState(0);
            (,,, uint256 h1, uint256 p1,) = v.streamState(1);
            // the last depositor collected the zero-share rewards and the streams ran out: only rounding dust is unpaid
            uint256 dust = 10 + 4 * hs[i].vaultCalls();
            assertLe(h0 - p0, dust, "E-3 unpaid quote after exit");
            assertLe(h1 - p1, dust, "E-3 unpaid ORRY after exit");
        }
    }
}

contract EarnInvariants is EarnInvariantBase {
    function setUp() public override {
        super.setUp();
        EarnHandler[2] memory hs = [hE, hU];
        for (uint256 i; i < 2; ++i) {
            targetContract(address(hs[i]));
            bytes4[] memory sel = new bytes4[](17);
            sel[0] = EarnHandler.deposit.selector;
            sel[1] = EarnHandler.zap.selector;
            sel[2] = EarnHandler.withdraw.selector;
            sel[3] = EarnHandler.harvest.selector;
            sel[4] = EarnHandler.claim.selector;
            sel[5] = EarnHandler.swap.selector;
            sel[6] = EarnHandler.swap.selector; // swaps twice as often
            sel[7] = EarnHandler.poolDonate.selector;
            sel[8] = EarnHandler.jitAround.selector;
            sel[9] = EarnHandler.collect.selector;
            sel[10] = EarnHandler.initializeOther.selector;
            sel[11] = EarnHandler.donateToVault.selector;
            sel[12] = EarnHandler.warp.selector;
            sel[13] = EarnHandler.roll.selector;
            sel[14] = EarnHandler.warpSeconds.selector;
            sel[15] = EarnHandler.pushRestore.selector;
            sel[16] = EarnHandler.notifyRewards.selector;
            targetSelector(FuzzSelector({addr: address(hs[i]), selectors: sel}));
        }
    }

    function invariant_earn() public view {
        checkAll();
    }

    function afterInvariant() public {
        checkExit(vm.getBlockTimestamp());
    }
}
