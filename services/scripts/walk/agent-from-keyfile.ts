/**
 * The agent's side of the operator walk, from the saved key file alone: reads its session, tops its float up through
 * the module, and shows that a top-up above the float ceiling is refused (a client-side refusal, nothing is sent).
 * Prints one JSON line.
 *
 *   tsx scripts/walk/agent-from-keyfile.ts <agent.env> <usdg>                       local fork, tops up to 1 USDG
 *   tsx scripts/walk/agent-from-keyfile.ts <agent.env> <usdg> --live --amount 500000 --over 30000000
 *
 * Without --live the key file's RPC must be local. --live is passed only by operator-live-4663.mjs, after the owner's CONFIRM.
 */
import { readFileSync } from "node:fs";
import { erc20Abi, type Address } from "viem";
import { agentFromEnv } from "@orrery/sdk";

const [file, usdg] = process.argv.slice(2) as [string, Address];
const flag = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const LIVE = process.argv.includes("--live");
const AMOUNT = BigInt(flag("--amount") ?? "1000000");
const OVER = BigInt(flag("--over") ?? "30000000");
// --rpc replaces the key file's RPC with a local fork (a rehearsal of the live walk); it is never a way onto mainnet.
const RPC = flag("--rpc");
if (RPC && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(RPC)) throw new Error("--rpc takes a local fork only");
const env = Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("=") as [string, string]));
if (!LIVE && !RPC && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(env.ORRERY_RPC_URL ?? "")) throw new Error("local fork only (pass --live for mainnet)");
const agent = agentFromEnv(RPC ? { ...env, ORRERY_RPC_URL: RPC } : env);
const session = await agent.session();
const topUp = await agent.ensureFloat(usdg, AMOUNT);
const float = await agent.publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [agent.signer] });
let aboveCeiling = "went through";
try {
  await agent.ensureFloat(usdg, OVER);
} catch (e) {
  aboveCeiling = String((e as Error).message).split("\n")[0]!.slice(0, 100);
}
console.log(JSON.stringify({ signer: agent.signer, account: session.account, agentId: session.agentId.toString(), topUp, float: float.toString(), aboveCeiling }));
