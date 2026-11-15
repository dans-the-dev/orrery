// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @notice Reads `OrryStaking`'s private stream ledgers from storage (layout from `forge inspect OrryStaking
/// storageLayout`: `_streams` at slot 4, five words per stream: rate, periodFinish|lastUpdate, perToken, unstreamed,
/// owed). Tests use it to check S-4 exactly: notified = claimed + owed + scheduled + unstreamed.
library StakingLedger {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant STREAMS_SLOT = 4;

    struct Ledger {
        uint256 rate;
        uint64 periodFinish;
        uint64 lastUpdate;
        uint256 perToken;
        uint256 unstreamed;
        uint256 owed;
    }

    function read(address staking, uint256 asset) internal view returns (Ledger memory l) {
        uint256 base = STREAMS_SLOT + asset * 5;
        l.rate = uint256(VM.load(staking, bytes32(base)));
        uint256 packed = uint256(VM.load(staking, bytes32(base + 1)));
        l.periodFinish = uint64(packed);
        l.lastUpdate = uint64(packed >> 64);
        l.perToken = uint256(VM.load(staking, bytes32(base + 2)));
        l.unstreamed = uint256(VM.load(staking, bytes32(base + 3)));
        l.owed = uint256(VM.load(staking, bytes32(base + 4)));
    }

    /// @dev The part of the running stream not yet streamed, as of now (exact at any time: streams accrue lazily, so
    /// rate * (periodFinish - max(now, lastUpdate)) plus the lazily unaccrued part rate * (min(now, finish) - lastUpdate)).
    function scheduledAndLazy(address staking, uint256 asset) internal view returns (uint256) {
        Ledger memory l = read(staking, asset);
        if (l.periodFinish <= l.lastUpdate) return 0;
        return l.rate * (l.periodFinish - l.lastUpdate);
    }
}
