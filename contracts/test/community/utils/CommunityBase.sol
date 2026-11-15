// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {RewardPool} from "../../../src/community/RewardPool.sol";
import {OrryAchievements} from "../../../src/community/OrryAchievements.sol";
import {OrryChat} from "../../../src/community/OrryChat.sol";
import {OrryNames} from "../../../src/community/OrryNames.sol";
import {OrryBoost} from "../../../src/community/OrryBoost.sol";
import {OrryPasses} from "../../../src/community/OrryPasses.sol";
import {TemplateMarket} from "../../../src/community/TemplateMarket.sol";
import {ReferralRegistry} from "../../../src/community/ReferralRegistry.sol";
import {CashbackRewards} from "../../../src/community/CashbackRewards.sol";
import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";
import {MockEarningStaking} from "../../markets/utils/MarketMocks.sol";
import {MockOrryPrice, MockToken} from "./CommunityMocks.sol";

/// @notice Deploys the L1 set with its spec defaults (`docs/updates/L1-COMMUNITY-SPEC.md` 2) on mocks: ORRY at a fixed
/// 100 ORRY per USD, a settable earning balance.
abstract contract CommunityBase is Test {
    uint256 internal constant T0 = 1_800_000_000; // 2027-01-15 08:00:00 UTC
    uint256 internal constant USD = 1e6;
    uint256 internal constant ORRY = 1e18;

    MockOrry internal orry;
    MockOrryPrice internal price;
    MockEarningStaking internal staking;
    MockToken internal usdg;
    RewardPool internal pool;
    OrryAchievements internal ach;
    OrryChat internal chat;
    OrryNames internal names;
    OrryBoost internal boost;
    OrryPasses internal passes;
    TemplateMarket internal market;
    ReferralRegistry internal registry;
    CashbackRewards internal cashback;

    address internal admin = makeAddr("treasuryWallet");
    address internal publisher = makeAddr("publisher");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public virtual {
        vm.warp(T0);
        orry = new MockOrry(address(this), 1e30);
        price = new MockOrryPrice();
        staking = new MockEarningStaking();
        usdg = new MockToken();
        address achAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        pool = new RewardPool(address(orry), achAt, admin, 2500, 48 hours);
        ach = new OrryAchievements(address(pool));
        chat = new OrryChat(
            address(orry), address(price), address(pool), address(staking), 0.01e6, 1000, 500, 10_000e18, 5
        );
        names = new OrryNames(address(orry), address(price), address(pool), 1e6);
        boost = new OrryBoost(address(orry), address(price), 0.5e6, 5e6, 2e6);
        passes = new OrryPasses(address(orry), address(price), 1e6, 5e6);
        market = new TemplateMarket(address(orry), address(price), 2000, 1e6, 1000e6);
        registry = new ReferralRegistry();
        cashback = new CashbackRewards(
            address(orry),
            address(price),
            address(registry),
            admin,
            CashbackRewards.Config({
                hold: 30 days,
                claimWindow: 365 days,
                referralWindow: 90 days,
                monthlyCapUsd: 1000e6,
                maxShareBps: 5000,
                maxCashbackBps: 1000
            })
        );
        vm.prank(admin);
        cashback.setPublisher(publisher);

        address[5] memory users = [alice, bob, carol, admin, publisher];
        for (uint256 i; i < users.length; ++i) {
            orry.transfer(users[i], 10_000_000e18);
            vm.startPrank(users[i]);
            orry.approve(address(pool), type(uint256).max);
            orry.approve(address(chat), type(uint256).max);
            orry.approve(address(names), type(uint256).max);
            orry.approve(address(boost), type(uint256).max);
            orry.approve(address(passes), type(uint256).max);
            orry.approve(address(market), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _fundPool(uint256 amount) internal {
        vm.prank(admin);
        pool.fund(address(orry), amount);
    }
}
