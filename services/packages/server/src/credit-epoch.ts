import { keccak256, toHex, type Abi, type Address } from "viem";
import { attesterFeeSplitterAbi, attesterRegistryAbi } from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { CreditConfig } from "./credit-config.js";
import type { Sql } from "./db.js";

/**
 * Lane L4 weekly epoch job, planning half (`docs/updates/L4-CREDIT-SPEC.md` 6.4). It reads the chain and the index and
 * returns the transactions the attestor owner (or anyone, for the permissionless ones) would send. It sends nothing.
 */

export interface ForwardedResult {
  staker: string;
  agentId: string;
  observedAt: bigint;
  endpointsLive: boolean;
  registrationValid: boolean;
}

export interface Disagreement {
  staker: string;
  results: number;
  disagreements: number;
  rateBps: number;
  over: boolean;
}

/**
 * Per agent, each attester's latest result counts once; the majority of `endpointsLive && registrationValid` among the
 * attesters that probed the agent is the reference (a tie has no majority and counts for nobody). An attester's rate is
 * its results that differ from a majority over its results that met one.
 */
export function disagreements(rows: ForwardedResult[], barBps: number): Disagreement[] {
  const latest = new Map<string, ForwardedResult>();
  for (const r of rows) {
    const k = `${r.agentId}:${r.staker}`;
    const prev = latest.get(k);
    if (!prev || r.observedAt > prev.observedAt) latest.set(k, r);
  }
  const byAgent = new Map<string, ForwardedResult[]>();
  for (const r of latest.values()) byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r]);
  const tally = new Map<string, { results: number; disagreements: number }>();
  for (const results of byAgent.values()) {
    const ok = results.filter((r) => r.endpointsLive && r.registrationValid).length;
    const bad = results.length - ok;
    if (results.length < 2 || ok === bad) continue;
    const majority = ok > bad;
    for (const r of results) {
      const t = tally.get(r.staker) ?? { results: 0, disagreements: 0 };
      t.results += 1;
      if ((r.endpointsLive && r.registrationValid) !== majority) t.disagreements += 1;
      tally.set(r.staker, t);
    }
  }
  return [...tally.entries()]
    .map(([staker, t]) => {
      const rateBps = Math.floor((t.disagreements * 10_000) / t.results);
      return { staker, ...t, rateBps, over: rateBps > barBps };
    })
    .sort((a, b) => b.rateBps - a.rateBps);
}

export interface Candidate {
  staker: string;
  amount: bigint;
  lockedAt: bigint;
  excludedUntilEpoch: bigint;
}

/** The set `rollEpoch` will take at `epoch`: same rule as the contract (stake, earlier lock, lower address). */
export function predictActiveSet(cands: Candidate[], epoch: bigint, maxActive: number): string[] {
  return cands
    .filter((c) => !(c.excludedUntilEpoch !== 0n && c.excludedUntilEpoch >= epoch))
    .sort((a, b) =>
      a.amount !== b.amount ? (a.amount > b.amount ? -1 : 1) : a.lockedAt !== b.lockedAt ? (a.lockedAt < b.lockedAt ? -1 : 1) : BigInt(a.staker) < BigInt(b.staker) ? -1 : 1,
    )
    .slice(0, maxActive)
    .map((c) => c.staker);
}

export interface PlannedTx {
  to: Address;
  fn: string;
  args: string[];
  who: "anyone" | "attestor owner";
  why: string;
}

export interface EpochPlan {
  epoch: number;
  rolled: boolean;
  secondsToNextEpoch: number;
  nextSet: string[];
  disagreements: Disagreement[];
  pendingSplitUsdg: string;
  txs: PlannedTx[];
  checklist: { item: string; ok: boolean }[];
}

