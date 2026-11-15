/**
 * Knowledge base for the support drafter: the text of the live site's public pages plus live API facts (pricing, which
 * features are open, the ORRY contract address). Built from what visitors see right now, so a held feature reads as
 * "Coming soon" here exactly as it does on the site, and nothing drifts from the deployed product.
 */

/** Public pages, in a fixed order so the knowledge base text (and the prompt cache) stays stable between refreshes. */
export const KB_PAGES = [
  "/",
  "/docs",
  "/docs/claims",
  "/docs/earn",
  "/docs/stake",
  "/docs/merchants",
  "/credits",
  "/operator",
  "/signer",
  "/merchants",
  "/earn",
  "/stake",
  "/claim",
  "/burn",
  "/leaderboard",
  "/stocks",
  "/swap",
  "/dark-pool",
  "/terms",
  "/privacy",
] as const;

export const OFFICIAL_LINKS = {
  site: "https://orrery.tech",
  docs: "https://orrery.tech/docs",
  explorer: "https://robinhoodchain.blockscout.com",
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

/** Visible text of an HTML page: scripts, styles and tags removed, entities decoded, whitespace collapsed. */
export function pageText(html: string): string {
  const noCode = html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const text = noCode
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

interface Pricing {
  packPrice: string;
  packSize: number;
  freeChecksPerMonth: number;
  creditsPerCheck: number;
  volumeCreditsPerCheck: number;
  volumeChecks: number;
  checksPerMinute: number;
  plan?: { price: string; credits: number; days: number; checksPerMinute: number };
}

/** `/v1/pricing` in words, amounts in USDG (6 decimals), so the drafter never misreads base units. Null when malformed. */
export function pricingText(json: string): string | null {
  try {
    const p = JSON.parse(json) as Pricing;
    const usdg = (s: string) => Number(BigInt(s)) / 1e6;
    const perCredit = usdg(p.packPrice) / p.packSize;
    const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 6 });
    const lines = [
      `Credit pack price: ${n(p.packSize)} credits for ${n(usdg(p.packPrice))} USDG, settled over x402 on Robinhood Chain.`,
      `Included each month: ${n(p.freeChecksPerMonth)} signed checks per address, at no cost.`,
      `Beyond that, each check uses ${p.creditsPerCheck} credits (${n(perCredit * p.creditsPerCheck)} USDG), dropping to ${p.volumeCreditsPerCheck} credit (${n(perCredit * p.volumeCreditsPerCheck)} USDG) past ${n(p.volumeChecks)} checks in a month.`,
      `Throughput: up to ${n(p.checksPerMinute)} checks a minute.`,
    ];
    if (p.plan) lines.push(`Platform plan: ${p.plan.days} days, ${n(p.plan.credits)} credits and up to ${n(p.plan.checksPerMinute)} checks a minute for ${n(usdg(p.plan.price))} USDG.`);
    return lines.join("\n");
  } catch {
    return null;
  }
}

export interface KbSources {
  webUrl: string;
  apiUrl: string;
  fetchImpl?: typeof fetch;
}

async function get(fetchImpl: typeof fetch, url: string): Promise<string | null> {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "orrery-support" } });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

/**
 * The knowledge base text. Pages that fail to load are left out (and named in `missing`), so one slow page never blocks a
 * draft; the caller keeps the previous text when everything fails.
 */
export async function buildKb(src: KbSources): Promise<{ text: string; missing: string[] }> {
  const fetchImpl = src.fetchImpl ?? fetch;
  const web = src.webUrl.replace(/\/$/, "");
  const api = src.apiUrl.replace(/\/$/, "");
  const missing: string[] = [];
  const parts: string[] = [];

  parts.push(
    [
      "# Official addresses",
      `Website: ${OFFICIAL_LINKS.site}`,
      `Docs: ${OFFICIAL_LINKS.docs}`,
      "X and Discord: use the official links exactly as the site pages below show them.",
      `Explorer: ${OFFICIAL_LINKS.explorer}`,
      "Network: Robinhood Chain mainnet, chain id 4663.",
    ].join("\n"),
  );

  const ca = await get(fetchImpl, `${web}/api/ca`);
  if (ca) {
    try {
      const j = JSON.parse(ca) as { ca?: string | null };
      if (j.ca) parts.push(`# ORRY token\nORRY token contract on Robinhood Chain: ${j.ca}`);
    } catch {
      missing.push("/api/ca");
    }
  } else missing.push("/api/ca");

  const pricing = await get(fetchImpl, `${api}/v1/pricing`);
  const readable = pricing ? pricingText(pricing) : null;
  if (readable) parts.push(`# Current prices (from GET ${api}/v1/pricing)\n${readable}`);
  else missing.push("/v1/pricing");

  const releases = await get(fetchImpl, `${api}/v1/releases`);
  if (releases) {
    try {
      const j = JSON.parse(releases) as { serverTime: string; releases: Record<string, string | null> };
      const now = Date.parse(j.serverTime);
      const open = Object.entries(j.releases).filter(([, at]) => at && Date.parse(at) <= now).map(([f]) => f);
      const held = Object.entries(j.releases).filter(([, at]) => !at || Date.parse(at) > now).map(([f]) => f);
      parts.push(`# What is open\nAvailable now: ${open.join(", ") || "none"}\nComing soon: ${held.join(", ") || "none"}`);
    } catch {
      missing.push("/v1/releases");
    }
  } else missing.push("/v1/releases");

  for (const path of KB_PAGES) {
    const html = await get(fetchImpl, web + path);
    if (!html) {
      missing.push(path);
      continue;
    }
    parts.push(`# Page ${web}${path}\n${pageText(html)}`);
  }
  return { text: parts.join("\n\n"), missing };
}
