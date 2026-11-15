// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Fork test of lane A against a real Pons V2 launch on Robinhood Chain 4663:
//   heavy forge test --match-path 'test/fork/orry/earn/*' --fork-url https://rpc.mainnet.chain.robinhood.com \
//     --fork-block-number 108947000 -vv
// Skipped on any other chain. Read-only use of Pons: the test plays a launcher and buyers through the public factory
// and curve; no Orrery contract references a Pons address (R-1, G-1).

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {OrreryHook} from "../../../../src/orry/OrreryHook.sol";
import {EarnVault} from "../../../../src/orry/EarnVault.sol";
import {ClaimAll} from "../../../../src/orry/ClaimAll.sol";
import {OrryLens} from "../../../../src/orry/OrryLens.sol";
import {IEarnVault} from "../../../../src/orry/interfaces/IEarnVault.sol";
import {IOrryLens} from "../../../../src/orry/interfaces/IOrryClaims.sol";
import {PoolManagerCode} from "../../../orry/earn/fixtures/PoolManagerCode.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {EarnVaultFactory} from "../../../../src/orry/EarnVaultFactory.sol";
import {IClaimAll} from "../../../../src/orry/interfaces/IOrryClaims.sol";
import {IOrreryHook} from "../../../../src/orry/interfaces/IOrreryHook.sol";
import {
    HubActor,
    MockRouter,
    MockStaking,
    MockRegistry,
    MockTreasury,
    MockToken
} from "../../../orry/earn/mocks/EarnMocks.sol";
import {OracleGhost, OracleCheck} from "../../../orry/earn/OracleGhost.sol";

interface IPonsV2Factory {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase; // 0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);
    function launchFee() external view returns (uint256);
    function graduate(address token) external;
    function createGraduatedPool(address token) external returns (uint256 positionId);
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    function poolManager() external view returns (address);
}

interface IPonsV2Curve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function readyToGraduate() external view returns (bool);
    function sellableTokens() external view returns (uint256);
}

interface IBurnable {
    function burn(uint256 amount) external;
    function burnFrom(address account, uint256 amount) external;
}

