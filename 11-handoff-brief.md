# 11 Handoff brief for the executing agent

Date: 2026-11-06. The planning session plans; you write and run the code. This brief is the contract between us.
Project folder: `~/Projects/blockchain/orrery/` (own git repo, branch `main`, local only). Product name: **Orrery**, domain orreryagent.com (Q7). Code may keep
the `Orrery` contract prefix; package scope `@orrery`.

## 1. Read first, in this order

1. `README.md`: what the product is, file index, workspace constraints.
2. `02-open-questions.md`: every decision (Q1 to Q9, I1 to I10) with date and owner. Do not reopen them.
3. `08-contract-spec.md`: contracts, data model, functions, admin powers, open points to verify (section 11).
4. `09-invariants.md`: invariant ids, test plan, adversarial review brief.
5. `10-spec-review.md`: the independent spec review and how each finding was resolved (ids `R-…` cited in the specs).
6. `14-services-spec.md`: facilitator, API, prober, indexer, SDK, web.
7. `05-risks.md` and `01-analysis.md` for context.
8. Workspace rules: `~/Projects/blockchain/CLAUDE.md`, `~/.claude/PROJECT-CONVENTIONS.md`.
9. Method: `~/.claude/skills/protocol-design/SKILL.md` steps 5 to 8 and its `templates/` (foundry.toml,
   harness-notes, mutate.py).

## 2. What exists

| Item | State |
| :--- | :--- |
| Planning documents (`00` to `14`) | Written, committed locally; specs at revision 2 after an independent review |
| Contracts, services, SDK, web | **Nothing.** No code exists |
| Deployments, keys, funds | None |
| Outside facts verified | ERC-8004 registries have code on 4663 at the canonical addresses; USDG 6 decimals; Safe7579 and Kernel 3.1 code present at their usual addresses (identity not confirmed); Smart Sessions absent at its usual address; gas 0.02 gwei on 2026-11-06 |

## 3. Execution backlog, in order

A task is done only when its proof passes and the docs it touches are current. Commit locally per task on a branch
`build/e<n>`; never push without the owner's word.

| # | Task | Proof |
| :--- | :--- | :--- |
| E0 | Foundry project in `contracts/` from the template; interfaces for IdentityRegistry (ERC-8004 subset), ERC-7579 account (`executeFromExecutor`), ERC-20; mocks: `MockIdentityRegistry` (clears `agentWallet` on transfer, ERC-1271 proof), `MockUSDG` (replayed EIP-3009 nonce succeeds and moves nothing), `MockAccount7579` | `forge build` clean |
| E1 | Fork proofs of outside dependencies on 4663 (08 §11, six points): Safe7579 and Kernel 3.1 identities, versions and the addresses `OrreryLens` needs; `executeFromExecutor` mode and `isModuleInstalled`; Kernel behaviour when `onUninstall` reverts; `setAgentWallet` via ERC-1271 then NFT transfer clears it (and whether an event fires); USDG transfer from a smart account; forbidden selectors computed | Fork tests pass with block numbers; findings written into 08 §1 and §3 |
| E2 | `OrreryPolicyModule` per spec; unit tests for every function, revert and event | `forge test` counts |
| E3 | `OrreryAttestor` and `OrreryLens`; unit tests | `forge test` counts |
| E4 | Invariant harness covering every id in `09-invariants.md`; deterministic deep run printing state counts; mutation run with `mutate.py` | Every invariant id mapped to a test; all states reached > 0; every listed mutation killed |
| E5 | End-to-end fork test on 4663: Safe7579 account, bind identity, open session, topUp USDG, execute an allowlisted call, propose and apply an increase across the delay, transfer the identity NFT, check `bound = false` | Pass, block number recorded |
| E6 | `facilitator` with the USDG replay rule; tests against a 4663 fork and `MockUSDG` | Replay test proves no credit is granted twice |
| E7 | `indexer` (Postgres, address-filtered `eth_getLogs`, lag-based health) | Backfill on 46630 rehearsal data; lag metric exposed |
| E8 | `api` (credits over x402, keys, signed checks) and `prober` (SSRF guards) | Integration tests; SSRF test suite (private IP, redirect, oversize) |
| E9 | `sdk` (operator, agent, counterparty parts) | Example scripts run against a local anvil fork of 4663 |
| E10 | `web`: design pitch first (three directions per the no-slop and web3-design skills) for the owner; build after the pick | Owner picks a direction; first-visit walk with a fresh wallet passes |
| E11 | Rehearsal deploy on 46630, full flow with testnet-bank funds | **Owner review before starting**; addresses and tx hashes recorded |
| E12 | Mainnet deploy on 4663 | **Owner types CONFIRM**; summary of contracts, wallets and costs shown first |

Run big builds through `heavy <command>`. Fedora native only; code stays in `~/Projects` on btrfs.

## 4. Planning backlog (stays with the planning session)

- X handle registration for Orrery.
- Final prices: credit pack size and price, verification fee (both guesses today).
- Rollout plan (publik-launch-skill) once E11 passes.
- Phase 2 (performance tracking) and phase 3 (controlled copy) specs: not before v1 has real users.

## 5. Rules for the executing agent

- Do not change an approved decision without writing why and asking the owner.
- Never commit to a shared remote, push, deploy, spend funds or touch keys without the owner's explicit word; mainnet only
  after the owner types CONFIRM. Keys live in `~/.secrets/<project>/`, never in the repo.
- Never write "audited" or "safe"; report counts and what was not run.
- Report as: command, decisive output line, files changed, list of anything unverified.
- If something cannot be proven (for example Kernel 3.1 does not behave as expected), stop and say so; do not work
  around a spec point silently.
- Keep `README.md`, `PROGRESS.md` and the invariant mapping true after each task.
- No GitHub Actions; checks run locally. No tools installed unasked beyond what the stack needs (Foundry, Node, pnpm,
  Postgres in Docker); stop containers and dev servers when a task ends.

## 6. Open owner decisions that affect execution

1. **X handle** @orrerytech to register (owner). Domain orreryagent.com is held and parked; no DNS change without the owner's word.
2. **Hosting** for `api`, `prober`, `indexer`, `facilitator` and Postgres. Default proposal: server 2, after a
   shared-infra check; web on Vercel Hobby.
3. **Prices**: pack $1 for 500 checks, verification fee 5 USDG (guesses). Default: use them on 46630 only.
4. **Treasury and attestor owner**: the owner's own wallet address. Needed before E11.
5. **Kernel support**: if E1 shows Kernel 3.1 needs extra work, ship Safe7579 only in v1. Default: yes.
