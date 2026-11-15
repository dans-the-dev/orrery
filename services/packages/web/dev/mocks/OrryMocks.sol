// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Development walk harness for the web app only: minimal stand-ins with the frozen ORRY ABIs
// (services/packages/shared/src/orry-abi.ts) so every button can send a real transaction to a local anvil.
// Never deployed anywhere else. The real contracts are lanes A and B.

contract MockOrry {
    string public constant name = "ORRY";
    string public constant symbol = "ORRY";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event Burned(uint8 indexed source, uint256 amount);

    function mint(address to, uint256 amount) external { totalSupply += amount; balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; emit Approval(msg.sender, s, a); return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) { _spend(f, a); _move(f, to, a); return true; }
    function burn(uint256 a) external { _burn(msg.sender, a); }
    function burnFrom(address f, uint256 a) external { _spend(f, a); _burn(f, a); }
    function _spend(address f, uint256 a) internal { if (f != msg.sender) { require(allowance[f][msg.sender] >= a, "allowance"); allowance[f][msg.sender] -= a; } }
    function _move(address f, address to, uint256 a) internal { require(balanceOf[f] >= a, "balance"); balanceOf[f] -= a; balanceOf[to] += a; emit Transfer(f, to, a); }
    function _burn(address f, uint256 a) internal { require(balanceOf[f] >= a, "balance"); balanceOf[f] -= a; totalSupply -= a; emit Transfer(f, address(0), a); }
}

contract MockHook {
    function LP_FEE() external pure returns (uint24) { return 8500; }
    function protocolFeePips() external pure returns (uint24) { return 1500; }
}

contract MockVault {
    error SharesLocked(uint64 unlockAt);
    error ZeroAmount();
    error InsufficientShares();
    MockOrry public immutable orry;
    address public immutable hook;
    uint64 public constant DEPOSIT_LOCK = 900;
    uint64 public constant STREAM_PERIOD = 7 days;
    uint16 public constant MAX_BLOCK_MOVE_BPS = 100;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    mapping(address => uint64) public unlockAt;
    mapping(address => uint256) internal feeEth;
    mapping(address => uint256) internal feeRc;
    event Deposited(address indexed account, uint256 ethIn, uint256 orryIn, uint256 shares, uint64 unlockAt);
    event Withdrawn(address indexed account, uint256 shares, uint256 ethOut, uint256 orryOut);
    event FeesClaimed(address indexed account, address indexed caller, uint256 ethAmount, uint256 orryAmount);

    constructor(MockOrry r, address h) { orry = r; hook = h; }

    function _poolEth() internal view returns (uint256) { return address(this).balance - _feesEthTotal; }
    function _poolRc() internal view returns (uint256) { return orry.balanceOf(address(this)) - _feesRcTotal; }
    uint256 internal _feesEthTotal;
    uint256 internal _feesRcTotal;

    function _mint(address a, uint256 s) internal { sharesOf[a] += s; totalShares += s; unlockAt[a] = uint64(block.timestamp + DEPOSIT_LOCK); }

    function deposit(uint256 orryMax, uint256 minShares, uint256) external payable returns (uint256 shares) {
        if (msg.value == 0 && orryMax == 0) revert ZeroAmount();
        if (orryMax > 0) orry.transferFrom(msg.sender, address(this), orryMax);
        shares = msg.value / 1e9 + orryMax / 1e13;
        require(shares >= minShares, "SlippageExceeded");
        _mint(msg.sender, shares);
        emit Deposited(msg.sender, msg.value, orryMax, shares, unlockAt[msg.sender]);
    }
    function zapDeposit(bool fromEth, uint256 amountIn, uint256, uint256 minShares, uint256) external payable returns (uint256 shares) {
        if (amountIn == 0) revert ZeroAmount();
        if (fromEth) require(msg.value == amountIn, "value");
        else orry.transferFrom(msg.sender, address(this), amountIn);
        shares = fromEth ? amountIn / 1e9 : amountIn / 1e13;
        require(shares >= minShares, "SlippageExceeded");
        _mint(msg.sender, shares);
        emit Deposited(msg.sender, fromEth ? amountIn : 0, fromEth ? 0 : amountIn, shares, unlockAt[msg.sender]);
    }
    function previewWithdraw(uint256 s) public view returns (uint256 e, uint256 r) {
        if (totalShares == 0) return (0, 0);
        e = _poolEth() * s / totalShares; r = _poolRc() * s / totalShares;
    }
    function positionAmounts() external view returns (uint256, uint256) { return (_poolEth(), _poolRc()); }
    function withdraw(uint256 s, uint256 minE, uint256 minR, uint256) external returns (uint256 e, uint256 r) {
        if (block.timestamp < unlockAt[msg.sender]) revert SharesLocked(unlockAt[msg.sender]);
        if (s == 0 || s > sharesOf[msg.sender]) revert InsufficientShares();
        (e, r) = previewWithdraw(s);
        require(e >= minE && r >= minR, "SlippageExceeded");
        sharesOf[msg.sender] -= s; totalShares -= s;
        _pay(msg.sender);
        orry.transfer(msg.sender, r);
        (bool ok,) = msg.sender.call{value: e}(""); require(ok, "eth");
        emit Withdrawn(msg.sender, s, e, r);
    }
    function harvest() external pure returns (uint256, uint256) { return (0, 0); }
    function pendingFees(address a) external view returns (uint256, uint256) { return (feeEth[a], feeRc[a]); }
    /// @dev harness: credits fees to an account, funded by the caller
    function seedFees(address a, uint256 rc) external payable { orry.transferFrom(msg.sender, address(this), rc); feeEth[a] += msg.value; feeRc[a] += rc; _feesEthTotal += msg.value; _feesRcTotal += rc; }
    function claimFees() external returns (uint256, uint256) { return _pay(msg.sender); }
    function claimFor(address a) external returns (uint256, uint256) { return _pay(a); }
    function _pay(address a) internal returns (uint256 e, uint256 r) {
        e = feeEth[a]; r = feeRc[a]; feeEth[a] = 0; feeRc[a] = 0; _feesEthTotal -= e; _feesRcTotal -= r;
        if (r > 0) orry.transfer(a, r);
        if (e > 0) { (bool ok,) = a.call{value: e}(""); require(ok, "eth"); }
        emit FeesClaimed(a, msg.sender, e, r);
    }
}

