// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IClaimAll} from "./interfaces/IOrryClaims.sol";
import {IEarnVault} from "./interfaces/IEarnVault.sol";
import {IEarnVaultFactory} from "./interfaces/IEarnVaultFactory.sol";
import {IOrryStaking} from "./interfaces/IOrryStaking.sol";

/// @title ClaimAll
/// @notice One call claims every reward of the caller (`docs/ORRY-BUILD-SPEC.md` 3.7): the fees of every Earn vault
/// the factory lists (at most MAX_PAIRS) and the staking rewards, each paid by its own contract straight to
/// `msg.sender`. Holds nothing, no owner.
contract ClaimAll is IClaimAll {
    address public immutable earnFactory;
    address public immutable staking;
    address private immutable _orry;

    constructor(address earnFactory_, address staking_) {
        require(earnFactory_ != address(0) && staking_ != address(0), "zero address");
        earnFactory = earnFactory_;
        staking = staking_;
        _orry = IOrryStaking(staking_).orry();
    }

    /// @dev `paid`: ORRY, native ETH (staking plus the ETH vault), then each other vault's quote in factory order.
    function claimAll() external returns (Paid[] memory paid) {
        address[] memory vaults = IEarnVaultFactory(earnFactory).vaults();
        address[] memory quotes = new address[](vaults.length);
        uint256 others;
        for (uint256 i; i < vaults.length; ++i) {
            quotes[i] = IEarnVault(vaults[i]).quote();
            if (quotes[i] != address(0)) ++others;
        }
        paid = new Paid[](2 + others);
        paid[0].asset = _orry;
        (uint256 stakeEth, uint256 stakeOrry) = IOrryStaking(staking).claimFor(msg.sender);
        paid[0].amount = stakeOrry;
        paid[1].amount = stakeEth;
        uint256 k = 2;
        for (uint256 i; i < vaults.length; ++i) {
            (uint256 q, uint256 r) = IEarnVault(vaults[i]).claimFor(msg.sender);
            paid[0].amount += r;
            if (quotes[i] == address(0)) {
                paid[1].amount += q;
            } else {
                paid[k] = Paid(quotes[i], q);
                ++k;
            }
        }
        emit ClaimedAll(msg.sender, paid);
    }
}
