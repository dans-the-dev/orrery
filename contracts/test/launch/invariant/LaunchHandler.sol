// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {AgentLaunch} from "../../../src/launch/AgentLaunch.sol";
import {AgentCoin} from "../../../src/launch/AgentCoin.sol";
import {SpokeHook} from "../../../src/launch/SpokeHook.sol";
import {OrryStaking} from "../../../src/orry/OrryStaking.sol";
import {MockIdentityRegistry} from "../../mocks/Mocks.sol";
import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";
import {MockAttestorL5, MockPolicyModuleL5} from "../utils/LaunchMocks.sol";

/// @notice Bounded actions over the L5 system: launches (each a fresh agent), early buys, public buys and sells exact in
/// and exact out, distributions, Earn flushes, creator claims, wallet unbinding and time. Every swap's fee is checked
/// against the hook's rule as it happens (LA-5); early buys against the allowance (LA-12); creator payouts against the
/// bound wallet (LA-13). Ghosts feed the invariants in `LaunchInvariants.t.sol`.
contract LaunchHandler is Test {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant MAX_COINS = 6;

    AgentLaunch public al;
    SpokeHook public hook;
    MockOrry public orry;
    OrryStaking public staking;
    MockIdentityRegistry public registry;
    MockAttestorL5 public attestor;
    MockPolicyModuleL5 public module;
    PoolSwapTest public swapRouter;
    IPoolManager public pm;

    address[] public actors;
    address[] public coinList;
    mapping(address coin => address) public walletOf;
    uint256 public clock;

    // ghosts
    uint256 public creatorPaid;
    bool public feeMismatch;
    bool public earlyViolation;
    bool public payoutViolation;
    bool public publicEarlyBuyAccepted;
    uint256 public nLaunch;
    uint256 public nEarly;
    uint256 public nEarlyRefused;
    uint256 public nBuy;
    uint256 public nSell;
    uint256 public nDistribute;
    uint256 public nClaim;
    uint256 public nFlush;

    constructor(
        AgentLaunch al_,
        SpokeHook hook_,
        MockOrry orry_,
        OrryStaking staking_,
        MockIdentityRegistry registry_,
        MockAttestorL5 attestor_,
        MockPolicyModuleL5 module_,
        PoolSwapTest swapRouter_,
        IPoolManager pm_,
        address[] memory actors_,
        uint256 clock_
    ) {
        al = al_;
        hook = hook_;
        orry = orry_;
        staking = staking_;
        registry = registry_;
        attestor = attestor_;
        module = module_;
        swapRouter = swapRouter_;
        pm = pm_;
        actors = actors_;
        clock = clock_;
    }

    function coinCount() external view returns (uint256) {
        return coinList.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _coin(uint256 seed) internal view returns (address) {
        return coinList[seed % coinList.length];
    }

    // ---------------------------------------------------------------- actions

    function launch(uint256 actorSeed, uint256 firstBuy) external {
        if (coinList.length >= MAX_COINS) return;
        address owner = _actor(actorSeed);
        uint256 id = registry.register(owner);
        address wallet = makeAddr(string(abi.encode("hwallet", id)));
        vm.prank(owner);
        registry.setAgentWallet(id, wallet);
        attestor.setVerified(id, true);
        module.setInstalled(wallet, true);
        vm.startPrank(owner);
        staking.stakeForAgent(id, 20_000e18);
        staking.extendAgentLock(id, uint64(block.timestamp + 91 days));
        firstBuy = bound(firstBuy, 0, 3_000_000e18);
        address coin = al.launch(id, "Handler Coin", "HDC", bytes32(id), firstBuy, 0);
        vm.stopPrank();
        coinList.push(coin);
        walletOf[coin] = wallet;
        nLaunch++;
    }

    function buyEarly(uint256 actorSeed, uint256 coinSeed, uint256 amount) external {
        if (coinList.length == 0) return;
        address who = _actor(actorSeed);
        // half the time the newest coin, which is the one most likely still in its early window
        address coin = coinSeed % 2 == 0 ? coinList[coinList.length - 1] : _coin(coinSeed / 2);
        amount = bound(amount, 1e18, 25_000e18);
        uint256 room = al.earlyAllowance(coin, who);
        uint256 bought = al.earlyBought(coin, who);
        vm.prank(who);
        try al.buyEarly(coin, amount, 0, block.timestamp) returns (uint256 out) {
            nEarly++;
            if (out > room || al.earlyBought(coin, who) != bought + out) earlyViolation = true;
        } catch {
            nEarlyRefused++;
        }
    }

    function buy(uint256 actorSeed, uint256 coinSeed, uint256 amount, bool exactOut) external {
        if (coinList.length == 0) return;
        address who = _actor(actorSeed);
        address coin = _coin(coinSeed);
        PoolKey memory key = al.poolKeyOf(coin);
        PoolId id = key.toId();
        bool early = hook.isEarly(id);
        uint24 pips = hook.feeAt(id, block.timestamp);
        uint256 fees0 = hook.feesOf(id);
        uint256 rc0 = orry.balanceOf(who);
        int256 spec = exactOut ? int256(bound(amount, 1e18, 5_000_000e18)) : -int256(bound(amount, 1e15, 500_000e18));
        try this.swapAs(who, key, true, spec) {
            if (early) publicEarlyBuyAccepted = true;
            uint256 fee = hook.feesOf(id) - fees0;
            uint256 paid = rc0 - orry.balanceOf(who);
            // exact in: fee from the paid input; exact out: fee on top of the pool's input
            uint256 expected = exactOut ? (paid - fee) * pips / 1e6 : paid * pips / 1e6;
            if (fee != expected) feeMismatch = true;
            nBuy++;
        } catch {}
    }

    function sell(uint256 actorSeed, uint256 coinSeed, uint256 fraction, bool exactOut) external {
        if (coinList.length == 0) return;
        address who = _actor(actorSeed);
        address coin = _coin(coinSeed);
        uint256 bal = AgentCoin(coin).balanceOf(who);
        if (bal == 0) return;
        PoolKey memory key = al.poolKeyOf(coin);
        PoolId id = key.toId();
        uint256 fees0 = hook.feesOf(id);
        uint256 rc0 = orry.balanceOf(who);
        int256 spec;
        if (exactOut) {
            spec = int256(bound(fraction, 1e15, 1_000e18));
        } else {
            spec = -int256(bound(fraction, 1, bal));
        }
        try this.swapAs(who, key, false, spec) {
            uint256 fee = hook.feesOf(id) - fees0;
            uint256 got = orry.balanceOf(who) - rc0;
            uint256 expected = exactOut ? uint256(spec) * 10_000 / 1e6 : (got + fee) * 10_000 / 1e6;
            if (fee != expected) feeMismatch = true;
            if (exactOut && got != uint256(spec)) feeMismatch = true;
            nSell++;
        } catch {}
    }

    /// @dev External so a refused swap can be caught; only this handler calls it.
    function swapAs(address who, PoolKey memory key, bool buy_, int256 spec) external {
        require(msg.sender == address(this), "self only");
        vm.prank(who);
        AgentCoin(Currency.unwrap(key.currency1)).approve(address(swapRouter), type(uint256).max);
        vm.prank(who);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: buy_,
                amountSpecified: spec,
                sqrtPriceLimitX96: buy_ ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function distribute(uint256 coinSeed) external {
        if (coinList.length == 0) return;
        if (al.distribute(_coin(coinSeed)) > 0) nDistribute++;
    }

    function flushEarn() external {
        if (al.flushEarn() > 0) nFlush++;
    }

    function claimCreator(uint256 coinSeed) external {
        if (coinList.length == 0) return;
        address coin = _coin(coinSeed);
        address wallet = registry.getAgentWallet(al.launchOf(coin).agentId);
        uint256 before = wallet == address(0) ? 0 : orry.balanceOf(wallet);
        try al.claimCreatorFees(coin) returns (uint256 paid) {
            if (wallet == address(0) || !module.isInstalledOn(wallet) || orry.balanceOf(wallet) - before != paid) {
                payoutViolation = true;
            }
            creatorPaid += paid;
            nClaim++;
        } catch {}
    }

    function toggleWallet(uint256 coinSeed) external {
        if (coinList.length == 0) return;
        address wallet = walletOf[_coin(coinSeed)];
        module.setInstalled(wallet, !module.isInstalledOn(wallet));
    }

    function warp(uint256 secs) external {
        clock += bound(secs, 1, 2 hours);
        vm.warp(clock);
        vm.roll(vm.getBlockNumber() + 1);
    }
}
