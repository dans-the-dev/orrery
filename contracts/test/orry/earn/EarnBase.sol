// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {OrreryHook} from "../../../src/orry/OrreryHook.sol";
import {EarnVault} from "../../../src/orry/EarnVault.sol";
import {EarnVaultFactory} from "../../../src/orry/EarnVaultFactory.sol";
import {ClaimAll} from "../../../src/orry/ClaimAll.sol";
import {OrryLens} from "../../../src/orry/OrryLens.sol";
import {PoolManagerCode} from "./fixtures/PoolManagerCode.sol";
import {
    MockOrry,
    MockUsdg,
    MockFeed,
    MockTreasury,
    MockRouter,
    MockRegistry,
    MockStaking,
    HubActor
} from "./mocks/EarnMocks.sol";

/// @dev Exposes the reward stream bookkeeping for the invariants (E-3) without widening the production ABI.
contract EarnVaultHarness is EarnVault {
    constructor(address hook_, address quote_) EarnVault(hook_, quote_) {}

    function streamState(uint256 i)
        external
        view
        returns (uint256 rate, uint256 perShare, uint256 queued, uint256 harvested, uint256 paid, uint64 periodFinish)
    {
        Stream storage s = _streams[i];
        return (s.rate, s.perShare, s.queued, s.harvested, s.paid, s.periodFinish);
    }

    /// @dev What the running period has not yet credited to shares (rate carries 1e36). With no shares, time since the
    /// last update is still unstreamed (it goes to `queued` on the next update).
    function scheduledLeft(uint256 i) external view returns (uint256) {
        Stream storage s = _streams[i];
        uint256 from = totalShares == 0 || block.timestamp < s.lastUpdate ? s.lastUpdate : block.timestamp;
        return from < s.periodFinish ? s.rate * (s.periodFinish - from) / 1e36 : 0;
    }
}

