"use client";

import { useState } from "react";
import Link from "next/link";
import { isAddress } from "viem";
import { deployed } from "@/lib/config";
import { STATUS, short, usdg } from "@/lib/format";
import { useSignerView } from "@/lib/lens";

/** The hero console reads the public on-chain view for a paying address. It shows nothing it has not read. */
export function PayerConsole() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState<string>();
  const { data, isFetching, error } = useSignerView(query);
  const cap = data?.caps[0];
  const has = data && data.account !== "0x0000000000000000000000000000000000000000";
  const active = has && data.status === 1;
  const pct = cap && cap.perDay > 0n ? Number((cap.spentToday * 10000n) / cap.perDay) / 100 : 0;
  const state = !deployed ? "Lookups open soon" : !query ? "Enter a paying address" : has ? STATUS[data.status] : error ? "Read did not finish" : isFetching ? "Checking" : "No session for this address";

  return (
    <div className={`console${query ? "" : " is-idle"}`} aria-label="Payer check">
      <div className="console-head">
        <span>Check a payer</span>
        <span className="console-source">{isFetching ? "Reading the chain" : has ? "Read from the chain" : "Public read"}</span>
      </div>
      <form
        className="console-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (isAddress(input.trim())) setQuery(input.trim());
        }}
      >
        <input id="c-payer" placeholder="0x… paying address" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Payer address" spellCheck={false} />
        <button type="submit" disabled={!deployed || !isAddress(input.trim())}>Run check</button>
      </form>
      <div className={`console-state${active ? " is-active" : ""}`}>
        <i aria-hidden="true" />
        <strong>{state}</strong>
        {has ? <span>{data.attestation.endpointsLive ? "Endpoints live" : "No live probe"}</span> : null}
      </div>
      <div className="console-grid">
        <div className="console-day">
          <small>Spent today</small>
          <strong>{cap ? usdg(cap.spentToday) : "·"}<em> of {cap ? usdg(cap.perDay) : "·"} USDG</em></strong>
          <span className="console-track"><i style={{ width: `${Math.min(100, pct)}%` }} /></span>
        </div>
        <div>
          <small>Per payment</small>
          <strong>{cap ? usdg(cap.perTx) : "·"}</strong>
        </div>
        <div>
          <small>Float ceiling</small>
          <strong>{cap ? usdg(cap.floatMax) : "·"}</strong>
        </div>
      </div>
      <div className="console-foot">
        <span>{has ? `Account ${short(data.account)}` : "Signed checks through the API"}</span>
        {has ? <Link href={`/signer/${query}`}>Full record</Link> : <Link href="/dashboard/credits">Get credits</Link>}
      </div>
    </div>
  );
}
