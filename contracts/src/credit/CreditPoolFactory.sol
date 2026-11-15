// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Min, IIdentityRegistry} from "../interfaces/IExternal.sol";
import {IOrryPriceOracle} from "../markets/interfaces/IMarketPricing.sol";
import {CreditPool, IAttestorVerified} from "./CreditPool.sol";

interface ITreasuryOwner {
    function owner() external view returns (address);
}

/// @title CreditPoolFactory
/// @notice Creates Orrery Credit pools (`docs/updates/L4-CREDIT-SPEC.md` 3.3). Only the treasury owner creates a pool
///         or retires one; each pool's terms are fixed at creation. Retiring only stops new deposits and draws.
contract CreditPoolFactory {
    IERC20Min public immutable usdg;
    IERC20Min public immutable orry;
    IOrryPriceOracle public immutable oracle;
    IIdentityRegistry public immutable identity;
    IAttestorVerified public immutable attestor;
    address public immutable treasury;

    mapping(address => bool) public isPool;
    address[] internal _pools;

    event PoolCreated(address indexed pool, uint256 indexed index, CreditPool.Params params);
    event PoolRetired(address indexed pool);

    error ZeroAddress();
    error NotTreasuryOwner();
    error UnknownPool();

    constructor(
        IERC20Min usdg_,
        IERC20Min orry_,
        IOrryPriceOracle oracle_,
        IIdentityRegistry identity_,
        IAttestorVerified attestor_,
        address treasury_
    ) {
        if (
            address(usdg_) == address(0) || address(orry_) == address(0) || address(oracle_) == address(0)
                || address(identity_) == address(0) || address(attestor_) == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        usdg = usdg_;
        orry = orry_;
        oracle = oracle_;
        identity = identity_;
        attestor = attestor_;
        treasury = treasury_;
    }

    modifier onlyTreasuryOwner() {
        if (msg.sender != ITreasuryOwner(treasury).owner()) revert NotTreasuryOwner();
        _;
    }

    function createPool(CreditPool.Params calldata p) external onlyTreasuryOwner returns (address pool) {
        pool = address(new CreditPool(usdg, orry, oracle, identity, attestor, treasury, p));
        isPool[pool] = true;
        _pools.push(pool);
        emit PoolCreated(pool, _pools.length - 1, p);
    }

    function retire(address pool) external onlyTreasuryOwner {
        if (!isPool[pool]) revert UnknownPool();
        CreditPool(pool).retire();
        emit PoolRetired(pool);
    }

    function pools() external view returns (address[] memory) {
        return _pools;
    }

    function poolCount() external view returns (uint256) {
        return _pools.length;
    }
}
