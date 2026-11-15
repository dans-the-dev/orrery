"use client";

import { use } from "react";
import { isAddress } from "viem";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageHead } from "@/components/PageHead";
import { Record } from "@/components/Record";
import { deployed } from "@/lib/config";
import { useSignerView } from "@/lib/lens";

export default function SignerPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const { data, isLoading, error } = useSignerView(address);
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="signer-main">
        <PageHead kicker="Signer record" title={address} titleClass="mono" art="signer-lookup" />
        {!isAddress(address) ? <div className="panel"><h2>That is not an address</h2><p>Check the address and try again.</p></div>
          : !deployed ? <div className="panel"><h2>Lookups open soon</h2><p>Signer records appear here once the contracts are live on this network.</p></div>
          : isLoading ? <div className="panel"><h2>Reading the chain</h2></div>
          : error || !data ? <div className="panel"><h2>The read did not finish</h2><p>Refresh in a moment.</p></div>
          : <Record view={data} />}
      </main>
      <Footer />
    </div>
  );
}
