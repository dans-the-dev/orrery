"use client";

import { useEffect, useMemo, useState } from "react";
import {
  concat,
  encodeFunctionData,
  getAddress,
  encodeAbiParameters,
  keccak256,
  isAddress,
  parseAbi,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useConnection, usePublicClient, useReadContract, useSendTransaction, useSignMessage, useWriteContract } from "wagmi";
import { agentWalletDigest, operatorCalls, signSessionConsent, type Policy } from "@orrery/sdk";
import { devUSDGAbi, orreryAttestorAbi } from "@orrery/shared";
import { Funding } from "./Funding";
import { StatusPill } from "@/components/Record";
import { AgentStakeSlot, VerifyWithOrryLink } from "@/components/orry/slots";
import { ADDRESSES, AGENT_RPC_URL, CHAIN_ID, activeChain, deployed } from "@/lib/config";
import { duration, isZero, short, usdg } from "@/lib/format";
import { useAgentView } from "@/lib/lens";
import { DEFAULT_PRESET, LIMIT_PRESETS, SAFE_STACK, agentEnvFile, createSafeCall, defaultExpiry, identityRegistryAbi, prepareAccountCall, recall, remember, safeFactoryAbi, safeSetupAbi } from "@/lib/operator-setup";

const safeAbi = parseAbi([
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function domainSeparator() view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
]);
const devAccountAbi = parseAbi(["function owner() view returns (address)", "function execute(address target,uint256 value,bytes data) returns (bytes)"]);
const install7579 = parseAbi(["function installModule(uint256 moduleTypeId,address module,bytes initData)"]);
const registryAbi = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function setAgentWallet(uint256 agentId,address newWallet,uint256 deadline,bytes signature)",
]);
const devRegistryAbi = parseAbi(["function setAgentWallet(uint256 id,address wallet)"]);

type Kind = "safe" | "dev" | "unsupported" | null;
const STACK = SAFE_STACK[CHAIN_ID];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * The operator's workspace, shown in the dashboard's Agents section: open or create the account and the agent, bind the
 * identity, create the signer, set the limits, fund the agent. Every action is signed by the connected wallet.
 */
