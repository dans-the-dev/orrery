// Live walk on orreryagent.com with real funds on Robinhood Chain 4663, for the owner to run and confirm.
//
//   node scripts/walk/operator-live-4663.mjs --sign-only    Dashboard Credits with signed messages only: sign in, issue
//                                                           an API key, run a signed check. No transaction, no funds.
//   node scripts/walk/operator-live-4663.mjs --dry-run      prints the plan, the balances and the cost ceiling; opens the
//                                                           live page far enough to see the first button; sends nothing
//   node scripts/walk/operator-live-4663.mjs                prints the same, waits for a typed CONFIRM, then walks
//   node scripts/walk/operator-live-4663.mjs --resume       continues a walk that stopped: the account, agent and signer
//                                                           come from the saved key file, and only the steps the chain
//                                                           does not show as done are run (also takes --dry-run)
//   [--skip-verify]  leave out the agent verification (the attestor's fee, read from the chain)
//   [--skip-pack]    leave out the credit pack bought from the dashboard
//
// The walk wallet (~/.secrets/orrery/mainnet-walk.json, never printed) is the operator: it creates its account in
// Dashboard, Agents, registers an agent, binds it, creates the signer on the page, opens a session from the Small
// preset, adds 1 USDG to the account, sends the page's default ETH to the signer, pays the verification, and buys one
// credit pack in Dashboard, Credits. The saved key file then tops the agent's float up to 0.5 USDG through the module.
// Fund the wallet first with fund-roles-4663.ts --roles walk and fund-usdg-4663.ts --to walk (each has its own CONFIRM).
//
// Every wallet request passes the policy below (guarded-wallet.mjs): a destination, function or amount it does not
// name is refused, and the walk stops. Secrets written (mode 600, addresses only on screen):
//   ~/.secrets/orrery/mainnet-walk-agent.env   the agent signer's key file from the page
//   ~/.secrets/orrery/mainnet-walk-api.json    the API key issued to the walk wallet
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createPublicClient, decodeFunctionData, erc20Abi, fallback, formatEther, formatUnits, getAddress, http, parseAbi, parseEther, parseEventLogs, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { attachGuardedWallet } from "./guarded-wallet.mjs";
const require = createRequire(process.env.WALK_PLAYWRIGHT ?? "/home/dand/Projects/promo-films/_pw/package.json");
const { chromium } = require("playwright-core");

