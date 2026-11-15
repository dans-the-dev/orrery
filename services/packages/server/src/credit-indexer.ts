import { parseEventLogs, type Abi, type AbiEvent, type Address, type Log } from "viem";
import {
  attesterFeeSplitterAbi,
  attesterRegistryAbi,
  creditPoolAbi,
  creditPoolFactoryAbi,
  creditRevenueRouterAbi,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { CreditConfig } from "./credit-config.js";
import type { Sql } from "./db.js";
import { blockTimes } from "./orry-indexer.js";
import { logLine } from "./log.js";

/**
 * Lane L4 indexer: one cursor (`credit`) over the attester registry, its splitter, the Credit factory, every pool it
 * created and every line router those pools opened, at the confirmation depth. A pool or router found inside a range is
 * read for that same range before the cursor moves, so no event is skipped.
 */

const STATE_ID = "credit";
const lower = (a: unknown) => String(a).toLowerCase();

type Source = "registry" | "splitter" | "factory" | "pool" | "router";

const eventsOf = (abi: Abi): AbiEvent[] => abi.filter((x): x is AbiEvent => x.type === "event");
const ABI_BY_SOURCE: Record<Source, Abi> = {
  registry: attesterRegistryAbi as Abi,
  splitter: attesterFeeSplitterAbi as Abi,
  factory: creditPoolFactoryAbi as Abi,
  pool: creditPoolAbi as Abi,
  router: creditRevenueRouterAbi as Abi,
};

const jsonArgs = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(args).map(([k, v]) => [
      k,
      typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.toLowerCase() : typeof x === "bigint" ? x.toString() : x)) : v && typeof v === "object" ? jsonArgs(v as Record<string, unknown>) : v,
    ]),
  );

async function knownSources(c: CreditConfig, sql: Sql): Promise<Map<string, Source>> {
  const m = new Map<string, Source>();
  if (c.registry) m.set(lower(c.registry), "registry");
  if (c.splitter) m.set(lower(c.splitter), "splitter");
  if (c.factory) m.set(lower(c.factory), "factory");
  for (const r of await sql<{ pool: string }[]>`select pool from credit_pools`) m.set(r.pool, "pool");
  for (const r of await sql<{ router: string }[]>`select router from credit_lines`) m.set(r.router, "router");
  return m;
}

function topicEvents(sources: Iterable<Source>): AbiEvent[] {
  const seen = new Map<string, AbiEvent>();
  for (const src of new Set(sources)) for (const e of eventsOf(ABI_BY_SOURCE[src])) seen.set(`${e.name}(${e.inputs.map((i) => i.type).join(",")})`, e);
  return [...seen.values()];
}

