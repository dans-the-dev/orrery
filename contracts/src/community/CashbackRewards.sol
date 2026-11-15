// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";

import {IOrryPriceOracle} from "../markets/interfaces/IMarketPricing.sol";
import {IOrryToken} from "../orry/interfaces/IOrryToken.sol";
import {ReferralRegistry} from "./ReferralRegistry.sol";
import {Months} from "./Months.sol";

/// @title CashbackRewards
/// @notice The cashback sink of blocker B-1 (`OrryBuyback.cashbackSink`, R-45): `CASHBACK_BPS` of the ORRY the buyback
/// buys arrives here as plain transfers. It pays ORRY cashback (utility 7) and referral rewards (utility 8, R-53 to R-56)
/// from that ORRY only, plus any Reward Pool campaign payout sent here (RF-5). `docs/updates/L1-COMMUNITY-SPEC.md` L1-12,
/// L1-13.
/// Accruals are computed by the services indexer from fees actually paid and posted by the `publisher` key, in USD. On
/// chain each record is bounded: a reward is at most `MAX_SHARE_BPS` of its fee (cashback at most `MAX_CASHBACK_BPS`), a
/// referral record must match the `ReferralRegistry` link and a fee paid within `REFERRAL_WINDOW` of it, referral USD per
/// referrer per UTC calendar month is at most `MONTHLY_CAP_USD`, a record is accepted once (`ref`), and its fee was paid at
/// most `MAX_LAG` ago.
/// Claim periods are UTC calendar months of the accrual. A month opens (anyone) `HOLD` after it ends: its USD total is
/// priced in ORRY at the hub mean price and `min(needed, free)` is reserved, so a short sink pays pro rata. Each account
/// claims its share of a month once; `CLAIM_WINDOW` after opening, what is unclaimed returns to the free balance. The admin
/// (treasury wallet) may void an account's month before it opens and sets the publisher key. Nobody can withdraw.
contract CashbackRewards {
    struct Accrual {
        address account; // cashback: the fee payer; referral: the referrer
        uint8 kind; // 1 cashback, 2 referral
        address referee; // referral only, else address(0)
        uint64 feePaidAt;
        uint128 feeUsd; // USDG base units
        uint128 rewardUsd;
        bytes32 ref; // source reference (transaction and log), one record per (ref, kind, account)
    }

    struct Period {
        uint128 totalUsd;
        uint64 openedAt;
        bool closed;
        uint256 reserve;
        uint256 left;
    }

    event Accrued(
        address indexed account,
        uint8 indexed kind,
        uint256 indexed month,
        address referee,
        uint256 feeUsd,
        uint256 rewardUsd,
        uint64 feePaidAt,
        bytes32 ref
    );
    event MonthVoided(address indexed account, uint256 indexed month, uint256 usd);
    event PeriodOpened(uint256 indexed month, uint256 totalUsd, uint256 orryNeeded, uint256 reserve);
    event RewardClaimed(address indexed account, uint256 indexed month, uint256 usd, uint256 orry);
    event PeriodClosed(uint256 indexed month, uint256 returned);
    event PublisherSet(address indexed publisher);
    event AdminTransferStarted(address indexed admin, address indexed pending);
    event AdminTransferred(address indexed previous, address indexed admin);

    error NotAdmin();
    error NotPublisher();
    error ZeroAddress();
    error BadAccrual(uint256 index);
    error DuplicateAccrual(uint256 index);
    error AboveMonthlyCap(address referrer);
    error NotOpenable(uint256 openableAt);
    error AlreadyOpened();
    error NotOpen();
    error PeriodIsClosed();
    error NothingToClaim();
    error ClaimWindowOpen(uint256 closableAt);
    error PriceNotReady();
    error TransferFailed();

    uint8 public constant KIND_CASHBACK = 1;
    uint8 public constant KIND_REFERRAL = 2;
    uint256 private constant BPS = 10_000;
    uint64 public constant MAX_LAG = 35 days;

    IOrryToken public immutable orry;
    IOrryPriceOracle public immutable orryPrice;
    ReferralRegistry public immutable registry;
    uint64 public immutable HOLD;
    uint64 public immutable CLAIM_WINDOW;
    uint64 public immutable REFERRAL_WINDOW;
    uint256 public immutable MONTHLY_CAP_USD;
    uint16 public immutable MAX_SHARE_BPS;
    uint16 public immutable MAX_CASHBACK_BPS;

    address public admin;
    address public pendingAdmin;
    address public publisher;
    uint256 public totalReserved;

    mapping(uint256 month => Period) private _periods;
    mapping(address account => mapping(uint256 month => uint256)) public owedUsd;
    mapping(address account => mapping(uint256 month => bool)) public claimedMonth;
    mapping(address referrer => mapping(uint256 month => uint256)) public referralUsd;
    mapping(bytes32 key => bool) public seen;

    struct Config {
        uint64 hold;
        uint64 claimWindow;
        uint64 referralWindow;
        uint256 monthlyCapUsd;
        uint16 maxShareBps;
        uint16 maxCashbackBps;
    }

    constructor(address orry_, address orryPrice_, address registry_, address admin_, Config memory c) {
        if (orry_ == address(0) || orryPrice_ == address(0) || registry_ == address(0) || admin_ == address(0)) {
            revert ZeroAddress();
        }
        require(c.hold != 0 && c.claimWindow != 0 && c.referralWindow != 0 && c.monthlyCapUsd != 0, "zero config");
        require(c.maxShareBps <= BPS && c.maxCashbackBps <= c.maxShareBps, "share bps");
        orry = IOrryToken(orry_);
        orryPrice = IOrryPriceOracle(orryPrice_);
        registry = ReferralRegistry(registry_);
        admin = admin_;
        HOLD = c.hold;
        CLAIM_WINDOW = c.claimWindow;
        REFERRAL_WINDOW = c.referralWindow;
        MONTHLY_CAP_USD = c.monthlyCapUsd;
        MAX_SHARE_BPS = c.maxShareBps;
        MAX_CASHBACK_BPS = c.maxCashbackBps;
        emit AdminTransferred(address(0), admin_);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ------------------------------------------------------------------ views

    /// @notice ORRY held and not reserved for an opened month.
    function free() public view returns (uint256) {
        return orry.balanceOf(address(this)) - totalReserved;
    }

    function periodOf(uint256 month) external view returns (Period memory) {
        return _periods[month];
    }

    function currentMonth() external view returns (uint256) {
        return Months.monthOf(block.timestamp);
    }

    /// @notice When `month` (UTC calendar month index, year * 12 + month - 1) can be opened.
    function openableAt(uint256 month) public view returns (uint256) {
        return Months.startOf(month + 1) + HOLD;
    }

    /// @notice ORRY `account` can claim for `month` now (0 when not open, closed, claimed or nothing owed).
    function claimable(address account, uint256 month) public view returns (uint256) {
        Period storage p = _periods[month];
        if (p.openedAt == 0 || p.closed || claimedMonth[account][month] || p.totalUsd == 0) return 0;
        return FullMath.mulDiv(owedUsd[account][month], p.reserve, p.totalUsd);
    }

    // ------------------------------------------------------------------ accruals (publisher)

    function accrue(Accrual[] calldata records) external {
        if (msg.sender != publisher) revert NotPublisher();
        uint256 month = Months.monthOf(block.timestamp);
        Period storage p = _periods[month];
        for (uint256 i; i < records.length; ++i) {
            Accrual calldata r = records[i];
            if (r.account == address(0) || r.rewardUsd == 0) revert BadAccrual(i);
            if (r.feePaidAt > block.timestamp || r.feePaidAt + MAX_LAG < block.timestamp) revert BadAccrual(i);
            if (r.kind == KIND_CASHBACK) {
                if (r.referee != address(0)) revert BadAccrual(i);
                if (uint256(r.rewardUsd) * BPS > uint256(r.feeUsd) * MAX_CASHBACK_BPS) revert BadAccrual(i);
            } else if (r.kind == KIND_REFERRAL) {
                if (uint256(r.rewardUsd) * BPS > uint256(r.feeUsd) * MAX_SHARE_BPS) revert BadAccrual(i);
                if (registry.referrerOf(r.referee) != r.account) revert BadAccrual(i);
                uint64 at = registry.linkedAt(r.referee);
                if (r.feePaidAt < at || r.feePaidAt >= at + REFERRAL_WINDOW) revert BadAccrual(i);
                uint256 used = referralUsd[r.account][month] + r.rewardUsd;
                if (used > MONTHLY_CAP_USD) revert AboveMonthlyCap(r.account);
                referralUsd[r.account][month] = used;
            } else {
                revert BadAccrual(i);
            }
            bytes32 key = keccak256(abi.encode(r.ref, r.kind, r.account));
            if (seen[key]) revert DuplicateAccrual(i);
            seen[key] = true;
            owedUsd[r.account][month] += r.rewardUsd;
            p.totalUsd += r.rewardUsd;
            emit Accrued(r.account, r.kind, month, r.referee, r.feeUsd, r.rewardUsd, r.feePaidAt, r.ref);
        }
    }

    // ------------------------------------------------------------------ periods

    /// @notice Admin, before `month` opens: removes `account`'s accruals of that month (its referral cap use stays).
    function voidMonth(address account, uint256 month) external onlyAdmin {
        Period storage p = _periods[month];
        if (p.openedAt != 0) revert AlreadyOpened();
        uint256 usd = owedUsd[account][month];
        if (usd == 0) revert NothingToClaim();
        owedUsd[account][month] = 0;
        p.totalUsd -= uint128(usd);
        emit MonthVoided(account, month, usd);
    }

    /// @notice Anyone, `HOLD` after `month` ends: prices its total and reserves `min(needed, free)`.
    function openPeriod(uint256 month) external returns (uint256 reserve) {
        Period storage p = _periods[month];
        if (p.openedAt != 0) revert AlreadyOpened();
        uint256 at = openableAt(month);
        if (block.timestamp < at) revert NotOpenable(at);
        uint256 needed;
        if (p.totalUsd != 0) {
            if (!_ready()) revert PriceNotReady();
            try orryPrice.orryFor(p.totalUsd) returns (uint256 n) {
                needed = n;
            } catch {
                revert PriceNotReady();
            }
            uint256 f = free();
            reserve = needed < f ? needed : f;
        }
        p.openedAt = uint64(block.timestamp);
        p.reserve = reserve;
        p.left = reserve;
        totalReserved += reserve;
        emit PeriodOpened(month, p.totalUsd, needed, reserve);
    }

    function claim(uint256[] calldata months) external returns (uint256) {
        return _claim(msg.sender, months);
    }

    /// @notice Anyone pays `account`'s rewards to `account` and nowhere else (a later stateless ClaimAll can call it).
    function claimFor(address account, uint256[] calldata months) external returns (uint256) {
        return _claim(account, months);
    }

    function _claim(address account, uint256[] calldata months) private returns (uint256 total) {
        bool any;
        for (uint256 i; i < months.length; ++i) {
            uint256 month = months[i];
            Period storage p = _periods[month];
            if (p.openedAt == 0) revert NotOpen();
            if (p.closed) revert PeriodIsClosed();
            uint256 usd = owedUsd[account][month];
            if (usd == 0 || claimedMonth[account][month]) revert NothingToClaim();
            claimedMonth[account][month] = true;
            any = true;
            uint256 amount = FullMath.mulDiv(usd, p.reserve, p.totalUsd);
            p.left -= amount;
            totalReserved -= amount;
            total += amount;
            emit RewardClaimed(account, month, usd, amount);
        }
        if (!any) revert NothingToClaim();
        if (total != 0) {
            uint256 before = orry.balanceOf(account);
            if (!orry.transfer(account, total)) revert TransferFailed();
            if (orry.balanceOf(account) - before != total) revert TransferFailed();
        }
    }

    /// @notice Anyone, `CLAIM_WINDOW` after `month` opened: what is unclaimed returns to the free balance.
    function closePeriod(uint256 month) external returns (uint256 returned) {
        Period storage p = _periods[month];
        if (p.openedAt == 0) revert NotOpen();
        if (p.closed) revert PeriodIsClosed();
        uint256 at = uint256(p.openedAt) + CLAIM_WINDOW;
        if (block.timestamp < at) revert ClaimWindowOpen(at);
        p.closed = true;
        returned = p.left;
        p.left = 0;
        totalReserved -= returned;
        emit PeriodClosed(month, returned);
    }

    // ------------------------------------------------------------------ roles

    function setPublisher(address next) external onlyAdmin {
        publisher = next;
        emit PublisherSet(next);
    }

    function transferAdmin(address next) external onlyAdmin {
        pendingAdmin = next;
        emit AdminTransferStarted(admin, next);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin || msg.sender == address(0)) revert NotAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    function _ready() private view returns (bool) {
        try orryPrice.ready() returns (bool r) {
            return r;
        } catch {
            return false;
        }
    }
}