const has = (f) => process.argv.includes(f);
const SIGN_ONLY = has("--sign-only");
const DRY = has("--dry-run");
const RESUME = has("--resume");
const VERIFY = !has("--skip-verify");
const PACK = !has("--skip-pack") && !process.env.WALK_RPC;
const SECRETS = join(homedir(), ".secrets/orrery");
// Rehearsal: WALK_RPC (a local anvil fork of 4663, nothing else is accepted) with WALK_SITE (a local build of the web
// pointed at that fork) runs the same steps and the same policy with no real funds. The check service does not see a
// fork, so a rehearsal ends after the agent's top-up and leaves the dashboard's Credits steps to the live run.
const REHEARSAL = Boolean(process.env.WALK_RPC);
if (REHEARSAL && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(process.env.WALK_RPC)) throw new Error("WALK_RPC must be a local fork");
if (REHEARSAL && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(process.env.WALK_SITE ?? "")) throw new Error("a rehearsal needs WALK_SITE, a local web build on that fork");
const SHOTS = new URL(REHEARSAL ? "../../.local/live-walk-rehearsal/" : "../../.local/live-walk/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const AGENT_ENV = REHEARSAL && !RESUME ? join(SHOTS, "rehearsal-agent.env") : join(SECRETS, "mainnet-walk-agent.env");
const SITE = REHEARSAL ? process.env.WALK_SITE : "https://orreryagent.com";
const API = "https://api.orreryagent.com";
// publicnode first: it publishes transactions; blockmachine answers reads but refuses eth_sendRawTransaction
const RPCS = REHEARSAL ? [process.env.WALK_RPC] : ["https://robinhood-rpc.publicnode.com", "https://rpc-robinhood.blockmachine.io"];
const KEY_FILE = join(SECRETS, "mainnet-walk.json");
// declared below, once the mode is known: a fresh rehearsal must never write over the live agent's key file
const API_KEY_FILE = join(SECRETS, "mainnet-walk-api.json");


const dep = JSON.parse(readFileSync(new URL("../../../deployments/4663.json", import.meta.url), "utf8"));
const lc = (a) => a.toLowerCase();
const MODULE = lc(dep.module);
const ATTESTOR = lc(dep.attestor);
const REGISTRY = lc(dep.registry);
const USDG = lc(dep.usdg);
const TREASURY = lc(dep.treasury);
// Safe 1.4.1 and the Safe7579 adapter on 4663, the same addresses the page uses (packages/web/lib/operator-setup.ts).
const FACTORY = lc("0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67");
const SINGLETON = lc("0x29fcB43b46531BcA003ddC8FCB67FFE91900C762");
const MULTISEND = lc("0x9641d764fc13c8B624c04430C7356C1C7C8102e2");

// What the walk moves, at most.
const ACCOUNT_USDG = parseUnits("1", 6); // into the new account
const TOP_UP = 500_000n; // the agent's float, drawn from the account through the module
const SIGNER_ETH = parseEther("0.0002"); // the page's default first gas for the signer
const MAX_TX = 12;
const GAS_BUDGET = 2_500_000n; // all transactions together; the fork walk used about 1.3 M

const pub = createPublicClient({ transport: fallback(RPCS.map((u) => http(u, { retryCount: 2, timeout: 30_000 }))) });
if ((await pub.getChainId()) !== 4663) throw new Error("not chain 4663");
const owner = privateKeyToAccount(JSON.parse(readFileSync(KEY_FILE, "utf8")).privateKey).address;
const usdgOf = (a) => pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

const abi = {
  factory: parseAbi(["function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)", "event ProxyCreation(address indexed proxy, address singleton)"]),
  registry: parseAbi(["function register(string agentURI) returns (uint256 agentId)", "function setAgentWallet(uint256 agentId,address newWallet,uint256 deadline,bytes signature)"]),
  safe: parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)"]),
  attestor: parseAbi(["function fee() view returns (uint128)", "function isVerified(uint256 agentId) view returns (bool)", "function payVerification(uint256 agentId,address expectedOwner,uint128 maxFee)"]),
};
// A fresh walk would save a new signer over the key file of the agent that is already open on mainnet.
if (!RESUME && !SIGN_ONLY && !REHEARSAL && existsSync(AGENT_ENV)) {
  console.log(`A key file from an earlier walk exists (${AGENT_ENV}). Continue that walk with --resume, or move the file away to start a new agent.`);
  process.exit(1);
}
// A stopped walk left its account, agent and signer in the key file; the chain says which steps are still open.
const prior = RESUME ? Object.fromEntries(readFileSync(AGENT_ENV, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("="))) : null;
const done = { account: false, signerGas: false, verified: false };
if (prior) {
  done.account = (await usdgOf(prior.ORRERY_ACCOUNT)) >= ACCOUNT_USDG;
  done.signerGas = (await pub.getBalance({ address: prior.ORRERY_SIGNER_ADDRESS })) > 0n;
  done.verified = await pub.readContract({ address: ATTESTOR, abi: abi.attestor, functionName: "isVerified", args: [BigInt(prior.ORRERY_AGENT_ID)] });
}
const payFee = VERIFY && !done.verified;
const fee = payFee ? await pub.readContract({ address: ATTESTOR, abi: abi.attestor, functionName: "fee" }) : 0n;
const pricing = await (await fetch(`${API}/v1/pricing`)).json();
const packPrice = PACK ? BigInt(pricing.packPrice) : 0n;

