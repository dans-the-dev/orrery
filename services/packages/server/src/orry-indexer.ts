import type postgres from "postgres";
import { BaseError, ContractFunctionZeroDataError, decodeEventLog, getAbiItem, type Abi, type Address, type Hex, type Log, type ReadContractReturnType } from "viem";
import {
  NATIVE_ETH,
  iEarnVaultAbi,
  iEarnVaultFactoryAbi,
  iOrryBurnEventsAbi,
  iOrryBuybackAbi,
  iOrryLensAbi,
  iOrryRewardsRouterAbi,
  iOrryStakingAbi,
  iOrreryHookAbi,
  iOrreryTreasuryAbi,
  poolManagerAbi,
  orryCreditsFor,
} from "@orrery/shared";
import type { Config, OrryConfig } from "./config.js";
import type { Chain } from "./chain.js";
import type { Sql } from "./db.js";
import { toJson } from "./check.js";
import { hubsOf, sampleOnce } from "./orry-price.js";
import { logLine } from "./log.js";

/**
 * ORRY indexer (build spec §5, workspace rule 7), multi-pair (R-35 to R-38). Per range of at most 10,000 blocks: one
 * address-filtered `eth_getLogs` for the ORRY contracts and every Earn vault the factory lists (a vault created inside
 * the range gets one more call for that range), and one for PoolManager `Swap` with every hub's poolId as topic 1. The
 * hook's registry and the factory's list only grow; new entries are read once. Indexes only up to `head -
 * confirmations`, so every stored event is at the confirmation depth and credits are granted in the same database
 * transaction that stores the `CreditsPaid`. Health is lag against the head, never "backfill finished".
 */

export type OrrySource = "hook" | "vault" | "factory" | "staking" | "router" | "treasury" | "buyback" | "pool";

const ABIS: Record<OrrySource, Abi> = {
  hook: iOrreryHookAbi as Abi,
  vault: iEarnVaultAbi as Abi,
  factory: iEarnVaultFactoryAbi as Abi,
  staking: iOrryStakingAbi as Abi,
  router: [...iOrryRewardsRouterAbi, ...iOrryBurnEventsAbi] as Abi,
  treasury: [...iOrreryTreasuryAbi, ...iOrryBurnEventsAbi] as Abi,
  buyback: [...iOrryBuybackAbi, ...iOrryBurnEventsAbi] as Abi,
  pool: poolManagerAbi as Abi,
};

const STATE_ID = "orry";
const swapEvent = getAbiItem({ abi: poolManagerAbi, name: "Swap" });

function sources(rc: OrryConfig, vaults: string[]): Map<string, OrrySource> {
  return new Map<string, OrrySource>([
    [rc.hook.toLowerCase(), "hook"],
    [rc.earnFactory.toLowerCase(), "factory"],
    ...vaults.map((v): [string, OrrySource] => [v.toLowerCase(), "vault"]),
    [rc.staking.toLowerCase(), "staking"],
    [rc.router.toLowerCase(), "router"],
    [rc.treasury.toLowerCase(), "treasury"],
    [rc.buyback.toLowerCase(), "buyback"],
  ]);
}

type Args = Record<string, string | number | boolean>;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type Tx = postgres.TransactionSql<{}>;

function decode(source: OrrySource, log: Log): { event: string; args: Args } {
  try {
    const d = decodeEventLog({ abi: ABIS[source], data: log.data, topics: log.topics });
    return { event: d.eventName ?? "unknown", args: toJson(d.args) as Args };
  } catch {
    return { event: "unknown", args: { topics: log.topics.join(","), data: log.data } };
  }
}

const lower = (a: unknown) => String(a).toLowerCase();

async function claimed(tx: Tx, account: string, asset: string, amount: string): Promise<void> {
  await tx`insert into orry_claimed (address, asset, amount) values (${lower(account)}, ${lower(asset)}, ${amount})
    on conflict (address, asset) do update set amount = orry_claimed.amount + excluded.amount`;
}

async function markDirty(tx: Tx, address: string): Promise<void> {
  await tx`insert into orry_accounts (address, dirty) values (${lower(address)}, true)
    on conflict (address) do update set dirty = true`;
}

