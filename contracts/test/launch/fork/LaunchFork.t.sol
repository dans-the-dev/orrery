// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC6909Claims} from "v4-core/src/interfaces/external/IERC6909Claims.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
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
import {EarnVault} from "../../../src/orry/EarnVault.sol";
import {IOrryToken} from "../../../src/orry/interfaces/IOrryToken.sol";
import {OrryPriceOracle} from "../../../src/markets/OrryPriceOracle.sol";
import {AgentLaunch} from "../../../src/launch/AgentLaunch.sol";
import {AgentCoin} from "../../../src/launch/AgentCoin.sol";
import {SpokeHook} from "../../../src/launch/SpokeHook.sol";
import {IAgentLaunch} from "../../../src/launch/interfaces/IAgentLaunch.sol";

interface IL5SafeFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce) external returns (address);
}

interface IL5Safe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function enableModule(address module) external;
    function domainSeparator() external view returns (bytes32);
}

struct L5ModuleInit {
    address module;
    bytes initData;
}

struct L5RegistryInit {
    address registry;
    address[] attesters;
    uint8 threshold;
}

interface IL5Safe7579Init {
    function initializeAccount(
        L5ModuleInit[] calldata validators,
        L5ModuleInit[] calldata executors,
        L5ModuleInit[] calldata fallbacks,
        L5ModuleInit[] calldata hooks,
        L5RegistryInit calldata registryInit
    ) external;
}

interface IL5Registry {
    function register(string memory agentURI) external returns (uint256);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
    function getAgentWallet(uint256 agentId) external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IL5Module {
    function isInstalledOn(address account) external view returns (bool);
}

interface IL5Attestor {
    function isVerified(uint256 agentId) external view returns (bool);
    function payVerification(uint256 agentId, address expectedOwner, uint128 maxFee) external;
    function fee() external view returns (uint128);
}

/// @notice Lane L5 on a fork of Robinhood Chain 4663: the real Uniswap v4 PoolManager, the launched ORRY token (Pons V2,
/// still on its curve), USDG, the Chainlink ETH/USD feed, the CREATE2 factory, and Orrery's own live v1 contracts: the
/// ERC-8004 IdentityRegistry, `OrreryAttestor` (verification paid in real USDG) and `OrreryPolicyModule` (installed on a real
/// Safe 1.4.1 through the Safe7579 v1.0.0 adapter, bound as the agent's wallet with an ERC-1271 proof). The ORRY launch
/// set (`OrryStaking`, `OrreryHook` with the ORRY/ETH hub, `EarnVault`) and the R1 `OrryPriceOracle` are deployed from
/// source on the fork (nothing of it is on 4663 yet). The spoke hook goes through the real CREATE2 factory at a mined salt,
/// as the deploy script does.
/// Run: forge test --match-path 'test/launch/fork/*' --fork-url <4663 rpc> -vv
contract LaunchForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal constant ORRY = 0x85272EA3aE8685C768045dba5455fE305C706aA4;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant ATTESTOR = 0xC18a0dc74F5326786f5aDe357354159C63282Bd0;
    address internal constant MODULE = 0x2934c34AFD7b5410D05ddD638982EED1D49F0D4c;
    address internal constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant ADAPTER = 0x7579EE8307284F293B1927136486880611F20002;
    bytes32 internal constant SAFE_MSG_TYPEHASH = 0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca;
    bytes32 internal constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    uint160 internal constant HUB_SQRT_PRICE = 158456325028528675187087900672000; // 4,000,000 ORRY per ETH

    IPoolManager internal pm = IPoolManager(POOL_MANAGER);
    IOrryToken internal orry = IOrryToken(ORRY);
    OrryStaking internal staking;
    OrreryHook internal hubHook;
    EarnVault internal vault;
    OrryPriceOracle internal oracle;
    OrreryTreasury internal treasury;
    SpokeHook internal hook;
    AgentLaunch internal al;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    IL5Safe internal safe;

