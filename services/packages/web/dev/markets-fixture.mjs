// FIXTURE API and keeper for the local markets walk only. Serves lane C's frozen /v1/markets shapes
// (services/packages/shared/src/markets.ts, r1/services ff5f9d4) plus the proposed POST /v1/markets/relay, reading every figure from the mock markets that
// dev/setup-markets-walk.mjs deployed on anvil. Its keeper moves the mock Chainlink feeds, seals and reveals orders
// from three counterparty wallets, and clears each batch after its reveal window.
// Never point a production build at this server. Run: node dev/markets-fixture.mjs (port 3411).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, parseUnits } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FIXTURE_PORT ?? 3411);
const RPC = process.env.WALK_RPC ?? "http://127.0.0.1:8566";
const KEEPER = process.env.WALK_KEEPER !== "0";
// Chance that each counterparty wallet seals an order in a batch (1 = every batch, both sides).
const BOT_RATE = Number(process.env.WALK_BOT_RATE ?? 0.35);
const walk = JSON.parse(readFileSync(join(here, "markets-walk.json"), "utf8"));
const chain = defineChain({ id: 31337, name: "Local chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (account) => createWalletClient({ chain, transport: http(RPC), account });

const marketAbi = parseAbi([
  "struct Order { bool sellAsset; uint256 amountIn; uint256 limitPrice; uint8 mode; bool payFeeInOrry; }",
  "struct BatchResult { bool cleared; uint256 price; uint80 roundId; uint256 assetFilled; uint256 usdgFilled; uint256 usdgFees; uint256 orryFeesBurned; uint32 ordersDropped; uint256 assetViaPool; uint256 usdgViaPool; }",
  "function phase() view returns (uint256, bool, uint64)",
  "function revealEnd(uint256) view returns (uint64)",
  "function start() view returns (uint64)",
  "function commitSeconds() view returns (uint32)",
  "function revealSeconds() view returns (uint32)",
  "function feeBps() view returns (uint16)",
  "function minNotionalUsdg() view returns (uint256)",
  "function commitFeeUsd() view returns (uint256)",
  "function maxStaleness() view returns (uint32)",
  "function MAX_ORDERS() view returns (uint32)",
  "function EXPIRY() view returns (uint64)",
  "function revealFor(address, Order, bytes32)",
  "function commitmentOf(uint256, address) view returns (bytes32)",
  "function orryFeeDiscountBps() view returns (uint16)",
  "function maxDeviationBps() view returns (uint16)",
  "function pool() view returns (address)",
  "function orderCount(uint256) view returns (uint256)",
  "function commitCount(uint256) view returns (uint256)",
  "function orderAt(uint256, uint256) view returns (address, Order)",
  "function result(uint256) view returns (BatchResult)",
  "function commitmentFor(uint256, address, Order, bytes32) pure returns (bytes32)",
  "function commit(bytes32)",
  "function reveal(Order, bytes32)",
  "function clear(uint256, uint80)",
  "event Committed(uint256 indexed batch, address indexed account, bytes32 commitment, uint256 orryBurned)",
  "event Revealed(uint256 indexed batch, address indexed account, Order order)",
  "event OrderDropped(uint256 indexed batch, address indexed account)",
  "event OrderFilled(uint256 indexed batch, address indexed account, uint256 inputUsed, uint256 output, uint256 usdgFee, uint256 orryFee)",
  "event BatchCleared(uint256 indexed batch, uint256 price, uint80 roundId, uint256 assetFilled, uint256 usdgFilled)",
  "event Burned(uint8 indexed source, uint256 amount)",
]);
const feedAbi = parseAbi([
  "function latestRound() view returns (uint80)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
  "function push(int256)",
]);

const s = (v) => v.toString();
const mask = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const nowChain = async () => Number((await pub.getBlock()).timestamp);
const read = (address, functionName, args = [], abi = marketAbi) => pub.readContract({ address, abi, functionName, args });

async function params(m) {
  const [cs, rs, fee, min, cf, stale, maxOrders, expiry, l3, dev] = await Promise.all(
    ["commitSeconds", "revealSeconds", "feeBps", "minNotionalUsdg", "commitFeeUsd", "maxStaleness", "MAX_ORDERS", "EXPIRY", "orryFeeDiscountBps", "maxDeviationBps"].map((f) => read(m.market, f)),
  );
  return { commitSeconds: Number(cs), revealSeconds: Number(rs), feeBps: Number(fee), minNotionalUsdg: s(min), commitFeeUsd: s(cf), maxStaleness: Number(stale), maxOrders: Number(maxOrders), expirySeconds: Number(expiry), orryFeeDiscountBps: Number(l3), maxDeviationBps: Number(dev) };
}

async function marketView(m, now) {
  const [[rid, ans, , upd], p, [batch, inCommit, endsAt]] = await Promise.all([read(m.feed, "latestRoundData", [], feedAbi), params(m), read(m.market, "phase")]);
  return {
    market: m.market,
    asset: { address: m.token, symbol: m.symbol, name: m.name, decimals: 18 },
    usdg: walk.usdg,
    price: { feed: m.feed, answer: ans > 0n ? s(ans) : null, decimals: 8, roundId: s(rid), updatedAt: Number(upd), fresh: now - Number(upd) <= p.maxStaleness },
    params: p,
    remainderPool: { poolId: `0x${"0".repeat(64)}`, listed: (await read(m.market, "pool")) !== "0x0000000000000000000000000000000000000000" },
    phase: { batch: s(batch), inCommit, endsAt: Number(endsAt) },
    createdBlock: 0,
  };
}

const modeName = (n) => (Number(n) === 1 ? "swap" : "limit");
const fillOf = (l) => (l ? { inputUsed: s(l.args.inputUsed), output: s(l.args.output), usdgFee: s(l.args.usdgFee), orryFee: s(l.args.orryFee), tx: l.transactionHash } : null);

async function batchView(m, b, now, withOrders) {
  const [rEnd, commits, reveals, r] = await Promise.all([read(m.market, "revealEnd", [b]), read(m.market, "commitCount", [b]), read(m.market, "orderCount", [b]), read(m.market, "result", [b])]);
  const p = await params(m);
  const revealEndsAt = Number(rEnd);
  const commitEndsAt = revealEndsAt - p.revealSeconds;
  const expiresAt = revealEndsAt + p.expirySeconds;
  const status = r.cleared ? "cleared" : now < commitEndsAt ? "commit" : now < revealEndsAt ? "reveal" : now > expiresAt ? "expired" : "clearing";
  const committed = await pub.getContractEvents({ address: m.market, abi: marketAbi, eventName: "Committed", args: { batch: b }, fromBlock: 0n });
  const filled = await pub.getContractEvents({ address: m.market, abi: marketAbi, eventName: "OrderFilled", args: { batch: b }, fromBlock: 0n });
  const dropped = await pub.getContractEvents({ address: m.market, abi: marketAbi, eventName: "OrderDropped", args: { batch: b }, fromBlock: 0n });
  let result = null;
  if (r.cleared) {
    const [c] = await pub.getContractEvents({ address: m.market, abi: marketAbi, eventName: "BatchCleared", args: { batch: b }, fromBlock: 0n });
    const block = c ? await pub.getBlock({ blockNumber: c.blockNumber }) : undefined;
    const usdgFees = filled.reduce((x, l) => x + l.args.usdgFee, 0n);
    const orryFees = filled.reduce((x, l) => x + l.args.orryFee, 0n);
    const nFilled = filled.filter((l) => l.args.inputUsed > 0n).length;
    result = { price: s(r.price), roundId: s(r.roundId), assetFilled: s(r.assetFilled), usdgFilled: s(r.usdgFilled), usdgFees: s(usdgFees), orryFeesBurned: s(orryFees), ordersFilled: nFilled, ordersUnfilled: Number(reveals) - nFilled - dropped.length, ordersDropped: dropped.length, assetViaPool: s(r.assetViaPool), usdgViaPool: s(r.usdgViaPool), tx: c?.transactionHash, block: Number(c?.blockNumber ?? 0n), time: Number(block?.timestamp ?? 0n) };
  }
  let orders = null;
  if (withOrders && now >= revealEndsAt) {
    orders = [];
    for (let i = 0n; i < reveals; i++) {
      const [account, o] = await read(m.market, "orderAt", [b, i]);
      const f = filled.find((l) => l.args.account.toLowerCase() === account.toLowerCase());
      const d = dropped.some((l) => l.args.account.toLowerCase() === account.toLowerCase());
      const st = d ? "dropped" : status === "expired" ? "expired" : !r.cleared ? "revealed" : f && f.args.inputUsed > 0n ? "filled" : "unfilled";
      orders.push({ account: mask(account), sellAsset: o.sellAsset, amountIn: s(o.amountIn), limitPrice: s(o.limitPrice), mode: modeName(o.mode), payFeeInOrry: o.payFeeInOrry, status: st, fill: f && f.args.inputUsed > 0n ? fillOf(f) : null });
    }
  }
  return { market: m.market, batch: s(b), commitEndsAt, revealEndsAt, expiresAt, status, commits: Number(commits), reveals: Number(reveals), commitFeesBurned: s(committed.reduce((x, l) => x + l.args.orryBurned, 0n)), result, orders };
}

const byMarket = (addr) => walk.markets.find((m) => m.market.toLowerCase() === addr.toLowerCase());
const relayed = new Map(); // `${market}:${batch}:${account}` -> { market, account, batch, order, salt, done }

async function route(method, url, body) {
  const u = new URL(url, "http://x");
  const p = u.pathname;
  const now = await nowChain();
  // Lane C's relay (r1/services f3538d0): queue only an order that matches the on-chain commitment in an open window.
  const relayView = (r, m) => ({ market: m.market, batch: s(r.batch), account: r.account, status: r.status, revealsFrom: r.revealsFrom, revealsBy: r.revealsBy, tx: r.tx ?? null, reason: r.reason ?? null });
  if (method === "POST" && p === "/v1/markets/relay/reveals") {
    const m = byMarket(String(body.market ?? ""));
    if (!m || !/^0x[0-9a-fA-F]{40}$/.test(String(body.account)) || !/^0x[0-9a-fA-F]{64}$/.test(String(body.salt)) || !body.order) return [400, { error: "Bad relay request" }];
    const o = body.order;
    const order = { sellAsset: Boolean(o.sellAsset), amountIn: BigInt(o.amountIn), limitPrice: BigInt(o.limitPrice), mode: o.mode === "swap" ? 1 : 0, payFeeInOrry: Boolean(o.payFeeInOrry) };
    const batch = BigInt(body.batch);
    const [rEnd, onChain, mine] = await Promise.all([read(m.market, "revealEnd", [batch]), read(m.market, "commitmentOf", [batch, body.account]), read(m.market, "commitmentFor", [batch, body.account, order, body.salt])]);
    const p2 = await params(m);
    if (now >= Number(rEnd)) return [409, { error: "The reveal window of this batch has closed." }];
    if (onChain.toLowerCase() !== mine.toLowerCase()) return [400, { error: "The order does not match the commitment." }];
    const key = `${m.market}:${batch}:${String(body.account).toLowerCase()}`;
    relayed.set(key, { market: m.market, account: body.account, batch, order, salt: body.salt, done: false, status: "queued", revealsFrom: Number(rEnd) - p2.revealSeconds, revealsBy: Number(rEnd) });
    return [202, relayView(relayed.get(key), m)];
  }
  const rs = p.match(/^\/v1\/markets\/relay\/reveals\/(0x[0-9a-fA-F]{40})\/(\d+)\/(0x[0-9a-fA-F]{40})$/);
  if (method === "GET" && rs) {
    const m = byMarket(rs[1]);
    const r = relayed.get(`${m?.market}:${rs[2]}:${rs[3].toLowerCase()}`);
    if (!m || !r) return [404, { error: "No relayed reveal" }];
    return [200, relayView(r, m)];
  }
  if (method !== "GET") return [404, { error: "Not found" }];
  if (p === "/v1/markets") return [200, { markets: await Promise.all(walk.markets.map((m) => marketView(m, now))), chainTime: now, updatedAt: new Date().toISOString() }];
  let mm = p.match(/^\/v1\/markets\/(0x[0-9a-fA-F]{40})\/batches$/);
  if (mm) {
    const m = byMarket(mm[1]);
    if (!m) return [404, { error: "Unknown market" }];
    const limit = Number(u.searchParams.get("limit") ?? 12);
    const [cur] = await read(m.market, "phase");
    const batches = [];
    for (let b = cur; b >= 0n && batches.length < limit && cur - b < 200n; b--) {
      if ((await read(m.market, "commitCount", [b])) > 0n) batches.push(await batchView(m, b, now, false));
    }
    return [200, { market: m.market, batches, updatedAt: new Date().toISOString() }];
  }
  mm = p.match(/^\/v1\/markets\/(0x[0-9a-fA-F]{40})\/batches\/(\d+)$/);
  if (mm) {
    const m = byMarket(mm[1]);
    if (!m) return [404, { error: "Unknown market" }];
    return [200, await batchView(m, BigInt(mm[2]), now, true)];
  }
  mm = p.match(/^\/v1\/markets\/accounts\/(0x[0-9a-fA-F]{40})\/orders$/);
  if (mm) {
    const account = mm[1];
    const orders = [];
    for (const m of walk.markets) {
      const committed = await pub.getContractEvents({ address: m.market, abi: marketAbi, eventName: "Committed", args: { account }, fromBlock: 0n });
      for (const c of committed) {
        const b = c.args.batch;
        const view = await batchView(m, b, now, false);
        const [rev] = await pub.getContractEvents({ address: m.market, abi: marketAbi, eventName: "Revealed", args: { batch: b, account }, fromBlock: 0n });
        const [f] = await pub.getContractEvents({ address: m.market, abi: marketAbi, eventName: "OrderFilled", args: { batch: b, account }, fromBlock: 0n });
        const [d] = await pub.getContractEvents({ address: m.market, abi: marketAbi, eventName: "OrderDropped", args: { batch: b, account }, fromBlock: 0n });
        const o = rev?.args.order;
        let status = "committed";
        if (!rev) status = now >= view.revealEndsAt ? "missed" : "committed";
        else if (d) status = "dropped";
        else if (view.status === "expired") status = "expired";
        else if (!view.result) status = "revealed";
        else status = f && f.args.inputUsed > 0n ? "filled" : "unfilled";
        const block = await pub.getBlock({ blockNumber: c.blockNumber });
        orders.push({
          market: m.market,
          asset: m.token,
          symbol: m.symbol,
          batch: s(b),
          status,
          commitment: c.args.commitment,
          commitTx: c.transactionHash,
          committedAt: Number(block.timestamp),
          commitFeeBurned: s(c.args.orryBurned),
          revealEndsAt: view.revealEndsAt,
          order: o ? { sellAsset: o.sellAsset, amountIn: s(o.amountIn), limitPrice: s(o.limitPrice), mode: modeName(o.mode), payFeeInOrry: o.payFeeInOrry } : null,
          revealTx: rev?.transactionHash ?? null,
          fill: f && f.args.inputUsed > 0n ? fillOf(f) : null,
        });
      }
    }
    orders.sort((a, b) => b.committedAt - a.committedAt);
    return [200, { address: account, orders: orders.slice(0, Number(u.searchParams.get("limit") ?? 50)), updatedAt: new Date().toISOString() }];
  }
  if (p === "/v1/orry/burns") {
    const by = { 1: 0n, 2: 0n, 3: 0n, 4: 0n, 5: 0n, 6: 0n };
    const items = [];
    for (const m of walk.markets) {
      for (const l of await pub.getContractEvents({ address: m.market, abi: marketAbi, eventName: "Burned", fromBlock: 0n })) {
        by[l.args.source] += l.args.amount;
        const block = await pub.getBlock({ blockNumber: l.blockNumber });
        items.push({ tx: l.transactionHash, block: Number(l.blockNumber), time: Number(block.timestamp), source: l.args.source, amount: s(l.args.amount) });
      }
    }
    items.sort((a, b) => b.block - a.block);
    const total = Object.values(by).reduce((x, y) => x + y, 0n);
    return [200, { total: s(total), bySource: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, s(v)])), items: items.slice(0, Number(u.searchParams.get("limit") ?? 25)), decimals: 18 }];
  }
  return [404, { error: "Not found" }];
}

