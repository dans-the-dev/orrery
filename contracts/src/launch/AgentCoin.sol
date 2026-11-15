// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @notice A coin launched by a Orrery-verified agent through `AgentLaunch` (`docs/updates/L5-LAUNCH-SPEC.md` L5-1): a
/// plain ERC-20 with a fixed supply minted once to the launcher, 18 decimals. No owner, no mint, no burn, no pause, no
/// blocklist, no transfer hook, no upgrade path. Pattern of the owner's `HashbornToken`
/// (`hashborn-npm/contracts/src/HashbornToken.sol`, MIT), rebuilt on solmate's ERC20.
contract AgentCoin is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address to) ERC20(name_, symbol_, 18) {
        _mint(to, supply);
    }
}
