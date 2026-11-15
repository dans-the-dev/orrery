// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {AgentLaunch} from "../../src/launch/AgentLaunch.sol";
import {AgentCoin} from "../../src/launch/AgentCoin.sol";
import {SpokeHook} from "../../src/launch/SpokeHook.sol";
import {IAgentLaunch} from "../../src/launch/interfaces/IAgentLaunch.sol";
import {IOrryStaking} from "../../src/orry/interfaces/IOrryStaking.sol";
import {IOrryBurnEvents} from "../../src/orry/interfaces/IOrryToken.sol";
import {LaunchBase} from "./utils/LaunchBase.sol";

/// @notice `AgentLaunch` unit tests: gates (LA-9, LA-10), launch shape (LA-6, LA-7, LA-15, LA-16), early access (LA-12),
/// distribution (LA-1 to LA-3), creator claims (LA-13).
contract AgentLaunchTest is LaunchBase {
    using PoolIdLibrary for PoolKey;

    uint256 constant SUPPLY = 1_000_000_000e18;

    // ---------------------------------------------------------------- construction

    function test_constructor_defaults() public view {
        IAgentLaunch.Params memory p = al.params();
        assertEq(p.startTick, START_TICK);
        assertEq(p.maxFirstBuyBps, 500);
        assertEq(al.SUPPLY(), SUPPLY);
        assertEq(al.LOCK_PERIOD(), 90 days);
        assertEq(uint256(al.CREATOR_BPS()) + al.EARN_BPS() + al.OWNER_BPS(), 8500, "burn takes the remaining 15%");
        assertEq(al.SQRT_PRICE_START(), TickMath.getSqrtPriceAtTick(START_TICK));
        assertEq(al.hook(), address(hook));
        assertEq(hook.launch(), address(al));
    }

    function test_constructor_rejects_bad_params() public {
        IAgentLaunch.Params memory p = defaultParams();
        p.startTick = 25_001; // not a multiple of 200
        _expectBadDeploy(p);
        p = defaultParams();
        p.startTick = -887_200; // at MIN_TICK: empty range
        _expectBadDeploy(p);
        p = defaultParams();
        p.startTick = -887_000; // the whole supply between two ticks near the bottom needs more than uint128 liquidity
        _expectBadDeploy(p);
        p = defaultParams();
        p.maxFirstBuyBps = 0;
        _expectBadDeploy(p);
        p = defaultParams();
        p.maxFirstBuyBps = 2001;
        _expectBadDeploy(p);
        p = defaultParams();
        p.earlyMaxBps = 501;
        _expectBadDeploy(p);
        p = defaultParams();
        p.earlyFullUsd = 0;
        p.earlyMinUsd = 0;
        _expectBadDeploy(p);
        p = defaultParams();
        p.earlyMinUsd = 2_000e6;
        _expectBadDeploy(p);
    }

    function _expectBadDeploy(IAgentLaunch.Params memory p) internal {
        vm.expectRevert(IAgentLaunch.BadParameters.selector);
        this.newLaunchWithOwnHook(p);
    }

    /// @dev External so `vm.expectRevert` can wrap a constructor (a bare `new` after expectRevert ends the test). The hook
    /// is made for this frame's next CREATE address, so only the parameters can make the constructor revert.
    function newLaunchWithOwnHook(IAgentLaunch.Params memory p) external returns (address) {
        uint64 nonce = vm.getNonce(address(this));
        address launchAt = vm.computeCreateAddress(address(this), nonce);
        address hookAt = address((uint160(uint256(keccak256(abi.encode("bad", launchAt)))) & ~uint160(0x3FFF)) | HOOK_BITS);
        deployCodeTo("SpokeHook.sol:SpokeHook", abi.encode(address(PM), address(orry), launchAt, START_FEE, DECAY, EARLY), hookAt);
        vm.setNonceUnsafe(address(this), nonce);
        address made = newLaunch(hookAt, address(registry), p);
        require(made == launchAt, "prediction");
        return made;
    }

    function newLaunch(address hookAt, address registryAt, IAgentLaunch.Params memory p) public returns (address) {
        return address(
            new AgentLaunch(
                address(PM), address(orry), hookAt, registryAt, address(attestor), address(module), address(staking),
                address(price), address(vault), address(treasury), p
            )
        );
    }

    function test_constructor_harness_accepts_the_defaults_and_the_bounds() public {
        // positive control: the same path deploys with good parameters, so every revert above comes from a parameter
        assertTrue(this.newLaunchWithOwnHook(defaultParams()) != address(0));
        IAgentLaunch.Params memory p = defaultParams();
        p.maxFirstBuyBps = 2000;
        p.earlyMaxBps = 500;
        p.earlyMinUsd = p.earlyFullUsd;
        p.startTick = 886_800; // near the top of the range (near the bottom the liquidity would overflow uint128)
        assertTrue(this.newLaunchWithOwnHook(p) != address(0));
    }

    function test_constructor_rejects_a_hook_for_another_launcher() public {
        // hook made for `al`, a second AgentLaunch pointing at it must refuse
        vm.expectRevert(IAgentLaunch.BadParameters.selector);
        this.newLaunch(address(hook), address(registry), defaultParams()); // hook made for `al`
    }

    function test_constructor_rejects_zero_address() public {
        vm.expectRevert(IAgentLaunch.ZeroAddress.selector);
        this.newLaunch(address(hook), address(0), defaultParams());
    }

    // ---------------------------------------------------------------- launch shape

    function test_launch_opens_at_start_tick_with_the_whole_supply_locked() public {
        (uint256 id,) = _agent(alice);
        address coin = _launch(id, alice, 0);
        AgentCoin c = AgentCoin(coin);
        assertEq(c.totalSupply(), SUPPLY, "LA-7 fixed supply");
        assertEq(_tick(coin), START_TICK, "LA-16 opening tick");
        _assertOnePosition(coin);
        uint256 dust = c.balanceOf(address(al));
        assertLt(dust, 10, "LA-7 only rounding dust stays");
        assertEq(c.balanceOf(address(PM)), SUPPLY - dust, "the pool holds the rest");
        assertGt(uint160(coin), uint160(address(orry)), "L5-2 coin above ORRY");
        IAgentLaunch.Launch memory l = al.launchOf(coin);
        assertEq(l.agentId, id);
        assertEq(l.creator, alice);
        assertEq(al.coinOfAgent(id), coin);
        assertEq(al.launchCount(), 1);
        assertEq(hook.publicOpenAt(l.poolId), block.timestamp + EARLY);
        assertEq(al.predictCoin(alice, bytes32(id), "Agent Coin", "AGC"), coin, "predictCoin");
    }

    function test_launch_by_the_bound_wallet() public {
        (uint256 id, address wallet) = _agent(alice);
        vm.prank(wallet);
        address coin = al.launch(id, "Wallet Coin", "WLC", bytes32(0), 0, 0);
        assertEq(al.launchOf(coin).creator, wallet);
    }

    function test_launch_first_buy_pays_one_percent_and_goes_to_the_creator() public {
        (uint256 id,) = _agent(alice);
        uint256 before = orry.balanceOf(alice);
        address coin = _launch(id, alice, 100_000e18);
        assertEq(before - orry.balanceOf(alice), 100_000e18, "exact ORRY pulled");
        uint256 fee = 1_000e18;
        assertEq(hook.feesOf(_key(coin).toId()), fee, "1% of the first buy");
        assertEq(_claims(address(al)), fee, "claims minted to AgentLaunch");
        uint256 got = AgentCoin(coin).balanceOf(alice);
        assertGt(got, 0);
        // constant product with a virtual ORRY reserve equal to the start value
        assertEq(AgentCoin(coin).balanceOf(address(al)) < 10, true, "bought coins handed over");
        assertLt(_tick(coin), START_TICK, "buying moves the price down in coin per ORRY");
    }

    function test_launch_first_buy_cap_and_slippage() public {
        (uint256 id,) = _agent(alice);
        // about 5.3% of supply: above the 5% cap
        vm.prank(alice);
        vm.expectRevert();
        al.launch(id, "Big", "BIG", bytes32(0), 4_700_000e18, 0);
        vm.prank(alice);
        vm.expectRevert();
        al.launch(id, "Slip", "SLP", bytes32(0), 1_000e18, type(uint256).max);
        // both reverts left nothing behind
        assertEq(al.coinOfAgent(id), address(0));
        address coin = _launch(id, alice, 4_000_000e18);
        assertLe(AgentCoin(coin).balanceOf(alice), SUPPLY * 500 / 10_000, "LA-15 within the cap");
    }

    function test_launch_first_buy_cap_error_names_the_cap() public {
        (uint256 id,) = _agent(alice);
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(al).call(
            abi.encodeCall(AgentLaunch.launch, (id, "Big", "BIG", bytes32(0), 10_000_000e18, 0))
        );
        assertFalse(ok);
        assertEq(bytes4(ret), IAgentLaunch.FirstBuyTooLarge.selector);
    }

    function test_launch_names_are_checked() public {
        (uint256 id,) = _agent(alice);
        vm.startPrank(alice);
        vm.expectRevert(IAgentLaunch.InvalidName.selector);
        al.launch(id, "", "AGC", bytes32(0), 0, 0);
        vm.expectRevert(IAgentLaunch.InvalidName.selector);
        al.launch(id, "Agent", "", bytes32(0), 0, 0);
        vm.expectRevert(IAgentLaunch.InvalidName.selector);
        al.launch(id, "123456789012345678901234567890123", "AGC", bytes32(0), 0, 0);
        vm.expectRevert(IAgentLaunch.InvalidName.selector);
        al.launch(id, "Agent", "12345678901", bytes32(0), 0, 0);
        vm.expectRevert(IAgentLaunch.InvalidName.selector);
        al.launch(id, "Agent\n", "AGC", bytes32(0), 0, 0);
        vm.expectRevert(IAgentLaunch.InvalidName.selector);
        al.launch(id, "Agent", string(abi.encodePacked("A", bytes1(0x7f))), bytes32(0), 0, 0);
        al.launch(id, "12345678901234567890123456789012", "1234567890", bytes32(0), 0, 0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- gates (LA-9, LA-10)

    function test_gate_not_controller() public {
        (uint256 id,) = _agent(alice);
        assertEq(uint8(al.canLaunch(id, bob)), uint8(IAgentLaunch.Gate.NotController));
        vm.prank(bob);
        vm.expectRevert(IAgentLaunch.NotController.selector);
        al.launch(id, "X", "X", bytes32(0), 0, 0);
        // an agent that does not exist
        assertEq(uint8(al.canLaunch(999, alice)), uint8(IAgentLaunch.Gate.NotController));
        vm.prank(alice);
        vm.expectRevert(IAgentLaunch.NotController.selector);
        al.launch(999, "X", "X", bytes32(0), 0, 0);
    }

    function test_gate_one_coin_per_agent() public {
        (uint256 id,) = _agent(alice);
        _launch(id, alice, 0);
        assertEq(uint8(al.canLaunch(id, alice)), uint8(IAgentLaunch.Gate.AlreadyLaunched));
        vm.prank(alice);
        vm.expectRevert(IAgentLaunch.AlreadyLaunched.selector);
        al.launch(id, "Second", "TWO", bytes32(uint256(7)), 0, 0);
    }

    function test_gate_not_verified() public {
        (uint256 id,) = _agent(alice);
        attestor.setVerified(id, false);
        assertEq(uint8(al.canLaunch(id, alice)), uint8(IAgentLaunch.Gate.NotVerified));
        vm.prank(alice);
        vm.expectRevert(IAgentLaunch.NotVerified.selector);
        al.launch(id, "X", "X", bytes32(0), 0, 0);
    }

    function test_gate_wallet_not_bound() public {
        (uint256 id, address wallet) = _agent(alice);
        module.setInstalled(wallet, false);
        assertEq(uint8(al.canLaunch(id, alice)), uint8(IAgentLaunch.Gate.WalletNotBound));
        vm.prank(alice);
        vm.expectRevert(IAgentLaunch.WalletNotBound.selector);
        al.launch(id, "X", "X", bytes32(0), 0, 0);
        module.setInstalled(wallet, true);
        vm.prank(alice);
        registry.setAgentWallet(id, address(0));
        assertEq(uint8(al.canLaunch(id, alice)), uint8(IAgentLaunch.Gate.WalletNotBound));
    }

    function test_gate_price_not_ready() public {
        (uint256 id,) = _agent(alice);
        price.setReverts(true);
        assertEq(uint8(al.canLaunch(id, alice)), uint8(IAgentLaunch.Gate.PriceNotReady));
        vm.prank(alice);
        vm.expectRevert(IAgentLaunch.PriceNotReady.selector);
        al.launch(id, "X", "X", bytes32(0), 0, 0);
    }

    function test_gate_stake_too_low() public {
        uint256 id = registry.register(bob);
        vm.prank(bob);
        registry.setAgentWallet(id, carol);
        attestor.setVerified(id, true);
        module.setInstalled(carol, true);
        vm.startPrank(bob);
        staking.stakeForAgent(id, 9_999e18); // 99.99 USD
        staking.extendAgentLock(id, uint64(block.timestamp + 91 days));
        vm.stopPrank();
        assertEq(uint8(al.canLaunch(id, bob)), uint8(IAgentLaunch.Gate.StakeTooLow));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IAgentLaunch.StakeTooLow.selector, 99_990_000, 100e6));
        al.launch(id, "X", "X", bytes32(0), 0, 0);
        vm.prank(bob);
        staking.stakeForAgent(id, 1e18);
        assertEq(uint8(al.canLaunch(id, bob)), uint8(IAgentLaunch.Gate.Ok), "exactly 100 USD passes");
    }

    function test_gate_lock_too_short() public {
        uint256 id = registry.register(bob);
        vm.prank(bob);
        registry.setAgentWallet(id, carol);
        attestor.setVerified(id, true);
        module.setInstalled(carol, true);
        vm.startPrank(bob);
        staking.stakeForAgent(id, 20_000e18);
        staking.extendAgentLock(id, uint64(block.timestamp + 90 days - 1));
        vm.stopPrank();
        assertEq(uint8(al.canLaunch(id, bob)), uint8(IAgentLaunch.Gate.LockTooShort));
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentLaunch.LockTooShort.selector, uint64(block.timestamp + 90 days - 1), uint64(block.timestamp + 90 days)
            )
        );
        al.launch(id, "X", "X", bytes32(0), 0, 0);
        vm.prank(bob);
        staking.extendAgentLock(id, uint64(block.timestamp + 90 days));
        assertEq(uint8(al.canLaunch(id, bob)), uint8(IAgentLaunch.Gate.Ok), "exactly 90 days passes");
    }

    function test_gate_stake_of_a_previous_owner_does_not_count() public {
        (uint256 id,) = _agent(alice);
        vm.prank(alice);
        registry.transferFrom(alice, bob, id);
        vm.prank(bob);
        registry.setAgentWallet(id, carol);
        module.setInstalled(carol, true);
        // the attestor's verification is bound to the paying owner; keep it true here to reach the stake gate
        assertEq(uint8(al.canLaunch(id, bob)), uint8(IAgentLaunch.Gate.StakeTooLow), "alice's position is not bob's");
    }

    function test_creator_stake_stays_locked_after_launch() public {
        (uint256 id,) = _agent(alice);
        _launch(id, alice, 0);
        IOrryStaking.AgentPosition memory pos = staking.agentStake(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOrryStaking.AgentStakeLocked.selector, pos.lockedUntil));
        staking.requestAgentUnstake(id, alice, 1e18);
    }

    // ---------------------------------------------------------------- early access (LA-11, LA-12)

    function _stake(address who, uint256 usd) internal {
        vm.prank(who);
        staking.stake(usd * 100e18 / 1e6);
    }

    function test_early_buy_within_the_stake_weighted_allowance() public {
        (uint256 id,) = _agent(alice);
        address coin = _launch(id, alice, 0);
        _stake(bob, 200e6); // 200 USD -> 20% of the full allowance
        uint256 allowance = al.earlyAllowance(coin, bob);
        assertEq(allowance, SUPPLY * 50 * 200e6 / (10_000 * 1_000e6), "0.1% of supply");
        vm.prank(bob);
        uint256 out = al.buyEarly(coin, 1_000e18, 1, block.timestamp);
        assertEq(AgentCoin(coin).balanceOf(bob), out);
        assertEq(al.earlyBought(coin, bob), out);
        assertEq(al.earlyAllowance(coin, bob), allowance - out);
        assertEq(hook.feesOf(_key(coin).toId()), 10e18, "early buys pay 1%");
    }

    function test_early_buy_over_allowance_reverts() public {
        (uint256 id,) = _agent(alice);
        address coin = _launch(id, alice, 0);
        _stake(bob, 20e6); // 0.01% of supply = 100,000 coins, about 8,300 ORRY
        vm.prank(bob);
        (bool ok, bytes memory ret) =
            address(al).call(abi.encodeCall(AgentLaunch.buyEarly, (coin, 50_000e18, 0, block.timestamp)));
        assertFalse(ok);
        assertEq(bytes4(ret), IAgentLaunch.OverEarlyAllowance.selector);
        assertEq(al.earlyBought(coin, bob), 0);
    }

    function test_early_buy_needs_a_stake() public {
        (uint256 id,) = _agent(alice);
        address coin = _launch(id, alice, 0);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IAgentLaunch.NotEarlyEligible.selector, 0, 10e6));
        al.buyEarly(coin, 1e18, 0, block.timestamp);
        _stake(carol, 9e6);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IAgentLaunch.NotEarlyEligible.selector, 9e6, 10e6));
        al.buyEarly(coin, 1e18, 0, block.timestamp);
        assertEq(al.earlyAllowance(coin, carol), 0);
    }

    function test_early_allowance_is_capped_at_full_weight_and_linear() public {
        (uint256 id,) = _agent(alice);
        address coin = _launch(id, alice, 0);
        _stake(bob, 5_000e6);
        _stake(carol, 1_000e6);
        assertEq(al.earlyAllowance(coin, bob), al.earlyAllowance(coin, carol), "capped at 1,000 USD");
        _stake(dave, 500e6);
        assertEq(al.earlyAllowance(coin, dave) * 2, al.earlyAllowance(coin, carol), "linear below the cap");
    }

    function test_early_buy_window_rules() public {
        (uint256 id,) = _agent(alice);
        address coin = _launch(id, alice, 0);
        _stake(bob, 200e6);
        vm.startPrank(bob);
        vm.expectRevert(IAgentLaunch.ZeroAmount.selector);
        al.buyEarly(coin, 0, 0, block.timestamp);
        vm.expectRevert(IAgentLaunch.DeadlinePassed.selector);
        al.buyEarly(coin, 1e18, 0, block.timestamp - 1);
        vm.expectRevert(IAgentLaunch.UnknownCoin.selector);
        al.buyEarly(address(0xBEEF), 1e18, 0, block.timestamp);
        vm.expectRevert();
        al.buyEarly(coin, 1e18, type(uint256).max, block.timestamp);
        vm.stopPrank();
        price.setReverts(true);
        vm.prank(bob);
        vm.expectRevert(IAgentLaunch.PriceNotReady.selector);
        al.buyEarly(coin, 1e18, 0, block.timestamp);
        price.setReverts(false);
        _warp(EARLY);
        vm.prank(bob);
        vm.expectRevert(IAgentLaunch.EarlyWindowClosed.selector);
        al.buyEarly(coin, 1e18, 0, block.timestamp);
        assertEq(al.earlyAllowance(coin, bob), 0, "no allowance after the window");
    }

    function test_public_buy_refused_in_the_early_window_sell_allowed() public {
        (uint256 id,) = _agent(alice);
        address coin = _launch(id, alice, 10_000e18);
        PoolKey memory key = _key(coin);
        _approveCoin(bob, coin);
        vm.expectRevert();
        _rawSwap(bob, key, true, -1e18);
        // the creator sells part of the first buy inside the early window through a public router
        uint256 coins = AgentCoin(coin).balanceOf(alice) / 2;
        uint256 out = _sell(alice, coin, coins);
        assertGt(out, 0, "LA-11 sells are never refused");
    }

    function test_no_early_window_opens_to_the_public_at_once() public {
        (SpokeHook h2, AgentLaunch a2) = deployLaunch(defaultParams(), START_FEE, DECAY, 0, 2);
        hook = h2;
        al = a2;
        (uint256 id,) = _agent(alice);
        vm.prank(alice);
        orry.approve(address(al), type(uint256).max);
        address coin = _launch(id, alice, 0);
        _stake(bob, 200e6);
        vm.prank(bob);
        orry.approve(address(al), type(uint256).max);
        vm.prank(bob);
        vm.expectRevert(IAgentLaunch.EarlyWindowClosed.selector);
        al.buyEarly(coin, 1e18, 0, block.timestamp);
        uint256 fees = hook.feesOf(_key(coin).toId());
        _buy(bob, coin, 1_000e18);
        assertEq(hook.feesOf(_key(coin).toId()) - fees, 800e18, "the launch fee applies from the opening second");
    }

    // ---------------------------------------------------------------- distribution (LA-1 to LA-3)

    function _trade(address coin) internal {
        _buy(bob, coin, 100_000e18);
        _sell(bob, coin, AgentCoin(coin).balanceOf(bob) / 2);
    }

    function test_distribute_splits_50_20_15_15() public {
        (address coin,) = _launchOpen(alice);
        _trade(coin);
        uint256 fees = al.pendingFees(coin);
        assertGt(fees, 0);
        assertEq(_claims(address(al)), fees, "LA-1 claims match pending fees");
        uint256 supply = orry.totalSupply();
        uint256 ownerBefore = orry.balanceOf(ownerWallet);
        vm.expectEmit(true, false, false, true, address(al));
        emit IOrryBurnEvents.Burned(50, fees - fees * 5000 / 10_000 - fees * 2000 / 10_000 - fees * 1500 / 10_000);
        vm.prank(dave);
        uint256 amount = al.distribute(coin);
        assertEq(amount, fees);
        uint256 creator = fees * 5000 / 10_000;
        uint256 earn = fees * 2000 / 10_000;
        uint256 owner = fees * 1500 / 10_000;
        assertEq(al.creatorOwed(coin), creator, "LA-3 creator");
        assertEq(vault.notified(), earn, "LA-3 Earn, first notification at once");
        assertEq(orry.balanceOf(ownerWallet) - ownerBefore, owner, "LA-3 owner");
        assertEq(supply - orry.totalSupply(), fees - creator - earn - owner, "LA-3 burn takes the rest");
        assertEq(_claims(address(al)), 0, "LA-1 claims redeemed");
        assertEq(orry.balanceOf(address(al)), al.creatorOwed(coin) + al.earnPending(), "LA-2");
        assertEq(al.pendingFees(coin), 0);
        assertEq(al.distribute(coin), 0, "nothing pending: quiet no-op");
    }

    function test_earn_is_notified_at_most_hourly() public {
        (address coin,) = _launchOpen(alice);
        _trade(coin);
        al.distribute(coin);
        assertEq(vault.calls(), 1);
        _trade(coin);
        al.distribute(coin);
        assertEq(vault.calls(), 1, "inside the hour: pending");
        uint256 pending = al.earnPending();
        assertGt(pending, 0);
        assertEq(al.flushEarn(), 0);
        _warp(1 hours);
        assertEq(al.flushEarn(), pending);
        assertEq(vault.calls(), 2);
        assertEq(al.earnPending(), 0);
        assertEq(orry.balanceOf(address(al)), al.creatorOwed(coin), "LA-2");
    }

    function test_a_refusing_vault_does_not_block_distribution() public {
        (address coin,) = _launchOpen(alice);
        _trade(coin);
        vault.setReverts(true);
        uint256 fees = al.pendingFees(coin);
        al.distribute(coin);
        assertEq(al.earnPending(), fees * 2000 / 10_000, "the Earn share waits");
        assertEq(orry.allowance(address(al), address(vault)), 0, "allowance cleared");
        vault.setReverts(false);
        al.flushEarn();
        assertEq(al.earnPending(), 0);
        assertEq(vault.notified(), fees * 2000 / 10_000);
    }

    function test_owner_share_burned_when_the_treasury_has_no_owner() public {
        (address coin,) = _launchOpen(alice);
        _trade(coin);
        treasury.setOwner(address(0));
        uint256 fees = al.pendingFees(coin);
        uint256 supply = orry.totalSupply();
        al.distribute(coin);
        assertEq(supply - orry.totalSupply(), fees - fees * 5000 / 10_000 - fees * 2000 / 10_000);
    }

    function test_distribute_unknown_coin() public {
        vm.expectRevert(IAgentLaunch.UnknownCoin.selector);
        al.distribute(address(0xBEEF));
        vm.expectRevert(IAgentLaunch.UnknownCoin.selector);
        al.claimCreatorFees(address(0xBEEF));
        assertEq(al.pendingFees(address(0xBEEF)), 0);
    }

    // ---------------------------------------------------------------- creator claims (LA-13)

    function test_creator_fees_go_to_the_bound_wallet_only() public {
        (address coin, uint256 id) = _launchOpen(alice);
        address wallet = registry.getAgentWallet(id);
        _trade(coin);
        uint256 fees = al.pendingFees(coin);
        vm.prank(dave); // anyone may run it
        uint256 paid = al.claimCreatorFees(coin);
        assertEq(paid, fees * 5000 / 10_000);
        assertEq(orry.balanceOf(wallet), paid, "paid to the agent's bound account");
        assertEq(orry.balanceOf(dave), 1e28, "nothing to the caller");
        assertEq(al.creatorOwed(coin), 0);
        vm.expectRevert(IAgentLaunch.NothingToClaim.selector);
        al.claimCreatorFees(coin);
    }

    function test_creator_fees_wait_while_the_wallet_is_not_bound() public {
        (address coin, uint256 id) = _launchOpen(alice);
        address wallet = registry.getAgentWallet(id);
        _trade(coin);
        module.setInstalled(wallet, false);
        vm.expectRevert(abi.encodeWithSelector(IAgentLaunch.CreatorWalletNotBound.selector, wallet));
        al.claimCreatorFees(coin);
        // the identity moves: the mock registry clears the wallet like ERC-8004 does
        vm.prank(alice);
        registry.transferFrom(alice, bob, id);
        vm.expectRevert(abi.encodeWithSelector(IAgentLaunch.CreatorWalletNotBound.selector, address(0)));
        al.claimCreatorFees(coin);
        vm.prank(bob);
        registry.setAgentWallet(id, carol);
        module.setInstalled(carol, true);
        uint256 owed = al.creatorOwed(coin) + al.pendingFees(coin) * 5000 / 10_000;
        uint256 carolBefore = orry.balanceOf(carol);
        uint256 paid = al.claimCreatorFees(coin);
        assertEq(paid, owed);
        assertEq(orry.balanceOf(carol) - carolBefore, paid, "the share follows the identity to its new bound account");
        assertEq(orry.balanceOf(wallet), 0);
    }

    // ---------------------------------------------------------------- views

    function test_coins_paging() public {
        address[] memory made = new address[](3);
        address[3] memory owners = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            (uint256 id,) = _agent(owners[i]);
            made[i] = _launch(id, owners[i], 0);
        }
        address[] memory page = al.coins(1, 5);
        assertEq(page.length, 2);
        assertEq(page[0], made[1]);
        assertEq(page[1], made[2]);
        assertEq(al.coins(3, 1).length, 0);
        assertEq(al.coins(0, 2).length, 2);
    }

    function test_unlock_callback_only_from_the_pool_manager() public {
        vm.expectRevert(IAgentLaunch.NotPoolManager.selector);
        al.unlockCallback(abi.encode(uint8(2), address(0), uint256(1), address(0)));
    }
}

