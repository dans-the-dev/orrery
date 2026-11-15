// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CreditBase, CreditOracle} from "./CreditBase.sol";
import {IERC20Min, IIdentityRegistry} from "../../src/interfaces/IExternal.sol";
import {IOrryPriceOracle} from "../../src/markets/interfaces/IMarketPricing.sol";
import {CreditPool, IAttestorVerified} from "../../src/credit/CreditPool.sol";
import {CreditPoolFactory} from "../../src/credit/CreditPoolFactory.sol";
import {CreditRevenueRouter} from "../../src/credit/CreditRevenueRouter.sol";

contract CreditPoolTest is CreditBase {
    address internal lender = makeAddr("lender");
    address internal lender2 = makeAddr("lender2");
    address internal op = makeAddr("operator");
    address internal wallet = makeAddr("agentWallet");
    uint256 internal agent;
    uint256 internal constant BOND = 100_000e18; // 1,000 USDG at 0.01

    function setUp() public override {
        super.setUp();
        agent = newVerifiedAgent(op, wallet);
    }

    // ------------------------------------------------------------------ factory and params

    function test_factory_onlyTreasuryOwner() public {
        CreditPool.Params memory p = defaultParams();
        vm.expectRevert(CreditPoolFactory.NotTreasuryOwner.selector);
        factory.createPool(p);
        vm.prank(ops);
        address second = factory.createPool(p);
        assertTrue(factory.isPool(second));
        assertEq(factory.poolCount(), 2);
        assertEq(factory.pools()[1], second);
        vm.expectRevert(CreditPoolFactory.NotTreasuryOwner.selector);
        factory.retire(second);
        vm.prank(ops);
        vm.expectRevert(CreditPoolFactory.UnknownPool.selector);
        factory.retire(address(0xBAD));
        vm.prank(ops);
        factory.retire(second);
        assertTrue(CreditPool(second).retired());
        vm.expectRevert(CreditPool.NotFactory.selector);
        pool.retire();
    }

    function deployFactory(
        IERC20Min u,
        IERC20Min r,
        IOrryPriceOracle o,
        IIdentityRegistry i,
        IAttestorVerified a,
        address t
    ) external returns (CreditPoolFactory) {
        return new CreditPoolFactory(u, r, o, i, a, t);
    }

    function deployPool(
        IERC20Min u,
        IERC20Min r,
        IOrryPriceOracle o,
        IIdentityRegistry i,
        IAttestorVerified a,
        address t
    ) external returns (CreditPool) {
        return new CreditPool(u, r, o, i, a, t, defaultParams());
    }

    function test_factory_constructorZeroAddress() public {
        IERC20Min u = IERC20Min(address(usdg));
        IERC20Min r = IERC20Min(address(orry));
        IOrryPriceOracle o = IOrryPriceOracle(address(oracle));
        IIdentityRegistry i = IIdentityRegistry(address(identity));
        IAttestorVerified a = IAttestorVerified(address(attestor));
        address t = address(treasury);
        vm.expectRevert(CreditPoolFactory.ZeroAddress.selector);
        this.deployFactory(IERC20Min(address(0)), r, o, i, a, t);
        vm.expectRevert(CreditPoolFactory.ZeroAddress.selector);
        this.deployFactory(u, IERC20Min(address(0)), o, i, a, t);
        vm.expectRevert(CreditPoolFactory.ZeroAddress.selector);
        this.deployFactory(u, r, IOrryPriceOracle(address(0)), i, a, t);
        vm.expectRevert(CreditPoolFactory.ZeroAddress.selector);
        this.deployFactory(u, r, o, IIdentityRegistry(address(0)), a, t);
        vm.expectRevert(CreditPoolFactory.ZeroAddress.selector);
        this.deployFactory(u, r, o, i, IAttestorVerified(address(0)), t);
        vm.expectRevert(CreditPoolFactory.ZeroAddress.selector);
        this.deployFactory(u, r, o, i, a, address(0));
        assertEq(address(this.deployFactory(u, r, o, i, a, t).treasury()), t);
        vm.expectRevert(CreditPool.ZeroAddress.selector);
        this.deployPool(IERC20Min(address(0)), r, o, i, a, t);
        vm.expectRevert(CreditPool.ZeroAddress.selector);
        this.deployPool(u, IERC20Min(address(0)), o, i, a, t);
        vm.expectRevert(CreditPool.ZeroAddress.selector);
        this.deployPool(u, r, IOrryPriceOracle(address(0)), i, a, t);
        vm.expectRevert(CreditPool.ZeroAddress.selector);
        this.deployPool(u, r, o, IIdentityRegistry(address(0)), a, t);
        vm.expectRevert(CreditPool.ZeroAddress.selector);
        this.deployPool(u, r, o, i, IAttestorVerified(address(0)), t);
        vm.expectRevert(CreditPool.ZeroAddress.selector);
        this.deployPool(u, r, o, i, a, address(0));
        assertEq(this.deployPool(u, r, o, i, a, t).factory(), address(this));
    }

    function test_params_validated() public {
        CreditPool.Params memory p;
        p = defaultParams(); p.aprBps = 0; _badParams(p);
        p = defaultParams(); p.aprBps = 5001; _badParams(p);
        p = defaultParams(); p.feeBps = 2001; _badParams(p);
        p = defaultParams(); p.repayBps = 0; _badParams(p);
        p = defaultParams(); p.repayBps = 10_001; _badParams(p);
        p = defaultParams(); p.maxLineBps = 0; _badParams(p);
        p = defaultParams(); p.maxLineBps = 10_001; _badParams(p);
        p = defaultParams(); p.term = 1 days - 1; _badParams(p);
        p = defaultParams(); p.grace = 1 days - 1; _badParams(p);
        p = defaultParams(); p.maxLineUsdg = 0; _badParams(p);
        p = defaultParams(); p.tierRepaid[0] = 1; _badParams(p);
        p = defaultParams(); p.tierMultBps[0] = 0; _badParams(p);
        p = defaultParams(); p.tierRepaid[2] = p.tierRepaid[1]; _badParams(p);
        p = defaultParams(); p.tierMultBps[2] = p.tierMultBps[1] - 1; _badParams(p);
        p = defaultParams(); p.tierMultBps[3] = 50_001; _badParams(p);
        p = defaultParams(); p.aprBps = 5000; p.feeBps = 2000; p.repayBps = 10_000; p.maxLineBps = 10_000;
        p.term = 1 days; p.grace = 1 days; p.tierMultBps[3] = 50_000;
        vm.prank(ops);
        factory.createPool(p);
    }

    function _badParams(CreditPool.Params memory p) internal {
        vm.prank(ops);
        vm.expectRevert(CreditPool.BadParams.selector);
        factory.createPool(p);
    }

    // ------------------------------------------------------------------ lenders

    function test_deposit_withdraw_roundTrip() public {
        uint256 s = lend(lender, 1_000 * U);
        assertEq(s, 1_000 * U * 1e6);
        assertEq(pool.cash(), 1_000 * U);
        assertEq(pool.totalAssets(), 1_000 * U);
        assertEq(pool.valueOf(lender), 1_000 * U);
        vm.prank(lender);
        vm.expectRevert(CreditPool.ZeroAmount.selector);
        pool.withdraw(0);
        vm.prank(lender);
        vm.expectRevert(CreditPool.InsufficientShares.selector);
        pool.withdraw(s + 1);
        vm.prank(lender);
        uint256 got = pool.withdraw(s);
        assertEq(got, 1_000 * U);
        assertEq(usdg.balanceOf(lender), got);
        assertEq(pool.totalShares(), 0);
    }

    function test_deposit_refusals() public {
        vm.prank(lender);
        vm.expectRevert(CreditPool.ZeroAmount.selector);
        pool.deposit(0);
        vm.prank(lender);
        vm.expectRevert(CreditPool.TransferFailed.selector);
        pool.deposit(U); // no allowance
        vm.prank(ops);
        factory.retire(address(pool));
        usdg.mint(lender, U);
        vm.startPrank(lender);
        usdg.approve(address(pool), U);
        vm.expectRevert(CreditPool.PoolRetired.selector);
        pool.deposit(U);
        vm.stopPrank();
    }

    function test_deposit_tinyAmountStillMintsShares() public {
        lend(lender, 10_000 * U);
        // make one share worth more than one unit by paying interest in, then deposit 1 unit
        _openAndDraw(500 * U);
        warp(365 days);
        repayAs(op, agent, 1_000 * U);
        // value per share is now above 1e-6 USDG; 1 unit still mints shares thanks to the 1e6 virtual scale
        assertGt(lend(lender2, 1), 0);
    }

    function test_donation_doesNotMoveShareValue() public {
        lend(lender, 1_000 * U);
        uint256 before = pool.valueOf(lender);
        usdg.mint(address(pool), 500 * U);
        assertEq(pool.valueOf(lender), before);
        assertEq(pool.cash(), 1_000 * U);
    }

    function test_withdraw_limitedByCashNotPausedByRetire() public {
        uint256 s = lend(lender, 10_000 * U);
        _openAndDraw(1_000 * U);
        vm.prank(ops);
        factory.retire(address(pool));
        vm.prank(lender);
        vm.expectRevert(CreditPool.InsufficientCash.selector);
        pool.withdraw(s);
        vm.prank(lender);
        uint256 got = pool.withdraw(s * 9 / 10 - 1e6);
        assertApproxEqAbs(got, 9_000 * U, 3);
    }

    // ------------------------------------------------------------------ bonds and lines

    function test_postBond_opensLineOnce() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(CreditPool.ZeroAmount.selector);
        pool.postBond(agent, 0);
        orry.mint(makeAddr("stranger"), M);
        vm.startPrank(makeAddr("stranger"));
        orry.approve(address(pool), M);
        vm.expectRevert(CreditPool.NotAgentOwner.selector);
        pool.postBond(agent, M);
        vm.stopPrank();
        bond(op, agent, BOND);
        CreditPool.Line memory l = pool.lineOf(agent);
        assertEq(l.bondOwner, op);
        assertEq(l.bond, BOND);
        assertTrue(l.router != address(0));
        assertEq(pool.routerOf(agent), l.router);
        assertEq(CreditRevenueRouter(l.router).agentId(), agent);
        assertEq(CreditRevenueRouter(l.router).repayBps(), 5000);
        bond(op, agent, BOND);
        assertEq(pool.lineOf(agent).bond, 2 * BOND);
        assertEq(pool.lineOf(agent).router, l.router, "same router");
        assertEq(pool.totalBonds(), 2 * BOND);
        assertEq(orry.balanceOf(address(pool)), 2 * BOND);
    }

    function test_postBond_newOwnerTakesOverOnlyAnEmptyLine() public {
        bond(op, agent, BOND);
        address buyer = makeAddr("buyer");
        vm.prank(op);
        identity.transferFrom(op, buyer, agent);
        orry.mint(buyer, M);
        vm.startPrank(buyer);
        orry.approve(address(pool), M);
        vm.expectRevert(CreditPool.NotBondOwner.selector);
        pool.postBond(agent, M);
        vm.stopPrank();
        vm.prank(op);
        pool.withdrawBond(agent, BOND);
        vm.prank(buyer);
        pool.postBond(agent, M);
        assertEq(pool.lineOf(agent).bondOwner, buyer);
    }

    function test_withdrawBond_rules() public {
        bond(op, agent, BOND);
        vm.prank(makeAddr("x"));
        vm.expectRevert(CreditPool.NotBondOwner.selector);
        pool.withdrawBond(agent, 1);
        vm.prank(op);
        vm.expectRevert(CreditPool.ZeroAmount.selector);
        pool.withdrawBond(agent, 0);
        lend(lender, 50_000 * U);
        vm.prank(op);
        pool.draw(agent, 10 * U);
        vm.prank(op);
        vm.expectRevert(CreditPool.DebtOutstanding.selector);
        pool.withdrawBond(agent, 1);
        repayAs(op, agent, 11 * U);
        vm.prank(op);
        pool.withdrawBond(agent, BOND);
        assertEq(orry.balanceOf(op), BOND);
        assertEq(pool.totalBonds(), 0);
    }

    // ------------------------------------------------------------------ draw

    function test_draw_paysAgentWallet_setsDueOnce() public {
        lend(lender, 50_000 * U);
        bond(op, agent, BOND);
        assertEq(pool.limitOf(agent), 1_000 * U);
        vm.prank(op);
        pool.draw(agent, 400 * U);
        assertEq(usdg.balanceOf(wallet), 400 * U);
        CreditPool.Line memory l = pool.lineOf(agent);
        assertEq(l.principal, 400 * U);
        assertEq(l.dueAt, clock + 30 days);
        warp(10 days);
        vm.prank(op);
        pool.draw(agent, 100 * U);
        assertEq(pool.lineOf(agent).dueAt, l.dueAt, "a later draw never moves the due date");
        assertEq(pool.totalPrincipal(), 500 * U);
        assertEq(pool.cash(), 49_500 * U);
        assertEq(pool.totalAssets(), 50_000 * U);
    }

    function test_draw_paysOwnerWhenNoWallet() public {
        address op2 = makeAddr("op2");
        uint256 a2 = newVerifiedAgent(op2, op2);
        vm.prank(op2);
        identity.setAgentWallet(a2, address(0));
        lend(lender, 50_000 * U);
        bond(op2, a2, BOND);
        vm.prank(op2);
        pool.draw(a2, 10 * U);
        assertEq(usdg.balanceOf(op2), 10 * U);
        assertEq(pool.payoutOf(a2), op2);
    }

    function test_draw_refusals() public {
        lend(lender, 50_000 * U);
        vm.prank(op);
        vm.expectRevert(CreditPool.NotBondOwner.selector);
        pool.draw(agent, U);
        bond(op, agent, BOND);
        vm.prank(op);
        vm.expectRevert(CreditPool.ZeroAmount.selector);
        pool.draw(agent, 0);
        vm.prank(makeAddr("x"));
        vm.expectRevert(CreditPool.NotBondOwner.selector);
        pool.draw(agent, U);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(CreditPool.OverLimit.selector, 1_000 * U));
        pool.draw(agent, 1_000 * U + 1);
        oracle.setReady(false);
        vm.prank(op);
        vm.expectRevert(CreditOracle.OracleNotReady.selector);
        pool.draw(agent, U);
        assertEq(pool.limitOf(agent), 0);
        oracle.setReady(true);
        oracle.set(200); // bond now worth 20 USDG, under the 25 USDG minimum
        vm.prank(op);
        vm.expectRevert(CreditPool.BondTooSmall.selector);
        pool.draw(agent, U);
        assertEq(pool.limitOf(agent), 0);
        oracle.set(10_000);
        // owner changed: the bond owner can no longer draw
        vm.prank(op);
        identity.transferFrom(op, makeAddr("buyer"), agent);
        vm.prank(op);
        vm.expectRevert(CreditPool.NotAgentOwner.selector);
        pool.draw(agent, U);
    }

    function test_draw_notVerified() public {
        address op2 = makeAddr("op2");
        vm.prank(op2);
        uint256 a2 = identity.register(op2);
        lend(lender, 50_000 * U);
        bond(op2, a2, BOND);
        vm.prank(op2);
        vm.expectRevert(CreditPool.NotVerified.selector);
        pool.draw(a2, U);
    }

    function test_draw_caps() public {
        lend(lender, 5_000 * U); // pool cap 10% = 500
        bond(op, agent, BOND); // bond 1,000
        assertEq(pool.limitOf(agent), 500 * U);
        lend(lender, 200_000 * U); // pool cap 20,500
        bond(op, agent, 9 * BOND); // bond 10,000
        assertEq(pool.limitOf(agent), 10_000 * U);
        bond(op, agent, 5 * BOND); // bond 15,000, capped by maxLineUsdg
        assertEq(pool.limitOf(agent), 10_000 * U);
    }

    function test_draw_insufficientCashAndRetired() public {
        lend(lender, 50_000 * U);
        bond(op, agent, BOND);
        address op2 = makeAddr("op2");
        uint256 a2 = newVerifiedAgent(op2, op2);
        bond(op2, a2, 50 * BOND);
        // drain cash with lender withdrawals after lending most of it out
        vm.prank(op2);
        pool.draw(a2, 5_000 * U);
        uint256 part = pool.sharesOf(lender) * 44_900 / 50_000;
        vm.prank(lender);
        pool.withdraw(part);
        assertLt(pool.cash(), 200 * U);
        vm.prank(op);
        vm.expectRevert(CreditPool.InsufficientCash.selector);
        pool.draw(agent, 200 * U);
        vm.prank(ops);
        factory.retire(address(pool));
        vm.prank(op);
        vm.expectRevert(CreditPool.PoolRetired.selector);
        pool.draw(agent, U);
    }

    // ------------------------------------------------------------------ interest and repay

    function test_interest_accruesSimpleRoundedUp() public {
        lend(lender, 50_000 * U);
        _openAndDraw(1_000 * U);
        warp(30 days);
        // 1,000 * 12% * 30/365 = 9.863013698... -> 9.863014
        assertEq(pool.lineOf(agent).interest, 9_863_014);
        assertEq(pool.owedOf(agent), 1_009_863_014);
    }

    function test_repay_interestFirstFeeToTreasury() public {
        lend(lender, 50_000 * U);
        _openAndDraw(1_000 * U);
        warp(30 days);
        uint256 cashBefore = pool.cash();
        uint256 paid = repayAs(op, agent, 5 * U);
        assertEq(paid, 5 * U);
        assertEq(usdg.balanceOf(address(treasury)), 500_000, "10% of interest");
        assertEq(pool.cash() - cashBefore, 4_500_000);
        CreditPool.Line memory l = pool.lineOf(agent);
        assertEq(l.interest, 4_863_014);
        assertEq(l.principal, 1_000 * U);
        // overpaying pulls only what is owed, then the line is clear
        paid = repayAs(op, agent, 2_000 * U);
        assertEq(paid, 1_004_863_014);
        l = pool.lineOf(agent);
        assertEq(l.principal + l.interest, 0);
        assertEq(l.dueAt, 0);
        assertEq(usdg.balanceOf(address(treasury)), 986_301, "fee on interest only: floor(9.863014 * 10%)");
        assertEq(pool.totalPrincipal(), 0);
        assertEq(l.repaidUsdDays, 1_000 * U * 30);
        vm.expectRevert(CreditPool.NothingOwed.selector);
        pool.repay(agent, 1);
    }

    function test_repay_zeroAmount() public {
        lend(lender, 50_000 * U);
        _openAndDraw(10 * U);
        vm.expectRevert(CreditPool.ZeroAmount.selector);
        pool.repay(agent, 0);
    }

    function test_lenderValueGrowsOnlyWhenInterestIsPaid() public {
        lend(lender, 50_000 * U);
        uint256 v0 = pool.valueOf(lender);
        _openAndDraw(1_000 * U);
        warp(30 days);
        assertEq(pool.valueOf(lender), v0, "accrued interest is not counted");
        repayAs(op, agent, 2_000 * U);
        assertApproxEqAbs(pool.valueOf(lender), v0 + 9_863_014 - 986_301, 1);
    }

    function test_tiers_growWithRepaidDays_notWithFastCycling() public {
        lend(lender, 500_000 * U);
        bond(op, agent, BOND);
        // cycling 1,000 in and out within the same second earns no tier
        for (uint256 i; i < 5; ++i) {
            vm.prank(op);
            pool.draw(agent, 1_000 * U);
            repayAs(op, agent, 1_000 * U);
        }
        assertEq(pool.lineOf(agent).repaidUsdDays, 0);
        assertEq(pool.limitOf(agent), 1_000 * U);
        // 1,000 for 8 days = 8,000 USDG-days, past the 7,500 threshold: 1.5x
        vm.prank(op);
        pool.draw(agent, 1_000 * U);
        warp(8 days);
        repayAs(op, agent, 2_000 * U);
        assertEq(pool.lineOf(agent).repaidUsdDays, 8_000 * U);
        assertEq(pool.limitOf(agent), 1_500 * U);
        assertEq(pool.tierMultBps(75_000 * U), 20_000);
        assertEq(pool.tierMultBps(750_000 * U), 30_000);
        (uint128[4] memory r, uint16[4] memory m) = pool.tiers();
        assertEq(r[1], 7_500 * U);
        assertEq(m[3], 30_000);
    }

    function test_tiers_ageCappedAtTerm() public {
        lend(lender, 500_000 * U);
        _openAndDraw(1_000 * U);
        warp(36 days); // past the term, before default
        repayAs(op, agent, 2_000 * U);
        assertEq(pool.lineOf(agent).repaidUsdDays, 1_000 * U * 30);
    }

    // ------------------------------------------------------------------ router

    function test_router_repaysShareThenPaysAgent() public {
        lend(lender, 50_000 * U);
        _openAndDraw(100 * U);
        CreditRevenueRouter r = CreditRevenueRouter(pool.routerOf(agent));
        vm.expectRevert(CreditRevenueRouter.NothingToSweep.selector);
        r.sweep();
        usdg.mint(address(r), 60 * U); // x402 revenue
        (uint256 toPool, uint256 toAgent) = r.sweep();
        assertEq(toPool, 30 * U);
        assertEq(toAgent, 30 * U);
        assertEq(usdg.balanceOf(wallet), 100 * U + 30 * U);
        assertEq(pool.lineOf(agent).principal, 70 * U);
        // owed caps the pool's part
        usdg.mint(address(r), 1_000 * U);
        (toPool, toAgent) = r.sweep();
        assertEq(toPool, 70 * U);
        assertEq(toAgent, 930 * U);
        assertEq(usdg.balanceOf(address(r)), 0);
        assertEq(r.revenue(), 1_060 * U);
        // nothing owed: everything to the agent
        usdg.mint(address(r), 5 * U);
        (toPool, toAgent) = r.sweep();
        assertEq(toPool, 0);
        assertEq(toAgent, 5 * U);
    }

    function test_router_blockedWalletKeepsRemainder() public {
        lend(lender, 50_000 * U);
        _openAndDraw(100 * U);
        CreditRevenueRouter r = CreditRevenueRouter(pool.routerOf(agent));
        usdg.setBlocked(wallet, true);
        usdg.mint(address(r), 10 * U);
        (uint256 toPool, uint256 toAgent) = r.sweep();
        assertEq(toPool, 5 * U);
        assertEq(toAgent, 0);
        assertEq(usdg.balanceOf(address(r)), 5 * U, "kept for the next sweep");
        usdg.setBlocked(wallet, false);
        (toPool, toAgent) = r.sweep();
        assertEq(toPool, 2_500_000);
        assertEq(toAgent, 2_500_000);
    }

    // ------------------------------------------------------------------ default

    function test_liquidate_onlyAfterDuePlusGrace_bondToLenders() public {
        lend(lender, 30_000 * U);
        lend(lender2, 10_000 * U);
        _openAndDraw(1_000 * U);
        vm.expectRevert(CreditPool.NotDue.selector);
        pool.liquidate(agent);
        warp(37 days);
        vm.expectRevert(CreditPool.NotDue.selector);
        pool.liquidate(agent);
        warp(1);
        uint256 v1 = pool.valueOf(lender);
        pool.liquidate(agent);
        CreditPool.Line memory l = pool.lineOf(agent);
        assertTrue(l.defaulted);
        assertEq(l.bond, 0);
        assertEq(l.principal, 0);
        assertGt(l.recovery, 1_000 * U);
        assertEq(pool.totalPrincipal(), 0);
        assertEq(pool.totalBonds(), 0);
        assertEq(pool.seizedUnclaimed(), 50 * BOND);
        assertLt(pool.valueOf(lender), v1, "lenders absorb the written-off principal");
        // ORRY split 3:1 by shares
        assertApproxEqAbs(pool.orryClaimable(lender), 50 * BOND * 3 / 4, 1e6);
        assertApproxEqAbs(pool.orryClaimable(lender2), 50 * BOND / 4, 1e6);
        vm.prank(lender);
        uint256 got = pool.claimOrry();
        assertEq(orry.balanceOf(lender), got);
        vm.prank(lender);
        vm.expectRevert(CreditPool.ZeroAmount.selector);
        pool.claimOrry();
        // defaulted is terminal for the line
        orry.mint(op, M);
        vm.startPrank(op);
        orry.approve(address(pool), M);
        vm.expectRevert(CreditPool.LineDefaulted.selector);
        pool.postBond(agent, M);
        vm.expectRevert(CreditPool.LineDefaulted.selector);
        pool.draw(agent, U);
        vm.stopPrank();
        vm.expectRevert(CreditPool.NothingOwed.selector);
        pool.liquidate(agent);
        // later revenue repays the recovery to lenders
        uint256 v2 = pool.valueOf(lender);
        CreditRevenueRouter r = CreditRevenueRouter(pool.routerOf(agent));
        usdg.mint(address(r), 100 * U);
        r.sweep();
        assertEq(pool.lineOf(agent).recovery, l.recovery - 50 * U);
        assertGt(pool.valueOf(lender), v2);
        assertEq(usdg.balanceOf(address(treasury)), 0, "no fee on recoveries");
    }

    function test_liquidate_noDebt() public {
        bond(op, agent, BOND);
        vm.expectRevert(CreditPool.NothingOwed.selector);
        pool.liquidate(agent);
    }

    function test_donation_thenDeposit_booksOnlyDeposits() public {
        lend(lender, 1_000 * U);
        uint256 v = pool.valueOf(lender);
        usdg.mint(address(pool), 500 * U);
        lend(lender2, 1_000 * U);
        assertEq(pool.cash(), 2_000 * U, "a donation is never booked");
        assertEq(pool.valueOf(lender), v);
    }

    function test_shortTransferTokensRefused() public {
        ShortToken st = new ShortToken();
        CreditPool p2 = this.deployPool(
            IERC20Min(address(st)),
            IERC20Min(address(orry)),
            IOrryPriceOracle(address(oracle)),
            IIdentityRegistry(address(identity)),
            IAttestorVerified(address(attestor)),
            address(treasury)
        );
        st.mint(lender, 100 * U);
        vm.startPrank(lender);
        st.approve(address(p2), 100 * U);
        vm.expectRevert(CreditPool.InexactTransfer.selector);
        p2.deposit(100 * U);
        vm.stopPrank();
        ShortToken sr = new ShortToken();
        CreditPool p3 = this.deployPool(
            IERC20Min(address(usdg)),
            IERC20Min(address(sr)),
            IOrryPriceOracle(address(oracle)),
            IIdentityRegistry(address(identity)),
            IAttestorVerified(address(attestor)),
            address(treasury)
        );
        sr.mint(op, BOND);
        vm.startPrank(op);
        sr.approve(address(p3), BOND);
        vm.expectRevert(CreditPool.InexactTransfer.selector);
        p3.postBond(agent, BOND);
        vm.stopPrank();
    }

    function test_draw_limitCountsAccruedInterest() public {
        lend(lender, 50_000 * U);
        bond(op, agent, BOND); // limit 1,000
        vm.prank(op);
        pool.draw(agent, 900 * U);
        warp(30 days); // about 8.88 USDG of interest
        uint256 limit = pool.limitOf(agent);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(CreditPool.OverLimit.selector, limit));
        pool.draw(agent, 100 * U);
        vm.prank(op);
        pool.draw(agent, 91 * U);
    }

    function test_withdraw_keepsOrryAccruedBefore() public {
        lend(lender, 30_000 * U);
        lend(lender2, 10_000 * U);
        _openAndDraw(1_000 * U);
        warp(38 days);
        pool.liquidate(agent);
        uint256 owed = pool.orryClaimable(lender);
        assertGt(owed, 0);
        uint256 half = pool.sharesOf(lender) / 2;
        vm.prank(lender);
        pool.withdraw(half);
        assertEq(pool.orryClaimable(lender), owed, "withdrawing shares never drops ORRY already earned");
        vm.prank(lender);
        assertEq(pool.claimOrry(), owed);
    }

    /// CR-10 under uneven shares and several seizures: what lenders can claim never exceeds what was seized, and every
    /// lender can claim in full (the last claim never underflows).
    function test_seizedOrry_roundingNeverOverpays() public {
        address[] memory ls = new address[](5);
        for (uint256 i; i < ls.length; ++i) {
            ls[i] = address(uint160(0xD000 + i));
            lend(ls[i], 1_000 * U + i * 7_777_777 + 3);
        }
        for (uint256 k; k < 3; ++k) {
            address o = address(uint160(0xE000 + k));
            uint256 id = newVerifiedAgent(o, o);
            bond(o, id, 3_333_333_333_333_333_333_333 + k * 1_000_000_000_000_000_007);
            vm.prank(o);
            pool.draw(id, 30 * U + k);
            // a lender arrives between seizures, so checkpoints sit on a nonzero accumulator
            address late = address(uint160(0xD100 + k));
            lend(late, 333 * U + k * 1_234_567 + 1);
            uint256 acc1 = pool.accOrryPerShare();
            warp(38 days);
            pool.liquidate(id);
            // a lender that joined at acc1 earns at most its shares times the increase, rounded down
            uint256 cap = pool.sharesOf(late) * (pool.accOrryPerShare() - acc1) / 1e36;
            assertLe(pool.orryClaimable(late), cap, "checkpoint rounds against the lender");
            uint256 sum;
            for (uint256 i; i < ls.length; ++i) sum += pool.orryClaimable(ls[i]);
            for (uint256 j; j <= k; ++j) sum += pool.orryClaimable(address(uint160(0xD100 + j)));
            assertLe(sum, pool.seizedUnclaimed());
        }
        for (uint256 i; i < ls.length; ++i) {
            vm.prank(ls[i]);
            pool.claimOrry();
        }
        for (uint256 j; j < 3; ++j) {
            if (pool.orryClaimable(address(uint160(0xD100 + j))) == 0) continue;
            vm.prank(address(uint160(0xD100 + j)));
            pool.claimOrry();
        }
        assertEq(orry.balanceOf(address(pool)), pool.totalBonds() + pool.seizedUnclaimed());
    }

    function _openAndDraw(uint256 amount) internal {
        bond(op, agent, 50 * BOND);
        vm.prank(op);
        pool.draw(agent, amount);
    }
}

/// @notice Moves one unit less than asked on transferFrom.
contract ShortToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a - 1;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}
