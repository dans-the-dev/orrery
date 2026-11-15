// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IEarnVault} from "../../../src/orry/interfaces/IEarnVault.sol";
import {EarnVault} from "../../../src/orry/EarnVault.sol";
import {OrreryHook} from "../../../src/orry/OrreryHook.sol";
import {EarnBase, EarnVaultHarness} from "./EarnBase.sol";
import {CallbackAttacker, EthRefuser, ReentrantDepositor} from "./mocks/EarnMocks.sol";

contract EarnVaultTest is EarnBase {
    using StateLibrary for IPoolManager;

    uint256 internal constant WEEK = 7 days;

    event Deposited(address indexed account, uint256 quoteIn, uint256 orryIn, uint256 shares, uint64 unlockAt);
    event Withdrawn(address indexed account, uint256 shares, uint256 quoteOut, uint256 orryOut);
    event FeesHarvested(uint256 quoteAmount, uint256 orryAmount, uint64 periodFinish);
    event FeesClaimed(address indexed account, address indexed caller, uint256 quoteAmount, uint256 orryAmount);
    event RewardsNotified(address indexed from, uint256 orryAmount);

    uint160 internal sqrtLo;
    uint160 internal sqrtHi;

    function setUp() public override {
        super.setUp();
        sqrtLo = TickMath.getSqrtPriceAtTick(LOWER);
        sqrtHi = TickMath.getSqrtPriceAtTick(UPPER);
    }

    function _expectedLiquidity(uint256 qa, uint256 rc) internal view returns (uint128) {
        (uint256 a0, uint256 a1) = toPool(qa, rc);
        return LiquidityAmounts.getLiquidityForAmounts(sqrtPrice(), sqrtLo, sqrtHi, a0, a1);
    }

    /// @dev Round trips through the hub so the position earns LP fees in both currencies.
    function _trade(uint256 rounds) internal {
        for (uint256 i; i < rounds; ++i) {
            sellQuote(q(1 ether));
            sellOrry(4e24);
        }
    }

    /// @dev Deposit with an explicit `msg.value`, for the value checks.
    function _rawDeposit(uint256 value, uint256 quoteMax, uint256 orryMax, uint256 minShares, uint256 deadline)
        internal
        returns (uint256)
    {
        return vault.deposit{value: value}(quoteMax, orryMax, minShares, 0, type(uint160).max, deadline);
    }

    function _rawZap(uint256 value, bool fromQuote, uint256 amountIn, uint256 minOut, uint256 minShares, uint256 dl)
        internal
        returns (uint256)
    {
        return vault.zapDeposit{value: value}(fromQuote, amountIn, minOut, minShares, 0, type(uint160).max, dl);
    }

    /// @dev The value a correct deposit of `amount` quote sends.
    function _v(uint256 amount) internal view returns (uint256) {
        return isEth ? amount : 0;
    }

    function _fundedHarvest() internal returns (uint256 f0, uint256 f1) {
        _trade(3);
        (f0, f1) = vault.harvest();
    }

    // ---------------------------------------------------------------- views and wiring

    function test_wiring_and_constants() public view {
        assertEq(vault.hook(), address(hook));
        assertEq(vault.orry(), address(orry));
        assertEq(vault.quote(), quote);
        assertEq(vault.DEPOSIT_LOCK(), 15 minutes);
        assertEq(vault.STREAM_PERIOD(), 7 days);
        assertEq(vault.MAX_BLOCK_MOVE_BPS(), 100);
        assertEq(vault.totalShares(), 0);
        (uint256 e, uint256 r) = vault.positionAmounts();
        assertEq(e + r, 0);
        (e, r) = vault.previewWithdraw(0);
        assertEq(e + r, 0);
    }

    function test_views_before_hub_initialized() public {
        OrreryHook fresh = deployHook(address(router), hookAddress(5));
        EarnVault v = new EarnVault(address(fresh), quote);
        (uint256 e, uint256 r) = v.previewWithdraw(1e18);
        assertEq(e + r, 0);
        (e, r) = v.harvest();
        assertEq(e + r, 0);
        uint256 qa = q(1 ether);
        vm.prank(alice);
        vm.expectRevert(IEarnVault.HubNotInitialized.selector);
        v.deposit{value: _v(qa)}(qa, 1e24, 0, 0, type(uint160).max, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(IEarnVault.HubNotInitialized.selector);
        v.zapDeposit{value: _v(qa)}(true, qa, 0, 0, 0, type(uint160).max, block.timestamp);
    }

    /// @dev try/catch rather than expectRevert before `new` (forge isolate mode); the reason is checked too.
    function test_constructor_rejects_an_unknown_quote() public {
        bytes memory reason;
        try new EarnVault(address(hook), address(orry)) {
            fail();
        } catch (bytes memory r) {
            reason = r;
        }
        assertEq(reason, abi.encodeWithSignature("UnknownPair()"), "UnknownPair from the hook");
    }

    function test_unlockCallback_and_receive_only_from_pool_manager() public {
        vm.expectRevert();
        vault.unlockCallback(abi.encode(uint8(2), uint256(0), uint256(0), uint256(1), uint256(0), false, uint256(0)));
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok, "plain ETH sends are refused (every vault)");
    }

    // ---------------------------------------------------------------- deposit

    function test_deposit_mints_liquidity_units_and_refunds() public {
        uint256 qa = q(10 ether);
        uint256 orryMax = orryFor(qa) * 2;
        uint128 expected = _expectedLiquidity(qa, orryMax);
        uint256 qBefore = quoteBalance(alice);
        uint256 rBefore = orry.balanceOf(alice);

        vm.expectEmit(true, false, false, false, address(vault));
        emit Deposited(alice, 0, 0, expected, uint64(block.timestamp + 15 minutes));
        vm.prank(alice);
        uint256 shares = _rawDeposit(_v(qa), qa, orryMax, expected, block.timestamp);

        assertEq(shares, expected, "shares are liquidity units");
        assertEq(positionLiquidity(), shares);
        assertEq(vault.totalShares(), shares);
        assertEq(vault.sharesOf(alice), shares);
        assertEq(vault.unlockAt(alice), vm.getBlockTimestamp() + 15 minutes);
        uint256 quoteUsed = qBefore - quoteBalance(alice);
        uint256 orryUsed = rBefore - orry.balanceOf(alice);
        assertLe(quoteUsed, qa);
        assertGt(quoteUsed, qa - qa / 1e6 - 2, "the quote is the limiting side");
        assertApproxEqRel(orryUsed, orryMax / 2, 1e15, "the unused ORRY came back");
        (uint256 pq, uint256 pr) = vault.positionAmounts();
        assertApproxEqAbs(pq, quoteUsed, 2);
        assertApproxEqAbs(pr, orryUsed, 2);
        assertEq(quoteBalance(address(vault)), 0, "vault keeps nothing");
        assertEq(orry.balanceOf(address(vault)), 0);
    }

    function test_deposit_orry_limited_refunds_quote() public {
        uint256 qBefore = quoteBalance(alice);
        uint256 rc = orryFor(q(5 ether));
        deposit(alice, q(10 ether), rc);
        assertApproxEqRel(qBefore - quoteBalance(alice), q(5 ether), 1e15, "half the quote came back");
        assertEq(quoteBalance(address(vault)), 0);
    }

    function test_deposit_reverts() public {
        uint256 qa = q(1 ether);
        vm.startPrank(alice);
        vm.expectRevert(IEarnVault.DeadlinePassed.selector);
        _rawDeposit(_v(qa), qa, 1e25, 0, block.timestamp - 1);
        vm.expectRevert(IEarnVault.ZeroAmount.selector);
        _rawDeposit(0, 0, 1e25, 0, block.timestamp);
        vm.expectRevert(IEarnVault.ZeroAmount.selector);
        _rawDeposit(_v(qa), qa, 0, 0, block.timestamp);
        uint128 expected = _expectedLiquidity(qa, 1e25);
        vm.expectRevert(IEarnVault.SlippageExceeded.selector);
        _rawDeposit(_v(qa), qa, 1e25, uint256(expected) + 1, block.timestamp);
        vm.expectRevert(IEarnVault.ZeroAmount.selector); // amounts too small for one liquidity unit
        _rawDeposit(_v(1), 1, 1, 0, block.timestamp);
        vm.stopPrank();
    }

    /// @dev Native vault: `msg.value == quoteMax`; ERC-20 vault: `msg.value == 0`.
    function test_deposit_value_mismatch_reverts() public {
        uint256 qa = q(1 ether);
        vm.startPrank(alice);
        vm.expectRevert(IEarnVault.ValueMismatch.selector);
        _rawDeposit(isEth ? qa - 1 : 1, qa, 1e25, 0, block.timestamp);
        if (isEth) {
            vm.expectRevert(IEarnVault.ValueMismatch.selector);
            _rawDeposit(qa + 1, qa, 1e25, 0, block.timestamp);
        }
        vm.stopPrank();
    }

    function test_deposit_at_deadline_is_accepted() public {
        uint256 qa = q(1 ether);
        vm.prank(alice);
        assertGt(_rawDeposit(_v(qa), qa, 1e25, 0, block.timestamp), 0);
    }

    // ---------------------------------------------------------------- zap

    function test_zap_from_quote() public {
        depositBalanced(bob, 20 ether);
        uint256 qa = q(2 ether);
        uint256 qBefore = quoteBalance(alice);
        uint256 rBefore = orry.balanceOf(alice);
        uint256 hookClaims = claims(address(hook), address(orry));
        uint256 shares = zap(alice, true, qa, 1, 1);
        assertGt(shares, 0);
        assertGt(claims(address(hook), address(orry)), hookClaims, "the zap swap paid the hook fee");
        assertLe(qBefore - quoteBalance(alice), qa);
        assertGe(orry.balanceOf(alice), rBefore, "never pulls ORRY on a quote zap");
        // review M-1: the LP fee of the zap's own swap stays in the vault, streaming to the existing LPs (bob holds the
        // only position), instead of going back to the zapper
        assertApproxEqRel(quoteBalance(address(vault)), qa / 2 * uint256(hook.LP_FEE()) / 1e6, 0.01e18, "the zap's LP fee is streamed");
        assertEq(orry.balanceOf(address(vault)), 0);
        assertEq(positionLiquidity(), vault.totalShares());
        // about 2 ETH of value in liquidity: close to a 1 ETH balanced deposit's liquidity
        assertApproxEqRel(shares, _expectedLiquidity(q(1 ether), type(uint128).max / 2), 0.03e18);
    }

    function test_zap_from_orry() public {
        depositBalanced(bob, 20 ether);
        uint256 amount = orryFor(q(2 ether));
        uint256 qBefore = quoteBalance(alice);
        uint256 rBefore = orry.balanceOf(alice);
        uint256 shares = zap(alice, false, amount, 1, 1);
        assertGt(shares, 0);
        assertLe(rBefore - orry.balanceOf(alice), amount);
        assertGe(quoteBalance(alice), qBefore, "never takes the quote on an ORRY zap");
        assertGt(claims(address(hook), quote), 0);
        assertEq(quoteBalance(address(vault)), 0);
        assertApproxEqRel(orry.balanceOf(address(vault)), amount / 2 * uint256(hook.LP_FEE()) / 1e6, 0.01e18, "the zap's LP fee is streamed (M-1)");
    }

    function test_zap_reverts() public {
        depositBalanced(bob, 20 ether);
        uint256 qa = q(1 ether);
        vm.startPrank(alice);
        vm.expectRevert(IEarnVault.DeadlinePassed.selector);
        _rawZap(_v(qa), true, qa, 0, 0, block.timestamp - 1);
        vm.expectRevert(IEarnVault.ZeroAmount.selector);
        _rawZap(_v(1), true, 1, 0, 0, block.timestamp);
        vm.expectRevert(IEarnVault.ValueMismatch.selector); // value does not match amountIn
        _rawZap(isEth ? qa / 2 : 1, true, qa, 0, 0, block.timestamp);
        vm.expectRevert(IEarnVault.ValueMismatch.selector); // value sent with an ORRY zap
        _rawZap(1, false, 1e24, 0, 0, block.timestamp);
        uint256 spot = orryFor(qa / 2);
        vm.expectRevert(IEarnVault.SlippageExceeded.selector); // minSwapOut above what half of the quote buys
        _rawZap(_v(qa), true, qa, spot, 0, block.timestamp);
        vm.expectRevert(IEarnVault.SlippageExceeded.selector); // minShares
        _rawZap(_v(qa), true, qa, 0, type(uint128).max, block.timestamp);
        vm.stopPrank();
    }

    function test_zap_same_block_guard() public {
        depositBalanced(bob, 20 ether);
        nextBlock();
        sellQuote(q(0.2 ether)); // about 2% price move inside this block
        uint256 qa = q(1 ether);
        vm.prank(alice);
        vm.expectRevert(IEarnVault.PriceMovedInBlock.selector);
        _rawZap(_v(qa), true, qa, 0, 0, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(IEarnVault.PriceMovedInBlock.selector);
        _rawZap(0, false, 4e24, 0, 0, block.timestamp);

        nextBlock(); // next block: the moved price is the new start
        assertGt(zap(alice, true, qa, 0, 0), 0);
    }

    function test_zap_small_move_in_block_passes() public {
        depositBalanced(bob, 20 ether);
        nextBlock();
        sellQuote(q(0.02 ether)); // about 0.2%
        assertGt(zap(alice, true, q(0.2 ether), 0, 0), 0);
        nextBlock();
        sellOrry(8e22); // about 0.2% the other way
        assertGt(zap(alice, false, 8e23, 0, 0), 0);
    }

    /// @dev Price move in percent (1e18 = 100%) between two sqrt prices.
    function _movePct(uint160 from, uint160 to) internal pure returns (uint256) {
        uint256 a = uint256(from) * uint256(from) / (1 << 96);
        uint256 b = uint256(to) * uint256(to) / (1 << 96);
        return a > b ? (a - b) * 1e18 / a : (b - a) * 1e18 / a;
    }

    function test_zap_guard_threshold_just_above_one_percent() public {
        depositBalanced(bob, 20 ether);
        nextBlock();
        uint160 start = sqrtPrice();
        sellQuote(q(0.122 ether));
        uint256 moved = _movePct(start, sqrtPrice());
        assertGt(moved, 0.0105e18, "test setup: above 1%");
        assertLt(moved, 0.015e18, "test setup: below 1.5%");
        uint256 qa = q(0.1 ether);
        vm.prank(alice);
        vm.expectRevert(IEarnVault.PriceMovedInBlock.selector);
        _rawZap(_v(qa), true, qa, 0, 0, block.timestamp);
    }

    function test_zap_guard_threshold_just_below_one_percent() public {
        depositBalanced(bob, 20 ether);
        nextBlock();
        uint160 start = sqrtPrice();
        sellQuote(q(0.08 ether));
        uint256 moved = _movePct(start, sqrtPrice());
        assertGt(moved, 0.006e18, "test setup: above 0.6%");
        assertLt(moved, 0.0095e18, "test setup: below 0.95%");
        assertGt(zap(alice, true, q(0.1 ether), 0, 0), 0);
    }

    function test_unlockCallback_cannot_be_called_from_another_unlock() public {
        uint256 shares = depositBalanced(alice, 10 ether);
        CallbackAttacker attacker = new CallbackAttacker(PM, address(vault));
        vm.expectRevert();
        attacker.attack(shares);
        assertEq(positionLiquidity(), shares, "position untouched");
    }

    function test_zap_guard_upward_move() public {
        depositBalanced(bob, 20 ether);
        nextBlock();
        sellOrry(1.6e24); // ORRY in: the quote's price in ORRY falls about 2%
        uint256 qa = q(1 ether);
        vm.prank(alice);
        vm.expectRevert(IEarnVault.PriceMovedInBlock.selector);
        _rawZap(_v(qa), true, qa, 0, 0, block.timestamp);
    }

    // ---------------------------------------------------------------- withdraw

    function test_withdraw_respects_lock_then_pays_preview() public {
        uint256 shares = depositBalanced(alice, 10 ether);
        uint64 until = vault.unlockAt(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IEarnVault.SharesLocked.selector, until));
        vault.withdraw(shares, 0, 0, block.timestamp);
        vm.warp(until - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IEarnVault.SharesLocked.selector, until));
        vault.withdraw(shares, 0, 0, block.timestamp);

        vm.warp(until);
        (uint256 pe, uint256 pr) = vault.previewWithdraw(shares);
        uint256 eBefore = quoteBalance(alice);
        uint256 rBefore = orry.balanceOf(alice);
        vm.expectEmit(true, false, false, true, address(vault));
        emit Withdrawn(alice, shares, pe, pr);
        vm.prank(alice);
        (uint256 e, uint256 r) = vault.withdraw(shares, pe, pr, block.timestamp);
        assertEq(e, pe);
        assertEq(r, pr);
        assertEq(quoteBalance(alice) - eBefore, pe);
        assertEq(orry.balanceOf(alice) - rBefore, pr);
        assertEq(vault.totalShares(), 0);
        assertEq(vault.sharesOf(alice), 0);
        assertEq(positionLiquidity(), 0);
    }

    function test_withdraw_reverts() public {
        uint256 shares = depositBalanced(alice, 10 ether);
        wait(15 minutes);
        vm.startPrank(alice);
        vm.expectRevert(IEarnVault.DeadlinePassed.selector);
        vault.withdraw(shares, 0, 0, block.timestamp - 1);
        vm.expectRevert(IEarnVault.ZeroAmount.selector);
        vault.withdraw(0, 0, 0, block.timestamp);
        vm.expectRevert(IEarnVault.InsufficientShares.selector);
        vault.withdraw(shares + 1, 0, 0, block.timestamp);
        (uint256 pe, uint256 pr) = vault.previewWithdraw(shares);
        vm.expectRevert(IEarnVault.SlippageExceeded.selector);
        vault.withdraw(shares, pe + 1, 0, block.timestamp);
        vm.expectRevert(IEarnVault.SlippageExceeded.selector);
        vault.withdraw(shares, 0, pr + 1, block.timestamp);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(IEarnVault.InsufficientShares.selector);
        vault.withdraw(1, 0, 0, block.timestamp);
    }

    function test_partial_withdraw_keeps_rest() public {
        uint256 shares = depositBalanced(alice, 10 ether);
        wait(15 minutes);
        vm.prank(alice);
        vault.withdraw(shares / 3, 0, 0, block.timestamp);
        assertEq(vault.sharesOf(alice), shares - shares / 3);
        assertEq(positionLiquidity(), shares - shares / 3);
    }

    function test_withdraw_pays_streamed_fees_too() public {
        uint256 shares = depositBalanced(alice, 10 ether);
        (uint256 f0, uint256 f1) = _fundedHarvest();
        wait(WEEK);
        (uint256 pe, uint256 pr) = vault.previewWithdraw(shares);
        (uint256 q0, uint256 q1) = vault.pendingFees(alice);
        assertApproxEqAbs(q0, f0, 2);
        assertApproxEqAbs(q1, f1, 2);
        uint256 eBefore = quoteBalance(alice);
        uint256 rBefore = orry.balanceOf(alice);
        vm.expectEmit(true, true, false, false, address(vault));
        emit FeesClaimed(alice, alice, 0, 0);
        vm.prank(alice);
        (uint256 e, uint256 r) = vault.withdraw(shares, 0, 0, block.timestamp);
        assertEq(e, pe, "returned amounts are principal only");
        assertEq(r, pr);
        assertEq(quoteBalance(alice) - eBefore, pe + q0);
        assertEq(orry.balanceOf(alice) - rBefore, pr + q1);
        (q0, q1) = vault.pendingFees(alice);
        assertEq(q0 + q1, 0);
    }

    // ---------------------------------------------------------------- lock rule

    function test_lock_is_share_weighted() public {
        uint256 s1 = depositBalanced(alice, 4 ether);
        wait(600); // 300 s of the first lock left
        uint256 s2 = depositBalanced(alice, 4 ether);
        uint256 expectedLock = (300 * s1 + 900 * s2) / (s1 + s2);
        assertEq(vault.unlockAt(alice), vm.getBlockTimestamp() + expectedLock);
    }

    function test_lock_after_expiry_counts_held_shares_as_free() public {
        uint256 s1 = depositBalanced(alice, 4 ether);
        wait(2 hours);
        uint256 s2 = depositBalanced(alice, 1 ether);
        assertEq(vault.unlockAt(alice), vm.getBlockTimestamp() + (900 * s2) / (s1 + s2));
    }

    function test_lock_only_affects_the_depositor() public {
        depositBalanced(alice, 4 ether);
        uint256 sb = depositBalanced(bob, 4 ether);
        wait(15 minutes);
        depositBalanced(alice, 4 ether); // alice re-locks, bob does not
        vm.prank(bob);
        vault.withdraw(sb, 0, 0, block.timestamp);
    }

    // ---------------------------------------------------------------- harvest and streams

    function test_harvest_streams_fees_over_the_period() public {
        depositBalanced(alice, 10 ether);
        _trade(3);
        vm.expectEmit(false, false, false, false, address(vault));
        emit FeesHarvested(0, 0, uint64(block.timestamp + WEEK));
        (uint256 f0, uint256 f1) = vault.harvest();
        assertGt(f0, 0);
        assertGt(f1, 0);
        (,,, uint256 h0,, uint64 finish) = vault.streamState(0);
        (,,, uint256 h1,,) = vault.streamState(1);
        assertEq(h0, f0);
        assertEq(h1, f1);
        assertEq(finish, vm.getBlockTimestamp() + WEEK);
        assertEq(quoteBalance(address(vault)), f0, "harvested fees sit in the vault");
        assertEq(orry.balanceOf(address(vault)), f1);

        (uint256 q0, uint256 q1) = vault.pendingFees(alice);
        assertEq(q0 + q1, 0, "nothing streamed at the harvest second");
        wait(WEEK / 2);
        (q0, q1) = vault.pendingFees(alice);
        assertApproxEqAbs(q0, f0 / 2, 2);
        assertApproxEqAbs(q1, f1 / 2, 2);
        wait(WEEK);
        (q0, q1) = vault.pendingFees(alice);
        assertApproxEqAbs(q0, f0, 2);
        assertApproxEqAbs(q1, f1, 2);
        assertLe(q0, f0);
        assertLe(q1, f1);
    }

    function test_harvest_without_shares_or_fees() public {
        (uint256 e, uint256 r) = vault.harvest();
        assertEq(e + r, 0);
        depositBalanced(alice, 1 ether);
        (e, r) = vault.harvest(); // no swaps yet
        assertEq(e + r, 0);
        (,,,,, uint64 finish) = vault.streamState(0);
        assertEq(finish, 0, "no fees, no stream started");
    }

    function test_new_fees_roll_the_remainder() public {
        depositBalanced(alice, 10 ether);
        (uint256 f0,) = _fundedHarvest();
        wait(WEEK / 2);
        _trade(1);
        (uint256 g0,) = vault.harvest();
        (uint256 rate,,,,, uint64 finish) = vault.streamState(0);
        assertEq(finish, vm.getBlockTimestamp() + WEEK);
        assertApproxEqRel(rate * WEEK / 1e36, f0 - f0 / 2 + g0, 1e12);
    }

    function test_two_holders_split_pro_rata() public {
        uint256 sa = depositBalanced(alice, 10 ether);
        uint256 sb = depositBalanced(bob, 5 ether);
        (uint256 f0, uint256 f1) = _fundedHarvest();
        wait(WEEK);
        (uint256 a0, uint256 a1) = vault.pendingFees(alice);
        (uint256 b0, uint256 b1) = vault.pendingFees(bob);
        assertApproxEqAbs(a0, f0 * sa / (sa + sb), 3);
        assertApproxEqAbs(b1, f1 * sb / (sa + sb), 3);
        assertLe(a0 + b0, f0);
        assertLe(a1 + b1, f1);
    }

    /// @dev E-4: a deposit right after a harvest (or a JIT deposit around a big swap) earns only its streamed share.
    function test_E4_late_deposit_gets_only_its_streamed_share() public {
        depositBalanced(alice, 10 ether);
        (uint256 f0, uint256 f1) = _fundedHarvest();
        uint256 sb = depositBalanced(bob, 10 ether);
        wait(15 minutes);
        vm.prank(bob);
        vault.withdraw(sb, 0, 0, block.timestamp);
        uint256 total = vault.totalShares() + sb;
        // bob held sb of `total` for 15 minutes of a 7 day stream; only bob has been paid so far
        (,,,, uint256 paid0,) = vault.streamState(0);
        (,,,, uint256 paid1,) = vault.streamState(1);
        assertLe(paid0, f0 * 15 minutes / WEEK * sb / total + 2);
        assertLe(paid1, f1 * 15 minutes / WEEK * sb / total + 2);
        assertGt(paid1, 0);
    }

    function test_zero_share_time_is_queued_then_restreamed() public {
        uint256 sa = depositBalanced(alice, 10 ether);
        (uint256 f0,) = _fundedHarvest();
        wait(1 days);
        vm.prank(alice);
        vault.withdraw(sa, 0, 0, block.timestamp);
        uint256 alicePaid = f0 * 1 days / WEEK;
        wait(2 days); // nobody holds shares
        depositBalanced(bob, 1 ether);
        (,, uint256 queued0,,,) = vault.streamState(0);
        assertEq(queued0, 0, "queued amount restreamed at the deposit");
        wait(WEEK);
        (uint256 b0,) = vault.pendingFees(bob);
        assertApproxEqAbs(b0, f0 - alicePaid, f0 / 1e9 + 3, "bob gets the queued and the unstreamed part");
        (,,,, uint256 paid0,) = vault.streamState(0);
        assertApproxEqAbs(paid0, alicePaid, 3);
    }

    function test_claimFees_and_claimFor() public {
        depositBalanced(alice, 10 ether);
        _fundedHarvest();
        wait(WEEK);
        (uint256 q0, uint256 q1) = vault.pendingFees(alice);
        uint256 eBefore = quoteBalance(alice);
        uint256 rBefore = orry.balanceOf(alice);
        uint256 carolE = quoteBalance(carol);
        uint256 carolR = orry.balanceOf(carol);

        vm.expectEmit(true, true, false, true, address(vault));
        emit FeesClaimed(alice, carol, q0, q1);
        vm.prank(carol);
        (uint256 e, uint256 r) = vault.claimFor(alice);
        assertEq(e, q0);
        assertEq(r, q1);
        assertEq(quoteBalance(alice) - eBefore, q0, "paid to the account");
        assertEq(orry.balanceOf(alice) - rBefore, q1);
        assertEq(quoteBalance(carol), carolE, "caller gets nothing");
        assertEq(orry.balanceOf(carol), carolR);

        vm.prank(alice);
        (e, r) = vault.claimFees();
        assertEq(e + r, 0, "nothing left");
        (,,,, uint256 paid0,) = vault.streamState(0);
        assertEq(paid0, q0);
    }

    function test_claim_never_blocked_by_lock() public {
        depositBalanced(alice, 10 ether);
        _fundedHarvest();
        wait(1 hours);
        depositBalanced(alice, 1 ether); // relocked
        wait(1 hours);
        vm.prank(alice);
        (uint256 e,) = vault.claimFees();
        assertGt(e, 0);
    }

    // ---------------------------------------------------------------- notified rewards (B-2, E-7)

    /// @dev E-7: notified ORRY streams to shares only, pro rata, over STREAM_PERIOD; principal, the quote stream and a
    /// caller without shares get nothing of it.
    function test_notifyRewards_streams_to_shares_only() public {
        uint256 sa = depositBalanced(alice, 10 ether);
        uint256 sb = depositBalanced(bob, 5 ether);
        (uint256 pa0, uint256 pa1) = vault.previewWithdraw(sa);
        uint256 amount = 3e24;
        uint256 vaultR = orry.balanceOf(address(vault));
        vm.expectEmit(true, false, false, true, address(vault));
        emit RewardsNotified(carol, amount);
        vm.prank(carol);
        vault.notifyRewards(amount);
        assertEq(orry.balanceOf(address(vault)), vaultR + amount, "pulled exactly");
        (,,, uint256 h1,, uint64 finish) = vault.streamState(1);
        assertEq(h1, amount);
        assertEq(finish, vm.getBlockTimestamp() + WEEK);
        (uint256 q0, uint256 q1) = vault.pendingFees(alice);
        assertEq(q0 + q1, 0, "nothing at the notify second");

        wait(WEEK);
        (uint256 a0, uint256 a1) = vault.pendingFees(alice);
        (uint256 b0, uint256 b1) = vault.pendingFees(bob);
        (uint256 c0, uint256 c1) = vault.pendingFees(carol);
        assertEq(a0 + b0, 0, "the quote stream gets nothing");
        assertEq(c0 + c1, 0, "the payer has no shares");
        assertApproxEqAbs(a1, amount * sa / (sa + sb), 3);
        assertApproxEqAbs(b1, amount * sb / (sa + sb), 3);
        assertLe(a1 + b1, amount);
        (uint256 pa0b, uint256 pa1b) = vault.previewWithdraw(sa);
        assertEq(pa0b, pa0, "principal untouched");
        assertEq(pa1b, pa1);

        uint256 r = orry.balanceOf(alice);
        vm.prank(carol);
        vault.claimFor(alice);
        assertEq(orry.balanceOf(alice) - r, a1, "paid to the holder");
    }

    function test_notifyRewards_without_shares_waits_for_the_next_depositor() public {
        vm.prank(carol);
        vault.notifyRewards(2e24);
        wait(2 days);
        depositBalanced(alice, 1 ether);
        (,, uint256 queued,,,) = vault.streamState(1);
        assertEq(queued, 0, "restreamed at the deposit");
        wait(WEEK);
        (, uint256 a1) = vault.pendingFees(alice);
        assertApproxEqAbs(a1, 2e24, 2e24 / 1e9 + 3, "the first holder gets all of it");
    }

    function test_notifyRewards_rolls_with_fees_and_the_running_period() public {
        depositBalanced(alice, 10 ether);
        (, uint256 f1) = _fundedHarvest();
        wait(WEEK / 2);
        vm.prank(carol);
        vault.notifyRewards(1e24);
        (uint256 rate,,,,, uint64 finish) = vault.streamState(1);
        assertEq(finish, vm.getBlockTimestamp() + WEEK);
        assertApproxEqRel(rate * WEEK / 1e36, f1 - f1 / 2 + 1e24, 1e12, "unstreamed fees plus the notified amount");
        wait(WEEK);
        (, uint256 a1) = vault.pendingFees(alice);
        assertApproxEqAbs(a1, f1 + 1e24, 10);
    }

    function test_notifyRewards_zero_reverts() public {
        vm.prank(carol);
        vm.expectRevert(IEarnVault.ZeroAmount.selector);
        vault.notifyRewards(0);
    }

    // ---------------------------------------------------------------- E-6 donations

    function test_E6_donations_change_nothing() public {
        uint256 shares = depositBalanced(alice, 10 ether);
        _fundedHarvest();
        wait(1 days);
        (uint256 pe, uint256 pr) = vault.previewWithdraw(shares);
        (uint256 q0, uint256 q1) = vault.pendingFees(alice);
        uint256 vaultEth = quoteBalance(address(vault));
        uint256 vaultOrry = orry.balanceOf(address(vault));

        orry.transfer(address(vault), 5e24);
        giveQuote(address(vault), q(3 ether));

        (uint256 pe2, uint256 pr2) = vault.previewWithdraw(shares);
        (uint256 q02, uint256 q12) = vault.pendingFees(alice);
        assertEq(pe2, pe);
        assertEq(pr2, pr);
        assertEq(q02, q0);
        assertEq(q12, q1);

        vm.prank(alice);
        (uint256 e, uint256 r) = vault.withdraw(shares, 0, 0, block.timestamp);
        assertEq(e, pe);
        assertEq(r, pr);
        // what is left is the unstreamed fees plus the donation, nothing of it counted
        assertEq(quoteBalance(address(vault)), vaultEth - q0 + q(3 ether));
        assertEq(orry.balanceOf(address(vault)), vaultOrry - q1 + 5e24);
    }

    function test_E6_pool_donation_is_streamed_as_fees() public {
        depositBalanced(alice, 10 ether);
        (uint256 d0, uint256 d1) = toPool(q(1 ether), 0);
        trader.donate(key, d0, d1); // donate() credits in-range LPs, here only the vault
        (uint256 f0,) = vault.harvest();
        assertApproxEqAbs(f0, q(1 ether), 1);
        (uint256 q0,) = vault.pendingFees(alice);
        assertEq(q0, 0, "streamed, not paid at once");
    }

    // ---------------------------------------------------------------- ETH recipients (native vault only)

    function test_refusing_recipient_reverts_only_its_own_call() public {
        if (!isEth) vm.skip(true);
        EthRefuser w = new EthRefuser();
        orry.transfer(address(w), 1e26);
        w.approve(orry, address(vault));
        vm.deal(address(w), 10 ether);
        w.deposit{value: 2 ether}(vault, orryFor(2 ether) * 2);
        depositBalanced(alice, 10 ether);
        _fundedHarvest();
        wait(1 days);

        w.setRefuse(true);
        vm.expectRevert(IEarnVault.EthTransferFailed.selector);
        vault.claimFor(address(w));
        uint256 rc = orryFor(1 ether);
        vm.expectRevert(IEarnVault.EthTransferFailed.selector);
        w.deposit{value: 2 ether}(vault, rc); // ETH refund refused

        vm.prank(carol);
        (uint256 e,) = vault.claimFor(alice);
        assertGt(e, 0, "other accounts are unaffected");

        w.setRefuse(false);
        (e,) = w.claim(vault);
        assertGt(e, 0);
    }

    function test_reentrancy_through_eth_refund_is_blocked() public {
        if (!isEth) vm.skip(true);
        ReentrantDepositor d = new ReentrantDepositor(vault);
        orry.transfer(address(d), 1e26);
        d.approve(orry);
        vm.deal(address(d), 10 ether);
        d.arm();
        d.deposit{value: 4 ether}(orryFor(1 ether)); // ORRY-limited: ETH refund calls back
        assertTrue(d.tried());
        assertFalse(d.innerSucceeded(), "re-entry must fail");
        assertEq(positionLiquidity(), vault.totalShares());
    }
}

contract EarnVaultUsdgLowTest is EarnVaultTest {
    function kind() internal pure override returns (Kind) {
        return Kind.USDG_LOW;
    }
}

contract EarnVaultUsdgHighTest is EarnVaultTest {
    function kind() internal pure override returns (Kind) {
        return Kind.USDG_HIGH;
    }
}
