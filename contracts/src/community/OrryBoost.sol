// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OrryPriced} from "./OrryPriced.sol";

/// @title OrryBoost
/// @notice Burn-to-boost (utility 14) and agent promotion (C2), `docs/updates/L1-COMMUNITY-SPEC.md` L1-8. Anyone burns
/// ORRY worth `usdPerDay(kind) x days` at the hub mean price to boost a target for that many 24 hour units; units stack
/// from the later of now and the target's current end. Kinds: 1 a chat post (message id), 2 an agent (ERC-8004 agentId),
/// 3 a template listing (template id). Every ORRY paid is burned (`Burned(8, amount)`). No owner, no setter.
contract OrryBoost is OrryPriced {
    event Boosted(
        uint8 indexed kind, uint256 indexed target, address indexed payer, uint256 days_, uint256 burned, uint64 until
    );

    error BadKind();
    error BadDays();

    uint8 public constant BURN_SOURCE = 8;
    uint8 public constant KIND_POST = 1;
    uint8 public constant KIND_AGENT = 2;
    uint8 public constant KIND_TEMPLATE = 3;
    uint256 public constant MAX_DAYS = 30;

    uint256 public immutable postUsdPerDay;
    uint256 public immutable agentUsdPerDay;
    uint256 public immutable templateUsdPerDay;

    mapping(uint8 kind => mapping(uint256 target => uint64)) public boostedUntil;

    constructor(address orry_, address orryPrice_, uint256 postUsd, uint256 agentUsd, uint256 templateUsd)
        OrryPriced(orry_, orryPrice_)
    {
        require(postUsd != 0 && agentUsd != 0 && templateUsd != 0, "zero price");
        postUsdPerDay = postUsd;
        agentUsdPerDay = agentUsd;
        templateUsdPerDay = templateUsd;
    }

    function usdPerDay(uint8 kind) public view returns (uint256) {
        if (kind == KIND_POST) return postUsdPerDay;
        if (kind == KIND_AGENT) return agentUsdPerDay;
        if (kind == KIND_TEMPLATE) return templateUsdPerDay;
        revert BadKind();
    }

    function quote(uint8 kind, uint256 days_) external view returns (uint256) {
        if (days_ == 0 || days_ > MAX_DAYS) revert BadDays();
        return _quote(usdPerDay(kind) * days_, type(uint256).max);
    }

    function isBoosted(uint8 kind, uint256 target) external view returns (bool) {
        return boostedUntil[kind][target] > block.timestamp;
    }

    function boost(uint8 kind, uint256 target, uint256 days_, uint256 maxOrry) external returns (uint64 until) {
        if (days_ == 0 || days_ > MAX_DAYS) revert BadDays();
        uint256 cost = _quote(usdPerDay(kind) * days_, maxOrry);
        _burnFrom(msg.sender, cost, BURN_SOURCE);
        uint64 current = boostedUntil[kind][target];
        uint64 start = current > block.timestamp ? current : uint64(block.timestamp);
        until = start + uint64(days_) * 1 days;
        boostedUntil[kind][target] = until;
        emit Boosted(kind, target, msg.sender, days_, cost, until);
    }
}
