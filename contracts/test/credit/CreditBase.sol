// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrreryAttestor} from "../../src/OrreryAttestor.sol";
import {IIdentityRegistry, IERC20Min} from "../../src/interfaces/IExternal.sol";
import {IOrryToken} from "../../src/orry/interfaces/IOrryToken.sol";
import {IOrryPriceOracle} from "../../src/markets/interfaces/IMarketPricing.sol";
import {AttesterRegistry} from "../../src/credit/AttesterRegistry.sol";
import {AttesterFeeSplitter, IAttestorTreasuryView} from "../../src/credit/AttesterFeeSplitter.sol";
import {CreditPool, IAttestorVerified} from "../../src/credit/CreditPool.sol";
import {CreditPoolFactory} from "../../src/credit/CreditPoolFactory.sol";
import {MockIdentityRegistry, MockERC20} from "../mocks/Mocks.sol";

/// @notice ORRY stand-in: 18 decimals, burn and burnFrom (allowance checked), like the Pons V2 token.
contract CreditOrry is MockERC20 {
    constructor() MockERC20("Orrery", "ORRY", 18) {}

    function burn(uint256 a) external {
        _move(msg.sender, address(0xdead), a);
        balanceOf[address(0xdead)] -= a;
        totalSupply -= a;
    }

    function burnFrom(address f, uint256 a) external {
        uint256 al = allowance[f][msg.sender];
        require(al >= a, "allowance");
        allowance[f][msg.sender] = al - a;
        require(balanceOf[f] >= a, "balance");
        balanceOf[f] -= a;
        totalSupply -= a;
    }
}

/// @notice USDG stand-in with an issuer blocklist (a blocked address can neither send nor receive).
contract CreditUsdg is MockERC20 {
    mapping(address => bool) public blocked;

    constructor() MockERC20("Global Dollar", "USDG", 6) {}

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function _move(address f, address to, uint256 a) internal override {
        require(!blocked[f] && !blocked[to], "blocked");
        super._move(f, to, a);
    }
}

/// @notice The `OrreryTreasury` surface the lane reads: owner, orry, quote signers. Receives USDG like the real one.
contract CreditTreasury {
    address public owner;
    address public orry;
    mapping(address => bool) public isQuoteSigner;

    constructor(address owner_) {
        owner = owner_;
    }

    function setOrry(address r) external {
        orry = r;
    }

    function setQuoteSigner(address s, bool b) external {
        isQuoteSigner[s] = b;
    }

    function setOwner(address o) external {
        owner = o;
    }
}

/// @notice `IOrryPriceOracle` stand-in: `usdPerOrry` USDG base units per 1e18 ORRY; reverts while not ready.
contract CreditOracle {
    uint256 public usdPerOrry;
    bool public ready = true;

    error OracleNotReady();

    function set(uint256 usdPerOrry_) external {
        usdPerOrry = usdPerOrry_;
    }

    function setReady(bool r) external {
        ready = r;
    }

    function usdValue(uint256 orryAmount) external view returns (uint256) {
        if (!ready) revert OracleNotReady();
        return orryAmount * usdPerOrry / 1e18;
    }

    function orryFor(uint256 usd) external view returns (uint256) {
        if (!ready) revert OracleNotReady();
        return (usd * 1e18 + usdPerOrry - 1) / usdPerOrry;
    }
}

