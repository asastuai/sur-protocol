// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPyth - Interface for Pyth Network oracle
/// @dev Matches the real Pyth contract deployed on Base
///      Pyth is pull-based: you submit price update data and pay a fee,
///      then read the price. This gives sub-second latency.

struct PythPrice {
    int64 price;          // price in fixed-point
    uint64 conf;          // confidence interval
    int32 expo;           // exponent (e.g., -8 means price * 10^-8)
    uint256 publishTime;  // unix timestamp of price publication
}

interface IPyth {
    /// @notice Get the latest price for a feed (reverts if too stale)
    /// @param id The Pyth price feed ID
    /// @return price The price data
    function getPriceNoOlderThan(bytes32 id, uint256 age)
        external
        view
        returns (PythPrice memory price);

    /// @notice Get the latest price (may be stale)
    function getPriceUnsafe(bytes32 id)
        external
        view
        returns (PythPrice memory price);

    /// @notice Update price feeds with fresh data from Pyth
    /// @param updateData Encoded price update data from Pyth API
    function updatePriceFeeds(bytes[] calldata updateData) external payable;

    /// @notice Get the fee required to update price feeds
    function getUpdateFee(bytes[] calldata updateData)
        external
        view
        returns (uint256 fee);
}
