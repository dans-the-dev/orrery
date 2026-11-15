// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {EarnInvariantBase} from "./EarnInvariants.t.sol";
import {EarnHandler} from "./EarnHandler.sol";
import {EarnVaultHarness} from "../EarnBase.sol";
import {OracleCheck} from "../OracleGhost.sol";

/// @dev Deterministic deep run over both hubs: 6,000 weighted actions from a fixed seed, each on the ETH or the USDG
/// hub, every invariant checked every 25 actions (the oracles every 5) and after a full exit. Reports how many of each
/// action succeeded per hub; each must be above zero.
contract EarnDeepRun is EarnInvariantBase {
    uint256 internal constant STEPS = 6_000;
    uint256[3][2] internal consultSeen; // per hub: answered, OracleNotReady, OracleWindowTooLong

    function tallyConsult() internal {
        EarnHandler[2] memory hs = [hE, hU];
        uint32[4] memory ws = [uint32(60), 1800, 3780, 3781];
        for (uint256 h; h < 2; ++h) {
            for (uint256 i; i < ws.length; ++i) {
                (uint8 st,,) = OracleCheck.consultStatus(hook, hs[h].quote(), ws[i]);
                ++consultSeen[h][st];
            }
        }
    }

    function step(EarnHandler h, uint256 seed) internal {
        uint256 pick = seed % 100;
        uint256 a = seed >> 8;
        uint256 b = seed >> 72;
        uint256 c = seed >> 136;
        if (pick < 14) h.deposit(a, b, c);
        else if (pick < 22) h.zap(a, b % 2 == 0, c);
        else if (pick < 34) h.withdraw(a, b);
        else if (pick < 40) h.harvest();
        else if (pick < 48) h.claim(a, b, c % 2 == 0);
        else if (pick < 68) h.swap(a % 2 == 0, b % 3 != 0, c);
        else if (pick < 71) h.poolDonate(a);
        else if (pick < 75) h.jitAround(a);
        else if (pick < 79) h.collect();
        else if (pick < 80) h.initializeOther(uint24(a), int24(uint24(b)));
        else if (pick < 82) h.donateToVault(a, b);
        else if (pick < 83) h.notifyRewards(a);
        else if (pick < 89) h.warp(a % 4 == 0 ? b : b % 30 minutes);
        else if (pick < 95) h.warpSeconds(a);
        else if (pick < 97) h.pushRestore(a, b % 2 == 0);
        else h.roll();
    }

    function report(string memory name, EarnHandler h, uint256 idx) internal view {
        console2.log(name);
        console2.log("  deposits / zaps / withdrawals", h.nDeposits(), h.nZaps(), h.nWithdrawals());
        console2.log("  locked refused / harvests / claims", h.nLockedRejects(), h.nHarvests(), h.nClaims());
        console2.log("  swaps / collects / pool donations", h.nSwaps(), h.nCollects(), h.nPoolDonations());
        console2.log("  JIT / vault donations / push and restore", h.nJit(), h.nDonations(), h.nPushRestores());
        console2.log("  notified rewards", h.nNotifies());
        console2.log("  oracle updates / checkpoints (ring wraps past 64)", h.ghost().updates(), h.ghost().checkpointCount());
        console2.log(
            "  consult answered / not ready / too long", consultSeen[idx][0], consultSeen[idx][1], consultSeen[idx][2]
        );
        EarnVaultHarness v = h.vault();
        (,,, uint256 h0, uint256 p0,) = v.streamState(0);
        (,,, uint256 h1, uint256 p1,) = v.streamState(1);
        console2.log("  quote fees harvested / paid", h0, p0);
        console2.log("  ORRY fees harvested / paid", h1, p1);
    }

    function assertActive(EarnHandler h, uint256 idx) internal view {
        assertGt(h.nDeposits(), 0);
        assertGt(h.nZaps(), 0);
        assertGt(h.nWithdrawals(), 0);
        assertGt(h.nLockedRejects(), 0);
        assertGt(h.nHarvests(), 0);
        assertGt(h.nClaims(), 0);
        assertGt(h.nSwaps(), 0);
        assertGt(h.nCollects(), 0);
        assertGt(h.nPoolDonations(), 0);
        assertGt(h.nJit(), 0);
        assertGt(h.nDonations(), 0);
        assertGt(h.nPushRestores(), 0);
        assertGt(h.nNotifies(), 0);
        assertGt(h.ghost().updates(), 0);
        assertGt(h.ghost().checkpointCount(), 64, "the ring wrapped");
        assertGt(consultSeen[idx][0], 0);
        assertGt(consultSeen[idx][1], 0);
        assertGt(consultSeen[idx][2], 0);
        EarnVaultHarness v = h.vault();
        (,,,, uint256 p0,) = v.streamState(0);
        (,,,, uint256 p1,) = v.streamState(1);
        assertGt(p0, 0);
        assertGt(p1, 0);
    }

    function test_deepRun() public {
        uint256 seed = uint256(keccak256("orrery earn deep run, two hubs"));
        for (uint256 i; i < STEPS; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            step((seed >> 200) % 2 == 0 ? hE : hU, seed);
            if (i % 25 == 0) checkAll();
            else if (i % 5 == 0) checkOracles();
            if (i % 5 == 0) tallyConsult();
        }
        checkAll();
        report("ETH hub", hE, 0);
        report("USDG hub (ORRY is currency0)", hU, 1);
        assertActive(hE, 0);
        assertActive(hU, 1);

        checkExit(seed);
        EarnHandler[2] memory hs = [hE, hU];
        for (uint256 k; k < 2; ++k) {
            EarnVaultHarness v = hs[k].vault();
            (,,, uint256 h0, uint256 p0,) = v.streamState(0);
            (,,, uint256 h1, uint256 p1,) = v.streamState(1);
            console2.log("after exit: quote unpaid dust, ORRY unpaid dust", h0 - p0, h1 - p1);
        }
    }
}
