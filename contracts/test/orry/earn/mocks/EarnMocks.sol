// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IOrryStaking} from "../../../../src/orry/interfaces/IOrryStaking.sol";
import {IEarnVault} from "../../../../src/orry/interfaces/IEarnVault.sol";
import {IOrreryHook} from "../../../../src/orry/interfaces/IOrreryHook.sol";

/// @dev Same shape as a Pons V2 launch token: fixed 1e27 supply minted once, 18 decimals, burn and burnFrom.
contract MockOrry is ERC20, ERC20Burnable {
    constructor() ERC20("Orrery", "ORRY") {
        _mint(msg.sender, 1e27);
    }
}

/// @dev USDG stand-in: 6 decimals, open mint for tests.
contract MockUsdg is ERC20 {
    constructor() ERC20("Global Dollar", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A further quote token with any decimals, open mint for tests.
contract MockToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory symbol_, uint8 decimals_) ERC20(symbol_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Chainlink AggregatorV3 stand-in: answer and update time are set by the test; `broken` makes it revert.
contract MockFeed {
    int256 public answer;
    uint256 public updatedAt;
    bool public broken;

    constructor(int256 answer_) {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @dev OrreryTreasury stand-in for the pair admin: only `owner()`.
contract MockTreasury {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function setOwner(address o) external {
        owner = o;
    }
}

/// @dev Stands in for OrryRewardsRouter: accepts ETH and ERC-20s, does nothing else.
contract MockRouter {
    receive() external payable {}
}

/// @dev A router whose receive tries to re-enter the hook's collect and records whether that worked.
contract ReentrantRouter {
    IOrreryHook public hook;
    bool public tried;
    bool public innerSucceeded;

    function setHook(IOrreryHook h) external {
        hook = h;
    }

    receive() external payable {
        if (address(hook) == address(0) || tried) return;
        tried = true;
        try hook.collect() {
            innerSucceeded = true;
        } catch {}
    }
}

/// @dev Minimal ERC-721 owner lookup; unknown ids revert like a burned token.
contract MockRegistry {
    mapping(uint256 => address) public owners;

    function setOwner(uint256 id, address o) external {
        owners[id] = o;
    }

    function ownerOf(uint256 id) external view returns (address o) {
        o = owners[id];
        require(o != address(0), "no token");
    }
}

/// @dev Stands in for OrryStaking (lane B) with the functions ClaimAll and OrryLens use. `claimFor` pays real ETH
/// and ORRY that the test loaded, to `account` only.
contract MockStaking {
    IERC20 public immutable orryToken;
    address public immutable identityRegistry;

    mapping(address => uint256) public owedEth;
    mapping(address => uint256) public owedOrry;
    mapping(address => uint256[3]) internal _plain; // active, leaving, readyAt
    mapping(uint256 => mapping(address => IOrryStaking.AgentPosition)) internal _agent;

    event RewardsClaimed(address indexed account, address indexed caller, uint256 ethAmount, uint256 orryAmount);

    constructor(IERC20 orry_, address registry_) {
        orryToken = orry_;
        identityRegistry = registry_;
    }

    function orry() external view returns (address) {
        return address(orryToken);
    }

    receive() external payable {}

    function setOwed(address account, uint256 eth, uint256 orry) external {
        owedEth[account] = eth;
        owedOrry[account] = orry;
    }

    function setPlain(address account, uint256 active, uint256 leaving, uint64 readyAt) external {
        _plain[account] = [active, leaving, uint256(readyAt)];
    }

    function setAgent(uint256 agentId, address owner, IOrryStaking.AgentPosition calldata p) external {
        _agent[agentId][owner] = p;
    }

    function claimFor(address account) external returns (uint256 ethAmount, uint256 orryAmount) {
        ethAmount = owedEth[account];
        orryAmount = owedOrry[account];
        owedEth[account] = 0;
        owedOrry[account] = 0;
        if (orryAmount != 0) orryToken.transfer(account, orryAmount);
        if (ethAmount != 0) {
            (bool ok,) = account.call{value: ethAmount}("");
            require(ok);
        }
        emit RewardsClaimed(account, msg.sender, ethAmount, orryAmount);
    }

    function plainStake(address account) external view returns (uint256 active, uint256 leaving, uint64 readyAt) {
        uint256[3] memory p = _plain[account];
        return (p[0], p[1], uint64(p[2]));
    }

    function pendingRewards(address account) external view returns (uint256, uint256) {
        return (owedEth[account], owedOrry[account]);
    }

    function agentStakeOf(uint256 agentId, address owner) external view returns (IOrryStaking.AgentPosition memory) {
        return _agent[agentId][owner];
    }
}

/// @dev Wallet contract that refuses ETH while `refuse` is set.
contract EthRefuser {
    bool public refuse;

    function setRefuse(bool r) external {
        refuse = r;
    }

    function approve(IERC20 t, address spender) external {
        t.approve(spender, type(uint256).max);
    }

    function deposit(IEarnVault v, uint256 orryMax) external payable returns (uint256) {
        return v.deposit{value: msg.value}(msg.value, orryMax, 0, 0, type(uint160).max, block.timestamp);
    }

    function claim(IEarnVault v) external returns (uint256, uint256) {
        return v.claimFees();
    }

    receive() external payable {
        require(!refuse, "refused");
    }
}

/// @dev Wallet contract whose receive tries to re-enter the vault and records the outcome.
contract ReentrantDepositor {
    IEarnVault public vault;
    bool public armed;
    bool public tried;
    bool public innerSucceeded;

    constructor(IEarnVault v) {
        vault = v;
    }

    function approve(IERC20 t) external {
        t.approve(address(vault), type(uint256).max);
    }

    function arm() external {
        armed = true;
    }

    function deposit(uint256 orryMax) external payable returns (uint256) {
        return vault.deposit{value: msg.value}(msg.value, orryMax, 0, 0, type(uint160).max, block.timestamp);
    }

    function claim() external returns (uint256, uint256) {
        return vault.claimFees();
    }

    receive() external payable {
        if (!armed || tried) return;
        tried = true;
        try vault.harvest() {
            innerSucceeded = true;
        } catch {}
    }
}

/// @dev Trades, adds liquidity and donates directly on the PoolManager; settles every delta from its own balance.
contract HubActor is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable pm;

    enum Kind {
        SWAP,
        MODIFY,
        DONATE
    }

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    function approve(IERC20 t, address spender) external {
        t.approve(spender, type(uint256).max);
    }

    function swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified) external returns (BalanceDelta) {
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        return swapTo(key, zeroForOne, amountSpecified, limit);
    }

    function swapTo(PoolKey memory key, bool zeroForOne, int256 amountSpecified, uint160 limit)
        public
        returns (BalanceDelta)
    {
        bytes memory r = pm.unlock(abi.encode(Kind.SWAP, key, abi.encode(zeroForOne, amountSpecified, limit)));
        return abi.decode(r, (BalanceDelta));
    }

    function modify(PoolKey memory key, int24 lower, int24 upper, int256 liquidity, bytes32 salt)
        external
        returns (BalanceDelta)
    {
        bytes memory r = pm.unlock(abi.encode(Kind.MODIFY, key, abi.encode(lower, upper, liquidity, salt)));
        return abi.decode(r, (BalanceDelta));
    }

    function donate(PoolKey memory key, uint256 amount0, uint256 amount1) external {
        pm.unlock(abi.encode(Kind.DONATE, key, abi.encode(amount0, amount1)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (Kind kind, PoolKey memory key, bytes memory args) = abi.decode(data, (Kind, PoolKey, bytes));
        BalanceDelta d;
        if (kind == Kind.SWAP) {
            (bool zeroForOne, int256 amountSpecified, uint160 limit) = abi.decode(args, (bool, int256, uint160));
            d = pm.swap(key, SwapParams(zeroForOne, amountSpecified, limit), "");
        } else if (kind == Kind.MODIFY) {
            (int24 lower, int24 upper, int256 liquidity, bytes32 salt) =
                abi.decode(args, (int24, int24, int256, bytes32));
            (d,) = pm.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, liquidity, salt), "");
        } else {
            (uint256 a0, uint256 a1) = abi.decode(args, (uint256, uint256));
            d = pm.donate(key, a0, a1, "");
        }
        _settle(key.currency0);
        _settle(key.currency1);
        return abi.encode(d);
    }

    function _settle(Currency c) private {
        int256 d = pm.currencyDelta(address(this), c);
        if (d > 0) {
            pm.take(c, address(this), uint256(d));
        } else if (d < 0) {
            if (Currency.unwrap(c) == address(0)) {
                pm.settle{value: uint256(-d)}();
            } else {
                pm.sync(c);
                IERC20(Currency.unwrap(c)).transfer(address(pm), uint256(-d));
                pm.settle();
            }
        }
    }
}

/// @dev Calls the vault's unlockCallback from inside its own unlock, posing as the PoolManager's callback, with a
/// WITHDRAW op that would pull the vault's liquidity without burning any share.
contract CallbackAttacker is IUnlockCallback {
    IPoolManager public immutable pm;
    address public immutable vault;

    constructor(IPoolManager pm_, address vault_) {
        pm = pm_;
        vault = vault_;
    }

    function attack(uint256 liquidity) external {
        pm.unlock(abi.encode(liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        uint256 liquidity = abi.decode(data, (uint256));
        // Op(action = WITHDRAW, in0, in1, liquidity, swapIn, zeroForOne, minSwapOut)
        IUnlockCallback(vault).unlockCallback(abi.encode(uint8(2), uint256(0), uint256(0), liquidity, uint256(0), false, uint256(0)));
        return "";
    }
}
