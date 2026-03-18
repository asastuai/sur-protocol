// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/// @title AddStockMarkets - Adds US equity perpetual markets to PerpEngine
/// @dev Run after initial deployment. Adds AAPL, TSLA, AMZN, NVDA, MSFT, GOOG, META, COIN, SPY
///
/// Usage:
///   forge script script/AddStockMarkets.s.sol:AddStockMarkets \
///     --rpc-url base_sepolia --broadcast -vvvv

interface IPerpEngine {
    function addMarket(
        string calldata name,
        uint256 initialMarginBps,
        uint256 maintenanceMarginBps,
        uint256 maxPositionSize,
        uint256 fundingIntervalSecs
    ) external;
}

interface IOracleRouter {
    function addFeed(
        bytes32 marketId,
        bytes32 pythFeedId,
        address chainlinkFeed,
        uint256 maxDeviation,
        uint256 maxAge
    ) external;
}

contract AddStockMarkets is Script {
    uint256 constant SIZE_PRECISION = 1e8;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address engine = vm.envAddress("ENGINE_ADDRESS");
        address oracle = vm.envAddress("ORACLE_ROUTER_ADDRESS");

        vm.startBroadcast(deployerKey);

        IPerpEngine eng = IPerpEngine(engine);
        IOracleRouter orc = IOracleRouter(oracle);

        // ── STOCK MARKETS ──
        // Initial margin: 10% (1000 bps) → 10x max leverage
        // Maintenance margin: 5% (500 bps)
        // Funding: 8 hours

        _addStock(eng, orc, "AAPL-USD", 1000, 500, 100_000,
            0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688);

        _addStock(eng, orc, "TSLA-USD", 1000, 500, 50_000,
            0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1);

        _addStock(eng, orc, "AMZN-USD", 1000, 500, 50_000,
            0xb5d0e0fa58a1fdc967f1a9bc7924cf3db30f480bdaf4546fdf73e8e8b1a9920c);

        _addStock(eng, orc, "NVDA-USD", 1000, 500, 50_000,
            0x20a938f54b68f1f2ef18ea0328f6dd0747f8ea11486d22b021e83a900be89776);

        _addStock(eng, orc, "MSFT-USD", 1000, 500, 50_000,
            0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1);

        _addStock(eng, orc, "GOOG-USD", 1000, 500, 50_000,
            0xe65ff435be2f83fdb38a4263d3e06e8c8e5d29342fdd5a5a6e4e9b5636a78f5e);

        _addStock(eng, orc, "META-USD", 1000, 500, 30_000,
            0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b);

        _addStock(eng, orc, "COIN-USD", 1200, 600, 30_000,
            0xffff00e31a041e569e04f0266aca30e4fef2baa02b3061fdddeb97edceb35bdc);

        _addStock(eng, orc, "SPY-USD", 800, 400, 10_000,
            0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5);

        vm.stopBroadcast();

        console.log("=== Stock markets added successfully ===");
        console.log("Markets: AAPL, TSLA, AMZN, NVDA, MSFT, GOOG, META, COIN, SPY");
    }

    function _addStock(
        IPerpEngine eng,
        IOracleRouter orc,
        string memory name,
        uint256 initialBps,
        uint256 maintBps,
        uint256 maxShares,
        bytes32 pythFeed
    ) internal {
        bytes32 mId = keccak256(abi.encodePacked(name));

        // Add market to PerpEngine
        eng.addMarket(
            name,
            initialBps,
            maintBps,
            maxShares * SIZE_PRECISION,
            28800 // 8 hour funding interval
        );

        // Add oracle feed (Pyth only for stocks, no Chainlink fallback)
        orc.addFeed(
            mId,
            pythFeed,
            address(0), // no Chainlink for stocks
            500,        // 5% max deviation (stocks can move more)
            120         // 2 minute max age
        );
    }
}
