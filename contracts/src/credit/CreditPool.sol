// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Min, IIdentityRegistry} from "../interfaces/IExternal.sol";
import {IOrryPriceOracle} from "../markets/interfaces/IMarketPricing.sol";
import {CreditRevenueRouter} from "./CreditRevenueRouter.sol";

interface IAttestorVerified {
    function isVerified(uint256 agentId) external view returns (bool);
}

/// @title CreditPool
/// @notice One Orrery Credit market (`docs/updates/L4-CREDIT-SPEC.md` 3.4, custody pattern C): lenders' USDG and the
///         ORRY first-loss bonds of this pool's lines, nothing else. A verified agent's owner posts an ORRY bond and
///         draws USDG into the agent wallet up to a limit set by the bond's USD value, the agent's repayment tier and two
///         caps. The line's router (the agent's x402 `payTo`) repays first. A line still owing `grace` after its due date
///         can be liquidated by anyone: the whole bond goes to this pool's lenders and the unpaid debt stays owed as a
///         recovery. Lender value is cash plus outstanding principal; interest counts when it is paid. No admin power
///         over deposits, bonds or debt; the factory can only `retire` the pool (no new deposits or draws).
contract CreditPool is ReentrancyGuard {
    uint16 private constant BPS = 10_000;
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant ACC = 1e36;
    uint256 private constant YEAR = 365 days;
    uint256 public constant TIERS = 4;

    struct Params {
        uint16 aprBps;
        uint16 feeBps;
        uint16 repayBps;
        uint16 maxLineBps;
        uint32 term;
        uint32 grace;
        uint128 minBondUsd;
        uint128 maxLineUsdg;
        uint128[4] tierRepaid;
        uint16[4] tierMultBps;
    }

    struct Line {
        address bondOwner;
        address router;
        uint128 bond;
        uint128 principal;
        uint128 interest;
        uint128 recovery;
        uint128 repaidUsdDays; // principal repaid times its age in days (capped at `term`): the tier record
        uint64 lastAccrual;
        uint64 dueAt;
        bool defaulted;
    }

    IERC20Min public immutable usdg;
    IERC20Min public immutable orry;
    IOrryPriceOracle public immutable oracle;
    IIdentityRegistry public immutable identity;
    IAttestorVerified public immutable attestor;
    address public immutable treasury;
    address public immutable factory;

    uint16 public immutable aprBps;
    uint16 public immutable feeBps;
    uint16 public immutable repayBps;
    uint16 public immutable maxLineBps;
    uint32 public immutable term;
    uint32 public immutable grace;
    uint128 public immutable minBondUsd;
    uint128 public immutable maxLineUsdg;
    uint128 internal immutable _tr1;
    uint128 internal immutable _tr2;
    uint128 internal immutable _tr3;
    uint16 internal immutable _tm0;
    uint16 internal immutable _tm1;
    uint16 internal immutable _tm2;
    uint16 internal immutable _tm3;

    bool public retired;
    uint256 public cash;
    uint256 public totalPrincipal;
    uint256 public totalShares;
    uint256 public totalBonds;
    uint256 public accOrryPerShare;
    uint256 public undistributedOrry;
    uint256 public seizedUnclaimed;
    mapping(address => uint256) public sharesOf;
    mapping(address => uint256) internal _orryDebt;
    mapping(address => uint256) internal _orryPending;
    mapping(uint256 agentId => Line) internal _lines;

    event Deposited(address indexed lender, uint256 assets, uint256 shares);
    event Withdrawn(address indexed lender, uint256 assets, uint256 shares);
    event OrryClaimed(address indexed lender, uint256 amount);
    event LineOpened(uint256 indexed agentId, address indexed bondOwner, address router);
    event BondPosted(uint256 indexed agentId, address indexed bondOwner, uint256 amount, uint256 bond);
    event BondWithdrawn(uint256 indexed agentId, address indexed bondOwner, uint256 amount, uint256 bond);
    event Drawn(uint256 indexed agentId, address indexed to, uint256 amount, uint256 principal, uint64 dueAt);
    event Repaid(
        uint256 indexed agentId, address indexed payer, uint256 toInterest, uint256 fee, uint256 toPrincipal, uint256 toRecovery
    );
    event Liquidated(uint256 indexed agentId, address indexed by, uint256 principal, uint256 interest, uint256 bondSeized);
    event Retired();

    error ZeroAmount();
    error ZeroAddress();
    error BadParams();
    error PoolRetired();
    error NotFactory();
    error ZeroShares();
    error InsufficientCash();
    error InexactTransfer();
    error TransferFailed();
    error NotAgentOwner();
    error NotBondOwner();
    error LineDefaulted();
    error DebtOutstanding();
    error NotVerified();
    error BondTooSmall();
    error OverLimit(uint256 limit);
    error NothingOwed();
    error NotDue();
    error InsufficientShares();

    constructor(
        IERC20Min usdg_,
        IERC20Min orry_,
        IOrryPriceOracle oracle_,
        IIdentityRegistry identity_,
        IAttestorVerified attestor_,
        address treasury_,
        Params memory p
    ) {
        if (
            address(usdg_) == address(0) || address(orry_) == address(0) || address(oracle_) == address(0)
                || address(identity_) == address(0) || address(attestor_) == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        if (p.aprBps == 0 || p.aprBps > 5000 || p.feeBps > 2000 || p.repayBps == 0 || p.repayBps > BPS) revert BadParams();
        if (p.maxLineBps == 0 || p.maxLineBps > BPS || p.term < 1 days || p.grace < 1 days) revert BadParams();
        if (p.maxLineUsdg == 0 || p.tierRepaid[0] != 0 || p.tierMultBps[0] == 0) revert BadParams();
        for (uint256 i = 1; i < TIERS; ++i) {
            if (p.tierRepaid[i] <= p.tierRepaid[i - 1] || p.tierMultBps[i] < p.tierMultBps[i - 1]) revert BadParams();
        }
        if (p.tierMultBps[3] > 50_000) revert BadParams();
        usdg = usdg_;
        orry = orry_;
        oracle = oracle_;
        identity = identity_;
        attestor = attestor_;
        treasury = treasury_;
        factory = msg.sender;
        aprBps = p.aprBps;
        feeBps = p.feeBps;
        repayBps = p.repayBps;
        maxLineBps = p.maxLineBps;
        term = p.term;
        grace = p.grace;
        minBondUsd = p.minBondUsd;
        maxLineUsdg = p.maxLineUsdg;
        _tr1 = p.tierRepaid[1];
        _tr2 = p.tierRepaid[2];
        _tr3 = p.tierRepaid[3];
        _tm0 = p.tierMultBps[0];
        _tm1 = p.tierMultBps[1];
        _tm2 = p.tierMultBps[2];
        _tm3 = p.tierMultBps[3];
    }

    // ------------------------------------------------------------------ lenders

    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (retired) revert PoolRetired();
        if (assets == 0) revert ZeroAmount();
        shares = assets * (totalShares + VIRTUAL_SHARES) / (totalAssets() + 1);
        if (shares == 0) revert ZeroShares();
        _settle(msg.sender);
        _pullExact(usdg, msg.sender, assets);
        cash += assets;
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        _orryDebt[msg.sender] = _accrued(sharesOf[msg.sender], true);
        if (undistributedOrry != 0) _distribute(0);
        emit Deposited(msg.sender, assets, shares);
    }

    /// @notice Never paused; limited only by the USDG not lent out.
    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (shares > sharesOf[msg.sender]) revert InsufficientShares();
        assets = previewWithdraw(shares);
        if (assets > cash) revert InsufficientCash();
        _settle(msg.sender);
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        _orryDebt[msg.sender] = _accrued(sharesOf[msg.sender], true);
        cash -= assets;
        _send(usdg, msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    /// @notice ORRY from seized bonds owed to the caller's shares.
    function claimOrry() external nonReentrant returns (uint256 amount) {
        _settle(msg.sender);
        _orryDebt[msg.sender] = _accrued(sharesOf[msg.sender], true);
        amount = _orryPending[msg.sender];
        if (amount == 0) revert ZeroAmount();
        _orryPending[msg.sender] = 0;
        seizedUnclaimed -= amount;
        _send(orry, msg.sender, amount);
        emit OrryClaimed(msg.sender, amount);
    }

    // ------------------------------------------------------------------ lines

    /// @notice The agent's owner locks ORRY behind `agentId`; the first post opens the line and its router.
    function postBond(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Line storage l = _lines[agentId];
        if (l.defaulted) revert LineDefaulted();
        if (l.bondOwner != msg.sender) {
            // a new owner takes over a line only while it holds no bond and no debt
            if (l.bond != 0 || l.principal != 0 || l.interest != 0) revert NotBondOwner();
            if (identity.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
            l.bondOwner = msg.sender;
        }
        if (l.router == address(0)) {
            l.router = address(new CreditRevenueRouter(address(this), usdg, agentId, repayBps));
            l.lastAccrual = uint64(block.timestamp);
            emit LineOpened(agentId, msg.sender, l.router);
        }
        _pullExact(orry, msg.sender, amount);
        l.bond += _u128(amount);
        totalBonds += amount;
        emit BondPosted(agentId, msg.sender, amount, l.bond);
    }

    function withdrawBond(uint256 agentId, uint256 amount) external nonReentrant {
        Line storage l = _lines[agentId];
        if (l.bondOwner != msg.sender) revert NotBondOwner();
        if (amount == 0) revert ZeroAmount();
        if (l.principal != 0 || l.interest != 0) revert DebtOutstanding();
        l.bond -= _u128(amount);
        totalBonds -= amount;
        _send(orry, msg.sender, amount);
        emit BondWithdrawn(agentId, msg.sender, amount, l.bond);
    }

    function draw(uint256 agentId, uint256 amount) external nonReentrant {
        if (retired) revert PoolRetired();
        if (amount == 0) revert ZeroAmount();
        Line storage l = _lines[agentId];
        if (l.defaulted) revert LineDefaulted();
        if (l.bondOwner != msg.sender) revert NotBondOwner();
        if (identity.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        if (!attestor.isVerified(agentId)) revert NotVerified();
        _accrue(l);
        uint256 bondUsd = oracle.usdValue(l.bond);
        if (bondUsd < minBondUsd || bondUsd == 0) revert BondTooSmall();
        uint256 limit = _limit(l, bondUsd);
        uint256 debt = uint256(l.principal) + l.interest;
        if (debt + amount > limit) revert OverLimit(limit);
        if (amount > cash) revert InsufficientCash();
        if (debt == 0) l.dueAt = uint64(block.timestamp) + term;
        l.principal += _u128(amount);
        totalPrincipal += amount;
        cash -= amount;
        address to = payoutOf(agentId);
        _send(usdg, to, amount);
        emit Drawn(agentId, to, amount, l.principal, l.dueAt);
    }

    /// @notice Anyone repays a line: interest first (Orrery's `feeBps` of it to the treasury), then principal, then a
    ///         recovery after default. Pulls only what is owed and returns it.
    function repay(uint256 agentId, uint256 amount) external nonReentrant returns (uint256 paid) {
        Line storage l = _lines[agentId];
        _accrue(l);
        uint256 owed = uint256(l.interest) + l.principal + l.recovery;
        if (owed == 0) revert NothingOwed();
        if (amount == 0) revert ZeroAmount();
        paid = amount < owed ? amount : owed;
        _pullExact(usdg, msg.sender, paid);
        uint256 rest = paid;
        uint256 toInterest = rest < l.interest ? rest : l.interest;
        uint256 fee = toInterest * feeBps / BPS;
        l.interest -= _u128(toInterest);
        rest -= toInterest;
        uint256 toPrincipal = rest < l.principal ? rest : l.principal;
        if (toPrincipal != 0) {
            // age of the debt since it went from zero to positive, capped at the term: cycling a line fast earns nothing
            uint256 age = block.timestamp - (uint256(l.dueAt) - term);
            if (age > term) age = term;
            l.repaidUsdDays += _u128(toPrincipal * age / 1 days);
        }
        l.principal -= _u128(toPrincipal);
        totalPrincipal -= toPrincipal;
        rest -= toPrincipal;
        uint256 toRecovery = rest; // rest <= recovery because paid <= owed
        l.recovery -= _u128(toRecovery);
        if (l.principal == 0 && l.interest == 0) l.dueAt = 0;
        cash += paid - fee;
        _send(usdg, treasury, fee);
        emit Repaid(agentId, msg.sender, toInterest, fee, toPrincipal, toRecovery);
    }

    /// @notice Anyone, once a line still owes `grace` after its due date: the whole bond goes to this pool's lenders,
    ///         the principal is written off and the unpaid debt stays owed as a recovery. Terminal for the line.
    function liquidate(uint256 agentId) external nonReentrant {
        Line storage l = _lines[agentId];
        _accrue(l);
        uint256 principal = l.principal;
        uint256 interest = l.interest;
        if (principal + interest == 0) revert NothingOwed();
        if (block.timestamp <= uint256(l.dueAt) + grace) revert NotDue();
        l.recovery += _u128(principal + interest);
        l.principal = 0;
        l.interest = 0;
        l.dueAt = 0;
        l.defaulted = true;
        totalPrincipal -= principal;
        uint256 seized = l.bond;
        l.bond = 0;
        totalBonds -= seized;
        seizedUnclaimed += seized;
        _distribute(seized);
        emit Liquidated(agentId, msg.sender, principal, interest, seized);
    }

    function retire() external {
        if (msg.sender != factory) revert NotFactory();
        retired = true;
        emit Retired();
    }

    // ------------------------------------------------------------------ views

    function totalAssets() public view returns (uint256) {
        return cash + totalPrincipal;
    }

    function previewWithdraw(uint256 shares) public view returns (uint256) {
        return shares * (totalAssets() + 1) / (totalShares + VIRTUAL_SHARES);
    }

    function valueOf(address lender) external view returns (uint256) {
        return previewWithdraw(sharesOf[lender]);
    }

    function orryClaimable(address lender) external view returns (uint256) {
        uint256 accrued = _accrued(sharesOf[lender], false);
        uint256 debt = _orryDebt[lender];
        return _orryPending[lender] + (accrued > debt ? accrued - debt : 0);
    }

    function lineOf(uint256 agentId) external view returns (Line memory l) {
        l = _lines[agentId];
        l.interest += _u128(_pendingInterest(l));
    }

    /// @notice What the line owes now: principal, interest accrued to this block and any recovery.
    function owedOf(uint256 agentId) external view returns (uint256) {
        Line memory l = _lines[agentId];
        return uint256(l.principal) + l.interest + _pendingInterest(l) + l.recovery;
    }

    function routerOf(uint256 agentId) external view returns (address) {
        return _lines[agentId].router;
    }

    /// @notice Where drawn USDG and router revenue go: the ERC-8004 agent wallet, else the agent's owner, else the bond
    ///         owner.
    function payoutOf(uint256 agentId) public view returns (address) {
        try identity.getAgentWallet(agentId) returns (address w) {
            if (w != address(0)) return w;
        } catch {}
        try identity.ownerOf(agentId) returns (address o) {
            if (o != address(0)) return o;
        } catch {}
        return _lines[agentId].bondOwner;
    }

    /// @notice The bond multiple for a line with `usdDays` of repaid principal-days.
    function tierMultBps(uint256 usdDays) public view returns (uint16) {
        if (usdDays >= _tr3) return _tm3;
        if (usdDays >= _tr2) return _tm2;
        if (usdDays >= _tr1) return _tm1;
        return _tm0;
    }

    /// @notice The line's limit now (0 while the price oracle is not ready).
    function limitOf(uint256 agentId) external view returns (uint256) {
        Line storage l = _lines[agentId];
        try oracle.usdValue(l.bond) returns (uint256 bondUsd) {
            if (bondUsd < minBondUsd) return 0;
            return _limit(l, bondUsd);
        } catch {
            return 0;
        }
    }

    function tiers() external view returns (uint128[4] memory repaid, uint16[4] memory multBps) {
        repaid = [uint128(0), _tr1, _tr2, _tr3];
        multBps = [_tm0, _tm1, _tm2, _tm3];
    }

    // ------------------------------------------------------------------ internals

    function _limit(Line storage l, uint256 bondUsd) private view returns (uint256 limit) {
        limit = bondUsd * tierMultBps(l.repaidUsdDays) / BPS;
        if (limit > maxLineUsdg) limit = maxLineUsdg;
        uint256 poolCap = totalAssets() * maxLineBps / BPS;
        if (limit > poolCap) limit = poolCap;
    }

    function _pendingInterest(Line memory l) private view returns (uint256) {
        if (l.principal == 0 || block.timestamp <= l.lastAccrual) return 0;
        uint256 num = uint256(l.principal) * aprBps * (block.timestamp - l.lastAccrual);
        uint256 den = uint256(BPS) * YEAR;
        return (num + den - 1) / den;
    }

    function _accrue(Line storage l) private {
        uint256 add = _pendingInterest(l);
        if (add != 0) l.interest += _u128(add);
        l.lastAccrual = uint64(block.timestamp);
    }

    function _distribute(uint256 amount) private {
        uint256 total = undistributedOrry + amount;
        uint256 s = totalShares;
        if (s == 0) {
            undistributedOrry = total;
            return;
        }
        undistributedOrry = 0;
        accOrryPerShare += total * ACC / s;
    }

    /// @dev Shares times the accumulator; the checkpoint rounds up and the accrual down, so the sum of everything
    ///      claimable never exceeds what was distributed (CR-10).
    function _accrued(uint256 shares, bool up) private view returns (uint256) {
        uint256 v = shares * accOrryPerShare;
        return up ? (v + ACC - 1) / ACC : v / ACC;
    }

    function _settle(address lender) private {
        uint256 accrued = _accrued(sharesOf[lender], false);
        uint256 debt = _orryDebt[lender];
        if (accrued > debt) _orryPending[lender] += accrued - debt;
    }

    function _pullExact(IERC20Min token, address from, uint256 amount) private {
        uint256 before = token.balanceOf(address(this));
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeCall(IERC20Min.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        if (token.balanceOf(address(this)) != before + amount) revert InexactTransfer();
    }

    function _send(IERC20Min token, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20Min.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _u128(uint256 v) private pure returns (uint128) {
        if (v > type(uint128).max) revert BadParams();
        return uint128(v);
    }
}
