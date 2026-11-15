// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OrreryTreasury} from "../../../../src/orry/OrreryTreasury.sol";
import {OrreryAttestor} from "../../../../src/OrreryAttestor.sol";
import {MockIdentityRegistry, MockERC20} from "../../../mocks/Mocks.sol";
import {MockOrry} from "../utils/StakeMocks.sol";
import {QuoteSigning} from "../utils/TreasuryBase.sol";

/// @notice Bounded handler for OrreryTreasury (invariants T-1 to T-6). The handler's `puller` is the buyback the coin
/// proposal names. The ghost keeps its own model of the daily pull window from the specification text.
contract TreasuryHandler is QuoteSigning {
    OrreryTreasury public treasury;
    MockERC20 public usdg;
    MockOrry public orry;
    MockIdentityRegistry public registry;
    OrreryAttestor public attestor;
    address public owner;
    address public puller = makeAddr("puller");
    uint256 internal signerKey;
    uint256 internal strangerKey;

    address[] public actors;

    // ghosts
    uint256 public minted;
    uint256 public toOwner;
    uint256 public toBuyback;
    uint256 public proposedAt;
    bool public coinSet;
    uint256 public coinSetAt;
    uint256 public winStart;
    uint256 public winBase;
    uint256 public winPulled;
    uint256 public lastSupply;
    mapping(uint256 day => uint256) public verificationsOnDay;
    uint256 public maxVerificationsInADay;
    bytes32[] internal _usedIds;

    bool public badT2;
    bool public badT3;
    bool public badT4;
    bool public badT5;
    bool public badSupplyUp;

    mapping(bytes32 => uint256) public calls;

    uint256 internal _now;
    uint256 internal _nonce;

    constructor(
        OrreryTreasury t,
        MockERC20 u,
        MockOrry r,
        MockIdentityRegistry reg,
        OrreryAttestor att,
        address owner_,
        uint256 signerKey_,
        uint256 start
    ) {
        treasury = t;
        usdg = u;
        orry = r;
        registry = reg;
        attestor = att;
        owner = owner_;
        signerKey = signerKey_;
        (, strangerKey) = makeAddrAndKey("strangerSigner");
        _now = start;
        lastSupply = r.totalSupply();
        for (uint256 i; i < 4; ++i) {
            actors.push(makeAddr(string(abi.encodePacked("buyer", vm.toString(i)))));
        }
    }

    function init() external {
        for (uint256 i; i < actors.length; ++i) {
            vm.prank(actors[i]);
            orry.approve(address(treasury), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _count(bytes32 k) internal {
        calls[k] += 1;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _checkSupply() internal {
        uint256 s = orry.totalSupply();
        if (s > lastSupply) badSupplyUp = true;
        lastSupply = s;
    }

    // ---------------------------------------------------------------- revenue and owner

    function revenue(uint256 amount) public {
        amount = _bound(amount, 1, 50_000e6);
        usdg.mint(address(treasury), amount);
        minted += amount;
        _count("revenue");
    }

    function sync() public {
        treasury.sync();
        _count("sync");
    }

    function withdrawOwner() public {
        uint256 ownerBefore = usdg.balanceOf(owner);
        uint256 balBefore = usdg.balanceOf(address(treasury));
        vm.prank(owner);
        try treasury.withdrawOwnerShare() {
            uint256 got = usdg.balanceOf(owner) - ownerBefore;
            if (balBefore - usdg.balanceOf(address(treasury)) != got || treasury.ownerAccrued() != 0) badT2 = true;
            toOwner += got;
            _count("withdrawOwner");
        } catch {}
    }

    function reclaim() public {
        uint256 bal = usdg.balanceOf(address(treasury));
        vm.prank(owner);
        try treasury.reclaimReserve() {
            if (coinSet) badT2 = true; // the reserve may move to the owner only while coinless
            if (usdg.balanceOf(address(treasury)) != bal) badT2 = true;
            _count("reclaim");
        } catch {}
    }

    // ---------------------------------------------------------------- coin

    function propose() public {
        vm.prank(owner);
        try treasury.proposeCoin(address(orry), puller) {
            if (coinSet) badT3 = true;
            proposedAt = _now;
            _count("propose");
        } catch {}
    }

    function execute() public {
        vm.prank(owner);
        try treasury.executeCoin() {
            if (coinSet || proposedAt == 0 || _now < proposedAt + 48 hours || _now > proposedAt + 48 hours + 7 days) {
                badT3 = true;
            }
            if (treasury.orry() != address(orry) || treasury.buyback() != puller) badT3 = true;
            coinSet = true;
            coinSetAt = _now;
            _count("execute");
        } catch {}
    }

    // ---------------------------------------------------------------- pulls (T-2 daily bound)

    function pull(uint256 amount) public {
        amount = _bound(amount, 1, 100_000e6);
        uint256 bal = usdg.balanceOf(address(treasury));
        uint256 got0 = usdg.balanceOf(puller);
        // the ghost window, from the specification: base = reserve (after sync) at the window start
        treasury.sync();
        uint256 reserve = treasury.buybackReserve();
        bool fresh = winStart == 0 || _now >= winStart + 1 days;
        uint256 base = fresh ? reserve : winBase;
        uint256 used = fresh ? 0 : winPulled;
        uint256 allowed = reserve <= 1e6 ? reserve : _min(reserve, (base * 1000 / 10_000) > used ? base * 1000 / 10_000 - used : 0);
        vm.prank(puller);
        try treasury.pullBuyback(amount) returns (uint256 pulled) {
            uint256 got = usdg.balanceOf(puller) - got0;
            if (!coinSet || got != pulled || pulled > allowed || pulled != _min(amount, allowed)) badT2 = true;
            if (bal - usdg.balanceOf(address(treasury)) != pulled) badT2 = true;
            if (fresh) {
                winStart = _now;
                winBase = base;
                winPulled = 0;
            }
            winPulled += pulled;
            toBuyback += pulled;
            _count("pull");
        } catch {
            if (coinSet && allowed != 0) badT2 = true; // an allowed pull must never fail
        }
    }

    /// @dev Anyone other than the buyback trying to pull must fail.
    function strangerPull(uint256 actorSeed) public {
        vm.prank(_actor(actorSeed));
        try treasury.pullBuyback(1) {
            badT2 = true;
        } catch {}
        _count("strangerPull");
    }

    // ---------------------------------------------------------------- ORRY checkout (T-4, T-5)

    function credits(uint256 actorSeed, uint256 amount, uint256 mode) public {
        address buyer = _actor(actorSeed);
        amount = _bound(amount, 1, 1_000e18);
        if (orry.balanceOf(buyer) < amount) return;
        mode = mode % 5; // 0,1,2 fresh valid; 3 replay a used id; 4 wrong signer or expired
        bytes32 q = keccak256(abi.encode("credits", ++_nonce));
        if (mode == 3 && _usedIds.length != 0) q = _usedIds[_nonce % _usedIds.length];
        uint64 exp = uint64(_now + 120);
        uint256 key = signerKey;
        if (mode == 4) {
            if (_nonce % 2 == 0) key = strangerKey;
            else exp = uint64(_now - 1);
        }
        bytes memory sig = _creditsSig(key, address(treasury), buyer, 2, amount, q, exp);
        bool wasUsed = treasury.quoteUsed(q);
        uint256 supply = orry.totalSupply();
        vm.prank(buyer);
        try treasury.burnForCredits(2, amount, q, exp, sig) {
            if (wasUsed || mode == 4) badT5 = true;
            if (supply - orry.totalSupply() != amount) badT4 = true;
            _usedIds.push(q);
            _count("credits");
        } catch {
            if (mode < 3 && coinSet && !wasUsed) badT5 = true; // a fresh valid quote must work once the coin is set
            if (mode >= 3) _count("creditsRejected");
        }
        _checkSupply();
    }

    function verify(uint256 actorSeed, uint256 amount, uint256 mode) public {
        address payer = _actor(actorSeed);
        amount = _bound(amount, 1, 100e18);
        if (orry.balanceOf(payer) < amount) return;
        mode = mode % 4; // 0,1 fresh agent; 2 replay a used id; 3 wrong expected owner
        address agentOwner = makeAddr(string(abi.encodePacked("agentOwner", vm.toString(_nonce))));
        uint256 id = registry.register(agentOwner);
        bytes32 q = keccak256(abi.encode("verify", ++_nonce));
        if (mode == 2 && _usedIds.length != 0) q = _usedIds[_nonce % _usedIds.length];
        uint64 exp = uint64(_now + 120);
        bytes memory sig = _verificationSig(signerKey, address(treasury), payer, id, amount, q, exp);
        address expected = mode == 3 ? payer : agentOwner;
        bool wasUsed = treasury.quoteUsed(q);
        uint256 supply = orry.totalSupply();
        uint256 usdgBal = usdg.balanceOf(address(treasury));
        uint256 day = _now / 1 days;
        vm.prank(payer);
        try treasury.verifyWithOrry(id, expected, amount, q, exp, sig) {
            if (wasUsed || mode == 3) badT5 = true;
            if (supply - orry.totalSupply() != amount) badT4 = true;
            if (usdg.balanceOf(address(treasury)) != usdgBal || attestor.getVerification(id).feePaid != 0) badT4 = true;
            verificationsOnDay[day] += 1;
            if (verificationsOnDay[day] > maxVerificationsInADay) maxVerificationsInADay = verificationsOnDay[day];
            _usedIds.push(q);
            _count("verify");
        } catch {
            if (mode >= 2) _count("verifyRejected");
            else if (coinSet && !wasUsed && verificationsOnDay[day] < 25) badT5 = true;
            else if (verificationsOnDay[day] >= 25) _count("verifyCapped");
        }
        _checkSupply();
    }

    function warp(uint256 secs) public {
        secs = _bound(secs, 1, 2 days);
        _now += secs;
        vm.warp(_now);
        _count("warp");
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
