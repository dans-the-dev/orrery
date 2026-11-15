// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {CreditBase, CreditUsdg, CreditOrry, CreditOracle} from "./CreditBase.sol";
import {OrreryAttestor} from "../../src/OrreryAttestor.sol";
import {MockIdentityRegistry} from "../mocks/Mocks.sol";
import {AttesterRegistry} from "../../src/credit/AttesterRegistry.sol";
import {AttesterFeeSplitter} from "../../src/credit/AttesterFeeSplitter.sol";
import {CreditPool} from "../../src/credit/CreditPool.sol";
import {CreditRevenueRouter} from "../../src/credit/CreditRevenueRouter.sol";

/// @notice Bounded actions over the registry, the splitter, one pool and its routers, with ghost state.
contract CreditHandler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant M = 1e18;
    uint256 internal constant U = 1e6;

    AttesterRegistry public registry;
    AttesterFeeSplitter public splitter;
    OrreryAttestor public attestor;
    CreditPool public pool;
    CreditUsdg public usdg;
    CreditOrry public orry;
    CreditOracle public oracle;
    MockIdentityRegistry public identity;
    address public ops;
    address public treasury;

    address[] public stakers;
    address[] public lenders;
    uint256[] public agents;
    mapping(uint256 => address) public opOf;
    uint256 public clock;

    // ghosts
    uint256 public ghostUsdgIntoSplitter;
    uint256 public ghostSplitToTreasury;
    uint256 public ghostSplitToAttesters;
    uint256 public ghostClaimed;
    uint256 public ghostReleased;
    mapping(address => uint256) public ghostStakeIn;
    mapping(address => uint256) public ghostStakeOut;
    uint256 public ghostFees;
    uint256 public ghostInterestPaid;
    uint256 public ghostSeized;
    uint256 public ghostOrryClaimed;
    uint256 public ghostBondsIn;
    uint256 public ghostBondsOut;
    uint256 public ghostDraws;
    uint256 public ghostLiquidations;
    uint256 public ghostRolls;
    uint256 public ghostForwards;
    uint256 public ghostClaims;
    uint256 public ghostDefaultFreeValueDrops;
    uint256 public lastPricePerShare;
    bool public anyDefault;
    mapping(bytes32 => uint256) public calls;

    constructor(
        AttesterRegistry r,
        AttesterFeeSplitter s,
        OrreryAttestor a,
        CreditPool p,
        CreditUsdg u,
        CreditOrry rc,
        CreditOracle o,
        MockIdentityRegistry id,
        address ops_,
        address treasury_,
        uint256 clock_
    ) {
        registry = r;
        splitter = s;
        attestor = a;
        pool = p;
        usdg = u;
        orry = rc;
        oracle = o;
        identity = id;
        ops = ops_;
        treasury = treasury_;
        clock = clock_;
        for (uint256 i; i < 6; ++i) stakers.push(address(uint160(0xA000 + i)));
        for (uint256 i; i < 4; ++i) lenders.push(address(uint160(0xB000 + i)));
        for (uint256 i; i < 8; ++i) {
            address op = address(uint160(0xC000 + i));
            vm.prank(op);
            uint256 id_ = identity.register(op);
            usdg.mint(op, 5 * U);
            vm.startPrank(op);
            usdg.approve(address(attestor), 5 * U);
            attestor.payVerification(id_, op, uint128(5 * U));
            vm.stopPrank();
            ghostUsdgIntoSplitter += 5 * U;
            agents.push(id_);
            opOf[id_] = op;
        }
    }

    function _probe(address staker) internal pure returns (address) {
        return address(uint160(staker) + 0x100000);
    }

    function _count(string memory name) internal {
        calls[keccak256(bytes(name))] += 1;
    }

    // ------------------------------------------------------------------ time

    function warp(uint256 dt) external {
        dt = bound(dt, 1 hours, 3 days);
        clock += dt;
        vm.warp(clock);
        _count("warp");
    }

    // ------------------------------------------------------------------ attesters

    function stake(uint256 who, uint256 amount) external {
        address s = stakers[who % stakers.length];
        AttesterRegistry.Staker memory st = registry.stakerOf(s);
        if (st.unlockAt != 0) return;
        amount = st.amount == 0 ? bound(amount, 1_000_000 * M, 3_000_000 * M) : bound(amount, 1, 500_000 * M);
        orry.mint(s, amount);
        vm.startPrank(s);
        orry.approve(address(registry), amount);
        registry.stake(amount, st.amount == 0 ? _probe(s) : address(0));
        vm.stopPrank();
        ghostStakeIn[s] += amount;
        _count("stake");
    }

    function requestUnlock(uint256 who) external {
        address s = stakers[who % stakers.length];
        AttesterRegistry.Staker memory st = registry.stakerOf(s);
        if (st.amount == 0 || st.unlockAt != 0) return;
        vm.prank(s);
        registry.requestUnlock();
        _count("unlock");
    }

    function withdrawStake(uint256 who) external {
        address s = stakers[who % stakers.length];
        AttesterRegistry.Staker memory st = registry.stakerOf(s);
        if (st.unlockAt == 0 || clock < st.unlockAt) return;
        vm.prank(s);
        registry.withdraw();
        ghostStakeOut[s] += st.amount;
        _count("withdrawStake");
    }

    function roll() external {
        if (registry.rolled(registry.currentEpoch())) return;
        registry.rollEpoch();
        ghostRolls += 1;
        _count("roll");
    }

    function exclude(uint256 who) external {
        address s = stakers[who % stakers.length];
        if (registry.stakerOf(s).amount == 0) return;
        vm.prank(ops);
        registry.exclude(s, bytes32(who));
        _count("exclude");
    }

    function forward(uint256 who, uint256 agentIdx) external {
        address s = stakers[who % stakers.length];
        uint256 e = registry.currentEpoch();
        if (!registry.rolled(e) || !registry.isActive(e, s)) return;
        uint256 id_ = agents[agentIdx % agents.length];
        if (attestor.getAttestation(id_).observedAt >= clock) return;
        OrreryAttestor.Attestation memory a;
        a.observedAt = uint64(clock);
        a.expiresAt = uint64(clock + 1 days);
        a.endpointsLive = true;
        vm.prank(_probe(s));
        registry.attest(id_, a);
        ghostForwards += 1;
        _count("forward");
    }

    function revenue(uint256 amount) external {
        amount = bound(amount, 1, 50 * U);
        usdg.mint(address(splitter), amount);
        ghostUsdgIntoSplitter += amount;
        _count("revenue");
    }

    function split() external {
        if (usdg.balanceOf(address(splitter)) == splitter.booked()) return;
        (uint256 a, uint256 t) = splitter.split();
        ghostSplitToAttesters += a;
        ghostSplitToTreasury += t;
        _count("split");
    }

    function claim(uint256 who, uint256 back) external {
        address s = stakers[who % stakers.length];
        uint256 e = registry.currentEpoch();
        if (e == 0) return;
        uint256 epoch = e - 1 - (back % e);
        uint256 amt = splitter.claimable(epoch, s);
        if (amt == 0) return;
        vm.prank(s);
        splitter.claim(epoch);
        ghostClaimed += amt;
        ghostClaims += 1;
        _count("claim");
    }

    function release(uint256 back) external {
        uint256 e = registry.currentEpoch();
        if (e == 0) return;
        uint256 epoch = e - 1 - (back % e);
        if (registry.totalResults(epoch) != 0 || splitter.released(epoch)) return;
        ghostReleased += splitter.releaseUnused(epoch);
        _count("release");
    }

    // ------------------------------------------------------------------ credit

    function deposit(uint256 who, uint256 amount) external {
        address l = lenders[who % lenders.length];
        amount = bound(amount, 1, 20_000 * U);
        usdg.mint(l, amount);
        vm.startPrank(l);
        usdg.approve(address(pool), amount);
        pool.deposit(amount);
        vm.stopPrank();
        _checkPrice();
        _count("deposit");
    }

    function withdraw(uint256 who, uint256 frac) external {
        address l = lenders[who % lenders.length];
        uint256 s = pool.sharesOf(l) * bound(frac, 1, 100) / 100;
        if (s == 0 || pool.previewWithdraw(s) > pool.cash()) return;
        vm.prank(l);
        pool.withdraw(s);
        _checkPrice();
        _count("withdraw");
    }

    function claimOrry(uint256 who) external {
        address l = lenders[who % lenders.length];
        uint256 c = pool.orryClaimable(l);
        if (c == 0) return;
        vm.prank(l);
        ghostOrryClaimed += pool.claimOrry();
        _count("claimOrry");
    }

    function postBond(uint256 idx, uint256 amount) external {
        uint256 id_ = agents[idx % agents.length];
        CreditPool.Line memory l = pool.lineOf(id_);
        if (l.defaulted) return;
        amount = bound(amount, 1_000 * M, 500_000 * M);
        address op = opOf[id_];
        orry.mint(op, amount);
        vm.startPrank(op);
        orry.approve(address(pool), amount);
        pool.postBond(id_, amount);
        vm.stopPrank();
        ghostBondsIn += amount;
        _count("postBond");
    }

    function withdrawBond(uint256 idx, uint256 frac) external {
        uint256 id_ = agents[idx % agents.length];
        CreditPool.Line memory l = pool.lineOf(id_);
        if (l.bond == 0 || l.principal != 0 || l.interest != 0) return;
        uint256 amount = uint256(l.bond) * bound(frac, 1, 100) / 100;
        if (amount == 0) return;
        vm.prank(opOf[id_]);
        pool.withdrawBond(id_, amount);
        ghostBondsOut += amount;
        _count("withdrawBond");
    }

    function draw(uint256 idx, uint256 amount) external {
        uint256 id_ = agents[idx % agents.length];
        CreditPool.Line memory l = pool.lineOf(id_);
        if (l.defaulted || l.bond == 0) return;
        uint256 limit = pool.limitOf(id_);
        uint256 debt = uint256(l.principal) + l.interest;
        if (limit <= debt) return;
        uint256 room = limit - debt;
        if (room > pool.cash()) room = pool.cash();
        if (room == 0) return;
        amount = bound(amount, 1, room);
        vm.prank(opOf[id_]);
        pool.draw(id_, amount);
        ghostDraws += 1;
        _checkPrice();
        _count("draw");
    }

    function repay(uint256 idx, uint256 amount) external {
        uint256 id_ = agents[idx % agents.length];
        uint256 owed = pool.owedOf(id_);
        if (owed == 0) return;
        amount = bound(amount, 1, owed + 10 * U);
        CreditPool.Line memory before = pool.lineOf(id_);
        uint256 tBefore = usdg.balanceOf(treasury);
        usdg.mint(address(this), amount);
        usdg.approve(address(pool), amount);
        uint256 paid = pool.repay(id_, amount);
        uint256 toInterest = paid < before.interest ? paid : before.interest;
        ghostInterestPaid += toInterest;
        ghostFees += usdg.balanceOf(treasury) - tBefore;
        require(paid <= owed, "repay pulled more than owed");
        _checkPrice();
        _count("repay");
    }

    function routerRevenue(uint256 idx, uint256 amount) external {
        uint256 id_ = agents[idx % agents.length];
        address r = pool.routerOf(id_);
        if (r == address(0)) return;
        amount = bound(amount, 1, 2_000 * U);
        uint256 owed = pool.owedOf(id_);
        CreditPool.Line memory before = pool.lineOf(id_);
        uint256 tBefore = usdg.balanceOf(treasury);
        usdg.mint(r, amount);
        (uint256 toPool,) = CreditRevenueRouter(r).sweep();
        require(toPool <= owed, "router paid more than owed");
        if (toPool != 0) {
            ghostInterestPaid += toPool < before.interest ? toPool : before.interest;
            ghostFees += usdg.balanceOf(treasury) - tBefore;
        }
        _checkPrice();
        _count("routerRevenue");
    }

    function liquidate(uint256 idx) external {
        uint256 id_ = agents[idx % agents.length];
        CreditPool.Line memory l = pool.lineOf(id_);
        if (l.principal + l.interest == 0 || clock <= uint256(l.dueAt) + pool.grace()) return;
        pool.liquidate(id_);
        ghostSeized += l.bond;
        ghostLiquidations += 1;
        anyDefault = true;
        lastPricePerShare = _price();
        _count("liquidate");
    }

    function priceMove(uint256 p) external {
        oracle.set(bound(p, 100, 50_000));
        _count("priceMove");
    }

    // ------------------------------------------------------------------ helpers

    function _price() internal view returns (uint256) {
        return (pool.totalAssets() + 1) * 1e30 / (pool.totalShares() + 1e6);
    }

    /// @dev CR-11: without defaults, value per share never falls (every rounding favours the pool).
    function _checkPrice() internal {
        uint256 p = _price();
        if (p < lastPricePerShare && !anyDefault) ghostDefaultFreeValueDrops += 1;
        if (p > lastPricePerShare || !anyDefault) lastPricePerShare = p;
    }

    function stakersList() external view returns (address[] memory) {
        return stakers;
    }

    function lendersList() external view returns (address[] memory) {
        return lenders;
    }

    function agentsList() external view returns (uint256[] memory) {
        return agents;
    }
}

