/**
 * Orrery go-live on Robinhood Chain mainnet 4663: everything after deploy-4663.ts (and deploy-orry-4663.ts) in one
 * script, so launch day is a few commands instead of the manual runbook (docs/HOSTING-4663.md sections 3 to 4).
 *
 *   tsx scripts/go-live-4663.ts env     [--fork --rpc <url>]   env files in ops/server1/out/<target>/ from deployments/*.json
 *   tsx scripts/go-live-4663.ts server  [--fork] [--dry-run]   server 1 (keys, pg password, env, image, compose, releases held,
 *                                                              health); --fork rehearses the same compose.yml in local Docker
 *   tsx scripts/go-live-4663.ts dns     [--dry-run]            api.orrery.tech A record (Hostinger API) and the Caddy block
 *   tsx scripts/go-live-4663.ts vercel  [--dry-run]            production env on the Vercel project `orrery`, then deploy
 *   tsx scripts/go-live-4663.ts check   [--fork]               health, indexer lag, releases, the X gate on orrery.tech
 *
 * Mainnet stages print what they will do and wait for a typed CONFIRM; --dry-run prints and sends nothing. Keys come
 * from ~/.secrets/orrery/ and are copied, never printed. The deployer key never leaves the laptop. --fork uses
 * deployments/*-fork.json and the 46630 development keys, as the deploy scripts' own --fork mode does.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { RELEASE_FEATURES } from "@orrery/shared";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OPS = join(ROOT, "ops/server1");
const SECRETS = join(homedir(), ".secrets/orrery");
const [stage = ""] = process.argv.slice(2);
const flag = (n: string) => process.argv.includes(n);
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const FORK = flag("--fork");
const DRY = flag("--dry-run");
const TARGET = FORK ? "fork" : "mainnet";
const OUT = join(OPS, "out", TARGET);
const HOST = arg("--host") ?? "server1";
const SERVER_IP = "187.53.130.188";
const API_HOST = "api.orrery.tech";
const KEYS = FORK ? "46630" : "mainnet";
const REHEARSAL_DIR = join(ROOT, "ops/server1/out/rehearsal");
const VERCEL = { org: "team_wRfsbfi0dD9R8aLIlSrQAvRX", project: "prj_EnJvBohVCy94TRGI3eWVCWovKNEX" }; // Vercel project "orrery"

const log = (s: string) => console.log(s);
const fail = (s: string): never => {
  console.error(`stopped: ${s}`);
  process.exit(1);
};
type Json = Record<string, unknown>;
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Json;
const isAddr = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** Runs a command (or prints it on --dry-run). `secret` hides the arguments from the log. */
function run(cmd: string, args: string[], opts: { input?: string; secret?: boolean; allowFail?: boolean; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const shown = opts.secret ? `${cmd} <hidden>` : `${cmd} ${args.join(" ")}`;
  if (DRY) {
    log(`  would run: ${shown}`);
    return "";
  }
  const r = spawnSync(cmd, args, { input: opts.input, encoding: "utf8", cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !opts.allowFail) fail(`${shown} exited ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(-400)}`);
  return (r.stdout ?? "").trim();
}
const ssh = (script: string, opts: { allowFail?: boolean } = {}) => run("ssh", [HOST, script], opts);

async function confirm(summary: string[]) {
  log(summary.join("\n"));
  if (DRY || FORK) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Type CONFIRM to go on (anything else stops): ");
  rl.close();
  if (answer.trim() !== "CONFIRM") fail("not confirmed, nothing was sent");
}

// ------------------------------------------------------------------ deployments

function deployments() {
  const v1Path = join(ROOT, `deployments/${FORK ? "4663-fork" : "4663"}.json`);
  if (!existsSync(v1Path)) fail(`${v1Path} is missing: run deploy-4663.ts${FORK ? " --fork" : ""} first`);
  const v1 = readJson(v1Path);
  const orryPath = join(ROOT, `deployments/orry-${FORK ? "4663-fork" : "4663"}.json`);
  const orry = existsSync(orryPath) ? readJson(orryPath) : null;
  for (const k of ["attestor", "module", "lens", "registry", "usdg", "treasury"]) if (!isAddr(v1[k])) fail(`v1 ${k} is not an address`);
  if (orry) for (const k of ["orry", "hook", "earnFactory", "staking", "router", "buyback", "lens", "claimAll", "vaultEth"]) if (!isAddr(orry[k])) fail(`orry ${k} is not an address`);
  if (orry && String(orry.treasury).toLowerCase() !== String(v1.treasury).toLowerCase()) fail("the ORRY deployment names another treasury than the v1 deployment");
  const marketsPath = join(ROOT, `deployments/markets-${FORK ? "4663-fork" : "4663"}.json`);
  const markets = existsSync(marketsPath) ? readJson(marketsPath) : null;
  if (markets && !isAddr(markets.factory)) fail("markets factory is not an address");
  const facilitatorPath = join(ROOT, `deployments/facilitator-${FORK ? "4663-fork" : "4663"}.json`);
  const facilitator = existsSync(facilitatorPath) ? readJson(facilitatorPath) : null;
  if (facilitator && (!isAddr(facilitator.factory) || !isAddr(facilitator.proxy))) fail("facilitator factory or proxy is not an address");
  if (facilitator && !markets) fail("the facilitator reads stake discounts from the markets' FeeTiers: deploy the markets first");
  return { v1, orry, markets, facilitator };
}

// ------------------------------------------------------------------ env

function envFiles(rpc: string) {
  const { v1, orry, markets, facilitator } = deployments();
  const common: Record<string, string> = {
    ORRERY_CHAIN_ID: "4663",
    ORRERY_RPC_URL: rpc,
    ORRERY_DATABASE_URL: "postgres://orrery:<pg-password>@orrery-pg:5432/orrery",
    ORRERY_PUBLIC_URL: FORK ? "http://127.0.0.1:18787" : `https://${API_HOST}`,
    ORRERY_CONFIRMATIONS: FORK ? "2" : "10",
    ORRERY_MODULE: String(v1.module),
    ORRERY_ATTESTOR: String(v1.attestor),
    ORRERY_LENS: String(v1.lens),
    ORRERY_REGISTRY: String(v1.registry),
    ORRERY_USDG: String(v1.usdg),
    ORRERY_TREASURY: String(v1.treasury),
    ORRERY_INDEXER_START_BLOCK: String(v1.deployBlock),
    ORRERY_RELAYER_KEY_FILE: "/run/keys/relayer.json",
    ORRERY_CHECK_SIGNER_KEY_FILE: "/run/keys/check-signer.json",
    ORRERY_ATTESTER_KEY_FILE: "/run/keys/attester.json",
  };
  if (orry) {
    Object.assign(common, {
      ORRERY_ORRY_TOKEN: String(orry.orry),
      ORRERY_ORRY_HOOK: String(orry.hook),
      ORRERY_ORRY_EARN_FACTORY: String(orry.earnFactory),
      ORRERY_ORRY_STAKING: String(orry.staking),
      ORRERY_ORRY_ROUTER: String(orry.router),
      ORRERY_ORRY_BUYBACK: String(orry.buyback),
      ORRERY_ORRY_LENS: String(orry.lens),
      ORRERY_ORRY_CLAIM_ALL: String(orry.claimAll),
      ORRERY_ORRY_TREASURY: String(v1.treasury),
      ORRERY_ORRY_USD_POOL_ID: String(orry.usdPoolId),
      ORRERY_ORRY_START_BLOCK: String(orry.deployBlock),
    });
  }
  if (markets) {
    Object.assign(common, {
      ORRERY_MARKET_FACTORY: String(markets.factory),
      ORRERY_MARKETS_START_BLOCK: String(markets.startBlock),
    });
  }
  if (facilitator && markets) {
    Object.assign(common, {
      ORRERY_SPLITTER_FACTORY: String(facilitator.factory),
      ORRERY_X402_PERMIT2_PROXY: String(facilitator.proxy),
      ORRERY_PERMIT2: String(facilitator.permit2),
      ORRERY_FACILITATOR_START_BLOCK: String(facilitator.startBlock),
      ORRERY_FEE_TIERS: String(markets.feeTiers),
    });
  }
  const cors = FORK ? "http://localhost:3100,http://127.0.0.1:3100" : "https://orrery.tech,https://www.orrery.tech";
  const api = {
    ORRERY_CORS_ORIGINS: cors,
    ORRERY_QUOTE_SIGNER_KEY_FILE: "/run/keys/quote-signer.json",
    ORRERY_TRUST_PROXY: "loopback,linklocal,uniquelocal",
  };
  const web: Record<string, string> = {
    NEXT_PUBLIC_CHAIN_ID: "4663",
    NEXT_PUBLIC_API_URL: FORK ? "http://127.0.0.1:18787" : `https://${API_HOST}`,
    NEXT_PUBLIC_MODULE: String(v1.module),
    NEXT_PUBLIC_ATTESTOR: String(v1.attestor),
    NEXT_PUBLIC_LENS: String(v1.lens),
    NEXT_PUBLIC_REGISTRY: String(v1.registry),
    NEXT_PUBLIC_USDG: String(v1.usdg),
  };
  if (FORK) web.NEXT_PUBLIC_RPC_URL = rpc.split(",")[0]!.replace("10.232.9.1", "127.0.0.1");
  if (orry) {
    Object.assign(web, {
      NEXT_PUBLIC_ORRY_TOKEN: String(orry.orry),
      NEXT_PUBLIC_ORRY_EARN_FACTORY: String(orry.earnFactory),
      NEXT_PUBLIC_ORRY_STAKING: String(orry.staking),
      NEXT_PUBLIC_ORRY_CLAIM_ALL: String(orry.claimAll),
      NEXT_PUBLIC_ORRY_REWARDS_ROUTER: String(orry.router),
      NEXT_PUBLIC_ORRY_TREASURY: String(v1.treasury),
    });
  }
  if (markets) Object.assign(web, { NEXT_PUBLIC_MARKET_FACTORY: String(markets.factory), NEXT_PUBLIC_MARKETS_RELAY: "1" });
  if (facilitator) web.NEXT_PUBLIC_SPLITTER_FACTORY = String(facilitator.factory);
  return { common, api, web, orry: Boolean(orry), markets: Boolean(markets), facilitator: Boolean(facilitator) };
}

const dotenv = (o: Record<string, string>, head: string) =>
  `# ${head}\n# Written by scripts/go-live-4663.ts ${new Date().toISOString()} from deployments/*.json. No secrets in this file.\n` +
  Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";

function writeEnv() {
  // Containers reach the laptop's fork through the compose network's gateway (10.232.9.1, see compose.yml); anvil must
  // listen on 0.0.0.0 for that.
  const rpc = arg("--rpc") ?? (FORK ? "http://10.232.9.1:18548" : "https://rpc.mainnet.chain.robinhood.com,https://rpc-robinhood.blockmachine.io");
  const e = envFiles(rpc);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "common.env"), dotenv(e.common, `Orrery ${TARGET}, every service`));
  writeFileSync(join(OUT, "api.env"), dotenv(e.api, `Orrery ${TARGET}, API only`));
  writeFileSync(join(OUT, "web.env"), dotenv(e.web, `Orrery ${TARGET}, Vercel production env of the web`));
  log(`wrote ${OUT}/common.env, api.env, web.env (ORRY ${e.orry ? "included" : "not deployed yet, left out"}; markets ${e.markets ? "included" : "not deployed yet, left out"})`);
  return e;
}

