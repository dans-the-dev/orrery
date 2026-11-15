"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Abi, Address } from "viem";
import { useReadContracts } from "wagmi";
import { iDataProviderRegistryAbi } from "@orrery/shared";
import { API_URL, ADDRESSES } from "@/lib/config";
import { short } from "@/lib/format";
import { dollars, useDataProviders } from "@/lib/data/api";
import { useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { ExitConnect, Fig, NoticeLine, OrryHead, Row } from "../orry/parts";

const abi = iDataProviderRegistryAbi as Abi;
const n = (v: number | string) => Number(v).toLocaleString("en-US");
const payments = (count: number) => (count === 0 ? "" : `, ${n(count)} ${count === 1 ? "payment" : "payments"} in 30 days`);

export function ProvidersView() {
  const list = useDataProviders();
  const { address, connected } = useWallet();
  const min = list.data?.minStakeUsd;
  return (
    <>
      <OrryHead
        kicker="Data providers"
        title="Sell data to agents, paid per call."
        lead={
          <p>
            List your x402 endpoint with an ORRY stake worth at least {min ? dollars(min) : <Fig />}. Agents pay your payment address; Orrery keeps 1% and forwards
            the rest to your wallet.
          </p>
        }
      />
      <section className="mc-sec">
        <h2>Providers</h2>
        {list.isLoading ? (
          <dl className="rc-rows"><Row label="Providers"><Fig /></Row></dl>
        ) : (list.data?.providers.filter((p) => p.active) ?? []).length === 0 ? (
          <p className="mc-note">The first listed providers appear here.</p>
        ) : (
          <ul className="mc-dir">
            {list.data!.providers
              .filter((p) => p.active)
              .map((p) => (
                <li key={p.provider}>
                  <div>
                    <strong>{p.name}</strong>
                    {p.description ? <p>{p.description}</p> : null}
                    <p>
                      {dollars(p.priceUsdg)} a call, {dollars(p.stakeUsd)} staked
                      {payments(p.settled30d.reduce((a, s) => a + s.payments, 0))}
                    </p>
                  </div>
                  <div className="mc-dir-meta">
                    <a href={p.endpoint} target="_blank" rel="noreferrer">{p.endpoint.replace(/^https:\/\//, "")}</a>
                    <code>{short(p.splitter)}</code>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </section>
      {!address ? (
        <section className="mc-sec">
          <h2>Your listing</h2>
          <ExitConnect text={connected ? "Switch your wallet to this network to manage your listing." : "Connect the wallet that receives payments for your data."} />
        </section>
      ) : (
        <Listing provider={address} onChange={() => void list.refetch()} />
      )}
    </>
  );
}

function Listing({ provider, onChange }: { provider: Address; onChange: () => void }) {
  const tx = useTx();
  const registry = ORRY.dataRegistry!;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: registry, abi, functionName: "listing", args: [provider] },
      { address: registry, abi, functionName: "stakeUsdOf", args: [provider] },
      { address: registry, abi, functionName: "minStakeUsd" },
      { address: registry, abi, functionName: "splitterOf", args: [provider] },
      { address: registry, abi, functionName: "isActive", args: [provider] },
    ],
    query: { refetchInterval: 15_000 },
  });
  const listing = reads.data?.[0]?.status === "success" ? (reads.data[0].result as { listedAt: bigint; priceUsdg: bigint }) : undefined;
  const stake = reads.data?.[1]?.status === "success" ? (reads.data[1].result as bigint) : undefined;
  const min = reads.data?.[2]?.status === "success" ? (reads.data[2].result as bigint) : undefined;
  const splitter = reads.data?.[3]?.status === "success" ? (reads.data[3].result as Address) : undefined;
  const active = reads.data?.[4]?.status === "success" ? (reads.data[4].result as boolean) : undefined;
  const listed = Boolean(listing && listing.listedAt > 0n);
  const mine = useDataProviders().data?.providers.find((p) => p.provider.toLowerCase() === provider.toLowerCase());

  const [endpoint, setEndpoint] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("0.001");
  useEffect(() => {
    if (!mine) return;
    setEndpoint(mine.endpoint);
    setName(mine.name);
    setDescription(mine.description);
    setPrice(String(Number(mine.priceUsdg) / 1e6));
  }, [mine?.provider, mine?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const priceUnits = /^\d+(\.\d{1,6})?$/.test(price) ? BigInt(Math.round(Number(price) * 1e6)) : 0n;
  const valid = /^https:\/\/\S{4,192}$/.test(endpoint) && name.trim().length >= 2 && name.trim().length <= 40 && description.length <= 280 && priceUnits > 0n;
  const staked = stake !== undefined && min !== undefined && stake >= min;

  async function save() {
    const fn = listed ? "update" : "list";
    const ok = await tx.run(listed ? "Update listing" : "List your endpoint", async ({ send }) => {
      await send({ address: registry, abi, functionName: fn, args: [endpoint, name.trim(), description, priceUnits] });
      return listed ? "Your listing is updated." : "Your endpoint is listed.";
    });
    if (ok) {
      void reads.refetch();
      onChange();
    }
  }
  async function remove() {
    const ok = await tx.run("Remove listing", async ({ send }) => {
      await send({ address: registry, abi, functionName: "unlist", args: [] });
      return "Your listing is removed.";
    });
    if (ok) {
      void reads.refetch();
      onChange();
    }
  }

  return (
    <>
      <section className="mc-sec">
        <h2>Your listing</h2>
        <dl className="rc-rows">
          <Row label="Status">{listing === undefined ? <Fig /> : listed ? (active ? "Listed" : "Listed, stake below the minimum") : "Not listed"}</Row>
          <Row label="Your ORRY stake" hint={min !== undefined ? `at least ${dollars(min)} to list` : undefined}>{stake === undefined ? <Fig /> : dollars(stake)}</Row>
          <Row label="Payment address">{splitter ? <code>{splitter}</code> : <Fig />}</Row>
        </dl>
        {stake !== undefined && !staked ? (
          <p className="mc-note">
            <Link href="/stake">Stake ORRY</Link> to reach the listing minimum.
          </p>
        ) : null}
        <div className="mc-form">
          <label className="field mc-wide">
            Endpoint
            <input value={endpoint} maxLength={200} placeholder="https://" onChange={(e) => setEndpoint(e.target.value.trim())} />
          </label>
          <label className="field">
            Name
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            Price per call, USD
            <input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value.trim())} />
          </label>
          <label className="field mc-wide">
            What the data is
            <textarea value={description} maxLength={280} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <div className="mc-actions">
          <button className="primary" type="button" disabled={Boolean(tx.busy) || !valid || !staked} onClick={() => void save()}>
            {listed ? "Update listing" : "List your endpoint"}
          </button>
          {listed ? (
            <button className="secondary" type="button" disabled={Boolean(tx.busy)} onClick={() => void remove()}>
              Remove listing
            </button>
          ) : null}
        </div>
        <NoticeLine notice={tx.notice} />
      </section>
      <section className="mc-sec">
        <h2>Take payments at your endpoint</h2>
        <p className="mc-note">
          Answer with x402 <code>exact</code> terms whose <code>payTo</code> is your payment address, and settle with Orrery&apos;s data facilitator
          {API_URL ? <> at <code>{`${API_URL}/v1/data/x402`}</code></> : null}. Agents pay in USDG{ADDRESSES.usdg ? <> (<code>{short(ADDRESSES.usdg)}</code>)</> : null} or in ORRY over Permit2.
          Orrery&apos;s keeper forwards what your payment address holds to your wallet; fees paid in ORRY are burned.
        </p>
      </section>
    </>
  );
}
