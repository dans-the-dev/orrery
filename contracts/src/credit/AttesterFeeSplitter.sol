// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Min} from "../interfaces/IExternal.sol";
import {IOrryBurnEvents, IOrryToken} from "../orry/interfaces/IOrryToken.sol";
import {AttesterRegistry} from "./AttesterRegistry.sol";

/// @notice The live attestor and treasury calls the splitter makes.
interface IAttestorTreasuryView {
    function payVerification(uint256 agentId, address expectedOwner, uint128 maxFee) external;
    function fee() external view returns (uint128);
    function treasury() external view returns (address);
}

interface IOrreryTreasuryView {
    function orry() external view returns (address);
    function isQuoteSigner(address signer) external view returns (bool);
}

/// @title AttesterFeeSplitter
/// @notice Set as `OrreryAttestor.treasury` (`docs/updates/L4-CREDIT-SPEC.md` 3.2). Every USDG it receives is split by
///         `split`: `shareBps` booked to the current epoch's attester pool, the rest to `OrreryTreasury` in the same
///         call. Attesters claim an ended epoch pro rata to the distinct agents they forwarded in it. Because the attestor
///         treats only its treasury as the fee-free payer (finding F2), the splitter also carries the ORRY verification
///         route that `OrreryTreasury.verifyWithOrry` gives today, with the treasury's own quote signers.
contract AttesterFeeSplitter is IOrryBurnEvents, ReentrancyGuard {
    uint8 public constant BURN_SOURCE = 40;
    uint32 public constant MAX_ORRY_VERIFICATIONS_PER_DAY = 25;
    uint16 private constant BPS = 10_000;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Orrery Attester Fees");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant VERIFICATION_TYPEHASH =
        keccak256("VerificationQuote(address payer,uint256 agentId,uint256 orryAmount,bytes32 quoteId,uint64 expiry)");
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    IERC20Min public immutable usdg;
    address public immutable treasury;
    IAttestorTreasuryView public immutable attestor;
    AttesterRegistry public immutable registry;
    uint16 public immutable shareBps;

    /// @notice USDG held for attesters: booked minus claimed minus released.
    uint256 public booked;
    mapping(uint256 epoch => uint256) public pool;
    mapping(uint256 epoch => uint256) public claimedTotal;
    mapping(uint256 epoch => mapping(address => bool)) public claimed;
    mapping(uint256 epoch => bool) public released;
    mapping(bytes32 => bool) public quoteUsed;
    uint64 private _verifyDay;
    uint32 private _verifyCount;

    event Split(uint256 indexed epoch, uint256 received, uint256 toAttesters, uint256 toTreasury);
    event Claimed(uint256 indexed epoch, address indexed staker, uint256 amount);
    event Released(uint256 indexed epoch, uint256 amount);
    event VerificationBurned(uint256 indexed agentId, address indexed payer, uint256 orryAmount, bytes32 indexed quoteId);

    error ZeroAddress();
    error BadShare();
    error NothingToSplit();
    error EpochNotEnded();
    error AlreadyClaimed();
    error NothingToClaim();
    error HasResults();
    error AlreadyReleased();
    error TransferFailed();
    error CoinNotSet();
    error ZeroAmount();
    error QuoteExpired();
    error QuoteUsed();
    error BadQuoteSignature();
    error DailyVerificationCap();
    error InexactBurn();
    error NotAttestorTreasury();

    constructor(IERC20Min usdg_, address treasury_, IAttestorTreasuryView attestor_, AttesterRegistry registry_, uint16 shareBps_) {
        if (address(usdg_) == address(0) || treasury_ == address(0) || address(attestor_) == address(0)) {
            revert ZeroAddress();
        }
        if (address(registry_) == address(0)) revert ZeroAddress();
        if (shareBps_ > 5000) revert BadShare();
        usdg = usdg_;
        treasury = treasury_;
        attestor = attestor_;
        registry = registry_;
        shareBps = shareBps_;
    }

    // ------------------------------------------------------------------ USDG

    /// @notice Anyone: books `shareBps` of USDG received since the last split to the current epoch, sends the rest to
    ///         `OrreryTreasury`.
    function split() external nonReentrant returns (uint256 toAttesters, uint256 toTreasury) {
        uint256 fresh = usdg.balanceOf(address(this)) - booked;
        if (fresh == 0) revert NothingToSplit();
        uint256 e = registry.currentEpoch();
        toAttesters = fresh * shareBps / BPS;
        toTreasury = fresh - toAttesters;
        booked += toAttesters;
        pool[e] += toAttesters;
        _send(treasury, toTreasury);
        emit Split(e, fresh, toAttesters, toTreasury);
    }

    function claimable(uint256 epoch, address staker) public view returns (uint256) {
        if (epoch >= registry.currentEpoch() || claimed[epoch][staker]) return 0;
        uint256 total = registry.totalResults(epoch);
        if (total == 0) return 0;
        return pool[epoch] * registry.results(epoch, staker) / total;
    }

    /// @notice An attester (the staker address) takes its share of an ended epoch, once.
    function claim(uint256 epoch) external nonReentrant returns (uint256 amount) {
        if (epoch >= registry.currentEpoch()) revert EpochNotEnded();
        if (claimed[epoch][msg.sender]) revert AlreadyClaimed();
        amount = claimable(epoch, msg.sender);
        if (amount == 0) revert NothingToClaim();
        claimed[epoch][msg.sender] = true;
        claimedTotal[epoch] += amount;
        booked -= amount;
        _send(msg.sender, amount);
        emit Claimed(epoch, msg.sender, amount);
    }

    /// @notice Anyone: an ended epoch in which no result was forwarded sends its attester pool to the treasury.
    function releaseUnused(uint256 epoch) external nonReentrant returns (uint256 amount) {
        if (epoch >= registry.currentEpoch()) revert EpochNotEnded();
        if (registry.totalResults(epoch) != 0) revert HasResults();
        if (released[epoch]) revert AlreadyReleased();
        released[epoch] = true;
        amount = pool[epoch];
        booked -= amount;
        _send(treasury, amount);
        emit Released(epoch, amount);
    }

    // ------------------------------------------------------------------ ORRY verification route (F2)

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice Pay the verification in ORRY at a signed quote: burns the ORRY from the caller, then records the
    ///         verification as the attestor's treasury (fee 0, no USDG moves). Same rules as the treasury's route.
    function verifyWithOrry(
        uint256 agentId,
        address expectedOwner,
        uint256 orryAmount,
        bytes32 quoteId,
        uint64 expiry,
        bytes calldata sig
    ) external nonReentrant {
        address coin = IOrreryTreasuryView(treasury).orry();
        if (coin == address(0)) revert CoinNotSet();
        if (orryAmount == 0) revert ZeroAmount();
        if (attestor.treasury() != address(this)) revert NotAttestorTreasury();
        if (expiry < block.timestamp) revert QuoteExpired();
        if (quoteUsed[quoteId]) revert QuoteUsed();
        bytes32 structHash = keccak256(abi.encode(VERIFICATION_TYPEHASH, msg.sender, agentId, orryAmount, quoteId, expiry));
        address signer = _recover(keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash)), sig);
        if (signer == address(0) || !IOrreryTreasuryView(treasury).isQuoteSigner(signer)) revert BadQuoteSignature();
        quoteUsed[quoteId] = true;

        uint64 day = uint64(block.timestamp / 1 days);
        if (day != _verifyDay) {
            _verifyDay = day;
            _verifyCount = 0;
        }
        if (_verifyCount >= MAX_ORRY_VERIFICATIONS_PER_DAY) revert DailyVerificationCap();
        _verifyCount += 1;

        uint256 supplyBefore = IOrryToken(coin).totalSupply();
        IOrryToken(coin).burnFrom(msg.sender, orryAmount);
        if (supplyBefore - IOrryToken(coin).totalSupply() != orryAmount) revert InexactBurn();
        attestor.payVerification(agentId, expectedOwner, attestor.fee());
        emit VerificationBurned(agentId, msg.sender, orryAmount, quoteId);
        emit Burned(BURN_SOURCE, orryAmount);
    }

    function verificationsToday() external view returns (uint32) {
        return uint64(block.timestamp / 1 days) == _verifyDay ? _verifyCount : 0;
    }

    // ------------------------------------------------------------------ internals

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = address(usdg).call(abi.encodeCall(IERC20Min.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    /// @dev Same rules as `OrreryTreasury._recover`: 65 bytes, low `s`, v 27 or 28; anything else gives address 0.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_ORDER) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
