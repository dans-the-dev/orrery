"use client";

import { useState } from "react";
import type { Abi, Address } from "viem";
import { useReadContract } from "wagmi";
import { PASS_KINDS, orryPassesAbi } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { Fig, NoticeLine, OrryHead, Row, Segmented } from "@/components/orry/parts";
import { useCommunity, type CommunityConfig } from "@/lib/community/config";
import { isAddr, isZeroAddr, sameAddr, usd, withHeadroom } from "@/lib/community/logic";
import { useCommunityTx } from "@/lib/community/tx";
import { useNow, useWallet } from "@/lib/orry/chain";
import { mask, orry, span, utc } from "@/lib/orry/format";

const passesAbi = orryPassesAbi as Abi;
/** OrryPasses.MAX_COUNT: passes per purchase. */
const MAX_COUNT = 52;

type Kind = "day" | "week";
type For = "me" | "gift";

export function PassesView() {
  const { config } = useCommunity();
  if (!config) return null;
  return <Passes cfg={config} />;
}

/** The pass end of an account, read from the contract (fresh after every purchase). */
function usePassUntil(passes: Address, account?: Address) {
  const q = useReadContract({ address: passes, abi: orryPassesAbi, functionName: "passUntil", args: account ? [account] : undefined, query: { enabled: Boolean(account), refetchInterval: 30_000 } });
  return q.data === undefined ? undefined : Number(q.data);
}

