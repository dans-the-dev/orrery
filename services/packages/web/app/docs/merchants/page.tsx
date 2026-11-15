import { DocsShell } from "@/components/orry/docsShell";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Merchants guide", description: "How merchant payments work: payment addresses, x402 settlement in USDG and ORRY, the fee, forwarding and the directory." };

export default function MerchantsDocs() {
  return (
    <DocsShell kicker="Guide" title="Merchants" lead={<p>Sell API calls, data or tools to agents and get paid over x402 in USDG or ORRY.</p>}>
      <FeatureGate feature="facilitator" held={<ComingSoon title="The merchants guide opens with merchant payments." text="This guide appears here when merchant payments open." />}>
        <>
          <h2>Your payment address</h2>
          <p>
            Each merchant wallet has one payment address, made by Orrery&apos;s splitter factory. The address is fixed by your wallet address, so it is
            known before it exists, and the Merchants page shows it as soon as you connect. One transaction sets it up. Use it as the <code>payTo</code>{" "}
            of every x402 price you publish; the facilitator settles only to payment addresses made by the factory.
          </p>

          <h2>How a payment settles</h2>
          <p>
            In USDG the payer signs an EIP-3009 authorization for the exact amount to your payment address, and the facilitator sends it on chain. ORRY
            has no EIP-3009, so ORRY payments go through Permit2: the payer approves Permit2 once, then signs one message per payment that names the
            amount and your payment address. Orrery&apos;s x402 proxy moves the ORRY only to the address named in that message.
          </p>
          <p>
            Your server calls <code>POST /v1/x402/verify</code> before it serves the request and <code>POST /v1/x402/settle</code> to collect, as in the
            x402 facilitator API. <code>GET /v1/x402/supported</code> lists the assets and their transfer methods.
          </p>

          <h2>The fee and forwarding</h2>
          <p>
            Payments wait at your payment address until they are forwarded to your wallet. Orrery&apos;s keeper forwards on its own, and anyone can call{" "}
            <code>forward(token)</code> at any time, you included. On each forward Orrery keeps 0.2% of the amount. The fee in USDG goes to the
            treasury; the fee in ORRY is burned and shows on the burn page. Other tokens forward whole.
          </p>
          <p>
            ORRY staked by your wallet lowers the fee, using the same stake tiers as the markets. The Merchants page shows your stake and the fee it gives
            you now.
          </p>

          <h2>Profile and directory</h2>
          <p>
            Your merchant record can carry a name, a link and a short description. Saving it signs a message with your wallet and sends no transaction.
            Merchants whose stake reaches the badge level appear in the directory on the Merchants page, largest stake first.
          </p>

          <h2>API</h2>
          <table>
            <tbody>
              <tr><td><code>GET /v1/merchants/:address</code></td><td>Payment address, setup state, fee discount, stake and 30 day volume of one merchant.</td></tr>
              <tr><td><code>GET /v1/merchants</code></td><td>The directory.</td></tr>
              <tr><td><code>GET /v1/x402/supported</code></td><td>Assets, networks and transfer methods the facilitator accepts.</td></tr>
              <tr><td><code>POST /v1/x402/verify</code></td><td>Checks a payment before you serve the request.</td></tr>
              <tr><td><code>POST /v1/x402/settle</code></td><td>Sends the payment on chain and returns the transaction.</td></tr>
            </tbody>
          </table>
        </>
      </FeatureGate>
    </DocsShell>
  );
}
