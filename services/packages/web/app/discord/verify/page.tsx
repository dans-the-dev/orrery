"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useConnection, useSignMessage } from "wagmi";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide } from "@/components/PageGuide";
import { PageHead } from "@/components/PageHead";
import { WalletButton } from "@/components/WalletButton";
import { API_URL, DISCORD_URL } from "@/lib/config";

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
    setState({ tone: "", text: "Sign the message in your wallet." });
    try {
      const signature = await signMessageAsync({ message: message(user, nonce) });
      const r = await fetch(`${API_URL}/v1/discord/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce, address, signature }),
      });
      const j = (await r.json().catch(() => ({}))) as { roles?: string[]; test?: boolean; error?: string };
      if (r.ok && j.roles && j.test) setState({ tone: "ok", text: `Verified on the development network. On mainnet this wallet would get: ${j.roles.join(", ")}. Your server roles stay as they are.` });
      else if (r.ok && j.roles) setState({ tone: "ok", text: `Verified. Your roles in the Orrery server: ${j.roles.join(", ")}.` });
      else setState({ tone: "error", text: j.error ?? "Verification did not finish. Run /verify in Discord again." });
    } catch {
      setState({ tone: "error", text: "The signature was not given. Try again when you are ready." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageGuide
        audience="Members of the Orrery Discord server."
        steps={[
          { title: "Run /verify in Discord", text: "The bot answers with a link that only you can see. It works once, for 15 minutes." },
          { title: "Connect and sign", text: "Connect the wallet you use with Orrery and sign one message. Signing costs nothing and moves no funds." },
          { title: "Get your roles", text: "Verified for everyone, ORRY Holder for ORRY held or staked, Operator for an agent you own, Merchant for credits bought." },
        ]}
      />
      <section className="panel lookup-form">
        <h2>Link your wallet to Discord</h2>
        {!valid ? (
          <p>This page opens from the link the Orrery bot sends after <code>/verify</code>. <a href={DISCORD_URL} target="_blank" rel="noreferrer">Join the server</a></p>
        ) : !API_URL ? (
          <p>Verification opens soon.</p>
        ) : !isConnected ? (
          <div className="row"><p>Connect the wallet you want to link.</p><WalletButton /></div>
        ) : (
          <div className="row">
            <p>Wallet {address}</p>
            <button className="primary" type="button" disabled={busy} onClick={run}>Sign and verify</button>
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
        <PageHead kicker="Discord" title="Verify your wallet." lead={<p>Link a wallet to your Discord account and get the roles that match what you do on Orrery.</p>} art="agent-tag" />
        <Suspense fallback={null}>
          <Verify />
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
