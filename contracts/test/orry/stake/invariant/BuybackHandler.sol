// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {OrryBuyback} from "../../../../src/orry/OrryBuyback.sol";
import {OrryRewardsRouter} from "../../../../src/orry/OrryRewardsRouter.sol";
import {OrreryTreasury} from "../../../../src/orry/OrreryTreasury.sol";
import {MockERC20} from "../../../mocks/Mocks.sol";
import {MockOrry} from "../utils/StakeMocks.sol";
import {TestHubHook} from "../utils/TestHubHook.sol";

/// @notice Bounded handler for OrryBuyback on a local PoolManager with two hubs (B-1 to B-3 per hub, P-5, the slice
/// route rule, G-2): slices on either route, ETH burns and USDG-hub buys between traders moving every pool, liquidity
/// moving in and out of the USDG hub (so the route flips), hook fee collection, quote fees and router distribution.
contract BuybackHandler is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    OrryBuyback public buyback;
    OrreryTreasury public treasury;
    OrryRewardsRouter public router;
    TestHubHook public hook;
    IPoolManager public pm;
    PoolSwapTest public swapRouter;
    MockERC20 public usdg;
    MockOrry public orry;
    PoolKey internal _usdgKey;
    PoolKey internal _hubKey;
    PoolKey internal _usdgHubKey;
    PoolModifyLiquidityTest public lpRouter;
    MockERC20 public stray; // a token that is not a quote, sent to the router at the start (P-5: never moves)
    uint256 public usdgHubLiquidity;

    uint256 public lastSupply;
    uint256 public ghostLastSlice;
    uint256 public ghostLastBurn;
    uint256 public usdgSpent;
    uint256 public orryToRouter;
    uint256 public orryBurnedByBuyback;
    uint256 public maxHop1MovePpm;
    uint256 public maxHubMovePpm;
    uint256 public maxUsdgHubMovePpm;
    uint256 public ghostQuoteHeld; // USDG the router forwarded to the buyback and buyWithQuote has not spent
    uint256 public ghostLastQuoteBuy;
    uint256 public directSlices;
    uint256 public ethPathSlices;
    uint256 public quoteBuys;
    uint256 public quoteForwarded;

    bool public badB1;
    bool public badB2;
    bool public badB3;
    bool public badSupplyUp;
    bool public badP5;
    bool public badRoute;

    mapping(bytes32 => uint256) public calls;

    uint256 internal _now;
    uint256 internal _block;

    constructor(
        OrryBuyback b,
        OrreryTreasury t,
        OrryRewardsRouter r,
        TestHubHook h,
        IPoolManager pm_,
        PoolSwapTest sr,
        MockERC20 u,
        MockOrry rc,
        PoolKey memory usdgKey,
        PoolKey memory hubKey,
        PoolKey memory usdgHubKey,
        PoolModifyLiquidityTest lp,
        uint256 liquidity,
        uint256 start
    ) {
        buyback = b;
        treasury = t;
        router = r;
        hook = h;
        pm = pm_;
        swapRouter = sr;
        usdg = u;
        orry = rc;
        _usdgKey = usdgKey;
        _hubKey = hubKey;
        _usdgHubKey = usdgHubKey;
        lpRouter = lp;
        usdgHubLiquidity = liquidity;
        _now = start;
        _block = block.number;
        lastSupply = rc.totalSupply();
    }

    function init() external {
        usdg.approve(address(swapRouter), type(uint256).max);
        orry.approve(address(swapRouter), type(uint256).max);
        usdg.approve(address(lpRouter), type(uint256).max);
        orry.approve(address(lpRouter), type(uint256).max);
        stray = new MockERC20("Stray", "STR", 18);
        stray.mint(address(router), 1e18);
    }

    function _usdgIs0() internal view returns (bool) {
        return Currency.unwrap(_usdgHubKey.currency0) == address(usdg);
    }

    /// @dev Independent caps (B-1): 0.5 x fee x the input side's virtual reserve.
    function _reserveIn(PoolKey memory key, bool zeroForOne) internal view returns (uint256) {
        (uint160 sp,,,) = pm.getSlot0(key.toId());
        uint128 l = pm.getLiquidity(key.toId());
        if (sp == 0 || l == 0) return 0;
        return zeroForOne ? FullMath.mulDiv(l, 2 ** 96, sp) : FullMath.mulDiv(l, sp, 2 ** 96);
    }

    function _usdgHubCap() internal view returns (uint256) {
        return _reserveIn(_usdgHubKey, _usdgIs0()) * 10_000 / 2e6;
    }

    function _ethPathCap() internal view returns (uint256) {
        uint256 cap1 = _reserveIn(_usdgKey, false) * 500 / 2e6;
        uint160 sp = _sqrtP(_usdgKey);
        uint256 hubEth = _reserveIn(_hubKey, true) * 10_000 / 2e6;
        uint256 hubUsdg = FullMath.mulDiv(FullMath.mulDiv(hubEth, sp, 2 ** 96), sp, 2 ** 96);
        return cap1 < hubUsdg ? cap1 : hubUsdg;
    }

    function _count(bytes32 k) internal {
        calls[k] += 1;
    }

    function _sqrtP(PoolKey memory key) internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(key.toId());
    }

    function _movePpm(uint160 pre, uint160 post) internal pure returns (uint256) {
        uint256 d = post > pre ? post - pre : pre - post;
        return d * 1e6 / pre;
    }

    function _checkSupply() internal {
        uint256 s = orry.totalSupply();
        if (s > lastSupply) badSupplyUp = true;
        lastSupply = s;
    }

    // ---------------------------------------------------------------- actions

    function revenue(uint256 amount) public {
        amount = _bound(amount, 1e6, 20_000e6);
        usdg.mint(address(treasury), amount);
        _count("revenue");
    }

    function slice() public {
        uint160 p1 = _sqrtP(_usdgKey);
        uint160 p2 = _sqrtP(_hubKey);
        uint160 p3 = _sqrtP(_usdgHubKey);
        uint256 routerRc = orry.balanceOf(address(router));
        uint256 sinkRc = _sinkBalance();
        uint256 treasuryUsdg = usdg.balanceOf(address(treasury));
        uint256 heldUsdg = usdg.balanceOf(address(buyback));
        // the route rule, from the spec text: direct when the USDG hub's cap is at least the ETH path's
        uint256 directCap = _usdgHubCap();
        bool expectDirect = directCap != 0 && directCap >= _ethPathCap();
        if (buyback.sliceViaUsdgHub() != expectDirect) badRoute = true;
        try buyback.executeSlice() returns (uint256 out) {
            if (ghostLastSlice != 0 && _now < ghostLastSlice + 1 hours) badB1 = true;
            ghostLastSlice = _now;
            uint256 spent = treasuryUsdg - usdg.balanceOf(address(treasury));
            if (spent > 1_000e6) badB1 = true; // maxSliceUsdgCap on both routes
            if (expectDirect) {
                // one hop in the USDG hub; hop 1 and the ETH hub untouched
                if (_sqrtP(_usdgKey) != p1 || _sqrtP(_hubKey) != p2) badRoute = true;
                if (spent > directCap) badB1 = true;
                uint256 m3 = _movePpm(p3, _sqrtP(_usdgHubKey));
                if (m3 > 5000) badB2 = true;
                if (m3 > maxUsdgHubMovePpm) maxUsdgHubMovePpm = m3;
                directSlices += 1;
            } else {
                if (p3 != 0 && _sqrtP(_usdgHubKey) != p3) badRoute = true;
                uint256 m1 = _movePpm(p1, _sqrtP(_usdgKey));
                uint256 m2 = _movePpm(p2, _sqrtP(_hubKey));
                // half of the pool fee in ppm of sqrtPrice: 500 / 2 and (8500 + 1500) / 2
                if (m1 > 250 || m2 > 5000) badB2 = true;
                if (m1 > maxHop1MovePpm) maxHop1MovePpm = m1;
                if (m2 > maxHubMovePpm) maxHubMovePpm = m2;
                ethPathSlices += 1;
            }
            if (!_splitOk(out, routerRc, sinkRc)) badB3 = true;
            // the slice spends only what it pulled: the quote USDG held for buyWithQuote is untouched (P-5)
            if (usdg.balanceOf(address(buyback)) != heldUsdg || orry.balanceOf(address(buyback)) != 0) badB3 = true;
            usdgSpent += spent;
            orryToRouter += out;
            _count("slice");
        } catch (bytes memory err) {
            _countRevert(err);
        }
        _checkSupply();
    }

    /// @dev R-37: the buyback spends the USDG the router forwarded, in the USDG hub only, at most that hop's cap.
    function buyUsdg() public {
        uint160 p1 = _sqrtP(_usdgKey);
        uint160 p2 = _sqrtP(_hubKey);
        uint160 p3 = _sqrtP(_usdgHubKey);
        uint256 cap = _usdgHubCap();
        uint256 held = usdg.balanceOf(address(buyback));
        uint256 routerRc = orry.balanceOf(address(router));
        uint256 sinkRc = _sinkBalance();
        try buyback.buyWithQuote(address(usdg)) returns (uint256 out) {
            if (ghostLastQuoteBuy != 0 && _now < ghostLastQuoteBuy + 1 hours) badB1 = true;
            ghostLastQuoteBuy = _now;
            uint256 spent = held - usdg.balanceOf(address(buyback));
            if (spent > cap || spent != (held < cap ? held : cap)) badB1 = true;
            uint256 m3 = _movePpm(p3, _sqrtP(_usdgHubKey));
            if (m3 > 5000) badB2 = true;
            if (m3 > maxUsdgHubMovePpm) maxUsdgHubMovePpm = m3;
            if (_sqrtP(_usdgKey) != p1 || _sqrtP(_hubKey) != p2) badP5 = true; // its own hub only
            if (!_splitOk(out, routerRc, sinkRc) || orry.balanceOf(address(buyback)) != 0) badB3 = true;
            ghostQuoteHeld -= spent;
            quoteBuys += 1;
            _count("buyUsdg");
        } catch (bytes memory err) {
            _countRevert(err);
        }
        _checkSupply();
    }

    // ---------------------------------------------------------------- cashback sink (B-1)

    address public constant SINK = address(0xCA5B);
    uint256 public cashbackPaid;

    function _sinkBalance() internal view returns (uint256) {
        return orry.balanceOf(SINK);
    }

    /// @dev B-1: once the sink is set it gets floor(out * CASHBACK_BPS / 1e4) and the router the rest; before, the router
    /// gets all of it.
    function _splitOk(uint256 out, uint256 routerBefore, uint256 sinkBefore) internal returns (bool) {
        uint256 cb = buyback.cashbackSink() == address(0) ? 0 : out * buyback.CASHBACK_BPS() / 10_000;
        cashbackPaid += cb;
        return orry.balanceOf(address(router)) - routerBefore == out - cb && _sinkBalance() - sinkBefore == cb;
    }

    /// @dev The treasury owner proposes the sink, and executes it once the delay has passed.
    function cashbackSink() public {
        if (buyback.cashbackSink() != address(0)) return;
        address o = treasury.owner();
        (address p, uint64 at) = buyback.pendingCashbackSink();
        vm.startPrank(o);
        if (p == address(0)) {
            buyback.proposeCashbackSink(SINK);
            _count("sinkProposed");
        } else if (_now >= at) {
            buyback.executeCashbackSink();
            _count("sinkSet");
        }
        vm.stopPrank();
    }

    /// @dev Hub fees in USDG reaching the router (as the hook's collect would pay them).
    function quoteFee(uint256 amount) public {
        amount = _bound(amount, 1, 2_000e6);
        usdg.mint(address(router), amount);
        _count("quoteFee");
    }

    function tradeUsdgHub(bool usdgIn, uint256 amount) public {
        if (_sqrtP(_usdgHubKey) == 0) return;
        bool zeroForOne = usdgIn == _usdgIs0();
        if (usdgIn) {
            amount = _bound(amount, 1e6, 5_000e6);
            usdg.mint(address(this), amount);
        } else {
            amount = _bound(amount, 1e18, 2_000_000e18);
            if (orry.balanceOf(address(this)) < amount) return;
        }
        swapRouter.swap(
            _usdgHubKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        _count("tradeUsdgHub");
    }

    /// @dev LPs come and go in the USDG hub between 1e18 and 6e18 of liquidity, so the slice route flips.
    function usdgHubLp(bool add) public {
        if (_sqrtP(_usdgHubKey) == 0) return;
        int256 delta;
        if (add && usdgHubLiquidity <= 5e18) delta = 1e18;
        else if (!add && usdgHubLiquidity >= 2e18) delta = -1e18;
        else return;
        usdg.mint(address(this), 200_000e6);
        lpRouter.modifyLiquidity(
            _usdgHubKey,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(200),
                tickUpper: TickMath.maxUsableTick(200),
                liquidityDelta: delta,
                salt: 0
            }),
            ""
        );
        usdgHubLiquidity = delta > 0 ? usdgHubLiquidity + 1e18 : usdgHubLiquidity - 1e18;
        _count("usdgHubLp");
    }

    function burn() public {
        uint160 p = _sqrtP(_hubKey);
        uint256 supply = orry.totalSupply();
        try buyback.burnEth() returns (uint256 burned) {
            if (ghostLastBurn != 0 && _now < ghostLastBurn + 1 hours) badB1 = true;
            ghostLastBurn = _now;
            uint256 m = _movePpm(p, _sqrtP(_hubKey));
            if (m > 5000) badB2 = true;
            if (m > maxHubMovePpm) maxHubMovePpm = m;
            if (supply - orry.totalSupply() != burned || orry.balanceOf(address(buyback)) != 0) badB3 = true;
            if (_sinkBalance() != cashbackPaid) badB3 = true; // burnEth pays no cashback
            orryBurnedByBuyback += burned;
            _count("burn");
        } catch (bytes memory err) {
            _countRevert(err);
        }
        _checkSupply();
    }

    function sendEth(uint256 amount) public {
        amount = _bound(amount, 1, 2 ether);
        vm.deal(address(this), address(this).balance + amount);
        (bool ok,) = address(buyback).call{value: amount}("");
        require(ok);
        _count("sendEth");
    }

    function trade(bool hub, bool zeroForOne, uint256 amount) public {
        PoolKey memory key = hub ? _hubKey : _usdgKey;
        if (zeroForOne) {
            amount = _bound(amount, 1e12, hub ? 3 ether : 15 ether);
            vm.deal(address(this), address(this).balance + amount);
        } else {
            amount = _bound(amount, 1e6, hub ? 3_000_000e18 : 30_000e6);
            if (hub && orry.balanceOf(address(this)) < amount) return;
            if (!hub) usdg.mint(address(this), amount);
        }
        swapRouter.swap{value: zeroForOne ? amount : 0}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        _count(hub ? bytes32("tradeHub") : bytes32("tradeUsdg"));
    }

    function collectDistribute() public {
        hook.collect();
        uint256 supply = orry.totalSupply();
        uint256 routerUsdg = usdg.balanceOf(address(router));
        uint256 buybackUsdg = usdg.balanceOf(address(buyback));
        try router.distribute() {
            _count("distribute");
            // P-5: the whole quote balance moved to the buyback and nowhere else
            if (usdg.balanceOf(address(router)) != 0) badP5 = true;
            if (usdg.balanceOf(address(buyback)) - buybackUsdg != routerUsdg) badP5 = true;
            ghostQuoteHeld += routerUsdg;
            if (routerUsdg != 0) quoteForwarded += 1;
        } catch {}
        if (stray.balanceOf(address(router)) != 1e18) badP5 = true;
        if (orry.totalSupply() > supply) badSupplyUp = true;
        _checkSupply();
    }

    function warp(uint256 secs, uint256 blocks) public {
        secs = _bound(secs, 1, 3 hours);
        blocks = _bound(blocks, 0, 3);
        _now += secs;
        _block += blocks;
        vm.warp(_now);
        vm.roll(_block);
        _count("warp");
    }

    function _countRevert(bytes memory err) internal {
        bytes4 sel = err.length >= 4 ? bytes4(err) : bytes4(0);
        if (sel == bytes4(keccak256("TooSoon(uint64)"))) _count("tooSoon");
        else if (sel == bytes4(keccak256("PriceMovedInBlock()"))) _count("movedInBlock");
        else if (sel == bytes4(keccak256("NothingToBuy()"))) _count("nothingToBuy");
        else if (sel == bytes4(keccak256("SlippageExceeded()"))) _count("slippage");
        else if (sel == bytes4(keccak256("NotAQuote()"))) _count("notAQuote");
        else _count("otherRevert");
    }

    receive() external payable {}
}
