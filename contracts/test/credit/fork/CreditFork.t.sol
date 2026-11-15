// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrreryAttestor} from "../../../src/OrreryAttestor.sol";
import {IIdentityRegistry, IERC20Min} from "../../../src/interfaces/IExternal.sol";
import {IOrryToken} from "../../../src/orry/interfaces/IOrryToken.sol";
import {IOrryPriceOracle} from "../../../src/markets/interfaces/IMarketPricing.sol";
import {AttesterRegistry} from "../../../src/credit/AttesterRegistry.sol";
import {AttesterFeeSplitter, IAttestorTreasuryView} from "../../../src/credit/AttesterFeeSplitter.sol";
import {CreditPool, IAttestorVerified} from "../../../src/credit/CreditPool.sol";
import {CreditPoolFactory} from "../../../src/credit/CreditPoolFactory.sol";
import {CreditRevenueRouter} from "../../../src/credit/CreditRevenueRouter.sol";
import {CreditOracle} from "../CreditBase.sol";

interface IRegisterF {
    function register() external returns (uint256);
    function ownerOf(uint256) external view returns (address);
    function getAgentWallet(uint256) external view returns (address);
}

interface ITreasuryF {
    function owner() external view returns (address);
    function orry() external view returns (address);
    function attestor() external view returns (address);
    function isQuoteSigner(address) external view returns (bool);
    function proposeCoin(address, address) external;
    function executeCoin() external;
    function setQuoteSigner(address, bool) external;
    function verifyWithOrry(uint256, address, uint256, bytes32, uint64, bytes calldata) external;
}

interface IErc20F {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function name() external view returns (string memory);
    function decimals() external view returns (uint8);
}

