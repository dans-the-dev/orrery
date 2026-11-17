import { describe, expect, it } from "vitest";
import { tradeVenues } from "./trade-venues";

const CA = "0x2c30E8E77B752Bf9f945A9BF99427EE0b60C50be";

describe("trade venues beside the CA", () => {
  it("shows nothing by default when ORRERY_TRADE_LINKS is unset or blank", () => {
    expect(tradeVenues(CA)).toEqual([]);
    expect(tradeVenues(CA, "  ")).toEqual([]);
  });

  it("shows nothing without a contract address", () => {
    expect(tradeVenues(null)).toEqual([]);
    expect(tradeVenues(null, "Pons|https://ponsfamily.com/launchpad/{ca}")).toEqual([]);
  });

  it("takes the list from server config, at most three venues", () => {
    const v = tradeVenues(CA, "Pons|https://ponsfamily.com/launchpad/{ca}, Swap|https://dex.example/swap?out={ca},A|https://a.example,B|https://b.example");
    expect(v.map((x) => x.name)).toEqual(["Pons", "Swap", "A"]);
    expect(v[1]).toEqual({ name: "Swap", url: `https://dex.example/swap?out=${CA}`, icon: undefined });
  });

  it("drops entries that are not https links and falls back when none is usable", () => {
    expect(tradeVenues(CA, "Bad|http://plain.example,Script|javascript:alert(1),Good|https://ok.example").map((x) => x.name)).toEqual(["Good"]);
    expect(tradeVenues(CA, "Bad|javascript:alert(1),|https://noname.example")).toEqual(tradeVenues(CA));
    expect(tradeVenues(CA, 'X|https://a.example/"><script>')).toEqual(tradeVenues(CA));
  });
});