async function staker(tx: Tx, address: string, plainActive: string, plainLeaving: string, agentActive: string): Promise<void> {
  await tx`insert into orry_stakers (address, plain_active, plain_leaving, agent_active)
    values (${lower(address)}, greatest(${plainActive}::numeric, 0), greatest(${plainLeaving}::numeric, 0), greatest(${agentActive}::numeric, 0))
    on conflict (address) do update set
      plain_active = orry_stakers.plain_active + ${plainActive}::numeric,
      plain_leaving = orry_stakers.plain_leaving + ${plainLeaving}::numeric,
      agent_active = orry_stakers.agent_active + ${agentActive}::numeric`;
}

const neg = (v: unknown) => `-${String(v)}`;

/** Applies one new event to the derived tables, in chain order. */
async function apply(cfg: Config, tx: Tx, source: OrrySource, event: string, a: Args, log: Log): Promise<void> {
  if (source === "staking") {
    switch (event) {
      case "Staked":
        await staker(tx, String(a.account), String(a.amount), "0", "0");
        return markDirty(tx, String(a.account));
      case "UnstakeRequested":
        await staker(tx, String(a.account), neg(a.amount), String(a.amount), "0");
        return markDirty(tx, String(a.account));
      case "Withdrawn":
        await staker(tx, String(a.account), "0", neg(a.amount), "0");
        return markDirty(tx, String(a.account));
      case "AgentStaked":
        await tx`insert into orry_agent_positions (agent_id, owner, staker, active)
          values (${String(a.agentId)}, ${lower(a.owner)}, ${lower(a.staker)}, ${String(a.amount)})
          on conflict (agent_id, owner) do update set staker = excluded.staker, active = orry_agent_positions.active + excluded.active`;
        await staker(tx, String(a.staker), "0", "0", String(a.amount));
        return markDirty(tx, String(a.staker));
      case "AgentUnstakeRequested": {
        const [p] = await tx<{ staker: string }[]>`update orry_agent_positions
          set active = active - ${String(a.amount)}::numeric, leaving = leaving + ${String(a.amount)}::numeric
          where agent_id = ${String(a.agentId)} and owner = ${lower(a.owner)} returning staker`;
        if (!p) return;
        await staker(tx, p.staker, "0", "0", neg(a.amount));
        return markDirty(tx, p.staker);
      }
      case "AgentLockExtended":
        await tx`update orry_agent_positions set locked_until = ${String(a.lockedUntil)}
          where agent_id = ${String(a.agentId)} and owner = ${lower(a.owner)}`;
        return;
      case "AgentWithdrawn":
        await tx`update orry_agent_positions set leaving = leaving - ${String(a.amount)}::numeric
          where agent_id = ${String(a.agentId)} and owner = ${lower(a.owner)}`;
        return markDirty(tx, String(a.staker));
      case "RewardsClaimed":
        await claimed(tx, String(a.account), NATIVE_ETH, String(a.ethAmount));
        await claimed(tx, String(a.account), cfg.orry!.token, String(a.orryAmount));
        return markDirty(tx, String(a.account));
    }
    return;
  }
  if (source === "vault") {
    const vault = lower(log.address);
    switch (event) {
      case "Deposited":
        await tx`insert into orry_earn_shares (address, vault, shares) values (${lower(a.account)}, ${vault}, ${String(a.shares)})
          on conflict (address, vault) do update set shares = orry_earn_shares.shares + excluded.shares`;
        return markDirty(tx, String(a.account));
      case "Withdrawn":
        await tx`update orry_earn_shares set shares = shares - ${String(a.shares)}::numeric where address = ${lower(a.account)} and vault = ${vault}`;
        return markDirty(tx, String(a.account));
      case "FeesClaimed": {
        const [v] = await tx<{ quote: string }[]>`select quote from orry_vaults where vault = ${vault}`;
        if (!v) throw new Error(`FeesClaimed from a vault the factory does not list: ${vault}`);
        await claimed(tx, String(a.account), v.quote, String(a.quoteAmount));
        await claimed(tx, String(a.account), cfg.orry!.token, String(a.orryAmount));
        return markDirty(tx, String(a.account));
      }
    }
    return;
  }
  if (source === "treasury") {
    if (event === "CreditsPaid") return grantCredits(cfg, tx, a, log);
    if (event === "VerificationBurned") {
      await tx`update orry_quotes set used_tx = ${log.transactionHash!}
        where quote_id = ${lower(a.quoteId)} and kind = 'verification' and used_tx is null`;
    }
  }
}