// ------------------------------------------------------------------ server

function imageTag() {
  const sha = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--", "services"], { encoding: "utf8" }).trim();
  if (dirty && !FORK) fail("services/ has uncommitted changes; commit first so the image tag names what runs");
  return sha;
}

function buildImage(tag: string) {
  const have = spawnSync("docker", ["image", "inspect", `orrery-services:${tag}`], { encoding: "utf8" }).status === 0;
  if (have) return log(`image orrery-services:${tag} is built`);
  run("heavy", ["docker", "build", "-q", "-f", join(OPS, "services.Dockerfile"), "-t", `orrery-services:${tag}`, join(ROOT, "services")]);
}

async function server() {
  const e = writeEnv();
  const tag = imageTag();
  const services = ["postgres", "api", "indexer", "prober", ...(e.orry ? ["keeper"] : []), ...(e.markets ? ["market-keeper", "market-relay"] : [])];
  const profiles = [...(e.orry ? ["--profile", "orry"] : []), ...(e.markets ? ["--profile", "markets"] : [])];
  const keys = ["relayer", "check-signer", "attester", "quote-signer", ...(e.orry ? ["keeper"] : []), ...(e.markets ? ["market-keeper", "reveal-relay"] : [])];
  for (const k of keys) if (!existsSync(join(SECRETS, `${KEYS}-${k}.json`))) fail(`~/.secrets/orrery/${KEYS}-${k}.json is missing`);

  if (FORK) {
    // Local rehearsal of the server layout: compose.yml, env files and secrets in one folder, as /opt/orrery is.
    await confirm([`rehearsal in local Docker: project orrery-rehearsal, folder ${REHEARSAL_DIR}, image ${tag}, services ${services.join(" ")}`]);
    const sec = join(REHEARSAL_DIR, "secrets");
    mkdirSync(sec, { recursive: true });
    chmodSync(sec, 0o700);
    for (const k of keys) {
      copyFileSync(join(SECRETS, `${KEYS}-${k}.json`), join(sec, `${KEYS}-${k}.json`));
      chmodSync(join(sec, `${KEYS}-${k}.json`), 0o600);
    }
    const pgFile = join(sec, "pg-password");
    if (!existsSync(pgFile)) writeFileSync(pgFile, execFileSync("openssl", ["rand", "-hex", "24"], { encoding: "utf8" }).trim(), { mode: 0o600 });
    const pg = readFileSync(pgFile, "utf8").trim();
    copyFileSync(join(OPS, "compose.yml"), join(REHEARSAL_DIR, "compose.yml"));
    writeFileSync(join(REHEARSAL_DIR, "common.env"), readFileSync(join(OUT, "common.env"), "utf8").replace("<pg-password>", pg), { mode: 0o600 });
    copyFileSync(join(OUT, "api.env"), join(REHEARSAL_DIR, "api.env"));
    writeFileSync(join(REHEARSAL_DIR, "release.env"), `TAG=${tag}\nORRERY_DIR=${REHEARSAL_DIR}\nORRERY_KEYS=${KEYS}\n`);
    // compose.yml joins the shared edge network that server 1 has; a local stand-in keeps the file unchanged
    if (spawnSync("docker", ["network", "inspect", "infra_default"]).status !== 0) run("docker", ["network", "create", "infra_default"]);
    buildImage(tag);
    run("docker", ["compose", "-p", "orrery-rehearsal", "--env-file", join(REHEARSAL_DIR, "release.env"), "-f", join(REHEARSAL_DIR, "compose.yml"), ...profiles, "up", "-d", ...services]);
  } else {
    await confirm([
      `go-live on ${HOST} (server 1): /opt/orrery, image orrery-services:${tag}, services ${services.join(" ")}`,
      `  keys copied: ${keys.map((k) => `${KEYS}-${k}.json`).join(", ")} (the deployer key stays on this laptop)`,
      `  every release stays held; nothing opens until releases.ts sets a time`,
    ]);
    ssh("install -d -m 700 /opt/orrery/secrets");
    for (const k of keys) {
      run("scp", ["-q", join(SECRETS, `${KEYS}-${k}.json`), `${HOST}:/opt/orrery/secrets/${KEYS}-${k}.json`]);
    }
    ssh("chmod 600 /opt/orrery/secrets/*; test -s /opt/orrery/secrets/pg-password || (umask 077; openssl rand -hex 24 > /opt/orrery/secrets/pg-password)");
    // the services run as the image's `node` user (uid 1000): a key file left to root at mode 600 stops them at start
    // (first mainnet run, 2026-11-11: EACCES on /run/keys/relayer.json)
    ssh(`chown 1000:1000 ${keys.map((k) => `/opt/orrery/secrets/${KEYS}-${k}.json`).join(" ")}`);
    run("scp", ["-q", join(OPS, "compose.yml"), join(OPS, "Caddyfile-block"), `${HOST}:/opt/orrery/`]);
    run("scp", ["-q", join(OUT, "common.env"), join(OUT, "api.env"), `${HOST}:/opt/orrery/`]);
    ssh(`cd /opt/orrery && chmod 600 common.env api.env && sed -i "s|<pg-password>|$(cat secrets/pg-password)|" common.env && printf 'TAG=${tag}\\n' > release.env`);
    buildImage(tag);
    run("bash", ["-c", `docker save orrery-services:${tag} | gzip -1 | ssh ${HOST} 'gunzip | docker load'`]);
    ssh(`cd /opt/orrery && docker compose -p orrery-mainnet --env-file release.env -f compose.yml ${profiles.join(" ")} up -d ${services.join(" ")}`);
  }
  await holdReleases();
  await check();
}

