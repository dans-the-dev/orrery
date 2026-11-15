// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {OrreryAttestor} from "../../../src/OrreryAttestor.sol";
import {IIdentityRegistry, IERC20Min} from "../../../src/interfaces/IExternal.sol";
import {OrreryHook} from "../../../src/orry/OrreryHook.sol";
import {EarnVault} from "../../../src/orry/EarnVault.sol";
import {EarnVaultFactory} from "../../../src/orry/EarnVaultFactory.sol";
import {ClaimAll} from "../../../src/orry/ClaimAll.sol";
import {OrryLens} from "../../../src/orry/OrryLens.sol";
import {OrryStaking} from "../../../src/orry/OrryStaking.sol";
import {OrryRewardsRouter} from "../../../src/orry/OrryRewardsRouter.sol";
import {OrreryTreasury} from "../../../src/orry/OrreryTreasury.sol";
import {OrryBuyback} from "../../../src/orry/OrryBuyback.sol";
import {IOrryBuyback} from "../../../src/orry/interfaces/IOrryBuyback.sol";
import {IOrryRewardsRouter} from "../../../src/orry/interfaces/IOrryRewardsRouter.sol";
import {IClaimAll, IOrryLens} from "../../../src/orry/interfaces/IOrryClaims.sol";
import {MockIdentityRegistry, MockERC20} from "../../mocks/Mocks.sol";
import {PoolManagerCode} from "../earn/fixtures/PoolManagerCode.sol";
import {MockOrry, MockFeed, HubActor} from "../earn/mocks/EarnMocks.sol";

