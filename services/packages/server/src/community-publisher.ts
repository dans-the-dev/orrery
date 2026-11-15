import { type Abi, type Address } from "viem";
import { cashbackRewardsAbi, monthIndex } from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { buildAccruals, feeRows, type Accrual, type Link } from "./community-ledger.js";
import { stakeOf } from "./facilitator-public.js";

/**
 * Builds the cashback and referral accruals for fees paid in the last `MAX_LAG` window that the sink has not recorded,
 * and (with `send`) posts them to `CashbackRewards.accrue` from the publisher key, in batches. The contract bounds
 * each record (RF-2, RF-3); this job only decides what is owed. Run: `community-publisher` (dry run) or `--send`.
 */
const LAG_DAYS = 34; // inside the contract's 35 day MAX_LAG
const BATCH = 40;

export async function pendingAccruals(cfg: Config, chain: Chain, sql: Sql): Promise<Accrual[]> {
  const c = cfg.community!;
  if (!c.cashback) return [];
  // chain time: the sink checks MAX_LAG and the month against block.timestamp
  const now = new Date(Number((await chain.public.getBlock()).timestamp) * 1000);
  const from = new Date(now.getTime() - LAG_DAYS * 86_400_000);
  const rows = await feeRows(sql, cfg, from, new Date(now.getTime() + 1000));
  const links = new Map<string, Link>(
    (await sql<{ referee: string; referrer: string; linked_at: Date }[]>`select referee, referrer, linked_at from community_referrals`).map((r) => [
      r.referee,
      { referrer: r.referrer, linkedAt: r.linked_at },
    ]),
  );
  const merchants = new Set((await sql<{ merchant: string }[]>`select merchant from merchants`.catch(() => [])).map((m) => m.merchant));
  const referrers = [...new Set([...links.values()].map((l) => l.referrer))];
  const stakers = new Set<string>();
  if (cfg.facilitator?.feeTiers) {
    for (const r of referrers) {
      const s = await stakeOf(cfg, chain, r as Address).catch(() => ({ usd: 0n }));
      if (s.usd >= c.stakerMinUsd) stakers.add(r);
    }
  }
  const seen = new Set(
    (await sql<{ ref: string; kind: number; account: string }[]>`select ref, kind, account from community_accruals`).map((a) => `${a.ref}:${a.kind}:${a.account}`),
  );
  const month = BigInt(monthIndex(now));
  const capUsed = new Map<string, bigint>();
  for (const r of referrers) {
    capUsed.set(r, (await chain.public.readContract({ address: c.cashback, abi: cashbackRewardsAbi as Abi, functionName: "referralUsd", args: [r as Address, month] })) as bigint);
  }
  return buildAccruals(c, rows, links, merchants, stakers, seen, capUsed);
}

export async function publishAccruals(cfg: Config, chain: Chain, sql: Sql, send: boolean, log: (m: string) => void = console.log): Promise<number> {
  const c = cfg.community!;
  const list = await pendingAccruals(cfg, chain, sql);
  log(`community publisher: ${list.length} accrual(s) pending`);
  if (!send || list.length === 0) {
    for (const a of list.slice(0, 20)) log(`  ${a.kind === 1 ? "cashback" : "referral"} ${a.account} ${a.rewardUsd} of ${a.feeUsd} (ref ${a.ref.slice(0, 10)})`);
    return 0;
  }
  if (!c.publisherKey || !c.cashback) throw new Error("ORRERY_COMMUNITY_PUBLISHER_KEY and ORRERY_COMMUNITY_CASHBACK are needed to send");
  const wallet = chain.wallet(c.publisherKey);
  let sent = 0;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const hash = await wallet.writeContract({ address: c.cashback, abi: cashbackRewardsAbi, functionName: "accrue", args: [batch], chain: wallet.chain, account: wallet.account });
    const r = await chain.public.waitForTransactionReceipt({ hash, timeout: cfg.receiptTimeoutMs });
    if (r.status !== "success") throw new Error(`accrue reverted in ${hash}`);
    sent += batch.length;
    log(`  sent ${batch.length} in ${hash}`);
  }
  return sent;
}
