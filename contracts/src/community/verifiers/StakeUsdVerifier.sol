// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAchievementVerifier} from "../interfaces/IAchievementVerifier.sol";
import {IOrryPriceOracle} from "../../markets/interfaces/IMarketPricing.sol";
import {IOrryStaking} from "../../orry/interfaces/IOrryStaking.sol";

/// @notice Condition "earning stake in `OrryStaking` worth at least `minStakeUsd`" (R-41, utility 10). The earning
/// balance (plain plus agent stakes as staker) is valued with the R1 `OrryPriceOracle`; false while it is not ready.
/// No owner, no setter: one verifier per threshold.
contract StakeUsdVerifier is IAchievementVerifier {
    address public immutable staking;
    address public immutable orryPrice;
    uint256 public immutable minStakeUsd; // USDG base units

    constructor(address staking_, address orryPrice_, uint256 minStakeUsd_) {
        require(staking_ != address(0) && orryPrice_ != address(0), "zero address");
        require(minStakeUsd_ != 0, "zero threshold");
        staking = staking_;
        orryPrice = orryPrice_;
        minStakeUsd = minStakeUsd_;
    }

    function isComplete(address account, bytes calldata) external view returns (bool) {
        return StakeUsd.valueOf(staking, orryPrice, account) >= minStakeUsd;
    }
}

/// @notice USD value of an account's earning stake; 0 while the price is not ready or a read fails.
library StakeUsd {
    function valueOf(address staking, address orryPrice, address account) internal view returns (uint256) {
        try IOrryPriceOracle(orryPrice).ready() returns (bool r) {
            if (!r) return 0;
        } catch {
            return 0;
        }
        uint256 balance = IOrryStaking(staking).earningBalance(account);
        if (balance == 0) return 0;
        try IOrryPriceOracle(orryPrice).usdValue(balance) returns (uint256 usd) {
            return usd;
        } catch {
            return 0;
        }
    }
}
