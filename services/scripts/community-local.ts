/**
 * Lane L1: deploys the Community contracts on a local anvil with stand-ins (an ORRY-shaped token, a fixed-rate ORRY
 * price, a settable earning stake) and seeds a lived-in state for the API, the web and the walk: names, rooms, posts,
 * a tip, a hidden message, boosts, a pass, a template sale, referral links, cashback and referral accruals with an
 * opened month, Reward Pool events and achievements. Nothing here touches 4663 or 46630.
 *
 * Run (anvil must be running, best started about 45 days in the past: anvil --accounts 12 --timestamp <now - 45 days>):
 *   tsx scripts/community-local.ts --rpc http://127.0.0.1:18600 [--env out.env]
 * Prints the env lines the API and the community indexer need.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getContractAddress,
  http,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../../contracts/out");
const MNEMONIC = "test test test test test test test test test test test junk";
const ORRY = 10n ** 18n;
const USD = 10n ** 6n;

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8"));
  return { abi: a.abi as Abi, bytecode: a.bytecode.object as Hex };
}

export interface CommunityDeployment {
  orry: Address;
  price: Address;
  staking: Address;
  pool: Address;
  achievements: Address;
  chat: Address;
  names: Address;
  boost: Address;
  passes: Address;
  templates: Address;
  referrals: Address;
  cashback: Address;
  stakeVerifier: Address;
  startBlock: bigint;
}

const account = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });

export function clients(rpc: string) {
  const pub = createPublicClient({ chain: foundry, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
  const wallet = (i: number) => createWalletClient({ chain: foundry, transport: http(rpc), account: account(i), pollingInterval: 50 });
  return { pub, wallet };
}

export async function deployCommunity(rpc: string): Promise<CommunityDeployment> {
  const { pub, wallet } = clients(rpc);
  const admin = wallet(0);
  const startBlock = await pub.getBlockNumber();
  const deploy = async (file: string, name: string, args: unknown[] = []) => {
    const a = artifact(file, name);
    const hash = await admin.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error(`${name} did not deploy`);
    return r.contractAddress;
  };
  const write = async (address: Address, abi: Abi, functionName: string, args: unknown[], i = 0) => {
    const hash = await wallet(i).writeContract({ address, abi, functionName, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
  };
  const orry = await deploy("StakeMocks.sol", "MockOrry", [admin.account.address, 1_000_000_000n * ORRY]);
  const price = await deploy("CommunityMocks.sol", "MockOrryPrice");
  await write(price, artifact("CommunityMocks.sol", "MockOrryPrice").abi, "set", [2000n * 10n ** 12n]); // 2,000 ORRY per USD
  const staking = await deploy("MarketMocks.sol", "MockEarningStaking");
  const nonce = await pub.getTransactionCount({ address: admin.account.address });
  const achAt = getContractAddress({ from: admin.account.address, nonce: BigInt(nonce + 1) });
  const pool = await deploy("RewardPool.sol", "RewardPool", [orry, achAt, admin.account.address, 2500, 48n * 3600n]);
  const achievements = await deploy("OrryAchievements.sol", "OrryAchievements", [pool]);
  if (achievements.toLowerCase() !== achAt.toLowerCase()) throw new Error("achievements address prediction");
  const chat = await deploy("OrryChat.sol", "OrryChat", [orry, price, pool, staking, 10_000n, 1000n, 500, 10_000n * ORRY, 5]);
  const names = await deploy("OrryNames.sol", "OrryNames", [orry, price, pool, USD]);
  const boost = await deploy("OrryBoost.sol", "OrryBoost", [orry, price, USD / 2n, 5n * USD, 2n * USD]);
  const passes = await deploy("OrryPasses.sol", "OrryPasses", [orry, price, USD, 5n * USD]);
  const templates = await deploy("TemplateMarket.sol", "TemplateMarket", [orry, price, 2000, USD, 1000n * USD]);
  const referrals = await deploy("ReferralRegistry.sol", "ReferralRegistry");
  const cashback = await deploy("CashbackRewards.sol", "CashbackRewards", [
    orry,
    price,
    referrals,
    admin.account.address,
    { hold: 30n * 86400n, claimWindow: 365n * 86400n, referralWindow: 90n * 86400n, monthlyCapUsd: 1000n * USD, maxShareBps: 5000, maxCashbackBps: 1000 },
  ]);
  await write(cashback, artifact("CashbackRewards.sol", "CashbackRewards").abi, "setPublisher", [account(7).address]);
  const stakeVerifier = await deploy("StakeUsdVerifier.sol", "StakeUsdVerifier", [staking, price, 100n * USD]);
  return { orry, price, staking, pool, achievements, chat, names, boost, passes, templates, referrals, cashback, stakeVerifier, startBlock };
}

async function warp(pub: PublicClient, seconds: number) {
  await (pub as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method: "evm_increaseTime", params: [seconds] });
  await (pub as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method: "evm_mine", params: [] });
}

async function now(pub: PublicClient): Promise<bigint> {
  return (await pub.getBlock()).timestamp;
}

/** The lived-in state. Accounts: 0 admin (treasury wallet), 1 to 4 members, 5, 6, 8, 9, 10 reporters, 7 publisher. */
export async function seedCommunity(rpc: string, d: CommunityDeployment): Promise<void> {
  const { pub, wallet } = clients(rpc);
  const A = (name: string) => artifact(`${name}.sol`, name).abi;
  const ERC = artifact("StakeMocks.sol", "MockOrry").abi;
  const STK = artifact("MarketMocks.sol", "MockEarningStaking").abi;
  const write = async (i: number, address: Address, abi: Abi, functionName: string, args: unknown[], value?: bigint) => {
    const hash = await wallet(i).writeContract({ address, abi, functionName, args, value });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} by ${i} reverted`);
  };
  const MAX = 2n ** 256n - 1n;
  const members = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  for (const i of members) {
    await write(0, d.orry, ERC, "transfer", [account(i).address, 50_000_000n * ORRY]);
    for (const spender of [d.pool, d.chat, d.names, d.boost, d.passes, d.templates]) await write(i, d.orry, ERC, "approve", [spender, MAX]);
  }
  for (const spender of [d.pool]) await write(0, d.orry, ERC, "approve", [spender, MAX]);
  // earning stakes (stand-in): members 1 and 2 above the staker room, 5 to 10 above the report gate
  await write(0, d.staking, STK, "set", [account(1).address, 2_000_000n * ORRY]);
  await write(0, d.staking, STK, "set", [account(2).address, 400_000n * ORRY]);
  for (const i of [5, 6, 8, 9, 10]) await write(0, d.staking, STK, "set", [account(i).address, 20_000n * ORRY]);

  // referral links and accruals first: the month must end and pass its 30 day hold before it opens
  await write(2, d.referrals, A("ReferralRegistry"), "link", [account(1).address]);
  await write(3, d.referrals, A("ReferralRegistry"), "link", [account(1).address]);
  const t0 = await now(pub);
  const recs = [
    { account: account(2).address, kind: 1, referee: "0x0000000000000000000000000000000000000000", feePaidAt: t0, feeUsd: 20n * USD, rewardUsd: 400_000n, ref: keccak256(toHex("seed:fee:1")) },
    { account: account(1).address, kind: 2, referee: account(2).address, feePaidAt: t0, feeUsd: 20n * USD, rewardUsd: 4n * USD, ref: keccak256(toHex("seed:fee:1")) },
    { account: account(1).address, kind: 2, referee: account(3).address, feePaidAt: t0, feeUsd: 50n * USD, rewardUsd: 10n * USD, ref: keccak256(toHex("seed:fee:2")) },
  ];
  await write(7, d.cashback, A("CashbackRewards"), "accrue", [recs]);
  // the buyback's cashback share arrives as a plain transfer
  await write(0, d.orry, ERC, "transfer", [d.cashback, 100_000n * ORRY]);
  const month = (await pub.readContract({ address: d.cashback, abi: A("CashbackRewards"), functionName: "currentMonth" })) as bigint;
  const openAt = (await pub.readContract({ address: d.cashback, abi: A("CashbackRewards"), functionName: "openableAt", args: [month] })) as bigint;
  await warp(pub, Number(openAt - (await now(pub))) + 60);
  await write(9, d.cashback, A("CashbackRewards"), "openPeriod", [month]);
  // a chain started in the past (anvil --timestamp) catches up with the wall clock here, so the site's countdowns read true
  const wall = BigInt(Math.floor(Date.now() / 1000));
  const behind = wall - (await now(pub));
  if (behind > 120n) await warp(pub, Number(behind));
  // a new month: one more cashback record waiting for its hold
  await write(7, d.cashback, A("CashbackRewards"), "accrue", [[{ ...recs[0]!, feePaidAt: await now(pub), ref: keccak256(toHex("seed:fee:3")) }]]);

  // names, rooms, posts, a tip, a hidden message
  await write(1, d.names, A("OrryNames"), "setName", ["ada_l", MAX]);
  await write(2, d.names, A("OrryNames"), "setName", ["basil", MAX]);
  await write(3, d.names, A("OrryNames"), "setName", ["cyra_ops", MAX]);
  await write(0, d.chat, A("OrryChat"), "createRoom", [100n * USD, "stakers"]);
  const post = async (i: number, room: number, replyTo: number, text: string) => write(i, d.chat, A("OrryChat"), "post", [BigInt(room), BigInt(replyTo), text, MAX]);
  await post(1, 0, 0, "Welcome to the Orrery room. Every message here lives on Robinhood Chain.");
  await post(2, 0, 1, "Glad to be here. Which daily cap do you run for a trading agent?");
  await post(1, 0, 2, "50 USDG a day per agent, with the Earn vault as the only target. Template is in the market.");
  await post(3, 0, 0, "Shipped a merchant integration today: 1,000 free checks a month covered our pilot traffic.");
  await post(4, 0, 0, "free orry airdrop click here");
  await post(1, 1, 0, "Stakers room: weekly quest ideas welcome.");
  await write(2, d.chat, A("OrryChat"), "tip", [3n, 500n * ORRY]);
  for (const i of [5, 6, 8, 9, 10]) await write(i, d.chat, A("OrryChat"), "report", [5n]);

  // boosts, a pass, a template sale
  await write(3, d.boost, A("OrryBoost"), "boost", [1, 3n, 1n, MAX]);
  await write(1, d.boost, A("OrryBoost"), "boost", [2, 42n, 3n, MAX]);
  await write(2, d.passes, A("OrryPasses"), "buy", [account(2).address, 2, 1n, MAX]);
  await write(1, d.templates, A("TemplateMarket"), "list", [5n * USD, keccak256(toHex('{"dailyCapUsdg":50,"targets":["earn"]}')), "ipfs://bafy-daily-cap-50"]);
  await write(3, d.templates, A("TemplateMarket"), "list", [12n * USD, keccak256(toHex('{"perTxUsdg":10,"merchants":"verified"}')), "ipfs://bafy-merchant-only"]);
  await write(2, d.templates, A("TemplateMarket"), "buy", [1n, MAX]);
  await write(1, d.boost, A("OrryBoost"), "boost", [3, 2n, 2n, MAX]);

  // Reward Pool: funding, two events, achievements
  await write(0, d.pool, A("RewardPool"), "fund", [d.orry, 5_000_000n * ORRY]);
  const deadline = (await now(pub)) + 7n * 86400n;
  await write(0, d.pool, A("RewardPool"), "createEvent", [d.orry, 1_000_000n * ORRY, deadline, 1, keccak256(toHex("most active 7 days by protocol fees"))]);
  await write(0, d.pool, A("RewardPool"), "createEvent", [d.orry, 200_000n * ORRY, deadline, 2, keccak256(toHex("bug bounty: policy module"))]);
  await write(0, d.pool, A("RewardPool"), "publishWinners", [2n, [account(3).address], [150_000n * ORRY]]);
  await write(0, d.achievements, A("OrryAchievements"), "create", [d.orry, 1_000n * ORRY, 500, deadline, 3, d.stakeVerifier, keccak256(toHex("stake 100 USD"))]);
  await write(0, d.achievements, A("OrryAchievements"), "create", [d.orry, 500n * ORRY, 50, deadline, 9, "0x0000000000000000000000000000000000000000", keccak256(toHex("weekly quest: first paid check"))]);
  await write(1, d.achievements, A("OrryAchievements"), "claim", [1n, "0x"]);
  await write(2, d.achievements, A("OrryAchievements"), "claim", [1n, "0x"]);
  const t = await now(pub);
  await write(0, d.achievements, A("OrryAchievements"), "publishCompleters", [2n, [account(2).address, account(3).address], [t - 3600n, t - 60n]]);
}

export function envLines(d: CommunityDeployment): string {
  return [
    `ORRERY_COMMUNITY_POOL=${d.pool}`,
    `ORRERY_COMMUNITY_ACHIEVEMENTS=${d.achievements}`,
    `ORRERY_COMMUNITY_CHAT=${d.chat}`,
    `ORRERY_COMMUNITY_NAMES=${d.names}`,
    `ORRERY_COMMUNITY_BOOST=${d.boost}`,
    `ORRERY_COMMUNITY_PASSES=${d.passes}`,
    `ORRERY_COMMUNITY_TEMPLATES=${d.templates}`,
    `ORRERY_COMMUNITY_REFERRALS=${d.referrals}`,
    `ORRERY_COMMUNITY_CASHBACK=${d.cashback}`,
    `ORRERY_COMMUNITY_ORRY=${d.orry}`,
    `ORRERY_COMMUNITY_STAKING=${d.staking}`,
    `ORRERY_ORRY_PRICE_ORACLE=${d.price}`,
    `ORRERY_COMMUNITY_START_BLOCK=${d.startBlock}`,
  ].join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("community-local.ts")) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const rpc = arg("--rpc") ?? "http://127.0.0.1:18600";
  const d = await deployCommunity(rpc);
  await seedCommunity(rpc, d);
  const lines = envLines(d);
  const file = arg("--env");
  if (file) writeFileSync(file, lines + "\n");
  console.log(lines);
}

