"use client";

import { useMemo, useState } from "react";
import { formatUnits, parseAbi, type Abi, type Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { iPredictionMarketAbi, iPredictionMarketFactoryAbi, type PredictMarketView } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { usePredictMarkets, useR2Account } from "@/lib/r2/api";
import { useNow, useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { mask, parseAmount, orry, span, utc } from "@/lib/orry/format";
import { usdg } from "@/lib/markets/math";
import { USDG_DECIMALS } from "@/lib/config";
import { AmountField, Fig, NoticeLine, OrryHead, Row, Segmented } from "../orry/parts";

const FACTORY = ORRY.predictFactory as Address;
const factoryAbi = iPredictionMarketFactoryAbi as Abi;
const marketAbi = iPredictionMarketAbi as Abi;
const erc20 = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const feedAbi = parseAbi([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const oracleAbi = parseAbi(["function orryFor(uint256 usd) view returns (uint256)", "function ready() view returns (bool)"]);
const symbolAbi = parseAbi(["function symbol() view returns (string)"]);

const price = (v: string | bigint, decimals: number) => {
  const n = Number(formatUnits(BigInt(v), decimals));
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n >= 100 ? 2 : 4 });
};
const label = (m: PredictMarketView) => m.label.replace(/\s*\/\s*USD$/i, "");
const STATUS: Record<PredictMarketView["status"], string> = {
  open: "Open",
  locked: "Staking closed",
  closed: "Settling",
  yes: "Settled YES",
  no: "Settled NO",
  refund: "Refunded",
};

/** The pool split: how the stakes stand on each side, which is also what each side pays out per USDG. */
function Split({ yes, no }: { yes: bigint; no: bigint }) {
  const total = yes + no;
  const y = total === 0n ? 50 : Number((yes * 1000n) / total) / 10;
  return (
    <div className="r2-split" role="img" aria-label={`YES ${y.toFixed(1)}%, NO ${(100 - y).toFixed(1)}%`}>
      <span className="r2-split-yes" style={{ flexBasis: `${y}%` }} />
      <span className="r2-split-no" style={{ flexBasis: `${100 - y}%` }} />
      <small>
        <b>YES {total === 0n ? "0%" : `${y.toFixed(0)}%`}</b>
        <b>NO {total === 0n ? "0%" : `${(100 - y).toFixed(0)}%`}</b>
      </small>
    </div>
  );
}

function Reading({ markets, now }: { markets?: PredictMarketView[]; now: number }) {
  const open = (markets ?? []).filter((m) => m.status === "open");
  const next = open.reduce<number | undefined>((t, m) => (t === undefined || m.closeTime < t ? m.closeTime : t), undefined);
  const pool = open.reduce((s, m) => s + BigInt(m.yesPool) + BigInt(m.noPool), 0n);
  return (
    <div className="rc-card">
      <p className="rc-card-title">Open markets</p>
      <p className="rc-big">
        <Fig v={markets ? usdg(pool) : undefined} unit="USDG staked" />
      </p>
      <dl className="rc-rows">
        <Row label="Taking stakes">{markets ? open.length.toLocaleString("en-US") : "…"}</Row>
        <Row label="Next close">{markets ? (next ? `in ${span(next - now)}` : "None open") : "…"}</Row>
      </dl>
    </div>
  );
}

function StakeDesk({ m, now }: { m: PredictMarketView; now: number }) {
  const { address, ready } = useWallet();
  const tx = useTx();
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [amt, setAmt] = useState("");
  const usdgAddr = useReadContract({ address: FACTORY, abi: factoryAbi, functionName: "usdg", query: { staleTime: Infinity } }).data as Address | undefined;
  const bal = useReadContract({ address: usdgAddr, abi: erc20, functionName: "balanceOf", args: address ? [address] : undefined, query: { enabled: Boolean(usdgAddr && address) } }).data;
  const open = m.status === "open" && now < m.lockTime;
  async function stake() {
    const a = parseAmount(amt, USDG_DECIMALS);
    if (!address || !a || !usdgAddr) return;
    await tx.run("Stake", async ({ send, step }) => {
      step("Approve USDG for this market in your wallet.");
      await send({ address: usdgAddr, abi: erc20 as Abi, functionName: "approve", args: [m.market as Address, a] });
      step("Confirm the stake in your wallet.");
      await send({ address: m.market as Address, abi: marketAbi, functionName: "stake", args: [side === "yes", a] });
      setAmt("");
      return `Staked ${usdg(a)} USDG on ${side.toUpperCase()}.`;
    });
  }
  return (
    <section className="rc-desk r2-desk" aria-label="Stake on this market">
      <h2 className="r2-desk-title">
        {label(m)} above {price(m.strike, m.decimals)} USD at {utc(m.closeTime)}
      </h2>
      <Split yes={BigInt(m.yesPool)} no={BigInt(m.noPool)} />
      {open ? (
        <div className="rc-desk-body">
          <Segmented label="Side" value={side} onChange={setSide} options={[{ id: "yes", label: "YES, above" }, { id: "no", label: "NO, at or below" }]} />
          <AmountField id="predict-amt" label="USDG to stake" unit="USDG" value={amt} onChange={setAmt} max={bal !== undefined ? usdg(bal as bigint) : undefined} onMax={() => bal !== undefined && setAmt(formatUnits(bal as bigint, USDG_DECIMALS))} hint={`Staking closes in ${span(m.lockTime - now)}`} />
          {ready ? (
            <button className="primary rc-go" type="button" disabled={Boolean(tx.busy) || !parseAmount(amt, USDG_DECIMALS)} onClick={() => void stake()}>
              {tx.busy ? "Staking…" : `Stake on ${side.toUpperCase()}`}
            </button>
          ) : (
            <WalletButton />
          )}
          <NoticeLine notice={tx.notice} />
        </div>
      ) : (
        <p className="rc-muted">{m.status === "locked" ? `Staking closed. The market closes in ${span(m.closeTime - now)}.` : m.status === "closed" ? "The close has passed. Settlement uses the first Chainlink price published after it." : STATUS[m.status]}</p>
      )}
    </section>
  );
}

export function Positions({ markets }: { markets: PredictMarketView[] }) {
  const { address } = useWallet();
  const acc = useR2Account(address);
  const tx = useTx();
  const [inOrry, setInOrry] = useState(false);
  // every position of this wallet, with the market's details when the market list is readable
  const rows = (acc.data?.predict ?? []).map((p) => ({ p, m: markets.find((x) => x.market === p.market) }));
  if (!address || rows.length === 0) return null;
  async function claim(market: string) {
    await tx.run("Claim", async ({ send, step }) => {
      if (inOrry && ORRY.token) {
        step("Approve ORRY for the fee in your wallet.");
        await send({ address: ORRY.token, abi: erc20 as Abi, functionName: "approve", args: [market as Address, 2n ** 256n - 1n] });
      }
      await send({ address: market as Address, abi: marketAbi, functionName: "claim", args: [inOrry] });
      return "Paid to your wallet.";
    });
  }
  return (
    <section className="rc-panel" aria-label="Your positions">
      <div className="rc-panel-head">
        <h2>Your positions</h2>
        <label className="r2-check">
          <input type="checkbox" checked={inOrry} onChange={(e) => setInOrry(e.target.checked)} /> Pay the fee in ORRY, 25% off
        </label>
      </div>
      <table className="rc-table">
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col" className="num">YES</th>
            <th scope="col" className="num">NO</th>
            <th scope="col">Result</th>
            <th scope="col"><span className="sr-only">Claim</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ p, m }) => {
            const settled = !m || m.status === "yes" || m.status === "no" || m.status === "refund";
            const won = !m || m.status === "refund" || (m.status === "yes" ? BigInt(p.yes) > 0n : m.status === "no" ? BigInt(p.no) > 0n : false);
            return (
              <tr key={p.market}>
                <td data-label="Market">{m ? `${label(m)} above ${price(m.strike, m.decimals)}` : <span className="mono">{mask(p.market)}</span>}</td>
                <td data-label="YES" className="num mono">{usdg(BigInt(p.yes))}</td>
                <td data-label="NO" className="num mono">{usdg(BigInt(p.no))}</td>
                <td data-label="Result">{p.claimed ? `Paid ${usdg(BigInt(p.payout ?? "0"))} USDG` : m ? STATUS[m.status] : ""}</td>
                <td>
                  {settled && won && !p.claimed ? (
                    <button type="button" className="secondary" disabled={Boolean(tx.busy)} onClick={() => void claim(p.market)}>
                      {m?.status === "refund" ? "Take back" : "Claim"}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <NoticeLine notice={tx.notice} />
    </section>
  );
}

function CreateMarket() {
  const { address, ready } = useWallet();
  const tx = useTx();
  const count = useReadContract({ address: FACTORY, abi: factoryAbi, functionName: "feedCount" }).data as bigint | undefined;
  const feedAddrs = useReadContracts({
    contracts: Array.from({ length: Number(count ?? 0n) }, (_, i) => ({ address: FACTORY, abi: factoryAbi, functionName: "feedAt", args: [BigInt(i)] })),
    query: { enabled: count !== undefined },
  }).data?.map((r) => r.result as Address | undefined).filter(Boolean) as Address[] | undefined;
  const meta = useReadContracts({
    contracts: (feedAddrs ?? []).flatMap((f) => [
      { address: f, abi: feedAbi, functionName: "description" },
      { address: f, abi: feedAbi, functionName: "decimals" },
      { address: f, abi: feedAbi, functionName: "latestRoundData" },
      { address: FACTORY, abi: factoryAbi, functionName: "assetOfFeed", args: [f] },
    ]),
    query: { enabled: Boolean(feedAddrs?.length) },
  }).data;
  const assets = (feedAddrs ?? []).map((_, i) => meta?.[i * 4 + 3]?.result as Address | undefined);
  const symbols = useReadContracts({
    contracts: assets.map((a) => ({ address: a, abi: symbolAbi, functionName: "symbol" })),
    query: { enabled: assets.some(Boolean) },
  }).data;
  const feeds = (feedAddrs ?? []).map((f, i) => ({
    feed: f,
    // the feed's own description; a feed without one is named after the stock token it is bound to
    name: String(meta?.[i * 4]?.result ?? (symbols?.[i]?.result ? `${symbols[i]!.result}` : "Price feed")).replace(/\s*\/\s*USD$/i, ""),
    decimals: Number(meta?.[i * 4 + 1]?.result ?? 8),
    answer: (meta?.[i * 4 + 2]?.result as readonly bigint[] | undefined)?.[1],
  }));
  const [feed, setFeed] = useState<Address | "">("");
  const [strike, setStrike] = useState("");
  const [hours, setHours] = useState(24);
  const chosen = feeds.find((f) => f.feed === feed) ?? feeds[0];
  const params = useReadContract({ address: FACTORY, abi: factoryAbi, functionName: "params", query: { staleTime: Infinity } }).data as { creationFeeUsd: bigint } | undefined;
  const oracle = useReadContract({ address: FACTORY, abi: factoryAbi, functionName: "orryPrice", query: { staleTime: Infinity } }).data as Address | undefined;
  const fee = useReadContract({ address: oracle, abi: oracleAbi, functionName: "orryFor", args: params ? [params.creationFeeUsd] : undefined, query: { enabled: Boolean(oracle && params && params.creationFeeUsd > 0n) } }).data as bigint | undefined;

  async function create() {
    if (!chosen || !address) return;
    const s = parseAmount(strike, chosen.decimals);
    if (!s) return;
    const close = BigInt(Math.floor(Date.now() / 1000) + hours * 3600 + 120);
    await tx.run("Create market", async ({ send, step, ensureAllowance }) => {
      if (fee && fee > 0n) await ensureAllowance(address, FACTORY, fee + fee / 50n, step);
      step("Confirm the new market in your wallet.");
      await send({ address: FACTORY, abi: factoryAbi, functionName: "create", args: [chosen.feed, s, close] });
      setStrike("");
      return `Market created: ${chosen.name} above ${strike} USD at ${utc(Number(close))}.`;
    });
  }
  return (
    <section className="rc-panel" aria-label="Open a market">
      <div className="rc-panel-head">
        <h2>Open a market</h2>
        <p>Pick a listed price feed, a strike and a close. Anyone can stake on it until 30 minutes before the close.</p>
      </div>
      <div className="r2-create">
        <label>
          <span>Price feed</span>
          <select value={chosen?.feed ?? ""} onChange={(e) => setFeed(e.target.value as Address)}>
            {feeds.map((f) => (
              <option key={f.feed} value={f.feed}>
                {f.name}
                {f.answer !== undefined ? `, now ${price(f.answer, f.decimals)} USD` : ""}
              </option>
            ))}
          </select>
        </label>
        <AmountField id="predict-strike" label="Strike" unit="USD" value={strike} onChange={setStrike} />
        <label>
          <span>Closes in</span>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {[2, 24, 72, 168].map((h) => (
              <option key={h} value={h}>
                {h < 24 ? `${h} hours` : `${h / 24} ${h === 24 ? "day" : "days"}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {fee && fee > 0n ? <p className="rc-muted">Opening a market burns {orry(fee)} ORRY.</p> : null}
      {ready ? (
        <button className="secondary" type="button" disabled={Boolean(tx.busy) || !chosen || !parseAmount(strike, chosen?.decimals ?? 8)} onClick={() => void create()}>
          {tx.busy ? "Opening…" : "Open the market"}
        </button>
      ) : null}
      <NoticeLine notice={tx.notice} />
    </section>
  );
}

/** Held page: positions and claims stay reachable whatever the release switch says. */
export function PredictExits() {
  const q = usePredictMarkets(false);
  return <Positions markets={q.data?.markets ?? []} />;
}

export function PredictView() {
  const q = usePredictMarkets();
  const now = useNow();
  const markets = useMemo(() => q.data?.markets ?? [], [q.data]);
  const [pick, setPick] = useState<string | undefined>(undefined);
  const chosen = markets.find((m) => m.market === pick) ?? markets.find((m) => m.status === "open");
  return (
    <>
      <OrryHead
        title="Call where a price closes."
        lead={<p>Stake USDG on YES or NO for a stock or ETH price at a set time. Chainlink settles it at the first price published after the close, and the winning side shares the pool.</p>}
        reading={<Reading markets={q.data ? markets : undefined} now={now} />}
      />
      <div className="rc-grid">
        <section className="rc-panel r2-markets" aria-label="Markets">
          {markets.length === 0 ? (
            <p className="rc-muted">{q.isLoading ? "Reading the markets…" : "No market is open yet. Open the first one below."}</p>
          ) : (
            <table className="rc-table">
              <thead>
                <tr>
                  <th scope="col">Market</th>
                  <th scope="col">Closes</th>
                  <th scope="col">Pool</th>
                  <th scope="col" className="num">Staked</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {markets.map((m) => (
                  <tr key={m.market} className={chosen?.market === m.market ? "is-picked" : undefined}>
                    <td data-label="Market">
                      <button type="button" className="r2-pick" onClick={() => setPick(m.market)}>
                        <strong>{label(m)}</strong> above <span className="mono">{price(m.strike, m.decimals)}</span>
                        {m.latest ? <small>now {price(m.latest.answer, m.decimals)}</small> : null}
                      </button>
                    </td>
                    <td data-label="Closes">{m.closeTime > now ? `in ${span(m.closeTime - now)}` : utc(m.closeTime)}</td>
                    <td data-label="Pool">
                      <Split yes={BigInt(m.yesPool)} no={BigInt(m.noPool)} />
                    </td>
                    <td data-label="Staked" className="num mono">{usdg(BigInt(m.yesPool) + BigInt(m.noPool))}</td>
                    <td data-label="Status">{STATUS[m.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        {chosen ? <StakeDesk m={chosen} now={now} /> : null}
      </div>
      <Positions markets={markets} />
      <CreateMarket />
    </>
  );
}
