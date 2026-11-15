/**
 * Orrery deployment for Robinhood Chain mainnet 4663 (or a local fork of it).
 *
 *   tsx scripts/deploy-4663.ts --rpc http://127.0.0.1:8548 --fork   dry run on an anvil fork of 4663 (46630 keys)
 *   tsx scripts/deploy-4663.ts                                       live: prints a summary and waits for CONFIRM
 *
 * Owner decision 2026-11-08: the deployer is also the attestor owner and the treasury owner, so --owner and
 * --treasury-owner default to the deployer; pass them only to hand either role to another wallet.
 *
 * Deploys OrreryAttestor (USDG fee), OrreryPolicyModule and OrreryLens against the real ERC-8004 IdentityRegistry, USDG, Permit2,
 * EntryPoints, the Safe7579 v1.0.0 adapter and the Safe 1.4.1 singletons, sets the check-signer and attester keys,
 * deploys OrreryTreasury in coinless mode (owner decisions T2, T11: it ships with v1; R-57: 30% of USDG revenue to the
 * treasury owner for operations and the owner, 70% held for the ORRY buyback) and points the attestor's fee at it, then hands the attestor to the
 * owner's wallet (two-step: the owner then calls acceptOwnership). The treasury starts with no quote signer; one is set
 * with setQuoteSigner when ORRY launches (ORRY checkout is closed until the coin is set). Keys are read from
 * ~/.secrets/orrery/<keys>-<role>.json; nothing is printed but addresses.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, isAddress, type Abi, type Account, type Address, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { orreryAttestorAbi, orreryLensAbi, orreryPolicyModuleAbi, orreryTreasuryAbi } from "@orrery/shared";
import * as bytecode from "../test/generated/bytecode.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const FORK = process.argv.includes("--fork");
// The official RPC: it accepts transactions (rpc-robinhood.blockmachine.io serves reads only and refuses eth_sendRawTransaction,
// found on the first live run 2026-11-11). Where the official name is DNS-blocked, pass --rpc https://robinhood-rpc.publicnode.com.
const RPC = arg("--rpc") ?? "https://rpc.mainnet.chain.robinhood.com";
const KEYS = arg("--keys") ?? (FORK ? "46630" : "mainnet");

/** 4663 addresses, verified with eth_getCode and identity calls on 2026-11-06 and 2026-11-07. */
export const MAINNET = {
  registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  entryPoint07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  entryPoint08: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  safe7579Adapter: "0x7579EE8307284F293B1927136486880611F20002", // accountId rhinestone.safe7579.v1.0.0
  safeSingletons: ["0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", "0x41675C099F32341bf84BFc5382aF534df5C7461a"], // 1.4.1 L2, 1.4.1
  // runtime codehash of SafeProxy from SafeProxyFactory 1.4.1 (0x4e1D…ec67): proxyCreationCode run through eth_call
  safeProxyCodehashes: ["0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c"],
} as const satisfies Record<string, unknown>;
const FEE = 5_000_000n; // 5 USDG (owner may change it later, capped at 50 USDG)
const OWNER_BPS = 3000; // treasury: 30% of USDG revenue to the treasury owner (20% operations + 10% owner), 70% to the buyback reserve (R-57, replaces R-4/T9's 90/10)

const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 1500 }) });
const keyOf = (role: string) => (JSON.parse(readFileSync(join(homedir(), ".secrets/orrery", `${KEYS}-${role}.json`), "utf8")) as { privateKey: Hex }).privateKey;
const addrOf = (role: string) => privateKeyToAccount(keyOf(role)).address;

const deployerWallet = createWalletClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 1500 }), account: privateKeyToAccount(keyOf("deployer")) }) as WalletClient & { account: Account };
const deployer = deployerWallet.account.address;
const owner = (arg("--owner") ?? deployer) as Address;
if (arg("--treasury")) throw new Error("--treasury is replaced by --treasury-owner: the attestor's treasury is now the OrreryTreasury contract.");
const treasuryOwner = (arg("--treasury-owner") ?? deployer) as Address;
if (!isAddress(owner) || !isAddress(treasuryOwner)) throw new Error("--owner and --treasury-owner must be addresses.");