/// @notice Integration of all lanes with the real contracts on the 4663 PoolManager runtime (etched): lane A's
/// multi-pair hook (ORRY/ETH and ORRY/USDG hubs), the vault factory's two vaults, ClaimAll and lens, wired to lane B's
/// staking, rewards router, treasury and buyback. Each lane tested against stand-ins for the other; this suite checks
/// the seams (spec 3.1 to 3.7, R-35 to R-37, invariants G-1, G-2, RR-1, B-3, E-1, S-4, P-4, P-5).
contract OrrySystemTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager internal constant PM = IPoolManager(PoolManagerCode.ADDRESS);
    bytes32 internal constant BURNED = keccak256("Burned(uint8,uint256)");
    bytes32 internal constant CREDITS_TYPEHASH =
        keccak256("CreditsQuote(address buyer,uint32 packs,uint256 orryAmount,bytes32 quoteId,uint64 expiry)");
    uint160 internal constant HUB_SQRT_PRICE = 158456325028528675187087900672000; // 4,000,000 ORRY per ETH
    int24 internal constant USDG_TICK = -199200; // about 2,235 USDG per ETH

    MockOrry internal orry;
    MockERC20 internal usdg;
    MockFeed internal ethFeed;
    MockIdentityRegistry internal registry;
    OrreryAttestor internal attestor;
    OrryStaking internal staking;
    OrreryTreasury internal treasury;
    OrreryHook internal hook;
    OrryBuyback internal buyback;
    OrryRewardsRouter internal router;
    EarnVaultFactory internal factory;
    EarnVault internal vault; // ETH hub
    EarnVault internal vaultU; // USDG hub
    ClaimAll internal claimAll;
    OrryLens internal lens;
    HubActor internal trader;
    PoolKey internal hubKey; // ORRY/ETH
    PoolKey internal hubKeyU; // ORRY/USDG
    PoolKey internal usdgKey; // ETH/USDG, buyback hop 1

    address internal owner = makeAddr("owner");
    address internal attestorAdmin = makeAddr("attestorAdmin");
    address internal alice = makeAddr("alice"); // Earn only
    address internal bob = makeAddr("bob"); // Earn and plain stake
    address internal carol = makeAddr("carol"); // plain stake only
    address internal dave = makeAddr("dave"); // agent owner, stakes behind the agent
    uint256 internal signerKey;
    uint256 internal agentId;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.etch(address(PM), PoolManagerCode.RUNTIME);
        address quoteSigner;
        (quoteSigner, signerKey) = makeAddrAndKey("quoteSigner");

        orry = new MockOrry();
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        ethFeed = new MockFeed(2_235e8);
        registry = new MockIdentityRegistry();
        staking = new OrryStaking(address(orry), address(registry), 7 days, 14 days, 7 days);
        attestor = new OrreryAttestor(
            IIdentityRegistry(address(registry)), IERC20Min(address(usdg)), attestorAdmin, address(1), 5e6
        );
        address[] memory signers = new address[](1);
        signers[0] = quoteSigner;
        treasury = new OrreryTreasury(address(usdg), address(attestor), owner, 1000, signers);
        vm.prank(attestorAdmin);
        attestor.setTreasury(address(treasury));

        // router, buyback and hook reference each other (finding F-4): predict the two CREATE addresses, put the hook
        // at a flag-mined address first (deployCodeTo spends one nonce of this contract)
        uint64 n = vm.getNonce(address(this)) + 1;
        address buybackAt = vm.computeCreateAddress(address(this), n);
        address routerAt = vm.computeCreateAddress(address(this), n + 1);
        address hookAt = address((uint160(uint256(keccak256("orrery.integration.hook"))) & ~uint160(0x3FFF)) | 0x10C4);
        deployCodeTo(
            "OrreryHook.sol:OrreryHook",
            abi.encode(
                address(PM),
                address(orry),
                routerAt,
                address(treasury),
                uint24(8500),
                uint24(1500),
                int24(200),
                address(usdg),
                address(ethFeed)
            ),
            hookAt
        );
        hook = OrreryHook(hookAt);
        usdgKey = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), 500, 10, IHooks(address(0)));
        PoolKey[] memory hop1 = new PoolKey[](1);
        hop1[0] = usdgKey;
        buyback = new OrryBuyback(address(treasury), routerAt, hookAt, address(usdg), address(PM), hop1, 1_000e6, 1000);
        router = new OrryRewardsRouter(address(orry), address(staking), address(buyback), hookAt, 5000, 1 hours);
        require(address(buyback) == buybackAt && address(router) == routerAt, "address prediction");
        // B-1: no cashback sink at deploy, so every ORRY the buyback buys goes to the router (the slice asserts below)
        require(buyback.cashbackSink() == address(0) && buyback.CASHBACK_BPS() == 1000, "cashback sink unset");
        factory = new EarnVaultFactory(hookAt);
        vault = EarnVault(payable(factory.createVault(address(0))));
        vaultU = EarnVault(payable(factory.createVault(address(usdg))));
        claimAll = new ClaimAll(address(factory), address(staking));
        lens = new OrryLens(address(factory), address(staking));

        hubKey = hook.hubKey(address(0));
        hubKeyU = hook.hubKey(address(usdg));
        PM.initialize(hubKey, HUB_SQRT_PRICE);
        PM.initialize(usdgKey, TickMath.getSqrtPriceAtTick(USDG_TICK));
        // the USDG hub opens at the ETH hub's ORRY per ETH divided by the hop 1 pool's USDG per ETH
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(USDG_TICK);
        PM.initialize(
            hubKeyU,
            hook.pairOf(address(usdg)).orryIsCurrency0
                ? uint160(FullMath.mulDiv(sqrtA, 1 << 96, HUB_SQRT_PRICE))
                : uint160(FullMath.mulDiv(HUB_SQRT_PRICE, 1 << 96, sqrtA))
        );

        // ETH/USDG depth for hop 1: about 1,000 ETH and 2.2 M USDG full range
        trader = new HubActor(PM);
        vm.deal(address(trader), 5_000 ether);
        usdg.mint(address(trader), 10_000_000e6);
        orry.transfer(address(trader), 1e26);
        trader.modify(usdgKey, TickMath.minUsableTick(10), TickMath.maxUsableTick(10), int256(uint256(4.7e16)), bytes32(0));

        address[4] memory people = [alice, bob, carol, dave];
        for (uint256 i; i < 4; ++i) {
            vm.deal(people[i], 1_000 ether);
            orry.transfer(people[i], 1.6e26);
            usdg.mint(people[i], 1_000_000e6);
            vm.startPrank(people[i]);
            orry.approve(address(vault), type(uint256).max);
            orry.approve(address(vaultU), type(uint256).max);
            usdg.approve(address(vaultU), type(uint256).max);
            orry.approve(address(staking), type(uint256).max);
            orry.approve(address(treasury), type(uint256).max);
            vm.stopPrank();
        }
        agentId = registry.register(dave);
    }

    // ------------------------------------------------------------------ the whole protocol money path, two hubs

    function test_protocol_money_path_end_to_end() public {
        vm.recordLogs();
        uint256 supply0 = orry.totalSupply();

        // LPs in both hubs (the USDG hub shallow at first) and stakers
        _depositBalanced(alice, 30 ether);
        _depositBalanced(bob, 30 ether);
        _depositUsdg(alice, 10_000e6);
        _depositUsdg(bob, 10_000e6);
        vm.prank(bob);
        staking.stake(5_000_000e18);
        vm.prank(carol);
        staking.stake(10_000_000e18);
        vm.prank(dave);
        staking.stakeForAgent(agentId, 2_500_000e18);
        assertEq(staking.totalEarning(), 17_500_000e18, "total earning");

        // trading in both hubs pays LP fees to both vault positions and the 0.15% hook fee as claims
        for (uint256 i; i < 20; ++i) {
            _nextBlock();
            trader.swap(hubKey, i % 2 == 0, -int256(uint256(i % 2 == 0 ? 1 ether : 4_000_000e18)));
            _swapUsdgHub(i % 2 == 0, i % 2 == 0 ? 500e6 : 900_000e18);
        }
        assertGt(_claims(address(hook), address(0)), 0, "hook ETH claims");
        assertGt(_claims(address(hook), address(usdg)), 0, "hook USDG claims");
        assertGt(_claims(address(hook), address(orry)), 0, "hook ORRY claims");

        // collect sends exactly the claims of every currency to the real router (P-4)
        uint256 hookEth = _claims(address(hook), address(0));
        uint256 hookUsdg = _claims(address(hook), address(usdg));
        uint256 hookOrry = _claims(address(hook), address(orry));
        hook.collect();
        assertEq(address(router).balance, hookEth, "router ETH");
        assertEq(usdg.balanceOf(address(router)), hookUsdg, "router USDG");
        assertEq(orry.balanceOf(address(router)), hookOrry, "router ORRY");
        assertEq(
            _claims(address(hook), address(0)) + _claims(address(hook), address(usdg)) + _claims(address(hook), address(orry)),
            0,
            "hook claims left"
        );

        // treasury: coinless revenue, then the coin and the real buyback
        usdg.mint(address(treasury), 100_000e6);
        treasury.sync();
        assertEq(treasury.ownerAccrued(), 10_000e6, "owner 10%");
        assertEq(treasury.buybackReserve(), 90_000e6, "reserve 90%");
        vm.prank(owner);
        treasury.proposeCoin(address(orry), address(buyback));
        _wait(48 hours);
        vm.prank(owner);
        treasury.executeCoin();

        // slice 1, shallow USDG hub: USDG -> ETH on the hookless pool -> ORRY in the ETH hub, ORRY to the router
        _nextBlock();
        assertFalse(buyback.sliceViaUsdgHub(), "shallow USDG hub: the ETH path");
        uint256 routerOrry = orry.balanceOf(address(router));
        uint256 hookOrryBefore = _claims(address(hook), address(orry));
        uint256 maxSlice = buyback.maxSliceUsdg();
        assertGt(maxSlice, 0, "slice size");
        assertLe(maxSlice, 1_000e6, "slice cap (R-18)");
        uint256 reserveBefore = treasury.buybackReserve();
        uint256 bought = buyback.executeSlice();
        assertGt(bought, 0, "slice bought ORRY");
        (uint256 usdgIn, uint256 ethMid,) = _lastSlice();
        assertEq(usdgIn, maxSlice, "slice spent maxSliceUsdg");
        assertGt(ethMid, 0, "ETH path: hop 1 produced ETH");
        assertEq(orry.balanceOf(address(router)), routerOrry + bought, "slice ORRY reaches the router");
        assertEq(treasury.buybackReserve(), reserveBefore - maxSlice, "slice pulled exactly maxSliceUsdg");
        assertGt(_claims(address(hook), address(orry)), hookOrryBefore, "buyback paid the hook fee");
        assertEq(orry.balanceOf(address(buyback)), 0, "buyback holds no ORRY after a slice");

        // the USDG hub deepens; slice 2 takes the direct route through it (R-35: no hop 1)
        _deepenUsdgHub();
        _wait(1 hours);
        _nextBlock();
        assertTrue(buyback.sliceViaUsdgHub(), "deep USDG hub: the direct route");
        routerOrry = orry.balanceOf(address(router));
        uint256 hookUsdgBefore = _claims(address(hook), address(usdg)) + _claims(address(hook), address(orry));
        maxSlice = buyback.maxSliceUsdg();
        bought = buyback.executeSlice();
        assertGt(bought, 0, "direct slice bought ORRY");
        (usdgIn, ethMid,) = _lastSlice();
        assertEq(usdgIn, maxSlice);
        assertEq(ethMid, 0, "direct route: no ETH in the middle");
        assertEq(orry.balanceOf(address(router)), routerOrry + bought, "direct slice ORRY reaches the router");
        assertGt(_claims(address(hook), address(usdg)) + _claims(address(hook), address(orry)), hookUsdgBefore, "USDG hub fee paid");
        assertEq(orry.balanceOf(address(buyback)), 0, "buyback holds no ORRY after a direct slice");

        // distribute: ETH and ORRY split half to staking; ORRY half burned (source 1), ETH half to the buyback; the
        // whole USDG balance goes to the buyback (R-37, P-5)
        hook.collect();
        uint256 rEth = address(router).balance;
        uint256 rUsdg = usdg.balanceOf(address(router));
        uint256 rOrry = orry.balanceOf(address(router));
        uint256 stakingOrry = orry.balanceOf(address(staking));
        uint256 supplyBefore = orry.totalSupply();
        assertGt(rUsdg, 0, "router holds USDG fees");
        vm.expectEmit(true, false, false, true, address(router));
        emit IOrryRewardsRouter.QuoteForwarded(address(usdg), rUsdg);
        router.distribute();
        assertEq(address(router).balance, 0, "router ETH left");
        assertEq(usdg.balanceOf(address(router)), 0, "router USDG left");
        assertEq(orry.balanceOf(address(router)), 0, "router ORRY left");
        assertEq(orry.balanceOf(address(staking)), stakingOrry + rOrry / 2, "stakers ORRY half");
        assertEq(supplyBefore - orry.totalSupply(), rOrry - rOrry / 2, "ORRY half burned");
        assertEq(address(buyback).balance, rEth - rEth / 2, "ETH half to the buyback");
        assertEq(usdg.balanceOf(address(buyback)), rUsdg, "USDG forwarded to the buyback");

        // buyWithQuote: the buyback turns the USDG into ORRY in the USDG hub and sends it to the router
        _nextBlock();
        uint256 quoteCap = buyback.maxQuoteIn(address(usdg));
        uint256 orryAtRouter = orry.balanceOf(address(router));
        uint256 got = buyback.buyWithQuote(address(usdg));
        assertGt(got, 0, "buyWithQuote bought ORRY");
        assertEq(orry.balanceOf(address(router)), orryAtRouter + got, "quote ORRY reaches the router");
        assertEq(usdg.balanceOf(address(buyback)), rUsdg - quoteCap, "buyWithQuote spends up to its cap");
        assertEq(orry.balanceOf(address(buyback)), 0, "buyback holds no ORRY after buyWithQuote");

        // burnEth: the ETH half buys ORRY in the ETH hub and burns it (source 4)
        _wait(1 hours);
        _nextBlock();
        uint256 waiting = address(buyback).balance;
        uint256 cap = buyback.maxBurnEth();
        supplyBefore = orry.totalSupply();
        uint256 burned = buyback.burnEth();
        assertGt(burned, 0, "burnEth burned");
        assertEq(supplyBefore - orry.totalSupply(), burned, "burn equals supply drop");
        assertEq(address(buyback).balance, waiting > cap ? waiting - cap : 0, "burnEth spends up to its cap");

        // the ORRY bought with USDG fees splits like any ORRY at the next distribute (R-37: half stakers, half burned)
        rOrry = orry.balanceOf(address(router));
        stakingOrry = orry.balanceOf(address(staking));
        supplyBefore = orry.totalSupply();
        router.distribute();
        assertEq(orry.balanceOf(address(staking)), stakingOrry + rOrry / 2, "stakers get half of the quote ORRY");
        assertEq(supplyBefore - orry.totalSupply(), rOrry - rOrry / 2, "half of the quote ORRY burned");

        // a week of streams, then one button for everything
        // fees enter a 7 day stream when harvested (spec 3.2), so harvest both vaults first, then let the week run
        vault.harvest();
        vaultU.harvest();
        _wait(7 days);
        IOrryLens.Claimables memory b = lens.claimables(bob);
        (uint256 vEth, uint256 vOrry) = vault.pendingFees(bob);
        (uint256 uUsdg, uint256 uOrry) = vaultU.pendingFees(bob);
        (uint256 sEth, uint256 sOrry) = staking.pendingRewards(bob);
        assertEq(b.earn.length, 2, "lens lists both vaults");
        assertEq(b.earn[0].vault, address(vault));
        assertEq(b.earn[0].feesQuote, vEth, "lens earn ETH");
        assertEq(b.earn[0].feesOrry, vOrry, "lens earn ORRY (ETH hub)");
        assertEq(b.earn[1].vault, address(vaultU));
        assertEq(b.earn[1].quote, address(usdg));
        assertEq(b.earn[1].feesQuote, uUsdg, "lens earn USDG");
        assertEq(b.earn[1].feesOrry, uOrry, "lens earn ORRY (USDG hub)");
        assertEq(b.stakeRewardsEth, sEth, "lens stake ETH");
        assertEq(b.stakeRewardsOrry, sOrry, "lens stake ORRY");
        assertGt(vEth + vOrry, 0, "bob has ETH hub fees");
        assertGt(uUsdg + uOrry, 0, "bob has USDG hub fees");
        assertGt(sEth + sOrry, 0, "bob has stake rewards");
        assertEq(b.stakeActive, 5_000_000e18, "lens stake active");

        uint256 bobEth = bob.balance;
        uint256 bobOrry = orry.balanceOf(bob);
        uint256 bobUsdg = usdg.balanceOf(bob);
        vm.prank(bob);
        IClaimAll.Paid[] memory paid = claimAll.claimAll();
        assertEq(paid.length, 3, "ORRY, ETH, USDG");
        assertEq(paid[0].asset, address(orry));
        assertEq(paid[0].amount, vOrry + uOrry + sOrry, "claimAll ORRY total");
        assertEq(paid[1].asset, address(0));
        assertEq(paid[1].amount, vEth + sEth, "claimAll ETH total");
        assertEq(paid[2].asset, address(usdg));
        assertEq(paid[2].amount, uUsdg, "claimAll USDG total");
        assertEq(bob.balance - bobEth, paid[1].amount, "bob received ETH");
        assertEq(orry.balanceOf(bob) - bobOrry, paid[0].amount, "bob received ORRY");
        assertEq(usdg.balanceOf(bob) - bobUsdg, paid[2].amount, "bob received USDG");
        b = lens.claimables(bob);
        assertEq(
            b.earn[0].feesQuote + b.earn[0].feesOrry + b.earn[1].feesQuote + b.earn[1].feesOrry + b.stakeRewardsEth
                + b.stakeRewardsOrry,
            0,
            "nothing left"
        );

        // LP-only and stake-only addresses: ClaimAll must not fail on the side they do not use
        vm.prank(alice);
        paid = claimAll.claimAll();
        assertGt(paid[0].amount + paid[1].amount + paid[2].amount, 0, "alice Earn fees");
        vm.prank(carol);
        paid = claimAll.claimAll();
        assertGt(paid[0].amount + paid[1].amount, 0, "carol stake rewards");
        assertEq(paid[2].amount, 0, "carol has no USDG hub fees");

        // agent positions read through the lens with the real staking
        uint256[] memory ids = new uint256[](1);
        address[] memory owners = new address[](1);
        ids[0] = agentId;
        owners[0] = dave;
        IOrryLens.AgentClaimable[] memory ac = lens.agentClaimables(dave, ids, owners);
        assertEq(ac.length, 1, "agent rows");
        assertEq(ac[0].active, 2_500_000e18, "agent active");
        assertTrue(ac[0].reportedForAgent, "reported for agent");

        // ORRY checkout through the treasury burns the payment (source 2)
        uint64 expiry = uint64(vm.getBlockTimestamp() + 120);
        bytes32 quoteId = keccak256("integration.quote.1");
        uint256 price = 8_000e18;
        bytes memory sig = _creditsSig(carol, 2, price, quoteId, expiry);
        supplyBefore = orry.totalSupply();
        vm.prank(carol);
        treasury.burnForCredits(2, price, quoteId, expiry, sig);
        assertEq(supplyBefore - orry.totalSupply(), price, "credits burned");

        // G-2 and the burn ledger: supply only falls, by exactly the sum of Burned events of sources 1, 2, 4
        uint256[5] memory bySource;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 2 && logs[i].topics[0] == BURNED) {
                bySource[uint256(logs[i].topics[1])] += abi.decode(logs[i].data, (uint256));
            }
        }
        assertGt(bySource[1], 0, "source 1 burned");
        assertEq(bySource[2], price, "source 2 burned");
        assertEq(bySource[3], 0, "source 3 untouched");
        assertGt(bySource[4], 0, "source 4 burned");
        assertEq(supply0 - orry.totalSupply(), bySource[1] + bySource[2] + bySource[3] + bySource[4], "supply ledger");

        // nothing stuck in pass-through contracts
        assertEq(orry.balanceOf(address(hook)) + address(hook).balance + usdg.balanceOf(address(hook)), 0, "hook holds nothing");
        assertEq(
            orry.balanceOf(address(claimAll)) + address(claimAll).balance + usdg.balanceOf(address(claimAll)),
            0,
            "ClaimAll holds nothing"
        );
        assertEq(orry.balanceOf(address(buyback)), 0, "buyback holds no ORRY");
    }

    // ------------------------------------------------------------------ the shared same-block guard

    /// @notice Negative control: the buyback reads the real hook's start-of-block record of the hub it trades in. A >1%
    /// ETH hub move earlier in the same block refuses a slice on the ETH path; the next block accepts it (R-17: the block
    /// is EVM block.number).
    function test_slice_refused_after_a_hub_move_in_the_same_block() public {
        _depositBalanced(alice, 35 ether);
        _depositUsdg(alice, 10_000e6); // shallow USDG hub: the ETH path
        _setCoinWithRevenue(50_000e6);
        _nextBlock();
        assertFalse(buyback.sliceViaUsdgHub());
        trader.swap(hubKey, true, -int256(3 ether)); // about 3% of the hub's ETH side
        vm.expectRevert(IOrryBuyback.PriceMovedInBlock.selector);
        buyback.executeSlice();
        _nextBlock();
        assertGt(buyback.executeSlice(), 0, "next block slices");
    }

    /// @notice Same control on the direct route: a >1% USDG hub move refuses the direct slice in that block, and a
    /// move in the ETH hub does not (P-3: each hub has its own record).
    function test_direct_slice_refused_after_a_usdg_hub_move_in_the_same_block() public {
        _depositBalanced(alice, 35 ether);
        _depositUsdg(alice, 10_000e6);
        _deepenUsdgHub(); // deep USDG hub: the direct route
        _setCoinWithRevenue(50_000e6);
        _nextBlock();
        assertTrue(buyback.sliceViaUsdgHub());
        uint256 snap = vm.snapshotState();
        trader.swap(hubKey, true, -int256(3 ether)); // ETH hub only: the direct route does not care
        assertGt(buyback.executeSlice(), 0, "an ETH hub move leaves the direct route alone");
        vm.revertToState(snap);
        _swapUsdgHub(true, 9_000e6); // about 3% of the USDG hub's USDG side
        vm.expectRevert(IOrryBuyback.PriceMovedInBlock.selector);
        buyback.executeSlice();
        _nextBlock();
        assertGt(buyback.executeSlice(), 0, "next block slices");
    }

    /// @notice B-1 seam with the real treasury owner: once the sink is set (propose, 48 hours, execute) a slice pays it
    /// exactly 10% of the ORRY bought and the router the rest.
    function test_cashback_sink_takes_its_share_once_set() public {
        _depositBalanced(alice, 35 ether);
        _depositUsdg(alice, 10_000e6);
        _setCoinWithRevenue(50_000e6);
        address sink = makeAddr("cashbackSink");
        vm.prank(owner);
        buyback.proposeCashbackSink(sink);
        assertEq(buyback.cashbackSink(), address(0), "not before the delay");
        _wait(48 hours);
        vm.prank(owner);
        buyback.executeCashbackSink();
        assertEq(buyback.cashbackSink(), sink);
        _nextBlock();
        uint256 routerOrry = orry.balanceOf(address(router));
        uint256 bought = buyback.executeSlice();
        assertGt(bought, 0);
        assertEq(orry.balanceOf(sink), bought * 1000 / 10_000, "sink gets 10%");
        assertEq(orry.balanceOf(address(router)) - routerOrry, bought - bought * 1000 / 10_000, "router gets the rest");
        assertEq(orry.balanceOf(address(buyback)), 0, "buyback holds no ORRY");
    }

    /// @notice The vault's zap and the buyback use the same record: a slice that moved the hub stays inside the 1%
    /// bound, so a zap in the same block still works when the price is near the start of the block.
    function test_zap_after_a_slice_in_the_same_block() public {
        _depositBalanced(alice, 35 ether);
        _depositUsdg(alice, 10_000e6);
        _setCoinWithRevenue(50_000e6);
        _nextBlock();
        buyback.executeSlice();
        vm.prank(bob);
        uint256 shares = vault.zapDeposit{value: 1 ether}(true, 1 ether, 0, 0, 0, type(uint160).max, vm.getBlockTimestamp() + 60);
        assertGt(shares, 0, "zap after a slice");
    }

    // ------------------------------------------------------------------ helpers

    function _depositBalanced(address user, uint256 eth) internal {
        (uint160 p,,,) = PM.getSlot0(hubKey.toId());
        uint256 r = eth * uint256(p) / (1 << 96) * uint256(p) / (1 << 96);
        vm.prank(user);
        vault.deposit{value: eth}(eth, r * 101 / 100, 0, 0, type(uint160).max, vm.getBlockTimestamp() + 60);
    }

    /// @dev ORRY worth `usdgAmount` at the USDG hub's price, whatever the currency order.
    function _orryForUsdg(uint256 usdgAmount) internal view returns (uint256) {
        (uint160 p,,,) = PM.getSlot0(hubKeyU.toId());
        if (hook.pairOf(address(usdg)).orryIsCurrency0) {
            return FullMath.mulDiv(FullMath.mulDiv(usdgAmount, 1 << 96, p), 1 << 96, p);
        }
        return FullMath.mulDiv(FullMath.mulDiv(usdgAmount, p, 1 << 96), p, 1 << 96);
    }

    function _depositUsdg(address user, uint256 usdgAmount) internal {
        uint256 r = _orryForUsdg(usdgAmount);
        vm.prank(user);
        vaultU.deposit(usdgAmount, r * 101 / 100, 0, 0, type(uint160).max, vm.getBlockTimestamp() + 60);
    }

    /// @dev A further LP brings the USDG hub to about 145,000 USDG, so its hop cap passes the ETH path's (the rule for the
    /// direct slice route). ORRY comes from what setUp kept back.
    function _deepenUsdgHub() internal {
        address erin = makeAddr("erin");
        orry.transfer(erin, 2.5e26);
        usdg.mint(erin, 135_000e6);
        vm.startPrank(erin);
        orry.approve(address(vaultU), type(uint256).max);
        usdg.approve(address(vaultU), type(uint256).max);
        vm.stopPrank();
        _depositUsdg(erin, 135_000e6);
    }

    /// @dev Exact-input swap in the USDG hub: `sellUsdg` sells USDG for ORRY, else ORRY for USDG.
    function _swapUsdgHub(bool sellUsdg, uint256 amount) internal {
        bool r0 = hook.pairOf(address(usdg)).orryIsCurrency0;
        trader.swap(hubKeyU, sellUsdg != r0, -int256(amount));
    }

    /// @dev The newest SliceExecuted(usdgIn, ethMid, orryOut) in the recorded logs. Reading drains the recorded logs;
    /// recording goes on, and every Burned event of the main test comes after the last slice.
    function _lastSlice() internal returns (uint256 usdgIn, uint256 ethMid, uint256 orryOut) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; --i) {
            if (logs[i - 1].emitter == address(buyback) && logs[i - 1].topics[0] == IOrryBuyback.SliceExecuted.selector) {
                return abi.decode(logs[i - 1].data, (uint256, uint256, uint256));
            }
        }
        revert("no SliceExecuted");
    }

    function _setCoinWithRevenue(uint256 amount) internal {
        usdg.mint(address(treasury), amount);
        treasury.sync();
        vm.prank(owner);
        treasury.proposeCoin(address(orry), address(buyback));
        _wait(48 hours);
        vm.prank(owner);
        treasury.executeCoin();
    }

    function _creditsSig(address buyer, uint32 packs, uint256 amount, bytes32 quoteId, uint64 expiry)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Orrery Treasury")),
                keccak256(bytes("1")),
                block.chainid,
                address(treasury)
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", domain, keccak256(abi.encode(CREDITS_TYPEHASH, buyer, packs, amount, quoteId, expiry))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _claims(address holder, address currency) internal view returns (uint256) {
        return PM.balanceOf(holder, uint256(uint160(currency)));
    }

    function _wait(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    function _nextBlock() internal {
        vm.roll(vm.getBlockNumber() + 1);
    }
}