/**
 * Grants checks once per quoteId, and only for a quote this API signed with the same buyer, packs and ORRY amount: a pack
 * quote grants its packs at the ORRY rate, a pay-as-you-go quote the credits stored with it.
 * A `CreditsPaid` that matches no stored quote (another signer, or a leaked quote-signer key) is recorded with 0 checks.
 */
async function grantCredits(cfg: Config, tx: Tx, a: Args, log: Log): Promise<void> {
  const quoteId = lower(a.quoteId);
  const buyer = lower(a.buyer);
  const packs = Number(a.packs);
  const [q] = await tx<{ kind: string; buyer: string; packs: number | null; credits: string | null; orry_amount: string }[]>`select kind,
    buyer, packs, credits::text, orry_amount from orry_quotes where quote_id = ${quoteId}`;
  // A pack quote grants by its packs; a pay-as-you-go quote ('checks', its packs = checks) grants the credits stored with it.
  const kind = q?.kind === "checks" ? "checks" : "credits";
  const matched =
    !!q && (q.kind === "credits" || (q.kind === "checks" && q.credits !== null)) && q.buyer === buyer && q.packs === packs && BigInt(q.orry_amount) === BigInt(String(a.orryAmount));
  const credits = !matched ? 0n : kind === "checks" ? BigInt(q!.credits!) : orryCreditsFor(packs, cfg.packSize);
  const ins = await tx`insert into orry_credit_grants (quote_id, buyer, packs, orry_amount, credits, matched, tx_hash, block_number, kind)
    values (${quoteId}, ${buyer}, ${packs}, ${String(a.orryAmount)}, ${credits.toString()}, ${matched}, ${log.transactionHash!}, ${log.blockNumber!.toString()}, ${kind})
    on conflict (quote_id) do nothing returning quote_id`;
  if (ins.length === 0 || !matched) return;
  await tx`insert into credit_accounts (address, credits) values (${buyer}, ${credits.toString()})
    on conflict (address) do update set credits = credit_accounts.credits + ${credits.toString()}`;
  await tx`update orry_quotes set used_tx = ${log.transactionHash!} where quote_id = ${quoteId}`;
}

export async function blockTimes(chain: Chain, logs: Log[]): Promise<Map<bigint, Date>> {
  const out = new Map<bigint, Date>();
  for (const log of logs) {
    const n = log.blockNumber!;
    if (out.has(n)) continue;
    // Newer nodes put the block time on the log itself; otherwise one block read per distinct block. Some nodes send the
    // field as 0x0 (the 46630 sequencer RPC does), so a zero counts as missing.
    const raw = (log as { blockTimestamp?: bigint | Hex | null }).blockTimestamp;
    const onLog = raw !== undefined && raw !== null ? BigInt(raw) : 0n;
    const ts = onLog > 0n ? onLog : (await chain.public.getBlock({ blockNumber: n })).timestamp;
    out.set(n, new Date(Number(ts) * 1000));
  }
  return out;
}

export interface OrryIndexerOptions {
  range?: bigint;
}

