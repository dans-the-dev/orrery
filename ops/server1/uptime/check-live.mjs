#!/usr/bin/env node
/**
 * Orrery live check for the server 1 uptime monitor (/opt/uptime-monitor/orrery, timer uptime-wa@orrery). Prints a
 * PASS/FAIL table in the format /opt/uptime-monitor/bin/uptime-run.mjs reads and exits 1 when anything fails. Sends
 * GET requests and one eth_blockNumber per RPC; needs no key and no account.
 *
 * targets.json:
 *   "stage": the current stage, one of "stages" in order (prelaunch, launch, orry). A check with "from": "<stage>" runs only
 *            once the current stage has reached it; earlier it is listed as held. CHECK_STAGE overrides it for a test run.
 *   "networks": { "<name>": { "web": origin, "api": origin } }   origins for the HTTP checks.
 *   "probe": { "file": path relative to this script, "maxAgeSec": n }   written by host-probe.mjs on the host just
 *            before each run (container states, the indexer health body), since this check runs in a container that
 *            cannot see the host's loopback ports or the docker socket.
 *   "rpc": [urls]   4663 RPCs for the chain reads below, official first.
 *   "checks": entries of one of these kinds:
 *     HTTP:      { "base": "web"|"api", "path": "/", "contains": "text" } or { ..., "json": { "<dotted path>": expected } }
 *                expected is a literal, {"notNull": true} or {"atLeast": "<integer>"}.
 *     container: { "container": "<name>", "minUpSeconds": n }   running, not restarting, not unhealthy, up at least n s.
 *     indexer:   { "indexer": { "rpc": [urls], "maxLag": blocks, "orryExtra": blocks } }   the indexer health must
 *                answer 200 with ok true, and its cursor must be within maxLag of the chain head read here from the RPCs
 *                (the highest answer): an independent reading next to the indexer's own live-head lag (commit 6bee7c1;
 *                before it, the health compared against a stored head that froze with a stuck loop). The ORRY cursor is allowed
 *                maxLag + orryExtra (it stays `confirmations` behind by design).
 *     balance:   { "balance": { "address": "0x…", "minEth": "0.0001" } }   ETH balance from the first RPC that answers.
 *     backup:    { "backup": { "maxAgeHours": 26 } }   the newest database dump (from the probe) is younger than that.
 *     keeper:    { "keeperPass": { "maxAgeMinutes": 75 } }   the keeper's last logged pass (from the probe) is younger.
 *
 * Env: CHECK_CONFIG (another targets file), CHECK_STAGE, CHECK_TIMEOUT_MS (default 15000).
 */
import { readFileSync } from "node:fs";

const env = process.env;
const CONFIG = env.CHECK_CONFIG?.trim() || new URL("./targets.json", import.meta.url);
const TIMEOUT_MS = Number(env.CHECK_TIMEOUT_MS) || 15_000;

const errText = (e) => {
  const text = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause : null;
  return cause ? `${text}: ${cause.code ?? cause.message}` : text;
};

/** GET a URL, timing it; never throws (a network failure becomes status 0). */
async function get(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "orrery-check-live" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, body: await res.text(), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: errText(e), ms: Date.now() - t0 };
  }
}

const at = (obj, path) => path.split(".").reduce((v, key) => (v == null ? undefined : v[key]), obj);