export async function indexCreditOnce(
  c: CreditConfig,
  chain: Chain,
  sql: Sql,
  confirmations: number,
  range = 5_000n,
): Promise<{ last: bigint; head: bigint; logs: number; lag: bigint }> {
  const [state] = await sql<{ last_block: string }[]>`select last_block from indexer_state where id = ${STATE_ID}`;
  const from = state ? BigInt(state.last_block) + 1n : c.startBlock;
  const head = await chain.public.getBlockNumber();
  const safe = head > BigInt(confirmations) ? head - BigInt(confirmations) : 0n;
  if (from > safe) return { last: from - 1n, head, logs: 0, lag: head - (from - 1n) };
  const to = from + range - 1n < safe ? from + range - 1n : safe;
  let total = 0;
  await sql.begin(async (tx) => {
    const map = await knownSources(c, tx as unknown as Sql);
    let pending = [...map.keys()];
    while (pending.length) {
      const srcs = pending.map((a) => map.get(a)!);
      const logs = (await chain.public.getLogs({ address: pending as Address[], events: topicEvents(srcs), fromBlock: from, toBlock: to, strict: false })) as Log[];
      const sorted = [...logs].sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex! - y.logIndex! : x.blockNumber! < y.blockNumber! ? -1 : 1));
      const times = await blockTimes(chain, sorted);
      const found: string[] = [];
      for (const log of sorted) {
        const source = map.get(lower(log.address));
        if (!source) continue;
        const [decoded] = parseEventLogs({ abi: ABI_BY_SOURCE[source], logs: [log], strict: false }) as unknown as { eventName: string; args: Record<string, unknown> }[];
        if (!decoded) continue;
        const args = jsonArgs(decoded.args ?? {});
        const time = times.get(log.blockNumber!)!;
        const ins = await tx`insert into credit_events (block_number, log_index, tx_hash, address, source, event, args, block_time)
          values (${log.blockNumber!.toString()}, ${log.logIndex!}, ${log.transactionHash!}, ${lower(log.address)}, ${source}, ${decoded.eventName}, ${tx.json(args as never)}, ${time})
          on conflict do nothing returning log_index`;
        if (ins.length !== 1) continue;
        total++;
        const ev = `${source}.${decoded.eventName}`;
        if (ev === "registry.ResultForwarded") {
          await tx`insert into attester_results (block_number, log_index, epoch, staker, agent_id, probe_key, observed_at, endpoints_live, registration_valid, domain_verified, counted, block_time)
            values (${log.blockNumber!.toString()}, ${log.logIndex!}, ${String(args.epoch)}, ${String(args.staker)}, ${String(args.agentId)}, ${String(args.probeKey)},
              ${String(args.observedAt)}, ${Boolean(args.endpointsLive)}, ${Boolean(args.registrationValid)}, ${Boolean(args.domainVerified)}, ${Boolean(args.counted)}, ${time})
            on conflict do nothing`;
        } else if (ev === "factory.PoolCreated") {
          const pool = String(args.pool);
          await tx`insert into credit_pools (pool, pool_index, params, created_block) values (${pool}, ${Number(args.index)}, ${tx.json(args.params as never)}, ${log.blockNumber!.toString()})
            on conflict do nothing`;
          if (!map.has(pool)) {
            map.set(pool, "pool");
            found.push(pool);
          }
        } else if (ev === "factory.PoolRetired" || ev === "pool.Retired") {
          const pool = ev === "pool.Retired" ? lower(log.address) : String(args.pool);
          await tx`update credit_pools set retired = true where pool = ${pool}`;
        } else if (ev === "pool.LineOpened") {
          const router = String(args.router);
          await tx`insert into credit_lines (pool, agent_id, bond_owner, router, opened_block) values (${lower(log.address)}, ${String(args.agentId)}, ${String(args.bondOwner)}, ${router}, ${log.blockNumber!.toString()})
            on conflict do nothing`;
          if (!map.has(router)) {
            map.set(router, "router");
            found.push(router);
          }
        } else if (ev === "pool.BondPosted") {
          await tx`update credit_lines set bond_owner = ${String(args.bondOwner)} where pool = ${lower(log.address)} and agent_id = ${String(args.agentId)}`;
        } else if (ev === "pool.Deposited") {
          await tx`insert into credit_lenders (pool, lender) values (${lower(log.address)}, ${String(args.lender)}) on conflict do nothing`;
        }
      }
      pending = found;
    }
    await tx`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${to.toString()}, ${head.toString()})
      on conflict (id) do update set last_block = excluded.last_block, head_block = excluded.head_block, updated_at = now()`;
  });
  return { last: to, head, logs: total, lag: head - to };
}

export async function runCreditIndexer(
  c: CreditConfig,
  chain: Chain,
  sql: Sql,
  confirmations: number,
  signal?: AbortSignal,
  log: (m: string) => void = () => {},
): Promise<void> {
  let lastError = 0;
  while (!signal?.aborted) {
    try {
      const r = await indexCreditOnce(c, chain, sql, confirmations);
      if (r.lag > BigInt(confirmations) + 1n) continue;
    } catch (e) {
      if (Date.now() - lastError > 60_000) log(`credit indexer step failed: ${logLine(e)}`);
      lastError = Date.now();
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
}

export async function creditLag(sql: Sql): Promise<{ last: bigint; head: bigint } | null> {
  const [row] = await sql<{ last_block: string; head_block: string }[]>`select last_block::text, head_block::text from indexer_state where id = ${STATE_ID}`;
  return row ? { last: BigInt(row.last_block), head: BigInt(row.head_block) } : null;
}