const REG = attesterRegistryAbi as Abi;
const SPL = attesterFeeSplitterAbi as Abi;
const ATTESTOR = [
  { type: "function", name: "treasury", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "isAttester", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
] as const satisfies Abi;
const TREASURY = [{ type: "function", name: "orry", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }] as const satisfies Abi;
const ERC20 = [{ type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const satisfies Abi;

export async function planEpoch(c: CreditConfig, chain: Chain, sql: Sql): Promise<EpochPlan> {
  if (!c.registry) throw new Error("ORRERY_ATTESTER_REGISTRY is not set");
  const r = c.registry;
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    chain.public.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const [epoch, genesis, epochLength, maxActive, attestor, candidates] = await Promise.all([
    read<bigint>(r, REG, "currentEpoch"),
    read<bigint>(r, REG, "genesis"),
    read<bigint>(r, REG, "epochLength"),
    read<bigint>(r, REG, "maxActive"),
    read<Address>(r, REG, "attestor"),
    read<Address[]>(r, REG, "candidates"),
  ]);
  const rolled = await read<boolean>(r, REG, "rolled", [epoch]);
  const now = (await chain.public.getBlock()).timestamp;
  const nextStart = genesis + (epoch + 1n) * epochLength;
  const cands: Candidate[] = await Promise.all(
    candidates.map(async (staker) => {
      const s = await read<{ amount: bigint; lockedAt: bigint; excludedUntilEpoch: bigint }>(r, REG, "stakerOf", [staker]);
      return { staker: staker.toLowerCase(), amount: s.amount, lockedAt: s.lockedAt, excludedUntilEpoch: s.excludedUntilEpoch };
    }),
  );
  const rows = await sql<{ staker: string; agent_id: string; observed_at: string; endpoints_live: boolean; registration_valid: boolean }[]>`
    select staker, agent_id::text, observed_at::text, endpoints_live, registration_valid from attester_results where epoch = ${epoch.toString()}`;
  const dis = disagreements(
    rows.map((x) => ({ staker: x.staker, agentId: x.agent_id, observedAt: BigInt(x.observed_at), endpointsLive: x.endpoints_live, registrationValid: x.registration_valid })),
    c.disagreementBps,
  );
  const txs: PlannedTx[] = [];
  if (!rolled) txs.push({ to: r, fn: "rollEpoch", args: [], who: "anyone", why: `epoch ${epoch} has no active set yet` });
  for (const d of dis.filter((x) => x.over)) {
    const reason = keccak256(toHex(JSON.stringify({ epoch: epoch.toString(), staker: d.staker, results: d.results, disagreements: d.disagreements })));
    txs.push({ to: r, fn: "exclude", args: [d.staker, reason], who: "attestor owner", why: `${d.rateBps / 100}% of its results against the majority, bar ${c.disagreementBps / 100}%` });
  }
  let pending = 0n;
  const checklist: { item: string; ok: boolean }[] = [];
  const [registryKey, attestorTreasury] = await Promise.all([read<boolean>(attestor, ATTESTOR, "isAttester", [r]), read<Address>(attestor, ATTESTOR, "treasury")]);
  checklist.push({ item: "the registry holds a OrreryAttestor attester key", ok: registryKey });
  if (c.splitter) {
    const s = c.splitter;
    const [usdg, booked, treasury] = await Promise.all([read<Address>(s, SPL, "usdg"), read<bigint>(s, SPL, "booked"), read<Address>(s, SPL, "treasury")]);
    pending = (await read<bigint>(usdg, ERC20, "balanceOf", [s])) - booked;
    if (pending > 0n) txs.unshift({ to: s, fn: "split", args: [], who: "anyone", why: `${pending} USDG base units arrived since the last split` });
    for (let e = epoch > 8n ? epoch - 8n : 0n; e < epoch; e++) {
      const [total, released, pool] = await Promise.all([read<bigint>(r, REG, "totalResults", [e]), read<boolean>(s, SPL, "released", [e]), read<bigint>(s, SPL, "pool", [e])]);
      if (total === 0n && !released && pool > 0n) txs.push({ to: s, fn: "releaseUnused", args: [e.toString()], who: "anyone", why: `epoch ${e} had no results; its pool returns to the treasury` });
    }
    const coin = await read<Address>(treasury, TREASURY, "orry").catch(() => "0x0000000000000000000000000000000000000000" as Address);
    checklist.push({ item: "OrreryAttestor.treasury is the splitter (finding F2: switch only with the services route)", ok: attestorTreasury.toLowerCase() === s.toLowerCase() });
    checklist.push({ item: "OrreryTreasury coin is set (the splitter's ORRY verification route needs it)", ok: BigInt(coin) !== 0n });
  }
  return {
    epoch: Number(epoch),
    rolled,
    secondsToNextEpoch: Number(nextStart - now),
    nextSet: predictActiveSet(cands, rolled ? epoch + 1n : epoch, Number(maxActive)),
    disagreements: dis,
    pendingSplitUsdg: pending.toString(),
    txs,
    checklist,
  };
}
