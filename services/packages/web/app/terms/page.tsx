import Link from "next/link";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageHead } from "@/components/PageHead";
import { DISCORD_URL, X_HANDLE, X_URL } from "@/lib/config";

export const metadata = {
  title: "Orrery · Terms of Use",
  description: "The terms for using orrery.tech, the Orrery API, the SDK, the Discord bot and the Orrery contracts on Robinhood Chain.",
};

const UPDATED = "9 November 2026";

type Section = { id: string; title: string; body: ReactNode };

const SECTIONS: Section[] = [
  {
    id: "using",
    title: "Using Orrery",
    body: (
      <>
        <p>
          These terms apply to orrery.tech, the Orrery API, the Orrery SDK, the Orrery Discord bot and the Orrery contracts on Robinhood Chain (together, the service). By using the service you agree to these terms.
        </p>
        <p>If you use the service for a company or another organisation, you agree to these terms on its behalf and confirm that you are able to do so.</p>
        <p>You are responsible for following the laws that apply to you where you use the service.</p>
      </>
    ),
  },
  {
    id: "service",
    title: "What the service does",
    body: (
      <>
        <p>
          Operators set public spending limits for their agents on their own Safe account through the Orrery policy module: a limit per payment, a limit per day, a float, the calls an agent may make and a delay before any limit rises. Agents are ERC-8004 identities and pay in USDG over x402.
        </p>
        <p>Merchants check a paying address and receive an answer signed under EIP-712. Checks use check credits, which can be paid for in USDG or ORRY. Agent verification is paid the same way.</p>
        <p>ORRY is the protocol token. It is used in Earn pools, staking, claims and burns.</p>
        <p>Features open over time. A feature that has not opened yet is marked Coming soon on the site.</p>
      </>
    ),
  },
  {
    id: "wallet",
    title: "Your wallet and keys",
    body: (
      <>
        <p>You use Orrery with your own wallet. Your private keys and seed phrase stay in your wallet, and you sign each message and transaction yourself.</p>
        <p>
          You choose the limits for each agent and the signer that may use them. Payments an agent makes are signed by the agent signer you authorised, within the limits recorded in the module on Robinhood Chain.
        </p>
        <p>Keep your keys, your seed phrase and your agent signer keys private.</p>
      </>
    ),
  },
  {
    id: "api",
    title: "API keys and check credits",
    body: (
      <>
        <p>An API key is issued to a wallet address when it signs in with a signed message or buys check credits. Each address has one active key at a time.</p>
        <p>You can replace your key whenever you like by signing a message with the same wallet. The new key takes the place of the old one.</p>
        <p>Keep your API key private. Checks made with your key use the monthly included checks and the credits of your address.</p>
      </>
    ),
  },
  {
    id: "fees",
    title: "Fees",
    body: (
      <>
        <p>
          Check pricing, credits and the platform plan are shown in the dashboard under <Link href="/dashboard/credits">Credits</Link> and the agent verification fee under <Link href="/dashboard/agents">Agents</Link>, before you pay. Earn pool fees and how they are shared are published on the site and set in the contracts.
        </p>
        <p>The fees that apply are the ones in effect when your transaction is made. You pay the gas for the transactions you send from your wallet.</p>
      </>
    ),
  },
  {
    id: "use",
    title: "Acceptable use",
    body: (
      <>
        <p>When you use the service, you agree to:</p>
        <ul>
          <li>use it only for lawful purposes;</li>
          <li>register only agents, endpoints and domains that you control, and describe them truthfully;</li>
          <li>stay within the published request rates of the API;</li>
          <li>leave other people&apos;s keys, accounts and systems alone;</li>
          <li>keep the service running for everyone, with no attempts to disrupt it or test it for weaknesses without the team&apos;s written permission;</li>
          <li>use the Orrery name and logo only in ways that make clear who runs your product.</li>
        </ul>
      </>
    ),
  },
  {
    id: "onchain",
    title: "Records on Robinhood Chain",
    body: (
      <p>
        Sessions, limits, payments, agent verifications, Earn deposits, stakes, claims and burns are recorded on Robinhood Chain. These records are public and anyone can read them.
      </p>
    ),
  },
  {
    id: "others",
    title: "Services run by others",
    body: <p>Orrery works together with services run by others, such as your wallet, Robinhood Chain, Discord and X. Your use of those services follows their own terms.</p>,
  },
  {
    id: "brand",
    title: "Name and content",
    body: <p>The Orrery name, logo, site design, artwork and text belong to the Orrery team.</p>,
  },
  {
    id: "changes",
    title: "Changes to these terms",
    body: (
      <p>
        These terms may be updated as the service grows. Each update is posted on this page with a new date at the top. Using the service after an update means you accept the updated terms.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about these terms go to the team on X at{" "}
        <a href={X_URL} target="_blank" rel="noreferrer">
          {X_HANDLE}
        </a>{" "}
        or in the{" "}
        <a href={DISCORD_URL} target="_blank" rel="noreferrer">
          Orrery Discord
        </a>
        . The way your data is handled is described in the <Link href="/privacy">Privacy Policy</Link>.
      </p>
    ),
  },
];

export default function Terms() {
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="docs-main legal-main">
        <PageHead
          kicker="Legal"
          title="Terms of Use"
          lead={<p>The terms for using orrery.tech, the Orrery API, the SDK, the Discord bot and the Orrery contracts on Robinhood Chain.</p>}
          art="docs-manual"
        />
        <div className="legal">
          <aside className="legal-toc" aria-label="Contents">
            <p className="legal-updated">Updated {UPDATED}</p>
            <ol>
              {SECTIONS.map((s, i) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>
                    <span className="legal-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                    {s.title}
                  </a>
                </li>
              ))}
            </ol>
            <p className="legal-other">
              <Link href="/privacy">Privacy Policy</Link>
            </p>
          </aside>
          <article className="docs-body legal-body">
            {SECTIONS.map((s, i) => (
              <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
                <h2 id={`${s.id}-h`}>
                  <span className="legal-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                  {s.title}
                </h2>
                {s.body}
              </section>
            ))}
          </article>
        </div>
      </main>
      <Footer />
    </div>
  );
}
