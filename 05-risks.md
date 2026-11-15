# 05 Risks

Date: 2026-11-06. Internal document; factual by design.

| Area | Risk | Level | Mitigation |
| :--- | :--- | :--- | :--- |
| Market | Agent-wallet features commoditised by Coinbase, Alchemy, Rhinestone, MetaMask | High | Wedge on public, verifiable policy and liveness (C1), interoperate with their accounts instead of replacing them |
| Market | x402 volume small and partly wash; demand for paid checks may be slow | High | Low fixed cost, free SDK, paid checks priced at micro-payment level; operator plan as second leg |
| Market | Chain with little agent activity (4663) gives few users | Medium | Q2; design chain-agnostic registry so a second chain is a deploy, not a rewrite |
| Trust | Verifier attestations become the new thing to game | High | Results expire, repeat probes, state numbers not badges, bond option, publish verifier keys |
| Contract | Policy module bug lets an agent exceed caps | High | Invariants on caps and allowlist, fuzz, mutation checks, fork tests on real smart accounts |
| Contract | Policy weakened right after a counterparty check | Medium | Delay on increases, instant decreases, `validUntil` on results |
| Contract | Admin or verifier key compromise posts false attestations | Medium | Admin powers capped and listed; verifier keys revocable; attestations carry signer; one-wallet ops per workspace rule |
| Dependency | ERC-8004 Validation Registry interface still changing | Medium | Own attestor in v1; adapter later |
| Dependency | ERC-7715 / 7710 still draft; ERC-7579 module differences across accounts | Medium | One account base in v1 (Q3), tested on fork |
| Dependency | USDG issuer can freeze or wipe balances | Medium | Fees in USDG, no bonds in v1 (Q5); the attestor and module hold no balances |
| Legal | Operator identity verification (KYC) brings data-protection and compliance load | Medium | Q1: avoid holding personal data in v1 unless the owner picks operator KYC |
| Legal | Phase 3 copy trading looks like investment management | High | Kept out of v1; reassess before phase 3 |
| Ops | Indexer RPC cost on a 101 ms chain | Medium | Follow workspace rule 7: request-priced RPC or hosted indexing, lag-based health |

## Residual risks after the spec review (2026-11-06)

| Area | Risk | Level | Handling |
| :--- | :--- | :--- | :--- |
| Contract | An allowlisted target can move assets the policy does not list (vault shares, unlisted tokens) | Medium | Stated in every check's `coverage`; SDK warns operators to cap every token a target can move |
| Contract | A Safe that re-enables the adapter without `onUninstall` revives old sessions | Low | Operator's own action; `installed` reported live |
| Trust | Account kinds outside Safe7579 and Kernel 3.1 cannot be judged | Medium | `accountKind = Unknown`, no validity window in checks |
| Process | Revision 2 of the spec has not had a second independent pass | Medium | Code-level adversarial review after E4 stays mandatory |
| Trust | An account owner can grant the signer power outside the module that no on-chain read can see (hidden module entries for other contracts, pre-signed transactions) | Medium | Checks are scoped to "this module limits this signer and the account shows no other known grant" (08 §9); a DELEGATECALL-blocking Safe guard could narrow it later |
| Chain | The 1-hour increase delay relies on `block.timestamp`, which the Robinhood Chain sequencer sets within its allowed drift | Low | Accepted; revisit if the chain's timestamp bounds change |