abstract contract CreditBase is Test {
    uint256 internal constant M = 1e18; // one ORRY
    uint256 internal constant U = 1e6; // one USDG
    uint256 internal constant MIN_STAKE = 1_000_000 * M;
    uint64 internal constant EPOCH = 7 days;
    uint64 internal constant UNLOCK = 14 days;

    address internal ops = makeAddr("ops"); // attestor owner and treasury owner
    address internal orreryProber = makeAddr("orreryProber");
    uint256 internal signerPk = 0xA11CE;
    address internal quoteSigner;

    MockIdentityRegistry internal identity;
    CreditUsdg internal usdg;
    CreditOrry internal orry;
    CreditTreasury internal treasury;
    CreditOracle internal oracle;
    OrreryAttestor internal attestor;
    AttesterRegistry internal registry;
    AttesterFeeSplitter internal splitter;
    CreditPoolFactory internal factory;
    CreditPool internal pool;

    uint64 internal genesis;
    uint256 internal clock; // own clock: via-IR may reuse block.timestamp across vm.warp

    function setUp() public virtual {
        clock = 1_800_000_000;
        vm.warp(clock);
        quoteSigner = vm.addr(signerPk);
        identity = new MockIdentityRegistry();
        usdg = new CreditUsdg();
        orry = new CreditOrry();
        treasury = new CreditTreasury(ops);
        treasury.setQuoteSigner(quoteSigner, true);
        oracle = new CreditOracle();
        oracle.set(10_000); // 0.01 USDG per ORRY
        attestor = new OrreryAttestor(IIdentityRegistry(address(identity)), IERC20Min(address(usdg)), ops, address(treasury), uint128(5 * U));
        genesis = uint64(clock);
        registry = new AttesterRegistry(IOrryToken(address(orry)), attestor, MIN_STAKE, 20, EPOCH, UNLOCK, genesis);
        splitter = new AttesterFeeSplitter(
            IERC20Min(address(usdg)), address(treasury), IAttestorTreasuryView(address(attestor)), registry, 3000
        );
        vm.startPrank(ops);
        attestor.setAttester(orreryProber, true);
        attestor.setAttester(address(registry), true);
        attestor.setTreasury(address(splitter));
        vm.stopPrank();
        factory = new CreditPoolFactory(
            IERC20Min(address(usdg)),
            IERC20Min(address(orry)),
            IOrryPriceOracle(address(oracle)),
            IIdentityRegistry(address(identity)),
            IAttestorVerified(address(attestor)),
            address(treasury)
        );
        vm.prank(ops);
        pool = CreditPool(factory.createPool(defaultParams()));
    }

    function defaultParams() internal pure returns (CreditPool.Params memory p) {
        p.aprBps = 1200;
        p.feeBps = 1000;
        p.repayBps = 5000;
        p.maxLineBps = 1000;
        p.term = 30 days;
        p.grace = 7 days;
        p.minBondUsd = uint128(25 * U);
        p.maxLineUsdg = uint128(10_000 * U);
        p.tierRepaid = [uint128(0), uint128(7_500 * U), uint128(75_000 * U), uint128(750_000 * U)];
        p.tierMultBps = [uint16(10_000), uint16(15_000), uint16(20_000), uint16(30_000)];
    }

    function warp(uint256 dt) internal {
        clock += dt;
        vm.warp(clock);
    }

    function fundOrry(address to, uint256 amount) internal {
        orry.mint(to, amount);
    }

    function stakeAs(address who, uint256 amount, address probe) internal {
        orry.mint(who, amount);
        vm.startPrank(who);
        orry.approve(address(registry), amount);
        registry.stake(amount, probe);
        vm.stopPrank();
    }

    /// @dev Registers an agent owned by `owner`, pays its verification in USDG; the agent wallet is `wallet`.
    function newVerifiedAgent(address owner, address wallet) internal returns (uint256 id) {
        vm.prank(owner);
        id = identity.register(owner);
        if (wallet != owner) {
            vm.prank(owner);
            identity.setAgentWallet(id, wallet);
        }
        usdg.mint(owner, 5 * U);
        vm.startPrank(owner);
        usdg.approve(address(attestor), 5 * U);
        attestor.payVerification(id, owner, uint128(5 * U));
        vm.stopPrank();
    }

    function result(uint64 observedAt) internal view returns (OrreryAttestor.Attestation memory a) {
        a.observedAt = observedAt;
        a.expiresAt = uint64(clock + 1 days);
        a.endpointsLive = true;
        a.registrationValid = true;
        a.domainVerified = false;
    }

    function lend(address lender, uint256 assets) internal returns (uint256 shares) {
        usdg.mint(lender, assets);
        vm.startPrank(lender);
        usdg.approve(address(pool), assets);
        shares = pool.deposit(assets);
        vm.stopPrank();
    }

    function bond(address owner, uint256 agentId, uint256 amount) internal {
        orry.mint(owner, amount);
        vm.startPrank(owner);
        orry.approve(address(pool), amount);
        pool.postBond(agentId, amount);
        vm.stopPrank();
    }

    function repayAs(address payer, uint256 agentId, uint256 amount) internal returns (uint256 paid) {
        usdg.mint(payer, amount);
        vm.startPrank(payer);
        usdg.approve(address(pool), amount);
        paid = pool.repay(agentId, amount);
        vm.stopPrank();
    }
}
