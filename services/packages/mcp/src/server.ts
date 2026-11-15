import { writeFileSync, existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, parseAbi, type Account, type Address, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import {
  AgentClient,
  DATA_DATASETS,
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  decodeHeader,
  encodeHeader,
  signPermit2Payment,
  verifyCheck,
  verifyDataResponse,
  type CheckResponse,
  type DataCatalogResponse,
  type DataPaymentRequirements,
  type DataResponse,
  type PaymentRequired,
  type PaymentRequirements,
  type PublicPaymentRequirements,
} from "@orrery/sdk";
import type { McpConfig } from "./config.js";

/**
 * `@orrery/mcp` (`docs/UPDATE-CANDIDATES.md` 3.6, `docs/updates/L2-DATA-MCP-SPEC.md` D-16). Counterparty tools use the
 * Orrery API key; agent tools sign with the session signer's key, held on the agent's own machine; every tool says what
 * it costs, paid tools report what is left and warn below 20% of a pack, and a payment above the configured amount
 * needs `confirm: true` from the caller.
 */

export const VERSION = "0.1.0";
const LOW = 0.2;
const erc20Abi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const ok = (v: unknown): Text => ({ content: [{ type: "text", text: json(v) }] });
const fail = (message: string): Text => ({ content: [{ type: "text", text: message }], isError: true });

export interface McpDeps {
  config: McpConfig;
  /** Override the RPC client (tests). */
  publicClient?: PublicClient;
  fetch?: typeof fetch;
}

export function createOrreryMcpServer(deps: McpDeps): McpServer {
  const cfg = deps.config;
  const doFetch = deps.fetch ?? fetch;
  const chain = defineChain({ id: cfg.chainId, name: `chain-${cfg.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
  const publicClient = deps.publicClient ?? (createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient);
  const wallet = cfg.agentKey ? (createWalletClient({ chain, transport: http(cfg.rpcUrl), account: privateKeyToAccount(cfg.agentKey) }) as WalletClient & { account: Account }) : null;
  const agent = wallet ? new AgentClient(wallet, publicClient, cfg.module) : null;
  let apiKey = cfg.apiKey;
  let dataSigner: Address | null = null;

  async function api<T>(path: string, init: { key?: boolean; method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; headers: Headers }> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.key) {
      if (!apiKey) throw new Error("This tool needs a Orrery API key: set ORRERY_API_KEY, or buy a data pack with orrery_data_buy_pack first.");
      headers.authorization = `Bearer ${apiKey}`;
    }
    const r = await doFetch(`${cfg.apiUrl}${path}`, { method: init.method ?? "GET", headers });
    const body = (await r.json().catch(() => ({}))) as T;
    return { status: r.status, body, headers: r.headers };
  }
  const errorOf = (b: unknown, status: number) => (b as { error?: string })?.error ?? `The Orrery API answered ${status}.`;

  async function signer(): Promise<Address> {
    if (!dataSigner) dataSigner = getAddress((await api<{ signer: string }>("/v1/data/signer")).body.signer);
    return dataSigner;
  }

  /** Keeps a key issued by a purchase: saved to ORRERY_API_KEY_FILE (mode 600) when set, else held for this session. */
  function keepKey(key: string | undefined): string | null {
    if (!key) return null;
    apiKey = key;
    if (cfg.apiKeyFile && !existsSync(cfg.apiKeyFile)) {
      writeFileSync(cfg.apiKeyFile, key, { mode: 0o600 });
      return `A Orrery API key was issued and saved to ${cfg.apiKeyFile}.`;
    }
    return "A Orrery API key was issued; it is kept for this session. Set ORRERY_API_KEY_FILE to keep the next one.";
  }

  async function creditsNotice(): Promise<{ credits: string; freeChecksLeft: number; notice?: string } | null> {
    const r = await api<{ credits: string; month: { freeChecksLeft: number } }>("/v1/credits", { key: true }).catch(() => null);
    if (!r || r.status !== 200) return null;
    const pricing = await api<{ packSize: number }>("/v1/pricing").catch(() => null);
    const pack = pricing?.body.packSize ?? 500;
    const low = BigInt(r.body.credits) < BigInt(Math.ceil(pack * LOW)) && r.body.month.freeChecksLeft === 0;
    return { credits: r.body.credits, freeChecksLeft: r.body.month.freeChecksLeft, ...(low ? { notice: `Check credits are low (${r.body.credits} left, under 20% of a ${pack} credit pack).` } : {}) };
  }

  const server = new McpServer({ name: "orrery", version: VERSION });

  // ---------------------------------------------------------------- free reads

  server.registerTool(
    "orrery_pricing",
    { title: "Orrery prices", description: "Free. Current prices: checks (free monthly checks, credits per check, packs, the platform plan) and Orrery Data packs in USDG and ORRY.", inputSchema: {} },
    async () => {
      const [checks, data] = await Promise.all([api("/v1/pricing"), api<DataCatalogResponse>("/v1/data").catch(() => null)]);
      return ok({ checks: checks.body, data: data && data.status === 200 ? data.body.pricing : null });
    },
  );

  server.registerTool(
    "orrery_signer_record",
    { title: "Signer record", description: "Free. The public Orrery record of a session signer address: its account, agent, policy, caps and status.", inputSchema: { address: z.string().describe("0x address of the signer") } },
    async ({ address }) => {
      if (!isAddress(address)) return fail("Pass a 0x address.");
      const r = await api(`/v1/signers/${address}`);
      return r.status === 200 ? ok(r.body) : fail(errorOf(r.body, r.status));
    },
  );

  server.registerTool(
    "orrery_agent_record",
    {
      title: "Agent record",
      description: "Free. The public Orrery record of an ERC-8004 agent: verification, attestation, endpoints and, with its account, the policy.",
      inputSchema: { agentId: z.string().regex(/^\d+$/).describe("ERC-8004 agent id"), account: z.string().optional().describe("the agent's smart account, 0x address") },
    },
    async ({ agentId, account }) => {
      if (account && !isAddress(account)) return fail("Pass account as a 0x address.");
      const r = await api(`/v1/agents/${agentId}${account ? `?account=${account}` : ""}`);
      return r.status === 200 ? ok(r.body) : fail(errorOf(r.body, r.status));
    },
  );

  server.registerTool(
    "orrery_verify_check",
    { title: "Verify a check", description: "Free (one chain read). Verifies a signed Orrery check: its signature, that the signer is an active check signer, and that it has not expired.", inputSchema: { check: z.record(z.string(), z.unknown()).describe("the check response as returned by a check tool") } },
    async ({ check }) => {
      const v = await verifyCheck(publicClient, cfg.attestor, check as unknown as CheckResponse);
      return ok({ ok: v.ok, reason: v.reason ?? null, version: v.version ?? null });
    },
  );

  // ---------------------------------------------------------------- counterparty (API key)

  const checkTool = async (path: string) => {
    const r = await api<CheckResponse>(path, { key: true });
    if (r.status !== 200) return fail(errorOf(r.body, r.status));
    const v = await verifyCheck(publicClient, cfg.attestor, r.body).catch(() => ({ ok: false, reason: "could not read the attestor" }));
    return ok({ check: r.body, verified: v.ok, reason: (v as { reason?: string }).reason ?? null, account: await creditsNotice() });
  };

  server.registerTool(
    "orrery_check_payer",
    {
      title: "Check a payer",
      description: "Costs one check: a free monthly check first, then check credits (see orrery_pricing). Needs ORRERY_API_KEY. Signed check of the agent behind a payer address, verified on chain, with the credits left.",
      inputSchema: { address: z.string().describe("0x address that pays you (an agent's session signer)") },
    },
    async ({ address }) => (isAddress(address) ? checkTool(`/v1/check/by-signer/${address}`) : fail("Pass a 0x address.")),
  );

  server.registerTool(
    "orrery_check_agent",
    {
      title: "Check an agent",
      description: "Costs one check: a free monthly check first, then check credits (see orrery_pricing). Needs ORRERY_API_KEY. Signed check of an ERC-8004 agent and its account, verified on chain, with the credits left.",
      inputSchema: { agentId: z.string().regex(/^\d+$/), account: z.string().describe("the agent's smart account, 0x address") },
    },
    async ({ agentId, account }) => (isAddress(account) ? checkTool(`/v1/check/by-agent/${agentId}?account=${account}`) : fail("Pass account as a 0x address.")),
  );

  server.registerTool(
    "orrery_credits",
    { title: "Credits", description: "Free. Needs ORRERY_API_KEY. Check credits, free checks left this month, plan and data calls left on your key.", inputSchema: {} },
    async () => {
      const r = await api("/v1/credits", { key: true });
      if (r.status !== 200) return fail(errorOf(r.body, r.status));
      const data = await api<{ calls: string; packCalls: number; low: boolean }>("/v1/data/account", { key: true }).catch(() => null);
      return ok({ checks: r.body, data: data && data.status === 200 ? data.body : null, notice: (await creditsNotice())?.notice ?? null });
    },
  );

  // ---------------------------------------------------------------- Orrery Data

  server.registerTool(
    "orrery_data_catalog",
    { title: "Orrery Data catalogue", description: "Free. The official datasets (built only from chain data and Orrery's own system), their views and filters, and pack prices.", inputSchema: {} },
    async () => {
      const r = await api<DataCatalogResponse>("/v1/data");
      return r.status === 200 ? ok(r.body) : fail(errorOf(r.body, r.status));
    },
  );

  server.registerTool(
    "orrery_data_query",
    {
      title: "Query a dataset",
      description:
        "Costs one data call (packs of calls are bought with orrery_data_buy_pack; see orrery_pricing). Needs a Orrery API key. Returns signed records, checked against Orrery's data signer before they are shown, with the calls left.",
      inputSchema: {
        dataset: z.enum(DATA_DATASETS),
        view: z.string().optional(),
        filters: z.record(z.string(), z.string()).optional().describe("for example { agentId: '12' } or { symbol: 'TSLA' }"),
        limit: z.number().int().min(1).max(500).optional(),
        before: z.string().optional().describe("the `next` value of the previous page"),
      },
    },
    async ({ dataset, view, filters, limit, before }) => {
      const qs = new URLSearchParams({ ...(filters ?? {}), ...(view ? { view } : {}), ...(limit ? { limit: String(limit) } : {}), ...(before ? { before } : {}) });
      const r = await api<DataResponse & { error?: string }>(`/v1/data/datasets/${dataset}${qs.size ? `?${qs}` : ""}`, { key: true });
      if (r.status === 402) return fail("No data calls left on this key. Buy a pack with orrery_data_buy_pack.");
      if (r.status !== 200) return fail(errorOf(r.body, r.status));
      const v = await verifyDataResponse(r.body, { signer: await signer(), chainId: cfg.chainId });
      if (!v.ok) return fail(`The answer did not verify (${v.reason}); it is not shown.`);
      const calls = BigInt(r.body.account?.calls ?? "0");
      const pack = await api<DataCatalogResponse>("/v1/data").then((x) => x.body.pricing.packCalls).catch(() => 1000);
      const notice = calls < BigInt(Math.ceil(pack * LOW)) ? `Data calls are low (${calls} left, under 20% of a ${pack} call pack).` : null;
      return ok({ verified: true, ...r.body, account: { address: r.body.account?.address, calls: r.body.account?.calls }, notice });
    },
  );

  server.registerTool(
    "orrery_data_verify",
    { title: "Verify a data answer", description: "Free, offline. Verifies a Orrery Data answer: the records and query hashes and the data signer's EIP-712 signature.", inputSchema: { response: z.record(z.string(), z.unknown()) } },
    async ({ response }) => ok(await verifyDataResponse(response as unknown as DataResponse, { signer: await signer().catch(() => undefined), chainId: cfg.chainId })),
  );

  server.registerTool(
    "orrery_data_providers",
    { title: "Data providers", description: "Free. Third-party x402 data providers listed with an ORRY stake: endpoint, declared price per call, stake and 30 day volume.", inputSchema: {} },
    async () => {
      const r = await api("/v1/data/providers");
      return r.status === 200 ? ok(r.body) : fail(errorOf(r.body, r.status));
    },
  );

  // ---------------------------------------------------------------- agent tools (session signer key)

  const needAgent = () => (agent ? null : fail("This tool needs the session signer's key file: set ORRERY_AGENT_KEY_FILE (mode 600)."));
  const overCap = (usd: number, confirm: boolean | undefined) =>
    usd > cfg.maxPaymentUsd && !confirm ? fail(`This payment is ${usd} USD, above the ${cfg.maxPaymentUsd} USD set for this server. Call again with confirm: true to pay it.`) : null;

  server.registerTool(
    "orrery_data_buy_pack",
    {
      title: "Buy a data pack",
      description:
        "Costs one data pack (the price is in orrery_pricing; ORRY pays 20% less), paid by the agent's session signer from its float within the session caps. Needs ORRERY_AGENT_KEY_FILE. Above ORRERY_MCP_MAX_PAYMENT_USD it needs confirm: true. Issues the API key on the first purchase.",
      inputSchema: { asset: z.enum(["USDG", "ORRY"]).default("USDG"), confirm: z.boolean().optional() },
    },
    async ({ asset, confirm }) => {
      const missing = needAgent();
      if (missing) return missing;
      const first = await api("/v1/data/packs", { method: "POST" });
      if (first.status !== 402) return fail(errorOf(first.body, first.status));
      const required = decodeHeader<PaymentRequired>(first.headers.get(HEADER_REQUIRED)!);
      const accepts = required.accepts as unknown as DataPaymentRequirements[];
      const req = accepts.find((a) => (asset === "ORRY" ? a.extra.assetTransferMethod === "permit2" : a.extra.assetTransferMethod === "eip3009"));
      if (!req) return fail(asset === "ORRY" ? "Paying data packs in ORRY is not open right now. Pay in USDG." : "No USDG pack is offered right now.");
      const usd = Number(asset === "ORRY" ? (req.extra.usd ?? "0") : req.amount) / 1e6;
      const capped = overCap(usd, confirm);
      if (capped) return capped;
      let header: string;
      if (asset === "USDG") {
        await agent!.ensureFloat(getAddress(req.asset), BigInt(req.amount));
        header = encodeHeader(await agent!.signPayment(req as unknown as PaymentRequirements, cfg.chainId, required.resource));
      } else {
        const allowance = await publicClient.readContract({ address: req.asset, abi: erc20Abi, functionName: "allowance", args: [agent!.signer, req.extra.permit2!] });
        if (allowance < BigInt(req.amount)) return fail(`The signer ${agent!.signer} has not approved Permit2 (${req.extra.permit2}) for ORRY. Approve it once from the signer, then try again.`);
        header = encodeHeader(await signPermit2Payment(wallet!, { chainId: cfg.chainId, requirements: req as unknown as PublicPaymentRequirements, permit2: req.extra.permit2!, proxy: req.extra.proxy! }));
      }
      for (let i = 0; i < 10; i++) {
        const r = await api<{ account?: { address: string; calls: string; apiKey?: string }; granted?: string; transaction?: string; error?: string }>("/v1/data/packs", { method: "POST", headers: { [HEADER_SIGNATURE]: header } });
        if (r.status === 202) {
          await new Promise((res) => setTimeout(res, 2_000));
          continue;
        }
        if (r.status !== 200) return fail(errorOf(r.body, r.status));
        const note = keepKey(r.body.account?.apiKey);
        return ok({ paid: { asset, amount: req.amount, usd }, calls: r.body.account?.calls, granted: r.body.granted, transaction: r.body.transaction, key: note });
      }
      return fail("The payment is still confirming. Call orrery_credits in a minute to see the calls.");
    },
  );

  server.registerTool(
    "orrery_allowance",
    { title: "Allowance", description: "Free (chain reads). Needs ORRERY_AGENT_KEY_FILE. What the agent may still spend today per capped token, and its float headroom.", inputSchema: {} },
    async () => {
      const missing = needAgent();
      if (missing) return missing;
      return ok({ signer: agent!.signer, ...(await agent!.session()), caps: await agent!.getAllowance() });
    },
  );

  server.registerTool(
    "orrery_ensure_float",
    {
      title: "Top up the float",
      description: "Costs gas only. Needs ORRERY_AGENT_KEY_FILE. Moves a capped token from the agent's account into the signer's float, within the session caps, so the float holds at least `amount` (base units).",
      inputSchema: { token: z.string(), amount: z.string().regex(/^\d+$/) },
    },
    async ({ token, amount }) => {
      const missing = needAgent();
      if (missing) return missing;
      if (!isAddress(token)) return fail("Pass token as a 0x address.");
      const tx = await agent!.ensureFloat(getAddress(token), BigInt(amount));
      return ok({ transaction: tx, toppedUp: tx !== null });
    },
  );

  server.registerTool(
    "orrery_pay_x402",
    {
      title: "Pay an x402 URL",
      description:
        "Costs what the URL asks for (x402 `exact` in USDG), paid from the agent's float within the session caps. Needs ORRERY_AGENT_KEY_FILE. Above ORRERY_MCP_MAX_PAYMENT_USD it needs confirm: true. HTTPS only (or localhost).",
      inputSchema: { url: z.string().url(), method: z.enum(["GET", "POST"]).default("GET"), body: z.string().max(65_536).optional(), confirm: z.boolean().optional() },
    },
    async ({ url, method, body, confirm }) => {
      const missing = needAgent();
      if (missing) return missing;
      const u = new URL(url);
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return fail("Only https URLs can be paid.");
      const init: RequestInit = { method, ...(body ? { body, headers: { "content-type": "application/json" } } : {}) };
      const first = await doFetch(url, init);
      if (first.status !== 402) return ok({ status: first.status, paid: false, body: await first.text() });
      const header = first.headers.get(HEADER_REQUIRED);
      if (!header) return fail("The URL answered 402 without payment requirements.");
      const required = decodeHeader<PaymentRequired>(header);
      const req = required.accepts.find((a) => a.scheme === "exact" && a.network === `eip155:${cfg.chainId}` && (a.extra?.assetTransferMethod ?? "eip3009") === "eip3009");
      if (!req) return fail(`No x402 exact requirement on chain ${cfg.chainId} that this server can pay.`);
      const capped = overCap(Number(req.amount) / 1e6, confirm);
      if (capped) return capped;
      await agent!.ensureFloat(getAddress(req.asset), BigInt(req.amount));
      const payload = await agent!.signPayment(req, cfg.chainId, required.resource);
      const headers = new Headers(init.headers);
      headers.set(HEADER_SIGNATURE, encodeHeader(payload));
      const paid = await doFetch(url, { ...init, headers });
      return ok({ status: paid.status, paid: paid.ok, amount: req.amount, asset: req.asset, payTo: req.payTo, body: await paid.text() });
    },
  );

  return server;
}
