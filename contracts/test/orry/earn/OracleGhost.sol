// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {OrreryHook} from "../../../src/orry/OrreryHook.sol";
import {IOrreryHook} from "../../../src/orry/interfaces/IOrreryHook.sol";

/// @dev Independent model of the hub oracle at one-second resolution (spec 3.1, H-5 to H-7). It never reads the hook:
/// it sees only the pool tick after every action and whether that action swapped. Exact integer arithmetic.
contract OracleGhost {
    using StateLibrary for IPoolManager;

    uint256 internal constant INTERVAL = 60;
    uint256 internal constant CARD = 64;
    uint256 internal constant MAX_W = 3780;

    IPoolManager public immutable pm;
    PoolId public immutable poolId;
    address public immutable quote; // the hub this ghost follows (used by OracleCheck only)

    uint256 public gTs; // time the cumulative is brought to
    int256 public gCum; // sum of tick x seconds held, from the hub's initialization to gTs
    int256 public gTick; // pool tick since the last action

    uint256 public latestTs;
    int256 public latestCum;
    int256 public latestTick;
    uint256 public updates;

    uint256[] internal _ckTs;
    int256[] internal _ckCum;

    constructor(IPoolManager pm_, PoolId poolId_, address quote_, uint256 initTs) {
        pm = pm_;
        poolId = poolId_;
        quote = quote_;
        (, int24 t,,) = pm_.getSlot0(poolId_);
        gTs = initTs;
        gTick = t;
        latestTs = initTs;
        latestTick = t;
        _ckTs.push(initTs);
        _ckCum.push(0);
    }

    /// @dev Before an action: the tick held since the last action weights the seconds up to now.
    function before() external {
        gCum += gTick * int256(block.timestamp - gTs);
        gTs = block.timestamp;
    }

    /// @dev After an action. The first swap of a second updates `latest` with the tick held until then; a checkpoint
    /// follows when the newest one is at least 60 s old.
    function afterAction(bool swapped) external {
        require(block.timestamp == gTs, "ghost: before() not called this second");
        if (swapped && block.timestamp != latestTs) {
            latestTs = block.timestamp;
            latestCum = gCum;
            latestTick = gTick;
            ++updates;
            if (block.timestamp - _ckTs[_ckTs.length - 1] >= INTERVAL) {
                _ckTs.push(block.timestamp);
                _ckCum.push(gCum);
            }
        }
        (, int24 t,,) = pm.getSlot0(poolId);
        gTick = t;
    }

    function cumNow() public view returns (int256) {
        return gCum + gTick * int256(block.timestamp - gTs);
    }

    function checkpointCount() external view returns (uint256) {
        return _ckTs.length;
    }

    function checkpoint(uint256 i) external view returns (uint256 ts, int256 cum) {
        return (_ckTs[i], _ckCum[i]);
    }

    /// @dev Expected `consult(window)`: status 0 answers, 1 OracleNotReady, 2 OracleWindowTooLong.
    function expectConsult(uint256 window) external view returns (uint8 status, int256 mean, uint256 actual) {
        if (window == 0 || window > MAX_W) return (2, 0, 0);
        if (block.timestamp < window) return (1, 0, 0);
        uint256 target = block.timestamp - window;
        uint256 n = _ckTs.length;
        uint256 first = n > CARD ? n - CARD : 0;
        for (uint256 i = n; i > first; --i) {
            if (_ckTs[i - 1] <= target) {
                actual = block.timestamp - _ckTs[i - 1];
                int256 d = cumNow() - _ckCum[i - 1];
                mean = d / int256(actual);
                if (d < 0 && d % int256(actual) != 0) --mean;
                return (0, mean, actual);
            }
        }
        return (1, 0, 0);
    }
}

