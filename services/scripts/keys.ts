/**
 * Creates Orrery keys in ~/.secrets/orrery/<network>-<role>.json (folder 700, files 600), skips any that already exist,
 * copies them to the Private Keys backup folder, appends the indexes, and prints addresses only.
 *
 *   tsx scripts/keys.ts                    46630 rehearsal set
 *   tsx scripts/keys.ts --network mainnet  4663 set (deployer is also attestor owner and treasury, owner decision 2026-11-08)
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const network = process.argv.includes("--network") ? process.argv[process.argv.indexOf("--network") + 1]! : "46630";
const SETS: Record<string, { chainId: number; roles: [string, string][] }> = {};
SETS["mainnet"] = {
  chainId: 4663,
  roles: [
    ["deployer", "Orrery mainnet deployer, attestor owner and treasury on Robinhood Chain 4663"],
    ["relayer", "Orrery x402 facilitator relayer (pays settlement gas) on 4663, hot key on the API server"],
    ["attester", "Orrery prober attester key on 4663, hot key on the API server"],
    ["check-signer", "Orrery signed-check key on 4663, hot key on the API server"],
    ["quote-signer", "Orrery ORRY quote signer (treasury setQuoteSigner) on 4663, hot key on the API server"],
    ["keeper", "Orrery ORRY keeper gas key (collect, distribute, buyback slices) on 4663, hot key on the keeper"],
    ["market-keeper", "Orrery markets keeper gas key (clears sealed batches) on 4663, hot key on the market keeper"],
    ["reveal-relay", "Orrery markets reveal relay gas key (revealFor) on 4663, hot key on the market relay"],
    ["buyer", "Orrery mainnet test buyer: buys credit packs over x402 to prove the live purchase path on 4663 (USDG from the owner)"],
    ["walk", "Orrery mainnet operator walk wallet: creates a Safe, registers an agent, pays a verification and buys a pack on 4663 (operator-live-4663.mjs)"],
  ],
};
const REHEARSAL: [string, string][] = [
  ["deployer", "Orrery deployer, attestor owner and treasury for the 46630 rehearsal"],
  ["relayer", "Orrery x402 facilitator relayer (pays settlement gas) on 46630"],
  ["attester", "Orrery prober attester key on 46630"],
  ["check-signer", "Orrery signed-check key on 46630"],
  ["operator", "Orrery rehearsal operator, owner of the development account on 46630"],
  ["agent-signer", "Orrery rehearsal agent signer (float wallet) on 46630"],
  ["merchant", "Orrery rehearsal merchant (buys credits, runs checks) on 46630"],
  ["walk", "Orrery first-visit walk wallet (fresh) on 46630"],
  ["quote-signer", "Orrery ORRY quote signer (treasury setQuoteSigner) on 46630"],
  ["keeper", "Orrery ORRY keeper gas key (collect, distribute, buyback slices) on 46630; also owns the 46630 dev price feeds"],
  ["market-keeper", "Orrery markets keeper gas key (clears sealed batches) on 46630"],
  ["reveal-relay", "Orrery markets reveal relay gas key (revealFor) on 46630"],
];
SETS["46630"] = { chainId: 46630, roles: REHEARSAL };
const set = SETS[network];
if (!set) throw new Error(`unknown network ${network}; use one of ${Object.keys(SETS).join(", ")}`);
const dir = join(homedir(), ".secrets", "orrery");
const backup = "/mnt/shared/Home/Desktop/Private Keys/.secrets/orrery";
const today = new Date().toISOString().slice(0, 10);

mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
mkdirSync(backup, { recursive: true, mode: 0o700 });

const out: Record<string, string> = {};
for (const [role, desc] of set.roles) {
  const file = `${network}-${role}.json`;
  const path = join(dir, file);
  let address: string;
  if (existsSync(path)) {
    address = (JSON.parse(readFileSync(path, "utf8")) as { address: string }).address;
  } else {
    const privateKey = generatePrivateKey();
    address = privateKeyToAccount(privateKey).address;
    writeFileSync(path, JSON.stringify({ address, privateKey, chainId: set.chainId, role, created: today }, null, 2) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
    const b = join(backup, file);
    copyFileSync(path, b);
    chmodSync(b, 0o600);
    if (readFileSync(b, "utf8") !== readFileSync(path, "utf8")) throw new Error(`backup mismatch for ${file}`);
    appendFileSync(join(backup, "INDEX.txt"), `${file} | ${address} | ${desc} | ${today}\n`);
    appendFileSync("/mnt/shared/Home/Desktop/Private Keys/INDEX.txt", `.secrets\\orrery\\${file}   ${desc}, ${address} | ${today}\n`);
  }
  out[role] = address;
}
console.log(JSON.stringify(out, null, 2));
