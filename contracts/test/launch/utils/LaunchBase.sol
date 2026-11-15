// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC6909Claims} from "v4-core/src/interfaces/external/IERC6909Claims.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {OrryStaking} from "../../../src/orry/OrryStaking.sol";
import {AgentLaunch} from "../../../src/launch/AgentLaunch.sol";
import {SpokeHook} from "../../../src/launch/SpokeHook.sol";
import {IAgentLaunch} from "../../../src/launch/interfaces/IAgentLaunch.sol";

import {PoolManagerCode} from "../../orry/earn/fixtures/PoolManagerCode.sol";
import {MockIdentityRegistry} from "../../mocks/Mocks.sol";
import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";
import {MockOrryPrice} from "../../community/utils/CommunityMocks.sol";
import {MockAttestorL5, MockPolicyModuleL5, MockTreasuryL5, MockEarnVaultL5} from "./LaunchMocks.sol";

/// @notice Lane L5 unit base: the live v4 PoolManager code etched at its 4663 address, ORRY at a low address (so every
/// coin sorts above it), the real `OrryStaking`, stand-ins for the registry, attestor, policy module, price, vault and
/// treasury, and the L5 contracts with the spec defaults. 100 ORRY = 1 USD at the stand-in price.
abstract contract LaunchBase is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager internal constant PM = IPoolManager(PoolManagerCode.ADDRESS);
    address internal constant ORRY_LOW = address(uint160(0xC0DE0000));
    uint160 internal constant HOOK_BITS = 0x28CC;

    // spec defaults (guesses, L5-3, L5-5, L5-6, L5-7, L5-9)
    int24 internal constant START_TICK = 25_000;
    uint24 internal constant START_FEE = 800_000;
    uint32 internal constant DECAY = 60;
    uint32 internal constant EARLY = 600;

    MockOrry internal orry;
    MockIdentityRegistry internal registry;
    MockAttestorL5 internal attestor;
    MockPolicyModuleL5 internal module;
    MockOrryPrice internal price;
    MockEarnVaultL5 internal vault;
    MockTreasuryL5 internal treasury;
    OrryStaking internal staking;
    SpokeHook internal hook;
    AgentLaunch internal al;
    PoolSwapTest internal swapRouter;

    address internal ownerWallet = makeAddr("ownerWallet");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    uint256 internal clock;

    function setUp() public virtual {
        clock = 1_800_000_000;
        vm.warp(clock);
        vm.etch(address(PM), PoolManagerCode.RUNTIME);
        address at = orryAt();
        deployCodeTo("StakeMocks.sol:MockOrry", abi.encode(address(this), 1e30), at);
        orry = MockOrry(at);
        registry = new MockIdentityRegistry();
        attestor = new MockAttestorL5();
        module = new MockPolicyModuleL5();
        price = new MockOrryPrice();
        vault = new MockEarnVaultL5(address(orry));
        treasury = new MockTreasuryL5(ownerWallet);
        staking = new OrryStaking(address(orry), address(registry), 7 days, 14 days, 7 days);
        swapRouter = new PoolSwapTest(PM);
        (hook, al) = deployLaunch(defaultParams(), START_FEE, DECAY, EARLY, 1);

        address[4] memory people = [alice, bob, carol, dave];
        for (uint256 i; i < people.length; ++i) {
            orry.transfer(people[i], 1e28);
            vm.startPrank(people[i]);
            orry.approve(address(al), type(uint256).max);
            orry.approve(address(staking), type(uint256).max);
            orry.approve(address(swapRouter), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @dev Where ORRY lives; low by default so every coin sorts above it.
    function orryAt() internal view virtual returns (address) {
        return ORRY_LOW;
    }

    function defaultParams() internal pure returns (IAgentLaunch.Params memory) {
        return IAgentLaunch.Params({
            startTick: START_TICK,
            maxFirstBuyBps: 500,
            minStakeUsd: 100e6,
            earlyMaxBps: 50,
            earlyFullUsd: 1_000e6,
            earlyMinUsd: 10e6
        });
    }

    /// @dev Hook at an address with exactly the spoke bits (`seed` varies it), then `AgentLaunch` at the predicted address.
    function deployLaunch(IAgentLaunch.Params memory p, uint24 startFee, uint32 decay, uint32 early, uint256 seed)
        internal
        returns (SpokeHook h, AgentLaunch a)
    {
        uint64 nonce = vm.getNonce(address(this));
        address launchAt = vm.computeCreateAddress(address(this), nonce);
        address hookAt = address((uint160(uint256(keccak256(abi.encode("l5.hook", seed)))) & ~uint160(0x3FFF)) | HOOK_BITS);
        deployCodeTo(
            "SpokeHook.sol:SpokeHook", abi.encode(address(PM), address(orry), launchAt, startFee, decay, early), hookAt
        );
        h = SpokeHook(hookAt);
        vm.setNonceUnsafe(address(this), nonce); // deployCodeTo spends a nonce; AgentLaunch takes the predicted one
        a = new AgentLaunch(
            address(PM),
            address(orry),
            hookAt,
            address(registry),
            address(attestor),
            address(module),
            address(staking),
            address(price),
            address(vault),
            address(treasury),
            p
        );
        require(address(a) == launchAt, "launch address prediction");
    }

    // ---------------------------------------------------------------- helpers

    function _warp(uint256 secs) internal {
        clock += secs;
        vm.warp(clock);
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev A verified agent owned by `owner` with a bound wallet (module installed), 20,000 ORRY (200 USD) staked behind
    /// it by the owner and locked 91 days.
    function _agent(address owner) internal returns (uint256 id, address wallet) {
        id = registry.register(owner);
        wallet = makeAddr(string(abi.encode("wallet", id)));
        vm.prank(owner);
        registry.setAgentWallet(id, wallet);
        attestor.setVerified(id, true);
        module.setInstalled(wallet, true);
        vm.startPrank(owner);
        staking.stakeForAgent(id, 20_000e18);
        staking.extendAgentLock(id, uint64(block.timestamp + 91 days));
        vm.stopPrank();
    }

    function _launch(uint256 id, address caller, uint256 orryIn) internal returns (address coin) {
        vm.prank(caller);
        coin = al.launch(id, "Agent Coin", "AGC", bytes32(id), orryIn, 0);
    }

    function _launchOpen(address owner) internal returns (address coin, uint256 id) {
        (id,) = _agent(owner);
        coin = _launch(id, owner, 0);
        _warp(EARLY + DECAY);
    }

    function _key(address coin) internal view returns (PoolKey memory) {
        return al.poolKeyOf(coin);
    }

    function _approveCoin(address who, address coin) internal {
        vm.prank(who);
        MockOrry(coin).approve(address(swapRouter), type(uint256).max);
    }

    function _swap(address who, address coin, bool buy, int256 amountSpecified) internal returns (BalanceDelta d) {
        _approveCoin(who, coin);
        return _rawSwap(who, _key(coin), buy, amountSpecified);
    }

    /// @dev No external call before the swap itself, so `vm.expectRevert` can sit in front of it.
    function _rawSwap(address who, PoolKey memory key, bool buy, int256 amountSpecified) internal returns (BalanceDelta d) {
        vm.prank(who);
        d = swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: buy,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Exact-in buy: returns coins received.
    function _buy(address who, address coin, uint256 orryIn) internal returns (uint256) {
        BalanceDelta d = _swap(who, coin, true, -int256(orryIn));
        return uint256(int256(d.amount1()));
    }

    /// @dev Exact-in sell: returns ORRY received.
    function _sell(address who, address coin, uint256 coinsIn) internal returns (uint256) {
        BalanceDelta d = _swap(who, coin, false, -int256(coinsIn));
        return uint256(int256(d.amount0()));
    }

    function _claims(address who) internal view returns (uint256) {
        return IERC6909Claims(address(PM)).balanceOf(who, uint256(uint160(address(orry))));
    }

    /// @dev Liquidity of AgentLaunch's launch position (the pool's active liquidity is 0 while the price sits exactly at
    /// START_TICK, the position's upper edge, and equals it everywhere below).
    function _liquidity(address coin) internal view returns (uint128 liq) {
        (liq,,) = PM.getPositionInfo(_key(coin).toId(), address(al), al.MIN_TICK(), START_TICK, bytes32(0));
    }

    /// @dev LA-6 in full: the launch position holds the launch liquidity and is the only liquidity in range.
    function _assertOnePosition(address coin) internal view {
        PoolId id = _key(coin).toId();
        uint128 l = al.launchLiquidity();
        assertEq(_liquidity(coin), l, "LA-6 launch position");
        uint128 active = PM.getLiquidity(id);
        assertEq(active, _tick(coin) < START_TICK ? l : 0, "LA-6 no other liquidity");
    }

    function _tick(address coin) internal view returns (int24 tick) {
        (, tick,,) = PM.getSlot0(_key(coin).toId());
    }
}