/// @notice With ORRY at a high address half the salts give a coin below it: `launch` refuses those and `predictCoin`
/// finds a good salt off chain (L5-2).
contract AgentLaunchHighOrryTest is LaunchBase {
    function orryAt() internal pure override returns (address) {
        return 0x85272EA3aE8685C768045dba5455fE305C706aA4; // the real ORRY address: about half the salts sort below it
    }

    function test_coin_below_orry_is_refused_and_a_mined_salt_works() public {
        (uint256 id,) = _agent(alice);
        bytes32 bad;
        bytes32 good;
        bool haveBad;
        bool haveGood;
        address rc = address(orry);
        for (uint256 i; i < 64 && !(haveBad && haveGood); ++i) {
            address c = al.predictCoin(alice, bytes32(i), "Agent Coin", "AGC");
            if (uint160(c) <= uint160(rc) && !haveBad) {
                bad = bytes32(i);
                haveBad = true;
            }
            if (uint160(c) > uint160(rc) && !haveGood) {
                good = bytes32(i);
                haveGood = true;
            }
        }
        assertTrue(haveBad && haveGood, "both kinds within 64 salts");
        vm.prank(alice);
        vm.expectRevert(IAgentLaunch.CoinSortsBelowOrry.selector);
        al.launch(id, "Agent Coin", "AGC", bad, 0, 0);
        vm.prank(alice);
        address coin = al.launch(id, "Agent Coin", "AGC", good, 0, 0);
        assertEq(coin, al.predictCoin(alice, good, "Agent Coin", "AGC"));
    }
}
