// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOrryPriceOracle} from "../markets/interfaces/IMarketPricing.sol";
import {IOrryBurnEvents, IOrryToken} from "../orry/interfaces/IOrryToken.sol";

/// @notice Shared base of the L1 contracts that charge a USD price in ORRY (`docs/updates/L1-COMMUNITY-SPEC.md` 1).
/// The price is the R1 `OrryPriceOracle` (hub mean tick over 30 minutes, R-28); the caller caps what it pays.
abstract contract OrryPriced is IOrryBurnEvents {
    error ZeroAddress();
    error PriceNotReady();
    error PriceAboveMax(uint256 orryNeeded, uint256 maxOrry);
    error InexactTransfer();

    uint256 internal constant BPS = 10_000;

    IOrryToken public immutable orry;
    IOrryPriceOracle public immutable orryPrice;

    constructor(address orry_, address orryPrice_) {
        if (orry_ == address(0) || orryPrice_ == address(0)) revert ZeroAddress();
        orry = IOrryToken(orry_);
        orryPrice = IOrryPriceOracle(orryPrice_);
    }

    /// @dev ORRY worth `usd` (USDG base units) now, rounded up by the oracle; reverts above `maxOrry`.
    function _quote(uint256 usd, uint256 maxOrry) internal view returns (uint256 amount) {
        if (!_ready()) revert PriceNotReady();
        try orryPrice.orryFor(usd) returns (uint256 a) {
            amount = a;
        } catch {
            revert PriceNotReady();
        }
        if (amount > maxOrry) revert PriceAboveMax(amount, maxOrry);
    }

    function _ready() internal view returns (bool) {
        try orryPrice.ready() returns (bool r) {
            return r;
        } catch {
            return false;
        }
    }

    /// @dev Moves exactly `amount` ORRY from `from` to `to` (balance-delta checked on `to`).
    function _pull(address from, address to, uint256 amount) internal {
        if (amount == 0) return;
        uint256 before = orry.balanceOf(to);
        orry.transferFrom(from, to, amount);
        if (orry.balanceOf(to) - before != amount) revert InexactTransfer();
    }

    /// @dev Pulls `amount` ORRY from `from` into this contract and burns it (supply-delta checked).
    function _burnFrom(address from, uint256 amount, uint8 source) internal {
        if (amount == 0) return;
        _pull(from, address(this), amount);
        uint256 supply = orry.totalSupply();
        orry.burn(amount);
        if (supply - orry.totalSupply() != amount) revert InexactTransfer();
        emit Burned(source, amount);
    }
}
