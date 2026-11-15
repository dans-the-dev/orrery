// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Receives protocol money only: the hub hook's protocol fees (native ETH, ORRY and, since R-37, the quote token
/// of every other hub) and the ORRY that the buyback bought (`docs/ORRY-BUILD-SPEC.md` 3.4, `docs/ORRY-PAIRS-PLAN.md`).
/// It never calls, holds or redirects a Pons fee (owner rule, 2026-11-08). `distribute`:
/// - splits ETH and ORRY by `STAKERS_BPS`: the stakers' part goes to `OrryStaking.notifyRewards`; the rest of the ORRY
///   is burned (source 1) and the rest of the ETH goes to the buyback, which buys ORRY in the ETH hub and burns it
///   (source 4);
/// - forwards the router's whole balance of every registered quote other than native ETH to the buyback (R-37), which
///   turns it into ORRY in that quote's own hub (`IOrryBuyback.buyWithQuote`) and sends the ORRY back here, where the
///   next `distribute` splits it like any ORRY. A quote whose transfer fails is skipped and stays here for the next
///   call. A token that is not a registered quote is never moved (P-5).
/// No owner, no setter.
interface IOrryRewardsRouter {
    event Distributed(uint256 ethToStakers, uint256 orryToStakers, uint256 ethToBuyback, uint256 orryBurned);
    event QuoteForwarded(address indexed quote, uint256 amount);

    error TooSoon(uint64 nextAt);
    error NothingToDistribute();
    error EthTransferFailed();

    function STAKERS_BPS() external view returns (uint16); // default 5000
    function MIN_INTERVAL() external view returns (uint64); // 1 hour

    function orry() external view returns (address);
    function staking() external view returns (address);
    function buyback() external view returns (address);
    /// @notice The OrreryHook whose registered pairs (`pairCount`, `pairAt`) name the quotes this router forwards.
    function hook() external view returns (address);
    function lastDistributionAt() external view returns (uint64);

    /// @notice Anyone, at most once per MIN_INTERVAL. Reverts NothingToDistribute only when the router holds no ETH, no
    /// ORRY and no registered quote.
    function distribute() external;

    receive() external payable;
}
