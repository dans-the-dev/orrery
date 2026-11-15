import { getAddress, isAddress, type Address } from "viem";

/**
 * Lane L5 settings (`docs/updates/L5-LAUNCH-SPEC.md`). Null when `ORRERY_AGENT_LAUNCH` is not set, so a stack without
 * Agent Launch runs exactly as before. The hook and the PoolManager are read from the AgentLaunch contract at start.
 */
export interface LaunchConfig {
  /** `AgentLaunch`; its `hook()` and `poolManager()` are read live. */
  agentLaunch: Address;
  /** `SpokeRouter`: its `Traded` events name the trader of a router swap (the PoolManager only sees the router). */
  spokeRouter: Address | null;
  startBlock: bigint;
  /** Cache of chain reads behind the public routes. */
  cacheMs: number;
  /** Trades returned per coin page. */
  tradesPerPage: number;
}

function int(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

export function loadLaunch(env: NodeJS.ProcessEnv): LaunchConfig | null {
  const raw = env.ORRERY_AGENT_LAUNCH;
  if (!raw) return null;
  if (!isAddress(raw)) throw new Error("ORRERY_AGENT_LAUNCH must be a 0x address");
  const router = env.ORRERY_SPOKE_ROUTER;
  if (router && !isAddress(router)) throw new Error("ORRERY_SPOKE_ROUTER must be a 0x address");
  return {
    agentLaunch: getAddress(raw),
    spokeRouter: router ? getAddress(router) : null,
    startBlock: BigInt(env.ORRERY_LAUNCH_START_BLOCK ?? env.ORRERY_INDEXER_START_BLOCK ?? 0),
    cacheMs: int(env, "ORRERY_LAUNCH_CACHE_MS", 5_000, 0, 600_000),
    tradesPerPage: int(env, "ORRERY_LAUNCH_TRADES_PER_PAGE", 50, 1, 500),
  };
}
