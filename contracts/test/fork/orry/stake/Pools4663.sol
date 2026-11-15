// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Native ETH / USDG Uniswap v4 pools on Robinhood Chain 4663, found by lane B on 2026-11-08 from every
/// `Initialize` event of the PoolManager 0x8366a39CC670B4001A1121B8F6A443A643e40951 with currency0 = native ETH and
/// currency1 = USDG (eth_getLogs over blocks 0 to 108,947,868 in 10 M-block chunks on rpc.mainnet.chain.robinhood.com:
/// 633 pools, 157 without a hook; the rest carry hooks, mostly dynamic-fee launchpad pools, and are not usable as
/// hop 1). The three deepest hookless pools by in-range virtual USDG reserve (L * sqrtP / 2^96), read through StateView
/// 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b at block 108,949,963 (timestamp 1,794,111,458), price about 2,235 USDG
/// per ETH. The PoolManager charges a protocol fee on each (slot0 protocolFee): pool A 512125 (0x7D07D, 125 pips each
/// way), pool B 479349 (0x75075, 117 each way), pool C 102425 (0x19019, 25 each way); the buyback counts it in the hop fee.
/// Re-read on the fork at block 108,971,149 (test_fork_recorded_pools_are_live): same ids, fees and protocol fees, pool A
/// liquidity 146,130,037,603,456,150, pool B 82,880,721,553,403,039, pool C 41,839,532,623,305,217.
library Pools4663 {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    uint256 internal constant DISCOVERY_BLOCK = 108_949_963;

    // 1. deepest: fee 500 (0.05%), tick spacing 10, liquidity 145,602,775,995,603,454, sqrtPriceX96
    //    3,745,785,501,221,435,844,790,227, tick -199,200; virtual reserves about 6.88 M USDG / 3,080 ETH; created block 169,464
    bytes32 internal constant POOL_A_ID = 0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982;
    uint24 internal constant POOL_A_FEE = 500;
    int24 internal constant POOL_A_SPACING = 10;
    uint128 internal constant POOL_A_LIQUIDITY = 145_602_775_995_603_454;
    uint24 internal constant POOL_A_PROTOCOL_FEE = 512_125;

    // 2. fee 460, tick spacing 9, liquidity 82,890,483,492,547,834, sqrtPriceX96 3,745,714,908,084,492,240,585,110;
    //    virtual reserves about 3.92 M USDG / 1,753 ETH; created block 4,429,344
    bytes32 internal constant POOL_B_ID = 0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32;
    uint24 internal constant POOL_B_FEE = 460;
    int24 internal constant POOL_B_SPACING = 9;
    uint128 internal constant POOL_B_LIQUIDITY = 82_890_483_492_547_834;
    uint24 internal constant POOL_B_PROTOCOL_FEE = 479_349;

    // 3. fee 100, tick spacing 1, liquidity 41,839,532,623,305,217, sqrtPriceX96 3,745,457,370,106,923,160,092,446;
    //    virtual reserves about 1.98 M USDG / 885 ETH; created block 1,146,712
    bytes32 internal constant POOL_C_ID = 0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e;
    uint24 internal constant POOL_C_FEE = 100;
    int24 internal constant POOL_C_SPACING = 1;
    uint128 internal constant POOL_C_LIQUIDITY = 41_839_532_623_305_217;
    uint24 internal constant POOL_C_PROTOCOL_FEE = 102_425;
}
