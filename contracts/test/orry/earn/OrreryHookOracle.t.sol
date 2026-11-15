// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {stdError} from "forge-std/StdError.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {OrreryHook} from "../../../src/orry/OrreryHook.sol";
import {IOrreryHook} from "../../../src/orry/interfaces/IOrreryHook.sol";
import {EarnBase} from "./EarnBase.sol";
import {OracleGhost, OracleCheck} from "./OracleGhost.sol";

/// @dev Hub time-weighted price (spec 3.1 "Price observations" and `consult`, invariants H-5 to H-8).
contract OrreryHookOracleTest is EarnBase {
    using StateLibrary for IPoolManager;

    uint256 internal constant T_START = 1_700_000_000;
    uint32 internal constant WINDOW = 30 minutes;

    uint256 internal t0;
    int24 internal tick0;

    function setUp() public override {
        vm.warp(T_START);
        super.setUp();
        t0 = vm.getBlockTimestamp();
        tick0 = currentTick();
    }

    // ---------------------------------------------------------------- helpers

    function currentTick() internal view returns (int24 t) {
        (, t,,) = PM.getSlot0(poolId);
    }

    /// @dev Without liquidity a price-limited swap moves the hub to any price for free. Always exactly one swap.
    function moveTo(int24 t) internal {
        uint160 target = TickMath.getSqrtPriceAtTick(t);
        uint160 cur = sqrtPrice();
        if (target == cur) return touch();
        trader.swapTo(key, target < cur, -1, target);
        assertEq(currentTick(), t, "moveTo");
    }

    /// @dev One swap that leaves the tick where it is: the price rises by one unit (no liquidity) or a dust amount.
    function touch() internal {
        int24 before = currentTick();
        if (PM.getLiquidity(poolId) == 0) trader.swapTo(key, false, -1, sqrtPrice() + 1);
        else trader.swap(key, true, -int256(orryIs0 ? 1e9 : q(1e9) + 1)); // dust of currency0
        assertEq(currentTick(), before, "touch moved the tick");
    }

    function cumulativeNow() internal view returns (int56) {
        (uint32 ts, int56 cum,) = hook.latestObservation(quote);
        return cum + int56(currentTick()) * int56(uint56(vm.getBlockTimestamp() - ts));
    }

    function expectConsult(uint32 window, int56 cumNow, int56 cumThen, uint32 actual) internal view {
        (int24 m, uint32 a) = hook.consult(quote, window);
        int56 d = cumNow - cumThen;
        int56 q = d / int56(uint56(actual));
        if (d < 0 && d % int56(uint56(actual)) != 0) --q;
        assertEq(a, actual, "actualWindow");
        assertEq(int256(m), int256(q), "meanTick");
    }

    // ---------------------------------------------------------------- constants and initialization

    function test_constants() public view {
        assertEq(hook.OBSERVATION_INTERVAL(), 60);
        assertEq(hook.OBSERVATION_CARDINALITY(), 64);
        assertEq(hook.MAX_WINDOW(), 3780);
    }

    function test_afterInitialize_writesFirstEntry() public view {
        (uint32 ts, int56 cum, int24 t) = hook.latestObservation(quote);
        assertEq(ts, t0);
        assertEq(cum, 0);
        assertEq(t, tick0);
        (uint32 ots, int56 ocum) = hook.observation(quote, 0);
        assertEq(ots, t0);
        assertEq(ocum, 0);
        (uint16 newest, uint16 count) = hook.observationIndex(quote);
        assertEq(newest, 0);
        assertEq(count, 1);
        (ots, ocum) = hook.observation(quote, 1);
        assertEq(ots, 0);
        assertEq(ocum, 0);
    }

    function test_views_beforeInitialize() public {
        OrreryHook fresh = deployHook(address(router), hookAddress(2));
        (uint32 ts, int56 cum, int24 t) = fresh.latestObservation(quote);
        assertEq(ts, 0);
        assertEq(cum, 0);
        assertEq(t, 0);
        (uint16 newest, uint16 count) = fresh.observationIndex(quote);
        assertEq(newest, 0);
        assertEq(count, 0);
        vm.expectRevert(IOrreryHook.OracleNotReady.selector);
        fresh.consult(quote, 60);
    }

    function test_observation_indexOutOfRange_reverts() public {
        vm.expectRevert(stdError.indexOOBError);
        hook.observation(quote, 64);
    }

    // ---------------------------------------------------------------- write path

    function test_sameSecond_noUpdate() public {
        moveTo(tick0 + 1000); // the second of initialization
        nextBlock(); // a new block in the same second
        moveTo(tick0 + 2000);
        (uint32 ts, int56 cum, int24 t) = hook.latestObservation(quote);
        assertEq(ts, t0);
        assertEq(cum, 0);
        assertEq(t, tick0);
        (, uint16 count) = hook.observationIndex(quote);
        assertEq(count, 1);
    }

    /// @dev H-6: elapsed seconds are weighted by the tick that held during them (the tick before the first swap of the
    /// new second), not by the tick stored at the previous update, which a later swap in that second replaced.
    function test_update_weightsElapsedSecondsByHeldTick() public {
        moveTo(tick0 + 1000);
        wait(7);
        moveTo(tick0 - 500);
        (uint32 ts, int56 cum, int24 t) = hook.latestObservation(quote);
        assertEq(ts, t0 + 7);
        assertEq(cum, int56(tick0 + 1000) * 7);
        assertEq(t, tick0 + 1000);
        wait(5);
        touch();
        (ts, cum, t) = hook.latestObservation(quote);
        assertEq(ts, t0 + 12);
        assertEq(cum, int56(tick0 + 1000) * 7 + int56(tick0 - 500) * 5);
        assertEq(t, tick0 - 500);
    }

    /// @dev The cumulative is one function of time: the running value consult uses before an update is the value the
    /// update stores.
    function test_update_continuesTheRunningCumulative() public {
        moveTo(tick0 + 300);
        wait(90);
        moveTo(tick0 - 700);
        moveTo(tick0 + 50); // later swap in the same second
        wait(45);
        int56 before = cumulativeNow();
        touch();
        (, int56 cum,) = hook.latestObservation(quote);
        assertEq(cum, before);
    }

    function test_checkpoint_spacedAtLeastInterval() public {
        wait(59);
        touch();
        (uint16 newest, uint16 count) = hook.observationIndex(quote);
        assertEq(count, 1, "59 s: latest only");
        wait(1);
        touch();
        (newest, count) = hook.observationIndex(quote);
        assertEq(count, 2);
        assertEq(newest, 1);
        (uint32 ts, int56 cum) = hook.observation(quote, 1);
        assertEq(ts, t0 + 60);
        assertEq(cum, int56(tick0) * 60);
        wait(30);
        touch();
        wait(29);
        touch();
        (, count) = hook.observationIndex(quote);
        assertEq(count, 2, "59 s after the newest checkpoint");
        wait(1);
        touch();
        (newest, count) = hook.observationIndex(quote);
        assertEq(count, 3);
        assertEq(newest, 2);
        (ts, cum) = hook.observation(quote, 2);
        assertEq(ts, t0 + 120);
        assertEq(cum, int56(tick0) * 120);
    }

    function test_checkpoint_afterLongGap() public {
        wait(10 days);
        touch();
        (uint16 newest, uint16 count) = hook.observationIndex(quote);
        assertEq(count, 2);
        (uint32 ts, int56 cum) = hook.observation(quote, newest);
        assertEq(ts, t0 + 10 days);
        assertEq(cum, int56(tick0) * 10 days);
    }

    function test_ring_wrapsAfterCardinality() public {
        int56 expected;
        int24 held = tick0;
        for (uint256 k = 1; k <= 70; ++k) {
            wait(60);
            expected += int56(held) * 60;
            held = tick0 + int24(int256(k)) * 10;
            moveTo(held);
        }
        (uint16 newest, uint16 count) = hook.observationIndex(quote);
        assertEq(count, 64);
        assertEq(newest, 70 % 64);
        (, int56 newestCum) = hook.observation(quote, newest);
        assertEq(newestCum, expected);
        // oldest is checkpoint 7; timestamps rise by exactly 60 s around the ring
        for (uint256 j; j < 64; ++j) {
            (uint32 ts,) = hook.observation(quote, (uint256(newest) + 1 + j) % 64);
            assertEq(ts, t0 + 60 * (7 + j));
        }
    }

    /// @dev H-4: the oracle never reverts a swap, at the extreme ticks held for decades.
    function test_beforeSwap_neverReverts_extremeTicksForDecades() public {
        trader.swapTo(key, true, -1, TickMath.MIN_SQRT_PRICE + 1);
        int24 low = currentTick();
        assertEq(low, TickMath.MIN_TICK);
        wait(30 * 365 days);
        touch();
        (, int56 cum,) = hook.latestObservation(quote);
        int56 afterLow = int56(low) * int56(uint56(30 * 365 days));
        assertEq(cum, afterLow);
        trader.swapTo(key, false, -1, TickMath.MAX_SQRT_PRICE - 1);
        int24 high = currentTick();
        wait(30 * 365 days);
        trader.swapTo(key, true, -1, sqrtPrice() - 1);
        (, cum,) = hook.latestObservation(quote);
        assertEq(cum, afterLow + int56(high) * int56(uint56(30 * 365 days)));
        (int24 m,) = hook.consult(quote, 3780);
        assertEq(m, high);
    }

    /// @dev H-4: uint32 seconds wrap in 2106; swaps keep working and the step stays exact across the wrap.
    function test_beforeSwap_neverReverts_acrossTimestampWrap() public {
        vm.warp(uint256(type(uint32).max) - 29);
        touch();
        (, int56 c1,) = hook.latestObservation(quote);
        vm.warp(uint256(type(uint32).max) + 31);
        touch();
        (uint32 ts, int56 c2,) = hook.latestObservation(quote);
        assertEq(ts, 30);
        assertEq(c2 - c1, int56(tick0) * 60);
        (uint16 newest,) = hook.observationIndex(quote);
        (uint32 cts,) = hook.observation(quote, newest);
        assertEq(cts, 30, "checkpoint written 60 s after the previous one");
    }

    // ---------------------------------------------------------------- consult

    function test_consult_windowOutOfRange_reverts() public {
        wait(4000);
        touch();
        vm.expectRevert(IOrreryHook.OracleWindowTooLong.selector);
        hook.consult(quote, 0);
        vm.expectRevert(IOrreryHook.OracleWindowTooLong.selector);
        hook.consult(quote, 3781);
        (int24 m, uint32 a) = hook.consult(quote, 3780);
        assertEq(m, tick0);
        assertEq(a, 4000);
    }

    function test_consult_notReady_untilTheWindowHasHistory() public {
        vm.expectRevert(IOrreryHook.OracleNotReady.selector);
        hook.consult(quote, 1);
        wait(1);
        (int24 m, uint32 a) = hook.consult(quote, 1);
        assertEq(m, tick0);
        assertEq(a, 1);
        vm.expectRevert(IOrreryHook.OracleNotReady.selector);
        hook.consult(quote, 2);
        wait(1798);
        (m, a) = hook.consult(quote, 1799);
        assertEq(a, 1799);
        vm.expectRevert(IOrreryHook.OracleNotReady.selector);
        hook.consult(quote, 1800);
    }

    function test_consult_notReady_whenNowIsBelowTheWindow() public {
        vm.warp(30);
        ethFeed.set(ETH_USD, 30);
        OrreryHook early = deployHook(address(router), hookAddress(2));
        PM.initialize(early.hubKey(quote), openingSqrtPrice(quote));
        vm.warp(50);
        vm.expectRevert(IOrreryHook.OracleNotReady.selector);
        early.consult(quote, 60);
        (, uint32 a) = early.consult(quote, 20);
        assertEq(a, 20);
    }

    function test_consult_floorsTowardNegativeInfinity() public {
        uint256 snap = vm.snapshotState();
        moveTo(-101);
        wait(7);
        moveTo(-100);
        wait(3);
        (int24 m, uint32 a) = hook.consult(quote, 10);
        assertEq(a, 10);
        assertEq(m, -101, "-1007 / 10 floors to -101");

        vm.revertToState(snap);
        moveTo(101);
        wait(7);
        moveTo(100);
        wait(3);
        (m,) = hook.consult(quote, 10);
        assertEq(m, 100, "1007 / 10 floors to 100");

        vm.revertToState(snap);
        moveTo(-100);
        wait(10);
        (m,) = hook.consult(quote, 10);
        assertEq(m, -100, "exact division keeps -100");
    }

    function test_consult_picksTheNewestCheckpointAtOrBeforeTheTarget() public {
        int24[4] memory ticks = [tick0 + 100, tick0 - 200, tick0 + 300, tick0 - 400];
        int56[4] memory cumAt;
        moveTo(ticks[0]);
        for (uint256 k = 1; k < 4; ++k) {
            wait(60);
            cumAt[k] = cumAt[k - 1] + int56(ticks[k - 1]) * 60;
            moveTo(ticks[k]);
        }
        wait(20); // now = t0 + 200; checkpoints at t0, +60, +120, +180
        int56 cumNow = cumAt[3] + int56(ticks[3]) * 20;
        expectConsult(80, cumNow, cumAt[2], 80); // target t0 + 120, inclusive
        expectConsult(81, cumNow, cumAt[1], 140);
        expectConsult(20, cumNow, cumAt[3], 20);
        expectConsult(19, cumNow, cumAt[3], 20);
        expectConsult(200, cumNow, 0, 200);
        vm.expectRevert(IOrreryHook.OracleNotReady.selector);
        hook.consult(quote, 201);
    }

    /// @dev H-5 to H-7 against the independent ghost, over random moves, gaps and blocks.
    function testFuzz_matchesGhost(uint256 seed) public {
        OracleGhost g = new OracleGhost(PM, poolId, quote, t0);
        for (uint256 i; i < 40; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            if (seed % 4 != 0) wait((seed >> 8) % 150);
            if ((seed >> 24) % 5 == 0) nextBlock();
            g.before();
            bool swapped = (seed >> 40) % 5 != 0;
            if (swapped) {
                int24 t = int24(int256((seed >> 48) % 20_001)) - 10_000;
                moveTo(t == 0 ? int24(1) : t);
            }
            g.afterAction(swapped);
            assertEq(OracleCheck.verify(g, hook), "");
        }
    }

    // ---------------------------------------------------------------- H-8 manipulation

    /// @dev A hub with real liquidity and 31 minutes of honest checkpoints at a steady tick.
    function liquidHub() internal {
        depositBalanced(alice, 40 ether);
        for (uint256 k; k < 31; ++k) {
            wait(60);
            touch();
        }
        assertEq(currentTick(), tick0, "steady warm-up");
    }

    /// @dev Exact-input budget when selling currency1 (`one`) or currency0.
    function budget(bool one) internal view returns (int256) {
        bool orrySide = one != orryIs0;
        return orrySide ? -int256(1.5e26) : -int256(q(100 ether));
    }

    function push(int24 ticks) internal {
        uint160 target = TickMath.getSqrtPriceAtTick(currentTick() + ticks);
        bool up = ticks > 0; // the price rises when currency1 is sold
        trader.swapTo(key, !up, budget(up), target);
        assertEq(sqrtPrice(), target, "push reached its price");
    }

    function restore(uint160 p0, bool wasUp) internal {
        trader.swapTo(key, wasUp, budget(!wasUp), p0);
        assertEq(sqrtPrice(), p0, "restored exactly");
    }

    struct Run {
        int56 cumNow;
        int24 meanNow;
        int24 meanLater;
    }

    function run(int24 ticks, uint256 hold, bool attack) internal returns (Run memory r) {
        uint160 p0 = sqrtPrice();
        if (attack) push(ticks);
        else touch();
        wait(hold);
        if (attack) restore(p0, ticks > 0);
        else touch();
        r.cumNow = cumulativeNow();
        (r.meanNow,) = hook.consult(quote, WINDOW);
        wait(300);
        (r.meanLater,) = hook.consult(quote, WINDOW);
    }

    function abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }

    /// @dev H-8: pushes of 10% (953 ticks) and 50% (4055 ticks) in both directions, held 1, 12 and 60 s, against a
    /// 30 minute window. The cumulative moves by exactly push x hold; the integer mean tick moves by at most
    /// push x (h + 1) / window plus the one tick that flooring the mean can add.
    function test_H8_heldPushMovesTheMeanByAtMostPushTimesHoldOverWindow() public {
        liquidHub();
        wait(30);
        int24[4] memory pushes = [int24(953), 4055, -953, -4055];
        uint256[3] memory holds = [uint256(1), 12, 60];
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 3; ++j) {
                uint256 snap = vm.snapshotState();
                Run memory a = run(pushes[i], holds[j], true);
                vm.revertToState(snap);
                Run memory b = run(pushes[i], holds[j], false);
                vm.revertToState(snap);

                uint256 p = abs(pushes[i]);
                assertEq(int256(a.cumNow - b.cumNow), int256(pushes[i]) * int256(holds[j]), "cumulative moves by push x hold");
                uint256 movedNow = abs(int256(a.meanNow) - int256(b.meanNow));
                uint256 movedLater = abs(int256(a.meanLater) - int256(b.meanLater));
                uint256 bound = p * (holds[j] + 1);
                assertLe(movedNow * WINDOW, bound + WINDOW, "H-8 right after the restore");
                assertLe(movedLater * WINDOW, bound + WINDOW, "H-8 300 s later");
                console2.log("push ticks", int256(pushes[i]));
                console2.log("  hold s", holds[j]);
                console2.log("  mean moved now / later (ticks)", movedNow, movedLater);
                console2.log("  bound push*(h+1)/window x1000", bound * 1000 / WINDOW);
            }
        }
    }

    /// @dev Everything the oracle exposes, plus consult at several windows (status, mean, actual).
    function oracleState() internal view returns (bytes memory s) {
        (uint32 ts, int56 cum, int24 t) = hook.latestObservation(quote);
        (uint16 newest, uint16 count) = hook.observationIndex(quote);
        s = abi.encode(ts, cum, t, newest, count);
        for (uint256 i; i < 64; ++i) {
            (uint32 cts, int56 ccum) = hook.observation(quote, i);
            s = abi.encodePacked(s, cts, ccum);
        }
        uint32[5] memory ws = [uint32(1), 60, 600, 1800, 3780];
        for (uint256 i; i < ws.length; ++i) {
            (uint8 st, int24 m, uint32 a) = OracleCheck.consultStatus(hook, quote, ws[i]);
            s = abi.encodePacked(s, st, m, a);
        }
    }

    function pushAndRestore(int24 ticks, bool rollBetween) internal {
        uint160 p0 = sqrtPrice();
        push(ticks);
        if (rollBetween) nextBlock();
        restore(p0, ticks > 0);
    }

    /// @dev H-8: a price pushed and restored within one block (or within one second across blocks) moves no
    /// checkpoint and no consult result, now or later, compared with the same block without the push.
    function test_H8_pushAndRestoreInOneBlockMovesNothing() public {
        liquidHub();
        wait(45);
        for (uint256 c; c < 3; ++c) {
            uint256 snap = vm.snapshotState();
            // honest run: one ordinary swap in this second
            touch();
            bytes memory honestNow = oracleState();
            wait(700);
            touch();
            wait(10);
            bytes memory honestLater = oracleState();
            vm.revertToState(snap);
            // attack run: c 0 = honest swap first, push and restore in the same block; c 1 = across two blocks of the
            // same second; c 2 = the push is the first swap of the second
            if (c != 2) touch();
            pushAndRestore(c == 0 ? int24(4055) : int24(-4055), c == 1);
            assertEq(oracleState(), honestNow, "now");
            wait(700);
            touch();
            wait(10);
            assertEq(oracleState(), honestLater, "later");
            vm.revertToState(snap);
        }
    }
}

contract OrreryHookOracleUsdgLowTest is OrreryHookOracleTest {
    function kind() internal pure override returns (Kind) {
        return Kind.USDG_LOW;
    }
}

contract OrreryHookOracleUsdgHighTest is OrreryHookOracleTest {
    function kind() internal pure override returns (Kind) {
        return Kind.USDG_HIGH;
    }
}