function mismatch(path, actual, expected) {
  if (expected !== null && typeof expected === "object") {
    if (expected.notNull) return actual == null ? `${path} is ${actual}` : null;
    if (expected.atLeast !== undefined) {
      try {
        return BigInt(actual) >= BigInt(expected.atLeast) ? null : `${path} is ${actual}, below ${expected.atLeast}`;
      } catch {
        return `${path} is ${JSON.stringify(actual)}, not an integer`;
      }
    }
    return `unknown expectation for ${path}`;
  }
  return actual === expected ? null : `${path} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
}

async function httpCheck(check, bases) {
  const origin = bases[check.base];
  if (!origin) return `no "${check.base}" origin in networks`;
  const r = await get(`${origin.replace(/\/+$/, "")}${check.path}`);
  if (r.status !== 200) return `${r.status === 0 ? r.body : `HTTP ${r.status}`} after ${r.ms} ms`;
  try {
    if (check.contains !== undefined) {
      if (!r.body.includes(check.contains)) return `"${check.contains}" missing (${r.ms} ms)`;
    } else {
      const doc = JSON.parse(r.body);
      for (const [path, expected] of Object.entries(check.json ?? {})) {
        const problem = mismatch(path, at(doc, path), expected);
        if (problem) return `${problem} (${r.ms} ms)`;
      }
    }
  } catch (e) {
    return `${errText(e)} (${r.ms} ms)`;
  }
  return { ok: `${r.ms} ms` };
}

/** The host probe's file, or the reason it cannot be used. */
function readProbe(probeCfg) {
  const file = new URL(probeCfg?.file ?? "./probe/host.json", import.meta.url);
  let probe;
  try {
    probe = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `host probe unreadable: ${errText(e)}` };
  }
  const age = Math.round((Date.now() - Date.parse(probe.at)) / 1000);
  const maxAge = Number(probeCfg?.maxAgeSec) || 600;
  if (!(age <= maxAge)) return { error: `host probe is ${Number.isFinite(age) ? `${age} s` : "of unknown"} old (limit ${maxAge} s)` };
  return { probe };
}

function containerCheck(check, probe) {
  const c = probe.containers?.[check.container];
  if (c === undefined) return `${check.container} not probed`;
  if (c === null) return `${check.container} not found`;
  if (c.error) return `${check.container}: ${c.error}`;
  if (!c.running || c.restarting) return `${check.container} is ${c.status} (exit code ${c.exitCode}, restarts ${c.restartCount})`;
  if (c.health === "unhealthy") return `${check.container} is unhealthy`;
  const up = Math.round((Date.parse(probe.at) - Date.parse(c.startedAt)) / 1000);
  const minUp = Number(check.minUpSeconds) || 0;
  if (up < minUp) return `${check.container} up only ${up} s, restarted recently (restarts ${c.restartCount})`;
  return { ok: `${c.status}, up ${up >= 3600 ? `${Math.floor(up / 3600)} h` : `${Math.floor(up / 60)} min`}${c.health ? `, ${c.health}` : ""}` };
}

/** Highest eth_blockNumber among the RPCs that answer, or null. */
async function chainHead(rpcs) {
  const answers = await Promise.all(
    rpcs.map(async (url) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "orrery-check-live" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const doc = await res.json();
        return typeof doc.result === "string" ? BigInt(doc.result) : null;
      } catch {
        return null;
      }
    }),
  );
  const heads = answers.filter((h) => h !== null);
  return heads.length ? heads.reduce((a, b) => (a > b ? a : b)) : null;
}

let RPC = [];

/** ETH balance in wei from the first RPC that answers, or null. */
async function balanceOf(address) {
  for (const url of RPC) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "orrery-check-live" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const doc = await res.json();
      if (typeof doc.result === "string") return BigInt(doc.result);
    } catch {
      // next RPC
    }
  }
  return null;
}

const toWei = (eth) => {
  const [i, f = ""] = String(eth).split(".");
  return BigInt(i || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
};
const fmtEth = (wei) => {
  const s = wei.toString().padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18, -12)}`;
};

async function balanceCheck(check) {
  const { address, minEth } = check.balance;
  const wei = await balanceOf(address);
  if (wei === null) return "balance unreadable from every RPC";
  const floor = toWei(minEth);
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  if (wei < floor) return `${short} holds ${fmtEth(wei)} ETH, below ${minEth}`;
  return { ok: `${short} holds ${fmtEth(wei)} ETH (floor ${minEth})` };
}

function backupCheck(check, probe) {
  const b = probe.backup;
  if (!b) return "backup folder not probed";
  if (b.error) return `backup folder: ${b.error}`;
  if (!b.newest) return "no dump in the backup folder";
  const hours = (Date.parse(probe.at) - Date.parse(b.newestAt)) / 3_600_000;
  const max = Number(check.backup.maxAgeHours) || 26;
  if (!(hours <= max)) return `newest dump ${b.newest} is ${hours.toFixed(1)} h old (limit ${max} h)`;
  return { ok: `${b.newest}, ${hours.toFixed(1)} h old, ${b.bytes} bytes, ${b.count} kept` };
}

