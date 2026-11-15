# Orrery

Know Your Agent infrastructure for the AI agent economy: an agent wallet with a policy engine (spending limits,
allowlists, scoped session keys, revocation) on top of ERC-8004 identity and x402 payments, plus a developer SDK.
Verifiable performance tracking and controlled agent-to-agent copy come in later phases.

Status (2026-11-15): created as a rebrand of Runcore (`../kya-protocol`, commit faed73d) with the same functions:
contracts, services, SDK, MCP server, web app and ops copied, every name, identifier and token ticker renamed
(Runcore to Orrery, RCORE to ORRY, Kya* contracts to Orrery*), user-facing copy rewritten, and a new visual direction
(Observatory, `design/README.md`). Fresh git history. Nothing deployed: `deployments/` is empty, the SDK and MCP have no
default contract addresses, and no keys exist yet (`~/.secrets/orrery/` when they are made). Domain orrery.tech
(not registered), no X or Discord account yet. The planning documents below are carried over from Runcore and keep
their original decision history.

## Files

| File | Purpose |
| :--- | :--- |
| `00-source/research-brief-2026-11-06.md` | The owner's research brief, translated to English; figures unverified |
| `01-analysis.md` | Fact check of the brief, what holds up, problems ranked, gaps |
| `02-open-questions.md` | Every decision with date and owner, plus the integration pass |
| `03-economics.md` | Market size, revenue scenarios, abuse scenarios |
| `04-architecture-draft.md` | Components, check result shape, policy state machine |
| `05-risks.md` | Market, trust, contract, dependency, legal, ops risks |
| `08-contract-spec.md` | v1 contracts: policy module, attestor, lens; data model, functions, admin powers, not in v1 |
| `09-invariants.md` | Invariants by category, test plan, adversarial review brief |
| `10-spec-review.md` | Independent spec review: 18 findings and how each was resolved |
| `11-handoff-brief.md` | Brief for the executing agent: read order, backlog E0 to E12 with proofs, rules, open owner decisions |
| `14-services-spec.md` | Facilitator, API with credit packs, prober, indexer, SDK, web |
| `PROGRESS.md` | Where the project stands and what comes next |

Planned planning documents follow the workspace protocol-design method (`01-analysis.md`, `02-open-questions.md`,
`03-economics.md`, `04-architecture-draft.md`, `05-risks.md`, `08-contract-spec.md`, `09-invariants.md`,
`11-handoff-brief.md`). The planning session stops at spec, invariants and handoff brief; another agent writes the code.

## Workspace constraints that apply here

- English only in shipped content, global audience, no disclaimer lines and no doubt-raising sentences in UI.
- Wallet connect via EIP-6963, brand-neutral. Robinhood Chain is the default chain unless the owner picks another.
- Any DEX price reference uses Uniswap v4.
- No external audit as a gate: fuzz and invariant tests plus internal review.
- No GitHub Actions: checks run locally.
- Keys go to `~/.secrets/<project>/`; test networks funded from the testnet bank.
- Indexer RPC: measure the chain's block rate before choosing a provider.