/** Every release held until the launch plan sets its time (the API seeds held on 4663; this proves it). */
async function holdReleases() {
  const exec = (a: string[]) =>
    FORK ? run("docker", ["exec", "orrery-api", "/app/node_modules/.bin/tsx", "/app/scripts/releases.ts", ...a], { allowFail: true }) : ssh(`docker exec orrery-api /app/node_modules/.bin/tsx /app/scripts/releases.ts ${a.join(" ")}`, { allowFail: true });
  if (DRY) return log("  would check every release is held");
  for (let i = 0; i < 30; i++) {
    const list = exec(["list"]);
    if (list.includes("held") || list.includes("open")) {
      const open = list.split("\n").filter((l) => /\bopen\b/.test(l)).map((l) => l.trim().split(/\s+/)[0]!);
      for (const f of open) exec(["set", f, "null"]);
      log(`releases: ${RELEASE_FEATURES.length} known, ${open.length ? `held again: ${open.join(", ")}` : "all held"}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail("the API did not answer releases.ts list within a minute");
}

// ------------------------------------------------------------------ dns and caddy

async function dns() {
  const tokenFile = join(homedir(), ".claude/secrets/hostinger-api-token.txt");
  if (!existsSync(tokenFile)) fail("the Hostinger token file is missing");
  const token = readFileSync(tokenFile, "utf8").trim();
  const base = "https://developers.hostinger.com/api/dns/v1/zones/orrery.tech";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" };
  const zone = (await (await fetch(base, { headers })).json()) as { name: string; type: string; records: { content: string }[] }[];
  if (!Array.isArray(zone)) fail("could not read the orrery.tech zone");
  const have = zone.find((r) => r.name === "api" && r.type === "A");
  // read-only, so it runs on --dry-run too
  const caddyHas = execFileSync("ssh", [HOST, `grep -c '^${API_HOST} {' /opt/phioradata/infra/Caddyfile || true`], { encoding: "utf8" }).trim();
  await confirm([
    `DNS: ${have ? `api A record exists (${have.records.map((r) => r.content).join(", ")})` : `add A record api.orrery.tech -> ${SERVER_IP}, TTL 300`}`,
    `Caddy: ${caddyHas && caddyHas !== "0" ? "block already in /opt/phioradata/infra/Caddyfile" : "append ops/server1/Caddyfile-block, reload from a docker cp copy"}`,
  ]);
  if (!have && !DRY) {
    const body = JSON.stringify({ overwrite: false, zone: [{ name: "api", type: "A", ttl: 300, records: [{ content: SERVER_IP }] }] });
    const v = await fetch(`${base}/validate`, { method: "POST", headers, body });
    if (!v.ok) fail(`Hostinger validate answered ${v.status}`);
    const p = await fetch(base, { method: "PUT", headers, body });
    if (!p.ok) fail(`Hostinger update answered ${p.status}`);
    log("DNS: api.orrery.tech added");
  } else if (have && !have.records.some((r) => r.content === SERVER_IP)) fail(`api.orrery.tech points elsewhere (${have.records.map((r) => r.content).join(", ")}); fix it by hand`);
  if (!caddyHas || caddyHas === "0") {
    // The container's own Caddyfile is a stale bind mount: reload from a copy of the host file (memory: server 1 inventory).
    ssh(`cp /opt/phioradata/infra/Caddyfile /opt/phioradata/infra/Caddyfile.bak-$(date +%Y%m%d%H%M%S) && printf '\\n' >> /opt/phioradata/infra/Caddyfile && grep -v '^#' /opt/orrery/Caddyfile-block >> /opt/phioradata/infra/Caddyfile`);
    ssh("docker cp /opt/phioradata/infra/Caddyfile infra-caddy-1:/tmp/Caddyfile.current && docker exec infra-caddy-1 caddy reload --config /tmp/Caddyfile.current --adapter caddyfile");
    if (!DRY) log("Caddy: block added and reloaded");
  }
}

// ------------------------------------------------------------------ vercel

async function vercel() {
  const e = writeEnv();
  await confirm([`Vercel project orrery (${VERCEL.project}): set ${Object.keys(e.web).length} production variables, then deploy --prod from services/`, ...Object.entries(e.web).map(([k, v]) => `  ${k}=${v}`)]);
  const env = { VERCEL_ORG_ID: VERCEL.org, VERCEL_PROJECT_ID: VERCEL.project };
  const cwd = join(ROOT, "services");
  for (const [k, v] of Object.entries(e.web)) {
    run("vercel", ["env", "rm", k, "production", "--yes"], { cwd, env, allowFail: true });
    run("vercel", ["env", "add", k, "production"], { cwd, env, input: v });
  }
  log(run("vercel", ["deploy", "--prod", "--yes"], { cwd, env }).split("\n").filter((l) => /Production|Aliased/.test(l)).join("\n"));
}

// ------------------------------------------------------------------ check

async function check() {
  if (DRY) return log("  would check health, indexer lag, releases and the X gate");
  const api = FORK ? "http://127.0.0.1:18787" : `https://${API_HOST}`;
  const get = async (u: string) => {
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
        if (r.ok) return await r.text();
      } catch {
        /* retry */
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    return fail(`${u} did not answer`);
  };
  log(`api health: ${await get(`${api}/health`)}`);
  const idx = FORK ? await get("http://127.0.0.1:18788/") : ssh("curl -s -m 5 127.0.0.1:18788/");
  log(`indexer: ${idx}`);
  const rel = JSON.parse(await get(`${api}/v1/releases`)) as { releases: Record<string, string | null> };
  const open = Object.entries(rel.releases).filter(([, v]) => v !== null).map(([k]) => k);
  log(`releases: ${open.length ? `open ${open.join(", ")}` : "all held"}`);
  if (!FORK) {
    const home = await get("https://orrery.tech/");
    // The X handle comes from NEXT_PUBLIC_X_HANDLE (web/components/social.ts); no handle means the site shows no X link.
    const handle = (process.env.NEXT_PUBLIC_X_HANDLE ?? "").replace(/^@/, "");
    if (handle) {
      const x = home.includes(`href="https://x.com/${handle}"`) && home.includes(`twitter:site" content="@${handle}"`);
      log(`X gate on orrery.tech: ${x ? "pass" : "FAIL"}`);
    } else log("X gate on orrery.tech: skipped (NEXT_PUBLIC_X_HANDLE not set)");
  }
}

// ------------------------------------------------------------------ main

const stages: Record<string, () => unknown> = { env: writeEnv, server, dns, vercel, check };
if (!stages[stage]) fail(`unknown stage "${stage}"; use one of: ${Object.keys(stages).join(", ")}`);
if (FORK && ["dns", "vercel"].includes(stage) && !DRY) fail(`${stage} touches the real domain or Vercel; with --fork only --dry-run`);
await stages[stage]!();
