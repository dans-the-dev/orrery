// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title DevStockToken
/// @notice Development stand-in for a Robinhood stock token on networks that have none (46630): 18 decimals, an
///         owner-only mint, and the issuer views the markets read (no oracle pause, no scheduled multiplier change).
///         Not for production.
contract DevStockToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    address public immutable owner;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public constant oraclePaused = false;
    uint256 public constant effectiveAt = 0;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error NotOwner();

    constructor(string memory name_, string memory symbol_, address owner_) {
        name = name_;
        symbol = symbol_;
        owner = owner_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
