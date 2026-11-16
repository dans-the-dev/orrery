/**
 * Live check of Orrery's open core on mainnet 4663 from the test buyer wallet, without moving funds or sending a transaction:
 * key rotation (signed message), the free monthly checks and the credits behind them, signed check results verified against
 * the attestor, the public lens reads, and the refusals (bad key, reused nonce, bad input).
 *
 *   tsx scripts/check-core-4663.ts
 *
 * The rotated API key is written to ~/.secrets/orrery/mainnet-buyer-api.json (600) and never printed. Rotation revokes the
 * buyer's earlier key, which is the point of the test.
 */
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, defineChain, fallback, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyCheck, type CheckResponse } from "@orrery/sdk";

const API = "https://api.orreryagent.com";
const SECRETS = join(homedir(), ".secrets/orrery");
const dep = JSON.parse(readFileSync(new URL("../../deployments/4663.json", import.meta.url), "utf8")) as { attestor: Address; checkSigner: Address };
const RPCS = ["https://rpc-robinhood.blockmachine.io", "https://robinhood-rpc.publicnode.com"];
const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: RPCS } } });
const pub = createPublicClient({ chain, transport: fallback(RPCS.map((u) => http(u, { retryCount: 2, timeout: 20_000 }))) });
const buyer = privateKeyToAccount((JSON.parse(readFileSync(join(SECRETS, "mainnet-buyer.json"), "utf8")) as { privateKey: Hex }).privateKey);

const results: [string, boolean, string][] = [];
const check = (label: string, ok: boolean, detail = "") => {
  results.push([label, ok, detail]);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
};
const get = async (path: string, key?: string) => {
  const r = await fetch(`${API}${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: r.status, headers: r.headers, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
type Account = { credits: string; month: { checks: number; freeChecks: number; freeChecksLeft: number }; purchases: unknown[] };

console.log(`Orrery core on 4663, buyer ${buyer.address}`);

// 1 key rotation: nonce, signed message, a new key; the used nonce is refused
const n = (await get(`/v1/keys/nonce?address=${buyer.address}`)).body as { nonce: string; message: string };
check("rotation nonce issued", typeof n.nonce === "string" && n.message.includes(buyer.address));
const signature = await buyer.signMessage({ message: n.message });
const rotated = await post("/v1/keys/rotate", { address: buyer.address, nonce: n.nonce, signature });
const apiKey = rotated.body.apiKey as string | undefined;
check("key rotated with a signed message", rotated.status === 200 && typeof apiKey === "string" && apiKey.startsWith("or_"));
if (!apiKey) process.exit(1);
writeFileSync(join(SECRETS, "mainnet-buyer-api.json"), JSON.stringify({ address: buyer.address, apiKey, issued: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
chmodSync(join(SECRETS, "mainnet-buyer-api.json"), 0o600);
const reused = await post("/v1/keys/rotate", { address: buyer.address, nonce: n.nonce, signature });
check("a used nonce is refused", reused.status === 401, `HTTP ${reused.status}`);
const wrongSigner = await get(`/v1/keys/nonce?address=${buyer.address}`);
const forged = await post("/v1/keys/rotate", { address: dep.checkSigner, nonce: (wrongSigner.body as { nonce: string }).nonce, signature });
check("a nonce for another address is refused", forged.status === 401, `HTTP ${forged.status}`);

// 2 the account behind the new key: the purchased pack is still there
const before = (await get("/v1/credits", apiKey)).body as unknown as Account;
check("credits kept across rotation", before.credits === "500" && before.purchases.length === 1, `credits ${before.credits}, purchases ${before.purchases.length}, free left ${before.month.freeChecksLeft}`);
check("a bad key is refused", (await get("/v1/credits", "or_" + "0".repeat(64))).status === 401);
check("no key is refused", (await get("/v1/credits")).status === 401);

// 3 signed checks, verified against the attestor on chain
const bySigner = await get(`/v1/check/by-signer/${buyer.address}`, apiKey);
check("check by signer answers", bySigner.status === 200, `HTTP ${bySigner.status}, x-orrery-check-credits ${bySigner.headers.get("x-orrery-check-credits")}`);
// The buyer is not an agent session, so its check carries no window (validUntil = issuedAt) and must not be cached; the
// signature is verified as of its issue time.
const issuedAt = (r: { body: Record<string, unknown> }) => BigInt((r.body.result as { issuedAt: string }).issuedAt);
if (bySigner.status === 200) {
  const res = bySigner.body as unknown as CheckResponse;
  const v = await verifyCheck(pub as never, dep.attestor, res, { payer: buyer.address, now: issuedAt(bySigner) });
  check("check signature verifies (active check signer on the attestor)", v.ok, v.ok ? `version ${v.version}` : v.reason);
  const r = res.result as Record<string, string | boolean>;
  check("a non-agent gets no validity window", r.validUntil === r.issuedAt && r.verified === false, `status ${String(r.status)}, validUntil ${String(r.validUntil)} = issuedAt`);
}
const other = getAddress("0x000000000000000000000000000000000000dEaD");
const byOther = await get(`/v1/check/by-signer/${other}`, apiKey);
if (byOther.status === 200) {
  const v = await verifyCheck(pub as never, dep.attestor, byOther.body as unknown as CheckResponse, { payer: buyer.address, now: issuedAt(byOther) });
  check("a check about another address fails the payer pin", !v.ok && v.reason === "check is about another address", v.reason);
} else check("check about another address answers", false, `HTTP ${byOther.status}`);
const byAgent = await get(`/v1/check/by-agent/1?account=${buyer.address}`, apiKey);
check("check by agent answers", byAgent.status === 200, `HTTP ${byAgent.status}`);
check("bad input is refused", (await get(`/v1/check/by-signer/not-an-address`, apiKey)).status === 400);
check("a check without a key is refused", (await get(`/v1/check/by-signer/${buyer.address}`)).status === 401);

// 4 the meter: the three paid checks came out of the free monthly allowance, credits untouched
const after = (await get("/v1/credits", apiKey)).body as unknown as Account;
const used = after.month.checks - before.month.checks;
check("checks metered", used === 3, `month checks ${before.month.checks} -> ${after.month.checks}`);
check("free allowance used before credits", after.month.freeChecksLeft === before.month.freeChecksLeft - 3 && after.credits === before.credits, `free left ${before.month.freeChecksLeft} -> ${after.month.freeChecksLeft}, credits ${before.credits} -> ${after.credits}`);

// 5 public reads (no key)
const signer = await get(`/v1/signers/${buyer.address}`);
check("public signer read", signer.status === 200, `HTTP ${signer.status}`);
const agent = await get(`/v1/agents/1?account=${buyer.address}`);
check("public agent read", agent.status === 200, `HTTP ${agent.status}`);

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `${failed.length} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
