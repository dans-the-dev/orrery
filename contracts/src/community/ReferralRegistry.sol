// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title ReferralRegistry
/// @notice Referee to referrer links (utility 8, `docs/ORRY-UTILITIES-PLAN.md` 3, RF-1, `docs/updates/L1-COMMUNITY-SPEC.md`
/// L1-11). A link is set once, by the referee itself (`link`) or by the referee's EIP-712 signature relayed by anyone
/// (`linkWithSig`; ERC-1271 for contract accounts such as Safes), and never changes. No self link. No owner.
contract ReferralRegistry is EIP712 {
    event Linked(address indexed referee, address indexed referrer, uint64 linkedAt);

    error ZeroAddress();
    error SelfReferral();
    error AlreadyLinked();
    error Expired();
    error BadSignature();

    bytes32 public constant LINK_TYPEHASH = keccak256("Link(address referee,address referrer,uint256 deadline)");

    mapping(address referee => address) public referrerOf;
    mapping(address referee => uint64) public linkedAt;

    constructor() EIP712("Orrery Referrals", "1") {}

    function link(address referrer) external {
        _link(msg.sender, referrer);
    }

    function linkWithSig(address referee, address referrer, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(LINK_TYPEHASH, referee, referrer, deadline)));
        if (!SignatureChecker.isValidSignatureNow(referee, digest, signature)) revert BadSignature();
        _link(referee, referrer);
    }

    function digestOf(address referee, address referrer, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(LINK_TYPEHASH, referee, referrer, deadline)));
    }

    function _link(address referee, address referrer) private {
        if (referee == address(0) || referrer == address(0)) revert ZeroAddress();
        if (referee == referrer) revert SelfReferral();
        if (referrerOf[referee] != address(0)) revert AlreadyLinked();
        referrerOf[referee] = referrer;
        linkedAt[referee] = uint64(block.timestamp);
        emit Linked(referee, referrer, uint64(block.timestamp));
    }
}
