import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { encodeAbiParameters, getAddress, isAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import {
  iAgentLaunchAbi,
  iSpokeHookAbi,
  LAUNCH_GATES,
  orryPerCoinFromSqrtPrice,
  type LaunchAccountResponse,
  type LaunchCoinResponse,
  type LaunchCoinView,
  type LaunchCoinsResponse,
  type LaunchEligibilityResponse,
  type LaunchTradeView,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { ttlCache, type OrryRouteDeps } from "./orry-api.js";
import { releasesFor } from "./releases.js";
import { launchLinks, type LaunchLinks } from "./launch-indexer.js";

/**
 * `/v1/launch/` routes (lane L5, `docs/updates/L5-LAUNCH-SPEC.md`; shapes in `@orrery/shared` launch.ts). Every route
 * opens with the `launch` release and `ORRERY_AGENT_LAUNCH` configured; otherwise it answers the 404 of an unknown route.
 * Coin lists come from the indexer; the coin page adds live reads (pending fees, the creator share, the early window).
 */

const READ_FAILED = "Could not read the chain right now. Try again shortly.";
const ZERO = "0x0000000000000000000000000000000000000000";
const extAbi = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function isInstalledOn(address account) view returns (bool)",
  "function earningBalance(address account) view returns (uint256)",
  "function usdValue(uint256 orryAmount) view returns (uint256)",
  "function agentStake(uint256 agentId) view returns ((address staker, uint128 active, uint128 leaving, uint64 leavingAt, uint64 lockedUntil))",
  "function extsload(bytes32 slot) view returns (bytes32)",
  "function isVerified(uint256 agentId) view returns (bool)",
]);
/** v4 StateLibrary: pools live at slot 6 of the PoolManager; slot0 is the pool's first word (sqrtPriceX96 in the low 160 bits). */
const slot0Slot = (poolId: string) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId as Hex, 6n]));

interface CoinRow {
  coin: string;
  agent_id: string;
  creator: string;
  pool_id: string;
  name: string;
  symbol: string;
  launched_time: Date;
  public_open_at: string;
  first_buy_orry: string;
  first_buy_coins: string;
  last_sqrt_price: string | null;
  volume_orry: string;
  trades: number;
  early_buys: number;
  fees_distributed: string;
  creator_fees: string;
  earn_fees: string;
  owner_fees: string;
  burned: string;
  creator_claimed: string;
}

interface Links extends LaunchLinks {
  registry: Address;
  attestor: Address;
  module: Address;
  staking: Address;
  orryPrice: Address;
  sqrtStart: bigint;
  params: { minStakeUsd: bigint; maxFirstBuyBps: number };
  lockPeriod: bigint;
}

function view(r: CoinRow, sqrtStart: bigint): LaunchCoinView {
  const sqrt = r.last_sqrt_price ? BigInt(r.last_sqrt_price) : sqrtStart;
  return {
    coin: r.coin,
    agentId: r.agent_id,
    creator: r.creator,
    poolId: r.pool_id,
    name: r.name,
    symbol: r.symbol,
    launchedAt: Math.floor(r.launched_time.getTime() / 1000),
    publicOpenAt: Number(r.public_open_at),
    firstBuyOrry: r.first_buy_orry,
    firstBuyCoins: r.first_buy_coins,
    priceOrry: orryPerCoinFromSqrtPrice(sqrt).toString(),
    volumeOrry: r.volume_orry,
    trades: r.trades,
    earlyBuys: r.early_buys,
    feesDistributed: r.fees_distributed,
    creatorFees: r.creator_fees,
    earnFees: r.earn_fees,
    ownerFees: r.owner_fees,
    burned: r.burned,
    creatorClaimed: r.creator_claimed,
  };
}

