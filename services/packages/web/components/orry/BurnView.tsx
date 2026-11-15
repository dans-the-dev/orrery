"use client";

import { activeChain } from "@/lib/config";
import { useBurns } from "@/lib/orry/api";
import { useNow } from "@/lib/orry/chain";
import { ago, orry, utc } from "@/lib/orry/format";
import { useReleases } from "@/lib/orry/releases";
import { MARKET_BURN_SOURCES } from "@/lib/markets/config";
import { Fig, OrryHead, TxLink } from "./parts";

/** `Burned(source, amount)`: 1 rewards router, 2 checks paid in ORRY, 3 verification in ORRY, 4 buyback of the ETH share,
 * 5 and 6 the markets' sealing fee and trading fees paid in ORRY (docs/ORRY-R1-SPEC.md 2.4), 7 Orrery's fee on merchant
 * payments received in ORRY (wave 3 facilitator). */
export const BURN_SOURCES: Record<number, string> = {
  1: "Protocol fees, ORRY share",
  2: "Credit packs paid in ORRY",
  3: "Verifications paid in ORRY",
  4: "Protocol fees, ETH share bought and burned",
  ...MARKET_BURN_SOURCES,
  7: "Merchant payments in ORRY, Orrery's fee",
};

export function BurnView() {
  const releases = useReleases();
  const marketsOpen = releases.isLive("swap") || releases.isLive("darkpool") || releases.isLive("stocks");
  const merchantsOpen = releases.isLive("facilitator");
  const { data, isError, isLoading } = useBurns(30);
  const now = useNow(5000);
  const total = data?.total ?? 0n;
  const share = (v: bigint) => (total > 0n ? Number((v * 10_000n) / total) / 100 : 0);

  return (
    <>
      <OrryHead
        title="Where burned ORRY comes from."
        lead={<p>ORRY paid for checks and verifications is burned, and so is the burn share of the protocol&apos;s fees. Every entry below is a transaction on {activeChain.name}.</p>}
        reading={
          <div className="rc-card">
            <p className="rc-card-title">Burned so far</p>
            {isError && !data ? (
              <p className="rc-card-wait">Burn figures appear here in a moment.</p>
            ) : (
              <>
                <p className="rc-big">
                  <Fig v={data ? orry(total) : undefined} unit="ORRY" />
                </p>
                <ul className="rc-sources" aria-label="Burned ORRY by source">
                  {([1, 2, 3, 4, 5, 6, 7] as const).filter((k) => k <= 4 || (k === 7 ? merchantsOpen : marketsOpen) || (data?.bySource[k] ?? 0n) > 0n).map((k) => {
                    const v = data?.bySource[k] ?? 0n;
                    return (
                      <li key={k}>
                        <div className="rc-source-label">
                          <span>{BURN_SOURCES[k]}</span>
                          <strong>{data ? `${orry(v)} ORRY` : "…"}</strong>
                        </div>
                        <span className="rc-bar" aria-hidden="true">
                          <i style={{ width: `${share(v)}%` }} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        }
      />

      <section className="rc-panel" aria-label="Recent burns">
        <div className="rc-panel-head">
          <h2>Recent burns</h2>
        </div>
        {isLoading ? (
          <p className="rc-muted">…</p>
        ) : !data || data.items.length === 0 ? (
          <p className="rc-muted">{isError ? "Burns appear here in a moment." : "The first burn appears here as soon as it lands."}</p>
        ) : (
          <table className="rc-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Source</th>
                <th scope="col" className="num">Amount</th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((b) => (
                <tr key={`${b.tx}-${b.source}-${b.amount}`}>
                  <td title={b.time ? utc(b.time) : undefined}>{b.time ? ago(b.time, now) : `Block ${b.block}`}</td>
                  <td>{BURN_SOURCES[b.source] ?? `Source ${b.source}`}</td>
                  <td className="num mono">{orry(b.amount)} ORRY</td>
                  <td><TxLink hash={b.tx} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
