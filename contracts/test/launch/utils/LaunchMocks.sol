// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";

/// @notice `OrreryAttestor.isVerified` stand-in.
contract MockAttestorL5 {
    mapping(uint256 => bool) public isVerified;

    function setVerified(uint256 agentId, bool v) external {
        isVerified[agentId] = v;
    }
}

/// @notice `OrreryPolicyModule.isInstalledOn` stand-in.
contract MockPolicyModuleL5 {
    mapping(address => bool) public isInstalledOn;

    function setInstalled(address account, bool v) external {
        isInstalledOn[account] = v;
    }
}

/// @notice `OrreryTreasury.owner` stand-in.
contract MockTreasuryL5 {
    address public owner;

    constructor(address o) {
        owner = o;
    }

    function setOwner(address o) external {
        owner = o;
    }
}

interface IPullable {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice `IEarnVault.notifyRewards` stand-in: pulls the ORRY (balance-delta) and records every notification.
contract MockEarnVaultL5 {
    address public immutable orry;
    uint256 public notified;
    uint256 public calls;
    bool public reverts;

    constructor(address orry_) {
        orry = orry_;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function notifyRewards(uint256 amount) external {
        require(!reverts, "vault down");
        uint256 before = IPullable(orry).balanceOf(address(this));
        IPullable(orry).transferFrom(msg.sender, address(this), amount);
        uint256 got = IPullable(orry).balanceOf(address(this)) - before;
        require(got > 0, "ZeroAmount");
        notified += got;
        calls++;
    }
}

/// @notice An address that cannot hold anything useful: used as an unbound agent wallet.
contract NoCodeHolderL5 {}

/// @notice A squatter's liquidity helper: adds a position whose only owed currency is currency0 (ORRY), so it works on a
/// pool whose currency1 has no code yet (a coin that is not launched). v4's own test router reads both currencies.
contract HostileLpL5 is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function add(PoolKey memory key, ModifyLiquidityParams memory p) external {
        pm.unlock(abi.encode(key, p, msg.sender));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm only");
        (PoolKey memory key, ModifyLiquidityParams memory p, address payer) =
            abi.decode(data, (PoolKey, ModifyLiquidityParams, address));
        (BalanceDelta d,) = pm.modifyLiquidity(key, p, "");
        require(d.amount1() == 0, "currency0 only");
        uint256 owed = uint256(-int256(d.amount0()));
        pm.sync(key.currency0);
        IPullable(Currency.unwrap(key.currency0)).transferFrom(payer, address(pm), owed);
        pm.settle();
        return "";
    }
}