function keeperPassCheck(check, probe) {
  const k = probe.keeper;
  if (k === undefined) return "keeper log not probed";
  if (k === null) return "keeper container not found";
  if (k.error) return `keeper log: ${k.error}`;
  if (!k.lastPassAt) return "no keeper pass in its recent log";
  const minutes = Math.round((Date.parse(probe.at) - Date.parse(k.lastPassAt)) / 60_000);
  const max = Number(check.keeperPass.maxAgeMinutes) || 75;
  if (!(minutes <= max)) return `last keeper pass ${minutes} min ago (limit ${max} min)`;
  const counts = Object.entries(k.statuses ?? {}).map(([s, n]) => `${n} ${s}`).join(", ");
  return { ok: `last pass ${minutes} min ago${counts ? ` (${counts})` : ""}` };
}

async function indexerCheck(check, probe) {
  const cfg = check.indexer;
  const h = probe.indexer;
  if (!h) return "indexer health not probed";
  if (h.status !== 200) return `indexer health ${h.status === 0 ? `unreachable: ${h.error}` : `HTTP ${h.status}`}${h.body ? `: ${h.body.slice(0, 160)}` : ""}`;
  let body;
  try {
    body = JSON.parse(h.body);
  } catch {
    return "indexer health body is not JSON";
  }
  if (body.ok !== true) return `indexer reports ok=${body.ok}, lag ${body.lag}`;
  if (body.last == null) return "indexer reports no cursor";
  if (body.orry && body.orry.last == null) return "indexer reports no ORRY cursor";
  const head = await chainHead(cfg.rpc ?? RPC);
  if (head === null) return "chain head unreadable from every RPC";
  const maxLag = BigInt(cfg.maxLag ?? 600);
  const lag = head - BigInt(body.last);
  if (lag > maxLag) return `cursor ${body.last} is ${lag} blocks behind head ${head} (limit ${maxLag})`;
  let orry = "";
  if (body.orry) {
    const rLag = head - BigInt(body.orry.last);
    const rMax = maxLag + BigInt(cfg.orryExtra ?? 10);
    if (rLag > rMax) return `ORRY cursor ${body.orry.last} is ${rLag} blocks behind head ${head} (limit ${rMax})`;
    orry = `, ORRY ${rLag}`;
  }
  return { ok: `lag ${lag} blocks${orry} (head ${head})` };
}

async function main() {
  const config = JSON.parse(readFileSync(CONFIG, "utf8"));
  const stages = config.stages ?? ["prelaunch", "launch", "orry"];
  const stage = env.CHECK_STAGE?.trim() || config.stage || stages[0];
  const now = stages.indexOf(stage);
  if (now < 0) throw new Error(`stage "${stage}" is not one of ${stages.join(", ")}`);
  const networks = Object.entries(config.networks ?? {});
  if (networks.length === 0) throw new Error("no network to check (targets.json)");
  RPC = config.rpc ?? [];
  const usesProbe = (c) => c.container || c.indexer || c.backup || c.keeperPass;
  const probeRead = config.checks.some(usesProbe) ? readProbe(config.probe) : null;

  const rows = [];
  const held = [];
  for (const [network, bases] of networks) {
    console.log(`check:live ${network} (stage ${stage}): web ${bases.web ?? "-"}, api ${bases.api ?? "-"}`);
    for (const check of config.checks ?? []) {
      const name = `${network} ${check.name}`;
      if (check.from && stages.indexOf(check.from) > now) {
        held.push(`${check.name} (from ${check.from})`);
        continue;
      }
      let result;
      if (usesProbe(check)) {
        const p = probeRead.probe;
        if (probeRead.error) result = probeRead.error;
        else if (check.container) result = containerCheck(check, p);
        else if (check.indexer) result = await indexerCheck(check, p);
        else if (check.backup) result = backupCheck(check, p);
        else result = keeperPassCheck(check, p);
      } else if (check.balance) {
        result = await balanceCheck(check);
      } else {
        result = await httpCheck(check, bases);
      }
      rows.push(typeof result === "string" ? { name, status: "FAIL", detail: result } : { name, status: "PASS", detail: result.ok });
    }
  }

  const w = Math.max(...rows.map((r) => r.name.length), 5);
  const line = `${"-".repeat(w + 2)}+------+${"-".repeat(40)}`;
  console.log(`\n ${"CHECK".padEnd(w)} | STAT | DETAIL\n${line}`);
  for (const r of rows) console.log(` ${r.name.padEnd(w)} | ${r.status} | ${r.detail}`);
  const failed = rows.filter((r) => r.status === "FAIL").length;
  console.log(`${line}\n ${rows.length - failed} passed, ${failed} failed`);
  if (held.length) console.log(` held until their stage: ${held.join("; ")}`);
  if (failed || rows.length === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
