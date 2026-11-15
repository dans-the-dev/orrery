import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApi, connect, loadConfig, makeChain, migrate, setRelease, type Config, type Sql } from "@orrery/server";
import { indexCommunityOnce } from "../packages/server/src/community-indexer.js";
import { pendingAccruals, publishAccruals } from "../packages/server/src/community-publisher.js";
import { deployCommunity, envLines, seedCommunity, type CommunityDeployment } from "../scripts/community-local.js";
import { COMMUNITY_ANVIL_PORT, DATABASE_URL } from "./env.js";

/**
 * Lane L1 end to end on a local anvil: the real L1 contracts (stand-ins only for the token, its price and the earning
 * stake), the seed of scripts/community-local.ts, the community indexer into Postgres, and the API routes behind the
 * release switch.
 */
const RPC = `http://127.0.0.1:${COMMUNITY_ANVIL_PORT}`;
const standIn = "0x000000000000000000000000000000000000dEaD";
let anvil: ChildProcess;
let d: CommunityDeployment;
let cfg: Config;
let sql: Sql;
let app: ReturnType<typeof buildApi>;

async function rpcUp(): Promise<boolean> {
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return r.ok;
  } catch {
    return false;
  }
}

async function indexAll() {
  for (let i = 0; i < 20; i++) {
    const r = await indexCommunityOnce(cfg, makeChain(cfg), sql);
    if (r.last >= r.head) return;
  }
}

const get = async (url: string) => {
  const r = await app.inject({ method: "GET", url });
  return { status: r.statusCode, body: r.statusCode === 200 ? r.json() : null };
};

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", String(COMMUNITY_ANVIL_PORT), "--silent", "--accounts", "12"], { stdio: "ignore" });
  for (let i = 0; i < 60 && !(await rpcUp()); i++) await new Promise((r) => setTimeout(r, 250));
  d = await deployCommunity(RPC);
  await seedCommunity(RPC, d);
  const env = Object.fromEntries(envLines(d).split("\n").map((l) => l.split("=") as [string, string]));
  cfg = loadConfig({
    ORRERY_CHAIN_ID: "31337",
    ORRERY_RPC_URL: RPC,
    ORRERY_DATABASE_URL: DATABASE_URL,
    ORRERY_MODULE: standIn,
    ORRERY_ATTESTOR: standIn,
    ORRERY_LENS: standIn,
    ORRERY_REGISTRY: standIn,
    ORRERY_USDG: standIn,
    ORRERY_TREASURY: standIn,
    ORRERY_CONFIRMATIONS: "0",
    ORRERY_RELEASES_CACHE_MS: "0",
    ORRERY_PUBLIC_RATE_PER_MINUTE: "6000",
    ...env,
  });
  sql = connect(cfg.databaseUrl);
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrate(sql);
  app = buildApi(cfg, makeChain(cfg), sql);
  await indexAll();
});

afterAll(async () => {
  await app?.close();
  await sql?.end();
  anvil?.kill("SIGTERM");
});

