// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC7579Module} from "../interfaces/IExternal.sol";

/// @title DevAccount7579
/// @notice Minimal ERC-7579-style account for development-network rehearsals where the Safe7579 adapter is not deployed
///         (46630, measured 2026-11-07). One owner EOA; ERC-1271 signatures by that owner (so the real ERC-8004
///         registry accepts it as `agentWallet`); executor modules call `executeFromExecutor` in single-call mode.
///         Not for production: production accounts are Safes with the Safe7579 adapter.
contract DevAccount7579 {
    address public immutable owner;
    mapping(uint256 => mapping(address => bool)) public installed;

    error NotOwner();
    error NotExecutor();
    error UnsupportedMode();

    constructor(address owner_) {
        owner = owner_;
    }

    receive() external payable {}

    modifier onlyOwnerOrSelf() {
        if (msg.sender != owner && msg.sender != address(this)) revert NotOwner();
        _;
    }

    function installModule(uint256 typeId, address module, bytes calldata data) external onlyOwnerOrSelf {
        installed[typeId][module] = true;
        IERC7579Module(module).onInstall(data);
    }

    function uninstallModule(uint256 typeId, address module, bytes calldata data) external onlyOwnerOrSelf {
        installed[typeId][module] = false;
        IERC7579Module(module).onUninstall(data);
    }

    function isModuleInstalled(uint256 typeId, address module, bytes calldata) external view returns (bool) {
        return installed[typeId][module];
    }

    function execute(address target, uint256 value, bytes calldata data) external onlyOwnerOrSelf returns (bytes memory) {
        return _call(target, value, data);
    }

    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory returnData)
    {
        if (!installed[2][msg.sender]) revert NotExecutor();
        if (mode != bytes32(0)) revert UnsupportedMode();
        address target = address(bytes20(executionCalldata[0:20]));
        uint256 value = uint256(bytes32(executionCalldata[20:52]));
        returnData = new bytes[](1);
        returnData[0] = _call(target, value, executionCalldata[52:]);
    }

    /// @notice ERC-1271: valid when the owner signed `hash` directly (65-byte ECDSA, low s).
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) return 0xffffffff;
        return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function _call(address target, uint256 value, bytes memory data) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
