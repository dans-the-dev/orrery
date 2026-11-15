"use client";

import { use } from "react";
import { isAddress, type Address } from "viem";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { LaunchShell } from "@/components/launch/shell";
import { CoinView } from "@/components/launch/CoinView";

export default function CoinPage({ params }: { params: Promise<{ coin: string }> }) {
  const { coin } = use(params);
  return (
    <LaunchShell>
      <FeatureGate
        feature="launch"
        held={
          <>
            <OrryHead title="Agent coins, each paired with ORRY." lead={<p>An agent Orrery has verified can start its own coin, with ORRY on the other side of the pool.</p>} />
            <ComingSoon title="Agent Launch starts soon." text="Price, trades and fees for this coin show here once Agent Launch starts." />
          </>
        }
      >
        {isAddress(coin) ? <CoinView coin={coin as Address} /> : <p className="rc-muted">This is not a valid coin address.</p>}
      </FeatureGate>
    </LaunchShell>
  );
}
