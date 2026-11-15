// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {OrryStaking} from "../../../../src/orry/OrryStaking.sol";
import {OrryRewardsRouter} from "../../../../src/orry/OrryRewardsRouter.sol";
import {OrryBuyback} from "../../../../src/orry/OrryBuyback.sol";
import {TreasuryBase, QuoteSigning} from "./TreasuryBase.sol";
import {TestHubHook} from "./TestHubHook.sol";
import {PoolManagerCode} from "./PoolManagerCode.sol";

/// @notice Accepts ETH, used as the buyback address where the buyback itself is not under test.
contract EthSink {
    receive() external payable {}
}

/// @notice Shared deployment for lane B tests: `TreasuryBase` (token stand-ins, attestor, treasury), then staking, then
/// `_wire` deploys the router (and, in `BuybackBase`, the hub, the ETH/USDG pool and the buyback).
abstract contract StakeBase is TreasuryBase {
    OrryStaking internal staking;
    OrryRewardsRouter internal router;
    address internal buybackAddr;

    function setUp() public virtual override {
        super.setUp();
        staking = new OrryStaking(address(orry), address(registry), 7 days, 14 days, 7 days);
        address[3] memory people = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vm.prank(people[i]);
            orry.approve(address(staking), type(uint256).max);
        }
        _wire();
    }

    function _wire() internal virtual {
        buybackAddr = address(new EthSink());
        // a hook with no pairs: the router only reads its pair list
        address[] memory none = new address[](0);
        address hookStandIn = address(
            new TestHubHook(address(0xdead), address(orry), address(0), 8500, 1500, 200, address(treasury), owner, none)
        );
        router = new OrryRewardsRouter(address(orry), address(staking), buybackAddr, hookStandIn, 5000, 1 hours);
    }

    function _notify(uint256 ethAmount, uint256 orryAmount) internal {
        orry.approve(address(staking), orryAmount);
        vm.deal(address(this), address(this).balance + ethAmount);
        staking.notifyRewards{value: ethAmount}(orryAmount);
    }
}

/// @notice Adds a local Uniswap v4 PoolManager (the 4663 runtime etched at its address), an ETH/USDG pool, the multi-pair
/// test hook with the ETH and USDG pairs registered (R-35), the ETH hub initialized with liquidity, and the real buyback
/// and router wired together. The USDG hub is registered but not initialized here, so the treasury slice takes the ETH
/// path; `_initUsdgHub` opens it.
abstract contract BuybackBase is StakeBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager internal pm;
    PoolModifyLiquidityTest internal lpRouter;
    PoolSwapTest internal swapRouter;
    TestHubHook internal hook;
    OrryBuyback internal buyback;
    PoolKey internal usdgKey;
    PoolKey internal hubKey; // the ETH hub
    PoolKey internal usdgHubKey; // the USDG hub (ORRY/USDG)

    int24 internal constant USDG_TICK = -199200; // about 2,235 USDG per ETH
    int24 internal constant HUB_TICK = 138200; // about 1,002,600 ORRY per ETH
    uint128 internal constant USDG_POOL_L = 4.7e16; // full range, about 1,000 ETH and 2.2 M USDG
    uint128 internal constant HUB_L = 1e23; // full range, about 100 ETH and 100 M ORRY

    function _wire() internal virtual override {
        vm.etch(PoolManagerCode.ADDRESS, PoolManagerCode.runtime());
        pm = IPoolManager(PoolManagerCode.ADDRESS);
        lpRouter = new PoolModifyLiquidityTest(pm);
        swapRouter = new PoolSwapTest(pm);

        // deployCodeTo below uses one nonce of this contract (measured), so the buyback is the second CREATE from here
        uint64 n = vm.getNonce(address(this)) + 1;
        address buybackAt = vm.computeCreateAddress(address(this), n);
        address routerAt = vm.computeCreateAddress(address(this), n + 1);

        address hookAt = address(
            uint160(0x4444) << 144 | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        address[] memory launch = new address[](2);
        (launch[0], launch[1]) = (address(0), address(usdg));
        deployCodeTo(
            "TestHubHook.sol:TestHubHook",
            abi.encode(
                address(pm),
                address(orry),
                routerAt,
                uint24(8500),
                uint24(1500),
                int24(200),
                address(treasury),
                owner,
                launch
            ),
            hookAt
        );
        hook = TestHubHook(hookAt);

        usdgKey = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), 500, 10, IHooks(address(0)));
        hubKey = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(orry)), 8500, 200, IHooks(hookAt));
        usdgHubKey = hook.hubKey(address(usdg));
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = usdgKey;
        buyback = new OrryBuyback(address(treasury), routerAt, hookAt, address(usdg), address(pm), keys, 1_000e6, 1000);
        router = new OrryRewardsRouter(address(orry), address(staking), address(buyback), hookAt, 5000, 1 hours);
        require(address(buyback) == buybackAt && address(router) == routerAt, "address prediction");
        buybackAddr = address(buyback);

        pm.initialize(usdgKey, TickMath.getSqrtPriceAtTick(USDG_TICK));
        pm.initialize(hubKey, TickMath.getSqrtPriceAtTick(HUB_TICK));
        usdg.mint(address(this), 1e15);
        usdg.approve(address(lpRouter), type(uint256).max);
        usdg.approve(address(swapRouter), type(uint256).max);
        orry.approve(address(lpRouter), type(uint256).max);
        orry.approve(address(swapRouter), type(uint256).max);
        vm.deal(address(this), 10_000 ether);
        _addFullRange(usdgKey, USDG_POOL_L, 1_100 ether);
        _addFullRange(hubKey, HUB_L, 110 ether);
    }

    function _addFullRange(PoolKey memory key, uint128 liquidity, uint256 ethValue) internal {
        lpRouter.modifyLiquidity{value: ethValue}(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(key.tickSpacing),
                tickUpper: TickMath.maxUsableTick(key.tickSpacing),
                liquidityDelta: int256(uint256(liquidity)),
                salt: 0
            }),
            ""
        );
    }

    /// @dev Exact-input swap through the test router; `zeroForOne` sells ETH.
    function _swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal {
        swapRouter.swap{value: zeroForOne ? amountIn : 0}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Initializes the USDG hub at about 448.6 ORRY per USDG (0.00223 USD per ORRY, as the ETH hub at 2,235 USDG
    /// per ETH) with full-range liquidity `liquidity` (2e18 is about 94,000 USDG and 42 M ORRY).
    function _initUsdgHub(uint128 liquidity) internal {
        bool usdgIs0 = Currency.unwrap(usdgHubKey.currency0) == address(usdg);
        pm.initialize(usdgHubKey, TickMath.getSqrtPriceAtTick(usdgIs0 ? int24(337400) : int24(-337400)));
        lpRouter.modifyLiquidity(
            usdgHubKey,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(200),
                tickUpper: TickMath.maxUsableTick(200),
                liquidityDelta: int256(uint256(liquidity)),
                salt: 0
            }),
            ""
        );
    }

    function _sqrtP(PoolKey memory key) internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(key.toId());
    }
}