export function OperatorWorkspace() {
  const { address: owner, isConnected, chainId } = useConnection();
  const pub = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const { signMessageAsync } = useSignMessage();
  const [accountIn, setAccountIn] = useState("");
  const [agentIn, setAgentIn] = useState("");
  const [kind, setKind] = useState<Kind>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | ""; text: string } | null>(null);
  const account = isAddress(accountIn) ? getAddress(accountIn) : undefined;
  const agentId = /^\d+$/.test(agentIn) ? BigInt(agentIn) : undefined;
  const { data: view, refetch } = useAgentView(agentId, account);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // form state
  const [signer, setSigner] = useState("");
  const [consent, setConsent] = useState("");
  // The form opens on working starting limits; an existing session overwrites them below.
  const [perTx, setPerTx] = useState(DEFAULT_PRESET.perTx);
  const [perDay, setPerDay] = useState(DEFAULT_PRESET.perDay);
  const [floatMax, setFloatMax] = useState(DEFAULT_PRESET.floatMax);
  const [targets, setTargets] = useState("");
  const [expiry, setExpiry] = useState("");
  const [delayHours, setDelayHours] = useState("1");
  // A signer made in this tab. Held in memory only, so it is gone on reload; the operator stores it before the session opens.
  const [signerMode, setSignerMode] = useState<"create" | "paste">("create");
  const [signerKey, setSignerKey] = useState<Hex | null>(null);
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);

  const online = Boolean(isConnected && chainId === activeChain.id && owner && deployed);
  const ready = online && account;
  const hasSession = view && !isZero(view.account) && view.status !== 0;
  const madeSigner = useMemo(() => (signerKey ? privateKeyToAccount(signerKey) : null), [signerKey]);

  useEffect(() => setExpiry((v) => v || defaultExpiry(Date.now())), []);

  // Open the agent named in the link (?account=0x…&agent=1), or the one this wallet opened here last.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const qa = q.get("account") ?? "";
    const qi = q.get("agent") ?? "";
    if (isAddress(qa)) setAccountIn(qa);
    if (/^\d+$/.test(qi)) setAgentIn(qi);
  }, []);
  useEffect(() => {
    if (!owner) return;
    const last = recall(CHAIN_ID, owner);
    setAccountIn((v) => v || last.account || "");
    setAgentIn((v) => v || last.agentId || "");
  }, [owner]);
  useEffect(() => {
    if (owner && account && agentId !== undefined && (kind === "safe" || kind === "dev")) remember(CHAIN_ID, owner, { account, agentId: agentId.toString() });
  }, [owner, account, agentId, kind]);

  // A Safe is ready for Orrery once the adapter is one of its modules.
  const adapter = useReadContract({
    address: account,
    abi: safeSetupAbi,
    functionName: "isModuleEnabled",
    args: STACK ? [STACK.adapter] : undefined,
    query: { enabled: Boolean(STACK && account && kind === "safe") },
  });
  const needsPrepare = Boolean(STACK && kind === "safe" && adapter.data === false);
  const fee = useReadContract({ address: ADDRESSES.attestor, abi: orreryAttestorAbi, functionName: "fee", query: { enabled: Boolean(ADDRESSES.attestor) } }).data;

  // Detect the account kind: a 1-of-1 Safe owned by the connected wallet, or the local development account.
  useEffect(() => {
    let off = false;
    (async () => {
      if (!pub || !account || !owner) return setKind(null);
      try {
        const [threshold, owners] = await Promise.all([
          pub.readContract({ address: account, abi: safeAbi, functionName: "getThreshold" }),
          pub.readContract({ address: account, abi: safeAbi, functionName: "getOwners" }),
        ]);
        if (!off) setKind(threshold === 1n && owners.some((o) => o.toLowerCase() === owner.toLowerCase()) ? "safe" : "unsupported");
        return;
      } catch {}
      // The development account stands in for the Safe7579 adapter on development networks (31337, 46630); never on 4663.
      if (CHAIN_ID !== 4663) {
        try {
          const o = await pub.readContract({ address: account, abi: devAccountAbi, functionName: "owner" });
          if (!off) setKind(o.toLowerCase() === owner.toLowerCase() ? "dev" : "unsupported");
          return;
        } catch {}
      }
      if (!off) setKind("unsupported");
    })();
    return () => {
      off = true;
    };
  }, [pub, account, owner]);

  // Prefill the policy form from the current session.
  useEffect(() => {
    if (!view || !hasSession) return;
    const c = view.caps[0];
    if (c) {
      setPerTx(usdg(c.perTx).replace(/,/g, ""));
      setPerDay(usdg(c.perDay).replace(/,/g, ""));
      setFloatMax(usdg(c.floatMax).replace(/,/g, ""));
    }
    setTargets(view.targets.map((t) => `${t.target} ${t.selector}`).join("\n"));
    setExpiry(new Date(Number(view.policyValidUntil) * 1000).toISOString().slice(0, 10));
    setDelayHours(String(view.increaseDelay / 3600));
  }, [view?.policyHash]); // eslint-disable-line react-hooks/exhaustive-deps

  const policy: Policy | null = useMemo(() => {
    try {
      if (!ADDRESSES.usdg || !perTx || !perDay || !expiry) return null;
      const lines = targets.split("\n").map((l) => l.trim()).filter(Boolean);
      return {
        caps: [{ token: ADDRESSES.usdg, perTx: parseUnits(perTx, 6), perDay: parseUnits(perDay, 6), floatMax: parseUnits(floatMax || "0", 6) }],
        targets: lines.map((l) => {
          const [t, sel] = l.split(/\s+/);
          if (!t || !sel || !isAddress(t) || !/^0x[0-9a-fA-F]{8}$/.test(sel)) throw new Error("bad target");
          return { target: getAddress(t), selector: sel as Hex };
        }),
        // The same date as the current policy keeps its exact on-chain expiry, so an unchanged form is not an increase.
        validUntil:
          view && hasSession && new Date(Number(view.policyValidUntil) * 1000).toISOString().slice(0, 10) === expiry
            ? view.policyValidUntil
            : BigInt(Math.floor(new Date(`${expiry}T23:59:59Z`).getTime() / 1000)),
        increaseDelay: Math.round(Number(delayHours) * 3600),
      };
    } catch {
      return null;
    }
  }, [perTx, perDay, floatMax, targets, expiry, delayHours, view, hasSession]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setNotice({ tone: "", text: `${label}: confirm in your wallet.` });
    try {
      await fn();
      setNotice({ tone: "ok", text: `${label}: done.` });
      await refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setNotice({ tone: "error", text: /reject|denied/i.test(msg) ? "Request closed in the wallet." : `${label} did not go through. ${msg.split("\n")[0]?.slice(0, 160) ?? ""}` });
    } finally {
      setBusy(false);
    }
  }

  /** Executes a call through the account: Safe 1-of-1 with the owner's pre-validated signature, or the dev account. */
  async function exec(to: Address, data: Hex) {
    if (!account || !owner || !pub) throw new Error("Connect the owner wallet.");
    let hash: Hex;
    if (kind === "safe") {
      return execSafe(account, to, data, 0);
    } else if (kind === "dev") {
      hash = await writeContractAsync({ address: account, abi: devAccountAbi, functionName: "execute", args: [to, 0n, data] });
    } else throw new Error("This account is not a 1-of-1 Safe owned by the connected wallet.");
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("The transaction reverted.");
  }

  /** A call from a 1-of-1 Safe with the owner's pre-validated signature. Operation 1 is a delegatecall (MultiSendCallOnly). */
  async function execSafe(safe: Address, to: Address, data: Hex, operation: 0 | 1) {
    if (!owner || !pub) throw new Error("Connect the owner wallet.");
    const sig = concat([`0x${owner.slice(2).padStart(64, "0")}`, `0x${"0".repeat(64)}`, "0x01"]);
    const hash = await writeContractAsync({ address: safe, abi: safeAbi, functionName: "execTransaction", args: [to, 0n, data, operation, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, sig] });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("The transaction reverted.");
  }

  /** Adapter enabled, account initialised and the policy module installed, in one confirmation. */
  async function prepareAccount(safe: Address) {
    if (!STACK || !ADDRESSES.module) return;
    const p = prepareAccountCall(STACK, safe, ADDRESSES.module);
    await execSafe(safe, p.to, p.data, p.operation);
    void adapter.refetch();
  }

  /** A new 1-of-1 Safe owned by the connected wallet, then prepared for Orrery: two confirmations. */
  async function createAccount() {
    if (!STACK || !owner || !pub) return;
    const c = createSafeCall(STACK, owner, BigInt(Date.now()));
    const hash = await sendTransactionAsync({ to: c.to, data: c.data });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("The transaction reverted.");
    const safe = parseEventLogs({ abi: safeFactoryAbi, logs: r.logs, eventName: "ProxyCreation" })[0]?.args.proxy;
    if (!safe) throw new Error("The new account did not show in the receipt.");
    // Shown and remembered before the second confirmation, so a closed wallet prompt leaves an account to finish.
    setAccountIn(safe);
    remember(CHAIN_ID, owner, { account: safe });
    setNotice({ tone: "", text: "Account created. Confirm once more to set it up for Orrery." });
    await prepareAccount(safe);
  }

  /** A new ERC-8004 identity owned by the connected wallet. Its registration file can be set later in the registry. */
  async function registerAgent() {
    if (!owner || !pub || !ADDRESSES.registry) return;
    const hash = await writeContractAsync({ address: ADDRESSES.registry, abi: identityRegistryAbi, functionName: "register", args: [""] });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("The transaction reverted.");
    const id = parseEventLogs({ abi: identityRegistryAbi, logs: r.logs, eventName: "Registered" })[0]?.args.agentId;
    if (id === undefined) throw new Error("The new agent did not show in the receipt.");
    setAgentIn(id.toString());
    remember(CHAIN_ID, owner, { agentId: id.toString() });
  }

  function createSigner() {
    setSignerKey(generatePrivateKey());
    setStored(false);
    setCopied(false);
  }
  const keyFile = () =>
    signerKey && madeSigner && account && agentId !== undefined && ADDRESSES.module
      ? agentEnvFile({ signerKey, signer: madeSigner.address, chainId: CHAIN_ID, rpcUrl: AGENT_RPC_URL, module: ADDRESSES.module, account, agentId })
      : "";
  function downloadKey() {
    const url = URL.createObjectURL(new Blob([keyFile()], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `orrery-agent-${agentId?.toString() ?? "signer"}.env`;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function copyKey() {
    try {
      await navigator.clipboard.writeText(keyFile());
      setCopied(true);
    } catch {}
  }

  /** Opens the session with the signer made here (its consent is signed in this tab) or with the pasted pair. */
  async function openSession() {
    if (!account || agentId === undefined || !policy || !ADDRESSES.module) return;
    if (signerMode === "create") {
      if (!madeSigner) return;
      const sig = await signSessionConsent(madeSigner, { chainId: CHAIN_ID, module: ADDRESSES.module, account, agentId, policy });
      await exec(ADDRESSES.module, operatorCalls.openSession(agentId, madeSigner.address, policy, sig));
    } else {
      await exec(ADDRESSES.module, operatorCalls.openSession(agentId, getAddress(signer), policy, consent as Hex));
    }
  }

  async function bindIdentity() {
    if (!account || !owner || !pub || agentId === undefined || !ADDRESSES.registry) return;
    if (CHAIN_ID === 31337) {
      const hash = await writeContractAsync({ address: ADDRESSES.registry, abi: devRegistryAbi, functionName: "setAgentWallet", args: [agentId, account] });
      await pub.waitForTransactionReceipt({ hash });
      return;
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 240);
    const digest = agentWalletDigest({ chainId: CHAIN_ID, registry: ADDRESSES.registry, agentId, newWallet: account, owner, deadline });
    const domainSeparator = await pub.readContract({ address: account, abi: safeAbi, functionName: "domainSeparator" });
    // Safe message hash of the digest; the owner signs it with eth_sign semantics (Safe expects v + 4).
    const messageHash = keccakSafeMessage(domainSeparator, digest);
    const raw = await signMessageAsync({ message: { raw: messageHash } });
    const v = parseInt(raw.slice(130, 132), 16) + 4;
    const sig = concat(["0x0000000000000000000000000000000000000000", raw.slice(0, 130) as Hex, `0x${v.toString(16)}`]);
    const hash = await writeContractAsync({ address: ADDRESSES.registry, abi: registryAbi, functionName: "setAgentWallet", args: [agentId, account, deadline, sig] });
    await pub.waitForTransactionReceipt({ hash });
  }

  async function payVerification() {
    if (!owner || !pub || agentId === undefined || !ADDRESSES.attestor || !ADDRESSES.usdg) return;
    const fee = await pub.readContract({ address: ADDRESSES.attestor, abi: orreryAttestorAbi, functionName: "fee" });
    const agentOwner = await pub.readContract({ address: ADDRESSES.registry!, abi: registryAbi, functionName: "ownerOf", args: [agentId] });
    const a = await writeContractAsync({ address: ADDRESSES.usdg, abi: devUSDGAbi, functionName: "approve", args: [ADDRESSES.attestor, fee] });
    await pub.waitForTransactionReceipt({ hash: a });
    const h = await writeContractAsync({ address: ADDRESSES.attestor, abi: orreryAttestorAbi, functionName: "payVerification", args: [agentId, agentOwner, fee] });
    await pub.waitForTransactionReceipt({ hash: h });
  }

  const isDecrease = useMemo(() => {
    if (!view || !policy || !hasSession) return false;
    const c = view.caps[0];
    const p = policy.caps[0];
    if (!c || !p || view.caps.length !== 1) return false;
    const subset = policy.targets.every((t) => view.targets.some((x) => x.target.toLowerCase() === t.target.toLowerCase() && x.selector.toLowerCase() === t.selector.toLowerCase()));
    return p.perTx <= c.perTx && p.perDay <= c.perDay && p.floatMax <= c.floatMax && subset && policy.validUntil <= view.policyValidUntil && policy.increaseDelay >= view.increaseDelay;
  }, [view, policy, hasSession]);

  const unchanged = useMemo(() => {
    if (!view || !policy || !hasSession) return false;
    const c = view.caps[0];
    const p = policy.caps[0];
    return Boolean(c && p && p.perTx === c.perTx && p.perDay === c.perDay && p.floatMax === c.floatMax && policy.validUntil === view.policyValidUntil &&
      policy.increaseDelay === view.increaseDelay && policy.targets.length === view.targets.length && isDecrease);
  }, [view, policy, hasSession, isDecrease]);

  const pendingLeft = view ? Number(view.pendingReadyAt) - now : 0;
  const c = view?.caps[0];

  return (
    <div className="op-workspace">
        {!deployed ? (
          <div className="panel"><h2>The operator view opens soon</h2><p>Sessions can be opened here once the contracts are live on this network.</p></div>
        ) : (
          <div className="stack">
            <div>
            <section className="panel">
              <h2>Open an agent</h2>
              <div className="form-grid two">
                <div className="field-with-action">
                  <label className="field">Account<input value={accountIn} onChange={(e) => setAccountIn(e.target.value.trim())} placeholder="0x… your Safe" spellCheck={false} /><small>{!owner ? "Connect the owner wallet." : needsPrepare ? "Safe owned by this wallet. One confirmation sets it up for Orrery." : kind === "safe" ? "Safe, 1-of-1, owned by this wallet." : kind === "dev" ? "Local development account." : kind === "unsupported" ? "Needs a 1-of-1 Safe owned by the connected wallet." : STACK ? "No account yet? Create one here in two confirmations." : ""}</small></label>
                  {STACK && !account ? <button className="secondary" type="button" disabled={!online || busy} onClick={() => void run("Create account", createAccount)}>Create my account</button> : null}
                  {needsPrepare && account ? <button className="secondary" type="button" disabled={!online || busy} onClick={() => void run("Account setup", () => prepareAccount(account))}>Finish account setup</button> : null}
                </div>
                <div className="field-with-action">
                  <label className="field">Agent ID (ERC-8004)<input value={agentIn} onChange={(e) => setAgentIn(e.target.value.trim())} placeholder="1" inputMode="numeric" /><small>{agentId === undefined && ADDRESSES.registry ? "No agent identity yet? Register one here in one confirmation." : ""}</small></label>
                  {agentId === undefined && ADDRESSES.registry && CHAIN_ID !== 31337 ? <button className="secondary" type="button" disabled={!online || busy} onClick={() => void run("Register agent", registerAgent)}>Register a new agent</button> : null}
                </div>
              </div>
              {!owner ? <p className="muted-line">Connect a wallet on {activeChain.name} to start.</p> : null}
              {notice && !(account && agentId !== undefined && view) ? <div className={`notice ${notice.tone}`} role="status">{notice.text}</div> : null}
            </section>
            </div>

            {account && agentId !== undefined && view ? (
              <section className="editor">
                <div className="editor-head">
                  <div><p className="section-kicker">Agent #{agentId.toString()} / policy</p><h2>Spending authority</h2></div>
                  <StatusPill status={view.status} />
                </div>
                <ol className="setup-steps">
                  <li data-done={view.installed}>
                    <span className="setup-mark" aria-hidden="true">{view.installed ? "✓" : "1"}</span>
                    <div><strong>Policy module</strong><p>{view.installed ? "Installed on this account." : "The account enforces the limits through this module."}</p></div>
                    {!view.installed ? (
                      <button className="secondary" type="button" disabled={!ready || busy}
                        onClick={() => run("Install module", () => (needsPrepare ? prepareAccount(account) : exec(account, encodeFunctionData({ abi: install7579, functionName: "installModule", args: [2n, ADDRESSES.module!, "0x"] }))))}>Install module</button>
                    ) : null}
                  </li>
                  <li data-done={view.bound}>
                    <span className="setup-mark" aria-hidden="true">{view.bound ? "✓" : "2"}</span>
                    <div><strong>Identity</strong><p>{view.bound ? `Agent #${agentId.toString()} pays from this account.` : "One signature and one confirmation tie the agent to this account."}</p></div>
                    {!view.bound ? <button className="secondary" type="button" disabled={!ready || busy || !view.installed} onClick={() => run("Bind identity", bindIdentity)}>Bind identity</button> : null}
                  </li>
                  <li data-done={Boolean(hasSession && view.status !== 3)}>
                    <span className="setup-mark" aria-hidden="true">{hasSession && view.status !== 3 ? "✓" : "3"}</span>
                    <div><strong>Session</strong><p>{hasSession && view.status !== 3 ? `Signer ${short(view.signer)} pays inside the limits below.` : "Create the signer and set the limits below, then open the session."}</p></div>
                  </li>
                  <li data-done={view.verified} data-optional="true">
                    <span className="setup-mark" aria-hidden="true">{view.verified ? "✓" : "+"}</span>
                    <div><strong>Verification</strong><p>{view.verified ? "Paid. Checks of this agent show it as verified." : `Optional. A one-time fee${fee !== undefined ? ` of ${usdg(fee)} USDG` : ""} marks the agent as verified in every check.`}</p></div>
                    {!view.verified ? <button className="secondary" type="button" disabled={!ready || busy} onClick={() => run("Verification", payVerification)}>Pay verification</button> : null}
                    {!view.verified ? <VerifyWithOrryLink agentId={agentId} /> : null}
                  </li>
                </ol>

                {hasSession && c ? (
                  <div className="spend-panel">
                    <div><span>Spent today</span><strong>{usdg(c.spentToday)} <small>/ {usdg(c.perDay)} USDG</small></strong></div>
                    <div className="spend-track"><i style={{ width: `${c.perDay > 0n ? Math.min(100, Number((c.spentToday * 100n) / c.perDay)) : 0}%` }} /></div>
                    <p>{usdg(c.perDay > c.spentToday ? c.perDay - c.spentToday : 0n)} USDG available today · signer {short(view.signer)}</p>
                  </div>
                ) : null}

                {!hasSession || view.status === 3 ? (
                  <div className="editor-section">
                    <div className="row-heading">
                      <h3>Agent signer</h3>
                      <div className="seg" role="group" aria-label="Where the signer comes from">
                        <button type="button" aria-pressed={signerMode === "create"} onClick={() => setSignerMode("create")}>Create it here</button>
                        <button type="button" aria-pressed={signerMode === "paste"} onClick={() => setSignerMode("paste")}>The agent has one</button>
                      </div>
                    </div>
                    {signerMode === "create" ? (
                      <>
                        <p style={{ marginTop: 8 }}>The agent pays with its own key, inside the limits below. The key is made in this browser tab and goes only into the file you save.</p>
                        {!signerKey ? (
                          <div className="row" style={{ marginTop: 14 }}>
                            <button className="secondary" type="button" onClick={createSigner}>Create the signer</button>
                          </div>
                        ) : (
                          <div style={{ marginTop: 14 }}>
                            <div className="key-box">Signer {madeSigner?.address}</div>
                            <div className="row" style={{ marginTop: 12 }}>
                              <button className="secondary" type="button" onClick={downloadKey}>Download the key file</button>
                              <button className="quiet-button" type="button" onClick={() => void copyKey()}>{copied ? "Copied" : "Copy as text"}</button>
                              <button className="quiet-button" type="button" onClick={createSigner}>Make another</button>
                            </div>
                            <label className="check-line"><input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} />The key file is saved. It is shown only in this tab.</label>
                            <p className="muted-line">Give the file to the agent. The SDK reads it as environment variables. <a href="/docs">Agent setup</a></p>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <p style={{ marginTop: 8 }}>The agent generates its signer and signs the consent with the SDK (`signSessionConsent`). Paste both here.</p>
                        <div className="form-grid two" style={{ marginTop: 14 }}>
                          <label className="field">Signer address<input value={signer} onChange={(e) => setSigner(e.target.value.trim())} placeholder="0x…" spellCheck={false} /></label>
                          <label className="field">Signer consent<input value={consent} onChange={(e) => setConsent(e.target.value.trim())} placeholder="0x… 65-byte signature" spellCheck={false} /></label>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}

                <div className="editor-section">
                  <div className="row-heading">
                    <h3>Token caps</h3>
                    <div className="seg" role="group" aria-label="Starting limits">
                      {LIMIT_PRESETS.map((p) => (
                        <button key={p.id} type="button" aria-pressed={Number(perTx) === Number(p.perTx) && Number(perDay) === Number(p.perDay) && Number(floatMax) === Number(p.floatMax)}
                          onClick={() => { setPerTx(p.perTx); setPerDay(p.perDay); setFloatMax(p.floatMax); }}>{p.label}</button>
                      ))}
                    </div>
                  </div>
                  <div className="token-row">
                    <div className="token-name"><span className="coin-shape">$</span><strong>USDG</strong></div>
                    <label>Per payment<input type="number" min="0" step="0.01" value={perTx} onChange={(e) => setPerTx(e.target.value)} /><small>USDG</small></label>
                    <label>Per day<input type="number" min="0" step="0.01" value={perDay} onChange={(e) => setPerDay(e.target.value)} /><small>USDG</small></label>
                    <label>Float ceiling<input type="number" min="0" step="0.01" value={floatMax} onChange={(e) => setFloatMax(e.target.value)} /><small>USDG</small></label>
                  </div>
                </div>
                <details className="editor-section editor-more" open={targets.trim() !== "" ? true : undefined}>
                  <summary><h3>Allowed calls</h3><span>{targets.trim() === "" ? "None. The agent pays over x402 from its float." : "Custom"}</span></summary>
                  <p style={{ marginTop: 8 }}>Leave this empty for an agent that pays over x402. Add a line for each contract function the signer may call through the account.</p>
                  <label className="field" style={{ marginTop: 12 }}>One per line: target address and 4-byte selector<textarea value={targets} onChange={(e) => setTargets(e.target.value)} placeholder="0x… 0x12345678" spellCheck={false} /></label>
                </details>
                <div className="editor-section editor-two">
                  <label>Policy expiry<input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></label>
                  <label>Increase delay<select value={delayHours} onChange={(e) => setDelayHours(e.target.value)}>
                    {["1", "6", "24", "72"].map((h) => <option key={h} value={h}>{h === "1" ? "1 hour minimum" : `${h} hours`}</option>)}
                  </select></label>
                </div>

                {view.pendingReadyAt > 0n ? (
                  <div className="pending">
                    <div className="pending-symbol">⏳</div>
                    <div><strong>Increase pending</strong><p>{pendingLeft > 0 ? <>Ready in <span id="countdown">{duration(pendingLeft)}</span>.</> : "Ready to apply."}</p></div>
                    <button className="quiet-button" type="button" disabled={!ready || busy || pendingLeft > 0} onClick={() => run("Apply increase", () => exec(ADDRESSES.module!, operatorCalls.applyIncrease(agentId)))}>Apply</button>
                    <button className="quiet-button" type="button" disabled={!ready || busy} onClick={() => run("Cancel increase", () => exec(ADDRESSES.module!, operatorCalls.cancelIncrease(agentId)))}>Cancel</button>
                  </div>
                ) : null}

                <div className="editor-actions">
                  {!hasSession || view.status === 3 ? (
                    <button className="primary" type="button"
                      disabled={!ready || busy || !policy || !view.installed || !view.bound || (signerMode === "create" ? !signerKey || !stored : !isAddress(signer) || !/^0x[0-9a-fA-F]{130}$/.test(consent))}
                      onClick={() => run("Open session", openSession)}>Open session</button>
                  ) : (
                    <>
                      <button className="primary" type="button" disabled={!ready || busy || !policy || unchanged}
                        onClick={() => run(isDecrease ? "Lower limits" : "Propose increase", () => exec(ADDRESSES.module!, isDecrease ? operatorCalls.decreasePolicy(agentId, policy!) : operatorCalls.proposeIncrease(agentId, policy!)))}>
                        {unchanged ? "No changes" : isDecrease ? "Lower limits now" : `Propose increase (waits ${duration(Math.max(3600, view.increaseDelay))})`}
                      </button>
                      {view.status === 1 ? <button className="secondary" type="button" disabled={!ready || busy} onClick={() => run("Pause", () => exec(ADDRESSES.module!, operatorCalls.pause(agentId)))}>Pause agent</button> : null}
                      {view.status === 2 ? <button className="secondary" type="button" disabled={!ready || busy} onClick={() => run("Resume", () => exec(ADDRESSES.module!, operatorCalls.unpause(agentId)))}>Resume agent</button> : null}
                      <button className="danger-button" type="button" disabled={!ready || busy} onClick={() => run("Revoke", () => exec(ADDRESSES.module!, operatorCalls.revoke(agentId)))}>Revoke session</button>
                    </>
                  )}
                </div>
                {notice ? <div className={`notice ${notice.tone}`} role="status">{notice.text}</div> : null}
                {hasSession && (view.status === 1 || view.status === 2) ? <Funding account={account} signer={view.signer} suggestedUsdg={c ? usdg(c.perDay).replace(/,/g, "") : ""} disabled={!ready || busy} run={run} /> : null}
              </section>
            ) : null}

            {agentId !== undefined ? <AgentStakeSlot agentId={agentId} /> : null}
          </div>
        )}
    </div>
  );
}

/** keccak256(0x19 0x01 ‖ domainSeparator ‖ keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(abi.encode(digest))))) */
const SAFE_MSG_TYPEHASH = "0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca" as const;
function keccakSafeMessage(domainSeparator: Hex, digest: Hex): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "bytes32" }], [digest]));
  const struct = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [SAFE_MSG_TYPEHASH, inner]));
  return keccak256(concat(["0x1901", domainSeparator, struct]));
}
