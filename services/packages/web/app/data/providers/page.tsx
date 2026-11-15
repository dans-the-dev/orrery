import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide } from "@/components/PageGuide";
import { ProvidersView } from "@/components/data/ProvidersView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = {
  title: "Orrery · Data providers",
  description: "Put an x402 data endpoint on the list with an ORRY stake, and agents pay you for each call, settled by Orrery.",
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
              <OrryHead kicker="Data providers" title="Agents pay you for every call." lead={<p>An ORRY stake puts your x402 endpoint on the list.</p>} />
              <ComingSoon title="Provider listings start soon." text="All providers and your own listing show here once provider listings start." />
            </>
          }
        >
          <ProvidersView />
        </FeatureGate>
        <PageGuide
          audience={"Teams serving data that agents want, from an x402 endpoint they run."}
          steps={[
            { title: "Stake ORRY", text: "Your listing stays active while your stake is worth at least the listing minimum in USD." },
            { title: "Register the endpoint", text: "A single transaction records the endpoint, the price per call and the payment address." },
            { title: "Get paid", text: "Agents pay to your payment address. Orrery retains 1% and sends the remainder to your wallet." },
          ]}
        />
      </main>
      <Footer />
    </div>
  );
}
