// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PerpVault.sol";
import "../src/PerpEngine.sol";
import "../src/OracleRouter.sol";
import "../src/InsuranceFund.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockPyth.sol";
import "./mocks/MockChainlink.sol";

/// @title Oracle Circuit Breaker Tests
/// @notice Tests for P1: Oracle variance circuit breaker that pauses on extreme price moves
/// @dev H-6 fix: CB now returns early (doesn't push bad price). CB state IS persisted.

contract OracleCircuitBreakerTest is Test {
    PerpVault public vault;
    PerpEngine public engine;
    OracleRouter public oracle;
    InsuranceFund public insurance;
    MockUSDC public usdc;
    MockPyth public mockPyth;
    MockChainlinkAggregator public mockChainlinkBTC;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public feeRecipient = makeAddr("feeRecipient");

    uint256 constant USDC_UNIT = 1e6;
    uint256 constant SIZE_UNIT = 1e8;
    uint256 constant BTC_50K = 50_000 * USDC_UNIT;

    bytes32 public btcMarket;
    bytes32 constant PYTH_BTC_FEED = bytes32(uint256(0xB7C));

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 0);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);
        mockPyth = new MockPyth();
        mockChainlinkBTC = new MockChainlinkAggregator(8, "BTC/USD");
        oracle = new OracleRouter(address(mockPyth), address(engine), owner);

        btcMarket = keccak256(abi.encodePacked("BTC-USD"));

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        engine.setOperator(address(oracle), true);
        engine.setOperator(owner, true);
        oracle.setOperator(owner, true);
        insurance.setOperator(address(engine), true);

        engine.addMarket("BTC-USD", 500, 250, 10_000 * SIZE_UNIT, 28800);
        engine.updateMarkPrice(btcMarket, BTC_50K, BTC_50K);

        oracle.configureFeed(
            btcMarket,
            PYTH_BTC_FEED,
            address(mockChainlinkBTC),
            120, 100, 50
        );
        vm.stopPrank();

        // Set initial oracle prices
        _setOraclePrice(50_000);

        // Push once to establish lastPrice
        vm.prank(owner);
        oracle.pushPrice(btcMarket);
    }

    function _setOraclePrice(uint256 priceDollars) internal {
        int64 pythPrice = int64(int256(priceDollars * 1e8));
        int256 clPrice = int256(priceDollars * 1e8);
        mockPyth.setPrice(PYTH_BTC_FEED, pythPrice, 1_000_000, -8, block.timestamp);
        mockChainlinkBTC.setPrice(clPrice, block.timestamp);
    }

    // ============================================================
    //              DEFAULTS
    // ============================================================

    function test_oracleCB_defaults() public view {
        assertFalse(oracle.oracleCircuitBreakerActive());
        assertEq(oracle.oracleCooldownSecs(), 180);
        assertEq(oracle.maxPriceChangeBps(), 1000); // 10%
        assertTrue(oracle.isOracleHealthy());
    }

    // ============================================================
    //              TRIGGERS ON EXTREME MOVE
    // ============================================================

    function test_oracleCB_triggersOnLargeMove() public {
        // Move price by >10% (50k -> 56k = +12%)
        _setOraclePrice(56_000);

        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        // H-6 fix: CB state IS set (return, not revert)
        assertTrue(oracle.oracleCircuitBreakerActive(), "CB should be active after 12% move");
        assertFalse(oracle.isOracleHealthy(), "Oracle should report unhealthy");
    }

    function test_oracleCB_doesNotTriggerOnSmallMove() public {
        // Move price by 5% (50k -> 52.5k)
        _setOraclePrice(52_500);

        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        assertFalse(oracle.oracleCircuitBreakerActive(), "CB should NOT trigger on 5% move");
        assertTrue(oracle.isOracleHealthy());
    }

    function test_oracleCB_triggersOnLargeDrop() public {
        // Drop price by >10% (50k -> 44k = -12%)
        _setOraclePrice(44_000);

        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        assertTrue(oracle.oracleCircuitBreakerActive());
    }

    function test_oracleCB_doesNotPushBadPrice() public {
        // H-6 fix: bad price should NOT be pushed to PerpEngine
        _setOraclePrice(56_000);

        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        // CB was triggered
        assertTrue(oracle.oracleCircuitBreakerActive());

        // But lastPrice in oracle should NOT be updated (return early before tracking)
        (uint256 lastP,) = oracle.getLastPrice(btcMarket);
        assertEq(lastP, 50_000 * USDC_UNIT, "Last price should remain at 50k (bad price not pushed)");
    }

    // ============================================================
    //              AUTO-RESET AFTER COOLDOWN
    // ============================================================

    function test_oracleCB_autoResetAfterCooldown() public {
        // Trigger CB
        _setOraclePrice(56_000);
        vm.prank(owner);
        oracle.pushPrice(btcMarket);
        assertTrue(oracle.oracleCircuitBreakerActive());
        assertFalse(oracle.isOracleHealthy());

        // Warp past cooldown (180s)
        vm.warp(block.timestamp + 181);

        // M-17 fix: Need consecutive good prices for stability verification
        // Push 3 good prices (within 10% of last good price = 50000)
        _setOraclePrice(50_500);
        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        _setOraclePrice(50_800);
        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        _setOraclePrice(51_000);
        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        // isOracleHealthy should return true now (cooldown + 3 good prices)
        assertTrue(oracle.isOracleHealthy(), "Should be healthy after cooldown + good prices");
    }

    function test_oracleCB_notResetBeforeCooldown() public {
        _setOraclePrice(56_000);
        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        vm.warp(block.timestamp + 100); // only 100s, not 180s

        assertFalse(oracle.isOracleHealthy(), "Should still be unhealthy before cooldown");
    }

    // ============================================================
    //              MANUAL RESET
    // ============================================================

    function test_oracleCB_ownerCanReset() public {
        _setOraclePrice(56_000);
        vm.prank(owner);
        oracle.pushPrice(btcMarket);
        assertTrue(oracle.oracleCircuitBreakerActive());

        vm.prank(owner);
        oracle.resetOracleCircuitBreaker();

        assertFalse(oracle.oracleCircuitBreakerActive());
        assertTrue(oracle.isOracleHealthy());
    }

    function test_oracleCB_onlyOwnerCanReset() public {
        vm.prank(operator);
        vm.expectRevert(OracleRouter.NotOwner.selector);
        oracle.resetOracleCircuitBreaker();
    }

    // ============================================================
    //              CONFIG
    // ============================================================

    function test_oracleCB_setParams() public {
        vm.prank(owner);
        oracle.setOracleCircuitBreakerParams(300, 500); // 5 min cooldown, 5% threshold

        assertEq(oracle.oracleCooldownSecs(), 300);
        assertEq(oracle.maxPriceChangeBps(), 500);
    }

    function test_oracleCB_onlyOwnerCanSetParams() public {
        vm.prank(operator);
        vm.expectRevert(OracleRouter.NotOwner.selector);
        oracle.setOracleCircuitBreakerParams(300, 500);
    }

    function test_oracleCB_lowerThresholdTriggersEasier() public {
        // Set 3% threshold
        vm.prank(owner);
        oracle.setOracleCircuitBreakerParams(180, 300);

        // Move 5% (50k -> 52.5k)
        _setOraclePrice(52_500);
        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        assertTrue(oracle.oracleCircuitBreakerActive(), "CB should trigger with 3% threshold on 5% move");
    }

    // ============================================================
    //              EDGE CASES
    // ============================================================

    function test_oracleCB_firstPushNeverTriggers() public {
        // Deploy a fresh oracle
        OracleRouter freshOracle = new OracleRouter(address(mockPyth), address(engine), owner);

        vm.startPrank(owner);
        engine.setOperator(address(freshOracle), true);
        freshOracle.setOperator(owner, true);
        freshOracle.configureFeed(btcMarket, PYTH_BTC_FEED, address(mockChainlinkBTC), 120, 100, 50);
        vm.stopPrank();

        // First push - no previous price, so no CB
        _setOraclePrice(50_000);
        vm.prank(owner);
        freshOracle.pushPrice(btcMarket);

        assertFalse(freshOracle.oracleCircuitBreakerActive(), "First push should never trigger CB");
    }

    function test_oracleCB_consecutiveMovesCanRetrigger() public {
        // First big move triggers CB (but doesn't push bad price)
        _setOraclePrice(56_000);
        vm.prank(owner);
        oracle.pushPrice(btcMarket);
        assertTrue(oracle.oracleCircuitBreakerActive());

        // Wait for cooldown + manually reset (skip stability verification for this test)
        vm.warp(block.timestamp + 181);

        // Reset CB manually (owner can always reset)
        vm.prank(owner);
        oracle.resetOracleCircuitBreaker();

        // Now push a normal price first (since lastPrice is still 50k, 56k was rejected)
        // We need a price within 10% of 50k
        _setOraclePrice(54_000); // 50k -> 54k = 8%
        vm.prank(owner);
        oracle.pushPrice(btcMarket);
        assertFalse(oracle.oracleCircuitBreakerActive());

        // Now another big move from 54k
        _setOraclePrice(61_000); // 54k -> 61k = +12.9%
        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        assertTrue(oracle.oracleCircuitBreakerActive(), "CB should retrigger on second big move");
    }
}
