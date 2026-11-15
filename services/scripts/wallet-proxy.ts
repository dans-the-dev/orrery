/**
 * Local signing proxy for browser walks on a test network: holds one key read from a 600 key file and answers JSON-RPC on
 * 127.0.0.1. Account, signing and sending are handled here; everything else goes to the upstream RPC. A page-side
 * EIP-6963 shim forwards its requests to this proxy, so the key never enters the page or a chat. Test networks only.
 *
 *   ORRERY_WALLET_KEY_FILE=~/.secrets/orrery/46630-walk.json ORRERY_UPSTREAM_RPC=https://rpc.testnet.chain.robinhood.com \
 *     tsx scripts/wallet-proxy.ts
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const upstream = process.env.ORRERY_UPSTREAM_RPC ?? "https://rpc.testnet.chain.robinhood.com";
const port = Number(process.env.ORRERY_WALLET_PROXY_PORT ?? 8549);
const { privateKey } = JSON.parse(readFileSync(process.env.ORRERY_WALLET_KEY_FILE!, "utf8")) as { privateKey: Hex };
const account = privateKeyToAccount(privateKey);

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: unknown; error?: { code: number; message: string } };
}
const chainId = Number(((await rpc("eth_chainId", [])).result as string) ?? "0x0");
if (chainId === 4663 || chainId === 1) throw new Error("wallet-proxy is for test networks only");
const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [upstream] } } });
const wallet = createWalletClient({ chain, transport: http(upstream), account });

async function handle(method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case "eth_accounts":
    case "eth_requestAccounts":
      return [account.address];
    case "personal_sign":
      return account.signMessage({ message: { raw: params[0] as Hex } });
    case "eth_signTypedData_v4": {
      const typed = JSON.parse(params[1] as string) as { domain: never; types: Record<string, unknown>; primaryType: string; message: never };
      const { EIP712Domain: _drop, ...types } = typed.types;
      return account.signTypedData({ domain: typed.domain, types: types as never, primaryType: typed.primaryType as never, message: typed.message });
    }
    case "eth_sendTransaction": {
      const tx = params[0] as { to?: Hex; data?: Hex; value?: Hex; gas?: Hex };
      return wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined, chain, account } as never);
    }
    default: {
      const r = await rpc(method, params);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.result;
    }
  }
}

createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const msg = JSON.parse(body || "{}") as { id?: number; method: string; params?: unknown[] };
    try {
      const result = await handle(msg.method, msg.params ?? []);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? 1, result }));
    } catch (e) {
      const err = e as { code?: number; message?: string };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? 1, error: { code: err.code ?? -32000, message: err.message ?? "error" } }));
    }
  });
}).listen(port, "127.0.0.1", () => console.log(`wallet proxy for ${account.address} on chain ${chainId}, port ${port}`));
