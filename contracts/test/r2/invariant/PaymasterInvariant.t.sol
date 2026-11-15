// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PaymasterBase, MockEntryPoint} from "../utils/PaymasterBase.sol";
import {OrryPaymaster} from "../../../src/paymaster/OrryPaymaster.sol";
import {PackedUserOperation} from "../../../src/paymaster/interfaces/IOrryPaymaster.sol";
import {MockFeed, OracleHookStandIn} from "../../markets/utils/MarketMocks.sol";
import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";

/// @notice Bounded paymaster actions with ghost accounting (`docs/updates/L3-R2-SPEC.md` 5, PA-1 to PA-6).
contract PaymasterHandler is Test {
    OrryPaymaster internal pmr;
    MockEntryPoint internal ep;
    MockOrry internal orry;
    MockFeed internal ethFeed;
    OracleHookStandIn internal hook;
    address internal operator;
    address internal recipient;
    address[] public accounts;
    uint256 public clock;
    uint256 internal hubSince;

    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public paidToRecipient;
    uint256 public burned;
    uint256 public nOps;
    uint256 public nCapped;
    uint256 public nFlushes;
    uint256 public nRefused;

    constructor(
        OrryPaymaster pmr_,
        MockEntryPoint ep_,
        MockOrry orry_,
        MockFeed ethFeed_,
        OracleHookStandIn hook_,
        address operator_,
        address recipient_,
        address[] memory accounts_,
        uint256 start
    ) {
        (pmr, ep, orry, ethFeed, hook, operator, recipient, accounts, clock) =
            (pmr_, ep_, orry_, ethFeed_, hook_, operator_, recipient_, accounts_, start);
        hubSince = start - 2 hours;
    }

    function accountCount() external view returns (uint256) {
        return accounts.length;
    }

    function _acct(uint256 seed) internal view returns (address) {
        return accounts[seed % accounts.length];
    }

    function deposit(uint256 seed, uint256 amount) external {
        amount = bound(amount, 1, 50_000e18);
        vm.prank(operator);
        pmr.deposit(_acct(seed), amount);
        deposited += amount;
    }

    function withdraw(uint256 seed, uint256 amount) external {
        address a = _acct(seed);
        uint256 bal = pmr.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a);
        pmr.withdraw(a, amount);
        withdrawn += amount;
    }

    function op(uint256 seed, uint256 maxCost, uint256 actual, uint256 feePerGas) external {
        (uint256 rate,) = pmr.cachedRate();
        if (rate == 0) return;
        maxCost = bound(maxCost, 1, 2e15);
        actual = bound(actual, 0, maxCost);
        feePerGas = bound(feePerGas, 0, 5e9);
        address a = _acct(seed);
        uint256 pre = pmr.quote(maxCost);
        PackedUserOperation memory u;
        u.sender = a;
        u.paymasterAndData = abi.encodePacked(address(pmr), uint128(100_000), uint128(150_000));
        uint256 bal = pmr.balanceOf(a);
        if (bal < pre) {
            try ep.run(address(pmr), u, maxCost, actual, feePerGas) {
                revert("short balance validated");
            } catch {
                ++nRefused;
            }
            return;
        }
        ep.run(address(pmr), u, maxCost, actual, feePerGas);
        uint256 charged = bal - pmr.balanceOf(a);
        require(charged <= pre, "PA-2 charge above precharge");
        if (charged == pre && pre != 0) ++nCapped;
        ++nOps;
    }

    function moveHub(int256 drift) external {
        drift = bound(drift, -20_000, 20_000);
        hook.set(int24(138200 + drift), hubSince);
    }

    function wait(uint256 secs) external {
        clock += bound(secs, 1, 3 hours);
        vm.warp(clock);
    }

    function publishEth(uint256 answer) external {
        answer = bound(answer, 500e8, 10_000e8);
        ethFeed.push(int256(answer), clock);
    }

    function refresh() external {
        try pmr.refreshRate() {} catch {}
    }

    function flush() external {
        uint256 p = pmr.pendingRecipient();
        uint256 b = pmr.pendingBurn();
        if (p == 0 && b == 0) return;
        uint256 supply = orry.totalSupply();
        uint256 r = orry.balanceOf(recipient);
        pmr.flush();
        require(orry.balanceOf(recipient) - r == p, "PA-6 paid");
        require(supply - orry.totalSupply() == b, "PA-6 burned");
        paidToRecipient += p;
        burned += b;
        ++nFlushes;
    }
}

contract PaymasterInvariantTest is PaymasterBase {
    PaymasterHandler internal h;
    uint256 internal supply0;

    function setUp() public override {
        super.setUp();
        address[] memory a = new address[](4);
        for (uint256 i; i < 4; ++i) {
            a[i] = makeAddr(string(abi.encodePacked("acct", vm.toString(i))));
        }
        orry.transfer(operator, 100_000_000e18);
        h = new PaymasterHandler(pmr, ep, orry, ethFeed, hook, operator, recipient, a, START);
        pmr.refreshRate();
        supply0 = orry.totalSupply();
        targetContract(address(h));
    }

    function _held() internal view returns (uint256 sum) {
        for (uint256 i; i < h.accountCount(); ++i) {
            sum += pmr.balanceOf(h.accounts(i));
        }
        sum += pmr.pendingRecipient() + pmr.pendingBurn();
    }

    function _check() internal view {
        assertEq(orry.balanceOf(address(pmr)), _held(), "PA-1 held = balances + pending");
        assertEq(
            h.deposited(),
            h.withdrawn() + h.paidToRecipient() + h.burned() + orry.balanceOf(address(pmr)),
            "conservation"
        );
        assertEq(supply0 - orry.totalSupply(), h.burned(), "PA-6 only flush burns");
    }

    function invariant_accounting() public view {
        _check();
    }

    function test_deep_run() public {
        uint256 seed = 0xbeef;
        for (uint256 step; step < 3000; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 pick = seed % 100;
            uint256 a = seed >> 8;
            uint256 b = seed >> 72;
            uint256 c = seed >> 136;
            if (pick < 15) h.deposit(a, b % 20_000e18);
            else if (pick < 22) h.withdraw(a, b);
            else if (pick < 62) h.op(a, b, c, a >> 64);
            else if (pick < 70) h.moveHub(int256(b % 40_001) - 20_000);
            else if (pick < 78) h.wait(c % 2 hours);
            else if (pick < 86) h.publishEth(1500e8 + b % 2000e8);
            else if (pick < 94) h.refresh();
            else h.flush();
            if (step % 50 == 0) _check();
        }
        _check();
        console2.log("ops / capped / refused", h.nOps(), h.nCapped(), h.nRefused());
        console2.log("flushes / burned", h.nFlushes(), h.burned());
        assertGt(h.nOps(), 100);
        assertGt(h.nCapped(), 0);
        assertGt(h.nRefused(), 0);
        assertGt(h.nFlushes(), 0);
    }
}
