// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {OrreryAttestor} from "../../../../src/OrreryAttestor.sol";
import {IIdentityRegistry, IERC20Min} from "../../../../src/interfaces/IExternal.sol";
import {OrreryTreasury} from "../../../../src/orry/OrreryTreasury.sol";
import {MockIdentityRegistry, MockERC20} from "../../../mocks/Mocks.sol";
import {MockOrry} from "./StakeMocks.sol";

/// @notice Quote signing for `OrreryTreasury`, written from the interface text, independent of the contract.
abstract contract QuoteSigning is Test {
    bytes32 internal constant CREDITS_TYPEHASH =
        keccak256("CreditsQuote(address buyer,uint32 packs,uint256 orryAmount,bytes32 quoteId,uint64 expiry)");
    bytes32 internal constant VERIFICATION_TYPEHASH =
        keccak256("VerificationQuote(address payer,uint256 agentId,uint256 orryAmount,bytes32 quoteId,uint64 expiry)");

    function _domain(address treasury_) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Orrery Treasury")),
                keccak256(bytes("1")),
                block.chainid,
                treasury_
            )
        );
    }

    function _sign(uint256 key, address treasury_, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domain(treasury_), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _creditsSig(
        uint256 key,
        address treasury_,
        address buyer,
        uint32 packs,
        uint256 amount,
        bytes32 quoteId,
        uint64 expiry
    ) internal view returns (bytes memory) {
        return _sign(key, treasury_, keccak256(abi.encode(CREDITS_TYPEHASH, buyer, packs, amount, quoteId, expiry)));
    }

    function _verificationSig(
        uint256 key,
        address treasury_,
        address payer,
        uint256 agentId,
        uint256 amount,
        bytes32 quoteId,
        uint64 expiry
    ) internal view returns (bytes memory) {
        return _sign(
            key, treasury_, keccak256(abi.encode(VERIFICATION_TYPEHASH, payer, agentId, amount, quoteId, expiry))
        );
    }
}

/// @notice Treasury-only deployment: identity registry, ORRY stand-in, USDG, the v1 OrreryAttestor and OrreryTreasury.
/// Imports nothing from staking, the router, the buyback or Uniswap v4, so the treasury tests can ship with Orrery v1
/// on their own (R-12). `StakeBase` extends it for the rest of lane B.
abstract contract TreasuryBase is QuoteSigning {
    uint64 internal constant START = 1_800_000_000;
    uint256 internal constant SUPPLY = 1e27;

    MockIdentityRegistry internal registry;
    MockOrry internal orry;
    MockERC20 internal usdg;
    OrreryAttestor internal attestor;
    OrreryTreasury internal treasury;

    address internal owner = makeAddr("owner");
    address internal attestorAdmin = makeAddr("attestorAdmin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    uint256 internal signerKey;
    address internal quoteSigner;

    function setUp() public virtual {
        vm.warp(START);
        (quoteSigner, signerKey) = makeAddrAndKey("quoteSigner");
        registry = new MockIdentityRegistry();
        orry = new MockOrry(address(this), SUPPLY);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        attestor = new OrreryAttestor(
            IIdentityRegistry(address(registry)), IERC20Min(address(usdg)), attestorAdmin, address(1), 5e6
        );
        address[] memory signers = new address[](1);
        signers[0] = quoteSigner;
        treasury = new OrreryTreasury(address(usdg), address(attestor), owner, 1000, signers);
        vm.prank(attestorAdmin);
        attestor.setTreasury(address(treasury));

        address[3] memory people = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            orry.transfer(people[i], 10_000_000e18);
            vm.deal(people[i], 100 ether);
        }
    }

    // ---------------------------------------------------------------- helpers

    /// @dev The test clock. via-IR treats `block.timestamp` as constant within a call and may re-read it after a
    /// `vm.warp`, so tests read the time through the cheatcode instead.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _setCoin(address buyback_) internal {
        vm.prank(owner);
        treasury.proposeCoin(address(orry), buyback_);
        vm.warp(_now() + 48 hours);
        vm.prank(owner);
        treasury.executeCoin();
    }

    function _revenue(uint256 amount) internal {
        usdg.mint(address(treasury), amount);
    }

    receive() external payable virtual {}
}
