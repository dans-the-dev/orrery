/**
 * Development network only: keeps each DevRoundFeed on 46630 in step with the Robinhood Chain 4663 Chainlink feed it
 * mirrors, so the markets there clear at real prices. Every ORRERY_DEV_FEEDS_EVERY_MS (10 minutes) it reads the 4663
 * answer and pushes a round when the answer changed, or when the last round is older than ORRERY_DEV_FEEDS_REFRESH_MS
 * (55 minutes) so the feed stays fresh through market closures. Refuses chain 4663.
 *
 *   ORRERY_DEV_FEEDS=<46630 feed>=<4663 feed>,...   ORRERY_DEV_FEEDS_SOURCE_RPC=<4663 RPC list>
 *   ORRERY_DEV_FEEDS_KEY_FILE=<feed owner key file>  (the 46630 keeper key)
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, fallback, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { logLine } from "../log.js";

const chainId = Number(process.env.ORRERY_CHAIN_ID ?? 0);
if (chainId === 4663 || !chainId) throw new Error("dev-feeds runs on a development network only (ORRERY_CHAIN_ID other than 4663)");
const pairs = (process.env.ORRERY_DEV_FEEDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [dev, src] = s.split("=");
    return { dev: getAddress(dev!), src: getAddress(src!) };
  });
if (!pairs.length) throw new Error("Set ORRERY_DEV_FEEDS");
const urls = (process.env.ORRERY_RPC_URL ?? "").split(",").map((u) => u.trim()).filter(Boolean);
const srcUrls = (process.env.ORRERY_DEV_FEEDS_SOURCE_RPC ?? "https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com").split(",").map((u) => u.trim()).filter(Boolean);
const keyFile = process.env.ORRERY_DEV_FEEDS_KEY_FILE;
if (!keyFile) throw new Error("Set ORRERY_DEV_FEEDS_KEY_FILE");
const raw = readFileSync(keyFile, "utf8").trim();
const key = (raw.startsWith("{") ? (JSON.parse(raw) as { privateKey: Hex }).privateKey : raw) as Hex;
const everyMs = Number(process.env.ORRERY_DEV_FEEDS_EVERY_MS ?? 10 * 60_000);
const refreshMs = Number(process.env.ORRERY_DEV_FEEDS_REFRESH_MS ?? 55 * 60_000);

const chain = defineChain({ id: chainId, name: "development network", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: urls } } });
const transport = fallback(urls.map((u) => http(u, { retryCount: 2 })));
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ chain, transport, account: privateKeyToAccount(key) });
const source = createPublicClient({ transport: fallback(srcUrls.map((u) => http(u, { retryCount: 2 }))) });
const abi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function push(int256 answer) returns (uint80)",
]);

async function pass(): Promise<string[]> {
  const pushed: string[] = [];
  for (const p of pairs) {
    const [, answer] = await source.readContract({ address: p.src, abi, functionName: "latestRoundData" });
    let last: { answer: bigint; at: number } | null = null;
    try {
      const [, a, , t] = await pub.readContract({ address: p.dev as Address, abi, functionName: "latestRoundData" });
      last = { answer: a, at: Number(t) * 1000 };
    } catch {
      last = null; // no round yet
    }
    if (last && last.answer === answer && Date.now() - last.at < refreshMs) continue;
    const hash = await wallet.writeContract({ address: p.dev, abi, functionName: "push", args: [answer], chain, account: wallet.account });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    pushed.push(`${p.dev}:${r.status}`);
  }
  return pushed;
}

for (;;) {
  try {
    const pushed = await pass();
    if (pushed.length) console.log(JSON.stringify({ at: new Date().toISOString(), pushed }));
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: logLine(e) }));
  }
  await new Promise((res) => setTimeout(res, everyMs));
}
