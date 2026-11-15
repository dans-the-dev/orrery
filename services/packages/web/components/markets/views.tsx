"use client";

import Link from "next/link";
import { activeChain } from "@/lib/config";
import { useWallet } from "@/lib/orry/chain";
import { ago, amount } from "@/lib/orry/format";
import { useMarkets, type Market } from "@/lib/markets/api";
import { useHoldings } from "@/lib/markets/chain";
import { feedToPrice, pricePerToken, usd, usdg, usdgFor } from "@/lib/markets/math";
import { WalletButton } from "../WalletButton";
import { Fig, OrryHead, Row } from "../orry/parts";
import { BatchBook } from "./BatchBook";
import { MyOrders } from "./MyOrders";
import { OrderDesk } from "./OrderDesk";
import { StockMark } from "./parts";
import { useRuntime } from "./runtime";
import { MarketClock, MarketFacts, useMarketPick } from "./side";

/** Listed markets (each with its official logo) from the API, or the neutral state while they load. */
function useMarketList() {
  const q = useMarkets(activeChain.id);
  const markets = q.data?.markets ?? [];
  const waiting = q.isLoading || (q.isError && !q.data);
  return { markets, waiting, empty: !waiting && markets.length === 0, skew: q.data?.skew ?? 0 };
}

function Waiting({ empty }: { empty: boolean }) {
  return <p className="rc-muted mk-wait">{empty ? "Stock markets are listed here as each one opens." : "Stock markets appear here in a moment."}</p>;
}

const priceOf = (m: Market) => (m.price ? pricePerToken(feedToPrice(m.price.answer, m.price.decimals, m.decimals), m.decimals) : undefined);

export function SwapView() {
  const { markets, waiting, empty, skew } = useMarketList();
  const { m, pick } = useMarketPick(markets);
  return (
    <>
      <OrryHead
        title="Swap stock tokens with your order sealed."
        lead={<p>Your amount stays hidden on chain until the batch closes. This page reveals the order for you, and it settles at the batch&apos;s Chainlink price straight from and to your wallet.</p>}
        reading={m ? <div className="rc-card"><p className="rc-card-title">{m.name}<span>{m.symbol}</span></p><MarketClock m={m} skew={skew} /></div> : undefined}
      />
      {!m ? (
        <Waiting empty={empty || !waiting} />
      ) : (
        <>
          <div className="rc-grid">
            <OrderDesk mode={1} markets={markets} symbol={m.symbol} onSymbol={pick} skew={skew} />
            <aside className="rc-side">
              <h2>How a swap settles</h2>
              <ol className="mk-steps">
                <li>
                  <strong>Seal</strong>
                  <span>Only a hash of your order goes on chain. The amount and the side stay with you.</span>
                </li>
                <li>
                  <strong>Reveal</strong>
                  <span>When the sealing window closes, this page reveals the order from your wallet.</span>
                </li>
                <li>
                  <strong>Clear</strong>
                  <span>Matched orders settle at one Chainlink price. In a market with a Uniswap pool, the unmatched part fills there within a set distance of that price; anything left returns to your wallet in the same transaction.</span>
                </li>
              </ol>
              <MarketFacts m={m} />
            </aside>
          </div>
          <MyOrders markets={markets} mode={1} />
        </>
      )}
    </>
  );
}

export function DarkPoolView() {
  const { markets, waiting, empty, skew } = useMarketList();
  const { m, pick } = useMarketPick(markets);
  return (
    <>
      <OrryHead
        title="Large orders, crossed at one price."
        lead={<p>Limit orders here meet other orders only, at the Chainlink price when the batch clears, so size moves no price. Every order is sealed until its batch closes, then published in the book below.</p>}
        reading={m ? <div className="rc-card"><p className="rc-card-title">{m.name}<span>{m.symbol}</span></p><MarketClock m={m} skew={skew} /></div> : undefined}
      />
      {!m ? (
        <Waiting empty={empty || !waiting} />
      ) : (
        <>
          <div className="rc-grid">
            <OrderDesk mode={0} markets={markets} symbol={m.symbol} onSymbol={pick} skew={skew} />
            <aside className="rc-side">
              <h2>{m.name}</h2>
              <MarketFacts m={m} />
            </aside>
          </div>
          <BatchBook m={m} />
          <MyOrders markets={markets} market={m.market} mode={0} />
        </>
      )}
    </>
  );
}

