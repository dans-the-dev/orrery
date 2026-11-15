// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BuybackBase} from "./utils/StakeBase.sol";

/// @notice G-1 and G-2 on the deployed runtime code of the four lane B contracts: no Pons address (V2 factory, FeeEscrow,
/// MemeHook) is embedded, no Pons fee function selector is pushed, and no ORRY mint selector exists. The source-level
/// grep is `test/orry/stake/check_no_pons.py` (forge tests have no file access in this project's foundry.toml).
contract NoPonsTest is BuybackBase {
    address internal constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address internal constant PONS_FEE_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address internal constant PONS_MEME_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    function _contracts() internal view returns (address[4] memory) {
        return [address(staking), address(router), address(treasury), address(buyback)];
    }

    function test_G1_no_pons_address_in_runtime_code() public view {
        address[3] memory pons = [PONS_FACTORY, PONS_FEE_ESCROW, PONS_MEME_HOOK];
        address[4] memory cs = _contracts();
        for (uint256 i; i < cs.length; ++i) {
            bytes memory code = cs[i].code;
            assertGt(code.length, 0);
            for (uint256 j; j < pons.length; ++j) {
                assertFalse(_containsConst(code, uint160(pons[j])), "Pons address embedded");
            }
        }
    }

    function test_G1_no_pons_fee_selectors() public view {
        bytes4[6] memory sels = [
            bytes4(keccak256("claim()")), // FeeEscrow
            bytes4(keccak256("claimToken(address)")), // FeeEscrow
            bytes4(keccak256("credit(address)")), // FeeEscrow
            bytes4(keccak256("sweepPoolFees(bytes32,uint256,uint256)")), // MemeHook
            bytes4(keccak256("setCreatorFeeRecipient(address,address)")), // factory (shape as in the ABI notes)
            bytes4(keccak256("transferCreatorFeeRecipient(address,address)"))
        ];
        address[4] memory cs = _contracts();
        for (uint256 i; i < cs.length; ++i) {
            for (uint256 j; j < sels.length; ++j) {
                assertFalse(_containsConst(cs[i].code, uint32(sels[j])), "Pons selector in code");
            }
        }
    }

    function test_G2_no_mint_selector() public view {
        bytes4[3] memory sels = [
            bytes4(keccak256("mint(address,uint256)")),
            bytes4(keccak256("mint(uint256)")),
            bytes4(keccak256("mint(address,uint256,uint256)")) // ERC-6909 mint on the PoolManager
        ];
        address[4] memory cs = _contracts();
        for (uint256 i; i < cs.length; ++i) {
            for (uint256 j; j < sels.length; ++j) {
                assertFalse(_containsConst(cs[i].code, uint32(sels[j])), "mint selector in code");
            }
        }
    }

    /// @dev Positive control: the scan does find what is there (the buyback embeds the PoolManager swap selector).
    function test_scan_finds_a_known_selector() public view {
        bytes4 swapSel = bytes4(keccak256("swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)"));
        assertTrue(_containsConst(address(buyback).code, uint32(swapSel)), "swap");
        bytes4 settleSel = bytes4(keccak256("settle()"));
        assertTrue(_containsConst(address(buyback).code, uint32(settleSel)), "settle");
    }

    /// @dev True when `value` appears in `code` as a constant in any form the optimizer may emit: its bytes as they are,
    /// or shifted right by any of its trailing zero bits (the optimizer pushes `v >> k` and shifts it back with SHL).
    function _containsConst(bytes memory code, uint256 value) internal pure returns (bool) {
        for (uint256 k; k < 256; ++k) {
            if (k != 0 && (value >> (k - 1)) & 1 != 0) break; // stop once a set bit would be shifted out
            uint256 v = value >> k;
            if (v == 0) break;
            uint256 len = 0;
            for (uint256 t = v; t != 0; t >>= 8) ++len;
            bytes memory needle = new bytes(len);
            for (uint256 b; b < len; ++b) needle[len - 1 - b] = bytes1(uint8(v >> (8 * b)));
            if (_contains(code, needle)) return true;
        }
        return false;
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i; i <= hay.length - needle.length; ++i) {
            bool hit = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }
}
