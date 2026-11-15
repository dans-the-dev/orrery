// Development walk harness for the wave R1 market pages: compiles dev/mocks/MarketMocks.sol (and the ORRY mocks for
// ORRY and staking), deploys them to a local anvil, seeds the walk wallet and three counterparty wallets, and writes
// dev/markets-walk.json plus .env.development.local for `next dev`. Local anvil only (chain 31337).
// Batches are shortened for the walk (60 s sealing, 30 s reveal; the spec's guesses are 240 s and 60 s).
// Run: anvil --port 8566 --block-time 1 & node dev/setup-markets-walk.mjs && node dev/markets-fixture.mjs
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, maxUint256, parseEther, parseUnits } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.WALK_RPC ?? "http://127.0.0.1:8566";
const API = process.env.WALK_API ?? "http://127.0.0.1:3411";
const chain = defineChain({ id: 31337, name: "Local chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
if ((await pub.getChainId()) !== 31337) throw new Error("setup-markets-walk runs against a local anvil (31337) only");

const compile = (file, ir) => JSON.parse(execFileSync("solc", ["--combined-json", "abi,bin", "--optimize", ...(ir ? ["--via-ir"] : []), join(here, file)], { encoding: "utf8", maxBuffer: 64 << 20 }));
const outs = [compile("mocks/OrryMocks.sol", false), compile("mocks/MarketMocks.sol", true)];
const art = (name) => {
  for (const out of outs) {
    const key = Object.keys(out.contracts).find((k) => k.endsWith(`:${name}`));
    if (key) {
      const c = out.contracts[key];
      return { abi: typeof c.abi === "string" ? JSON.parse(c.abi) : c.abi, bytecode: `0x${c.bin}` };
    }
  }
  throw new Error(`no artifact ${name}`);
};

const accounts = await pub.request({ method: "eth_accounts" });
const [deployer, bot1, bot2, bot3, treasury] = accounts;
// The walk wallet is a fresh anvil account the browser shim signs for (index 5).
const me = process.env.WALK_ME ?? accounts[5];
const w = (account) => createWalletClient({ chain, transport: http(RPC), account });

async function deploy(name, args = []) {
  const { abi, bytecode } = art(name);
  const hash = await w(deployer).deployContract({ abi, bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  return { address: r.contractAddress, abi };
}
async function call(c, fn, args = [], from = deployer) {
  if (process.env.WALK_VERBOSE) console.error(`call ${fn}`);
  const hash = await w(from).writeContract({ address: c.address, abi: c.abi, functionName: fn, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
}

const orry = await deploy("MockOrry");
const registry = await deploy("MockRegistry", [deployer]);
const staking = await deploy("MockStaking", [orry.address, registry.address]);
const usdg = await deploy("MockToken", ["Global Dollar", "USDG", 6]);
const orryPrice = await deploy("MockOrryPrice", [400n]);
// Tier thresholds in USD (R-44, R-46): 100 USD of stake for 25% off, 1,000 USD for 50% off.
const tiers = await deploy("MockFeeTiers", [staking.address, orryPrice.address, [parseUnits("100", 6), parseUnits("1000", 6)], [2500, 5000]]);
const factory = await deploy("MockFactory");

// ACME has no official logo in lib/markets/logos.ts, so the web must not list it (owner rule).
const STOCKS = [
  ["Tesla", "TSLA", 24512n],
  ["Apple", "AAPL", 22840n],
  ["NVIDIA", "NVDA", 14185n],
  ["Acme Robotics", "ACME", 5120n],
];
const now = Number((await pub.getBlock()).timestamp);
const start = BigInt(now - (now % 90));
const markets = [];
for (const [name, symbol, cents] of STOCKS) {
  const token = await deploy("MockToken", [name, symbol, 18]);
  const feed = await deploy("MockFeed", [cents * 1_000_000n]);
  const market = await deploy("MockMarket", [
    [token.address, usdg.address, feed.address, treasury, tiers.address, orryPrice.address, orry.address],
    start,
    60,
    30,
    15,
    parseUnits("10", 6),
    3600,
    50_000n,
  ]);
  await call(factory, "add", [token.address, market.address, feed.address]);
  const entry = { symbol, name, token: token.address, feed: feed.address, market: market.address };
  // R1b: TSLA gets a stand-in Uniswap pool for the unmatched part of Private Swap orders; the others have none.
  if (symbol === "TSLA") {
    const pool = await deploy("MockPool", [token.address, usdg.address]);
    await call(token, "mint", [pool.address, parseEther("2000")]);
    await call(usdg, "mint", [pool.address, parseUnits("1000000", 6)]);
    await call(market, "setPool", [pool.address]);
    entry.pool = pool.address;
  }
  markets.push(entry);
}

// Seed: the walk wallet holds USDG, two stocks and staked ORRY (the 25% tier); the counterparties hold both sides.
const tokenOf = (s) => ({ address: markets.find((m) => m.symbol === s).token, abi: art("MockToken").abi });
await call(usdg, "mint", [me, parseUnits("50000", 6)]);
await call(tokenOf("TSLA"), "mint", [me, parseEther("12")]);
await call(tokenOf("AAPL"), "mint", [me, parseEther("25")]);
await call(orry, "mint", [me, parseEther("400000")]);
await w(deployer).sendTransaction({ to: me, value: parseEther("50") }).then((hash) => pub.waitForTransactionReceipt({ hash }));
await call(orry, "approve", [staking.address, parseEther("150000")], me);
await call(staking, "stake", [parseEther("150000")], me);
for (const bot of [bot1, bot2, bot3]) {
  await call(usdg, "mint", [bot, parseUnits("2000000", 6)]);
  await call(orry, "mint", [bot, parseEther("1000000")]);
  await call(orry, "approve", [markets[0].market, maxUint256], bot);
  for (const m of markets) {
    const t = { address: m.token, abi: art("MockToken").abi };
    await call(t, "mint", [bot, parseEther("5000")]);
    await call(t, "approve", [m.market, maxUint256], bot);
    await call(usdg, "approve", [m.market, maxUint256], bot);
    await call(orry, "approve", [m.market, maxUint256], bot);
  }
}

const out = { me, bots: [bot1, bot2, bot3], keeper: deployer, treasury, orry: orry.address, staking: staking.address, usdg: usdg.address, tiers: tiers.address, orryPrice: orryPrice.address, factory: factory.address, markets };
writeFileSync(join(here, "markets-walk.json"), JSON.stringify(out, null, 2));
writeFileSync(
  join(here, "../.env.development.local"),
  [
    "# Written by dev/setup-markets-walk.mjs for the local markets walk (anvil + fixture API). Not for any deployment.",
    "NEXT_PUBLIC_CHAIN_ID=31337",
    `NEXT_PUBLIC_RPC_URL=${RPC}`,
    `NEXT_PUBLIC_API_URL=${API}`,
    `NEXT_PUBLIC_USDG=${usdg.address}`,
    `NEXT_PUBLIC_ORRY_TOKEN=${orry.address}`,
    `NEXT_PUBLIC_ORRY_STAKING=${staking.address}`,
    `NEXT_PUBLIC_MARKET_FACTORY=${factory.address}`,
    // The fixture serves the proposed relay route, so the walk shows the opt-in relay choice.
    "NEXT_PUBLIC_MARKETS_RELAY=1",
    `NEXT_PUBLIC_ORRY_FEATURES=${process.env.WALK_FEATURES ?? "stocks,swap,darkpool,burn,stake"}`,
    "",
  ].join("\n"),
);
console.log(JSON.stringify(out, null, 2));
