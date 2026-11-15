#!/usr/bin/env python3
"""Compares the ABI of each lane B contract with the frozen interface ABI in services/packages/shared/src/orry-abi.ts.

Run from contracts/ after `forge build`: python3 test/orry/stake/check_abi.py
Functions and events must match exactly. Allowed extras: the constructor, the IOrryBurnEvents `Burned` event, the
Uniswap v4 `unlockCallback` on OrryBuyback, and Solidity's built-in error shapes (none are added).
"""
import json, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TS = ROOT.parent / "services/packages/shared/src/orry-abi.ts"
PAIRS = {
    "OrryStaking": "iOrryStakingAbi",
    "OrryRewardsRouter": "iOrryRewardsRouterAbi",
    "OrreryTreasury": "iOrreryTreasuryAbi",
    "OrryBuyback": "iOrryBuybackAbi",
}
EXTRA_OK = {("event", "Burned"), ("function", "unlockCallback"), ("constructor", "")}


def frozen(name):
    text = TS.read_text()
    m = re.search(r"export const " + name + r" = (\[.*?\]) as const;", text, re.S) or re.search(
        r"export const " + name + r" = (\[.*?\]);?\n", text, re.S)
    return json.loads(m.group(1))


def sig(item):
    def t(p):
        if p["type"].startswith("tuple"):
            return "(" + ",".join(t(c) for c in p["components"]) + ")" + p["type"][5:]
        return p["type"]
    ins = ",".join(t(p) for p in item.get("inputs", []))
    outs = ",".join(t(p) for p in item.get("outputs", []))
    idx = ",".join(str(p.get("indexed", False)) for p in item.get("inputs", [])) if item["type"] == "event" else ""
    return (item["type"], item.get("name", ""), ins, outs, item.get("stateMutability", ""), idx)


ok = True
for contract, abi_name in PAIRS.items():
    built = json.loads(subprocess.check_output(["forge", "inspect", contract, "abi", "--json"], cwd=ROOT))
    want = {sig(i) for i in frozen(abi_name) if i["type"] in ("function", "event", "receive")}
    have = {sig(i) for i in built if i["type"] in ("function", "event", "receive", "constructor")}
    missing = want - have
    extra = {s for s in have - want if (s[0], s[1]) not in EXTRA_OK}
    want_err = {sig(i) for i in frozen(abi_name) if i["type"] == "error"}
    have_err = {sig(i) for i in built if i["type"] == "error"}
    extra_err = have_err - want_err
    status = "OK" if not (missing or extra or extra_err) else "MISMATCH"
    ok &= status == "OK"
    print(f"{contract}: {status} ({len(want)} frozen functions/events, {len(have)} built incl. constructor)")
    for s in sorted(missing):
        print("  missing", s)
    for s in sorted(extra):
        print("  extra  ", s)
    for s in sorted(extra_err):
        print("  extra error", s)
sys.exit(0 if ok else 1)
