// FIXTURE API for local development walks only. Serves the /v1/orry shapes lane C confirmed on 2026-11-08 (spec section 5
// plus services/packages/shared/src/orry.ts on orry/services) until that API runs locally. Chain-backed figures (pool amounts, total staked, agent positions) are read from the
// local anvil mocks written by dev/setup-walk.mjs; every other figure here is a made-up fixture value.
// Never point a production build at this server. Run: node dev/orry-fixture.mjs (port 3411).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, parseEther } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FIXTURE_PORT ?? 3411);
const RPC = process.env.WALK_RPC ?? "http://127.0.0.1:8566";
const walk = existsSync(join(here, "walk.json")) ? JSON.parse(readFileSync(join(here, "walk.json"), "utf8")) : null;
const pub = createPublicClient({ transport: http(RPC) });
const vaultAbi = parseAbi([
  "function positionAmounts() view returns (uint256,uint256)",
  "function totalShares() view returns (uint256)",
  "function sharesOf(address) view returns (uint256)",
  "function unlockAt(address) view returns (uint64)",
  "function pendingFees(address) view returns (uint256,uint256)",
  "function previewWithdraw(uint256) view returns (uint256,uint256)",
]);
const stakingAbi = parseAbi([
  "function totalEarning() view returns (uint256)",
  "function plainStake(address) view returns (uint256,uint256,uint64)",
  "function pendingRewards(address) view returns (uint256,uint256)",
  "function agentStakeOf(uint256,address) view returns ((address staker,uint128 active,uint128 leaving,uint64 leavingAt,uint64 lockedUntil))",
]);

const now = () => Math.floor(Date.now() / 1000);
const iso = () => new Date().toISOString();
const e = (x) => parseEther(x).toString();
const hex = (n) => `0x${randomBytes(n).toString("hex")}`;
const masked = () => {
  const a = hex(20);
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
};

const BOARD = {
  stakers: Array.from({ length: 12 }, (_, i) => ({ rank: i + 1, address: masked(), decimals: 18, stake: e(String(Math.round(420000 / (i + 1)))) })),
  earners: Array.from({ length: 12 }, (_, i) => ({ rank: i + 1, address: masked(), decimals: 18, earned: { eth: e((1.4 / (i + 1)).toFixed(6)), orry: e(String(Math.round(61000 / (i + 1)))) } })),
};
const BURN_ITEMS = [
  [1, "12500", 380], [2, "8000", 1900], [4, "21340.5", 3700], [3, "16000", 5200], [1, "9800", 9400], [2, "4000", 14100], [4, "18822", 21000],
].map(([source, amount, age], i) => ({ tx: hex(32), block: 812000 - i * 900, time: now() - age, source, amount: e(amount) }));

async function read(address, abi, functionName, args = []) {
  if (!walk) return undefined;
  try {
    return await pub.readContract({ address, abi, functionName, args });
  } catch {
    return undefined;
  }
}

// Runtime release switch stand-in (GET /v1/releases): every feature held until a dev call sets a time.
// POST /v1/dev/releases {"feature":"earn","at":"now"|"+30s"|iso|null} changes one feature (local walks only).
const RELEASES = { earn: null, stake: null, "agent-stake": null, claim: null, burn: null, leaderboard: null, checkout: null };

