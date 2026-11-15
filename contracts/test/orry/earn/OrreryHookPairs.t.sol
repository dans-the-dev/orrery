// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {OrreryHook} from "../../../src/orry/OrreryHook.sol";
import {IOrreryHook} from "../../../src/orry/interfaces/IOrreryHook.sol";
import {PairsBase} from "./PairsBase.sol";
import {OracleGhost, OracleCheck} from "./OracleGhost.sol";
import {MockFeed, MockToken, MockUsdg} from "./mocks/EarnMocks.sol";

/// @dev The pair registry and several hubs on one hook (R-35, R-36, P-1 to P-4).
contract OrreryHookPairsTest is PairsBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    event PairProposed(address indexed quote, address indexed usdFeed, uint64 executableAt);
    event PairRegistered(address indexed quote, PoolId indexed poolId, address usdFeed);
    event HubInitialized(address indexed quote, PoolId indexed poolId, uint160 sqrtPriceX96);
    event ProtocolFeesCollected(address indexed currency, uint256 amount);

    address internal constant LOW_AT = address(uint160(2) << 156 | 0x11); // below ORRY
    address internal constant HIGH_AT = address(uint160(0xE) << 156 | 0x22); // above ORRY

    MockToken internal tkn;
    MockFeed internal tknFeed;

    function setUp() public override {
        super.setUp();
        tkn = newToken("TKN", 8, HIGH_AT);
        tknFeed = new MockFeed(60_000e8);
    }

    function _args(
        address pm,
        address rc,
        address rr,
        address tr,
        uint24 lp,
        uint24 pf,
        int24 ts,
        address us,
        address feed
    ) internal pure returns (bytes memory) {
        return abi.encode(pm, rc, rr, tr, lp, pf, ts, us, feed);
    }

    function _good() internal view returns (bytes memory) {
        return _args(
            address(PM), address(orry), address(router), address(treasury), 8500, 1500, 200, address(usdg), address(ethFeed)
        );
    }

    function _tryDeploy(address where, bytes memory args) internal returns (bool ok, bytes memory ret) {
        vm.etch(where, abi.encodePacked(vm.getCode("OrreryHook.sol:OrreryHook"), args));
        (ok, ret) = where.call("");
    }

    function _wrapped(address h, bytes4 err) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            h,
            IHooks.afterInitialize.selector,
            abi.encodeWithSelector(err),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    // ---------------------------------------------------------------- construction (R-35)

    function test_launch_pairs_registered_at_construction() public view {
        assertEq(hook.pairCount(), 2);
        IOrreryHook.Pair memory e = hook.pairAt(0);
        assertEq(e.quote, address(0));
        assertEq(e.usdFeed, address(ethFeed));
        assertFalse(e.orryIsCurrency0, "native ETH is always currency0");
        assertTrue(e.initialized, "EarnBase initialized the ETH hub");
        assertEq(e.registeredAt, uint64(vm.getBlockTimestamp()));
        IOrreryHook.Pair memory u = hook.pairAt(1);
        assertEq(u.quote, address(usdg));
        assertEq(u.usdFeed, address(0), "USDG is the unit");
        assertFalse(u.initialized);
        assertEq(u.orryIsCurrency0, uint160(address(orry)) < uint160(address(usdg)));
        assertTrue(hook.isPair(address(0)));
        assertTrue(hook.isPair(address(usdg)));
        assertFalse(hook.isPair(address(orry)));
        assertFalse(hook.isPair(address(tkn)));
        assertEq(hook.MAX_PAIRS(), 8);
        assertEq(hook.PAIR_DELAY(), 48 hours);
        assertEq(hook.PAIR_WINDOW(), 7 days);
        assertEq(hook.FEED_MAX_AGE(), 25 hours);
        assertEq(hook.treasury(), address(treasury));
        for (uint256 i; i < 2; ++i) {
            IOrreryHook.Pair memory p = hook.pairAt(i);
            PoolKey memory k = hook.hubKey(p.quote);
            assertEq(PoolId.unwrap(k.toId()), PoolId.unwrap(p.poolId));
            assertLt(uint160(Currency.unwrap(k.currency0)), uint160(Currency.unwrap(k.currency1)), "sorted");
            assertEq(k.fee, 8500);
            assertEq(k.tickSpacing, 200);
            assertEq(address(k.hooks), address(hook));
            (address qq, bool known) = hook.quoteOfPool(p.poolId);
            assertEq(qq, p.quote);
            assertTrue(known);
        }
    }

    function test_construction_emits_pair_registered() public {
        vm.recordLogs();
        OrreryHook h = deployHook(address(router), hookAddress(21));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(h) && logs[i].topics[0] == PairRegistered.selector) ++n;
        }
        assertEq(n, 2);
    }

    function test_constructor_rejects_bad_parameters() public {
        address w = hookAddress(8);
        MockFeed stale = new MockFeed(1);
        wait(26 hours);
        MockFeed zero = new MockFeed(0);
        MockFeed negative = new MockFeed(-1);
        MockFeed broken = new MockFeed(1);
        broken.setBroken(true);
        MockFeed future = new MockFeed(1);
        future.set(1, vm.getBlockTimestamp() + 1);
        MockFeed never = new MockFeed(1);
        never.set(1, 0);
        ethFeed.set(ETH_USD, vm.getBlockTimestamp());
        bytes[16] memory bad = [
            _args(address(0), address(orry), address(router), address(treasury), 8500, 1500, 200, address(usdg), address(ethFeed)),
            _args(address(PM), address(0), address(router), address(treasury), 8500, 1500, 200, address(usdg), address(ethFeed)),
            _args(address(PM), address(orry), address(0), address(treasury), 8500, 1500, 200, address(usdg), address(ethFeed)),
            _args(address(PM), address(orry), address(router), address(0), 8500, 1500, 200, address(usdg), address(ethFeed)),
            _args(address(PM), address(orry), address(router), address(treasury), 1_000_001, 1500, 200, address(usdg), address(ethFeed)),
            _args(address(PM), address(orry), address(router), address(treasury), 8500, 100_000, 200, address(usdg), address(ethFeed)),
            _args(address(PM), address(orry), address(router), address(treasury), 8500, 1500, 0, address(usdg), address(ethFeed)),
            _args(address(PM), address(orry), address(router), address(treasury), 8500, 1500, 200, address(orry), address(ethFeed)),
            _args(address(PM), address(orry), address(router), address(treasury), 8500, 1500, 200, makeAddr("eoa"), address(ethFeed)),
            _args(address(PM), address(orry), address(router), address(treasury), 8500, 1500, 200, address(usdg), makeAddr("eoaFeed")),
            _args(address(PM), address(orry), address(router), address(treasury), 8500, 1500, 200, address(usdg), address(stale)),
            _args(address(PM), address(orry), address(router), address(treasury), 8500, 1500, 200, address(usdg), address(zero)),
            _args(address(PM), address(orry), address(router), address(treasury), 8500, 1500, 200, address(usdg), address(negative)),
            _args(address(PM), address(orry), address(router), address(treasury), 8500, 1500, 200, address(usdg), address(broken)),
            _args(address(PM), address(orry), address(router), address(treasury), 8500, 1500, 200, address(usdg), address(future)),
            _args(address(PM), address(orry), address(router), address(treasury), 8500, 1500, 200, address(usdg), address(never))
        ];
        for (uint256 i; i < bad.length; ++i) {
            (bool ok,) = _tryDeploy(w, bad[i]);
            assertFalse(ok, string.concat("bad parameters must revert: ", vm.toString(i)));
        }
        (bool good,) = _tryDeploy(
            w,
            _args(address(PM), address(orry), address(router), address(treasury), 8500, 99_999, 1, address(usdg), address(ethFeed))
        );
        assertTrue(good, "bounds are inclusive below the caps");
        // a feed exactly FEED_MAX_AGE old still answers
        ethFeed.set(ETH_USD, vm.getBlockTimestamp() - 25 hours);
        (good,) = _tryDeploy(hookAddress(9), _good());
        assertTrue(good, "25 hours old answers");
        ethFeed.set(ETH_USD, vm.getBlockTimestamp() - 25 hours - 1);
        (good,) = _tryDeploy(hookAddress(10), _good());
        assertFalse(good, "one second older does not");
    }

    function test_constructor_rejects_bad_address_bits() public {
        address wrongBits = address((uint160(hookAddress(7)) & ~uint160(0x3FFF)) | 0x00C4); // no afterInitialize
        (bool ok, bytes memory ret) = _tryDeploy(wrongBits, _good());
        assertFalse(ok);
        assertEq(bytes4(ret), Hooks.HookAddressNotValid.selector);
    }

    // ---------------------------------------------------------------- pair admin (R-36)

    function test_pairAdmin_is_the_treasury_owner_read_live() public {
        assertEq(hook.pairAdmin(), admin);
        address next = makeAddr("nextOwner");
        treasury.setOwner(next);
        assertEq(hook.pairAdmin(), next);
        vm.prank(admin);
        vm.expectRevert(IOrreryHook.NotPairAdmin.selector);
        hook.proposePair(address(tkn), address(tknFeed));
        vm.prank(next);
        hook.proposePair(address(tkn), address(tknFeed));
    }

    function test_propose_and_execute_only_by_the_pair_admin() public {
        vm.prank(bob);
        vm.expectRevert(IOrreryHook.NotPairAdmin.selector);
        hook.proposePair(address(tkn), address(tknFeed));
        vm.prank(admin);
        hook.proposePair(address(tkn), address(tknFeed));
        wait(48 hours);
        tknFeed.set(60_000e8, vm.getBlockTimestamp());
        vm.prank(bob);
        vm.expectRevert(IOrreryHook.NotPairAdmin.selector);
        hook.executePair(address(tkn));
    }

    function test_propose_checks() public {
        vm.startPrank(admin);
        vm.expectRevert(IOrreryHook.PairAlreadyRegistered.selector);
        hook.proposePair(address(0), address(ethFeed));
        vm.expectRevert(IOrreryHook.PairAlreadyRegistered.selector);
        hook.proposePair(address(usdg), address(tknFeed));
        vm.expectRevert(IOrreryHook.BadQuote.selector);
        hook.proposePair(address(orry), address(tknFeed));
        vm.expectRevert(IOrreryHook.BadQuote.selector);
        hook.proposePair(makeAddr("noCode"), address(tknFeed));
        vm.expectRevert(IOrreryHook.FeedNotAnswering.selector);
        hook.proposePair(address(tkn), makeAddr("noFeed"));
        tknFeed.set(0, vm.getBlockTimestamp());
        vm.expectRevert(IOrreryHook.FeedNotAnswering.selector);
        hook.proposePair(address(tkn), address(tknFeed));
        tknFeed.set(60_000e8, vm.getBlockTimestamp() + 1); // dated in the future
        vm.expectRevert(IOrreryHook.FeedNotAnswering.selector);
        hook.proposePair(address(tkn), address(tknFeed));
        tknFeed.set(60_000e8, 0); // never updated (now is still under FEED_MAX_AGE since time 0)
        vm.expectRevert(IOrreryHook.FeedNotAnswering.selector);
        hook.proposePair(address(tkn), address(tknFeed));
        tknFeed.set(60_000e8, vm.getBlockTimestamp());
        tknFeed.setBroken(true);
        vm.expectRevert(IOrreryHook.FeedNotAnswering.selector);
        hook.proposePair(address(tkn), address(tknFeed));
        tknFeed.setBroken(false);
        vm.expectEmit(true, true, false, true, address(hook));
        emit PairProposed(address(tkn), address(tknFeed), uint64(vm.getBlockTimestamp() + 48 hours));
        hook.proposePair(address(tkn), address(tknFeed));
        vm.stopPrank();
        (address f, uint64 at) = hook.pendingPair(address(tkn));
        assertEq(f, address(tknFeed));
        assertEq(at, vm.getBlockTimestamp() + 48 hours);
        assertFalse(hook.isPair(address(tkn)), "a proposal registers nothing");
    }

    function test_reproposal_replaces_and_restarts_the_delay() public {
        vm.prank(admin);
        hook.proposePair(address(tkn), address(tknFeed));
        wait(40 hours);
        MockFeed other = new MockFeed(61_000e8);
        vm.prank(admin);
        hook.proposePair(address(tkn), address(other));
        (address f, uint64 at) = hook.pendingPair(address(tkn));
        assertEq(f, address(other));
        assertEq(at, vm.getBlockTimestamp() + 48 hours);
        wait(8 hours); // 48 h after the first proposal, not after the second
        other.set(61_000e8, vm.getBlockTimestamp());
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IOrreryHook.PairNotReady.selector, at));
        hook.executePair(address(tkn));
    }

    function test_execute_timing_edges() public {
        vm.prank(admin);
        hook.proposePair(address(tkn), address(tknFeed));
        (, uint64 at) = hook.pendingPair(address(tkn));
        uint256 snap = vm.snapshotState();

        vm.warp(at - 1);
        tknFeed.set(60_000e8, vm.getBlockTimestamp());
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IOrreryHook.PairNotReady.selector, at));
        hook.executePair(address(tkn));

        vm.warp(at);
        tknFeed.set(60_000e8, vm.getBlockTimestamp());
        vm.prank(admin);
        hook.executePair(address(tkn));
        assertTrue(hook.isPair(address(tkn)), "executable at exactly the delay");

        vm.revertToState(snap);
        vm.warp(uint256(at) + 7 days);
        tknFeed.set(60_000e8, vm.getBlockTimestamp());
        vm.prank(admin);
        hook.executePair(address(tkn));
        assertTrue(hook.isPair(address(tkn)), "executable at the last second of the window");

        vm.revertToState(snap);
        vm.warp(uint256(at) + 7 days + 1);
        tknFeed.set(60_000e8, vm.getBlockTimestamp());
        vm.prank(admin);
        vm.expectRevert(IOrreryHook.PairProposalExpired.selector);
        hook.executePair(address(tkn));
    }

    function test_execute_checks_and_effects() public {
        vm.prank(admin);
        vm.expectRevert(IOrreryHook.NoPairProposal.selector);
        hook.executePair(address(tkn));

        vm.prank(admin);
        hook.proposePair(address(tkn), address(tknFeed));
        wait(48 hours);
        vm.prank(admin);
        vm.expectRevert(IOrreryHook.FeedNotAnswering.selector); // the feed went stale during the delay
        hook.executePair(address(tkn));

        tknFeed.set(60_000e8, vm.getBlockTimestamp());
        PoolKey memory k = hook.hubKey(address(0)); // ETH, to compare shape
        vm.expectEmit(true, false, false, true, address(hook));
        emit PairRegistered(address(tkn), PoolId.wrap(bytes32(0)), address(tknFeed));
        vm.prank(admin);
        hook.executePair(address(tkn));
        assertEq(hook.pairCount(), 3);
        IOrreryHook.Pair memory p = hook.pairOf(address(tkn));
        assertEq(p.quote, address(tkn));
        assertEq(p.usdFeed, address(tknFeed));
        assertTrue(p.orryIsCurrency0, "TKN sits above ORRY");
        assertFalse(p.initialized);
        assertEq(p.registeredAt, vm.getBlockTimestamp());
        PoolKey memory tk = hook.hubKey(address(tkn));
        assertEq(Currency.unwrap(tk.currency0), address(orry));
        assertEq(Currency.unwrap(tk.currency1), address(tkn));
        assertEq(tk.fee, k.fee);
        assertEq(tk.tickSpacing, k.tickSpacing);
        (address f, uint64 at) = hook.pendingPair(address(tkn));
        assertEq(f, address(0));
        assertEq(at, 0, "proposal cleared");

        vm.startPrank(admin);
        vm.expectRevert(IOrreryHook.NoPairProposal.selector);
        hook.executePair(address(tkn));
        vm.expectRevert(IOrreryHook.PairAlreadyRegistered.selector);
        hook.proposePair(address(tkn), address(tknFeed));
        vm.stopPrank();
    }

    /// @dev P-1: never more than MAX_PAIRS, also when two proposals race for the last place.
    function test_cap_of_eight_pairs() public {
        MockFeed feed = new MockFeed(1e8);
        for (uint256 i; i < 5; ++i) {
            MockToken t = newToken("X", 18, address(uint160(0x30 + i) << 152 | 0x77));
            registerPair(address(t), feed);
        }
        assertEq(hook.pairCount(), 7);
        MockToken a = newToken("A", 18, address(uint160(0x40) << 152 | 0x88));
        MockToken b = newToken("B", 18, address(uint160(0x41) << 152 | 0x88));
        feed.set(1e8, vm.getBlockTimestamp());
        vm.startPrank(admin);
        hook.proposePair(address(a), address(feed));
        hook.proposePair(address(b), address(feed)); // still below the cap: proposals do not count
        vm.stopPrank();
        wait(48 hours);
        feed.set(1e8, vm.getBlockTimestamp());
        vm.prank(admin);
        hook.executePair(address(a));
        assertEq(hook.pairCount(), 8);
        vm.prank(admin);
        vm.expectRevert(IOrreryHook.TooManyPairs.selector);
        hook.executePair(address(b));
        MockToken c = newToken("C", 18, address(uint160(0x42) << 152 | 0x88));
        vm.prank(admin);
        vm.expectRevert(IOrreryHook.TooManyPairs.selector);
        hook.proposePair(address(c), address(feed));
        assertEq(hook.pairCount(), 8);
    }

    /// @dev P-2: nothing changes a registered pair: later proposals, executions and a new treasury owner leave every
    /// registered pair exactly as it was.
    function test_registered_pairs_never_change() public {
        registerPair(address(tkn), tknFeed);
        bytes32[3] memory before;
        for (uint256 i; i < 3; ++i) {
            before[i] = keccak256(abi.encode(hook.pairAt(i)));
        }
        MockFeed other = new MockFeed(2e8);
        vm.startPrank(admin);
        for (uint256 i; i < 3; ++i) {
            address qq = hook.pairAt(i).quote;
            vm.expectRevert(IOrreryHook.PairAlreadyRegistered.selector);
            hook.proposePair(qq, address(other));
            vm.expectRevert(IOrreryHook.NoPairProposal.selector);
            hook.executePair(qq);
        }
        vm.stopPrank();
        treasury.setOwner(makeAddr("newOwner"));
        initHub(address(tkn), 5e6);
        for (uint256 i; i < 3; ++i) {
            IOrreryHook.Pair memory p = hook.pairAt(i);
            if (p.quote == address(tkn)) p.initialized = false; // the only field that moves, once, at initialization
            assertEq(keccak256(abi.encode(p)), before[i]);
        }
    }

    // ---------------------------------------------------------------- initialization (P-1)

    function test_only_registered_keys_initialize() public {
        // a proposed but unexecuted pair
        vm.prank(admin);
        hook.proposePair(address(tkn), address(tknFeed));
        PoolKey memory k = PoolKey(
            Currency.wrap(address(orry)), Currency.wrap(address(tkn)), 8500, 200, IHooks(address(hook))
        );
        vm.expectRevert(_wrapped(address(hook), IOrreryHook.WrongPoolKey.selector));
        PM.initialize(k, TickMath.getSqrtPriceAtTick(0));
        // a key without ORRY
        MockToken other = newToken("O", 18, LOW_AT);
        PoolKey memory noOrry =
            PoolKey(Currency.wrap(address(other)), Currency.wrap(address(tkn)), 8500, 200, IHooks(address(hook)));
        vm.expectRevert(_wrapped(address(hook), IOrreryHook.WrongPoolKey.selector));
        PM.initialize(noOrry, TickMath.getSqrtPriceAtTick(0));
        // a registered pair with the wrong fee or spacing
        PoolKey memory u = hook.hubKey(address(usdg));
        u.fee = 3000;
        vm.expectRevert(_wrapped(address(hook), IOrreryHook.WrongPoolKey.selector));
        PM.initialize(u, TickMath.getSqrtPriceAtTick(0));
        u = hook.hubKey(address(usdg));
        u.tickSpacing = 60;
        vm.expectRevert(_wrapped(address(hook), IOrreryHook.WrongPoolKey.selector));
        PM.initialize(u, TickMath.getSqrtPriceAtTick(0));
        // the registered key initializes once
        u = hook.hubKey(address(usdg));
        uint160 p0 = openingSqrtPrice(address(usdg));
        vm.expectEmit(true, true, false, true, address(hook));
        emit HubInitialized(address(usdg), u.toId(), p0);
        PM.initialize(u, p0);
        assertTrue(hook.pairOf(address(usdg)).initialized);
        vm.expectRevert();
        PM.initialize(u, p0);
    }

    function test_unknown_quote_views_revert() public {
        address unknown = address(tkn);
        vm.expectRevert(IOrreryHook.UnknownPair.selector);
        hook.pairOf(unknown);
        vm.expectRevert(IOrreryHook.UnknownPair.selector);
        hook.hubKey(unknown);
        vm.expectRevert(IOrreryHook.UnknownPair.selector);
        hook.startOfBlockSqrtPriceX96(unknown);
        vm.expectRevert(IOrreryHook.UnknownPair.selector);
        hook.latestObservation(unknown);
        vm.expectRevert(IOrreryHook.UnknownPair.selector);
        hook.observation(unknown, 0);
        vm.expectRevert(IOrreryHook.UnknownPair.selector);
        hook.observationIndex(unknown);
        vm.expectRevert(IOrreryHook.UnknownPair.selector);
        hook.consult(unknown, 60);
        (address qq, bool known) = hook.quoteOfPool(PoolId.wrap(keccak256("some other pool")));
        assertEq(qq, address(0));
        assertFalse(known);
        vm.expectRevert();
        hook.pairAt(2);
    }

    // ---------------------------------------------------------------- isolation (P-3)

    function _hubState(address q_) internal view returns (bytes32) {
        (uint160 sp, uint64 bn) = hook.startOfBlockSqrtPriceX96(q_);
        (uint32 ts, int56 cum, int24 t) = hook.latestObservation(q_);
        (uint16 newest, uint16 count) = hook.observationIndex(q_);
        bytes memory ring;
        for (uint256 i; i < 64; ++i) {
            (uint32 cts, int56 ccum) = hook.observation(q_, i);
            ring = abi.encodePacked(ring, cts, ccum);
        }
        return keccak256(abi.encode(sp, bn, ts, cum, t, newest, count, ring, hubSqrtPrice(q_), hook.pairOf(q_)));
    }

    /// @dev P-3: a swap in one hub never changes another hub's start-of-block record, observations, ring or price; and
    /// the quote claims of the other hub do not move.
    function test_swap_in_one_hub_never_changes_another() public {
        initHub(address(usdg));
        addLiquidity(address(0), 1e22);
        addLiquidity(address(usdg), 1e18);
        for (uint256 r; r < 6; ++r) {
            wait(61);
            nextBlock();
            bytes32 u = _hubState(address(usdg));
            uint256 usdgClaims = claims(address(hook), address(usdg));
            swapIn(address(0), r % 2 == 0, r % 2 == 0 ? 0.3 ether : 1e24);
            assertEq(_hubState(address(usdg)), u, "ETH swap moved the USDG hub");
            assertEq(claims(address(hook), address(usdg)), usdgClaims);

            bytes32 e = _hubState(address(0));
            uint256 ethClaims = claims(address(hook), address(0));
            swapIn(address(usdg), r % 2 == 1, r % 2 == 1 ? 900e6 : 1e24);
            assertEq(_hubState(address(0)), e, "USDG swap moved the ETH hub");
            assertEq(claims(address(hook), address(0)), ethClaims);
        }
    }

    /// @dev H-5 to H-7 per hub, both hubs at once, each against its own ghost, over random swaps, gaps and blocks.
    function testFuzz_two_hub_oracles_match_their_ghosts(uint256 seed) public {
        initHub(address(usdg));
        uint256 t0 = vm.getBlockTimestamp();
        addLiquidity(address(0), 1e22);
        addLiquidity(address(usdg), 1e18);
        OracleGhost ge = new OracleGhost(PM, hubId(address(0)), address(0), t0);
        OracleGhost gu = new OracleGhost(PM, hubId(address(usdg)), address(usdg), t0);
        for (uint256 i; i < 40; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            if (seed % 3 != 0) wait((seed >> 8) % 120);
            if ((seed >> 24) % 4 == 0) nextBlock();
            ge.before();
            gu.before();
            bool inEth = (seed >> 32) % 2 == 0;
            bool sellQ = (seed >> 40) % 2 == 0;
            uint256 amt = inEth ? (sellQ ? 0.01 ether + (seed >> 48) % 0.5 ether : 1e22 + (seed >> 48) % 2e24)
                : (sellQ ? 1e6 + (seed >> 48) % 1500e6 : 1e22 + (seed >> 48) % 2e24);
            swapIn(inEth ? address(0) : address(usdg), sellQ, amt);
            ge.afterAction(inEth);
            gu.afterAction(!inEth);
            assertEq(OracleCheck.verify(ge, hook), "", "ETH hub");
            assertEq(OracleCheck.verify(gu, hook), "", "USDG hub");
        }
    }

    // ---------------------------------------------------------------- collect per currency (P-4)

    function test_collect_pays_every_currency_exactly() public {
        initHub(address(usdg));
        registerPair(address(tkn), tknFeed);
        initHub(address(tkn), 5e6);
        addLiquidity(address(0), 1e22);
        addLiquidity(address(usdg), 1e18);
        addLiquidity(address(tkn), 1e17);
        swapIn(address(0), true, 1 ether);
        swapIn(address(0), false, 4e24);
        swapIn(address(usdg), true, 3000e6);
        swapIn(address(usdg), false, 4e24);
        swapIn(address(tkn), true, 5e6);
        swapIn(address(tkn), false, 4e24);
        address[4] memory cur = [address(orry), address(0), address(usdg), address(tkn)];
        uint256[4] memory pending;
        uint256[4] memory before;
        for (uint256 i; i < 4; ++i) {
            pending[i] = hook.pendingProtocolFee(cur[i]);
            assertGt(pending[i], 0);
            before[i] = cur[i] == address(0) ? address(router).balance : MockToken(cur[i]).balanceOf(address(router));
        }
        // stray balances ride along
        tkn.mint(address(hook), 5);
        for (uint256 i; i < 4; ++i) {
            vm.expectEmit(true, false, false, true, address(hook));
            emit ProtocolFeesCollected(cur[i], pending[i] + (cur[i] == address(tkn) ? 5 : 0));
        }
        vm.prank(carol);
        hook.collect();
        for (uint256 i; i < 4; ++i) {
            uint256 got = (cur[i] == address(0) ? address(router).balance : MockToken(cur[i]).balanceOf(address(router)))
                - before[i];
            assertEq(got, pending[i] + (cur[i] == address(tkn) ? 5 : 0), "router got exactly the claims");
            assertEq(hook.pendingProtocolFee(cur[i]), 0);
        }
        assertEq(tkn.balanceOf(address(hook)), 0);
    }

    function test_collect_emits_only_for_paid_currencies() public {
        addLiquidity(address(0), 1e22);
        swapIn(address(0), true, 1 ether); // fee in ORRY only
        vm.recordLogs();
        hook.collect();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == ProtocolFeesCollected.selector) {
                ++n;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), address(orry));
            }
        }
        assertEq(n, 1);
    }
}
