// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title DevRoundFeed
/// @notice Development stand-in for a Chainlink aggregator proxy on networks that have none (46630). The owner pushes
///         rounds (a process mirrors the matching Robinhood Chain 4663 feed), each stamped with the block time. Reads
///         follow AggregatorV3: phase-style round ids from 2^64, `getRoundData` reverts for a round that does not
///         exist, so the markets can pick the round that was current at a reveal window's end. Not for production.
contract DevRoundFeed {
    uint80 public constant FIRST = uint80(1 << 64);
    uint8 public immutable decimals;
    string public description;
    address public owner;

    uint80 internal _latest;
    mapping(uint80 => int256) internal _answer;
    mapping(uint80 => uint256) internal _updatedAt;

    error NotOwner();
    error NoData();
    event Pushed(uint80 indexed roundId, int256 answer, uint256 updatedAt);
    event OwnerSet(address indexed owner);

    constructor(uint8 decimals_, string memory description_, address owner_) {
        decimals = decimals_;
        description = description_;
        owner = owner_;
        emit OwnerSet(owner_);
    }

    function push(int256 answer) external returns (uint80 id) {
        if (msg.sender != owner) revert NotOwner();
        id = _latest == 0 ? FIRST : _latest + 1;
        _latest = id;
        _answer[id] = answer;
        _updatedAt[id] = block.timestamp;
        emit Pushed(id, answer, block.timestamp);
    }

    function setOwner(address owner_) external {
        if (msg.sender != owner) revert NotOwner();
        owner = owner_;
        emit OwnerSet(owner_);
    }

    function version() external pure returns (uint256) {
        return 4;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (_latest == 0) revert NoData();
        uint80 id = _latest;
        return (id, _answer[id], _updatedAt[id], _updatedAt[id], id);
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 t = _updatedAt[roundId];
        if (t == 0) revert NoData();
        return (roundId, _answer[roundId], t, t, roundId);
    }
}
