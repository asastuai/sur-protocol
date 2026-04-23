// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title PerpEngineView - Read-only lens for PerpEngine
/// @notice Extracted view functions to reduce PerpEngine bytecode size.
///         Does NOT hold state — reads directly from PerpEngine.
/// @dev Deploy alongside PerpEngine. Frontend/monitoring calls this for complex views.

interface IPerpEngineView {
    // Structs must match PerpEngine
    enum MarginMode { ISOLATED, CROSS }

    function vault() external view returns (address);
    function markets(bytes32 marketId) external view returns (
        bytes32 id, string memory name, bool active,
        uint256 initialMarginBps, uint256 maintenanceMarginBps,
        uint256 maxPositionSize, uint256 markPrice, uint256 indexPrice,
        uint256 lastPriceUpdate, int256 cumulativeFunding,
        uint256 lastFundingUpdate, uint256 fundingIntervalSecs,
        uint256 openInterestLong, uint256 openInterestShort
    );
    function positions(bytes32 marketId, address trader) external view returns (
        int256 size, uint256 entryPrice, uint256 margin,
        int256 lastCumulativeFunding, uint256 lastUpdated,
        uint256 marginTierVersion
    );
    function traderMarginMode(address trader) external view returns (MarginMode);
    function traderActiveMarkets(address trader, uint256 index) external view returns (bytes32);
    function getAccountEquity(address trader) external view returns (int256 equity, uint256 totalMaintRequired);
    function marketIds(uint256 index) external view returns (bytes32);
    function marketCount() external view returns (uint256);
}

interface IPerpVaultBalance {
    function balances(address) external view returns (uint256);
}

contract PerpEngineView {
    uint256 public constant SIZE_PRECISION = 1e8;
    uint256 public constant BPS = 10_000;

    IPerpEngineView public immutable engine;

    constructor(address _engine) {
        engine = IPerpEngineView(_engine);
    }

    /// @notice Comprehensive account details for cross-margin traders
    /// @dev Extracted from PerpEngine to save bytecode. Same logic, same return values.
    function getAccountDetails(address trader)
        external view returns (
            IPerpEngineView.MarginMode mode,
            int256 totalEquity,
            uint256 totalInitialRequired,
            uint256 totalMaintenanceRequired,
            uint256 totalNotional,
            uint256 freeBalance,
            uint256 positionCount,
            int256 totalUnrealizedPnl
        )
    {
        mode = engine.traderMarginMode(trader);
        freeBalance = IPerpVaultBalance(engine.vault()).balances(trader);
        int256 positionEquity = int256(0);
        totalUnrealizedPnl = 0;

        // Count active markets by trying to read until revert
        uint256 count = 0;
        while (true) {
            try engine.traderActiveMarkets(trader, count) returns (bytes32) {
                count++;
            } catch {
                break;
            }
        }
        positionCount = count;

        for (uint256 i = 0; i < count;) {
            bytes32 mId = engine.traderActiveMarkets(trader, i);
            (int256 size, uint256 entryPrice, uint256 margin,,,) = engine.positions(mId, trader);

            if (size != 0) {
                (,,, uint256 initialMarginBps, uint256 maintenanceMarginBps,
                 , uint256 markPrice,,,,,,,) = engine.markets(mId);

                uint256 absSize = size >= 0 ? uint256(size) : uint256(-size);
                uint256 notional = (markPrice * absSize) / SIZE_PRECISION;

                int256 priceDiff = int256(markPrice) - int256(entryPrice);
                int256 pnl = (priceDiff * size) / int256(SIZE_PRECISION);

                positionEquity += int256(margin) + pnl;
                totalUnrealizedPnl += pnl;
                totalNotional += notional;
                totalInitialRequired += (notional * initialMarginBps) / BPS;
                totalMaintenanceRequired += (notional * maintenanceMarginBps) / BPS;
            }
            unchecked { ++i; }
        }

        totalEquity = int256(freeBalance) + positionEquity;
    }

    /// @notice Get liquidation price for a position
    /// @dev liqPrice = entryPrice - (margin * SIZE_PRECISION) / size (for longs)
    ///      liqPrice = entryPrice + (margin * SIZE_PRECISION) / abs(size) (for shorts)
    function getLiquidationPrice(bytes32 marketId, address trader) external view returns (uint256) {
        (int256 size, uint256 entryPrice, uint256 margin,,,) = engine.positions(marketId, trader);
        if (size == 0 || margin == 0) return 0;

        (,,,, uint256 maintenanceMarginBps,,,,,,,,, ) = engine.markets(marketId);
        uint256 absSize = size >= 0 ? uint256(size) : uint256(-size);
        uint256 notional = (entryPrice * absSize) / SIZE_PRECISION;
        uint256 maintMargin = (notional * maintenanceMarginBps) / BPS;

        if (size > 0) {
            // Long: liq when price drops enough that margin + pnl < maintMargin
            // liqPrice = entryPrice - (margin - maintMargin) * SIZE_PRECISION / absSize
            if (margin <= maintMargin) return entryPrice; // already liquidatable
            uint256 buffer = margin - maintMargin;
            uint256 priceDrop = (buffer * SIZE_PRECISION) / absSize;
            return entryPrice > priceDrop ? entryPrice - priceDrop : 0;
        } else {
            // Short: liq when price rises enough
            if (margin <= maintMargin) return entryPrice;
            uint256 buffer = margin - maintMargin;
            uint256 priceRise = (buffer * SIZE_PRECISION) / absSize;
            return entryPrice + priceRise;
        }
    }
}
