"use client";

import Link from "next/link";
import { useState } from "react";
import { formatUnits, parseAbi, type Abi, type Address } from "viem";
import { useReadContract } from "wagmi";
import { iAgentLaunchAbi, spokeRouterAbi, type LaunchCoinResponse } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { LaunchApiError, useLaunchAccount, useLaunchCoin } from "@/lib/launch/api";
import { quoteBuy, quoteSell, withLimit } from "@/lib/launch/quote";
import { useNow, useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { useReleases } from "@/lib/orry/releases";
import { ago, mask, parseAmount, orry, span } from "@/lib/orry/format";
import { AmountField, Fig, NoticeLine, OrryHead, Row, Segmented, SlippagePicker, TxLink } from "../orry/parts";
import { coinPrice } from "./LaunchList";
import { FeeSplit } from "./shell";

const AL = ORRY.agentLaunch as Address;
const ROUTER = ORRY.spokeRouter as Address;
const launchAbi = iAgentLaunchAbi as Abi;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const pct = (pips: number) => `${(pips / 10_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

/** Early access (utility 5): stakers buy first, each up to an allocation that grows with the USD value of their stake. */
function EarlyDesk({ coin, symbol, publicOpenAt, now }: { coin: Address; symbol: string; publicOpenAt: number; now: number }) {
  const { address, ready } = useWallet();
  const releases = useReleases();
  const tx = useTx();
  const acc = useLaunchAccount(address);
  const [amt, setAmt] = useState("");
  const params = useReadContract({ address: AL, abi: launchAbi, functionName: "params", query: { staleTime: Infinity } }).data as
    | { earlyMaxBps: number; earlyFullUsd: bigint }
    | undefined;
  const mine = acc.data?.early.find((x) => x.coin === coin.toLowerCase());
  const room = mine ? BigInt(mine.allowance) : 0n;
  if (releases.ready && !releases.isLive("launch-priority")) return null;
  async function buy() {
    const a = parseAmount(amt);
    if (!address || !a) return;
    await tx.run("Early buy", async ({ send, step, ensureAllowance }) => {
      await ensureAllowance(address, AL, a, step);
      step("Approve the early buy in your wallet.");
      await send({ address: AL, abi: launchAbi, functionName: "buyEarly", args: [coin, a, 1n, BigInt(Math.floor(Date.now() / 1000) + 300)] });
      setAmt("");
      return `${symbol} bought ahead of the public window.`;
    });
  }
  return (
    <section className="rc-desk" aria-label="Staker window">
      <h2 className="ln-desk-title">Staker window, {span(publicOpenAt - now)} left</h2>
      <p className="rc-muted">
        The more USD your ORRY stake is worth, the larger your allocation
        {params ? `, reaching ${params.earlyMaxBps / 100}% of the supply at ${(Number(params.earlyFullUsd) / 1e6).toLocaleString("en-US")} USD` : ""}.
        Early buys carry the 1% fee.
      </p>
      {!ready ? (
        <WalletButton />
      ) : (
        <div className="rc-desk-body">
          <dl className="rc-rows">
            <Row label="Your stake">{acc.data ? (acc.data.stakeUsd !== null ? `${orry(BigInt(acc.data.stakeUsd) * 10n ** 12n)} USD` : "…") : "…"}</Row>
            <Row label="Allocation remaining">{acc.data ? `${orry(room)} ${symbol}` : "…"}</Row>
          </dl>
          {room > 0n ? (
            <>
              <AmountField id="early-amt" label="ORRY amount" unit="ORRY" value={amt} onChange={setAmt} />
              <button className="primary rc-go" type="button" disabled={Boolean(tx.busy) || !parseAmount(amt)} onClick={() => void buy()}>
                {tx.busy ? "Buying…" : `Buy ${symbol} early`}
              </button>
            </>
          ) : (
            <p className="rc-muted">
              Join the next early window by staking ORRY on the <Link href="/stake">Stake page</Link>.
            </p>
          )}
          <NoticeLine notice={tx.notice} />
        </div>
      )}
    </section>
  );
}

/** Public trades through Orrery's spoke router, quoted from the pool's live price. */
function TradeDesk({ coin, symbol, live }: { coin: Address; symbol: string; live: NonNullable<LaunchCoinResponse["live"]> }) {
  const { address, ready } = useWallet();
  const tx = useTx();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [bps, setBps] = useState(100);
  const bal = useReadContract({ address: coin, abi: erc20, functionName: "balanceOf", args: address ? [address] : undefined, query: { enabled: Boolean(address) } }).data as bigint | undefined;
  const a = parseAmount(amt) ?? 0n;
  const sqrt = BigInt(live.sqrtPriceX96);
  const liq = BigInt(live.liquidity);
  const quote = side === "buy" ? quoteBuy(a, sqrt, liq, live.feePips) : quoteSell(a, sqrt, liq);
  async function trade() {
    if (!address || a === 0n) return;
    await tx.run(side === "buy" ? "Buy" : "Sell", async ({ send, step, ensureAllowance }) => {
      if (side === "buy") {
        await ensureAllowance(address, ROUTER, a, step);
        step("Approve the buy in your wallet.");
        await send({ address: ROUTER, abi: spokeRouterAbi as Abi, functionName: "buy", args: [coin, a, withLimit(quote, bps), BigInt(Math.floor(Date.now() / 1000) + 300)] });
      } else {
        step(`Approve the ${symbol} spend in your wallet.`);
        await send({ address: coin, abi: parseAbi(["function approve(address,uint256) returns (bool)"]) as Abi, functionName: "approve", args: [ROUTER, a] });
        step("Approve the sale in your wallet.");
        await send({ address: ROUTER, abi: spokeRouterAbi as Abi, functionName: "sell", args: [coin, a, withLimit(quote, bps), BigInt(Math.floor(Date.now() / 1000) + 300)] });
      }
      setAmt("");
      return side === "buy" ? `Bought ${symbol}.` : `Sold ${symbol}.`;
    });
  }
  return (
    <section className="rc-desk" aria-label={`Trade ${symbol}`}>
      <Segmented label="Side" value={side} onChange={(v) => { setSide(v); setAmt(""); }} options={[{ id: "buy", label: `Buy ${symbol}` }, { id: "sell", label: `Sell ${symbol}` }]} />
      <div className="rc-desk-body">
        <AmountField
          id="trade-amt"
          label={side === "buy" ? "ORRY amount" : `${symbol} amount`}
          unit={side === "buy" ? "ORRY" : symbol}
          value={amt}
          onChange={setAmt}
          max={side === "sell" && bal !== undefined ? orry(bal) : undefined}
          onMax={() => bal !== undefined && setAmt(formatUnits(bal, 18))}
          hint={a > 0n ? `Roughly ${orry(quote)} ${side === "buy" ? symbol : "ORRY"} · fee ${pct(side === "buy" ? live.feePips : 10_000)}` : `Fee ${pct(side === "buy" ? live.feePips : 10_000)}`}
        />
        <SlippagePicker value={bps} onChange={setBps} />
        {ready ? (
          <button className="primary rc-go" type="button" disabled={Boolean(tx.busy) || a === 0n} onClick={() => void trade()}>
            {tx.busy ? "Sending…" : side === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`}
          </button>
        ) : (
          <WalletButton />
        )}
        <NoticeLine notice={tx.notice} />
      </div>
    </section>
  );
}

