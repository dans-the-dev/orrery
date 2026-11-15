// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";

import {
    IOrryPaymaster, IPaymasterEntryPoint, PackedUserOperation, PaymasterParams
} from "./interfaces/IOrryPaymaster.sol";
import {IOrryPriceOracle} from "../markets/interfaces/IMarketPricing.sol";
import {IOrryToken} from "../orry/interfaces/IOrryToken.sol";
import {IChainlinkFeed} from "../markets/ChainlinkFeed.sol";

/// @notice ERC-4337 paymaster that takes ORRY for gas (`docs/updates/L3-R2-SPEC.md` 5, L3-11 to L3-14, utility 12). One
/// per EntryPoint (v0.7 and v0.8 on 4663 share the interface).
///
/// Money flow: anyone deposits ORRY for an account (an operator funds its agent's smart account; the account never
/// approves anything, which the KYA module forbids, I13). Validation moves the operation's precharge out of the account's
/// balance at the cached rate; `postOp` charges the real cost at the fresh oracle rate (what the EntryPoint reported, plus
/// an upper bound of what it adds after postOp: the postOp gas limit, a tenth of the call gas limit for its unused-gas
/// penalty, and `postOpOverheadGas`), capped
/// at the precharge, returns the rest, and books the base part for `orryRecipient` and the premium part for burning
/// (source 33); `flush` pays and burns. The owner manages only this contract's ETH at the EntryPoint.
///
/// ERC-7562: validation touches only this contract's storage (the cached rate and the sender's balance) and uses no
/// banned opcode; the cache's age is enforced through `validUntil`. A paymaster that keeps storage must be
/// staked at the EntryPoint (`addStake`).
contract OrryPaymaster is IOrryPaymaster {
    uint256 public constant MIN_POST_OP_GAS = 120_000;
    uint256 private constant BPS = 10_000;
    uint256 private constant WEI_PER_ETH = 1e18;
    uint256 private constant USD_DECIMALS = 6;
    uint16 private constant MAX_PREMIUM_BPS = 5000;
    uint16 private constant MAX_BUFFER_BPS = 10_000;
    uint8 private constant BURN_PAYMASTER_PREMIUM = 33;
    bytes32 private constant LOCK_SLOT = keccak256("orrery.OrryPaymaster.lock");

    address public immutable entryPoint;
    address public immutable orry;
    address public immutable orryPrice;
    address public immutable ethUsdFeed;
    address public immutable orryRecipient;
    uint16 private immutable _premiumBps;
    uint16 private immutable _bufferBps;
    uint256 private immutable _maxCostWei;
    uint32 private immutable _postOpOverheadGas;
    uint32 private immutable _maxRateAge;
    uint32 private immutable _maxEthStaleness;
    uint256 private immutable _usdPerEthScale; // 10 ** feed decimals: answer * 10**6 / this = USDG base units per ETH

    address public owner;
    address public pendingOwner;
    mapping(address account => uint256) public balanceOf;
    uint256 public pendingRecipient;
    uint256 public pendingBurn;
    uint256 private _rate;
    uint64 private _rateAt;

    constructor(
        address entryPoint_,
        address orry_,
        address orryPrice_,
        address ethUsdFeed_,
        address owner_,
        address orryRecipient_,
        PaymasterParams memory p
    ) {
        if (
            entryPoint_ == address(0) || orry_ == address(0) || orryPrice_ == address(0) || ethUsdFeed_ == address(0)
                || owner_ == address(0) || orryRecipient_ == address(0)
        ) revert ZeroAddress();
        if (
            p.premiumBps > MAX_PREMIUM_BPS || p.bufferBps > MAX_BUFFER_BPS || p.maxCostWei == 0 || p.maxRateAge == 0
                || p.maxEthStaleness == 0
        ) revert BadParams();
        uint8 d = IChainlinkFeed(ethUsdFeed_).decimals();
        if (d < USD_DECIMALS || d > 36) revert BadParams();
        entryPoint = entryPoint_;
        orry = orry_;
        orryPrice = orryPrice_;
        ethUsdFeed = ethUsdFeed_;
        owner = owner_;
        orryRecipient = orryRecipient_;
        _premiumBps = p.premiumBps;
        _bufferBps = p.bufferBps;
        _maxCostWei = p.maxCostWei;
        _postOpOverheadGas = p.postOpOverheadGas;
        _maxRateAge = p.maxRateAge;
        _maxEthStaleness = p.maxEthStaleness;
        _usdPerEthScale = 10 ** (d - USD_DECIMALS);
        emit OwnershipTransferred(address(0), owner_);
    }

    modifier nonReentrant() {
        bytes32 slot = LOCK_SLOT;
        assembly ("memory-safe") {
            if tload(slot) { revert(0, 0) }
            tstore(slot, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ------------------------------------------------------------------ views

    function params() external view returns (PaymasterParams memory) {
        return PaymasterParams(_premiumBps, _bufferBps, _maxCostWei, _postOpOverheadGas, _maxRateAge, _maxEthStaleness);
    }

    function cachedRate() external view returns (uint256 rate, uint64 at) {
        return (_rate, _rateAt);
    }

    function currentRate() public view returns (uint256) {
        (bool ok, uint256 rate) = _freshRate();
        if (!ok) revert OracleNotReady();
        return rate;
    }

    function quote(uint256 maxCostWei) public view returns (uint256) {
        return FullMath.mulDivRoundingUp(
            maxCostWei, _rate * (BPS + _premiumBps + _bufferBps), WEI_PER_ETH * BPS
        );
    }

    // ------------------------------------------------------------------ prepaid balances

    function deposit(address account, uint256 amount) external nonReentrant {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 before = IOrryToken(orry).balanceOf(address(this));
        if (!_tryCall(abi.encodeCall(IOrryToken.transferFrom, (msg.sender, address(this), amount)))) {
            revert InexactTransfer();
        }
        if (IOrryToken(orry).balanceOf(address(this)) - before != amount) revert InexactTransfer();
        balanceOf[account] += amount;
        emit Deposited(account, msg.sender, amount);
    }

    function withdraw(address to, uint256 amount) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (bal < amount) revert InsufficientBalance();
        balanceOf[msg.sender] = bal - amount;
        _send(to, amount);
        emit Withdrawn(msg.sender, to, amount);
    }

    // ------------------------------------------------------------------ rate

    function refreshRate() external returns (uint256 rate) {
        bool ok;
        (ok, rate) = _freshRate();
        if (!ok) revert OracleNotReady();
        _store(rate);
    }

    function _store(uint256 rate) private {
        _rate = rate;
        _rateAt = uint64(block.timestamp);
        emit RateRefreshed(rate, uint64(block.timestamp));
    }

    /// @dev ORRY base units per 1e18 wei: Chainlink ETH/USD (fresh, positive) to USDG base units, then the hub TWAP.
    function _freshRate() private view returns (bool ok, uint256 rate) {
        uint256 answer;
        try IChainlinkFeed(ethUsdFeed).latestRoundData() returns (uint80, int256 a, uint256, uint256 updatedAt, uint80) {
            if (a <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0);
            if (block.timestamp - updatedAt > _maxEthStaleness) return (false, 0);
            answer = uint256(a);
        } catch {
            return (false, 0);
        }
        uint256 usdPerEth = answer / _usdPerEthScale;
        if (usdPerEth == 0) return (false, 0);
        try IOrryPriceOracle(orryPrice).orryFor(usdPerEth) returns (uint256 r) {
            return (r != 0, r);
        } catch {
            return (false, 0);
        }
    }

    // ------------------------------------------------------------------ ERC-4337

    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        external
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        if (maxCost > _maxCostWei) revert CostTooHigh();
        // paymasterAndData: paymaster (20) | verification gas limit (16) | postOp gas limit (16) | data
        bytes calldata pmd = userOp.paymasterAndData;
        if (pmd.length < 52) revert PostOpGasTooLow();
        uint256 postOpGasLimit = uint128(bytes16(pmd[36:52]));
        if (postOpGasLimit < MIN_POST_OP_GAS) revert PostOpGasTooLow();
        uint256 rate = _rate;
        if (rate == 0) revert RateNotSet();
        uint256 precharge = quote(maxCost);
        address sender = userOp.sender;
        uint256 bal = balanceOf[sender];
        if (bal < precharge) revert InsufficientBalance();
        balanceOf[sender] = bal - precharge;
        // gas the EntryPoint charges after `actualGasCost` is reported: postOp itself and the 10% penalty on unused
        // execution and postOp gas (v0.7 and v0.8). Its upper bound: the whole postOp limit plus a tenth of the call limit.
        uint256 extraGas = postOpGasLimit + uint128(uint256(userOp.accountGasLimits)) / 10;
        context = abi.encode(sender, precharge, rate, extraGas);
        // the cached rate is usable until it is `maxRateAge` old; the EntryPoint enforces it (validUntil, bits 160..207)
        validationData = uint256(uint48(uint256(_rateAt) + _maxRateAge)) << 160;
    }

    /// @dev Makes no call that can revert: the fresh rate is read in try blocks, everything else is storage.
    function postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external
        onlyEntryPoint
    {
        (address account, uint256 precharge, uint256 rate, uint256 extraGas) =
            abi.decode(context, (address, uint256, uint256, uint256));
        (bool ok, uint256 fresh) = _freshRate();
        if (ok) {
            rate = fresh;
            _store(fresh);
        }
        uint256 cost = actualGasCost + (extraGas + _postOpOverheadGas) * actualUserOpFeePerGas;
        uint256 charge = FullMath.mulDivRoundingUp(cost, rate * (BPS + _premiumBps), WEI_PER_ETH * BPS);
        if (charge > precharge) charge = precharge;
        uint256 base = FullMath.mulDiv(charge, BPS, BPS + _premiumBps);
        uint256 premium = charge - base;
        pendingRecipient += base;
        pendingBurn += premium;
        uint256 refund = precharge - charge;
        balanceOf[account] += refund;
        emit Charged(account, actualGasCost, charge, premium, refund);
    }

    // ------------------------------------------------------------------ flush

    function flush() external nonReentrant {
        uint256 paid = pendingRecipient;
        uint256 burned = pendingBurn;
        if (paid == 0 && burned == 0) revert ZeroAmount();
        pendingRecipient = 0;
        pendingBurn = 0;
        if (paid != 0) _send(orryRecipient, paid);
        if (burned != 0) {
            uint256 supply = IOrryToken(orry).totalSupply();
            IOrryToken(orry).burn(burned);
            if (supply - IOrryToken(orry).totalSupply() != burned) revert InexactTransfer();
            emit Burned(BURN_PAYMASTER_PREMIUM, burned);
        }
        emit Flushed(orryRecipient, paid, burned);
    }

    // ------------------------------------------------------------------ owner: this contract's ETH only

    function depositEth() external payable {
        IPaymasterEntryPoint(entryPoint).depositTo{value: msg.value}(address(this));
    }

    function withdrawEth(address payable to, uint256 amount) external onlyOwner {
        IPaymasterEntryPoint(entryPoint).withdrawTo(to, amount);
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        IPaymasterEntryPoint(entryPoint).addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        IPaymasterEntryPoint(entryPoint).unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        IPaymasterEntryPoint(entryPoint).withdrawStake(to);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ helpers

    function _send(address to, uint256 amount) private {
        if (!_tryCall(abi.encodeCall(IOrryToken.transfer, (to, amount)))) revert InexactTransfer();
    }

    /// @dev An ORRY call that succeeded and returned true or nothing.
    function _tryCall(bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = orry.call(data);
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }
}
