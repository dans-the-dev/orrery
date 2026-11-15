// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// DEVELOPMENT WALK MOCKS ONLY. Stand-ins for the wave R1 markets (docs/ORRY-R1-SPEC.md 2.1 to 2.4) with the frozen
// ISealedBatchMarket / IMarketFactory / IFeeTiers / IOrryPriceOracle surface, so the web can be walked on a local
// anvil before lane M-1 ships the real contracts. Simplified clearing; never deploy anywhere but chain 31337.

interface IERC20m {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}
interface IBurnable {
    function burnFrom(address, uint256) external;
}
interface IEarning {
    function earningBalance(address) external view returns (uint256);
}

contract MockToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    bool public paused;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) { name = n; symbol = s; decimals = d; }
    function mint(address to, uint256 a) external { totalSupply += a; balanceOf[to] += a; emit Transfer(address(0), to, a); }
    function setPaused(bool p) external { paused = p; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; emit Approval(msg.sender, s, a); return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        require(al >= a, "allowance");
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        _move(f, to, a);
        return true;
    }
    function _move(address f, address to, uint256 a) internal { require(!paused, "paused"); require(balanceOf[f] >= a, "balance"); balanceOf[f] -= a; balanceOf[to] += a; emit Transfer(f, to, a); }
}

/// Chainlink-shaped USD feed, 8 decimals. `push` writes a new round stamped with the block time.
contract MockFeed {
    uint8 public constant decimals = 8;
    uint80 public latestRound;
    mapping(uint80 => int256) public answers;
    mapping(uint80 => uint256) public stamps;
    constructor(int256 a) { push(a); }
    function push(int256 a) public { latestRound += 1; answers[latestRound] = a; stamps[latestRound] = block.timestamp; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (latestRound, answers[latestRound], stamps[latestRound], stamps[latestRound], latestRound);
    }
    function getRoundData(uint80 r) external view returns (uint80, int256, uint256, uint256, uint80) {
        return (r, answers[r], stamps[r], stamps[r], r);
    }
}

/// Thresholds in USD (USDG base units) at the ORRY price (R-44, R-46); every discount is 0 while the price is not ready.
contract MockFeeTiers {
    address public immutable staking;
    address public immutable orryPrice;
    uint256[] internal minsUsd;
    uint16[] internal discounts;
    constructor(address s, address p, uint256[] memory m, uint16[] memory d) { staking = s; orryPrice = p; minsUsd = m; discounts = d; }
    function tierCount() external view returns (uint256) { return minsUsd.length; }
    function tier(uint256 i) external view returns (uint256, uint16) { return (minsUsd[i], discounts[i]); }
    function stakeUsd(address a) public view returns (uint256) {
        if (!MockOrryPrice(orryPrice).ready() || staking == address(0)) return 0;
        return MockOrryPrice(orryPrice).usdValue(IEarning(staking).earningBalance(a));
    }
    function discountBps(address a) external view returns (uint16 best) {
        uint256 v = stakeUsd(a);
        for (uint256 i; i < minsUsd.length; i++) if (v >= minsUsd[i]) best = discounts[i];
    }
}

/// ORRY in USD at a fixed rate: `orryPerUsd` whole ORRY for one USD.
contract MockOrryPrice {
    uint32 public constant WINDOW = 1800;
    bool public ready = true;
    uint256 public orryPerUsd;
    address public hook;
    address public ethUsdFeed;
    constructor(uint256 r) { orryPerUsd = r; }
    function setReady(bool r) external { ready = r; }
    function usdValue(uint256 orryAmount) external view returns (uint256) { require(ready, "not ready"); return orryAmount / (orryPerUsd * 1e12); }
    function orryFor(uint256 usd) public view returns (uint256) { require(ready, "not ready"); return usd * orryPerUsd * 1e12; }
}

/// Stand-in for a Uniswap v4 stock/USDG pool: fills at the given price 5 bps against the taker.
contract MockPool {
    address public immutable asset; address public immutable usdg;
    constructor(address a, address u) { asset = a; usdg = u; }
    /// The market has already sent `amountIn` here; the output goes back to the market.
    function fill(bool buyAsset, uint256 amountIn, uint256 price) external returns (uint256 out) {
        out = buyAsset ? amountIn * 1e18 / (price * 10_005 / 10_000) : amountIn * (price * 9_995 / 10_000) / 1e18;
        IERC20m(buyAsset ? asset : usdg).transfer(msg.sender, out);
    }
}