function Fees({ coin, data }: { coin: Address; data: LaunchCoinResponse }) {
  const tx = useTx();
  const c = data.coin;
  const live = data.live;
  const pending = live ? BigInt(live.pendingFees) : 0n;
  const owed = live ? BigInt(live.creatorOwed) + (pending * 5000n) / 10_000n : 0n;
  async function split() {
    await tx.run("Split fees", async ({ send }) => {
      await send({ address: AL, abi: launchAbi, functionName: "distribute", args: [coin] });
      return "Split done. Agent share held for payout, Earn share streaming to depositors, burn share burned.";
    });
  }
  async function pay() {
    await tx.run("Pay out to agent", async ({ send }) => {
      await send({ address: AL, abi: launchAbi, functionName: "claimCreatorFees", args: [coin] });
      return "Agent share sent to its account.";
    });
  }
  return (
    <section className="rc-panel" aria-label="Fees">
      <div className="rc-panel-head">
        <h2>Fees</h2>
      </div>
      <dl className="rc-rows">
        <Row label="Divided to date">{`${orry(BigInt(c.feesDistributed))} ORRY`}</Row>
        <Row label="Agent account">{`${orry(BigInt(c.creatorFees))} ORRY`}</Row>
        <Row label="Earn depositors">{`${orry(BigInt(c.earnFees))} ORRY`}</Row>
        <Row label="Burned">{`${orry(BigInt(c.burned))} ORRY`}</Row>
        <Row label="Orrery">{`${orry(BigInt(c.ownerFees))} ORRY`}</Row>
        <Row label="Not yet divided">{live ? `${orry(pending)} ORRY` : "…"}</Row>
        <Row label="Held for the agent" hint={live?.agentWallet ? mask(live.agentWallet) : undefined}>{live ? `${orry(owed)} ORRY` : "…"}</Row>
      </dl>
      <div className="ln-actions">
        <button type="button" className="secondary" disabled={Boolean(tx.busy) || pending === 0n} onClick={() => void split()}>
          Split fees
        </button>
        <button type="button" className="secondary" disabled={Boolean(tx.busy) || owed === 0n || !live?.walletBound} onClick={() => void pay()}>
          Pay out to agent
        </button>
      </div>
      <NoticeLine notice={tx.notice} />
    </section>
  );
}