/// @dev Compares the hook with the ghost. Returns "" when they agree, else the first difference.
library OracleCheck {
    using StateLibrary for IPoolManager;

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function verify(OracleGhost g, OrreryHook h) internal view returns (string memory) {
        uint256 nowTs = vm.getBlockTimestamp();
        // H-6: latest and the running cumulative
        address qt = g.quote();
        (uint32 lts, int56 lcum, int24 ltick) = h.latestObservation(qt);
        if (lts != g.latestTs() || lcum != g.latestCum() || ltick != g.latestTick()) {
            return string.concat(
                "H-6 latest: hook ",
                vm.toString(uint256(lts)),
                " ",
                vm.toString(int256(lcum)),
                " ",
                vm.toString(int256(ltick)),
                " ghost ",
                vm.toString(g.latestTs()),
                " ",
                vm.toString(g.latestCum())
            );
        }
        (, int24 tickNow,,) = g.pm().getSlot0(g.poolId());
        if (int256(lcum) + int256(tickNow) * int256(nowTs - lts) != g.cumNow()) return "H-6 cumulative now";
        if (lts > nowTs) return "H-5 latest in the future";

        // H-5 and H-6: ring contents, order and spacing
        (uint16 newest, uint16 count) = h.observationIndex(qt);
        uint256 n = g.checkpointCount();
        uint256 c = n < 64 ? n : 64;
        if (count != c || newest != (n - 1) % 64) return "H-5 ring index";
        uint256 prevTs;
        for (uint256 k; k < c; ++k) {
            uint256 gi = n - c + k;
            (uint32 ts, int56 cum) = h.observation(qt, gi % 64);
            (uint256 gts, int256 gcum) = g.checkpoint(gi);
            if (ts != gts || cum != gcum) return string.concat("H-6 checkpoint ", vm.toString(gi));
            if (k > 0 && ts < prevTs + 60) return string.concat("H-5 spacing at ", vm.toString(gi));
            prevTs = ts;
        }
        (uint32 newestTs,) = h.observation(qt, newest);
        if (lts != newestTs && lts - newestTs >= 60) return "H-5 latest without its due checkpoint";

        // H-7: consult at fixed windows and at the edges of the newest checkpoints
        uint32[11] memory fixedW = [uint32(0), 1, 2, 59, 60, 61, 300, 1800, 3779, 3780, 3781];
        for (uint256 i; i < fixedW.length; ++i) {
            string memory bad = _consult(g, h, fixedW[i]);
            if (bytes(bad).length != 0) return bad;
        }
        for (uint256 k; k < 4 && k < c; ++k) {
            (uint256 gts,) = g.checkpoint(n - 1 - k);
            if (gts >= nowTs || nowTs - gts > 3780) continue;
            string memory bad = _consult(g, h, uint32(nowTs - gts));
            if (bytes(bad).length != 0) return bad;
            bad = _consult(g, h, uint32(nowTs - gts + 1));
            if (bytes(bad).length != 0) return bad;
        }
        return "";
    }

    /// @dev Status 0 answered, 1 OracleNotReady, 2 OracleWindowTooLong, 3 any other revert (never allowed).
    function consultStatus(OrreryHook h, address qt, uint32 w)
        internal
        view
        returns (uint8 status, int24 mean, uint32 actual)
    {
        try h.consult(qt, w) returns (int24 m, uint32 a) {
            return (0, m, a);
        } catch (bytes memory err) {
            bytes4 sel = err.length >= 4 ? bytes4(err) : bytes4(0);
            if (sel == IOrreryHook.OracleNotReady.selector) return (1, 0, 0);
            if (sel == IOrreryHook.OracleWindowTooLong.selector) return (2, 0, 0);
            return (3, 0, 0);
        }
    }

    function _consult(OracleGhost g, OrreryHook h, uint32 w) private view returns (string memory) {
        (uint8 st, int24 m, uint32 a) = consultStatus(h, g.quote(), w);
        (uint8 gst, int256 gm, uint256 ga) = g.expectConsult(w);
        if (st != gst || (st == 0 && (m != gm || a != ga))) {
            return string.concat(
                "H-7 consult window ",
                vm.toString(uint256(w)),
                ": hook ",
                vm.toString(uint256(st)),
                " ",
                vm.toString(int256(m)),
                " ",
                vm.toString(uint256(a)),
                " ghost ",
                vm.toString(uint256(gst)),
                " ",
                vm.toString(gm),
                " ",
                vm.toString(ga)
            );
        }
        if (st == 0 && a < w) return "H-7 actualWindow below window";
        return "";
    }
}
