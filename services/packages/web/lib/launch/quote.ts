/**
 * Quotes for the spoke pools (lane L5). Every spoke has one position, the launch's own, in range at every price at or below
 * the opening, so a swap is the constant-product step of Uniswap's SqrtPriceMath over that one liquidity. The hook's fee is
 * on the ORRY side: taken from a buy's input, and from a sell's output.
 */
const Q96 = 1n << 96n;
const PIPS = 1_000_000n;

/** Coins out for `orryIn` ORRY at `feePips` (exact in, ORRY is currency0). */
export function quoteBuy(orryIn: bigint, sqrtPriceX96: bigint, liquidity: bigint, feePips: number): bigint {
  if (orryIn <= 0n || liquidity === 0n || sqrtPriceX96 === 0n) return 0n;
  const x = orryIn - (orryIn * BigInt(feePips)) / PIPS;
  const num = liquidity << 96n;
  const next = (num * sqrtPriceX96) / (num + x * sqrtPriceX96);
  return (liquidity * (sqrtPriceX96 - next)) / Q96;
}

/** ORRY out for `coinsIn` coins (exact in, the coin is currency1), after the 1% fee on the output. */
export function quoteSell(coinsIn: bigint, sqrtPriceX96: bigint, liquidity: bigint, feePips = 10_000): bigint {
  if (coinsIn <= 0n || liquidity === 0n || sqrtPriceX96 === 0n) return 0n;
  const next = sqrtPriceX96 + (coinsIn * Q96) / liquidity;
  const gross = (liquidity * Q96 * (next - sqrtPriceX96)) / next / sqrtPriceX96;
  return gross - (gross * BigInt(feePips)) / PIPS;
}

/** The output floor for a quote and a price limit in basis points. */
export const withLimit = (quote: bigint, bps: number) => (quote * BigInt(10_000 - bps)) / 10_000n;

/** ORRY per whole coin from the pool price (coins per ORRY), 18 decimals. */
export const orryPerCoin = (sqrtPriceX96: bigint) => (sqrtPriceX96 === 0n ? 0n : (10n ** 18n << 192n) / (sqrtPriceX96 * sqrtPriceX96));
