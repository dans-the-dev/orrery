// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {MerchantSplitterFactory} from "../../src/facilitator/MerchantSplitterFactory.sol";
import {DataFeeSplitter} from "../../src/data/DataFeeSplitter.sol";
import {DataProviderRegistry} from "../../src/data/DataProviderRegistry.sol";
import {DataOrry, DataStakeValue, DataTreasury, RefusingPool} from "./DataMocks.sol";

/// @notice Bounded actions on the splitter and the registry, with ghost books (`docs/updates/L2-DATA-MCP-SPEC.md` 3).
contract DataHandler is Test {
    DataOrry public orry;
    DataTreasury public treasury;
    DataFeeSplitter public splitter;
    RefusingPool public pool;
    DataStakeValue public stake;
    MerchantSplitterFactory public factory;
    DataProviderRegistry public reg;
    address public owner = address(0xA11CE);
    uint256 public constant MIN = 100_000_000;
    uint256 public clock = 1_800_000_000;

    // ghost books
    uint256 public paid;
    uint256 public burned;
    uint256 public splits;
    uint256 public fundings;
    uint256 public proposedAt;
    address public proposed;
    address public firstPool;
    uint256 public poolSetAt;
    bool public splitRuleBroken;
    address[4] public actors;
    mapping(address => bool) public ghostListed;
    uint256 public ghostListedCount;
    uint256 public listings;

    constructor() {
        vm.warp(clock);
        orry = new DataOrry();
        treasury = new DataTreasury(owner);
        splitter = new DataFeeSplitter(address(orry), address(treasury));
        pool = new RefusingPool(address(orry));
        stake = new DataStakeValue();
        DataOrry usdg = new DataOrry();
        factory = new MerchantSplitterFactory(100, address(usdg), address(orry), address(treasury), address(0));
        reg = new DataProviderRegistry(address(stake), address(factory), MIN);
        actors = [address(0xB0B1), address(0xB0B2), address(0xB0B3), address(0xB0B4)];
    }

    function pay(uint96 a) public {
        a = uint96(bound(a, 1, 1e27));
        orry.mint(address(splitter), a);
        paid += a;
    }

    function split() public {
        uint256 bal = orry.balanceOf(address(splitter));
        uint256 owed = splitter.poolOwed();
        uint256 fresh = bal - owed;
        bool sendable = splitter.pool() != address(0) && (owed + fresh - fresh * 7000 / 10000) != 0;
        if (fresh == 0 && !sendable) return;
        uint256 supply = orry.totalSupply();
        uint256 poolBefore = orry.balanceOf(address(pool));
        (uint256 b, uint256 tp) = splitter.split();
        uint256 burnt = supply - orry.totalSupply();
        if (b != fresh * 7000 / 10000 || burnt != b || tp != fresh - b) splitRuleBroken = true;
        burned += burnt;
        ++splits;
        if (orry.balanceOf(address(pool)) > poolBefore) ++fundings;
    }

    function togglePool(bool refuse) public {
        pool.setRefuse(refuse);
    }

    function propose() public {
        if (splitter.pool() != address(0)) return;
        vm.prank(owner);
        splitter.proposePool(address(pool));
        proposed = address(pool);
        proposedAt = clock;
    }

    function execute() public {
        if (splitter.pool() != address(0) || proposed == address(0)) return;
        vm.prank(owner);
        try splitter.executePool() {
            firstPool = splitter.pool();
            poolSetAt = clock;
        } catch {}
    }

    function strangerExecute(uint256 who) public {
        address s = address(uint160(bound(who, 1, type(uint160).max)));
        if (s == owner) return;
        vm.prank(s);
        try splitter.executePool() {
            firstPool = address(0xDEAD); // never expected: flags DS-5
        } catch {}
    }

    function warp(uint32 dt) public {
        clock += bound(dt, 1, 30 hours);
        vm.warp(clock);
    }

    function setStake(uint256 who, uint256 v) public {
        stake.set(actors[who % 4], bound(v, 0, MIN * 3));
    }

    function list(uint256 who) public {
        address a = actors[who % 4];
        vm.prank(a);
        try reg.list("https://data.example.org/feed", "Feed", "", 1000) {
            ghostListed[a] = true;
            ++ghostListedCount;
            ++listings;
        } catch {}
    }

    function unlist(uint256 who) public {
        address a = actors[who % 4];
        vm.prank(a);
        try reg.unlist() {
            ghostListed[a] = false;
            --ghostListedCount;
        } catch {}
    }

    function update(uint256 who, uint256 price) public {
        address a = actors[who % 4];
        vm.prank(a);
        try reg.update("https://data.example.org/v2", "Feed Two", "x", bound(price, 1, 1e12)) {} catch {}
    }
}

