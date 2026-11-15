// A wallet for Playwright walks on the live site, where real funds are at stake. Unlike wallet.mjs (test networks and
// local forks only), every request passes a policy before the key signs anything: the page gets an EIP-6963 wallet whose
// requests are answered in Node, the key never enters the page, and a request the policy does not name is refused and
// recorded. The caller owns the policy; this file holds no addresses or limits of its own.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, fallback, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * policy:
 *   personalSign(hexMessage)      -> true, or a string saying why not
 *   typedData(typed)              -> true, or a string (typed is the parsed EIP-712 payload)
 *   transaction({ to, data, value }) -> true, or a string (value is a bigint)
 *   onReceipt?(tx, receipt)       -> called after each transaction is mined (to learn addresses the next rules need)
 */
export async function attachGuardedWallet(page, { keyFile, rpcs, chainId, name = "Walk wallet", policy }) {
  const { privateKey } = JSON.parse(readFileSync(keyFile, "utf8"));
  const account = privateKeyToAccount(privateKey);
  const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: rpcs } } });
  const transport = fallback(rpcs.map((u) => http(u, { retryCount: 2, timeout: 30_000 })));
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account });
  if ((await pub.getChainId()) !== chainId) throw new Error(`the RPC is not chain ${chainId}`);
  const log = [];
  let nextNonce = 0;
  const refused = [];
  const sent = [];
  const refuse = (what, why) => {
    refused.push(`${what}: ${why}`);
    throw new Error(`refused by the walk policy (${what}: ${why})`);
  };
  await page.exposeFunction("__guardedRpc", async (method, params) => {
    log.push(method);
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [account.address];
      case "eth_chainId":
        return `0x${chainId.toString(16)}`;
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "personal_sign": {
        const ok = policy.personalSign ? policy.personalSign(params[0]) : "no rule for signed messages";
        if (ok !== true) refuse("personal_sign", ok);
        return account.signMessage({ message: { raw: params[0] } });
      }
      case "eth_signTypedData_v4": {
        const typed = JSON.parse(params[1]);
        const ok = policy.typedData ? policy.typedData(typed) : "no rule for typed data";
        if (ok !== true) refuse(`typed data ${typed.primaryType}`, ok);
        const { EIP712Domain: _drop, ...types } = typed.types;
        return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
      }
      case "eth_sendTransaction": {
        const t = params[0];
        const tx = { to: t.to, data: t.data ?? "0x", value: t.value ? BigInt(t.value) : 0n };
        const ok = policy.transaction ? await policy.transaction(tx) : "no rule for transactions";
        if (ok !== true) refuse(`transaction to ${tx.to}`, ok);
        // Signed here once, so the hash is known before anything is broadcast. With two RPCs behind a fallback, the first
        // can accept the transaction and still answer with an error; the second then refuses the same bytes ("nonce too
        // low") although the transaction is on its way. So a send error is settled by looking for the receipt, and the
        // nonce is counted here instead of asked from whichever node answers.
        const chainNonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
        const nonce = Math.max(chainNonce, nextNonce);
        const request = await wallet.prepareTransactionRequest({ to: tx.to, data: tx.data, value: tx.value, nonce, chain, account });
        const signed = await wallet.signTransaction(request);
        const hash = keccak256(signed);
        nextNonce = nonce + 1;
        let sendError = null;
        try {
          await pub.sendRawTransaction({ serializedTransaction: signed });
        } catch (e) {
          sendError = e;
        }
        let receipt;
        try {
          receipt = await pub.waitForTransactionReceipt({ hash, timeout: sendError ? 45_000 : 180_000 });
        } catch (e) {
          nextNonce = nonce; // never mined: the nonce is free again
          throw sendError ?? e;
        }
        sent.push({ hash, to: tx.to, value: tx.value, gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice, status: receipt.status });
        if (policy.onReceipt) await policy.onReceipt(tx, receipt);
        return hash;
      }
      case "eth_sign":
      case "eth_signTransaction":
      case "eth_signTypedData":
      case "eth_signTypedData_v3":
        return refuse(method, "not a method the walk uses");
      default:
        return pub.request({ method, params });
    }
  });
  await page.addInitScript(({ name }) => {
    const listeners = {};
    const provider = {
      isWalkWallet: true,
      request: async ({ method, params = [] }) => {
        try {
          return await window.__guardedRpc(method, params);
        } catch (e) {
          const err = new Error(String(e?.message ?? e));
          err.code = 4001;
          throw err;
        }
      },
      on: (ev, fn) => ((listeners[ev] ??= []).push(fn), provider),
      removeListener: (ev, fn) => ((listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn)), provider),
    };
    const info = { uuid: "7a1c4f2e-0000-4000-8000-000000000002", name, icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "tech.orrery.walk.guarded" };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, { name });
  return { address: account.address, pub, log, refused, sent };
}