/** One step: index up to `range` confirmed blocks. Returns the new cursor and the lag behind the head in blocks. */
export async function indexOrryOnce(
  cfg: Config,
  chain: Chain,
  sql: Sql,
  opts: OrryIndexerOptions = {},
): Promise<{ last: bigint; head: bigint; lag: bigint; logs: number }> {
  const rc = cfg.orry;
  if (!rc) throw new Error("ORRY contracts are not configured");
  const range = opts.range ?? 10_000n;
  const [state] = await sql<{ last_block: string }[]>`select last_block from indexer_state where id = ${STATE_ID}`;
  const from = state ? BigInt(state.last_block) + 1n : rc.startBlock;
  const head = await chain.public.getBlockNumber();
  const depth = BigInt(cfg.confirmations);
  const safe = head > depth ? head - depth : 0n;
  if (from > safe) {
    await sql`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${(from - 1n).toString()}, ${head.toString()})
      on conflict (id) do update set head_block = excluded.head_block, updated_at = now()`;
    return { last: from - 1n, head, lag: head - (from - 1n), logs: 0 };
  }
  const to = from + range - 1n < safe ? from + range - 1n : safe;
  // the registry and the vault list as they stand now; both only grow, so they cover every event up to `to`
  const [hubs, vaults] = await Promise.all([hubsOf(rc, chain), vaultsOf(rc, chain, sql)]);
  const map = sources(rc, vaults.map((v) => v.vault));
  const poolIds = hubs.map((h) => h.poolId.toLowerCase());
  const [contractLogs, swapLogs] = await Promise.all([
    chain.public.getLogs({ address: [...map.keys()] as Address[], fromBlock: from, toBlock: to }),
    poolIds.length
      ? chain.public.getLogs({ address: rc.poolManager, event: swapEvent, args: { id: poolIds as Hex[] }, fromBlock: from, toBlock: to })
      : Promise.resolve([] as Log[]),
  ]);
  const tagged: { log: Log; source: OrrySource }[] = [
    ...contractLogs.map((log) => ({ log: log as Log, source: map.get(log.address.toLowerCase())! })),
    ...(swapLogs as Log[])
      .filter((log) => log.address.toLowerCase() === rc.poolManager.toLowerCase() && poolIds.includes(log.topics[1]?.toLowerCase() ?? ""))
      .map((log) => ({ log, source: "pool" as const })),
  ].sort((x, y) => (x.log.blockNumber! === y.log.blockNumber! ? x.log.logIndex! - y.log.logIndex! : x.log.blockNumber! < y.log.blockNumber! ? -1 : 1));
  const times = await blockTimes(chain, tagged.map((t) => t.log));
  await sql.begin(async (tx) => {
    for (const h of hubs) {
      await tx`insert into orry_hubs (position, quote, pool_id, usd_feed, orry_is_currency0)
        values (${h.position}, ${lower(h.quote)}, ${lower(h.poolId)}, ${lower(h.usdFeed)}, ${h.orryIsCurrency0}) on conflict do nothing`;
    }
    for (const { log, source } of tagged) {
      const { event, args } = decode(source, log);
      const ins = await tx`insert into orry_events (block_number, log_index, tx_hash, address, source, event, args, block_time)
        values (${log.blockNumber!.toString()}, ${log.logIndex!}, ${log.transactionHash!}, ${log.address.toLowerCase()}, ${source},
          ${event}, ${tx.json(args as never)}, ${times.get(log.blockNumber!)!}) on conflict do nothing returning log_index`;
      if (ins.length === 1) await apply(cfg, tx, source, event, args, log);
    }
    await tx`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${to.toString()}, ${head.toString()})
      on conflict (id) do update set last_block = excluded.last_block, head_block = excluded.head_block, updated_at = now()`;
    await tx`insert into orry_height (id, high_block) values (true, ${to.toString()})
      on conflict (id) do update set high_block = greatest(orry_height.high_block, excluded.high_block)`;
  });
  return { last: to, head, lag: head - to, logs: tagged.length };
}

const vaultCache = new Map<string, { position: number; vault: Address; quote: Address }[]>();

