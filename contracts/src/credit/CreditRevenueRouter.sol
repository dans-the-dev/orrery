// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Min} from "../interfaces/IExternal.sol";

interface ICreditPoolRouterView {
    function owedOf(uint256 agentId) external view returns (uint256);
    function payoutOf(uint256 agentId) external view returns (address);
    function repay(uint256 agentId, uint256 amount) external returns (uint256 paid);
}

/// @title CreditRevenueRouter
/// @notice The x402 `payTo` of one agent while its credit line is open (`docs/updates/L4-CREDIT-SPEC.md` 3.5). `sweep`
///         repays `repayBps` of what it holds (never more than the line owes) and sends the rest to the agent wallet.
///         Holds USDG only between sweeps; no owner.
contract CreditRevenueRouter {
    uint16 private constant BPS = 10_000;

    address public immutable pool;
    IERC20Min public immutable usdg;
    uint256 public immutable agentId;
    uint16 public immutable repayBps;

    /// @notice USDG swept through this router since deployment.
    uint256 public revenue;

    event Swept(uint256 amount, uint256 toPool, uint256 toAgent, address indexed payout, bool payoutFailed);

    error NothingToSweep();
    error ApproveFailed();

    constructor(address pool_, IERC20Min usdg_, uint256 agentId_, uint16 repayBps_) {
        pool = pool_;
        usdg = usdg_;
        agentId = agentId_;
        repayBps = repayBps_;
    }

    function sweep() external returns (uint256 toPool, uint256 toAgent) {
        uint256 bal = usdg.balanceOf(address(this));
        if (bal == 0) revert NothingToSweep();
        ICreditPoolRouterView p = ICreditPoolRouterView(pool);
        uint256 share = bal * repayBps / BPS;
        uint256 owed = p.owedOf(agentId);
        toPool = share < owed ? share : owed;
        if (toPool != 0) {
            (bool ok, bytes memory ret) = address(usdg).call(abi.encodeWithSelector(0x095ea7b3, pool, toPool));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApproveFailed();
            toPool = p.repay(agentId, toPool);
        }
        toAgent = bal - toPool;
        address payout = p.payoutOf(agentId);
        bool failed;
        if (toAgent != 0) {
            (bool ok, bytes memory ret) = address(usdg).call(abi.encodeCall(IERC20Min.transfer, (payout, toAgent)));
            failed = !ok || (ret.length != 0 && !abi.decode(ret, (bool)));
            if (failed) toAgent = 0; // kept for the next sweep
        }
        revenue += toPool + toAgent;
        emit Swept(bal, toPool, toAgent, payout, failed);
    }
}