// Keeper: feeds move, counterparties seal and reveal, batches clear.
const sealedByBots = new Map(); // `${market}:${batch}:${bot}` -> { order, salt, revealed }
let lastPush = 0;
// `wait` false sends without waiting for the block, so one tick can seal and reveal for every wallet in time.
const send = async (from, address, functionName, args, abi = marketAbi, wait = true) => {
  const hash = await wallet(from).writeContract({ address, abi, functionName, args });
  if (!wait) return hash;
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
};
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

async function roundFor(feed, revealEnd) {
  let r = await read(feed, "latestRound", [], feedAbi);
  while (r > 0n) {
    const [, , , upd] = await read(feed, "getRoundData", [r], feedAbi);
    if (Number(upd) <= revealEnd) return r;
    r -= 1n;
  }
  return 0n;
}

async function tick() {
  const now = await nowChain();
  if (now - lastPush >= 20) {
    lastPush = now;
    for (const m of walk.markets) {
      const [, ans] = await read(m.feed, "latestRoundData", [], feedAbi);
      const next = BigInt(Math.round(Number(ans) * (1 + rand(-0.003, 0.003))));
      await send(walk.keeper, m.feed, "push", [next], feedAbi, false);
    }
  }
  for (const m of walk.markets) {
    const [b, inCommit, endsAt] = await read(m.market, "phase");
    const [, ans] = await read(m.feed, "latestRoundData", [], feedAbi);
    const price = BigInt(ans) / 100n;
    for (const [i, bot] of walk.bots.entries()) {
      const key = `${m.market}:${b}:${bot}`;
      if (inCommit && Number(endsAt) - now > 6 && !sealedByBots.has(key) && Math.random() < BOT_RATE) {
        const sell = (i + Number(b)) % 2 === 0;
        const limitPrice = sell ? (price * BigInt(Math.round(rand(9930, 9990)))) / 10000n : (price * BigInt(Math.round(rand(10010, 10070)))) / 10000n;
        const amountIn = sell ? parseEther(rand(0.5, 6).toFixed(3)) : parseUnits(rand(150, 1500).toFixed(2), 6);
        const order = { sellAsset: sell, amountIn, limitPrice, mode: i === 2 ? 1 : 0, payFeeInOrry: i === 1 };
        const salt = `0x${randomBytes(32).toString("hex")}`;
        sealedByBots.set(key, { order, salt, revealed: false, batch: b });
        try {
          const c = await read(m.market, "commitmentFor", [b, bot, order, salt]);
          await send(bot, m.market, "commit", [c], marketAbi, false);
        } catch (e) {
          sealedByBots.delete(key);
          console.log(`KEEPER commit ${m.symbol} ${b}: ${String(e.shortMessage ?? e.message).split("\n")[0]}`);
        }
      }
      const prev = sealedByBots.get(`${m.market}:${b}:${bot}`);
      if (!inCommit && prev && !prev.revealed) {
        prev.revealed = true;
        try {
          await send(bot, m.market, "reveal", [prev.order, prev.salt], marketAbi, false);
        } catch (e) {
          console.log(`KEEPER reveal ${m.symbol} ${b}: ${String(e.shortMessage ?? e.message).split("\n")[0]}`);
        }
      }
    }
    if (b > 0n) {
      const last = b - 1n;
      const [count, commits, r, rEnd] = await Promise.all([read(m.market, "orderCount", [last]), read(m.market, "commitCount", [last]), read(m.market, "result", [last]), read(m.market, "revealEnd", [last])]);
      // Like the real keeper, clear every batch that had an order sealed, revealed or not.
      if (commits > 0n && !r.cleared && now >= Number(rEnd)) {
        try {
          const hint = await roundFor(m.feed, Number(rEnd));
          await send(walk.keeper, m.market, "clear", [last, hint]);
          console.log(`KEEPER cleared ${m.symbol} batch ${last} (${count} orders)`);
        } catch (e) {
          console.log(`KEEPER clear ${m.symbol} ${last}: ${String(e.shortMessage ?? e.message).split("\n")[0]}`);
        }
      }
    }
  }
}

