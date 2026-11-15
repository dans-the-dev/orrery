// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";

import {IIdentityRegistry} from "../interfaces/IExternal.sol";
import {IOrryStaking} from "./interfaces/IOrryStaking.sol";
import {IOrryToken} from "./interfaces/IOrryToken.sol";

/// @title OrryStaking
/// @notice ORRY staking (`docs/ORRY-BUILD-SPEC.md` 3.3, invariants S-1 to S-5). Plain stakes per address and stakes
/// behind an ERC-8004 agentId both earn for their staker. ETH and ORRY rewards are streamed over `STREAM_PERIOD` pro
/// rata to active stake. Requesting an unstake stops earning at once; the amount stays locked until its cooldown ends.
/// @dev Reward ledgers per asset follow `aethernode/23-token-spec.md` section 5: `owed` (streamed to stakers, not yet
/// claimed), `unstreamed` (division remainders and time with nobody earning), and the scheduled remainder
/// `rate * (periodFinish - now)`. At every point, per asset: notified = claimed + owed + scheduled + unstreamed.
/// No owner, no pause, no setter. Nothing can move a position except its staker after its cooldown.
contract OrryStaking is IOrryStaking {
    uint256 private constant PRECISION = 1e36;
    uint256 private constant ETH = 0;
    uint256 private constant ORRY = 1;
    /// @dev Transient slot of the reentrancy lock.
    bytes32 private constant LOCK_SLOT = keccak256("orrery.orry.staking.lock");

    struct Plain {
        uint128 active;
        uint128 leaving;
        uint64 readyAt;
    }

    struct Stream {
        uint256 rate; // reward units per second
        uint64 periodFinish;
        uint64 lastUpdate;
        uint256 perToken; // accumulated reward per earning unit, scaled by PRECISION
        uint256 unstreamed; // waits for the next notify of this asset
        uint256 owed; // streamed to stakers, not yet claimed
    }

    uint64 public immutable PLAIN_COOLDOWN;
    uint64 public immutable AGENT_COOLDOWN;
    uint64 public immutable STREAM_PERIOD;
    /// @notice An agent lock may reach at most this far ahead of the moment it is set (R-13).
    uint64 public constant MAX_AGENT_LOCK = 365 days;

    address public immutable orry;
    address public immutable identityRegistry;

    uint256 public totalEarning;

    mapping(address account => uint256) internal _earning;
    mapping(address account => Plain) internal _plain;
    mapping(uint256 agentId => mapping(address owner => AgentPosition)) internal _agent;

    Stream[2] internal _streams;
    mapping(address account => uint256[2]) internal _paidPerToken;
    mapping(address account => uint256[2]) internal _accrued;

    constructor(
        address orry_,
        address identityRegistry_,
        uint64 plainCooldown,
        uint64 agentCooldown,
        uint64 streamPeriod
    ) {
        require(orry_ != address(0) && identityRegistry_ != address(0), "zero address");
        require(plainCooldown != 0 && agentCooldown != 0 && streamPeriod != 0, "zero duration");
        orry = orry_;
        identityRegistry = identityRegistry_;
        PLAIN_COOLDOWN = plainCooldown;
        AGENT_COOLDOWN = agentCooldown;
        STREAM_PERIOD = streamPeriod;
    }

    modifier nonReentrant() {
        bytes32 slot = LOCK_SLOT;
        assembly ("memory-safe") {
            if tload(slot) { revert(0, 0) }
            tstore(slot, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    // ------------------------------------------------------------------ plain stake

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _accrue(msg.sender);
        _pullOrry(amount);
        Plain storage p = _plain[msg.sender];
        p.active += _u128(amount);
        _earning[msg.sender] += amount;
        totalEarning += amount;
        emit Staked(msg.sender, amount);
    }

    function requestUnstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Plain storage p = _plain[msg.sender];
        if (amount > p.active) revert InsufficientActive();
        _accrue(msg.sender);
        uint128 a = uint128(amount);
        p.active -= a;
        p.leaving += a;
        uint64 readyAt = uint64(block.timestamp) + PLAIN_COOLDOWN;
        p.readyAt = readyAt;
        _earning[msg.sender] -= amount;
        totalEarning -= amount;
        emit UnstakeRequested(msg.sender, amount, readyAt);
    }

    function withdraw() external nonReentrant returns (uint256 amount) {
        Plain storage p = _plain[msg.sender];
        amount = p.leaving;
        if (amount == 0 || block.timestamp < p.readyAt) revert NothingReady();
        p.leaving = 0;
        p.readyAt = 0;
        _sendOrry(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ agent stake

    function stakeForAgent(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        address agentOwner = IIdentityRegistry(identityRegistry).ownerOf(agentId);
        if (msg.sender != agentOwner && msg.sender != IIdentityRegistry(identityRegistry).getAgentWallet(agentId)) {
            revert NotAgentController();
        }
        AgentPosition storage pos = _agent[agentId][agentOwner];
        address staker = pos.staker;
        if (staker == address(0)) {
            pos.staker = msg.sender;
        } else if (staker != msg.sender) {
            revert PositionHeldByAnotherStaker();
        }
        _accrue(msg.sender);
        _pullOrry(amount);
        pos.active += _u128(amount);
        _earning[msg.sender] += amount;
        totalEarning += amount;
        emit AgentStaked(agentId, agentOwner, msg.sender, amount);
    }

    function requestAgentUnstake(uint256 agentId, address owner, uint256 amount) external nonReentrant {
        AgentPosition storage pos = _agent[agentId][owner];
        if (msg.sender != pos.staker) revert NotStaker();
        if (block.timestamp < pos.lockedUntil) revert AgentStakeLocked(pos.lockedUntil);
        if (amount == 0) revert ZeroAmount();
        if (amount > pos.active) revert InsufficientActive();
        _accrue(msg.sender);
        uint128 a = uint128(amount);
        pos.active -= a;
        pos.leaving += a;
        uint64 leavingAt = uint64(block.timestamp) + AGENT_COOLDOWN;
        pos.leavingAt = leavingAt;
        _earning[msg.sender] -= amount;
        totalEarning -= amount;
        emit AgentUnstakeRequested(agentId, owner, amount, leavingAt);
    }

    function withdrawAgent(uint256 agentId, address owner) external nonReentrant returns (uint256 amount) {
        AgentPosition storage pos = _agent[agentId][owner];
        address staker = pos.staker;
        if (msg.sender != staker) revert NotStaker();
        amount = pos.leaving;
        if (amount == 0 || block.timestamp < pos.leavingAt) revert NothingReady();
        pos.leaving = 0;
        pos.leavingAt = 0;
        // an emptied position is free for the identity's next controller
        if (pos.active == 0) pos.staker = address(0);
        _sendOrry(staker, amount);
        emit AgentWithdrawn(agentId, owner, staker, amount);
    }

    /// @dev R-13: the staker of the position reported for the agent commits it until `lockedUntil`. The lock only
    /// grows; it changes no earning and no reward. An emptied position keeps its lock for the next staker of the same
    /// (agentId, owner) key; a new owner of the identity starts a fresh position.
    function extendAgentLock(uint256 agentId, uint64 lockedUntil) external nonReentrant {
        address agentOwner = IIdentityRegistry(identityRegistry).ownerOf(agentId);
        AgentPosition storage pos = _agent[agentId][agentOwner];
        if (msg.sender != pos.staker) revert NotStaker();
        if (lockedUntil <= pos.lockedUntil) revert LockNotExtended();
        if (lockedUntil > block.timestamp + MAX_AGENT_LOCK) revert LockTooLong();
        pos.lockedUntil = lockedUntil;
        emit AgentLockExtended(agentId, agentOwner, lockedUntil);
    }

    // ------------------------------------------------------------------ rewards

    function notifyRewards(uint256 orryAmount) external payable nonReentrant {
        if (msg.value == 0 && orryAmount == 0) revert ZeroAmount();
        _updateStreams();
        if (orryAmount != 0) _pullOrry(orryAmount);
        // only the assets paid in restart; the other stream keeps its schedule
        if (msg.value != 0) _restart(_streams[ETH], msg.value);
        if (orryAmount != 0) _restart(_streams[ORRY], orryAmount);
        emit RewardsNotified(msg.sender, msg.value, orryAmount, uint64(block.timestamp) + STREAM_PERIOD);
    }

    function claimRewards() external nonReentrant returns (uint256 ethAmount, uint256 orryAmount) {
        return _claim(msg.sender, msg.sender);
    }

    function claimFor(address account) external nonReentrant returns (uint256 ethAmount, uint256 orryAmount) {
        return _claim(account, account);
    }

    /// @notice Pays the caller's rewards to `to`: a staker that cannot take ETH still gets both assets (review L-1).
    function claimRewardsTo(address to) external nonReentrant returns (uint256 ethAmount, uint256 orryAmount) {
        if (to == address(0)) revert ZeroAddress();
        return _claim(msg.sender, to);
    }

    // ------------------------------------------------------------------ views

    function earningBalance(address account) external view returns (uint256) {
        return _earning[account];
    }

    function plainStake(address account) external view returns (uint256 active, uint256 leaving, uint64 readyAt) {
        Plain memory p = _plain[account];
        return (p.active, p.leaving, p.readyAt);
    }

    function agentStake(uint256 agentId) external view returns (AgentPosition memory pos) {
        try IIdentityRegistry(identityRegistry).ownerOf(agentId) returns (address agentOwner) {
            pos = _agent[agentId][agentOwner];
        } catch {}
    }

    function agentStakeOf(uint256 agentId, address owner) external view returns (AgentPosition memory) {
        return _agent[agentId][owner];
    }

    function pendingRewards(address account) external view returns (uint256 ethAmount, uint256 orryAmount) {
        ethAmount = _pending(account, ETH);
        orryAmount = _pending(account, ORRY);
    }

    // ------------------------------------------------------------------ internals

    function _claim(address account, address to) private returns (uint256 ethAmount, uint256 orryAmount) {
        _accrue(account);
        uint256[2] storage acc = _accrued[account];
        ethAmount = acc[ETH];
        orryAmount = acc[ORRY];
        if (ethAmount == 0 && orryAmount == 0) return (0, 0);
        acc[ETH] = 0;
        acc[ORRY] = 0;
        _streams[ETH].owed -= ethAmount;
        _streams[ORRY].owed -= orryAmount;
        if (orryAmount != 0) _sendOrry(to, orryAmount);
        if (ethAmount != 0) {
            (bool ok,) = to.call{value: ethAmount}("");
            if (!ok) {
                // An address that cannot take ETH keeps its ETH owed and still gets its ORRY (review L-1); the ETH can
                // go elsewhere with claimRewardsTo.
                acc[ETH] = ethAmount;
                _streams[ETH].owed += ethAmount;
                ethAmount = 0;
            }
        }
        if (ethAmount == 0 && orryAmount == 0) return (0, 0);
        emit RewardsClaimed(account, msg.sender, ethAmount, orryAmount);
    }

    /// @dev Brings both streams to now, then books `account`'s share at its earning balance before any change.
    function _accrue(address account) private {
        _updateStreams();
        uint256 bal = _earning[account];
        for (uint256 i; i < 2; ++i) {
            uint256 perToken = _streams[i].perToken;
            uint256 paid = _paidPerToken[account][i];
            if (perToken != paid) {
                if (bal != 0) _accrued[account][i] += FullMath.mulDiv(bal, perToken - paid, PRECISION);
                _paidPerToken[account][i] = perToken;
            }
        }
    }

    function _updateStreams() private {
        uint256 total = totalEarning;
        for (uint256 i; i < 2; ++i) {
            Stream storage s = _streams[i];
            uint256 end = block.timestamp < s.periodFinish ? block.timestamp : s.periodFinish;
            if (end > s.lastUpdate) {
                uint256 streamed = s.rate * (end - s.lastUpdate);
                if (total == 0) {
                    s.unstreamed += streamed; // nobody earning: kept for the next period
                } else {
                    s.perToken += FullMath.mulDiv(streamed, PRECISION, total);
                    s.owed += streamed;
                }
            }
            s.lastUpdate = uint64(block.timestamp);
        }
    }

    /// @dev Called after `_updateStreams`: rate = (scheduled remainder + unstreamed + amount) / STREAM_PERIOD, the
    /// division remainder stays unstreamed.
    function _restart(Stream storage s, uint256 amount) private {
        uint256 scheduled = block.timestamp < s.periodFinish ? s.rate * (s.periodFinish - block.timestamp) : 0;
        uint256 total = scheduled + s.unstreamed + amount;
        uint256 rate = total / STREAM_PERIOD;
        s.unstreamed = total - rate * STREAM_PERIOD;
        s.rate = rate;
        s.periodFinish = uint64(block.timestamp) + STREAM_PERIOD;
    }

    function _pending(address account, uint256 i) private view returns (uint256) {
        Stream memory s = _streams[i];
        uint256 perToken = s.perToken;
        uint256 total = totalEarning;
        uint256 end = block.timestamp < s.periodFinish ? block.timestamp : s.periodFinish;
        if (end > s.lastUpdate && total != 0) perToken += FullMath.mulDiv(s.rate * (end - s.lastUpdate), PRECISION, total);
        return _accrued[account][i]
            + FullMath.mulDiv(_earning[account], perToken - _paidPerToken[account][i], PRECISION);
    }

    /// @dev Balance-delta intake: a token that delivers less or more than `amount` reverts.
    function _pullOrry(uint256 amount) private {
        uint256 before = IOrryToken(orry).balanceOf(address(this));
        (bool ok, bytes memory ret) =
            orry.call(abi.encodeCall(IOrryToken.transferFrom, (msg.sender, address(this), amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert InexactTransfer();
        if (IOrryToken(orry).balanceOf(address(this)) - before != amount) revert InexactTransfer();
    }

    /// @dev Amounts are bounded by the ORRY supply (1e27); the check only guards the narrowing.
    function _u128(uint256 x) private pure returns (uint128) {
        require(x <= type(uint128).max);
        return uint128(x);
    }

    function _sendOrry(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = orry.call(abi.encodeCall(IOrryToken.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert InexactTransfer();
    }
}
