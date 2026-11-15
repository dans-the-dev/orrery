import { createServer } from "node:http";
import { chainHead, connect, lagBehind, loadConfig, makeChain, migrate } from "../index.js";
import { runLaunchIndexer } from "../launch-indexer.js";

/**
 * Lane L5 indexer process (Agent Launch: launches, early buys, fee splits, creator claims and the spoke pools' swaps).
 * Health keys on lag against the live chain head (workspace rule 7), never on "backfill finished".
 */
const cfg = loadConfig();
if (!cfg.launch) throw new Error("Set ORRERY_AGENT_LAUNCH to run the Agent Launch indexer.");
const lc = cfg.launch;
const sql = connect(cfg.databaseUrl);
await migrate(sql);
const chain = makeChain(cfg);
const maxLag = BigInt(process.env.ORRERY_INDEXER_MAX_LAG ?? 600);
createServer(async (_req, res) => {
  const head = await chainHead(chain).catch(() => null);
  const [s] = await sql<{ last_block: string; head_block: string }[]>`select last_block, head_block from indexer_state where id = 'launch'`;
  const lag = lagBehind(s ? { last: BigInt(s.last_block) } : null, head);
  const ok = lag !== null && lag <= maxLag + BigInt(cfg.confirmations);
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok, head: head?.toString() ?? null, last: s?.last_block ?? null, lag: lag?.toString() ?? null }));
}).listen(Number(process.env.ORRERY_LAUNCH_INDEXER_HEALTH_PORT ?? 8793));
await runLaunchIndexer(lc, chain, sql, cfg.confirmations, undefined, (m) => console.error(m));
