/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { ContractAddress } from "@/components/ContractAddress";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PayerConsole } from "@/components/PayerConsole";
import { Faq } from "@/components/motion/Faq";
import { FlowStrip } from "@/components/motion/Flow";
import { HeroLoop } from "@/components/motion/HeroLoop";
import { Magnetic, Tilt } from "@/components/motion/Pointer";

const FACTS = [
  "ERC-8004 agent identity",
  "x402 payments in USDG",
  "Per payment, daily and float caps",
  "Limit increases wait at least one hour",
  "EIP-712 signed answers",
  "Built on Robinhood Chain",
];

const STEPS = [
  { art: "gate-set", title: "Set", text: "The operator sets caps and allowed calls on the agent's account." },
  { art: "gate-pay", title: "Pay", text: "The agent pays in USDG from its own signer, inside those caps." },
  { art: "gate-check", title: "Check", text: "The merchant looks up the address that paid." },
  { art: "gate-sign", title: "Sign", text: "Orrery returns the caps and live state in one signed answer." },
];

const JOBS = [
  { art: "job-cap", title: "Cap the spend.", text: "Per payment, per day and float ceilings shape what the agent can send." },
  { art: "job-wait", title: "Build in the wait.", text: "Raising a limit takes at least one hour, so every increase is public before it applies." },
  { art: "job-route", title: "Choose the route.", text: "Allowed calls define the contracts the agent can reach. Everything else stays closed." },
];


const AUDIENCES = [
  { art: "agent-tag", who: "Operators", title: "You run an AI agent.", text: "Give it a budget it cannot exceed: per payment, per day and float caps, the contracts it may call, and a public wait before any increase.", href: "/operator", cta: "Set the limit" },
  { art: "signer-lookup", who: "Merchants", title: "Agents pay you.", text: "Before you accept a payment, check the paying address and get a signed answer: who the agent is, its caps and what it spent today.", href: "/signer", cta: "Check a payer" },
  { art: "credits-pack", who: "ORRY holders", title: "You hold the token.", text: "Earn from swap fees in the ORRY pools, stake for a share of Orrery's revenue, and watch product use burn supply.", href: "/earn", cta: "See ORRY" },
];

const ORRY_USES = [
  { title: "Earn", text: "Deposit into the ORRY/ETH or ORRY/USDG pool. 85% of every swap fee streams to Earn shares over 7 days.", href: "/earn", cta: "Open Earn" },
  { title: "Stake", text: "Pool fees and ORRY bought with Orrery's USDG revenue stream to every active stake, in ETH and ORRY.", href: "/stake", cta: "Open Stake" },
  { title: "Pay and burn", text: "Credit packs and agent verifications can be paid in ORRY. Every ORRY spent there is burned in the same transaction.", href: "/burn", cta: "See the burns" },
];

const FAQ = [
  { q: "What is an agent payment?", a: "An AI agent paying for an API, data or a service by itself, in USDG, over x402: the payment travels with the HTTP request." },
  { q: "Can the agent spend more than its limits?", a: "No. The caps live in the policy module on the agent's own Safe, so every payment is checked on chain before it moves. Raising a cap waits at least one hour, in public." },
  { q: "What does a merchant receive from a check?", a: "An EIP-712 signed record of the payer: session status, agent identity, caps, spend today and the latest endpoint probe. The SDK verifies the signature." },
  { q: "Which network does Orrery run on?", a: "Robinhood Chain. Agents are ERC-8004 identities, accounts are Safe 1.4.1 with an ERC-7579 module, payments settle in USDG." },
  { q: "What is ORRY used for?", a: "Earning from the ORRY pools, staking for a share of Orrery's revenue, and paying for checks and verifications, which burns it." },
];

const CODE = `import { OrreryApi, verifyCheck } from "@orrery-tech/sdk";

const api = new OrreryApi("https://api.orrery.tech", apiKey);
const res = await api.checkPayer(payer);
const v = await verifyCheck(publicClient, attestor, res, { payer });

if (v.ok) {
  v.result.status;        // active, paused, revoked
  v.result.caps;          // per payment, per day, float
  v.result.endpointsLive; // latest probe of the agent
}`;

