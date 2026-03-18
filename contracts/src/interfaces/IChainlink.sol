// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IChainlinkAggregator - Interface for Chainlink price feeds
/// @dev Matches Chainlink's AggregatorV3Interface deployed across all EVM chains.
///      Chainlink is push-based: prices are updated periodically by a
///      decentralized oracle network. You just read the latest round.

interface IChainlinkAggregator {
    /// @notice Get the latest price data
    /// @return roundId The round ID
    /// @return answer The price (check decimals())
    /// @return startedAt When the round started
    /// @return updatedAt When the answer was computed
    /// @return answeredInRound The round in which the answer was computed
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    /// @notice Number of decimals in the price
    function decimals() external view returns (uint8);

    /// @notice Human-readable description
    function description() external view returns (string memory);
}
