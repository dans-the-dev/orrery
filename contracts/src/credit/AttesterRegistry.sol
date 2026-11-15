// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OrreryAttestor} from "../OrreryAttestor.sol";
import {IOrryToken} from "../orry/interfaces/IOrryToken.sol";

/// @title AttesterRegistry
/// @notice Third-party attesters (R-47, `docs/updates/L4-CREDIT-SPEC.md` 3.1). Anyone locks at least `minStake` ORRY and
///         names a probe key; each epoch the top `maxActive` stakers become the active set. `OrreryAttestor` allows at most
///         5 attester keys (finding F1), so this registry holds ONE of them and forwards results from active probe keys.
///         No slashing: stake only ever returns to its staker, `unlockDelay` after `requestUnlock`.
contract AttesterRegistry is ReentrancyGuard {
    uint256 public constant MAX_CANDIDATES = 1000;

    struct Staker {
        uint128 amount;
        uint64 lockedAt;
        uint64 unlockAt; // 0 while staked
        address probeKey;
        uint64 excludedUntilEpoch; // excluded while epoch <= this; 0 = never excluded
    }

    IOrryToken public immutable orry;
    OrreryAttestor public immutable attestor;
    uint256 public immutable minStake;
    uint256 public immutable maxActive;
    uint64 public immutable epochLength;
    uint64 public immutable unlockDelay;
    uint64 public immutable genesis;

    uint256 public totalStaked;
    mapping(address => Staker) internal _stakers;
    mapping(address probeKey => address staker) public probeOwner;
    address[] internal _candidates;
    mapping(address => uint256) internal _candidateIndex; // index + 1

    mapping(uint256 epoch => bool) public rolled;
    mapping(uint256 epoch => address[]) internal _active;
    mapping(uint256 epoch => mapping(address => bool)) public isActive;
    mapping(uint256 epoch => mapping(address => uint256)) public results;
    mapping(uint256 epoch => uint256) public totalResults;
    mapping(uint256 epoch => mapping(address => mapping(uint256 agentId => bool))) public counted;

    event Staked(address indexed staker, uint256 amount, uint256 total, address indexed probeKey);
    event ProbeKeySet(address indexed staker, address indexed oldKey, address indexed newKey);
    event UnlockRequested(address indexed staker, uint256 amount, uint64 unlockAt);
    event Withdrawn(address indexed staker, uint256 amount);
    event EpochRolled(uint256 indexed epoch, address[] active);
    event Excluded(address indexed staker, uint256 indexed epoch, uint64 untilEpoch, bytes32 reasonHash);
    event ResultForwarded(
        uint256 indexed epoch,
        address indexed staker,
        uint256 indexed agentId,
        address probeKey,
        uint64 observedAt,
        bool endpointsLive,
        bool registrationValid,
        bool domainVerified,
        bool counted
    );

    error ZeroAmount();
    error ZeroAddress();
    error BelowMinimum();
    error BadProbeKey();
    error ProbeKeyTaken();
    error NotStaker();
    error Unlocking();
    error NotUnlocking();
    error StillLocked(uint64 unlockAt);
    error TooManyCandidates();
    error AlreadyRolled();
    error NotRolled();
    error NotActive();
    error NotAttestorOwner();
    error InexactTransfer();
    error BadParams();

    constructor(
        IOrryToken orry_,
        OrreryAttestor attestor_,
        uint256 minStake_,
        uint256 maxActive_,
        uint64 epochLength_,
        uint64 unlockDelay_,
        uint64 genesis_
    ) {
        if (address(orry_) == address(0) || address(attestor_) == address(0)) revert ZeroAddress();
        if (minStake_ == 0 || minStake_ > type(uint128).max || maxActive_ == 0 || maxActive_ > 100) revert BadParams();
        if (epochLength_ < 1 hours || unlockDelay_ == 0 || genesis_ > block.timestamp) revert BadParams();
        orry = orry_;
        attestor = attestor_;
        minStake = minStake_;
        maxActive = maxActive_;
        epochLength = epochLength_;
        unlockDelay = unlockDelay_;
        genesis = genesis_;
    }

    // ------------------------------------------------------------------ stake

    /// @notice Lock `amount` ORRY. The first lock needs at least `minStake` and a fresh probe key; a top-up passes 0.
    function stake(uint256 amount, address probeKey) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Staker storage s = _stakers[msg.sender];
        if (s.unlockAt != 0) revert Unlocking();
        if (s.amount == 0) {
            if (amount < minStake) revert BelowMinimum();
            if (probeOwner[msg.sender] != address(0)) revert ProbeKeyTaken();
            _claimProbeKey(msg.sender, probeKey);
            s.probeKey = probeKey;
            s.lockedAt = uint64(block.timestamp);
            if (_candidates.length >= MAX_CANDIDATES) revert TooManyCandidates();
            _candidates.push(msg.sender);
            _candidateIndex[msg.sender] = _candidates.length;
        } else if (probeKey != address(0)) {
            revert BadProbeKey();
        }
        uint256 before = orry.balanceOf(address(this));
        _pull(msg.sender, amount);
        if (orry.balanceOf(address(this)) != before + amount) revert InexactTransfer();
        uint256 total = uint256(s.amount) + amount;
        if (total > type(uint128).max) revert BadParams();
        s.amount = uint128(total);
        totalStaked += amount;
        emit Staked(msg.sender, amount, total, s.probeKey);
    }

    function setProbeKey(address newKey) external {
        Staker storage s = _stakers[msg.sender];
        if (s.amount == 0) revert NotStaker();
        if (s.unlockAt != 0) revert Unlocking();
        address old = s.probeKey;
        _claimProbeKey(msg.sender, newKey);
        delete probeOwner[old];
        s.probeKey = newKey;
        emit ProbeKeySet(msg.sender, old, newKey);
    }

    /// @notice Leave: out of the active set and the candidates at once; the stake unlocks `unlockDelay` later.
    function requestUnlock() external {
        Staker storage s = _stakers[msg.sender];
        if (s.amount == 0) revert NotStaker();
        if (s.unlockAt != 0) revert Unlocking();
        uint64 at = uint64(block.timestamp) + unlockDelay;
        s.unlockAt = at;
        _removeCandidate(msg.sender);
        delete probeOwner[s.probeKey];
        _deactivate(currentEpoch(), msg.sender);
        emit UnlockRequested(msg.sender, s.amount, at);
    }

    function withdraw() external nonReentrant {
        Staker memory s = _stakers[msg.sender];
        if (s.unlockAt == 0) revert NotUnlocking();
        if (block.timestamp < s.unlockAt) revert StillLocked(s.unlockAt);
        delete _stakers[msg.sender];
        totalStaked -= s.amount;
        if (!orry.transfer(msg.sender, s.amount)) revert InexactTransfer();
        emit Withdrawn(msg.sender, s.amount);
    }

    // ------------------------------------------------------------------ epochs

    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - genesis) / epochLength;
    }

    function epochStart(uint256 epoch) public view returns (uint64) {
        return uint64(genesis + epoch * epochLength);
    }

    /// @notice Anyone, once per epoch: the top `maxActive` eligible candidates by stake (ties: earlier lock, then the
    ///         lower address) become this epoch's active set. Bounded by MAX_CANDIDATES.
    function rollEpoch() external returns (address[] memory set) {
        uint256 e = currentEpoch();
        if (rolled[e]) revert AlreadyRolled();
        rolled[e] = true;
        uint256 cap = maxActive;
        // a min-heap of the best `cap` so far: the root is the lowest ranked kept candidate
        set = new address[](cap);
        uint256[] memory key = new uint256[](cap);
        uint256 n;
        uint256 len = _candidates.length;
        for (uint256 i; i < len; ++i) {
            address c = _candidates[i];
            Staker storage s = _stakers[c];
            // every candidate holds at least minStake (first lock), so only the exclusion filters
            uint64 ex = s.excludedUntilEpoch;
            if (ex != 0 && ex >= e) continue;
            // rank key: more stake first, then the earlier lock; equal keys go to the lower address
            uint256 k = (uint256(s.amount) << 64) | (type(uint64).max - s.lockedAt);
            if (n < cap) {
                _heapPush(set, key, n++, c, k);
            } else if (_above(k, c, key[0], set[0])) {
                _heapReplaceRoot(set, key, cap, c, k);
            }
        }
        _sortDesc(set, key, n);
        assembly {
            mstore(set, n)
        }
        for (uint256 i; i < n; ++i) {
            isActive[e][set[i]] = true;
            _active[e].push(set[i]);
        }
        emit EpochRolled(e, set);
    }

    /// @dev True when (ka, a) ranks above (kb, b).
    function _above(uint256 ka, address a, uint256 kb, address b) private pure returns (bool) {
        return ka > kb || (ka == kb && a < b);
    }

    function _heapPush(address[] memory set, uint256[] memory key, uint256 j, address c, uint256 k) private pure {
        while (j > 0) {
            uint256 parent = (j - 1) / 2;
            if (!_above(key[parent], set[parent], k, c)) break;
            set[j] = set[parent];
            key[j] = key[parent];
            j = parent;
        }
        set[j] = c;
        key[j] = k;
    }

    function _heapReplaceRoot(address[] memory set, uint256[] memory key, uint256 cap, address c, uint256 k) private pure {
        uint256 j;
        while (true) {
            uint256 m = 2 * j + 1;
            if (m >= cap) break;
            if (m + 1 < cap && _above(key[m], set[m], key[m + 1], set[m + 1])) ++m;
            if (!_above(k, c, key[m], set[m])) break;
            set[j] = set[m];
            key[j] = key[m];
            j = m;
        }
        set[j] = c;
        key[j] = k;
    }

    function _sortDesc(address[] memory set, uint256[] memory key, uint256 n) private pure {
        for (uint256 i = 1; i < n; ++i) {
            address c = set[i];
            uint256 k = key[i];
            uint256 j = i;
            while (j > 0 && _above(k, c, key[j - 1], set[j - 1])) {
                set[j] = set[j - 1];
                key[j] = key[j - 1];
                --j;
            }
            set[j] = c;
            key[j] = k;
        }
    }

    /// @notice The attestor owner leaves `staker` out of the current set and the next roll (quality rule, no slashing).
    function exclude(address staker, bytes32 reasonHash) external {
        if (msg.sender != attestor.owner()) revert NotAttestorOwner();
        if (_stakers[staker].amount == 0) revert NotStaker();
        uint256 e = currentEpoch();
        uint64 until = uint64(e + 1);
        _stakers[staker].excludedUntilEpoch = until;
        _deactivate(e, staker);
        emit Excluded(staker, e, until, reasonHash);
    }

    // ------------------------------------------------------------------ forwarding

    /// @notice An active attester's probe key posts a result; the registry is the `OrreryAttestor` attester.
    function attest(uint256 agentId, OrreryAttestor.Attestation calldata a) external nonReentrant {
        address staker = probeOwner[msg.sender];
        uint256 e = currentEpoch();
        if (!rolled[e]) revert NotRolled();
        if (staker == address(0) || !isActive[e][staker]) revert NotActive();
        attestor.attest(agentId, a);
        bool fresh = !counted[e][staker][agentId];
        if (fresh) {
            counted[e][staker][agentId] = true;
            results[e][staker] += 1;
            totalResults[e] += 1;
        }
        emit ResultForwarded(
            e, staker, agentId, msg.sender, a.observedAt, a.endpointsLive, a.registrationValid, a.domainVerified, fresh
        );
    }

    // ------------------------------------------------------------------ views

    function stakerOf(address staker) external view returns (Staker memory) {
        return _stakers[staker];
    }

    function activeSet(uint256 epoch) external view returns (address[] memory) {
        return _active[epoch];
    }

    function candidates() external view returns (address[] memory) {
        return _candidates;
    }

    function candidateCount() external view returns (uint256) {
        return _candidates.length;
    }

    // ------------------------------------------------------------------ internals

    function _claimProbeKey(address staker, address key) private {
        if (key == address(0) || key == staker) revert BadProbeKey();
        if (probeOwner[key] != address(0) || _stakers[key].amount != 0) revert ProbeKeyTaken();
        probeOwner[key] = staker;
    }

    function _deactivate(uint256 e, address staker) private {
        if (!isActive[e][staker]) return;
        isActive[e][staker] = false;
        address[] storage set = _active[e];
        uint256 len = set.length;
        for (uint256 i; i < len; ++i) {
            if (set[i] == staker) {
                set[i] = set[len - 1];
                set.pop();
                break;
            }
        }
    }

    function _removeCandidate(address staker) private {
        uint256 idx = _candidateIndex[staker];
        if (idx == 0) return;
        uint256 last = _candidates.length;
        if (idx != last) {
            address moved = _candidates[last - 1];
            _candidates[idx - 1] = moved;
            _candidateIndex[moved] = idx;
        }
        _candidates.pop();
        delete _candidateIndex[staker];
    }

    function _pull(address from, uint256 amount) private {
        (bool ok, bytes memory ret) =
            address(orry).call(abi.encodeCall(IOrryToken.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert InexactTransfer();
    }
}
