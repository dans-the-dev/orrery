// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice One button for every reward an address has (`docs/ORRY-BUILD-SPEC.md` 3.7). Calls `claimFor(msg.sender)` on
/// every Earn vault the factory lists (at most MAX_PAIRS) and on staking; each pays only that address. Holds nothing. No
/// owner.
interface IClaimAll {
    /// @notice One paid asset; `asset` address 0 is native ETH.
    struct Paid {
        address asset;
        uint256 amount;
    }

    /// @notice `paid` lists ORRY first, native ETH second (staking plus the ETH vault), then the quote of every other
    /// vault in factory order; zero amounts included.
    event ClaimedAll(address indexed account, Paid[] paid);

    function earnFactory() external view returns (address);
    function staking() external view returns (address);

    function claimAll() external returns (Paid[] memory paid);
}

/// @notice Read-only view for the claim center: everything an address can claim or withdraw now or later.
interface IOrryLens {
    /// @notice The address's place in one Earn vault (one entry per factory vault, shares 0 included).
    struct EarnPosition {
        address vault;
        address quote; // address 0 = native ETH
        uint256 shares;
        uint64 unlockAt;
        uint256 feesQuote;
        uint256 feesOrry;
        uint256 positionQuote; // what the address's shares would withdraw now
        uint256 positionOrry;
    }

    struct Claimables {
        EarnPosition[] earn; // factory order, at most MAX_PAIRS
        uint256 stakeActive;
        uint256 stakeLeaving;
        uint64 stakeReadyAt;
        uint256 stakeRewardsEth;
        uint256 stakeRewardsOrry;
    }

    struct AgentClaimable {
        uint256 agentId;
        address owner;
        uint256 active;
        uint256 leaving;
        uint64 leavingAt;
        bool reportedForAgent; // owner == current ownerOf(agentId)
    }

    function earnFactory() external view returns (address);
    function staking() external view returns (address);

    function claimables(address account) external view returns (Claimables memory);
    /// @notice Agent positions the address holds as staker, for the agentIds and owners the indexer supplies.
    function agentClaimables(address staker, uint256[] calldata agentIds, address[] calldata owners)
        external
        view
        returns (AgentClaimable[] memory);
}
