/**
 * Moves the deployer's ETH from Ethereum mainnet to Robinhood Chain 4663 through the chain's own bridge, for the owner
 * to run and confirm. The deposit lands at the same address on 4663 (an EOA is not aliased), usually within 10 to 15
 * minutes of the Ethereum transaction.
 *
 *   tsx scripts/bridge-eth-4663.ts --dry-run            checks the bridge, prints the plan and the cost, sends nothing
 *   tsx scripts/bridge-eth-4663.ts                      prints the same, waits for a typed CONFIRM, sends, then waits
 *                                                       for the ETH on 4663
 *   [--amount 0.0095]  ETH to bridge (default: the whole balance less three times the Ethereum gas cost)
 *   [--rpc <url>]      Ethereum RPC (default https://ethereum-rpc.publicnode.com)
 *
 * Bridge: Robinhood Chain's Delayed Inbox on Ethereum, Inbox.depositEth() (docs.robinhood.com/chain/cross-chain-messaging).
 * Before anything is sent the script checks inbox.bridge() == BRIDGE, bridge.allowedDelayedInboxes(inbox),
 * bridge.rollup().chainId() == 4663 and inbox.paused() == false. Key: ~/.secrets/orrery/mainnet-deployer.json, never printed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const INBOX = "0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D" as const;
const BRIDGE = "0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3" as const;
const L2_RPC = "https://rpc-robinhood.blockmachine.io";
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const DRY = process.argv.includes("--dry-run");
const RPC = arg("--rpc") ?? "https://ethereum-rpc.publicnode.com";
const fail = (s: string): never => {
  console.error(`stopped: ${s}. Nothing was sent.`);
  process.exit(1);
};

const abi = parseAbi([
  "function depositEth() payable returns (uint256)",
  "function bridge() view returns (address)",
  "function paused() view returns (bool)",
  "function allowedDelayedInboxes(address) view returns (bool)",
  "function rollup() view returns (address)",
  "function chainId() view returns (uint256)",
]);

const key = (JSON.parse(readFileSync(join(homedir(), ".secrets/orrery/mainnet-deployer.json"), "utf8")) as { privateKey: Hex }).privateKey;
const account = privateKeyToAccount(key);
const l1 = createPublicClient({ chain: mainnet, transport: http(RPC) });
const l2 = createPublicClient({ transport: http(L2_RPC) });

if ((await l1.getChainId()) !== 1) fail("the RPC is not Ethereum mainnet");
if ((await l1.readContract({ address: INBOX, abi, functionName: "bridge" })).toLowerCase() !== BRIDGE.toLowerCase()) fail("the inbox points at another bridge");
if (!(await l1.readContract({ address: BRIDGE, abi, functionName: "allowedDelayedInboxes", args: [INBOX] }))) fail("the bridge does not accept this inbox");
const rollup = await l1.readContract({ address: BRIDGE, abi, functionName: "rollup" });
if ((await l1.readContract({ address: rollup, abi, functionName: "chainId" })) !== 4663n) fail("the bridge does not belong to chain 4663");
if (await l1.readContract({ address: INBOX, abi, functionName: "paused" })) fail("the inbox is paused");

const balance = await l1.getBalance({ address: account.address });
const fees = await l1.estimateFeesPerGas();
const gas = await l1.estimateContractGas({ address: INBOX, abi, functionName: "depositEth", account, value: 1n });
const cost = gas * fees.maxFeePerGas;
const amount = arg("--amount") ? parseEther(arg("--amount")!) : balance - cost * 3n;
if (amount <= 0n) fail(`the deployer holds ${formatEther(balance)} ETH on Ethereum, too little to cover the gas`);
if (amount + cost > balance) fail(`${formatEther(amount)} ETH plus gas is more than the ${formatEther(balance)} ETH the deployer holds`);
const l2Before = await l2.getBalance({ address: account.address });

console.log(`Bridge ETH from Ethereum to Robinhood Chain 4663
  from / to       ${account.address} (deployer, same address on both chains)
  on Ethereum     ${formatEther(balance)} ETH
  on 4663 now     ${formatEther(l2Before)} ETH
  amount          ${formatEther(amount)} ETH
  Ethereum gas    ~${gas} gas, at most ${formatEther(cost)} ETH (left on Ethereum: ~${formatEther(balance - amount - cost)} ETH or more)
  route           Inbox.depositEth() ${INBOX} -> bridge ${BRIDGE} -> rollup ${rollup} (chain 4663, checked)
  arrival         usually 10 to 15 minutes after the Ethereum transaction confirms
  reversible      no: a deposit cannot be cancelled once sent; the ETH arrives on 4663 at the same address`);
if (DRY) {
  console.log("Dry run: nothing was sent.");
  process.exit(0);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question("Type CONFIRM to send: ");
rl.close();
if (answer.trim() !== "CONFIRM") {
  console.log("Not confirmed. Nothing was sent.");
  process.exit(1);
}

const wallet = createWalletClient({ account, chain: mainnet, transport: http(RPC) });
const hash = await wallet.writeContract({ address: INBOX, abi, functionName: "depositEth", value: amount });
console.log(`sent ${hash} (https://etherscan.io/tx/${hash})`);
const receipt = await l1.waitForTransactionReceipt({ hash, timeout: 600_000 });
if (receipt.status !== "success") fail(`the Ethereum transaction reverted (${hash})`);
console.log(`confirmed on Ethereum in block ${receipt.blockNumber}; waiting for the ETH on 4663 (checks every 30 s, up to 40 min)`);
for (let i = 0; i < 80; i++) {
  const now = await l2.getBalance({ address: account.address }).catch(() => l2Before);
  if (now > l2Before) {
    console.log(`arrived: ${formatEther(now)} ETH on 4663 at ${account.address}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
console.log(`not on 4663 yet after 40 minutes; the deposit is in the bridge (${hash}) and arrives on its own. Check again later.`);