export function CoinView({ coin }: { coin: Address }) {
  const q = useLaunchCoin(coin);
  const now = useNow();
  const d = q.data;
  if (q.isError && !d) {
    // a coin launched seconds ago reaches the list on the next indexed block
    return <p className="rc-muted">{q.error instanceof LaunchApiError && q.error.status === 404 ? "This coin shows up once the next block is indexed." : "Fetching the coin again."}</p>;
  }
  if (!d) return <div className="rc-gate-wait" aria-busy="true" aria-label="Loading" />;
  const c = d.coin;
  const early = c.publicOpenAt > now;
  const agentHref = d.live?.agentWallet ? `/agent/${c.agentId}?account=${d.live.agentWallet}` : `/agent/${c.agentId}`;
  return (
    <>
      <OrryHead
        kicker={`Agent ${c.agentId}`}
        title={`${c.name}`}
        lead={
          <p>
            {c.symbol} belongs to an agent Orrery has verified. Half of each trade fee is paid to the agent&apos;s account. Its spending caps
            and live record are open on <Link href={agentHref}>its record page</Link>.
          </p>
        }
        reading={
          <div className="rc-card">
            <p className="rc-card-title">{c.symbol}</p>
            <p className="rc-big">
              <Fig v={coinPrice(c.priceOrry)} unit="ORRY" />
            </p>
            <dl className="rc-rows">
              <Row label="Traded">{`${orry(BigInt(c.volumeOrry))} ORRY`}</Row>
              <Row label="Trades">{c.trades.toLocaleString("en-US")}</Row>
              <Row label="Launched">{ago(c.launchedAt, now)}</Row>
            </dl>
          </div>
        }
      />
      <FeeSplit />
      {early ? (
        <EarlyDesk coin={coin} symbol={c.symbol} publicOpenAt={c.publicOpenAt} now={now} />
      ) : d.live ? (
        <TradeDesk coin={coin} symbol={c.symbol} live={d.live} />
      ) : null}
      <Fees coin={coin} data={d} />
      <section className="rc-panel" aria-label="Latest trades">
        <div className="rc-panel-head">
          <h2>Latest trades</h2>
        </div>
        {d.trades.length === 0 ? (
          <p className="rc-muted">Each trade shows here as it lands.</p>
        ) : (
          <table className="rc-table">
            <thead>
              <tr>
                <th scope="col">Trade</th>
                <th scope="col" className="num">ORRY</th>
                <th scope="col" className="num">{c.symbol}</th>
                <th scope="col">Account</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {d.trades.map((t, i) => (
                <tr key={`${t.txHash}-${i}`}>
                  <td data-label="Trade" className={`ln-kind-${t.kind}`}>{t.kind === "early" ? "Early buy" : t.kind === "buy" ? "Buy" : "Sell"}</td>
                  <td data-label="ORRY" className="num mono">{orry(BigInt(t.orry))}</td>
                  <td data-label={c.symbol} className="num mono">{orry(BigInt(t.coins))}</td>
                  <td data-label="Account" className="mono">{mask(t.account)}</td>
                  <td data-label="When"><TxLink hash={t.txHash} /> {ago(t.time, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
