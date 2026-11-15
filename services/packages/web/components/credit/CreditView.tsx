"use client";

import { useState } from "react";
import { erc20Abi, type Abi, type Address } from "viem";
import { usePublicClient } from "wagmi";
import { creditPoolAbi, type CreditLineView, type CreditPoolView } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { ADDRESSES } from "@/lib/config";
import { bps, days, useCreditAccount, useCreditLines, useCreditPools } from "@/lib/credit/api";
import { useNow, useTx, useWallet } from "@/lib/orry/chain";
import { amount, parseAmount, orry, toInput, utc } from "@/lib/orry/format";
import { useReleases } from "@/lib/orry/releases";
import { AmountField, Fig, NoticeLine, OrryHead, Row, Segmented } from "../orry/parts";

const POOL = creditPoolAbi as Abi;
const usd = (v?: string | bigint) => (v === undefined ? undefined : amount(BigInt(v), { decimals: 6, frac: 2 }));
const sharesFor = (p: CreditPoolView, assets: bigint) => {
  const s = BigInt(p.totalShares) + 1_000_000n;
  const v = BigInt(p.totalAssets) + 1n;
  return (assets * s + v - 1n) / v;
};

/** Approves USDG for `spender` when the allowance is short, then runs the call. */
function useUsdgAllowance() {
  const pub = usePublicClient();
  return async (owner: Address, spender: Address, amt: bigint, send: (c: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) => Promise<unknown>, step: (t: string) => void) => {
    if (!pub || !ADDRESSES.usdg) throw new Error("USDG is not configured.");
    const current = await pub.readContract({ address: ADDRESSES.usdg, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
    if (current >= amt) return;
    step("Approve USDG in your wallet.");
    await send({ address: ADDRESSES.usdg, abi: erc20Abi as Abi, functionName: "approve", args: [spender, amt] });
  };
}

function Reading({ pool }: { pool?: CreditPoolView }) {
  return (
    <div className="rc-card">
      <p className="rc-card-title">Pool 1</p>
      <p className="rc-big">
        <Fig v={usd(pool?.totalAssets)} unit="USDG" />
      </p>
      <dl className="rc-rows">
        <Row label="Lent to agents">{pool ? `${usd(pool.totalPrincipal)} USDG` : "…"}</Row>
        <Row label="Interest">{pool ? `${bps(pool.params.aprBps)} a year` : "…"}</Row>
        <Row label="Open lines">{pool ? pool.lines : "…"}</Row>
      </dl>
    </div>
  );
}

/** The line's own figure: what is drawn against the limit. */
function LineMeter({ line }: { line: CreditLineView }) {
  const limit = BigInt(line.limit);
  const drawn = BigInt(line.principal) + BigInt(line.interest);
  const scale = [limit, drawn].reduce((a, b) => (b > a ? b : a), 1n);
  const w = (v: bigint) => `${Number((v * 1000n) / scale) / 10}%`;
  return (
    <div className="cr-meter" role="img" aria-label={`${usd(drawn)} of ${usd(limit)} USDG drawn`}>
      <div className="cr-meter-track">
        <span className="cr-meter-limit" style={{ width: w(limit) }} />
        <span className="cr-meter-drawn" style={{ width: w(drawn) }} />
      </div>
      <small>
        <b>{usd(drawn)} drawn</b>
        <b>{usd(limit)} limit</b>
      </small>
    </div>
  );
}

function LendDesk({ pool }: { pool: CreditPoolView }) {
  const { address, ready } = useWallet();
  const tx = useTx();
  const approve = useUsdgAllowance();
  const acct = useCreditAccount(address);
  const mine = acct.data?.positions.find((p) => p.pool.toLowerCase() === pool.pool.toLowerCase());
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amt, setAmt] = useState("");
  const a = parseAmount(amt, 6);
  const cash = BigInt(pool.cash);
  const value = mine ? BigInt(mine.value) : 0n;
  const out = value < cash ? value : cash;

  async function deposit() {
    if (!address || !a) return;
    await tx.run("Lend", async ({ send, step }) => {
      await approve(address, pool.pool as Address, a, send, step);
      step("Confirm the deposit in your wallet.");
      await send({ address: pool.pool as Address, abi: POOL, functionName: "deposit", args: [a] });
      setAmt("");
      return `${usd(a)} USDG lent to the pool.`;
    });
  }
  async function withdraw() {
    if (!address || !a || !mine) return;
    const owned = BigInt(mine.shares);
    const shares = a >= value ? owned : sharesFor(pool, a) > owned ? owned : sharesFor(pool, a);
    await tx.run("Withdraw", async ({ send }) => {
      await send({ address: pool.pool as Address, abi: POOL, functionName: "withdraw", args: [shares] });
      setAmt("");
      return "USDG back in your wallet.";
    });
  }
  async function claim() {
    await tx.run("Claim ORRY", async ({ send }) => {
      await send({ address: pool.pool as Address, abi: POOL, functionName: "claimOrry" });
      return "ORRY in your wallet.";
    });
  }

  return (
    <section className="rc-desk" aria-label="Lend">
      <Segmented label="Lend actions" value={mode} onChange={setMode} options={[{ id: "deposit", label: "Lend" }, { id: "withdraw", label: "Withdraw" }]} />
      <div className="rc-desk-body">
        {mode === "deposit" ? (
          <AmountField id="cr-lend" label="USDG to lend" unit="USDG" value={amt} onChange={setAmt} hint={mine ? `Your position ${usd(mine.value)} USDG` : undefined} />
        ) : (
          <AmountField id="cr-out" label="USDG to withdraw" unit="USDG" value={amt} onChange={setAmt} max={usd(out)} onMax={() => setAmt(toInput(out, 6))} hint={`Available in the pool now ${usd(cash)} USDG`} />
        )}
        {ready ? (
          <button className="primary rc-go" type="button" disabled={Boolean(tx.busy) || !a || (mode === "deposit" && pool.retired)} onClick={() => void (mode === "deposit" ? deposit() : withdraw())}>
            {tx.busy ? "Waiting for the wallet…" : mode === "deposit" ? "Lend USDG" : "Withdraw USDG"}
          </button>
        ) : (
          <WalletButton />
        )}
        {mine && BigInt(mine.orryClaimable) > 0n ? (
          <div className="cr-claim">
            <span>
              <b className="num">{orry(BigInt(mine.orryClaimable))}</b> ORRY from bonds is yours
            </span>
            <button type="button" className="rc-max" disabled={Boolean(tx.busy)} onClick={() => void claim()}>
              Claim
            </button>
          </div>
        ) : null}
        <NoticeLine notice={tx.notice} />
      </div>
    </section>
  );
}

function LineDesk({ pool }: { pool: CreditPoolView }) {
  const { address, ready } = useWallet();
  const tx = useTx();
  const approve = useUsdgAllowance();
  const now = useNow();
  const [agent, setAgent] = useState("");
  const [mode, setMode] = useState<"bond" | "draw" | "repay" | "release">("bond");
  const [amt, setAmt] = useState("");
  const id = /^\d{1,30}$/.test(agent) ? agent : undefined;
  const lines = useCreditLines(id);
  const line = lines.data?.lines.find((l) => l.pool.toLowerCase() === pool.pool.toLowerCase());
  const decimals = mode === "bond" || mode === "release" ? 18 : 6;
  const a = parseAmount(amt, decimals);
  const owed = line ? BigInt(line.owed) : 0n;
  const debt = line ? BigInt(line.principal) + BigInt(line.interest) : 0n;
  const room = line && BigInt(line.limit) > debt ? BigInt(line.limit) - debt : 0n;

  async function go() {
    if (!address || !a || !id) return;
    const p = pool.pool as Address;
    if (mode === "bond") {
      await tx.run("Post bond", async ({ send, step, ensureAllowance }) => {
        await ensureAllowance(address, p, a, step);
        step("Confirm the bond in your wallet.");
        await send({ address: p, abi: POOL, functionName: "postBond", args: [BigInt(id), a] });
        setAmt("");
        return `${orry(a)} ORRY locked behind agent ${id}.`;
      });
    } else if (mode === "draw") {
      await tx.run("Draw", async ({ send }) => {
        await send({ address: p, abi: POOL, functionName: "draw", args: [BigInt(id), a] });
        setAmt("");
        return `${usd(a)} USDG sent to the agent wallet.`;
      });
    } else if (mode === "repay") {
      await tx.run("Repay", async ({ send, step }) => {
        await approve(address, p, a, send, step);
        step("Confirm the repayment in your wallet.");
        await send({ address: p, abi: POOL, functionName: "repay", args: [BigInt(id), a] });
        setAmt("");
        return "Repaid.";
      });
    } else {
      await tx.run("Release bond", async ({ send }) => {
        await send({ address: p, abi: POOL, functionName: "withdrawBond", args: [BigInt(id), a] });
        setAmt("");
        return `${orry(a)} ORRY back in your wallet.`;
      });
    }
  }

  return (
    <section className="rc-panel" aria-label="Agent credit line">
      <div className="rc-panel-head">
        <h2>Your agent&apos;s line</h2>
      </div>
      <label className="cr-field">
        <span>Agent id</span>
        <input value={agent} inputMode="numeric" placeholder="328" onChange={(e) => setAgent(e.target.value.replace(/\D/g, ""))} />
      </label>
      {line ? (
        <>
          <LineMeter line={line} />
          <dl className="rc-rows">
            <Row label="Bond">{orry(BigInt(line.bond))} ORRY</Row>
            <Row label="Bond multiple">{(line.tierMultBps / 10_000).toFixed(1)}x</Row>
            <Row label="Owed now">{usd(owed)} USDG</Row>
            <Row label="Due">{line.dueAt ? (line.dueAt > now ? utc(line.dueAt) : `${utc(line.dueAt)}, grace ends ${utc(line.dueAt + pool.params.grace)}`) : "Nothing owed"}</Row>
            <Row label="Repays from">
              <span className="mono">{line.router}</span>
            </Row>
          </dl>
        </>
      ) : id && lines.isFetched ? (
        <p className="rc-muted">No line for agent {id} in this pool yet. Post a bond to open one.</p>
      ) : null}
      {id ? (
        <div className="rc-desk-body">
          <Segmented
            label="Line actions"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setAmt("");
            }}
            options={[{ id: "bond", label: "Bond" }, { id: "draw", label: "Draw" }, { id: "repay", label: "Repay" }, { id: "release", label: "Release bond" }]}
          />
          <AmountField
            id="cr-line"
            label={mode === "bond" ? "ORRY to lock" : mode === "release" ? "ORRY to release" : mode === "draw" ? "USDG to draw" : "USDG to repay"}
            unit={decimals === 18 ? "ORRY" : "USDG"}
            value={amt}
            onChange={setAmt}
            max={mode === "draw" ? usd(room) : mode === "repay" ? usd(owed) : mode === "release" && line ? orry(BigInt(line.bond)) : undefined}
            onMax={() => setAmt(mode === "draw" ? toInput(room, 6) : mode === "repay" ? toInput(owed, 6) : line ? toInput(BigInt(line.bond)) : "")}
          />
          {ready ? (
            <button className="primary rc-go" type="button" disabled={Boolean(tx.busy) || !a} onClick={() => void go()}>
              {tx.busy ? "Waiting for the wallet…" : mode === "bond" ? "Lock ORRY" : mode === "draw" ? "Draw USDG" : mode === "repay" ? "Repay" : "Release ORRY"}
            </button>
          ) : (
            <WalletButton />
          )}
          <NoticeLine notice={tx.notice} />
        </div>
      ) : null}
    </section>
  );
}

