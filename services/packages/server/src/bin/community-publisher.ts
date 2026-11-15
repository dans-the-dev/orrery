import { connect, loadConfig, makeChain, migrate } from "../index.js";
import { publishAccruals } from "../community-publisher.js";

// Lane L1: posts pending cashback and referral accruals to CashbackRewards. Dry run unless `--send`.
const cfg = loadConfig();
if (!cfg.community?.cashback) {
  console.error("ORRERY_COMMUNITY_POOL and ORRERY_COMMUNITY_CASHBACK are needed.");
  process.exit(1);
}
const sql = connect(cfg.databaseUrl);
await migrate(sql);
const n = await publishAccruals(cfg, makeChain(cfg), sql, process.argv.includes("--send"));
console.log(`community publisher: ${n} sent`);
await sql.end();
