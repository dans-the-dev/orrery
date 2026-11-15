// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PaymasterBase} from "./utils/PaymasterBase.sol";
import {OrryPaymaster} from "../../src/paymaster/OrryPaymaster.sol";
import {
    IOrryPaymaster, IPaymaster, PackedUserOperation, PaymasterParams
} from "../../src/paymaster/interfaces/IOrryPaymaster.sol";
import {IOrryBurnEvents} from "../../src/orry/interfaces/IOrryToken.sol";
import {FeeOnTransferToken} from "../mocks/Mocks.sol";
import {ShortBurnOrry} from "./utils/R2Mocks.sol";

/// @notice Unit tests of `OrryPaymaster` (`docs/updates/L3-R2-SPEC.md` 5, PA-1 to PA-6).
contract OrryPaymasterTest is PaymasterBase {
    function _rate() internal view returns (uint256) {
        return orryPrice.orryFor(2235e6);
    }

    function _held() internal view returns (uint256) {
        return pmr.balanceOf(account) + pmr.pendingRecipient() + pmr.pendingBurn();
    }

    // ------------------------------------------------------------------ constructor and views

    function test_constructor_checks() public {
        PaymasterParams memory p = _pmParams();
        p.premiumBps = 5001;
        vm.expectRevert(IOrryPaymaster.BadParams.selector);
        new OrryPaymaster(address(ep), address(orry), address(orryPrice), address(ethFeed), owner, recipient, p);
        p = _pmParams();
        p.bufferBps = 10_001;
        vm.expectRevert(IOrryPaymaster.BadParams.selector);
        new OrryPaymaster(address(ep), address(orry), address(orryPrice), address(ethFeed), owner, recipient, p);
        p = _pmParams();
        p.maxCostWei = 0;
        vm.expectRevert(IOrryPaymaster.BadParams.selector);
        new OrryPaymaster(address(ep), address(orry), address(orryPrice), address(ethFeed), owner, recipient, p);
        p = _pmParams();
        p.maxRateAge = 0;
        vm.expectRevert(IOrryPaymaster.BadParams.selector);
        new OrryPaymaster(address(ep), address(orry), address(orryPrice), address(ethFeed), owner, recipient, p);
        p = _pmParams();
        p.maxEthStaleness = 0;
        vm.expectRevert(IOrryPaymaster.BadParams.selector);
        new OrryPaymaster(address(ep), address(orry), address(orryPrice), address(ethFeed), owner, recipient, p);
        vm.expectRevert(IOrryPaymaster.ZeroAddress.selector);
        new OrryPaymaster(address(0), address(orry), address(orryPrice), address(ethFeed), owner, recipient, _pmParams());
        vm.expectRevert(IOrryPaymaster.ZeroAddress.selector);
        new OrryPaymaster(address(ep), address(orry), address(orryPrice), address(ethFeed), owner, address(0), _pmParams());
    }

    function test_getters() public view {
        assertEq(pmr.entryPoint(), address(ep));
        assertEq(pmr.orry(), address(orry));
        assertEq(pmr.orryPrice(), address(orryPrice));
        assertEq(pmr.ethUsdFeed(), address(ethFeed));
        assertEq(pmr.orryRecipient(), recipient);
        assertEq(pmr.owner(), owner);
        assertEq(pmr.MIN_POST_OP_GAS(), 120_000);
        PaymasterParams memory p = pmr.params();
        assertEq(p.premiumBps, 1000);
        assertEq(p.bufferBps, 2000);
        assertEq(p.maxCostWei, 2e15);
        assertEq(p.postOpOverheadGas, 45_000);
        assertEq(p.maxRateAge, 3600);
        assertEq(p.maxEthStaleness, 7200);
        (uint256 r, uint64 at) = pmr.cachedRate();
        assertEq(r, 0);
        assertEq(at, 0);
    }

    function test_rate_is_eth_usd_then_the_hub_price() public {
        uint256 rate = pmr.currentRate();
        assertEq(rate, _rate());
        // about 1,002,600 ORRY per ETH at tick 138200
        assertGt(rate, 1_000_000e18);
        assertLt(rate, 1_005_000e18);
        uint64 t = uint64(_now());
        vm.expectEmit(address(pmr));
        emit IOrryPaymaster.RateRefreshed(rate, t);
        assertEq(pmr.refreshRate(), rate);
        (uint256 r, uint64 at) = pmr.cachedRate();
        assertEq(r, rate);
        assertEq(at, _now());
    }

    function test_rate_needs_a_fresh_eth_price_and_a_ready_hub() public {
        vm.warp(START - 60 + 7201);
        vm.expectRevert(IOrryPaymaster.OracleNotReady.selector);
        pmr.currentRate();
        vm.expectRevert(IOrryPaymaster.OracleNotReady.selector);
        pmr.refreshRate();
        ethFeed.push(ETH_ANSWER, _now());
        pmr.refreshRate();
        hook.set(HUB_TICK, 0);
        vm.expectRevert(IOrryPaymaster.OracleNotReady.selector);
        pmr.refreshRate();
        hook.set(HUB_TICK, _now() - 2 hours);
        ethFeed.push(0, _now());
        vm.expectRevert(IOrryPaymaster.OracleNotReady.selector);
        pmr.refreshRate();
        ethFeed.push(ETH_ANSWER, _now() + 1);
        vm.expectRevert(IOrryPaymaster.OracleNotReady.selector);
        pmr.refreshRate();
    }

    // ------------------------------------------------------------------ prepaid balances

    function test_deposit_and_withdraw() public {
        vm.expectEmit(address(pmr));
        emit IOrryPaymaster.Deposited(account, operator, 500e18);
        _fund(account, 500e18);
        assertEq(pmr.balanceOf(account), 500e18);
        assertEq(orry.balanceOf(address(pmr)), 500e18);
        vm.prank(operator);
        vm.expectRevert(IOrryPaymaster.InsufficientBalance.selector);
        pmr.withdraw(operator, 1); // only the account spends its balance
        vm.prank(account);
        vm.expectRevert(IOrryPaymaster.InsufficientBalance.selector);
        pmr.withdraw(account, 500e18 + 1);
        vm.prank(account);
        vm.expectEmit(address(pmr));
        emit IOrryPaymaster.Withdrawn(account, operator, 200e18);
        pmr.withdraw(operator, 200e18);
        assertEq(pmr.balanceOf(account), 300e18);
        assertEq(orry.balanceOf(address(pmr)), 300e18);
    }

    function test_deposit_and_withdraw_input_checks() public {
        vm.startPrank(operator);
        vm.expectRevert(IOrryPaymaster.ZeroAmount.selector);
        pmr.deposit(account, 0);
        vm.expectRevert(IOrryPaymaster.ZeroAddress.selector);
        pmr.deposit(address(0), 1);
        vm.stopPrank();
        vm.startPrank(account);
        vm.expectRevert(IOrryPaymaster.ZeroAmount.selector);
        pmr.withdraw(account, 0);
        vm.expectRevert(IOrryPaymaster.ZeroAddress.selector);
        pmr.withdraw(address(0), 1);
        vm.stopPrank();
    }

    function test_deposit_rejects_a_fee_on_transfer_token() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        OrryPaymaster p2 = new OrryPaymaster(
            address(ep), address(fot), address(orryPrice), address(ethFeed), owner, recipient, _pmParams()
        );
        fot.mint(operator, 100e18);
        vm.startPrank(operator);
        fot.approve(address(p2), type(uint256).max);
        vm.expectRevert(IOrryPaymaster.InexactTransfer.selector);
        p2.deposit(account, 100e18);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ validation

    function test_only_the_entry_point_validates_and_posts() public {
        PackedUserOperation memory op = _op(account, 150_000);
        vm.expectRevert(IOrryPaymaster.NotEntryPoint.selector);
        pmr.validatePaymasterUserOp(op, bytes32(0), 1e14);
        vm.expectRevert(IOrryPaymaster.NotEntryPoint.selector);
        pmr.postOp(IPaymaster.PostOpMode.opSucceeded, abi.encode(account, uint256(1), uint256(1)), 1, 1);
    }

    function test_validation_rules() public {
        _fund(account, 10_000e18);
        PackedUserOperation memory op = _op(account, 150_000);
        vm.expectRevert(IOrryPaymaster.RateNotSet.selector);
        ep.validateOnly(address(pmr), op, 1e14);
        pmr.refreshRate();
        vm.expectRevert(IOrryPaymaster.CostTooHigh.selector);
        ep.validateOnly(address(pmr), op, 2e15 + 1);
        vm.expectRevert(IOrryPaymaster.PostOpGasTooLow.selector);
        ep.validateOnly(address(pmr), _op(account, 119_999), 1e14);
        PackedUserOperation memory shortOp = _op(account, 150_000);
        shortOp.paymasterAndData = abi.encodePacked(address(pmr), uint128(100_000));
        vm.expectRevert(IOrryPaymaster.PostOpGasTooLow.selector);
        ep.validateOnly(address(pmr), shortOp, 1e14);
        vm.expectRevert(IOrryPaymaster.InsufficientBalance.selector);
        ep.validateOnly(address(pmr), _op(makeAddr("empty"), 150_000), 1e14);
        // the cap and the minimum themselves pass
        ep.validateOnly(address(pmr), _op(account, 120_000), 2e15);
    }

    function test_validation_sets_aside_the_precharge_and_returns_valid_until() public {
        _fund(account, 10_000e18);
        pmr.refreshRate();
        uint256 rate = _rate();
        uint256 maxCost = 1e15;
        uint256 expected = FullMath.mulDivRoundingUp(maxCost, rate * 13_000, 1e18 * 10_000);
        assertEq(pmr.quote(maxCost), expected);
        (bytes memory ctx, uint256 vd) = ep.validateOnly(address(pmr), _op(account, 150_000), maxCost);
        assertEq(pmr.balanceOf(account), 10_000e18 - expected);
        (address s, uint256 pre, uint256 r, uint256 extra) = abi.decode(ctx, (address, uint256, uint256, uint256));
        assertEq(s, account);
        assertEq(pre, expected);
        assertEq(r, rate);
        assertEq(extra, 150_000, "the postOp gas limit; no call gas limit in this operation");
        assertEq(vd, uint256(_now() + 3600) << 160, "validUntil = cached at + maxRateAge, no failure bit");
        assertEq(vd & 1, 0);
    }

    function test_withdraw_inside_the_operation_cannot_take_the_precharge() public {
        _fund(account, 10_000e18);
        pmr.refreshRate();
        (bytes memory ctx,) = ep.validateOnly(address(pmr), _op(account, 150_000), 1e15);
        uint256 free = pmr.balanceOf(account);
        vm.prank(account);
        vm.expectRevert(IOrryPaymaster.InsufficientBalance.selector);
        pmr.withdraw(account, free + 1);
        vm.prank(account);
        pmr.withdraw(account, free);
        ep.postOnly(address(pmr), ctx, 1e14, 1e9);
        assertEq(orry.balanceOf(address(pmr)), _held(), "PA-1");
    }

    // ------------------------------------------------------------------ postOp

    function test_post_op_charges_the_real_cost_at_the_fresh_rate_and_refunds_the_rest() public {
        _fund(account, 10_000e18);
        pmr.refreshRate();
        uint256 rate = _rate();
        uint256 maxCost = 1e15;
        uint256 actual = 3e14;
        uint256 feePerGas = 1e9;
        // the postOp limit, a tenth of the call gas limit (the EntryPoint's unused-gas penalty bound) and the overhead
        uint256 cost = actual + (150_000 + 10_000 + 45_000) * feePerGas;
        PackedUserOperation memory op = _op(account, 150_000);
        op.accountGasLimits = bytes32(uint256(100_000)); // call gas limit in the low 128 bits
        uint256 charge = FullMath.mulDivRoundingUp(cost, rate * 11_000, 1e18 * 10_000);
        uint256 base = charge * 10_000 / 11_000;
        uint256 pre = pmr.quote(maxCost);
        vm.expectEmit(address(pmr));
        emit IOrryPaymaster.Charged(account, actual, charge, charge - base, pre - charge);
        ep.run(address(pmr), op, maxCost, actual, feePerGas);
        assertEq(pmr.balanceOf(account), 10_000e18 - charge, "PA-2: only the charge leaves the balance");
        assertEq(pmr.pendingRecipient(), base);
        assertEq(pmr.pendingBurn(), charge - base);
        assertEq(orry.balanceOf(address(pmr)), _held(), "PA-1");
        // PA-3: the charge covers cost plus premium at the rate
        assertGe(charge * 1e18 * 10_000, cost * rate * 11_000);
    }

    function test_charge_is_capped_at_the_precharge_when_the_price_moved_against_us() public {
        _fund(account, 10_000e18);
        pmr.refreshRate();
        uint256 pre = pmr.quote(2e15);
        // ORRY falls a lot before postOp: far more ORRY per ETH
        hook.set(HUB_TICK + 20_000, START - 2 hours);
        ep.run(address(pmr), _op(account, 150_000), 2e15, 2e15, 1e9);
        assertEq(pmr.balanceOf(account), 10_000e18 - pre, "charged exactly the precharge, never more");
        assertEq(pmr.pendingRecipient() + pmr.pendingBurn(), pre);
        (uint256 r,) = pmr.cachedRate();
        assertGt(r, _rate() - 1, "postOp cached the fresh rate");
    }

    function test_post_op_uses_the_validation_rate_when_the_oracle_cannot_price() public {
        _fund(account, 10_000e18);
        pmr.refreshRate();
        uint256 rate = _rate();
        (bytes memory ctx,) = ep.validateOnly(address(pmr), _op(account, 150_000), 1e15);
        vm.warp(START - 60 + 7201); // ETH/USD stale
        ep.postOnly(address(pmr), ctx, 1e14, 0);
        uint256 charge = FullMath.mulDivRoundingUp(1e14, rate * 11_000, 1e18 * 10_000);
        assertEq(10_000e18 - pmr.balanceOf(account), charge);
        (uint256 r, uint64 at) = pmr.cachedRate();
        assertEq(r, rate);
        assertEq(at, START, "the cache kept its old time");
    }

    function test_zero_cost_operation_charges_nothing() public {
        _fund(account, 1_000e18);
        pmr.refreshRate();
        ep.run(address(pmr), _op(account, 150_000), 1e14, 0, 0);
        assertEq(pmr.balanceOf(account), 1_000e18);
        assertEq(pmr.pendingBurn(), 0);
    }

    // ------------------------------------------------------------------ flush

    function test_flush_pays_the_recipient_and_burns_the_premium() public {
        _fund(account, 10_000e18);
        pmr.refreshRate();
        ep.run(address(pmr), _op(account, 150_000), 1e15, 4e14, 1e9);
        uint256 paid = pmr.pendingRecipient();
        uint256 burned = pmr.pendingBurn();
        assertGt(burned, 0);
        uint256 supply = orry.totalSupply();
        vm.expectEmit(address(pmr));
        emit IOrryBurnEvents.Burned(33, burned);
        vm.expectEmit(address(pmr));
        emit IOrryPaymaster.Flushed(recipient, paid, burned);
        pmr.flush();
        assertEq(orry.balanceOf(recipient), paid, "PA-6");
        assertEq(supply - orry.totalSupply(), burned, "PA-6");
        assertEq(pmr.pendingRecipient(), 0);
        assertEq(pmr.pendingBurn(), 0);
        assertEq(orry.balanceOf(address(pmr)), pmr.balanceOf(account));
        vm.expectRevert(IOrryPaymaster.ZeroAmount.selector);
        pmr.flush();
    }

    function test_zero_premium_pays_everything_to_the_recipient() public {
        PaymasterParams memory p = _pmParams();
        p.premiumBps = 0;
        OrryPaymaster p0 = new OrryPaymaster(
            address(ep), address(orry), address(orryPrice), address(ethFeed), owner, recipient, p
        );
        vm.prank(operator);
        orry.approve(address(p0), type(uint256).max);
        vm.prank(operator);
        p0.deposit(account, 1_000e18);
        p0.refreshRate();
        PackedUserOperation memory op = _op(account, 150_000);
        op.paymasterAndData = abi.encodePacked(address(p0), uint128(100_000), uint128(150_000));
        ep.run(address(p0), op, 1e14, 1e13, 0);
        assertEq(p0.pendingBurn(), 0);
        uint256 supply = orry.totalSupply();
        p0.flush();
        assertEq(orry.totalSupply(), supply);
    }

    function test_flush_burn_is_checked_on_the_supply() public {
        ShortBurnOrry sr = new ShortBurnOrry(address(this), 1e27);
        OrryPaymaster p2 = new OrryPaymaster(
            address(ep), address(sr), address(orryPrice), address(ethFeed), owner, recipient, _pmParams()
        );
        sr.approve(address(p2), type(uint256).max);
        p2.deposit(account, 10_000e18);
        p2.refreshRate();
        PackedUserOperation memory op = _op(account, 150_000);
        op.paymasterAndData = abi.encodePacked(address(p2), uint128(100_000), uint128(150_000));
        ep.run(address(p2), op, 1e15, 4e14, 1e9);
        vm.expectRevert(IOrryPaymaster.InexactTransfer.selector);
        p2.flush();
    }

    // ------------------------------------------------------------------ owner: ETH only

    function test_owner_manages_only_the_paymasters_eth() public {
        vm.deal(address(this), 10 ether);
        pmr.depositEth{value: 1 ether}(); // anyone may fund the deposit
        assertEq(ep.balanceOf(address(pmr)), 1 ether);
        address payable to = payable(makeAddr("ethTo"));
        vm.expectRevert(IOrryPaymaster.NotOwner.selector);
        pmr.withdrawEth(to, 1);
        vm.deal(owner, 5 ether);
        vm.startPrank(owner);
        pmr.withdrawEth(to, 0.4 ether);
        assertEq(to.balance, 0.4 ether);
        pmr.addStake{value: 2 ether}(86_400);
        assertEq(ep.stakeOf(address(pmr)), 2 ether);
        assertEq(ep.delayOf(address(pmr)), 86_400);
        pmr.unlockStake();
        pmr.withdrawStake(to);
        vm.stopPrank();
        assertEq(to.balance, 2.4 ether);
        vm.startPrank(account);
        vm.expectRevert(IOrryPaymaster.NotOwner.selector);
        pmr.addStake(1);
        vm.expectRevert(IOrryPaymaster.NotOwner.selector);
        pmr.unlockStake();
        vm.expectRevert(IOrryPaymaster.NotOwner.selector);
        pmr.withdrawStake(to);
        vm.stopPrank();
    }

    function test_two_step_ownership() public {
        address next = makeAddr("next");
        vm.prank(account);
        vm.expectRevert(IOrryPaymaster.NotOwner.selector);
        pmr.transferOwnership(next);
        vm.prank(owner);
        pmr.transferOwnership(next);
        vm.prank(account);
        vm.expectRevert(IOrryPaymaster.NotOwner.selector);
        pmr.acceptOwnership();
        vm.prank(next);
        pmr.acceptOwnership();
        assertEq(pmr.owner(), next);
        assertEq(pmr.pendingOwner(), address(0));
    }

    // ------------------------------------------------------------------ fuzz

    /// PA-1 to PA-3 for random costs and prices.
    function testFuzz_charge_bounds(uint256 maxCost, uint256 actual, uint256 feePerGas, int24 drift) public {
        maxCost = bound(maxCost, 1, 2e15);
        actual = bound(actual, 0, maxCost);
        feePerGas = bound(feePerGas, 0, 1e10);
        drift = int24(bound(drift, -30_000, 30_000));
        _fund(account, 1_000_000e18);
        pmr.refreshRate();
        uint256 pre = pmr.quote(maxCost);
        hook.set(HUB_TICK + drift, START - 2 hours);
        uint256 fresh = _rate();
        ep.run(address(pmr), _op(account, 150_000), maxCost, actual, feePerGas);
        uint256 charged = 1_000_000e18 - pmr.balanceOf(account);
        assertLe(charged, pre, "PA-2");
        uint256 cost = actual + (150_000 + 45_000) * feePerGas;
        if (charged < pre) assertGe(charged * 1e18 * 10_000, cost * fresh * 11_000, "PA-3");
        assertEq(orry.balanceOf(address(pmr)), _held(), "PA-1");
    }
}