function Terms({ pool }: { pool: CreditPoolView }) {
  const p = pool.params;
  const tiers = p.tierUsdDays.map((t, i) => `${(p.tierMultBps[i]! / 10_000).toFixed(1)}x from ${amount(BigInt(t), { decimals: 6, frac: 0 })}`).join(", ");
  return (
    <section className="rc-panel" aria-label="Terms of pool 1">
      <div className="rc-panel-head">
        <h2>Terms</h2>
      </div>
      <dl className="rc-rows">
        <Row label="Interest">{bps(p.aprBps)} a year, simple, on what is drawn</Row>
        <Row label="Orrery's share">{bps(p.feeBps)} of interest paid</Row>
        <Row label="From x402 revenue">{bps(p.repayBps)} of each payment to the agent repays first</Row>
        <Row label="Limit">bond value times its multiple, at most {usd(p.maxLineUsdg)} USDG and {bps(p.maxLineBps)} of the pool</Row>
        <Row label="Multiple">{tiers} USDG-days repaid</Row>
        <Row label="Minimum bond">{usd(p.minBondUsd)} USDG of ORRY</Row>
        <Row label="Term">{days(p.term)} from the first draw, then {days(p.grace)} of grace; after that the bond passes to the pool&apos;s lenders</Row>
      </dl>
    </section>
  );
}

