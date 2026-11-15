// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";

/// @notice Fixed-rate ORRY price: `orryPerUsd` ORRY base units per 1 USDG base unit. `ready` is only a flag: the
/// conversions keep answering while it is false (so callers' own ready checks are what is tested); `reverts` breaks them.
contract MockOrryPrice {
    bool public ready = true;
    bool public reverts;
    uint256 public orryPerUsd = 100e12; // 100 ORRY per USD

    function set(uint256 perUsd) external {
        orryPerUsd = perUsd;
    }

    function setReady(bool r) external {
        ready = r;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function orryFor(uint256 usd) external view returns (uint256) {
        require(!reverts, "price down");
        return usd * orryPerUsd;
    }

    function usdValue(uint256 orryAmount) external view returns (uint256) {
        require(!reverts, "price down");
        return orryAmount / orryPerUsd;
    }
}

/// @notice `burn` takes the tokens but leaves half in the supply (moved to a sink): InexactTransfer.
contract ShortBurnOrry is MockOrry {
    constructor(address holder, uint256 supply) MockOrry(holder, supply) {}

    function _burn(address from, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[address(0xdead)] += amount / 2;
        totalSupply -= amount - amount / 2;
    }
}

/// @notice Plain 6-decimal token for multi-asset pool tests.
contract MockToken {
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockIdentity {
    mapping(uint256 => address) public ownerOf;

    function set(uint256 id, address owner) external {
        ownerOf[id] = owner;
    }

    function getAgentWallet(uint256) external pure returns (address) {
        return address(0);
    }
}

contract MockAttestor {
    mapping(uint256 => bool) public isVerified;

    function set(uint256 id, bool v) external {
        isVerified[id] = v;
    }
}

contract AlwaysVerifier {
    bool public answer = true;

    function set(bool a) external {
        answer = a;
    }

    function isComplete(address, bytes calldata) external view returns (bool) {
        return answer;
    }
}

/// @notice ERC-1271 account: accepts a signature by its owner key over the digest.
contract Mock1271 {
    address public immutable signer;

    constructor(address s) {
        signer = s;
    }

    function isValidSignature(bytes32 digest, bytes calldata sig) external view returns (bytes4) {
        (bytes32 r, bytes32 s) = abi.decode(sig[:64], (bytes32, bytes32));
        uint8 v = uint8(sig[64]);
        return ecrecover(digest, v, r, s) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