// ------------------------------------------------------------------ the policy
const state = { safe: prior ? lc(prior.ORRERY_ACCOUNT) : null, signer: prior ? lc(prior.ORRERY_SIGNER_ADDRESS) : null, typedSigned: 0, hashSigned: 0, textSigned: 0, txs: 0, allowTypedData: false };
const decode = (a, data) => {
  try {
    return decodeFunctionData({ abi: a, data });
  } catch {
    return null;
  }
};
const policy = {
  personalSign(hex) {
    const bytes = (hex.length - 2) / 2;
    if (bytes === 32) {
      // one bare hash: the Safe message that binds the agent's identity to the new account
      if (SIGN_ONLY) return "a hash is signed only in the full walk";
      if (!state.safe) return "no account yet";
      if (RESUME) return "the identity is already bound";
      return ++state.hashSigned <= 1 ? true : "a second hash";
    }
    const text = Buffer.from(hex.slice(2), "hex").toString("utf8");
    if (!/orrery/i.test(text)) return "a message that does not name Orrery";
    return ++state.textSigned <= 4 ? true : "too many signed messages";
  },
  typedData(typed) {
    if (!state.allowTypedData) return "typed data is signed only for the credit pack";
    const m = typed.message ?? {};
    if (typed.primaryType !== "TransferWithAuthorization") return "not a USDG authorization";
    if (lc(String(typed.domain?.verifyingContract)) !== USDG || Number(typed.domain?.chainId) !== 4663) return "not USDG on 4663";
    if (lc(String(m.from)) !== lc(owner) || lc(String(m.to)) !== TREASURY) return "not from the walk wallet to the treasury";
    if (BigInt(m.value) !== packPrice || packPrice === 0n) return "not the pack price";
    return ++state.typedSigned <= 1 ? true : "a second authorization";
  },
  async transaction({ to, data, value }) {
    if (SIGN_ONLY) return "this mode sends nothing";
    if (++state.txs > MAX_TX) return "more transactions than the walk has steps";
    const t = lc(to);
    if (t === FACTORY) {
      const d = decode(abi.factory, data);
      return value === 0n && !state.safe && d?.functionName === "createProxyWithNonce" && lc(d.args[0]) === SINGLETON ? true : "not the account creation";
    }
    if (t === REGISTRY) {
      const d = decode(abi.registry, data);
      if (value !== 0n || !d) return "not a registry call the walk makes";
      if (d.functionName === "register") return true;
      return d.functionName === "setAgentWallet" && state.safe && lc(d.args[1]) === state.safe ? true : "binding to another wallet";
    }
    if (state.safe && t === state.safe) {
      const d = decode(abi.safe, data);
      if (value !== 0n || d?.functionName !== "execTransaction") return "not a Safe execution";
      const [innerTo, innerValue, , operation] = d.args;
      if (innerValue !== 0n) return "the account would send ETH";
      if (lc(innerTo) === MULTISEND && operation === 1) return true; // account setup
      if (lc(innerTo) === MODULE && operation === 0) return true; // session calls
      return "the account would call something else";
    }
    if (t === USDG) {
      const d = decode(erc20Abi, data);
      if (value !== 0n || !d) return "not a USDG call the walk makes";
      if (d.functionName === "transfer") return state.safe && lc(d.args[0]) === state.safe && d.args[1] <= ACCOUNT_USDG ? true : "USDG to another address or above 1 USDG";
      if (d.functionName === "approve") return payFee && lc(d.args[0]) === ATTESTOR && d.args[1] <= fee ? true : "an approval beyond the verification fee";
      return "not a USDG call the walk makes";
    }
    if (t === ATTESTOR) {
      const d = decode(abi.attestor, data);
      return payFee && value === 0n && d?.functionName === "payVerification" && d.args[2] <= fee ? true : "not the verification";
    }
    if (data === "0x" && state.signer && t === state.signer) return value <= SIGNER_ETH ? true : "more ETH than the signer's first gas";
    return "a destination the walk does not name";
  },
  async onReceipt(tx, receipt) {
    if (receipt.status !== "success") throw new Error(`transaction ${receipt.transactionHash} reverted`);
    if (lc(tx.to) === FACTORY) {
      const proxy = parseEventLogs({ abi: abi.factory, logs: receipt.logs, eventName: "ProxyCreation" })[0]?.args.proxy;
      if (proxy) state.safe = lc(proxy);
    }
  },
};

