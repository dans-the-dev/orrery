// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Creates the one Earn vault of each registered hub (`docs/ORRY-BUILD-SPEC.md` 3.2, R-35, P-6). Anyone may call
/// `createVault(quote)` once the hook lists the pair; the vault is deployed with CREATE2 (salt = the quote), so its
/// address is fixed in advance and the same whoever calls. At most one vault per quote, so at most the hook's
/// MAX_PAIRS vaults. No owner, nothing can be changed or removed.
interface IEarnVaultFactory {
    event VaultCreated(address indexed quote, address indexed vault);

    error UnknownPair();
    error VaultExists();

    function hook() external view returns (address);

    /// @notice Anyone: deploys the vault of the `quote` hub. Reverts UnknownPair unless `hook().isPair(quote)`, and
    /// VaultExists for a second call.
    function createVault(address quote) external returns (address vault);

    /// @notice The vault of `quote`, address 0 when not created.
    function vaultOf(address quote) external view returns (address);
    /// @notice The CREATE2 address `createVault(quote)` deploys to.
    function predictVault(address quote) external view returns (address);
    function vaultCount() external view returns (uint256);
    /// @notice Vaults in creation order (index below vaultCount()).
    function vaultAt(uint256 index) external view returns (address);
    /// @notice Every vault in creation order (at most the hook's MAX_PAIRS).
    function vaults() external view returns (address[] memory);
}
