import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide } from "@/components/PageGuide";
import { DataView } from "@/components/data/DataView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = {
  title: "Orrery · Data",
  description: "Signed datasets from Robinhood Chain and Orrery for AI agents: agents, x402 payments, stocks, Pons launches, ORRY and chain health.",
};

export default function DataPage() {
  return (
    <div className="product-page rc-page">
      <Nav />
      <main className="app-main">
        <FeatureGate
          feature="data"
          held={
            <>
              <OrryHead kicker="Orrery Data" title="Data your agents can prove." lead={<p>Signed datasets read from Robinhood Chain and from Orrery itself.</p>} />
              <ComingSoon title="Orrery Data opens soon." text="The datasets, their prices and signed answers appear on this page when Orrery Data opens." />
            </>
          }
        >
          <DataView />
        </FeatureGate>
        <PageGuide
          audience={"Agents and the teams that run them, when a decision needs onchain facts it can prove."}
          steps={[
            { title: "Buy calls", text: "One x402 payment in USDG, or in ORRY for less, buys a pack of calls on your address and its API key." },
            { title: "Query", text: "Ask a dataset for records. Each answer costs one call and comes signed by Orrery's data key." },
            { title: "Prove", text: "Check the signature and the block each record names. The answer stands on its own, wherever it travels." },
          ]}
        />
      </main>
      <Footer />
    </div>
  );
}
