"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { erc20Abi, getAddress, isAddress, isHash, parseEventLogs } from "viem";
import { usePublicClient } from "wagmi";
import { ADDRESSES } from "@/lib/config";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide, ResultPreview } from "@/components/PageGuide";
import { PageHead } from "@/components/PageHead";
import Link from "next/link";

export default function SignerSearch() {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const router = useRouter();
  const pub = usePublicClient();
  const input = v.trim();
  const valid = isAddress(input) || isHash(input);

  /**
   * An address opens its record. A transaction hash is read first: the payer is the sender of the USDG transfer inside
   * it. Over x402 a facilitator sends the transaction, so the transaction's own sender is the wrong address to check.
   */
  async function lookUp() {
    setNotice("");
    if (isAddress(input)) return router.push(`/signer/${input}`);
    if (!isHash(input) || !pub) return;
    setBusy(true);
    try {
      const r = await pub.getTransactionReceipt({ hash: input });
      const transfers = parseEventLogs({ abi: erc20Abi, logs: r.logs, eventName: "Transfer" });
      const paid = transfers.find((t) => ADDRESSES.usdg && t.address.toLowerCase() === ADDRESSES.usdg.toLowerCase()) ?? transfers[0];
      router.push(`/signer/${getAddress(paid ? paid.args.from : r.from)}`);
    } catch {
      setNotice("That transaction was not found on this network. Check the hash, or paste the paying address.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="signer-main">
        <PageHead
          kicker="Signer lookup"
          title="Who paid you, and within what limits."
          lead={<p>Enter the address that sent the payment. The record is read from the chain.</p>}
          art="signer-lookup"
        />
        <PageGuide
          audience="Merchants, and anyone who received USDG from an AI agent."
          steps={[
            { title: "Copy the payment", text: "Paste the paying address, or the transaction hash of the payment. The payer is read from the USDG transfer inside it." },
            { title: "Look it up here", text: "Open to anyone, no key needed. The record is read straight from the chain, nothing is cached by us." },
            { title: "Check it in code", text: <>For a signed answer inside your own service, buy check credits and call <code>checkPayer</code>. <Link href="/dashboard/credits">Credits</Link></> },
          ]}
        />
        <div className="with-preview">
          <form className="panel lookup-form" onSubmit={(e) => { e.preventDefault(); void lookUp(); }}>
            <h2>Look up a payer</h2>
            <div className="row">
              <label className="field">Paying address or transaction hash<input value={v} onChange={(e) => setV(e.target.value)} placeholder="0x…" spellCheck={false} /></label>
              <button className="primary" type="submit" disabled={!valid || busy}>{busy ? "Reading" : "Look up"}</button>
            </div>
            {notice ? <div className="notice error" role="status">{notice}</div> : null}
          </form>
          <ResultPreview
            title="What the record shows"
            rows={[
              ["Session", "Active, paused or revoked"],
              ["Agent", "ERC-8004 ID and its owner"],
              ["Per payment", "The largest single payment allowed"],
              ["Per day", "Daily cap and what is spent today"],
              ["Float ceiling", "Most the signer can hold at once"],
              ["Endpoints", "Latest live probe of the agent"],
            ]}
            foot="An address with no Orrery session shows that plainly, so an unknown payer is easy to spot."
          />
        </div>
      </main>
      <Footer />
    </div>
  );
}