describe("community: indexer and API", () => {
  it("config is never held and carries the constructor values", async () => {
    const { status, body } = await get("/v1/community/config");
    expect(status).toBe(200);
    expect(body.addresses.chat.toLowerCase()).toBe(d.chat.toLowerCase());
    expect(body.postFeeUsd).toBe("10000");
    expect(body.boostUsdPerDay).toEqual({ post: "500000", agent: "5000000", template: "2000000" });
    expect(body.passUsd).toEqual({ day: "1000000", week: "5000000" });
    expect(body.tipCutBps).toBe(500);
    expect(body.hideThreshold).toBe(5);
    expect(body.checkWindowSeconds).toBe(172800);
  });

  it("chat: rooms, messages with names, tips and the hidden message", async () => {
    const rooms = (await get("/v1/community/rooms")).body.rooms;
    expect(rooms).toEqual([{ id: 0, name: "general", minStakeUsd: "0" }, { id: 1, name: "stakers", minStakeUsd: "100000000" }]);
    const msgs = (await get("/v1/community/messages?room=0")).body.messages;
    expect(msgs.map((m: { id: string }) => m.id)).toEqual(["5", "4", "3", "2", "1"]);
    const hidden = msgs.find((m: { id: string }) => m.id === "5");
    expect(hidden.hidden).toBe(true);
    expect(hidden.text).toBe(null);
    expect(hidden.reports).toBe(5);
    const tipped = msgs.find((m: { id: string }) => m.id === "3");
    expect(tipped.tips).toBe((500n * 10n ** 18n).toString());
    expect(tipped.authorName).toBe("ada_l");
    expect(tipped.boostedUntil).not.toBe(null);
    expect(msgs.find((m: { id: string }) => m.id === "1").fee).toBe((20n * 10n ** 18n).toString()); // 0.01 USD at 2,000 ORRY per USD
    expect((await get("/v1/community/messages?room=0&before=3&limit=1")).body.messages.map((m: { id: string }) => m.id)).toEqual(["2"]);
  });

  it("held features answer 404 and open again without a restart", async () => {
    await setRelease(sql, "chat", null, "test");
    expect((await get("/v1/community/rooms")).status).toBe(404);
    expect((await get("/v1/community/config")).status).toBe(200);
    await setRelease(sql, "chat", new Date(0), "test");
    expect((await get("/v1/community/rooms")).status).toBe(200);
  });

  it("rewards: pool books, events, achievements and recipients by completion time", async () => {
    const r = (await get("/v1/community/rewards")).body;
    const rc = r.pool.find((p: { asset: string }) => p.asset.toLowerCase() === d.orry.toLowerCase());
    expect(BigInt(rc.free) + BigInt(rc.locked)).toBeGreaterThan(0n);
    expect(r.events.map((e: { id: number; status: string }) => [e.id, e.status])).toEqual([[2, "published"], [1, "open"]]);
    expect(r.events[0].winners[0].amount).toBe((150_000n * 10n ** 18n).toString());
    expect(r.achievements.map((a: { id: number; onchain: boolean }) => [a.id, a.onchain])).toEqual([[2, false], [1, true]]);
    const rec = (await get("/v1/community/achievements/1/recipients")).body.recipients;
    expect(rec.length).toBe(2);
    expect(rec[0].address).toMatch(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/i);
  });

  it("most active ranks by protocol fees in USD (R-34) and commits to its rules", async () => {
    const m = (await get("/v1/community/most-active?days=30")).body;
    expect(m.rulesHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(m.rows.length).toBeGreaterThan(3);
    for (let i = 1; i < m.rows.length; i++) expect(BigInt(m.rows[i - 1].feesUsd) >= BigInt(m.rows[i].feesUsd)).toBe(true);
    // account 1: name 1 USD, 2 posts... boosts 5 x 3 + 2 x 2 USD: the top payer
    expect(Object.keys(m.rows[0].bySource).sort()).toEqual(["boost", "chat", "names"]);
  });

  it("boosts, passes and templates", async () => {
    const b = (await get("/v1/community/boosts")).body.boosts;
    expect(b.map((x: { kind: number; target: string }) => `${x.kind}:${x.target}`).sort()).toEqual(["1:3", "2:42", "3:2"]);
    const p = (await get(`/v1/community/passes/0x70997970C51812dc3A010C7d01b50e0d17dc79C8`)).body; // account 1 bought none
    expect(p.active).toBe(false);
    const t = (await get("/v1/community/templates")).body.templates;
    expect(t.map((x: { id: number }) => x.id)).toEqual([2, 1]); // the boosted listing first
    expect(t[1].sales).toBe(1);
    expect((await get("/v1/community/passes/nope")).status).toBe(400);
  });

  it("referrals and cashback: links, the opened month and claimable ORRY", async () => {
    const alice = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // account 1
    const bob = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // account 2
    const s = (await get(`/v1/community/referrals/${alice}`)).body;
    expect(s.referees).toBe(2);
    expect(s.months.length).toBe(1);
    expect(s.months[0].owedUsd).toBe("14000000");
    expect(BigInt(s.months[0].claimable)).toBe(28_000n * 10n ** 18n); // 14 USD at 2,000 ORRY per USD, full reserve
    const sb = (await get(`/v1/community/referrals/${bob}`)).body;
    expect(sb.referrer.toLowerCase()).toBe(alice.toLowerCase());
    expect(sb.discountUntil).not.toBe(null);
    const cb = (await get(`/v1/community/cashback/${bob}`)).body;
    expect(cb.records.length).toBe(2);
    expect(cb.months.length).toBe(2);
    const lb = (await get("/v1/community/referrals/leaderboard")).body.rows;
    expect(lb[0].referees).toBe(2);
  });

  it("the publisher turns fees into accruals the sink accepts, once", async () => {
    // bob (linked to alice) paid L1 fees in this month: a referral accrual for alice per fee, no cashback (ORRY fees)
    const pending = await pendingAccruals(cfg, makeChain(cfg), sql);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((a) => a.kind === 2)).toBe(true);
    expect(await publishAccruals(cfg, makeChain(cfg), sql, true, () => {})).toBe(pending.length);
    await indexAll();
    expect((await pendingAccruals(cfg, makeChain(cfg), sql)).length).toBe(0);
  });
});
