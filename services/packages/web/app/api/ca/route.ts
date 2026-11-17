import { getAddress, isAddress } from "viem";
import { tradeVenues } from "@/lib/trade-venues";

/**
 * The ORRY token address the hero's CA pill shows (owner rules: the coin's CA sits under the main buttons, and it comes
 * from server config at runtime, never from a NEXT_PUBLIC_ build value or a source constant). `ORRERY_CA` is a
 * server-side Vercel env var read on every request; changing it is an env edit and a redeploy of the same commit
 * (docs/RUNBOOK-INCIDENTS.md). Unset, malformed or a mixed-case value with a wrong checksum: `ca: null`, and the pill
 * stays hidden instead of showing a wrong address.
 */
export const dynamic = "force-dynamic";

export function GET() {
  const raw = process.env.ORRERY_CA?.trim() ?? "";
  const ca = isAddress(raw) ? getAddress(raw) : null;
  // The buttons beside the pill: where ORRY trades (from ORRERY_TRADE_LINKS if set).
  return Response.json({ ca, trade: tradeVenues(ca, process.env.ORRERY_TRADE_LINKS) }, { headers: { "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=600" } });
}
