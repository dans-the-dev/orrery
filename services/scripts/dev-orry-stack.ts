/**
 * Local ORRY stack for the web, in one command: anvil and Postgres (Docker) on their own ports, the real v1 and
 * multi-pair ORRY contracts deployed as `test/orry.real.test.ts` deploys them (`test/orry-system.ts`: two hubs,
 * ORRY/ETH and ORRY/USDG, and an Earn vault on each), the coin set (48 hours of chain time), seeded activity on both
 * hubs, then the API and both indexers in this process. Every release starts held (`releases` table, all null); open
 * one with `scripts/releases.ts set <feature> now`. Prints the web's environment.
 * Ctrl-C (or SIGTERM) stops the API, the indexers, anvil and the Postgres container.
 *
 * Development only: chain 31337, the standard anvil test mnemonic, nothing else. Chain time starts four days in the past
 * and is brought to the wall clock after seeding, so countdowns in the web read true.
 *
 *   pnpm exec tsx scripts/dev-orry-stack.ts
 *
 * Ports: ORRY_STACK_ANVIL_PORT (18656), ORRY_STACK_PG_PORT (55472), ORRY_STACK_API_PORT (18787); container
 * ORRY_STACK_PG_NAME (orrery-pg-orry-stack). ORRERY_CORS_ORIGINS passes through (default: the web on :3100 or :3131).
 */
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toHex, type Abi } from "viem";
import { foundry } from "viem/chains";
import { OrryApi, orryCalls } from "@orrery/sdk";
import type { ReleasesResponse } from "@orrery/shared";
import { buildApi, connect, loadConfig, makeChain, migrate, orryLag, runIndexer, runKeeperOnce, runOrryIndexer, seedReleases, setRelease, type Sql } from "@orrery/server";
import * as rc from "../test/generated/orry.js";
import { ROLE, anvilKey, apiEnv, deployOrrySystem, deposit, depositUsdg, hubSwaps, mine, rpcCall, send, setCoin, startAnvil, usdgHubSwaps, warp } from "../test/orry-system.js";

