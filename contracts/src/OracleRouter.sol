// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IPyth, PythPrice} from "./interfaces/IPyth.sol";
import {IChainlinkAggregator} from "./interfaces/IChainlink.sol";
import {IPerpEngine} from "./interfaces/ISurInterfaces.sol";

/// @title SUR Protocol - OracleRouter
/// @author SUR Protocol Team
/// @notice Unified price feed with Pyth (primary) and Chainlink (fallback).
///         Normalizes all prices to 6 decimal USDC precision.
/// @dev Architecture:
///      - Each SUR market has a FeedConfig mapping to oracle feed IDs
///      - getPrice() tries Pyth first, falls back to Chainlink
///      - Validates staleness, deviation between sources, and confidence
///      - pushPrice() fetches price and pushes to PerpEngine in one tx
///
///      Price flow:
///      1. Keeper calls pushPriceWithPyth(marketId, pythUpdateData)
///      2. OracleRouter updates Pyth on-chain (pays fee)
///      3. Reads fresh Pyth price → normalizes to 6 decimals
///      4. Optionally cross-checks with Chainlink
///      5. Calls engine.updateMarkPrice(marketId, markPrice, indexPrice)
///
///      For SUR Protocol:
///      - Mark Price = Pyth price (low latency, used for PnL + liquidations)
///      - Index Price = Chainlink price (more decentralized, used for funding)
///      - If Chainlink is not configured, indexPrice = markPrice

