// Lane L4 local stack for a walk: deploys the attester and Credit contracts with their stand-ins on a local anvil,
// seeds them (scripts/credit-stack.ts), funds the walk wallets with stand-in USDG and ORRY, and writes the addresses.
// Usage: npx tsx scripts/credit-local.ts <rpc> <out.json>
import { writeFileSync } from "node:fs";
import type { Abi } from "viem";
import * as g from "./credit-generated.js";
import { CREDIT_ROLE, creditClients, creditSend, deployCreditStack, seedCreditStack } from "./credit-stack.js";

const [rpc = "http://127.0.0.1:18661", out = "credit-stack.json"] = process.argv.slice(2);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(rpc)) throw new Error("the L4 local stack runs on a local anvil only");
const s = await deployCreditStack(rpc);
const ids = await seedCreditStack(rpc, s);
const c = creditClients(rpc);
for (const role of [CREDIT_ROLE.lender, CREDIT_ROLE.operator]) {
  await creditSend(rpc, CREDIT_ROLE.ops, s.usdg, g.CreditUsdg.abi as Abi, "mint", [c.address(role), 5_000n * 10n ** 6n]);
  await creditSend(rpc, CREDIT_ROLE.ops, s.orry, g.CreditOrry.abi as Abi, "mint", [c.address(role), 1_500_000n * 10n ** 18n]);
}
writeFileSync(out, JSON.stringify({ ...s, startBlock: s.startBlock.toString(), agent: ids.agent.toString(), agent2: ids.agent2.toString(), accounts: Object.fromEntries(Object.entries(CREDIT_ROLE).map(([k, i]) => [k, c.address(i)])) }, null, 2));
console.log(`L4 stack on ${rpc}: pool ${s.pool}, registry ${s.registry}, agent ${ids.agent}`);
