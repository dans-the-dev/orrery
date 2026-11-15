"use client";

import { use, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isAddress } from "viem";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide } from "@/components/PageGuide";
import { PageHead } from "@/components/PageHead";
import { Record } from "@/components/Record";
import { deployed } from "@/lib/config";
import { useAgentView } from "@/lib/lens";

export default function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = use(params);
  const account = useSearchParams().get("account") ?? "";
  const valid = /^\d+$/.test(agentId) && isAddress(account);
  const { data, isLoading, error } = useAgentView(valid ? BigInt(agentId) : undefined, account);
  const router = useRouter();
  const [accIn, setAccIn] = useState(account);
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="signer-main">
        <PageHead
          kicker="Agent record"
          title={`Agent #${agentId}`}
          lead={account ? <p className="mono">on account {account}</p> : null}
          art="agent-tag"
        />
        {!valid ? (
          <>
            <PageGuide
              audience="Anyone checking what an AI agent may spend, and from which account."
              steps={[
                { title: "Find the account", text: "The Safe the agent pays from. Its operator shares it, and it shows in every signed check." },
                { title: "Open the record", text: "Enter the account below. The record is read from the chain." },
                { title: "Read the limits", text: "Caps, spend today, allowed calls, verification and the latest endpoint probe." },
              ]}
            />
            <form className="panel lookup-form" onSubmit={(e) => { e.preventDefault(); if (/^\d+$/.test(agentId) && isAddress(accIn.trim())) router.push(`/agent/${agentId}?account=${accIn.trim()}`); }}>
              <h2>Which account does agent #{agentId} use?</h2>
              <div className="row">
                <label className="field">Account<input value={accIn} onChange={(e) => setAccIn(e.target.value)} placeholder="0x… the agent's Safe" spellCheck={false} /></label>
                <button className="primary" type="submit" disabled={!isAddress(accIn.trim())}>Open record</button>
              </div>
            </form>
          </>
        )
          : !deployed ? <div className="panel"><h2>Lookups open soon</h2><p>Agent records appear here once the contracts are live on this network.</p></div>
          : isLoading ? <div className="panel"><h2>Reading the chain</h2></div>
          : error || !data ? <div className="panel"><h2>The read did not finish</h2><p>Refresh in a moment.</p></div>
          : <Record view={data} />}
      </main>
      <Footer />
    </div>
  );
}