/// @notice Lane L4 on a fork of Robinhood Chain 4663, against the live `OrreryAttestor`, `OrreryTreasury`, USDG, ORRY
///         and the ERC-8004 identity registry. The ORRY price oracle (R1) is not deployed, so Credit uses a stand-in.
///         Run: forge test --match-path 'test/credit/fork/*' --fork-url <4663 rpc> --fork-block-number <head - 20>
contract CreditForkTest is Test {
    address constant ATTESTOR = 0xC18a0dc74F5326786f5aDe357354159C63282Bd0;
    address constant TREASURY = 0x5b633d7Ec2749104d53B67dC47210dBE538aC54c;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ORRY = 0x85272EA3aE8685C768045dba5455fE305C706aA4;
    address constant REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant ORRERY_PROBER = 0xe0444a010EbAdb445aD75629E20c4C0149724eC0;

    uint256 constant M = 1e18;
    uint256 constant U = 1e6;

    OrreryAttestor attestor = OrreryAttestor(ATTESTOR);
    address owner;
    uint256 t0;

    bytes32 constant VERIFICATION_TYPEHASH =
        keccak256("VerificationQuote(address payer,uint256 agentId,uint256 orryAmount,bytes32 quoteId,uint64 expiry)");

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url of Robinhood Chain 4663");
        owner = attestor.owner();
        t0 = block.timestamp;
    }

    function _newAgent(address who) internal returns (uint256 id) {
        vm.prank(who);
        id = IRegisterF(REGISTRY).register();
    }

    function _payVerification(address who, uint256 id) internal {
        uint128 fee = attestor.fee();
        deal(USDG, who, fee);
        vm.startPrank(who);
        IErc20F(USDG).approve(ATTESTOR, fee);
        attestor.payVerification(id, who, fee);
        vm.stopPrank();
    }

    function _attesters(uint64 genesis) internal returns (AttesterRegistry r, AttesterFeeSplitter s) {
        r = new AttesterRegistry(IOrryToken(ORRY), attestor, 1_000_000 * M, 20, 7 days, 14 days, genesis);
        s = new AttesterFeeSplitter(IERC20Min(USDG), TREASURY, IAttestorTreasuryView(ATTESTOR), r, 3000);
    }

    // ------------------------------------------------------------------ facts

    function test_fork_facts() public view {
        assertEq(attestor.MAX_ATTESTERS(), 5, "F1: five keys at most");
        assertEq(attestor.attesterCount(), 1);
        assertTrue(attestor.isAttester(ORRERY_PROBER));
        assertEq(attestor.treasury(), TREASURY);
        assertEq(ITreasuryF(TREASURY).attestor(), ATTESTOR);
        assertEq(ITreasuryF(TREASURY).orry(), address(0), "coin not set yet");
        assertEq(attestor.fee(), 5 * U);
        assertEq(IErc20F(ORRY).name(), "ORRERY");
        assertEq(IErc20F(ORRY).decimals(), 18);
        assertEq(IErc20F(USDG).decimals(), 6);
    }

    /// F1: the live attestor refuses a sixth key, so 20 third-party keys can never be set directly.
    function test_fork_F1_noRoomForTwentyKeys() public {
        vm.startPrank(owner);
        for (uint256 i; i < 4; ++i) attestor.setAttester(address(uint160(0xF000 + i)), true);
        vm.expectRevert(OrreryAttestor.TooManyKeys.selector);
        attestor.setAttester(address(0xF0FF), true);
        vm.stopPrank();
    }

    /// F2: once the attestor's treasury is anything else, the live treasury's ORRY route can no longer record fee-free.
    function test_fork_F2_oldPlanBreaksTreasuryRoute() public {
        (, AttesterFeeSplitter s) = _attesters(uint64(block.timestamp));
        address payer = makeAddr("payer");
        uint256 id = _newAgent(payer);
        vm.prank(owner);
        attestor.setTreasury(address(s));
        uint128 fee = attestor.fee();
        vm.prank(TREASURY); // exactly the call OrreryTreasury.verifyWithOrry makes
        vm.expectRevert(OrreryAttestor.TransferFailed.selector);
        attestor.payVerification(id, payer, fee);
    }

    // ------------------------------------------------------------------ attesters end to end

    function test_fork_attesters_endToEnd() public {
        (AttesterRegistry r, AttesterFeeSplitter s) = _attesters(uint64(block.timestamp));
        vm.startPrank(owner);
        attestor.setAttester(address(r), true);
        attestor.setTreasury(address(s));
        vm.stopPrank();
        assertEq(attestor.attesterCount(), 2, "one key for all third-party attesters");

        address a = makeAddr("attesterA");
        address b = makeAddr("attesterB");
        address pa = makeAddr("probeA");
        address pb = makeAddr("probeB");
        deal(ORRY, a, 2_000_000 * M);
        deal(ORRY, b, 1_000_000 * M);
        vm.startPrank(a);
        IErc20F(ORRY).approve(address(r), 2_000_000 * M);
        r.stake(2_000_000 * M, pa);
        vm.stopPrank();
        vm.startPrank(b);
        IErc20F(ORRY).approve(address(r), 1_000_000 * M);
        r.stake(1_000_000 * M, pb);
        vm.stopPrank();
        assertEq(IErc20F(ORRY).balanceOf(address(r)), 3_000_000 * M, "real ORRY moves exactly");
        address[] memory set = r.rollEpoch();
        assertEq(set.length, 2);
        assertEq(set[0], a);

        // two agents verified with real USDG: the fee lands in the splitter
        address op1 = makeAddr("op1");
        address op2 = makeAddr("op2");
        uint256 id1 = _newAgent(op1);
        uint256 id2 = _newAgent(op2);
        _payVerification(op1, id1);
        _payVerification(op2, id2);
        assertEq(IErc20F(USDG).balanceOf(address(s)), 10 * U);
        uint256 tBefore = IErc20F(USDG).balanceOf(TREASURY);
        s.split();
        assertEq(IErc20F(USDG).balanceOf(TREASURY) - tBefore, 7 * U, "70% to OrreryTreasury");

        vm.warp(t0 + 60);
        OrreryAttestor.Attestation memory res;
        res.observedAt = uint64(t0 + 60);
        res.expiresAt = uint64(t0 + 1 days);
        res.endpointsLive = true;
        res.registrationValid = true;
        vm.prank(pa);
        r.attest(id1, res);
        vm.prank(pb);
        r.attest(id2, res);
        assertEq(attestor.getAttestation(id1).attester, address(r));
        assertTrue(attestor.getAttestation(id2).endpointsLive);

        // Orrery's own prober still writes directly and can still clear
        vm.warp(t0 + 120);
        res.observedAt = uint64(t0 + 120);
        vm.prank(ORRERY_PROBER);
        attestor.attest(id1, res);
        assertEq(attestor.getAttestation(id1).attester, ORRERY_PROBER);

        vm.warp(t0 + 7 days);
        vm.prank(a);
        assertEq(s.claim(0), 1_500_000);
        vm.prank(b);
        assertEq(s.claim(0), 1_500_000);
        assertEq(IErc20F(USDG).balanceOf(a), 1_500_000);
        assertEq(IErc20F(USDG).balanceOf(address(s)), 0);

        // exit: unlock, 14 days, the whole stake back
        vm.prank(a);
        r.requestUnlock();
        vm.warp(t0 + 21 days);
        vm.prank(a);
        r.withdraw();
        assertEq(IErc20F(ORRY).balanceOf(a), 2_000_000 * M);
    }

    /// The splitter's ORRY route with the real ORRY token (burnFrom) once the live treasury's coin is set.
    function test_fork_splitterOrryRoute_realBurn() public {
        (, AttesterFeeSplitter s) = _attesters(uint64(block.timestamp));
        vm.startPrank(owner);
        ITreasuryF(TREASURY).proposeCoin(ORRY, address(0xB0B0)); // a buyback stand-in; only orry() matters here
        vm.warp(t0 + 48 hours);
        ITreasuryF(TREASURY).executeCoin();
        (address signer, uint256 pk) = makeAddrAndKey("quoteSigner");
        ITreasuryF(TREASURY).setQuoteSigner(signer, true);
        attestor.setTreasury(address(s));
        vm.stopPrank();
        address payer = makeAddr("payer");
        uint256 id = _newAgent(payer);
        deal(ORRY, payer, 1_000 * M);
        uint64 exp = uint64(block.timestamp + 120);
        bytes32 sh = keccak256(abi.encode(VERIFICATION_TYPEHASH, payer, id, 500 * M, bytes32("q1"), exp));
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", s.domainSeparator(), sh)));
        uint256 supply = IErc20F(ORRY).totalSupply();
        vm.startPrank(payer);
        IErc20F(ORRY).approve(address(s), 500 * M);
        s.verifyWithOrry(id, payer, 500 * M, "q1", exp, abi.encodePacked(rr, ss, v));
        vm.stopPrank();
        assertEq(supply - IErc20F(ORRY).totalSupply(), 500 * M, "real ORRY burned");
        assertTrue(attestor.isVerified(id));
        assertEq(attestor.getVerification(id).feePaid, 0);
    }

    // ------------------------------------------------------------------ credit end to end

    function _pool() internal returns (CreditPool pool, CreditOracle oracle) {
        oracle = new CreditOracle();
        oracle.set(10_000); // 0.01 USDG per ORRY (stand-in: the R1 oracle is not deployed)
        CreditPoolFactory f = new CreditPoolFactory(
            IERC20Min(USDG),
            IERC20Min(ORRY),
            IOrryPriceOracle(address(oracle)),
            IIdentityRegistry(REGISTRY),
            IAttestorVerified(ATTESTOR),
            TREASURY
        );
        CreditPool.Params memory p;
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
        vm.expectRevert(CreditPoolFactory.NotTreasuryOwner.selector);
        f.createPool(p);
        vm.prank(ITreasuryF(TREASURY).owner());
        pool = CreditPool(f.createPool(p));
    }

    function test_fork_credit_endToEnd() public {
        (CreditPool pool,) = _pool();
        address lender = makeAddr("lender");
        deal(USDG, lender, 50_000 * U);
        vm.startPrank(lender);
        IErc20F(USDG).approve(address(pool), 50_000 * U);
        pool.deposit(50_000 * U);
        vm.stopPrank();
        assertEq(IErc20F(USDG).balanceOf(address(pool)), 50_000 * U);

        address op = makeAddr("operator");
        uint256 id = _newAgent(op);
        _payVerification(op, id);
        assertTrue(attestor.isVerified(id));
        assertEq(IRegisterF(REGISTRY).getAgentWallet(id), op, "the live registry points the wallet at the owner");
        deal(ORRY, op, 200_000 * M);
        vm.startPrank(op);
        IErc20F(ORRY).approve(address(pool), 200_000 * M);
        pool.postBond(id, 200_000 * M); // 2,000 USDG at the stand-in price
        assertEq(pool.limitOf(id), 2_000 * U);
        pool.draw(id, 1_500 * U);
        vm.stopPrank();
        assertEq(IErc20F(USDG).balanceOf(op), 1_500 * U, "real USDG into the agent wallet");

        // 30 days of x402 revenue through the router repays half of each sweep
        vm.warp(t0 + 30 days);
        CreditRevenueRouter router = CreditRevenueRouter(pool.routerOf(id));
        deal(USDG, address(router), 400 * U);
        uint256 tBefore = IErc20F(USDG).balanceOf(TREASURY);
        (uint256 toPool, uint256 toAgent) = router.sweep();
        assertEq(toPool, 200 * U);
        assertEq(toAgent, 200 * U);
        // interest 1,500 * 12% * 30/365 = 14.794521 (up); Orrery's 10%
        assertEq(IErc20F(USDG).balanceOf(TREASURY) - tBefore, 1_479_452);
        assertEq(pool.lineOf(id).principal, 1_500 * U - (200 * U - 14_794_521));

        // the rest is never repaid: default after due + grace; the real ORRY bond goes to the lender
        vm.warp(t0 + 37 days + 1);
        pool.liquidate(id);
        vm.prank(lender);
        uint256 got = pool.claimOrry();
        assertApproxEqAbs(got, 200_000 * M, 1e6);
        assertEq(IErc20F(ORRY).balanceOf(lender), got);
        assertTrue(pool.lineOf(id).defaulted);
    }
}
