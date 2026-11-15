// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOrryRewardsRouter} from "./interfaces/IOrryRewardsRouter.sol";
import {IOrryStaking} from "./interfaces/IOrryStaking.sol";
import {IOrryBurnEvents, IOrryToken} from "./interfaces/IOrryToken.sol";
import {IOrreryHook} from "./interfaces/IOrreryHook.sol";
import {IERC20Min} from "../interfaces/IExternal.sol";

/// @title OrryRewardsRouter
/// @notice Splits the protocol money it receives (`docs/ORRY-BUILD-SPEC.md` 3.4, invariants RR-1 and RR-2): the hub
/// hook's protocol fees and the ORRY the buyback bought with treasury revenue. For each asset the stakers' part
/// `floor(balance * STAKERS_BPS / 10000)` goes to `OrryStaking.notifyRewards`; the rest of the ORRY is burned
/// (source 1) and the rest of the ETH goes to the buyback, which buys ORRY in the ETH hub and burns it (source 4).
/// Every registered quote other than native ETH (R-37, the hook's pair list) is forwarded whole to the buyback, which
/// buys ORRY in that quote's own hub and sends it back here, where the next `distribute` splits it like any ORRY. A
/// token that is not a registered quote is never moved (P-5); a quote whose transfer fails stays for the next call.
/// @dev No owner, no setter. Calls only ORRY, the staking contract, the buyback, the hook's pair views and the quote
/// tokens' `balanceOf` and `transfer`; never a Pons contract (R-1).
contract OrryRewardsRouter is IOrryRewardsRouter, IOrryBurnEvents {
    uint256 private constant BPS = 10_000;
    bytes32 private constant LOCK_SLOT = keccak256("orrery.orry.router.lock");

    uint16 public immutable STAKERS_BPS;
    uint64 public immutable MIN_INTERVAL;

    address public immutable orry;
    address public immutable staking;
    address public immutable buyback;
    address public immutable hook;

    uint64 public lastDistributionAt;

    constructor(address orry_, address staking_, address buyback_, address hook_, uint16 stakersBps, uint64 minInterval) {
        require(
            orry_ != address(0) && staking_ != address(0) && buyback_ != address(0) && hook_ != address(0),
            "zero address"
        );
        require(stakersBps <= BPS, "bps above 10000");
        require(minInterval != 0, "zero interval");
        require(IOrryStaking(staking_).orry() == orry_, "staking token");
        require(IOrreryHook(hook_).orry() == orry_, "hook token");
        orry = orry_;
        staking = staking_;
        buyback = buyback_;
        hook = hook_;
        STAKERS_BPS = stakersBps;
        MIN_INTERVAL = minInterval;
    }

    modifier nonReentrant() {
        bytes32 slot = LOCK_SLOT;
        assembly ("memory-safe") {
            if tload(slot) { revert(0, 0) }
            tstore(slot, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    receive() external payable {}

    function distribute() external nonReentrant {
        uint64 last = lastDistributionAt;
        if (last != 0 && block.timestamp < last + MIN_INTERVAL) revert TooSoon(last + MIN_INTERVAL);
        uint256 eth = address(this).balance;
        uint256 rc = IOrryToken(orry).balanceOf(address(this));
        bool forwarded = _forwardQuotes();
        if (eth == 0 && rc == 0 && !forwarded) revert NothingToDistribute();
        lastDistributionAt = uint64(block.timestamp);

        uint256 ethToStakers = eth * STAKERS_BPS / BPS;
        uint256 orryToStakers = rc * STAKERS_BPS / BPS;
        uint256 ethToBuyback = eth - ethToStakers;
        uint256 orryBurned = rc - orryToStakers;

        if (ethToStakers != 0 || orryToStakers != 0) {
            if (orryToStakers != 0) _approve(staking, orryToStakers);
            IOrryStaking(staking).notifyRewards{value: ethToStakers}(orryToStakers);
        }
        if (orryBurned != 0) {
            IOrryToken(orry).burn(orryBurned);
            emit Burned(1, orryBurned);
        }
        emit Distributed(ethToStakers, orryToStakers, ethToBuyback, orryBurned);
        if (ethToBuyback != 0) {
            (bool ok,) = buyback.call{value: ethToBuyback}("");
            if (!ok) revert EthTransferFailed();
        }
    }

    /// @dev R-37: each registered quote other than native ETH goes whole to the buyback. The hook caps the list at
    /// MAX_PAIRS. ORRY is never a quote (the hook refuses it), but it is skipped here too.
    function _forwardQuotes() private returns (bool any) {
        uint256 n = IOrreryHook(hook).pairCount();
        for (uint256 i; i < n; ++i) {
            address quote = IOrreryHook(hook).pairAt(i).quote;
            if (quote == address(0) || quote == orry) continue;
            uint256 amount;
            try IERC20Min(quote).balanceOf(address(this)) returns (uint256 b) {
                amount = b;
            } catch {
                continue;
            }
            if (amount == 0) continue;
            (bool ok, bytes memory ret) = quote.call(abi.encodeCall(IERC20Min.transfer, (buyback, amount)));
            if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) continue;
            emit QuoteForwarded(quote, amount);
            any = true;
        }
    }

    function _approve(address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = orry.call(abi.encodeCall(IOrryToken.approve, (spender, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "approve failed");
    }
}
