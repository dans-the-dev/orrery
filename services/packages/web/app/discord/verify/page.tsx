"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useConnection, useSignMessage } from "wagmi";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide } from "@/components/PageGuide";
import { PageHead } from "@/components/PageHead";
import { WalletButton } from "@/components/WalletButton";
import { DISCORD_URL } from "@/components/social";
import { API_URL } from "@/lib/config";

function message(user: string, nonce: string) {
  return `Orrery Discord verification\nDiscord user: ${user}\nNonce: ${nonce}`;
}

function Verify() {
  const q = useSearchParams();
  const nonce = q.get("n") ?? "";
  const user = q.get("u") ?? "";
  const { address, isConnected } = useConnection();
  const { signMessageAsync } = useSignMessage();
  const [state, setState] = useState<{ tone: "ok" | "error" | ""; text: string }>({ tone: "", text: "" });
  const [busy, setBusy] = useState(false);
  const valid = /^[0-9a-f]{32}$/.test(nonce) && /^\d{15,25}$/.test(user);

  async function run() {
    if (!address || !API_URL) return;
    setBusy(true);
    setState({ tone: "", text: "Approve the signature request in your wallet." });
    try {
      const signature = await signMessageAsync({ message: message(user, nonce) });
      const r = await fetch(`${API_URL}/v1/discord/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce, address, signature }),
      });
      const j = (await r.json().catch(() => ({}))) as { roles?: string[]; test?: boolean; error?: string };
      if (r.ok && j.roles && j.test) setState({ tone: "ok", text: `Wallet confirmed on the development network. On mainnet it would receive: ${j.roles.join(", ")}. Your current server roles are unchanged.` });
      else if (r.ok && j.roles) setState({ tone: "ok", text: `Wallet confirmed. Roles now set in the Orrery server: ${j.roles.join(", ")}.` });
      else setState({ tone: "error", text: j.error ?? "Verification incomplete. Send /verify in Discord for a new link." });
    } catch {
      setState({ tone: "error", text: "No signature received. Start again whenever you are ready." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageGuide
        audience="People in the Orrery Discord server."
        steps={[
          { title: "Send /verify in Discord", text: "The bot replies with a private link meant for you alone. It opens once, within 15 minutes." },
          { title: "Connect, then sign", text: "Connect the wallet you use on Orrery and sign a single message. The signature is free and moves no funds." },
          { title: "Receive your roles", text: "Everyone gets Verified. ORRY Holder follows ORRY held or staked, Operator follows an agent you own, and Merchant follows credits you bought." },
        ]}
      />
      <section className="panel lookup-form">
        <h2>Tie a wallet to your Discord account</h2>
        {!valid ? (
          <p>Reach this page through the link the Orrery bot sends when you use <code>/verify</code>.{DISCORD_URL ? <> <a href={DISCORD_URL} target="_blank" rel="noreferrer">Join the Orrery server</a></> : null}</p>
        ) : !API_URL ? (
          <p>Wallet verification starts soon.</p>
        ) : !isConnected ? (
          <div className="row"><p>Connect the wallet you want tied to Discord.</p><WalletButton /></div>
        ) : (
          <div className="row">
            <p>Connected as {address}</p>
            <button className="primary" type="button" disabled={busy} onClick={run}>Sign to confirm</button>
          </div>
        )}
        {state.text ? <p className={state.tone === "error" ? "notice error" : "notice"} role="status">{state.text}</p> : null}
      </section>
    </>
  );
}

export default function DiscordVerifyPage() {
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="signer-main">
        <PageHead kicker="Discord" title="Confirm your wallet for Discord." lead={<p>Tie a wallet to your Discord account, and your server roles follow what that wallet does on Orrery.</p>} art="agent-tag" />
        <Suspense fallback={null}>
          <Verify />
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