export function StocksView() {
  const { markets, waiting, empty } = useMarketList();
  const { address } = useWallet();
  const rt = useRuntime();
  const held = useHoldings(markets.map((m) => m.asset), address);
  const value = (m: Market) => {
    const h = held?.get(m.asset.toLowerCase());
    return h !== undefined && m.price ? usdgFor(h, feedToPrice(m.price.answer, m.price.decimals, m.decimals)) : undefined;
  };
  const total = held && markets.length ? markets.reduce((s, m) => s + (value(m) ?? 0n), 0n) : undefined;
  const owned = held ? markets.filter((m) => (held.get(m.asset.toLowerCase()) ?? 0n) > 0n).length : 0;

  return (
    <>
      <OrryHead
        title="Stock tokens on Robinhood Chain."
        lead={<p>Each one trades against USDG in sealed batches, at its Chainlink price. Prices below come from the same feeds the markets clear at.</p>}
        reading={
          <div className="rc-card">
            <p className="rc-card-title">Your stock tokens</p>
            {address ? (
              <>
                <p className="rc-big">
                  <Fig v={total !== undefined ? usdg(total) : undefined} unit="USDG" />
                </p>
                <p className="rc-muted">{held ? (owned === 0 ? "None in this wallet yet." : owned === 1 ? "One stock token in this wallet, at today's prices." : `${owned} stock tokens in this wallet, at today's prices.`) : "…"}</p>
              </>
            ) : (
              <div className="rc-connect">
                <p>Connect a wallet to see your holdings.</p>
                <WalletButton />
              </div>
            )}
          </div>
        }
      />
      {markets.length === 0 ? (
        <Waiting empty={empty || !waiting} />
      ) : (
        <section className="rc-panel mk-stocks" aria-label="Stock tokens">
          <table className="rc-table">
            <thead>
              <tr>
                <th scope="col">Stock</th>
                <th scope="col" className="num">Price</th>
                <th scope="col">Updated</th>
                <th scope="col" className="num">You hold</th>
                <th scope="col" className="num">Value</th>
                <th scope="col">
                  <span className="sr-only">Trade</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => {
                const p = priceOf(m);
                const h = held?.get(m.asset.toLowerCase());
                const v = value(m);
                return (
                  <tr key={m.market}>
                    <td data-label="Stock">
                      <Link href={`/stocks/${m.symbol}`} className="mk-stock">
                        {m.logo ? <StockMark logo={m.logo} /> : null}
                        <span>
                          <strong>{m.name}</strong>
                          <small>{m.symbol}</small>
                        </span>
                      </Link>
                    </td>
                    <td data-label="Price" className="num mono">{p !== undefined ? `${usd(p)} USDG` : "Updating"}{m.fresh ? null : <small className="mk-sub">Next US session</small>}</td>
                    <td data-label="Updated">{m.price?.updatedAt ? ago(m.price.updatedAt, rt.now) : ""}</td>
                    <td data-label="You hold" className="num mono">{address ? (h === undefined ? "…" : `${amount(h, { decimals: m.decimals })} ${m.symbol}`) : ""}</td>
                    <td data-label="Value" className="num mono">{address && v !== undefined ? `${usdg(v)} USDG` : ""}</td>
                    <td data-label="">
                      <Link className="secondary mk-trade" href={`/stocks/${m.symbol}`}>
                        Trade
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

export function AssetView({ symbol }: { symbol: string }) {
  const { markets, waiting, empty, skew } = useMarketList();
  const { address } = useWallet();
  const rt = useRuntime();
  const m = markets.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
  const held = useHoldings(m ? [m.asset] : [], address);
  const h = m ? held?.get(m.asset.toLowerCase()) : undefined;
  const p = m ? priceOf(m) : undefined;

  if (!m) {
    return (
      <>
        <OrryHead title={symbol.toUpperCase()} />
        {waiting ? (
          <Waiting empty={false} />
        ) : (
          <p className="rc-muted mk-wait">
            {empty ? "Stock markets are listed here as each one opens." : `${symbol.toUpperCase()} is not listed.`} <Link href="/stocks">All stocks</Link>
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <OrryHead
        kicker={m.symbol}
        title={m.name}
        lead={<p>Buy or sell {m.symbol} for USDG in the next batch. The order stays sealed until the batch closes and settles at the Chainlink price.</p>}
        reading={
          <div className="rc-card">
            <p className="rc-card-title">
              <span className="mk-card-stock">
                {m.logo ? <StockMark logo={m.logo} size={28} /> : null}
                {m.symbol}
              </span>
              <span>{m.price?.updatedAt ? `Chainlink, ${ago(m.price.updatedAt, rt.now)}` : ""}</span>
            </p>
            <p className="rc-big">
              <Fig v={p !== undefined ? usd(p) : "Updating"} unit={p !== undefined ? "USDG" : undefined} />
            </p>
            {address ? (
              <dl className="rc-rows rc-rows-tight">
                <Row label="You hold">
                  <Fig v={h === undefined ? undefined : amount(h, { decimals: m.decimals })} unit={m.symbol} />
                </Row>
              </dl>
            ) : null}
          </div>
        }
      />
      <div className="rc-grid">
        <OrderDesk mode={1} markets={markets} symbol={m.symbol} fixed skew={skew} />
        <aside className="rc-side">
          <MarketClock m={m} skew={skew} />
          <MarketFacts m={m} />
          <p className="mk-more">
            Placing a large order? <Link href={`/dark-pool?stock=${m.symbol}`}>Set a limit in the Dark Pool</Link>
          </p>
        </aside>
      </div>
      <BatchBook m={m} />
      <MyOrders markets={markets} market={m.market} />
    </>
  );
}
