"use client";

import { useMemo, useState } from "react";
import { keccak256, toBytes, type Abi, type Address, type Hex } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { BOOST_KINDS, orryBoostAbi, templateMarketAbi, type CommunityTemplate } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { NoticeLine, OrryHead, Row } from "@/components/orry/parts";
import { USDG_DECIMALS } from "@/lib/config";
import { useTemplates } from "@/lib/community/api";
import { useCommunity, type CommunityConfig } from "@/lib/community/config";
import { percent, sameAddr, usd, withHeadroom } from "@/lib/community/logic";
import { useCommunityTx, type Run } from "@/lib/community/tx";
import { big, time } from "@/lib/orry/api";
import { useNow, useWallet } from "@/lib/orry/chain";
import { mask, parseAmount, orry, span } from "@/lib/orry/format";

const marketAbi = templateMarketAbi as Abi;
const boostAbi = orryBoostAbi as Abi;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export function TemplatesView() {
  const { config, live } = useCommunity();
  if (!config) return null;
  return <Templates cfg={config} boostOpen={live("burn-to-boost")} />;
}

function Templates({ cfg, boostOpen }: { cfg: CommunityConfig; boostOpen: boolean }) {
  const { address, ready, connected } = useWallet();
  const q = useTemplates(true);
  const now = useNow(5000);
  const tx = useCommunityTx();
  const [actedOn, setActedOn] = useState<number | null>(null);
  const market = cfg.addresses.templates as Address;
  const all = useMemo(() => q.data?.templates ?? [], [q.data]);
  const boostedUntil = (t: CommunityTemplate) => (t.boostedUntil ? time(t.boostedUntil) : 0);
  // Boosted listings first, then the market's order.
  const listed = all.filter((t) => t.listed).sort((a, b) => Number(boostedUntil(b) > now) - Number(boostedUntil(a) > now));
  const mine = all.filter((t) => sameAddr(t.creator, address));

  const reads = useReadContracts({
    allowFailure: true,
    contracts: listed.flatMap((t) => [
      { address: market, abi: templateMarketAbi, functionName: "quote" as const, args: [BigInt(t.id)] as const },
      { address: market, abi: templateMarketAbi, functionName: "licensed" as const, args: [BigInt(t.id), address ?? ZERO] as const },
    ]),
    query: { enabled: listed.length > 0, refetchInterval: 30_000 },
  });
  const quoteOf = (i: number) => (reads.data?.[i * 2]?.status === "success" ? (reads.data[i * 2]!.result as bigint) : undefined);
  const licensedOf = (i: number) => Boolean(address && reads.data?.[i * 2 + 1]?.status === "success" && reads.data[i * 2 + 1]!.result);

  async function buy(t: CommunityTemplate, quote: bigint) {
    const max = withHeadroom(quote);
    setActedOn(t.id);
    await tx.run("Buy template", async ({ send, step, approve }) => {
      await approve(cfg.addresses.orry as Address, market, max);
      step("Confirm the purchase in your wallet.");
      await send({ address: market, abi: marketAbi, functionName: "buy", args: [BigInt(t.id), max] });
      return `Template ${t.id} is licensed to your wallet.`;
    });
  }

  return (
    <>
      <OrryHead
        title="Spending policies, written by operators."
        lead={
          <p>
            Policy templates for agent spending limits, priced in USD and paid in ORRY. {percent(cfg.templateBurnBps)} of each sale is burned and the rest goes to the template&apos;s creator.
          </p>
        }
      />
      <section className="rc-panel rc-board" aria-label="Templates">
        <div className="rc-panel-head">
          <h2>Templates</h2>
          <p>Each licence is held by the buying wallet for good. The content hash lets you check the file at its address before you buy.</p>
        </div>
        {q.isLoading ? (
          <p className="rc-muted">…</p>
        ) : listed.length === 0 ? (
          <p className="rc-muted">{q.isError ? "Templates appear here in a moment." : "The first templates appear here as creators list them."}</p>
        ) : (
          <table className="rc-table cm-templates">
            <thead>
              <tr>
                <th scope="col">Template</th>
                <th scope="col">Creator</th>
                <th scope="col" className="num">Price</th>
                <th scope="col" className="num">Sales</th>
                <th scope="col" className="num">
                  <span className="cm-sr">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {listed.map((t, i) => {
                const quote = quoteOf(i);
                const own = sameAddr(t.creator, address);
                const licensed = licensedOf(i);
                const until = boostedUntil(t);
                return (
                  <tr key={t.id}>
                    <td>
                      <strong className="cm-tpl-name">Template {t.id}</strong>
                      {until > now ? <span className="cm-boosted">Boosted, {span(until - now)} left</span> : null}
                      <TemplateLinks t={t} />
                    </td>
                    <td className="mono" data-label="Creator">
                      {own ? "You" : mask(t.creator)}
                    </td>
                    <td className="num" data-label="Price">
                      <span className="mono">{usd(big(t.priceUsd))}</span>
                      <small className="cm-sub mono">{quote !== undefined ? `${orry(quote)} ORRY now` : "…"}</small>
                    </td>
                    <td className="num mono" data-label="Sales">
                      {t.sales.toLocaleString("en-US")}
                    </td>
                    <td className="num">
                      {own ? (
                        <span className="cm-state">Yours</span>
                      ) : licensed ? (
                        <span className="cm-state">Licensed</span>
                      ) : connected ? (
                        <button className="secondary" type="button" disabled={!ready || Boolean(tx.busy) || quote === undefined} onClick={() => quote !== undefined && void buy(t, quote)}>
                          {tx.busy && actedOn === t.id ? "Buying…" : "Buy"}
                        </button>
                      ) : null}
                      {actedOn === t.id ? <NoticeLine notice={tx.notice} /> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {!connected && listed.length > 0 ? (
          <div className="rc-connect">
            <p>Connect a wallet to buy a template.</p>
            <WalletButton />
          </div>
        ) : null}
      </section>
      <div className="rc-grid cm-after">
        <ListForm cfg={cfg} />
        <section className="rc-side" aria-label="Your templates">
          <h2>Your templates</h2>
          {!address ? (
            <p className="rc-muted">Templates you list show here once a wallet is connected.</p>
          ) : mine.length === 0 ? (
            <p className="rc-muted">{q.isLoading ? "…" : "No templates listed from this wallet yet."}</p>
          ) : (
            <ul className="cm-mine">
              {mine.map((t) => (
                <MyTemplate key={t.id} cfg={cfg} t={t} boostOpen={boostOpen} run={tx.run} busy={Boolean(tx.busy)} onAct={() => setActedOn(t.id)} notice={actedOn === t.id ? tx.notice : null} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function TemplateLinks({ t }: { t: CommunityTemplate }) {
  const href = /^https?:\/\//i.test(t.uri) ? t.uri : undefined;
  return (
    <span className="cm-sub">
      {href ? (
        <a className="cm-link" href={href} target="_blank" rel="noreferrer">
          Open file
        </a>
      ) : t.uri ? (
        <span className="mono">{t.uri}</span>
      ) : null}
      <span className="mono" title={t.contentHash}>
        {shortHash(t.contentHash)}
      </span>
    </span>
  );
}

/** List a template: USD price within the market's range, the content hash of the policy JSON, and where the file lives. */
function ListForm({ cfg }: { cfg: CommunityConfig }) {
  const { ready, connected } = useWallet();
  const tx = useCommunityTx();
  const market = cfg.addresses.templates as Address;
  const bounds = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: market, abi: templateMarketAbi, functionName: "minPriceUsd" },
      { address: market, abi: templateMarketAbi, functionName: "maxPriceUsd" },
    ],
    query: { staleTime: Infinity },
  });
  const min = bounds.data?.[0]?.status === "success" ? (bounds.data[0].result as bigint) : undefined;
  const max = bounds.data?.[1]?.status === "success" ? (bounds.data[1].result as bigint) : undefined;
  const [priceIn, setPriceIn] = useState("");
  const [json, setJson] = useState("");
  const [uri, setUri] = useState("");
  const price = parseAmount(priceIn, USDG_DECIMALS);
  const inRange = price !== undefined && (min === undefined || price >= min) && (max === undefined || price <= max);
  const parsed = useMemo(() => {
    if (!json.trim()) return undefined;
    try {
      JSON.parse(json);
      return keccak256(toBytes(json)) as Hex;
    } catch {
      return null;
    }
  }, [json]);

  async function list() {
    if (!price || !parsed || !uri.trim()) return;
    const u = uri.trim();
    await tx.run("List template", async ({ send }) => {
      await send({ address: market, abi: marketAbi, functionName: "list", args: [price, parsed, u] });
      setPriceIn("");
      setJson("");
      setUri("");
      return "Listed. It appears in the market in a moment.";
    });
  }

  return (
    <section className="rc-desk" aria-label="List a template">
      <div className="rc-desk-body">
        <h2 className="cm-desk-title">List a template</h2>
        <div className="rc-amount">
          <label htmlFor="cm-tpl-price">Price per licence</label>
          <div className="rc-amount-box">
            <input id="cm-tpl-price" inputMode="decimal" autoComplete="off" placeholder="0.00" value={priceIn} onChange={(e) => setPriceIn(e.target.value.replace(/[^\d.]/g, ""))} />
            <span className="rc-unit">USD</span>
          </div>
          <div className="rc-amount-foot">
            <span>{min !== undefined && max !== undefined ? `From ${usd(min)} to ${usd(max)}. Buyers pay it in ORRY at the live price.` : "Buyers pay it in ORRY at the live price."}</span>
          </div>
        </div>
        <div>
          <label className="cm-label" htmlFor="cm-tpl-json">
            Policy JSON
          </label>
          <textarea id="cm-tpl-json" className="cm-code" rows={6} spellCheck={false} placeholder='{ "caps": [] }' value={json} onChange={(e) => setJson(e.target.value)} />
          <p className="cm-field-foot">{parsed === null ? "This is not valid JSON." : parsed ? <span className="mono">Content hash {shortHash(parsed)}</span> : "Paste the exact file you host. Its keccak256 hash is recorded with the listing."}</p>
        </div>
        <div>
          <label className="cm-label" htmlFor="cm-tpl-uri">
            File address
          </label>
          <input id="cm-tpl-uri" className="cm-input" autoComplete="off" spellCheck={false} placeholder="https:// or ipfs://" value={uri} onChange={(e) => setUri(e.target.value)} />
        </div>
        {connected ? (
          <button className="primary rc-go" type="button" disabled={!ready || Boolean(tx.busy) || !inRange || !parsed || !uri.trim()} onClick={() => void list()}>
            {tx.busy ? "Listing…" : "List template"}
          </button>
        ) : (
          <div className="rc-connect">
            <p>Connect a wallet to list a template.</p>
            <WalletButton />
          </div>
        )}
        <NoticeLine notice={tx.notice} />
      </div>
    </section>
  );
}

/** One of the creator's templates: reprice, delist or relist, and boost the listing for 24 hours. */
function MyTemplate({ cfg, t, boostOpen, run, busy, onAct, notice }: { cfg: CommunityConfig; t: CommunityTemplate; boostOpen: boolean; run: Run; busy: boolean; onAct: () => void; notice: ReturnType<typeof useCommunityTx>["notice"] }) {
  const { ready } = useWallet();
  const market = cfg.addresses.templates as Address;
  const boost = cfg.addresses.boost;
  const [priceIn, setPriceIn] = useState("");
  const price = parseAmount(priceIn, USDG_DECIMALS);
  const boostQuote = useReadContract({ address: boost ?? undefined, abi: orryBoostAbi, functionName: "quote", args: [BOOST_KINDS.template, 1n], query: { enabled: Boolean(boost && boostOpen && t.listed), refetchInterval: 30_000 } });

  async function reprice() {
    if (!price) return;
    onAct();
    await run("Reprice", async ({ send }) => {
      await send({ address: market, abi: marketAbi, functionName: "setPrice", args: [BigInt(t.id), price] });
      setPriceIn("");
      return `Template ${t.id} now costs ${usd(price)}.`;
    });
  }
  async function setListed(listed: boolean) {
    onAct();
    await run(listed ? "Relist" : "Delist", async ({ send }) => {
      await send({ address: market, abi: marketAbi, functionName: "setListed", args: [BigInt(t.id), listed] });
      return listed ? `Template ${t.id} is for sale again.` : `Template ${t.id} is off the market. Licences already sold stay with their buyers.`;
    });
  }
  async function boostIt() {
    if (!boost || boostQuote.data === undefined) return;
    const max = withHeadroom(boostQuote.data);
    onAct();
    await run("Boost", async ({ send, step, approve }) => {
      await approve(cfg.addresses.orry as Address, boost, max);
      step("Confirm the boost in your wallet.");
      await send({ address: boost, abi: boostAbi, functionName: "boost", args: [BOOST_KINDS.template, BigInt(t.id), 1n, max] });
      return `Template ${t.id} is boosted for 24 hours. The ORRY paid is burned.`;
    });
  }

  return (
    <li className="rc-agent">
      <div className="rc-agent-head">
        <strong>Template {t.id}</strong>
        <span>{t.listed ? `For sale at ${usd(big(t.priceUsd))} · ${t.sales.toLocaleString("en-US")} sold` : `Off the market · ${t.sales.toLocaleString("en-US")} sold`}</span>
      </div>
      <dl className="rc-rows rc-rows-tight">
        <Row label="Content hash">
          <span title={t.contentHash}>{shortHash(t.contentHash)}</span>
        </Row>
      </dl>
      <div className="rc-agent-actions">
        <div className="rc-inline">
          <input aria-label={`New price for template ${t.id}, USD`} inputMode="decimal" autoComplete="off" placeholder="New price, USD" value={priceIn} onChange={(e) => setPriceIn(e.target.value.replace(/[^\d.]/g, ""))} />
          <button className="secondary" type="button" disabled={!ready || busy || !price} onClick={() => void reprice()}>
            Reprice
          </button>
        </div>
        <button className="secondary" type="button" disabled={!ready || busy} onClick={() => void setListed(!t.listed)}>
          {t.listed ? "Delist" : "Relist"}
        </button>
        {boostOpen && boost && t.listed ? (
          <button className="secondary" type="button" disabled={!ready || busy || boostQuote.data === undefined} onClick={() => void boostIt()}>
            Boost 24 h{boostQuote.data !== undefined ? ` · ${orry(boostQuote.data)} ORRY` : ""}
          </button>
        ) : null}
      </div>
      <NoticeLine notice={notice} />
    </li>
  );
}
