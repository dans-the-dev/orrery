import type postgres from "postgres";
import { decodeEventLog, parseAbi, parseAbiItem, type Abi, type Address, type Hex, type Log } from "viem";
import { iAgentLaunchAbi, iOrryBurnEventsAbi, iSpokeHookAbi, spokeRouterAbi } from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Sql } from "./db.js";
import type { LaunchConfig } from "./launch-config.js";
import { toJson } from "./check.js";
import { blockTimes } from "./orry-indexer.js";

/**
 * Lane L5 indexer (`docs/updates/L5-LAUNCH-SPEC.md`, workspace rule 7). Per range of at most 10,000 confirmed blocks: one
 * `eth_getLogs` for AgentLaunch and its SpokeHook, then one for the PoolManager's `Swap` events filtered by the spoke pool
 * ids (topic 1), so the PoolManager's other pools cost nothing. Events, derived tables and the cursor change in one
 * database transaction; a re-index never applies an event twice.
 */

const STATE_ID = "launch";
type Tx = postgres.TransactionSql<{}>;
type Args = Record<string, unknown>;
const lower = (a: unknown) => String(a).toLowerCase();
const str = (v: unknown) => String(v);
const abs = (v: unknown) => {
  const n = BigInt(str(v));
  return (n < 0n ? -n : n).toString();
};

export const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
/** AgentLaunch's events: its interface plus `IOrryBurnEvents.Burned` (source 50). */
const launchEventsAbi = [...iAgentLaunchAbi, ...iOrryBurnEventsAbi] as Abi;
const linkAbi = parseAbi(["function hook() view returns (address)", "function poolManager() view returns (address)"]);

export interface LaunchLinks {
  hook: Address;
  poolManager: Address;
}

/** The hook and PoolManager of an AgentLaunch (immutables, read once). */
export async function launchLinks(chain: Chain, lc: LaunchConfig): Promise<LaunchLinks> {
  const [hook, poolManager] = await Promise.all([
    chain.public.readContract({ address: lc.agentLaunch, abi: linkAbi, functionName: "hook" }),
    chain.public.readContract({ address: lc.agentLaunch, abi: linkAbi, functionName: "poolManager" }),
  ]);
  return { hook: hook as Address, poolManager: poolManager as Address };
}

function decode(abi: Abi, log: Log): { event: string; args: Args } {
  try {
    const d = decodeEventLog({ abi, data: log.data, topics: log.topics });
    return { event: d.eventName ?? "unknown", args: toJson(d.args) as Args };
  } catch {
    return { event: "unknown", args: { topics: log.topics.join(","), data: log.data } };
  }
}

async function insertCoin(tx: Tx, a: Args, log: Log, time: Date): Promise<void> {
  await tx`insert into launch_coins (coin, agent_id, creator, pool_id, name, symbol, launched_time, launched_block, launched_tx,
      public_open_at, liquidity, pooled, first_buy_orry, first_buy_coins)
    values (${lower(a.coin)}, ${str(a.agentId)}, ${lower(a.creator)}, ${lower(a.poolId)}, ${str(a.name)}, ${str(a.symbol)}, ${time},
      ${log.blockNumber!.toString()}, ${log.transactionHash!}, ${str(a.publicOpenAt)}, ${str(a.liquidity)}, ${str(a.pooled)},
      ${str(a.firstBuyOrry)}, ${str(a.firstBuyCoins)})
    on conflict do nothing`;
}