/** The factory's vault list (`vaultCount`, `vaultAt`, each vault's `quote`), stored in `orry_vaults`; only new entries are read. */
export async function vaultsOf(rc: OrryConfig, chain: Chain, sql: Sql): Promise<{ position: number; vault: Address; quote: Address }[]> {
  const key = rc.earnFactory.toLowerCase();
  const known = vaultCache.get(key) ?? [];
  const count = Number(await chain.public.readContract({ address: rc.earnFactory, abi: iEarnVaultFactoryAbi, functionName: "vaultCount" }));
  for (let i = known.length; i < count; i++) {
    const vault = await chain.public.readContract({ address: rc.earnFactory, abi: iEarnVaultFactoryAbi, functionName: "vaultAt", args: [BigInt(i)] });
    const quote = await chain.public.readContract({ address: vault, abi: iEarnVaultAbi, functionName: "quote" });
    await sql`insert into orry_vaults (position, vault, quote) values (${i}, ${lower(vault)}, ${lower(quote)}) on conflict do nothing`;
    known.push({ position: i, vault, quote });
  }
  vaultCache.set(key, known);
  return known;
}

export async function orryLag(sql: Sql): Promise<{ last: bigint; head: bigint; lag: bigint; updatedAt: Date } | null> {
  const [s] = await sql<{ last_block: string; head_block: string; updated_at: Date }[]>`select last_block, head_block, updated_at
    from indexer_state where id = ${STATE_ID}`;
  if (!s) return null;
  return { last: BigInt(s.last_block), head: BigInt(s.head_block), lag: BigInt(s.head_block) - BigInt(s.last_block), updatedAt: s.updated_at };
}

/**
 * The block the derived tables are complete through, and `account`'s claimed totals per asset, read in one statement (one
 * database snapshot): the cursor, or the high-water block while a re-index has moved the cursor back (the totals already
 * hold every event up to it). Null until the indexer has passed `startBlock`. Earned all time is these totals plus pending
 * read at this block; claimed indexed to one block plus pending read at another leaves a fresh claim in neither term.
 */
export async function claimedAtHeight(sql: Sql | Tx, rc: OrryConfig, account: string): Promise<{ height: bigint | null; claimed: Map<string, bigint> }> {
  const a = account.toLowerCase();
  const [r] = await sql<{ height: string | null; claimed: { asset: string; amount: string }[] | null }[]>`select
    greatest((select last_block from indexer_state where id = ${STATE_ID}), (select high_block from orry_height))::text as height,
    (select json_agg(json_build_object('asset', asset, 'amount', amount::text)) from orry_claimed where address = ${a}) as claimed`;
  const height = r?.height ? BigInt(r.height) : null;
  const claimed = new Map((r?.claimed ?? []).map((c) => [c.asset, BigInt(c.amount)]));
  return { height: height !== null && height >= rc.startBlock ? height : null, claimed };
}

/** Assets in the fixed order of `earnedAllTime`: ORRY, native ETH, then every other hub quote in the hook's order. */
export function assetOrder(rc: OrryConfig, hubQuotes: string[]): string[] {
  const out = [rc.token.toLowerCase(), NATIVE_ETH.toLowerCase()];
  for (const q of hubQuotes.map((x) => x.toLowerCase())) if (!out.includes(q)) out.push(q);
  return out;
}

/** Claimed plus pending per asset at one block (`claimables` read at the same height as the claimed totals). */
export function earnedPerAsset(rc: OrryConfig, order: string[], claimed: Map<string, bigint>, c: Claimables): Map<string, bigint> {
  const out = new Map(order.map((a) => [a, claimed.get(a) ?? 0n]));
  const add = (asset: string, v: bigint) => out.set(asset.toLowerCase(), (out.get(asset.toLowerCase()) ?? 0n) + v);
  for (const e of c.earn) {
    add(e.quote, e.feesQuote);
    add(rc.token, e.feesOrry);
  }
  add(NATIVE_ETH, c.stakeRewardsEth);
  add(rc.token, c.stakeRewardsOrry);
  for (const [asset, v] of claimed) if (!out.has(asset)) out.set(asset, v);
  return out;
}

export type Claimables = ReadContractReturnType<typeof iOrryLensAbi, "claimables">;
export type AgentClaimables = ReadContractReturnType<typeof iOrryLensAbi, "agentClaimables">;
const NO_CLAIMABLES: Claimables = { earn: [], stakeActive: 0n, stakeLeaving: 0n, stakeReadyAt: 0n, stakeRewardsEth: 0n, stakeRewardsOrry: 0n };

