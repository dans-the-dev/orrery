// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OrryPriced} from "./OrryPriced.sol";
import {RewardPool} from "./RewardPool.sol";

/// @title OrryNames
/// @notice On-chain usernames (`docs/ORRY-CHAT-PLAN.md` 1, `docs/updates/L1-COMMUNITY-SPEC.md` L1-7): one name per
/// address, unique, `[a-z0-9_]` and `MIN_LENGTH` to `MAX_LENGTH` bytes, paid `nameFeeUsd` in ORRY at the hub mean price,
/// all of it to the Reward Pool. Setting a new name frees the old one, for the same fee. No transfer, no expiry, no owner.
contract OrryNames is OrryPriced {
    event NameSet(address indexed account, string name, bytes32 indexed key, uint256 fee);
    event NameReleased(address indexed account, bytes32 indexed key);

    error BadName();
    error NameTaken();
    error SameName();

    uint256 public constant MIN_LENGTH = 3;
    uint256 public constant MAX_LENGTH = 20;

    RewardPool public immutable pool;
    uint256 public immutable nameFeeUsd;

    mapping(address account => string) private _names;
    mapping(bytes32 key => address) public ownerOfKey;

    constructor(address orry_, address orryPrice_, address pool_, uint256 nameFeeUsd_)
        OrryPriced(orry_, orryPrice_)
    {
        if (pool_ == address(0)) revert ZeroAddress();
        require(RewardPool(payable(pool_)).orry() == orry_, "pool orry");
        require(nameFeeUsd_ != 0, "zero fee");
        pool = RewardPool(payable(pool_));
        nameFeeUsd = nameFeeUsd_;
    }

    function nameOf(address account) external view returns (string memory) {
        return _names[account];
    }

    function ownerOf(string calldata name) external view returns (address) {
        return ownerOfKey[keccak256(bytes(name))];
    }

    function isValid(string calldata name) public pure returns (bool) {
        bytes memory b = bytes(name);
        if (b.length < MIN_LENGTH || b.length > MAX_LENGTH) return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f;
            if (!ok) return false;
        }
        return true;
    }

    function setName(string calldata name, uint256 maxFee) external returns (uint256 fee) {
        if (!isValid(name)) revert BadName();
        bytes32 key = keccak256(bytes(name));
        address holder = ownerOfKey[key];
        if (holder == msg.sender) revert SameName();
        if (holder != address(0)) revert NameTaken();
        fee = _quote(nameFeeUsd, maxFee);
        _pull(msg.sender, address(pool), fee);
        pool.sync(address(orry));
        bytes memory old = bytes(_names[msg.sender]);
        if (old.length != 0) {
            bytes32 oldKey = keccak256(old);
            delete ownerOfKey[oldKey];
            emit NameReleased(msg.sender, oldKey);
        }
        ownerOfKey[key] = msg.sender;
        _names[msg.sender] = name;
        emit NameSet(msg.sender, name, key, fee);
    }
}
