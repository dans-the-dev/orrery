// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC6909Claims} from "v4-core/src/interfaces/external/IERC6909Claims.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {IIdentityRegistry} from "../interfaces/IExternal.sol";
import {IOrryStaking} from "../orry/interfaces/IOrryStaking.sol";
import {IEarnVault} from "../orry/interfaces/IEarnVault.sol";
import {IOrryToken, IOrryBurnEvents} from "../orry/interfaces/IOrryToken.sol";
import {IOrryPriceOracle} from "../markets/interfaces/IMarketPricing.sol";
import {IAgentLaunch} from "./interfaces/IAgentLaunch.sol";
import {ISpokeHook} from "./interfaces/ISpokeHook.sol";
import {AgentCoin} from "./AgentCoin.sol";

/// @dev The read `AgentLaunch` needs from `OrreryAttestor` (paid verification, owner unchanged since).
interface IAttestorVerified {
    function isVerified(uint256 agentId) external view returns (bool);
}

/// @dev The read `AgentLaunch` needs from `OrreryPolicyModule` (the account answers "installed" for the module).
interface IPolicyModuleInstalled {
    function isInstalledOn(address account) external view returns (bool);
}

/// @dev The read `AgentLaunch` needs from `OrreryTreasury`: its owner receives the owner share (T6).
interface ITreasuryOwner {
    function owner() external view returns (address);
}