async function route(method, url, body) {
  const u = new URL(url, "http://x");
  const p = u.pathname;
  if (method === "GET" && p === "/v1/releases") return [200, { serverTime: iso(), releases: RELEASES }];
  if (method === "POST" && p === "/v1/dev/releases") {
    if (!(body.feature in RELEASES)) return [400, { error: "Unknown feature" }];
    const at = body.at;
    const rel = typeof at === "string" ? at.match(/^\+(\d+)s$/) : null;
    RELEASES[body.feature] = at === null ? null : at === "now" ? iso() : rel ? new Date(Date.now() + Number(rel[1]) * 1000).toISOString() : new Date(at).toISOString();
    return [200, { serverTime: iso(), releases: RELEASES }];
  }
  if (method === "GET" && p === "/v1/pricing") return [200, { packPrice: "1000000", packSize: 500 }];
  if (method === "GET" && p === "/v1/orry/earn") {
    const [pe, pr] = (await read(walk?.vault, vaultAbi, "positionAmounts")) ?? [0n, 0n];
    const ts = (await read(walk?.vault, vaultAbi, "totalShares")) ?? 0n;
    return [200, { tvl: { eth: pe.toString(), orry: pr.toString() }, totalShares: ts.toString(), fees7d: { eth: e("0.4213"), orry: e("10220.4") }, feesAllTime: { eth: e("3.0921"), orry: e("77410") }, hubPrice: { orryPerEth: e("200000") }, decimals: 18, updatedAt: iso() }];
  }
  if (method === "GET" && p === "/v1/orry/stake") {
    const te = (await read(walk?.staking, stakingAbi, "totalEarning")) ?? 0n;
    return [200, { totalEarning: te.toString(), rewards7d: { eth: e("0.2840"), orry: e("6120") }, rewardsAllTime: { eth: e("1.9032"), orry: e("40210") }, stakers: 2, decimals: 18, updatedAt: iso() }];
  }
  const acct = p.match(/^\/v1\/orry\/accounts\/(0x[0-9a-fA-F]{40})$/);
  if (method === "GET" && acct) {
    const a = acct[1];
    const [fe, fr] = (await read(walk?.vault, vaultAbi, "pendingFees", [a])) ?? [0n, 0n];
    const shares = (await read(walk?.vault, vaultAbi, "sharesOf", [a])) ?? 0n;
    const [pe, pr] = shares > 0n ? ((await read(walk?.vault, vaultAbi, "previewWithdraw", [shares])) ?? [0n, 0n]) : [0n, 0n];
    const [sa, sl, sr] = (await read(walk?.staking, stakingAbi, "plainStake", [a])) ?? [0n, 0n, 0n];
    const [re, rr] = (await read(walk?.staking, stakingAbi, "pendingRewards", [a])) ?? [0n, 0n];
    const agents = [];
    if (walk) {
      const pos = await read(walk.staking, stakingAbi, "agentStakeOf", [7n, walk.me]);
      if (pos && pos.staker.toLowerCase() === a.toLowerCase()) agents.push({ agentId: "7", owner: walk.me, active: pos.active.toString(), leaving: pos.leaving.toString(), leavingAt: Number(pos.leavingAt), reportedForAgent: true });
    }
    return [200, {
      earnShares: shares.toString(), earnUnlockAt: Number((await read(walk?.vault, vaultAbi, "unlockAt", [a])) ?? 0), earnFeesEth: fe.toString(), earnFeesOrry: fr.toString(),
      earnPositionEth: pe.toString(), earnPositionOrry: pr.toString(), stakeActive: sa.toString(), stakeLeaving: sl.toString(), stakeReadyAt: Number(sr),
      stakeRewardsEth: re.toString(), stakeRewardsOrry: rr.toString(), agentPositions: agents, earnedAllTime: { eth: e("0.1931"), orry: e("9210.75") }, address: a, decimals: 18, updatedAt: iso(),
    }];
  }
  if (method === "GET" && p === "/v1/orry/leaderboard") {
    const kind = u.searchParams.get("kind") === "earners" ? "earners" : "stakers";
    return [200, BOARD[kind].slice(0, Number(u.searchParams.get("limit") ?? 50))];
  }
  if (method === "GET" && p === "/v1/orry/burns") {
    const by = { 1: 0n, 2: 0n, 3: 0n, 4: 0n };
    for (const b of BURN_ITEMS) by[b.source] += BigInt(b.amount);
    const total = Object.values(by).reduce((x, y) => x + y, 0n);
    return [200, { total: total.toString(), bySource: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.toString()])), items: BURN_ITEMS, decimals: 18 }];
  }
  if (method === "POST" && p === "/v1/orry/quotes/credits") {
    const packs = Math.max(1, Number(body.packs ?? 1));
    const domain = { name: "Orrery Treasury", version: "1", chainId: 31337, verifyingContract: walk?.treasury };
    return [200, { kind: "credits", quote: { buyer: body.buyer, packs, orryAmount: (BigInt(packs) * parseEther("4000")).toString(), quoteId: hex(32), expiry: now() + 120 }, credits: String(packs * 625), signature: `0x${"00".repeat(65)}`, signer: walk?.me, domain, decimals: 18, usdValue: String(packs * 1_000_000), usdDecimals: 6, price: { orryPerUsd: "4000", basis: "median", samples: 30, windowSeconds: 1800 } }];
  }
  if (method === "POST" && p === "/v1/orry/quotes/verification") {
    const domain = { name: "Orrery Treasury", version: "1", chainId: 31337, verifyingContract: walk?.treasury };
    return [200, { kind: "verification", quote: { payer: body.payer, agentId: String(body.agentId), orryAmount: parseEther("16000").toString(), quoteId: hex(32), expiry: now() + 120 }, signature: `0x${"00".repeat(65)}`, signer: walk?.me, domain, decimals: 18, usdValue: "4000000", usdDecimals: 6, price: { orryPerUsd: "4000", basis: "median", samples: 30, windowSeconds: 1800 } }];
  }
  return [404, { error: "Not found" }];
}

createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const [status, json] = await route(req.method, req.url, raw ? JSON.parse(raw) : {}).catch((err) => [500, { error: String(err) }]);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    console.log(`FIXTURE ${req.method} ${req.url} ${status}`);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`FIXTURE orry API on http://127.0.0.1:${PORT} (chain reads from ${RPC}${walk ? "" : ", no walk.json yet"})`));