contract OracleRouter {
    // ============================================================
    //                          ERRORS
    // ============================================================

    error NotOwner();
    error NotOperator();
    error ZeroAddress();
    error FeedNotConfigured(bytes32 marketId);
    error PriceStale(bytes32 marketId, uint256 age, uint256 maxAge);
    error PriceNegativeOrZero(bytes32 marketId, int256 price);
    error PriceDeviationTooHigh(
        bytes32 marketId,
        uint256 pythPrice,
        uint256 chainlinkPrice,
        uint256 deviationBps
    );
    error ConfidenceTooWide(bytes32 marketId, uint256 price, uint256 confidence);
    error PythUpdateFailed();
    error OracleCircuitBreakerActive(bytes32 marketId);

    // ============================================================
    //                          EVENTS
    // ============================================================

    event PriceUpdated(
        bytes32 indexed marketId,
        uint256 markPrice,
        uint256 indexPrice,
        uint8 source, // 0=Pyth, 1=Chainlink, 2=Both
        uint256 timestamp
    );

    event FeedConfigured(
        bytes32 indexed marketId,
        bytes32 pythFeedId,
        address chainlinkFeed
    );

    event PythUpdateSubmitted(uint256 fee, uint256 timestamp);
    event DeviationWarning(bytes32 indexed marketId, uint256 pythPrice, uint256 chainlinkPrice, uint256 deviationBps);
    event OperatorUpdated(address indexed operator, bool status);
    event OracleCircuitBreakerTriggered(bytes32 indexed marketId, uint256 oldPrice, uint256 newPrice, uint256 changeBps, uint256 timestamp);
    event OracleCircuitBreakerReset(uint256 timestamp);

    // ============================================================
    //                          TYPES
    // ============================================================

    /// @notice Oracle feed configuration for a market
    struct FeedConfig {
        bytes32 pythFeedId;             // Pyth price feed ID (bytes32)
        address chainlinkFeed;          // Chainlink aggregator address (address(0) if not set)
        uint256 maxStalenessSeconds;    // max age before price is considered stale
        uint256 maxDeviationBps;        // max allowed deviation between Pyth and Chainlink
        uint256 maxConfidenceBps;       // max Pyth confidence interval as % of price
        bool active;
    }

    /// @notice Normalized price result
    struct PriceResult {
        uint256 price;         // normalized to 6 decimals (USDC precision)
        uint256 timestamp;     // when the price was published
        uint8 source;          // 0=Pyth, 1=Chainlink
        uint256 confidence;    // confidence/spread in 6 decimals
    }

    // ============================================================
    //                      CONSTANTS
    // ============================================================

    /// @notice Target precision: 6 decimals (matches USDC)
    uint256 public constant TARGET_DECIMALS = 6;
    uint256 public constant TARGET_PRECISION = 1e6;
    uint256 public constant BPS = 10_000;

    // ============================================================
    //                          STATE
    // ============================================================

    /// @notice Pyth oracle contract
    IPyth public immutable pyth;

    /// @notice PerpEngine contract for price pushes
    IPerpEngine public immutable engine;

    /// @notice Contract owner
    address public owner;

    /// @notice Approved operators (keepers, backend)
    mapping(address => bool) public operators;

    /// @notice Feed configurations per market
    mapping(bytes32 => FeedConfig) public feeds;

    /// @notice All configured market IDs
    bytes32[] public configuredMarkets;

    /// @notice Last price pushed per market (for deviation tracking)
    mapping(bytes32 => uint256) public lastPrice;
    mapping(bytes32 => uint256) public lastPriceTimestamp;

    /// @notice Whether trading is paused due to oracle anomaly
    bool public oracleCircuitBreakerActive;

    /// @notice Timestamp when oracle circuit breaker was triggered
    uint256 public oracleCircuitBreakerTriggeredAt;

    /// @notice Auto-reset cooldown for oracle circuit breaker
    uint256 public oracleCooldownSecs = 180; // 3 minutes

    /// @notice Max price change per update (in BPS). Larger moves trigger circuit breaker.
    uint256 public maxPriceChangeBps = 1000; // 10% max move per update

    // ============================================================
    //                        MODIFIERS
    // ============================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        _;
    }

    modifier feedExists(bytes32 marketId) {
        if (!feeds[marketId].active) revert FeedNotConfigured(marketId);
        _;
    }

    // ============================================================
    //                       CONSTRUCTOR
    // ============================================================

    /// @param _pyth Pyth oracle contract address on Base
    /// @param _engine PerpEngine contract address
    /// @param _owner Contract owner
    constructor(address _pyth, address _engine, address _owner) {
        if (_pyth == address(0) || _engine == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        pyth = IPyth(_pyth);
        engine = IPerpEngine(_engine);
        owner = _owner;
    }

    // ============================================================
    //                  FEED CONFIGURATION
    // ============================================================

    /// @notice Configure oracle feeds for a market
    /// @param marketId The SUR market ID (e.g., keccak256("BTC-USD"))
    /// @param pythFeedId Pyth price feed ID for this asset
    /// @param chainlinkFeed Chainlink aggregator address (address(0) to skip)
    /// @param maxStalenessSeconds Max price age in seconds
    /// @param maxDeviationBps Max allowed deviation between sources (in BPS)
    /// @param maxConfidenceBps Max Pyth confidence as % of price (in BPS)
    function configureFeed(
        bytes32 marketId,
        bytes32 pythFeedId,
        address chainlinkFeed,
        uint256 maxStalenessSeconds,
        uint256 maxDeviationBps,
        uint256 maxConfidenceBps
    ) external onlyOwner {
        bool isNew = !feeds[marketId].active;

        feeds[marketId] = FeedConfig({
            pythFeedId: pythFeedId,
            chainlinkFeed: chainlinkFeed,
            maxStalenessSeconds: maxStalenessSeconds,
            maxDeviationBps: maxDeviationBps,
            maxConfidenceBps: maxConfidenceBps,
            active: true
        });

        if (isNew) {
            configuredMarkets.push(marketId);
        }

        emit FeedConfigured(marketId, pythFeedId, chainlinkFeed);
    }

    /// @notice Deactivate a feed
    function deactivateFeed(bytes32 marketId) external onlyOwner {
        feeds[marketId].active = false;
    }

    // ============================================================
    //              PRICE READING (VIEW FUNCTIONS)
    // ============================================================

    /// @notice Get the latest price from Pyth for a market
    /// @param marketId The SUR market ID
    /// @return result Normalized price result
    function getPythPrice(bytes32 marketId)
        public
        view
        feedExists(marketId)
        returns (PriceResult memory result)
    {
        FeedConfig memory feed = feeds[marketId];

        PythPrice memory pythData = pyth.getPriceNoOlderThan(
            feed.pythFeedId,
            feed.maxStalenessSeconds
        );

        if (pythData.price <= 0) revert PriceNegativeOrZero(marketId, int256(pythData.price));

        result.price = _normalizePythPrice(pythData.price, pythData.expo);
        result.timestamp = pythData.publishTime;
        result.source = 0; // Pyth
        result.confidence = _normalizePythPrice(int64(uint64(pythData.conf)), pythData.expo);

        // Validate confidence interval
        if (feed.maxConfidenceBps > 0 && result.price > 0) {
            uint256 confRatio = (result.confidence * BPS) / result.price;
            if (confRatio > feed.maxConfidenceBps) {
                revert ConfidenceTooWide(marketId, result.price, result.confidence);
            }
        }
    }

    /// @notice Get the latest price from Chainlink for a market
    /// @param marketId The SUR market ID
    /// @return result Normalized price result
    function getChainlinkPrice(bytes32 marketId)
        public
        view
        feedExists(marketId)
        returns (PriceResult memory result)
    {
        FeedConfig memory feed = feeds[marketId];
        if (feed.chainlinkFeed == address(0)) revert FeedNotConfigured(marketId);

        IChainlinkAggregator aggregator = IChainlinkAggregator(feed.chainlinkFeed);

        (, int256 answer,, uint256 updatedAt,) = aggregator.latestRoundData();

        if (answer <= 0) revert PriceNegativeOrZero(marketId, answer);

        // Check staleness
        uint256 age = block.timestamp - updatedAt;
        if (age > feed.maxStalenessSeconds) {
            revert PriceStale(marketId, age, feed.maxStalenessSeconds);
        }

        // Normalize to 6 decimals
        uint8 feedDecimals = aggregator.decimals();
        result.price = _normalizeChainlinkPrice(uint256(answer), feedDecimals);
        result.timestamp = updatedAt;
        result.source = 1; // Chainlink
        result.confidence = 0; // Chainlink doesn't report confidence
    }

    /// @notice Get the best available price (Pyth first, Chainlink fallback)
    /// @param marketId The SUR market ID
    /// @return markPrice Primary price for PnL/liquidations (6 decimals)
    /// @return indexPrice Secondary price for funding rate (6 decimals)
    /// @return source 0=Pyth, 1=Chainlink, 2=Both
    function getPrice(bytes32 marketId)
        public
        view
        feedExists(marketId)
        returns (uint256 markPrice, uint256 indexPrice, uint8 source)
    {
        FeedConfig memory feed = feeds[marketId];
        bool hasPyth = feed.pythFeedId != bytes32(0);
        bool hasChainlink = feed.chainlinkFeed != address(0);

        uint256 pythP;
        uint256 chainlinkP;

        // Try Pyth (primary for mark price)
        if (hasPyth) {
            try this.getPythPrice(marketId) returns (PriceResult memory r) {
                pythP = r.price;
            } catch {
                // Pyth failed, will try Chainlink
            }
        }

        // Try Chainlink (primary for index price, fallback for mark)
        if (hasChainlink) {
            try this.getChainlinkPrice(marketId) returns (PriceResult memory r) {
                chainlinkP = r.price;
            } catch {
                // Chainlink failed
            }
        }

        // Determine final prices
        if (pythP > 0 && chainlinkP > 0) {
            // Both available: check deviation
            markPrice = pythP;
            indexPrice = chainlinkP;
            source = 2; // Both
        } else if (pythP > 0) {
            markPrice = pythP;
            indexPrice = pythP; // Use Pyth for both if no Chainlink
            source = 0;
        } else if (chainlinkP > 0) {
            markPrice = chainlinkP;
            indexPrice = chainlinkP;
            source = 1;
        } else {
            revert PriceNegativeOrZero(marketId, 0);
        }
    }

    // ============================================================
    //                   PRICE PUSH FUNCTIONS
    // ============================================================

    /// @notice Update Pyth prices and push to PerpEngine
    /// @param marketId The SUR market ID
    /// @param pythUpdateData Pyth price update data (from Pyth Hermes API)
    /// @dev Keeper calls this with fresh Pyth data. The Pyth update fee
    ///      is paid by the caller (msg.value).
    function pushPriceWithPyth(
        bytes32 marketId,
        bytes[] calldata pythUpdateData
    ) external payable onlyOperator feedExists(marketId) {
        // Update Pyth on-chain
        uint256 fee = pyth.getUpdateFee(pythUpdateData);
        pyth.updatePriceFeeds{value: fee}(pythUpdateData);

        emit PythUpdateSubmitted(fee, block.timestamp);

        // Read prices and push
        _pushPrice(marketId);

        // Refund excess ETH
        if (msg.value > fee) {
            (bool success,) = msg.sender.call{value: msg.value - fee}("");
            require(success, "ETH refund failed");
        }
    }

    /// @notice Push price to PerpEngine using already-fresh oracle data
    /// @param marketId The SUR market ID
    /// @dev Use when Pyth has already been updated recently (e.g., by another tx)
    function pushPrice(bytes32 marketId)
        external
        onlyOperator
        feedExists(marketId)
    {
        _pushPrice(marketId);
    }

    /// @notice Push prices for multiple markets at once
    /// @param marketIds Array of market IDs to update
    function pushPriceBatch(bytes32[] calldata marketIds)
        external
        onlyOperator
    {
        for (uint256 i = 0; i < marketIds.length;) {
            if (feeds[marketIds[i]].active) {
                _pushPrice(marketIds[i]);
            }
            unchecked { ++i; }
        }
    }

    /// @notice Update Pyth and push prices for multiple markets
    function pushPriceBatchWithPyth(
        bytes32[] calldata marketIds,
        bytes[] calldata pythUpdateData
    ) external payable onlyOperator {
        // Update Pyth once
        uint256 fee = pyth.getUpdateFee(pythUpdateData);
        pyth.updatePriceFeeds{value: fee}(pythUpdateData);

        emit PythUpdateSubmitted(fee, block.timestamp);

        // Push each market
        for (uint256 i = 0; i < marketIds.length;) {
            if (feeds[marketIds[i]].active) {
                _pushPrice(marketIds[i]);
            }
            unchecked { ++i; }
        }

        // Refund
        if (msg.value > fee) {
            (bool success,) = msg.sender.call{value: msg.value - fee}("");
            require(success, "ETH refund failed");
        }
    }

    // ============================================================
    //                  INTERNAL FUNCTIONS
    // ============================================================

    /// @notice Read prices from oracles and push to PerpEngine
    function _pushPrice(bytes32 marketId) internal {
        (uint256 markPrice, uint256 indexPrice, uint8 source) = getPrice(marketId);

        // Check deviation between sources if both available
        FeedConfig memory feed = feeds[marketId];
        if (source == 2 && feed.maxDeviationBps > 0) {
            uint256 deviation = _calculateDeviation(markPrice, indexPrice);
            if (deviation > feed.maxDeviationBps) {
                emit DeviationWarning(marketId, markPrice, indexPrice, deviation);
                // Don't revert - use Pyth as mark, Chainlink as index
                // but warn the operator. In severe cases, operator should pause.
                if (deviation > feed.maxDeviationBps * 3) {
                    // >3x max deviation: something is very wrong, revert
                    revert PriceDeviationTooHigh(marketId, markPrice, indexPrice, deviation);
                }
            }
        }

        // Price change circuit breaker
        uint256 prevPrice = lastPrice[marketId];
        if (prevPrice > 0 && maxPriceChangeBps > 0) {
            uint256 changeBps = _calculateDeviation(markPrice, prevPrice);
            if (changeBps > maxPriceChangeBps) {
                oracleCircuitBreakerActive = true;
                oracleCircuitBreakerTriggeredAt = block.timestamp;
                emit OracleCircuitBreakerTriggered(marketId, prevPrice, markPrice, changeBps, block.timestamp);
                // Still push the price (so liquidations use accurate price)
                // but the flag will block new positions in PerpEngine
            }
        }

        // Push to PerpEngine
        engine.updateMarkPrice(marketId, markPrice, indexPrice);

        // Track last price
        lastPrice[marketId] = markPrice;
        lastPriceTimestamp[marketId] = block.timestamp;

        emit PriceUpdated(marketId, markPrice, indexPrice, source, block.timestamp);
    }

    /// @notice Normalize Pyth price to 6 decimals
    /// @dev Pyth prices have variable exponents. E.g., price=5000000, expo=-2 = $50,000.00
    ///      We need to convert to our 6-decimal format: 50_000_000_000
    function _normalizePythPrice(int64 price, int32 expo)
        internal
        pure
        returns (uint256)
    {
        if (price <= 0) return 0;

        uint256 absPrice = uint256(uint64(price));

        // Target: 6 decimals. Pyth expo tells us current decimals.
        // If expo = -8, price has 8 decimals → need to divide by 10^(8-6) = 100
        // If expo = -4, price has 4 decimals → need to multiply by 10^(6-4) = 100

        int32 targetExpo = -int32(int256(TARGET_DECIMALS)); // -6

        if (expo >= targetExpo) {
            // Price has fewer decimals than target, multiply
            uint256 scale = 10 ** uint32(expo - targetExpo);
            return absPrice * scale;
        } else {
            // Price has more decimals than target, divide
            uint256 scale = 10 ** uint32(targetExpo - expo);
            return absPrice / scale;
        }
    }

    /// @notice Normalize Chainlink price to 6 decimals
    /// @dev Chainlink usually uses 8 decimals for crypto feeds
    function _normalizeChainlinkPrice(uint256 price, uint8 feedDecimals)
        internal
        pure
        returns (uint256)
    {
        if (feedDecimals == TARGET_DECIMALS) {
            return price;
        } else if (feedDecimals > TARGET_DECIMALS) {
            return price / (10 ** (feedDecimals - TARGET_DECIMALS));
        } else {
            return price * (10 ** (TARGET_DECIMALS - feedDecimals));
        }
    }

    /// @notice Calculate deviation between two prices in BPS
    function _calculateDeviation(uint256 priceA, uint256 priceB)
        internal
        pure
        returns (uint256)
    {
        if (priceA == 0 || priceB == 0) return BPS; // 100% deviation

        uint256 diff = priceA > priceB ? priceA - priceB : priceB - priceA;
        uint256 avg = (priceA + priceB) / 2;

        return (diff * BPS) / avg;
    }

    // ============================================================
    //                     VIEW FUNCTIONS
    // ============================================================

    /// @notice Get the number of configured feeds
    function feedCount() external view returns (uint256) {
        return configuredMarkets.length;
    }

    /// @notice Get last pushed price for a market
    function getLastPrice(bytes32 marketId)
        external
        view
        returns (uint256 price, uint256 timestamp)
    {
        return (lastPrice[marketId], lastPriceTimestamp[marketId]);
    }

    /// @notice Check if oracle circuit breaker is active (for PerpEngine to query)
    function isOracleHealthy() external view returns (bool) {
        if (!oracleCircuitBreakerActive) return true;
        // Auto-reset after cooldown
        if (block.timestamp - oracleCircuitBreakerTriggeredAt >= oracleCooldownSecs) return true;
        return false;
    }

    /// @notice Check if price data is fresh enough for a market
    function isPriceFresh(bytes32 marketId) external view returns (bool) {
        FeedConfig memory feed = feeds[marketId];
        if (!feed.active) return false;
        if (lastPriceTimestamp[marketId] == 0) return false;
        return (block.timestamp - lastPriceTimestamp[marketId]) <= feed.maxStalenessSeconds;
    }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    function setOperator(address op, bool status) external onlyOwner {
        if (op == address(0)) revert ZeroAddress();
        operators[op] = status;
        emit OperatorUpdated(op, status);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    function setOracleCircuitBreakerParams(uint256 cooldownSecs, uint256 maxChangeBps) external onlyOwner {
        oracleCooldownSecs = cooldownSecs;
        maxPriceChangeBps = maxChangeBps;
    }

    function resetOracleCircuitBreaker() external onlyOwner {
        oracleCircuitBreakerActive = false;
        emit OracleCircuitBreakerReset(block.timestamp);
    }

    /// @notice Receive ETH for Pyth update fees
    receive() external payable {}
}
