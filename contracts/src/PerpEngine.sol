// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IPerpVault} from "./interfaces/ISurInterfaces.sol";

/// @title SUR Protocol - PerpEngine
/// @author SUR Protocol Team
/// @notice Manages perpetual futures positions, margin, PnL, and funding rates.
/// @dev This contract does NOT hold funds. All collateral lives in PerpVault.
///      PerpEngine is an operator on PerpVault — it can move balances between
///      accounts to settle PnL and lock/unlock margin.
///
///      Precision model:
///      - Prices: 6 decimal places (1e6), matches USDC precision
///      - Sizes: 8 decimal places (1e8), matches engine quantity
///      - USDC amounts: 6 decimal places (native USDC)
///      - Funding rates: 18 decimal places (high precision for small rates)
///
///      Position model:
///      - size > 0 = LONG, size < 0 = SHORT, size == 0 = no position
///      - Each account has one position per market (net position)
///      - Opening opposite side reduces/flips the position
///
///      Margin model:
///      - initialMarginBps: required margin to open (e.g., 500 = 5% = 20x max leverage)
///      - maintenanceMarginBps: below this = liquidatable (e.g., 250 = 2.5%)
///      - margin is locked in the engine's vault balance, deducted from trader

contract PerpEngine {
    // ============================================================
    //                        CONSTANTS
    // ============================================================

    uint256 public constant PRICE_PRECISION = 1e6;
    uint256 public constant SIZE_PRECISION = 1e8;
    uint256 public constant FUNDING_PRECISION = 1e18;
    uint256 public constant BPS = 10_000;

    // ============================================================
    //                          ERRORS
    // ============================================================

    error NotOwner();
    error NotOperator();
    error Paused();
    error NotPaused();
    error ZeroAmount();
    error ZeroAddress();
    error MarketNotFound(bytes32 marketId);
    error MarketAlreadyExists(bytes32 marketId);
    error MarketPaused(bytes32 marketId);
    error InsufficientMargin(uint256 required, uint256 available);
    error NoPosition();
    error InvalidPrice();
    error MaxPositionExceeded(uint256 requested, uint256 max);
    error StalePrice(uint256 lastUpdate, uint256 maxAge);
    error CannotSwitchModeWithPositions();
    error CrossMarginAccountLiquidatable();
    error CircuitBreakerActive();
    error ExposureLimitExceeded(uint256 traderNotional, uint256 maxAllowed);
    error OiCapExceeded(bytes32 marketId, uint256 currentOi, uint256 cap);
    error ReserveFactorExceeded(bytes32 marketId, uint256 oiNotional, uint256 maxNotional);
    error OiSkewCapExceeded(bytes32 marketId, uint256 dominantSide, uint256 totalOi);
    error InvalidParam();

    // ============================================================
    //                          EVENTS
    // ============================================================

    event MarginModeChanged(address indexed trader, MarginMode newMode);
    event ExposureLimitUpdated(uint256 newLimitBps);
    event MarginTiersUpdated(bytes32 indexed marketId, uint256 tierCount);
    event OiCapUpdated(bytes32 indexed marketId, uint256 newCap);
    event OiSkewCapUpdated(uint256 newCapBps);
    event ReserveFactorUpdated(uint256 newFactorBps);
    event PriceImpactParamsUpdated(bytes32 indexed marketId, uint256 impactExponentBps, uint256 impactFactorBps);
    event PriceImpactApplied(bytes32 indexed marketId, address indexed trader, uint256 impactUsdc, bool worsensSkew);

    event PositionOpened(
        bytes32 indexed marketId,
        address indexed trader,
        int256 size,
        uint256 entryPrice,
        uint256 margin
    );

    event PositionModified(
        bytes32 indexed marketId,
        address indexed trader,
        int256 oldSize,
        int256 newSize,
        uint256 newEntryPrice,
        uint256 newMargin,
        int256 realizedPnl
    );

    event PositionClosed(
        bytes32 indexed marketId,
        address indexed trader,
        int256 closedSize,
        uint256 exitPrice,
        int256 realizedPnl
    );

    event MarkPriceUpdated(
        bytes32 indexed marketId,
        uint256 oldPrice,
        uint256 newPrice,
        uint256 timestamp
    );

    event FundingRateUpdated(
        bytes32 indexed marketId,
        int256 fundingRate,
        int256 cumulativeFunding,
        uint256 timestamp
    );

    event FundingApplied(
        bytes32 indexed marketId,
        address indexed trader,
        int256 fundingPayment
    );

    event MarketAdded(
        bytes32 indexed marketId,
        string name,
        uint256 initialMarginBps,
        uint256 maintenanceMarginBps
    );

    event OperatorUpdated(address indexed operator, bool status);
    event PauseStatusChanged(bool isPaused);
    event CircuitBreakerTriggered(bytes32 indexed marketId, uint256 liquidatedNotional, uint256 openInterestNotional, uint256 timestamp);
    event CircuitBreakerReset(uint256 timestamp);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);

    // ============================================================
    //                        STRUCTS
    // ============================================================

    /// @notice Configuration for a perpetual market
    struct Market {
        bytes32 id;
        string name;
        bool active;
        uint256 initialMarginBps;       // 500 = 5% = 20x max leverage
        uint256 maintenanceMarginBps;   // 250 = 2.5%
        uint256 maxPositionSize;        // in SIZE_PRECISION units
        uint256 markPrice;              // 6 decimals
        uint256 indexPrice;             // 6 decimals
        uint256 lastPriceUpdate;
        int256 cumulativeFunding;       // 18 decimals, per unit of size
        uint256 lastFundingUpdate;
        uint256 fundingIntervalSecs;    // e.g., 28800 = 8 hours
        uint256 openInterestLong;       // SIZE_PRECISION
        uint256 openInterestShort;      // SIZE_PRECISION
    }

    /// @notice A trader's position in a specific market
    struct Position {
        int256 size;                    // positive=long, negative=short (8 decimals)
        uint256 entryPrice;             // average entry price (6 decimals)
        uint256 margin;                 // locked margin in USDC (6 decimals)
        int256 lastCumulativeFunding;   // funding snapshot (18 decimals)
        uint256 lastUpdated;
    }

    /// @notice A leverage tier bracket (like tax brackets)
    struct MarginTier {
        uint256 maxNotional;            // max notional for this tier (USDC 6 dec). 0 = unlimited (last tier)
        uint256 initialMarginBps;       // initial margin requirement for this tier
        uint256 maintenanceMarginBps;   // maintenance margin for this tier
    }

    // ============================================================
    //                      MARGIN MODES
    // ============================================================

    enum MarginMode { ISOLATED, CROSS }

    // ============================================================
    //                          STATE
    // ============================================================

    address public owner;
    address public pendingOwner;
    bool public paused;
    IPerpVault public vault;

    uint256 public maxPriceAge = 60;

    mapping(bytes32 => Market) public markets;
    bytes32[] public marketIds;

    /// @notice Positions: marketId => trader => Position
    mapping(bytes32 => mapping(address => Position)) public positions;

    mapping(address => bool) public operators;

    address public feeRecipient;
    address public insuranceFund;

    /// @notice Dedicated funding pool account (C-2 fix: separated from feeRecipient)
    /// @dev Funding flows between longs and shorts through this pool, not fee collection.
    ///      Must be funded separately from protocol fees.
    address public fundingPool;

    /// @notice Margin mode per trader (default: ISOLATED)
    mapping(address => MarginMode) public traderMarginMode;

    /// @notice Track which markets a trader has positions in (for cross-margin equity calculation)
    mapping(address => bytes32[]) public traderActiveMarkets;

    /// @notice G-06/G-07: O(1) lookup for active market membership + index
    /// @dev Maps trader => marketId => (index + 1) in traderActiveMarkets. 0 = not present.
    mapping(address => mapping(bytes32 => uint256)) internal _activeMarketIndex;

    /// @notice Max trader exposure as % of total vault deposits (in BPS). 0 = disabled.
    uint256 public maxExposureBps = 500; // 5% of total vault TVL per trader

    // Circuit breaker state
    uint256 public circuitBreakerWindowSecs = 60;
    uint256 public circuitBreakerThresholdBps = 500;
    bool public circuitBreakerActive;
    uint256 public circuitBreakerCooldownSecs = 300;
    uint256 public circuitBreakerTriggeredAt;
    mapping(bytes32 => uint256) public liquidatedInWindow;
    mapping(bytes32 => uint256) public windowStart;

    /// @notice Tiered margin brackets per market. If empty, falls back to flat market.initialMarginBps
    mapping(bytes32 => MarginTier[]) public marketMarginTiers;

    /// @notice OI caps per market (in SIZE_PRECISION units). 0 = unlimited
    mapping(bytes32 => uint256) public marketOiCap;

    /// @notice OI skew cap in BPS (max % one side can be of total OI). Default 7000 = 70%
    uint256 public oiSkewCapBps = 7000;

    /// @notice Reserve factor: max OI notional as % of pool TVL (in BPS). 0 = disabled.
    /// @dev GMX-inspired. Prevents OI from exceeding a fraction of available liquidity.
    ///      E.g., 8000 = OI notional can be at most 80% of vault totalDeposits.
    uint256 public reserveFactorBps = 0;

    /// @notice Price impact parameters per market (GMX-inspired quadratic model)
    /// @dev impactFee = (sizeDelta / totalOI)^2 * impactFactorBps / BPS
    ///      Only applied to trades that WORSEN the OI skew.
    struct PriceImpactConfig {
        uint256 impactFactorBps;    // base impact factor (e.g., 100 = 1%)
        uint256 impactExponentBps;  // exponent in BPS (20000 = 2.0x, quadratic)
    }
    mapping(bytes32 => PriceImpactConfig) public priceImpactConfigs;

    // G-19: Reentrancy uses transient storage (EIP-1153) — no storage slot needed

    // ============================================================
    //                       MODIFIERS
    // ============================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier marketExists(bytes32 marketId) {
        if (markets[marketId].id == bytes32(0)) revert MarketNotFound(marketId);
        _;
    }

    modifier marketActive(bytes32 marketId) {
        if (!markets[marketId].active) revert MarketPaused(marketId);
        _;
    }

    /// @notice Reentrancy guard (C-1 fix + G-19: transient storage for gas efficiency)
    modifier nonReentrant() {
        assembly {
            if tload(0) { revert(0, 0) }
            tstore(0, 1)
        }
        _;
        assembly { tstore(0, 0) }
    }

    // ============================================================
    //                      CONSTRUCTOR
    // ============================================================

    constructor(
        address _vault,
        address _owner,
        address _feeRecipient,
        address _insuranceFund,
        address _fundingPool
    ) {
        if (_vault == address(0) || _owner == address(0)) revert ZeroAddress();
        if (_feeRecipient == address(0) || _insuranceFund == address(0)) revert ZeroAddress();
        if (_fundingPool == address(0)) revert ZeroAddress();

        vault = IPerpVault(_vault);
        owner = _owner;
        feeRecipient = _feeRecipient;
        insuranceFund = _insuranceFund;
        fundingPool = _fundingPool;
    }

    // ============================================================
    //                   MARKET MANAGEMENT
    // ============================================================

    function addMarket(
        string calldata name,
        uint256 initialMarginBps,
        uint256 maintenanceMarginBps,
        uint256 maxPositionSize,
        uint256 fundingIntervalSecs
    ) external onlyOwner {
        bytes32 marketId = keccak256(abi.encodePacked(name));
        if (markets[marketId].id != bytes32(0)) revert MarketAlreadyExists(marketId);

        if (initialMarginBps == 0 || initialMarginBps > BPS) revert InvalidParam();
        if (maintenanceMarginBps == 0 || maintenanceMarginBps >= initialMarginBps) revert InvalidParam();
        if (maxPositionSize == 0) revert InvalidParam();
        if (fundingIntervalSecs == 0) revert InvalidParam();

        markets[marketId] = Market({
            id: marketId,
            name: name,
            active: true,
            initialMarginBps: initialMarginBps,
            maintenanceMarginBps: maintenanceMarginBps,
            maxPositionSize: maxPositionSize,
            markPrice: 0,
            indexPrice: 0,
            lastPriceUpdate: 0,
            cumulativeFunding: 0,
            lastFundingUpdate: block.timestamp,
            fundingIntervalSecs: fundingIntervalSecs,
            openInterestLong: 0,
            openInterestShort: 0
        });

        marketIds.push(marketId);
        emit MarketAdded(marketId, name, initialMarginBps, maintenanceMarginBps);
    }

    event MarketActiveChanged(bytes32 indexed marketId, bool active);

    function setMarketActive(bytes32 marketId, bool active)
        external onlyOwner marketExists(marketId)
    {
        markets[marketId].active = active;
        emit MarketActiveChanged(marketId, active); // M-9 fix
    }

    // ============================================================
    //                    PRICE MANAGEMENT
    // ============================================================

    function updateMarkPrice(bytes32 marketId, uint256 newMarkPrice, uint256 newIndexPrice)
        external onlyOperator marketExists(marketId)
    {
        if (newMarkPrice == 0 || newIndexPrice == 0) revert InvalidPrice();

        Market storage market = markets[marketId];
        uint256 oldPrice = market.markPrice;

        market.markPrice = newMarkPrice;
        market.indexPrice = newIndexPrice;
        market.lastPriceUpdate = block.timestamp;

        emit MarkPriceUpdated(marketId, oldPrice, newMarkPrice, block.timestamp);
    }

    function _requireFreshPrice(bytes32 marketId) internal view {
        Market storage market = markets[marketId];
        if (market.markPrice == 0) revert InvalidPrice();
        if (block.timestamp - market.lastPriceUpdate > maxPriceAge) {
            revert StalePrice(market.lastPriceUpdate, maxPriceAge);
        }
    }

    // ============================================================
    //                  POSITION OPERATIONS
    // ============================================================

    /// @notice Open or modify a position
    /// @param marketId The market
    /// @param trader The trader's address
    /// @param sizeDelta Size change: positive=long, negative=short (8 decimals)
    /// @param price Execution price (6 decimals)
    function openPosition(
        bytes32 marketId,
        address trader,
        int256 sizeDelta,
        uint256 price
    )
        external
        onlyOperator
        whenNotPaused
        nonReentrant
        marketExists(marketId)
        marketActive(marketId)
    {
        if (sizeDelta == 0) revert ZeroAmount();
        if (price == 0) revert InvalidPrice();
        _requireFreshPrice(marketId);

        // Circuit breaker: block new positions during active circuit breaker
        _checkCircuitBreaker();

        Market storage market = markets[marketId];
        Position storage pos = positions[marketId][trader];

        // Apply pending funding before modifying
        _applyFunding(marketId, trader);

        int256 oldSize = pos.size;
        int256 newSize = oldSize + sizeDelta;

        // Check max position size
        uint256 absNewSize = _abs(newSize);
        if (absNewSize > market.maxPositionSize) {
            revert MaxPositionExceeded(absNewSize, market.maxPositionSize);
        }

        if (oldSize == 0) {
            _openNewPosition(market, pos, trader, sizeDelta, price);
        } else if (_sameSign(oldSize, sizeDelta)) {
            _increasePosition(market, pos, trader, sizeDelta, price);
        } else {
            _reduceOrFlipPosition(market, pos, trader, sizeDelta, price);
        }
    }

    /// @notice Close an entire position
    function closePosition(
        bytes32 marketId,
        address trader,
        uint256 price
    )
        external
        onlyOperator
        whenNotPaused
        nonReentrant
        marketExists(marketId)
    {
        if (price == 0) revert InvalidPrice();
        _requireFreshPrice(marketId); // H-3 fix: require fresh oracle price for closes too

        Position storage pos = positions[marketId][trader];
        if (pos.size == 0) revert NoPosition();

        _applyFunding(marketId, trader);

        int256 closedSize = pos.size;
        int256 pnl = _calculatePnl(pos.entryPrice, price, closedSize);

        _settlePnl(trader, pnl, pos.margin);
        _updateOpenInterest(markets[marketId], closedSize, int256(0));

        emit PositionClosed(marketId, trader, closedSize, price, pnl);
        _removeActiveMarket(trader, marketId);
        delete positions[marketId][trader];
    }

    // ============================================================
    //                  FUNDING RATE
    // ============================================================

    /// @notice Calculate and apply funding rate. Callable by anyone (keeper).
    /// @dev Funding = (markPrice - indexPrice) / indexPrice per interval.
    ///      Longs pay shorts when funding > 0 (mark > index).
    function applyFundingRate(bytes32 marketId)
        external nonReentrant marketExists(marketId)
    {
        Market storage market = markets[marketId];

        uint256 elapsed = block.timestamp - market.lastFundingUpdate;
        if (elapsed < market.fundingIntervalSecs) return;
        if (market.markPrice == 0 || market.indexPrice == 0) return;

        int256 priceDiff = int256(market.markPrice) - int256(market.indexPrice);
        int256 fundingRate = (priceDiff * int256(FUNDING_PRECISION)) / int256(market.indexPrice);

        // H-4 fix: Cap funding rate per interval (max 0.1% = 1e15 in FUNDING_PRECISION)
        int256 maxFundingRate = int256(FUNDING_PRECISION) / 1000; // 0.1%
        if (fundingRate > maxFundingRate) fundingRate = maxFundingRate;
        if (fundingRate < -maxFundingRate) fundingRate = -maxFundingRate;

        // H-4 fix: Cap max periods per call to prevent accumulated wipeout
        uint256 periods = elapsed / market.fundingIntervalSecs;
        if (periods > 3) periods = 3;

        int256 totalFunding = fundingRate * int256(periods);

        market.cumulativeFunding += totalFunding;
        market.lastFundingUpdate += market.fundingIntervalSecs * periods;

        emit FundingRateUpdated(marketId, fundingRate, market.cumulativeFunding, block.timestamp);
    }

    function _applyFunding(bytes32 marketId, address trader) internal {
        Position storage pos = positions[marketId][trader];
        if (pos.size == 0) return;

        Market storage market = markets[marketId];
        int256 fundingDelta = market.cumulativeFunding - pos.lastCumulativeFunding;

        if (fundingDelta == 0) {
            pos.lastCumulativeFunding = market.cumulativeFunding;
            return;
        }

        // Payment = size * fundingDelta / FUNDING_PRECISION
        // Long + positive funding = pays. Short + positive funding = receives.
        int256 fundingPayment = (pos.size * fundingDelta) / int256(FUNDING_PRECISION);

        if (fundingPayment > 0) {
            // Trader pays funding → goes to dedicated funding pool (C-2 fix)
            uint256 payment = uint256(fundingPayment);
            if (payment > pos.margin) payment = pos.margin;
            pos.margin -= payment;
            vault.internalTransfer(trader, fundingPool, payment);
        } else if (fundingPayment < 0) {
            // Trader receives funding ← from dedicated funding pool (C-2 fix)
            uint256 receipt = uint256(-fundingPayment);
            // Graceful degradation: cap to available funding pool balance
            uint256 fpBal = vault.balances(fundingPool);
            if (receipt > fpBal) receipt = fpBal;
            if (receipt > 0) {
                pos.margin += receipt;
                vault.internalTransfer(fundingPool, trader, receipt);
            }
        }

        pos.lastCumulativeFunding = market.cumulativeFunding;
        emit FundingApplied(marketId, trader, fundingPayment);
    }

    // ============================================================
    //                   INTERNAL HELPERS
    // ============================================================

    /// @notice Calculate required margin using tiered brackets (like tax brackets)
    function _calculateTieredMargin(bytes32 marketId, uint256 notional, bool isInitial)
        internal view returns (uint256)
    {
        MarginTier[] storage tiers = marketMarginTiers[marketId];

        // Fallback to flat rate if no tiers configured
        if (tiers.length == 0) {
            Market storage market = markets[marketId];
            uint256 bpsRate = isInitial ? market.initialMarginBps : market.maintenanceMarginBps;
            return (notional * bpsRate) / BPS;
        }

        uint256 totalMargin = 0;
        uint256 remainingNotional = notional;
        uint256 prevMax = 0;

        for (uint256 i = 0; i < tiers.length && remainingNotional > 0;) {
            uint256 tierMax = tiers[i].maxNotional;
            uint256 bpsRate = isInitial ? tiers[i].initialMarginBps : tiers[i].maintenanceMarginBps;

            uint256 tierNotional;
            if (tierMax == 0) {
                tierNotional = remainingNotional; // Last tier (unlimited)
            } else {
                uint256 tierSize = tierMax - prevMax;
                tierNotional = remainingNotional > tierSize ? tierSize : remainingNotional;
            }

            totalMargin += (tierNotional * bpsRate) / BPS;
            remainingNotional -= tierNotional;
            prevMax = tierMax;
            unchecked { ++i; }
        }

        return totalMargin;
    }

    /// @notice Check if position is below maintenance using tiered brackets
    function _isBelowMaintenance(bytes32 marketId, Position storage pos, uint256 currentPrice)
        internal view returns (bool)
    {
        if (pos.size == 0) return false;
        uint256 notional = _notional(currentPrice, _abs(pos.size));
        if (notional == 0) return false;

        int256 unrealizedPnl = _calculatePnl(pos.entryPrice, currentPrice, pos.size);
        int256 effectiveMargin = int256(pos.margin) + unrealizedPnl;
        if (effectiveMargin <= 0) return true;

        uint256 maintRequired = _calculateTieredMargin(marketId, notional, false);
        return uint256(effectiveMargin) < maintRequired;
    }

    /// @notice Check OI caps after position change
    function _checkOiCaps(bytes32 marketId) internal view {
        Market storage market = markets[marketId];
        uint256 totalOi = market.openInterestLong + market.openInterestShort;

        // Check absolute OI cap
        uint256 cap = marketOiCap[marketId];
        if (cap > 0 && totalOi > cap) {
            revert OiCapExceeded(marketId, totalOi, cap);
        }

        // Check skew cap
        if (totalOi > 0 && oiSkewCapBps < BPS) {
            uint256 dominant = market.openInterestLong > market.openInterestShort
                ? market.openInterestLong : market.openInterestShort;
            uint256 dominantBps = (dominant * BPS) / totalOi;
            if (dominantBps > oiSkewCapBps) {
                revert OiSkewCapExceeded(marketId, dominant, totalOi);
            }
        }

        // Check reserve factor: OI notional must not exceed % of pool TVL
        if (reserveFactorBps > 0) {
            uint256 poolTvl = vault.totalDeposits();
            if (poolTvl > 0) {
                // Convert OI from SIZE_PRECISION to notional using mark price
                uint256 oiNotional = (totalOi * market.markPrice) / SIZE_PRECISION;
                uint256 maxOiNotional = (poolTvl * reserveFactorBps) / BPS;
                if (oiNotional > maxOiNotional) {
                    revert ReserveFactorExceeded(marketId, oiNotional, maxOiNotional);
                }
            }
        }
    }

    /// @notice Calculate price impact fee for trades that worsen OI skew
    /// @dev GMX-inspired quadratic model: fee = notional * (sizeFraction)^exponent * factor
    ///      Only penalizes the side that increases the imbalance.
    function _calculatePriceImpact(
        bytes32 marketId,
        address trader,
        int256 sizeDelta,
        uint256 notional
    ) internal returns (uint256 impactFee) {
        PriceImpactConfig storage config = priceImpactConfigs[marketId];
        if (config.impactFactorBps == 0) return 0;

        Market storage market = markets[marketId];
        uint256 totalOi = market.openInterestLong + market.openInterestShort;
        if (totalOi == 0) return 0;

        // Determine if this trade worsens the skew
        bool isLong = sizeDelta > 0;
        bool worsensSkew;
        if (market.openInterestLong >= market.openInterestShort) {
            worsensSkew = isLong; // longs dominant → going long worsens skew
        } else {
            worsensSkew = !isLong; // shorts dominant → going short worsens skew
        }

        if (!worsensSkew) return 0; // reducing skew → no penalty

        // sizeFraction = absSizeDelta / totalOi (in BPS for precision)
        uint256 sizeFractionBps = (_abs(sizeDelta) * BPS) / totalOi;

        // impactFee = notional * (sizeFractionBps/BPS)^2 * impactFactorBps / BPS
        // Quadratic: larger trades relative to OI pay disproportionately more
        impactFee = (notional * sizeFractionBps * sizeFractionBps * config.impactFactorBps)
            / (BPS * BPS * BPS);

        emit PriceImpactApplied(marketId, trader, impactFee, worsensSkew);
    }

    function _openNewPosition(
        Market storage market,
        Position storage pos,
        address trader,
        int256 sizeDelta,
        uint256 price
    ) internal {
        uint256 notional = _notional(price, _abs(sizeDelta));
        uint256 requiredMargin = _calculateTieredMargin(market.id, notional, true);

        // G-02: Cache vault.balances(trader) once, track remaining arithmetically
        uint256 available = vault.balances(trader);
        uint256 transferred;

        if (traderMarginMode[trader] == MarginMode.CROSS) {
            // Cross-margin: check total account equity covers total initial margin
            // including this new position
            _requireCrossMarginSufficient(trader, market.id, notional, market.initialMarginBps);

            // In cross mode, lock only a minimal margin per position (the required initial)
            // but the check was against total equity, so profitable positions subsidize new ones
            transferred = requiredMargin;
            if (transferred > available) {
                // This can happen when unrealized PnL from other positions covers the margin
                // Transfer what's available; the position is backed by total account equity
                transferred = available;
            }
            if (transferred > 0) {
                vault.internalTransfer(trader, address(this), transferred);
            }
            pos.margin = transferred;
        } else {
            // Isolated: strict per-position check
            if (available < requiredMargin) {
                revert InsufficientMargin(requiredMargin, available);
            }
            vault.internalTransfer(trader, address(this), requiredMargin);
            pos.margin = requiredMargin;
            transferred = requiredMargin;
        }

        pos.size = sizeDelta;
        pos.entryPrice = price;
        pos.lastCumulativeFunding = market.cumulativeFunding;
        pos.lastUpdated = block.timestamp;

        _updateOpenInterest(market, int256(0), sizeDelta);
        _checkOiCaps(market.id);

        // Price impact: charge fee for trades worsening OI skew
        uint256 impactFee = _calculatePriceImpact(market.id, trader, sizeDelta, notional);
        if (impactFee > 0) {
            // G-02: Use cached balance minus what was already transferred
            uint256 remainingBal = available - transferred;
            uint256 fee = impactFee > remainingBal ? remainingBal : impactFee;
            if (fee > 0) {
                vault.internalTransfer(trader, feeRecipient, fee);
            }
        }

        _addActiveMarket(trader, market.id);
        emit PositionOpened(market.id, trader, sizeDelta, price, pos.margin);
        _checkExposureLimit(trader);
    }

    function _increasePosition(
        Market storage market,
        Position storage pos,
        address trader,
        int256 sizeDelta,
        uint256 price
    ) internal {
        int256 oldSize = pos.size;
        uint256 absOldSize = _abs(oldSize);
        uint256 absDelta = _abs(sizeDelta);

        // Weighted average entry price
        uint256 newEntryPrice = (
            (pos.entryPrice * absOldSize) + (price * absDelta)
        ) / (absOldSize + absDelta);

        // Tiered margin: calculate total required for full position, subtract existing
        uint256 totalNotionalAfter = _notional(newEntryPrice, absOldSize + absDelta);
        uint256 totalRequiredMargin = _calculateTieredMargin(market.id, totalNotionalAfter, true);
        uint256 additionalMargin = totalRequiredMargin > pos.margin ? totalRequiredMargin - pos.margin : 0;

        // G-03: Cache vault.balances(trader) once, track remaining arithmetically
        uint256 available = vault.balances(trader);
        uint256 transferred;

        if (traderMarginMode[trader] == MarginMode.CROSS) {
            // Cross-margin: check total equity covers total initial margin after increase
            _requireCrossMarginSufficient(trader, market.id, totalNotionalAfter, market.initialMarginBps);

            transferred = additionalMargin;
            if (transferred > available) {
                transferred = available;
            }
            if (transferred > 0) {
                vault.internalTransfer(trader, address(this), transferred);
            }
            pos.margin += transferred;
        } else {
            // Isolated: strict per-position check
            if (available < additionalMargin) {
                revert InsufficientMargin(additionalMargin, available);
            }
            vault.internalTransfer(trader, address(this), additionalMargin);
            pos.margin += additionalMargin;
            transferred = additionalMargin;
        }

        int256 newSize = oldSize + sizeDelta;
        pos.size = newSize;
        pos.entryPrice = newEntryPrice;
        pos.lastUpdated = block.timestamp;

        _updateOpenInterest(market, oldSize, newSize);
        _checkOiCaps(market.id);

        // Price impact on the increase delta
        uint256 deltaNotional = _notional(price, absDelta);
        uint256 impactFee = _calculatePriceImpact(market.id, trader, sizeDelta, deltaNotional);
        if (impactFee > 0) {
            // G-03: Use cached balance minus what was already transferred
            uint256 remainingBal = available - transferred;
            uint256 fee = impactFee > remainingBal ? remainingBal : impactFee;
            if (fee > 0) {
                vault.internalTransfer(trader, feeRecipient, fee);
            }
        }

        emit PositionModified(market.id, trader, oldSize, newSize, newEntryPrice, pos.margin, 0);
        _checkExposureLimit(trader);
    }

    function _reduceOrFlipPosition(
        Market storage market,
        Position storage pos,
        address trader,
        int256 sizeDelta,
        uint256 price
    ) internal {
        int256 oldSize = pos.size;
        int256 newSize = oldSize + sizeDelta;

        // Determine how much of the old position is being closed
        uint256 closingSize;
        if (_abs(sizeDelta) <= _abs(oldSize)) {
            closingSize = _abs(sizeDelta);
        } else {
            closingSize = _abs(oldSize); // full close (may flip)
        }

        // Realized PnL on the closed portion
        int256 closedSizeSigned = oldSize > 0 ? int256(closingSize) : -int256(closingSize);
        int256 realizedPnl = _calculatePnl(pos.entryPrice, price, closedSizeSigned);

        // Release proportional margin (full margin on full close to avoid dust)
        uint256 releasedMargin = (newSize == 0)
            ? pos.margin
            : (pos.margin * closingSize) / _abs(oldSize);
        _settlePnl(trader, realizedPnl, releasedMargin);
        pos.margin -= releasedMargin;

        if (newSize == 0) {
            // Fully closed
            _updateOpenInterest(market, oldSize, int256(0));
            emit PositionClosed(market.id, trader, oldSize, price, realizedPnl);
            _removeActiveMarket(trader, market.id);
            delete positions[market.id][trader];
        } else if (_sameSign(oldSize, newSize)) {
            // Partial close (same direction, smaller)
            pos.size = newSize;
            pos.lastUpdated = block.timestamp;
            _updateOpenInterest(market, oldSize, newSize);
            emit PositionModified(market.id, trader, oldSize, newSize, pos.entryPrice, pos.margin, realizedPnl);
        } else {
            // Flip: close old fully, open new in opposite direction
            _updateOpenInterest(market, oldSize, int256(0));
            emit PositionClosed(market.id, trader, oldSize, price, realizedPnl);

            int256 remainingDelta = newSize;
            pos.size = 0;
            pos.entryPrice = 0;
            pos.margin = 0;
            _openNewPosition(market, pos, trader, remainingDelta, price);
        }
    }

    /// @notice Settle PnL: return margin +/- PnL to trader
    /// @dev Core clearing logic. The engine acts as central counterparty:
    ///      - Losers' losses STAY in the engine pool (fund winners)
    ///      - Winners get margin + profit FROM the pool
    ///      - If pool is short (bad debt), insurance fund covers the gap
    function _settlePnl(address trader, int256 pnl, uint256 releasedMargin) internal {
        if (pnl >= 0) {
            // Winner: return margin + profit
            uint256 totalReturn = releasedMargin + uint256(pnl);
            uint256 engineBal = vault.balances(address(this));

            if (totalReturn > engineBal) {
                // Engine can't fully cover → pull shortfall from insurance
                uint256 shortfall = totalReturn - engineBal;
                uint256 insuranceBal = vault.balances(insuranceFund);
                if (shortfall > insuranceBal) shortfall = insuranceBal;
                if (shortfall > 0) {
                    vault.internalTransfer(insuranceFund, address(this), shortfall);
                }
                // Cap totalReturn to what's actually available
                uint256 available = vault.balances(address(this));
                if (totalReturn > available) totalReturn = available;
            }

            vault.internalTransfer(address(this), trader, totalReturn);
        } else {
            uint256 loss = uint256(-pnl);
            if (loss >= releasedMargin) {
                // Loss exceeds margin: trader gets nothing
                // Margin stays in engine pool (covers counterparties)
                // Bad debt = loss - margin (tracked by insurance fund externally)
            } else {
                // Partial loss: return remaining to trader
                uint256 returnAmount = releasedMargin - loss;
                vault.internalTransfer(address(this), trader, returnAmount);
                // Loss portion stays in engine pool naturally
            }
        }
    }

    function _updateOpenInterest(Market storage market, int256 oldSize, int256 newSize) internal {
        if (oldSize > 0) market.openInterestLong -= _abs(oldSize);
        else if (oldSize < 0) market.openInterestShort -= _abs(oldSize);

        if (newSize > 0) market.openInterestLong += _abs(newSize);
        else if (newSize < 0) market.openInterestShort += _abs(newSize);
    }

    // ============================================================
    //                     MATH HELPERS
    // ============================================================

    /// @notice Notional value: price * absSize / SIZE_PRECISION → USDC (6 dec)
    function _notional(uint256 price, uint256 absSize) internal pure returns (uint256) {
        return (price * absSize) / SIZE_PRECISION;
    }

    /// @notice Track liquidation volume and trigger circuit breaker if threshold exceeded
    function _trackLiquidation(bytes32 marketId, uint256 liquidatedNotional) internal {
        // Reset window if expired
        if (block.timestamp - windowStart[marketId] > circuitBreakerWindowSecs) {
            windowStart[marketId] = block.timestamp;
            liquidatedInWindow[marketId] = 0;
        }

        liquidatedInWindow[marketId] += liquidatedNotional;

        // Calculate total OI notional for this market
        Market storage market = markets[marketId];
        uint256 totalOI = market.openInterestLong + market.openInterestShort;
        uint256 oiNotional = _notional(market.markPrice, totalOI);

        if (oiNotional > 0) {
            uint256 liquidatedRatioBps = (liquidatedInWindow[marketId] * BPS) / oiNotional;
            if (liquidatedRatioBps >= circuitBreakerThresholdBps) {
                circuitBreakerActive = true;
                circuitBreakerTriggeredAt = block.timestamp;
                emit CircuitBreakerTriggered(marketId, liquidatedInWindow[marketId], oiNotional, block.timestamp);
            }
        }
    }

    /// @dev G-10: Extracted from liquidatePosition to reduce stack depth
    function _distributeLiquidationRewards(
        bytes32 marketId,
        address keeper,
        uint256 currentPrice,
        uint256 liquidateSize,
        uint256 releasedMargin,
        int256 pnl
    ) internal returns (int256 badDebt, uint256 keeperReward, uint256 insurancePayout) {
        uint256 liquidatedNotional = _notional(currentPrice, liquidateSize);
        int256 effectiveMargin = int256(releasedMargin) + pnl;

        if (effectiveMargin <= 0) {
            badDebt = -effectiveMargin;
            keeperReward = (liquidatedNotional * 5) / BPS; // 0.05%
            // Graceful degradation: if insurance fund is depleted, pay what's available
            uint256 insuranceBal = vault.balances(insuranceFund);
            if (keeperReward > insuranceBal) keeperReward = insuranceBal;
            if (keeperReward > 0) {
                vault.internalTransfer(insuranceFund, keeper, keeperReward);
            }
        } else {
            uint256 remaining = uint256(effectiveMargin);
            uint256 maxReward = (liquidatedNotional * 500) / BPS; // cap 5%
            keeperReward = remaining / 2;
            if (keeperReward > maxReward) keeperReward = maxReward;
            insurancePayout = remaining - keeperReward;

            vault.internalTransfer(address(this), keeper, keeperReward);
            if (insurancePayout > 0) {
                vault.internalTransfer(address(this), insuranceFund, insurancePayout);
            }
        }

        _trackLiquidation(marketId, liquidatedNotional);
    }

    /// @notice Check circuit breaker status and auto-reset after cooldown
    /// @dev M-5 fix: Removed O(n) market loop — per-market windows reset lazily in _trackLiquidation
    function _checkCircuitBreaker() internal {
        if (!circuitBreakerActive) return;
        // Auto-reset after cooldown
        if (block.timestamp - circuitBreakerTriggeredAt >= circuitBreakerCooldownSecs) {
            circuitBreakerActive = false;
            // Per-market windows reset lazily in _trackLiquidation when window expires
            emit CircuitBreakerReset(block.timestamp);
            return;
        }
        revert CircuitBreakerActive();
    }

    /// @notice PnL = (exitPrice - entryPrice) * size / SIZE_PRECISION
    function _calculatePnl(uint256 entryPrice, uint256 exitPrice, int256 size)
        internal pure returns (int256)
    {
        int256 priceDiff = int256(exitPrice) - int256(entryPrice);
        return (priceDiff * size) / int256(SIZE_PRECISION);
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    function _sameSign(int256 a, int256 b) internal pure returns (bool) {
        return (a > 0 && b > 0) || (a < 0 && b < 0);
    }

    // ============================================================
    //                      LIQUIDATION
    // ============================================================

    event PositionLiquidated(
        bytes32 indexed marketId,
        address indexed trader,
        address indexed keeper,
        int256 size,
        uint256 markPrice,
        int256 pnl,
        uint256 remainingMargin,
        uint256 keeperReward,
        uint256 insurancePayout,
        int256 badDebt
    );

    /// @notice Liquidate an undercollateralized position (PARTIAL — 25% per round)
    /// @dev Closes 25% of position at mark price. If still underwater, can be called again.
    ///      Distribution:
    ///      - Healthy (effectiveMargin > 0): keeper gets portion, insurance gets rest
    ///      - Underwater (effectiveMargin <= 0): margin stays in engine pool,
    ///        keeper gets small reward from insurance fund
    function liquidatePosition(
        bytes32 marketId,
        address trader,
        address keeper
    ) external onlyOperator whenNotPaused nonReentrant marketExists(marketId) {
        // Cross-margin traders must be liquidated via liquidateAccount()
        if (traderMarginMode[trader] == MarginMode.CROSS) {
            revert NotLiquidatable();
        }

        Position storage pos = positions[marketId][trader];
        if (pos.size == 0) revert NoPosition();

        Market storage market = markets[marketId];
        uint256 currentPrice = market.markPrice;
        if (currentPrice == 0) revert InvalidPrice();

        // H-1 fix: Apply pending funding BEFORE liquidation check
        // Positions that become solvent after receiving funding should not be liquidated
        _applyFunding(marketId, trader);

        // Verify position is actually liquidatable (uses tiered maintenance, post-funding margin)
        if (!_isBelowMaintenance(marketId, pos, currentPrice)) {
            revert NotLiquidatable();
        }

        int256 oldSize = pos.size;
        uint256 absOldSize = _abs(oldSize);

        // Partial liquidation: 25% per round (full close if tiny position)
        uint256 liquidateSize = absOldSize / 4;
        if (liquidateSize == 0 || absOldSize <= SIZE_PRECISION / 100) {
            liquidateSize = absOldSize; // close fully if tiny
        }

        bool isFullClose = liquidateSize >= absOldSize;
        if (isFullClose) liquidateSize = absOldSize;

        // PnL on liquidated portion
        int256 pnl = _calculatePnl(
            pos.entryPrice, currentPrice,
            oldSize > 0 ? int256(liquidateSize) : -int256(liquidateSize)
        );

        {
            // Scoped block to reduce stack depth
            uint256 releasedMargin = isFullClose ? pos.margin : (pos.margin * liquidateSize) / absOldSize;

            (int256 badDebt, uint256 keeperReward, uint256 insurancePayout) =
                _distributeLiquidationRewards(marketId, keeper, currentPrice, liquidateSize, releasedMargin, pnl);

            // Update position or delete
            if (isFullClose) {
                _updateOpenInterest(market, oldSize, int256(0));
                _removeActiveMarket(trader, marketId);
                delete positions[marketId][trader];
            } else {
                int256 newSize = oldSize > 0
                    ? oldSize - int256(liquidateSize)
                    : oldSize + int256(liquidateSize);
                pos.size = newSize;
                pos.margin -= releasedMargin;
                pos.lastUpdated = block.timestamp;
                _updateOpenInterest(market, oldSize, newSize);
            }

            int256 effectiveMargin = int256(releasedMargin) + pnl;
            emit PositionLiquidated(
                marketId, trader, keeper,
                oldSize > 0 ? int256(liquidateSize) : -int256(liquidateSize),
                currentPrice, pnl,
                uint256(effectiveMargin > 0 ? effectiveMargin : int256(0)),
                keeperReward, insurancePayout, badDebt
            );
        }
    }

    error NotLiquidatable();

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /// @notice Get full position details with computed fields
    function getPosition(bytes32 marketId, address trader)
        external view returns (
            int256 size,
            uint256 entryPrice,
            uint256 margin,
            int256 unrealizedPnl,
            uint256 marginRatioBps
        )
    {
        Position storage pos = positions[marketId][trader];
        size = pos.size;
        entryPrice = pos.entryPrice;
        margin = pos.margin;

        if (size != 0) {
            unrealizedPnl = _calculatePnl(pos.entryPrice, markets[marketId].markPrice, size);
            marginRatioBps = _marginRatio(pos, markets[marketId].markPrice);
        }
    }

    /// @notice Margin ratio in BPS
    function _marginRatio(Position storage pos, uint256 currentPrice)
        internal view returns (uint256)
    {
        if (pos.size == 0) return type(uint256).max;
        uint256 notional = _notional(currentPrice, _abs(pos.size));
        if (notional == 0) return type(uint256).max;

        int256 unrealizedPnl = _calculatePnl(pos.entryPrice, currentPrice, pos.size);
        int256 effectiveMargin = int256(pos.margin) + unrealizedPnl;
        if (effectiveMargin <= 0) return 0;

        return (uint256(effectiveMargin) * BPS) / notional;
    }

    /// @notice Check if position is liquidatable (respects margin mode)
    function isLiquidatable(bytes32 marketId, address trader)
        external view marketExists(marketId) returns (bool)
    {
        Position storage pos = positions[marketId][trader];
        if (pos.size == 0) return false;

        if (traderMarginMode[trader] == MarginMode.CROSS) {
            return _isAccountLiquidatable(trader);
        }

        // Isolated mode: check this position using tiered maintenance
        return _isBelowMaintenance(marketId, pos, markets[marketId].markPrice);
    }

    /// @notice Get unrealized PnL at current mark price
    function getUnrealizedPnl(bytes32 marketId, address trader) external view returns (int256) {
        Position storage pos = positions[marketId][trader];
        if (pos.size == 0) return 0;
        return _calculatePnl(pos.entryPrice, markets[marketId].markPrice, pos.size);
    }

    /// @notice Get effective leverage (notional / margin), in 100ths (2000 = 20.00x)
    function getLeverage(bytes32 marketId, address trader) external view returns (uint256) {
        Position storage pos = positions[marketId][trader];
        if (pos.size == 0 || pos.margin == 0) return 0;
        uint256 notional = _notional(markets[marketId].markPrice, _abs(pos.size));
        return (notional * 100) / pos.margin;
    }

    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    /// @notice G-18: Lightweight OI getter for OrderSettlement dynamic spread
    /// @dev Avoids decoding 14 return values from markets() struct
    function getOpenInterest(bytes32 marketId) external view returns (uint256 oiLong, uint256 oiShort) {
        Market storage m = markets[marketId];
        oiLong = m.openInterestLong;
        oiShort = m.openInterestShort;
    }

    // ============================================================
    //                   CROSS MARGIN
    // ============================================================

    /// @notice Switch margin mode. Can only switch when NO open positions.
    function setMarginMode(MarginMode mode) external whenNotPaused {
        address trader = msg.sender;
        if (traderActiveMarkets[trader].length > 0) {
            revert CannotSwitchModeWithPositions();
        }
        traderMarginMode[trader] = mode;
        emit MarginModeChanged(trader, mode);
    }

    /// @notice Check if cross-margin account has sufficient equity for initial margin
    /// @dev Called during openPosition/increasePosition in cross mode
    /// @param trader The trader
    /// @param excludeMarketId Market to exclude from existing check (being updated)
    /// @param newNotional Notional of the new/updated position
    /// @param newInitialBps Initial margin BPS for the new/updated position
    function _requireCrossMarginSufficient(
        address trader,
        bytes32 excludeMarketId,
        uint256 newNotional,
        uint256 newInitialBps
    ) internal view {
        // Total initial margin required across all positions (excluding the one being modified)
        uint256 totalInitialRequired = 0;
        int256 totalEquity = int256(vault.balances(trader));

        bytes32[] storage activeMarkets = traderActiveMarkets[trader];
        for (uint256 i = 0; i < activeMarkets.length;) {
            bytes32 mId = activeMarkets[i];
            Position storage pos = positions[mId][trader];

            if (pos.size != 0) {
                Market storage m = markets[mId];
                uint256 absSize = _abs(pos.size);
                uint256 notional = _notional(m.markPrice, absSize);

                int256 pnl = _calculatePnl(pos.entryPrice, m.markPrice, pos.size);
                totalEquity += int256(pos.margin) + pnl;

                if (mId != excludeMarketId) {
                    totalInitialRequired += (notional * m.initialMarginBps) / BPS;
                }
            }
            unchecked { ++i; }
        }

        // Add the new/modified position's requirement
        totalInitialRequired += (newNotional * newInitialBps) / BPS;

        if (totalEquity < int256(totalInitialRequired)) {
            revert InsufficientMargin(totalInitialRequired, totalEquity > 0 ? uint256(totalEquity) : 0);
        }
    }

    /// @notice Get total account equity for a trader (cross-margin metric)
    /// @return equity = free vault balance + sum(margin + unrealizedPnL) for all positions
    /// @return totalMaintRequired = sum(notional * maintenanceMarginBps / BPS) for all positions
    function getAccountEquity(address trader)
        public view returns (int256 equity, uint256 totalMaintRequired)
    {
        int256 positionEquity = int256(0);
        totalMaintRequired = 0;

        bytes32[] storage activeMarkets = traderActiveMarkets[trader];
        for (uint256 i = 0; i < activeMarkets.length;) {
            bytes32 mId = activeMarkets[i];
            Position storage pos = positions[mId][trader];

            if (pos.size != 0) {
                Market storage market = markets[mId];
                uint256 absSize = _abs(pos.size);
                uint256 notional = _notional(market.markPrice, absSize);

                // Position equity = margin + unrealized PnL
                int256 pnl = _calculatePnl(pos.entryPrice, market.markPrice, pos.size);
                positionEquity += int256(pos.margin) + pnl;

                // Maintenance requirement for this position
                totalMaintRequired += (notional * market.maintenanceMarginBps) / BPS;
            }

            unchecked { ++i; }
        }

        // Total equity = free vault balance + position equity
        equity = int256(vault.balances(trader)) + positionEquity;
    }

    /// @notice Get number of active positions for a trader
    function getActiveMarketCount(address trader) external view returns (uint256) {
        return traderActiveMarkets[trader].length;
    }

    /// @notice Check if a cross-margin account is liquidatable
    function _isAccountLiquidatable(address trader) internal view returns (bool) {
        (int256 equity, uint256 maintRequired) = getAccountEquity(trader);
        if (maintRequired == 0) return false;
        return equity < int256(maintRequired);
    }

    /// @notice Check if a cross-margin account is liquidatable (public view)
    function isAccountLiquidatable(address trader) external view returns (bool) {
        if (traderMarginMode[trader] != MarginMode.CROSS) return false;
        return _isAccountLiquidatable(trader);
    }

    // ============================================================
    //               MARGIN MANAGEMENT
    // ============================================================

    event MarginAdded(bytes32 indexed marketId, address indexed trader, uint256 amount);
    event MarginRemoved(bytes32 indexed marketId, address indexed trader, uint256 amount);

    /// @notice Add margin to an existing position (works in both modes)
    /// @dev In isolated mode: increases position's margin (reduces leverage)
    ///      In cross mode: moves free balance into position's locked margin
    function addMargin(bytes32 marketId, address trader, uint256 amount)
        external onlyOperator whenNotPaused nonReentrant marketExists(marketId)
    {
        if (amount == 0) revert ZeroAmount();
        Position storage pos = positions[marketId][trader];
        if (pos.size == 0) revert NoPosition();

        uint256 available = vault.balances(trader);
        if (available < amount) {
            revert InsufficientMargin(amount, available);
        }

        vault.internalTransfer(trader, address(this), amount);
        pos.margin += amount;
        pos.lastUpdated = block.timestamp;

        emit MarginAdded(marketId, trader, amount);
    }

    /// @notice Remove margin from an existing position (works in both modes)
    /// @dev In isolated mode: must keep margin >= maintenance requirement
    ///      In cross mode: must keep total account equity >= total maintenance
    function removeMargin(bytes32 marketId, address trader, uint256 amount)
        external onlyOperator whenNotPaused marketExists(marketId) nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        Position storage pos = positions[marketId][trader];
        if (pos.size == 0) revert NoPosition();
        if (pos.margin < amount) revert InsufficientMargin(amount, pos.margin);

        Market storage market = markets[marketId];

        if (traderMarginMode[trader] == MarginMode.CROSS) {
            // H-2 fix: In cross mode, removing margin from position to free balance
            // is a wash for total equity. Just check equity >= totalMaint (no subtraction).
            (int256 equity, uint256 totalMaint) = getAccountEquity(trader);
            if (equity < int256(totalMaint)) {
                revert InsufficientMargin(totalMaint, equity > 0 ? uint256(equity) : 0);
            }
        } else {
            // Isolated: check this position stays above maintenance margin
            uint256 newMargin = pos.margin - amount;
            uint256 notional = _notional(market.markPrice, _abs(pos.size));
            int256 pnl = _calculatePnl(pos.entryPrice, market.markPrice, pos.size);
            int256 effectiveMargin = int256(newMargin) + pnl;

            uint256 maintRequired = (notional * market.maintenanceMarginBps) / BPS;
            if (effectiveMargin < int256(maintRequired)) {
                revert InsufficientMargin(maintRequired, effectiveMargin > 0 ? uint256(effectiveMargin) : 0);
            }
        }

        pos.margin -= amount;
        vault.internalTransfer(address(this), trader, amount);
        pos.lastUpdated = block.timestamp;

        emit MarginRemoved(marketId, trader, amount);
    }

    /// @notice Liquidate an entire cross-margin account
    /// @dev Closes ALL positions when total account equity < total maintenance requirement.
    ///      Keeper receives reward from the remaining equity.
    ///      This is the cross-margin equivalent of liquidatePosition().
    function liquidateAccount(address trader, address keeper)
        external onlyOperator whenNotPaused nonReentrant
    {
        if (traderMarginMode[trader] != MarginMode.CROSS) revert NotLiquidatable();
        if (!_isAccountLiquidatable(trader)) revert NotLiquidatable();

        bytes32[] storage activeMarkets = traderActiveMarkets[trader];
        uint256 totalMargin = 0;
        int256 totalPnl = 0;
        uint256 totalNotional = 0;

        // Phase 1: Calculate totals and close all positions
        for (uint256 i = 0; i < activeMarkets.length;) {
            bytes32 mId = activeMarkets[i];
            Position storage pos = positions[mId][trader];

            if (pos.size != 0) {
                Market storage market = markets[mId];
                uint256 currentPrice = market.markPrice;

                // Apply pending funding FIRST (modifies pos.margin)
                _applyFunding(mId, trader);

                uint256 absSize = _abs(pos.size);
                int256 closedSize = pos.size;

                int256 pnl = _calculatePnl(pos.entryPrice, currentPrice, closedSize);
                totalPnl += pnl;
                totalMargin += pos.margin; // post-funding margin
                totalNotional += _notional(currentPrice, absSize);

                _updateOpenInterest(market, closedSize, int256(0));

                emit PositionLiquidated(
                    mId, trader, keeper,
                    closedSize, currentPrice, pnl,
                    0, 0, 0, 0 // account-level distribution below
                );

                delete positions[mId][trader];
            }

            unchecked { ++i; }
        }

        // M-7 fix: Track liquidation notional for circuit breaker before clearing
        if (activeMarkets.length > 0 && totalNotional > 0) {
            _trackLiquidation(activeMarkets[0], totalNotional);
        }

        // Clear active markets + index mapping
        for (uint256 j = 0; j < activeMarkets.length;) {
            delete _activeMarketIndex[trader][activeMarkets[j]];
            unchecked { ++j; }
        }
        delete traderActiveMarkets[trader];

        // Phase 2: Distribute remaining equity
        int256 effectiveMargin = int256(totalMargin) + totalPnl;
        uint256 keeperReward = 0;
        int256 badDebt = 0;

        if (effectiveMargin <= 0) {
            // Underwater: margin stays in engine pool, keeper paid from insurance
            badDebt = -effectiveMargin;
            keeperReward = (totalNotional * 5) / BPS; // 0.05% of total notional
            // Graceful degradation: if insurance fund is depleted, pay what's available
            uint256 insuranceBal = vault.balances(insuranceFund);
            if (keeperReward > insuranceBal) keeperReward = insuranceBal;
            if (keeperReward > 0) {
                vault.internalTransfer(insuranceFund, keeper, keeperReward);
            }
        } else {
            uint256 remaining = uint256(effectiveMargin);
            uint256 maxReward = (totalNotional * 500) / BPS; // cap 5%
            keeperReward = remaining / 2;
            if (keeperReward > maxReward) keeperReward = maxReward;
            uint256 insurancePayout = remaining - keeperReward;

            vault.internalTransfer(address(this), keeper, keeperReward);
            if (insurancePayout > 0) {
                vault.internalTransfer(address(this), insuranceFund, insurancePayout);
            }
        }
    }

    // ============================================================
    //               ACTIVE MARKET TRACKING
    // ============================================================

    /// @dev G-06: O(1) add via mapping index
    function _addActiveMarket(address trader, bytes32 marketId) internal {
        if (_activeMarketIndex[trader][marketId] != 0) return; // already tracked
        bytes32[] storage active = traderActiveMarkets[trader];
        active.push(marketId);
        _activeMarketIndex[trader][marketId] = active.length; // store index+1
    }

    /// @dev G-07: O(1) remove via swap-and-pop with index mapping
    function _removeActiveMarket(address trader, bytes32 marketId) internal {
        uint256 idx1 = _activeMarketIndex[trader][marketId];
        if (idx1 == 0) return; // not tracked

        bytes32[] storage active = traderActiveMarkets[trader];
        uint256 lastIdx = active.length - 1;
        uint256 idx = idx1 - 1;

        if (idx != lastIdx) {
            bytes32 lastMarket = active[lastIdx];
            active[idx] = lastMarket;
            _activeMarketIndex[trader][lastMarket] = idx1; // update moved element's index
        }
        active.pop();
        delete _activeMarketIndex[trader][marketId];
    }

    /// @notice Check that a trader's total notional exposure doesn't exceed maxExposureBps of vault TVL
    function _checkExposureLimit(address trader) internal view {
        if (maxExposureBps == 0) return; // disabled

        uint256 totalTraderNotional = 0;
        bytes32[] storage activeMarkets = traderActiveMarkets[trader];
        for (uint256 i = 0; i < activeMarkets.length;) {
            bytes32 mId = activeMarkets[i];
            Position storage pos = positions[mId][trader];
            if (pos.size != 0) {
                Market storage m = markets[mId];
                totalTraderNotional += _notional(m.markPrice, _abs(pos.size));
            }
            unchecked { ++i; }
        }

        uint256 totalProtocolOI = 0;
        for (uint256 i = 0; i < marketIds.length;) {
            Market storage m = markets[marketIds[i]];
            uint256 oi = m.openInterestLong + m.openInterestShort;
            totalProtocolOI += _notional(m.markPrice, oi);
            unchecked { ++i; }
        }

        // If no OI yet (bootstrapping), skip check
        if (totalProtocolOI == 0) return;

        uint256 maxAllowed = (totalProtocolOI * maxExposureBps) / BPS;
        if (totalTraderNotional > maxAllowed) {
            revert ExposureLimitExceeded(totalTraderNotional, maxAllowed);
        }
    }

    // ============================================================
    //                     ADMIN FUNCTIONS
    // ============================================================

    /// @notice Start 2-step ownership transfer (sets pendingOwner)
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Accept ownership (must be called by pendingOwner)
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address oldOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(oldOwner, msg.sender);
    }

    function setOperator(address op, bool status) external onlyOwner {
        if (op == address(0)) revert ZeroAddress();
        operators[op] = status;
        emit OperatorUpdated(op, status);
    }

    event MaxPriceAgeUpdated(uint256 oldAge, uint256 newAge);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event InsuranceFundUpdated(address indexed oldFund, address indexed newFund);
    event FundingPoolUpdated(address indexed oldPool, address indexed newPool);
    event CircuitBreakerParamsUpdated(uint256 windowSecs, uint256 thresholdBps, uint256 cooldownSecs);

    function pause() external onlyOwner {
        if (paused) revert Paused();
        paused = true;
        emit PauseStatusChanged(true);
    }

    function unpause() external onlyOwner {
        if (!paused) revert NotPaused();
        paused = false;
        emit PauseStatusChanged(false);
    }

    function setMaxPriceAge(uint256 newAge) external onlyOwner {
        if (newAge < 10 || newAge > 3600) revert InvalidParam();
        uint256 oldAge = maxPriceAge;
        maxPriceAge = newAge;
        emit MaxPriceAgeUpdated(oldAge, newAge);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        address old = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(old, newRecipient);
    }

    function setInsuranceFund(address newFund) external onlyOwner {
        if (newFund == address(0)) revert ZeroAddress();
        address old = insuranceFund;
        insuranceFund = newFund;
        emit InsuranceFundUpdated(old, newFund);
    }

    function setFundingPool(address newPool) external onlyOwner {
        if (newPool == address(0)) revert ZeroAddress();
        address old = fundingPool;
        fundingPool = newPool;
        emit FundingPoolUpdated(old, newPool);
    }

    function setMaxExposureBps(uint256 newBps) external onlyOwner {
        if (newBps > BPS && newBps != 0) revert InvalidParam();
        maxExposureBps = newBps;
        emit ExposureLimitUpdated(newBps);
    }

    function setCircuitBreakerParams(uint256 windowSecs, uint256 thresholdBps, uint256 cooldownSecs) external onlyOwner {
        if (windowSecs < 60 || windowSecs > 86400) revert InvalidParam();
        if (thresholdBps == 0 || thresholdBps > BPS) revert InvalidParam();
        if (cooldownSecs < 60 || cooldownSecs > 86400) revert InvalidParam();
        circuitBreakerWindowSecs = windowSecs;
        circuitBreakerThresholdBps = thresholdBps;
        circuitBreakerCooldownSecs = cooldownSecs;
        emit CircuitBreakerParamsUpdated(windowSecs, thresholdBps, cooldownSecs);
    }

    function resetCircuitBreaker() external onlyOwner {
        circuitBreakerActive = false;
        emit CircuitBreakerReset(block.timestamp);
    }

    // ============================================================
    //               TIERED LEVERAGE ADMIN
    // ============================================================

    /// @notice Set tiered margin brackets for a market
    /// @dev Tiers must be sorted by maxNotional ascending. Last tier should have maxNotional = 0 (unlimited).
    function setMarginTiers(bytes32 marketId, MarginTier[] calldata tiers)
        external onlyOwner marketExists(marketId)
    {
        delete marketMarginTiers[marketId];
        for (uint256 i = 0; i < tiers.length;) {
            if (tiers[i].initialMarginBps == 0 || tiers[i].initialMarginBps > BPS) revert InvalidParam();
            if (tiers[i].maintenanceMarginBps == 0 || tiers[i].maintenanceMarginBps >= tiers[i].initialMarginBps) revert InvalidParam();
            if (i > 0 && tiers[i].maxNotional != 0 && tiers[i].maxNotional <= tiers[i-1].maxNotional) revert InvalidParam();
            marketMarginTiers[marketId].push(tiers[i]);
            unchecked { ++i; }
        }
        emit MarginTiersUpdated(marketId, tiers.length);
    }

    /// @notice Set OI cap for a market (in SIZE_PRECISION units)
    function setOiCap(bytes32 marketId, uint256 cap) external onlyOwner marketExists(marketId) {
        marketOiCap[marketId] = cap;
        emit OiCapUpdated(marketId, cap);
    }

    /// @notice Set OI skew cap (5000-10000 BPS, where 7000 = 70% max dominance)
    function setOiSkewCap(uint256 newCapBps) external onlyOwner {
        if (newCapBps < 5000 || newCapBps > BPS) revert InvalidParam();
        oiSkewCapBps = newCapBps;
        emit OiSkewCapUpdated(newCapBps);
    }

    /// @notice Set reserve factor: max OI notional as % of pool TVL
    /// @param newFactorBps 0 = disabled, 8000 = 80% of pool TVL
    function setReserveFactor(uint256 newFactorBps) external onlyOwner {
        if (newFactorBps > BPS) revert InvalidParam();
        reserveFactorBps = newFactorBps;
        emit ReserveFactorUpdated(newFactorBps);
    }

    /// @notice Configure price impact for a market
    /// @param marketId The market
    /// @param impactFactorBps Base impact factor (e.g., 100 = 1% max impact)
    /// @param impactExponentBps Exponent scale (20000 = quadratic). 0 = disable.
    function setPriceImpactConfig(
        bytes32 marketId,
        uint256 impactFactorBps,
        uint256 impactExponentBps
    ) external onlyOwner marketExists(marketId) {
        priceImpactConfigs[marketId] = PriceImpactConfig({
            impactFactorBps: impactFactorBps,
            impactExponentBps: impactExponentBps
        });
        emit PriceImpactParamsUpdated(marketId, impactExponentBps, impactFactorBps);
    }

}
