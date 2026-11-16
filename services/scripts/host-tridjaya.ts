/**
 * Orrery's services on the Tridjaya host (ssh alias `vps`) while server 1 is suspended: systemd units, the host's
 * Postgres 16 and nginx, the same pattern Oraqle and Quero use there (no Docker on that host).
 *
 *   tsx scripts/host-tridjaya.ts prep     user, folders, database, DNS for api.orreryagent.com, nginx, TLS certificate
 *   tsx scripts/host-tridjaya.ts deploy   code, dependencies, env, keys, units api + indexer + prober, every release held
 *   tsx scripts/host-tridjaya.ts check    unit state, API health, indexer lag, releases
 *
 * prep needs no contracts. deploy needs ops/server1/out/mainnet/{common,api}.env, written by
 * `tsx scripts/go-live-4663.ts env` after deploy-4663.ts has written deployments/4663.json. Each stage prints what it
 * will change and waits for a typed CONFIRM. Keys come from ~/.secrets/orrery/mainnet-<role>.json and are copied,
 * never printed; the deployer key never leaves this laptop. Files: ops/tridjaya/.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { RELEASE_FEATURES } from "@orrery/shared";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OPS = join(ROOT, "ops/tridjaya");
const ENV_DIR = join(ROOT, "ops/server1/out/mainnet");
const SECRETS = join(homedir(), ".secrets/orrery");
const HOST = "vps";
const API_HOST = "api.orreryagent.com";
const IPV4 = "72.60.237.158";
const IPV6 = "2a02:4780:5e:fbcc::1";
const API_PORT = 18787;
const INDEXER_PORT = 18788;
const UNITS = ["api", "indexer", "prober"];
const KEYS = ["relayer", "check-signer", "attester", "quote-signer"];
const NODE = "/opt/node24/bin/node";
const TSX = "/opt/orrery/app/node_modules/tsx/dist/cli.mjs";
const [stage = ""] = process.argv.slice(2);

const log = (s: string) => console.log(s);
const fail = (s: string): never => {
  console.error(`stopped: ${s}`);
  process.exit(1);
};
const ssh = (script: string, input?: string) =>
  execFileSync("ssh", ["-o", "BatchMode=yes", HOST, `set -euo pipefail\n${script}`], { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] });
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

async function confirm(lines: string[]) {
  log(lines.join("\n"));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Type CONFIRM to go on: ");
  rl.close();
  if (answer.trim() !== "CONFIRM") fail("not confirmed, nothing was changed");
}

// ------------------------------------------------------------------ prep

async function dnsRecords() {
  const token = readFileSync(join(homedir(), ".claude/secrets/hostinger-api-token.txt"), "utf8").trim();
  const base = "https://developers.hostinger.com/api/dns/v1/zones/orreryagent.com";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" };
  const zone = [
    { name: "api", type: "A", ttl: 300, records: [{ content: IPV4 }] },
    { name: "api", type: "AAAA", ttl: 300, records: [{ content: IPV6 }] },
  ];
  const r = await fetch(base, { method: "PUT", headers, body: JSON.stringify({ overwrite: true, zone }) });
  if (!r.ok) fail(`Hostinger DNS answered ${r.status}: ${await r.text()}`);
  log(`DNS: ${API_HOST} A ${IPV4}, AAAA ${IPV6}`);
}

async function prep() {
  await confirm([
    `Tridjaya host (${HOST}), Orrery preparation:`,
    "  system user orrery; /opt/orrery and /etc/orrery (700)",
    "  Postgres 16: role and database orrery, password in /etc/orrery/pg-password (600)",
    `  DNS: ${API_HOST} -> ${IPV4} / ${IPV6} (Hostinger API)`,
    `  nginx site orrery (${API_HOST} -> 127.0.0.1:${API_PORT}), Let's Encrypt certificate by webroot`,
    "  nothing else on the host is touched; no Orrery process starts yet",
  ]);
  ssh(`
id orrery >/dev/null 2>&1 || useradd --system --home /opt/orrery --shell /usr/sbin/nologin orrery
install -d -o orrery -g orrery -m 755 /opt/orrery
install -d -o orrery -g orrery -m 700 /etc/orrery /etc/orrery/keys
test -s /etc/orrery/pg-password || (umask 077; openssl rand -hex 24 > /etc/orrery/pg-password)
chown orrery:orrery /etc/orrery/pg-password; chmod 600 /etc/orrery/pg-password
PW=$(cat /etc/orrery/pg-password)
if sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='orrery'" | grep -q 1; then
  sudo -u postgres psql -q -c "alter role orrery with login password '$PW'"
else
  sudo -u postgres psql -q -c "create role orrery with login password '$PW'"
fi
sudo -u postgres psql -tAc "select 1 from pg_database where datname='orrery'" | grep -q 1 || sudo -u postgres createdb -O orrery orrery
echo "postgres ready"`);
  await dnsRecords();
  const site = readFileSync(join(OPS, "nginx-orrery.conf"), "utf8");
  const httpOnly = site.split("#HTTPS")[0]!;
  ssh(`cat > /etc/nginx/sites-available/orrery; ln -sf /etc/nginx/sites-available/orrery /etc/nginx/sites-enabled/orrery; nginx -t 2>&1 | tail -1; systemctl reload nginx`, httpOnly);
  // Let's Encrypt needs the new record to resolve; public resolvers see it within a few minutes of the change.
  for (let i = 0; ; i++) {
    const seen = sh("dig", ["+short", "A", API_HOST, "@1.1.1.1"]).trim();
    if (seen === IPV4) break;
    if (i >= 60) fail(`${API_HOST} does not resolve to ${IPV4} yet; run prep again later`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  ssh(`test -e /etc/letsencrypt/live/${API_HOST}/fullchain.pem || certbot certonly --webroot -w /var/www/acme-temp -d ${API_HOST} --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring -q
echo "certificate ready"`);
  ssh(`cat > /etc/nginx/sites-available/orrery; nginx -t 2>&1 | tail -1; systemctl reload nginx`, site.replace("#HTTPS\n", ""));
  log(`prep done: https://${API_HOST} answers 502 until deploy starts the API`);
}

// ------------------------------------------------------------------ deploy

function envFor(file: string, pg: string) {
  const path = join(ENV_DIR, file);
  if (!existsSync(path)) fail(`${path} is missing: run deploy-4663.ts, then go-live-4663.ts env`);
  return readFileSync(path, "utf8")
    .replace(/postgres:\/\/orrery:[^@\s]*@orrery-pg:5432\/orrery/, `postgres://orrery:${pg}@127.0.0.1:5432/orrery`)
    .replaceAll("/run/keys/", "/etc/orrery/keys/");
}

async function deploy() {
  const sha = sh("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]).trim();
  if (sh("git", ["-C", ROOT, "status", "--porcelain", "--", "services"]).trim()) fail("services/ has uncommitted changes; commit first");
  for (const k of KEYS) if (!existsSync(join(SECRETS, `mainnet-${k}.json`))) fail(`~/.secrets/orrery/mainnet-${k}.json is missing`);
  await confirm([
    `Tridjaya host (${HOST}), Orrery deploy at ${sha}:`,
    "  code to /opt/orrery/app (shared, sdk, server, releases.ts), pnpm install --frozen-lockfile there",
    `  keys copied to /etc/orrery/keys: ${KEYS.join(", ")} (the deployer key stays on this laptop)`,
    `  /etc/orrery/common.env and api.env from ops/server1/out/mainnet; API on 127.0.0.1:${API_PORT}, indexer health :${INDEXER_PORT}`,
    `  units orrery@${UNITS.join(", orrery@")} enabled and started; every release stays held`,
  ]);
  // Code: a tarball of the tracked files the services need, unpacked over a clean app folder.
  const tar = execFileSync("git", ["-C", join(ROOT, "services"), "archive", "--format=tar", "HEAD", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "tsconfig.json", "packages/shared", "packages/sdk", "packages/server", "packages/web/package.json", "scripts/releases.ts"]);
  execFileSync("ssh", ["-o", "BatchMode=yes", HOST, "rm -rf /opt/orrery/app.new && mkdir -p /opt/orrery/app.new && tar -x -C /opt/orrery/app.new"], { input: tar, stdio: ["pipe", "inherit", "inherit"] });
  ssh(`
install -m 644 /dev/stdin /opt/orrery/bind-loopback.cjs`, readFileSync(join(OPS, "bind-loopback.cjs"), "utf8"));
  ssh(`
cd /opt/orrery/app.new
export PATH=/opt/node24/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install --frozen-lockfile --filter @orrery/server... --filter orrery-services --reporter=silent
echo ${sha} > REVISION
chown -R orrery:orrery /opt/orrery/app.new
rm -rf /opt/orrery/app.old; test -d /opt/orrery/app && mv /opt/orrery/app /opt/orrery/app.old; mv /opt/orrery/app.new /opt/orrery/app
echo "code ${sha} installed"`);
  for (const k of KEYS) ssh(`install -o orrery -g orrery -m 400 /dev/stdin /etc/orrery/keys/${k}.json`, readFileSync(join(SECRETS, `mainnet-${k}.json`), "utf8"));
  const pg = ssh("cat /etc/orrery/pg-password").trim();
  const common = `${envFor("common.env", pg)}ORRERY_PORT=${API_PORT}\nORRERY_INDEXER_HEALTH_PORT=${INDEXER_PORT}\n`;
  ssh("install -o orrery -g orrery -m 600 /dev/stdin /etc/orrery/common.env", common);
  ssh("install -o orrery -g orrery -m 600 /dev/stdin /etc/orrery/api.env", envFor("api.env", pg));
  ssh("install -m 644 /dev/stdin /etc/systemd/system/orrery@.service", readFileSync(join(OPS, "orrery@.service"), "utf8"));
  ssh(`systemctl daemon-reload; systemctl enable --now ${UNITS.map((u) => `orrery@${u}`).join(" ")}; systemctl restart ${UNITS.map((u) => `orrery@${u}`).join(" ")}; echo "units started"`);
  await holdReleases();
  await check();
}

const releases = (args: string) =>
  ssh(`cd /opt/orrery/app; set -a; . /etc/orrery/common.env; set +a; runuser -u orrery -- ${NODE} ${TSX} scripts/releases.ts ${args}`);

async function holdReleases() {
  for (let i = 0; i < 30; i++) {
    let list = "";
    try {
      list = releases("list");
    } catch {
      /* the API creates the table on start */
    }
    if (/\b(held|open)\b/.test(list)) {
      const open = list.split("\n").filter((l) => /\bopen\b/.test(l)).map((l) => l.trim().split(/\s+/)[0]!);
      for (const f of open) releases(`set ${f} null`);
      return log(`releases: ${RELEASE_FEATURES.length} known, ${open.length ? `held again: ${open.join(", ")}` : "all held"}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail("releases.ts list did not answer within a minute");
}

// ------------------------------------------------------------------ check

async function check() {
  log(ssh(`systemctl is-active ${UNITS.map((u) => `orrery@${u}`).join(" ")} | paste -sd' '`).trim());
  for (let i = 0; i < 30; i++) {
    const health = ssh(`curl -s -m 5 127.0.0.1:${API_PORT}/health || true`).trim();
    if (health.includes('"ok":true')) {
      log(`api health (loopback): ${health}`);
      break;
    }
    if (i === 29) fail("the API did not answer /health");
    await new Promise((r) => setTimeout(r, 2000));
  }
  log(`indexer: ${ssh(`curl -s -m 5 127.0.0.1:${INDEXER_PORT}/ || true`).trim()}`);
  const pub = await fetch(`https://${API_HOST}/health`).then((r) => r.text()).catch((e: Error) => e.message);
  log(`api health (https://${API_HOST}): ${pub}`);
  const rel = (await fetch(`https://${API_HOST}/v1/releases`).then((r) => r.json()).catch(() => null)) as { releases?: Record<string, string | null> } | null;
  const open = Object.entries(rel?.releases ?? {}).filter(([, v]) => v !== null).map(([k]) => k);
  log(`releases: ${rel ? (open.length ? `open ${open.join(", ")}` : "all held") : "not readable"}`);
}

const stages: Record<string, () => Promise<unknown>> = { prep, deploy, check };
const run = stages[stage];
if (!run) fail(`stage is one of: ${Object.keys(stages).join(", ")}`);
await run!();