// ------------------------------------------------------------------ plan and gate
const gasPrice = await pub.getGasPrice();
const [ethNow, usdgNow] = await Promise.all([pub.getBalance({ address: owner }), usdgOf(owner)]);
const needUsdg = SIGN_ONLY ? 0n : (done.account ? 0n : ACCOUNT_USDG) + fee + packPrice;
// twice the current gas price, since the wallet client bids above it
const needEth = SIGN_ONLY ? 0n : (done.signerGas ? 0n : SIGNER_ETH) + (RESUME ? GAS_BUDGET / 4n : GAS_BUDGET) * gasPrice * 2n;
if (SIGN_ONLY) {
  console.log(`Orrery live walk, signed messages only (no transaction, no funds)\n  site    ${SITE}\n  wallet  ${owner}`);
} else {
  const todo = RESUME
    ? [
        `continues agent #${prior.ORRERY_AGENT_ID} on account ${prior.ORRERY_ACCOUNT} (signer ${prior.ORRERY_SIGNER_ADDRESS})`,
        done.account ? "account already holds its USDG" : `add ${formatUnits(ACCOUNT_USDG, 6)} USDG to the account`,
        done.signerGas ? "signer already has ETH" : `send ${formatEther(SIGNER_ETH)} ETH to the signer`,
      ]
    : ["create account (2 tx), register agent, bind identity, open session (Small preset: 1 / 10 / 5 USDG)", `add ${formatUnits(ACCOUNT_USDG, 6)} USDG to the account, send ${formatEther(SIGNER_ETH)} ETH to the signer`];
  if (VERIFY) todo.push(payFee ? `pay verification (${formatUnits(fee, 6)} USDG to the attestor)` : "verification already paid");
  if (PACK) todo.push(`buy one credit pack in the dashboard (${formatUnits(packPrice, 6)} USDG to the treasury ${dep.treasury}, signed, no gas)`);
  todo.push(`agent tops its float up to ${formatUnits(TOP_UP, 6)} USDG from the account`);
  console.log(`Orrery live walk on Robinhood Chain mainnet (4663)${RESUME ? ", resumed" : ""}${REHEARSAL ? "  [REHEARSAL on a local fork, no real funds]" : ""}
  site        ${SITE}
  wallet      ${owner}  (ETH ${formatEther(ethNow)}, USDG ${formatUnits(usdgNow, 6)})
  steps       ${todo.join(",\n              ")}
  USDG out    at most ${formatUnits(needUsdg, 6)} USDG
  ETH out     at most ${formatEther(needEth)} ETH (a gas ceiling at ${(Number(gasPrice) / 1e9).toFixed(3)} gwei${done.signerGas || SIGN_ONLY ? "" : `, plus ${formatEther(SIGNER_ETH)} to the signer`})
  stays       the account, the agent and its session stay open on mainnet as the wallet's own`);
  if (ethNow < needEth || usdgNow < needUsdg) {
    console.log(`\nThe wallet is short: it needs ${formatEther(needEth)} ETH and ${formatUnits(needUsdg, 6)} USDG. Fund it first:
  ./node_modules/.bin/tsx scripts/fund-roles-4663.ts --roles walk --target ${formatEther(needEth + needEth / 5n)}
  ./node_modules/.bin/tsx scripts/fund-usdg-4663.ts --to walk --usdg ${formatUnits(needUsdg + 200_000n, 6)}`);
    if (!DRY) process.exit(1);
  }
}

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !/_rsc|402|401|favicon|ERR_BLOCKED_BY_CLIENT/.test(m.text()) && errors.push(m.text().slice(0, 200)));
const wallet = await attachGuardedWallet(page, { keyFile: KEY_FILE, rpcs: RPCS, chainId: 4663, name: "Orrery walk", policy });
const connect = async () => {
  const b = page.getByRole("button", { name: "Connect wallet", disabled: false }).first();
  if (await b.isVisible().catch(() => false)) await b.click();
  await page.waitForTimeout(2500);
};
const finish = async (code) => {
  say(`requests refused by the policy: ${wallet.refused.join(" | ") || "none"}`);
  say(`console errors: ${[...new Set(errors)].join(" | ") || "none"}`);
  await browser.close();
  process.exit(code);
};
const fail = async (why) => {
  say(`STOPPED: ${why}`);
  await page.screenshot({ path: join(SHOTS, "stopped.png"), fullPage: true, mask: [page.locator(".cp-key code"), page.locator(".cp-snippet"), page.getByLabel("API key")] }).catch(() => {});
  await finish(1);
};

