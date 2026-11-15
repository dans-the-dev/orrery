import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import {
  MARKET_FEATURES,
  ORRY_FEATURES,
  decodeSlot0,
  defaultOrryFeatures,
  maskAddress,
  parseOrryFeatures,
  poolStateSlot,
  orryCreditsFor,
  orryPerEthFromSqrt,
  orryUsdForCredits,
} from "@orrery/shared";
import { compareRatio, loadConfig, medianRatio, ratioOf, orryForUsd } from "@orrery/server";

const Q96 = 2n ** 96n;
const A = "0x00000000000000000000000000000000000000a1";
const base = {
  ORRERY_MODULE: A,
  ORRERY_ATTESTOR: A,
  ORRERY_LENS: A,
  ORRERY_REGISTRY: A,
  ORRERY_USDG: A,
  ORRERY_TREASURY: A,
};
const orry = {
  ORRERY_ORRY_TOKEN: A,
  ORRERY_ORRY_HOOK: A,
  ORRERY_ORRY_EARN_FACTORY: A,
  ORRERY_ORRY_STAKING: A,
  ORRERY_ORRY_ROUTER: A,
  ORRERY_ORRY_BUYBACK: A,
  ORRERY_ORRY_LENS: A,
  ORRERY_POOL_MANAGER: A,
  ORRERY_ORRY_USD_POOL_ID: `0x${"11".repeat(32)}`,
};
const keys = {
  ORRERY_RELAYER_KEY: generatePrivateKey(),
  ORRERY_CHECK_SIGNER_KEY: generatePrivateKey(),
  ORRERY_ATTESTER_KEY: generatePrivateKey(),
};

describe("release switch ORRERY_ORRY_FEATURES", () => {
  it("parses a comma list, holds everything on an empty string, rejects unknown names", () => {
    expect(parseOrryFeatures(undefined)).toBeUndefined();
    expect([...parseOrryFeatures("")!]).toEqual([]);
    expect([...parseOrryFeatures(" earn, Stake ,leaderboard")!].sort()).toEqual(["earn", "leaderboard", "stake"]);
    expect(() => parseOrryFeatures("earn,stakes")).toThrow(/Unknown ORRY feature "stakes"/);
  });

  it("defaults: all held on 4663, all open on 46630 and local", () => {
    expect(defaultOrryFeatures(4663).size).toBe(0);
    expect([...defaultOrryFeatures(46630)]).toEqual([...ORRY_FEATURES]);
    expect([...defaultOrryFeatures(31337)]).toEqual([...ORRY_FEATURES]);
  });

  it("without ORRY addresses nothing opens, and an explicit list is refused", () => {
    expect(loadConfig({ ...base }).orryFeatures.size).toBe(0);
    expect(() => loadConfig({ ...base, ORRERY_ORRY_FEATURES: "earn" })).toThrow(/needs the ORRY contract addresses/);
  });

  it("4663 holds everything by default and needs no quote key while checkout is held", () => {
    const cfg = loadConfig({ ...base, ...orry, ...keys, ORRERY_CHAIN_ID: "4663" });
    expect(cfg.orryFeatures.size).toBe(0);
    expect(cfg.quoteSignerKey).toBeNull();
    expect(cfg.orry!.treasury).toBe(A); // falls back to ORRERY_TREASURY
  });

  it("46630 opens everything and then requires its own quote signer key", () => {
    expect(() => loadConfig({ ...base, ...orry, ...keys, ORRERY_CHAIN_ID: "46630" })).toThrow(/ORRERY_QUOTE_SIGNER_KEY/);
    const q = generatePrivateKey();
    const cfg = loadConfig({ ...base, ...orry, ...keys, ORRERY_CHAIN_ID: "46630", ORRERY_QUOTE_SIGNER_KEY: q });
    expect(cfg.orryFeatures.size).toBe(ORRY_FEATURES.length - MARKET_FEATURES.length); // no market factory: the market features stay held
    expect(cfg.quoteSignerKey).toBe(q);
    expect(() => loadConfig({ ...base, ...orry, ...keys, ORRERY_CHAIN_ID: "46630", ORRERY_QUOTE_SIGNER_KEY: keys.ORRERY_CHECK_SIGNER_KEY })).toThrow(
      /must be its own key/,
    );
  });

  it("checkout opens without an ETH/USDG pool (the ORRY/USDG hub prices quotes); a quote lifetime above 120 s is refused", () => {
    const { ORRERY_ORRY_USD_POOL_ID: _drop, ...noPool } = orry;
    const cfg = loadConfig({ ...base, ...noPool });
    expect(cfg.orryFeatures.has("checkout")).toBe(true);
    expect(cfg.orry!.usdPoolId).toBeNull();
    expect(cfg.orry!.usdg).toBe(base.ORRERY_USDG);
    expect(() => loadConfig({ ...base, ...orry, ORRERY_QUOTE_TTL_SECONDS: "121" })).toThrow(/ORRERY_QUOTE_TTL_SECONDS/);
  });
});

