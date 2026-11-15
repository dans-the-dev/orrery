#!/usr/bin/env node
/**
 * Host side of the Orrery uptime check. Runs on server 1 as root with the system Node (22) right before each check
 * (ExecStartPre in uptime-wa@orrery.service.d/host-probe.conf), because the check itself runs in a throwaway container
 * that sees neither the docker socket nor the host's loopback ports.
 *
 *   node host-probe.mjs /opt/uptime-monitor/orrery
 *
 * Reads <dir>/targets.json for the container names (every "container" check, held or not), probe.indexerHealth,
 * probe.backupDir and probe.keeperContainer, then writes <dir>/probe/host.json: the time, each container's state
 * (status, running, restarting, start time, exit code, restart count, health; null when it does not exist), the
 * indexer health answer (status and body), the newest database dump (name, time, size, how many are kept) and the
 * keeper's last logged pass (time and step status counts). Nothing secret is read: docker inspect is asked for those
 * state fields only, the dump folder is listed (never read), and the keeper logs one JSON line per pass without its
 * key. Always exits 0; a problem is written into the file, and the check turns a missing or stale file into a FAIL.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const dir = resolve(process.argv[2] ?? "/opt/uptime-monitor/orrery");
const FORMAT =
  '{"status":{{json .State.Status}},"running":{{.State.Running}},"restarting":{{.State.Restarting}},' +
  '"startedAt":{{json .State.StartedAt}},"exitCode":{{.State.ExitCode}},"restartCount":{{.RestartCount}},' +
  '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}';

async function container(name) {
  try {
    const { stdout } = await run("docker", ["inspect", "--type", "container", "--format", FORMAT, name], { timeout: 10_000 });
    return JSON.parse(stdout);
  } catch (e) {
    const text = `${e?.stderr ?? ""}${e?.message ?? ""}`;
    return /no such (container|object)/i.test(text) ? null : { error: text.split("\n")[0].slice(0, 200) };
  }
}

async function indexer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return { status: res.status, body: (await res.text()).slice(0, 2_000) };
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message;
    return { status: 0, error: `${e?.message ?? e}${cause ? `: ${cause}` : ""}`.slice(0, 200) };
  }
}

function backup(folder) {
  try {
    const dumps = readdirSync(folder)
      .filter((f) => /^orrery-\d{8}T\d{4}Z\.dump$/.test(f))
      .map((f) => ({ f, st: statSync(join(folder, f)) }))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    if (!dumps.length) return { count: 0, newest: null };
    const n = dumps[0];
    return { count: dumps.length, newest: n.f, newestAt: n.st.mtime.toISOString(), bytes: n.st.size };
  } catch (e) {
    return { error: String(e?.code ?? e?.message ?? e).slice(0, 200) };
  }
}

/** The keeper's last pass line from its recent log: { lastPassAt, statuses }, or null when it has no log. */
async function keeper(name) {
  let text;
  try {
    const { stdout, stderr } = await run("docker", ["logs", "--tail", "50", name], { timeout: 10_000, maxBuffer: 4 << 20 });
    text = `${stdout}\n${stderr}`;
  } catch (e) {
    const t = `${e?.stderr ?? ""}${e?.message ?? ""}`;
    return /no such container/i.test(t) ? null : { error: t.split("\n")[0].slice(0, 200) };
  }
  let last = null;
  for (const line of text.split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j && typeof j.at === "string" && Array.isArray(j.steps) && (!last || j.at > last.at)) last = j;
    } catch {
      // not a pass line
    }
  }
  if (!last) return { lastPassAt: null };
  const statuses = {};
  for (const s of last.steps) {
    const k = s.error ? "error" : String(s.status ?? "unknown");
    statuses[k] = (statuses[k] ?? 0) + 1;
  }
  return { lastPassAt: last.at, statuses };
}

const out = { at: new Date().toISOString(), containers: {}, indexer: null, backup: null, keeper: null };
try {
  const targets = JSON.parse(readFileSync(join(dir, "targets.json"), "utf8"));
  const names = [...new Set((targets.checks ?? []).map((c) => c.container).filter(Boolean))];
  const states = await Promise.all(names.map(container));
  names.forEach((n, i) => {
    out.containers[n] = states[i];
  });
  if (targets.probe?.indexerHealth) out.indexer = await indexer(targets.probe.indexerHealth);
  if (targets.probe?.backupDir) out.backup = backup(targets.probe.backupDir);
  if (targets.probe?.keeperContainer) out.keeper = await keeper(targets.probe.keeperContainer);
} catch (e) {
  out.error = String(e?.message ?? e).slice(0, 200);
}
out.at = new Date().toISOString();
try {
  mkdirSync(join(dir, "probe"), { recursive: true });
  const file = join(dir, "probe", "host.json");
  writeFileSync(`${file}.tmp`, `${JSON.stringify(out, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
} catch (e) {
  console.error(`host probe could not write its file: ${e?.message ?? e}`);
}