export function CreditView() {
  const pools = useCreditPools();
  const releases = useReleases();
  const pool = pools.data?.pools.find((p) => !p.retired) ?? pools.data?.pools[0];
  return (
    <>
      <OrryHead
        title="Lend USDG to agents that earn."
        lead={<p>Lenders fund one pool. A verified agent&apos;s owner locks ORRY behind the agent and draws USDG into its wallet, and the agent&apos;s x402 revenue repays the line first.</p>}
        reading={<Reading pool={pool} />}
      />
      {pool ? (
        <>
          <div className="rc-grid">
            <LendDesk pool={pool} />
            <Terms pool={pool} />
          </div>
          {releases.isLive("credit-bond") ? <LineDesk pool={pool} /> : null}
        </>
      ) : pools.isFetched ? (
        <p className="rc-muted">The first pool opens here.</p>
      ) : null}
    </>
  );
}

/** Held page: a lender's USDG and seized ORRY stay withdrawable whatever the release switch says. */
export function CreditExits() {
  const { address } = useWallet();
  const acct = useCreditAccount(address);
  const tx = useTx();
  const held = acct.data?.positions ?? [];
  if (!address || held.length === 0) return null;
  return (
    <section className="rc-desk" aria-label="Your Credit positions">
      <div className="rc-desk-body">
        {held.map((p) => (
          <div key={p.pool} className="cr-claim">
            <span>
              <b className="num">{usd(p.value)}</b> USDG lent, <b className="num">{orry(BigInt(p.orryClaimable))}</b> ORRY to claim
            </span>
            <button
              type="button"
              className="rc-max"
              disabled={Boolean(tx.busy)}
              onClick={() =>
                void tx.run("Withdraw", async ({ send }) => {
                  if (BigInt(p.orryClaimable) > 0n) await send({ address: p.pool as Address, abi: POOL, functionName: "claimOrry" });
                  await send({ address: p.pool as Address, abi: POOL, functionName: "withdraw", args: [BigInt(p.shares)] });
                  return "Back in your wallet.";
                })
              }
            >
              Withdraw all
            </button>
          </div>
        ))}
        <NoticeLine notice={tx.notice} />
      </div>
    </section>
  );
}
