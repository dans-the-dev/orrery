// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {EarnBase} from "./EarnBase.sol";

/// @dev Gas of one hub swap on each path through `beforeSwap`, with the hook, PoolManager, swapper and ORRY storage
/// cold as at the start of a transaction. Uses only swaps, so the same file measures the hook before the oracle.
contract OrreryHookGasTest is EarnBase {
    function setUp() public override {
        vm.warp(1_700_000_000);
        super.setUp();
        depositBalanced(alice, 20 ether);
    }

    /// @dev Measures an exact-in swap of 0.01 ETH worth of the quote, then swaps the ORRY back unmeasured in the same
    /// second and block, so every measurement starts from the same price and pays the same token transfers.
    function gasSwap() internal returns (uint256 used) {
        uint256 orryBefore = orry.balanceOf(address(trader));
        int256 amount = -int256(q(0.01 ether));
        vm.cool(address(hook));
        vm.cool(address(PM));
        vm.cool(address(trader));
        vm.cool(address(orry));
        vm.cool(address(usdg));
        uint256 g = gasleft();
        trader.swap(key, !orryIs0, amount);
        used = g - gasleft();
        sellOrry(orry.balanceOf(address(trader)) - orryBefore);
    }

    function test_gas_swapPaths() public {
        wait(61);
        nextBlock();
        uint256 a = gasSwap();
        uint256 b = gasSwap();
        nextBlock();
        uint256 c = gasSwap();
        wait(1);
        uint256 d = gasSwap();
        wait(1);
        nextBlock();
        uint256 e = gasSwap();
        wait(60);
        uint256 f = gasSwap();
        for (uint256 i; i < 64; ++i) {
            wait(60);
            if (i % 2 == 0) sellQuote(q(1e12) + 1);
            else sellOrry(4e18);
        }
        wait(60);
        uint256 h = gasSwap();
        console2.log("new block, new second, 60 s: checkpoint into an empty slot", a);
        console2.log("same block, same second", b);
        console2.log("new block, same second", c);
        console2.log("same block, new second, no checkpoint", d);
        console2.log("new block, new second, no checkpoint", e);
        console2.log("same block, new second, 60 s: checkpoint into an empty slot", f);
        console2.log("same block, new second, 60 s: checkpoint over a used slot", h);
    }
}

contract OrreryHookGasUsdgLowTest is OrreryHookGasTest {
    function kind() internal pure override returns (Kind) {
        return Kind.USDG_LOW;
    }
}

contract OrreryHookGasUsdgHighTest is OrreryHookGasTest {
    function kind() internal pure override returns (Kind) {
        return Kind.USDG_HIGH;
    }
}
