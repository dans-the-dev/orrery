"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { pad, toHex, type Abi, type Address } from "viem";
import { usePublicClient, useReadContracts } from "wagmi";
import { iAgentLaunchAbi, iOrryStakingAbi } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { useLaunchEligibility } from "@/lib/launch/api";
import { quoteBuy, withLimit } from "@/lib/launch/quote";
import { useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { parseAmount, orry, utc } from "@/lib/orry/format";
import { AmountField, NoticeLine, OrryHead } from "../orry/parts";
import { FeeSplit } from "./shell";

const AL = ORRY.agentLaunch as Address;
const launchAbi = iAgentLaunchAbi as Abi;

function Check({ ok, title, note, action }: { ok: boolean | undefined; title: string; note?: string; action?: ReactNode }) {
  return (
    <li className={ok === undefined ? undefined : ok ? "is-ok" : "is-todo"}>
      <i aria-hidden="true">{ok === undefined ? "·" : ok ? "✓" : "!"}</i>
      <span>
        {title}
        {note ? <small>{note}</small> : null}
      </span>
      <span>{action}</span>
    </li>
  );
}

export function LaunchNew() {
  const { address, ready } = useWallet();
  const tx = useTx();
  const pub = usePublicClient();
  const router = useRouter();
  const [agentId, setAgentId] = useState(useSearchParams().get("agent") ?? "");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [buy, setBuy] = useState("");
  const e = useLaunchEligibility(agentId.trim(), address).data;
  const consts = useReadContracts({
    contracts: [
      { address: AL, abi: launchAbi, functionName: "launchLiquidity" },
      { address: AL, abi: [{ type: "function", name: "SQRT_PRICE_START", inputs: [], outputs: [{ type: "uint160" }], stateMutability: "view" }] as Abi, functionName: "SQRT_PRICE_START" },
    ],
    query: { staleTime: Infinity },
  }).data;
  const liquidity = consts?.[0]?.result as bigint | undefined;
  const sqrtStart = consts?.[1]?.result as bigint | undefined;
  const buyAmount = parseAmount(buy) ?? 0n;
  const quote = liquidity && sqrtStart ? quoteBuy(buyAmount, sqrtStart, liquidity, 10_000) : 0n;

  const controls = Boolean(e && address && (e.owner === address.toLowerCase() || e.agentWallet === address.toLowerCase()));
  const usdOk = e ? e.stake.usd !== null && BigInt(e.stake.usd) >= BigInt(e.needs.minStakeUsd) : undefined;
  const lockOk = e ? e.stake.lockedUntil >= e.needs.lockUntil : undefined;
  const textOk = (s: string, max: number) => s.trim().length > 0 && new TextEncoder().encode(s).length <= max && !/[\u0000-\u001f\u007f]/.test(s);
  const canLaunch = Boolean(ready && e?.gate === "ok" && textOk(name, 32) && textOk(symbol, 10));

  async function lock() {
    if (!e || !ORRY.staking) return;
    // an hour past the 90 days, so the lock still covers the launch a little later
    const until = BigInt(e.needs.lockUntil + 3600);
    await tx.run("Lock stake", async ({ send }) => {
      await send({ address: ORRY.staking!, abi: iOrryStakingAbi as Abi, functionName: "extendAgentLock", args: [BigInt(e.agentId), until] });
      return `Lock runs until ${utc(Number(until))}.`;
    });
  }

  async function launch() {
    if (!address || !pub || !e) return;
    await tx.run("Launch", async ({ send, step, ensureAllowance }) => {
      step("Searching for an address for the coin.");
      let salt: `0x${string}` | undefined;
      for (let i = 0n; i < 256n && !salt; i++) {
        const s = pad(toHex(i), { size: 32 });
        const coin = (await pub.readContract({ address: AL, abi: launchAbi, functionName: "predictCoin", args: [address, s, name.trim(), symbol.trim()] })) as Address;
        if (ORRY.token && BigInt(coin) > BigInt(ORRY.token)) salt = s;
      }
      if (!salt) throw new Error("This name gave no usable coin address. Pick a different symbol.");
      if (buyAmount > 0n) await ensureAllowance(address, AL, buyAmount, step);
      step("Approve the launch in your wallet.");
      await send({ address: AL, abi: launchAbi, functionName: "launch", args: [BigInt(e.agentId), name.trim(), symbol.trim(), salt, buyAmount, withLimit(quote, 200)] });
      const coin = (await pub.readContract({ address: AL, abi: launchAbi, functionName: "coinOfAgent", args: [BigInt(e.agentId)] })) as Address;
      router.push(`/launch/${coin}`);
      return `${symbol.trim()} is on chain.`;
    });
  }

  return (
    <>
      <OrryHead
        title="Give your agent a coin of its own."
        lead={
          <p>
            Each verified agent gets one coin. The entire supply enters an ORRY pool at the opening price and remains in that pool. Stakers
            get the first window, then trading opens to all.
          </p>
        }
      />
      <FeeSplit label="Your coin takes 1% on each trade, and half of that is paid to your agent's account" />
      <section className="rc-panel" aria-label="Your agent">
        <div className="rc-panel-head">
          <h2>Your agent</h2>
        </div>
        <label className="ln-field">
          Agent ID
          <input inputMode="numeric" value={agentId} onChange={(ev) => setAgentId(ev.target.value.replace(/\D/g, ""))} placeholder="1" />
        </label>
        {!ready ? (
          <WalletButton />
        ) : e ? (
          <ul className="ln-checks">
            <Check ok={controls} title="Connected wallet controls the agent" note="Only the owner or the bound account can launch the coin." />
            <Check ok={e.verified} title="Orrery verification" action={e.verified ? null : <Link className="secondary" href="/dashboard/agents">Verify</Link>} />
            <Check ok={e.walletBound} title="Bound account under Orrery's spending policy" note="The agent's half of each fee lands in this account." />
            <Check
              ok={usdOk}
              title={`At least ${(Number(e.needs.minStakeUsd) / 1e6).toLocaleString("en-US")} USD staked behind the agent`}
              note={e.stake.usd !== null ? `Currently ${orry(BigInt(e.stake.active))} ORRY · ${orry(BigInt(e.stake.usd) * 10n ** 12n)} USD` : undefined}
              action={usdOk ? null : <Link className="secondary" href="/stake">Stake</Link>}
            />
            <Check
              ok={lockOk}
              title="90 day stake lock"
              note={e.stake.lockedUntil > 0 ? `Lock ends ${utc(e.stake.lockedUntil)}` : undefined}
              action={lockOk || !usdOk ? null : (
                <button type="button" className="secondary" disabled={Boolean(tx.busy)} onClick={() => void lock()}>
                  Lock 90 days
                </button>
              )}
            />
            <Check ok={e.coin === null} title="Agent has no coin yet" action={e.coin ? <Link className="secondary" href={`/launch/${e.coin}`}>View its coin</Link> : null} />
          </ul>
        ) : agentId ? (
          <p className="rc-muted">Looking up the agent…</p>
        ) : null}
      </section>
      <section className="rc-desk" aria-label="The coin">
        <div className="ln-two">
          <label className="ln-field">
            Name
            <input value={name} maxLength={32} onChange={(ev) => setName(ev.target.value)} placeholder="Atlas Research" />
          </label>
          <label className="ln-field">
            Symbol
            <input value={symbol} maxLength={10} onChange={(ev) => setSymbol(ev.target.value.toUpperCase())} placeholder="ATLAS" />
          </label>
        </div>
        <AmountField
          id="launch-buy"
          label="Opening buy, ahead of everyone (optional)"
          unit="ORRY"
          value={buy}
          onChange={setBuy}
          hint={`${buyAmount > 0n && quote > 0n ? `Roughly ${orry(quote)} coins. ` : ""}${e ? `Up to ${e.needs.maxFirstBuyBps / 100}% of the supply.` : ""}`}
        />
        {ready ? (
          <button className="primary rc-go" type="button" disabled={!canLaunch || Boolean(tx.busy)} onClick={() => void launch()}>
            {tx.busy === "Launch" ? "Launching…" : symbol.trim() ? `Launch ${symbol.trim()}` : "Launch"}
          </button>
        ) : (
          <WalletButton />
        )}
        <NoticeLine notice={tx.notice} />
      </section>
    </>
  );
}
