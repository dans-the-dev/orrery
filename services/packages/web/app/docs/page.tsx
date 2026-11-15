import Link from "next/link";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageHead } from "@/components/PageHead";
import { OrryDocsLinks } from "@/components/orry/slots";

export const metadata = { title: "Orrery · Docs" };

export default function Docs() {
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="docs-main">
        <PageHead
          kicker="Docs"
          title="Build with Orrery."
          lead={<p>Orrery gives an agent&apos;s signer public, capped spending authority over its operator&apos;s smart account. Anyone who receives a payment can read the paying address on-chain, or buy a signed check that adds a fresh probe of the agent&apos;s endpoints.</p>}
          art="docs-manual"
        />
        <div className="docs-body">

        <h2>Install</h2>
        <pre>{`pnpm add @orrery-tech/sdk viem`}</pre>

        <h2>Operator: set up an agent</h2>
        <p>The <Link href="/dashboard/agents">Agents</Link> section of the dashboard does the whole setup from your wallet: it creates the account (a Safe with the Safe7579 adapter and the Orrery policy module), registers the agent&apos;s ERC-8004 identity, creates the signer, opens the session with the limits you pick, and saves the signer&apos;s key file for the agent.</p>
        <p>To script it instead, the agent creates a fresh signer and signs its consent, and the operator sends the session from its account. Signers are single use.</p>
        <pre>{`import { signSessionConsent, operatorCalls, type Policy } from "@orrery-tech/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(generatePrivateKey()); // stays with the agent
const policy: Policy = {
  caps: [{ token: USDG, perTx: 10_000_000n, perDay: 50_000_000n, floatMax: 20_000_000n }],
  targets: [],
  validUntil: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
  increaseDelay: 3600,
};
const consent = await signSessionConsent(signer, { chainId, module, account, agentId, policy });
const data = operatorCalls.openSession(agentId, signer.address, policy, consent);
// send \`data\` to the module from your account (Safe execTransaction)`}</pre>

        <h2>Agent: pay over x402</h2>
        <p>Load the key file from the dashboard as environment variables. The agent pays from its float, and before each payment the SDK tops the float up through the module, within the caps.</p>
        <pre>{`import { agentFromEnv } from "@orrery-tech/sdk";

const agent = agentFromEnv(); // reads ORRERY_SIGNER_KEY and the rest of the key file
const res = await agent.x402Fetch("https://api.example.com/data");`}</pre>

        <h2>Merchant: check the payer</h2>
        <p>Get an API key in the dashboard under <Link href="/dashboard/credits">Credits</Link> with one wallet signature. One call asks for the signed check and verifies it on-chain.</p>
        <pre>{`import { checkPayment } from "@orrery-tech/sdk";

const v = await checkPayment(payer, process.env.ORRERY_API_KEY);
if (v.ok) {
  // v.result.caps, v.result.status, v.result.endpointsLive, v.result.validUntil
}`}</pre>
        <p>The same check over plain HTTP, from any language:</p>
        <pre>{`curl -H "authorization: Bearer $ORRERY_API_KEY" \\
  https://api.orrery.tech/v1/check/by-signer/0xPAYING_ADDRESS`}</pre>

        <h2>Check result fields</h2>
        <table>
          <tbody>
            <tr><td>signer, account, agentId</td><td>Who the answer is about. The claim covers payments from this signer.</td></tr>
            <tr><td>status</td><td>0 none, 1 active, 2 paused, 3 revoked, 4 expired.</td></tr>
            <tr><td>caps</td><td>Per token: per payment, per day, float ceiling and spent today.</td></tr>
            <tr><td>targetsHash</td><td>Hash of the allowed calls; the JSON lists them.</td></tr>
            <tr><td>validFor</td><td>The earliest moment this signer&apos;s limits can rise through the module.</td></tr>
            <tr><td>accountKind, otherAccountModules</td><td>Whether the account is a recognised Safe and whether it shows other grants.</td></tr>
            <tr><td>verified, endpointsLive, registrationValid, domainVerified</td><td>Verification and the latest probe of the agent&apos;s registration and endpoints.</td></tr>
            <tr><td>issuedAt, validUntil</td><td>When the answer was signed and until when it applies.</td></tr>
          </tbody>
        </table>
        <p>Coverage: the caps measure outflow of the listed tokens and native ETH from the account by this signer.</p>
        <OrryDocsLinks />
        </div>
      </main>
      <Footer />
    </div>
  );
}
