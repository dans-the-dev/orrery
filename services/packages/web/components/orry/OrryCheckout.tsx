"use client";

import { useEffect, useState } from "react";
import { parseAbi, type Abi, type Address } from "viem";
import { usePublicClient } from "wagmi";
import { iOrreryTreasuryAbi } from "@orrery/shared";
import { ADDRESSES } from "@/lib/config";
import { ApiError, parseQuote, post, type Quote } from "@/lib/orry/api";
import { useAccountChain, useNow, useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { useReleases } from "@/lib/orry/releases";
import { orry, span } from "@/lib/orry/format";
import { NoticeLine, Row } from "./parts";

const TREASURY = ORRY.treasury as Address;
const treasuryAbi = iOrreryTreasuryAbi as Abi;
const registryAbi = parseAbi(["function ownerOf(uint256) view returns (address)"]);

/** Credits granted per pack paid in ORRY: the USDG pack size at 625 credits per dollar instead of 500. */
const orryCredits = (packs: number, packSize?: number) => (packSize ? Math.floor((packs * packSize * 625) / 500) : undefined);

function QuoteLine({ quote, now }: { quote: Quote; now: number }) {
  const left = quote.expiry - now;
  return (
    <dl className="rc-rows rc-rows-tight">
      <Row label="Price">{orry(quote.orryAmount)} ORRY</Row>
      <Row label="Quote">{left > 0 ? `Good for ${span(left)}` : "Out of date, request another"}</Row>
    </dl>
  );
}

/** Most checks in one pay-as-you-go quote (the API's ORRERY_ORRY_MAX_CHECKS default). */
const MAX_CHECKS = 1_000;

/** ORRY checkout on the credits page: credit packs, single checks and agent verification, paid in ORRY and burned. */
export function OrryCheckout({ packSize, creditsPerCheck }: { packSize?: number; creditsPerCheck?: number }) {
  const { address, ready } = useWallet();
  const me = useAccountChain(address);
  const pub = usePublicClient();
  const now = useNow();
  const packsTx = useTx();
  const verifyTx = useTx();
  const checksTx = useTx();
  const payg = useReleases().isLive("payg-checks");

  const [packs, setPacks] = useState(1);
  const [packQuote, setPackQuote] = useState<Quote | null>(null);
  const [agentIn, setAgentIn] = useState("");
  const [verifyQuote, setVerifyQuote] = useState<{ quote: Quote; owner: Address } | null>(null);
  const [checks, setChecks] = useState(10);
  const [checksQuote, setChecksQuote] = useState<Quote | null>(null);
  const agentId = /^\d+$/.test(agentIn) ? BigInt(agentIn) : undefined;

  useEffect(() => {
    // The operator page links here with ?agent=<id> to pay that agent's verification in ORRY.
    const a = new URLSearchParams(window.location.search).get("agent");
    if (a && /^\d+$/.test(a)) setAgentIn(a);
  }, []);
  useEffect(() => setPackQuote(null), [packs, address]);
  useEffect(() => setVerifyQuote(null), [agentIn, address]);
  useEffect(() => setChecksQuote(null), [checks, address]);

  const credits = packQuote?.credits !== undefined ? Number(packQuote.credits) : orryCredits(packs, packSize);
  const checkCredits = checksQuote?.credits !== undefined ? Number(checksQuote.credits) : creditsPerCheck ? checks * creditsPerCheck : undefined;

  /** Reads a quote and refuses one signed for a contract other than the configured treasury. */
  async function fetchQuote(path: string, body: unknown): Promise<Quote> {
    const q = parseQuote(await post<Record<string, unknown>>(path, body));
    if (q.treasury && q.treasury.toLowerCase() !== TREASURY.toLowerCase()) throw new Error("This quote names a different contract. Request a fresh quote.");
    return q;
  }
  const quoteError = (e: unknown) =>
    e instanceof ApiError && e.status === 503 ? "The ORRY price reading is still settling. Request the quote again shortly." : e instanceof Error ? e.message : "The quote did not arrive. Request it again.";

  async function quotePacks() {
    if (!address) return;
    packsTx.setNotice({ tone: "", text: "Taking a price reading." });
    try {
      setPackQuote(await fetchQuote("/v1/orry/quotes/credits", { buyer: address, packs }));
      packsTx.setNotice(null);
    } catch (e) {
      packsTx.setNotice({ tone: "error", text: quoteError(e) });
    }
  }
  async function payPacks() {
    const q = packQuote;
    if (!address || !q) return;
    // A failed payment drops the quote, so the next click asks for a fresh one.
    const ok = await packsTx.run("ORRY payment", async ({ send, step, ensureAllowance }) => {
      await ensureAllowance(address, TREASURY, q.orryAmount, step);
      step("Sign the payment in your wallet.");
      await send({ address: TREASURY, abi: treasuryAbi, functionName: "burnForCredits", args: [packs, q.orryAmount, q.quoteId, BigInt(q.expiry), q.sig] });
      setPackQuote(null);
      return `Payment on record, ${orry(q.orryAmount)} ORRY burned. ${credits ? `${credits.toLocaleString("en-US")} credits are` : "The credits are"} added to this address when the block confirms. The balance and the API key for this wallet are on this page.`;
    });
    if (!ok) setPackQuote(null);
  }

  async function quoteChecks() {
    if (!address) return;
    checksTx.setNotice({ tone: "", text: "Taking a price reading." });
    try {
      setChecksQuote(await fetchQuote("/v1/orry/quotes/checks", { buyer: address, checks }));
      checksTx.setNotice(null);
    } catch (e) {
      checksTx.setNotice({ tone: "error", text: quoteError(e) });
    }
  }
  async function payChecks() {
    const q = checksQuote;
    if (!address || !q) return;
    const n = q.checks ?? checks;
    const ok = await checksTx.run("Check purchase", async ({ send, step, ensureAllowance }) => {
      await ensureAllowance(address, TREASURY, q.orryAmount, step);
      step("Sign the payment in your wallet.");
      // the treasury's packs field carries the number of checks for a pay-as-you-go quote
      await send({ address: TREASURY, abi: treasuryAbi, functionName: "burnForCredits", args: [n, q.orryAmount, q.quoteId, BigInt(q.expiry), q.sig] });
      setChecksQuote(null);
      const c = q.credits !== undefined ? ` (${Number(q.credits).toLocaleString("en-US")} credits)` : "";
      const one = n === 1;
      return `Payment on record, ${orry(q.orryAmount)} ORRY burned. ${n.toLocaleString("en-US")} ${one ? "check" : "checks"}${c} ${one ? "is" : "are"} added to this address when the block confirms, for use with the API key of this wallet.`;
    });
    if (!ok) setChecksQuote(null);
  }

  async function quoteVerify() {
    if (!address || agentId === undefined || !pub || !ADDRESSES.registry) return;
    verifyTx.setNotice({ tone: "", text: "Taking a price reading." });
    try {
      const owner = await pub.readContract({ address: ADDRESSES.registry, abi: registryAbi, functionName: "ownerOf", args: [agentId] });
      const quote = await fetchQuote("/v1/orry/quotes/verification", { payer: address, agentId: agentId.toString() });
      setVerifyQuote({ quote, owner });
      verifyTx.setNotice(null);
    } catch (e) {
      verifyTx.setNotice({ tone: "error", text: e instanceof ApiError || (e instanceof Error && !/ownerOf|revert/i.test(e.message)) ? quoteError(e) : "No agent is registered under that ID." });
    }
  }
  async function payVerify() {
    const v = verifyQuote;
    if (!address || !v || agentId === undefined) return;
    const ok = await verifyTx.run("ORRY verification", async ({ send, step, ensureAllowance }) => {
      await ensureAllowance(address, TREASURY, v.quote.orryAmount, step);
      step("Sign the verification in your wallet.");
      await send({ address: TREASURY, abi: treasuryAbi, functionName: "verifyWithOrry", args: [agentId, v.owner, v.quote.orryAmount, v.quote.quoteId, BigInt(v.quote.expiry), v.quote.sig] });
      setVerifyQuote(null);
      return `Verification on record for agent #${agentId}. ${orry(v.quote.orryAmount)} ORRY burned.`;
    });
    if (!ok) setVerifyQuote(null);
  }

  const balance = me.orryBalance;
  const short = (q: Quote | null | undefined) => Boolean(q && balance !== undefined && balance < q.orryAmount);

  return (
    <section className="panel rc-checkout" id="orry">
      <div className="panel-head">
        <div>
          <p className="section-kicker">ORRY checkout</p>
          <h2>Every 1 USD of ORRY buys 625 credits.</h2>
        </div>
      </div>
      <p>Every ORRY spent here is burned. Prices are read from the ORRY pool, and each quote states how long it stays good.</p>

      <div className={payg ? "rc-checkout-grid three" : "rc-checkout-grid"}>
        <div>
          <h3>Credit packs</h3>
          <div className="rc-amount">
            <label htmlFor="rc-packs">Packs</label>
            <div className="rc-amount-box">
              <input id="rc-packs" inputMode="numeric" value={String(packs)} onChange={(e) => setPacks(Math.max(1, Math.min(100, Number(e.target.value.replace(/\D/g, "")) || 1)))} />
              <span className="rc-unit">{credits ? `${credits.toLocaleString("en-US")} credits` : "packs"}</span>
            </div>
          </div>
          {packQuote ? <QuoteLine quote={packQuote} now={now} /> : null}
          <div className="row">
            {!packQuote || packQuote.expiry <= now ? (
              <button className="secondary" type="button" disabled={!ready || Boolean(packsTx.busy)} onClick={() => void quotePacks()}>Quote in ORRY</button>
            ) : (
              <button className="primary" type="button" disabled={!ready || Boolean(packsTx.busy) || short(packQuote)} onClick={() => void payPacks()}>
                {short(packQuote) ? "ORRY balance too low" : `Pay ${orry(packQuote.orryAmount)} ORRY`}
              </button>
            )}
          </div>
          <NoticeLine notice={packsTx.notice} />
        </div>

        {payg ? (
          <div>
            <h3>Single checks</h3>
            <div className="rc-amount">
              <label htmlFor="rc-checks">Checks</label>
              <div className="rc-amount-box">
                <input id="rc-checks" inputMode="numeric" value={String(checks)} onChange={(e) => setChecks(Math.max(1, Math.min(MAX_CHECKS, Number(e.target.value.replace(/\D/g, "")) || 1)))} />
                <span className="rc-unit">{checkCredits ? `${checkCredits.toLocaleString("en-US")} credits` : "checks"}</span>
              </div>
            </div>
            {checksQuote ? <QuoteLine quote={checksQuote} now={now} /> : null}
            <div className="row">
              {!checksQuote || checksQuote.expiry <= now ? (
                <button className="secondary" type="button" disabled={!ready || Boolean(checksTx.busy)} onClick={() => void quoteChecks()}>Quote in ORRY</button>
              ) : (
                <button className="primary" type="button" disabled={!ready || Boolean(checksTx.busy) || short(checksQuote)} onClick={() => void payChecks()}>
                  {short(checksQuote) ? "ORRY balance too low" : `Pay ${orry(checksQuote.orryAmount)} ORRY`}
                </button>
              )}
            </div>
            <NoticeLine notice={checksTx.notice} />
          </div>
        ) : null}

        <div>
          <h3>Agent verification</h3>
          <div className="rc-amount">
            <label htmlFor="rc-verify-agent">Agent ID</label>
            <div className="rc-amount-box">
              <input id="rc-verify-agent" inputMode="numeric" placeholder="1" value={agentIn} onChange={(e) => setAgentIn(e.target.value.replace(/\D/g, ""))} />
              <span className="rc-unit">ERC-8004</span>
            </div>
          </div>
          {verifyQuote ? <QuoteLine quote={verifyQuote.quote} now={now} /> : null}
          <div className="row">
            {!verifyQuote || verifyQuote.quote.expiry <= now ? (
              <button className="secondary" type="button" disabled={!ready || Boolean(verifyTx.busy) || agentId === undefined || !ADDRESSES.registry} onClick={() => void quoteVerify()}>Quote in ORRY</button>
            ) : (
              <button className="primary" type="button" disabled={!ready || Boolean(verifyTx.busy) || short(verifyQuote.quote)} onClick={() => void payVerify()}>
                {short(verifyQuote.quote) ? "ORRY balance too low" : `Verify · ${orry(verifyQuote.quote.orryAmount)} ORRY`}
              </button>
            )}
          </div>
          <NoticeLine notice={verifyTx.notice} />
        </div>
      </div>
      {!ready ? <p className="rc-muted">Paying in ORRY needs a connected wallet.</p> : balance !== undefined ? <p className="rc-muted">Wallet balance · {orry(balance)} ORRY</p> : null}
    </section>
  );
}
