import { describe, expect, it } from "vitest";
import { quoteBuy, quoteSell, rcorePerCoin, withLimit } from "./quote";

// about the opening price at tick 25,000 (exact square root, not TickMath) and the launch liquidity for 1e27 coins
const SQRT_START = 276_516_177_415_270_759_983_386_722_851n;
const L = 286_522_702_775_830_135_466_418_051n;

describe("spoke quotes", () => {
  it("a buy and the sell of its coins return the input less both fees", () => {
    const coins = quoteBuy(10_000n * 10n ** 18n, SQRT_START, L, 10_000);
    expect(coins).toBeGreaterThan(0n);
    // after the buy the price moved; selling the coins back at that price returns about 9,801 RCORE
    const x = 10_000n * 10n ** 18n - 100n * 10n ** 18n;
    const next = ((L << 96n) * SQRT_START) / ((L << 96n) + x * SQRT_START);
    const back = quoteSell(coins, next, L);
    expect(Number(back / 10n ** 15n) / 1000).toBeCloseTo(9801, 0);
  });
  it("the launch fee takes its share of a buy's input", () => {
    expect(quoteBuy(1000n, SQRT_START, L, 800_000)).toBeLessThan(quoteBuy(1000n, SQRT_START, L, 10_000));
  });
  it("prices and limits", () => {
    expect(rcorePerCoin(SQRT_START)).toBeGreaterThan(80_000_000_000_000_000n); // about 0.0821 RCORE per coin
    expect(rcorePerCoin(SQRT_START)).toBeLessThan(83_000_000_000_000_000n);
    expect(withLimit(10_000n, 100)).toBe(9_900n);
    expect(quoteBuy(0n, SQRT_START, L, 10_000)).toBe(0n);
  });
});
