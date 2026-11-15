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
      step("Confirm the pass in your wallet.");
      await send({ address: passes, abi: passesAbi, functionName: "buy", args: [to, PASS_KINDS[kind], BigInt(count), max] });
      return sameAddr(to, address) ? `Bought ${label}. Your pass time is extended.` : `Sent ${label} to ${mask(to)}.`;
    });
  }

  return (
    <>
      <OrryHead
        title="Day and week passes, paid in ORRY."
        lead={<p>Buy pass time for your wallet or send it to another one. Every ORRY paid for a pass is burned, and new time adds to the end of the current pass.</p>}
        reading={<PassCard until={myUntil} now={now} connected={connected} />}
      />
      <div className="rc-grid">
        <section className="rc-desk" aria-label="Buy a pass">
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
                <span>From 1 to {MAX_COUNT} in one purchase.</span>
              </div>
            </div>
            <div>
              <Segmented
                label="Recipient"
                value={forWho}
                onChange={setForWho}
                options={[
                  { id: "me", label: "For my wallet" },
                  { id: "gift", label: "As a gift" },
                ]}
              />
              {forWho === "gift" ? (
                <div className="cm-gift">
                  <label className="cm-label" htmlFor="cm-pass-gift">
                    Wallet that receives the pass
                  </label>
                  <input id="cm-pass-gift" className="cm-input mono" autoComplete="off" spellCheck={false} placeholder="0x…" value={giftIn} onChange={(e) => setGiftIn(e.target.value)} />
                  {giftIn.trim() && !gift ? <p className="cm-field-foot">Enter a full wallet address.</p> : null}
                </div>
              ) : null}
            </div>
            <dl className="rc-rows rc-rows-tight">
              <Row label="Price" hint={countOk ? usd(unitUsd * BigInt(count)) : undefined}>
                <Fig v={quote.data !== undefined && countOk ? orry(quote.data) : undefined} unit="ORRY" />
              </Row>
              {account ? (
                <Row label={forWho === "me" ? "Your pass" : "Their pass"}>{until === undefined ? "…" : until > now ? `Runs until ${utc(until)}` : "No active pass"}</Row>
              ) : null}
            </dl>
            {connected ? (
              <button className="primary rc-go" type="button" disabled={!ready || Boolean(tx.busy) || !account || !countOk || quote.data === undefined} onClick={() => void buy()}>
                {tx.busy ? "Buying…" : forWho === "me" ? "Buy pass" : "Send pass"}
              </button>
            ) : (
              <div className="rc-connect">
                <p>Connect a wallet to buy a pass.</p>
                <WalletButton />
              </div>
            )}
            <NoticeLine notice={tx.notice} />
          </div>
        </section>
        <section className="rc-side" aria-label="How passes work">
          <h2>How passes work</h2>
          <dl className="rc-rows">
            <Row label="Day pass">{usd(cfg.passUsd.day)}</Row>
            <Row label="Week pass">{usd(cfg.passUsd.week)}</Row>
            <Row label="Paid in">ORRY at the live price</Row>
            <Row label="ORRY paid">Burned</Row>
          </dl>
          <div className="rc-explain">
            <p>A pass belongs to the wallet it is bought for. Buying again before it ends adds the new time after the current end.</p>
          </div>
        </section>
      </div>
    </>
  );
}

function PassCard({ until, now, connected }: { until?: number; now: number; connected: boolean }) {
  return (
    <div className="rc-card">
      <p className="rc-card-title">Your pass</p>
      {!connected ? (
        <>
          <p className="rc-card-wait">Connect a wallet to see your pass.</p>
          <WalletButton />
        </>
      ) : until === undefined ? (
        <p className="rc-card-wait">…</p>
      ) : until > now ? (
        <>
          <p className="rc-big">
            <Fig v={span(until - now)} unit="left" />
          </p>
          <dl className="rc-rows">
            <Row label="Runs until">{utc(until)}</Row>
          </dl>
        </>
      ) : (
        <p className="rc-card-wait">No active pass on this wallet.</p>
      )}
    </div>
  );
}
