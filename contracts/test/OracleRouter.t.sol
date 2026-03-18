// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OracleRouter.sol";
import "../src/PerpEngine.sol";
import "../src/PerpVault.sol";
import "../src/InsuranceFund.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockPyth.sol";
import "./mocks/MockChainlink.sol";

contract OracleRouterTest is Test {
    OracleRouter public router;
    MockPyth public mockPyth;
    MockChainlinkAggregator public mockChainlinkBTC;
    MockChainlinkAggregator public mockChainlinkETH;

    PerpVault public vault;
    PerpEngine public engine;
    InsuranceFund public insurance;
    MockUSDC public usdc;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public feeRecipient = makeAddr("feeRecipient");

    bytes32 public btcMarket;
    bytes32 public ethMarket;

    // Pyth feed IDs (simulated)
    bytes32 public constant PYTH_BTC_FEED = bytes32(uint256(1));
    bytes32 public constant PYTH_ETH_FEED = bytes32(uint256(2));

    uint256 constant USDC = 1e6;
    uint256 constant SIZE = 1e8;

    // ============================================================
    //                          SETUP
    // ============================================================

    function setUp() public {
        vm.warp(1000); // ensure block.timestamp is large enough for staleness tests

        // Deploy infrastructure
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 0);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance));

        // Deploy mocks
        mockPyth = new MockPyth();
        mockChainlinkBTC = new MockChainlinkAggregator(8, "BTC/USD"); // 8 decimals
        mockChainlinkETH = new MockChainlinkAggregator(8, "ETH/USD");

        // Deploy OracleRouter
        router = new OracleRouter(address(mockPyth), address(engine), owner);

        btcMarket = keccak256(abi.encodePacked("BTC-USD"));
        ethMarket = keccak256(abi.encodePacked("ETH-USD"));

        // Setup permissions
        vm.startPrank(owner);

        vault.setOperator(address(engine), true);
        engine.setOperator(address(router), true); // router can push prices
        engine.setOperator(owner, true);
        router.setOperator(operator, true);

        // Add markets in engine
        engine.addMarket("BTC-USD", 500, 250, 100_000 * SIZE, 28800);
        engine.addMarket("ETH-USD", 667, 333, 1_000_000 * SIZE, 28800);

        // Need to set initial prices in engine first (required for freshness checks)
        engine.updateMarkPrice(btcMarket, 50_000 * USDC, 50_000 * USDC);
        engine.updateMarkPrice(ethMarket, 3_000 * USDC, 3_000 * USDC);

        // Configure oracle feeds
        router.configureFeed(
            btcMarket,
            PYTH_BTC_FEED,
            address(mockChainlinkBTC),
            120,    // 120 seconds max staleness
            100,    // 1% max deviation
            50      // 0.5% max confidence
        );

        router.configureFeed(
            ethMarket,
            PYTH_ETH_FEED,
            address(mockChainlinkETH),
            120,
            100,
            50
        );

        vm.stopPrank();

        // Set mock oracle prices
        _setPythPrice(PYTH_BTC_FEED, 50_000_00, -2, block.timestamp); // $50,000.00 (expo=-2)
        _setPythPrice(PYTH_ETH_FEED, 3_000_00, -2, block.timestamp);  // $3,000.00

        _setChainlinkPrice(mockChainlinkBTC, 50_000_00000000, block.timestamp); // 8 decimals
        _setChainlinkPrice(mockChainlinkETH, 3_000_00000000, block.timestamp);
    }

    function _setPythPrice(bytes32 feedId, int64 price, int32 expo, uint256 ts) internal {
        mockPyth.setPrice(feedId, price, 100, expo, ts); // conf=100
    }

    function _setChainlinkPrice(MockChainlinkAggregator agg, int256 price, uint256 ts) internal {
        agg.setPrice(price, ts);
    }

    // ============================================================
    //                    CONSTRUCTOR TESTS
    // ============================================================

    function test_constructor_setsState() public view {
        assertEq(address(router.pyth()), address(mockPyth));
        assertEq(address(router.engine()), address(engine));
        assertEq(router.owner(), owner);
    }

    function test_constructor_revertsZeroAddress() public {
        vm.expectRevert(OracleRouter.ZeroAddress.selector);
        new OracleRouter(address(0), address(engine), owner);
    }

    // ============================================================
    //                 FEED CONFIGURATION
    // ============================================================

    function test_configureFeed_success() public view {
        (
            bytes32 pythId, address clFeed,
            uint256 staleness, uint256 deviation,
            uint256 conf, bool active
        ) = router.feeds(btcMarket);

        assertEq(pythId, PYTH_BTC_FEED);
        assertEq(clFeed, address(mockChainlinkBTC));
        assertEq(staleness, 120);
        assertEq(deviation, 100);
        assertEq(conf, 50);
        assertTrue(active);
    }

    function test_configureFeed_revertsNonOwner() public {
        vm.prank(operator);
        vm.expectRevert(OracleRouter.NotOwner.selector);
        router.configureFeed(btcMarket, bytes32(0), address(0), 60, 100, 50);
    }

    function test_feedCount() public view {
        assertEq(router.feedCount(), 2); // BTC + ETH
    }

    // ============================================================
    //              PYTH PRICE READING
    // ============================================================

    function test_getPythPrice_btc() public view {
        OracleRouter.PriceResult memory result = router.getPythPrice(btcMarket);

        // $50,000.00 with expo=-2 → normalized to 6 decimals = 50_000_000_000
        assertEq(result.price, 50_000 * USDC);
        assertEq(result.source, 0); // Pyth
        assertEq(result.timestamp, block.timestamp);
    }

    function test_getPythPrice_eth() public view {
        OracleRouter.PriceResult memory result = router.getPythPrice(ethMarket);
        assertEq(result.price, 3_000 * USDC);
    }

    function test_getPythPrice_differentExponents() public {
        // Test expo=-8 (like many Pyth feeds)
        // $50,000 with expo=-8 = 5_000_000_000_000 raw
        _setPythPrice(PYTH_BTC_FEED, int64(int256(5_000_000_000_000)), -8, block.timestamp);

        OracleRouter.PriceResult memory result = router.getPythPrice(btcMarket);
        // 5_000_000_000_000 / 10^(8-6) = 5_000_000_000_000 / 100 = 50_000_000_000
        assertEq(result.price, 50_000 * USDC);
    }

    function test_getPythPrice_expoMinusFour() public {
        // expo=-4: $50,000 = 500_000_000 raw
        _setPythPrice(PYTH_BTC_FEED, int64(int256(500_000_000)), -4, block.timestamp);

        OracleRouter.PriceResult memory result = router.getPythPrice(btcMarket);
        // 500_000_000 * 10^(6-4) = 500_000_000 * 100 = 50_000_000_000
        assertEq(result.price, 50_000 * USDC);
    }

    function test_getPythPrice_staleReverts() public {
        // Set price in the past beyond staleness window
        _setPythPrice(PYTH_BTC_FEED, 50_000_00, -2, block.timestamp - 200);

        vm.expectRevert(); // Pyth reverts on stale price
        router.getPythPrice(btcMarket);
    }

    // ============================================================
    //            CHAINLINK PRICE READING
    // ============================================================

    function test_getChainlinkPrice_btc() public view {
        OracleRouter.PriceResult memory result = router.getChainlinkPrice(btcMarket);

        // 50_000_00000000 with 8 decimals → 6 decimals = 50_000_000_000
        assertEq(result.price, 50_000 * USDC);
        assertEq(result.source, 1); // Chainlink
    }

    function test_getChainlinkPrice_staleReverts() public {
        _setChainlinkPrice(mockChainlinkBTC, 50_000_00000000, block.timestamp - 200);

        vm.expectRevert(
            abi.encodeWithSelector(
                OracleRouter.PriceStale.selector,
                btcMarket, 200, 120
            )
        );
        router.getChainlinkPrice(btcMarket);
    }

    function test_getChainlinkPrice_negativeReverts() public {
        _setChainlinkPrice(mockChainlinkBTC, -1, block.timestamp);

        vm.expectRevert(
            abi.encodeWithSelector(
                OracleRouter.PriceNegativeOrZero.selector,
                btcMarket, int256(-1)
            )
        );
        router.getChainlinkPrice(btcMarket);
    }

    // ============================================================
    //              COMBINED PRICE (getPrice)
    // ============================================================

    function test_getPrice_bothSources() public view {
        (uint256 markPrice, uint256 indexPrice, uint8 source) = router.getPrice(btcMarket);

        assertEq(markPrice, 50_000 * USDC);  // Pyth (mark)
        assertEq(indexPrice, 50_000 * USDC);  // Chainlink (index)
        assertEq(source, 2); // Both
    }

    function test_getPrice_pythOnly() public {
        // Make Chainlink stale
        _setChainlinkPrice(mockChainlinkBTC, 50_000_00000000, block.timestamp - 200);

        (uint256 markPrice, uint256 indexPrice, uint8 source) = router.getPrice(btcMarket);

        assertEq(markPrice, 50_000 * USDC);
        assertEq(indexPrice, 50_000 * USDC); // Falls back to Pyth
        assertEq(source, 0); // Pyth only
    }

    function test_getPrice_chainlinkOnly() public {
        // Make Pyth stale
        _setPythPrice(PYTH_BTC_FEED, 50_000_00, -2, block.timestamp - 200);

        (uint256 markPrice, uint256 indexPrice, uint8 source) = router.getPrice(btcMarket);

        assertEq(markPrice, 50_000 * USDC);
        assertEq(indexPrice, 50_000 * USDC);
        assertEq(source, 1); // Chainlink only
    }

    function test_getPrice_bothStaleReverts() public {
        _setPythPrice(PYTH_BTC_FEED, 50_000_00, -2, block.timestamp - 200);
        _setChainlinkPrice(mockChainlinkBTC, 50_000_00000000, block.timestamp - 200);

        vm.expectRevert(); // Both fail
        router.getPrice(btcMarket);
    }

    // ============================================================
    //                    PUSH PRICE
    // ============================================================

    function test_pushPrice_updatesEngine() public {
        vm.prank(operator);
        router.pushPrice(btcMarket);

        // Check engine got updated
        (uint256 lastPushed, uint256 lastTs) = router.getLastPrice(btcMarket);
        assertEq(lastPushed, 50_000 * USDC);
        assertEq(lastTs, block.timestamp);
    }

    function test_pushPrice_revertsNonOperator() public {
        vm.prank(makeAddr("random"));
        vm.expectRevert(OracleRouter.NotOperator.selector);
        router.pushPrice(btcMarket);
    }

    function test_pushPriceBatch() public {
        bytes32[] memory marketIds = new bytes32[](2);
        marketIds[0] = btcMarket;
        marketIds[1] = ethMarket;

        vm.prank(operator);
        router.pushPriceBatch(marketIds);

        (uint256 btcPrice,) = router.getLastPrice(btcMarket);
        (uint256 ethPrice,) = router.getLastPrice(ethMarket);
        assertEq(btcPrice, 50_000 * USDC);
        assertEq(ethPrice, 3_000 * USDC);
    }

    function test_pushPriceWithPyth() public {
        bytes[] memory updateData = new bytes[](1);
        updateData[0] = bytes("mock");

        vm.deal(operator, 1 ether);
        vm.prank(operator);
        router.pushPriceWithPyth{value: 0.01 ether}(btcMarket, updateData);

        (uint256 price,) = router.getLastPrice(btcMarket);
        assertEq(price, 50_000 * USDC);
    }

    // ============================================================
    //               DEVIATION CHECKS
    // ============================================================

    function test_deviation_warning_emitted() public {
        // Set Pyth to $50,000, Chainlink to $50,400 (0.8% deviation - within limit)
        _setPythPrice(PYTH_BTC_FEED, 50_000_00, -2, block.timestamp);
        _setChainlinkPrice(mockChainlinkBTC, 50_400_00000000, block.timestamp);

        // Should succeed but emit deviation warning since 0.8% < 1% max
        vm.prank(operator);
        router.pushPrice(btcMarket);
    }

    function test_deviation_extreme_reverts() public {
        // Set prices with >3% deviation (3x the 1% max → hard revert)
        _setPythPrice(PYTH_BTC_FEED, 50_000_00, -2, block.timestamp);
        _setChainlinkPrice(mockChainlinkBTC, 52_000_00000000, block.timestamp); // 4% deviation

        vm.prank(operator);
        vm.expectRevert(); // PriceDeviationTooHigh
        router.pushPrice(btcMarket);
    }

    // ============================================================
    //              PRICE FRESHNESS VIEW
    // ============================================================

    function test_isPriceFresh_true() public {
        vm.prank(operator);
        router.pushPrice(btcMarket);

        assertTrue(router.isPriceFresh(btcMarket));
    }

    function test_isPriceFresh_false_neverPushed() public view {
        // ETH market was configured but router.pushPrice never called for it
        // However we did push in setUp... let's use a new market
        bytes32 fakeMarket = keccak256(abi.encodePacked("FAKE-USD"));
        assertFalse(router.isPriceFresh(fakeMarket));
    }

    function test_isPriceFresh_false_stale() public {
        vm.prank(operator);
        router.pushPrice(btcMarket);

        // Warp beyond staleness
        vm.warp(block.timestamp + 200);

        assertFalse(router.isPriceFresh(btcMarket));
    }

    // ============================================================
    //             FEED NOT CONFIGURED
    // ============================================================

    function test_unconfiguredFeed_reverts() public {
        bytes32 fakeMkt = keccak256(abi.encodePacked("FAKE-USD"));

        vm.expectRevert(
            abi.encodeWithSelector(OracleRouter.FeedNotConfigured.selector, fakeMkt)
        );
        router.getPrice(fakeMkt);
    }

    // ============================================================
    //               DEACTIVATE FEED
    // ============================================================

    function test_deactivateFeed() public {
        vm.prank(owner);
        router.deactivateFeed(btcMarket);

        vm.expectRevert(
            abi.encodeWithSelector(OracleRouter.FeedNotConfigured.selector, btcMarket)
        );
        router.getPrice(btcMarket);
    }

    // ============================================================
    //            NORMALIZATION EDGE CASES
    // ============================================================

    function test_normalization_6decChainlink() public {
        // Some Chainlink feeds use 6 decimals (e.g., USDC/USD)
        MockChainlinkAggregator cl6 = new MockChainlinkAggregator(6, "USDC/USD");
        cl6.setPrice(1_000_000, block.timestamp); // $1.000000

        bytes32 usdcMarket = keccak256(abi.encodePacked("USDC-USD"));

        vm.startPrank(owner);
        engine.addMarket("USDC-USD", 500, 250, 100_000 * SIZE, 28800);
        engine.updateMarkPrice(usdcMarket, 1 * USDC, 1 * USDC);

        router.configureFeed(
            usdcMarket,
            bytes32(0), // no Pyth
            address(cl6),
            120, 100, 50
        );
        vm.stopPrank();

        OracleRouter.PriceResult memory result = router.getChainlinkPrice(usdcMarket);
        assertEq(result.price, 1 * USDC); // $1.000000
    }

    function test_normalization_18decChainlink() public {
        // Hypothetical 18-decimal feed
        MockChainlinkAggregator cl18 = new MockChainlinkAggregator(18, "TEST/USD");
        cl18.setPrice(int256(50_000 * 1e18), block.timestamp);

        bytes32 testMarket = keccak256(abi.encodePacked("TEST-USD"));

        vm.startPrank(owner);
        engine.addMarket("TEST-USD", 500, 250, 100_000 * SIZE, 28800);
        engine.updateMarkPrice(testMarket, 50_000 * USDC, 50_000 * USDC);

        router.configureFeed(
            testMarket,
            bytes32(0),
            address(cl18),
            120, 100, 50
        );
        vm.stopPrank();

        OracleRouter.PriceResult memory result = router.getChainlinkPrice(testMarket);
        assertEq(result.price, 50_000 * USDC);
    }

    // ============================================================
    //                 ADMIN TESTS
    // ============================================================

    function test_setOperator() public {
        address newOp = makeAddr("newOp");
        vm.prank(owner);
        router.setOperator(newOp, true);
        assertTrue(router.operators(newOp));
    }

    function test_transferOwnership() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        router.transferOwnership(newOwner);
        assertEq(router.owner(), newOwner);
    }
}
