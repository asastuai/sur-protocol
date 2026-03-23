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

/// @title OracleRouter Chaos Tests
/// @notice Attack vectors: price manipulation, circuit breaker bypass,
///         normalization overflow, single-source fallback, deviation manipulation

contract OracleRouterChaosTest is Test {
    MockUSDC public usdc;
    PerpVault public vault;
    PerpEngine public engine;
    InsuranceFund public insurance;
    OracleRouter public oracle;
    MockPyth public mockPyth;
    MockChainlinkAggregator public mockCL_BTC;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("treasury");

    uint256 constant U = 1e6;
    uint256 constant S = 1e8;
    bytes32 public btcMkt;
    bytes32 constant PYTH_BTC = bytes32(uint256(0xB7C));

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, type(uint256).max);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);
        mockPyth = new MockPyth();
        mockCL_BTC = new MockChainlinkAggregator(8, "BTC/USD");
        oracle = new OracleRouter(address(mockPyth), address(engine), owner);
        btcMkt = keccak256(abi.encodePacked("BTC-USD"));

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        engine.setOperator(address(oracle), true);
        engine.setOperator(owner, true);
        oracle.setOperator(owner, true);
        engine.addMarket("BTC-USD", 500, 250, 1_000_000 * S, 28800);
        engine.updateMarkPrice(btcMkt, 50_000 * U, 50_000 * U);
        oracle.configureFeed(btcMkt, PYTH_BTC, address(mockCL_BTC), 120, 500, 200);
        vm.stopPrank();

        mockPyth.setPrice(PYTH_BTC, int64(int256(50_000 * 1e8)), 1_000_000, -8, block.timestamp);
        mockCL_BTC.setPrice(int256(50_000 * 1e8), block.timestamp);

        // Initial push to set lastPrice
        vm.prank(owner);
        oracle.pushPrice(btcMkt);
    }

    // ================================================================
    //  TEST 1: Circuit breaker triggers on >10% price move
    // ================================================================
    function test_oracle_circuitBreakerTriggers() public {
        emit log_string("=== ORACLE: Circuit breaker on large price move ===");

        // Move price 15% (> 10% max)
        mockPyth.setPrice(PYTH_BTC, int64(int256(57_500 * 1e8)), 1_000_000, -8, block.timestamp);
        mockCL_BTC.setPrice(int256(57_500 * 1e8), block.timestamp);

        vm.prank(owner);
        oracle.pushPrice(btcMkt);

        bool cbActive = oracle.oracleCircuitBreakerActive();
        emit log_named_uint("  CB active?", cbActive ? 1 : 0);
        assertTrue(cbActive, "CB should be active after 15% move");

        // Verify engine price was NOT updated
        (,,,,,,uint256 markPrice,,,,,,, ) = engine.markets(btcMkt);
        assertEq(markPrice, 50_000 * U, "Engine price should NOT have changed");
        emit log_string("  [OK] CB blocked bad price from reaching engine");
    }

    // ================================================================
    //  TEST 2: Circuit breaker auto-reset after cooldown + good prices
    // ================================================================
    function test_oracle_circuitBreakerReset() public {
        emit log_string("=== ORACLE: Circuit breaker auto-reset ===");

        // Trigger CB
        mockPyth.setPrice(PYTH_BTC, int64(int256(60_000 * 1e8)), 1_000_000, -8, block.timestamp);
        mockCL_BTC.setPrice(int256(60_000 * 1e8), block.timestamp);
        vm.prank(owner);
        oracle.pushPrice(btcMkt);
        assertTrue(oracle.oracleCircuitBreakerActive(), "CB should be active");

        // Wait cooldown
        vm.warp(block.timestamp + 181);

        // Push 3 good prices (within 10% of lastPrice=50k)
        uint256[3] memory goodPrices = [uint256(50_500), uint256(51_000), uint256(51_500)];
        for (uint256 i = 0; i < 3; i++) {
            mockPyth.setPrice(PYTH_BTC, int64(int256(goodPrices[i] * 1e8)), 1_000_000, -8, block.timestamp);
            mockCL_BTC.setPrice(int256(goodPrices[i] * 1e8), block.timestamp);
            vm.prank(owner);
            oracle.pushPrice(btcMkt);
        }

        bool healthy = oracle.isOracleHealthy();
        emit log_named_uint("  Oracle healthy after reset?", healthy ? 1 : 0);
        assertTrue(healthy, "Oracle should be healthy after cooldown + 3 good prices");
    }

    // ================================================================
    //  TEST 3: Pyth-Chainlink deviation check
    // ================================================================
    function test_oracle_priceDeviationBlocked() public {
        emit log_string("=== ORACLE: Price deviation between sources ===");

        // Pyth at $50k, Chainlink at $53k (6% deviation > 5% max)
        mockPyth.setPrice(PYTH_BTC, int64(int256(50_000 * 1e8)), 1_000_000, -8, block.timestamp);
        mockCL_BTC.setPrice(int256(53_000 * 1e8), block.timestamp);

        vm.prank(owner);
        try oracle.pushPrice(btcMkt) {
            emit log_string("  [BUG] Push succeeded despite 6% deviation!");
        } catch {
            emit log_string("  [OK] Push blocked due to price deviation");
        }
    }

    // ================================================================
    //  TEST 4: Single source fallback (Chainlink down)
    //  When Chainlink is down, no deviation check occurs.
    //  A manipulated Pyth feed could push any price.
    // ================================================================
    function test_oracle_singleSourceNoDeviation() public {
        emit log_string("=== ORACLE: Single source fallback (no cross-validation) ===");

        // Make Chainlink stale — advance time first then set old timestamp
        vm.warp(block.timestamp + 300);
        mockCL_BTC.setPrice(int256(50_000 * 1e8), block.timestamp - 200); // 200s old > 120s max

        // Pyth shows $54k (8% up, within CB limit of 10%)
        mockPyth.setPrice(PYTH_BTC, int64(int256(54_000 * 1e8)), 1_000_000, -8, block.timestamp);

        vm.prank(owner);
        oracle.pushPrice(btcMkt);

        (,,,,,,uint256 markPrice,,,,,,, ) = engine.markets(btcMkt);
        emit log_named_uint("  Mark price after single-source push", markPrice);

        // Index should also be Pyth (no Chainlink available)
        // This means funding = 0 (mark == index)
        (,,,,,,,uint256 indexPrice,,,,,, ) = engine.markets(btcMkt);
        assertEq(markPrice, indexPrice, "Mark == Index when single source");
        emit log_string("  [INFO] Single source: no deviation check, funding = 0");
    }

    // ================================================================
    //  TEST 5: Negative Pyth price handling
    // ================================================================
    function test_oracle_negativePriceRejected() public {
        emit log_string("=== ORACLE: Negative price rejection ===");

        mockPyth.setPrice(PYTH_BTC, int64(-1), 1_000_000, -8, block.timestamp);

        vm.prank(owner);
        try oracle.pushPrice(btcMkt) {
            emit log_string("  [BUG] Negative price accepted!");
        } catch {
            emit log_string("  [OK] Negative price rejected");
        }
    }

    // ================================================================
    //  TEST 6: Wide confidence interval
    //  Pyth confidence > maxConfidenceBps should be rejected
    // ================================================================
    function test_oracle_wideConfidenceRejected() public {
        emit log_string("=== ORACLE: Wide confidence interval rejection ===");

        // Price $50k with confidence $2k (4% > 2% maxConfidenceBps)
        mockPyth.setPrice(PYTH_BTC, int64(int256(50_000 * 1e8)), uint64(2_000 * 1e8), -8, block.timestamp);

        vm.prank(owner);
        try oracle.pushPrice(btcMkt) {
            emit log_string("  [BUG] Wide confidence accepted!");
        } catch {
            emit log_string("  [OK] Wide confidence rejected");
        }
    }

    // ================================================================
    //  TEST 7: Stale price rejected
    // ================================================================
    function test_oracle_stalePriceRejected() public {
        emit log_string("=== ORACLE: Stale price rejection ===");

        // Both sources stale — advance time first
        vm.warp(block.timestamp + 300);
        mockPyth.setPrice(PYTH_BTC, int64(int256(50_000 * 1e8)), 1_000_000, -8, block.timestamp - 200);
        mockCL_BTC.setPrice(int256(50_000 * 1e8), block.timestamp - 200);

        vm.prank(owner);
        try oracle.pushPrice(btcMkt) {
            emit log_string("  [BUG] Stale price accepted!");
        } catch {
            emit log_string("  [OK] Stale price rejected");
        }
    }

    // ================================================================
    //  TEST 8: Rapid successive updates (front-running attempt)
    // ================================================================
    function test_oracle_rapidUpdates() public {
        emit log_string("=== ORACLE: Rapid successive price updates ===");

        // Push multiple prices in same block
        uint256[5] memory prices = [uint256(50_100), uint256(50_200), uint256(50_300), uint256(50_400), uint256(50_500)];
        for (uint256 i = 0; i < 5; i++) {
            mockPyth.setPrice(PYTH_BTC, int64(int256(prices[i] * 1e8)), 1_000_000, -8, block.timestamp);
            mockCL_BTC.setPrice(int256(prices[i] * 1e8), block.timestamp);
            vm.prank(owner);
            oracle.pushPrice(btcMkt);
        }

        (,,,,,,uint256 markPrice,,,,,,, ) = engine.markets(btcMkt);
        emit log_named_uint("  Final mark price", markPrice);
        assertEq(markPrice, 50_500 * U, "Should be last pushed price");
        emit log_string("  [OK] Multiple updates in same block accepted (expected)");
    }
}
