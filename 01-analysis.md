# 01 Analysis of the research brief

Date: 2026-11-06. Source: `00-source/research-brief-2026-11-06.md`. Labels: **verified** (checked by command or primary
source this session), **summary** (read through a search summary, re-check before relying), **not verified**.

## Fact check of the brief

| Claim in brief | Finding | Label |
| :--- | :--- | :--- |
| ERC-8004 live on many chains, Base largest | Canonical registries `IdentityRegistry 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, `ReputationRegistry 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` listed for 30+ mainnets in the official repo README, **including Robinhood Chain 4663**. Testnet pair `0x8004A818…BD9e` / `0x8004B663…8713` on 46630. Bytecode present at both mainnet addresses on 4663 and at IdentityRegistry on Base (`eth_getCode`, 2026-11-06). | verified |
| Validation Registry part of ERC-8004 | Official README: the Validation Registry section is "still under active update and discussion with the TEE community". Not a stable dependency. | verified |
| ERC-8004 standard status | EIP still Draft. | summary |
| Only 3 to 15% of registrations valid and live | arXiv 2606.26028 (Xiong et al., v2 8 Jul 2026, data to 13 May 2026): 3% Ethereum, 4% BSC, 15% Base have a valid registration file with a live endpoint; 73.5 / 59.2 / 90.6% of reviewers show coordinated Sybil behaviour; after filtering 15.8 / 77.9 / 86.8% of rated agents keep no valid feedback. Authors: registry "cannot function as a trust signal" as deployed. | summary (paper abstract) |
| > 2 million ERC-8004 agents | Not checked across chains; registry has no `totalSupply`. | not verified |
| ERC-8004 agents on 4663 (not in brief) | Mint (`Transfer` from zero) logs of the IdentityRegistry, deploy block 12,058,809 to head 107,595,188, scanned 2026-11-06 via Pocket RPC: **21,497 agents, 1,655 distinct owners; top 10 owners hold 90.3% (largest 10,000, next 5,593); 1,482 owners hold exactly one agent.** New mints: 83 in the last 24 h, 1,390 in 7 days, 12,922 in 30 days. Reading: bulk registration dominates; the realistic operator base on 4663 today is about 1,500. | verified |
| x402 ~197 M transactions, ~$42.5 M settled | Coverage reports "more than 196 million transactions across twelve blockchains, over $42 million" by Nov 2026. | summary |
| x402 138 M+ on Base (Chainalysis) | Chainalysis via PaymentsJournal: 138 M+ transactions on Base in Q3 2026; > 87% of payments between $0.0001 and $0.10. | summary |
| Average payment $0.05 to $0.30 | Consistent with the above. | summary |
| Not in brief | Artemis dashboard 2026-11-03: 369.5 K transactions and **$27.8 K volume in 24 h**; October 2026 reported at $274 K; an early-2026 Artemis analysis put about half of transactions as self-trading / wash. | summary |
| Virtuals ACP ~$430 M, 2.5 M jobs | Not checked. | not verified |
| ERC-7715 wallet permissions | Draft since May 2024, depends on ERC-7710 delegation; grant / redeem flow with on-chain enforcement. | summary |
| Agent wallet market | Coinbase Agentic Wallets (launched 11 Feb 2026, server-side policy), Alchemy EIP-7702 + session permissions, Openfort, Rhinestone/Biconomy Smart Sessions (ERC-7579 module with spending-limit and action policies), one comparison site lists 34 programmable agent wallets. Coinbase AgentKit itself ships no built-in spending limits. | summary |
| Skyfire KYAPay | Signed JWT tokens naming the agent, its principal and platform; optional paid verification ties a human or business identity. Off-chain. | summary |
| Robinhood Chain payment token | USDG (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`) supports `receiveWithAuthorization` (EIP-3009 style); x402 `exact` EVM scheme uses `transferWithAuthorization`. Measured 2026-11-05 in another workspace project. No mainstream x402 facilitator (Coinbase CDP, Circle) lists 4663. Third-party facilitators exist: aeron-facilitator (verify and settle USDG), a verify-only one by ExpertVagabond, and agent402 guides for USDG on 4663 (summary, not checked for maintenance or behaviour). v1 runs its own internal facilitator (I1) and does not depend on them. Block time 101 ms. | verified (earlier session) / summary (facilitator lists) |
| Competitor on 4663 | priors.trade: agent credit for ERC-8004 agents on 4663 (researched 2026-10-02 in `agent-credit-docs`). Adjacent, not the same product. | summary |