    address internal owner;
    uint256 internal ownerKey;
    address internal treasuryOwner = makeAddr("treasuryOwner");
    address internal staker = makeAddr("staker");
    address internal trader = makeAddr("trader");
    uint256 internal agentId;
    bytes32 internal hookSalt;
    uint256 internal clock;

    function setUp() public {
        if (block.chainid != 4663) {
            vm.skip(true); // fork suite: run with --fork-url of Robinhood Chain 4663
            return;
        }
        require(ORRY.code.length > 0 && POOL_MANAGER.code.length > 0 && CREATE2_FACTORY.code.length > 0, "fork state");
        clock = block.timestamp;
        (owner, ownerKey) = makeAddrAndKey("agentOwner");

        // ORRY launch set and the R1 oracle, from source (as CommunityFork)
        staking = new OrryStaking(ORRY, REGISTRY, 7 days, 14 days, 7 days);
        OrreryAttestor treasuryAttestor =
            new OrreryAttestor(IIdentityRegistry(REGISTRY), IERC20Min(USDG), makeAddr("attestorAdmin"), address(1), 5e6);
        address[] memory signers = new address[](1);
        signers[0] = makeAddr("quoteSigner");
        treasury = new OrreryTreasury(USDG, address(treasuryAttestor), treasuryOwner, 3000, signers);
        uint64 n = vm.getNonce(address(this)) + 1;
        address buybackAt = vm.computeCreateAddress(address(this), n);
        address routerAt = vm.computeCreateAddress(address(this), n + 1);
        address hubAt = address((uint160(uint256(keccak256("orrery.l5.fork.hub"))) & ~uint160(0x3FFF)) | 0x10C4);
        deployCodeTo(
            "OrreryHook.sol:OrreryHook",
            abi.encode(POOL_MANAGER, ORRY, routerAt, address(treasury), uint24(8500), uint24(1500), int24(200), USDG, ETH_USD_FEED),
            hubAt
        );
        hubHook = OrreryHook(hubAt);
        PoolKey[] memory hop1 = new PoolKey[](1);
        hop1[0] = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 500, 10, IHooks(address(0)));
        OrryBuyback buyback = new OrryBuyback(address(treasury), routerAt, hubAt, USDG, POOL_MANAGER, hop1, 1_000e6, 1000);
        OrryRewardsRouter router = new OrryRewardsRouter(ORRY, address(staking), address(buyback), hubAt, 5000, 1 hours);
        require(address(buyback) == buybackAt && address(router) == routerAt, "address prediction");
        vault = new EarnVault(hubAt, address(0));
        oracle = new OrryPriceOracle(hubAt, USDG, ETH_USD_FEED, 120 days);

        swapRouter = new PoolSwapTest(pm);
        lpRouter = new PoolModifyLiquidityTest(pm);
        PoolKey memory hub = hubHook.hubKey(address(0));
        pm.initialize(hub, HUB_SQRT_PRICE);
        deal(ORRY, address(this), 500_000_000e18);
        vm.deal(address(this), 1_000 ether);
        orry.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity{value: 60 ether}(
            hub, ModifyLiquidityParams(TickMath.minUsableTick(200), TickMath.maxUsableTick(200), 4e22, 0), ""
        );

