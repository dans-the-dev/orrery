/**
 * Entry points that need almost no configuration: an agent built from the key file the Operator page saves, and a
 * merchant's check of a payer in one call. Orrery's own addresses on Robinhood Chain are the defaults.
 */
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain } from "@orrery/shared";
import { AgentClient, OrreryApi, verifyCheck } from "./index";

/**
 * Orrery v1 on Robinhood Chain 4663 (the repository's deployments/4663.json). The RPC is one that publishes
 * transactions: an agent sends its own top-ups, and rpc-robinhood.blockmachine.io (the web's read endpoint) answers
 * eth_sendRawTransaction with "publishing transactions not supported by this endpoint" (seen on mainnet, 2026-11-11).
 */
export const ORRERY_MAINNET = {
  chainId: 4663,
  rpcUrl: "https://robinhood-rpc.publicnode.com",
  apiUrl: "https://api.orrery.tech",
  module: "0x2934c34afd7b5410d05ddd638982eed1d49f0d4c",
  attestor: "0xc18a0dc74f5326786f5ade357354159c63282bd0",
  lens: "0xc10bb949d79d906e042d940cf5226c9f2c783ed9",
} as const satisfies { chainId: number; rpcUrl: string; apiUrl: string; module: Address; attestor: Address; lens: Address };

type Env = Record<string, string | undefined>;
const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};
const chainFor = (chainId: number, rpcUrl: string) =>
  defineChain({ id: chainId, name: chainId === robinhoodChain.id ? robinhoodChain.name : `Chain ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });

/**
 * The agent's client from environment variables, as written by the key file of the Operator page. Only
 * `ORRERY_SIGNER_KEY` is required; `ORRERY_CHAIN_ID`, `ORRERY_RPC_URL` and `ORRERY_MODULE` default to Orrery on
 * Robinhood Chain.
 */
export function agentFromEnv(env: Env = processEnv()): AgentClient {
  const key = env.ORRERY_SIGNER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Set ORRERY_SIGNER_KEY to the signer key from your Orrery key file.");
  const chainId = Number(env.ORRERY_CHAIN_ID ?? ORRERY_MAINNET.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("ORRERY_CHAIN_ID must be a chain ID such as 4663.");
  const rpcUrl = env.ORRERY_RPC_URL || ORRERY_MAINNET.rpcUrl;
  const module = env.ORRERY_MODULE || (chainId === ORRERY_MAINNET.chainId ? ORRERY_MAINNET.module : undefined);
  if (!module || !isAddress(module)) throw new Error("Set ORRERY_MODULE to the Orrery policy module on this chain.");
  const chain = chainFor(chainId, rpcUrl);
  const wallet = createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(key as Hex) }) as WalletClient & { account: Account };
  return new AgentClient(wallet, createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient, getAddress(module));
}

/**
 * A merchant's whole check in one call: asks the check service about `payer`, then verifies the signed answer against
 * the attestor on-chain. `ok` is true only for a valid, current answer about this payer. Defaults to Orrery on
 * Robinhood Chain; pass `apiUrl`, `attestor` and `publicClient` (or `rpcUrl`) for another network.
 */
export async function checkPayment(
  payer: Address,
  apiKey: string,
  opts: { apiUrl?: string; attestor?: Address; rpcUrl?: string; publicClient?: PublicClient } = {},
) {
  const rpcUrl = opts.rpcUrl ?? ORRERY_MAINNET.rpcUrl;
  const publicClient = opts.publicClient ?? (createPublicClient({ chain: chainFor(ORRERY_MAINNET.chainId, rpcUrl), transport: http(rpcUrl) }) as PublicClient);
  const res = await new OrreryApi(opts.apiUrl ?? ORRERY_MAINNET.apiUrl, apiKey).checkPayer(payer);
  return verifyCheck(publicClient, opts.attestor ?? ORRERY_MAINNET.attestor, res, { payer });
}
