// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {IOrryStaking} from "../../../../src/orry/interfaces/IOrryStaking.sol";
import {OrryStaking} from "../../../../src/orry/OrryStaking.sol";
import {OrryRewardsRouter} from "../../../../src/orry/OrryRewardsRouter.sol";
import {MockIdentityRegistry} from "../../../mocks/Mocks.sol";
import {MockOrry} from "../utils/StakeMocks.sol";

/// @notice Bounded handler for OrryStaking and OrryRewardsRouter (invariants S-1 to S-5, RR-1, RR-2, G-2).
/// Every action is bounded so most calls succeed; the ghost state is kept from what each call returned or moved.
contract StakeHandler is Test {
    OrryStaking public staking;
    OrryRewardsRouter public router;
    MockOrry public orry;
    MockIdentityRegistry public registry;
    address public sink;

    address[] public actors;
    uint256[] public agentIds;
    mapping(uint256 agentId => address[]) internal _ownersSeen;

    // ghosts
    uint256[2] public notified;
    uint256[2] public paid;
    uint256 public principalIn;
    uint256 public principalOut;
    uint256 public donated;
    uint256 public lastSupply;
    uint256 public routerBurned;
    uint256 public routerToBuyback;

    // S-5 observations: (agentId, owner, active, at)
    struct Seen {
        uint256 agentId;
        address owner;
        uint256 active;
        uint256 at;
    }

    Seen[] internal _seen;

    // violation flags, checked by the invariant functions
    bool public badS2;
    bool public badRR1;
    bool public badRR2;
    bool public badSupplyUp;
    bool public badS6;
    mapping(bytes32 key => uint64) public lastLock;

    mapping(bytes32 => uint256) public calls;

    uint256 internal _now;
    uint256 internal _block;

    constructor(OrryStaking s, OrryRewardsRouter r, MockOrry t, MockIdentityRegistry reg, address sink_, uint256 start) {
        staking = s;
        router = r;
        orry = t;
        registry = reg;
        sink = sink_;
        _now = start;
        _block = block.number;
        lastSupply = t.totalSupply();
        for (uint256 i; i < 5; ++i) {
            address a = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            actors.push(a);
            vm.deal(a, 1_000 ether);
        }
    }

    /// @dev Called by the test after funding: approvals and three agents.
    function init() external {
        for (uint256 i; i < actors.length; ++i) {
            vm.prank(actors[i]);
            orry.approve(address(staking), type(uint256).max);
        }
        for (uint256 i; i < 3; ++i) {
            address o = actors[i];
            uint256 id = registry.register(o);
            vm.prank(o);
            registry.setAgentWallet(id, actors[i + 2]);
            agentIds.push(id);
            _ownersSeen[id].push(o);
        }
        orry.approve(address(staking), type(uint256).max);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function seenCount() external view returns (uint256) {
        return _seen.length;
    }

    function seenAt(uint256 i) external view returns (Seen memory) {
        return _seen[i];
    }

    function ownersSeen(uint256 agentId) external view returns (address[] memory) {
        return _ownersSeen[agentId];
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _agent(uint256 seed) internal view returns (uint256) {
        return agentIds[seed % agentIds.length];
    }

    function _count(bytes32 k) internal {
        calls[k] += 1;
    }

    function _checkSupply() internal {
        uint256 s = orry.totalSupply();
        if (s > lastSupply) badSupplyUp = true;
        lastSupply = s;
    }

    // ---------------------------------------------------------------- actions

    function stake(uint256 actorSeed, uint256 amount) public {
        address a = _actor(actorSeed);
        amount = _bound(amount, 1, 1_000_000e18);
        if (orry.balanceOf(a) < amount) return;
        vm.prank(a);
        staking.stake(amount);
        principalIn += amount;
        _count("stake");
    }

    function requestUnstake(uint256 actorSeed, uint256 amount) public {
        address a = _actor(actorSeed);
        (uint256 active,,) = staking.plainStake(a);
        if (active == 0) return;
        amount = _bound(amount, 1, active);
        vm.prank(a);
        staking.requestUnstake(amount);
        _count("requestUnstake");
    }

    function withdraw(uint256 actorSeed) public {
        address a = _actor(actorSeed);
        (, uint256 leaving, uint64 readyAt) = staking.plainStake(a);
        uint256 before = orry.balanceOf(a);
        vm.prank(a);
        try staking.withdraw() returns (uint256 amount) {
            if (_now < readyAt || amount != leaving || orry.balanceOf(a) != before + amount) badS2 = true;
            principalOut += amount;
            _count("withdraw");
        } catch {
            if (leaving != 0 && _now >= readyAt) badS2 = true; // a ready withdrawal must never fail
        }
    }

    function stakeForAgent(uint256 agentSeed, bool byWallet, uint256 amount) public {
        uint256 id = _agent(agentSeed);
        address caller = byWallet ? registry.getAgentWallet(id) : registry.ownerOf(id);
        if (caller == address(0)) return;
        amount = _bound(amount, 1, 1_000_000e18);
        if (orry.balanceOf(caller) < amount) return;
        IOrryStaking.AgentPosition memory p = staking.agentStakeOf(id, registry.ownerOf(id));
        if (p.staker != address(0) && p.staker != caller) return;
        vm.prank(caller);
        staking.stakeForAgent(id, amount);
        principalIn += amount;
        _count("stakeForAgent");
    }

    function requestAgentUnstake(uint256 agentSeed, uint256 ownerSeed, uint256 amount) public {
        uint256 id = _agent(agentSeed);
        address[] memory owners = _ownersSeen[id];
        address o = owners[ownerSeed % owners.length];
        IOrryStaking.AgentPosition memory p = staking.agentStakeOf(id, o);
        if (p.active == 0) return;
        amount = _bound(amount, 1, p.active);
        vm.prank(p.staker);
        try staking.requestAgentUnstake(id, o, amount) {
            if (_now < p.lockedUntil) badS6 = true; // S-6: active fell under a lock
            _count("requestAgentUnstake");
        } catch {
            if (_now >= p.lockedUntil) badS6 = true; // an unlocked, valid request must work
            _count("lockedRefused");
        }
    }

    /// @dev R-13: the staker of the reported position extends its lock; S-6 bookkeeping in `lastLock`.
    function extendLock(uint256 agentSeed, uint256 ahead) public {
        uint256 id = _agent(agentSeed);
        address o = registry.ownerOf(id);
        IOrryStaking.AgentPosition memory p = staking.agentStakeOf(id, o);
        if (p.staker == address(0)) return;
        uint64 until = uint64(_now + _bound(ahead, 0, 400 days));
        bool shouldWork = until > p.lockedUntil && until <= _now + staking.MAX_AGENT_LOCK();
        vm.prank(p.staker);
        try staking.extendAgentLock(id, until) {
            if (!shouldWork) badS6 = true;
            lastLock[keccak256(abi.encode(id, o))] = until;
            _count("extendLock");
        } catch {
            if (shouldWork) badS6 = true;
            _count("extendRefused");
        }
    }

    function withdrawAgent(uint256 agentSeed, uint256 ownerSeed) public {
        uint256 id = _agent(agentSeed);
        address[] memory owners = _ownersSeen[id];
        address o = owners[ownerSeed % owners.length];
        IOrryStaking.AgentPosition memory p = staking.agentStakeOf(id, o);
        if (p.staker == address(0)) return;
        uint256 before = orry.balanceOf(p.staker);
        vm.prank(p.staker);
        try staking.withdrawAgent(id, o) returns (uint256 amount) {
            if (_now < p.leavingAt || amount != p.leaving || orry.balanceOf(p.staker) != before + amount) badS2 = true;
            principalOut += amount;
            _count("withdrawAgent");
        } catch {
            if (p.leaving != 0 && _now >= p.leavingAt) badS2 = true;
        }
    }

    /// @dev Someone other than the staker tries to move a position: must always fail (S-2).
    function strangerTakes(uint256 agentSeed, uint256 ownerSeed, uint256 actorSeed) public {
        uint256 id = _agent(agentSeed);
        address[] memory owners = _ownersSeen[id];
        address o = owners[ownerSeed % owners.length];
        address a = _actor(actorSeed);
        IOrryStaking.AgentPosition memory p = staking.agentStakeOf(id, o);
        if (a == p.staker) return;
        vm.prank(a);
        try staking.withdrawAgent(id, o) {
            badS2 = true;
        } catch {}
        vm.prank(a);
        try staking.requestAgentUnstake(id, o, 1) {
            badS2 = true;
        } catch {}
        if (o == registry.ownerOf(id)) {
            vm.prank(a);
            try staking.extendAgentLock(id, uint64(_now + 1 days)) {
                badS6 = true;
            } catch {}
        }
        _count("strangerTakes");
    }

    function transferIdentity(uint256 agentSeed, uint256 toSeed) public {
        uint256 id = _agent(agentSeed);
        address from = registry.ownerOf(id);
        address to = _actor(toSeed);
        if (to == from) return;
        vm.prank(from);
        registry.transferFrom(from, to, id);
        _ownersSeen[id].push(to);
        _count("transferIdentity");
    }

    function setWallet(uint256 agentSeed, uint256 walletSeed) public {
        uint256 id = _agent(agentSeed);
        address o = registry.ownerOf(id);
        vm.prank(o);
        registry.setAgentWallet(id, _actor(walletSeed));
        _count("setWallet");
    }

    function observeAgent(uint256 agentSeed) public {
        uint256 id = _agent(agentSeed);
        IOrryStaking.AgentPosition memory p = staking.agentStake(id);
        if (p.active == 0) return;
        if (_seen.length >= 64) _seen.pop(); // keep the list bounded; the newest replaces the last slot
        _seen.push(Seen(id, registry.ownerOf(id), p.active, _now));
        _count("observeAgent");
    }

    function notify(uint256 ethAmount, uint256 rcAmount) public {
        ethAmount = _bound(ethAmount, 0, 50 ether);
        rcAmount = _bound(rcAmount, 0, 5_000_000e18);
        if (ethAmount == 0 && rcAmount == 0) return;
        if (orry.balanceOf(address(this)) < rcAmount) return;
        vm.deal(address(this), ethAmount);
        staking.notifyRewards{value: ethAmount}(rcAmount);
        notified[0] += ethAmount;
        notified[1] += rcAmount;
        _count("notify");
    }

    function feedRouter(uint256 ethAmount, uint256 rcAmount) public {
        ethAmount = _bound(ethAmount, 0, 20 ether);
        rcAmount = _bound(rcAmount, 0, 2_000_000e18);
        if (orry.balanceOf(address(this)) < rcAmount) return;
        vm.deal(address(router), address(router).balance + ethAmount);
        orry.transfer(address(router), rcAmount);
        _count("feedRouter");
    }

    function distribute() public {
        uint256 eth = address(router).balance;
        uint256 rc = orry.balanceOf(address(router));
        uint256 stakingEth = address(staking).balance;
        uint256 stakingRc = orry.balanceOf(address(staking));
        uint256 sinkEth = sink.balance;
        uint256 supply = orry.totalSupply();
        try router.distribute() {
            uint256 ethSt = eth * router.STAKERS_BPS() / 10_000;
            uint256 rcSt = rc * router.STAKERS_BPS() / 10_000;
            if (address(router).balance != 0 || orry.balanceOf(address(router)) != 0) badRR1 = true;
            if (
                address(staking).balance - stakingEth != ethSt || orry.balanceOf(address(staking)) - stakingRc != rcSt
                    || sink.balance - sinkEth != eth - ethSt || supply - orry.totalSupply() != rc - rcSt
            ) badRR2 = true;
            notified[0] += ethSt;
            notified[1] += rcSt;
            routerBurned += rc - rcSt;
            routerToBuyback += eth - ethSt;
            _count("distribute");
        } catch {}
        _checkSupply();
    }

    function claim(uint256 callerSeed, uint256 accountSeed, bool forOther) public {
        address caller = _actor(callerSeed);
        address account = forOther ? _actor(accountSeed) : caller;
        (uint256 pe, uint256 pr) = staking.pendingRewards(account);
        uint256 ethBefore = account.balance;
        uint256 rcBefore = orry.balanceOf(account);
        vm.prank(caller);
        (uint256 e, uint256 r) = forOther ? staking.claimFor(account) : staking.claimRewards();
        if (e != pe || r != pr || account.balance != ethBefore + e || orry.balanceOf(account) != rcBefore + r) {
            badS2 = true; // rewards go to the account and nowhere else, exactly what was pending
        }
        paid[0] += e;
        paid[1] += r;
        if (e + r != 0) _count("claim");
    }

    function donate(uint256 amount) public {
        amount = _bound(amount, 1, 1_000e18);
        orry.transfer(address(staking), amount);
        donated += amount;
        _count("donate");
    }

    function warp(uint256 secs) public {
        secs = _bound(secs, 1, 3 days);
        _now += secs;
        _block += 1;
        vm.warp(_now);
        vm.roll(_block);
        _count("warp");
    }

    receive() external payable {}
}