        // the L5 pair: the spoke hook through the real CREATE2 factory at a mined salt, then AgentLaunch at the
        // predicted CREATE address
        uint64 launchNonce = vm.getNonce(address(this));
        address launchAt = vm.computeCreateAddress(address(this), launchNonce);
        bytes memory hookInit = abi.encodePacked(
            type(SpokeHook).creationCode, abi.encode(POOL_MANAGER, ORRY, launchAt, uint24(800_000), uint32(60), uint32(600))
        );
        address hookAt;
        (hookSalt, hookAt) = _mine(keccak256(hookInit));
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(hookSalt, hookInit));
        require(ok && address(bytes20(ret)) == hookAt, "CREATE2 factory deploy");
        hook = SpokeHook(hookAt);
        if (vm.getNonce(address(this)) != launchNonce) vm.setNonceUnsafe(address(this), launchNonce);
        al = new AgentLaunch(
            POOL_MANAGER,
            ORRY,
            hookAt,
            REGISTRY,
            ATTESTOR,
            MODULE,
            address(staking),
            address(oracle),
            address(vault),
            address(treasury),
            IAgentLaunch.Params(25_000, 500, 100e6, 50, 1_000e6, 10e6)
        );
        require(address(al) == launchAt, "launch address prediction");

        // the agent: registered by its owner, a Safe with Safe7579 and the real OrreryPolicyModule, bound as the wallet,
        // verification paid in real USDG on the real attestor
        safe = _safe();
        vm.prank(owner);
        agentId = IL5Registry(REGISTRY).register("ipfs://orrery-l5-fork-agent");
        _bind(agentId);
        uint128 fee = IL5Attestor(ATTESTOR).fee();
        deal(USDG, owner, fee);
        vm.startPrank(owner);
        (bool approved,) = USDG.call(abi.encodeWithSignature("approve(address,uint256)", ATTESTOR, uint256(fee)));
        require(approved, "approve");
        IL5Attestor(ATTESTOR).payVerification(agentId, owner, fee);
        vm.stopPrank();

        // ORRY for the owner (stake and first buy), a staker for the early window and a trader
        orry.transfer(owner, 20_000_000e18);
        orry.transfer(staker, 20_000_000e18);
        orry.transfer(trader, 50_000_000e18);
        vm.startPrank(owner);
        orry.approve(address(staking), type(uint256).max);
        orry.approve(address(al), type(uint256).max);
        staking.stakeForAgent(agentId, 1_000_000e18);
        staking.extendAgentLock(agentId, uint64(block.timestamp + 91 days));
        vm.stopPrank();
        vm.startPrank(staker);
        orry.approve(address(staking), type(uint256).max);
        orry.approve(address(al), type(uint256).max);
        staking.stake(5_000_000e18);
        vm.stopPrank();
        vm.prank(trader);
        orry.approve(address(swapRouter), type(uint256).max);

        // 31 minutes of hub history: the oracle answers (ETH hub mean tick times the real ETH/USD feed)
        _warp(31 minutes);
        require(oracle.ready(), "oracle ready");
    }

    receive() external payable {}

    // ---------------------------------------------------------------- tests

    function test_fork_hook_salt_mined_for_the_create2_factory() public view {
        assertEq(uint160(address(hook)) & 0x3FFF, 0x28CC, "permission bits");
        assertEq(hook.launch(), address(al));
        console2.log("mined salt", uint256(hookSalt));
        console2.log("hook", address(hook));
    }

    function test_fork_real_gates() public view {
        assertTrue(IL5Attestor(ATTESTOR).isVerified(agentId), "verified on the real attestor");
        assertEq(IL5Registry(REGISTRY).getAgentWallet(agentId), address(safe), "Safe bound in the real registry");
        assertTrue(IL5Module(MODULE).isInstalledOn(address(safe)), "real module installed on the Safe");
        console2.log("agent stake in USD (6 dp)", oracle.usdValue(staking.agentStake(agentId).active));
        assertEq(uint8(al.canLaunch(agentId, owner)), uint8(IAgentLaunch.Gate.Ok));
        assertEq(uint8(al.canLaunch(agentId, trader)), uint8(IAgentLaunch.Gate.NotController));
    }

    function test_fork_launch_trade_distribute_claim() public {
        bytes32 salt = _goodSalt(owner, "Fork Agent", "FAG");
        address predicted = al.predictCoin(owner, salt, "Fork Agent", "FAG");
        PoolKey memory key = PoolKey(Currency.wrap(ORRY), Currency.wrap(predicted), 0, 200, IHooks(address(hook)));

        // hostile: the spoke key cannot be opened by anyone else, before or after
        vm.prank(trader);
        vm.expectRevert();
        pm.initialize(key, TickMath.getSqrtPriceAtTick(-100_000));

        vm.prank(owner);
        address coin = al.launch(agentId, "Fork Agent", "FAG", salt, 1_000_000e18, 0);
        assertEq(coin, predicted);
        PoolId id = key.toId();
        (, int24 tick, uint24 protocolFee,) = pm.getSlot0(id);
        console2.log("spoke tick after the first buy", int256(tick));
        console2.log("PoolManager protocol fee on the new spoke (pips, 0 = none)", uint256(protocolFee));
        assertLt(tick, 25_000);
        assertEq(pm.getLiquidity(id), al.launchLiquidity(), "the launch position is the only liquidity");
        assertEq(hook.feesOf(id), 10_000e18, "1% of the first buy");
        uint256 creatorCoins = AgentCoin(coin).balanceOf(owner);
        console2.log("creator first buy, coins", creatorCoins / 1e18);

        // early window: the staker buys through AgentLaunch, a public buy is refused
        uint256 allowance = al.earlyAllowance(coin, staker);
        console2.log("staker early allowance, coins", allowance / 1e18);
        assertEq(allowance, 5_000_000e18, "full weight: 0.5% of supply");
        vm.prank(staker);
        uint256 early = al.buyEarly(coin, 100_000e18, 1, block.timestamp);
        assertGt(early, 0);
        vm.expectRevert();
        _swapRaw(trader, key, true, -1e18);

        // public opening: the launch fee, then 1%
        _warp(600);
        uint256 f0 = hook.feesOf(id);
        _swap(trader, coin, key, true, -int256(10_000e18));
        assertEq(hook.feesOf(id) - f0, 8_000e18, "80% at the public opening second");
        _warp(60);
        f0 = hook.feesOf(id);
        _swap(trader, coin, key, true, -int256(2_000_000e18));
        assertEq(hook.feesOf(id) - f0, 20_000e18, "1% after the decay");
        f0 = hook.feesOf(id);
        _swap(trader, coin, key, true, int256(1_000_000e18)); // exact out
        assertGt(hook.feesOf(id) - f0, 0);
        uint256 rc0 = orry.balanceOf(trader);
        f0 = hook.feesOf(id);
        _swap(trader, coin, key, false, -int256(AgentCoin(coin).balanceOf(trader) / 2)); // sell exact in
        uint256 got = orry.balanceOf(trader) - rc0;
        assertEq(hook.feesOf(id) - f0, (got + hook.feesOf(id) - f0) / 100, "1% of the ORRY output");
        _swap(trader, coin, key, false, int256(10_000e18)); // sell exact out

        // outside liquidity refused on the real PoolManager
        vm.startPrank(trader);
        orry.approve(address(lpRouter), type(uint256).max);
        AgentCoin(coin).approve(address(lpRouter), type(uint256).max);
        vm.expectRevert();
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(-887_200, 887_200, 1e18, 0), "");
        vm.stopPrank();

        // distribution: real ORRY burned, Earn streamed through the real B-2 path, owner paid
        uint256 fees = al.pendingFees(coin);
        assertEq(IERC6909Claims(POOL_MANAGER).balanceOf(address(al), uint256(uint160(ORRY))), fees, "LA-1 on the real PM");
        uint256 supply = orry.totalSupply();
        uint256 vault0 = orry.balanceOf(address(vault));
        uint256 owner0 = orry.balanceOf(treasuryOwner);
        al.distribute(coin);
        uint256 creator = fees * 5000 / 10_000;
        uint256 earn = fees * 2000 / 10_000;
        uint256 ownerPart = fees * 1500 / 10_000;
        assertEq(supply - orry.totalSupply(), fees - creator - earn - ownerPart, "real ORRY supply fell by the burn");
        assertEq(orry.balanceOf(address(vault)) - vault0, earn, "EarnVault.notifyRewards took the Earn share");
        assertEq(orry.balanceOf(treasuryOwner) - owner0, ownerPart, "owner share to the treasury owner");
        console2.log("fees distributed, ORRY", fees / 1e18);

        // the creator share goes to the agent's Safe with the real policy module installed
        uint256 safe0 = orry.balanceOf(address(safe));
        vm.prank(trader);
        uint256 paid = al.claimCreatorFees(coin);
        assertEq(paid, creator);
        assertEq(orry.balanceOf(address(safe)) - safe0, creator, "paid to the policy-bound Safe");
        assertEq(orry.balanceOf(address(al)), al.earnPending(), "LA-2");

        // the creator's agent stake stays locked
        vm.prank(owner);
        vm.expectRevert();
        staking.requestAgentUnstake(agentId, owner, 1);
    }

    // ---------------------------------------------------------------- helpers

    function _warp(uint256 secs) internal {
        clock += secs;
        vm.warp(clock);
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev The first salt from 0 whose CREATE2 address through the factory carries exactly the spoke bits.
    function _mine(bytes32 initHash) internal pure returns (bytes32 salt, address at) {
        for (uint256 i; i < 400_000; ++i) {
            salt = bytes32(i);
            at = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, initHash)))));
            if (uint160(at) & 0x3FFF == 0x28CC) return (salt, at);
        }
        revert("no salt");
    }

    function _goodSalt(address caller, string memory name, string memory symbol) internal view returns (bytes32 salt) {
        for (uint256 i; i < 256; ++i) {
            salt = bytes32(i);
            if (uint160(al.predictCoin(caller, salt, name, symbol)) > uint160(ORRY)) return salt;
        }
        revert("no coin salt");
    }

    function _swapRaw(address who, PoolKey memory key, bool buy, int256 spec) internal {
        vm.prank(who);
        swapRouter.swap(
            key,
            SwapParams(buy, spec, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function _swap(address who, address coin, PoolKey memory key, bool buy, int256 spec) internal {
        vm.prank(who);
        AgentCoin(coin).approve(address(swapRouter), type(uint256).max);
        _swapRaw(who, key, buy, spec);
    }

    function _safe() internal returns (IL5Safe s) {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory init =
            abi.encodeCall(IL5Safe.setup, (owners, 1, address(0), "", ADAPTER, address(0), 0, payable(address(0))));
        s = IL5Safe(IL5SafeFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_L2, init, uint256(keccak256("orrery-l5-fork"))));
        safe = s;
        _exec(address(s), abi.encodeCall(IL5Safe.enableModule, (ADAPTER)));
        L5ModuleInit[] memory none = new L5ModuleInit[](0);
        L5ModuleInit[] memory execs = new L5ModuleInit[](1);
        execs[0] = L5ModuleInit(MODULE, "");
        _exec(
            address(s),
            abi.encodeCall(
                IL5Safe7579Init.initializeAccount, (none, execs, none, none, L5RegistryInit(address(0), new address[](0), 0))
            )
        );
    }

    function _exec(address to, bytes memory data) internal {
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(owner))), bytes32(0), uint8(1));
        vm.prank(owner);
        bool ok = safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sig);
        require(ok, "safe exec");
    }

    /// @dev ERC-1271 proof from the Safe through the Safe7579 adapter (as `test/fork/Safe7579.fork.t.sol`).
    function _bind(uint256 id) internal {
        uint256 deadline = block.timestamp + 4 minutes;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                REGISTRY
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", domain, keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, id, address(safe), owner, deadline))
            )
        );
        bytes32 safeMsgHash = keccak256(
            abi.encodePacked(
                bytes1(0x19),
                bytes1(0x01),
                safe.domainSeparator(),
                keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(abi.encode(digest))))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, safeMsgHash);
        vm.prank(owner);
        IL5Registry(REGISTRY).setAgentWallet(id, address(safe), deadline, abi.encodePacked(address(0), r, s, v));
    }
}
