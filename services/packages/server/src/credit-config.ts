import { isAddress, type Address } from "viem";

/**
 * Lane L4 configuration (`docs/updates/L4-CREDIT-SPEC.md` 6). Null when neither the attester registry nor the Credit
 * factory is configured, so a deployment without L4 runs exactly as before.
 */
export interface CreditConfig {
  /** `AttesterRegistry`; null turns the attester routes and indexing off. */
  registry: Address | null;
  /** `AttesterFeeSplitter`; null: the attester routes show no fee pool. */
  splitter: Address | null;
  /** `CreditPoolFactory`; null turns the Credit routes and indexing off. */
  factory: Address | null;
  /** First block the indexer reads (the deployment block). */
  startBlock: bigint;
  /** Cache of the public chain reads, so idle browser tabs cannot run up RPC calls. */
  cacheMs: number;
  /** Disagreement bar of the epoch job, basis points of an attester's results (A12, guess 1,000). */
  disagreementBps: number;
}

function optAddr(env: NodeJS.ProcessEnv, name: string): Address | null {
  const v = env[name];
  if (!v) return null;
  if (!isAddress(v)) throw new Error(`${name} expects a 0x address`);
  return v as Address;
}

function int(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number, max: number): number {
  const raw = env[name];
  const v = raw === undefined || raw === "" ? dflt : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return v;
}

export function loadCreditConfig(env: NodeJS.ProcessEnv): CreditConfig | null {
  const registry = optAddr(env, "ORRERY_ATTESTER_REGISTRY");
  const splitter = optAddr(env, "ORRERY_ATTESTER_SPLITTER");
  const factory = optAddr(env, "ORRERY_CREDIT_FACTORY");
  if (!registry && !factory) return null;
  const start = env.ORRERY_CREDIT_START_BLOCK ?? "0";
  if (!/^\d+$/.test(start)) throw new Error("ORRERY_CREDIT_START_BLOCK must be a block number");
  return {
    registry,
    splitter,
    factory,
    startBlock: BigInt(start),
    cacheMs: int(env, "ORRERY_CREDIT_CACHE_MS", 15_000, 0, 600_000),
    disagreementBps: int(env, "ORRERY_ATTESTER_DISAGREEMENT_BPS", 1000, 1, 10_000),
  };
}
