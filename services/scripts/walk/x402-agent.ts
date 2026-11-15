/**
 * Walk: the agent's x402 payment on the development network, against the hosted API. The merchant buys a credit pack over
 * x402 (its API key), the agent pays for a pack from its float, and the merchant checks the agent's paying address and
 * verifies the signed answer. Same steps as scripts/exercise-api.ts without the local indexer pass.
 *
 *   npx tsx scripts/walk/x402-agent.ts [api]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AgentClient, OrreryApi, verifyCheck } from "@orrery/sdk";

const API = process.argv[2] ?? "https://orrery-dev-api.187-53-130-188.sslip.io";
const RPC = "https://robinhood-sepolia-rpc.publicnode.com";
const dep = (JSON.parse(readFileSync(new URL("../../../deployments/46630-full.json", import.meta.url), "utf8")) as { a: Record<string, Address> }).a;
const chain = defineChain({ id: 46630, name: "46630", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
const key = (role: string) => (JSON.parse(readFileSync(join(homedir(), ".secrets/orrery", `46630-${role}.json`), "utf8")) as { privateKey: Hex }).privateKey;
const w = (role: string) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(key(role)) }) as WalletClient & { account: Account };
const say = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

const bought = await OrreryApi.buyCredits(API, w("merchant"), pub);
say(`1 merchant pack over x402: credits ${bought.credits}, key ${bought.apiKey ? "issued" : "existing"}`);
const apiKey = bought.apiKey ?? process.env.ORRERY_API_KEY;
if (!apiKey) throw new Error("No API key: set ORRERY_API_KEY from the first purchase.");

const agent = new AgentClient(w("agent-signer"), pub, dep.module!);
const before = (await agent.getAllowance())[0];
const res = await agent.x402Fetch(`${API}/v1/credits`, { method: "POST" });
const after = (await agent.getAllowance())[0];
say(`2 agent pays over x402 from its float: HTTP ${res.status}; remaining today ${before?.remainingToday} -> ${after?.remainingToday}; float headroom ${before?.floatHeadroom} -> ${after?.floatHeadroom}`);

const check = await new OrreryApi(API, apiKey).checkPayer(agent.signer);
const v = await verifyCheck(pub, dep.attestor!, check, { now: BigInt(check.result.issuedAt as string), payer: agent.signer });
const r = v.result as typeof v.result & { stakeActive?: bigint };
say(`3 merchant check: signature ok ${v.ok}; status ${r.status}; verified ${r.verified}; endpoints live ${r.endpointsLive}; spent today ${r.caps[0]?.spentToday}; stake ${r.stakeActive ?? "n/a"}`);