if (DRY) {
  await page.goto(`${SITE}/dashboard/agents${prior ? `?account=${prior.ORRERY_ACCOUNT}&agent=${prior.ORRERY_AGENT_ID}` : ""}`, { waitUntil: "load", timeout: 120_000 });
  await connect();
  if (prior) {
    await page.locator(".editor").waitFor({ timeout: 60_000 });
    await page.waitForTimeout(4000);
    const list = (await page.locator(".setup-steps li").evaluateAll((els) => els.map((e) => `${e.dataset.done === "true" ? "done" : "open"} ${e.querySelector("strong")?.textContent}`))).join(" | ");
    say(`dry run: the agent is open on the live page: ${list} · ${(await page.locator(".editor-head").innerText()).replace(/\s+/g, " ")}`);
  } else {
    const create = page.getByRole("button", { name: /^Create a Safe$/ });
    await create.waitFor({ timeout: 60_000 });
    say(`dry run: ${new URL(page.url()).pathname} is open, "Create a Safe" is ${(await create.isDisabled()) ? "disabled" : "ready"}`);
  }
  say("dry run: nothing was signed or sent.");
  await finish(0);
}
if (!SIGN_ONLY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(REHEARSAL ? "\nType CONFIRM to run this rehearsal on the local fork: " : "\nType CONFIRM to run this walk on mainnet with the walk wallet: ");
  rl.close();
  if (answer.trim() !== "CONFIRM") {
    console.log("Not confirmed. Nothing was signed or sent.");
    await browser.close();
    process.exit(1);
  }
}

// ------------------------------------------------------------------ credits, signed messages only
async function creditsSignedOnly(payer, label) {
  await page.goto(`${SITE}/dashboard/credits`, { waitUntil: "load", timeout: 120_000 });
  await connect();
  const signIn = page.getByRole("button", { name: "Show my credits" });
  if (await signIn.isVisible().catch(() => false)) {
    await signIn.click();
    await page.getByText("This month's included checks").waitFor({ timeout: 60_000 });
  }
  await page.waitForTimeout(2000);
  say(`${label} signed in: ${(await page.locator(".cp-stats").innerText()).replace(/\s+/g, " ")}`);
  await page.getByRole("button", { name: /^(Issue my API key|Replace the key)$/ }).click();
  await page.locator(".cp-key code").first().waitFor({ timeout: 60_000 });
  const apiKey = (await page.locator(".cp-key code").first().innerText()).trim();
  writeFileSync(API_KEY_FILE, JSON.stringify({ address: owner, apiKey, issuedAt: new Date().toISOString() }), { mode: 0o600 });
  chmodSync(API_KEY_FILE, 0o600);
  say(`${label} API key issued and saved to ${API_KEY_FILE} (${apiKey.length} characters, not shown); snippet shown: ${await page.locator(".cp-snippet").isVisible()}`);
  await page.getByLabel("Paying address").fill(payer);
  await page.getByRole("button", { name: "Send a signed check" }).click();
  const rows = page.locator(".cp-try ~ .cp-rows");
  await rows.waitFor({ timeout: 60_000 });
  const text = (await rows.innerText()).replace(/\s+/g, " ");
  say(`${label} signed check of ${payer}: ${text}`);
  // the key is on the page in three places; none of them reaches the picture
  await page.screenshot({ path: join(SHOTS, `${label}-credits.png`), fullPage: true, mask: [page.locator(".cp-key code"), page.locator(".cp-snippet"), page.getByLabel("API key")] });
  if (!/Signature Valid/.test(text)) await fail("the check's signature did not verify in the browser");
  return text;
}

if (SIGN_ONLY) {
  await creditsSignedOnly(owner, "sign-only");
  if (wallet.sent.length) await fail("a transaction was sent in sign-only mode");
  say("sign-only: no transaction was sent, no typed data was signed.");
  await finish(0);
}

