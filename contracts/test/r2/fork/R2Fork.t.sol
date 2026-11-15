// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

import {MarketFactory} from "../../../src/markets/MarketFactory.sol";
import {FeeTiers} from "../../../src/markets/FeeTiers.sol";
import {OrryPriceOracle} from "../../../src/markets/OrryPriceOracle.sol";
import {MarketParams} from "../../../src/markets/MarketParams.sol";
import {IChainlinkFeed} from "../../../src/markets/ChainlinkFeed.sol";
import {OrreryAttestor} from "../../../src/OrreryAttestor.sol";
import {IIdentityRegistry, IERC20Min} from "../../../src/interfaces/IExternal.sol";
import {OrreryTreasury} from "../../../src/orry/OrreryTreasury.sol";
import {PredictionMarketFactory} from "../../../src/markets/r2/PredictionMarketFactory.sol";
import {PredictionMarket} from "../../../src/markets/r2/PredictionMarket.sol";
import {IPredictionMarket, PredictionParams} from "../../../src/markets/r2/interfaces/IPrediction.sol";
import {LimitOrderBook} from "../../../src/markets/r2/LimitOrderBook.sol";
import {ILimitOrderBook} from "../../../src/markets/r2/interfaces/ILimitOrderBook.sol";
import {OrryPaymaster} from "../../../src/paymaster/OrryPaymaster.sol";
import {PackedUserOperation, PaymasterParams} from "../../../src/paymaster/interfaces/IOrryPaymaster.sol";
import {MockEarningStaking, OracleHookStandIn} from "../../markets/utils/MarketMocks.sol";

interface IStockF {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function mint(address, uint256) external;
    function oraclePaused() external view returns (bool);
    function effectiveAt() external view returns (uint256);
}

interface IRegistryF {
    function blockAccounts(address[] calldata) external;
    function unblockAccounts(address[] calldata) external;
}

