// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {OrreryAttestor} from "../../../../src/OrreryAttestor.sol";
import {IIdentityRegistry, IERC20Min} from "../../../../src/interfaces/IExternal.sol";
import {IOrryBuyback} from "../../../../src/orry/interfaces/IOrryBuyback.sol";
import {IOrreryTreasury} from "../../../../src/orry/interfaces/IOrreryTreasury.sol";
import {IOrryStaking} from "../../../../src/orry/interfaces/IOrryStaking.sol";
import {OrryStaking} from "../../../../src/orry/OrryStaking.sol";
import {OrryRewardsRouter} from "../../../../src/orry/OrryRewardsRouter.sol";
import {OrreryTreasury} from "../../../../src/orry/OrreryTreasury.sol";
import {OrryBuyback} from "../../../../src/orry/OrryBuyback.sol";
import {MockOrry} from "../../../orry/stake/utils/StakeMocks.sol";
import {TestHubHook} from "../../../orry/stake/utils/TestHubHook.sol";
import {QuoteSigning} from "../../../orry/stake/utils/TreasuryBase.sol";
import {Pools4663} from "./Pools4663.sol";

interface IIdentityRegistryRegister {
    function register(string memory agentURI) external returns (uint256);
}

/// @notice Lane B on a fork of Robinhood Chain 4663: the real PoolManager, the three recorded ETH/USDG v4 pools, real
/// USDG and the real ERC-8004 IdentityRegistry. An ORRY stand-in (Pons-shaped) and its hub pool are created on the fork
/// with the test hook (lane A's hook is not merged yet; integration re-runs with it later).
/// Run: forge test --match-path 'test/fork/orry/stake/*' --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract StakeForkTest is QuoteSigning {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant Q96 = 2 ** 96;

    IPoolManager internal pm = IPoolManager(Pools4663.POOL_MANAGER);
    IERC20Min internal usdg = IERC20Min(Pools4663.USDG);
    MockOrry internal orry;
    OrreryAttestor internal attestor;
    OrryStaking internal staking;
    OrreryTreasury internal treasury;
    OrryRewardsRouter internal router;
    OrryBuyback internal buyback;
    TestHubHook internal hook;
    PoolModifyLiquidityTest internal lpRouter;
    PoolSwapTest internal swapRouter;
    PoolKey internal hubKey;
    PoolKey[] internal hop1;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal trader = makeAddr("trader");
    address internal quoteSigner;
    uint256 internal signerKey;

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url of Robinhood Chain 4663");
        require(address(pm).code.length > 0, "PoolManager");
        (quoteSigner, signerKey) = makeAddrAndKey("quoteSigner");

        hop1.push(_ethUsdgKey(Pools4663.POOL_A_FEE, Pools4663.POOL_A_SPACING));
        hop1.push(_ethUsdgKey(Pools4663.POOL_B_FEE, Pools4663.POOL_B_SPACING));
        hop1.push(_ethUsdgKey(Pools4663.POOL_C_FEE, Pools4663.POOL_C_SPACING));

        orry = new MockOrry(address(this), 1e27);
        staking = new OrryStaking(address(orry), Pools4663.IDENTITY_REGISTRY, 7 days, 14 days, 7 days);
        attestor = new OrreryAttestor(
            IIdentityRegistry(Pools4663.IDENTITY_REGISTRY), usdg, makeAddr("attestorAdmin"), address(1), 5e6
        );
        address[] memory signers = new address[](1);
        signers[0] = quoteSigner;
        treasury = new OrreryTreasury(address(usdg), address(attestor), owner, 1000, signers);
        vm.prank(makeAddr("attestorAdmin"));
        attestor.setTreasury(address(treasury));

        lpRouter = new PoolModifyLiquidityTest(pm);
        swapRouter = new PoolSwapTest(pm);
        uint64 n = vm.getNonce(address(this)) + 1; // deployCodeTo uses one nonce
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
        buyback = new OrryBuyback(address(treasury), routerAt, hookAt, address(usdg), address(pm), hop1, 1_000e6, 1000);
        router = new OrryRewardsRouter(address(orry), address(staking), address(buyback), hookAt, 5000, 1 hours);
        require(address(router) == routerAt, "address prediction");

        // hub: about 1,000,000 ORRY per ETH, 100 ETH and 100 M ORRY full range
        hubKey = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(orry)), 8500, 200, IHooks(hookAt));
        pm.initialize(hubKey, TickMath.getSqrtPriceAtTick(138_200));
        orry.approve(address(lpRouter), type(uint256).max);
        vm.deal(address(this), 1_000 ether);
        lpRouter.modifyLiquidity{value: 110 ether}(
            hubKey,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(200),
                tickUpper: TickMath.maxUsableTick(200),
                liquidityDelta: 1e23,
                salt: 0
            }),
            ""
        );

        orry.transfer(alice, 10_000_000e18);
        orry.transfer(trader, 50_000_000e18);
        vm.deal(alice, 10 ether);
        vm.deal(trader, 50 ether);
    }

    function _ethUsdgKey(uint24 fee, int24 spacing) internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(Pools4663.USDG), fee, spacing, IHooks(address(0)));
    }

    function _sqrtP(PoolKey memory key) internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(key.toId());
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    // ---------------------------------------------------------------- recorded pools

    function test_fork_recorded_pools_are_live() public view {
        bytes32[3] memory ids = [Pools4663.POOL_A_ID, Pools4663.POOL_B_ID, Pools4663.POOL_C_ID];
        for (uint256 i; i < 3; ++i) {
            assertEq(PoolId.unwrap(hop1[i].toId()), ids[i], "recorded key hashes to the recorded id");
            (uint160 s, int24 tick, uint24 protocolFee, uint24 lpFee) = pm.getSlot0(hop1[i].toId());
            uint128 l = pm.getLiquidity(hop1[i].toId());
            assertGt(s, 0);
            assertGt(l, 0);
            assertEq(lpFee, hop1[i].fee);
            console2.log("pool", i);
            console2.log("  liquidity now", l);
            console2.log("  sqrtPriceX96 now", s);
            console2.log("  tick now", tick);
            console2.log("  protocolFee", protocolFee);
            console2.log("  virtual USDG (6 decimals)", FullMath.mulDiv(l, s, Q96));
        }
        console2.log("fork block (EVM block.number reads the L1 number on 4663)", block.number);
        console2.log("fork timestamp", block.timestamp);
    }

    // ---------------------------------------------------------------- the whole lane B path

    function test_fork_treasury_slice_distribute_stream_claim_burn() public {
        // stakers: a plain stake and an agent stake behind a real ERC-8004 identity
        vm.startPrank(alice);
        orry.approve(address(staking), type(uint256).max);
        staking.stake(1_000_000e18);
        uint256 agentId = IIdentityRegistryRegister(Pools4663.IDENTITY_REGISTRY).register("ipfs://orrery-lane-b-fork");
        staking.stakeForAgent(agentId, 500_000e18);
        uint64 lockedUntil = uint64(_now() + 10 days); // R-13: the Agent Launch gate reads this
        staking.extendAgentLock(agentId, lockedUntil);
        vm.stopPrank();
        assertEq(staking.agentStake(agentId).lockedUntil, lockedUntil);
        assertEq(staking.agentStake(agentId).active, 500_000e18);
        assertEq(staking.earningBalance(alice), 1_500_000e18);

        // 1. coinless: revenue splits 10/90, nothing can be pulled, the owner may reclaim the reserve
        deal(address(usdg), address(treasury), 1_000e6);
        treasury.sync();
        assertEq(treasury.ownerAccrued(), 100e6);
        assertEq(treasury.buybackReserve(), 900e6);
        assertEq(buyback.maxSliceUsdg(), 0);
        vm.expectRevert(IOrryBuyback.NothingToBuy.selector);
        buyback.executeSlice();
        vm.prank(owner);
        treasury.reclaimReserve();
        vm.prank(owner);
        treasury.withdrawOwnerShare();
        assertEq(usdg.balanceOf(owner), 1_000e6);

        // 2. the coin is set 48 hours after the proposal
        deal(address(usdg), address(treasury), 20_000e6);
        uint256 t0 = _now();
        vm.prank(owner);
        treasury.proposeCoin(address(orry), address(buyback));
        vm.warp(t0 + 48 hours - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IOrreryTreasury.ProposalNotReady.selector, uint64(t0 + 48 hours)));
        treasury.executeCoin();
        vm.warp(t0 + 48 hours);
        vm.prank(owner);
        treasury.executeCoin();
        assertEq(treasury.orry(), address(orry));

        // 3. a slice through the deepest real ETH/USDG pool and the hub
        uint160[3] memory pre = [_sqrtP(hop1[0]), _sqrtP(hop1[1]), _sqrtP(hop1[2])];
        uint160 hubPre = _sqrtP(hubKey);
        uint256 amount = buyback.maxSliceUsdg();
        assertGt(amount, 0);
        treasury.sync();
        uint256 reserve = treasury.buybackReserve();
        uint256 g = gasleft();
        uint256 out = buyback.executeSlice();
        uint256 sliceGas = g - gasleft();
        assertEq(orry.balanceOf(address(router)), out, "B-3");
        assertEq(treasury.buybackReserve(), reserve - amount);
        assertEq(usdg.balanceOf(address(buyback)), 0);
        uint256 deepest = _deepestIndex();
        for (uint256 i; i < 3; ++i) {
            if (i == deepest) {
                uint256 fee = _fullFee(hop1[i], false);
                uint256 moved = _sqrtP(hop1[i]) - pre[i];
                assertGt(moved, 0, "deepest pool traded");
                assertLe(moved * 2e6, uint256(pre[i]) * fee, "B-2 hop 1");
                console2.log("hop 1 pool index, fee pips incl. protocol fee", i, fee);
                console2.log("hop 1 sqrtP move ppm", moved * 1e6 / pre[i]);
            } else {
                assertEq(_sqrtP(hop1[i]), pre[i], "other pools untouched");
            }
        }
        uint256 hubMoved = hubPre - _sqrtP(hubKey);
        assertLe(hubMoved * 2e6, uint256(hubPre) * _fullFee(hubKey, true), "B-2 hub");
        console2.log("slice USDG in (6 decimals)", amount);
        console2.log("slice ORRY out", out);
        console2.log("executeSlice gas", sliceGas);
        vm.expectRevert(abi.encodeWithSelector(IOrryBuyback.TooSoon.selector, uint64(_now() + 1 hours)));
        buyback.executeSlice();

        // 4. hub trading fees reach the router through the hook; the router splits
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(trader);
        orry.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap{value: 3 ether}(hubKey, _params(true, 3 ether), _settings(), "");
        swapRouter.swap(hubKey, _params(false, 2_000_000e18), _settings(), "");
        vm.stopPrank();
        uint256 feeEth = hook.pendingProtocolFee(address(0));
        uint256 feeRc = hook.pendingProtocolFee(address(orry));
        hook.collect();
        assertGt(feeEth, 0);
        assertGt(feeRc, 0);
        uint256 routerRc = orry.balanceOf(address(router));
        uint256 supply = orry.totalSupply();
        router.distribute();
        assertEq(address(router).balance, 0, "RR-1");
        assertEq(orry.balanceOf(address(router)), 0, "RR-1");
        assertEq(supply - orry.totalSupply(), routerRc - routerRc / 2, "RR-2 burn");
        assertEq(address(buyback).balance, feeEth - feeEth / 2, "RR-2 ETH to the buyback");

        // 5. burnEth buys ORRY in the hub with that ETH and burns it
        vm.roll(vm.getBlockNumber() + 1);
        supply = orry.totalSupply();
        g = gasleft();
        uint256 burned = buyback.burnEth();
        uint256 burnGas = g - gasleft();
        assertGt(burned, 0);
        assertEq(supply - orry.totalSupply(), burned, "B-3 burn");
        assertEq(orry.balanceOf(address(buyback)), 0);
        console2.log("burnEth ORRY burned", burned);
        console2.log("burnEth gas", burnGas);

        // 6. the stream pays the staker over seven days
        vm.warp(_now() + 7 days);
        (uint256 e, uint256 r) = staking.pendingRewards(alice);
        assertApproxEqAbs(e, feeEth / 2, 7 days);
        assertApproxEqAbs(r, routerRc / 2, 7 days);
        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        staking.claimRewards();
        assertEq(alice.balance, ethBefore + e);

        // 7. ORRY checkout: a verification for the real identity, paid in ORRY and burned, no USDG moved
        uint256 usdgBefore = usdg.balanceOf(address(treasury));
        bytes32 q = keccak256("fork-verify");
        uint64 exp = uint64(_now() + 120);
        bytes memory sig = _verificationSig(signerKey, address(treasury), alice, agentId, 25e18, q, exp);
        vm.prank(alice);
        orry.approve(address(treasury), 25e18);
        supply = orry.totalSupply();
        vm.prank(alice);
        treasury.verifyWithOrry(agentId, alice, 25e18, q, exp, sig);
        assertTrue(attestor.isVerified(agentId));
        assertEq(attestor.getVerification(agentId).feePaid, 0);
        assertEq(usdg.balanceOf(address(treasury)), usdgBefore);
        assertEq(supply - orry.totalSupply(), 25e18);

        // 8. unstake and withdraw after the cooldowns (the agent stake only once its lock ends)
        vm.startPrank(alice);
        staking.requestUnstake(1_000_000e18);
        vm.expectRevert(abi.encodeWithSelector(IOrryStaking.AgentStakeLocked.selector, lockedUntil));
        staking.requestAgentUnstake(agentId, alice, 500_000e18);
        vm.warp(lockedUntil);
        staking.requestAgentUnstake(agentId, alice, 500_000e18);
        vm.warp(_now() + 14 days);
        assertEq(staking.withdraw(), 1_000_000e18);
        assertEq(staking.withdrawAgent(agentId, alice), 500_000e18);
        vm.stopPrank();
        assertEq(staking.totalEarning(), 0);
    }

    /// @dev R-35 to R-37 with both hubs open on the real PoolManager: the treasury slice goes one hop through a USDG hub
    /// deeper than the ETH path; USDG-hub trading fees are collected, forwarded by the router and bought into ORRY in
    /// the USDG hub; the router splits that ORRY half to stakers, half burned.
    function test_fork_two_hubs_direct_slice_and_quote_fees() public {
        vm.startPrank(alice);
        orry.approve(address(staking), type(uint256).max);
        staking.stake(1_000_000e18);
        vm.stopPrank();

        // open the USDG hub at about 448.6 ORRY per USDG (0.00223 USD per ORRY, as the ETH hub), L = 8e18
        PoolKey memory usdgHub = hook.hubKey(address(usdg));
        bool usdgIs0 = Currency.unwrap(usdgHub.currency0) == address(usdg);
        pm.initialize(usdgHub, TickMath.getSqrtPriceAtTick(usdgIs0 ? int24(337_400) : int24(-337_400)));
        deal(address(usdg), address(this), 2_000_000e6);
        (bool ok,) = address(usdg).call(abi.encodeWithSignature("approve(address,uint256)", address(lpRouter), type(uint256).max));
        require(ok);
        lpRouter.modifyLiquidity(
            usdgHub,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(200),
                tickUpper: TickMath.maxUsableTick(200),
                liquidityDelta: 8e18,
                salt: 0
            }),
            ""
        );

        // coin set, revenue in
        vm.prank(owner);
        treasury.proposeCoin(address(orry), address(buyback));
        vm.warp(_now() + 48 hours);
        vm.prank(owner);
        treasury.executeCoin();
        deal(address(usdg), address(treasury), 20_000e6);
        treasury.sync();

        // the route rule on the real pools: the USDG hub's cap is at least the ETH path's
        assertTrue(buyback.sliceViaUsdgHub(), "direct route");
        uint160[3] memory hop1Pre = [_sqrtP(hop1[0]), _sqrtP(hop1[1]), _sqrtP(hop1[2])];
        uint160 ethHubPre = _sqrtP(hubKey);
        uint256 expected = buyback.maxSliceUsdg();
        uint256 routerRc = orry.balanceOf(address(router));
        vm.recordLogs();
        uint256 g = gasleft();
        uint256 out = buyback.executeSlice();
        console2.log("direct slice gas", g - gasleft());
        console2.log("direct slice USDG in", expected);
        console2.log("direct slice ORRY out", out);
        assertEq(orry.balanceOf(address(router)) - routerRc, out);
        for (uint256 i; i < 3; ++i) {
            assertEq(_sqrtP(hop1[i]), hop1Pre[i], "hop 1 pools untouched");
        }
        assertEq(_sqrtP(hubKey), ethHubPre, "the ETH hub untouched");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(buyback) && logs[i].topics[0] == IOrryBuyback.SliceExecuted.selector) {
                (uint256 usdgIn, uint256 ethMid,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                assertEq(usdgIn, expected);
                assertEq(ethMid, 0, "one hop");
            }
        }

        // trading in the USDG hub leaves fees in USDG and ORRY
        vm.roll(vm.getBlockNumber() + 1);
        deal(address(usdg), trader, 50_000e6);
        vm.startPrank(trader);
        (ok,) = address(usdg).call(abi.encodeWithSignature("approve(address,uint256)", address(swapRouter), type(uint256).max));
        require(ok);
        orry.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(usdgHub, _params(usdgIs0, 5_000e6), _settings(), "");
        swapRouter.swap(usdgHub, _params(!usdgIs0, 2_000_000e18), _settings(), "");
        vm.stopPrank();
        uint256 feeUsdg = hook.pendingProtocolFee(address(usdg));
        assertGt(feeUsdg, 0);
        hook.collect();
        vm.warp(_now() + 1 hours);
        router.distribute();
        assertEq(usdg.balanceOf(address(router)), 0, "P-5: forwarded");
        assertEq(usdg.balanceOf(address(buyback)), feeUsdg);

        vm.roll(vm.getBlockNumber() + 1);
        uint256 qOut = buyback.buyWithQuote(address(usdg));
        console2.log("USDG hub fees bought into ORRY", feeUsdg, qOut);
        assertEq(usdg.balanceOf(address(buyback)), 0);
        vm.warp(_now() + 1 hours);
        uint256 rc = orry.balanceOf(address(router));
        uint256 supply = orry.totalSupply();
        router.distribute();
        assertEq(supply - orry.totalSupply(), rc - rc / 2, "half burned");
        assertEq(orry.balanceOf(address(router)), 0);
    }

    /// @dev B-1 on the fork: the treasury owner sets the cashback sink after 48 hours; a slice through the real ETH/USDG
    /// pools then pays 10% of its ORRY to the sink and the rest to the router.
    function test_fork_cashback_sink_split() public {
        address sink = makeAddr("cashbackSink");
        vm.prank(owner);
        treasury.proposeCoin(address(orry), address(buyback));
        vm.prank(owner);
        buyback.proposeCashbackSink(sink);
        vm.warp(_now() + 48 hours);
        vm.prank(owner);
        treasury.executeCoin();
        vm.prank(owner);
        buyback.executeCashbackSink();
        deal(address(usdg), address(treasury), 20_000e6);
        treasury.sync();
        uint256 r0 = orry.balanceOf(address(router));
        uint256 out = buyback.executeSlice();
        uint256 cb = out * 1000 / 10_000;
        console2.log("slice ORRY out / cashback", out, cb);
        assertEq(orry.balanceOf(sink), cb);
        assertEq(orry.balanceOf(address(router)) - r0, out - cb);
        assertEq(orry.balanceOf(address(buyback)), 0);
    }

    function test_fork_same_block_guard() public {
        deal(address(usdg), address(treasury), 20_000e6);
        vm.prank(owner);
        treasury.proposeCoin(address(orry), address(buyback));
        vm.warp(_now() + 48 hours);
        vm.prank(owner);
        treasury.executeCoin();
        vm.startPrank(trader);
        swapRouter.swap{value: 3 ether}(hubKey, _params(true, 3 ether), _settings(), "");
        vm.stopPrank();
        vm.expectRevert(IOrryBuyback.PriceMovedInBlock.selector);
        buyback.executeSlice();
        vm.roll(vm.getBlockNumber() + 1);
        buyback.executeSlice();
    }

    /// R-18 on the real pools: pushing listed pool 2 (about 57% of pool 1's liquidity) 0.8% in price makes it disagree
    /// with pool 1, so the slice is refused; pool 1 stays the chosen pool and is untouched.
    function test_fork_listed_pool_spread_refuses_a_slice() public {
        deal(address(usdg), address(treasury), 20_000e6);
        vm.prank(owner);
        treasury.proposeCoin(address(orry), address(buyback));
        vm.warp(_now() + 48 hours);
        vm.prank(owner);
        treasury.executeCoin();
        uint160 a0 = _sqrtP(hop1[0]);
        deal(address(usdg), address(this), 10_000_000e6);
        (bool ok,) = address(usdg).call(abi.encodeWithSignature("approve(address,uint256)", address(swapRouter), type(uint256).max));
        require(ok);
        uint160 b0 = _sqrtP(hop1[1]);
        swapRouter.swap(
            hop1[1],
            SwapParams({zeroForOne: false, amountSpecified: -int256(10_000_000e6), sqrtPriceLimitX96: uint160(uint256(b0) * 1004 / 1000)}),
            _settings(),
            ""
        );
        assertGt(_sqrtP(hop1[1]), b0);
        vm.expectRevert(IOrryBuyback.PriceMovedInBlock.selector);
        buyback.executeSlice();
        assertEq(_sqrtP(hop1[0]), a0);
    }

    // ---------------------------------------------------------------- helpers

    function _deepestIndex() internal view returns (uint256 best) {
        uint256 bestReserve;
        for (uint256 i; i < 3; ++i) {
            uint256 r = FullMath.mulDiv(pm.getLiquidity(hop1[i].toId()), _sqrtP(hop1[i]), Q96);
            if (r > bestReserve) {
                bestReserve = r;
                best = i;
            }
        }
    }

    function _fullFee(PoolKey memory key, bool zeroForOne) internal view returns (uint256) {
        (,, uint24 protocolFee, uint24 lpFee) = pm.getSlot0(key.toId());
        uint256 pf = zeroForOne ? protocolFee & 0xfff : protocolFee >> 12;
        uint256 fee = pf + lpFee - (pf * lpFee) / 1e6;
        if (address(key.hooks) == address(hook)) fee += hook.protocolFeePips();
        return fee;
    }

    function _params(bool zeroForOne, uint256 amountIn) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }

    function _settings() internal pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    receive() external payable {}
}