async function applyLaunch(tx: Tx, event: string, a: Args, log: Log, time: Date): Promise<void> {
  switch (event) {
    case "EarlyBuy":
      await tx`insert into launch_trades (tx_hash, log_index, block_number, coin, kind, account, orry, coins, block_time)
        values (${log.transactionHash!}, ${log.logIndex!}, ${log.blockNumber!.toString()}, ${lower(a.coin)}, 'early', ${lower(a.buyer)}, ${str(a.orryIn)},
          ${str(a.coinsOut)}, ${time}) on conflict do nothing`;
      await tx`update launch_coins set early_buys = early_buys + 1 where coin = ${lower(a.coin)}`;
      return;
    case "FeesDistributed":
      await tx`update launch_coins set fees_distributed = fees_distributed + ${str(a.total)}::numeric,
          creator_fees = creator_fees + ${str(a.creator)}::numeric, earn_fees = earn_fees + ${str(a.earn)}::numeric,
          owner_fees = owner_fees + ${str(a.owner)}::numeric, burned = burned + ${str(a.burned)}::numeric
        where coin = ${lower(a.coin)}`;
      return;
    case "CreatorFeesClaimed":
      await tx`update launch_coins set creator_claimed = creator_claimed + ${str(a.amount)}::numeric where coin = ${lower(a.coin)}`;
      return;
    default:
      return; // Launched is applied first; EarnNotified, Burned (source 50), SpokeOpened and SpokeFee stay in launch_events
  }
}

/** A PoolManager swap of a spoke: amounts are the pool's (the swapper's side, before the hook fee). A swap through
 * Orrery's router is credited to the trader its `Traded` event names; any other router stays the account. */
async function applySwap(tx: Tx, coin: string, a: Args, log: Log, time: Date, agentLaunch: string, traders: Map<string, string>): Promise<void> {
  const amount0 = BigInt(str(a.amount0));
  await tx`update launch_coins set volume_orry = volume_orry + ${abs(a.amount0)}::numeric, trades = trades + 1,
      last_sqrt_price = ${str(a.sqrtPriceX96)} where coin = ${coin}`;
  // AgentLaunch's own swaps are the first buy (in Launched) and early buys (in EarlyBuy, with the real buyer)
  if (lower(a.sender) === agentLaunch) return;
  await tx`insert into launch_trades (tx_hash, log_index, block_number, coin, kind, account, orry, coins, block_time)
    values (${log.transactionHash!}, ${log.logIndex!}, ${log.blockNumber!.toString()}, ${coin}, ${amount0 < 0n ? "buy" : "sell"},
      ${traders.get(`${log.transactionHash!.toLowerCase()}:${coin}`) ?? lower(a.sender)},
      ${abs(a.amount0)}, ${abs(a.amount1)}, ${time}) on conflict do nothing`;
}

