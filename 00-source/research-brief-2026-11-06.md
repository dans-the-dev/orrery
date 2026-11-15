# AI Agents Economy + KYA: research and execution brief

Source: the owner's research session of 2026-11-06, translated to English for this repository. Content is kept as
given. **None of the figures below has been verified by this workspace yet**; verification is the first planning task
(see `../PROGRESS.md`).

## 1. Executive summary

The AI Agents Economy + KYA (Know Your Agent) narrative is one of the earliest and highest-potential areas in crypto
right now. AI agents already make hundreds of millions of on-chain payments (mostly micro-payments), but the identity,
authorization and accountability infrastructure is still raw.

**Main opportunity:** build the layer that makes an agent easy to trust, limit and audit, not just "an agent that can pay".

## 2. Market data and real activity (November 2026, unverified)

| Metric | Figure | Source / note |
| :--- | :--- | :--- |
| x402 cumulative transactions | ~197 million | "agent economy.to" (2026-11-06) |
| x402 settled volume | ~$42.5 million | Mostly micro-payments (< $0.10) |
| x402 on Base (Chainalysis) | 138 million+ | Through Q3 2026 |
| Virtuals ACP gross value | ~$430 million | 2.5 million+ jobs |
| ERC-8004 registered agents | > 2 million | 24 chains (Base largest), low quality |
| Average x402 payment | $0.05 to $0.30 | Mostly inference, data, tools |

Note: transaction counts are high but economic value is still small. Much activity is test traffic or bots. Agent
identity quality is poor (a study reports only 3 to 15% of registrations are valid and live).

## 3. Core infrastructure that exists

| Layer | Standard / protocol | Status | Strength | Weakness |
| :--- | :--- | :--- | :--- | :--- |
| Payment | x402 (Coinbase) | Dominant | Simple, HTTP-native, micro-payments | No built-in identity or authorization |
| Identity | ERC-8004 | Live on many chains | On-chain ID (ERC-721) + reputation | Many fake or inactive registrations |
| Authorization | Assertion tokens, session keys, KYA frameworks | Early | Scoped permissions | No dominant standard yet |
| Off-chain | Visa TAP, Mastercard Agent Pay, Google AP2, Skyfire KYAPay | Active | Institutional backing | Closed, not crypto-native |

ERC-8004 is the most relevant identity standard today (Identity Registry + Reputation + Validation), deployed on Base,
Ethereum, Polygon and others.

ERC-8004 reputation problems (2026 study): most registrations are placeholders; feedback is easy to game (high Sybil);
only 3 to 15% of agents have a live, valid endpoint.

## 4. Competitor landscape

| Project | Focus | Strength | Weakness |
| :--- | :--- | :--- | :--- |
| Virtuals Protocol | Agent launchpad + EconomyOS | Identity + banking layer, revenue share | More speculative, uneven agent quality |
| ElizaOS | Open-source framework | Developer-friendly, many plugins | Token dead, software focus |
| Coinbase AgentKit / Agentic Wallet | Wallet and tools for agents | Strong backing, x402 native | Tied to the Coinbase ecosystem |
| Binance Agentic Wallet | MPC wallet for agents | Institutional, spending controls | Not fully decentralized |
| Olas / Autonolas | Agent coordination and services | Long in the space | Smaller market share |

**Biggest gap:** nobody owns KYA that is easy to use, high quality and has strong permission scoping.

## 5. Most promising use cases

| Rank | Use case | Potential | Reality today | Fit | Note |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Agent buys data / tools on demand | High | Already happening (x402 dominant) | Very good | Micro-payments for inference, on-chain data, risk checks |
| 2 | Yield / DeFi automation with controls | High | Starting | Good | Agent rebalancing, yield optimization |
| 3 | Agent wallet + spending limit + KYA | Very high | High demand, raw solutions | **Best** | Foundation for every other use case |
| 4 | Research / intelligence agent | Medium-high | Many attempts | Good | Agent buys data, then sells insight |
| 5 | Autonomous trading for profit | Hype appeal | Hard, mixed results | Not recommended | Many failures, high regulatory and liability load |

Conclusion: do not start from "agent trades for profit". Start from infrastructure (KYA + controlled wallet) and the
more controlled use cases (data purchase + insight, yield automation).

## 6. Copy Agent idea (agent-to-agent copy)

Concept: other agents see a good agent's reputation and performance and copy its strategy, paying 10% of profit.

Assessment:
- A 10% fee is common (example: Hyperliquid vaults).
- Virtuals has started agentic copy trading.
- ERC-8004 reputation today is weak and easy to manipulate.
- Main risks: front-running, execution delay, hard performance verification.

To make it viable:
1. Verifiable performance tracking (PnL, drawdown, win rate) that can be audited.
2. Controlled copy (spending limit, allowlist, kill switch stays active).
3. High-watermark fee (fee only on new profit).
4. Paper trading / simulation mode first.
5. Do not rely on raw ERC-8004 reputation alone.

Roadmap position: not a launch feature. Build after KYA + performance tracking are solid.

## 7. Recommended execution direction

Main priorities:
1. **KYA + agent wallet with a policy engine**: spending limits (daily / per transaction), contract / address
   allowlist, session keys / scoped permissions, easy revocation, ERC-8004 integration.
2. **Developer experience**: easy SDK, good docs, x402 integration examples.
3. **Performance tracking layer**: verifiable track record, ready for copy agent later.

Avoid:
- Launching a token before a product people use.
- A new standard competing with ERC-8004 / x402.
- Micro-payments without clear value.
- "Autonomous trading for profit" as the core.

## 8. Suggested roadmap

| Phase | Focus | Copy Agent |
| :--- | :--- | :--- |
| 1 | KYA + agent wallet with spending limits + basic SDK | No |
| 2 | Verifiable performance tracking + on-chain data integration | Prepare data |
| 3 | Controlled copy trading + fee model + paper trading | Yes |

## 9. Main risks

| Risk | Level | Mitigation |
| :--- | :--- | :--- |
| High volume, low value | High | Focus on valuable use cases |
| Many fake / bot registrations | High | Quality filter + verification |
| Fragmented standards | Medium | Build on ERC-8004 + x402 |
| Unclear KYA regulation | Medium | Voluntary / developer tooling |
| Reputation manipulation | High | Do not rely on raw ERC-8004 |
| Autonomous trading fails | High | Not the core product at first |

## 10. Key sources for deep dive

- "agent economy.to": live x402 and ERC-8004 data (exact URL to confirm)
- ERC-8004 (EIP-8004): identity standard
- Chainalysis report (October 2026): 138 million payments
- Virtuals Protocol whitepaper: EconomyOS
- Academic study on ERC-8004 (2026): Sybil and registration quality
- Hyperliquid vaults: 10% performance fee example

## 11. Conclusion

Very early narrative with a clear infrastructure gap. A project that builds practical KYA + a wallet with controls has a
real chance to become core infrastructure. Focus on utility and developer adoption, not token hype. Copy agent comes
later, after the foundation is solid.
