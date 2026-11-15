// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OrryPriced} from "./OrryPriced.sol";

/// @title TemplateMarket
/// @notice Policy template market (utility 9, `docs/updates/L1-COMMUNITY-SPEC.md` L1-10). A creator lists a template
/// (content hash and URI of a `OrreryPolicyModule` policy config) at a USD price; a buyer pays it in ORRY at the hub mean
/// price, `burnBps` of it is burned (`Burned(10, amount)`) and the rest goes to the creator, and the buyer holds a licence
/// for good. The creator reprices, delists and relists; licences already sold stay. No owner, no setter.
contract TemplateMarket is OrryPriced {
    struct Template {
        address creator;
        bool listed;
        uint128 priceUsd;
        bytes32 contentHash;
    }

    event TemplateListed(uint256 indexed id, address indexed creator, uint256 priceUsd, bytes32 contentHash, string uri);
    event TemplatePriced(uint256 indexed id, uint256 priceUsd);
    event TemplateListing(uint256 indexed id, bool listed);
    event TemplateBought(
        uint256 indexed id, address indexed buyer, address indexed creator, uint256 paid, uint256 burned
    );

    error BadPrice();
    error UnknownTemplate();
    error NotCreator();
    error NotListed();
    error AlreadyLicensed();
    error OwnTemplate();

    uint8 public constant BURN_SOURCE = 10;

    uint16 public immutable burnBps;
    uint256 public immutable minPriceUsd;
    uint256 public immutable maxPriceUsd;

    uint256 public templateCount;
    mapping(uint256 id => Template) private _templates;
    mapping(uint256 id => mapping(address buyer => bool)) public licensed;

    constructor(address orry_, address orryPrice_, uint16 burnBps_, uint256 minPriceUsd_, uint256 maxPriceUsd_)
        OrryPriced(orry_, orryPrice_)
    {
        require(burnBps_ <= BPS, "burn bps");
        require(minPriceUsd_ != 0 && minPriceUsd_ <= maxPriceUsd_ && maxPriceUsd_ <= type(uint128).max, "bounds");
        burnBps = burnBps_;
        minPriceUsd = minPriceUsd_;
        maxPriceUsd = maxPriceUsd_;
    }

    function templateOf(uint256 id) external view returns (Template memory) {
        return _templates[id];
    }

    function list(uint256 priceUsd, bytes32 contentHash, string calldata uri) external returns (uint256 id) {
        _checkPrice(priceUsd);
        id = ++templateCount;
        _templates[id] = Template(msg.sender, true, uint128(priceUsd), contentHash);
        emit TemplateListed(id, msg.sender, priceUsd, contentHash, uri);
    }

    function setPrice(uint256 id, uint256 priceUsd) external {
        Template storage t = _own(id);
        _checkPrice(priceUsd);
        t.priceUsd = uint128(priceUsd);
        emit TemplatePriced(id, priceUsd);
    }

    function setListed(uint256 id, bool listed) external {
        Template storage t = _own(id);
        t.listed = listed;
        emit TemplateListing(id, listed);
    }

    function quote(uint256 id) external view returns (uint256) {
        Template storage t = _templates[id];
        if (t.creator == address(0)) revert UnknownTemplate();
        return _quote(t.priceUsd, type(uint256).max);
    }

    function buy(uint256 id, uint256 maxOrry) external returns (uint256 paid) {
        Template storage t = _templates[id];
        if (t.creator == address(0)) revert UnknownTemplate();
        if (!t.listed) revert NotListed();
        if (t.creator == msg.sender) revert OwnTemplate();
        if (licensed[id][msg.sender]) revert AlreadyLicensed();
        paid = _quote(t.priceUsd, maxOrry);
        licensed[id][msg.sender] = true;
        uint256 burned = paid * burnBps / BPS;
        _burnFrom(msg.sender, burned, BURN_SOURCE);
        _pull(msg.sender, t.creator, paid - burned);
        emit TemplateBought(id, msg.sender, t.creator, paid, burned);
    }

    function _own(uint256 id) private view returns (Template storage t) {
        t = _templates[id];
        if (t.creator == address(0)) revert UnknownTemplate();
        if (t.creator != msg.sender) revert NotCreator();
    }

    function _checkPrice(uint256 priceUsd) private view {
        if (priceUsd < minPriceUsd || priceUsd > maxPriceUsd) revert BadPrice();
    }
}
