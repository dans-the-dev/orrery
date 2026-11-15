"use client";

import Link from "next/link";
import type { Abi, Address } from "viem";
import { useReadContract } from "wagmi";
import { iAgentLaunchAbi } from "@orrery/shared";
import { ORRY } from "@/lib/orry/config";
import { useLaunchCoins } from "@/lib/launch/api";
import { useNow } from "@/lib/orry/chain";
import { ago, orry, span } from "@/lib/orry/format";
import { Fig, OrryHead, Row } from "../orry/parts";
import { FeeSplit } from "./shell";

/** Price in ORRY per coin with enough digits for a small number. */
export function coinPrice(v: string | bigint): string {
  const n = Number(BigInt(v)) / 1e18;
  if (n === 0) return "0";
  return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

export function LaunchList() {
  const q = useLaunchCoins();
  const now = useNow();
  const t = q.data?.totals;
  const params = useReadContract({ address: ORRY.agentLaunch as Address, abi: iAgentLaunchAbi as Abi, functionName: "params", query: { staleTime: Infinity } })
    .data as { minStakeUsd: bigint } | undefined;
  return (
    <>
      <OrryHead
        title="Coins from verified agents."
        lead={
          <p>
            Only agents Orrery has verified can launch a coin here, each against ORRY, with its whole supply locked in its pool from
            the first block. Every trade pays 1%, and half of it goes to the agent&apos;s own account, where its spending caps are public.
          </p>
        }
        reading={
          <div className="rc-card">
            <p className="rc-card-title">Agent Launch</p>
            <p className="rc-big">
              <Fig v={t ? orry(BigInt(t.volumeOrry)) : undefined} unit="ORRY traded" />
            </p>
            <dl className="rc-rows">
              <Row label="Coins launched">{t ? t.coins.toLocaleString("en-US") : "…"}</Row>
              <Row label="Paid to agents">{t ? `${orry(BigInt(t.creatorFees))} ORRY` : "…"}</Row>
              <Row label="Burned">{t ? `${orry(BigInt(t.burned))} ORRY` : "…"}</Row>
            </dl>
          </div>
        }
      />
      <FeeSplit label="Where every trade's 1% goes" />
      <div className="ln-actions">
        <Link className="primary" href="/launch/new">
          Launch your agent&apos;s coin
        </Link>
        <span className="rc-muted">
          Needs a verified agent with {params ? `${(Number(params.minStakeUsd) / 1e6).toLocaleString("en-US")} USD of ` : ""}ORRY staked behind it for 90 days.
        </span>
      </div>
      <section className="rc-panel" aria-label="Launched coins">
        <div className="rc-panel-head">
          <h2>Launched coins</h2>
        </div>
        {q.data && q.data.coins.length === 0 ? (
          <p className="rc-muted">The first coin appears here the moment an agent launches it.</p>
        ) : (
          <table className="rc-table">
            <thead>
              <tr>
                <th scope="col">Coin</th>
                <th scope="col">Agent</th>
                <th scope="col" className="num">Price, ORRY</th>
                <th scope="col" className="num">Traded, ORRY</th>
                <th scope="col" className="num">Trades</th>
                <th scope="col">Opened</th>
              </tr>
            </thead>
            <tbody>
              {(q.data?.coins ?? []).map((c) => {
                const early = c.publicOpenAt > now;
                return (
                  <tr key={c.coin}>
                    <td data-label="Coin">
                      <Link className="ln-coin" href={`/launch/${c.coin}`}>
                        <strong>{c.name}</strong>
                        <small>{c.symbol}</small>
                      </Link>
                    </td>
                    <td data-label="Agent">Agent {c.agentId}</td>
                    <td data-label="Price, ORRY" className="num mono">{coinPrice(c.priceOrry)}</td>
                    <td data-label="Traded, ORRY" className="num mono">{orry(BigInt(c.volumeOrry))}</td>
                    <td data-label="Trades" className="num mono">{c.trades.toLocaleString("en-US")}</td>
                    <td data-label="Opened">{early ? `Stakers first, public in ${span(c.publicOpenAt - now)}` : ago(c.launchedAt, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {q.isError ? <p className="rc-muted">The list is loading again in a moment.</p> : null}
      </section>
    </>
  );
}
