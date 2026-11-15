// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OrryPriced} from "./OrryPriced.sol";
import {RewardPool} from "./RewardPool.sol";
import {StakeUsd} from "./verifiers/StakeUsdVerifier.sol";
import {IOrryStaking} from "../orry/interfaces/IOrryStaking.sol";

/// @title OrryChat
/// @notice On-chain Community Chat (`docs/ORRY-CHAT-PLAN.md` 1, R-31, R-32, R-39, `docs/updates/L1-COMMUNITY-SPEC.md`
/// L1-6). A message is an event: its text lives only in the `Posted` log, which nobody can edit or delete; storage keeps
/// only its author (for tips and reports). Each post pays `postFeeUsd` in ORRY at the hub mean price, all of it to the
/// Reward Pool (R-31). Rooms: room 0 is open; the admin (the pool's admin, the treasury wallet) creates more rooms, each
/// with a USD minimum earning stake in `OrryStaking` (staker rooms, C2; 0 = open); rooms are never edited or deleted.
/// Tips go to the author minus `tipCutBps` to the pool. Moderation (R-32): stakers with at least `reportMinStake` ORRY
/// earning report a message once each; at `hideThreshold` reports the contract emits `Hidden`, and the site hides it.
/// No owner beyond room creation, no pause, no setter.
contract OrryChat is OrryPriced {
    struct Room {
        bool exists;
        uint128 minStakeUsd; // USDG base units; 0 = open
    }

    event RoomCreated(uint256 indexed room, uint256 minStakeUsd, string name);
    event Posted(
        uint256 indexed id, uint256 indexed room, address indexed author, uint256 replyTo, uint256 fee, string text
    );
    event Tipped(uint256 indexed id, address indexed from, address indexed author, uint256 amount, uint256 cut);
    event Reported(uint256 indexed id, address indexed reporter, uint32 reports);
    event Hidden(uint256 indexed id, uint32 reports);

    error NotAdmin();
    error UnknownRoom();
    error BelowRoomStake(uint256 stakeUsd, uint256 minStakeUsd);
    error BadText();
    error UnknownMessage();
    error SelfTip();
    error ZeroAmount();
    error BelowReportStake();
    error AlreadyReported();

    RewardPool public immutable pool;
    IOrryStaking public immutable staking;
    uint256 public immutable postFeeUsd;
    uint256 public immutable maxTextBytes;
    uint16 public immutable tipCutBps;
    uint256 public immutable reportMinStake;
    uint32 public immutable hideThreshold;

    uint256 public roomCount; // rooms 0 .. roomCount - 1
    uint256 public messageCount; // messages 1 .. messageCount
    mapping(uint256 room => Room) private _rooms;
    mapping(uint256 id => address) public authorOf;
    mapping(uint256 id => uint32) public reportsOf;
    mapping(uint256 id => mapping(address reporter => bool)) public reported;

    constructor(
        address orry_,
        address orryPrice_,
        address pool_,
        address staking_,
        uint256 postFeeUsd_,
        uint256 maxTextBytes_,
        uint16 tipCutBps_,
        uint256 reportMinStake_,
        uint32 hideThreshold_
    ) OrryPriced(orry_, orryPrice_) {
        if (pool_ == address(0) || staking_ == address(0)) revert ZeroAddress();
        require(RewardPool(payable(pool_)).orry() == orry_, "pool orry");
        require(postFeeUsd_ != 0, "zero fee");
        require(maxTextBytes_ != 0 && maxTextBytes_ <= 4096, "text bound");
        require(tipCutBps_ <= BPS, "tip cut");
        require(reportMinStake_ != 0 && hideThreshold_ != 0, "moderation");
        pool = RewardPool(payable(pool_));
        staking = IOrryStaking(staking_);
        postFeeUsd = postFeeUsd_;
        maxTextBytes = maxTextBytes_;
        tipCutBps = tipCutBps_;
        reportMinStake = reportMinStake_;
        hideThreshold = hideThreshold_;
        _rooms[0] = Room(true, 0);
        roomCount = 1;
        emit RoomCreated(0, 0, "general");
    }

    function createRoom(uint256 minStakeUsd, string calldata name) external returns (uint256 room) {
        if (msg.sender != pool.admin()) revert NotAdmin();
        require(minStakeUsd <= type(uint128).max, "min stake");
        room = roomCount++;
        _rooms[room] = Room(true, uint128(minStakeUsd));
        emit RoomCreated(room, minStakeUsd, name);
    }

    function roomOf(uint256 room) external view returns (bool exists, uint256 minStakeUsd) {
        Room memory r = _rooms[room];
        return (r.exists, r.minStakeUsd);
    }

    /// @notice The ORRY a post costs now (reverts while the price is not ready).
    function postFee() external view returns (uint256) {
        return _quote(postFeeUsd, type(uint256).max);
    }

    /// @notice USD value of `account`'s earning stake, as staker rooms read it.
    function stakeUsdOf(address account) public view returns (uint256) {
        return StakeUsd.valueOf(address(staking), address(orryPrice), account);
    }

    function post(uint256 room, uint256 replyTo, string calldata text, uint256 maxFee) external returns (uint256 id) {
        Room memory r = _rooms[room];
        if (!r.exists) revert UnknownRoom();
        uint256 len = bytes(text).length;
        if (len == 0 || len > maxTextBytes) revert BadText();
        if (replyTo != 0 && authorOf[replyTo] == address(0)) revert UnknownMessage();
        if (r.minStakeUsd != 0) {
            uint256 s = stakeUsdOf(msg.sender);
            if (s < r.minStakeUsd) revert BelowRoomStake(s, r.minStakeUsd);
        }
        uint256 fee = _quote(postFeeUsd, maxFee);
        _toPool(msg.sender, fee);
        id = ++messageCount;
        authorOf[id] = msg.sender;
        emit Posted(id, room, msg.sender, replyTo, fee, text);
    }

    function tip(uint256 id, uint256 amount) external {
        address author = authorOf[id];
        if (author == address(0)) revert UnknownMessage();
        if (author == msg.sender) revert SelfTip();
        if (amount == 0) revert ZeroAmount();
        uint256 cut = amount * tipCutBps / BPS;
        _pull(msg.sender, author, amount - cut);
        _toPool(msg.sender, cut);
        emit Tipped(id, msg.sender, author, amount, cut);
    }

    function report(uint256 id) external {
        if (authorOf[id] == address(0)) revert UnknownMessage();
        if (reported[id][msg.sender]) revert AlreadyReported();
        if (staking.earningBalance(msg.sender) < reportMinStake) revert BelowReportStake();
        reported[id][msg.sender] = true;
        uint32 n = ++reportsOf[id];
        emit Reported(id, msg.sender, n);
        if (n == hideThreshold) emit Hidden(id, n);
    }

    function isHidden(uint256 id) external view returns (bool) {
        return reportsOf[id] >= hideThreshold;
    }

    function _toPool(address from, uint256 amount) private {
        if (amount == 0) return;
        _pull(from, address(pool), amount);
        pool.sync(address(orry));
    }
}
