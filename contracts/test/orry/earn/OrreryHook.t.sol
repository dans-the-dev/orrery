// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {OrreryHook} from "../../../src/orry/OrreryHook.sol";
import {IOrreryHook} from "../../../src/orry/interfaces/IOrreryHook.sol";
import {EarnBase} from "./EarnBase.sol";
import {MockOrry, ReentrantRouter} from "./mocks/EarnMocks.sol";

contract OrreryHookTest is EarnBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    event HubInitialized(address indexed quote, PoolId indexed poolId, uint160 sqrtPriceX96);
    event ProtocolFeeTaken(PoolId indexed poolId, address indexed currency, uint256 amount);
    event ProtocolFeesCollected(address indexed currency, uint256 amount);

    function setUp() public override {
        super.setUp();
        depositBalanced(alice, 20 ether);
    }

    function _wrapped(bytes4 hookSelector, bytes4 err) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookSelector,
            abi.encodeWithSelector(err),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    /// @dev (quote, ORRY) deltas of a swap.
    function _qr(BalanceDelta d) internal view returns (int256 dq, int256 dr) {
        return orryIs0 ? (int256(d.amount1()), int256(d.amount0())) : (int256(d.amount0()), int256(d.amount1()));
    }

    function _swapQ(bool sellQuote_, int256 amountSpecified) internal returns (BalanceDelta) {
        return trader.swap(key, sellQuote_ != orryIs0, amountSpecified);
    }

    // ---------------------------------------------------------------- construction

    function test_constants_and_key() public view {
        assertEq(hook.LP_FEE(), 8500);
        assertEq(hook.protocolFeePips(), 1500);
        assertEq(hook.TICK_SPACING(), 200);
        assertEq(hook.poolManager(), address(PM));
        assertEq(hook.orry(), address(orry));
        assertEq(hook.rewardsRouter(), address(router));
        assertTrue(hook.isPair(quote));
        assertTrue(hook.pairOf(quote).initialized);
        PoolKey memory k = hook.hubKey(quote);
        assertEq(Currency.unwrap(k.currency0), orryIs0 ? address(orry) : quote);
        assertEq(Currency.unwrap(k.currency1), orryIs0 ? quote : address(orry));
        assertEq(k.fee, 8500);
        assertEq(k.tickSpacing, 200);
        assertEq(address(k.hooks), address(hook));
        assertEq(PoolId.unwrap(hook.pairOf(quote).poolId), PoolId.unwrap(k.toId()));
        assertEq(uint160(address(hook)) & 0x3FFF, 0x10C4, "permission bits");
    }

    // ---------------------------------------------------------------- H-1

    function test_H1_second_initialize_and_other_keys_revert() public {
        uint160 p0 = openingSqrtPrice(quote);
        // same key again: the PoolManager refuses it
        vm.expectRevert();
        PM.initialize(key, p0);

        // the same pair with another fee on this hook: WrongPoolKey
        PoolKey memory other = key;
        other.fee = 3000;
        vm.expectRevert(_wrapped(IHooks.afterInitialize.selector, IOrreryHook.WrongPoolKey.selector));
        PM.initialize(other, p0);
    }

    function test_H1_unregistered_hook_rejects_every_wrong_key() public {
        OrreryHook fresh = deployHook(address(router), hookAddress(2));
        MockOrry otherToken = new MockOrry();
        PoolKey memory base = fresh.hubKey(quote);
        // memory structs are references: build each key on its own
        PoolKey[4] memory wrong = [fresh.hubKey(quote), fresh.hubKey(quote), fresh.hubKey(quote), fresh.hubKey(quote)];
        wrong[0].fee = 3000;
        wrong[1].tickSpacing = 60;
        // the quote replaced by an unregistered token, on the side the quote sits
        if (orryIs0) wrong[2].currency1 = Currency.wrap(address(otherToken));
        else wrong[2].currency0 = Currency.wrap(address(1));
        wrong[3].currency0 = Currency.wrap(address(1)); // a key whose currency0 is no registered quote
        for (uint256 i; i < 4; ++i) {
            if (Currency.unwrap(wrong[i].currency0) >= Currency.unwrap(wrong[i].currency1)) continue;
            vm.expectRevert(
                abi.encodeWithSelector(
                    CustomRevert.WrappedError.selector,
                    address(fresh),
                    IHooks.afterInitialize.selector,
                    abi.encodeWithSelector(IOrreryHook.WrongPoolKey.selector),
                    abi.encodeWithSelector(Hooks.HookCallFailed.selector)
                )
            );
            PM.initialize(wrong[i], TickMath.getSqrtPriceAtTick(0));
        }
        assertFalse(fresh.pairOf(quote).initialized);

        vm.expectEmit(true, true, false, false, address(fresh));
        emit HubInitialized(quote, base.toId(), 0);
        PM.initialize(base, openingSqrtPrice(quote));
        assertTrue(fresh.pairOf(quote).initialized);
    }

    function test_callbacks_only_from_pool_manager() public {
        SwapParams memory sp = SwapParams(true, -1e18, TickMath.MIN_SQRT_PRICE + 1);
        vm.expectRevert(IOrreryHook.NotPoolManager.selector);
        hook.afterInitialize(address(this), key, 1 << 96, 0);
        vm.expectRevert(IOrreryHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), key, sp, "");
        vm.expectRevert(IOrreryHook.NotPoolManager.selector);
        hook.afterSwap(address(this), key, sp, toBalanceDelta(-1e18, 1e18), "");
        vm.expectRevert(IOrreryHook.NotPoolManager.selector);
        hook.unlockCallback(abi.encode(uint256(1), uint256(1)));
    }

    function test_unused_callbacks_revert() public {
        ModifyLiquidityParams memory mp = ModifyLiquidityParams(LOWER, UPPER, 1, 0);
        BalanceDelta z;
        vm.startPrank(address(PM));
        vm.expectRevert(IOrreryHook.HookNotImplemented.selector);
        hook.beforeInitialize(address(this), key, 1 << 96);
        vm.expectRevert(IOrreryHook.HookNotImplemented.selector);
        hook.beforeAddLiquidity(address(this), key, mp, "");
        vm.expectRevert(IOrreryHook.HookNotImplemented.selector);
        hook.afterAddLiquidity(address(this), key, mp, z, z, "");
        vm.expectRevert(IOrreryHook.HookNotImplemented.selector);
        hook.beforeRemoveLiquidity(address(this), key, mp, "");
        vm.expectRevert(IOrreryHook.HookNotImplemented.selector);
        hook.afterRemoveLiquidity(address(this), key, mp, z, z, "");
        vm.expectRevert(IOrreryHook.HookNotImplemented.selector);
        hook.beforeDonate(address(this), key, 1, 1, "");
        vm.expectRevert(IOrreryHook.HookNotImplemented.selector);
        hook.afterDonate(address(this), key, 1, 1, "");
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- start of block

    function test_start_of_block_price() public {
        (uint160 p0, uint64 b0) = hook.startOfBlockSqrtPriceX96(quote);
        assertEq(p0, 0);
        assertEq(b0, 0);

        uint160 before = sqrtPrice();
        sellQuote(q(1 ether));
        (uint160 p1, uint64 b1) = hook.startOfBlockSqrtPriceX96(quote);
        assertEq(p1, before, "price before the first swap of the block");
        assertEq(b1, block.number);

        sellQuote(q(1 ether)); // same block: not overwritten
        (uint160 p2,) = hook.startOfBlockSqrtPriceX96(quote);
        assertEq(p2, before);

        nextBlock();
        uint160 later = sqrtPrice();
        sellOrry(1e24);
        (uint160 p3, uint64 b3) = hook.startOfBlockSqrtPriceX96(quote);
        assertEq(p3, later);
        assertEq(b3, block.number);
    }

    /// @dev H-4: beforeSwap never reverts, whatever the swap parameters or the block.
    function testFuzz_H4_beforeSwap_never_reverts(bool zeroForOne, int256 amount, uint160 limit, uint64 blockNo, bytes calldata data)
        public
    {
        blockNo = uint64(bound(blockNo, 1, type(uint64).max)); // a chain never runs block 0
        vm.roll(blockNo);
        vm.prank(address(PM));
        (bytes4 sel,, uint24 fee) = hook.beforeSwap(address(this), key, SwapParams(zeroForOne, amount, limit), data);
        assertEq(sel, IHooks.beforeSwap.selector);
        assertEq(fee, 0);
        (uint160 p, uint64 b) = hook.startOfBlockSqrtPriceX96(quote);
        assertEq(p, sqrtPrice());
        assertEq(b, blockNo);
    }

    // ---------------------------------------------------------------- H-2 protocol fee

    function _feeOf(uint256 unspecified) internal pure returns (uint256) {
        return unspecified * PROTOCOL_FEE / 1e6;
    }

    function test_H2_exact_input_quote_to_orry() public {
        uint256 c1 = claims(address(hook), address(orry));
        (int256 dq, int256 dr) = _qr(_swapQ(true, -int256(q(1 ether))));
        uint256 fee = claims(address(hook), address(orry)) - c1;
        assertEq(dq, -int256(q(1 ether)));
        assertEq(fee, _feeOf(uint256(dr) + fee), "fee on the unspecified (output) side");
        assertGt(fee, 0);
        assertEq(claims(address(hook), quote), 0, "nothing on the specified side");
    }

    function test_H2_exact_input_orry_to_quote() public {
        (int256 dq,) = _qr(_swapQ(false, -4e24));
        uint256 fee = claims(address(hook), quote);
        assertEq(fee, _feeOf(uint256(dq) + fee));
        assertGt(fee, 0);
    }

    function test_H2_exact_output_quote_to_orry() public {
        (int256 dq, int256 dr) = _qr(_swapQ(true, 4e24)); // want 4M ORRY out, pay the quote
        assertEq(dr, 4e24);
        uint256 fee = claims(address(hook), quote);
        uint256 paid = uint256(-dq);
        assertEq(fee, _feeOf(paid - fee), "fee on the unspecified (input) side, paid on top");
        assertGt(fee, 0);
    }

    function test_H2_exact_output_orry_to_quote() public {
        (int256 dq, int256 dr) = _qr(_swapQ(false, int256(q(1 ether))));
        assertEq(dq, int256(q(1 ether)));
        uint256 fee = claims(address(hook), address(orry));
        uint256 paid = uint256(-dr);
        assertEq(fee, _feeOf(paid - fee));
    }

    function test_H2_tiny_swap_pays_no_fee_and_emits_nothing() public {
        vm.recordLogs();
        sellOrry(1e6); // 1e6 wei ORRY in: under one unit of any quote out, fee rounds to 0
        assertEq(claims(address(hook), quote), 0);
        assertEq(claims(address(hook), address(orry)), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(logs.length, 0);
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != ProtocolFeeTaken.selector, "no fee event for a zero fee");
        }
    }

    function testFuzz_H2_fee_is_exact(bool zeroForOne, bool exactIn, uint96 raw) public {
        // the specified currency is currency0 exactly when zeroForOne == exactIn
        bool specifiedIsQuote = (zeroForOne == exactIn) != orryIs0;
        uint256 amount = specifiedIsQuote ? bound(raw, q(1e9) + 1, q(5 ether)) : bound(raw, 1e9, 2e25);
        Currency unspecified = (exactIn == zeroForOne) ? key.currency1 : key.currency0;
        uint256 c0 = claims(address(hook), Currency.unwrap(unspecified));
        BalanceDelta d = trader.swap(key, zeroForOne, exactIn ? -int256(amount) : int256(amount));
        uint256 fee = claims(address(hook), Currency.unwrap(unspecified)) - c0;
        int128 u = exactIn == zeroForOne ? d.amount1() : d.amount0();
        // swapper delta = pool delta - hook fee; the pool delta is what the hook saw
        uint256 poolAbs = u > 0 ? uint256(int256(u)) + fee : uint256(-int256(u)) - fee;
        assertEq(fee, _feeOf(poolAbs));
    }

    function test_H2_fee_event() public {
        vm.expectEmit(true, true, false, false, address(hook));
        emit ProtocolFeeTaken(poolId, address(orry), 0);
        sellQuote(q(1 ether));
    }

    // ---------------------------------------------------------------- H-3 collect

    function _routerQuote() internal view returns (uint256) {
        return quoteBalance(address(router));
    }

    function test_H3_collect_pays_router_everything() public {
        sellQuote(q(2 ether));
        sellOrry(4e24);
        uint256 pq = hook.pendingProtocolFee(quote);
        uint256 pr = hook.pendingProtocolFee(address(orry));
        assertGt(pq, 0);
        assertGt(pr, 0);
        // stray balances reach the hook outside the fee path
        orry.transfer(address(hook), 123);
        giveQuote(address(hook), 7);

        uint256 qBefore = _routerQuote();
        uint256 rBefore = orry.balanceOf(address(router));
        vm.expectEmit(true, false, false, true, address(hook));
        emit ProtocolFeesCollected(address(orry), pr + 123);
        vm.expectEmit(true, false, false, true, address(hook));
        emit ProtocolFeesCollected(quote, pq + 7);
        vm.prank(bob);
        hook.collect();
        assertEq(_routerQuote() - qBefore, pq + 7);
        assertEq(orry.balanceOf(address(router)) - rBefore, pr + 123);
        assertEq(hook.pendingProtocolFee(quote) + hook.pendingProtocolFee(address(orry)), 0);
        assertEq(claims(address(hook), quote) + claims(address(hook), address(orry)), 0);
        assertEq(quoteBalance(address(hook)), 0);
        assertEq(orry.balanceOf(address(hook)), 0);
    }

    function test_collect_with_nothing_pending() public {
        vm.recordLogs();
        hook.collect();
        assertEq(vm.getRecordedLogs().length, 0, "no event, no transfer");
    }

    function test_collect_one_side_only() public {
        sellQuote(q(1 ether)); // fee in ORRY only
        uint256 r0 = orry.balanceOf(address(router));
        uint256 q0 = _routerQuote();
        hook.collect();
        assertEq(_routerQuote(), q0);
        assertGt(orry.balanceOf(address(router)), r0);
        sellOrry(4e24); // fee in the quote only
        r0 = orry.balanceOf(address(router));
        hook.collect();
        assertGt(_routerQuote(), q0);
        assertEq(orry.balanceOf(address(router)), r0);
    }

    function test_collect_is_reentrancy_safe() public {
        if (!isEth) vm.skip(true); // re-entry needs a native transfer to the router
        ReentrantRouter rr = new ReentrantRouter();
        OrreryHook h = deployHook(address(rr), hookAddress(3));
        rr.setHook(IOrreryHook(address(h)));
        vm.deal(address(h), 1 ether); // stray ETH: collect calls the router after the unlock has ended
        h.collect();
        assertTrue(rr.tried());
        assertFalse(rr.innerSucceeded(), "re-entry must fail");
        assertEq(address(rr).balance, 1 ether);
    }

    function test_buyback_style_swap_pays_fee_too() public {
        // any swapper, including a contract acting for the protocol, pays the hook fee
        sellQuote(q(0.5 ether));
        assertGt(claims(address(hook), address(orry)), 0);
    }

    // ---------------------------------------------------------------- G-1

    function test_G1_no_pons_address_in_runtime_code() public view {
        address[3] memory pons = [
            0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e,
            0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e,
            0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044
        ];
        address[5] memory ours = [address(hook), address(vault), address(claimAll), address(lens), address(factory)];
        for (uint256 i; i < ours.length; ++i) {
            bytes memory code = ours[i].code;
            for (uint256 j; j < pons.length; ++j) {
                assertFalse(_contains(code, abi.encodePacked(pons[j])), "Pons address in runtime code");
            }
        }
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (hay.length < needle.length) return false;
        for (uint256 i; i <= hay.length - needle.length; ++i) {
            bool m = true;
            for (uint256 k; k < needle.length; ++k) {
                if (hay[i + k] != needle[k]) {
                    m = false;
                    break;
                }
            }
            if (m) return true;
        }
        return false;
    }
}

contract OrreryHookUsdgLowTest is OrreryHookTest {
    function kind() internal pure override returns (Kind) {
        return Kind.USDG_LOW;
    }
}

contract OrreryHookUsdgHighTest is OrreryHookTest {
    function kind() internal pure override returns (Kind) {
        return Kind.USDG_HIGH;
    }
}
