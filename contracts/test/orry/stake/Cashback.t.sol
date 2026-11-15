// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";

import {IOrryBuyback} from "../../../src/orry/interfaces/IOrryBuyback.sol";
import {BuybackBase} from "./utils/StakeBase.sol";

/// @notice B-1 (R-45, `docs/ORRY-UPGRADE-PATHS.md`): the cashback sink is proposed by the treasury owner (read live),
/// set once after CASHBACK_DELAY, and from then on takes CASHBACK_BPS of the ORRY that `executeSlice` and
/// `buyWithQuote` buy; before that the router gets all of it; `burnEth` output is always burned whole.
contract CashbackTest is BuybackBase {
    address internal sink = makeAddr("cashbackSink");

    function setUp() public override {
        super.setUp();
        _setCoin(address(buyback));
        _revenue(10_000e6);
    }

    function _setSink() internal {
        vm.prank(owner);
        buyback.proposeCashbackSink(sink);
        vm.warp(_now() + 48 hours);
        vm.prank(owner);
        buyback.executeCashbackSink();
    }

    function _cashbackEvent() internal returns (bool seen, address to, uint256 amount) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(buyback) && logs[i].topics[0] == IOrryBuyback.CashbackPaid.selector) {
                seen = true;
                to = address(uint160(uint256(logs[i].topics[1])));
                amount = abi.decode(logs[i].data, (uint256));
            }
        }
    }

    function test_defaults() public view {
        assertEq(buyback.CASHBACK_BPS(), 1000);
        assertEq(buyback.CASHBACK_DELAY(), 48 hours);
        assertEq(buyback.cashbackSink(), address(0));
        (address p, uint64 at) = buyback.pendingCashbackSink();
        assertEq(p, address(0));
        assertEq(at, 0);
    }

    function test_unset_sink_sends_everything_to_the_router() public {
        uint256 r0 = orry.balanceOf(address(router));
        vm.recordLogs();
        uint256 out = buyback.executeSlice();
        (bool seen,,) = _cashbackEvent();
        assertFalse(seen, "no cashback before the sink is set");
        assertEq(orry.balanceOf(address(router)) - r0, out);
        assertEq(orry.balanceOf(sink), 0);
    }

    function test_propose_execute_rules() public {
        vm.prank(alice);
        vm.expectRevert(IOrryBuyback.NotTreasuryOwner.selector);
        buyback.proposeCashbackSink(sink);
        vm.prank(owner);
        vm.expectRevert(bytes("zero sink"));
        buyback.proposeCashbackSink(address(0));
        vm.prank(owner);
        vm.expectRevert(IOrryBuyback.NoCashbackProposal.selector);
        buyback.executeCashbackSink();

        uint64 at = uint64(_now() + 48 hours);
        vm.expectEmit(address(buyback));
        emit IOrryBuyback.CashbackSinkProposed(makeAddr("first"), at);
        vm.prank(owner);
        buyback.proposeCashbackSink(makeAddr("first"));
        // a new proposal replaces the pending one and restarts the delay
        vm.warp(_now() + 1 hours);
        vm.prank(owner);
        buyback.proposeCashbackSink(sink);
        (address p, uint64 pAt) = buyback.pendingCashbackSink();
        assertEq(p, sink);
        assertEq(pAt, _now() + 48 hours);

        vm.warp(pAt - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IOrryBuyback.CashbackNotReady.selector, pAt));
        buyback.executeCashbackSink();
        vm.warp(pAt);
        vm.prank(alice);
        vm.expectRevert(IOrryBuyback.NotTreasuryOwner.selector);
        buyback.executeCashbackSink();
        vm.expectEmit(address(buyback));
        emit IOrryBuyback.CashbackSinkSet(sink);
        vm.prank(owner);
        buyback.executeCashbackSink();
        assertEq(buyback.cashbackSink(), sink);
        (p, pAt) = buyback.pendingCashbackSink();
        assertEq(p, address(0));
        assertEq(pAt, 0);

        // set once: nothing changes it
        vm.prank(owner);
        vm.expectRevert(IOrryBuyback.CashbackSinkAlreadySet.selector);
        buyback.proposeCashbackSink(makeAddr("other"));
        vm.prank(owner);
        vm.expectRevert(IOrryBuyback.CashbackSinkAlreadySet.selector);
        buyback.executeCashbackSink();
    }

    function test_the_owner_is_read_live_from_the_treasury() public {
        address next = makeAddr("nextOwner");
        vm.prank(owner);
        treasury.transferOwnership(next);
        vm.prank(next);
        treasury.acceptOwnership();
        vm.prank(owner);
        vm.expectRevert(IOrryBuyback.NotTreasuryOwner.selector);
        buyback.proposeCashbackSink(sink);
        vm.prank(next);
        buyback.proposeCashbackSink(sink);
    }

    function test_exact_split_on_the_eth_path_slice() public {
        _setSink();
        uint256 r0 = orry.balanceOf(address(router));
        vm.recordLogs();
        uint256 out = buyback.executeSlice();
        uint256 cb = out * 1000 / 10_000;
        assertGt(cb, 0);
        assertEq(orry.balanceOf(sink), cb, "10% to the sink, rounded down");
        assertEq(orry.balanceOf(address(router)) - r0, out - cb, "the rest to the router");
        assertEq(orry.balanceOf(address(buyback)), 0);
        (bool seen, address to, uint256 amount) = _cashbackEvent();
        assertTrue(seen);
        assertEq(to, sink);
        assertEq(amount, cb);
    }

    function test_exact_split_on_the_direct_slice_and_quote_buys() public {
        _initUsdgHub(4e18);
        _setSink();
        assertTrue(buyback.sliceViaUsdgHub());
        uint256 out = buyback.executeSlice();
        uint256 cb = out * 1000 / 10_000;
        assertEq(orry.balanceOf(sink), cb);
        assertEq(orry.balanceOf(address(router)), out - cb);

        usdg.mint(address(buyback), 200e6);
        vm.roll(vm.getBlockNumber() + 1);
        uint256 qOut = buyback.buyWithQuote(address(usdg));
        uint256 qCb = qOut * 1000 / 10_000;
        assertEq(orry.balanceOf(sink), cb + qCb);
        assertEq(orry.balanceOf(address(router)), out - cb + qOut - qCb);
    }

    function test_burn_eth_output_is_burned_whole_with_the_sink_set() public {
        _setSink();
        vm.deal(address(buyback), 1 ether);
        uint256 supply = orry.totalSupply();
        uint256 burned = buyback.burnEth();
        assertEq(supply - orry.totalSupply(), burned);
        assertEq(orry.balanceOf(sink), 0);
    }
}