const chainId = await pub.getChainId();
if (chainId !== 4663) throw new Error(`Expected chain 4663, got ${chainId}`);
for (const [name, a] of Object.entries({ registry: MAINNET.registry, usdg: MAINNET.usdg, adapter: MAINNET.safe7579Adapter, permit2: MAINNET.permit2 })) {
  const code = await pub.getCode({ address: a as Address });
  if (!code || code === "0x") throw new Error(`${name} has no code at ${a}`);
}
if (FORK) await pub.request({ method: "anvil_setBalance" as never, params: [deployer, "0x2386F26FC10000"] as never });

const price = await pub.getGasPrice();
const balance = await pub.getBalance({ address: deployer });
const ESTIMATE_GAS = 9_000_000n; // attestor + module + lens + two role calls + treasury + setTreasury: 8.24 M measured on a 4663 fork (2026-11-08)
console.log(`Orrery deployment on chain 4663${FORK ? " (fork)" : ""}
  deployer        ${deployer} (balance ${formatEther(balance)} ETH)
  attestor owner  ${owner}${owner === deployer ? " (deployer)" : " (two-step: owner calls acceptOwnership after)"}
  treasury        OrreryTreasury (coinless), owner ${treasuryOwner}${treasuryOwner === deployer ? " (deployer)" : ""}, ${OWNER_BPS / 100}% to the owner
  fee             ${Number(FEE) / 1e6} USDG
  check signer    ${addrOf("check-signer")}
  attester        ${addrOf("attester")}
  gas estimate    ~${ESTIMATE_GAS} gas at ${price} wei = ~${formatEther(ESTIMATE_GAS * price)} ETH`);

if (!FORK && balance < ESTIMATE_GAS * price) {
  console.log(`Deployer balance is below the estimate. Send at least ${formatEther(ESTIMATE_GAS * price * 2n)} ETH to ${deployer} on 4663 first. Nothing was sent.`);
  process.exit(1);
}

if (!FORK) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Type CONFIRM to deploy on mainnet: ");
  rl.close();
  if (answer.trim() !== "CONFIRM") {
    console.log("Not confirmed. Nothing was sent.");
    process.exit(1);
  }
}

