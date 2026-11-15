// Lane L4 weekly attester epoch job, dry run only (docs/updates/L4-CREDIT-SPEC.md 6.4).
// Usage: npx tsx scripts/credit-epoch.ts   (reads the usual ORRERY_* environment: RPC, database, ORRERY_ATTESTER_*)
// Prints the epoch, the set the next roll takes, each attester's disagreement rate against the bar, and the transactions
// the job would send (rollEpoch, split, releaseUnused for anyone; exclude for the attestor owner). It sends nothing and
// needs no key.
import { connect, loadConfig, makeChain, migrate } from "@orrery/server";
import { planEpoch } from "../packages/server/src/credit-epoch.js";
import { indexCreditOnce } from "../packages/server/src/credit-indexer.js";

const cfg = loadConfig();
if (!cfg.credit?.registry) throw new Error("Set ORRERY_ATTESTER_REGISTRY (and ORRERY_ATTESTER_SPLITTER) first");
const sql = connect(cfg.databaseUrl);
try {
  await migrate(sql);
  const chain = makeChain(cfg);
  let r;
  do r = await indexCreditOnce(cfg.credit, chain, sql, cfg.confirmations);
  while (r.lag > BigInt(cfg.confirmations) + 1n);
  const plan = await planEpoch(cfg.credit, chain, sql);
  console.log(`epoch ${plan.epoch} (${plan.rolled ? "rolled" : "not rolled"}), next epoch in ${Math.max(0, plan.secondsToNextEpoch)} s`);
  console.log(`next active set (${plan.nextSet.length}): ${plan.nextSet.join(", ") || "none"}`);
  for (const d of plan.disagreements) console.log(`  ${d.staker}: ${d.disagreements}/${d.results} against the majority (${d.rateBps / 100}%)${d.over ? " OVER THE BAR" : ""}`);
  console.log(`USDG waiting for a split: ${plan.pendingSplitUsdg}`);
  for (const c of plan.checklist) console.log(`[${c.ok ? "x" : " "}] ${c.item}`);
  console.log(plan.txs.length ? "planned transactions (dry run, nothing sent):" : "nothing to send");
  for (const t of plan.txs) console.log(`  ${t.who}: ${t.to}.${t.fn}(${t.args.join(", ")})  # ${t.why}`);
} finally {
  await sql.end();
}
