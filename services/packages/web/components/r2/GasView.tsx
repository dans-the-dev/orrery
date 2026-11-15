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
      <p className="rc-card-title">Current gas reading</p>
      <p className="rc-big">
        <Fig v={per !== undefined ? orry(per) : undefined} unit="ORRY for each 0.00001 ETH of gas" />
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
    <section className="rc-desk r2-desk" aria-label="Take back prepaid gas">
      <div className="rc-desk-body">
        <AmountField id="gas-exit" label="Amount to take back, ORRY" unit="ORRY" value={amt} onChange={setAmt} max={orry(mine)} onMax={() => setAmt(toInput(mine))} />
        <button
          className="primary rc-go"
          type="button"
          disabled={Boolean(tx.busy) || !parseAmount(amt)}
          onClick={() => void tx.run("Withdraw", async ({ send }) => {
            await send({ address: PAYMASTER, abi: pmAbi, functionName: "withdraw", args: [address, parseAmount(amt)] });
            setAmt("");
            return "Returned to your wallet.";
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
      step("Approve the gas deposit in your wallet.");
      await send({ address: PAYMASTER, abi: pmAbi, functionName: "deposit", args: [target, a] });
      setAmt("");
      return `${orry(a)} ORRY is now ready for ${target === address ? "your account" : "that account"} to spend on gas.`;
    });
  }
  async function withdraw() {
    const a = parseAmount(amt);
    if (!address || !a) return;
    await tx.run("Withdraw", async ({ send }) => {
      await send({ address: PAYMASTER, abi: pmAbi, functionName: "withdraw", args: [address, a] });
      setAmt("");
      return `${orry(a)} ORRY returned to your wallet.`;
    });
  }

  return (
    <>
      <OrryHead
        title="Your agents spend ORRY on gas, not ETH."
        lead={<p>Set aside ORRY for a smart account. Orrery&apos;s paymaster then covers each of its ERC-4337 operations and charges that balance the USD value of the gas used.</p>}
        reading={<Reading />}
      />
      <div className="rc-grid">
        <section className="rc-desk r2-desk" aria-label="Gas balance">
          <Segmented label="Gas actions" value={mode} onChange={setMode} options={[{ id: "fund", label: "Add to an account" }, { id: "withdraw", label: "Withdraw" }]} />
          {mode === "fund" ? (
            <div className="rc-desk-body">
              <label className="r2-field">
                <span>Smart account</span>
                <input value={account} placeholder={address ?? "0x…"} onChange={(e) => setAccount(e.target.value.trim())} spellCheck={false} />
              </label>
              <AmountField id="gas-amt" label="Amount to add, ORRY" unit="ORRY" value={amt} onChange={setAmt} hint={bal !== undefined ? `Gas balance: ${orry(bal)} ORRY` : undefined} />
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
              <p className="rc-muted">Only the account itself takes its balance back, and it can send it to any address.</p>
              <AmountField id="gas-out" label="Amount to take back, ORRY" unit="ORRY" value={amt} onChange={setAmt} max={mine !== undefined ? orry(mine) : undefined} onMax={() => mine !== undefined && setAmt(toInput(mine))} />
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
            <h2>For agent builders</h2>
          </div>
          <dl className="rc-rows">
            <Row label="Paymaster">
              <span className="mono">{PAYMASTER}</span>
            </Row>
            <Row label="paymasterAndData">Paymaster address, then verification gas (16 bytes), then postOp gas of 120,000 or more (16 bytes)</Row>
            <Row label="Funding">Anyone may add to an account. Only that account can take its balance back</Row>
          </dl>
        </section>
      </div>
    </>
  );
}
