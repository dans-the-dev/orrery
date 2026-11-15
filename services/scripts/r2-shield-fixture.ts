/**
 * Lane L3: real UltraHonk proofs for the OrreryShield Foundry tests (`contracts/test/r2/shield/`), built with the ported
 * client (`packages/web/lib/r2/shield`) and the copied `transact` circuit. Adapted from Hushwave
 * `packages/sdk/scripts/make-fixture.ts` (MIT). Two sets: chain 31337 (unit tests, a USDG stand-in etched at the real
 * USDG address) and chain 4663 (fork tests, real USDG). The pool sits at a fixed address in both, since the EIP-712
 * domain the proofs carry names it. Writes Solidity constants, so the tests read no files.
 *
 *   pnpm tsx scripts/r2-shield-fixture.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompiledCircuit } from "@noir-lang/noir_js";
import { encodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ShieldedWallet,
  accountKeyTypedData,
  commitmentOf,
  deriveAccountKeys,
  encryptNote,
  exitWithdrawal,
  ownerHash,
  prepareTransact,
  publicInputsOf,
  randomField,
  secretCommit,
  type Kind,
  type PoolEvent,
} from "../packages/web/lib/r2/shield/index.js";
import { TransactProver } from "../packages/web/lib/r2/shield/prover.js";

const here = dirname(fileURLToPath(import.meta.url));
export const POOL = getAddress("0x5348494553440000000000000000000000000000"); // "SHIESD"
export const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"); // real USDG on 4663
const RELAYER = getAddress("0x00000000000000000000000000000000000be1a7");
const BPS = 10_000n;
const DEPOSIT_FEE_BPS = 50n;
const WITHDRAW_FEE_BPS = 50;
const U = 10n ** 6n;

// anvil's development keys: test accounts only
const alice = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const bob = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const carol = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

const TX_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "proof", type: "bytes" },
      { name: "root", type: "uint256" },
      { name: "nullifiers", type: "uint256[2]" },
      { name: "outCommitments", type: "uint256[2]" },
      { name: "asset", type: "address" },
      { name: "kind", type: "uint8" },
      { name: "withdrawAmount", type: "uint256" },
      { name: "withdrawTo", type: "address" },
      { name: "fee", type: "uint256" },
      { name: "protocolFee", type: "uint256" },
      { name: "intentNullifier", type: "uint256" },
    ],
  },
  {
    type: "tuple",
    components: [
      { name: "relayer", type: "address" },
      { name: "encryptedOutput0", type: "bytes" },
      { name: "encryptedOutput1", type: "bytes" },
    ],
  },
] as const;

async function fixtureFor(chainId: number, prover: TransactProver): Promise<Record<string, string>> {
  const aliceKeys = deriveAccountKeys(await alice.signTypedData(accountKeyTypedData(chainId)));
  const bobKeys = deriveAccountKeys(await bob.signTypedData(accountKeyTypedData(chainId)));
  const aliceWallet = new ShieldedWallet(alice.address, aliceKeys);
  const bobWallet = new ShieldedWallet(bob.address, bobKeys);
  const emit = (e: PoolEvent[]) => {
    aliceWallet.apply(e);
    bobWallet.apply(e);
  };

  // Alice deposits 1,000 USDG; the 0.5% deposit fee leaves a 995 USDG note (no staker discount here)
  const depositAmount = 1_000n * U;
  const depositFee = (depositAmount * DEPOSIT_FEE_BPS) / BPS;
  const note = { asset: BigInt(USDG), amount: depositAmount - depositFee, blinding: randomField(), ownerHash: ownerHash(alice.address, aliceKeys.npk) };
  const sc = secretCommit(note);
  const encryptedNote = encryptNote(aliceKeys.viewKey, note);
  emit([{ type: "Deposited", depositor: alice.address, amount: depositAmount, fee: depositFee, secretCommit: sc, commitment: commitmentOf(note), leafIndex: 0, encryptedNote }]);

  async function run(
    who: typeof alice,
    wallet: ShieldedWallet,
    kind: Kind,
    amount: bigint,
    to: Address,
    recipient?: { npk: bigint; viewKey: Hex },
    opts: { exit?: boolean; emit?: boolean } = {},
  ) {
    const fee = 1n * U; // relayer fee
    const exit = opts.exit ? exitWithdrawal(wallet.balance(), fee, WITHDRAW_FEE_BPS) : { amount, protocolFee: undefined };
    const prepared = prepareTransact({
      chainId,
      pool: POOL,
      owner: who.address,
      keys: wallet.keys,
      kind,
      asset: USDG,
      amount: exit.amount,
      protocolFee: exit.protocolFee,
      protocolFeeFloor: kind === "withdraw" ? (exit.amount * BigInt(WITHDRAW_FEE_BPS)) / BPS : undefined,
      omitEmptyOutputs: opts.exit,
      to,
      recipient,
      fee,
      notes: wallet.notes(),
      tree: wallet.tree,
      relayer: RELAYER,
    });
    const signature = await who.signTypedData(prepared.typedData);
    const { proof, publicInputs, millis } = await prover.prove(await prepared.witness(signature));
    const expected = publicInputsOf(prepared.args, prepared.ext, chainId, POOL);
    if (publicInputs.length !== expected.length || publicInputs.some((v, i) => v !== expected[i])) {
      throw new Error("public inputs differ from the contract's view");
    }
    console.log(`chain ${chainId} ${kind} ${exit.amount}: proved in ${millis} ms, proof ${(proof.length - 2) / 2} bytes`);
    if (opts.emit !== false) {
      let next = wallet.tree.size;
      const outs: PoolEvent[] = [];
      prepared.args.outCommitments.forEach((commitment, i) => {
        if (commitment === 0n) return;
        outs.push({ type: "NewCommitment", commitment, leafIndex: next++, encryptedNote: i === 0 ? prepared.ext.encryptedOutput0 : prepared.ext.encryptedOutput1 });
      });
      emit([{ type: "NewNullifier", nullifier: prepared.args.nullifiers[0] }, { type: "NewNullifier", nullifier: prepared.args.nullifiers[1] }, ...outs]);
    }
    return encodeAbiParameters(TX_TUPLE, [{ ...prepared.args, proof }, prepared.ext]);
  }

  // Alice sends 300 USDG to Bob and withdraws 500 USDG to Carol; Bob withdraws 200 USDG to himself, or (bobExit) takes
  // his whole balance out with both outputs omitted
  const send = await run(alice, aliceWallet, "send", 300n * U, bob.address, { npk: bobKeys.npk, viewKey: bobKeys.viewKey });
  const withdraw = await run(alice, aliceWallet, "withdraw", 500n * U, carol.address);
  const bobExit = await run(bob, bobWallet, "withdraw", 0n, bob.address, undefined, { exit: true, emit: false });
  const bobWithdraw = await run(bob, bobWallet, "withdraw", 200n * U, bob.address);
  return {
    aliceNpk: `0x${aliceKeys.npk.toString(16)}`,
    aliceViewKey: aliceKeys.viewKey,
    bobNpk: `0x${bobKeys.npk.toString(16)}`,
    bobViewKey: bobKeys.viewKey,
    depositSecretCommit: `0x${sc.toString(16)}`,
    depositNote: encryptedNote,
    send,
    withdraw,
    bobWithdraw,
    bobExit,
    aliceBalanceAfter: aliceWallet.balance().toString(),
    bobBalanceAfter: bobWallet.balance().toString(),
  };
}

function solidity(chainId: number, f: Record<string, string>): string {
  const b = (h: string) => `hex"${h.slice(2)}"`;
  return `
/// @notice Chain ${chainId}: real proofs for the pool at POOL with asset USDG.
library ShieldFixture${chainId} {
    uint256 internal constant ALICE_NPK = ${f.aliceNpk};
    uint256 internal constant BOB_NPK = ${f.bobNpk};
    uint256 internal constant DEPOSIT_SECRET_COMMIT = ${f.depositSecretCommit};
    uint256 internal constant ALICE_BALANCE_AFTER = ${f.aliceBalanceAfter};
    uint256 internal constant BOB_BALANCE_AFTER = ${f.bobBalanceAfter};

    function aliceViewKey() internal pure returns (bytes memory) {
        return ${b(f.aliceViewKey!)};
    }

    function bobViewKey() internal pure returns (bytes memory) {
        return ${b(f.bobViewKey!)};
    }

    function depositNote() internal pure returns (bytes memory) {
        return ${b(f.depositNote!)};
    }

    /// @dev abi.encode(TxArgs, ExtData) of each action.
    function send() internal pure returns (bytes memory) {
        return ${b(f.send!)};
    }

    function withdraw() internal pure returns (bytes memory) {
        return ${b(f.withdraw!)};
    }

    function bobWithdraw() internal pure returns (bytes memory) {
        return ${b(f.bobWithdraw!)};
    }

    function bobExit() internal pure returns (bytes memory) {
        return ${b(f.bobExit!)};
    }
}
`;
}

const circuit = JSON.parse(readFileSync(join(here, "../packages/web/lib/r2/shield/transact.json"), "utf8")) as CompiledCircuit;
const prover = await TransactProver.create(circuit);
let out = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Generated by services/scripts/r2-shield-fixture.ts (lane L3). Do not edit. Proofs of the copied Hushwave transact
// circuit (UltraHonk, EVM target) for OrreryShield at a fixed address; anvil development keys only.

library ShieldFixtureAddresses {
    address internal constant POOL = ${POOL};
    address internal constant USDG = ${USDG};
    address internal constant RELAYER = ${RELAYER};
    address internal constant ALICE = ${alice.address};
    address internal constant BOB = ${bob.address};
    address internal constant CAROL = ${carol.address};
    uint256 internal constant DEPOSIT_AMOUNT = 1000000000;
}
`;
for (const chainId of [31337, 4663]) out += solidity(chainId, await fixtureFor(chainId, prover));
await prover.destroy();
const dir = join(here, "../../contracts/test/r2/shield");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "ShieldFixture.sol"), out);
console.log(`wrote ${join(dir, "ShieldFixture.sol")} (${out.length} bytes)`);
