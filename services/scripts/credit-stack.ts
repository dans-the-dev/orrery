import { createPublicClient, createWalletClient, http, type Abi, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { foundry } from "viem/chains";
import { mnemonicToAccount } from "viem/accounts";
import * as g from "./credit-generated.js";

/**
 * Lane L4 local stack (`docs/updates/L4-CREDIT-SPEC.md`): the attester registry, its fee splitter and a Credit pool on a
 * local anvil, with the test stand-ins around them (identity registry, USDG with a blocklist, ORRY with burnFrom, a
 * treasury surface, a fixed-price ORRY oracle) and the real `OrreryAttestor`. Development and tests only.
 */

const MNEMONIC = "test test test test test test test test test test test junk";
const E6 = 10n ** 6n;
const E18 = 10n ** 18n;

/** Anvil account indexes by role. */
export const CREDIT_ROLE = { ops: 0, attesterA: 1, attesterB: 2, probeA: 3, probeB: 4, operator: 5, lender: 6, prober: 7, operator2: 8 } as const;

type Wallet = WalletClient & { account: Account };

export interface CreditStack {
  identity: Address;
  usdg: Address;
  orry: Address;
  treasury: Address;
  oracle: Address;
  attestor: Address;
  registry: Address;
  splitter: Address;
  factory: Address;
  pool: Address;
  startBlock: bigint;
  epochLength: number;
}

export function creditClients(rpc: string) {
  const pub = createPublicClient({ chain: foundry, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
  const wallets = new Map<number, Wallet>();
  const wallet = (i: number): Wallet => {
    let w = wallets.get(i);
    if (!w) {
      w = createWalletClient({ chain: foundry, transport: http(rpc), account: mnemonicToAccount(MNEMONIC, { addressIndex: i }) }) as Wallet;
      wallets.set(i, w);
    }
    return w;
  };
  return { pub, wallet, address: (i: number) => wallet(i).account.address };
}

export const DEFAULT_POOL_PARAMS = {
  aprBps: 1200,
  feeBps: 1000,
  repayBps: 5000,
  maxLineBps: 1000,
  term: 30 * 86400,
  grace: 7 * 86400,
  minBondUsd: 25n * E6,
  maxLineUsdg: 10_000n * E6,
  tierRepaid: [0n, 7_500n * E6, 75_000n * E6, 750_000n * E6],
  tierMultBps: [10_000, 15_000, 20_000, 30_000],
} as const;

export async function deployCreditStack(rpc: string, opts: { epochLength?: number } = {}): Promise<CreditStack> {
  const c = creditClients(rpc);
  const ops = c.wallet(CREDIT_ROLE.ops);
  const startBlock = await c.pub.getBlockNumber();
  const deploy = async (art: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []): Promise<Address> => {
    const hash = await ops.deployContract({ abi: art.abi, bytecode: art.bytecode, args, chain: foundry, account: ops.account } as never);
    const r = await c.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error("deployment reverted");
    return r.contractAddress;
  };
  const send = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => {
    const hash = await ops.writeContract({ address, abi, functionName, args, chain: foundry, account: ops.account } as never);
    const r = await c.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
  };
  const epochLength = opts.epochLength ?? 7 * 86400;
  const identity = await deploy(g.MockIdentityRegistry as never);
  const usdg = await deploy(g.CreditUsdg as never);
  const orry = await deploy(g.CreditOrry as never);
  const treasury = await deploy(g.CreditTreasury as never, [ops.account.address]);
  const oracle = await deploy(g.CreditOracle as never);
  await send(oracle, g.CreditOracle.abi as Abi, "set", [10_000n]); // 0.01 USDG per ORRY
  const attestor = await deploy(g.OrreryAttestor as never, [identity, usdg, ops.account.address, treasury, 5n * E6]);
  const now = (await c.pub.getBlock()).timestamp;
  const registry = await deploy(g.AttesterRegistry as never, [orry, attestor, 1_000_000n * E18, 20n, BigInt(epochLength), 14n * 86400n, now]);
  const splitter = await deploy(g.AttesterFeeSplitter as never, [usdg, treasury, attestor, registry, 3000]);
  await send(attestor, g.OrreryAttestor.abi as Abi, "setAttester", [c.address(CREDIT_ROLE.prober), true]);
  await send(attestor, g.OrreryAttestor.abi as Abi, "setAttester", [registry, true]);
  await send(attestor, g.OrreryAttestor.abi as Abi, "setTreasury", [splitter]);
  const factory = await deploy(g.CreditPoolFactory as never, [usdg, orry, oracle, identity, attestor, treasury]);
  const hash = await ops.writeContract({ address: factory, abi: g.CreditPoolFactory.abi as Abi, functionName: "createPool", args: [DEFAULT_POOL_PARAMS], chain: foundry, account: ops.account } as never);
  await c.pub.waitForTransactionReceipt({ hash });
  const pools = (await c.pub.readContract({ address: factory, abi: g.CreditPoolFactory.abi as Abi, functionName: "pools" })) as Address[];
  return { identity, usdg, orry, treasury, oracle, attestor, registry, splitter, factory, pool: pools[0]!, startBlock, epochLength };
}

/** Writes as `role`, waits, throws on a revert. */
export async function creditSend(rpc: string, role: number, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  const c = creditClients(rpc);
  const w = c.wallet(role);
  const hash = await w.writeContract({ address, abi, functionName, args, chain: foundry, account: w.account } as never);
  const r = await c.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

/**
 * Seeds a believable state: two attesters staked and rolled, two verified agents with forwarded results, a lender, an
 * operator with an ORRY bond and a drawn line, and revenue swept through the line's router. Returns the agent ids.
 */
export async function seedCreditStack(rpc: string, s: CreditStack): Promise<{ agent: bigint; agent2: bigint }> {
  const c = creditClients(rpc);
  const tx = (role: number, address: Address, abi: Abi, fn: string, args: readonly unknown[] = []) => creditSend(rpc, role, address, abi, fn, args);
  const U = g.CreditUsdg.abi as Abi;
  const R = g.CreditOrry.abi as Abi;
  const ID = g.MockIdentityRegistry.abi as Abi;
  const ATT = g.OrreryAttestor.abi as Abi;
  // attesters
  for (const [role, probe, amount] of [
    [CREDIT_ROLE.attesterA, CREDIT_ROLE.probeA, 2_400_000n * E18],
    [CREDIT_ROLE.attesterB, CREDIT_ROLE.probeB, 1_250_000n * E18],
  ] as const) {
    await tx(CREDIT_ROLE.ops, s.orry, R, "mint", [c.address(role), amount]);
    await tx(role, s.orry, R, "approve", [s.registry, amount]);
    await tx(role, s.registry, g.AttesterRegistry.abi as Abi, "stake", [amount, c.address(probe)]);
  }
  await tx(CREDIT_ROLE.ops, s.registry, g.AttesterRegistry.abi as Abi, "rollEpoch");
  // two verified agents (the verification fee lands in the splitter)
  const agents: bigint[] = [];
  for (const role of [CREDIT_ROLE.operator, CREDIT_ROLE.operator2]) {
    const op = c.address(role);
    const next = (await c.pub.readContract({ address: s.identity, abi: ID, functionName: "nextId" })) as bigint;
    await tx(role, s.identity, ID, "register", [op]);
    await tx(CREDIT_ROLE.ops, s.usdg, U, "mint", [op, 5n * E6]);
    await tx(role, s.usdg, U, "approve", [s.attestor, 5n * E6]);
    await tx(role, s.attestor, ATT, "payVerification", [next, op, 5n * E6]);
    agents.push(next);
  }
  const now = (await c.pub.getBlock()).timestamp;
  const result = { observedAt: now, expiresAt: now + 86400n, endpointsLive: true, registrationValid: true, domainVerified: false, registrationHash: `0x${"00".repeat(32)}` as Hex, attester: "0x0000000000000000000000000000000000000000" as Address };
  await tx(CREDIT_ROLE.probeA, s.registry, g.AttesterRegistry.abi as Abi, "attest", [agents[0], result]);
  await tx(CREDIT_ROLE.probeB, s.registry, g.AttesterRegistry.abi as Abi, "attest", [agents[1], result]);
  await tx(CREDIT_ROLE.ops, s.splitter, g.AttesterFeeSplitter.abi as Abi, "split");
  // credit: a lender, a bond, a draw, revenue through the router
  const lender = c.address(CREDIT_ROLE.lender);
  await tx(CREDIT_ROLE.ops, s.usdg, U, "mint", [lender, 25_000n * E6]);
  await tx(CREDIT_ROLE.lender, s.usdg, U, "approve", [s.pool, 25_000n * E6]);
  await tx(CREDIT_ROLE.lender, s.pool, g.CreditPool.abi as Abi, "deposit", [25_000n * E6]);
  const op = c.address(CREDIT_ROLE.operator);
  await tx(CREDIT_ROLE.ops, s.orry, R, "mint", [op, 150_000n * E18]);
  await tx(CREDIT_ROLE.operator, s.orry, R, "approve", [s.pool, 150_000n * E18]);
  await tx(CREDIT_ROLE.operator, s.pool, g.CreditPool.abi as Abi, "postBond", [agents[0], 150_000n * E18]);
  await tx(CREDIT_ROLE.operator, s.pool, g.CreditPool.abi as Abi, "draw", [agents[0], 900n * E6]);
  const router = (await c.pub.readContract({ address: s.pool, abi: g.CreditPool.abi as Abi, functionName: "routerOf", args: [agents[0]] })) as Address;
  await tx(CREDIT_ROLE.ops, s.usdg, U, "mint", [router, 120n * E6]);
  await tx(CREDIT_ROLE.ops, router, g.CreditRevenueRouter.abi as Abi, "sweep");
  return { agent: agents[0]!, agent2: agents[1]! };
}
