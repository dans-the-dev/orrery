"use client";

import { useState } from "react";
import { isAddress, type Abi, type Address } from "viem";
import { attesterFeeSplitterAbi, attesterRegistryAbi, type AttestersResponse } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { short } from "@/lib/format";
import { bps, days, useAttesters, useCreditAccount } from "@/lib/credit/api";
import { useNow, useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { amount, parseAmount, orry, utc } from "@/lib/orry/format";
import { AmountField, Fig, NoticeLine, OrryHead, Row, Segmented } from "../orry/parts";

const REG = attesterRegistryAbi as Abi;
const SPL = attesterFeeSplitterAbi as Abi;
const usd = (v: string) => amount(BigInt(v), { decimals: 6, frac: 2 });
const whole = (v: string) => amount(BigInt(v), { frac: 0 });

function Reading({ a }: { a?: AttestersResponse }) {
  return (
    <div className="rc-card">
      <p className="rc-card-title">{a ? `Week ${a.epoch + 1}` : "This week"}</p>
      <p className="rc-big">
        <Fig v={a ? usd(a.epochPool) : undefined} unit="USDG to attesters" />
      </p>
      <dl className="rc-rows">
        <Row label="Active">{a ? a.attesters.filter((x) => x.active).length : "…"}</Row>
        <Row label="Agents checked">{a ? a.totalResults : "…"}</Row>
        <Row label="Set changes">{a ? utc(a.epochEndsAt) : "…"}</Row>
      </dl>
    </div>
  );
}

function StakeDesk({ a }: { a: AttestersResponse }) {
  const { address, ready } = useWallet();
  const tx = useTx();
  const now = useNow();
  const acct = useCreditAccount(address);
  const me = acct.data?.attester?.staker ?? null;
  const [mode, setMode] = useState<"stake" | "leave">("stake");
  const [amt, setAmt] = useState("");
  const [probe, setProbe] = useState("");
  const amtWei = parseAmount(amt);
  const min = BigInt(a.minStake);
  const first = !me;
  const okFirst = first ? Boolean(amtWei && amtWei >= min && isAddress(probe) && probe.toLowerCase() !== address?.toLowerCase()) : Boolean(amtWei);
  const reg = a.registry as Address;

  async function stake() {
    if (!address || !amtWei) return;
    await tx.run("Stake", async ({ send, step, ensureAllowance }) => {
      await ensureAllowance(address, reg, amtWei, step);
      step("Sign the stake in your wallet.");
      await send({ address: reg, abi: REG, functionName: "stake", args: [amtWei, first ? probe : "0x0000000000000000000000000000000000000000"] });
      setAmt("");
      return `Attester stake on record · ${orry(amtWei)} ORRY.`;
    });
  }
  async function leave() {
    await tx.run("Leave", async ({ send }) => {
      await send({ address: reg, abi: REG, functionName: "requestUnlock" });
      return `Exit on record. The stake becomes withdrawable in ${days(a.unlockDelay)}.`;
    });
  }
  async function withdraw() {
    await tx.run("Withdraw stake", async ({ send }) => {
      await send({ address: reg, abi: REG, functionName: "withdraw" });
      return "The ORRY went back to your wallet.";
    });
  }

  return (
    <section className="rc-desk" aria-label="Attester stake">
      {me?.unlockAt ? (
        <div className="rc-desk-body">
          <p className="rc-muted">{me.unlockAt > now ? `${whole(me.amount)} ORRY becomes withdrawable on ${utc(me.unlockAt)}.` : `${whole(me.amount)} ORRY can be withdrawn now.`}</p>
          {me.unlockAt <= now ? (
            <button className="primary rc-go" type="button" disabled={Boolean(tx.busy)} onClick={() => void withdraw()}>
              Withdraw stake
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <Segmented label="Attester actions" value={mode} onChange={setMode} options={[{ id: "stake", label: first ? "Join as attester" : "Add stake" }, ...(me ? [{ id: "leave" as const, label: "Leave" }] : [])]} />
          {mode === "stake" ? (
            <div className="rc-desk-body">
              <AmountField id="at-amt" label="Amount to stake" unit="ORRY" value={amt} onChange={setAmt} hint={first ? `Minimum ${whole(a.minStake)} ORRY` : `Current stake · ${whole(me!.amount)} ORRY`} />
              {first ? (
                <label className="cr-field">
                  <span>Probe key · the address that signs your probe results</span>
                  <input value={probe} placeholder="0x…" spellCheck={false} onChange={(e) => setProbe(e.target.value.trim())} />
                </label>
              ) : null}
              {ready ? (
                <button className="primary rc-go" type="button" disabled={Boolean(tx.busy) || !okFirst || !ORRY.token} onClick={() => void stake()}>
                  {tx.busy ? "Check your wallet…" : "Stake ORRY"}
                </button>
              ) : (
                <WalletButton />
              )}
            </div>
          ) : (
            <div className="rc-desk-body">
              <p className="rc-muted">Leaving takes you out of the active set right away. The ORRY becomes withdrawable {days(a.unlockDelay)} after.</p>
              <button className="primary rc-go" type="button" disabled={Boolean(tx.busy)} onClick={() => void leave()}>
                Leave
              </button>
            </div>
          )}
        </>
      )}
      <Claims />
      <NoticeLine notice={tx.notice} />
    </section>
  );
}

/** Ended weeks with USDG to claim; never held. */
export function Claims() {
  const { address } = useWallet();
  const acct = useCreditAccount(address);
  const tx = useTx();
  const list = acct.data?.attester?.claimable ?? [];
  if (!ORRY.attesterSplitter || list.length === 0) return null;
  return (
    <div className="cr-claims">
      {list.map((c) => (
        <div key={c.epoch} className="cr-claim">
          <span>
            Week {c.epoch + 1}: <b className="num">{usd(c.amount)}</b> USDG
          </span>
          <button
            type="button"
            className="rc-max"
            disabled={Boolean(tx.busy)}
            onClick={() =>
              void tx.run("Claim", async ({ send }) => {
                await send({ address: ORRY.attesterSplitter as Address, abi: SPL, functionName: "claim", args: [BigInt(c.epoch)] });
                return "The USDG went to your wallet.";
              })
            }
          >
            Claim
          </button>
        </div>
      ))}
      <NoticeLine notice={tx.notice} />
    </div>
  );
}

export function AttestersView() {
  const q = useAttesters();
  const a = q.data;
  return (
    <>
      <OrryHead
        title="Observe agents and sign the readings."
        lead={
          <p>
            Stake {a ? whole(a.minStake) : "1,000,000"} ORRY and register a probe key. Every week the {a?.maxActive ?? 20} largest stakes form the set that probes agents and
            publishes signed results. The set splits {a ? bps(a.shareBps) : "30%"} of verification fees, weighted by the agents each attester checked.
          </p>
        }
        reading={<Reading a={a} />}
      />
      {a ? (
        <div className="rc-grid">
          <StakeDesk a={a} />
          <section className="rc-panel" aria-label="Current attester set">
            <div className="rc-panel-head">
              <h2>Current set</h2>
            </div>
            {a.attesters.length === 0 ? (
              <p className="rc-muted">Attester stakes are listed here once placed.</p>
            ) : (
              <div className="rc-table-wrap">
                <table className="rc-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Attester</th>
                      <th className="num">Stake</th>
                      <th className="num">Agents</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.attesters.map((x) => (
                      <tr key={x.staker} className={x.active ? undefined : "cr-out"}>
                        <td className="num">{x.rank ?? ""}</td>
                        <td className="mono">{short(x.staker)}</td>
                        <td className="num">{whole(x.amount)}</td>
                        <td className="num">{x.results}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}

/** Held page: a staker's ORRY and its claims stay reachable whatever the release switch says. */
export function AttesterExits() {
  const { address } = useWallet();
  const acct = useCreditAccount(address);
  const tx = useTx();
  const now = useNow();
  const me = acct.data?.attester?.staker;
  if (!address || !ORRY.attesterRegistry || (!me && !(acct.data?.attester?.claimable.length ?? 0))) return null;
  const reg = ORRY.attesterRegistry as Address;
  return (
    <section className="rc-desk" aria-label="Attester stake position">
      <div className="rc-desk-body">
        {me ? (
          <div className="cr-claim">
            <span>
              <b className="num">{whole(me.amount)}</b> ORRY staked
            </span>
            {me.unlockAt === 0 ? (
              <button type="button" className="rc-max" disabled={Boolean(tx.busy)} onClick={() => void tx.run("Leave", async ({ send }) => void (await send({ address: reg, abi: REG, functionName: "requestUnlock" })))}>
                Leave
              </button>
            ) : me.unlockAt <= now ? (
              <button type="button" className="rc-max" disabled={Boolean(tx.busy)} onClick={() => void tx.run("Withdraw stake", async ({ send }) => void (await send({ address: reg, abi: REG, functionName: "withdraw" })))}>
                Withdraw
              </button>
            ) : (
              <span className="rc-muted">Withdrawable on {utc(me.unlockAt)}</span>
            )}
          </div>
        ) : null}
        <Claims />
        <NoticeLine notice={tx.notice} />
      </div>
    </section>
  );
}
