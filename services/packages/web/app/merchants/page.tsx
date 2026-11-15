import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide } from "@/components/PageGuide";
import { MerchantsView } from "@/components/merchants/MerchantsView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Merchants", description: "Take agent payments in USDG or ORRY through Orrery's x402 facilitator, at a payment address that passes funds on to your wallet." };

export default function MerchantsPage() {
  return (
    <div className="product-page rc-page">
      <Nav />
      <main className="app-main">
          <FeatureGate
            feature="facilitator"
            held={
              <>
                <OrryHead kicker="Merchants" title="Take agent payments in USDG or ORRY." lead={<p>Your API gets its own payment address, and Orrery&apos;s x402 facilitator settles every call to it.</p>} />
                <ComingSoon title="Merchant payments start soon." text="Your payment address, its balances and the merchant directory show here once merchant payments start." />
              </>
            }
          >
            <MerchantsView />
          </FeatureGate>
          <PageGuide
            audience={"Teams selling API calls, data or tools to AI agents."}
            steps={[
              { title: "Create your payment address", text: "A single transaction from your wallet. That address becomes the payTo of each price you publish." },
              { title: "Post your x402 prices", text: "Aim your x402 middleware at Orrery's facilitator. Agents then pay in USDG, or in ORRY through Permit2." },
              { title: "Receive", text: "Each payment passes on to your wallet, less Orrery's fee. Staking ORRY brings that fee down and adds you to the directory." },
            ]}
          />
      </main>
      <Footer />
    </div>
  );
}
