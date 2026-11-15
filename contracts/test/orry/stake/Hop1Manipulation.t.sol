// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";

import {IProtocolFees} from "v4-core/src/interfaces/IProtocolFees.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {BuybackBase} from "./utils/StakeBase.sol";

/// @notice Finding F-1 (lane B report): hop 1 pools carry no hook, so nothing records their start-of-block price, and
/// `executeSlice` is open to anyone. In one transaction an attacker adds concentrated liquidity to the hop 1 pool,
/// pushes its price, calls `executeSlice` (whose `minOut` follows the moved spot) and unwinds. The pool here copies the
/// deepest 4663 pool (fee 500, PoolManager protocol fee 125 each way, about 6.9 M USDG of virtual reserve).
/// Expected from the cost model: the attack pays only when a slice exceeds about 5,750 USDG. R-18 caps every slice at
/// `maxSliceUsdgCap` (1,000 USDG by default), so even with a deep hub the bundle loses money. Before R-18 the second
/// test showed a profit of 79.13 USDG per slice at a 9,147 USDG slice (hub about 800 ETH).
contract Hop1ManipulationTest is BuybackBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant Q96 = 2 ** 96;

    function setUp() public override {
        super.setUp();
        // pool 1 of 4663: 145.6e15 liquidity in range, LP fee 500, protocol fee 125 each way
        _addFullRange(usdgKey, 1e17, 2_500 ether);
        vm.prank(address(0)); // the etched PoolManager has no owner in storage
        IProtocolFees(address(pm)).setProtocolFeeController(address(this));
        IProtocolFees(address(pm)).setProtocolFee(usdgKey, uint24(125 | (125 << 12)));
        _setCoin(address(buyback));
        _revenue(1_000_000e6); // reserve 900,000 USDG: 90,000 USDG may leave today
        usdg.mint(address(this), 100_000_000e6);
        vm.deal(address(this), address(this).balance + 100_000 ether);
    }

    function test_F1_attack_does_not_pay_at_launch_hub_depth() public {
        // hub as at launch in the tests: 100 ETH full range; the slice is bounded by the hub and the R-18 cap
        (int256 profit, uint256 slice) = _attack(1.4e17, 400);
        console2.log("launch depth: slice USDG", slice);
        console2.log("launch depth: attacker profit (USDG, 6 decimals, negative = loss)");
        console2.logInt(profit);
        assertLt(profit, 0);
    }

    function test_F1_attack_does_not_pay_with_a_deep_hub_under_the_slice_cap() public {
        _addFullRange(hubKey, 7e23, 800 ether); // hub about 800 ETH: its cap alone would allow about 8,900 USDG
        (int256 profit, uint256 slice) = _attack(4.6e17, 800);
        console2.log("deep hub: slice USDG", slice);
        console2.log("deep hub: attacker profit (USDG, 6 decimals, negative = loss)");
        console2.logInt(profit);
        assertEq(slice, 1_000e6, "R-18 cap binds");
        assertLt(profit, 0, "F-1 closed: the bundle loses money");
    }

    /// @dev Attacker = this contract. JIT liquidity `jitL` in +/- `halfTicks` around the price, push sqrtP up 2%,
    /// call `executeSlice`, swap back to the starting price, remove the JIT position. Profit valued at the starting
    /// price, in USDG units.
    function _attack(uint128 jitL, int24 halfTicks) internal returns (int256 profit, uint256 slice) {
        vm.roll(vm.getBlockNumber() + 1);
        uint160 p0 = _sqrtP(usdgKey);
        (, int24 tick,,) = pm.getSlot0(usdgKey.toId());
        int24 center = (tick / 10) * 10;
        uint256 eth0 = address(this).balance;
        uint256 usdg0 = usdg.balanceOf(address(this));

        ModifyLiquidityParams memory jit = ModifyLiquidityParams({
            tickLower: center - halfTicks, tickUpper: center + halfTicks, liquidityDelta: int256(uint256(jitL)), salt: 0
        });
        lpRouter.modifyLiquidity{value: 5_000 ether}(usdgKey, jit, "");
        // push: sell USDG for ETH until sqrtP is 2% higher (price about 4% higher)
        _swapTo(false, uint160(uint256(p0) * 102 / 100));
        slice = buyback.maxSliceUsdg();
        buyback.executeSlice();
        // unwind: sell ETH back to the starting price, remove the JIT position
        _swapTo(true, p0);
        jit.liquidityDelta = -int256(uint256(jitL));
        lpRouter.modifyLiquidity(usdgKey, jit, "");

        int256 dUsdg = int256(usdg.balanceOf(address(this))) - int256(usdg0);
        int256 dEth = int256(address(this).balance) - int256(eth0);
        // ETH valued at the starting price: USDG units = wei * (p0 / 2^96)^2
        int256 ethInUsdg = dEth >= 0
            ? int256(FullMath.mulDiv(FullMath.mulDiv(uint256(dEth), p0, Q96), p0, Q96))
            : -int256(FullMath.mulDiv(FullMath.mulDiv(uint256(-dEth), p0, Q96), p0, Q96));
        profit = dUsdg + ethInUsdg;
    }

    function _swapTo(bool zeroForOne, uint160 limit) internal {
        swapRouter.swap{value: zeroForOne ? 50_000 ether : 0}(
            usdgKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: zeroForOne ? -int256(50_000 ether) : -int256(100_000_000e6),
                sqrtPriceLimitX96: limit
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}