## What holds up

1. **The trust gap is real and measured.** ERC-8004 identity exists and is cheap, but its reputation layer is gamed and
   most registrations are dead. A layer that tells a counterparty "this agent is live, bound to an operator, and cannot
   spend beyond X" answers a problem the paper documents.
2. **Building on ERC-8004 and x402 rather than a new standard** is correct; both are deployed, including on 4663.
3. **Infrastructure first, copy trading later** is the right order; performance data must exist before anyone can price it.
4. **No token before product** matches workspace practice.

## Problems, ranked

### Critical

**C1. The "agent wallet with spending limits" part is already crowded.** Coinbase, Alchemy, Openfort, Rhinestone Smart
Sessions, MetaMask delegation (ERC-7710/7715), Binance and dozens more ship spend caps, allowlists and session keys
today. A project whose core is "wallet + limits + SDK" competes with Coinbase's distribution and loses. The brief's
"nobody owns KYA" is true for the *trust* side, not for the *wallet-limit* side. The project needs a wedge that those
wallets do not provide. Proposal (Q1): **provable policy**. Any counterparty can check on-chain, before accepting work or
extending credit, that an agent's spending authority is capped, by whom, and that its endpoint is live. Wallet vendors
enforce limits privately; nobody publishes them as a verifiable trust signal tied to the ERC-8004 identity.

**C2. No revenue model in the brief, and the obvious one does not pay.** Total measured x402 volume is about $27.8 K a
day across all chains (summary). A 1% fee on *every* x402 payment in the world would earn about $278 a day. Fees on
agent spend cannot fund the project at today's volume; see `03-economics.md`. Revenue has to come from the party that
needs the trust answer (verification per check, operator plans) or from a later product (credit, copy fees).

### High

**H1. "KYA" is undefined.** It can mean (a) verifying the human or business behind an agent (KYC of the operator,
Skyfire style, off-chain, privacy and compliance load), (b) proving what the agent *can* do (its policy and caps), or (c)
proving the agent is real and live (endpoint and registration checks). The brief uses all three. Each implies a
different product and legal posture (Q1).

**H2. Chain choice pulls two ways.** Workspace default is Robinhood Chain 4663, where ERC-8004 is deployed but agent
and x402 activity is unmeasured and no mainstream facilitator runs. Base holds most ERC-8004 and x402 activity. A trust
layer is worth most where the agents are (Q2).

**H3. Reputation from ERC-8004 feedback cannot be reused as is.** The paper's Sybil figures mean any score built on raw
feedback inherits the manipulation. Own signals must come from things that cost money or are verifiable: on-chain policy,
bonded stake, settled payments, live endpoint checks.

### Medium

**M1. Validation Registry is unstable**; do not build a hard dependency on its interface in v1.

**M2. Smart-account standards are still drafts** (ERC-7715, ERC-7710; ERC-7579 is final-ish but module ecosystems
differ). Pick one base and wrap it, do not build three adapters in v1 (Q3).

**M3. Copy agent (phase 3) is a trading product** with front-running, latency and liability issues; keep it out of the
spec until phase 2 data exists.

**M4. USDG on 4663 has issuer freeze and wipe functions** (role-gated). Any escrow or bond held in USDG can be frozen by
the issuer; this is a fact for the risk register, not a UI line.

## Gaps the brief leaves open

- Who the paying customer is: agent developers, API sellers / merchants receiving agent payments, or protocols lending
  to agents.
- Custody: non-custodial smart account vs server-side policy (MPC).
- What the SDK covers: one language (TypeScript) first, or Python too (most agent frameworks are Python).
- How the verifier decides "live" and what it signs.
- Name, domain, X handle.
