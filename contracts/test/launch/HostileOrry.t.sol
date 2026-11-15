// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAgentLaunch} from "../../src/launch/interfaces/IAgentLaunch.sol";
import {LaunchBase} from "./utils/LaunchBase.sol";

/// @notice ORRY that does not move or burn exactly is refused (the intake and burn checks of AgentLaunch). The real ORRY
/// moves and burns exactly (fork suite); these keep the checks honest. The token's code is swapped in place after the
/// stake is set up, so balances and approvals carry over.
contract AgentLaunchHostileOrryTest is LaunchBase {
    function test_a_token_with_a_transfer_fee_is_refused_at_intake() public {
        // AgentLaunch holds a creator's share first, so a short intake could be paid from someone else's ORRY
        (address first,) = _launchOpen(alice);
        _buy(bob, first, 300_000e18); // 3,000 ORRY of fees, 1,500 for the creator
        al.distribute(first);
        assertGt(al.creatorOwed(first), 1_000e18);
        (uint256 id,) = _agent(carol);
        vm.etch(address(orry), vm.getDeployedCode("StakeMocks.sol:FeeOrry"));
        vm.prank(carol);
        vm.expectRevert(IAgentLaunch.InexactTransfer.selector);
        al.launch(id, "Agent Coin", "AGC", bytes32(id), 1_000e18, 0);
    }

    function test_a_short_burn_is_refused() public {
        (address coin,) = _launchOpen(alice);
        _buy(bob, coin, 10_000e18);
        vm.etch(address(orry), vm.getDeployedCode("CommunityMocks.sol:ShortBurnOrry"));
        vm.expectRevert(IAgentLaunch.InexactTransfer.selector);
        al.distribute(coin);
    }
}
