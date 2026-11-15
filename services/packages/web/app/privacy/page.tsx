import Link from "next/link";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageHead } from "@/components/PageHead";
import { DISCORD_URL, X_HANDLE, X_URL } from "@/lib/config";

export const metadata = {
  title: "Orrery · Privacy Policy",
  description: "What Orrery keeps when you use orrery.tech, the Orrery API and the Discord bot, and why.",
};

const UPDATED = "9 November 2026";

type Section = { id: string; title: string; body: ReactNode };

const SECTIONS: Section[] = [
  {
    id: "overview",
    title: "Overview",
    body: (
      <>
        <p>
          This policy covers orrery.tech, the Orrery API and the Orrery Discord bot. Orrery works with wallet addresses. The records the service keeps are listed below, together with what each one is for.
        </p>
        <p>The service asks for no name, email address, phone number or password, and the website runs without advertising or analytics trackers.</p>
      </>
    ),
  },
  {
    id: "chain",
    title: "Public chain data",
    body: (
      <>
        <p>
          The service indexes events from the Orrery contracts and the ORRY pools on Robinhood Chain: addresses, amounts, transaction hashes and times. From these events it keeps totals per address, such as stakes, Earn shares and amounts claimed and earned.
        </p>
        <p>These totals power your account views and the leaderboard. Every one of them comes from records that are already public on Robinhood Chain.</p>
      </>
    ),
  },
  {
    id: "credits",
    title: "Check credits and API keys",
    body: (
      <>
        <p>When an address signs in for an API key, buys check credits or buys the platform plan, the service keeps:</p>
        <ul>
          <li>the wallet address and its credit balance;</li>
          <li>the date its platform plan runs until, when it has one;</li>
          <li>the payment record: amount, status and transaction hash;</li>
          <li>for payments in ORRY, the signed price quote: the buyer address, the number of packs or the agent id, and the ORRY amount;</li>
          <li>the number of checks the address makes each month and how many of them were included, to apply the monthly included checks and the price tier.</li>
        </ul>
        <p>The service also keeps a daily total of checks across all addresses, with no address attached. Unused price quotes are deleted one day after they expire.</p>
        <p>
          API keys are stored as a SHA-256 hash linked to your address. The full key is returned to you once, when it is issued. Signing in for a key, or replacing one, uses a one-time message that is valid for five minutes.
        </p>
        <p>A check reads the paying address you ask about and leaves no record of it. Your credit balance and your monthly check count are the records that change.</p>
      </>
    ),
  },
  {
    id: "agents",
    title: "Agent verification",
    body: (
      <>
        <p>
          For an agent registered on ERC-8004, the service reads its public registration file, the HTTPS endpoints it advertises and its domain. It keeps the result: whether the endpoints answered, whether the registration is valid, whether the domain is verified, a hash of the registration and the time of the probe.
        </p>
        <p>The probe results are also recorded on Robinhood Chain, where anyone can read them.</p>
      </>
    ),
  },
  {
    id: "discord",
    title: "Discord",
    body: (
      <>
        <p>
          When you run <code>/verify</code> in the Orrery Discord and sign a message with your wallet, the service keeps your Discord user id, the linked wallet address, the roles it gave you and when the link was made and last checked. The one-time verification link expires after 15 minutes.
        </p>
        <p>
          The bot checks linked wallets on a schedule and updates roles to match each wallet&apos;s ORRY balance and stake, the agents it owns and its credit purchases. Linking a different wallet replaces the earlier link.
        </p>
        <p>The bot also keeps the Discord user ids of members it has welcomed, so that each member is welcomed once.</p>
      </>
    ),
  },
  {
    id: "website",
    title: "The website",
    body: (
      <>
        <p>The website stores your wallet connection in cookies, so the connection stays in place when you reload a page. These cookies are used for that alone.</p>
        <p>
          The website is served by a hosting provider, and your browser reads Robinhood Chain through a public RPC endpoint. Both receive standard request data such as your IP address, under their own privacy policies. Your wallet app handles your keys and signatures under its own policy.
        </p>
      </>
    ),
  },
  {
    id: "requests",
    title: "Rate limits and logs",
    body: (
      <p>
        The Orrery API uses your IP address in memory to apply request rate limits and does not write it to its database. The servers keep operational logs, such as indexer progress and the actions of the Discord bot.
      </p>
    ),
  },
  {
    id: "use",
    title: "How the data is used",
    body: (
      <p>
        The records above are used to run the service: to issue keys, grant credits and plans, apply the monthly included checks and price tiers, answer checks, show balances and earnings, keep the leaderboard, give Discord roles and keep the API available. The service shares data with the providers that run it, such as hosting, Robinhood Chain access and Discord for roles, and where the law requires it.
      </p>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <p>
        API keys are stored as hashes. Signing in for a key, replacing a key and Discord verification use one-time messages signed by your wallet. Your private keys and seed phrase stay in your wallet, and the service has no use for them.
      </p>
    ),
  },
  {
    id: "choices",
    title: "Your choices",
    body: (
      <>
        <p>You choose which wallet you connect and which messages and transactions you sign. You can disconnect your wallet from the website at any time.</p>
        <p>Records on Robinhood Chain are public and stay on the chain. For questions about the records the service holds for your address or Discord account, including your Discord link, contact the team through the channels below.</p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: <p>This policy is updated when the service changes what it keeps. Each update is posted on this page with a new date at the top.</p>,
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Reach the team on X at{" "}
        <a href={X_URL} target="_blank" rel="noreferrer">
          {X_HANDLE}
        </a>{" "}
        or in the{" "}
        <a href={DISCORD_URL} target="_blank" rel="noreferrer">
          Orrery Discord
        </a>
        . The terms for using the service are in the <Link href="/terms">Terms of Use</Link>.
      </p>
    ),
  },
];

export default function Privacy() {
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="docs-main legal-main">
        <PageHead
          kicker="Legal"
          title="Privacy Policy"
          lead={<p>What Orrery keeps when you use orrery.tech, the Orrery API and the Discord bot, and what each record is for.</p>}
          art="signer-lookup"
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
              <Link href="/terms">Terms of Use</Link>
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
