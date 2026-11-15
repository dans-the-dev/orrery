"use client";

import { useState } from "react";
import { useBoard } from "@/lib/orry/api";
import { assetFrac } from "@/lib/orry/earn";
import { amount, mask, orry } from "@/lib/orry/format";
import { OrryHead, Segmented } from "./parts";

type Kind = "stakers" | "earners";

export function LeaderboardView() {
  const [kind, setKind] = useState<Kind>("stakers");
  const { data, isError, isLoading } = useBoard(kind, 50);
  const rows = data ?? [];
  const hasStake = rows.some((r) => r.stake !== undefined);
  const hasEarned = rows.some((r) => r.earned !== undefined);
  const hasValue = rows.some((r) => r.valueOrry !== undefined);

  return (
    <>
      <OrryHead
        title="Top stakers and top earners."
        lead={<p>Ranked by ORRY staked and by everything earned from Earn and Stake, claimed or still pending, valued in ORRY at each pool&apos;s price. Addresses show their first and last characters.</p>}
      />
      <section className="rc-panel rc-board" aria-label="Leaderboard">
        <Segmented
          label="Leaderboard"
          value={kind}
          onChange={setKind}
          options={[
            { id: "stakers", label: "Top stakers" },
            { id: "earners", label: "Top earners" },
          ]}
        />
        {isLoading ? (
          <p className="rc-muted">…</p>
        ) : rows.length === 0 ? (
          <p className="rc-muted">{isError ? "The leaderboard appears here in a moment." : kind === "stakers" ? "The first stakers appear here as soon as they stake." : "The first earners appear here as soon as rewards stream."}</p>
        ) : (
          <table className="rc-table">
            <thead>
              <tr>
                <th scope="col" className="rank">Rank</th>
                <th scope="col">Address</th>
                {hasStake ? <th scope="col" className="num">Staked</th> : null}
                {hasEarned ? <th scope="col" className="num">Earned</th> : null}
                {hasValue ? <th scope="col" className="num">Value in ORRY</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${kind}-${r.rank}-${r.address}`} className={r.rank <= 3 ? "is-top" : undefined}>
                  <td className="rank mono">{r.rank}</td>
                  <td className="mono">{mask(r.address)}</td>
                  {hasStake ? <td className="num mono" data-label="Staked">{r.stake !== undefined ? `${orry(r.stake)} ORRY` : ""}</td> : null}
                  {hasEarned ? (
                    <td className="num mono" data-label="Earned">
                      {(r.earned ?? []).filter((e) => e.amount > 0n).map((e) => (
                        <span key={e.address} className="rc-asset-line">{`${amount(e.amount, { decimals: e.decimals, frac: assetFrac(e.symbol) })} ${e.symbol}`}</span>
                      ))}
                    </td>
                  ) : null}
                  {hasValue ? <td className="num mono" data-label="Value in ORRY">{r.valueOrry !== undefined ? orry(r.valueOrry) : ""}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