contract MockStaking {
    error NothingReady();
    error InsufficientActive();
    error ZeroAmount();
    error PositionHeldByAnotherStaker();
    error AgentStakeLocked(uint64 lockedUntil);
    error LockNotExtended();
    struct AgentPosition { address staker; uint128 active; uint128 leaving; uint64 leavingAt; uint64 lockedUntil; }
    MockOrry public immutable orry;
    address public immutable identityRegistry;
    uint64 public constant PLAIN_COOLDOWN = 7 days;
    uint64 public constant AGENT_COOLDOWN = 14 days;
    uint64 public constant STREAM_PERIOD = 7 days;
    uint64 public constant MAX_AGENT_LOCK = 365 days;
    uint256 public totalEarning;
    mapping(address => uint256) internal pActive;
    mapping(address => uint256) internal pLeaving;
    mapping(address => uint64) internal pReady;
    mapping(address => uint256) public earningBalance;
    mapping(uint256 => mapping(address => AgentPosition)) internal pos;
    mapping(address => uint256) internal rEth;
    mapping(address => uint256) internal rRc;
    event Staked(address indexed account, uint256 amount);
    event RewardsClaimed(address indexed account, address indexed caller, uint256 ethAmount, uint256 orryAmount);

    constructor(MockOrry r, address reg) { orry = r; identityRegistry = reg; }
    function _owner(uint256 id) internal view returns (address) { return MockRegistry(identityRegistry).ownerOf(id); }

    function stake(uint256 a) external { if (a == 0) revert ZeroAmount(); orry.transferFrom(msg.sender, address(this), a); pActive[msg.sender] += a; earningBalance[msg.sender] += a; totalEarning += a; emit Staked(msg.sender, a); }
    function requestUnstake(uint256 a) external { if (a == 0) revert ZeroAmount(); if (a > pActive[msg.sender]) revert InsufficientActive(); pActive[msg.sender] -= a; earningBalance[msg.sender] -= a; totalEarning -= a; pLeaving[msg.sender] += a; pReady[msg.sender] = uint64(block.timestamp + PLAIN_COOLDOWN); }
    function withdraw() external returns (uint256 a) { a = pLeaving[msg.sender]; if (a == 0 || block.timestamp < pReady[msg.sender]) revert NothingReady(); pLeaving[msg.sender] = 0; pReady[msg.sender] = 0; orry.transfer(msg.sender, a); }
    function stakeForAgent(uint256 id, uint256 a) external {
        if (a == 0) revert ZeroAmount();
        address o = _owner(id);
        AgentPosition storage p = pos[id][o];
        if (p.staker != address(0) && p.staker != msg.sender) revert PositionHeldByAnotherStaker();
        orry.transferFrom(msg.sender, address(this), a);
        p.staker = msg.sender; p.active += uint128(a); earningBalance[msg.sender] += a; totalEarning += a;
    }
    function requestAgentUnstake(uint256 id, address o, uint256 a) external {
        AgentPosition storage p = pos[id][o];
        require(p.staker == msg.sender, "NotStaker");
        if (block.timestamp < p.lockedUntil) revert AgentStakeLocked(p.lockedUntil);
        if (a == 0) revert ZeroAmount(); if (a > p.active) revert InsufficientActive();
        p.active -= uint128(a); p.leaving += uint128(a); p.leavingAt = uint64(block.timestamp + AGENT_COOLDOWN);
        earningBalance[msg.sender] -= a; totalEarning -= a;
    }
    function withdrawAgent(uint256 id, address o) external returns (uint256 a) {
        AgentPosition storage p = pos[id][o];
        require(p.staker == msg.sender, "NotStaker");
        a = p.leaving; if (a == 0 || block.timestamp < p.leavingAt) revert NothingReady();
        p.leaving = 0; p.leavingAt = 0; orry.transfer(msg.sender, a);
    }
    function extendAgentLock(uint256 id, uint64 until) external {
        AgentPosition storage p = pos[id][_owner(id)];
        require(p.staker == msg.sender, "NotStaker");
        if (until <= p.lockedUntil) revert LockNotExtended();
        require(until <= block.timestamp + MAX_AGENT_LOCK, "LockTooLong");
        p.lockedUntil = until;
    }
        function plainStake(address a) external view returns (uint256, uint256, uint64) { return (pActive[a], pLeaving[a], pReady[a]); }
    function agentStake(uint256 id) external view returns (AgentPosition memory) { return pos[id][_owner(id)]; }
    function agentStakeOf(uint256 id, address o) external view returns (AgentPosition memory) { return pos[id][o]; }
    function pendingRewards(address a) external view returns (uint256, uint256) { return (rEth[a], rRc[a]); }
    /// @dev harness: credits rewards to an account, funded by the caller
    function seedRewards(address a, uint256 rc) external payable { orry.transferFrom(msg.sender, address(this), rc); rEth[a] += msg.value; rRc[a] += rc; }
    function notifyRewards(uint256) external payable {}
    function claimRewards() external returns (uint256, uint256) { return _pay(msg.sender); }
    function claimFor(address a) external returns (uint256, uint256) { return _pay(a); }
    function _pay(address a) internal returns (uint256 e, uint256 r) {
        e = rEth[a]; r = rRc[a]; rEth[a] = 0; rRc[a] = 0;
        if (r > 0) orry.transfer(a, r);
        if (e > 0) { (bool ok,) = a.call{value: e}(""); require(ok, "eth"); }
        emit RewardsClaimed(a, msg.sender, e, r);
    }
}