contract MockMarket {
    enum Mode { Limit, Swap }
    struct Order { bool sellAsset; uint256 amountIn; uint256 limitPrice; Mode mode; bool payFeeInOrry; }
    struct BatchResult { bool cleared; uint256 price; uint80 roundId; uint256 assetFilled; uint256 usdgFilled; uint256 usdgFees; uint256 orryFeesBurned; uint32 ordersDropped; uint256 assetViaPool; uint256 usdgViaPool; }
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }

    event Committed(uint256 indexed batch, address indexed account, bytes32 commitment, uint256 orryBurned);
    event Revealed(uint256 indexed batch, address indexed account, Order order);
    event OrderDropped(uint256 indexed batch, address indexed account);
    event OrderFilled(uint256 indexed batch, address indexed account, uint256 inputUsed, uint256 output, uint256 usdgFee, uint256 orryFee);
    event BatchCleared(uint256 indexed batch, uint256 price, uint80 roundId, uint256 assetFilled, uint256 usdgFilled);
    event BatchExpired(uint256 indexed batch);
    event Burned(uint8 indexed source, uint256 amount);

    error WrongPhase(); error AlreadyCommitted(); error BatchFull(); error BadReveal(); error BelowMinimum(); error AlreadyCleared();
    error Expired(); error BadRound(); error StalePrice(); error ZeroAmount(); error InexactTransfer(); error DeviationTooHigh();

    uint32 public constant MAX_ORDERS = 64;
    uint64 public constant EXPIRY = 1 days;
    uint16 public constant orryFeeDiscountBps = 2500;
    uint16 public constant maxDeviationBps = 50;
    address public pool;

    address public immutable asset; address public immutable usdg; address public immutable priceFeed; address public immutable treasury;
    address public immutable feeTiers; address public immutable orryPrice; address public immutable orry;
    uint64 public immutable start; uint32 public immutable commitSeconds; uint32 public immutable revealSeconds;
    uint16 public immutable feeBps; uint256 public immutable minNotionalUsdg; uint32 public immutable maxStaleness; uint256 public immutable commitFeeUsd;

    mapping(uint256 => mapping(address => bytes32)) public commitmentOf;
    mapping(uint256 => uint256) internal commits;
    mapping(uint256 => address[]) internal accounts;
    mapping(uint256 => Order[]) internal orders;
    mapping(uint256 => BatchResult) internal results;

    constructor(address[7] memory a, uint64 s, uint32 c, uint32 r, uint16 f, uint256 minN, uint32 stale, uint256 cf) {
        (asset, usdg, priceFeed, treasury, feeTiers, orryPrice, orry) = (a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
        (start, commitSeconds, revealSeconds, feeBps, minNotionalUsdg, maxStaleness, commitFeeUsd) = (s, c, r, f, minN, stale, cf);
    }

    function phase() public view returns (uint256 batch, bool inCommit, uint64 endsAt) {
        uint256 len = uint256(commitSeconds) + revealSeconds;
        batch = (block.timestamp - start) / len;
        uint256 cEnd = start + batch * len + commitSeconds;
        inCommit = block.timestamp < cEnd;
        endsAt = uint64(inCommit ? cEnd : cEnd + revealSeconds);
    }
    function revealEnd(uint256 batch) public view returns (uint64) { return uint64(start + (batch + 1) * (uint256(commitSeconds) + revealSeconds)); }
    function orderCount(uint256 batch) external view returns (uint256) { return orders[batch].length; }
    function commitCount(uint256 batch) external view returns (uint256) { return commits[batch]; }
    function orderAt(uint256 batch, uint256 i) external view returns (address, Order memory) { return (accounts[batch][i], orders[batch][i]); }
    function result(uint256 batch) external view returns (BatchResult memory) { return results[batch]; }
    function setPool(address p) external { require(pool == address(0), "set"); pool = p; }
    function remainderPool() external view returns (PoolKey memory key, bool listed) {
        listed = pool != address(0);
        if (listed) key = PoolKey(usdg < asset ? usdg : asset, usdg < asset ? asset : usdg, 3000, 60, address(0));
    }
    function commitmentFor(uint256 batch, address account, Order calldata order, bytes32 salt) public pure returns (bytes32) { return keccak256(abi.encode(batch, account, order, salt)); }

    function commit(bytes32 commitment) external {
        (uint256 b, bool inCommit,) = phase();
        if (!inCommit) revert WrongPhase();
        if (commitmentOf[b][msg.sender] != bytes32(0)) revert AlreadyCommitted();
        if (commits[b] >= MAX_ORDERS) revert BatchFull();
        commitmentOf[b][msg.sender] = commitment;
        commits[b] += 1;
        uint256 burned;
        if (commitFeeUsd > 0 && MockOrryPrice(orryPrice).ready()) {
            burned = MockOrryPrice(orryPrice).orryFor(commitFeeUsd);
            IBurnable(orry).burnFrom(msg.sender, burned);
            emit Burned(5, burned);
        }
        emit Committed(b, msg.sender, commitment, burned);
    }

    function reveal(Order calldata order, bytes32 salt) external { _reveal(msg.sender, order, salt); }
    function revealFor(address account, Order calldata order, bytes32 salt) external { _reveal(account, order, salt); }

    function _reveal(address account, Order calldata order, bytes32 salt) internal {
        (uint256 b, bool inCommit,) = phase();
        if (inCommit) revert WrongPhase();
        if (order.amountIn == 0) revert ZeroAmount();
        if (commitmentFor(b, account, order, salt) != commitmentOf[b][account]) revert BadReveal();
        (, int256 ans,,,) = MockFeed(priceFeed).latestRoundData();
        uint256 p = uint256(ans) / 100; // 8 decimal USD to USDG base units per 1e18 asset units (18 decimal assets)
        uint256 notional = order.sellAsset ? order.amountIn * p / 1e18 : order.amountIn;
        if (notional < minNotionalUsdg) revert BelowMinimum();
        commitmentOf[b][account] = bytes32(uint256(1)); // spent
        accounts[b].push(account);
        orders[b].push(order);
        emit Revealed(b, account, order);
    }

    struct Leg { bool ok; uint256 pulled; }

    function clear(uint256 b, uint80 roundHint) external {
        uint256 rEnd = revealEnd(b);
        if (block.timestamp < rEnd) revert WrongPhase();
        if (results[b].cleared) revert AlreadyCleared();
        if (block.timestamp > rEnd + EXPIRY) revert Expired();
        (, int256 ans,, uint256 upd,) = MockFeed(priceFeed).getRoundData(roundHint);
        if (upd == 0 || upd > rEnd) revert BadRound();
        if (roundHint != MockFeed(priceFeed).latestRound()) {
            (,,, uint256 nextUpd,) = MockFeed(priceFeed).getRoundData(roundHint + 1);
            if (nextUpd <= rEnd) revert BadRound();
        }
        if (rEnd - upd > maxStaleness || ans <= 0) revert StalePrice();
        uint256 price = uint256(ans) / 100;

        Order[] storage os = orders[b];
        Leg[] memory legs = new Leg[](os.length);
        uint256 buyUsdg; uint256 sellAsset; uint32 dropped;
        for (uint256 i; i < os.length; i++) {
            Order memory o = os[i];
            bool hits = o.sellAsset ? price >= o.limitPrice : price <= o.limitPrice;
            if (!hits) continue;
            address acct = accounts[b][i];
            uint256 want = o.sellAsset ? o.amountIn : o.amountIn + (o.payFeeInOrry ? 0 : o.amountIn * feeBps / 1e4);
            address tok = o.sellAsset ? asset : usdg;
            try IERC20m(tok).transferFrom(acct, address(this), want) returns (bool) {
                legs[i] = Leg(true, want);
                if (o.sellAsset) sellAsset += o.amountIn; else buyUsdg += o.amountIn;
            } catch {
                dropped++;
                emit OrderDropped(b, acct);
            }
        }
        // Cross at the price; the larger side fills pro rata (1e18 fixed point).
        uint256 demand = buyUsdg * 1e18 / price;
        uint256 fBuy = 1e18; uint256 fSell = 1e18;
        if (demand > sellAsset) fBuy = demand == 0 ? 0 : sellAsset * 1e18 / demand; else fSell = sellAsset == 0 ? 0 : demand * 1e18 / sellAsset;
        BatchResult memory res = BatchResult(true, price, roundHint, 0, 0, 0, 0, dropped, 0, 0);
        for (uint256 i; i < os.length; i++) {
            if (!legs[i].ok) continue;
            Order memory o = os[i];
            address acct = accounts[b][i];
            uint256 disc = MockFeeTiers(feeTiers).discountBps(acct);
            if (o.sellAsset) {
                uint256 used = o.amountIn * fSell / 1e18;
                uint256 gross = used * price / 1e18;
                res.assetFilled += used;
                // R1b: the unmatched part of a Swap order sells into the pool when its price meets the limit.
                if (o.mode == Mode.Swap && pool != address(0) && o.amountIn > used && price * 9_995 / 10_000 >= o.limitPrice) {
                    uint256 rest = o.amountIn - used;
                    IERC20m(asset).transfer(pool, rest);
                    uint256 got = MockPool(pool).fill(false, rest, price);
                    res.assetViaPool += rest; res.usdgViaPool += got;
                    used += rest; gross += got;
                }
                (uint256 fee, uint256 rFee) = _fee(acct, gross, disc, o.payFeeInOrry);
                if (used > 0) _pay(usdg, acct, gross - fee);
                if (o.amountIn > used) _pay(asset, acct, o.amountIn - used);
                res.usdgFees += fee; res.orryFeesBurned += rFee;
                if (fee > 0) _pay(usdg, treasury, fee);
                emit OrderFilled(b, acct, used, gross - fee, fee, rFee);
            } else {
                uint256 used = o.amountIn * fBuy / 1e18;
                uint256 out = used * 1e18 / price;
                uint256 bal = IERC20m(asset).balanceOf(address(this));
                if (out > bal) out = bal;
                res.usdgFilled += used;
                if (o.mode == Mode.Swap && pool != address(0) && o.amountIn > used && price * 10_005 / 10_000 <= o.limitPrice) {
                    uint256 rest = o.amountIn - used;
                    IERC20m(usdg).transfer(pool, rest);
                    uint256 got = MockPool(pool).fill(true, rest, price);
                    res.usdgViaPool += rest; res.assetViaPool += got;
                    used += rest; out += got;
                }
                (uint256 fee, uint256 rFee) = _fee(acct, used, disc, o.payFeeInOrry);
                if (out > 0) _pay(asset, acct, out);
                if (fee > legs[i].pulled - used) fee = legs[i].pulled - used;
                uint256 refund = legs[i].pulled - used - fee;
                if (refund > 0) _pay(usdg, acct, refund);
                res.usdgFees += fee; res.orryFeesBurned += rFee;
                if (fee > 0) _pay(usdg, treasury, fee);
                emit OrderFilled(b, acct, used, out, fee, rFee);
            }
        }
        // Rounding dust to the treasury: the market ends holding nothing (X-1).
        uint256 da = IERC20m(asset).balanceOf(address(this));
        if (da > 0) IERC20m(asset).transfer(treasury, da);
        uint256 du = IERC20m(usdg).balanceOf(address(this));
        if (du > 0) IERC20m(usdg).transfer(treasury, du);
        results[b] = res;
        emit BatchCleared(b, price, roundHint, res.assetFilled, res.usdgFilled);
    }

    /// Mock rounding guard: never send more than the market holds (the real market proves DP-3 instead).
    function _pay(address token, address to, uint256 a) internal {
        uint256 b = IERC20m(token).balanceOf(address(this));
        if (a > b) a = b;
        if (a > 0) IERC20m(token).transfer(to, a);
    }

    function _fee(address acct, uint256 notional, uint256 disc, bool inOrry) internal returns (uint256 usdgFee, uint256 orryFee) {
        uint256 fee = notional * feeBps * (10_000 - disc) / 1e8;
        if (fee == 0) return (0, 0);
        if (inOrry && MockOrryPrice(orryPrice).ready()) {
            uint256 r = MockOrryPrice(orryPrice).orryFor(fee * (10_000 - orryFeeDiscountBps) / 10_000);
            try IBurnable(orry).burnFrom(acct, r) { emit Burned(6, r); return (0, r); } catch {}
        }
        return (fee, 0);
    }

    function expire(uint256 b) external {
        if (block.timestamp <= revealEnd(b) + EXPIRY || results[b].cleared) revert WrongPhase();
        emit BatchExpired(b);
    }
}

contract MockFactory {
    address public owner = msg.sender;
    address public pendingOwner;
    mapping(address => address) public marketOf;
    address[] internal all;
    event MarketCreated(address indexed asset, address indexed market, address priceFeed);
    function add(address asset, address market, address feed) external { require(marketOf[asset] == address(0), "exists"); marketOf[asset] = market; all.push(market); emit MarketCreated(asset, market, feed); }
    function marketCount() external view returns (uint256) { return all.length; }
    function marketAt(uint256 i) external view returns (address) { return all[i]; }
}
