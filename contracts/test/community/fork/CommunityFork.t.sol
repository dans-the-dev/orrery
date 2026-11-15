// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {OrreryAttestor} from "../../../src/OrreryAttestor.sol";
import {IIdentityRegistry, IERC20Min} from "../../../src/interfaces/IExternal.sol";
import {OrreryHook} from "../../../src/orry/OrreryHook.sol";
import {OrryStaking} from "../../../src/orry/OrryStaking.sol";
import {OrryRewardsRouter} from "../../../src/orry/OrryRewardsRouter.sol";
import {OrreryTreasury} from "../../../src/orry/OrreryTreasury.sol";
import {OrryBuyback} from "../../../src/orry/OrryBuyback.sol";
import {IOrryToken} from "../../../src/orry/interfaces/IOrryToken.sol";
import {OrryPriceOracle} from "../../../src/markets/OrryPriceOracle.sol";

import {RewardPool} from "../../../src/community/RewardPool.sol";
import {OrryAchievements} from "../../../src/community/OrryAchievements.sol";
import {OrryChat} from "../../../src/community/OrryChat.sol";
import {OrryBoost} from "../../../src/community/OrryBoost.sol";
import {OrryPasses} from "../../../src/community/OrryPasses.sol";
import {TemplateMarket} from "../../../src/community/TemplateMarket.sol";
import {ReferralRegistry} from "../../../src/community/ReferralRegistry.sol";
import {CashbackRewards} from "../../../src/community/CashbackRewards.sol";
import {StakeUsdVerifier} from "../../../src/community/verifiers/StakeUsdVerifier.sol";
import {Months} from "../../../src/community/Months.sol";

