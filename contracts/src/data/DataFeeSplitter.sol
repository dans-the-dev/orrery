// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOrryToken} from "../orry/interfaces/IOrryToken.sol";
import {IOrreryTreasury} from "../orry/interfaces/IOrreryTreasury.sol";
import {IDataFeeSplitter, IRewardPoolFunding} from "./interfaces/IDataFeeSplitter.sol";

/// @notice Payee of official Orrery Data bought in ORRY (R-50, R-60). See `IDataFeeSplitter`.
/// Books: the splitter's ORRY balance is always `poolOwed` (booked for the Reward Pool) plus what arrived since the last
/// split. `split()` burns 70% of the latter, rounded down, books the rest, and funds the pool with everything booked once
/// the pool is set. A pool that refuses the funding leaves the booking in place and blocks no burn.
contract DataFeeSplitter is IDataFeeSplitter, ReentrancyGuard {
    uint16 public constant BURN_BPS = 7000;
    uint8 public constant BURN_SOURCE = 11;
    uint64 public constant POOL_DELAY = 48 hours;
    uint16 private constant BPS = 10_000;

    address public immutable orry;
    address public immutable treasury;

    address public pool;
    uint256 public poolOwed;
    address private _pendingPool;
    uint64 private _pendingPoolAt;

    constructor(address orry_, address treasury_) {
        if (orry_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        orry = orry_;
        treasury = treasury_;
    }

    function split() external nonReentrant returns (uint256 burned, uint256 toPool) {
        IOrryToken t = IOrryToken(orry);
        uint256 bal = t.balanceOf(address(this));
        uint256 owed = poolOwed;
        uint256 fresh = bal - owed;
        address p = pool;
        if (fresh == 0 && (p == address(0) || owed == 0)) revert NothingToSplit();
        if (fresh != 0) {
            burned = fresh * BURN_BPS / BPS;
            toPool = fresh - burned;
            if (burned != 0) {
                t.burn(burned);
                if (t.balanceOf(address(this)) != bal - burned) revert InexactBurn();
                emit Burned(BURN_SOURCE, burned);
            }
            owed += toPool;
            poolOwed = owed;
            emit Split(fresh, burned, toPool);
        }
        if (p != address(0) && owed != 0) _fund(t, p, owed);
    }

    function previewSplit() external view returns (uint256 received, uint256 burned, uint256 toPool, uint256 owedAfter) {
        received = IOrryToken(orry).balanceOf(address(this)) - poolOwed;
        burned = received * BURN_BPS / BPS;
        toPool = received - burned;
        owedAfter = pool == address(0) ? poolOwed + toPool : 0;
    }

    /// @dev Pays everything booked to the pool through its `fund` (exact pull). If the pool reverts, its allowance is
    /// withdrawn and the booking stays, so the burn half of `split` never depends on the pool.
    function _fund(IOrryToken t, address p, uint256 owed) private {
        uint256 before = t.balanceOf(address(this));
        t.approve(p, owed);
        try IRewardPoolFunding(p).fund(orry, owed) {
            if (before - t.balanceOf(address(this)) != owed) revert InexactFunding();
            poolOwed = 0;
            emit PoolFunded(p, owed);
        } catch {
            t.approve(p, 0);
        }
    }

    // ------------------------------------------------------------------ pool (set once, 48 h)

    function pendingPool() external view returns (address pool_, uint64 executableAt) {
        return (_pendingPool, _pendingPoolAt);
    }

    function proposePool(address pool_) external {
        if (msg.sender != IOrreryTreasury(treasury).owner()) revert NotTreasuryOwner();
        if (pool != address(0)) revert PoolAlreadySet();
        if (pool_ == address(0)) revert ZeroAddress();
        // a low-level read, so an EOA, a contract without `orry()` and a short answer all end in WrongPool
        (bool ok, bytes memory ret) = pool_.staticcall(abi.encodeCall(IRewardPoolFunding.orry, ()));
        if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != uint256(uint160(orry))) revert WrongPool();
        uint64 at = uint64(block.timestamp) + POOL_DELAY;
        _pendingPool = pool_;
        _pendingPoolAt = at;
        emit PoolProposed(pool_, at);
    }

    function executePool() external {
        if (msg.sender != IOrreryTreasury(treasury).owner()) revert NotTreasuryOwner();
        if (pool != address(0)) revert PoolAlreadySet();
        address p = _pendingPool;
        if (p == address(0)) revert NoPoolProposal();
        if (block.timestamp < _pendingPoolAt) revert PoolNotReady(_pendingPoolAt);
        pool = p;
        delete _pendingPool;
        delete _pendingPoolAt;
        emit PoolSet(p);
    }
}