/// @notice Invariants DS-2 to DS-5, DR-2 and DR-6 under random action sequences, plus a deterministic deep run.
contract DataInvariantsTest is Test {
    DataHandler h;

    function setUp() public {
        h = new DataHandler();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](12);
        sel[0] = DataHandler.pay.selector;
        sel[1] = DataHandler.split.selector;
        sel[2] = DataHandler.split.selector;
        sel[3] = DataHandler.togglePool.selector;
        sel[4] = DataHandler.propose.selector;
        sel[5] = DataHandler.execute.selector;
        sel[6] = DataHandler.warp.selector;
        sel[7] = DataHandler.setStake.selector;
        sel[8] = DataHandler.list.selector;
        sel[9] = DataHandler.unlist.selector;
        sel[10] = DataHandler.update.selector;
        sel[11] = DataHandler.strangerExecute.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function _check() internal view {
        DataFeeSplitter s = h.splitter();
        uint256 bal = h.orry().balanceOf(address(s));
        uint256 poolBal = h.orry().balanceOf(address(h.pool()));
        // DS-2: everything paid is burned, in the pool, or still in the splitter
        assertEq(h.paid(), h.burned() + poolBal + bal, "DS-2 conservation");
        // DS-3
        assertGe(bal, s.poolOwed(), "DS-3 balance covers the booking");
        // DS-1 per split
        assertFalse(h.splitRuleBroken(), "DS-1 exact 70% burn");
        // DS-4: no ORRY reaches a pool before one is set
        if (s.pool() == address(0)) assertEq(poolBal, 0, "DS-4 nothing leaves before the pool is set");
        // DS-5: set once, by the owner, not before 48 h after the proposal it executed
        if (s.pool() != address(0)) {
            assertEq(s.pool(), h.firstPool(), "DS-5 the pool never changes and no stranger set it");
            assertGe(h.poolSetAt(), h.proposedAt() + 48 hours, "DS-5 48 hour delay");
        }
        // DR-2, DR-6
        DataProviderRegistry reg = h.reg();
        assertEq(reg.providerCount(), h.ghostListedCount(), "DR-6 count");
        for (uint256 i; i < 4; ++i) {
            address a = h.actors(i);
            assertEq(reg.isListed(a), h.ghostListed(a), "listing books");
            assertEq(reg.isActive(a), h.ghostListed(a) && h.stake().usd(a) >= h.MIN(), "DR-2 active iff listed and staked");
        }
    }

    function invariant_data() public view {
        _check();
    }

    /// @dev Deterministic deep run: 4,000 weighted actions from a fixed seed, every invariant checked every 50 steps.
    function test_deep_run() public {
        uint256 seed = uint256(keccak256("orrery-data-l2"));
        for (uint256 i; i < 4000; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 r = seed % 100;
            uint256 x = seed >> 8;
            if (r < 22) h.pay(uint96(x));
            else if (r < 44) h.split();
            else if (r < 48) h.togglePool(x % 3 == 0);
            else if (r < 52) h.propose();
            else if (r < 58) h.execute();
            else if (r < 70) h.warp(uint32(x));
            else if (r < 78) h.setStake(x, x >> 32);
            else if (r < 86) h.list(x);
            else if (r < 90) h.unlist(x);
            else if (r < 96) h.update(x, x >> 40);
            else h.strangerExecute(x);
            if (i % 50 == 0) _check();
        }
        _check();
        console2.log("splits", h.splits());
        console2.log("pool fundings", h.fundings());
        console2.log("listings", h.listings());
        console2.log("pool set", h.splitter().pool() != address(0) ? 1 : 0);
        assertGt(h.splits(), 100, "the run splits");
        assertGt(h.fundings(), 0, "the run funds the pool");
        assertGt(h.listings(), 5, "the run lists providers");
        assertTrue(h.splitter().pool() != address(0), "the run sets the pool");
        assertGt(h.burned(), 0);
    }
}