let spent = 0n;
async function deploy(name: string, abi: Abi, code: Hex, args: unknown[]): Promise<{ address: Address; block: bigint }> {
  const hash = await deployerWallet.deployContract({ abi, bytecode: code, args, chain, account: deployerWallet.account });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deployment failed (${hash})`);
  spent += r.gasUsed * r.effectiveGasPrice;
  console.log(`deployed ${name.padEnd(8)} ${r.contractAddress} (${hash}, gas ${r.gasUsed})`);
  return { address: r.contractAddress, block: r.blockNumber };
}
async function call(to: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await deployerWallet.writeContract({ address: to, abi, functionName, args, chain, account: deployerWallet.account } as never);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  spent += r.gasUsed * r.effectiveGasPrice;
  console.log(`  ${functionName} ${hash}`);
}

// The attestor starts with the deployer as its fee treasury and is pointed at OrreryTreasury below (spec 3.5 order).
const attestor = await deploy("attestor", orreryAttestorAbi as Abi, bytecode.orreryAttestorBytecode, [MAINNET.registry, MAINNET.usdg, deployer, deployer, FEE]);
const module = await deploy("module", orreryPolicyModuleAbi as Abi, bytecode.orreryPolicyModuleBytecode, [
  MAINNET.registry, attestor.address, MAINNET.permit2, MAINNET.entryPoint07, MAINNET.entryPoint08, MAINNET.safe7579Adapter,
]);
const lens = await deploy("lens", orreryLensAbi as Abi, bytecode.orreryLensBytecode, [module.address, attestor.address, MAINNET.safe7579Adapter, MAINNET.safeProxyCodehashes, MAINNET.safeSingletons]);
await call(attestor.address, orreryAttestorAbi as Abi, "setCheckSigner", [addrOf("check-signer"), true]);
await call(attestor.address, orreryAttestorAbi as Abi, "setAttester", [addrOf("attester"), true]);
const treasury = await deploy("treasury", orreryTreasuryAbi as Abi, bytecode.orreryTreasuryBytecode, [MAINNET.usdg, attestor.address, treasuryOwner, OWNER_BPS, []]);
await call(attestor.address, orreryAttestorAbi as Abi, "setTreasury", [treasury.address]);
if (owner.toLowerCase() !== deployer.toLowerCase()) await call(attestor.address, orreryAttestorAbi as Abi, "transferOwnership", [owner]);

// read back
const [fee, tr, cs, at, modReg] = await Promise.all([
  pub.readContract({ address: attestor.address, abi: orreryAttestorAbi, functionName: "fee" }),
  pub.readContract({ address: attestor.address, abi: orreryAttestorAbi, functionName: "treasury" }),
  pub.readContract({ address: attestor.address, abi: orreryAttestorAbi, functionName: "isCheckSigner", args: [addrOf("check-signer")] }),
  pub.readContract({ address: attestor.address, abi: orreryAttestorAbi, functionName: "isAttester", args: [addrOf("attester")] }),
  pub.readContract({ address: module.address, abi: orreryPolicyModuleAbi, functionName: "identityRegistry" }),
]);
const known = await pub.readContract({ address: lens.address, abi: orreryLensAbi, functionName: "isKnownSafeProxyCodehash", args: [MAINNET.safeProxyCodehashes[0]] });
console.log(`read back: fee ${fee}, treasury ${tr}, check signer ${cs}, attester ${at}, registry ${modReg}, Safe proxy known ${known}`);
const read = (functionName: string) => pub.readContract({ address: treasury.address, abi: orreryTreasuryAbi, functionName } as never) as Promise<unknown>;
const [tOwner, tPending, tUsdg, tAttestor, tOrry, tBuyback, tBps] = await Promise.all(
  ["owner", "pendingOwner", "usdg", "attestor", "orry", "buyback", "OWNER_BPS"].map(read),
);
const same = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();
const zero = "0x0000000000000000000000000000000000000000";
const treasuryOk = same(tr, treasury.address) && same(tOwner, treasuryOwner) && same(tPending, zero) && same(tUsdg, MAINNET.usdg)
  && same(tAttestor, attestor.address) && same(tOrry, zero) && same(tBuyback, zero) && Number(tBps) === OWNER_BPS;
console.log(`read back treasury: owner ${tOwner}, pending ${tPending}, usdg ${tUsdg}, attestor ${tAttestor}, orry ${tOrry}, buyback ${tBuyback}, OWNER_BPS ${tBps}`);
if (!treasuryOk) throw new Error("Treasury read-back does not match. Do not start the API; check the deployment above.");
console.log(`spent ${formatEther(spent)} ETH`);

const tag = FORK ? "4663-fork" : "4663";
mkdirSync(join(here, "../../deployments"), { recursive: true });
writeFileSync(join(here, `../../deployments/${tag}.json`), JSON.stringify({
  chainId: 4663, deployBlock: attestor.block.toString(), attestor: attestor.address, module: module.address, lens: lens.address,
  ...MAINNET, owner, treasury: treasury.address, treasuryOwner, ownerBps: OWNER_BPS, deployer, checkSigner: addrOf("check-signer"), attester: addrOf("attester"), fee: FEE.toString(), spentEth: formatEther(spent),
}, null, 2) + "\n");
console.log(`wrote deployments/${tag}.json`);
console.log(`API: ORRERY_TREASURY=${treasury.address} (x402 packs and verification fees pay the treasury contract)`);
