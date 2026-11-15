// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOrryBurnEvents} from "../../orry/interfaces/IOrryToken.sol";

/// @notice ERC-4337 user operation as packed by EntryPoint v0.7 and v0.8 (same layout in both).
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// @notice The EntryPoint calls a paymaster makes or receives (v0.7 and v0.8 share them).
interface IPaymasterEntryPoint {
    function depositTo(address account) external payable;
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
    function balanceOf(address account) external view returns (uint256);
}

interface IPaymaster {
    enum PostOpMode {
        opSucceeded,
        opReverted,
        postOpReverted
    }

    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData);

    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external;
}

/// @notice Fixed numbers of a paymaster (`docs/updates/L3-R2-SPEC.md` 5). Guesses, set once at deployment.
struct PaymasterParams {
    uint16 premiumBps; // on top of the gas cost, burned (1000 = 10%, guess), at most 5000
    uint16 bufferBps; // extra precharge against a price move between the cached and the fresh rate (2000, guess)
    uint256 maxCostWei; // largest maximum cost of one operation (2e15, guess)
    uint32 postOpOverheadGas; // gas the EntryPoint spends after postOp, charged on top of the postOp limit (10000, guess)
    uint32 maxRateAge; // seconds a cached rate stays usable in validation (3600, guess)
    uint32 maxEthStaleness; // seconds the ETH/USD answer may age (7200, guess)
}

/// @notice Pays ERC-4337 gas in ORRY from a prepaid balance (`docs/updates/L3-R2-SPEC.md` 5, utility 12). Price: the gas
/// cost in ETH times Chainlink ETH/USD gives USD, and `OrryPriceOracle.orryFor` (the hub's time-weighted price, R-28)
/// gives ORRY, plus `premiumBps`. Validation reads only this contract's storage (a rate cached by `refreshRate` and the
/// sender's balance) and returns a `validUntil`, as ERC-7562 asks of a staked paymaster; `postOp` prices the operation
/// at the fresh rate.
interface IOrryPaymaster is IPaymaster, IOrryBurnEvents {
    event Deposited(address indexed account, address indexed from, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    event RateRefreshed(uint256 rate, uint64 at);
    event Charged(address indexed account, uint256 actualGasCost, uint256 charged, uint256 premium, uint256 refunded);
    event Flushed(address indexed recipient, uint256 paid, uint256 burned);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotEntryPoint();
    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error BadParams();
    error CostTooHigh();
    error PostOpGasTooLow();
    error RateNotSet();
    error InsufficientBalance();
    error OracleNotReady();
    error InexactTransfer();

    function MIN_POST_OP_GAS() external view returns (uint256);
    function entryPoint() external view returns (address);
    function orry() external view returns (address);
    function orryPrice() external view returns (address);
    function ethUsdFeed() external view returns (address);
    function orryRecipient() external view returns (address);
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function params() external view returns (PaymasterParams memory);

    /// @notice Prepaid ORRY of `account`, free to spend on operations or to withdraw.
    function balanceOf(address account) external view returns (uint256);
    /// @notice ORRY base units per 1e18 wei of gas cost (premium excluded), and when it was cached.
    function cachedRate() external view returns (uint256 rate, uint64 at);
    /// @notice The rate the oracle gives now; reverts `OracleNotReady` while it cannot price.
    function currentRate() external view returns (uint256);
    function pendingRecipient() external view returns (uint256);
    function pendingBurn() external view returns (uint256);
    /// @notice ORRY a validated operation of at most `maxCostWei` would set aside now, at the cached rate.
    function quote(uint256 maxCostWei) external view returns (uint256);

    function deposit(address account, uint256 amount) external;
    function withdraw(address to, uint256 amount) external;
    function refreshRate() external returns (uint256 rate);
    function flush() external;

    function depositEth() external payable;
    function withdrawEth(address payable to, uint256 amount) external;
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable to) external;
    function transferOwnership(address newOwner) external; // two-step
    function acceptOwnership() external;
}
