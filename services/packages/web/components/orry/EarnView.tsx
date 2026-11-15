"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { erc20Abi, type Abi, type Address } from "viem";
import { useBalance, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { depositPriceBounds, iEarnVaultAbi, iOrryTokenAbi, iOrreryHookAbi, sqrtPriceAtTick } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { useEarnStats, type EarnHub } from "@/lib/orry/api";
import { useNow, useOrryConstants, useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { useVaults, type EarnVaultInfo, type QuoteMeta } from "@/lib/orry/earn";
import { amount, parseAmount, pct, period, orry, span, toInput } from "@/lib/orry/format";
import { AmountField, ExitConnect, Fig, NoticeLine, OrryHead, Row, Segmented, SlippagePicker } from "./parts";

type Mode = "both" | "zap" | "withdraw";
const vaultAbi = iEarnVaultAbi as Abi;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
/** How far the pool price may sit from its 30 minute mean when a deposit enters (2%: fee plus normal drift). */
const BAND_BPS = 200;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
const cut = (v: bigint, bps: number) => (v * BigInt(10_000 - bps)) / 10_000n;
const pow = (d: number) => 10n ** BigInt(d);
/** An amount of the hub's quote token: ETH keeps five decimals, others two. */
const quoteFig = (q: QuoteMeta, v?: bigint | null) => amount(v, { decimals: q.decimals, frac: q.isEth ? 5 : 2 });
const pairName = (q: QuoteMeta) => `ORRY / ${q.symbol}`;

/**
 * Multi-pair Earn: one card per ORRY pool (ETH, USDG, ...), each with its own vault. `exitOnly` (Earn held) shows
 * only the cards where this wallet holds shares or fees, with Withdraw and Claim fees; withdrawals and claims are
 * never held.
 */
export function EarnView({ exitOnly = false }: { exitOnly?: boolean }) {
  const { connected } = useWallet();
  const { vaults, loaded } = useVaults();
  const stats = useEarnStats();

  if (exitOnly && !connected) return <ExitConnect text="Connect a wallet to withdraw an Earn share or claim its fees." />;

  return (
    <>
      {exitOnly ? null : (
        <OrryHead
          title={<>Add ORRY with ETH or USDG.</>}
          lead={<p>Each ORRY pool has its own Earn share. Your share earns from every swap in that pool, and fees arrive in ORRY and the pool&apos;s other token. Claim them whenever you like.</p>}
        />
      )}
      {!exitOnly && loaded && vaults.length === 0 ? <p className="rc-muted">Earn pools appear here as each vault opens.</p> : null}
      {vaults.map((v) => (
        <EarnHubCard key={v.vault} info={v} hub={stats.data?.hubs.find((h) => h.quote.address.toLowerCase() === v.quote.address.toLowerCase())} exitOnly={exitOnly} />
      ))}
    </>
  );
}

function EarnHubCard({ info, hub, exitOnly }: { info: EarnVaultInfo; hub?: EarnHub; exitOnly: boolean }) {
  const { vault, quote: q } = info;
  const { address, ready, connected } = useWallet();
  const consts = useOrryConstants();
  const now = useNow();
  const tx = useTx();
  const pub = usePublicClient();
  const [mode, setMode] = useState<Mode>(exitOnly ? "withdraw" : "both");
  const [slip, setSlip] = useState(100);
  const a = address ?? ZERO;

  // This wallet in this vault, its balances, and the pool's fee for zaps; fresh after every transaction.
  const { data: reads, refetch } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: vault, abi: iEarnVaultAbi, functionName: "sharesOf", args: [a] },
      { address: vault, abi: iEarnVaultAbi, functionName: "unlockAt", args: [a] },
      { address: vault, abi: iEarnVaultAbi, functionName: "pendingFees", args: [a] },
      { address: vault, abi: iEarnVaultAbi, functionName: "totalShares" },
      { address: ORRY.token ?? ZERO, abi: iOrryTokenAbi, functionName: "balanceOf", args: [a] },
      { address: q.isEth ? ZERO : q.address, abi: erc20Abi, functionName: "balanceOf", args: [a] },
    ],
    query: { enabled: Boolean(address), refetchInterval: 12_000 },
  });
  const r = <T,>(i: number) => (reads?.[i]?.status === "success" ? (reads[i].result as T) : undefined);
  const shares = r<bigint>(0);
  const unlockAt = Number(r<bigint | number>(1) ?? 0);
  const fees = r<readonly [bigint, bigint]>(2);
  const totalShares = r<bigint>(3);
  const rcBal = r<bigint>(4);
  const ethBal = useBalance({ address, query: { enabled: Boolean(address) && q.isEth, refetchInterval: 12_000 } });
  const qBal = q.isEth ? ethBal.data?.value : r<bigint>(5);
  const { data: hookAddr } = useReadContract({ address: vault, abi: iEarnVaultAbi, functionName: "hook", query: { staleTime: Infinity } });
  const { data: feeReads } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: (hookAddr as Address) ?? ZERO, abi: iOrreryHookAbi, functionName: "LP_FEE" },
      { address: (hookAddr as Address) ?? ZERO, abi: iOrreryHookAbi, functionName: "protocolFeePips" },
    ],
    query: { enabled: Boolean(hookAddr), staleTime: Infinity },
  });
  const feePips = feeReads?.every((f) => f.status === "success") ? Number(feeReads[0]!.result) + Number(feeReads[1]!.result) : undefined;
  const { data: myPosition } = useReadContract({ address: vault, abi: iEarnVaultAbi, functionName: "previewWithdraw", args: shares ? [shares] : undefined, query: { enabled: Boolean(shares && shares > 0n), refetchInterval: 12_000 } });
  // A pool with no liquidity can be moved for free, so the first deposit comes from the deploy's seed, not from here.
  const { data: poolShares } = useReadContract({ address: vault, abi: iEarnVaultAbi, functionName: "totalShares", query: { refetchInterval: 15_000 } });
  const emptyPool = poolShares === 0n;

  /** Deposit price bounds (review M-3): the pool price may sit at most BAND_BPS from its 30 minute mean, read now. */
  async function priceBounds() {
    if (!pub || !hookAddr) throw new Error("The pool price did not load. Try again in a moment.");
    const [meanTick, window] = (await pub.readContract({ address: hookAddr as Address, abi: iOrreryHookAbi, functionName: "consult", args: [q.address, 1800] })) as readonly [number, number];
    if (Number(window) < 60) throw new Error("This pool's price is still settling. Try again in a minute.");
    return depositPriceBounds(sqrtPriceAtTick(Number(meanTick)), BAND_BPS);
  }

  // Two-sided inputs keep the pool ratio from the side typed last. Price: ORRY base units per whole quote token.
  const price = hub?.orryPerQuote;
  const [qIn, setQIn] = useState("");
  const [rcIn, setRcIn] = useState("");
  const pairFromQuote = (v: string) => {
    setQIn(v);
    const x = parseAmount(v, q.decimals);
    if (x && price) setRcIn(toInput((x * price) / pow(q.decimals)));
  };
  const pairFromRc = (v: string) => {
    setRcIn(v);
    const x = parseAmount(v);
    if (x && price) setQIn(toInput((x * pow(q.decimals)) / price, q.decimals));
  };

  const [zapSide, setZapSide] = useState<"quote" | "orry">("quote");
  const [zapIn, setZapIn] = useState("");

  // Withdraw by share of this wallet's position: liquidity units differ per pool, a percentage reads the same everywhere.
  const [wdPct, setWdPct] = useState("");
  const wdShares = useMemo(() => {
    const p = Number(wdPct);
    if (!shares || !Number.isFinite(p) || p <= 0 || p > 100) return undefined;
    return p === 100 ? shares : (shares * BigInt(Math.round(p * 100))) / 10_000n;
  }, [wdPct, shares]);
  const { data: preview } = useReadContract({ address: vault, abi: iEarnVaultAbi, functionName: "previewWithdraw", args: wdShares ? [wdShares] : undefined, query: { enabled: Boolean(wdShares) } });
  const locked = unlockAt > now;

  async function approveQuote(owner: Address, amt: bigint, send: (c: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) => Promise<unknown>, step: (t: string) => void) {
    if (q.isEth || amt === 0n || !pub) return;
    const current = await pub.readContract({ address: q.address, abi: erc20Abi, functionName: "allowance", args: [owner, vault] });
    if (current >= amt) return;
    step(`Approve ${q.symbol} in your wallet.`);
    await send({ address: q.address, abi: erc20Abi as Abi, functionName: "approve", args: [vault, amt] });
  }

  async function deposit() {
    const qx = parseAmount(qIn, q.decimals) ?? 0n;
    const rx = parseAmount(rcIn) ?? 0n;
    if (!address || !pub || (qx === 0n && rx === 0n)) return;
    await tx.run("Deposit", async ({ send, step, ensureAllowance }) => {
      if (rx > 0n) await ensureAllowance(address, vault, rx, step);
      await approveQuote(address, qx, send, step);
      // ETH goes in as value; any other quote token through its approval.
      const value = q.isEth ? qx : 0n;
      const b = await priceBounds();
      const sim = await pub.simulateContract({ address: vault, abi: iEarnVaultAbi, functionName: "deposit", args: [qx, rx, 0n, b.min, b.max, deadline()], value, account: address });
      step("Confirm the deposit in your wallet.");
      await send({ address: vault, abi: vaultAbi, functionName: "deposit", args: [qx, rx, cut(sim.result, slip), b.min, b.max, deadline()], value });
      setQIn("");
      setRcIn("");
      void refetch();
      return "Deposited. Your share starts earning from the next swap.";
    });
  }

  async function zap() {
    const amt = parseAmount(zapIn, zapSide === "quote" ? q.decimals : 18);
    if (!address || !pub || !amt || !price) return;
    const fromQuote = zapSide === "quote";
    const half = amt / 2n;
    const expected = fromQuote ? (half * price) / pow(q.decimals) : (half * pow(q.decimals)) / price;
    const minSwapOut = cut(cut(expected, Math.ceil((feePips ?? 10_000) / 100)), slip);
    await tx.run("Zap deposit", async ({ send, step, ensureAllowance }) => {
      if (fromQuote) await approveQuote(address, amt, send, step);
      else await ensureAllowance(address, vault, amt, step);
      const value = fromQuote && q.isEth ? amt : 0n;
      const b = await priceBounds();
      const sim = await pub.simulateContract({ address: vault, abi: iEarnVaultAbi, functionName: "zapDeposit", args: [fromQuote, amt, minSwapOut, 0n, b.min, b.max, deadline()], value, account: address });
      step("Confirm the deposit in your wallet.");
      await send({ address: vault, abi: vaultAbi, functionName: "zapDeposit", args: [fromQuote, amt, minSwapOut, cut(sim.result, slip), b.min, b.max, deadline()], value });
      setZapIn("");
      void refetch();
      return "Deposited. Your share starts earning from the next swap.";
    });
  }

  async function withdraw() {
    if (!address || !wdShares || !preview) return;
    await tx.run("Withdraw", async ({ send }) => {
      await send({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [wdShares, cut(preview[0], slip), cut(preview[1], slip), deadline()] });
      setWdPct("");
      void refetch();
      return `Withdrawn. ${q.symbol}, ORRY and your streamed fees are in your wallet.`;
    });
  }

  async function claimFees() {
    await tx.run("Claim fees", async ({ send }) => {
      await send({ address: vault, abi: vaultAbi, functionName: "claimFees" });
      void refetch();
      return "Fees claimed to your wallet.";
    });
  }

  const busy = Boolean(tx.busy);
  const hasFees = Boolean((fees?.[0] ?? 0n) > 0n || (fees?.[1] ?? 0n) > 0n);
  const qMax = qBal !== undefined ? quoteFig(q, qBal) : undefined;
  const rcMax = rcBal !== undefined ? orry(rcBal) : undefined;
  // An amount above the wallet's balance names the token instead of failing in the wallet.
  const qx = parseAmount(qIn, q.decimals) ?? 0n;
  const rx = parseAmount(rcIn) ?? 0n;
  const shortBoth = rcBal !== undefined && rx > rcBal ? "ORRY" : qBal !== undefined && qx > qBal ? q.symbol : undefined;
  const zapAmt = parseAmount(zapIn, zapSide === "quote" ? q.decimals : 18) ?? 0n;
  const zapBal = zapSide === "quote" ? qBal : rcBal;
  const shortZap = zapBal !== undefined && zapAmt > zapBal ? (zapSide === "quote" ? q.symbol : "ORRY") : undefined;
  // Leaves room for gas when the quote is ETH.
  const qSpendable = qBal !== undefined ? (q.isEth ? (qBal * 98n) / 100n : qBal) : undefined;

  // Under a held Earn page: only a pool where this wallet holds something, and only while it does (or a confirmation shows).
  if (exitOnly && !tx.notice && (shares === undefined || (shares === 0n && !hasFees))) return null;

  return (
    <section className="rc-hub" aria-label={pairName(q)}>
      <header className="rc-hub-head">
        <h2>{pairName(q)}</h2>
        {!exitOnly && hub ? (
          <dl className="rc-hub-figs">
            <div>
              <dt>Holds</dt>
              <dd>{`${quoteFig(q, hub.tvl.quote)} ${q.symbol} + ${orry(hub.tvl.orry)} ORRY`}</dd>
            </div>
            <div>
              <dt>Fees, last 7 days</dt>
              <dd>{`${quoteFig(q, hub.fees7d.quote)} ${q.symbol} + ${orry(hub.fees7d.orry)} ORRY`}</dd>
            </div>
            {hub.notifiedAllTime > 0n ? (
              <div>
                <dt>ORRY rewards added, last 7 days</dt>
                <dd>{`${orry(hub.notified7d)} ORRY`}</dd>
              </div>
            ) : null}
            <div>
              <dt>Pool price</dt>
              <dd>{price ? `1 ${q.symbol} = ${orry(price)} ORRY` : "Opens with the pool"}</dd>
            </div>
          </dl>
        ) : null}
      </header>

      <div className="rc-grid">
        <section className="rc-desk" aria-label={`${pairName(q)} actions`}>
          <Segmented
            label={`${pairName(q)} actions`}
            value={mode}
            onChange={setMode}
            options={
              exitOnly
                ? [{ id: "withdraw", label: "Withdraw" }]
                : [
                    { id: "both", label: "Deposit" },
                    { id: "zap", label: "Zap deposit" },
                    { id: "withdraw", label: "Withdraw" },
                  ]
            }
          />

          {emptyPool && mode !== "withdraw" ? <p className="rc-desk-note">This pool opens for deposits once it holds its first liquidity.</p> : null}
          {mode === "both" ? (
            <div className="rc-desk-body">
              <p className="rc-desk-note">Add both sides at the pool price. Whatever the pool cannot take at that ratio comes back to you in the same transaction.</p>
              <AmountField id={`earn-q-${vault}`} label={`${q.symbol}, up to`} unit={q.symbol} value={qIn} onChange={pairFromQuote} max={qMax} onMax={() => qSpendable !== undefined && pairFromQuote(toInput(qSpendable, q.decimals))} />
              <AmountField id={`earn-r-${vault}`} label="ORRY, up to" unit="ORRY" value={rcIn} onChange={pairFromRc} max={rcMax} onMax={() => rcBal !== undefined && pairFromRc(toInput(rcBal))} />
              <SlippagePicker value={slip} onChange={setSlip} />
              <button className="primary rc-go" type="button" disabled={!ready || busy || emptyPool || (qx === 0n && rx === 0n) || Boolean(shortBoth)} onClick={() => void deposit()}>
                {shortBoth ? `Not enough ${shortBoth}` : tx.busy === "Deposit" ? "Depositing…" : "Deposit"}
              </button>
            </div>
          ) : null}

          {mode === "zap" ? (
            <div className="rc-desk-body">
              <p className="rc-desk-note">Bring one token. About half is swapped in the pool and both halves go into your share.</p>
              <Segmented label="Zap from" value={zapSide} onChange={(v) => { setZapSide(v); setZapIn(""); }} options={[{ id: "quote", label: `From ${q.symbol}` }, { id: "orry", label: "From ORRY" }]} />
              <AmountField
                id={`earn-zap-${vault}`}
                label={zapSide === "quote" ? q.symbol : "ORRY"}
                unit={zapSide === "quote" ? q.symbol : "ORRY"}
                value={zapIn}
                onChange={setZapIn}
                max={zapSide === "quote" ? qMax : rcMax}
                onMax={() => {
                  if (zapSide === "quote" && qSpendable !== undefined) setZapIn(toInput(qSpendable, q.decimals));
                  if (zapSide === "orry" && rcBal !== undefined) setZapIn(toInput(rcBal));
                }}
                hint={!price && hub ? "Zaps open once the pool has a price." : undefined}
              />
              <SlippagePicker value={slip} onChange={setSlip} />
              <button className="primary rc-go" type="button" disabled={!ready || busy || emptyPool || zapAmt === 0n || !price || Boolean(shortZap)} onClick={() => void zap()}>
                {shortZap ? `Not enough ${shortZap}` : tx.busy === "Zap deposit" ? "Depositing…" : "Zap deposit"}
              </button>
            </div>
          ) : null}

          {mode === "withdraw" ? (
            <div className="rc-desk-body">
              <p className="rc-desk-note">Withdraw pays {q.symbol} and ORRY at the pool price, together with your streamed fees.</p>
              <div className="rc-amount">
                <label htmlFor={`earn-wd-${vault}`}>Share of your position</label>
                <div className="rc-amount-box">
                  <input id={`earn-wd-${vault}`} inputMode="decimal" autoComplete="off" placeholder="0" value={wdPct} onChange={(e) => setWdPct(e.target.value.replace(/[^\d.]/g, ""))} />
                  <span className="rc-unit">%</span>
                </div>
                <div className="rc-amount-foot rc-quick">
                  {[25, 50, 75, 100].map((p) => (
                    <button key={p} type="button" className="rc-max" disabled={!shares} onClick={() => setWdPct(String(p))}>
                      {p === 100 ? "All" : `${p}%`}
                    </button>
                  ))}
                </div>
              </div>
              {preview ? (
                <dl className="rc-rows rc-rows-tight">
                  <Row label="You receive">{`${quoteFig(q, preview[0])} ${q.symbol} + ${orry(preview[1])} ORRY`}</Row>
                </dl>
              ) : null}
              <SlippagePicker value={slip} onChange={setSlip} />
              <button className="primary rc-go" type="button" disabled={!ready || busy || !wdShares || !preview || locked} onClick={() => void withdraw()}>
                {locked ? `Unlocks in ${span(unlockAt - now)}` : tx.busy === "Withdraw" ? "Withdrawing…" : "Withdraw"}
              </button>
            </div>
          ) : null}

          {!connected ? (
            <div className="rc-connect">
              <p>Connect a wallet to deposit.</p>
              <WalletButton />
            </div>
          ) : null}
          <NoticeLine notice={tx.notice} />
        </section>

        <section className="rc-side" aria-label={`Your ${pairName(q)} share`}>
          <h3 className="rc-hub-sub">Your share</h3>
          {!address ? (
            <p className="rc-muted">Your share, position and fees show here once a wallet is connected.</p>
          ) : (
            <>
              <dl className="rc-rows">
                <Row label="Share of the pool">
                  <Fig v={shares === undefined ? undefined : shares === 0n ? "None yet" : totalShares ? pct(shares, totalShares) : "…"} />
                </Row>
                <Row label="Position now">{shares === 0n ? "None yet" : myPosition ? `${quoteFig(q, myPosition[0])} ${q.symbol} + ${orry(myPosition[1])} ORRY` : "…"}</Row>
                <Row label="Withdraw">{shares === 0n ? "Nothing to withdraw" : locked ? `Opens in ${span(unlockAt - now)}` : "Open"}</Row>
              </dl>
              <div className="rc-claim">
                <div>
                  <p className="rc-claim-label">Fees ready to claim</p>
                  <p className="rc-claim-value">
                    <Fig v={fees ? quoteFig(q, fees[0]) : undefined} unit={q.symbol} />
                    <Fig v={fees ? orry(fees[1]) : undefined} unit="ORRY" />
                  </p>
                </div>
                <button className="primary" type="button" disabled={!ready || busy || !hasFees} onClick={() => void claimFees()}>
                  {tx.busy === "Claim fees" ? "Claiming…" : "Claim fees"}
                </button>
              </div>
            </>
          )}
          {exitOnly ? null : (
            <div className="rc-explain">
              <p>
                This pool&apos;s Earn vault holds one full-range position. The swap fees it collects stream to shares over{" "}
                {consts.earnStream ? period(consts.earnStream) : "the stream period"}, so every share earns for the time it is held.
                {consts.depositLock ? ` A deposit can be withdrawn ${period(consts.depositLock)} after it lands.` : ""}
              </p>
              <Link className="lp-link" href="/docs/earn">Read the Earn guide</Link>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
