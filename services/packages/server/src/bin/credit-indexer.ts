import { createServer } from "node:http";
import { chainHead, connect, loadConfig, makeChain, migrate } from "../index.js";
import { creditLag, runCreditIndexer } from "../credit-indexer.js";

/** Lane L4 attester and Credit indexer. Health on lag against the live chain head; it stays `confirmations` behind by design. */
const cfg = loadConfig();
if (!cfg.credit) throw new Error("Set ORRERY_ATTESTER_REGISTRY or ORRERY_CREDIT_FACTORY to run the credit indexer");
const sql = connect(cfg.databaseUrl);
await migrate(sql);
const chain = makeChain(cfg);
const maxLag = BigInt(process.env.ORRERY_INDEXER_MAX_LAG ?? 600) + BigInt(cfg.confirmations);
createServer(async (_req, res) => {
  const head = await chainHead(chain).catch(() => null);
  const l = await creditLag(sql).catch(() => null);
  const lag = head !== null && l ? head - l.last : null;
  const ok = lag !== null && lag <= maxLag;
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok, head: head?.toString() ?? null, last: l?.last.toString() ?? null, lag: lag?.toString() ?? null }));
}).listen(Number(process.env.ORRERY_CREDIT_INDEXER_HEALTH_PORT ?? 8792));
await runCreditIndexer(cfg.credit, chain, sql, cfg.confirmations, undefined, (m) => console.error(m));
