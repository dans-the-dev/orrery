// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOrryLens} from "./interfaces/IOrryClaims.sol";
import {IEarnVault} from "./interfaces/IEarnVault.sol";
import {IEarnVaultFactory} from "./interfaces/IEarnVaultFactory.sol";
import {IOrryStaking} from "./interfaces/IOrryStaking.sol";

interface IOwnerOf {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title OrryLens
/// @notice Read-only claim center view (`docs/ORRY-BUILD-SPEC.md` 3.7): what an address can claim or withdraw in
/// every Earn vault the factory lists and in staking, now or later. Stateless, no owner.
contract OrryLens is IOrryLens {
    address public immutable earnFactory;
    address public immutable staking;

    constructor(address earnFactory_, address staking_) {
        require(earnFactory_ != address(0) && staking_ != address(0), "zero address");
        earnFactory = earnFactory_;
        staking = staking_;
    }

    function claimables(address account) external view returns (Claimables memory) {
        Claimables memory c;
        address[] memory vaults = IEarnVaultFactory(earnFactory).vaults();
        c.earn = new EarnPosition[](vaults.length);
        for (uint256 i; i < vaults.length; ++i) {
            IEarnVault vault = IEarnVault(vaults[i]);
            EarnPosition memory e = c.earn[i];
            e.vault = vaults[i];
            e.quote = vault.quote();
            e.shares = vault.sharesOf(account);
            e.unlockAt = vault.unlockAt(account);
            (e.feesQuote, e.feesOrry) = vault.pendingFees(account);
            (e.positionQuote, e.positionOrry) = vault.previewWithdraw(e.shares);
        }
        IOrryStaking stake = IOrryStaking(staking);
        (c.stakeActive, c.stakeLeaving, c.stakeReadyAt) = stake.plainStake(account);
        (c.stakeRewardsEth, c.stakeRewardsOrry) = stake.pendingRewards(account);
        return c;
    }

    /// @notice Positions among the supplied (agentId, owner) pairs whose staker is `staker`; other pairs are left out.
    function agentClaimables(address staker, uint256[] calldata agentIds, address[] calldata owners)
        external
        view
        returns (AgentClaimable[] memory)
    {
        require(agentIds.length == owners.length, "length");
        IOrryStaking stake = IOrryStaking(staking);
        address registry = stake.identityRegistry();
        AgentClaimable[] memory list = new AgentClaimable[](agentIds.length);
        uint256 n;
        for (uint256 i; i < agentIds.length; ++i) {
            IOrryStaking.AgentPosition memory p = stake.agentStakeOf(agentIds[i], owners[i]);
            if (p.staker != staker || staker == address(0)) continue;
            list[n++] = AgentClaimable({
                agentId: agentIds[i],
                owner: owners[i],
                active: p.active,
                leaving: p.leaving,
                leavingAt: p.leavingAt,
                reportedForAgent: owners[i] != address(0) && _currentOwner(registry, agentIds[i]) == owners[i]
            });
        }
        assembly ("memory-safe") {
            mstore(list, n)
        }
        return list;
    }

    /// @dev A burned or unknown identity reverts in `ownerOf`; it reads as no owner.
    function _currentOwner(address registry, uint256 agentId) private view returns (address) {
        try IOwnerOf(registry).ownerOf(agentId) returns (address o) {
            return o;
        } catch {
            return address(0);
        }
    }
}
