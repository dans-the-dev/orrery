# Progress

## 2026-11-15 (Orrery)

- Orrery created from Runcore at faed73d: same functions, new name, token ORRY, contracts renamed, copy rewritten,
  Observatory theme. Runcore's launch history (`docs/launch/`), brand assets, deployments and addresses were left out.
- Discord removed (owner, 2026-11-15: remove every mission or activity that needs Discord): the bot
  (wallet /verify and roles, slash commands, announcements, booster tiers, welcomes), the /discord/verify page, the
  Discord links, the support assistant whose review queue lived in Discord (X mentions are answered by hand), its ops
  scripts, compose services and migrations 012 and 039. Referral tiers stay, without a Discord role. Plan documents
  that still describe Discord features are history.
- Before a live run: register orrery.tech, create the X account (set `NEXT_PUBLIC_X_HANDLE`), make new keys in
  `~/.secrets/orrery/`, deploy with `services/scripts/deploy-4663.ts`, then copy the addresses into `services/packages/sdk/src/quick.ts` and `services/packages/mcp/src/config.ts`.
- Fork tests under `contracts/test/**/fork` still read Runcore's live 4663 contracts as fixtures; they need Orrery's
  own addresses once it is deployed.

The entries below are Runcore's history, kept for the decisions behind the code. The rename pass switched the
names in them to Orrery's; every deployment, account and post they mention belongs to Runcore.

## 2026-11-06

- Folder created with the owner's research brief (`00-source/`), translated to English.
- Outside facts checked (`01-analysis.md`): ERC-8004 registries have code on 4663 and Base; Validation Registry still
  changing; ERC-8004 study (arXiv 2606.26028) confirms 3 to 15% live registrations and heavy Sybil feedback; x402 is
  about $27.8 K a day across all chains (summary); agent-wallet limits are a crowded market.
- Owner decisions (`02-open-questions.md`): Q1 provable policy + liveness; Q2 Robinhood Chain 4663 first (over the
  recommendation of Base); Q3 own ERC-7579 policy module; Q4 paid checks over x402 + one-time verification fee; Q5 no
  bond in v1; Q6 TypeScript SDK first; I4 increase delay minimum 1 hour; I5 fee once per agentId.
- Not verified: identities of Safe7579 / Kernel code found on 4663, the x402 and Virtuals figures (summary only), the
  number of ERC-8004 agents on 4663, prices (guesses).

- Contract spec `08` and invariants `09` written. Q8 (owner): agent pays x402 from a float wallet topped up within caps.
  Binding uses ERC-8004 `agentWallet`, which the registry clears on identity transfer (spec text read 2026-11-06).
  USDG on 4663: 6 decimals (eth_call). Integration pass 2: I8 to I10.

- Q9 (owner): checks sold as prepaid credit packs, because one USDG x402 settlement costs about $0.004 on 4663
  (0.02 gwei, ETH $2,246, measured 2026-11-06), more than the guessed $0.002 per check.
- `14-services-spec.md` and `11-handoff-brief.md` written. Planning is ready for an executing agent (start at E0).

- Readiness check (2026-11-06): ERC-8004 on 4663 measured (21,497 agents, 1,655 owners, top 10 hold 90.3%). Three own
  gaps closed (O(1) epoch uninstall, single-use signers, agent gas). Independent spec review: 1 Critical, 4 High,
  6 Medium, 7 Low, all applied (`10-spec-review.md`); specs 08, 09, 14 at revision 2; decisions I11 to I14.

- Owner 2026-11-06: "kerjakan saja protokol dan desain menggunakan opsi 3". Design direction 03 Current Limit chosen and
  finished as the frontend guide (`design/directions/03-current-limit/`). Contracts built in this session on branch
  `build/v1`: OrreryPolicyModule, OrreryAttestor, OrreryLens. 54 unit tests, invariant campaign (256 runs, 30,720 calls), deep run
  (4,000 actions), 38/38 mutations caught, 4 fork tests on Robinhood Chain 4663 with the real ERC-8004 registry, USDG,
  Safe 1.4.1 and Safe7579 v1.0.0. Details: `contracts/README.md`.

## 2026-11-07

- Services built (`services/`: x402 v2 facilitator, API with credit packs and signed checks, prober, indexer, SDK;
  31 tests) and the web app (`services/packages/web`, Next 16, wagmi 3, EIP-6963, design 03).
- Live rehearsal on Robinhood Chain 46630 passed (`docs/REHEARSAL-46630.md`, `deployments/46630.json`).
- Readiness work (owner: "Ya, kerjakan"), evidence in `docs/MAINNET-4663.md`:
  1. `services/scripts/deploy-4663.ts`: mainnet deployment with a CONFIRM gate; fork dry run passed; live gate tested
     with no transaction sent.
  2. Operator flow through a real Safe 1.4.1 + Safe7579 v1.0.0 in the web app on a 4663 fork: install, bind identity
     (ERC-1271 through the adapter), open session, pay verification with real USDG; record reads the Safe correctly.
  3. First-visit walk with a fresh wallet on 46630 live: hero check, record, connect, buy a pack over x402, signed check.
- Readiness class: READY on the engineering side; the live run waits on owner inputs (section 4 of
  `docs/MAINNET-4663.md`).

## 2026-11-10 and 11-11

- Five findings of the independent review fixed and re-verified (cf142dc; `docs/reviews/2026-11-10-independent-review.md`
  section 6); every fix's mutant caught, including `collectOne` self-only.
- Go-live rehearsed end to end on a 4663 fork (`docs/HOSTING-4663.md` section 0), the last run with the markets and
  the facilitator: 26 ORRY, 6 markets and 7 facilitator read-backs.
- Wave 3 merchant payments built (a6e34cf): MerchantSplitterFactory, MerchantSplitter, X402Permit2Proxy, the public
  facilitator API, `/merchants`, `/docs/merchants`, `deploy-facilitator-4663.ts`. Mutation 35/35.
- Wallet dashboard: `Dashboard` in the navbar while a wallet is connected, and a sidebar of every protocol page on the
  app pages.
- Wave clips for the X posts: `/mnt/shared/Home/Videos/Orrery/Orrery-Wave-*.mp4` (`docs/launch/x-posts.md`).

## Next

- Name decided 2026-11-06: **Orrery**, domain orrery.tech (Q7; Proofcap chosen first, then replaced).

- 2026-11-08 owner inputs: deployer = owner = treasury, fee 5 USDG, 500 checks for 1 USDG (M1 to M3); mainnet keys
  created (`docs/MAINNET-4663.md` section 4).

- 2026-11-08 X account @OrreryHQ created and verified by the owner (blue check); the site's handle constant uses that casing.

1. Owner: send ETH on 4663 to deployer (0.0003), relayer (0.0002), attester (0.0002).
2. Run `deploy-4663.ts` live; the owner types CONFIRM.
3. Hosting: web on Vercel Hobby at orrery.tech, services on server 1 (when the owner says deploy).
4. Not gates: Kernel 3.1, Slither, a second independent review.
