// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OrryPriced} from "./OrryPriced.sol";

/// @title OrryPasses
/// @notice Day and week passes (utility 15, `docs/updates/L1-COMMUNITY-SPEC.md` L1-9): anyone buys pass time for any
/// account, priced in USD and paid in ORRY at the hub mean price, all of it burned (`Burned(9, amount)`). Units stack
/// from the later of now and the account's current end. The perks are a services config. No owner, no setter.
contract OrryPasses is OrryPriced {
    event PassBought(
        address indexed account, address indexed payer, uint8 indexed kind, uint256 count, uint256 burned, uint64 until
    );

    error BadKind();
    error BadCount();

    uint8 public constant BURN_SOURCE = 9;
    uint8 public constant KIND_DAY = 1;
    uint8 public constant KIND_WEEK = 2;
    uint256 public constant MAX_COUNT = 52;

    uint256 public immutable dayPassUsd;
    uint256 public immutable weekPassUsd;

    mapping(address account => uint64) public passUntil;

    constructor(address orry_, address orryPrice_, uint256 dayUsd, uint256 weekUsd) OrryPriced(orry_, orryPrice_) {
        require(dayUsd != 0 && weekUsd != 0, "zero price");
        dayPassUsd = dayUsd;
        weekPassUsd = weekUsd;
    }

    function _unit(uint8 kind) private view returns (uint256 usd, uint64 duration) {
        if (kind == KIND_DAY) return (dayPassUsd, 1 days);
        if (kind == KIND_WEEK) return (weekPassUsd, 7 days);
        revert BadKind();
    }

    function quote(uint8 kind, uint256 count) external view returns (uint256) {
        if (count == 0 || count > MAX_COUNT) revert BadCount();
        (uint256 usd,) = _unit(kind);
        return _quote(usd * count, type(uint256).max);
    }

    function hasPass(address account) external view returns (bool) {
        return passUntil[account] > block.timestamp;
    }

    function buy(address account, uint8 kind, uint256 count, uint256 maxOrry) external returns (uint64 until) {
        if (account == address(0)) revert ZeroAddress();
        if (count == 0 || count > MAX_COUNT) revert BadCount();
        (uint256 usd, uint64 duration) = _unit(kind);
        uint256 cost = _quote(usd * count, maxOrry);
        _burnFrom(msg.sender, cost, BURN_SOURCE);
        uint64 current = passUntil[account];
        uint64 start = current > block.timestamp ? current : uint64(block.timestamp);
        until = start + duration * uint64(count);
        passUntil[account] = until;
        emit PassBought(account, msg.sender, kind, count, cost, until);
    }
}
