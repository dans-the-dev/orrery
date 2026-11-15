// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {OrreryHook} from "../../../../src/orry/OrreryHook.sol";
import {EarnVaultHarness} from "../EarnBase.sol";
import {MockOrry, MockUsdg, MockRouter, HubActor} from "../mocks/EarnMocks.sol";
import {OracleGhost, OracleCheck} from "../OracleGhost.sol";

/// @dev Bounded actions on one hub and its Earn vault, with ghost state for spec section 4 (H-1 to H-3, H-5 to H-8,
/// E-1 to E-6, G-2, P-3, P-4) per hub. Every action keeps going on a revert; flags record anything that must never
/// happen. Every action runs between the oracle ghost's `before` and `afterAction`, and checks that the other hub's
/// record, observations and price did not move (P-3). Amounts are drawn in ETH terms and scaled to the quote.
contract EarnHandler is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable pm;
    EarnVaultHarness public immutable vault;
    OrreryHook public immutable hook;
    MockOrry public immutable orry;
    MockUsdg public immutable usdg;
    MockRouter public immutable router;
    HubActor public immutable trader;
    HubActor public immutable jit;
    address public immutable quote;
    bool public immutable isEth;
    bool public immutable orryIs0;
    uint256 public immutable quotePerEth;
    PoolKey internal key;
    PoolId internal poolId;
    uint256 public immutable initialSupply;
    OracleGhost public immutable ghost;
    address public otherQuote;
    bool public otherSet;

    address[4] internal actors;

    // counters
    uint256 public nDeposits;
    uint256 public nZaps;
    uint256 public nWithdrawals;
    uint256 public nLockedRejects;
    uint256 public nHarvests;
    uint256 public nClaims;
    uint256 public nSwaps;
    uint256 public nCollects;
    uint256 public nDonations;
    uint256 public nPoolDonations;
    uint256 public nJit;
    uint256 public nWarps;
    uint256 public nShortWarps;
    uint256 public nPushRestores;
    uint256 public nNotifies;
    uint256 public vaultCalls; // successful state-changing vault calls, bounds the rounding dust

    // ghosts
    uint256 public donatedQuote;
    uint256 public donatedOrry;

    // flags
    bool public h1Broken;
    bool public h2Broken;
    bool public h3Broken;
    bool public e2Broken;
    bool public e5Broken;
    bool public e6Broken;
    bool public claimBlocked;
    bool public h5Broken;
    bool public h8Broken;
    bool public p3Broken;
    bool public e7Broken;

    uint256 private _depth;
    bool private _swapped;

    constructor(
        IPoolManager pm_,
        EarnVaultHarness vault_,
        OrreryHook hook_,
        MockUsdg usdg_,
        MockRouter router_,
        HubActor trader_,
        HubActor jit_,
        address[4] memory actors_,
        uint256 quotePerEth_
    ) {
        pm = pm_;
        vault = vault_;
        hook = hook_;
        orry = MockOrry(hook_.orry());
        usdg = usdg_;
        router = router_;
        trader = trader_;
        jit = jit_;
        actors = actors_;
        quote = vault_.quote();
        isEth = quote == address(0);
        orryIs0 = hook_.pairOf(quote).orryIsCurrency0;
        quotePerEth = quotePerEth_;
        key = hook_.hubKey(quote);
        poolId = key.toId();
        initialSupply = orry.totalSupply();
        ghost = new OracleGhost(pm_, poolId, quote, vm.getBlockTimestamp());
    }

    function setOther(address other) external {
        otherQuote = other;
        otherSet = true;
    }

    /// @dev Outermost action only: ghost bookkeeping around it; H-5's "at most one update of `latest` per second"
    /// (once `latest` carries this second, nothing in this hub's oracle may change until the clock moves); P-3 (the
    /// other hub's record, observations and price never move on this hub's actions).
    modifier observed() {
        bool outer = _depth == 0;
        bytes memory before;
        bytes32 otherBefore;
        bool sameSecond;
        if (outer) {
            ghost.before();
            _swapped = false;
            (uint32 ts,,) = hook.latestObservation(quote);
            sameSecond = ts == vm.getBlockTimestamp();
            before = _oracleRaw(quote);
            if (otherSet) otherBefore = keccak256(_hubRaw(otherQuote));
        }
        ++_depth;
        _;
        --_depth;
        if (outer) {
            ghost.afterAction(_swapped);
            bytes memory afterwards = _oracleRaw(quote);
            if (sameSecond && keccak256(afterwards) != keccak256(before)) h5Broken = true;
            (uint32 ts,,) = hook.latestObservation(quote);
            if (keccak256(afterwards) != keccak256(before) && ts != vm.getBlockTimestamp()) h5Broken = true;
            if (otherSet && keccak256(_hubRaw(otherQuote)) != otherBefore) p3Broken = true;
        }
    }

    /// @dev The hub's observations: latest, ring position and newest checkpoint.
    function _oracleRaw(address q_) internal view returns (bytes memory) {
        (uint32 ts, int56 cum, int24 t) = hook.latestObservation(q_);
        (uint16 newest, uint16 count) = hook.observationIndex(q_);
        (uint32 cts, int56 ccum) = hook.observation(q_, newest);
        return abi.encode(ts, cum, t, newest, count, cts, ccum);
    }

    /// @dev Everything a swap in that hub could move: observations, start-of-block record and live price (P-3).
    function _hubRaw(address q_) internal view returns (bytes memory) {
        (uint160 sp, uint64 bn) = hook.startOfBlockSqrtPriceX96(q_);
        (uint160 live,,,) = pm.getSlot0(hook.pairOf(q_).poolId);
        return abi.encode(_oracleRaw(q_), sp, bn, live);
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    // ---------------------------------------------------------------- vault actions

    function deposit(uint256 seed, uint256 ethRaw, uint256 ratioRaw) public observed {
        address a = actors[seed % 4];
        uint256 qa = _q(_bound(ethRaw, 0.001 ether, 20 ether));
        uint256 orryMax = _orryFor(qa) * _bound(ratioRaw, 50, 200) / 100;
        _giveQuote(a, qa);
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(a);
        try vault.deposit{value: isEth ? qa : 0}(qa, orryMax, 0, 0, type(uint160).max, ts) {
            ++nDeposits;
            ++vaultCalls;
        } catch {}
    }

    function zap(uint256 seed, bool fromQuote, uint256 raw) public observed {
        if (vault.totalShares() == 0) return;
        address a = actors[seed % 4];
        (uint256 pq,) = vault.positionAmounts();
        uint256 qa = _bound(raw, _q(0.001 ether), pq / 10 + _q(0.001 ether));
        uint256 ts = vm.getBlockTimestamp();
        if (fromQuote) {
            _giveQuote(a, qa);
            vm.prank(a);
            try vault.zapDeposit{value: isEth ? qa : 0}(true, qa, 0, 0, 0, type(uint160).max, ts) {
                _swapped = true;
                ++nZaps;
                ++vaultCalls;
            } catch {}
        } else {
            uint256 amount = _orryFor(qa);
            vm.prank(a);
            try vault.zapDeposit(false, amount, 0, 0, 0, type(uint160).max, ts) {
                _swapped = true;
                ++nZaps;
                ++vaultCalls;
            } catch {}
        }
    }

    function withdraw(uint256 seed, uint256 fracRaw) public observed {
        address a = actors[seed % 4];
        uint256 held = vault.sharesOf(a);
        if (held == 0) return;
        uint256 shares = held * _bound(fracRaw, 1, 100) / 100;
        if (shares == 0) shares = held;
        uint256 ts = vm.getBlockTimestamp();
        if (ts < vault.unlockAt(a)) {
            vm.prank(a);
            try vault.withdraw(shares, 0, 0, ts) {
                e5Broken = true; // E-5: locked shares can never leave
            } catch {
                ++nLockedRejects;
            }
            return;
        }
        (uint256 pq, uint256 pr) = vault.previewWithdraw(shares);
        vm.prank(a);
        try vault.withdraw(shares, 0, 0, ts) returns (uint256 qOut, uint256 rOut) {
            ++nWithdrawals;
            ++vaultCalls;
            if (qOut != pq || rOut != pr) e2Broken = true; // E-2: exactly the pro-rata liquidity, rounded down
        } catch {
            claimBlocked = true; // an unlocked withdrawal by an EOA must never fail
        }
    }

    function harvest() public observed {
        try vault.harvest() returns (uint256, uint256) {
            ++nHarvests;
            ++vaultCalls;
        } catch {}
    }

    function claim(uint256 seed, uint256 callerSeed, bool viaClaimFor) public observed {
        address a = actors[seed % 4];
        vm.prank(viaClaimFor ? actors[callerSeed % 4] : a);
        if (viaClaimFor) {
            try vault.claimFor(a) {
                ++nClaims;
                ++vaultCalls;
            } catch {
                claimBlocked = true; // E-5: claims can never be stopped
            }
        } else {
            try vault.claimFees() {
                ++nClaims;
                ++vaultCalls;
            } catch {
                claimBlocked = true;
            }
        }
    }

    // ---------------------------------------------------------------- pool actions

    /// @dev `zeroForOne` in pool terms; the size is drawn in quote units up to a third of the position's quote.
    function swap(bool zeroForOne, bool exactIn, uint256 raw) public observed {
        if (pm.getLiquidity(poolId) == 0) return;
        (uint256 pq,) = vault.positionAmounts();
        if (pq < _q(0.01 ether)) return;
        uint256 qSize = _bound(raw, _q(1e9) + 1, pq / 3);
        bool specifiedIs0 = zeroForOne == exactIn;
        bool specifiedIsQuote = specifiedIs0 != orryIs0;
        uint256 amount = specifiedIsQuote ? qSize : _orryFor(qSize);
        Currency unspecified = specifiedIs0 ? key.currency1 : key.currency0;
        uint256 before = _claims(Currency.unwrap(unspecified));
        try trader.swap(key, zeroForOne, exactIn ? -int256(amount) : int256(amount)) returns (BalanceDelta d) {
            _swapped = true;
            ++nSwaps;
            uint256 fee = _claims(Currency.unwrap(unspecified)) - before;
            int128 u = specifiedIs0 ? d.amount1() : d.amount0();
            uint256 poolAbs = u > 0 ? uint256(int256(u)) + fee : uint256(-int256(u)) - fee;
            if (fee != poolAbs * 1500 / 1e6) h2Broken = true; // H-2
        } catch {}
    }

    function poolDonate(uint256 raw) public observed {
        if (pm.getLiquidity(poolId) == 0) return;
        uint256 qa = _bound(raw, 1, _q(0.05 ether) + 1);
        (uint256 d0, uint256 d1) = orryIs0 ? (_orryFor(qa), qa) : (qa, _orryFor(qa));
        try trader.donate(key, d0, d1) {
            ++nPoolDonations;
        } catch {}
    }

    /// @dev Outside LP adds a narrow range around the price, a swap goes through, the LP leaves (JIT).
    function jitAround(uint256 raw) public observed {
        if (pm.getLiquidity(poolId) == 0) return;
        (, int24 tick,,) = pm.getSlot0(poolId);
        int24 lo = (tick / 200) * 200 - 400;
        int24 hi = lo + 800;
        if (lo < -887200 || hi > 887200) return;
        uint256 ts = vault.totalShares();
        if (ts == 0) return;
        // relative to the vault's full-range liquidity, so the JIT's narrow range costs a few percent of the position
        int256 liq = int256(_bound(raw, ts / 10 + 1, ts * 5 + 1));
        try jit.modify(key, lo, hi, liq, bytes32(0)) {
            swap(raw % 2 == 0, true, raw);
            try jit.modify(key, lo, hi, -liq, bytes32(0)) {
                ++nJit;
            } catch {}
        } catch {}
    }

    /// @dev H-3 and P-4 for every currency of every hub: the router receives exactly the pending claims.
    function collect() public observed {
        address[3] memory cur = [address(orry), address(0), address(usdg)];
        uint256[3] memory pending;
        uint256[3] memory before;
        for (uint256 i; i < 3; ++i) {
            pending[i] = hook.pendingProtocolFee(cur[i]);
            before[i] = _bal(cur[i], address(router));
        }
        try hook.collect() {
            ++nCollects;
            for (uint256 i; i < 3; ++i) {
                if (_bal(cur[i], address(router)) - before[i] != pending[i]) h3Broken = true;
                if (hook.pendingProtocolFee(cur[i]) != 0 || _bal(cur[i], address(hook)) != 0) h3Broken = true;
            }
        } catch {
            h3Broken = true; // collect must always work
        }
    }

    function initializeOther(uint24 fee, int24 spacing) public observed {
        PoolKey memory k = key;
        k.fee = uint24(_bound(fee, 0, 1_000_000));
        k.tickSpacing = int24(_bound(spacing, 1, 16_384));
        try pm.initialize(k, uint160(TickMath.MIN_SQRT_PRICE) * 1000) {
            h1Broken = true; // H-1 and P-1: only the registered key of a registered pair
        } catch {}
    }

    /// @dev H-8: a push of up to 4055 ticks restored exactly in the same block, after this second's `latest` update,
    /// changes nothing the oracle exposes, consult included.
    function pushRestore(uint256 raw, bool up) public observed {
        if (pm.getLiquidity(poolId) == 0) return;
        (uint32 lts,,) = hook.latestObservation(quote);
        if (lts != vm.getBlockTimestamp()) {
            try trader.swap(key, true, -int256(orryIs0 ? 1e9 : _q(1e9) + 1)) {
                _swapped = true;
            } catch {
                return;
            }
        }
        (uint160 p0, int24 t0,,) = pm.getSlot0(poolId);
        bytes memory before = _oracleFull();
        int24 k = int24(int256(_bound(raw, 1, 4055)));
        int24 target = up ? t0 + k : t0 - k;
        if (target <= TickMath.MIN_TICK || target >= TickMath.MAX_TICK) return;
        uint160 limit = TickMath.getSqrtPriceAtTick(target);
        // up sells currency1, down sells currency0; half of the trader's balance at most
        try trader.swapTo(key, !up, -int256(_budget(up)), limit) {
            _swapped = true;
        } catch {
            return;
        }
        try trader.swapTo(key, up, -int256(_budget(!up)), p0) {} catch {}
        (uint160 p1,,,) = pm.getSlot0(poolId);
        if (p1 != p0) return; // the trader could not restore: an ordinary price move, which the ghost follows
        ++nPushRestores;
        if (keccak256(_oracleFull()) != keccak256(before)) h8Broken = true;
    }

    function _budget(bool sellCurrency1) internal view returns (uint256) {
        bool orrySide = sellCurrency1 != orryIs0;
        return orrySide ? orry.balanceOf(address(trader)) / 2 : _bal(quote, address(trader)) / 2;
    }

    function _oracleFull() internal view returns (bytes memory s) {
        s = _oracleRaw(quote);
        (uint16 newest, uint16 count) = hook.observationIndex(quote);
        for (uint256 i; i < count; ++i) {
            (uint32 cts, int56 ccum) = hook.observation(quote, (uint256(newest) + 64 - i) % 64);
            s = abi.encodePacked(s, cts, ccum);
        }
        uint32[5] memory ws = [uint32(1), 60, 600, 1800, 3780];
        for (uint256 i; i < ws.length; ++i) {
            (uint8 st, int24 m, uint32 a) = OracleCheck.consultStatus(hook, quote, ws[i]);
            s = abi.encodePacked(s, st, m, a);
        }
    }

    // ---------------------------------------------------------------- outside value and time

    /// @dev E-7: notified ORRY goes to shares only: at the notify second no account's principal preview or pending fees
    /// move (the new rate streams from now), and the exit check later finds it all paid out to holders.
    function notifyRewards(uint256 raw) public observed {
        uint256 held = orry.balanceOf(address(this));
        if (held == 0) return;
        uint256 r = _bound(raw, 1, held < 1e24 ? held : 1e24);
        uint256[4][4] memory before = _snapshot();
        orry.approve(address(vault), r);
        try vault.notifyRewards(r) {
            ++nNotifies;
        } catch {
            e7Broken = true; // anyone can always notify a positive amount they hold
            return;
        }
        uint256[4][4] memory afterwards = _snapshot();
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 4; ++j) {
                if (before[i][j] != afterwards[i][j]) e7Broken = true;
            }
        }
    }

    /// @dev E-6: quote and ORRY pushed at the vault never change what any account can withdraw or claim.
    function donateToVault(uint256 rawQ, uint256 rawR) public observed {
        uint256 qa = _bound(rawQ, 0, _q(1 ether));
        uint256 held = orry.balanceOf(address(this));
        uint256 r = _bound(rawR, 0, held < 1e24 ? held : 1e24);
        uint256[4][4] memory before = _snapshot();
        orry.transfer(address(vault), r);
        _giveQuote(address(vault), qa);
        donatedQuote += qa;
        donatedOrry += r;
        ++nDonations;
        uint256[4][4] memory afterwards = _snapshot();
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 4; ++j) {
                if (before[i][j] != afterwards[i][j]) e6Broken = true;
            }
        }
    }

    function warp(uint256 raw) public {
        vm.warp(vm.getBlockTimestamp() + _bound(raw, 1 minutes, 3 days));
        vm.roll(vm.getBlockNumber() + 1);
        ++nWarps;
    }

    /// @dev Seconds-scale time, so ticks are held for seconds and checkpoints meet their 60 s spacing.
    function warpSeconds(uint256 raw) public {
        vm.warp(vm.getBlockTimestamp() + _bound(raw, 1, 90));
        if (raw % 3 == 0) vm.roll(vm.getBlockNumber() + 1);
        ++nShortWarps;
    }

    function roll() public {
        vm.roll(vm.getBlockNumber() + 1);
    }

    // ---------------------------------------------------------------- checks

    /// @dev E-2 at the end of a run: every account exits after its lock in seed order; each gets exactly its
    /// pro-rata principal, the sum never exceeds the position, and every streamed fee is claimable.
    function exitAll(uint256 seed) external {
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.roll(vm.getBlockNumber() + 1);
        (uint256 totalQ, uint256 totalR) = vault.positionAmounts();
        uint256 sumQ;
        uint256 sumR;
        for (uint256 k; k < 4; ++k) {
            address a = actors[(seed + k) % 4];
            uint256 held = vault.sharesOf(a);
            if (held != 0) {
                (uint256 pq, uint256 pr) = vault.previewWithdraw(held);
                uint256 ts = vm.getBlockTimestamp();
                vm.prank(a);
                (uint256 qOut, uint256 rOut) = vault.withdraw(held, 0, 0, ts);
                require(qOut == pq && rOut == pr, "E-2 exit amount");
                sumQ += qOut;
                sumR += rOut;
            }
        }
        require(sumQ <= totalQ && sumR <= totalR, "E-2 sum exceeds position");
        require(vault.totalShares() == 0, "shares left");
        for (uint256 k; k < 4; ++k) {
            vm.prank(actors[k]);
            vault.claimFees();
            (uint256 q0, uint256 q1) = vault.pendingFees(actors[k]);
            require(q0 == 0 && q1 == 0, "fees left after claim");
        }
        // Rewards of the zero-share time wait for the next depositor: one more deposit collects all of them. The
        // depositor is the actor holding the most ORRY (zaps and deposits may have spent another actor's balance).
        address next = actors[seed % 4];
        for (uint256 k; k < 4; ++k) {
            if (orry.balanceOf(actors[k]) > orry.balanceOf(next)) next = actors[k];
        }
        uint256 qa = _q(0.01 ether);
        _giveQuote(next, qa);
        uint256 orryMax = _orryFor(qa) * 2; // computed before the prank, which the next call consumes
        require(orry.balanceOf(next) >= orryMax, "exit: no actor holds enough ORRY for the final deposit");
        uint256 t1 = vm.getBlockTimestamp();
        vm.prank(next);
        uint256 s = vault.deposit{value: isEth ? qa : 0}(qa, orryMax, 0, 0, type(uint160).max, t1);
        vm.warp(vm.getBlockTimestamp() + 8 days);
        vm.roll(vm.getBlockNumber() + 1);
        uint256 t2 = vm.getBlockTimestamp();
        vm.prank(next);
        vault.withdraw(s, 0, 0, t2);
        vaultCalls += 2;
    }

    function _snapshot() internal view returns (uint256[4][4] memory s) {
        for (uint256 i; i < 4; ++i) {
            address a = actors[i];
            (s[i][0], s[i][1]) = vault.previewWithdraw(vault.sharesOf(a));
            (s[i][2], s[i][3]) = vault.pendingFees(a);
        }
    }

    function _claims(address currency) internal view returns (uint256) {
        return pm.balanceOf(address(hook), uint256(uint160(currency)));
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return token == address(0) ? who.balance : MockUsdg(token).balanceOf(who);
    }

    function _giveQuote(address a, uint256 amount) internal {
        if (isEth) vm.deal(a, a.balance + amount);
        else usdg.mint(a, amount);
    }

    function _q(uint256 ethWei) internal view returns (uint256) {
        return ethWei * quotePerEth / 1e18;
    }

    /// @dev ORRY worth `qa` of the quote at the current price.
    function _orryFor(uint256 qa) internal view returns (uint256) {
        (uint160 p,,,) = pm.getSlot0(poolId);
        if (orryIs0) return FullMath.mulDiv(FullMath.mulDiv(qa, 1 << 96, p), 1 << 96, p);
        return FullMath.mulDiv(FullMath.mulDiv(qa, p, 1 << 96), p, 1 << 96);
    }
}
