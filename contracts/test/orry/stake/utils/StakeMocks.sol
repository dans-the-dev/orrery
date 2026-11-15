// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice ORRY stand-in shaped like a Pons V2 token: the whole supply is minted once in the constructor, 18 decimals,
/// `burn` and `burnFrom`, no mint afterwards, no owner (G-2).
contract MockOrry {
    string public constant name = "Orrery";
    string public constant symbol = "ORRY";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address holder, uint256 supply) {
        totalSupply = supply;
        balanceOf[holder] = supply;
        emit Transfer(address(0), holder, supply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        _spend(from, amount);
        _move(from, to, amount);
        return true;
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function burnFrom(address account, uint256 amount) external virtual {
        _spend(account, amount);
        _burn(account, amount);
    }

    function _spend(address from, uint256 amount) internal {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
    }

    function _move(address from, address to, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _burn(address from, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }
}

/// @notice Keeps 1% of every transfer (a token with a transfer fee must be refused).
contract FeeOrry is MockOrry {
    constructor(address holder, uint256 supply) MockOrry(holder, supply) {}

    function _move(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        uint256 cut = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - cut;
        totalSupply -= cut;
    }
}

/// @notice `burnFrom` takes the tokens but only half leaves the supply (moved to a sink instead): InexactBurn.
contract HalfBurnOrry is MockOrry {
    constructor(address holder, uint256 supply) MockOrry(holder, supply) {}

    function burnFrom(address account, uint256 amount) external override {
        _spend(account, amount);
        _burn(account, amount - amount / 2);
        _move(account, address(0xdead), amount / 2);
    }
}

/// @notice Refuses ETH.
contract RejectEth {
    receive() external payable {
        revert("no eth");
    }

    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "call failed");
        return ret;
    }
}

/// @notice Re-enters a target when it receives ETH and records whether the inner call succeeded.
contract ReenterOnEth {
    address public target;
    bytes public data;
    bool public innerOk;
    bool public tried;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    function call(address t, bytes calldata d) external returns (bytes memory) {
        (bool ok, bytes memory ret) = t.call(d);
        require(ok, "call failed");
        return ret;
    }

    receive() external payable {
        if (tried || target == address(0)) return;
        tried = true;
        (innerOk,) = target.call(data);
    }
}