// ------------------------------------------------------------------ the operator walk
const notice = async () => (await page.locator(".notice").last().innerText().catch(() => "")).trim();
async function act(name, timeoutMs = 300_000) {
  const btn = page.getByRole("button", { name }).first();
  await btn.waitFor({ timeout: 60_000 });
  for (let i = 0; i < 60 && (await btn.isDisabled()); i++) await page.waitForTimeout(1000);
  const before = await notice();
  await btn.click();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const n = await notice();
    if (n !== before && /: done\.|was not completed|closed/.test(n)) return n;
    await page.waitForTimeout(1000);
  }
  return `TIMEOUT, last notice: ${await notice()}`;
}
const must = async (label, text) => {
  say(`${label}: ${text}`);
  if (!/: done\./.test(text)) await fail(`${label} did not finish`);
};
const steps = async () => (await page.locator(".setup-steps li").evaluateAll((els) => els.map((e) => `${e.dataset.done === "true" ? "done" : "open"} ${e.querySelector("strong")?.textContent}`))).join(" | ");

let account, agentId, env;
if (!RESUME) {
  await page.goto(`${SITE}/dashboard/agents`, { waitUntil: "load", timeout: 120_000 });
  await connect();
  await must("1 create account (2 transactions)", await act(/^Create a Safe$/));
  account = getAddress(await page.getByPlaceholder("0x… Safe address").inputValue());
  if (lc(account) !== state.safe) await fail("the page shows another account than the one created");
  await must("2 register agent", await act(/^Register an identity$/));
  agentId = await page.getByPlaceholder("1", { exact: true }).inputValue();
  say(`   account ${account}, agent #${agentId}`);
  await page.locator(".editor").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4000);
  await must("3 bind identity", await act(/^Bind identity$/));
  await page.waitForTimeout(3000);

  await page.getByRole("button", { name: "Generate a signer" }).click();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save the key file" }).click();
  await (await dl).saveAs(AGENT_ENV);
  chmodSync(AGENT_ENV, 0o600);
  env = Object.fromEntries(readFileSync(AGENT_ENV, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("=")));
  state.signer = lc(env.ORRERY_SIGNER_ADDRESS);
  say(`4 signer ${env.ORRERY_SIGNER_ADDRESS}; key file saved to ${AGENT_ENV} (mode 600)`);
  await page.getByLabel(/I saved the key file/).check();
  await page.getByRole("button", { name: "Small", exact: true }).click();
  const field = (l) => page.locator("label", { hasText: l }).locator("input").first();
  say(`   limits: per payment ${await field("Per payment").inputValue()}, per day ${await field("Per day").inputValue()}, float ${await field("Float ceiling").inputValue()}, expiry ${await field("Policy expiry").inputValue()}`);
  await must("5 open session", await act(/^Open session$/));
  await page.waitForTimeout(4000);
  say(`   steps: ${await steps()}`);

} else {
  env = prior;
  account = getAddress(prior.ORRERY_ACCOUNT);
  agentId = prior.ORRERY_AGENT_ID;
  await page.goto(`${SITE}/dashboard/agents?account=${account}&agent=${agentId}`, { waitUntil: "load", timeout: 120_000 });
  await connect();
  await page.locator(".editor").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4000);
  say(`resumed agent #${agentId} on ${account}: ${await steps()}`);
  if (!/done Session/.test(await steps())) await fail("the session is not open; start a fresh walk instead of resuming");
}

if (!done.account) {
  await page.locator(".fund-row").nth(0).locator("input").fill(formatUnits(ACCOUNT_USDG, 6));
  await must("6 add USDG to the account", await act(/^Add USDG$/));
} else say("6 the account already holds its USDG");
if (!done.signerGas) await must("7 send ETH to the signer", await act(/^Send ETH$/));
else say("7 the signer already has ETH");
if (payFee) {
  await must("8 pay verification", await act(/^Pay verification$/));
  await page.waitForTimeout(4000);
}
say(`   steps: ${await steps()}`);
await page.screenshot({ path: join(SHOTS, "agents-done.png"), fullPage: true });

