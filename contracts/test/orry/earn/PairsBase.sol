// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {EarnVault} from "../../../src/orry/EarnVault.sol";
import {EarnBase} from "./EarnBase.sol";
import {MockFeed, MockToken} from "./mocks/EarnMocks.sol";

/// @dev Several hubs at once: the ETH hub (initialized by EarnBase), the USDG hub and further pairs added through the
/// pair admin. Helpers address a hub by its quote.
abstract contract PairsBase is EarnBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    int24 internal constant FULL_LOWER = -887200;
    int24 internal constant FULL_UPPER = 887200;

    function initHub(address q_) internal {
        PM.initialize(hook.hubKey(q_), openingSqrtPrice(q_));
    }

    function initHub(address q_, uint256 perEth) internal {
        PM.initialize(hook.hubKey(q_), openingSqrtPrice(q_, perEth));
    }

    /// @dev A further quote token at a chosen address (below or above ORRY), funded for the users and the trader.
    function newToken(string memory symbol, uint8 decimals_, address at) internal returns (MockToken t) {
        deployCodeTo("EarnMocks.sol:MockToken", abi.encode(symbol, decimals_), at);
        t = MockToken(at);
        t.mint(address(trader), 1e30);
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            t.mint(users[i], 1e30);
        }
    }

    /// @dev Proposes, waits out the delay (refreshing the feed) and executes ORRY/`token`.
    function registerPair(address token, MockFeed feed) internal {
        vm.prank(admin);
        hook.proposePair(token, address(feed));
        wait(hook.PAIR_DELAY());
        feed.set(feed.answer(), vm.getBlockTimestamp());
        vm.prank(admin);
        hook.executePair(token);
    }

    function hubId(address q_) internal view returns (PoolId) {
        return hook.hubKey(q_).toId();
    }

    function hubSqrtPrice(address q_) internal view returns (uint160 p) {
        (p,,,) = PM.getSlot0(hubId(q_));
    }

    function hubTick(address q_) internal view returns (int24 t) {
        (, t,,) = PM.getSlot0(hubId(q_));
    }

    /// @dev Exact-input swap in the `q_` hub: `sellQuote` sells the quote for ORRY, else ORRY for the quote.
    function swapIn(address q_, bool sellQuote_, uint256 amount) internal returns (BalanceDelta) {
        bool r0 = hook.pairOf(q_).orryIsCurrency0;
        return trader.swap(hook.hubKey(q_), sellQuote_ != r0, -int256(amount));
    }

    /// @dev Full-range liquidity from the trader straight on the PoolManager.
    function addLiquidity(address q_, uint256 liquidity) internal {
        trader.modify(hook.hubKey(q_), FULL_LOWER, FULL_UPPER, int256(liquidity), bytes32(0));
    }

    /// @dev The factory vault of `q_` (created if needed), approved for every user.
    function factoryVault(address q_) internal returns (EarnVault v) {
        address a = factory.vaultOf(q_);
        if (a == address(0)) a = factory.createVault(q_);
        v = EarnVault(payable(a));
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(users[i]);
            orry.approve(a, type(uint256).max);
            if (q_ != address(0)) MockToken(q_).approve(a, type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @dev Balanced deposit of `quoteAmount` into vault `v` (enough ORRY at the hub price, plus 2%).
    function depositInto(EarnVault v, address user, uint256 quoteAmount) internal returns (uint256) {
        address q_ = v.quote();
        uint160 p = hubSqrtPrice(q_);
        bool r0 = hook.pairOf(q_).orryIsCurrency0;
        uint256 rc = r0
            ? quoteAmount * (1 << 96) / p * (1 << 96) / p
            : quoteAmount * uint256(p) / (1 << 96) * uint256(p) / (1 << 96);
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(user);
        return v.deposit{value: q_ == address(0) ? quoteAmount : 0}(quoteAmount, rc * 102 / 100 + 1, 0, 0, type(uint160).max, ts);
    }
}
