// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MarketBase} from "../../markets/utils/MarketBase.sol";
import {OrryPaymaster} from "../../../src/paymaster/OrryPaymaster.sol";
import {
    IPaymaster, PackedUserOperation, PaymasterParams
} from "../../../src/paymaster/interfaces/IOrryPaymaster.sol";

/// @notice EntryPoint stand-in for unit tests: keeps deposits and stakes like the real one and runs a paymaster's
/// validation and postOp for one operation as `handleOps` does (the real EntryPoint is exercised in the fork tests).
contract MockEntryPoint {
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public stakeOf;
    mapping(address => uint32) public delayOf;
    mapping(address => bool) public unlocked;

    function depositTo(address account) external payable {
        balanceOf[account] += msg.value;
    }

    function withdrawTo(address payable to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send");
    }

    function addStake(uint32 delay) external payable {
        stakeOf[msg.sender] += msg.value;
        delayOf[msg.sender] = delay;
    }

    function unlockStake() external {
        unlocked[msg.sender] = true;
    }

    function withdrawStake(address payable to) external {
        require(unlocked[msg.sender], "locked");
        uint256 s = stakeOf[msg.sender];
        stakeOf[msg.sender] = 0;
        (bool ok,) = to.call{value: s}("");
        require(ok, "send");
    }

    /// @dev validate, then postOp with the actual cost, in one call, as the EntryPoint does around the execution.
    function run(
        address paymaster,
        PackedUserOperation calldata op,
        uint256 maxCost,
        uint256 actualGasCost,
        uint256 feePerGas
    ) external returns (uint256 validationData) {
        bytes memory ctx;
        (ctx, validationData) = IPaymaster(paymaster).validatePaymasterUserOp(op, keccak256(abi.encode(op)), maxCost);
        IPaymaster(paymaster).postOp(IPaymaster.PostOpMode.opSucceeded, ctx, actualGasCost, feePerGas);
    }

    function validateOnly(address paymaster, PackedUserOperation calldata op, uint256 maxCost)
        external
        returns (bytes memory ctx, uint256 validationData)
    {
        return IPaymaster(paymaster).validatePaymasterUserOp(op, bytes32(0), maxCost);
    }

    function postOnly(address paymaster, bytes calldata ctx, uint256 actualGasCost, uint256 feePerGas) external {
        IPaymaster(paymaster).postOp(IPaymaster.PostOpMode.opReverted, ctx, actualGasCost, feePerGas);
    }
}

/// @notice The paymaster on the R1 test world (`MarketBase`, read only): ORRY at the hub stand-in's tick 138200 (about
/// 1,002,600 ORRY per ETH) times ETH at 2,235 USD. Values are the spec's guesses (`docs/updates/L3-R2-SPEC.md` 5).
abstract contract PaymasterBase is MarketBase {
    MockEntryPoint internal ep;
    OrryPaymaster internal pmr;
    address internal recipient = makeAddr("orryRecipient");
    address internal account = makeAddr("agentAccount");
    address internal operator = makeAddr("operator");

    function _pmParams() internal pure returns (PaymasterParams memory) {
        return PaymasterParams({
            premiumBps: 1000,
            bufferBps: 2000,
            maxCostWei: 2e15,
            postOpOverheadGas: 45_000,
            maxRateAge: 3600,
            maxEthStaleness: 7200
        });
    }

    function setUp() public virtual override {
        super.setUp();
        ep = new MockEntryPoint();
        pmr = new OrryPaymaster(
            address(ep), address(orry), address(orryPrice), address(ethFeed), owner, recipient, _pmParams()
        );
        orry.transfer(operator, 1_000_000e18);
        vm.prank(operator);
        orry.approve(address(pmr), type(uint256).max);
    }

    function _op(address sender, uint128 postOpGas) internal view returns (PackedUserOperation memory op) {
        op.sender = sender;
        op.paymasterAndData = abi.encodePacked(address(pmr), uint128(100_000), postOpGas);
    }

    function _fund(address who, uint256 amount) internal {
        vm.prank(operator);
        pmr.deposit(who, amount);
    }
}