/** A lens read at `blockNumber`; `empty` when the lens was not deployed yet at that block (it has code now). */
async function lensAt<T>(rc: OrryConfig, chain: Chain, read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionZeroDataError) && (await chain.public.getCode({ address: rc.lens }))) return empty;
    throw e;
  }
}

export const claimablesAt = (rc: OrryConfig, chain: Chain, account: Address, blockNumber: bigint) =>
  lensAt(rc, chain, () => chain.public.readContract({ address: rc.lens, abi: iOrryLensAbi, functionName: "claimables", args: [account], blockNumber }), NO_CLAIMABLES);

export const agentClaimablesAt = (rc: OrryConfig, chain: Chain, account: Address, ids: bigint[], owners: Address[], blockNumber: bigint) =>
  lensAt(
    rc,
    chain,
    () => chain.public.readContract({ address: rc.lens, abi: iOrryLensAbi, functionName: "agentClaimables", args: [account, ids, owners], blockNumber }),
    [] as AgentClaimables,
  );

/**
 * Earned all time per asset for the earners leaderboard: claimed totals plus `OrryLens.claimables` pending, both at the
 * indexer's height (`claimedAtHeight`), for accounts touched by an event since their last read and for accounts still
 * earning once their read is older than `snapshotSeconds`. Bounded per call. A stored figure is only replaced by one
 * measured at the same or a later block, so it never moves back.
 */
export async function snapshotAccounts(cfg: Config, chain: Chain, sql: Sql): Promise<number> {
  const rc = cfg.orry;
  if (!rc) return 0;
  const rows = await sql<{ address: string }[]>`select a.address from orry_accounts a left join orry_stakers s on s.address = a.address
    where a.dirty or ((exists (select 1 from orry_earn_shares e where e.address = a.address and e.shares > 0)
        or coalesce(s.plain_active + s.agent_active, 0) > 0)
      and (a.snapshot_at is null or a.snapshot_at < now() - make_interval(secs => ${rc.snapshotSeconds})))
    order by a.snapshot_at asc nulls first limit ${rc.snapshotMaxAccounts}`;
  if (rows.length === 0) return 0;
  const order = assetOrder(rc, (await hubsOf(rc, chain)).map((h) => h.quote));
  for (const { address } of rows) {
    const h = await claimedAtHeight(sql, rc, address);
    if (h.height === null) break;
    const c = await claimablesAt(rc, chain, address as Address, h.height);
    const earned = earnedPerAsset(rc, order, h.claimed, c);
    const height = h.height.toString();
    await sql.begin(async (tx) => {
      const ok = await tx`update orry_accounts set earned_block = ${height}, snapshot_at = now(), dirty = false
        where address = ${address} and (earned_block is null or earned_block <= ${height}) returning address`;
      if (ok.length === 0) return;
      await tx`delete from orry_earned where address = ${address}`;
      for (const [asset, amount] of earned) {
        await tx`insert into orry_earned (address, asset, amount) values (${address}, ${asset}, ${amount.toString()})`;
      }
    });
  }
  return rows.length;
}

/** Quotes never used and expired for a day are deleted. */
export async function pruneQuotes(sql: Sql): Promise<void> {
  await sql`delete from orry_quotes where used_tx is null and expiry < extract(epoch from now())::bigint - 86400`;
}

export async function runOrryIndexer(cfg: Config, chain: Chain, sql: Sql, signal?: AbortSignal, log: (m: string) => void = () => {}): Promise<void> {
  while (!signal?.aborted) {
    try {
      const r = await indexOrryOnce(cfg, chain, sql);
      await sampleOnce(cfg, chain, sql);
      if (r.lag <= BigInt(cfg.confirmations) + 600n) {
        await snapshotAccounts(cfg, chain, sql);
        await pruneQuotes(sql);
      }
      if (r.lag <= BigInt(cfg.confirmations)) await new Promise((res) => setTimeout(res, 2_000));
    } catch (e) {
      log(`orry indexer step failed: ${logLine(e)}`);
      await new Promise((res) => setTimeout(res, 5_000));
    }
  }
}