function Passes({ cfg }: { cfg: CommunityConfig }) {
  const { address, ready, connected } = useWallet();
  const now = useNow(5000);
  const tx = useCommunityTx();
  const passes = cfg.addresses.passes as Address;
  const [kind, setKind] = useState<Kind>("day");
  const [forWho, setForWho] = useState<For>("me");
  const [countIn, setCountIn] = useState("1");
  const [giftIn, setGiftIn] = useState("");
  const count = /^\d+$/.test(countIn) ? Number(countIn) : 0;
  const countOk = count >= 1 && count <= MAX_COUNT;
  const gift = isAddr(giftIn.trim()) && !isZeroAddr(giftIn.trim()) ? (giftIn.trim() as Address) : undefined;
  const account = forWho === "me" ? address : gift;
  const myUntil = usePassUntil(passes, address);
  const theirUntil = usePassUntil(passes, forWho === "gift" ? gift : undefined);
  const until = forWho === "me" ? myUntil : theirUntil;
  const unitUsd = kind === "day" ? cfg.passUsd.day : cfg.passUsd.week;
  const quote = useReadContract({
    address: passes,
    abi: orryPassesAbi,
    functionName: "quote",
    args: [PASS_KINDS[kind], BigInt(countOk ? count : 1)],
    query: { enabled: countOk, refetchInterval: 30_000 },
  });

  async function buy() {
    if (!account || !countOk || quote.data === undefined) return;
    const max = withHeadroom(quote.data);
    const to = account;
    const label = `${count} ${kind === "day" ? (count === 1 ? "day pass" : "day passes") : count === 1 ? "week pass" : "week passes"}`;
    await tx.run("Buy pass", async ({ send, step, approve }) => {
      await approve(cfg.addresses.orry as Address, passes, max);
      step("Sign the pass purchase in your wallet.");
      await send({ address: passes, abi: passesAbi, functionName: "buy", args: [to, PASS_KINDS[kind], BigInt(count), max] });
      return sameAddr(to, address) ? `Purchase on record · ${label}. The new time follows your current pass.` : `Gift on record · ${label} for ${mask(to)}.`;
    });
  }

  return (
    <>
      <OrryHead
        title="Passes by the day or the week, in ORRY."
        lead={<p>Get pass time for this wallet or gift it to any address. All ORRY spent on passes is burned, and fresh time starts where the current pass ends.</p>}
        reading={<PassCard until={myUntil} now={now} connected={connected} />}
      />
      <div className="rc-grid">
        <section className="rc-desk" aria-label="Pass purchase">
          <Segmented
            label="Pass"
            value={kind}
            onChange={setKind}
            options={[
              { id: "day", label: `Day pass · ${usd(cfg.passUsd.day)}` },
              { id: "week", label: `Week pass · ${usd(cfg.passUsd.week)}` },
            ]}
          />
          <div className="rc-desk-body">
            <div className="rc-amount">
              <label htmlFor="cm-pass-count">{kind === "day" ? "Days" : "Weeks"}</label>
              <div className="rc-amount-box">
                <input id="cm-pass-count" inputMode="numeric" autoComplete="off" value={countIn} onChange={(e) => setCountIn(e.target.value.replace(/\D/g, "").slice(0, 2))} />
                <span className="rc-unit">{kind === "day" ? "× 24 h" : "× 7 days"}</span>
              </div>
              <div className="rc-amount-foot">
                <span>Each purchase covers 1 to {MAX_COUNT}.</span>
              </div>
            </div>
            <div>
              <Segmented
                label="Recipient"
                value={forWho}
                onChange={setForWho}
                options={[
                  { id: "me", label: "This wallet" },
                  { id: "gift", label: "Gift" },
                ]}
              />
              {forWho === "gift" ? (
                <div className="cm-gift">
                  <label className="cm-label" htmlFor="cm-pass-gift">
                    Recipient address
                  </label>
                  <input id="cm-pass-gift" className="cm-input mono" autoComplete="off" spellCheck={false} placeholder="0x…" value={giftIn} onChange={(e) => setGiftIn(e.target.value)} />
                  {giftIn.trim() && !gift ? <p className="cm-field-foot">The address must be complete, 0x plus 40 characters.</p> : null}
                </div>
              ) : null}
            </div>
            <dl className="rc-rows rc-rows-tight">
              <Row label="Price" hint={countOk ? usd(unitUsd * BigInt(count)) : undefined}>
                <Fig v={quote.data !== undefined && countOk ? orry(quote.data) : undefined} unit="ORRY" />
              </Row>
              {account ? (
                <Row label={forWho === "me" ? "Current pass" : "Recipient pass"}>{until === undefined ? "…" : until > now ? `Valid through ${utc(until)}` : "None active"}</Row>
              ) : null}
            </dl>
            {connected ? (
              <button className="primary rc-go" type="button" disabled={!ready || Boolean(tx.busy) || !account || !countOk || quote.data === undefined} onClick={() => void buy()}>
                {tx.busy ? "Buying…" : forWho === "me" ? "Buy pass" : "Send pass"}
              </button>
            ) : (
              <div className="rc-connect">
                <p>Buying a pass needs a connected wallet.</p>
                <WalletButton />
              </div>
            )}
            <NoticeLine notice={tx.notice} />
          </div>
        </section>
        <section className="rc-side" aria-label="Pass terms">
          <h2>Pass terms</h2>
          <dl className="rc-rows">
            <Row label="Day pass">{usd(cfg.passUsd.day)}</Row>
            <Row label="Week pass">{usd(cfg.passUsd.week)}</Row>
            <Row label="Payment">ORRY at the current rate</Row>
            <Row label="ORRY spent">Burned</Row>
          </dl>
          <div className="rc-explain">
            <p>Each pass is tied to the wallet it was bought for. A second purchase made while a pass runs starts when that pass ends.</p>
          </div>
        </section>
      </div>
    </>
  );
}

function PassCard({ until, now, connected }: { until?: number; now: number; connected: boolean }) {
  return (
    <div className="rc-card">
      <p className="rc-card-title">Pass</p>
      {!connected ? (
        <>
          <p className="rc-card-wait">Connect a wallet to see its pass.</p>
          <WalletButton />
        </>
      ) : until === undefined ? (
        <p className="rc-card-wait">…</p>
      ) : until > now ? (
        <>
          <p className="rc-big">
            <Fig v={span(until - now)} unit="to go" />
          </p>
          <dl className="rc-rows">
            <Row label="Valid through">{utc(until)}</Row>
          </dl>
        </>
      ) : (
        <p className="rc-card-wait">This wallet holds no active pass.</p>
      )}
    </div>
  );
}