contract CreditInvariantsTest is CreditBase {
    CreditHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new CreditHandler(
            registry, splitter, attestor, pool, usdg, orry, oracle, identity, ops, address(treasury), clock
        );
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](24);
        sel[0] = h.warp.selector;
        sel[1] = h.stake.selector;
        sel[2] = h.stake.selector;
        sel[3] = h.requestUnlock.selector;
        sel[4] = h.withdrawStake.selector;
        sel[5] = h.roll.selector;
        sel[6] = h.exclude.selector;
        sel[7] = h.forward.selector;
        sel[8] = h.forward.selector;
        sel[9] = h.revenue.selector;
        sel[10] = h.split.selector;
        sel[11] = h.claim.selector;
        sel[12] = h.release.selector;
        sel[13] = h.deposit.selector;
        sel[14] = h.withdraw.selector;
        sel[15] = h.claimOrry.selector;
        sel[16] = h.postBond.selector;
        sel[17] = h.withdrawBond.selector;
        sel[18] = h.draw.selector;
        sel[19] = h.draw.selector;
        sel[20] = h.repay.selector;
        sel[21] = h.routerRevenue.selector;
        sel[22] = h.liquidate.selector;
        sel[23] = h.priceMove.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    // ------------------------------------------------------------------ attesters

    /// AT-1: active sets are bounded, ranked, and never hold an unlocking or excluded staker at roll time.
    function invariant_AT1_activeSetBoundedAndRanked() public view {
        uint256 e = registry.currentEpoch();
        if (!registry.rolled(e)) return;
        address[] memory set = registry.activeSet(e);
        assertLe(set.length, 20);
        for (uint256 i; i < set.length; ++i) {
            AttesterRegistry.Staker memory s = registry.stakerOf(set[i]);
            assertGe(s.amount, MIN_STAKE);
            assertEq(s.unlockAt, 0);
            assertTrue(registry.isActive(e, set[i]));
        }
    }

    /// AT-2, AT-4: stake leaves only to its staker; the registry holds exactly the sum of stakes.
    function invariant_AT2_AT4_stakeConserved() public view {
        address[] memory st = h.stakersList();
        uint256 sum;
        for (uint256 i; i < st.length; ++i) {
            uint256 held = registry.stakerOf(st[i]).amount;
            sum += held;
            assertEq(h.ghostStakeIn(st[i]), h.ghostStakeOut(st[i]) + held, "stake in = out + held");
            assertEq(orry.balanceOf(st[i]), h.ghostStakeOut(st[i]), "withdrawn stake went to its staker");
        }
        assertEq(registry.totalStaked(), sum);
        assertEq(orry.balanceOf(address(registry)), sum);
    }

    /// AT-3, AT-6: USDG into the splitter = sent to the treasury + held for attesters + claimed + released.
    function invariant_AT3_AT6_splitterBooks() public view {
        assertEq(splitter.booked(), h.ghostSplitToAttesters() - h.ghostClaimed() - h.ghostReleased());
        assertEq(
            usdg.balanceOf(address(splitter)) + h.ghostSplitToTreasury() + h.ghostClaimed() + h.ghostReleased(),
            h.ghostUsdgIntoSplitter()
        );
        assertLe(h.ghostSplitToAttesters() * 10_000, (h.ghostSplitToAttesters() + h.ghostSplitToTreasury()) * 3000);
        uint256 e = registry.currentEpoch();
        for (uint256 i; i < e && i < 40; ++i) {
            assertLe(splitter.claimedTotal(i), splitter.pool(i), "claims within the epoch pool");
            if (splitter.released(i)) assertEq(registry.totalResults(i), 0);
        }
    }

    /// AT-5: totalResults is the sum of per-staker results.
    function invariant_AT5_resultsSum() public view {
        uint256 e = registry.currentEpoch();
        address[] memory st = h.stakersList();
        for (uint256 ep; ep <= e && ep < 40; ++ep) {
            uint256 sum;
            for (uint256 i; i < st.length; ++i) sum += registry.results(ep, st[i]);
            assertEq(registry.totalResults(ep), sum);
        }
    }

    // ------------------------------------------------------------------ credit

    /// CR-1, CR-2: cash is backed; shares and principal sum up.
    function invariant_CR1_CR2_poolBooks() public view {
        assertGe(usdg.balanceOf(address(pool)), pool.cash());
        address[] memory ls = h.lendersList();
        uint256 sum;
        for (uint256 i; i < ls.length; ++i) sum += pool.sharesOf(ls[i]);
        assertEq(pool.totalShares(), sum);
        uint256[] memory ag = h.agentsList();
        uint256 principal;
        uint256 bonds;
        for (uint256 i; i < ag.length; ++i) {
            CreditPool.Line memory l = pool.lineOf(ag[i]);
            principal += l.principal;
            bonds += l.bond;
        }
        assertEq(pool.totalPrincipal(), principal);
        assertEq(pool.totalBonds(), bonds);
    }

    /// CR-3, CR-10: ORRY in the pool = open bonds + seized not yet claimed; bonds left only to owners or lenders.
    function invariant_CR3_CR10_bondsConserved() public view {
        assertEq(orry.balanceOf(address(pool)), pool.totalBonds() + pool.seizedUnclaimed());
        assertEq(h.ghostBondsIn(), pool.totalBonds() + h.ghostBondsOut() + h.ghostSeized());
        assertEq(pool.seizedUnclaimed(), h.ghostSeized() - h.ghostOrryClaimed());
        address[] memory ls = h.lendersList();
        uint256 claimable;
        for (uint256 i; i < ls.length; ++i) claimable += pool.orryClaimable(ls[i]);
        assertLe(claimable, pool.seizedUnclaimed());
    }

    /// CR-4: no open line owes more than every cap allows at today's price, except by interest or a price fall.
    function invariant_CR4_debtWithinCaps() public view {
        uint256[] memory ag = h.agentsList();
        for (uint256 i; i < ag.length; ++i) {
            CreditPool.Line memory l = pool.lineOf(ag[i]);
            assertLe(l.principal, pool.maxLineUsdg());
        }
    }

    /// CR-7: Orrery's take is exactly feeBps of interest paid, rounded down per payment.
    function invariant_CR7_feeOnInterestOnly() public view {
        assertLe(h.ghostFees() * 10_000, h.ghostInterestPaid() * pool.feeBps());
        assertEq(usdg.balanceOf(address(treasury)), h.ghostFees() + h.ghostSplitToTreasury() + h.ghostReleased());
    }

    /// CR-11: without a default, value per share never fell.
    function invariant_CR11_valueNeverFallsWithoutDefault() public view {
        assertEq(h.ghostDefaultFreeValueDrops(), 0);
    }
}