interface IErc20F {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface IEntryPointF {
    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PackedUserOperation calldata userOp) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Minimal ERC-4337 account for the fork test: one owner key signs the EntryPoint's user operation hash.
contract ForkAccount {
    address public immutable entryPoint;
    address public immutable owner;

    constructor(address entryPoint_, address owner_) {
        entryPoint = entryPoint_;
        owner = owner_;
    }

    function validateUserOp(PackedUserOperation calldata op, bytes32 hash, uint256 missing) external returns (uint256) {
        require(msg.sender == entryPoint, "entry point");
        bytes calldata sig = op.signature;
        address signer = ecrecover(hash, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
        if (missing != 0) {
            (bool ok,) = payable(msg.sender).call{value: missing}("");
            ok;
        }
        return signer == owner ? 0 : 1;
    }

    function execute(address to, uint256 value, bytes calldata data) external {
        require(msg.sender == entryPoint, "entry point");
        (bool ok,) = to.call{value: value}(data);
        require(ok, "call");
    }

    receive() external payable {}
}

/// @notice Lane L3 on a fork of Robinhood Chain 4663 (`docs/updates/L3-R2-SPEC.md`): the real USDG, the real TSLA and SPY
/// stock tokens with their real Chainlink feeds and issuer registry, the real SPY/USDG Uniswap v4 pool on the real
/// PoolManager, the real EntryPoint v0.7 and v0.8, the real ORRY token (Pons launch, burns checked on its supply) and the
/// real Chainlink ETH/USD feed. The hub's time-weighted price is the R1 stand-in (no ORRY hub exists on 4663 yet).
/// Run: heavy forge test --match-path 'test/r2/fork/*' --fork-url <4663 RPC> --fork-block-number <head - 20> -vv
/// Public RPCs keep only seconds of state on this 100 ms chain, so a long fork run fails with "historical state is not
/// available" (forge reports FatalExternalError) once its block falls out of their window; the R1 fork suite fails the
/// same way. The official RPC (rpc.mainnet.chain.robinhood.com) keeps at least 2,000 blocks; on 2026-11-11 the suite
/// passed 8 of 8 against it at block 111,545,343.
contract R2ForkTest is Test {
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address internal constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    address internal constant BLOCKER = 0x913cA87347391218e5De2C17c5A0AEba8B0b28fD;
    address internal constant MINTER = 0x13643b89b19245201b29d556EDDe5CF18f749C08;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant EP07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address internal constant EP08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    address internal constant ORRY = 0x85272EA3aE8685C768045dba5455fE305C706aA4;

    OracleHookStandIn internal hook;
    MockEarningStaking internal staking;
    OrryPriceOracle internal orryPrice;
    FeeTiers internal tiers;
    OrreryTreasury internal treasury;
    address internal ownerWallet = makeAddr("ownerWallet");
    uint256 internal forkNow;

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url of Robinhood Chain 4663");
        forkNow = block.timestamp;
        hook = new OracleHookStandIn();
        hook.set(138200, block.timestamp - 3 days);
        staking = new MockEarningStaking();
        uint256[] memory mins = new uint256[](2);
        uint16[] memory ds = new uint16[](2);
        (mins[0], mins[1], ds[0], ds[1]) = (100e6, 1_000e6, 2500, 5000);
        orryPrice = new OrryPriceOracle(address(hook), USDG, ETH_USD_FEED, 25 hours);
        tiers = new FeeTiers(address(staking), address(orryPrice), mins, ds);
        OrreryAttestor attestor =
            new OrreryAttestor(IIdentityRegistry(IDENTITY_REGISTRY), IERC20Min(USDG), address(this), ownerWallet, 5e6);
        address[] memory signers = new address[](1);
        signers[0] = makeAddr("quoteSigner");
        treasury = new OrreryTreasury(USDG, address(attestor), ownerWallet, 1000, signers);
    }

    function _orryTo(address who, uint256 amount) internal {
        deal(ORRY, who, amount);
    }

    // ------------------------------------------------------------------ facts

    function test_fork_facts() public view {
        assertEq(EP07.code.length, 16_035, "EntryPoint v0.7 runtime");
        assertEq(EP08.code.length, 21_738, "EntryPoint v0.8 runtime");
        assertEq(IErc20F(ORRY).symbol(), "ORRY");
        assertEq(IErc20F(ORRY).decimals(), 18);
        assertEq(IErc20F(ORRY).totalSupply(), 1e27);
        assertEq(IErc20F(USDG).decimals(), 6);
        (, int256 tsla,,,) = IChainlinkFeed(TSLA_FEED).latestRoundData();
        (, int256 eth,,,) = IChainlinkFeed(ETH_USD_FEED).latestRoundData();
        assertGt(tsla, 0);
        assertGt(eth, 0);
        console2.log("block", block.number);
        console2.log("TSLA / USD (8 dec)", uint256(tsla));
        console2.log("ETH / USD (8 dec)", uint256(eth));
    }

    // ------------------------------------------------------------------ prediction markets

    function _predictFactory() internal returns (PredictionMarketFactory f) {
        f = new PredictionMarketFactory(
            ownerWallet,
            USDG,
            address(treasury),
            address(tiers),
            address(orryPrice),
            ORRY,
            PredictionParams({feeBps: 200, lockSeconds: 1800, minStake: 1e6, creationFeeUsd: 1e6, orryFeeDiscountBps: 2500})
        );
        vm.prank(ownerWallet);
        f.listFeed(TSLA_FEED, TSLA);
    }

    function _staker(string memory name, address market) internal returns (address t) {
        t = makeAddr(name);
        deal(USDG, t, 10_000e6);
        _orryTo(t, 10_000_000e18);
        vm.startPrank(t);
        IErc20F(USDG).approve(market, type(uint256).max);
        IErc20F(ORRY).approve(market, type(uint256).max);
        vm.stopPrank();
    }

    /// The creation fee is burned from the real ORRY token: its total supply falls by exactly the fee.
    function test_fork_prediction_creation_burns_real_orry() public {
        PredictionMarketFactory f = _predictFactory();
        address creator = makeAddr("creator");
        _orryTo(creator, 10_000_000e18);
        vm.prank(creator);
        IErc20F(ORRY).approve(address(f), type(uint256).max);
        uint256 fee = orryPrice.orryFor(1e6);
        uint256 supply = IErc20F(ORRY).totalSupply();
        vm.prank(creator);
        f.create(TSLA_FEED, 400e8, uint64(block.timestamp + 2 hours));
        assertEq(supply - IErc20F(ORRY).totalSupply(), fee, "supply falls by the creation fee");
        console2.log("creation fee in ORRY (1 USD)", fee / 1e18);
    }

    /// A market created before the latest real TSLA round and closing at it settles on that round (the first at or after
    /// the close), with real USDG stakes, the real token's corporate action views, and the fee burned in real ORRY.
    function test_fork_prediction_settles_on_the_real_tsla_round() public {
        (uint80 id, int256 answer,, uint256 updatedAt,) = IChainlinkFeed(TSLA_FEED).latestRoundData();
        (,,, uint256 prevAt,) = IChainlinkFeed(TSLA_FEED).getRoundData(id - 1);
        assertLt(prevAt, updatedAt);
        uint64 close = uint64(updatedAt);
        PredictionMarketFactory f = _predictFactory();
        vm.warp(close - 1 hours); // before the round: the market is made and staked then
        address creator = makeAddr("creator");
        _orryTo(creator, 10_000_000e18);
        vm.prank(creator);
        IErc20F(ORRY).approve(address(f), type(uint256).max);
        vm.prank(creator);
        PredictionMarket m = PredictionMarket(f.create(TSLA_FEED, answer - 1, close));
        address yes = _staker("yes", address(m));
        address no = _staker("no", address(m));
        vm.prank(yes);
        m.stake(true, 1_000e6);
        vm.prank(no);
        m.stake(false, 3_000e6);
        vm.warp(forkNow);
        console2.log("TSLA effectiveAt", IStockF(TSLA).effectiveAt());
        m.settle(id);
        assertEq(uint8(m.status()), uint8(IPredictionMarket.Status.Yes), "real answer above a strike one unit lower");
        uint256 orryFee = orryPrice.orryFor(80e6 * 3 / 4); // 2% of 4,000 USDG, 25% off in ORRY
        uint256 supply = IErc20F(ORRY).totalSupply();
        uint256 before = IErc20F(USDG).balanceOf(yes);
        vm.prank(yes);
        m.claim(true);
        assertEq(IErc20F(USDG).balanceOf(yes) - before, 4_000e6, "the gross, fee paid in ORRY");
        assertEq(supply - IErc20F(ORRY).totalSupply(), orryFee, "real ORRY burned exactly");
        assertEq(IErc20F(USDG).balanceOf(address(m)), 0);
    }

    function test_fork_prediction_unsettled_market_refunds_real_usdg() public {
        PredictionMarketFactory f = _predictFactory();
        address creator = makeAddr("creator");
        _orryTo(creator, 10_000_000e18);
        vm.prank(creator);
        IErc20F(ORRY).approve(address(f), type(uint256).max);
        vm.prank(creator);
        PredictionMarket m = PredictionMarket(f.create(TSLA_FEED, 400e8, uint64(block.timestamp + 2 hours)));
        address yes = _staker("yes", address(m));
        address no = _staker("no", address(m));
        vm.prank(yes);
        m.stake(true, 500e6);
        vm.prank(no);
        m.stake(false, 700e6);
        vm.warp(m.closeTime() + 7 days); // no real round after a future close exists on the fork
        m.expire();
        vm.prank(yes);
        assertEq(m.claim(false), 500e6);
        vm.prank(no);
        assertEq(m.claim(false), 700e6);
    }

    // ------------------------------------------------------------------ limit orders

    function _spyPool() internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(SPY), Currency.wrap(USDG), 500, 5, IHooks(address(0)));
    }

    function _book() internal returns (LimitOrderBook book, address maker, uint256 key) {
        MarketFactory mf = new MarketFactory(
            ownerWallet,
            USDG,
            address(treasury),
            address(tiers),
            address(orryPrice),
            ORRY,
            POOL_MANAGER,
            MarketParams({
                commitSeconds: 240,
                revealSeconds: 60,
                feeBps: 15,
                minNotionalUsdg: 10e6,
                maxStaleness: 4 days,
                commitFeeUsd: 0.05e6,
                orryFeeDiscountBps: 2500,
                maxDeviationBps: 50
            })
        );
        vm.prank(ownerWallet);
        mf.create(SPY, SPY_FEED, _spyPool());
        book = new LimitOrderBook(
            USDG, address(mf), POOL_MANAGER, address(treasury), address(tiers), address(orryPrice), ORRY, 10, 100, 4 days, 2500
        );
        (maker, key) = makeAddrAndKey("maker");
        vm.prank(MINTER);
        IStockF(SPY).mint(maker, 10e18);
        deal(USDG, maker, 100_000e6);
        vm.startPrank(maker);
        IStockF(SPY).approve(address(book), type(uint256).max);
        IErc20F(USDG).approve(address(book), type(uint256).max);
        vm.stopPrank();
    }

    function _signed(LimitOrderBook book, ILimitOrderBook.Order memory o, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, book.hashOrder(o));
        return abi.encodePacked(r, s, v);
    }

    function test_fork_limit_orders_fill_through_the_real_spy_pool() public {
        (LimitOrderBook book, address maker, uint256 key) = _book();
        uint256 price = book.oraclePrice(SPY);
        console2.log("SPY oracle (USDG per SPY)", price);
        ILimitOrderBook.Order memory sell = ILimitOrderBook.Order({
            owner: maker,
            asset: SPY,
            sellAsset: true,
            amountIn: 2e18,
            limitPrice: price * 98 / 100,
            tipBps: 20,
            payFeeInOrry: false,
            nonce: 1,
            expiry: uint64(block.timestamp + 1 days)
        });
        address keeper = makeAddr("keeper");
        uint256 u0 = IErc20F(USDG).balanceOf(maker);
        uint256 t0 = IErc20F(USDG).balanceOf(address(treasury));
        bytes memory sig = _signed(book, sell, key);
        vm.prank(keeper);
        uint256 out = book.fill(sell, sig);
        console2.log("USDG for 2 SPY through the real pool", out);
        assertGe(out * 1e18 * 10_000, price * 9_900 * 2e18, "LO-3 sell within 1% of the feed");
        assertEq(IErc20F(USDG).balanceOf(maker) - u0, out - out * 10 / 10_000 - out * 20 / 10_000);
        assertEq(IErc20F(USDG).balanceOf(address(treasury)) - t0, out * 10 / 10_000, "fee reached the treasury");
        assertEq(IErc20F(USDG).balanceOf(keeper), out * 20 / 10_000);

        ILimitOrderBook.Order memory buy = sell;
        buy.sellAsset = false;
        buy.amountIn = 500e6;
        buy.limitPrice = price * 102 / 100;
        buy.nonce = 2;
        uint256 s0 = IStockF(SPY).balanceOf(maker);
        sig = _signed(book, buy, key);
        vm.prank(keeper);
        uint256 got = book.fill(buy, sig);
        assertEq(IStockF(SPY).balanceOf(maker) - s0, got);
        assertLe(500e6 * 1e18 * 10_000, price * 10_100 * got, "LO-3 buy within 1% of the feed");
        assertEq(IStockF(SPY).balanceOf(address(book)), 0, "X-1");
        assertEq(IErc20F(USDG).balanceOf(address(book)), 0, "X-1");
    }

    /// The real issuer registry blocks the owner: the fill reverts and nothing moves, the nonce stays usable.
    function test_fork_limit_order_of_a_blocked_owner_moves_nothing() public {
        (LimitOrderBook book, address maker, uint256 key) = _book();
        uint256 price = book.oraclePrice(SPY);
        ILimitOrderBook.Order memory sell = ILimitOrderBook.Order({
            owner: maker,
            asset: SPY,
            sellAsset: true,
            amountIn: 1e18,
            limitPrice: price * 98 / 100,
            tipBps: 0,
            payFeeInOrry: false,
            nonce: 9,
            expiry: uint64(block.timestamp + 1 days)
        });
        bytes memory sig = _signed(book, sell, key);
        address[] memory list = new address[](1);
        list[0] = maker;
        vm.prank(BLOCKER);
        IRegistryF(REGISTRY).blockAccounts(list);
        vm.expectRevert();
        book.fill(sell, sig);
        assertEq(IStockF(SPY).balanceOf(maker), 10e18);
        assertFalse(book.nonceUsed(maker, 9));
    }

    // ------------------------------------------------------------------ paymaster on the real EntryPoints

    function _paymaster(address ep) internal returns (OrryPaymaster pm) {
        pm = new OrryPaymaster(
            ep,
            ORRY,
            address(orryPrice),
            ETH_USD_FEED,
            address(this),
            ownerWallet,
            PaymasterParams({
                premiumBps: 1000,
                bufferBps: 2000,
                maxCostWei: 2e15,
                postOpOverheadGas: 45_000,
                maxRateAge: 3600,
                maxEthStaleness: 25 hours
            })
        );
        vm.deal(address(this), 10 ether);
        pm.depositEth{value: 1 ether}();
        pm.addStake{value: 1 ether}(86_400);
        pm.refreshRate();
    }

    function _op(address ep, address account, address pm, uint256 key)
        internal
        returns (PackedUserOperation memory op)
    {
        op.sender = account;
        op.nonce = IEntryPointF(ep).getNonce(account, 0);
        op.callData = abi.encodeCall(ForkAccount.execute, (makeAddr("target"), 0, ""));
        op.accountGasLimits = bytes32((uint256(150_000) << 128) | 100_000); // verification | call
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(0.01 gwei) << 128) | 0.05 gwei); // priority | max fee
        op.paymasterAndData = abi.encodePacked(pm, uint128(200_000), uint128(150_000));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, IEntryPointF(ep).getUserOpHash(op));
        op.signature = abi.encodePacked(r, s, v);
    }

    function _runOn(address ep) internal {
        OrryPaymaster pm = _paymaster(ep);
        (address agentOwner, uint256 key) = makeAddrAndKey("agentOwner");
        ForkAccount account = new ForkAccount(ep, agentOwner);
        address operator = makeAddr("operator");
        _orryTo(operator, 1_000_000e18);
        vm.prank(operator);
        IErc20F(ORRY).approve(address(pm), type(uint256).max);
        vm.prank(operator);
        pm.deposit(address(account), 100_000e18);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _op(ep, address(account), address(pm), key);
        uint256 deposit0 = IEntryPointF(ep).balanceOf(address(pm));
        address bundler = makeAddr("bundler");
        vm.prank(bundler, bundler);
        IEntryPointF(ep).handleOps(ops, payable(bundler));
        uint256 ethSpent = deposit0 - IEntryPointF(ep).balanceOf(address(pm));
        uint256 charged = 100_000e18 - pm.balanceOf(address(account));
        console2.log("ETH paid by the paymaster (wei)", ethSpent);
        console2.log("ORRY charged (wei)", charged);
        assertGt(ethSpent, 0);
        assertGt(charged, 0);
        assertEq(IEntryPointF(ep).getNonce(address(account), 0), 1, "the operation ran");
        // PA-3: the charge covers the ETH spent plus the premium at the current rate
        (uint256 rate,) = pm.cachedRate();
        assertGe(charged * 1e18 * 10_000, ethSpent * rate * 11_000);
        assertEq(IErc20F(ORRY).balanceOf(address(pm)), pm.balanceOf(address(account)) + pm.pendingRecipient() + pm.pendingBurn());
        uint256 supply = IErc20F(ORRY).totalSupply();
        uint256 burn = pm.pendingBurn();
        pm.flush();
        assertEq(supply - IErc20F(ORRY).totalSupply(), burn, "premium burned on the real ORRY");

        // a cached rate older than maxRateAge: the real EntryPoint refuses the operation (validUntil)
        vm.warp(block.timestamp + 3601);
        ops[0] = _op(ep, address(account), address(pm), key);
        vm.prank(bundler, bundler);
        vm.expectRevert();
        IEntryPointF(ep).handleOps(ops, payable(bundler));
    }

    function test_fork_paymaster_on_entry_point_v07() public {
        _runOn(EP07);
    }

    function test_fork_paymaster_on_entry_point_v08() public {
        _runOn(EP08);
    }
}
