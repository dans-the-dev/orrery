# Business model decisions (2026-11-09)

Relayed by the Orrery session after its review (owner answered "A": all six recommendations go to decision and spec);
numbers chosen by the owner in the orchestrating session. Decisions R-57 to R-62.

| # | Decision | Where it lands | When |
| :-- | :--- | :--- | :--- |
| R-57 | x402 facilitator settlement fee 0.2% on agent to merchant payments, collected through a per-merchant forwarding splitter: the merchant's `payTo` becomes its own splitter (created by a factory at a CREATE2 address keyed by the merchant), which forwards 99.8% to the merchant and 0.2% to `OrreryTreasury` on `forward()` (called by the facilitator after settlement, or anyone). Staker discount through the USD fee tiers | new `MerchantSplitter` + factory, facilitator (services) | update wave 2 (facilitator, U6); no change to the launch contracts |
| R-58 | Check pricing: 1,000 free checks per month per address; 0.004 USD per check at small volume, 0.002 USD above 100,000 checks a month; a 99 USDG monthly plan for agent platforms (higher limits, SLA) | API and pricing config | with the launch, services only |
| R-59 | Treasury USDG split 70% buyback / 30% owner (20% operations, 10% owner) by `OWNER_BPS = 3000` in `services/scripts/deploy-4663.ts`; no contract change (the constructor accepts up to 10,000). Supersedes R-4 and T9 (90/10) | v1 deploy script (`build/v1`, the Orrery session's file) | before the mainnet deploy |
| R-60 | Official data is payable in USDG at full price (to the treasury) or in ORRY at 20% off (70% burned, 30% to the Reward Pool, as R-50) | data service, `DataFeeSplitter` | D1 |
| R-61 | Agent-focused roadmap: facilitator, data market, MCP, Dark Pool and Stocks, Agent Launch first; perps, lend, multiply and RWA issuance wait until core USDG revenue is proven. Reorders R-29 (R3 and R4 deferred) | roadmap | now |
| R-62 | KPI set for the dashboard and reports: verified agents, integrated merchants, x402 volume, checks per day, USDG revenue, buyback size | services and web | with the launch |