if (!("earnVaultFactoryBytecode" in rc)) {
  console.error("[orry-stack] needs the multi-pair contracts: run forge build on lane A's orry/pairs-int, then node scripts/gen-abi.mjs");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const ANVIL_PORT = Number(process.env.ORRY_STACK_ANVIL_PORT ?? 18656);
const PG_PORT = Number(process.env.ORRY_STACK_PG_PORT ?? 55472);
const API_PORT = Number(process.env.ORRY_STACK_API_PORT ?? 18787);
const PG_NAME = process.env.ORRY_STACK_PG_NAME ?? "orrery-pg-orry-stack";
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const DATABASE_URL = `postgres://orrery:orrery@127.0.0.1:${PG_PORT}/orrery`;
const E18 = 10n ** 18n;
const USDG = 10n ** 6n;
/** The release seed: an empty list holds every feature (the table is filled once, all null). */
const SEED_OPEN = "";
const SEEDER = "dev-orry-stack";
/** The web's dev server on :3100, or on :3131 when another session holds 3100. */
const WEB_ORIGINS = ["3100", "3131"].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(",");

const log = (m: string) => console.log(`[orry-stack] ${m}`);
const free = (port: number) =>
  new Promise<boolean>((res) => {
    const srv = createServer().once("error", () => res(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => res(true)));
  });

let anvil: ChildProcess | undefined;
let pgStarted = false;
let sql: Sql | undefined;
let app: ReturnType<typeof buildApi> | undefined;
const stop = new AbortController();

async function shutdown(code: number) {
  stop.abort();
  await app?.close().catch(() => {});
  await sql?.end({ timeout: 2 }).catch(() => {});
  anvil?.kill("SIGTERM");
  if (pgStarted) {
    try {
      execFileSync("docker", ["stop", PG_NAME], { stdio: "ignore" });
    } catch {}
  }
  log("stopped: API, indexers, anvil and the Postgres container");
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

try {
  for (const p of [ANVIL_PORT, PG_PORT, API_PORT]) if (!(await free(p))) throw new Error(`port ${p} is in use; set ORRY_STACK_*_PORT`);

  // chain time starts four days back: 48 h for the coin plus a day of streams, then it is moved to the wall clock
  const genesis = Math.floor(Date.now() / 1000) - 4 * 86400;
  anvil = await startAnvil(ANVIL_PORT, ["--timestamp", String(genesis)]);
  log(`anvil on ${RPC} (chain 31337)`);
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", PG_NAME, "-e", "POSTGRES_USER=orrery", "-e", "POSTGRES_PASSWORD=orrery",
    "-e", "POSTGRES_DB=orrery", "-p", `127.0.0.1:${PG_PORT}:5432`, "postgres:17-alpine",
  ], { stdio: "ignore" });
  pgStarted = true;
  for (let i = 0; ; i++) {
    try {
      execFileSync("docker", ["exec", PG_NAME, "pg_isready", "-U", "orrery", "-d", "orrery"], { stdio: "ignore" });
      break;
    } catch {
      if (i > 200) throw new Error("Postgres did not start");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await new Promise((r) => setTimeout(r, 1_000));
  log(`postgres on 127.0.0.1:${PG_PORT} (container ${PG_NAME})`);

  const s = await deployOrrySystem(RPC);
  log("deployed v1, OrryStaking, OrreryTreasury, OrreryHook (flag address, hubs ORRY/ETH and ORRY/USDG), OrryBuyback (cashback 10%, no sink), OrryRewardsRouter, EarnVaultFactory (vaults ETH and USDG), ClaimAll, OrryLens");

  // activity: Earn deposits in both vaults, plain stakes, an agent stake with a lock, an unstake request, trading on both hubs
  await deposit(s, ROLE.alice, 30n * E18);
  await deposit(s, ROLE.bob, 20n * E18);
  await depositUsdg(s, ROLE.bob, 8_000n * USDG);
  await depositUsdg(s, ROLE.carol, 4_000n * USDG);
  await send(s, ROLE.bob, s.staking, rc.orryStakingAbi as Abi, "stake", [5_000_000n * E18]);
  await send(s, ROLE.carol, s.staking, rc.orryStakingAbi as Abi, "stake", [10_000_000n * E18]);
  await send(s, ROLE.operator, s.staking, rc.orryStakingAbi as Abi, "stakeForAgent", [s.agentId, 2_500_000n * E18]);
  const lockedUntil = BigInt(Math.floor(Date.now() / 1000)) + 30n * 86400n;
  await send(s, ROLE.operator, s.staking, rc.orryStakingAbi as Abi, "extendAgentLock", [s.agentId, lockedUntil]);
  await send(s, ROLE.bob, s.staking, rc.orryStakingAbi as Abi, "requestUnstake", [1_000_000n * E18]);
  await hubSwaps(s, 20);
  await usdgHubSwaps(s, 10);
  // the coin: revenue, proposeCoin, 48 hours, executeCoin; then one keeper pass (collect, harvest of both vaults, slice,
  // distribute, burnEth, buyWithQuote for USDG)
  await setCoin(s);
  await mine(s);
  const cfg = loadConfig({
    ...apiEnv(s, DATABASE_URL, {
      ORRERY_CONFIRMATIONS: "1",
      ORRERY_PORT: String(API_PORT),
      ORRERY_PUBLIC_URL: API,
      ORRERY_ORRY_FEATURES: SEED_OPEN,
      ORRERY_RELEASES_CACHE_MS: "2000",
      ORRERY_ORRY_SAMPLE_SECONDS: "5",
      ORRERY_ORRY_MIN_SAMPLES: "3",
      ORRERY_ORRY_SNAPSHOT_SECONDS: "30",
      ORRERY_ORRY_CACHE_MS: "2000",
    }),
    ORRERY_CORS_ORIGINS: process.env.ORRERY_CORS_ORIGINS ?? WEB_ORIGINS,
  });
  const steps = await runKeeperOnce(cfg, makeChain(cfg), anvilKey(ROLE.keeper));
  log(`keeper pass: ${steps.map((x) => `${x.action} ${x.status}${x.reason ? ` (${x.reason})` : ""}`).join(", ")}`);
  // B-2: ORRY notified to the USDG vault's reward stream (anyone may)
  const notified = 250_000n * E18;
  await send(s, ROLE.deployer, s.token, rc.mockOrryAbi as Abi, "approve", [s.vaultU, notified]);
  await send(s, ROLE.deployer, s.vaultU, rc.earnVaultAbi as Abi, "notifyRewards", [notified]);
  await hubSwaps(s, 6);
  await usdgHubSwaps(s, 4);
  await warp(s, 86400); // a day of the 7 day streams, so Earn fees and stake rewards are pending
  await send(s, ROLE.carol, s.staking, rc.orryStakingAbi as Abi, "claimRewards");

  // chain time to the wall clock, then a block a second
  const latest = (await s.pub.getBlock()).timestamp;
  const now = BigInt(Math.floor(Date.now() / 1000));
  await rpcCall(s, "evm_setNextBlockTimestamp", [toHex(now > latest ? now : latest + 1n)]);
  await mine(s);
  await rpcCall(s, "evm_setIntervalMining", [1]);

  // API and both indexers in this process, bound to 127.0.0.1
  sql = connect(cfg.databaseUrl);
  await migrate(sql);
  await seedReleases(sql, cfg.releaseSeed, `seed (${SEEDER})`);
  const chain = makeChain(cfg);
  app = buildApi(cfg, chain, sql);
  await app.listen({ port: API_PORT, host: "127.0.0.1" });
  log(`API on ${API} (every release held)`);
  void runIndexer(cfg, chain, sql, { startBlock: s.startBlock }, stop.signal);
  void runOrryIndexer(cfg, chain, sql, stop.signal, (m) => log(`orry indexer: ${m}`));

  // a credits burn through the API's own quote, once the sampler has enough prices: checkout opens for the seed only
  const cacheWait = () => new Promise((r) => setTimeout(r, cfg.releasesCacheMs + 500));
  await setRelease(sql, "checkout", new Date(), `${SEEDER} (seed burn)`);
  await cacheWait();
  const api = new OrryApi(API);
  const carol = s.wallet(ROLE.carol);
  let quote;
  for (let i = 0; !quote; i++) {
    quote = await api.quoteCredits(carol.account.address, 2).catch(() => undefined);
    if (!quote) {
      if (i > 60) throw new Error("no ORRY quote after 2 minutes");
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  const hash = await carol.sendTransaction({ to: s.treasury, data: orryCalls.burnForCredits(quote), chain: foundry, account: carol.account });
  await s.pub.waitForTransactionReceipt({ hash });
  log(`credits burn: 2 packs for ${quote.quote.orryAmount} ORRY base units (tx ${hash})`);
  for (let i = 0; i < 30; i++) {
    const [g] = await sql`select credits::text from orry_credit_grants where quote_id = ${quote.quote.quoteId.toLowerCase()}`;
    if (g) {
      log(`granted ${g.credits} checks to ${carol.account.address}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  await setRelease(sql, "checkout", null, `${SEEDER} (seed burn done)`);
  await cacheWait();
  const releases = (await (await fetch(`${API}/v1/releases`)).json()) as ReleasesResponse;
  const open = Object.entries(releases.releases).filter(([, at]) => at !== null).map(([f]) => f);
  if (open.length > 0) throw new Error(`releases not all held at start: ${open.join(", ")}`);
  log(`releases: all ${Object.keys(releases.releases).length} held (GET /v1/releases)`);

  const web: Record<string, string> = {
    NEXT_PUBLIC_CHAIN_ID: "31337",
    NEXT_PUBLIC_RPC_URL: RPC,
    NEXT_PUBLIC_API_URL: API,
    NEXT_PUBLIC_MODULE: s.module,
    NEXT_PUBLIC_ATTESTOR: s.attestor,
    NEXT_PUBLIC_LENS: s.orreryLens,
    NEXT_PUBLIC_REGISTRY: s.registry,
    NEXT_PUBLIC_USDG: s.usdg,
    NEXT_PUBLIC_ORRY_TOKEN: s.token,
    NEXT_PUBLIC_ORRY_EARN_FACTORY: s.earnFactory,
    NEXT_PUBLIC_ORRY_EARN_VAULT: s.vault,
    NEXT_PUBLIC_ORRY_STAKING: s.staking,
    NEXT_PUBLIC_ORRY_CLAIM_ALL: s.claimAll,
    NEXT_PUBLIC_ORRY_REWARDS_ROUTER: s.router,
    NEXT_PUBLIC_ORRY_TREASURY: s.treasury,
  };
  const people = {
    "anvil index 3, owner of agent 1 (agent stake with a lock)": s.address(ROLE.operator),
    "anvil index 4, owner of agent 2 (not verified: verification checkout)": s.address(ROLE.agentOwner2),
    "anvil index 7, Earn in the ETH vault only": s.address(ROLE.alice),
    "anvil index 8, Earn in both vaults and plain stake (one unstake request)": s.address(ROLE.bob),
    "anvil index 9, Earn in the USDG vault, plain stake, claimed rewards, bought 2 packs with ORRY": s.address(ROLE.carol),
  };
  const contracts = {
    hook: s.hook, buyback: s.buyback, lens: s.lens, earnFactory: s.earnFactory, earnVaultEth: s.vault, earnVaultUsdg: s.vaultU,
    poolManager: rc.poolManagerAddress, ethHubPoolId: s.hubPoolId, usdgHubPoolId: s.usdgHubPoolId, ethUsdgPoolId: s.usdPoolId,
  };
  mkdirSync(join(here, "../.local"), { recursive: true });
  writeFileSync(join(here, "../.local/orry-stack.web.env"), Object.entries(web).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  writeFileSync(join(here, "../.local/orry-stack.json"), JSON.stringify({ web, people, contracts, ports: { anvil: ANVIL_PORT, postgres: PG_PORT, api: API_PORT } }, null, 2));
  const lag = await orryLag(sql);
  console.log("\n# web env (also in services/.local/orry-stack.web.env)");
  for (const [k, v] of Object.entries(web)) console.log(`${k}=${v}`);
  console.log("\n# seeded wallets (standard anvil test mnemonic)");
  for (const [k, v] of Object.entries(people)) console.log(`${v}  ${k}`);
  console.log(`\n# other contracts\n${Object.entries(contracts).map(([k, v]) => `${k}=${v}`).join("\n")}`);
  console.log(`\n# release switch (no restart; the API rereads within ${cfg.releasesCacheMs} ms)`);
  console.log(`ORRERY_DATABASE_URL=${DATABASE_URL} ORRERY_ORRY_FEATURES= pnpm exec tsx scripts/releases.ts set <feature> now|null|<ISO time>`);
  log(`ready. ORRY indexer at block ${lag?.last} of ${lag?.head}. Ctrl-C stops everything.`);
} catch (e) {
  console.error(`[orry-stack] failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  await shutdown(1);
}