/** One step: index up to `range` confirmed blocks. */
export async function indexLaunchOnce(
  lc: LaunchConfig,
  chain: Chain,
  sql: Sql,
  confirmations: number,
  opts: { range?: bigint; links?: LaunchLinks } = {},
): Promise<{ last: bigint; head: bigint; lag: bigint; logs: number }> {
  const range = opts.range ?? 10_000n;
  const links = opts.links ?? (await launchLinks(chain, lc));
  const [state] = await sql<{ last_block: string }[]>`select last_block from indexer_state where id = ${STATE_ID}`;
  const from = state ? BigInt(state.last_block) + 1n : lc.startBlock;
  const head = await chain.public.getBlockNumber();
  const depth = BigInt(confirmations);
  const safe = head > depth ? head - depth : 0n;
  if (from > safe) {
    await sql`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${(from - 1n).toString()}, ${head.toString()})
      on conflict (id) do update set head_block = excluded.head_block, updated_at = now()`;
    return { last: from - 1n, head, lag: head - (from - 1n), logs: 0 };
  }
  const to = from + range - 1n < safe ? from + range - 1n : safe;
  const al = lc.agentLaunch.toLowerCase();
  const hook = links.hook.toLowerCase();

  const router = lc.spokeRouter?.toLowerCase() ?? null;
  const own = [lc.agentLaunch, links.hook, ...(lc.spokeRouter ? [lc.spokeRouter] : [])];
  const ownLogs = (await chain.public.getLogs({ address: own, fromBlock: from, toBlock: to })) as Log[];
  const abiOf = (address: string): Abi => (address === hook ? (iSpokeHookAbi as Abi) : address === router ? (spokeRouterAbi as Abi) : launchEventsAbi);
  const decoded = ownLogs.map((log) => ({ log, ...decode(abiOf(log.address.toLowerCase()), log) }));
  const traders = new Map<string, string>();
  for (const d of decoded) {
    if (d.event === "Traded") traders.set(`${d.log.transactionHash!.toLowerCase()}:${lower(d.args.coin)}`, lower(d.args.account));
  }
  const pools = new Map<string, string>(
    (await sql<{ pool_id: string; coin: string }[]>`select pool_id, coin from launch_coins`).map((r) => [r.pool_id, r.coin]),
  );
  for (const d of decoded) if (d.event === "Launched") pools.set(lower(d.args.poolId), lower(d.args.coin));
  const swapLogs = pools.size
    ? ((await chain.public.getLogs({
        address: links.poolManager,
        event: swapEvent,
        args: { id: [...pools.keys()] as Hex[] } as never,
        fromBlock: from,
        toBlock: to,
      })) as Log[])
    : [];
  const all = [...ownLogs, ...swapLogs].sort((x, y) =>
    x.blockNumber! === y.blockNumber! ? x.logIndex! - y.logIndex! : x.blockNumber! < y.blockNumber! ? -1 : 1,
  );
  const times = await blockTimes(chain, all);
  const swaps = swapLogs.map((log) => ({ log, ...decode([swapEvent] as Abi, log) }));

  await sql.begin(async (tx) => {
    const fresh = new Set<string>();
    for (const d of [...decoded, ...swaps]) {
      const log = d.log;
      const ins = await tx`insert into launch_events (block_number, log_index, tx_hash, address, event, args, block_time)
        values (${log.blockNumber!.toString()}, ${log.logIndex!}, ${log.transactionHash!}, ${log.address.toLowerCase()}, ${d.event},
          ${tx.json(d.args as never)}, ${times.get(log.blockNumber!)!}) on conflict do nothing returning log_index`;
      if (ins.length === 1) fresh.add(`${log.blockNumber}:${log.logIndex}`);
    }
    const isFresh = (log: Log) => fresh.has(`${log.blockNumber}:${log.logIndex}`);
    // a launch's first buy swaps before its Launched event in the same transaction: coins first, then everything in order
    for (const d of decoded) if (d.event === "Launched" && isFresh(d.log)) await insertCoin(tx, d.args, d.log, times.get(d.log.blockNumber!)!);
    const ordered = [...decoded, ...swaps].sort((x, y) =>
      x.log.blockNumber! === y.log.blockNumber! ? x.log.logIndex! - y.log.logIndex! : x.log.blockNumber! < y.log.blockNumber! ? -1 : 1,
    );
    for (const d of ordered) {
      if (!isFresh(d.log)) continue;
      const time = times.get(d.log.blockNumber!)!;
      if (d.log.address.toLowerCase() === links.poolManager.toLowerCase()) {
        const coin = pools.get(lower(d.args.id));
        if (coin) await applySwap(tx, coin, d.args, d.log, time, al, traders);
      } else if (d.log.address.toLowerCase() === al) {
        await applyLaunch(tx, d.event, d.args, d.log, time);
      }
    }
    await tx`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${to.toString()}, ${head.toString()})
      on conflict (id) do update set last_block = excluded.last_block, head_block = excluded.head_block, updated_at = now()`;
  });
  return { last: to, head, lag: head - to, logs: all.length };
}

export async function runLaunchIndexer(
  lc: LaunchConfig,
  chain: Chain,
  sql: Sql,
  confirmations: number,
  signal?: AbortSignal,
  log: (m: string) => void = () => {},
): Promise<void> {
  let links: LaunchLinks | undefined;
  while (!signal?.aborted) {
    try {
      links ??= await launchLinks(chain, lc);
      const r = await indexLaunchOnce(lc, chain, sql, confirmations, { links });
      if (r.lag <= BigInt(confirmations)) await new Promise((res) => setTimeout(res, 1_000));
    } catch (e) {
      log(`launch indexer step failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      await new Promise((res) => setTimeout(res, 5_000));
    }
  }
}
