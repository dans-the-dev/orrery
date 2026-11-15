"use client";

import { useState } from "react";
import { isAddress, type Abi, type Address } from "viem";
import { useReadContract } from "wagmi";
import { iOrryPaymasterAbi } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { usePaymasters } from "@/lib/r2/api";
import { useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { parseAmount, orry, toInput } from "@/lib/orry/format";
import { AmountField, Fig, NoticeLine, OrryHead, Row, Segmented } from "../orry/parts";

const PAYMASTER = ORRY.paymaster as Address;
const pmAbi = iOrryPaymasterAbi as Abi;
/** A typical agent operation on Robinhood Chain costs well under this much ETH; the page prices this amount. */
const SAMPLE_WEI = 10n ** 13n;

function Reading() {
  const q = usePaymasters();
  const pm = q.data?.paymasters.find((p) => p.paymaster === PAYMASTER.toLowerCase()) ?? q.data?.paymasters[0];
  const per = pm?.rate ? (BigInt(pm.rate) * SAMPLE_WEI * BigInt(10_000 + pm.premiumBps)) / (10n ** 18n * 10_000n) : undefined;
  return (
    <div className="rc-card">
      <p className="rc-card-title">Gas price in ORRY</p>
      <p className="rc-big">
        <Fig v={per !== undefined ? orry(per) : undefined} unit="ORRY per 0.00001 ETH" />
      </p>
      <dl className="rc-rows">
        <Row label="EntryPoint">{q.data ? q.data.paymasters.map((p) => `v${p.version}`).join(", ") : "…"}</Row>
        <Row label="Premium, burned">{pm ? `${pm.premiumBps / 100}%` : "…"}</Row>
      </dl>
    </div>
  );
}

/** Held page: an account's balance stays withdrawable whatever the release switch says. */
export function GasExits() {
  const { address, connected } = useWallet();
  const tx = useTx();
  const [amt, setAmt] = useState("");
  const mine = useReadContract({ address: PAYMASTER, abi: pmAbi, functionName: "balanceOf", args: address ? [address] : undefined, query: { enabled: Boolean(address && PAYMASTER) } }).data as bigint | undefined;
  if (!PAYMASTER || !connected || !mine) return null;
  return (
    <section className="rc-desk r2-desk" aria-label="Withdraw prepaid gas">
      <div className="rc-desk-body">
        <AmountField id="gas-exit" label="ORRY to withdraw" unit="ORRY" value={amt} onChange={setAmt} max={orry(mine)} onMax={() => setAmt(toInput(mine))} />
        <button
          className="primary rc-go"
          type="button"
          disabled={Boolean(tx.busy) || !parseAmount(amt)}
          onClick={() => void tx.run("Withdraw", async ({ send }) => {
            await send({ address: PAYMASTER, abi: pmAbi, functionName: "withdraw", args: [address, parseAmount(amt)] });
            setAmt("");
            return "Back in your wallet.";
          })}
        >
          Withdraw
        </button>
        <NoticeLine notice={tx.notice} />
      </div>
    </section>
  );
}

export function GasView() {
  const { address, ready } = useWallet();
  const tx = useTx();
  const [mode, setMode] = useState<"fund" | "withdraw">("fund");
  const [account, setAccount] = useState("");
  const [amt, setAmt] = useState("");
  const target = (isAddress(account) ? account : address) as Address | undefined;
  const bal = useReadContract({ address: PAYMASTER, abi: pmAbi, functionName: "balanceOf", args: target ? [target] : undefined, query: { enabled: Boolean(target), refetchInterval: 10_000 } }).data as bigint | undefined;
  const mine = useReadContract({ address: PAYMASTER, abi: pmAbi, functionName: "balanceOf", args: address ? [address] : undefined, query: { enabled: Boolean(address), refetchInterval: 10_000 } }).data as bigint | undefined;

  async function fund() {
    const a = parseAmount(amt);
    if (!address || !a || !target) return;
    await tx.run("Fund gas", async ({ send, step, ensureAllowance }) => {
      await ensureAllowance(address, PAYMASTER, a, step);
      step("Confirm the deposit in your wallet.");
      await send({ address: PAYMASTER, abi: pmAbi, functionName: "deposit", args: [target, a] });
      setAmt("");
      return `${orry(a)} ORRY ready for ${target === address ? "your account" : "that account"}'s gas.`;
    });
  }
  async function withdraw() {
    const a = parseAmount(amt);
    if (!address || !a) return;
    await tx.run("Withdraw", async ({ send }) => {
      await send({ address: PAYMASTER, abi: pmAbi, functionName: "withdraw", args: [address, a] });
      setAmt("");
      return `${orry(a)} ORRY back in your wallet.`;
    });
  }

  return (
    <>
      <OrryHead
        title="Pay your agents' gas in ORRY."
        lead={<p>Prepay a little ORRY for a smart account. Its ERC-4337 operations then run through Orrery&apos;s paymaster and are charged from that balance at the USD price of the gas they use.</p>}
        reading={<Reading />}
      />
      <div className="rc-grid">
        <section className="rc-desk r2-desk" aria-label="Gas balance">
          <Segmented label="Gas actions" value={mode} onChange={setMode} options={[{ id: "fund", label: "Fund an account" }, { id: "withdraw", label: "Withdraw" }]} />
          {mode === "fund" ? (
            <div className="rc-desk-body">
              <label className="r2-field">
                <span>Smart account</span>
                <input value={account} placeholder={address ?? "0x…"} onChange={(e) => setAccount(e.target.value.trim())} spellCheck={false} />
              </label>
              <AmountField id="gas-amt" label="ORRY to set aside" unit="ORRY" value={amt} onChange={setAmt} hint={bal !== undefined ? `Balance now ${orry(bal)} ORRY` : undefined} />
              {ready ? (
                <button className="primary rc-go" type="button" disabled={Boolean(tx.busy) || !parseAmount(amt) || !target} onClick={() => void fund()}>
                  {tx.busy ? "Funding…" : "Fund gas"}
                </button>
              ) : (
                <WalletButton />
              )}
            </div>
          ) : (
            <div className="rc-desk-body">
              <p className="rc-muted">Each account withdraws its own balance, to any address it names.</p>
              <AmountField id="gas-out" label="ORRY to withdraw" unit="ORRY" value={amt} onChange={setAmt} max={mine !== undefined ? orry(mine) : undefined} onMax={() => mine !== undefined && setAmt(toInput(mine))} />
              {ready ? (
                <button className="primary rc-go" type="button" disabled={Boolean(tx.busy) || !parseAmount(amt)} onClick={() => void withdraw()}>
                  {tx.busy ? "Withdrawing…" : "Withdraw"}
                </button>
              ) : (
                <WalletButton />
              )}
            </div>
          )}
          <NoticeLine notice={tx.notice} />
        </section>
        <section className="rc-panel r2-dev" aria-label="For developers">
          <div className="rc-panel-head">
            <h2>Use it from an agent</h2>
          </div>
          <dl className="rc-rows">
            <Row label="Paymaster">
              <span className="mono">{PAYMASTER}</span>
            </Row>
            <Row label="paymasterAndData">paymaster, verification gas (16 bytes), postOp gas of at least 120,000 (16 bytes)</Row>
            <Row label="Funding">Any wallet can fund an account; only the account withdraws its balance</Row>
          </dl>
        </section>
      </div>
    </>
  );
}