/** The SDK sample, one line per row so the lines can arrive in turn; comments in their own colour. */
function CodeLines({ code }: { code: string }) {
  const lines = code.split("\n");
  return (
    <pre className="lp-code" data-reveal="code">
      <code>
        {lines.map((l, i) => {
          const at = l.indexOf("//");
          return (
            <span key={i} className="cl" style={{ ["--i" as string]: i }}>
              {at >= 0 ? (
                <>
                  {l.slice(0, at)}
                  <span className="cc">{l.slice(at)}</span>
                </>
              ) : (
                l || "\u00a0"
              )}
              {i === lines.length - 1 ? <span className="caret" aria-hidden="true" /> : null}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

export default function Home() {
  return (
    <div className="lp">
      <div className="lp-hero-wrap">
        <Nav />
        <section className="lp-hero">
          <div className="lp-hero-copy">
            <p className="kicker">Spending limits for AI agents</p>
            <h1>
              <span className="rl"><span>Let agents pay.</span></span>
              <span className="rl"><span className="accent">Keep spend in range.</span></span>
            </h1>
            <p className="lp-lead load-rise" style={{ ["--d" as string]: "0.28s" }}>Set public limits for the agent that pays. Anyone receiving USDG can check the payer and get a signed answer.</p>
            <div className="lp-actions load-rise" style={{ ["--d" as string]: "0.38s" }}>
              <Magnetic><Link className="btn btn-brand" href="/dashboard/agents">Set the limit</Link></Magnetic>
              <Link className="btn btn-ghost" href="/signer">Check a payer</Link>
            </div>
            <ContractAddress />
          </div>
          <div className="lp-hero-stage">
            <Tilt className="hero-tilt" max={4}>
              <HeroLoop
                poster="/art/hero-limiter.webp"
                webm="/art/hero-limiter-loop.webm"
                mp4="/art/hero-limiter-loop.mp4"
                alt="A cobalt limiter dial with payment strands flowing in and one strand flowing out"
              />
            </Tilt>
            <PayerConsole />
          </div>
        </section>
      </div>

      <div className="lp-marquee" aria-label="Product facts">
        <div className="lp-marquee-track">
          {[...FACTS, ...FACTS].map((f, i) => (
            <span key={i}>{f}</span>
          ))}
        </div>
      </div>


      <section className="lp-section lp-paper lp-who" aria-labelledby="who-h">
        <div className="lp-head">
          <p className="kicker">Who it is for</p>
          <h2 id="who-h" data-reveal="lines"><span className="rl"><span>One payment, three people</span></span><span className="rl"><span>who need to trust it.</span></span></h2>
        </div>
        <div className="lp-who-grid" data-reveal="group">
          {AUDIENCES.map((a) => (
            <article key={a.who}>
              <img className="lp-who-art" src={`/art/${a.art}.webp`} alt="" aria-hidden="true" width={112} height={112} loading="lazy" />
              <p className="lp-who-tag">{a.who}</p>
              <h3>{a.title}</h3>
              <p>{a.text}</p>
              <Link className="lp-link" href={a.href}>{a.cta}</Link>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-dark" id="how">
        <div className="lp-head">
          <p className="kicker">How it works</p>
          <h2 data-reveal="lines"><span className="rl"><span>Four gates between an agent</span></span><span className="rl"><span>and a payment.</span></span></h2>
        </div>
        <div className="lp-steps-wrap" data-inview="">
        <ol className="lp-steps" data-reveal="">
          {STEPS.map((s, i) => (
            <li key={s.art}>
              <div className="lp-gate-art">
                <img src={`/art/${s.art}.webp`} alt="" width={720} height={720} loading="lazy" />
                {i < STEPS.length - 1 ? <span className="lp-gate-link" aria-hidden="true"><i /></span> : null}
              </div>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
        </div>
      </section>

      <section className="lp-section lp-paper">
        <div className="lp-head">
          <p className="kicker">Program the limit</p>
          <h2 data-reveal="lines"><span className="rl"><span>Every limit has a job.</span></span></h2>
        </div>
        <div className="lp-jobs" data-reveal="group">
          {JOBS.map((j) => (
            <article key={j.art} className="lp-job">
              <div className="lp-job-art"><img src={`/art/${j.art}.webp`} alt="" width={900} height={675} loading="lazy" /></div>
              <h3>{j.title}</h3>
              <p>{j.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-dark lp-split">
        <div>
          <p className="kicker">Receive a payment</p>
          <h2 data-reveal="lines"><span className="rl"><span>Plug the payer into</span></span><span className="rl"><span>the check.</span></span></h2>
          <p className="lp-copy">One call returns the current caps, spend today, the endpoint state and a signed result you can verify on your side.</p>
          <Link className="lp-link" href="/docs">Read the SDK guide</Link>
        </div>
        <CodeLines code={CODE} />
      </section>

      <section className="lp-section lp-ground lp-split lp-operator">
        <div>
          <p className="kicker">Run the agent</p>
          <h2 data-reveal="lines"><span className="rl"><span>See the limit while</span></span><span className="rl"><span>you tune it.</span></span></h2>
          <p className="lp-copy">Today&apos;s spend sits against the cap. Every policy field sits next to the live reading, and increases queue for the delay you set.</p>
          <Link className="lp-link" href="/dashboard/agents">Open the operator view</Link>
        </div>
        <div className="lp-operator-stage">
          <Tilt className="lp-operator-art"><div className="float"><img src="/art/operator-console.webp" alt="" width={900} height={675} loading="lazy" /></div></Tilt>
            <div className="lp-editor" aria-label="Policy editor preview" data-reveal="" style={{ ["--d" as string]: "0.15s" }}>
              <div className="lp-editor-head"><b>Agent policy</b><span>Preview</span></div>
              <div className="lp-editor-reading">
                <span>Spent today</span>
                <small>against the daily cap</small>
                <div className="console-track"><i style={{ width: "32%" }} /></div>
              </div>
              <dl className="lp-editor-fields">
                <div><dt>Per payment</dt><dd>Your cap</dd></div>
                <div><dt>Float ceiling</dt><dd>Your ceiling</dd></div>
                <div><dt>Allowed calls</dt><dd>Your targets</dd></div>
                <div><dt>Increase delay</dt><dd>1 hour or more</dd></div>
              </dl>
            </div>
        </div>
      </section>

      <section className="lp-section lp-paper lp-split lp-credits">
        <Tilt className="lp-credits-art"><div className="float"><img src="/art/credits-pack.webp" alt="" width={820} height={820} loading="lazy" /></div></Tilt>
        <div>
          <p className="kicker">Credits</p>
          <h2 data-reveal="lines"><span className="rl"><span>Checks priced by</span></span><span className="rl"><span>monthly volume.</span></span></h2>
          <p className="lp-copy">Sign in with your wallet for an API key. Each address has 1,000 checks a month included. Past them a check is 0.004 USDG, and 0.002 USDG past 100,000 checks a month, paid with credits in USDG over x402 or in ORRY. Operators pay once to verify an agent.</p>
          <div className="lp-actions">
            <Magnetic><Link className="btn btn-brand" href="/dashboard/credits">Get an API key</Link></Magnetic>
            <Link className="btn btn-ghost" href="/docs">How checks work</Link>
          </div>
        </div>
      </section>

      <section className="lp-section lp-dark lp-orry" aria-labelledby="orry-h">
        <div className="lp-head">
          <p className="kicker">ORRY</p>
          <h2 id="orry-h" data-reveal="lines"><span className="rl"><span>The token that runs on</span></span><span className="rl"><span>Orrery&apos;s revenue.</span></span></h2>
          <p className="lp-copy">Orrery earns in USDG from verifications and checks. Most of that revenue buys ORRY for stakers and for burning, and the ORRY pools pay their swap fees to Earn.</p>
          <div className="lp-flows" data-reveal="group">
            <FlowStrip label="USDG revenue buys ORRY, which goes to stakers and to burning" nodes={["USDG revenue", "Buys ORRY", ["Stakers", "Burn"]]} accent="Buys ORRY" />
            <FlowStrip label="Swap fees from the ORRY pools go to Earn" nodes={["Pool swap fees", "Earn"]} accent="Earn" />
          </div>
        </div>
        <ol className="lp-orry-uses" data-reveal="group">
          {ORRY_USES.map((u) => (
            <li key={u.title}>
              <h3>{u.title}</h3>
              <p>{u.text}</p>
              <Link className="lp-link" href={u.href}>{u.cta}</Link>
            </li>
          ))}
        </ol>
      </section>

      <section className="lp-section lp-ground lp-faq" aria-labelledby="faq-h">
        <div className="lp-head">
          <p className="kicker">Questions</p>
          <h2 id="faq-h" data-reveal="lines"><span className="rl"><span>Straight answers.</span></span></h2>
        </div>
        <Faq items={FAQ} />
      </section>
      <Footer />
    </div>
  );
}