// Relay loop, separate from the keeper so a slow tick never makes it miss a reveal window.
async function relayTick() {
  // Relay: reveal handed-over orders with revealFor once their reveal window is open.
  for (const r of relayed.values()) {
    if (r.done) continue;
    const [b, inCommit] = await read(r.market, "phase");
    if (b === r.batch && !inCommit) {
      r.done = true;
      try {
        r.tx = await send(walk.keeper, r.market, "revealFor", [r.account, r.order, r.salt]);
        r.status = "sent";
        console.log(`RELAY revealed ${r.account} batch ${r.batch}`);
      } catch (e) {
        r.status = "failed";
        r.reason = String(e.shortMessage ?? e.message).split("\n")[0];
        console.log(`RELAY revealFor ${r.batch}: ${r.reason}`);
      }
    } else if (b > r.batch) r.done = true;
  }
}
let relaying = false;
setInterval(async () => {
  if (relaying) return;
  relaying = true;
  try {
    await relayTick();
  } catch (e) {
    console.log(`RELAY ${String(e.message).split("\n")[0]}`);
  } finally {
    relaying = false;
  }
}, 1000);

let running = false;
if (KEEPER)
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (e) {
      console.log(`KEEPER ${String(e.message).split("\n")[0]}`);
    } finally {
      running = false;
    }
  }, 1500);

createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => route(req.method, req.url, raw ? JSON.parse(raw) : {})
    .catch((err) => [500, { error: String(err.shortMessage ?? err.message ?? err) }])
    .then(([status, json]) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
      console.log(`FIXTURE ${req.method} ${req.url} ${status}`);
    }));
}).listen(PORT, "127.0.0.1", () => console.log(`FIXTURE markets API on http://127.0.0.1:${PORT} (chain ${RPC}, keeper ${KEEPER ? "on" : "off"})`));
