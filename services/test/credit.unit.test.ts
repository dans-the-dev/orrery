import { describe, expect, it } from "vitest";
import { disagreements, predictActiveSet } from "../packages/server/src/credit-epoch.js";
import { loadCreditConfig } from "../packages/server/src/credit-config.js";

const r = (staker: string, agentId: string, ok: boolean, observedAt = 1n) => ({ staker, agentId, observedAt, endpointsLive: ok, registrationValid: true });

describe("credit epoch job", () => {
  it("rates each attester against the per-agent majority, latest result per attester", () => {
    const rows = [
      r("a", "1", true), r("b", "1", true), r("c", "1", false),
      r("a", "2", true), r("b", "2", true), r("c", "2", false),
      r("c", "2", true, 5n), // c's latest result for agent 2 agrees
      r("a", "3", true), r("b", "3", false), // a tie: no majority, counts for nobody
      r("a", "4", true), // one attester only: no majority
    ];
    const d = disagreements(rows, 1000);
    const byStaker = Object.fromEntries(d.map((x) => [x.staker, x]));
    expect(byStaker.c).toMatchObject({ results: 2, disagreements: 1, rateBps: 5000, over: true });
    expect(byStaker.a).toMatchObject({ results: 2, disagreements: 0, rateBps: 0, over: false });
    expect(byStaker.b).toMatchObject({ results: 2, disagreements: 0, over: false });
    expect(d[0]!.staker).toBe("c");
  });

  it("the bar is strict: exactly at the bar stays in", () => {
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push(r("a", String(i), true), r("b", String(i), true), r("x", String(i), i !== 0));
    const x = disagreements(rows, 1000).find((d) => d.staker === "x")!;
    expect(x.rateBps).toBe(1000);
    expect(x.over).toBe(false);
  });

  it("predicts the roll with the contract's ranking", () => {
    const set = predictActiveSet(
      [
        { staker: "0x00000000000000000000000000000000000000b2", amount: 5n, lockedAt: 10n, excludedUntilEpoch: 0n },
        { staker: "0x00000000000000000000000000000000000000b1", amount: 5n, lockedAt: 10n, excludedUntilEpoch: 0n },
        { staker: "0x00000000000000000000000000000000000000c1", amount: 5n, lockedAt: 9n, excludedUntilEpoch: 0n },
        { staker: "0x00000000000000000000000000000000000000d1", amount: 9n, lockedAt: 50n, excludedUntilEpoch: 3n },
        { staker: "0x00000000000000000000000000000000000000e1", amount: 1n, lockedAt: 1n, excludedUntilEpoch: 2n },
      ],
      3n,
      3,
    );
    expect(set).toEqual([
      "0x00000000000000000000000000000000000000c1",
      "0x00000000000000000000000000000000000000b1",
      "0x00000000000000000000000000000000000000b2",
    ]);
  });
});

describe("credit config", () => {
  it("is off unless a registry or factory is set", () => {
    expect(loadCreditConfig({})).toBeNull();
    const c = loadCreditConfig({ ORRERY_CREDIT_FACTORY: "0x0000000000000000000000000000000000000001" })!;
    expect(c.registry).toBeNull();
    expect(c.cacheMs).toBe(15_000);
    expect(c.disagreementBps).toBe(1000);
  });

  it("refuses bad values", () => {
    expect(() => loadCreditConfig({ ORRERY_ATTESTER_REGISTRY: "nope" })).toThrow(/0x address/);
    expect(() => loadCreditConfig({ ORRERY_ATTESTER_REGISTRY: "0x0000000000000000000000000000000000000001", ORRERY_CREDIT_START_BLOCK: "-1" })).toThrow(/block number/);
    expect(() => loadCreditConfig({ ORRERY_ATTESTER_REGISTRY: "0x0000000000000000000000000000000000000001", ORRERY_ATTESTER_DISAGREEMENT_BPS: "0" })).toThrow(/integer/);
  });
});
