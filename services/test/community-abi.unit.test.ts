import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toEventSelector, toFunctionSelector, type Abi, type AbiEvent, type AbiFunction } from "viem";
import {
  cashbackRewardsAbi,
  monthIndex,
  monthStart,
  orryAchievementsAbi,
  orryBoostAbi,
  orryChatAbi,
  orryNamesAbi,
  orryPassesAbi,
  referralRegistryAbi,
  rewardPoolAbi,
  templateMarketAbi,
} from "@orrery/shared";

/** The hand-written ABIs in shared/community.ts against the Foundry artifacts: every function and event must exist there. */
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../contracts/out");
const art = (name: string) => JSON.parse(readFileSync(join(OUT, `${name}.sol`, `${name}.json`), "utf8")).abi as Abi;

const sig = (x: AbiFunction | AbiEvent) => (x.type === "function" ? toFunctionSelector(x) : toEventSelector(x));

describe("community ABIs match the contracts", () => {
  const pairs: [string, Abi][] = [
    ["RewardPool", rewardPoolAbi as Abi],
    ["OrryAchievements", orryAchievementsAbi as Abi],
    ["OrryChat", orryChatAbi as Abi],
    ["OrryNames", orryNamesAbi as Abi],
    ["OrryBoost", orryBoostAbi as Abi],
    ["OrryPasses", orryPassesAbi as Abi],
    ["TemplateMarket", templateMarketAbi as Abi],
    ["ReferralRegistry", referralRegistryAbi as Abi],
    ["CashbackRewards", cashbackRewardsAbi as Abi],
  ];
  for (const [name, abi] of pairs) {
    it(name, () => {
      const real = new Set(art(name).filter((x) => x.type === "function" || x.type === "event").map((x) => sig(x as AbiFunction | AbiEvent)));
      for (const x of abi.filter((x) => x.type === "function" || x.type === "event")) {
        expect(real.has(sig(x as AbiFunction | AbiEvent)), `${name}.${(x as AbiFunction).name}`).toBe(true);
      }
    });
  }

  it("calendar months match the contract's Months library", () => {
    // contracts/test/community/CashbackRewards.t.sol: 1_800_000_000 is month 24324, 2000-02-29 is 24001
    expect(monthIndex(new Date(1_800_000_000 * 1000))).toBe(24324);
    expect(monthIndex(new Date(951_782_400 * 1000))).toBe(24001);
    expect(monthStart(24325).getTime() / 1000).toBe(1_801_440_000);
  });
});
