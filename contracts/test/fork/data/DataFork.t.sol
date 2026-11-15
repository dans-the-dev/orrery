// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {MerchantSplitterFactory} from "../../../src/facilitator/MerchantSplitterFactory.sol";
import {MerchantSplitter} from "../../../src/facilitator/MerchantSplitter.sol";
import {DataFeeSplitter} from "../../../src/data/DataFeeSplitter.sol";
import {DataProviderRegistry} from "../../../src/data/DataProviderRegistry.sol";
import {DataRewardPool, DataStakeValue} from "../../data/DataMocks.sol";

interface IErc20 {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface ITreasuryOwner {
    function owner() external view returns (address);
}

interface IStockToken {
    function uiMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
    function paused() external view returns (bool);
    function oraclePaused() external view returns (bool);
}

interface IIssuerRegistry {
    function isBlocked(address) external view returns (bool);
    function paused() external view returns (bool);
}

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @dev Pons V2 `getLaunchedToken` return shape (Sourcify exact match of the factory, read 2026-11-11).
struct PonsLaunch {
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
    uint8 phase;
    uint256 sweptQuote;
    uint256 sweptTokens;
    uint256 sweptAt;
    bool exists;
}

interface IPonsFactory {
    function getLaunchedToken(address token) external view returns (PonsLaunch memory);
}

/// @notice Lane L2 on a fork of Robinhood Chain 4663 (`docs/updates/L2-DATA-MCP-SPEC.md` 0 and 8): `DataFeeSplitter`
/// burning the real ORRY (the Pons V2 token launched by the owner) and reading the owner of the real mainnet
/// `OrreryTreasury`; `DataProviderRegistry` with a 1% `MerchantSplitterFactory` paying real USDG to the real treasury;
/// and the read shapes the data service relies on (stock tokens, the issuer registry, a stock feed, the Pons factory).
/// Run: forge test --match-path 'test/fork/data/*' --fork-url https://rpc-robinhood.blockmachine.io -vv
contract DataForkTest is Test {
    address constant ORRY = 0x85272EA3aE8685C768045dba5455fE305C706aA4;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant TREASURY = 0x5b633d7Ec2749104d53B67dC47210dBE538aC54c;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address constant ISSUER_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ORRY_CURVE = 0xe8b016eD5e5b6f47BDF475f516C571439bfF0420;

    DataFeeSplitter splitter;
    DataRewardPool pool;

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url of Robinhood Chain 4663");
        splitter = new DataFeeSplitter(ORRY, TREASURY);
        pool = new DataRewardPool(ORRY);
    }

    function test_fork_split_burns_real_orry_and_holds_the_pool_share() public {
        uint256 amount = 1_000e18;
        deal(ORRY, address(splitter), amount); // a payment through X402Permit2Proxy lands the same way
        uint256 supply = IErc20(ORRY).totalSupply();
        (uint256 burned, uint256 toPool) = splitter.split();
        assertEq(burned, 700e18);
        assertEq(toPool, 300e18);
        assertEq(supply - IErc20(ORRY).totalSupply(), 700e18, "the real ORRY burn lowers the supply exactly");
        assertEq(IErc20(ORRY).balanceOf(address(splitter)), 300e18);
        console2.log("ORRY supply after the burn", IErc20(ORRY).totalSupply());
    }

    function test_fork_pool_is_set_by_the_real_treasury_owner() public {
        address owner = ITreasuryOwner(TREASURY).owner();
        assertTrue(owner != address(0));
        console2.log("OrreryTreasury owner", owner);
        vm.prank(owner);
        splitter.proposePool(address(pool));
        vm.warp(block.timestamp + 48 hours);
        vm.prank(owner);
        splitter.executePool();
        deal(ORRY, address(splitter), 10e18);
        splitter.split();
        assertEq(pool.freeBalance(ORRY), 3e18, "30% booked by the pool with the real token's transferFrom");
        assertEq(IErc20(ORRY).balanceOf(address(splitter)), 0);
    }

    function test_fork_provider_payment_in_real_usdg_reaches_the_real_treasury() public {
        DataStakeValue stake = new DataStakeValue();
        MerchantSplitterFactory f = new MerchantSplitterFactory(100, USDG, ORRY, TREASURY, address(0));
        DataProviderRegistry reg = new DataProviderRegistry(address(stake), address(f), 100_000_000);
        address provider = makeAddr("provider");
        stake.set(provider, 100_000_000);
        vm.prank(provider);
        address s = reg.list("https://data.example.org/feed", "Example Feed", "", 2000);
        deal(USDG, s, 1_000_000); // 1 USDG paid by agents
        uint256 before = IErc20(USDG).balanceOf(TREASURY);
        MerchantSplitter(s).forward(USDG);
        assertEq(IErc20(USDG).balanceOf(TREASURY) - before, 10_000, "1% to the treasury");
        assertEq(IErc20(USDG).balanceOf(provider), 990_000);
        deal(ORRY, s, 1e18);
        uint256 supply = IErc20(ORRY).totalSupply();
        MerchantSplitter(s).forward(ORRY);
        assertEq(supply - IErc20(ORRY).totalSupply(), 1e16, "1% of ORRY burned");
    }

    function test_fork_stock_and_issuer_reads() public view {
        uint256 m = IStockToken(TSLA).uiMultiplier();
        assertGt(m, 0);
        IStockToken(TSLA).effectiveAt();
        IStockToken(TSLA).paused();
        IStockToken(TSLA).oraclePaused();
        IIssuerRegistry(ISSUER_REGISTRY).isBlocked(address(this));
        IIssuerRegistry(ISSUER_REGISTRY).paused();
        (,,, uint256 updatedAt,) = IFeed(TSLA_FEED).latestRoundData();
        assertGt(updatedAt, 0);
        console2.log("TSLA uiMultiplier", m);
        console2.log("TSLA feed age (s)", block.timestamp - updatedAt);
    }

    function test_fork_pons_launch_record_of_orry() public view {
        PonsLaunch memory l = IPonsFactory(PONS_FACTORY).getLaunchedToken(ORRY);
        assertTrue(l.exists);
        assertEq(l.token, ORRY);
        assertEq(l.curve, ORRY_CURVE);
        assertEq(l.pairToken, address(0), "paired with native ETH");
        assertEq(l.graduationThreshold, 4.2 ether);
        uint256 held = ORRY_CURVE.balance;
        console2.log("curve ETH held (wei)", held);
        console2.log("progress (bps)", held * 10_000 / l.graduationThreshold);
    }
}
