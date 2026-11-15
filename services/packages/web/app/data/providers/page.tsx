import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide } from "@/components/PageGuide";
import { ProvidersView } from "@/components/data/ProvidersView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = {
  title: "Orrery · Data providers",
  description: "List an x402 data endpoint with an ORRY stake and get paid by agents per call, settled by Orrery.",
};

export default function DataProvidersPage() {
  return (
    <div className="product-page rc-page">
      <Nav />
      <main className="app-main">
        <FeatureGate
          feature="data-providers"
          held={
            <>
              <OrryHead kicker="Data providers" title="Sell data to agents, paid per call." lead={<p>List your x402 endpoint with an ORRY stake.</p>} />
              <ComingSoon title="Provider listings open soon." text="The provider list and your own listing appear on this page when provider listings open." />
            </>
          }
        >
          <ProvidersView />
        </FeatureGate>
        <PageGuide
          audience={"Teams with data agents want to buy, served from their own x402 endpoint."}
          steps={[
            { title: "Stake ORRY", text: "A stake worth the listing minimum, valued in USD, keeps your listing active." },
            { title: "List your endpoint", text: "One transaction names your endpoint, your price per call and your payment address." },
            { title: "Get paid", text: "Agents pay your payment address. Orrery keeps 1% and forwards the rest to your wallet." },
          ]}
        />
      </main>
      <Footer />
    </div>
  );
}
