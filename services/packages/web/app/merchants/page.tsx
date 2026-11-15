import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide } from "@/components/PageGuide";
import { MerchantsView } from "@/components/merchants/MerchantsView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Merchants", description: "Get paid by agents in USDG or ORRY through Orrery's x402 facilitator, to a payment address that forwards to your wallet." };

export default function MerchantsPage() {
  return (
    <div className="product-page rc-page">
      <Nav />
      <main className="app-main">
          <FeatureGate
            feature="facilitator"
            held={
              <>
                <OrryHead kicker="Merchants" title="Get paid by agents in USDG or ORRY." lead={<p>A payment address for your API, settled by Orrery&apos;s x402 facilitator.</p>} />
                <ComingSoon title="Merchant payments open soon." text="Your payment address, its balances and the directory appear on this page when merchant payments open." />
              </>
            }
          >
            <MerchantsView />
          </FeatureGate>
          <PageGuide
            audience={"Teams that sell API calls, data or tools to AI agents."}
            steps={[
              { title: "Set up your payment address", text: "One transaction from your wallet. The address is the payTo of every price you publish." },
              { title: "Publish x402 prices", text: "Point your x402 middleware at Orrery's facilitator. Agents pay in USDG, or in ORRY over Permit2." },
              { title: "Receive", text: "Payments forward to your wallet, minus Orrery's fee. A stake in ORRY lowers the fee and lists you in the directory." },
            ]}
          />
      </main>
      <Footer />
    </div>
  );
}
