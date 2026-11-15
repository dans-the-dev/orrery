// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";

import {AgentCoin} from "../../src/launch/AgentCoin.sol";
import {SpokeHook} from "../../src/launch/SpokeHook.sol";
import {ISpokeHook} from "../../src/launch/interfaces/ISpokeHook.sol";
import {LaunchBase} from "./utils/LaunchBase.sol";
import {HostileLpL5} from "./utils/LaunchMocks.sol";

/// @notice `SpokeHook` unit tests: the fee on the ORRY side for all four swap kinds (LA-5), the launch fee curve, the
/// early window (LA-11), access (pool init and liquidity only from `AgentLaunch`, LA-6), hostile pool init with and without
/// liquidity, and the hook holding nothing (LA-4).
contract SpokeHookTest is LaunchBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function _wrapped(bytes4 callback, bytes memory inner) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            callback,
            inner,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    // ---------------------------------------------------------------- construction

    function test_permission_bits_and_constants() public view {
        assertEq(uint160(address(hook)) & 0x3FFF, 0x28CC);
        assertEq(hook.BASE_FEE(), 10_000);
        assertEq(hook.startFeePips(), START_FEE);
        assertEq(hook.decayWindow(), DECAY);
        assertEq(hook.earlyWindow(), EARLY);
        assertEq(hook.launch(), address(al));
    }

    function test_constructor_bounds() public {
        address at = address((uint160(uint256(keccak256("ctor"))) & ~uint160(0x3FFF)) | HOOK_BITS);
        _expectCtorRevert(at, abi.encode(address(PM), address(orry), address(al), uint24(9_999), uint32(60), uint32(0)));
        _expectCtorRevert(at, abi.encode(address(PM), address(orry), address(al), uint24(990_001), uint32(60), uint32(0)));
        _expectCtorRevert(at, abi.encode(address(PM), address(orry), address(al), START_FEE, uint32(0), uint32(0)));
        _expectCtorRevert(at, abi.encode(address(PM), address(orry), address(al), START_FEE, uint32(3601), uint32(0)));
        _expectCtorRevert(at, abi.encode(address(PM), address(orry), address(al), START_FEE, uint32(60), uint32(86_401)));
        _expectCtorRevert(at, abi.encode(address(0), address(orry), address(al), START_FEE, uint32(60), uint32(0)));
        // the bounds themselves are accepted
        this.deployHookTo(at, abi.encode(address(PM), address(orry), address(al), uint24(990_000), uint32(3600), uint32(86_400)));
        SpokeHook edge = SpokeHook(at);
        assertEq(edge.startFeePips(), 990_000);
        assertEq(edge.decayWindow(), 3600);
        assertEq(edge.earlyWindow(), 86_400);
        // wrong permission bits
        address wrong = address((uint160(uint256(keccak256("ctor"))) & ~uint160(0x3FFF)) | 0x10C4);
        vm.expectRevert();
        this.deployHookTo(wrong, abi.encode(address(PM), address(orry), address(al), START_FEE, DECAY, EARLY));
    }

    function _expectCtorRevert(address at, bytes memory args) internal {
        vm.expectRevert();
        this.deployHookTo(at, args);
    }

    function deployHookTo(address at, bytes memory args) external {
        deployCodeTo("SpokeHook.sol:SpokeHook", args, at);
    }

    function test_callbacks_only_from_the_pool_manager() public {
        PoolKey memory key;
        SwapParams memory sp;
        ModifyLiquidityParams memory mp;
        vm.expectRevert(ISpokeHook.NotPoolManager.selector);
        hook.beforeInitialize(address(al), key, 0);
        vm.expectRevert(ISpokeHook.NotPoolManager.selector);
        hook.beforeAddLiquidity(address(al), key, mp, "");
        vm.expectRevert(ISpokeHook.NotPoolManager.selector);
        hook.beforeSwap(address(al), key, sp, "");
        vm.expectRevert(ISpokeHook.NotPoolManager.selector);
        hook.afterSwap(address(al), key, sp, BalanceDelta.wrap(0), "");
        vm.expectRevert(ISpokeHook.HookNotImplemented.selector);
        hook.afterInitialize(address(0), key, 0, 0);
        vm.expectRevert(ISpokeHook.HookNotImplemented.selector);
        hook.beforeRemoveLiquidity(address(0), key, mp, "");
        vm.expectRevert(ISpokeHook.HookNotImplemented.selector);
        hook.beforeDonate(address(0), key, 0, 0, "");
        vm.expectRevert(ISpokeHook.HookNotImplemented.selector);
        hook.afterDonate(address(0), key, 0, 0, "");
        vm.expectRevert(ISpokeHook.HookNotImplemented.selector);
        hook.afterAddLiquidity(address(0), key, mp, BalanceDelta.wrap(0), BalanceDelta.wrap(0), "");
        vm.expectRevert(ISpokeHook.HookNotImplemented.selector);
        hook.afterRemoveLiquidity(address(0), key, mp, BalanceDelta.wrap(0), BalanceDelta.wrap(0), "");
    }

    // ---------------------------------------------------------------- fee on the ORRY side (LA-5)

    function test_buy_exact_in_fee_from_the_input() public {
        (address coin,) = _launchOpen(alice);
        PoolId id = _key(coin).toId();
        uint256 before = orry.balanceOf(bob);
        _buy(bob, coin, 10_000e18);
        assertEq(before - orry.balanceOf(bob), 10_000e18, "pays exactly the input");
        assertEq(hook.feesOf(id), 100e18, "1% of the input");
        assertEq(_claims(address(al)), 100e18);
    }

    function test_buy_exact_out_fee_on_top() public {
        (address coin,) = _launchOpen(alice);
        PoolId id = _key(coin).toId();
        uint256 before = orry.balanceOf(bob);
        BalanceDelta d = _swap(bob, coin, true, int256(100_000e18));
        assertEq(uint256(int256(d.amount1())), 100_000e18, "exact coins out");
        uint256 paid = before - orry.balanceOf(bob);
        uint256 fee = hook.feesOf(id);
        assertEq(fee, (paid - fee) * 10_000 / 1_000_000, "1% of the pool's ORRY input, charged on top");
    }

    function test_sell_exact_in_fee_from_the_output() public {
        (address coin,) = _launchOpen(alice);
        PoolId id = _key(coin).toId();
        uint256 coins = _buy(bob, coin, 10_000e18);
        uint256 fee0 = hook.feesOf(id);
        uint256 before = orry.balanceOf(bob);
        uint256 got = _sell(bob, coin, coins);
        assertEq(orry.balanceOf(bob) - before, got);
        uint256 fee = hook.feesOf(id) - fee0;
        assertEq(fee, (got + fee) * 10_000 / 1_000_000, "1% of the pool's ORRY output");
        // a round trip loses about 2% plus the price impact both ways (zero net)
        assertApproxEqRel(got, 9_801e18, 0.0001e18);
    }

    function test_sell_exact_out_fee_on_the_output() public {
        (address coin,) = _launchOpen(alice);
        PoolId id = _key(coin).toId();
        _buy(bob, coin, 10_000e18);
        uint256 fee0 = hook.feesOf(id);
        uint256 before = orry.balanceOf(bob);
        _swap(bob, coin, false, int256(5_000e18));
        assertEq(orry.balanceOf(bob) - before, 5_000e18, "exact ORRY out");
        assertEq(hook.feesOf(id) - fee0, 50e18, "1% of the requested output");
    }

    function test_hook_holds_nothing() public {
        (address coin,) = _launchOpen(alice);
        _buy(bob, coin, 10_000e18);
        _sell(bob, coin, AgentCoin(coin).balanceOf(bob));
        assertEq(orry.balanceOf(address(hook)), 0);
        assertEq(AgentCoin(coin).balanceOf(address(hook)), 0);
        assertEq(_claims(address(hook)), 0, "LA-4 claims go to AgentLaunch");
    }

    // ---------------------------------------------------------------- launch fee curve

    function test_launch_fee_falls_from_the_public_opening() public {
        (uint256 id,) = _agent(alice);
        address coin = _launch(id, alice, 0);
        PoolId pid = _key(coin).toId();
        uint64 open = hook.publicOpenAt(pid);
        assertEq(hook.feeAt(pid, open - 1), START_FEE, "flat before the opening");
        assertEq(hook.feeAt(pid, open), START_FEE);
        assertEq(hook.feeAt(pid, open + 30), 10_000 + (START_FEE - 10_000) / 2);
        assertEq(hook.feeAt(pid, open + DECAY - 1), 10_000 + (START_FEE - 10_000) / DECAY);
        assertEq(hook.feeAt(pid, open + DECAY), 10_000);
        assertEq(hook.feeAt(PoolId.wrap(bytes32(uint256(1))), open), 10_000, "unknown pool");
        uint24 last = type(uint24).max;
        for (uint256 t = open; t <= open + DECAY + 5; t += 7) {
            uint24 f = hook.feeAt(pid, t);
            assertLe(f, last, "non-increasing");
            last = f;
        }
        _warp(EARLY);
        uint256 fees = hook.feesOf(pid);
        _buy(bob, coin, 1_000e18);
        assertEq(hook.feesOf(pid) - fees, 800e18, "80% at the opening second");
        fees = hook.feesOf(pid);
        _sell(bob, coin, AgentCoin(coin).balanceOf(bob));
        uint256 sellFee = hook.feesOf(pid) - fees;
        assertLt(sellFee, 3e18, "sells pay 1% even inside the decay");
        _warp(30);
        fees = hook.feesOf(pid);
        _buy(carol, coin, 1_000e18);
        assertEq(hook.feesOf(pid) - fees, 1_000e18 * (10_000 + (uint256(START_FEE) - 10_000) / 2) / 1_000_000, "half way");
    }

    function test_is_early() public {
        (uint256 id,) = _agent(alice);
        address coin = _launch(id, alice, 0);
        PoolId pid = _key(coin).toId();
        assertTrue(hook.isEarly(pid));
        assertEq(hook.openedAt(pid), block.timestamp);
        _warp(EARLY - 1);
        assertTrue(hook.isEarly(pid));
        _warp(1);
        assertFalse(hook.isEarly(pid));
        assertFalse(hook.isEarly(PoolId.wrap(bytes32(uint256(1)))));
    }

    function test_early_window_refuses_public_buys_of_both_kinds() public {
        (uint256 id,) = _agent(alice);
        address coin = _launch(id, alice, 0);
        PoolKey memory key = _key(coin);
        uint64 open = hook.publicOpenAt(key.toId());
        _approveCoin(bob, coin);
        bytes memory inner = abi.encodeWithSelector(ISpokeHook.EarlyAccessOnly.selector, open);
        vm.expectRevert(_wrapped(IHooks.beforeSwap.selector, inner));
        _rawSwap(bob, key, true, -1e18);
        vm.expectRevert(_wrapped(IHooks.beforeSwap.selector, inner));
        _rawSwap(bob, key, true, 1e18);
    }

    // ---------------------------------------------------------------- access and hostile cases

    function test_hostile_init_of_the_spoke_key_before_launch() public {
        (uint256 id,) = _agent(alice);
        address coin = al.predictCoin(alice, bytes32(id), "Agent Coin", "AGC");
        PoolKey memory key = PoolKey(Currency.wrap(address(orry)), Currency.wrap(coin), 0, 200, IHooks(address(hook)));
        uint160 badPrice = TickMath.getSqrtPriceAtTick(-200_000);
        vm.prank(carol);
        vm.expectRevert(_wrapped(IHooks.beforeInitialize.selector, abi.encodeWithSelector(ISpokeHook.NotLaunch.selector)));
        PM.initialize(key, badPrice);
        // the launch still opens its own key at the start price
        assertEq(_launch(id, alice, 0), coin);
        assertEq(_tick(coin), START_TICK);
        // and nobody can initialize it again
        vm.expectRevert();
        PM.initialize(key, badPrice);
    }

    function test_hostile_pool_with_liquidity_on_another_key_changes_nothing() public {
        (uint256 id,) = _agent(alice);
        address coin = al.predictCoin(alice, bytes32(id), "Agent Coin", "AGC");
        // a hookless coin/ORRY pool at a skewed price, opened before the coin exists, with ORRY-only liquidity
        PoolKey memory squat = PoolKey(Currency.wrap(address(orry)), Currency.wrap(coin), 3000, 60, IHooks(address(0)));
        PM.initialize(squat, TickMath.getSqrtPriceAtTick(60_000));
        HostileLpL5 lp = new HostileLpL5(PM);
        vm.startPrank(carol);
        orry.approve(address(lp), type(uint256).max);
        lp.add(squat, ModifyLiquidityParams(60_060, 120_000, 1e24, 0));
        vm.stopPrank();
        (uint128 squatLiq,,) = PM.getPositionInfo(squat.toId(), address(lp), 60_060, 120_000, bytes32(0));
        assertEq(squatLiq, 1e24, "the squatter's ORRY-only position exists");
        // our launch is untouched by it
        address made = _launch(id, alice, 1_000e18);
        assertEq(made, coin);
        assertLt(_tick(coin), START_TICK);
        assertGt(_tick(coin), START_TICK - 200, "a 1,000 ORRY first buy barely moves the spoke");
        _assertOnePosition(coin);
    }

    function test_outside_liquidity_is_refused() public {
        (address coin,) = _launchOpen(alice);
        _buy(bob, coin, 10_000e18);
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(PM);
        PoolKey memory key = _key(coin);
        vm.startPrank(bob);
        orry.approve(address(lp), type(uint256).max);
        AgentCoin(coin).approve(address(lp), type(uint256).max);
        vm.expectRevert(_wrapped(IHooks.beforeAddLiquidity.selector, abi.encodeWithSelector(ISpokeHook.NotLaunch.selector)));
        lp.modifyLiquidity(key, ModifyLiquidityParams(-887_200, 887_200, 1e18, 0), "");
        vm.stopPrank();
        _assertOnePosition(coin);
    }

    function test_wrong_key_shapes_cannot_open_on_the_hook() public {
        // even AgentLaunch could not open a key of another shape: the checks sit in the hook
        PoolKey memory key = PoolKey(Currency.wrap(address(orry)), Currency.wrap(address(uint160(0xBEEF00000000))), 0, 60, IHooks(address(hook)));
        vm.prank(address(al));
        vm.expectRevert(_wrapped(IHooks.beforeInitialize.selector, abi.encodeWithSelector(ISpokeHook.WrongPoolKey.selector)));
        PM.initialize(key, TickMath.getSqrtPriceAtTick(0));
        key = PoolKey(Currency.wrap(address(orry)), Currency.wrap(address(uint160(0xBEEF00000000))), 100, 200, IHooks(address(hook)));
        vm.prank(address(al));
        vm.expectRevert(_wrapped(IHooks.beforeInitialize.selector, abi.encodeWithSelector(ISpokeHook.WrongPoolKey.selector)));
        PM.initialize(key, TickMath.getSqrtPriceAtTick(0));
        // a pair without ORRY as currency0
        key = PoolKey(Currency.wrap(address(0x1)), Currency.wrap(address(uint160(0xBEEF00000000))), 0, 200, IHooks(address(hook)));
        vm.prank(address(al));
        vm.expectRevert(_wrapped(IHooks.beforeInitialize.selector, abi.encodeWithSelector(ISpokeHook.WrongPoolKey.selector)));
        PM.initialize(key, TickMath.getSqrtPriceAtTick(0));
    }

    // ---------------------------------------------------------------- whole-supply sell back

    function test_everyone_can_sell_back_and_the_pool_returns_to_the_start() public {
        (address coin,) = _launchOpen(alice);
        _buy(bob, coin, 1_000_000e18);
        _buy(carol, coin, 500_000e18);
        _sell(bob, coin, AgentCoin(coin).balanceOf(bob));
        _sell(carol, coin, AgentCoin(coin).balanceOf(carol));
        assertGe(_tick(coin), START_TICK - 1, "back at the opening price");
        assertEq(AgentCoin(coin).balanceOf(address(PM)) + AgentCoin(coin).balanceOf(address(al)), 1_000_000_000e18);
    }
}
