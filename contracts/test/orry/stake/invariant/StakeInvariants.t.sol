// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";

import {IOrryStaking} from "../../../../src/orry/interfaces/IOrryStaking.sol";
import {StakeBase} from "../utils/StakeBase.sol";
import {StakingLedger} from "../utils/StakingLedger.sol";
import {StakeHandler} from "./StakeHandler.sol";

/// @notice Invariant campaign and deterministic deep run for OrryStaking and OrryRewardsRouter:
/// S-1 to S-5, RR-1, RR-2, G-2 (`docs/ORRY-BUILD-SPEC.md` section 4).
contract StakeInvariants is StakeBase {
    StakeHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new StakeHandler(staking, router, orry, registry, buybackAddr, START);
        orry.transfer(address(h), 300_000_000e18);
        for (uint256 i; i < h.actorCount(); ++i) {
            orry.transfer(h.actors(i), 100_000_000e18);
        }
        h.init();
        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](17);
        sels[0] = h.stake.selector;
        sels[1] = h.requestUnstake.selector;
        sels[2] = h.withdraw.selector;
        sels[3] = h.stakeForAgent.selector;
        sels[4] = h.requestAgentUnstake.selector;
        sels[5] = h.withdrawAgent.selector;
        sels[6] = h.strangerTakes.selector;
        sels[7] = h.transferIdentity.selector;
        sels[8] = h.setWallet.selector;
        sels[9] = h.observeAgent.selector;
        sels[10] = h.notify.selector;
        sels[11] = h.feedRouter.selector;
        sels[12] = h.distribute.selector;
        sels[13] = h.claim.selector;
        sels[14] = h.donate.selector;
        sels[15] = h.warp.selector;
        sels[16] = h.extendLock.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    // ---------------------------------------------------------------- invariants

    function invariant_S1_balances_cover_stakes_and_rewards() public view {
        _checkS1();
    }

    function invariant_S2_only_staker_after_readyAt() public view {
        assertFalse(h.badS2(), "S-2");
    }

    function invariant_S3_total_earning_is_the_sum() public view {
        _checkS3();
    }

    function invariant_S4_rewards_ledger() public view {
        _checkS4();
    }

    function invariant_S5_reported_agent_stake_stays_locked() public view {
        _checkS5();
    }

    function invariant_S6_agent_lock() public view {
        _checkS6();
    }

    function invariant_RR_router_split() public view {
        assertFalse(h.badRR1(), "RR-1");
        assertFalse(h.badRR2(), "RR-2");
    }

    function invariant_G2_supply_never_rises() public view {
        assertFalse(h.badSupplyUp(), "G-2");
        assertLe(orry.totalSupply(), SUPPLY);
    }

    // ---------------------------------------------------------------- deterministic deep run

    function test_deep_run_stake() public {
        uint256 seed = 0x5eed;
        for (uint256 step; step < 3_000; ++step) {
            // nothing in memory outlives one step, so each step reuses the same memory (avoids MemoryLimitOOG)
            uint256 fmp;
            assembly ("memory-safe") {
                fmp := mload(0x40)
            }
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 a = seed;
            uint256 b = seed >> 64;
            uint256 c = seed >> 128;
            uint256 pick = seed % 100;
            if (pick < 12) h.stake(a, b % 2_000_000e18);
            else if (pick < 18) h.requestUnstake(a, b);
            else if (pick < 24) h.withdraw(a);
            else if (pick < 34) h.stakeForAgent(a, b % 2 == 0, c % 2_000_000e18);
            else if (pick < 40) h.requestAgentUnstake(a, b, c);
            else if (pick < 46) h.withdrawAgent(a, b);
            else if (pick < 49) h.strangerTakes(a, b, c);
            else if (pick < 52) h.transferIdentity(a, b);
            else if (pick < 55) h.setWallet(a, b);
            else if (pick < 60) h.observeAgent(a);
            else if (pick < 63) h.extendLock(a, b);
            else if (pick < 66) h.notify(b % 30 ether, c % 3_000_000e18);
            else if (pick < 71) h.feedRouter(b % 10 ether, c % 1_000_000e18);
            else if (pick < 75) h.distribute();
            else if (pick < 86) h.claim(a, b, c % 2 == 0);
            else if (pick < 88) h.donate(b);
            else h.warp(b % 2 days);
            _checkAll();
            assembly ("memory-safe") {
                mstore(0x40, fmp)
            }
        }
        string[19] memory names = [
            "stake",
            "requestUnstake",
            "withdraw",
            "stakeForAgent",
            "requestAgentUnstake",
            "withdrawAgent",
            "strangerTakes",
            "transferIdentity",
            "setWallet",
            "observeAgent",
            "notify",
            "feedRouter",
            "distribute",
            "claim",
            "donate",
            "warp",
            "extendLock",
            "extendRefused",
            "lockedRefused"
        ];
        for (uint256 i; i < names.length; ++i) {
            uint256 n = h.calls(bytes32(bytes(names[i])));
            console2.log(names[i], n);
            assertGt(n, 0, names[i]);
        }
        console2.log("S-5 observations held", h.seenCount());
        console2.log("rewards notified eth / orry", h.notified(0), h.notified(1));
        console2.log("rewards paid eth / orry", h.paid(0), h.paid(1));
        console2.log("router burned orry / eth to buyback", h.routerBurned(), h.routerToBuyback());
    }

    // ---------------------------------------------------------------- checks

    function _checkAll() internal view {
        _checkS1();
        assertFalse(h.badS2(), "S-2");
        _checkS3();
        _checkS4();
        _checkS5();
        _checkS6();
        assertFalse(h.badRR1(), "RR-1");
        assertFalse(h.badRR2(), "RR-2");
        assertFalse(h.badSupplyUp(), "G-2");
    }

    /// S-1 (as equality, nothing else moves ORRY in): balance = stakes + unpaid rewards + donations.
    function _checkS1() internal view {
        uint256 principal = h.principalIn() - h.principalOut();
        assertEq(_sumPositions(), principal, "positions = principal ghost");
        uint256 unpaidRc = h.notified(1) - h.paid(1);
        assertEq(orry.balanceOf(address(staking)), principal + unpaidRc + h.donated(), "S-1 orry");
        assertEq(address(staking).balance, h.notified(0) - h.paid(0), "S-1 eth");
    }

    function _checkS3() internal view {
        uint256 sumEarning;
        for (uint256 i; i < h.actorCount(); ++i) {
            sumEarning += staking.earningBalance(h.actors(i));
        }
        assertEq(staking.totalEarning(), sumEarning, "S-3 sum of earning balances");
        assertEq(staking.totalEarning(), _sumActive(), "S-3 sum of active");
    }

    /// S-4: paid <= notified, and notified - paid = owed + unstreamed + scheduled (incl. not yet accrued), per asset.
    function _checkS4() internal view {
        uint256[2] memory pendingSum;
        for (uint256 i; i < h.actorCount(); ++i) {
            (uint256 e, uint256 r) = staking.pendingRewards(h.actors(i));
            pendingSum[0] += e;
            pendingSum[1] += r;
        }
        for (uint256 a; a < 2; ++a) {
            uint256 n = h.notified(a);
            uint256 p = h.paid(a);
            assertLe(p, n, "S-4 paid <= notified");
            StakingLedger.Ledger memory l = StakingLedger.read(address(staking), a);
            uint256 rest = l.periodFinish > l.lastUpdate ? l.rate * (l.periodFinish - l.lastUpdate) : 0;
            assertEq(n - p, l.owed + l.unstreamed + rest, "S-4 ledger");
            assertLe(pendingSum[a], n - p - l.unstreamed, "S-4 claimable within the unpaid streams");
        }
    }

    function _checkS5() internal view {
        uint256 nowTs = vm.getBlockTimestamp();
        for (uint256 i; i < h.seenCount(); ++i) {
            StakeHandler.Seen memory s = h.seenAt(i);
            if (nowTs >= s.at + staking.AGENT_COOLDOWN()) continue;
            IOrryStaking.AgentPosition memory p = staking.agentStakeOf(s.agentId, s.owner);
            assertGe(uint256(p.active) + p.leaving, s.active, "S-5");
        }
    }

    /// S-6: a lock only grows, never past now + MAX_AGENT_LOCK when set, and active never fell under it (handler flags).
    function _checkS6() internal view {
        assertFalse(h.badS6(), "S-6");
        for (uint256 j; j < 3; ++j) {
            uint256 id = h.agentIds(j);
            address[] memory owners = _distinct(h.ownersSeen(id));
            for (uint256 k; k < owners.length; ++k) {
                uint64 stored = staking.agentStakeOf(id, owners[k]).lockedUntil;
                assertEq(stored, h.lastLock(keccak256(abi.encode(id, owners[k]))), "S-6 lock only set by extendAgentLock");
            }
        }
    }

    function _sumPositions() internal view returns (uint256 sum) {
        for (uint256 i; i < h.actorCount(); ++i) {
            (uint256 active, uint256 leaving,) = staking.plainStake(h.actors(i));
            sum += active + leaving;
        }
        for (uint256 j; j < 3; ++j) {
            uint256 id = h.agentIds(j);
            address[] memory owners = _distinct(h.ownersSeen(id));
            for (uint256 k; k < owners.length; ++k) {
                IOrryStaking.AgentPosition memory p = staking.agentStakeOf(id, owners[k]);
                sum += uint256(p.active) + p.leaving;
            }
        }
    }

    function _sumActive() internal view returns (uint256 sum) {
        for (uint256 i; i < h.actorCount(); ++i) {
            (uint256 active,,) = staking.plainStake(h.actors(i));
            sum += active;
        }
        for (uint256 j; j < 3; ++j) {
            uint256 id = h.agentIds(j);
            address[] memory owners = _distinct(h.ownersSeen(id));
            for (uint256 k; k < owners.length; ++k) {
                sum += staking.agentStakeOf(id, owners[k]).active;
            }
        }
    }

    function _distinct(address[] memory xs) internal pure returns (address[] memory out) {
        out = new address[](xs.length);
        uint256 n;
        for (uint256 i; i < xs.length; ++i) {
            bool dup;
            for (uint256 j; j < n; ++j) {
                if (out[j] == xs[i]) dup = true;
            }
            if (!dup) out[n++] = xs[i];
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }
}
