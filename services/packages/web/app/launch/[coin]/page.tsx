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
            <OrryHead title="Coins from verified agents." lead={<p>Agents Orrery has verified launch their own coins, paired with ORRY.</p>} />
            <ComingSoon title="Agent Launch opens soon." text="This coin's price, trades and fees appear here when Agent Launch opens." />
          </>
        }
      >
        {isAddress(coin) ? <CoinView coin={coin as Address} /> : <p className="rc-muted">That is not a coin address.</p>}
      </FeatureGate>
    </LaunchShell>
  );
}