// the workspace's own tsx, so the walk does not depend on pnpm being on the PATH of the shell that runs it
let agentOut;
try {
  agentOut = execFileSync(new URL("../../node_modules/.bin/tsx", import.meta.url).pathname, ["scripts/walk/agent-from-keyfile.ts", AGENT_ENV, dep.usdg, "--amount", TOP_UP.toString(), "--over", "30000000", ...(REHEARSAL ? ["--rpc", process.env.WALK_RPC] : ["--live"])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: new URL("../..", import.meta.url).pathname });
} catch (e) {
  // one line of why, never the whole error (it carries the contract ABI and the signed transaction)
  const why = /Details: ([^\n]+)/.exec(String(e.stderr ?? e.message))?.[1] ?? String(e.stderr ?? e.message).split("\n").find((l) => /Error/.test(l)) ?? "unknown error";
  await fail(`9 the agent's top-up from the key file did not go through: ${why.slice(0, 200)}`);
}
const r = JSON.parse(agentOut.trim().split("\n").pop());
say(`9 agent from the key file: session account ${r.account}, agent #${r.agentId}, top-up ${r.topUp}, float ${Number(r.float) / 1e6} USDG, account ${Number(await usdgOf(account)) / 1e6} USDG`);
say(`   above the float ceiling: ${r.aboveCeiling}`);
if (lc(r.account) !== lc(account) || BigInt(r.float) < TOP_UP || r.aboveCeiling === "went through") await fail("the agent's top-up check failed");

if (REHEARSAL) {
  say("rehearsal ends here: the signer record, the signed check and the credit pack need the live check service.");
  await finish(0);
}

// the public record of the new signer, as any merchant sees it
await page.goto(`${SITE}/signer/${env.ORRERY_SIGNER_ADDRESS}`, { waitUntil: "load" });
await page.waitForTimeout(6000);
say(`10 public record: ${(await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 220)}`);
await page.screenshot({ path: join(SHOTS, "signer-record.png"), fullPage: true });

// credits in the dashboard: key, a signed check of the new signer, then the pack
const checkText = await creditsSignedOnly(env.ORRERY_SIGNER_ADDRESS, "11");
if (!/Session Active/.test(checkText)) await fail("the signed check does not show the new session as active");
if (PACK) {
  state.allowTypedData = true;
  const before = await usdgOf(owner);
  await page.getByRole("button", { name: `Buy the pack, ${Number(formatUnits(packPrice, 6)).toLocaleString("en-US")} USDG`, exact: true }).click();
  // the earlier "Key issued." note is cleared when the purchase starts; wait for the purchase's own outcome
  let text = "";
  for (let i = 0; i < 120; i++) {
    text = (await page.locator(".cp-note.is-ok, .cp-note.is-error").first().innerText().catch(() => "")).trim();
    if (text && !/Key issued\./.test(text)) break;
    await page.waitForTimeout(1000);
  }
  say(`12 credit pack from the dashboard: ${text} (wallet USDG ${formatUnits(before, 6)} -> ${formatUnits(await usdgOf(owner), 6)})`);
  await page.screenshot({ path: join(SHOTS, "credits-pack.png"), fullPage: true, mask: [page.locator(".cp-key code"), page.locator(".cp-snippet"), page.getByLabel("API key")] });
  if (!/Credits added/.test(text)) await fail("the pack purchase did not finish");
}

const gas = wallet.sent.reduce((n, t) => n + t.gasUsed * t.gasPrice, 0n);
say(`transactions from the wallet: ${wallet.sent.length}, gas ${formatEther(gas)} ETH`);
for (const t of wallet.sent) say(`   ${t.hash} to ${t.to}${t.value ? ` value ${formatEther(t.value)} ETH` : ""}`);
say(`wallet now: ETH ${formatEther(await pub.getBalance({ address: owner }))}, USDG ${formatUnits(await usdgOf(owner), 6)}`);
writeFileSync(join(SHOTS, "result.json"), JSON.stringify({ at: new Date().toISOString(), owner, account, agentId, signer: env.ORRERY_SIGNER_ADDRESS, topUp: r.topUp, transactions: wallet.sent.map((t) => t.hash) }, null, 2));
await finish(0);