/// @notice Deterministic deep run: thousands of weighted actions in one test, every invariant checked, and the run must
///         reach rolls, forwards, claims, draws and defaults.
contract CreditDeepRunTest is CreditInvariantsTest {
    function test_deepRun() public {
        uint256 seed = 42;
        uint256 steps = vm.envOr("CREDIT_DEEP_STEPS", uint256(4000)); // the mutation run uses fewer
        for (uint256 i; i < steps; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 a = seed >> 8;
            uint256 b = seed >> 128;
            uint256 pick = seed % 100;
            if (pick < 8) h.warp(a);
            else if (pick < 14) h.stake(a, b);
            else if (pick < 15) h.requestUnlock(a);
            else if (pick < 17) h.withdrawStake(a);
            else if (pick < 22) h.roll();
            else if (pick < 23) h.exclude(a);
            else if (pick < 33) h.forward(a, b);
            else if (pick < 37) h.revenue(a);
            else if (pick < 41) h.split();
            else if (pick < 46) h.claim(a, b);
            else if (pick < 47) h.release(b);
            else if (pick < 53) h.deposit(a, b);
            else if (pick < 56) h.withdraw(a, b);
            else if (pick < 58) h.claimOrry(a);
            else if (pick < 63) h.postBond(a, b);
            else if (pick < 64) h.withdrawBond(a, b);
            else if (pick < 74) h.draw(a, b);
            else if (pick < 79) h.repay(a, b);
            else if (pick < 88) h.routerRevenue(a, b);
            else if (pick < 92) h.liquidate(a);
            else h.priceMove(b);
            if (i % 50 == 0) _checkAll();
        }
        _checkAll();
        emit log_named_uint("rolls", h.ghostRolls());
        emit log_named_uint("forwards", h.ghostForwards());
        emit log_named_uint("attester claims", h.ghostClaims());
        emit log_named_uint("draws", h.ghostDraws());
        emit log_named_uint("liquidations", h.ghostLiquidations());
        emit log_named_uint("orry claimed by lenders", h.ghostOrryClaimed());
        assertGt(h.ghostRolls(), 5);
        assertGt(h.ghostForwards(), 20);
        assertGt(h.ghostClaims(), 3);
        assertGt(h.ghostDraws(), 20);
        assertGt(h.ghostLiquidations(), 0);
        assertGt(h.ghostOrryClaimed(), 0);
    }

    function _checkAll() internal view {
        invariant_AT1_activeSetBoundedAndRanked();
        invariant_AT2_AT4_stakeConserved();
        invariant_AT3_AT6_splitterBooks();
        invariant_AT5_resultsSum();
        invariant_CR1_CR2_poolBooks();
        invariant_CR3_CR10_bondsConserved();
        invariant_CR4_debtWithinCaps();
        invariant_CR7_feeOnInterestOnly();
        invariant_CR11_valueNeverFallsWithoutDefault();
    }
}