/// @notice Lane L1 on a fork of Robinhood Chain 4663 with the real ORRY stack: the launched ORRY token
/// (0x85272EA3…6aA4, Pons V2, still on its curve), the real PoolManager, USDG, ERC-8004 IdentityRegistry, the
/// Chainlink ETH/USD feed and the three recorded ETH/USDG pools; lane A's real `OrreryHook` (its 30 minute TWAP, R-28),
/// lane B's real `OrryStaking`, `OrreryTreasury`, `OrryRewardsRouter` and `OrryBuyback`, and the R1
/// `OrryPriceOracle`, all deployed from source on the fork, wired to the L1 contracts. The ORRY/ETH hub is opened on
/// the fork (the token has no hub on 4663 yet). The oracle's ETH staleness is 120 days so the 48 hour and 2 month warps keep the real
/// feed's last answer usable; everything else is a launch value.
/// Run: forge test --match-path 'test/community/fork/*' --fork-url https://rpc-robinhood.blockmachine.io -vv
contract CommunityForkTest is Test {
    address internal constant ORRY = 0x85272EA3aE8685C768045dba5455fE305C706aA4;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    uint160 internal constant HUB_SQRT_PRICE = 158456325028528675187087900672000; // 4,000,000 ORRY per ETH

    IPoolManager internal pm = IPoolManager(POOL_MANAGER);
    IOrryToken internal orry = IOrryToken(ORRY);
    OrryStaking internal staking;
    OrreryTreasury internal treasury;
    OrreryHook internal hook;
    OrryBuyback internal buyback;
    OrryRewardsRouter internal router;
    OrryPriceOracle internal oracle;
    PoolModifyLiquidityTest internal lpRouter;
    PoolSwapTest internal swapRouter;
    PoolKey internal hubKey;

    RewardPool internal pool;
    OrryAchievements internal ach;
    OrryChat internal chat;
    OrryBoost internal boost;
    OrryPasses internal passes;
    TemplateMarket internal market;
    ReferralRegistry internal registry;
    CashbackRewards internal cashback;

    address internal owner = makeAddr("treasuryOwner");
    address internal admin = makeAddr("treasuryWallet");
    address internal publisher = makeAddr("publisher");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    uint256 internal clock;

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url of Robinhood Chain 4663");
        require(ORRY.code.length > 0 && address(pm).code.length > 0, "fork state");
        clock = block.timestamp;

        staking = new OrryStaking(ORRY, IDENTITY_REGISTRY, 7 days, 14 days, 7 days);
        OrreryAttestor attestor =
            new OrreryAttestor(IIdentityRegistry(IDENTITY_REGISTRY), IERC20Min(USDG), makeAddr("attestorAdmin"), address(1), 5e6);
        address[] memory signers = new address[](1);
        signers[0] = makeAddr("quoteSigner");
        treasury = new OrreryTreasury(USDG, address(attestor), owner, 3000, signers);
        vm.prank(makeAddr("attestorAdmin"));
        attestor.setTreasury(address(treasury));

        uint64 n = vm.getNonce(address(this)) + 1; // deployCodeTo spends one nonce
        address buybackAt = vm.computeCreateAddress(address(this), n);
        address routerAt = vm.computeCreateAddress(address(this), n + 1);
        address hookAt = address((uint160(uint256(keccak256("orrery.l1.fork.hook"))) & ~uint160(0x3FFF)) | 0x10C4);
        deployCodeTo(
            "OrreryHook.sol:OrreryHook",
            abi.encode(POOL_MANAGER, ORRY, routerAt, address(treasury), uint24(8500), uint24(1500), int24(200), USDG, ETH_USD_FEED),
            hookAt
        );
        hook = OrreryHook(hookAt);
        PoolKey[] memory hop1 = new PoolKey[](3);
        hop1[0] = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 500, 10, IHooks(address(0)));
        hop1[1] = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 460, 9, IHooks(address(0)));
        hop1[2] = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 100, 1, IHooks(address(0)));
        buyback = new OrryBuyback(address(treasury), routerAt, hookAt, USDG, POOL_MANAGER, hop1, 1_000e6, 1000);
        router = new OrryRewardsRouter(ORRY, address(staking), address(buyback), hookAt, 5000, 1 hours);
        require(address(buyback) == buybackAt && address(router) == routerAt, "address prediction");
        oracle = new OrryPriceOracle(hookAt, USDG, ETH_USD_FEED, 120 days);

        // the ORRY/ETH hub, opened on the fork with real ORRY
        lpRouter = new PoolModifyLiquidityTest(pm);
        swapRouter = new PoolSwapTest(pm);
        hubKey = hook.hubKey(address(0));
        pm.initialize(hubKey, HUB_SQRT_PRICE);
        deal(ORRY, address(this), 500_000_000e18);
        vm.deal(address(this), 1_000 ether);
        orry.approve(address(lpRouter), type(uint256).max);
        orry.approve(address(swapRouter), type(uint256).max);
        lpRouter.modifyLiquidity{value: 60 ether}(
            hubKey,
            ModifyLiquidityParams(TickMath.minUsableTick(200), TickMath.maxUsableTick(200), 4e22, 0),
            ""
        );

        // L1
        address achAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        pool = new RewardPool(ORRY, achAt, admin, 2500, 48 hours);
        ach = new OrryAchievements(address(pool));
        chat = new OrryChat(ORRY, address(oracle), address(pool), address(staking), 0.01e6, 1000, 500, 10_000e18, 5);
        boost = new OrryBoost(ORRY, address(oracle), 0.5e6, 5e6, 2e6);
        passes = new OrryPasses(ORRY, address(oracle), 1e6, 5e6);
        market = new TemplateMarket(ORRY, address(oracle), 2000, 1e6, 1000e6);
        registry = new ReferralRegistry();
        cashback = new CashbackRewards(
            ORRY,
            address(oracle),
            address(registry),
            admin,
            CashbackRewards.Config(30 days, 365 days, 90 days, 1000e6, 5000, 1000)
        );
        vm.prank(admin);
        cashback.setPublisher(publisher);

        address[2] memory people = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            orry.transfer(people[i], 10_000_000e18);
            vm.startPrank(people[i]);
            orry.approve(address(chat), type(uint256).max);
            orry.approve(address(boost), type(uint256).max);
            orry.approve(address(passes), type(uint256).max);
            orry.approve(address(market), type(uint256).max);
            orry.approve(address(staking), type(uint256).max);
            orry.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }
    }

    receive() external payable {}

    function _warp(uint256 secs) internal {
        clock += secs;
        vm.warp(clock);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _history() internal {
        assertFalse(oracle.ready(), "no history yet");
        _warp(31 minutes);
        assertTrue(oracle.ready(), "ETH hub mean tick times the real ETH/USD feed");
        assertEq(oracle.source(), 2);
    }

    function test_fork_real_orry_token_shape_and_burn() public {
        assertEq(orry.totalSupply() <= 1e27, true);
        assertEq(IERC20Min(ORRY).decimals(), 18);
        uint256 supply = orry.totalSupply();
        vm.prank(alice);
        orry.burn(1e18);
        assertEq(supply - orry.totalSupply(), 1e18, "burn leaves the supply");
        vm.prank(alice);
        orry.approve(bob, 2e18);
        vm.prank(bob);
        orry.burnFrom(alice, 2e18);
        assertEq(supply - orry.totalSupply(), 3e18, "burnFrom leaves the supply");
        vm.prank(alice);
        orry.transfer(bob, 5e18);
        console2.log("real ORRY totalSupply after test burns", orry.totalSupply());
    }

    function test_fork_chat_names_boost_on_the_real_twap() public {
        vm.prank(alice);
        vm.expectRevert();
        chat.post(0, 0, "too early", type(uint256).max);
        _history();
        uint256 fee = oracle.orryFor(0.01e6);
        assertEq(chat.postFee(), fee);
        console2.log("post fee in ORRY (0.01 USD)", fee);
        console2.log("1 ORRY in USDG base units", oracle.usdValue(1e18));
        vm.prank(alice);
        uint256 id = chat.post(0, 0, "gm from the fork", type(uint256).max);
        assertEq(pool.freeBalance(ORRY), fee);
        assertEq(orry.balanceOf(address(pool)), fee);

        // staker room on real OrryStaking: 50 USD of earning stake at the TWAP
        vm.prank(admin);
        uint256 room = chat.createRoom(50e6, "stakers");
        vm.prank(bob);
        vm.expectRevert();
        chat.post(room, 0, "no stake", type(uint256).max);
        uint256 need = oracle.orryFor(50e6);
        vm.prank(alice);
        staking.stake(need + 1e18);
        assertGe(chat.stakeUsdOf(alice), 50e6);
        vm.prank(alice);
        chat.post(room, 0, "staker room", type(uint256).max);

        // tip and report with the real staking balance
        uint256 p0 = pool.freeBalance(ORRY);
        vm.prank(bob);
        chat.tip(id, 100e18);
        assertEq(pool.freeBalance(ORRY) - p0, 5e18, "5% tip cut");

        // boost burns real ORRY (source 8)
        uint256 supply = orry.totalSupply();
        uint256 cost = boost.quote(2, 1);
        vm.prank(bob);
        boost.boost(2, 1, 1, type(uint256).max);
        assertEq(supply - orry.totalSupply(), cost, "real burn");
        assertTrue(boost.isBoosted(2, 1));
        console2.log("agent boost, 1 day (5 USD) in ORRY", cost);

        // a template sale: 20% burned, 80% to the creator
        vm.prank(alice);
        uint256 t = market.list(10e6, keccak256("caps 50 USDG/day"), "ipfs://template");
        supply = orry.totalSupply();
        uint256 a0 = orry.balanceOf(alice);
        vm.prank(bob);
        uint256 paid = market.buy(t, type(uint256).max);
        assertEq(supply - orry.totalSupply(), paid * 2000 / 10_000);
        assertEq(orry.balanceOf(alice) - a0, paid - paid * 2000 / 10_000);
    }

    function test_fork_achievement_and_event_payouts() public {
        _history();
        deal(ORRY, admin, 1_000_000e18);
        vm.startPrank(admin);
        orry.approve(address(pool), type(uint256).max);
        pool.fund(ORRY, 1_000_000e18);
        StakeUsdVerifier v = new StakeUsdVerifier(address(staking), address(oracle), 100e6);
        uint256 aid = ach.create(ORRY, 1_000e18, 100, uint64(clock + 7 days), 1, address(v), keccak256("stake 100 USD"));
        uint256 eid = pool.createEvent(ORRY, 100_000e18, uint64(clock + 7 days), 2, keccak256("most active"));
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(OrryAchievements.ConditionNotMet.selector);
        ach.claim(aid, "");
        uint256 stakeNeed = oracle.orryFor(100e6) + 1e18; // computed first: a prank covers the next call only
        vm.prank(alice);
        staking.stake(stakeNeed);
        uint256 a0 = orry.balanceOf(alice);
        vm.prank(alice);
        ach.claim(aid, "");
        assertEq(orry.balanceOf(alice) - a0, 1_000e18);

        address[] memory ws = new address[](1);
        uint256[] memory amts = new uint256[](1);
        (ws[0], amts[0]) = (bob, 60_000e18);
        vm.prank(admin);
        pool.publishWinners(eid, ws, amts);
        _warp(48 hours);
        uint256 b0 = orry.balanceOf(bob);
        pool.claimFor(eid, bob);
        assertEq(orry.balanceOf(bob) - b0, 60_000e18);
        assertEq(pool.freeBalance(ORRY) + pool.lockedBalance(ORRY), orry.balanceOf(address(pool)));
    }

    /// @dev B-1 end to end: the treasury owner sets CashbackRewards as the buyback's cashback sink after 48 hours; a
    /// slice through the real ETH/USDG pools and the hub pays 10% of its ORRY to the sink; the publisher accrues
    /// cashback and a referral; the month opens 30 days after it ends and pays at the real TWAP, pro rata.
    function test_fork_b1_buyback_feeds_the_cashback_sink() public {
        vm.prank(owner);
        treasury.proposeCoin(ORRY, address(buyback));
        vm.prank(owner);
        buyback.proposeCashbackSink(address(cashback));
        _warp(48 hours);
        vm.prank(owner);
        treasury.executeCoin();
        vm.prank(owner);
        buyback.executeCashbackSink();
        assertEq(buyback.cashbackSink(), address(cashback));

        deal(USDG, address(treasury), 20_000e6);
        treasury.sync();
        uint256 out = buyback.executeSlice();
        uint256 cb = out * 1000 / 10_000;
        assertEq(orry.balanceOf(address(cashback)), cb, "sink got its 10%");
        assertEq(cashback.free(), cb);
        console2.log("slice ORRY out / to the sink", out, cb);

        // links and accruals this month
        vm.prank(bob);
        registry.link(alice);
        CashbackRewards.Accrual[] memory xs = new CashbackRewards.Accrual[](2);
        xs[0] = CashbackRewards.Accrual(bob, 1, address(0), uint64(clock), 100e6, 2e6, keccak256("tx1:0"));
        xs[1] = CashbackRewards.Accrual(alice, 2, bob, uint64(clock), 100e6, 20e6, keccak256("tx1:0"));
        vm.prank(publisher);
        cashback.accrue(xs);
        uint256 month = Months.monthOf(clock);
        uint256 openAt = cashback.openableAt(month);
        vm.expectRevert(abi.encodeWithSelector(CashbackRewards.NotOpenable.selector, openAt));
        cashback.openPeriod(month);

        // the hub needs fresh history after a long gap: a small trade keeps the TWAP live
        _warp(openAt - clock);
        swapRouter.swap{value: 0.01 ether}(
            hubKey,
            SwapParams(true, -0.01 ether, TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        _warp(31 minutes);
        uint256 needed = oracle.orryFor(22e6);
        uint256 reserve = cashback.openPeriod(month);
        assertEq(reserve, needed < cb ? needed : cb, "pro rata reserve");
        uint256 a0 = orry.balanceOf(alice);
        uint256[] memory ms = new uint256[](1);
        ms[0] = month;
        vm.prank(alice);
        cashback.claim(ms);
        uint256 aliceGot = orry.balanceOf(alice) - a0;
        assertEq(aliceGot, reserve * 20e6 / 22e6);
        console2.log("needed / reserved / referral paid", needed, reserve, aliceGot);
        assertEq(cashback.free() + cashback.totalReserved(), orry.balanceOf(address(cashback)));
    }
}
