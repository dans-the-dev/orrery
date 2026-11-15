// A test-network wallet for Playwright walks: the page sees one EIP-6963 wallet whose requests are answered in Node
// (page.exposeFunction), so the key never enters the page. Refuses chain 4663 and 1.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export async function attachWallet(page, { keyFile, rpc, chainId, name = "Walk wallet" }) {
  // 4663 only on a local fork (rehearsals); never against a live mainnet RPC
  if ((chainId === 4663 || chainId === 1) && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(rpc)) throw new Error("test networks or a local fork only");
  const { privateKey } = JSON.parse(readFileSync(keyFile, "utf8"));
  // On a fork whose time was moved forward, the page's clock follows the chain so signed expiries line up.
  if (process.env.WALK_CHAIN_CLOCK === "1") {
    const head = await createPublicClient({ transport: http(rpc) }).getBlock();
    await page.clock.install({ time: Number(head.timestamp) * 1000 });
  }
  const account = privateKeyToAccount(privateKey);
  const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ chain, transport: http(rpc), account });
  const log = [];
  await page.exposeFunction("__walkRpc", async (method, params) => {
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
      case "personal_sign":
        return account.signMessage({ message: { raw: params[0] } });
      case "eth_signTypedData_v4": {
        const typed = JSON.parse(params[1]);
        const { EIP712Domain: _drop, ...types } = typed.types;
        return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
      }
      case "eth_sendTransaction": {
        const tx = params[0];
        return wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined, chain, account });
      }
      default:
        return pub.request({ method, params });
    }
  });
  await page.addInitScript(({ name, address }) => {
    const listeners = {};
    const provider = {
      isWalkWallet: true,
      request: async ({ method, params = [] }) => {
        try {
          return await window.__walkRpc(method, params);
        } catch (e) {
          const err = new Error(String(e?.message ?? e));
          err.code = 4001;
          throw err;
        }
      },
      on: (ev, fn) => ((listeners[ev] ??= []).push(fn), provider),
      removeListener: (ev, fn) => ((listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn)), provider),
    };
    const info = { uuid: "7a1c4f2e-0000-4000-8000-000000000001", name, icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "tech.orrery.walk" };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
    void address;
  }, { name, address: account.address });
  return { address: account.address, log, pub };
}