/// @dev Shared setup. The hook registers ORRY/ETH and ORRY/USDG at construction; `kind()` picks the hub under test:
/// native ETH (always currency0), a 6-decimal USDG below ORRY's address (ORRY is currency1) or above it (ORRY is
/// currency0). Test amounts are written in ETH terms and scaled to the quote by `q()`; every hub opens at the same
/// ORRY price (4,000,000 ORRY per ETH, 3,000 USDG per ETH), so ORRY amounts mean the same in every hub.
abstract contract EarnBase is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    enum Kind {
        ETH,
        USDG_LOW,
        USDG_HIGH
    }

    IPoolManager internal constant PM = IPoolManager(PoolManagerCode.ADDRESS);
    uint160 internal constant FLAGS = 0x10C4;
    uint24 internal constant LP_FEE = 8500;
    uint24 internal constant PROTOCOL_FEE = 1500;
    int24 internal constant TS = 200;
    int24 internal constant LOWER = -887200;
    int24 internal constant UPPER = 887200;
    address internal constant ORRY_AT = address(uint160(1) << 159 | 0xAA1); // 0x8000...0aa1
    address internal constant USDG_LOW = address(uint160(1) << 156 | 0xBB2); // 0x1000...0bb2, below ORRY
    address internal constant USDG_HIGH = address(uint160(0xF) << 156 | 0xCC3); // 0xf000...0cc3, above ORRY
    uint256 internal constant ORRY_PER_ETH = 4e6;
    uint256 internal constant USDG_PER_ETH = 3000e6; // USDG units per 1e18 wei
    int256 internal constant ETH_USD = 3000e8;

    MockOrry internal orry;
    MockUsdg internal usdg;
    MockFeed internal ethFeed;
    MockTreasury internal treasury;
    MockRouter internal router;
    OrreryHook internal hook;
    EarnVaultHarness internal vault;
    MockRegistry internal registry;
    MockStaking internal staking;
    EarnVaultFactory internal factory;
    ClaimAll internal claimAll;
    OrryLens internal lens;
    HubActor internal trader;
    PoolKey internal key;
    PoolId internal poolId;

    address internal quote; // the hub under test, address 0 for native ETH
    bool internal isEth;
    bool internal orryIs0;
    uint256 internal quotePerEth;

    address internal admin = makeAddr("pairAdmin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function kind() internal view virtual returns (Kind) {
        return Kind.ETH;
    }

    /// @dev Where the USDG stand-in lives: above ORRY's address for the USDG_HIGH kind, below it otherwise.
    function usdgAt() internal view virtual returns (address) {
        return kind() == Kind.USDG_HIGH ? USDG_HIGH : USDG_LOW;
    }

    function setUp() public virtual {
        vm.etch(address(PM), PoolManagerCode.RUNTIME);
        deployCodeTo("EarnMocks.sol:MockOrry", ORRY_AT);
        orry = MockOrry(ORRY_AT);
        address at = usdgAt();
        deployCodeTo("EarnMocks.sol:MockUsdg", at);
        usdg = MockUsdg(at);
        ethFeed = new MockFeed(ETH_USD);
        treasury = new MockTreasury(admin);
        router = new MockRouter();
        hook = deployHook(address(router), hookAddress(1));

        isEth = kind() == Kind.ETH;
        quote = isEth ? address(0) : address(usdg);
        quotePerEth = isEth ? 1e18 : USDG_PER_ETH;
        orryIs0 = hook.pairOf(quote).orryIsCurrency0;
        vault = new EarnVaultHarness(address(hook), quote);
        registry = new MockRegistry();
        staking = new MockStaking(orry, address(registry));
        factory = new EarnVaultFactory(address(hook));
        claimAll = new ClaimAll(address(factory), address(staking));
        lens = new OrryLens(address(factory), address(staking));
        trader = new HubActor(PM);
        key = hook.hubKey(quote);
        poolId = key.toId();
        PM.initialize(key, openingSqrtPrice(quote));

        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vm.deal(users[i], 1_000 ether);
            orry.transfer(users[i], 2e26);
            usdg.mint(users[i], 1e15);
            vm.startPrank(users[i]);
            orry.approve(address(vault), type(uint256).max);
            usdg.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
        vm.deal(address(trader), 1_000 ether);
        orry.transfer(address(trader), 2e26);
        usdg.mint(address(trader), 1e15);
    }

    function hookAddress(uint256 salt) internal pure returns (address) {
        return address((uint160(uint256(keccak256(abi.encode("orrery.hook", salt)))) & ~uint160(0x3FFF)) | FLAGS);
    }

    function deployHook(address router_, address where) internal returns (OrreryHook) {
        deployCodeTo(
            "OrreryHook.sol:OrreryHook",
            abi.encode(
                address(PM),
                address(orry),
                router_,
                address(treasury),
                LP_FEE,
                PROTOCOL_FEE,
                TS,
                address(usdg),
                address(ethFeed)
            ),
            where
        );
        return OrreryHook(where);
    }

    /// @dev The opening price of the `q_` hub: 4,000,000 ORRY per ETH, 3,000 USDG per ETH, in the pool's orientation.
    function openingSqrtPrice(address q_) internal view returns (uint160) {
        return openingSqrtPrice(q_, q_ == address(0) ? 1e18 : USDG_PER_ETH);
    }

    /// @dev Opening price for a quote worth `perEth` of its units per ETH.
    function openingSqrtPrice(address q_, uint256 perEth) internal view returns (uint160) {
        bool r0 = hook.pairOf(q_).orryIsCurrency0;
        uint256 priceX192 = r0
            ? FullMath.mulDiv(perEth, 1 << 192, ORRY_PER_ETH * 1e18)
            : FullMath.mulDiv(ORRY_PER_ETH * 1e18, 1 << 192, perEth);
        return uint160(Math.sqrt(priceX192));
    }

    // ---------------------------------------------------------------- amounts

    /// @dev An amount written in ETH terms, in units of the quote under test.
    function q(uint256 ethWei) internal view returns (uint256) {
        return ethWei * quotePerEth / 1e18;
    }

    /// @dev ORRY worth `quoteAmount` at the current price.
    function orryFor(uint256 quoteAmount) internal view returns (uint256) {
        uint160 p = sqrtPrice();
        if (orryIs0) return FullMath.mulDiv(FullMath.mulDiv(quoteAmount, 1 << 96, p), 1 << 96, p);
        return FullMath.mulDiv(FullMath.mulDiv(quoteAmount, p, 1 << 96), p, 1 << 96);
    }

    function quoteBalance(address a) internal view returns (uint256) {
        return isEth ? a.balance : usdg.balanceOf(a);
    }

    function giveQuote(address a, uint256 amount) internal {
        if (isEth) vm.deal(a, a.balance + amount);
        else usdg.mint(a, amount);
    }

    /// @dev (quote, ORRY) in the pool's currency order.
    function toPool(uint256 qa, uint256 ra) internal view returns (uint256, uint256) {
        return orryIs0 ? (ra, qa) : (qa, ra);
    }

    // ---------------------------------------------------------------- actions

    function deposit(address user, uint256 quoteAmount, uint256 orryMax) internal returns (uint256) {
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(user);
        return vault.deposit{value: isEth ? quoteAmount : 0}(quoteAmount, orryMax, 0, 0, type(uint160).max, ts);
    }

    /// @dev A balanced deposit at the current price: `ethEq` of quote and enough ORRY (plus 1%).
    function depositBalanced(address user, uint256 ethEq) internal returns (uint256) {
        uint256 qa = q(ethEq);
        return deposit(user, qa, orryFor(qa) * 101 / 100);
    }

    function zap(address user, bool fromQuote, uint256 amountIn, uint256 minSwapOut, uint256 minShares)
        internal
        returns (uint256)
    {
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(user);
        return vault.zapDeposit{value: fromQuote && isEth ? amountIn : 0}(fromQuote, amountIn, minSwapOut, minShares, 0, type(uint160).max, ts);
    }

    /// @dev Exact-input swaps through the hub under test.
    function sellQuote(uint256 amount) internal {
        trader.swap(key, !orryIs0, -int256(amount));
    }

    function sellOrry(uint256 amount) internal {
        trader.swap(key, orryIs0, -int256(amount));
    }

    /// @dev Raw swap in pool terms (zeroForOne, v4 sign convention).
    function swap(bool zeroForOne, int256 amountSpecified) internal {
        trader.swap(key, zeroForOne, amountSpecified);
    }

    // ---------------------------------------------------------------- reads

    function positionLiquidity() internal view returns (uint128 liq) {
        (liq,,) = PM.getPositionInfo(poolId, address(vault), LOWER, UPPER, bytes32(0));
    }

    function claims(address owner, address currency) internal view returns (uint256) {
        return PM.balanceOf(owner, uint256(uint160(currency)));
    }

    function sqrtPrice() internal view returns (uint160 p) {
        (p,,,) = PM.getSlot0(poolId);
    }

    /// @dev Cheatcode reads: with via-IR, `block.timestamp` and `block.number` in a test body can be stale after a
    /// warp or roll.
    function wait(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    function nextBlock() internal {
        vm.roll(vm.getBlockNumber() + 1);
    }
}
