// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Orrery Earn for one hub: one shared full-range position in the ORRY/`quote` hub pool
/// (`docs/ORRY-BUILD-SPEC.md` 3.2, R-35). One vault per hub, created by `IEarnVaultFactory`. `quote` is address 0 for
/// native ETH, else an ERC-20. Amounts are always given and returned as (quote, ORRY), whatever the pool's currency
/// order. Shares are units of the liquidity this vault added itself, not transferable. Swap fees the position earns are
/// harvested and streamed to shares over `STREAM_PERIOD`. Every mint locks the receiver's shares for `DEPOSIT_LOCK`,
/// share-weighted. No owner, no pause: deposits, withdrawals and claims can never be stopped by anyone.
interface IEarnVault {
    event Deposited(address indexed account, uint256 quoteIn, uint256 orryIn, uint256 shares, uint64 unlockAt);
    event Withdrawn(address indexed account, uint256 shares, uint256 quoteOut, uint256 orryOut);
    event FeesHarvested(uint256 quoteAmount, uint256 orryAmount, uint64 periodFinish);
    event FeesClaimed(address indexed account, address indexed caller, uint256 quoteAmount, uint256 orryAmount);

    error DeadlinePassed();
    error ZeroAmount();
    error ValueMismatch();
    error SlippageExceeded();
    error SharesLocked(uint64 unlockAt);
    error InsufficientShares();
    error PriceMovedInBlock();
    error HubNotInitialized();
    error EthTransferFailed();
    error PriceOutOfBounds();

    function DEPOSIT_LOCK() external view returns (uint64); // 15 minutes
    function STREAM_PERIOD() external view returns (uint64); // 7 days
    function MAX_BLOCK_MOVE_BPS() external view returns (uint16); // 100 = 1% price move since start of block

    function hook() external view returns (address);
    function orry() external view returns (address);
    /// @notice The hub's quote token: address 0 for native ETH.
    function quote() external view returns (address);

    /// @notice Two-sided deposit of up to `quoteMax` quote and up to `orryMax` ORRY. Native ETH vault: `msg.value`
    /// must equal `quoteMax`; ERC-20 vault: `msg.value` must be 0 and the tokens are pulled with transferFrom, balance-delta
    /// checked (ValueMismatch otherwise). Adds the most liquidity both amounts allow at the current price and refunds
    /// the rest. The hub's sqrtPriceX96 must be within [minSqrtPriceX96, maxSqrtPriceX96] when the deposit enters
    /// (PriceOutOfBounds otherwise); pass bounds from a price outside the hub (review M-3).
    function deposit(
        uint256 quoteMax,
        uint256 orryMax,
        uint256 minShares,
        uint160 minSqrtPriceX96,
        uint160 maxSqrtPriceX96,
        uint256 deadline
    ) external payable returns (uint256 shares);

    /// @notice One-sided deposit: swaps about half of `amountIn` through the hub (`minSwapOut`, same-block guard), then
    /// deposits both sides. `fromQuote` true pays in the quote (native: `msg.value == amountIn`; ERC-20: pulled, with
    /// `msg.value` 0); false pulls `amountIn` ORRY with `msg.value` 0. The price bounds apply before the swap.
    function zapDeposit(
        bool fromQuote,
        uint256 amountIn,
        uint256 minSwapOut,
        uint256 minShares,
        uint160 minSqrtPriceX96,
        uint160 maxSqrtPriceX96,
        uint256 deadline
    ) external payable returns (uint256 shares);

    /// @notice Burns `shares` of the caller after their unlock, removes that liquidity and pays both sides; also pays
    /// the caller's streamed fees.
    function withdraw(uint256 shares, uint256 minQuoteOut, uint256 minOrryOut, uint256 deadline)
        external
        returns (uint256 quoteOut, uint256 orryOut);

    /// @notice Anyone: collects the position's swap fees into the stream (called inside every deposit and withdraw too).
    /// @notice Anyone pays `orryAmount` ORRY into the vault's ORRY reward stream (balance-delta checked), streamed to
    /// shareholders over STREAM_PERIOD like harvested fees (Agent Launch's Earn share, T6; docs/ORRY-UPGRADE-PATHS.md
    /// B-2). With no shares, it waits in the stream for the next period.
    function notifyRewards(uint256 orryAmount) external;
    event RewardsNotified(address indexed from, uint256 orryAmount);

    function harvest() external returns (uint256 quoteAmount, uint256 orryAmount);

    /// @notice Pays the caller's streamed fees.
    function claimFees() external returns (uint256 quoteAmount, uint256 orryAmount);

    /// @notice Anyone: pays `account`'s streamed fees to `account` and nowhere else (used by `ClaimAll`).
    function claimFor(address account) external returns (uint256 quoteAmount, uint256 orryAmount);

    function sharesOf(address account) external view returns (uint256);
    function totalShares() external view returns (uint256);
    function unlockAt(address account) external view returns (uint64);
    function pendingFees(address account) external view returns (uint256 quoteAmount, uint256 orryAmount);
    /// @notice Quote and ORRY the whole position holds at the current price.
    function positionAmounts() external view returns (uint256 quoteAmount, uint256 orryAmount);
    function previewWithdraw(uint256 shares) external view returns (uint256 quoteAmount, uint256 orryAmount);
}
