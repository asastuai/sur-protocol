// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title ISurInterfaces - Single source of truth for all protocol interfaces
/// @dev Every contract imports from here. No more interface drift.

/// @notice PerpVault interface - used by PerpEngine, OrderSettlement, InsuranceFund
interface IPerpVault {
    function balances(address account) external view returns (uint256);
    function internalTransfer(address from, address to, uint256 amount) external;
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;

    /// @notice Credit USDC-equivalent balance for yield-bearing collateral deposits
    /// @dev Only callable by CollateralManager
    function creditCollateral(address trader, uint256 usdcAmount) external;

    /// @notice Debit USDC-equivalent balance when withdrawing yield-bearing collateral
    /// @dev Only callable by CollateralManager
    function debitCollateral(address trader, uint256 usdcAmount) external;
}

/// @notice PerpEngine interface - used by OrderSettlement, Liquidator, OracleRouter
interface IPerpEngine {
    function openPosition(
        bytes32 marketId,
        address trader,
        int256 sizeDelta,
        uint256 price
    ) external;

    function liquidatePosition(
        bytes32 marketId,
        address trader,
        address keeper
    ) external;

    function updateMarkPrice(
        bytes32 marketId,
        uint256 newMarkPrice,
        uint256 newIndexPrice
    ) external;

    function isLiquidatable(bytes32 marketId, address trader) external view returns (bool);

    function isAccountLiquidatable(address trader) external view returns (bool);

    function liquidateAccount(address trader, address keeper) external;

    function getAccountEquity(address trader) external view returns (int256 equity, uint256 totalMaintRequired);

    function positions(bytes32 marketId, address trader) external view returns (
        int256 size,
        uint256 entryPrice,
        uint256 margin,
        int256 lastCumulativeFunding,
        uint256 lastUpdated
    );

    function getPosition(bytes32 marketId, address trader) external view returns (
        int256 size,
        uint256 entryPrice,
        uint256 margin,
        int256 unrealizedPnl,
        uint256 marginRatioBps
    );

    function getUnrealizedPnl(bytes32 marketId, address trader) external view returns (int256);

    function closePosition(bytes32 marketId, address trader, uint256 price) external;
}

/// @notice InsuranceFund interface - used by Liquidator
interface IInsuranceFund {
    function recordBadDebt(bytes32 marketId, address trader, uint256 amount) external;
    function payKeeperReward(address keeper, uint256 amount) external;
    function balance() external view returns (uint256);
}
