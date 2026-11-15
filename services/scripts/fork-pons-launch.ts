/**
 * Dry-run helper for scripts/deploy-orry-4663.ts: on an anvil fork of 4663, launches a token named Orrery (ORRY) on
 * the real Pons V2 factory with the deployer key (creator fees to the deployer, the owner's wallet: R-1), buys it on
 * the curve from impersonated fresh addresses until it graduates, creates the Pons pool, and prints the token address.
 * Refuses to run against anything but anvil, so it can never spend real funds.
 *
 *   tsx scripts/fork-pons-launch.ts --rpc http://127.0.0.1:18548 [--keys 46630]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, formatEther, getAddress, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const RPC = arg("--rpc");
if (!RPC) throw new Error("--rpc <anvil fork of 4663> is required.");
const KEYS = arg("--keys") ?? "46630";
const FACTORY = getAddress("0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e");
const PONS_HOOK = getAddress("0xe5e702641ea86f4ae6cc3cdaed2b886f976be044");
const STATE_VIEW = getAddress("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b");
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const factoryAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)",
  "function launchFee() view returns (uint256)",
  "function graduate(address token)",
  "function createGraduatedPool(address token) returns (uint256 positionId)",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);
const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)",
  "function readyToGraduate() view returns (bool)",
]);
const stateViewAbi = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"]);

const chain = defineChain({ id: 4663, name: "Robinhood Chain (fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const client = (await pub.request({ method: "web3_clientVersion" as never })) as string;
if (!/anvil/i.test(client) || (await pub.getChainId()) !== 4663) throw new Error(`Refusing: ${RPC} is not an anvil fork of 4663 (${client}).`);
const rpc = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });

const owner = privateKeyToAccount((JSON.parse(readFileSync(join(homedir(), ".secrets/orrery", `${KEYS}-deployer.json`), "utf8")) as { privateKey: Hex }).privateKey);
const ownerWallet = createWalletClient({ chain, transport: http(RPC), account: owner });
await rpc("anvil_setBalance", [owner.address, toHex(10n ** 19n)]);

const fee = (await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "launchFee" })) as bigint;
const params = {
  name: "Orrery", symbol: "ORRY", logo: "", description: "fork dry run",
  socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
  creatorFeeRecipient: owner.address, creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: ("0x" + "00".repeat(32)) as Hex,
  salt: keccak256(toHex(`orrery fork dry run ${Date.now()}`)),
};
const sim = await pub.simulateContract({ address: FACTORY, abi: factoryAbi, functionName: "launchToken", args: [params, 0n, ZERO], value: fee, account: owner });
const [token, curve] = sim.result as readonly [Address, Address];
const launchHash = await ownerWallet.writeContract(sim.request);
if ((await pub.waitForTransactionReceipt({ hash: launchHash })).status !== "success") throw new Error("launchToken reverted");
console.log(`launched ORRY ${token} (curve ${curve}, launch fee ${formatEther(fee)} ETH, creator fees to ${owner.address})`);

await rpc("evm_increaseTime", [toHex(10)]); // past the snipe-tax window
await rpc("evm_mine", []);
const phase = async () => ((await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] })) as { phase: number }).phase;
const buy = async (from: Address, value: bigint) => {
  const w = createWalletClient({ chain, transport: http(RPC), account: from });
  const hash = await w.writeContract({ address: curve, abi: curveAbi, functionName: "buy", args: [value, 0n, from], value, account: from, chain });
  return (await pub.waitForTransactionReceipt({ hash })).status === "success";
};
// the owner holds some ORRY for a smoke test (signed with its key); fresh impersonated buyers (no code, unlike anvil's
// default accounts on 4663) do the rest
{
  const hash = await ownerWallet.writeContract({ address: curve, abi: curveAbi, functionName: "buy", args: [5n * 10n ** 17n, 0n, owner.address], value: 5n * 10n ** 17n, chain, account: owner });
  if ((await pub.waitForTransactionReceipt({ hash })).status !== "success") throw new Error("owner buy reverted");
}
let offered = 5n * 10n ** 17n;
for (let i = 0; i < 40 && (await phase()) === 0; i++) {
  if ((await pub.readContract({ address: curve, abi: curveAbi, functionName: "readyToGraduate" })) as boolean) break;
  const buyer = getAddress(("0x" + keccak256(toHex(`orrery fork buyer ${i}`)).slice(26)) as Hex);
  await rpc("anvil_impersonateAccount", [buyer]);
  await rpc("anvil_setBalance", [buyer, toHex(10n ** 18n)]);
  if (!(await buy(buyer, 5n * 10n ** 17n))) break;
  offered += 5n * 10n ** 17n;
  await rpc("anvil_stopImpersonatingAccount", [buyer]);
}
if ((await phase()) === 0) await ownerWallet.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "graduate", args: [token], chain, account: owner }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
if ((await phase()) === 1) await ownerWallet.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "createGraduatedPool", args: [token], chain, account: owner }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const lt = (await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] })) as { phase: number; poolFee: number; tickSpacing: number; pairToken: Address };
if (lt.phase !== 2) throw new Error(`ORRY did not reach its Pons pool (phase ${lt.phase}).`);
const poolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [ZERO, token, lt.poolFee, lt.tickSpacing, PONS_HOOK]));
const [sqrtPriceX96] = (await pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] })) as readonly [bigint, number, number, number];
console.log(`graduated: ETH offered on the curve ${formatEther(offered)}, Pons pool fee ${lt.poolFee} spacing ${lt.tickSpacing}, poolId ${poolId}, sqrtPriceX96 ${sqrtPriceX96}`);
console.log(`ORRY=${token}`);
