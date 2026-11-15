// Development walk harness: compiles dev/mocks/OrryMocks.sol with the local solc, deploys it to a local anvil, seeds
// one account with ORRY, fees, rewards and stakes, and writes dev/walk.json plus .env.development.local for `next dev`.
// Local anvil only (chain 31337). Run: anvil --port 8566 & node dev/setup-walk.mjs
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, parseEther } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.WALK_RPC ?? "http://127.0.0.1:8566";
const API = process.env.WALK_API ?? "http://127.0.0.1:3411";
const chain = defineChain({ id: 31337, name: "Local chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
if ((await pub.getChainId()) !== 31337) throw new Error("setup-walk runs against a local anvil (31337) only");

const out = JSON.parse(execFileSync("solc", ["--combined-json", "abi,bin", "--optimize", join(here, "mocks/OrryMocks.sol")], { encoding: "utf8" }));
const art = (name) => {
  const key = Object.keys(out.contracts).find((k) => k.endsWith(`:${name}`));
  const c = out.contracts[key];
  return { abi: typeof c.abi === "string" ? JSON.parse(c.abi) : c.abi, bytecode: `0x${c.bin}` };
};

const [me, other] = await pub.request({ method: "eth_accounts" });
const wallet = createWalletClient({ chain, transport: http(RPC), account: me });
const otherWallet = createWalletClient({ chain, transport: http(RPC), account: other });

async function deploy(name, args = []) {
  const { abi, bytecode } = art(name);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  return { address: r.contractAddress, abi };
}
async function call(c, fn, args = [], value, w = wallet) {
  const hash = await w.writeContract({ address: c.address, abi: c.abi, functionName: fn, args, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
}

const token = await deploy("MockOrry");
const hook = await deploy("MockHook");
const registry = await deploy("MockRegistry", [me]);
const vault = await deploy("MockVault", [token.address, hook.address]);
const staking = await deploy("MockStaking", [token.address, registry.address]);
const router = await deploy("MockRouter", [token.address]);
const claimAll = await deploy("MockClaimAll", [vault.address, staking.address]);
const treasury = await deploy("MockTreasury", [token.address]);

// Seed: ORRY for both accounts, a deposit and stakes from the other account, fees and rewards for the walk account,
// an agent stake behind agent 7, and something waiting in the router.
await call(token, "mint", [me, parseEther("2500000")]);
await call(token, "mint", [other, parseEther("900000")]);
await call(token, "approve", [vault.address, parseEther("1000000")], undefined, otherWallet);
await call(vault, "deposit", [parseEther("400000"), 0n, 0n], parseEther("2"), otherWallet);
await call(token, "approve", [staking.address, parseEther("300000")], undefined, otherWallet);
await call(staking, "stake", [parseEther("300000")], undefined, otherWallet);
await call(token, "approve", [vault.address, parseEther("60000")]);
await call(vault, "seedFees", [me, parseEther("1830.5")], parseEther("0.0421"));
await call(token, "approve", [staking.address, parseEther("150000")]);
await call(staking, "seedRewards", [me, parseEther("2210.25")], parseEther("0.0187"));
await call(staking, "stake", [parseEther("120000")]);
await call(staking, "stakeForAgent", [7n, parseEther("25000")]);
await call(token, "transfer", [router.address, parseEther("5400")]);
await wallet.sendTransaction({ to: router.address, value: parseEther("0.31") }).then((hash) => pub.waitForTransactionReceipt({ hash }));

const addresses = { me, other, token: token.address, hook: hook.address, registry: registry.address, vault: vault.address, staking: staking.address, router: router.address, claimAll: claimAll.address, treasury: treasury.address };
writeFileSync(join(here, "walk.json"), JSON.stringify(addresses, null, 2));
writeFileSync(
  join(here, "../.env.development.local"),
  [
    "# Written by dev/setup-walk.mjs for the local walk (anvil + fixture API). Not for any deployment.",
    "NEXT_PUBLIC_CHAIN_ID=31337",
    `NEXT_PUBLIC_RPC_URL=${RPC}`,
    `NEXT_PUBLIC_API_URL=${API}`,
    `NEXT_PUBLIC_REGISTRY=${registry.address}`,
    `NEXT_PUBLIC_ORRY_TOKEN=${token.address}`,
    `NEXT_PUBLIC_ORRY_EARN_VAULT=${vault.address}`,
    `NEXT_PUBLIC_ORRY_STAKING=${staking.address}`,
    `NEXT_PUBLIC_ORRY_CLAIM_ALL=${claimAll.address}`,
    `NEXT_PUBLIC_ORRY_REWARDS_ROUTER=${router.address}`,
    `NEXT_PUBLIC_ORRY_TREASURY=${treasury.address}`,
    `NEXT_PUBLIC_ORRY_FEATURES=${process.env.WALK_FEATURES ?? "earn,stake,claim,burn,leaderboard,checkout"}`,
    "",
  ].join("\n"),
);
console.log(JSON.stringify(addresses, null, 2));
