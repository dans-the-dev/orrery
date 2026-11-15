import { describe, expect, it } from "vitest";
import { buildAccruals, rankByFees, tierOf, type FeeRow, type Link } from "../packages/server/src/community-ledger.js";

const USD = 1_000_000n;
const DAY = 86_400_000;
const T = new Date("2027-01-15T08:00:00Z");
const cfg = { cashbackBps: 200, referralBps: 2000, referralDays: 90, merchantWeightBps: 20_000, stakerWeightBps: 12_500, monthlyCapUsd: 1000n * USD };
const row = (ref: string, account: string, usd: bigint, source = "checks", at = T): FeeRow => ({ ref, account, source, usd, at, usdg: ["checks", "verification", "markets", "facilitator"].includes(source) });
const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const M = "0x00000000000000000000000000000000000000cc";

describe("cashback and referral accruals (utilities 7 and 8)", () => {
  const links = new Map<string, Link>([[B, { referrer: A, linkedAt: new Date(T.getTime() - DAY) }], [M, { referrer: A, linkedAt: new Date(T.getTime() - DAY) }]]);

  it("cashback only on USDG fees, referral on every fee in the window", () => {
    const out = buildAccruals(cfg, [row("f1", B, 100n * USD), row("f2", B, 100n * USD, "chat")], links, new Set(), new Set(), new Set(), new Map());
    expect(out.filter((x) => x.kind === 1).map((x) => x.rewardUsd)).toEqual([2n * USD]);
    expect(out.filter((x) => x.kind === 2).map((x) => x.rewardUsd)).toEqual([20n * USD, 20n * USD]);
    expect(out.every((x) => x.kind === 1 || x.account === A)).toBe(true);
  });

  it("weights: merchant x2, staker x1.25, never above half the fee (R-56, RF-2)", () => {
    const out = buildAccruals(cfg, [row("f1", M, 100n * USD, "chat")], links, new Set([M]), new Set([A]), new Set(), new Map());
    expect(out[0]!.rewardUsd).toBe(50n * USD); // 20% x 2 x 1.25 = 50%
    const half = buildAccruals({ ...cfg, referralBps: 5000 }, [row("f1", M, 100n * USD, "chat")], links, new Set([M]), new Set([A]), new Set(), new Map());
    expect(half[0]!.rewardUsd).toBe(50n * USD);
  });

  it("only fees inside [linkedAt, linkedAt + 90 days) and not already recorded", () => {
    const before = row("f0", B, 100n * USD, "chat", new Date(T.getTime() - 2 * DAY));
    const after = row("f9", B, 100n * USD, "chat", new Date(T.getTime() - DAY + 90 * DAY));
    expect(buildAccruals(cfg, [before, after], links, new Set(), new Set(), new Set(), new Map())).toEqual([]);
    const first = buildAccruals(cfg, [row("f1", B, 100n * USD)], links, new Set(), new Set(), new Set(), new Map());
    const seen = new Set(first.map((a) => `${a.ref}:${a.kind}:${a.account}`));
    expect(buildAccruals(cfg, [row("f1", B, 100n * USD)], links, new Set(), new Set(), seen, new Map())).toEqual([]);
  });

  it("trims the referrer's month to the cap (R-55, RF-3)", () => {
    const out = buildAccruals(cfg, [row("f1", B, 3000n * USD, "chat"), row("f2", B, 3000n * USD, "chat")], links, new Set(), new Set(), new Set(), new Map([[A, 900n * USD]]));
    expect(out.map((x) => x.rewardUsd)).toEqual([100n * USD]);
  });
});

describe("ranking (R-34) and tiers", () => {
  it("ranks by USD fees, ties by address", () => {
    const r = rankByFees([row("1", B, 5n * USD), row("2", A, 3n * USD, "chat"), row("3", A, 2n * USD), row("4", M, 1n)], 2);
    expect(r.map((x) => [x.account, x.feesUsd])).toEqual([[A, 5n * USD], [B, 5n * USD]]);
    expect(r[0]!.bySource).toEqual({ chat: 3n * USD, checks: 2n * USD });
  });
  it("tiers by referred volume", () => {
    const tiers = [1000n * USD, 10_000n * USD, 50_000n * USD];
    expect(tierOf(999n * USD, tiers)).toBe(null);
    expect(tierOf(1000n * USD, tiers)).toBe("Bronze");
    expect(tierOf(60_000n * USD, tiers)).toBe("Ambassador");
  });
});
