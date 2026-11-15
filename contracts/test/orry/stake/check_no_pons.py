#!/usr/bin/env python3
"""G-1 and G-2 source check for lane B (docs/ORRY-BUILD-SPEC.md section 4).

Run from contracts/: python3 test/orry/stake/check_no_pons.py
Fails when a lane B source names a Pons address or a Pons fee call, or calls a mint function.
The bytecode-level check is test/orry/stake/NoPons.t.sol.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SOURCES = [ROOT / "src/orry" / n for n in (
    "OrryStaking.sol", "OrryRewardsRouter.sol", "OrreryTreasury.sol", "OrryBuyback.sol")]
PATTERNS = {
    "Pons V2 factory address": r"7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
    "Pons FeeEscrow address": r"d3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
    "Pons MemeHook address": r"E5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
    "FeeEscrow-like interface": r"\bIFeeEscrow\b|\bFeeEscrow\b",
    "FeeEscrow claim calls": r"\.claim\s*\(|\.claimToken\s*\(|\.credit\s*\(|\.creditToken\s*\(",
    "MemeHook fee sweep": r"sweepPoolFees",
    "creator fee recipient calls": r"CreatorFeeRecipient",
    "mint call (G-2)": r"\.mint\s*\(|\bmint\s*\(",
}

bad = 0
for src in SOURCES:
    code = src.read_text()
    # comments may name Pons (they explain R-1); only code counts
    code = re.sub(r"//[^\n]*", "", code)
    code = re.sub(r"/\*.*?\*/", "", code, flags=re.S)
    for what, pat in PATTERNS.items():
        for m in re.finditer(pat, code, flags=re.I):
            line = code[: m.start()].count("\n") + 1
            print(f"FAIL {src.name}: {what} at code line {line}: {m.group(0)}")
            bad += 1
print(f"{len(SOURCES)} sources, {len(PATTERNS)} patterns, {bad} hits")
sys.exit(1 if bad else 0)