contract EarnPonsForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPonsV2Factory internal constant FACTORY = IPonsV2Factory(0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
    IPoolManager internal constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @dev Chainlink ETH/USD proxy on 4663 (from docs/ORRY-R1-SPEC.md; the hook's constructor checks it answers).
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    uint160 internal constant FLAGS = 0x10C4;
    int24 internal constant LOWER = -887200;
    int24 internal constant UPPER = 887200;
    bytes32 internal constant POOL_GRADUATED_TOPIC = keccak256("PoolGraduated(address,uint256,uint256,uint256)");
    bytes32 internal constant INITIALIZE_TOPIC =
        keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    address internal token;
    address internal curve;
    PoolKey internal ponsKey;
    uint160 internal ponsSqrtPrice;

    MockRouter internal router;
    MockTreasury internal treasury;
    OrreryHook internal hook;
    EarnVaultFactory internal factory;
    EarnVault internal vault; // ETH hub
    EarnVault internal vaultU; // USDG hub
    PoolKey internal keyU;
    PoolId internal hubIdU;
    PoolKey internal poolAKey; // the deepest ETH/USDG pool, for prices and USDG
    MockStaking internal staking;
    ClaimAll internal claimAll;
    OrryLens internal lens;
    HubActor internal trader;
    PoolKey internal key;
    PoolId internal hubId;
    uint256 internal hookSalt;
    uint256 internal hubInitTs;

    function setUp() public {
        if (block.chainid != 4663) {
            vm.skip(true);
            return;
        }
        assertEq(keccak256(address(PM).code), keccak256(PoolManagerCode.RUNTIME), "unit-test fixture == live code");
        assertEq(FACTORY.poolManager(), address(PM));
        _launchAndGraduate();
        _deployHub();
    }

    // ---------------------------------------------------------------- setup helpers

    function _launchAndGraduate() internal {
        vm.deal(owner, 10 ether);
        IPonsV2Factory.TokenParams memory p;
        p.name = "Orrery";
        p.symbol = "ORRY";
        p.description = "fork test";
        p.creatorFeeRecipient = owner; // R-1: Pons creator fees go to the owner's wallet, never to Orrery
        p.salt = keccak256("orrery fork test");
        uint256 fee = FACTORY.launchFee();
        assertEq(fee, 0.0005 ether, "launch fee");
        vm.prank(owner);
        (token, curve) = FACTORY.launchToken{value: fee}(p, 0, address(0));
        assertEq(IERC20(token).totalSupply(), 1e27);

        vm.warp(block.timestamp + 10); // past the 3 s snipe tax window
        vm.recordLogs(); // the crossing buy may graduate the launch by itself
        address[5] memory buyers = [alice, bob, carol, makeAddr("dave"), makeAddr("erin")];
        uint256 bought;
        for (uint256 i; i < 40 && !IPonsV2Curve(curve).readyToGraduate(); ++i) {
            address b = buyers[i % 5];
            vm.deal(b, b.balance + 1 ether);
            vm.prank(b);
            try IPonsV2Curve(curve).buy{value: 0.5 ether}(0.5 ether, 0, b) {
                bought += 0.5 ether;
            } catch {
                break;
            }
        }
        console2.log("ETH offered on the curve until graduation", bought);
        assertTrue(IPonsV2Curve(curve).readyToGraduate() || FACTORY.getLaunchedToken(token).phase != 0, "graduated");

        if (FACTORY.getLaunchedToken(token).phase == 0) FACTORY.graduate(token);
        if (FACTORY.getLaunchedToken(token).phase == 1) FACTORY.createGraduatedPool(token);
        IPonsV2Factory.LaunchedToken memory lt = FACTORY.getLaunchedToken(token);
        assertEq(lt.phase, 2, "Pons pool created");
        assertEq(lt.creatorFeeRecipient, owner);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seededEth;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(FACTORY) && logs[i].topics[0] == POOL_GRADUATED_TOPIC) {
                (,, seededEth) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
            if (logs[i].emitter == address(PM) && logs[i].topics[0] == INITIALIZE_TOPIC) {
                (uint24 f, int24 ts, address h, uint160 sp,) =
                    abi.decode(logs[i].data, (uint24, int24, address, uint160, int24));
                ponsKey = PoolKey(
                    Currency.wrap(address(uint160(uint256(logs[i].topics[2])))),
                    Currency.wrap(address(uint160(uint256(logs[i].topics[3])))),
                    f,
                    ts,
                    IHooks(h)
                );
                ponsSqrtPrice = sp;
            }
        }
        assertEq(Currency.unwrap(ponsKey.currency1), token, "Pons pool found");
        console2.log("ETH seeded into the Pons pool at graduation", seededEth);
        assertApproxEqRel(seededEth, 4.2 ether, 0.01e18, "graduated at about 4.2 ETH");
        assertGt(PM.getLiquidity(ponsKey.toId()), 0);
        (ponsSqrtPrice,,,) = PM.getSlot0(ponsKey.toId());
    }

    function _mineAndDeployHook(address router_) internal returns (OrreryHook h) {
        bytes memory init = abi.encodePacked(
            type(OrreryHook).creationCode,
            abi.encode(
                address(PM), token, router_, address(treasury), uint24(8500), uint24(1500), int24(200), USDG, ETH_USD_FEED
            )
        );
        bytes32 initHash = keccak256(init);
        uint256 salt = hookSalt;
        address predicted;
        for (;; ++salt) {
            predicted = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, bytes32(salt), initHash))))
            );
            if (uint160(predicted) & 0x3FFF == FLAGS && predicted.code.length == 0) break;
        }
        hookSalt = salt + 1;
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(bytes32(salt), init));
        assertTrue(ok, "CREATE2 deploy");
        assertEq(address(bytes20(ret)), predicted);
        h = OrreryHook(predicted);
    }

    function _deployHub() internal {
        router = new MockRouter();
        treasury = new MockTreasury(owner);
        hook = _mineAndDeployHook(address(router));
        factory = new EarnVaultFactory(address(hook));
        vault = EarnVault(payable(factory.createVault(address(0))));
        vaultU = EarnVault(payable(factory.createVault(USDG)));
        staking = new MockStaking(IERC20(token), address(new MockRegistry()));
        claimAll = new ClaimAll(address(factory), address(staking));
        lens = new OrryLens(address(factory), address(staking));
        trader = new HubActor(PM);
        key = hook.hubKey(address(0));
        hubId = key.toId();
        PM.initialize(key, ponsSqrtPrice); // the ETH hub opens at the Pons pool's price
        hubInitTs = vm.getBlockTimestamp();
        assertTrue(hook.pairOf(address(0)).initialized);
        assertTrue(PoolId.unwrap(hubId) != PoolId.unwrap(ponsKey.toId()), "separate pool");

        // the USDG hub opens at the Pons price times the deepest ETH/USDG pool's price
        poolAKey = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 500, 10, IHooks(address(0)));
        keyU = hook.hubKey(USDG);
        hubIdU = keyU.toId();
        PM.initialize(keyU, _usdgHubOpeningPrice());
        assertTrue(hook.pairOf(USDG).initialized);

        address[3] memory users = [alice, bob, carol];
        HubActor buyer = new HubActor(PM);
        vm.deal(address(buyer), 40 ether);
        buyer.swap(poolAKey, true, -30 ether); // real USDG from the real pool
        uint256 usdgEach = IERC20(USDG).balanceOf(address(buyer)) / 4;
        for (uint256 i; i < 3; ++i) {
            vm.deal(users[i], 100 ether);
            vm.startPrank(users[i]);
            IERC20(token).approve(address(vault), type(uint256).max);
            IERC20(token).approve(address(vaultU), type(uint256).max);
            IERC20(USDG).approve(address(vaultU), type(uint256).max);
            vm.stopPrank();
            vm.prank(address(buyer));
            IERC20(USDG).transfer(users[i], usdgEach);
        }
        vm.prank(address(buyer));
        IERC20(USDG).transfer(address(trader), usdgEach);
        vm.deal(address(trader), 100 ether);
        _give(address(trader), IERC20(token).balanceOf(carol) / 2, carol);
    }

    /// @dev ORRY per USDG = (ORRY per ETH in the Pons pool) / (USDG per ETH in pool A), in the hub's orientation.
    function _usdgHubOpeningPrice() internal view returns (uint160) {
        (uint160 sqrtA,,,) = PM.getSlot0(poolAKey.toId());
        bool r0 = hook.pairOf(USDG).orryIsCurrency0;
        // pool prices are currency1 per currency0: Pons = token per ETH, A = USDG per ETH
        return r0
            ? uint160(FullMath.mulDiv(sqrtA, 1 << 96, ponsSqrtPrice)) // USDG per token
            : uint160(FullMath.mulDiv(ponsSqrtPrice, 1 << 96, sqrtA)); // token per USDG
    }

    /// @dev ORRY worth `usdgAmount` at the USDG hub's price.
    function _orryForUsdg(uint256 usdgAmount) internal view returns (uint256) {
        (uint160 p,,,) = PM.getSlot0(hubIdU);
        if (hook.pairOf(USDG).orryIsCurrency0) {
            return FullMath.mulDiv(FullMath.mulDiv(usdgAmount, 1 << 96, p), 1 << 96, p);
        }
        return FullMath.mulDiv(FullMath.mulDiv(usdgAmount, p, 1 << 96), p, 1 << 96);
    }

    function _depositU(address user, uint256 usdgAmount) internal returns (uint256 shares) {
        uint256 rc = _orryForUsdg(usdgAmount) * 102 / 100;
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(user);
        shares = vaultU.deposit(usdgAmount, rc, 0, 0, type(uint160).max, ts);
    }

    /// @dev Exact-input swap in the USDG hub.
    function _swapU(bool sellUsdg, uint256 amount) internal returns (BalanceDelta) {
        bool r0 = hook.pairOf(USDG).orryIsCurrency0;
        return trader.swap(keyU, sellUsdg != r0, -int256(amount));
    }

    function _give(address to, uint256 amount, address from) internal {
        vm.prank(from);
        IERC20(token).transfer(to, amount);
    }

    function _orryFor(uint256 eth) internal view returns (uint256) {
        (uint160 p,,,) = PM.getSlot0(hubId);
        return eth * uint256(p) / (1 << 96) * uint256(p) / (1 << 96);
    }

    function _positionLiquidity(address v) internal view returns (uint128 liq) {
        (liq,,) = PM.getPositionInfo(hubId, v, LOWER, UPPER, bytes32(0));
    }

    function _deposit(address user, uint256 eth) internal returns (uint256 shares) {
        uint256 rc = _orryFor(eth) * 102 / 100;
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(user);
        shares = vault.deposit{value: eth}(eth, rc, 0, 0, type(uint160).max, ts);
    }

    function _wait(uint256 s) internal {
        vm.warp(vm.getBlockTimestamp() + s);
        vm.roll(vm.getBlockNumber() + 1);
    }

    // ---------------------------------------------------------------- Pons facts

    function test_fork_pons_token_facts() public {
        IERC20 t = IERC20(token);
        uint256 supply = t.totalSupply();
        uint256 aliceBal = t.balanceOf(alice);
        assertGt(aliceBal, 1e18);

        vm.prank(alice);
        IBurnable(token).burn(1e18);
        assertEq(t.totalSupply(), supply - 1e18, "burn lowers the supply");

        vm.prank(alice);
        t.approve(bob, 2e18);
        vm.prank(bob);
        IBurnable(token).burnFrom(alice, 2e18);
        assertEq(t.totalSupply(), supply - 3e18, "burnFrom lowers the supply");
        assertEq(t.allowance(alice, bob), 0);

        vm.prank(alice);
        t.transfer(makeAddr("fresh"), 5e18);
        assertEq(t.balanceOf(makeAddr("fresh")), 5e18, "plain transfer, no tax");
        assertEq(t.balanceOf(alice), aliceBal - 3e18 - 5e18);
    }

    // ---------------------------------------------------------------- hub next to the Pons pool

    function test_fork_hub_beside_pons_pool() public {
        _deposit(alice, 2 ether);
        // a swap in the Pons pool never touches the Orrery hook
        vm.deal(address(this), 1 ether);
        HubActor ponsTrader = new HubActor(PM);
        vm.deal(address(ponsTrader), 1 ether);
        ponsTrader.swap(ponsKey, true, -0.1 ether);
        assertEq(hook.pendingProtocolFee(address(0)) + hook.pendingProtocolFee(token), 0, "Pons swap pays nothing to Orrery");
        assertEq(address(router).balance, 0);
        (address qq, bool known) = hook.quoteOfPool(ponsKey.toId());
        assertFalse(known, "the Pons pool is no hub");
        assertEq(qq, address(0));

        // a hub swap pays the hook its 0.15%
        trader.swap(key, true, -0.1 ether);
        assertGt(hook.pendingProtocolFee(token), 0);
        (uint160 hubP,,,) = PM.getSlot0(hubId);
        console2.log("hub sqrtPrice / Pons sqrtPrice", hubP, ponsSqrtPrice);
    }

    // ---------------------------------------------------------------- full Earn cycle

    function test_fork_earn_full_cycle() public {
        uint256 sa = _deposit(alice, 2 ether);
        uint256 sb = _deposit(bob, 1 ether);
        vm.prank(carol);
        uint256 sc = vault.zapDeposit{value: 0.4 ether}(true, 0.4 ether, 1, 1, 0, type(uint160).max, vm.getBlockTimestamp());
        _wait(1);
        uint256 zapR = _orryFor(0.2 ether);
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(bob);
        uint256 sb2 = vault.zapDeposit(false, zapR, 1, 1, 0, type(uint160).max, ts);
        assertGt(sc, 0);
        assertGt(sb2, 0);
        assertEq(_positionLiquidity(address(vault)), vault.totalShares());

        for (uint256 i; i < 10; ++i) {
            trader.swap(key, true, -0.05 ether);
            trader.swap(key, false, -int256(_orryFor(0.05 ether)));
            _wait(30);
        }
        (uint256 f0, uint256 f1) = vault.harvest();
        assertGt(f0, 0);
        assertGt(f1, 0);
        _wait(7 days);

        (uint256 a0, uint256 a1) = vault.pendingFees(alice);
        IOrryLens.Claimables memory c = lens.claimables(alice);
        assertEq(c.earn.length, 2, "ETH and USDG vaults");
        assertEq(c.earn[0].feesQuote, a0);
        assertEq(c.earn[0].shares, sa);
        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        IClaimAll.Paid[] memory paid = claimAll.claimAll();
        assertEq(paid.length, 3);
        assertEq(paid[0].asset, token);
        assertEq(paid[0].amount, a1);
        assertEq(paid[1].asset, address(0));
        assertEq(paid[1].amount, a0);
        assertEq(paid[2].asset, USDG);
        assertEq(paid[2].amount, 0);
        assertEq(alice.balance - ethBefore, a0);

        ts = vm.getBlockTimestamp();
        vm.prank(bob);
        (uint256 we, uint256 wr) = vault.withdraw(sb + sb2, 0, 0, ts);
        assertGt(we, 0);
        assertGt(wr, 0);
        vm.prank(alice);
        vault.withdraw(sa, 0, 0, ts);
        vm.prank(carol);
        vault.withdraw(sc, 0, 0, ts);
        assertEq(vault.totalShares(), 0);
        assertEq(_positionLiquidity(address(vault)), 0);

        uint256 pe = hook.pendingProtocolFee(address(0));
        uint256 pr = hook.pendingProtocolFee(token);
        hook.collect();
        assertEq(address(router).balance, pe, "router holds only hub protocol fees");
        assertEq(IERC20(token).balanceOf(address(router)), pr);
        console2.log("hub fees to LPs ETH / ORRY", f0, f1);
        console2.log("protocol fees to router ETH / ORRY", pe, pr);
    }

    // ---------------------------------------------------------------- JIT

    /// @dev JIT against the vault: a big deposit just before a big swap cannot leave for 15 minutes and earns only
    /// its streamed share; a JIT range position in the pool takes LP fees of that swap but cannot touch the vault's
    /// principal or its harvested fees.
    function test_fork_jit_against_the_vault() public {
        _deposit(alice, 2 ether);
        trader.swap(key, true, -0.05 ether);
        trader.swap(key, false, -int256(_orryFor(0.05 ether)));
        vault.harvest();

        // (a) JIT through the vault: a deposit larger than the vault, right before a big swap
        uint256 sj = _deposit(bob, 3 ether);
        trader.swap(key, true, -0.5 ether);
        uint256 ts = vm.getBlockTimestamp();
        uint64 unlock = vault.unlockAt(bob); // read before the prank, which the next call consumes
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IEarnVault.SharesLocked.selector, unlock));
        vault.withdraw(sj, 0, 0, ts);
        vault.harvest();
        _wait(15 minutes);
        (uint256 b0, uint256 b1) = vault.pendingFees(bob);
        ts = vm.getBlockTimestamp();
        vm.prank(bob);
        vault.withdraw(sj, 0, 0, ts);
        console2.log("JIT depositor fees after 15 min, ETH / ORRY", b0, b1);
        // the swaps paid under 0.01 ETH of LP fee in ETH; 15 minutes of a 7 day stream is 0.15% of it
        assertLt(b0, uint256(0.01 ether) * 15 minutes / 7 days);

        // (b) JIT range position in the pool around a big swap
        HubActor jit = new HubActor(PM);
        vm.deal(address(jit), 50 ether);
        _give(address(jit), IERC20(token).balanceOf(alice) / 2, alice);
        (, int24 tick,,) = PM.getSlot0(hubId);
        int24 lo = (tick / 200) * 200 - 200;
        int24 hi = lo + 400;
        uint256 liqBefore = _positionLiquidity(address(vault));
        uint256 vaultEth = address(vault).balance;
        jit.modify(key, lo, hi, 1e22, bytes32(0));
        trader.swap(key, true, -0.5 ether);
        BalanceDelta out = jit.modify(key, lo, hi, -1e22, bytes32(0));
        console2.log("JIT range position out ETH / ORRY");
        console2.logInt(out.amount0());
        console2.logInt(out.amount1());
        assertEq(_positionLiquidity(address(vault)), liqBefore, "vault position untouched");
        assertEq(address(vault).balance, vaultEth, "vault balances untouched");
        assertEq(_positionLiquidity(address(vault)), vault.totalShares());

        // vault users exit normally afterwards
        _wait(1 days);
        uint256 sa = vault.sharesOf(alice);
        ts = vm.getBlockTimestamp();
        vm.prank(alice);
        vault.withdraw(sa, 0, 0, ts);
    }

    // ---------------------------------------------------------------- sandwich at the real fee

    function test_fork_sandwich_at_real_fee() public {
        _deposit(alice, 3 ether);
        _wait(1);
        HubActor attacker = new HubActor(PM);
        vm.deal(address(attacker), 10 ether);

        // front-run moves the price more than 1% inside the block: the victim's zap is refused
        attacker.swap(key, true, -0.1 ether);
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(bob);
        vm.expectRevert(IEarnVault.PriceMovedInBlock.selector);
        vault.zapDeposit{value: 0.5 ether}(true, 0.5 ether, 0, 0, 0, type(uint160).max, ts);

        // a victim zap with its own minSwapOut (99.5% of its quote) is refused even below the guard
        _wait(1);
        uint256 snap = vm.snapshotState();
        BalanceDelta q = trader.swap(key, true, -0.25 ether); // the zap swaps half of 0.5 ETH
        vm.revertToState(snap);
        uint256 minOut = uint256(int256(q.amount1())) * 995 / 1000;
        attacker.swap(key, true, -0.01 ether); // under 1%
        ts = vm.getBlockTimestamp();
        vm.prank(bob);
        vm.expectRevert(IEarnVault.SlippageExceeded.selector);
        vault.zapDeposit{value: 0.5 ether}(true, 0.5 ether, minOut, 0, 0, type(uint160).max, ts);

        // plain swap sandwich economics at the 1% hub fee (0.85% LP + 0.15% hook): the victim's price impact must
        // beat the attacker's 2% round trip, so a victim below about 1% of the hub's ETH side is not worth it
        _wait(1);
        (uint256 hubEth,) = vault.positionAmounts();
        uint256 victim = hubEth / 200; // 0.5% of the hub's ETH side
        uint256 start = address(attacker).balance;
        BalanceDelta front = attacker.swap(key, true, -0.2 ether);
        trader.swap(key, true, -int256(victim));
        attacker.swap(key, false, -int256(uint256(int256(front.amount1()))));
        int256 pnl = int256(address(attacker).balance) - int256(start);
        console2.log("attacker PnL in wei (negative = loss)");
        console2.logInt(pnl);
        assertLt(pnl, 0, "a retail-size sandwich loses money at the real fee");
    }

    // ---------------------------------------------------------------- front-run of the hub initialisation

    function _freshStack() internal returns (OrreryHook h, EarnVault v, PoolKey memory k) {
        h = _mineAndDeployHook(address(router));
        v = new EarnVault(address(h), address(0));
        k = h.hubKey(address(0));
        vm.prank(alice);
        IERC20(token).approve(address(v), type(uint256).max);
    }

    function test_fork_frontrun_hub_init_without_liquidity() public {
        (OrreryHook h, EarnVault v, PoolKey memory k) = _freshStack();
        // attacker opens the hub first at 9x the Pons price
        vm.prank(makeAddr("attacker"));
        PM.initialize(k, ponsSqrtPrice * 3);
        assertTrue(h.pairOf(address(0)).initialized);

        // nothing is lost: with no liquidity, a swap with a price limit moves the price back for free
        trader.swapTo(k, true, -1, ponsSqrtPrice);
        (uint160 p,,,) = PM.getSlot0(k.toId());
        assertEq(p, ponsSqrtPrice, "price restored at no cost");
        assertEq(h.pendingProtocolFee(address(0)) + h.pendingProtocolFee(token), 0);

        uint256 rc = uint256(ponsSqrtPrice) * uint256(ponsSqrtPrice) / (1 << 96) * 1 ether / (1 << 96);
        uint128 expected = LiquidityAmounts.getLiquidityForAmounts(
            ponsSqrtPrice, TickMath.getSqrtPriceAtTick(LOWER), TickMath.getSqrtPriceAtTick(UPPER), 1 ether, rc * 2
        );
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(alice);
        uint256 shares = v.deposit{value: 1 ether}(1 ether, rc * 2, expected, 0, type(uint160).max, ts);
        assertEq(shares, expected);
    }

    function test_fork_frontrun_hub_init_with_liquidity() public {
        (, EarnVault v, PoolKey memory k) = _freshStack();
        HubActor attacker = new HubActor(PM);
        vm.deal(address(attacker), 10 ether);
        _give(address(attacker), IERC20(token).balanceOf(bob) / 2, bob);
        vm.prank(makeAddr("attacker"));
        PM.initialize(k, ponsSqrtPrice * 3);
        attacker.modify(k, LOWER, UPPER, 1e20, bytes32(0)); // attacker's own liquidity at the hostile price

        // a depositor who set minShares from the Pons price is protected: fewer shares means a revert
        uint256 rc = uint256(ponsSqrtPrice) * uint256(ponsSqrtPrice) / (1 << 96) * 1 ether / (1 << 96);
        uint128 expected = LiquidityAmounts.getLiquidityForAmounts(
            ponsSqrtPrice, TickMath.getSqrtPriceAtTick(LOWER), TickMath.getSqrtPriceAtTick(UPPER), 1 ether, rc
        );
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(alice);
        vm.expectRevert(IEarnVault.SlippageExceeded.selector);
        v.deposit{value: 1 ether}(1 ether, rc, uint256(expected) * 99 / 100, 0, type(uint160).max, ts);

        // arbitrage brings the price back; the attacker's liquidity pays for it
        trader.swapTo(k, true, -10 ether, ponsSqrtPrice);
        (uint160 p,,,) = PM.getSlot0(k.toId());
        assertApproxEqRel(uint256(p), uint256(ponsSqrtPrice), 0.0001e18, "price back at the Pons level");
        vm.prank(alice);
        uint256 shares = v.deposit{value: 1 ether}(1 ether, rc, uint256(expected) * 99 / 100, 0, type(uint160).max, ts);
        assertGe(shares, uint256(expected) * 99 / 100);
    }

    // ---------------------------------------------------------------- time-weighted price (R-28), both hubs

    /// @dev H-5 to H-7 per hub and P-3 on the live PoolManager: 35 minutes of trading in both hubs beside the Pons
    /// pool (gaps of 0 to 60 s, several swaps in one second, new blocks, Pons pool swaps in between), each hub checked
    /// against its own one-second ghost after every step; consult answers a 30 minute window in both at the end.
    function test_fork_oracle_35_minute_run_both_hubs() public {
        _deposit(alice, 1 ether);
        _deposit(bob, 0.5 ether);
        _depositU(carol, IERC20(USDG).balanceOf(carol) / 8);
        OracleGhost ge = new OracleGhost(PM, hubId, address(0), hubInitTs);
        OracleGhost gu = new OracleGhost(PM, hubIdU, USDG, hubInitTs);
        HubActor ponsTrader = new HubActor(PM);
        vm.deal(address(ponsTrader), 5 ether);
        uint256 end = hubInitTs + 35 minutes;
        uint256 seed = uint256(keccak256("orrery fork oracle, two hubs"));
        uint256 steps;
        uint256[2] memory swaps;
        while (vm.getBlockTimestamp() < end) {
            seed = uint256(keccak256(abi.encode(seed, steps)));
            uint256 gap = seed % 5 == 0 ? 0 : (seed >> 8) % 61;
            vm.warp(vm.getBlockTimestamp() + gap);
            if (gap != 0 || (seed >> 16) % 3 == 0) vm.roll(vm.getBlockNumber() + 1);
            ge.before();
            gu.before();
            uint256 eth = 0.001 ether + (seed >> 24) % 0.2 ether;
            uint256 which = (seed >> 64) % 9;
            bool inEth;
            bool inUsdg;
            if (which == 0) {
                ponsTrader.swap(ponsKey, true, -int256(eth / 10)); // the Pons pool never feeds a hub oracle
            } else if (which < 5) {
                bool zeroForOne = (seed >> 72) % 2 == 0;
                trader.swap(key, zeroForOne, -int256(zeroForOne ? eth : _orryFor(eth)));
                inEth = true;
                ++swaps[0];
            } else {
                bool sellUsdg = (seed >> 72) % 2 == 0;
                uint256 usdgAmt = eth * 1000 / 1e12; // half the ETH side's size, in USDG (6 decimals)
                _swapU(sellUsdg, sellUsdg ? usdgAmt : _orryForUsdg(usdgAmt));
                inUsdg = true;
                ++swaps[1];
            }
            ge.afterAction(inEth);
            gu.afterAction(inUsdg);
            assertEq(OracleCheck.verify(ge, hook), "", "ETH hub");
            assertEq(OracleCheck.verify(gu, hook), "", "USDG hub");
            ++steps;
        }
        OracleGhost[2] memory gs = [ge, gu];
        address[2] memory qs = [address(0), USDG];
        console2.log("steps / ETH hub swaps / USDG hub swaps", steps, swaps[0], swaps[1]);
        for (uint256 i; i < 2; ++i) {
            (int24 mean30, uint32 actual30) = hook.consult(qs[i], 30 minutes);
            (uint8 st, int256 gMean, uint256 gActual) = gs[i].expectConsult(30 minutes);
            assertEq(st, 0, "30 minute window answers");
            assertEq(int256(mean30), gMean);
            assertEq(uint256(actual30), gActual);
            (, uint16 count) = hook.observationIndex(qs[i]);
            (, int24 spot,,) = PM.getSlot0(hook.pairOf(qs[i]).poolId);
            console2.log(i == 0 ? "ETH hub: checkpoints / updates" : "USDG hub: checkpoints / updates", count, gs[i].updates());
            console2.log("  spot tick", int256(spot));
            console2.log("  30 min mean tick", int256(mean30));
            console2.log("  over seconds", uint256(actual30));
            assertGt(count, 15, "checkpoints about every minute");
        }
    }

    // ---------------------------------------------------------------- the USDG hub (R-35)

    /// @dev Earn on the USDG hub with the real USDG token: deposits and both zaps, swaps both ways, harvest, ClaimAll
    /// paying ORRY, ETH and USDG, withdrawals, collect paying the router exactly in USDG and ORRY; swaps in the USDG
    /// hub leave the ETH hub's record, observations and price alone (P-3).
    function test_fork_usdg_hub_full_cycle() public {
        _deposit(alice, 0.5 ether);
        uint256 usdgA = IERC20(USDG).balanceOf(alice) / 8;
        uint256 sa = _depositU(alice, usdgA);
        uint256 sb = _depositU(bob, usdgA / 2);
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(carol);
        uint256 sc = vaultU.zapDeposit(true, usdgA / 5, 1, 1, 0, type(uint160).max, ts);
        _wait(1);
        uint256 zapR = _orryForUsdg(usdgA / 10);
        ts = vm.getBlockTimestamp();
        vm.prank(bob);
        uint256 sb2 = vaultU.zapDeposit(false, zapR, 1, 1, 0, type(uint160).max, ts);
        assertGt(sc, 0);
        assertGt(sb2, 0);
        assertEq(_positionLiquidityU(), vaultU.totalShares());

        bytes32 ethHub = _hubState(address(0));
        for (uint256 i; i < 10; ++i) {
            _swapU(true, usdgA / 20);
            _swapU(false, _orryForUsdg(usdgA / 20));
            assertEq(_hubState(address(0)), ethHub, "USDG swaps never move the ETH hub");
        }
        (uint256 f0, uint256 f1) = vaultU.harvest();
        assertGt(f0, 0);
        assertGt(f1, 0);
        _wait(7 days);

        (uint256 a0, uint256 a1) = vaultU.pendingFees(alice);
        (uint256 e0, uint256 e1) = vault.pendingFees(alice);
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        vm.prank(alice);
        IClaimAll.Paid[] memory paid = claimAll.claimAll();
        assertEq(paid.length, 3);
        assertEq(paid[0].asset, token);
        assertEq(paid[0].amount, a1 + e1);
        assertEq(paid[1].asset, address(0));
        assertEq(paid[1].amount, e0);
        assertEq(paid[2].asset, USDG);
        assertEq(paid[2].amount, a0);
        assertEq(IERC20(USDG).balanceOf(alice) - usdgBefore, a0, "real USDG paid");

        ts = vm.getBlockTimestamp();
        vm.prank(bob);
        (uint256 wq, uint256 wr) = vaultU.withdraw(sb + sb2, 0, 0, ts);
        assertGt(wq, 0);
        assertGt(wr, 0);
        vm.prank(alice);
        vaultU.withdraw(sa, 0, 0, ts);
        vm.prank(carol);
        vaultU.withdraw(sc, 0, 0, ts);
        assertEq(vaultU.totalShares(), 0);
        assertEq(_positionLiquidityU(), 0);

        uint256 pu = hook.pendingProtocolFee(USDG);
        uint256 pr = hook.pendingProtocolFee(token);
        assertGt(pu, 0);
        uint256 ru = IERC20(USDG).balanceOf(address(router));
        uint256 rr = IERC20(token).balanceOf(address(router));
        hook.collect();
        assertEq(IERC20(USDG).balanceOf(address(router)) - ru, pu, "router gets exactly the USDG claims");
        assertEq(IERC20(token).balanceOf(address(router)) - rr, pr);
        assertEq(IERC20(USDG).balanceOf(address(hook)), 0);
        console2.log("USDG hub fees to LPs USDG / ORRY", f0, f1);
        console2.log("protocol fees to router USDG / ORRY", pu, pr);
    }

    function _positionLiquidityU() internal view returns (uint128 liq) {
        (liq,,) = PM.getPositionInfo(hubIdU, address(vaultU), LOWER, UPPER, bytes32(0));
    }

    function _hubState(address q) internal view returns (bytes32) {
        (uint160 sp, uint64 bn) = hook.startOfBlockSqrtPriceX96(q);
        (uint32 ts, int56 cum, int24 t) = hook.latestObservation(q);
        (uint16 newest, uint16 count) = hook.observationIndex(q);
        (uint160 live,,,) = PM.getSlot0(hook.pairOf(q).poolId);
        return keccak256(abi.encode(sp, bn, ts, cum, t, newest, count, live));
    }

    /// @dev B-2 and E-7 with the real Pons token: ORRY notified into both vaults streams to their holders over the
    /// period and to nobody else; principal previews do not move.
    function test_fork_notify_rewards_into_both_vaults() public {
        uint256 se = _deposit(alice, 0.5 ether);
        uint256 su = _depositU(alice, IERC20(USDG).balanceOf(alice) / 8);
        (uint256 pe0, uint256 pe1) = vault.previewWithdraw(se);
        (uint256 pu0, uint256 pu1) = vaultU.previewWithdraw(su);
        uint256 amount = IERC20(token).balanceOf(bob) / 4;
        vm.startPrank(bob);
        IERC20(token).approve(address(vault), amount);
        IERC20(token).approve(address(vaultU), amount);
        vault.notifyRewards(amount);
        vaultU.notifyRewards(amount);
        vm.stopPrank();
        _wait(7 days);
        (uint256 e0, uint256 e1) = vault.pendingFees(alice);
        (uint256 u0, uint256 u1) = vaultU.pendingFees(alice);
        assertEq(e0 + u0, 0, "quote streams untouched");
        assertApproxEqAbs(e1, amount, 10, "the only ETH-vault holder gets it all");
        assertApproxEqAbs(u1, amount, 10, "the only USDG-vault holder gets it all");
        (uint256 b0, uint256 b1) = vault.pendingFees(bob);
        assertEq(b0 + b1, 0, "the payer gets nothing");
        (uint256 pe0b, uint256 pe1b) = vault.previewWithdraw(se);
        (uint256 pu0b, uint256 pu1b) = vaultU.previewWithdraw(su);
        assertEq(pe0b, pe0);
        assertEq(pe1b, pe1);
        assertEq(pu0b, pu0);
        assertEq(pu1b, pu1);
        uint256 r = IERC20(token).balanceOf(alice);
        vm.prank(alice);
        claimAll.claimAll();
        assertEq(IERC20(token).balanceOf(alice) - r, e1 + u1, "ClaimAll pays both");
        console2.log("notified per vault / paid to the holder (ORRY wei)", amount, e1 + u1);
    }

    /// @dev The real ETH/USD aggregator answers at the fork block, the hook accepted it at construction, and a pair
    /// proposed with it cannot be executed once the feed's last update is older than FEED_MAX_AGE (no new round on a
    /// fork after a 48 hour warp).
    function test_fork_real_feed_and_pair_admin() public {
        (, int256 answer,, uint256 updatedAt,) = IUsdFeedView(ETH_USD_FEED).latestRoundData();
        console2.log("ETH/USD answer (8 decimals)", uint256(answer));
        console2.log("feed age at the fork block (s)", vm.getBlockTimestamp() - updatedAt);
        assertGt(answer, 0);
        assertLe(vm.getBlockTimestamp() - updatedAt, 25 hours);
        assertEq(hook.pairOf(address(0)).usdFeed, ETH_USD_FEED);
        assertEq(hook.pairAdmin(), owner);

        MockToken t = new MockToken("TKN", 18);
        vm.prank(owner);
        hook.proposePair(address(t), ETH_USD_FEED);
        (, uint64 at) = hook.pendingPair(address(t));
        vm.warp(at);
        vm.prank(owner);
        vm.expectRevert(IOrreryHook.FeedNotAnswering.selector);
        hook.executePair(address(t));
        assertEq(hook.pairCount(), 2);
    }
}

interface IUsdFeedView {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}