/// @notice Agent Launch (`docs/updates/L5-LAUNCH-SPEC.md` 4). The single-sided launch position, the first buy inside the
/// launch's unlock and the CREATE2 coin follow the owner's Hashborn launchpad (`hashborn-npm/contracts/src/
/// HashbornLaunchpadV4.sol`, MIT, D-58 and D-59), rebuilt for ORRY as the pair asset, ERC-8004 agents as the only
/// launchers, a stake-weighted early window and the T6 fee split.
/// @dev ORRY is currency0 of every spoke (L5-2), so the coin is currency1, a buy is zeroForOne, and the position
/// `[MIN_TICK, START_TICK]` holds only the coin at the opening price. The only liquidity change this contract ever makes is
/// the launch's deposit: no code path removes it.
contract AgentLaunch is IAgentLaunch, IUnlockCallback, IOrryBurnEvents {
    using PoolIdLibrary for PoolKey;

    uint256 public constant SUPPLY = 1_000_000_000e18;
    uint64 public constant LOCK_PERIOD = 90 days;
    uint16 public constant CREATOR_BPS = 5000;
    uint16 public constant EARN_BPS = 2000;
    uint16 public constant OWNER_BPS = 1500;
    uint64 public constant EARN_INTERVAL = 1 hours;
    uint8 public constant BURN_SOURCE = 50;
    int24 public constant TICK_SPACING = 200;
    /// @notice Lowest usable tick at spacing 200: the bottom of every launch position.
    int24 public constant MIN_TICK = -887_200;
    uint16 internal constant MAX_FIRST_BUY_BPS = 2000;
    uint16 internal constant MAX_EARLY_BPS = 500;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_NAME_BYTES = 32;
    uint256 internal constant MAX_SYMBOL_BYTES = 10;

    enum Action {
        Launch,
        Buy,
        Redeem
    }

    address public immutable poolManager;
    address public immutable orry;
    address public immutable hook;
    address public immutable identityRegistry;
    address public immutable attestor;
    address public immutable policyModule;
    address public immutable staking;
    address public immutable orryPrice;
    address public immutable earnVault;
    address public immutable treasury;

    int24 public immutable START_TICK;
    uint160 public immutable SQRT_PRICE_START;
    uint160 public immutable SQRT_PRICE_MIN;
    uint128 public immutable launchLiquidity;
    uint16 public immutable maxFirstBuyBps;
    uint128 public immutable minStakeUsd;
    uint16 public immutable earlyMaxBps;
    uint128 public immutable earlyFullUsd;
    uint128 public immutable earlyMinUsd;

    mapping(address coin => Launch) internal _launches;
    mapping(uint256 agentId => address) internal _coinOfAgent;
    address[] internal _coins;
    mapping(address coin => uint256) internal _distributed;
    mapping(address coin => uint256) internal _creatorOwed;
    mapping(address coin => mapping(address account => uint256)) internal _earlyBought;
    uint256 public earnPending;
    uint64 public lastEarnAt;
    uint256 private _lock = 1;

    constructor(
        address poolManager_,
        address orry_,
        address hook_,
        address identityRegistry_,
        address attestor_,
        address policyModule_,
        address staking_,
        address orryPrice_,
        address earnVault_,
        address treasury_,
        Params memory p
    ) {
        if (
            poolManager_ == address(0) || orry_ == address(0) || hook_ == address(0) || identityRegistry_ == address(0)
                || attestor_ == address(0) || policyModule_ == address(0) || staking_ == address(0)
                || orryPrice_ == address(0) || earnVault_ == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        if (
            ISpokeHook(hook_).launch() != address(this) || ISpokeHook(hook_).orry() != orry_
                || ISpokeHook(hook_).poolManager() != poolManager_ || IEarnVault(earnVault_).orry() != orry_
                || IOrryStaking(staking_).orry() != orry_
        ) revert BadParameters();
        if (
            p.startTick % TICK_SPACING != 0 || p.startTick <= MIN_TICK || p.startTick >= -MIN_TICK
                || p.maxFirstBuyBps == 0 || p.maxFirstBuyBps > MAX_FIRST_BUY_BPS || p.earlyMaxBps == 0
                || p.earlyMaxBps > MAX_EARLY_BPS || p.earlyFullUsd == 0 || p.earlyMinUsd > p.earlyFullUsd
        ) revert BadParameters();
        poolManager = poolManager_;
        orry = orry_;
        hook = hook_;
        identityRegistry = identityRegistry_;
        attestor = attestor_;
        policyModule = policyModule_;
        staking = staking_;
        orryPrice = orryPrice_;
        earnVault = earnVault_;
        treasury = treasury_;
        START_TICK = p.startTick;
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(p.startTick);
        uint160 sqrtMin = TickMath.getSqrtPriceAtTick(MIN_TICK);
        SQRT_PRICE_START = sqrtStart;
        SQRT_PRICE_MIN = sqrtMin;
        // LiquidityAmounts.getLiquidityForAmount1 over [MIN_TICK, startTick], rounded down
        uint256 liq = FullMath.mulDiv(SUPPLY, 1 << 96, sqrtStart - sqrtMin);
        if (liq == 0 || liq > type(uint128).max) revert BadParameters();
        launchLiquidity = uint128(liq);
        maxFirstBuyBps = p.maxFirstBuyBps;
        minStakeUsd = p.minStakeUsd;
        earlyMaxBps = p.earlyMaxBps;
        earlyFullUsd = p.earlyFullUsd;
        earlyMinUsd = p.earlyMinUsd;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------------------------------------------------------- launch

    function launch(
        uint256 agentId,
        string calldata name,
        string calldata symbol,
        bytes32 salt,
        uint256 orryIn,
        uint256 minCoinOut
    ) external nonReentrant returns (address coin) {
        _requireGate(agentId, msg.sender);
        _checkText(name, MAX_NAME_BYTES);
        _checkText(symbol, MAX_SYMBOL_BYTES);

        coin = address(new AgentCoin{salt: _coinSalt(msg.sender, salt)}(name, symbol, SUPPLY, address(this)));
        if (uint160(coin) <= uint160(orry)) revert CoinSortsBelowOrry();
        PoolKey memory key = _key(coin);
        IPoolManager(poolManager).initialize(key, SQRT_PRICE_START);
        if (orryIn > 0) _pullOrry(msg.sender, orryIn);
        (uint256 pooled, uint256 bought) = abi.decode(
            IPoolManager(poolManager).unlock(abi.encode(Action.Launch, coin, orryIn, address(0))), (uint256, uint256)
        );
        uint256 cap = SUPPLY * maxFirstBuyBps / BPS;
        if (bought > cap) revert FirstBuyTooLarge(bought, cap);
        if (bought < minCoinOut) revert SlippageExceeded(bought, minCoinOut);

        PoolId poolId = key.toId();
        _launches[coin] = Launch({
            agentId: agentId,
            creator: msg.sender,
            poolId: poolId,
            liquidity: launchLiquidity,
            launchedAt: uint64(block.timestamp)
        });
        _coinOfAgent[agentId] = coin;
        _coins.push(coin);
        if (bought > 0) _transfer(coin, msg.sender, bought);
        emit Launched(
            coin,
            agentId,
            msg.sender,
            poolId,
            launchLiquidity,
            pooled,
            orryIn,
            bought,
            ISpokeHook(hook).publicOpenAt(poolId),
            name,
            symbol
        );
    }

    // ---------------------------------------------------------------- early access (utility 5)

    function buyEarly(address coin, uint256 orryIn, uint256 minCoinOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 coinsOut)
    {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (orryIn == 0) revert ZeroAmount();
        Launch storage l = _requireLaunch(coin);
        if (!ISpokeHook(hook).isEarly(l.poolId)) revert EarlyWindowClosed();
        (bool ok, uint256 usd) = _usd(IOrryStaking(staking).earningBalance(msg.sender));
        if (!ok) revert PriceNotReady();
        if (usd < earlyMinUsd) revert NotEarlyEligible(usd, earlyMinUsd);
        uint256 allowance = _allowanceFor(usd);

        _pullOrry(msg.sender, orryIn);
        coinsOut = abi.decode(
            IPoolManager(poolManager).unlock(abi.encode(Action.Buy, coin, orryIn, msg.sender)), (uint256)
        );
        if (coinsOut < minCoinOut) revert SlippageExceeded(coinsOut, minCoinOut);
        uint256 bought = _earlyBought[coin][msg.sender];
        if (bought + coinsOut > allowance) revert OverEarlyAllowance(allowance, bought, coinsOut);
        _earlyBought[coin][msg.sender] = bought + coinsOut;
        emit EarlyBuy(coin, msg.sender, orryIn, coinsOut);
    }

    // ---------------------------------------------------------------- fees

    function distribute(address coin) external nonReentrant returns (uint256 amount) {
        Launch storage l = _requireLaunch(coin);
        amount = _split(coin, l.poolId);
        _flushEarn();
    }

    function flushEarn() external nonReentrant returns (uint256 amount) {
        return _flushEarn();
    }

    function claimCreatorFees(address coin) external nonReentrant returns (uint256 amount) {
        Launch storage l = _requireLaunch(coin);
        _split(coin, l.poolId);
        _flushEarn();
        amount = _creatorOwed[coin];
        if (amount == 0) revert NothingToClaim();
        address wallet = _agentWallet(l.agentId);
        if (wallet == address(0) || !IPolicyModuleInstalled(policyModule).isInstalledOn(wallet)) {
            revert CreatorWalletNotBound(wallet);
        }
        _creatorOwed[coin] = 0;
        _transfer(orry, wallet, amount);
        emit CreatorFeesClaimed(coin, l.agentId, wallet, amount);
    }

    // ---------------------------------------------------------------- PoolManager callback

    /// @dev Only the PoolManager calls it, and only inside an `unlock` this contract started (v4 calls back the caller of
    /// `unlock`).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != poolManager) revert NotPoolManager();
        (Action action, address coin, uint256 amount, address recipient) =
            abi.decode(data, (Action, address, uint256, address));
        IPoolManager pm = IPoolManager(poolManager);
        if (action == Action.Redeem) {
            pm.burn(address(this), uint256(uint160(orry)), amount);
            pm.take(Currency.wrap(orry), address(this), amount);
            return "";
        }
        PoolKey memory key = _key(coin);
        if (action == Action.Buy) {
            uint256 out = _swapIn(pm, key, amount);
            pm.take(Currency.wrap(coin), recipient, out);
            return abi.encode(out);
        }
        // Launch: the position, then the first buy, settled in one unlock.
        (BalanceDelta added,) = pm.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: MIN_TICK,
                tickUpper: START_TICK,
                liquidityDelta: int256(uint256(launchLiquidity)),
                salt: 0
            }),
            ""
        );
        uint256 pooled = uint256(-int256(added.amount1()));
        uint256 bought = amount > 0 ? _swapIn(pm, key, amount) : 0;
        // the coin owed: what the position took, less what the first buy bought (kept here for the creator)
        pm.sync(Currency.wrap(coin));
        _transfer(coin, poolManager, pooled - bought);
        pm.settle();
        return abi.encode(pooled, bought);
    }

    // ---------------------------------------------------------------- views

    function params() external view returns (Params memory) {
        return Params(START_TICK, maxFirstBuyBps, minStakeUsd, earlyMaxBps, earlyFullUsd, earlyMinUsd);
    }

    function launchOf(address coin) external view returns (Launch memory) {
        return _launches[coin];
    }

    function coinOfAgent(uint256 agentId) external view returns (address) {
        return _coinOfAgent[agentId];
    }

    function launchCount() external view returns (uint256) {
        return _coins.length;
    }

    function coins(uint256 from, uint256 count) external view returns (address[] memory page) {
        uint256 n = _coins.length;
        if (from >= n) return new address[](0);
        uint256 end = count > n - from ? n : from + count;
        page = new address[](end - from);
        for (uint256 i = from; i < end; ++i) {
            page[i - from] = _coins[i];
        }
    }

    function poolKeyOf(address coin) external view returns (PoolKey memory) {
        return _key(coin);
    }

    function pendingFees(address coin) external view returns (uint256) {
        Launch storage l = _launches[coin];
        if (l.creator == address(0)) return 0;
        return ISpokeHook(hook).feesOf(l.poolId) - _distributed[coin];
    }

    function distributedOf(address coin) external view returns (uint256) {
        return _distributed[coin];
    }

    function creatorOwed(address coin) external view returns (uint256) {
        return _creatorOwed[coin];
    }

    function earlyBought(address coin, address account) external view returns (uint256) {
        return _earlyBought[coin][account];
    }

    function earlyAllowance(address coin, address account) external view returns (uint256) {
        Launch storage l = _launches[coin];
        if (l.creator == address(0) || !ISpokeHook(hook).isEarly(l.poolId)) return 0;
        (bool ok, uint256 usd) = _usd(IOrryStaking(staking).earningBalance(account));
        if (!ok || usd < earlyMinUsd) return 0;
        uint256 allowance = _allowanceFor(usd);
        uint256 bought = _earlyBought[coin][account];
        return bought >= allowance ? 0 : allowance - bought;
    }

    function canLaunch(uint256 agentId, address caller) external view returns (Gate gate) {
        (gate,,) = _gate(agentId, caller);
    }

    function predictCoin(address caller, bytes32 salt, string calldata name, string calldata symbol)
        external
        view
        returns (address)
    {
        bytes32 codeHash =
            keccak256(abi.encodePacked(type(AgentCoin).creationCode, abi.encode(name, symbol, SUPPLY, address(this))));
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _coinSalt(caller, salt), codeHash)))
            )
        );
    }

    // ---------------------------------------------------------------- internals

    /// @dev Launch gates in order (L5-7). Returns the first failing gate and two numbers for its error.
    function _gate(uint256 agentId, address caller) private view returns (Gate, uint256, uint256) {
        address agentOwner;
        try IIdentityRegistry(identityRegistry).ownerOf(agentId) returns (address o) {
            agentOwner = o;
        } catch {
            return (Gate.NotController, 0, 0);
        }
        address wallet = _agentWallet(agentId);
        if (caller != agentOwner && (wallet == address(0) || caller != wallet)) return (Gate.NotController, 0, 0);
        if (_coinOfAgent[agentId] != address(0)) return (Gate.AlreadyLaunched, 0, 0);
        if (!IAttestorVerified(attestor).isVerified(agentId)) return (Gate.NotVerified, 0, 0);
        if (wallet == address(0) || !IPolicyModuleInstalled(policyModule).isInstalledOn(wallet)) {
            return (Gate.WalletNotBound, 0, 0);
        }
        IOrryStaking.AgentPosition memory pos = IOrryStaking(staking).agentStake(agentId);
        (bool ok, uint256 usd) = _usd(pos.active);
        if (!ok) return (Gate.PriceNotReady, 0, 0);
        if (usd < minStakeUsd) return (Gate.StakeTooLow, usd, minStakeUsd);
        uint256 needed = block.timestamp + LOCK_PERIOD;
        if (pos.lockedUntil < needed) return (Gate.LockTooShort, pos.lockedUntil, needed);
        return (Gate.Ok, 0, 0);
    }

    function _requireGate(uint256 agentId, address caller) private view {
        (Gate g, uint256 a, uint256 b) = _gate(agentId, caller);
        if (g == Gate.Ok) return;
        if (g == Gate.NotController) revert NotController();
        if (g == Gate.AlreadyLaunched) revert AlreadyLaunched();
        if (g == Gate.NotVerified) revert NotVerified();
        if (g == Gate.WalletNotBound) revert WalletNotBound();
        if (g == Gate.PriceNotReady) revert PriceNotReady();
        if (g == Gate.StakeTooLow) revert StakeTooLow(a, b);
        revert LockTooShort(uint64(a), uint64(b));
    }

    function _requireLaunch(address coin) private view returns (Launch storage l) {
        l = _launches[coin];
        if (l.creator == address(0)) revert UnknownCoin();
    }

    /// @dev Redeems `coin`'s undistributed fees and splits them (L5-10). Creator and Earn shares accrue here; the owner
    /// share is paid to the treasury's owner now (burned when the treasury has no owner); the rest is burned.
    function _split(address coin, PoolId poolId) private returns (uint256 amount) {
        uint256 taken = ISpokeHook(hook).feesOf(poolId);
        uint256 done = _distributed[coin];
        if (taken == done) return 0;
        amount = taken - done;
        _distributed[coin] = taken;
        IPoolManager(poolManager).unlock(abi.encode(Action.Redeem, coin, amount, address(0)));

        uint256 creator = amount * CREATOR_BPS / BPS;
        uint256 earn = amount * EARN_BPS / BPS;
        uint256 ownerPart = amount * OWNER_BPS / BPS;
        uint256 burned = amount - creator - earn - ownerPart;
        _creatorOwed[coin] += creator;
        earnPending += earn;
        address ownerWallet = ITreasuryOwner(treasury).owner();
        if (ownerWallet == address(0)) {
            burned += ownerPart;
            ownerPart = 0;
        } else if (ownerPart > 0) {
            _transfer(orry, ownerWallet, ownerPart);
        }
        _burn(burned);
        emit FeesDistributed(coin, amount, creator, earn, ownerPart, burned);
    }

    /// @dev A vault that refuses the payment never blocks a distribution: the share stays in `earnPending` for the next
    /// try and the allowance is cleared.
    function _flushEarn() private returns (uint256 amount) {
        amount = earnPending;
        if (amount == 0 || block.timestamp < uint256(lastEarnAt) + EARN_INTERVAL) return 0;
        _approve(orry, earnVault, amount);
        try IEarnVault(earnVault).notifyRewards(amount) {
            earnPending = 0;
            lastEarnAt = uint64(block.timestamp);
            emit EarnNotified(amount);
        } catch {
            _approve(orry, earnVault, 0);
            return 0;
        }
    }

    /// @dev Exact-in ORRY buy of the coin at the pool's own price; pays the ORRY and returns the coins bought (still
    /// owed by the PoolManager to the caller of this function).
    function _swapIn(IPoolManager pm, PoolKey memory key, uint256 orryIn) private returns (uint256 out) {
        BalanceDelta s = pm.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(orryIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        if (uint256(-int256(s.amount0())) != orryIn) revert NotFilled();
        out = uint256(int256(s.amount1()));
        pm.sync(Currency.wrap(orry));
        _transfer(orry, poolManager, orryIn);
        pm.settle();
    }

    function _allowanceFor(uint256 usd) private view returns (uint256) {
        uint256 w = usd < earlyFullUsd ? usd : earlyFullUsd;
        return SUPPLY * earlyMaxBps * w / (BPS * earlyFullUsd);
    }

    /// @dev USD value of `orryAmount` at the R1 oracle; `ok` false while the oracle is not ready.
    function _usd(uint256 orryAmount) private view returns (bool ok, uint256 usd) {
        if (orryAmount == 0) return (true, 0);
        try IOrryPriceOracle(orryPrice).usdValue(orryAmount) returns (uint256 v) {
            return (true, v);
        } catch {
            return (false, 0);
        }
    }

    function _agentWallet(uint256 agentId) private view returns (address wallet) {
        try IIdentityRegistry(identityRegistry).getAgentWallet(agentId) returns (address w) {
            return w;
        } catch {
            return address(0);
        }
    }

    function _key(address coin) private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(orry),
            currency1: Currency.wrap(coin),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    function _coinSalt(address caller, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(caller, salt));
    }

    function _checkText(string calldata text, uint256 max) private pure {
        bytes calldata b = bytes(text);
        if (b.length == 0 || b.length > max) revert InvalidName();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c < 0x20 || c == 0x7f) revert InvalidName();
        }
    }

    /// @dev Pulls exactly `amount` ORRY from `from` (balance-delta checked).
    function _pullOrry(address from, uint256 amount) private {
        uint256 before = IOrryToken(orry).balanceOf(address(this));
        _call(orry, abi.encodeCall(IOrryToken.transferFrom, (from, address(this), amount)));
        if (IOrryToken(orry).balanceOf(address(this)) - before != amount) revert InexactTransfer();
    }

    function _burn(uint256 amount) private {
        if (amount == 0) return;
        uint256 supply = IOrryToken(orry).totalSupply();
        IOrryToken(orry).burn(amount);
        if (supply - IOrryToken(orry).totalSupply() != amount) revert InexactTransfer();
        emit Burned(BURN_SOURCE, amount);
    }

    function _transfer(address token, address to, uint256 amount) private {
        _call(token, abi.encodeCall(IOrryToken.transfer, (to, amount)));
    }

    function _approve(address token, address spender, uint256 amount) private {
        _call(token, abi.encodeCall(IOrryToken.approve, (spender, amount)));
    }

    /// @dev A token call that must succeed and return nothing or true.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert InexactTransfer();
    }
}
