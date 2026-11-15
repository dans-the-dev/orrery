// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Bounded buys of ORRY in the Orrery hub pools (`docs/ORRY-BUILD-SPEC.md` 3.6, R-35 to R-37). Never trades in
/// a Pons pool, so protocol money pays no Pons fee. Three entry points, anyone, each at most once per `MIN_INTERVAL`:
/// - `executeSlice` turns treasury USDG into ORRY for the rewards router. When the ORRY/USDG hub is registered and its
///   cap is at least the ETH path's, one hop in that hub (`ethMid` 0 in `SliceExecuted`); otherwise hop 1 USDG to native
///   ETH on the immutable list of Uniswap ETH/USDG v4 pools (bounded by `maxSliceUsdgCap` and the listed-pool spread,
///   R-18) and hop 2 ETH to ORRY in the ETH hub.
/// - `burnEth` turns the ETH the rewards router sent into ORRY in the ETH hub and burns it (source 4).
/// - `buyWithQuote(quote)` turns the router's `quote` (any registered quote other than native ETH, R-37) into ORRY in
///   that quote's own hub, one hop, and sends the ORRY to the rewards router, which splits it half to stakers and half
///   burned. Its interval is per quote.
/// Each hop is capped in the transaction at `0.5 × fee × reserve` of its pool, pays a minimum output against the
/// pre-trade state, and refuses (`PriceMovedInBlock`) when its hub's price moved earlier in the block (that hub's
/// same-block guard, `IOrreryHook.startOfBlockSqrtPriceX96(quote)`). No owner, no setter.
interface IOrryBuyback {
    /// @notice `ethMid` is 0 when the slice went one hop through the ORRY/USDG hub.
    event SliceExecuted(uint256 usdgIn, uint256 ethMid, uint256 orryOut);
    event EthBurned(uint256 ethIn, uint256 orryBurned);
    event QuoteSwapped(address indexed quote, uint256 quoteIn, uint256 orryOut);

    error TooSoon(uint64 nextAt);
    error NothingToBuy();
    error SlippageExceeded();
    error PriceMovedInBlock();
    /// @notice `buyWithQuote` with native ETH (use `burnEth`), ORRY, or a token that is not a registered quote.
    error NotAQuote();

    // cashback and referral share (R-45, docs/ORRY-UPGRADE-PATHS.md B-1)
    event CashbackSinkProposed(address indexed sink, uint64 executableAt);
    event CashbackSinkSet(address indexed sink);
    event CashbackPaid(address indexed sink, uint256 orryAmount);

    error NotTreasuryOwner();
    error CashbackSinkAlreadySet();
    error NoCashbackProposal();
    error CashbackNotReady(uint64 executableAt);

    /// @notice Share of the ORRY bought by executeSlice and buyWithQuote that goes to the cashback sink once it is set
    /// (1000 = 10%, constructor value); before that, all of it goes to the rewards router.
    function CASHBACK_BPS() external view returns (uint16);
    function CASHBACK_DELAY() external view returns (uint64); // 48 hours
    function cashbackSink() external view returns (address); // 0 until set; set once, never changed
    function pendingCashbackSink() external view returns (address sink, uint64 executableAt);
    /// @notice Treasury owner only (read live from the treasury); a new proposal replaces a pending one.
    function proposeCashbackSink(address sink) external;
    /// @notice Treasury owner only, after CASHBACK_DELAY; sets the sink for good.
    function executeCashbackSink() external;

    function MIN_INTERVAL() external view returns (uint64); // 1 hour, per entry point (per quote for buyWithQuote)

    function treasury() external view returns (address);
    function rewardsRouter() external view returns (address);
    function hook() external view returns (address);
    function orry() external view returns (address);
    function usdg() external view returns (address);

    function lastSliceAt() external view returns (uint64);
    function lastEthBurnAt() external view returns (uint64);
    function lastQuoteBuyAt(address quote) external view returns (uint64);
    /// @notice Largest USDG input a slice may spend right now (treasury allowance, the route's hop caps, maxSliceUsdgCap).
    function maxSliceUsdg() external view returns (uint256);
    /// @notice True when the next slice goes one hop through the ORRY/USDG hub (registered, initialized, and its cap
    /// at least the ETH path's).
    function sliceViaUsdgHub() external view returns (bool);
    /// @notice Largest ETH input a burn may spend right now (ETH hub hop cap).
    function maxBurnEth() external view returns (uint256);
    /// @notice Largest `quote` input `buyWithQuote` may spend right now (the buyback's balance and that hub's hop cap).
    function maxQuoteIn(address quote) external view returns (uint256);

    function executeSlice() external returns (uint256 orryOut);
    function burnEth() external returns (uint256 orryBurned);
    function buyWithQuote(address quote) external returns (uint256 orryOut);

    receive() external payable;
}