contract MockRouter {
    error NothingToDistribute();
    error TooSoon(uint64 nextAt);
    MockOrry public immutable orry;
    uint64 public constant MIN_INTERVAL = 1 hours;
    uint16 public constant STAKERS_BPS = 5000;
    uint64 public lastDistributionAt;
    constructor(MockOrry r) { orry = r; }
    receive() external payable {}
    function distribute() external {
        if (block.timestamp < lastDistributionAt + MIN_INTERVAL) revert TooSoon(lastDistributionAt + MIN_INTERVAL);
        uint256 rc = orry.balanceOf(address(this));
        if (address(this).balance == 0 && rc == 0) revert NothingToDistribute();
        lastDistributionAt = uint64(block.timestamp);
        if (rc > 0) orry.burn(rc);
        if (address(this).balance > 0) { (bool ok,) = address(0xdead).call{value: address(this).balance}(""); require(ok); }
    }
}

contract MockClaimAll {
    MockVault public immutable earnVault;
    MockStaking public immutable staking;
    constructor(MockVault v, MockStaking s) { earnVault = v; staking = s; }
    function claimAll() external returns (uint256 e, uint256 r) {
        (uint256 e1, uint256 r1) = earnVault.claimFor(msg.sender);
        (uint256 e2, uint256 r2) = staking.claimFor(msg.sender);
        return (e1 + e2, r1 + r2);
    }
}

contract MockRegistry {
    address public immutable holder;
    constructor(address h) { holder = h; }
    function ownerOf(uint256) external view returns (address) { return holder; }
}

contract MockTreasury {
    error QuoteExpired();
    error QuoteUsed();
    MockOrry public immutable orry;
    mapping(bytes32 => bool) public quoteUsed;
    event CreditsPaid(address indexed buyer, uint32 packs, uint256 orryAmount, bytes32 indexed quoteId);
    event VerificationBurned(uint256 indexed agentId, address indexed payer, uint256 orryAmount, bytes32 indexed quoteId);
    constructor(MockOrry r) { orry = r; }
    function _use(bytes32 q, uint64 expiry) internal { if (expiry < block.timestamp) revert QuoteExpired(); if (quoteUsed[q]) revert QuoteUsed(); quoteUsed[q] = true; }
    function burnForCredits(uint32 packs, uint256 amount, bytes32 q, uint64 expiry, bytes calldata) external { _use(q, expiry); orry.burnFrom(msg.sender, amount); emit CreditsPaid(msg.sender, packs, amount, q); }
    function verifyWithOrry(uint256 id, address, uint256 amount, bytes32 q, uint64 expiry, bytes calldata) external { _use(q, expiry); orry.burnFrom(msg.sender, amount); emit VerificationBurned(id, msg.sender, amount, q); }
}
