/**
 * Lane L5 deploy plan for Robinhood Chain 4663, dry run only: reads the chain, never signs or sends. It prints the two
 * transactions the deploy will make (the spoke hook through the CREATE2 factory at a mined salt, then AgentLaunch from
 * the deployer at its next nonce) with the predicted addresses, after checking every input has code. The deploy itself is
 * the orchestrator's go-live step (`deployLaunchPair` in scripts/launch-stack.ts does the same two steps on any chain).
 *
 *   pnpm tsx scripts/launch-plan-4663.ts --rpc https://rpc-robinhood.blockmachine.io
 *
 * Add --staking, --vault and --price once those contracts exist; until then they are listed as not deployed yet.
 *
 * Inputs that do not exist on 4663 yet (the ORRY launch set and the R1 price oracle) are arguments; the rest are the live
 * v1 and Uniswap addresses from deployments/4663.json and docs/ORRY-BUILD-SPEC.md.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, getAddress, getContractAddress, http, isAddress, type Address } from "viem";
import { CREATE2_FACTORY, LAUNCH_DEFAULTS, mineSpokeHookSalt, spokeHookInitCode } from "./launch-stack.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const addr = (n: string, v?: string): Address => {
  if (!v || !isAddress(v)) throw new Error(`${n} must be a 0x address`);
  return getAddress(v);
};

const v1 = JSON.parse(readFileSync(new URL("../../deployments/4663.json", import.meta.url), "utf8")) as Record<string, string>;
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address;
const ORRY = "0x85272EA3aE8685C768045dba5455fE305C706aA4" as Address;
const rpc = arg("--rpc") ?? "https://rpc-robinhood.blockmachine.io";
const deployer = addr("deployer", arg("--deployer") ?? v1.deployer);
const inputs = {
  poolManager: POOL_MANAGER,
  orry: ORRY,
  registry: addr("registry", v1.registry),
  attestor: addr("attestor", v1.attestor),
  module: addr("module", v1.module),
  treasury: addr("treasury", v1.treasury),
};
const later = { staking: arg("--staking"), vault: arg("--vault"), price: arg("--price") };
const notDeployedYet = Object.entries(later).filter(([, v]) => !v).map(([k]) => k);
for (const [k, v] of Object.entries(later)) if (v) (inputs as Record<string, Address>)[k] = addr(`--${k}`, v);

const pub = createPublicClient({ transport: http(rpc) });
const chainId = await pub.getChainId();
if (chainId !== 4663) throw new Error(`expected chain 4663, got ${chainId}`);
const missing: string[] = [];
for (const [name, a] of Object.entries({ ...inputs, create2Factory: CREATE2_FACTORY })) {
  if (!(await pub.getCode({ address: a }))) missing.push(`${name} ${a}`);
}
const nonce = await pub.getTransactionCount({ address: deployer });
const launchAt = getContractAddress({ from: deployer, nonce: BigInt(nonce + 1) });
const init = spokeHookInitCode({ poolManager: POOL_MANAGER, orry: ORRY, launch: launchAt, ...LAUNCH_DEFAULTS.hook });
const mined = mineSpokeHookSalt(init);
const hookTaken = Boolean(await pub.getCode({ address: mined.address }));
const routerAt = getContractAddress({ from: deployer, nonce: BigInt(nonce + 2) });

console.log(JSON.stringify(
  {
    chainId,
    deployer,
    deployerNonce: nonce,
    steps: [
      { tx: 1, to: CREATE2_FACTORY, what: "SpokeHook via CREATE2", salt: mined.salt, address: mined.address, codeAlreadyThere: hookTaken },
      { tx: 2, what: "AgentLaunch (CREATE)", address: launchAt, params: { ...LAUNCH_DEFAULTS.params, minStakeUsd: LAUNCH_DEFAULTS.params.minStakeUsd.toString(), earlyFullUsd: LAUNCH_DEFAULTS.params.earlyFullUsd.toString(), earlyMinUsd: LAUNCH_DEFAULTS.params.earlyMinUsd.toString() } },
      { tx: 3, what: "SpokeRouter (CREATE)", address: routerAt },
    ],
    inputs,
    missingCode: missing,
    notDeployedYet,
    note: "dry run: nothing was signed or sent",
  },
  null,
  2,
));
