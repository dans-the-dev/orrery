// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IEarnVaultFactory} from "./interfaces/IEarnVaultFactory.sol";
import {EarnVault} from "./EarnVault.sol";

/// @title EarnVaultFactory
/// @notice Deploys the one Earn vault of each registered hub (`docs/ORRY-BUILD-SPEC.md` 3.2, R-35, P-6). Anyone may
/// call `createVault(quote)` once the hook lists the pair; CREATE2 with the quote as salt fixes the address in advance,
/// whoever calls. At most one vault per quote, so at most the hook's MAX_PAIRS vaults. No owner, nothing to change.
contract EarnVaultFactory is IEarnVaultFactory {
    address public immutable hook;

    address[] private _vaults;
    mapping(address quote => address) private _vaultOf;

    constructor(address hook_) {
        require(hook_ != address(0), "zero address");
        hook = hook_;
    }

    /// @dev An unregistered quote reverts `UnknownPair` from the vault's constructor (`IOrreryHook.pairOf`), bubbled
    /// up by `new`; the selector is the same as this interface's.
    function createVault(address quote) external returns (address vault) {
        if (_vaultOf[quote] != address(0)) revert VaultExists();
        vault = address(new EarnVault{salt: _salt(quote)}(hook, quote));
        _vaultOf[quote] = vault;
        _vaults.push(vault);
        emit VaultCreated(quote, vault);
    }

    function vaultOf(address quote) external view returns (address) {
        return _vaultOf[quote];
    }

    function predictVault(address quote) external view returns (address) {
        bytes32 initHash = keccak256(abi.encodePacked(type(EarnVault).creationCode, abi.encode(hook, quote)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(quote), initHash)))));
    }

    function vaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    function vaultAt(uint256 index) external view returns (address) {
        return _vaults[index];
    }

    function vaults() external view returns (address[] memory) {
        return _vaults;
    }

    function _salt(address quote) private pure returns (bytes32) {
        return bytes32(uint256(uint160(quote)));
    }
}
