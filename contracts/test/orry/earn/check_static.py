#!/usr/bin/env python3
"""Static checks for lane A (run from contracts/ after `forge build`):

1. ABI: every entry of the frozen ABIs in services/packages/shared/src/orry-abi.ts (iOrreryHookAbi, iEarnVaultAbi,
   iClaimAllAbi, iOrryLensAbi, iEarnVaultFactoryAbi) exists unchanged in the compiled contract; entries the contract adds are listed.
2. G-1: no source under src/orry/ names a Pons V2 address or a Pons fee function.
3. G-2: no source under src/orry/ calls a mint on ORRY (the only `mint(` allowed is the PoolManager's ERC-6909 one).
Exit code 1 on any failure.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[4]  # repo root
CONTRACTS = ROOT / "contracts"
ABI_TS = ROOT / "services/packages/shared/src/orry-abi.ts"

PAIRS = {
    "iOrreryHookAbi": "OrreryHook",
    "iEarnVaultAbi": "EarnVault",
    "iClaimAllAbi": "ClaimAll",
    "iOrryLensAbi": "OrryLens",
    "iEarnVaultFactoryAbi": "EarnVaultFactory",
}
# Entries a v4 hook or an ETH-receiving vault cannot avoid; listed, not failed.
EXPECTED_EXTRAS = {
    "OrreryHook": {
        "function beforeInitialize", "function afterInitialize", "function beforeAddLiquidity",
        "function afterAddLiquidity", "function beforeRemoveLiquidity", "function afterRemoveLiquidity",
        "function beforeSwap", "function afterSwap", "function beforeDonate", "function afterDonate",
        "function unlockCallback", "constructor", "error HookAddressNotValid", "error SafeERC20FailedOperation",
        "error AddressEmptyCode", "error AddressInsufficientBalance", "error FailedInnerCall",
    },
    "EarnVault": {
        "function unlockCallback", "receive", "constructor", "error SafeERC20FailedOperation",
        "error AddressEmptyCode", "error AddressInsufficientBalance", "error FailedInnerCall", "error SafeCastOverflow",
        "error InvalidTick", "error InvalidPrice", "error NotEnoughLiquidity", "error PriceOverflow",
        "error InvalidPriceOrLiquidity",
    },
    "ClaimAll": {"constructor"},
    "OrryLens": {"constructor"},
    "EarnVaultFactory": {"constructor"},
}
PONS = ["0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e", "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
        "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044", "0x7eD5", "0xd3AF", "0xE5e7"]
PONS_CALLS = [r"IFeeEscrow", r"sweepPoolFees", r"creditToken", r"claimToken\s*\(", r"\bFeeEscrow\b", r"MemeHook",
              r"setCreatorFeeRecipient", r"transferCreatorFeeRecipient"]


def canon(entry):
    def p(params):
        return [(x.get("name", ""), x["type"], x.get("internalType", ""), x.get("indexed"),
                 json.dumps(x.get("components"), sort_keys=True)) for x in params]
    return json.dumps({
        "type": entry["type"], "name": entry.get("name"), "inputs": p(entry.get("inputs", [])),
        "outputs": p(entry.get("outputs", [])), "stateMutability": entry.get("stateMutability"),
        "anonymous": entry.get("anonymous"),
    }, sort_keys=True)


def label(entry):
    return entry["type"] if entry["type"] in ("constructor", "receive", "fallback") else f"{entry['type']} {entry['name']}"


def frozen_abis():
    text = ABI_TS.read_text()
    out = {}
    for name in PAIRS:
        m = re.search(r"export const " + name + r" = (\[.*?\]) as const;", text)
        assert m, f"{name} not found in {ABI_TS}"
        out[name] = json.loads(m.group(1))
    return out


def main():
    failures = []
    for ts_name, abi in frozen_abis().items():
        contract = PAIRS[ts_name]
        compiled = json.loads((CONTRACTS / f"out/{contract}.sol/{contract}.json").read_text())["abi"]
        have = {canon(e) for e in compiled}
        missing = [label(e) for e in abi if canon(e) not in have]
        want = {canon(e) for e in abi}
        extras = sorted({label(e) for e in compiled if canon(e) not in want})
        unexpected = [x for x in extras if x not in EXPECTED_EXTRAS[contract]]
        status = "OK" if not missing and not unexpected else "FAIL"
        print(f"ABI {status:4} {contract}: {len(abi)} frozen entries, {len(missing)} missing, extras: {', '.join(extras) or 'none'}")
        if missing:
            failures.append(f"{contract} missing {missing}")
        if unexpected:
            failures.append(f"{contract} unexpected extras {unexpected}")

    sources = sorted((CONTRACTS / "src/orry").rglob("*.sol"))
    for path in sources:
        src = path.read_text()
        for a in PONS:
            if a.lower() in src.lower():
                failures.append(f"G-1 {path.name} names Pons address {a}")
        for pat in PONS_CALLS:
            if re.search(pat, src):
                failures.append(f"G-1 {path.name} matches Pons call pattern {pat}")
        for m in re.finditer(r"([\w\.\(\)]*)\.mint\s*\(", src):
            if "poolManager" not in m.group(1) and "pm" not in m.group(1).lower():
                failures.append(f"G-2 {path.name} calls mint: {m.group(0)}")
        if re.search(r"\b_mint\s*\(", src):
            failures.append(f"G-2 {path.name} calls _mint")
    print(f"G-1/G-2 scanned {len(sources)} files under src/orry: {', '.join(p.name for p in sources)}")

    if failures:
        print("FAILURES:")
        for f in failures:
            print("  " + f)
        sys.exit(1)
    print("all static checks passed")


if __name__ == "__main__":
    main()
