/**
 * Where ORRY can be bought and sold, for the buttons beside the hero's CA pill. Pure, so the tests run without the app.
 *
 * The default is the one venue ORRY trades on today: its Pons launch page (checked on 2026-11-11, on the curve). The
 * server-side `ORRERY_TRADE_LINKS` replaces the list without a code change, for example once ORRY graduates into a
 * pool: `Name|https://url,Name|https://url`, with `{ca}` standing for the token address. An entry that is not an https
 * URL is dropped, and an empty or unusable value falls back to the default.
 */
export interface TradeVenue {
  name: string;
  url: string;
  /** The venue's own mark in /public/venues, for venues this repository holds one for. */
  icon?: string;
}

const ICONS: Record<string, string> = { pons: "/venues/pons.png" };
const DEFAULT_LINKS = "Pons|https://ponsfamily.com/launchpad/{ca}";

export function tradeVenues(ca: string | null, raw?: string): TradeVenue[] {
  if (!ca) return [];
  const parse = (s: string): TradeVenue[] =>
    s
      .split(",")
      .map((entry): TradeVenue | null => {
        const [name = "", link = ""] = entry.split("|").map((p) => p.trim());
        const url = link.replaceAll("{ca}", ca);
        if (!name || name.length > 24 || !/^https:\/\/[^\s"'<>]+$/.test(url)) return null;
        try {
          new URL(url);
        } catch {
          return null;
        }
        return { name, url, icon: ICONS[name.toLowerCase()] };
      })
      .filter((v): v is TradeVenue => v !== null)
      .slice(0, 3);
  const custom = raw?.trim() ? parse(raw) : [];
  return custom.length ? custom : parse(DEFAULT_LINKS);
}