export function registerLaunchRoutes(app: FastifyInstance, cfg: Config, chain: Chain, sql: Sql, deps: OrryRouteDeps): void {
  const lc = cfg.launch;
  const cache = ttlCache(lc?.cacheMs ?? 5_000);
  const clock = ttlCache(Math.min(1_000, lc?.cacheMs ?? 1_000));
  /** The chain's time (the latest block), which the hook's windows and fees follow. */
  const chainNow = () => clock("now", async () => (await chain.public.getBlock()).timestamp);
  const releases = releasesFor(sql, cfg.releaseSeed, cfg.releasesCacheMs);
  let linksP: Promise<Links> | undefined;
  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
    chain.public.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;

  const links = (): Promise<Links> => {
    if (!lc) throw new Error("not configured");
    linksP ??= (async () => {
      const al = lc.agentLaunch;
      const [base, registry, attestor, module, staking, orryPrice, sqrtStart, params, lockPeriod] = await Promise.all([
        launchLinks(chain, lc),
        read<Address>(al, iAgentLaunchAbi, "identityRegistry"),
        read<Address>(al, iAgentLaunchAbi, "attestor"),
        read<Address>(al, iAgentLaunchAbi, "policyModule"),
        read<Address>(al, iAgentLaunchAbi, "staking"),
        read<Address>(al, iAgentLaunchAbi, "orryPrice"),
        read<bigint>(al, parseAbi(["function SQRT_PRICE_START() view returns (uint160)"]), "SQRT_PRICE_START"),
        read<{ minStakeUsd: bigint; maxFirstBuyBps: number }>(al, iAgentLaunchAbi, "params"),
        read<bigint>(al, iAgentLaunchAbi, "LOCK_PERIOD"),
      ]);
      return { ...base, registry, attestor, module, staking, orryPrice, sqrtStart, params, lockPeriod: BigInt(lockPeriod) };
    })().catch((e) => {
      linksP = undefined;
      throw e;
    });
    return linksP;
  };

  const gate = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!lc) return reply.callNotFound();
    let open: boolean;
    try {
      open = await releases.isOpen("launch");
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
    if (!open) return reply.callNotFound();
    if (!deps.allowPublic(req.ip)) return reply.code(429).send({ error: "Too many requests. Try again in a minute." });
  };

  app.get("/v1/launch/coins", { preHandler: gate }, async (_req, reply) => {
    try {
      const l = await links();
      const rows = await sql<CoinRow[]>`select * from launch_coins order by launched_time desc limit 200`;
      const coins = rows.map((r) => view(r, l.sqrtStart));
      const sum = (k: keyof LaunchCoinView) => coins.reduce((acc, c) => acc + BigInt(c[k] as string), 0n).toString();
      const [count] = await sql<{ n: string }[]>`select count(*)::text as n from launch_coins`;
      const body: LaunchCoinsResponse = {
        coins,
        totals: {
          coins: Number(count?.n ?? 0),
          volumeOrry: sum("volumeOrry"),
          feesDistributed: sum("feesDistributed"),
          burned: sum("burned"),
          earnFees: sum("earnFees"),
          creatorFees: sum("creatorFees"),
        },
        updatedAt: new Date().toISOString(),
      };
      return body;
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
  });

  app.get<{ Params: { coin: string } }>("/v1/launch/coins/:coin", { preHandler: gate }, async (req, reply) => {
    if (!isAddress(req.params.coin)) return reply.code(400).send({ error: "coin must be a 0x address" });
    const coin = req.params.coin.toLowerCase();
    const [row] = await sql<CoinRow[]>`select * from launch_coins where coin = ${coin}`;
    if (!row) return reply.code(404).send({ error: "No coin was launched at this address." });
    try {
      const l = await links();
      const trades = await sql<{ tx_hash: string; kind: "early" | "buy" | "sell"; account: string; orry: string; coins: string; block_time: Date }[]>`
        select tx_hash, kind, account, orry, coins, block_time from launch_trades where coin = ${coin}
        order by block_number desc, log_index desc limit ${lc!.tradesPerPage}`;
      const live = await cache(`coin:${coin}`, async () => {
        const c = getAddress(coin);
        const al = lc!.agentLaunch;
        const [pendingFees, creatorOwed, early, feePips, wallet, slot0, liquidity] = await Promise.all([
          read<bigint>(al, iAgentLaunchAbi, "pendingFees", [c]),
          read<bigint>(al, iAgentLaunchAbi, "creatorOwed", [c]),
          read<boolean>(l.hook, iSpokeHookAbi, "isEarly", [row.pool_id]),
          read<number>(l.hook, iSpokeHookAbi, "feeAt", [row.pool_id, await chainNow()]),
          read<Address>(l.registry, extAbi, "getAgentWallet", [BigInt(row.agent_id)]).catch(() => ZERO as Address),
          read<Hex>(l.poolManager, extAbi, "extsload", [slot0Slot(row.pool_id)]),
          read<bigint>(al, iAgentLaunchAbi, "launchLiquidity"),
        ]);
        const bound = wallet !== ZERO ? await read<boolean>(l.module, extAbi, "isInstalledOn", [wallet]) : false;
        return {
          pendingFees: pendingFees.toString(),
          creatorOwed: creatorOwed.toString(),
          early,
          feePips: Number(feePips),
          agentWallet: wallet === ZERO ? null : wallet.toLowerCase(),
          walletBound: bound,
          sqrtPriceX96: (BigInt(slot0) & ((1n << 160n) - 1n)).toString(),
          liquidity: liquidity.toString(),
        };
      }).catch(() => null);
      const body: LaunchCoinResponse = {
        coin: view(row, l.sqrtStart),
        live,
        trades: trades.map(
          (t): LaunchTradeView => ({
            txHash: t.tx_hash,
            kind: t.kind,
            account: t.account,
            orry: t.orry,
            coins: t.coins,
            time: Math.floor(t.block_time.getTime() / 1000),
          }),
        ),
      };
      return body;
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
  });

  app.get<{ Params: { agentId: string }; Querystring: { caller?: string } }>(
    "/v1/launch/agents/:agentId",
    { preHandler: gate },
    async (req, reply) => {
      if (!/^\d{1,30}$/.test(req.params.agentId)) return reply.code(400).send({ error: "agentId must be a number" });
      const caller = req.query.caller ?? ZERO;
      if (!isAddress(caller)) return reply.code(400).send({ error: "caller must be a 0x address" });
      const agentId = BigInt(req.params.agentId);
      try {
        const l = await links();
        const al = lc!.agentLaunch;
        const [gateIdx, owner, wallet, coin, stake, verified] = await Promise.all([
          read<number>(al, iAgentLaunchAbi, "canLaunch", [agentId, getAddress(caller)]),
          read<Address>(l.registry, extAbi, "ownerOf", [agentId]).catch(() => null),
          read<Address>(l.registry, extAbi, "getAgentWallet", [agentId]).catch(() => null),
          read<Address>(al, iAgentLaunchAbi, "coinOfAgent", [agentId]),
          read<{ active: bigint; lockedUntil: bigint }>(l.staking, extAbi, "agentStake", [agentId]),
          read<boolean>(l.attestor, extAbi, "isVerified", [agentId]).catch(() => false),
        ]);
        const walletBound = wallet && wallet !== ZERO ? await read<boolean>(l.module, extAbi, "isInstalledOn", [wallet]).catch(() => false) : false;
        const usd = stake.active > 0n
          ? await read<bigint>(l.orryPrice, extAbi, "usdValue", [stake.active]).then((v) => v.toString(), () => null)
          : "0";
        const now = await chainNow();
        const body: LaunchEligibilityResponse = {
          agentId: agentId.toString(),
          gate: LAUNCH_GATES[Number(gateIdx)] ?? "not-controller",
          owner: owner ? owner.toLowerCase() : null,
          agentWallet: wallet && wallet !== ZERO ? wallet.toLowerCase() : null,
          verified,
          walletBound,
          coin: coin === ZERO ? null : coin.toLowerCase(),
          stake: { active: stake.active.toString(), lockedUntil: Number(stake.lockedUntil), usd },
          needs: {
            minStakeUsd: l.params.minStakeUsd.toString(),
            lockUntil: Number(now + l.lockPeriod),
            maxFirstBuyBps: Number(l.params.maxFirstBuyBps),
          },
        };
        return body;
      } catch {
        return reply.code(503).send({ error: READ_FAILED });
      }
    },
  );

  app.get<{ Params: { address: string } }>("/v1/launch/accounts/:address", { preHandler: gate }, async (req, reply) => {
    if (!isAddress(req.params.address)) return reply.code(400).send({ error: "address must be a 0x address" });
    const account = getAddress(req.params.address);
    try {
      const l = await links();
      const now = Number(await chainNow());
      const open = await sql<{ coin: string; symbol: string; public_open_at: string }[]>`
        select coin, symbol, public_open_at from launch_coins where public_open_at > ${now} order by launched_time desc limit 50`;
      const balance = await read<bigint>(l.staking, extAbi, "earningBalance", [account]);
      const stakeUsd = balance > 0n
        ? await read<bigint>(l.orryPrice, extAbi, "usdValue", [balance]).then((v) => v.toString(), () => null)
        : "0";
      const early = await Promise.all(
        open.map(async (c) => {
          const [allowance, bought] = await Promise.all([
            read<bigint>(lc!.agentLaunch, iAgentLaunchAbi, "earlyAllowance", [getAddress(c.coin), account]),
            read<bigint>(lc!.agentLaunch, iAgentLaunchAbi, "earlyBought", [getAddress(c.coin), account]),
          ]);
          return { coin: c.coin, symbol: c.symbol, allowance: allowance.toString(), bought: bought.toString(), publicOpenAt: Number(c.public_open_at) };
        }),
      );
      const body: LaunchAccountResponse = { account: account.toLowerCase(), stakeUsd, early };
      return body;
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
  });
}