describe("leaderboard masking (R-5)", () => {
  it("keeps the first and last four hex digits only", () => {
    expect(maskAddress("0x1234567890AbcdEF1234567890aBcDeF1234abcd")).toBe("0x1234…abcd");
    expect(maskAddress("0x1234567890AbcdEF1234567890aBcDeF1234abcd")).toHaveLength(11);
    expect(() => maskAddress("0x1234")).toThrow();
  });
});

describe("pool math", () => {
  it("slot0: decodes price, negative tick and fee; the pool state slot is keccak(poolId, 6)", () => {
    const sqrt = 1000n * Q96;
    const tick = -887_220;
    const word = sqrt | (BigInt.asUintN(24, BigInt(tick)) << 160n) | (8500n << 208n);
    const d = decodeSlot0(`0x${word.toString(16).padStart(64, "0")}`);
    expect(d).toEqual({ sqrtPriceX96: sqrt, tick, lpFee: 8500 });
    expect(poolStateSlot(`0x${"00".repeat(32)}`)).toBe("0x54cdd369e4e8a8515e52ca72ec816c2101831ad1f18bf44102ed171459c9b4f8");
  });

  it("hub price: ORRY base units per ETH", () => {
    expect(orryPerEthFromSqrt(Q96)).toBe(10n ** 18n);
    expect(orryPerEthFromSqrt(1000n * Q96)).toBe(10n ** 24n);
  });

  it("median is by value, upper middle on an even count; ORRY amounts round up", () => {
    const r = (h: bigint) => ratioOf(h * Q96, Q96);
    expect(medianRatio([r(3n), r(1n), r(2n)])).toEqual(r(2n));
    expect(medianRatio([r(4n), r(1n), r(3n), r(2n)])).toEqual(r(3n));
    expect(compareRatio(r(2n), r(3n))).toBe(-1);
    expect(orryForUsd(10n, { num: 1n, den: 3n })).toBe(4n);
    expect(orryForUsd(9n, { num: 1n, den: 3n })).toBe(3n);
  });

  it("checks from ORRY: 625 per 500-check pack (R-9)", () => {
    expect(orryCreditsFor(1, 500)).toBe(625n);
    expect(orryCreditsFor(3, 500)).toBe(1875n);
  });
});

describe("pay-as-you-go check price", () => {
  it("prices credits at the ORRY pack rate (625 per 1 USD), rounded up so it never undercuts a pack", () => {
    expect(orryUsdForCredits(2n, 1_000_000n, 500)).toBe(3_200n); // one check: 0.0032 USD of ORRY
    expect(orryUsdForCredits(625n, 1_000_000n, 500)).toBe(1_000_000n); // a pack's worth of credits: exactly 1 USD
    expect(orryUsdForCredits(orryCreditsFor(3, 500), 1_000_000n, 500)).toBe(3_000_000n);
    expect(orryUsdForCredits(1n, 1_000_000n, 300)).toBe(2_667n); // 2,666.67 rounded up
  });
});

