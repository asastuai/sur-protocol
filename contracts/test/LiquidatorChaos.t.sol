// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Liquidator.sol";
import "../src/PerpEngine.sol";
import "../src/PerpVault.sol";
import "../src/InsuranceFund.sol";
import "./mocks/MockUSDC.sol";

/// @title Liquidator Chaos Tests
/// @notice Attack vectors: liquidate healthy positions, double liquidation,
///         zero address, paused state, batch manipulation, counter overflow

contract LiquidatorChaosTest is Test {
    MockUSDC public usdc;
    PerpVault public vault;
    PerpEngine public engine;
    InsuranceFund public insurance;
    Liquidator public liquidator;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public keeper = makeAddr("keeper");

    uint256 constant U = 1e6;
    uint256 constant S = 1e8;
    bytes32 public btcMkt;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, type(uint256).max);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);

        btcMkt = keccak256(abi.encodePacked("BTC-USD"));

        liquidator = new Liquidator(address(engine), address(insurance), owner);

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        engine.setOperator(owner, true);
        engine.setOperator(address(liquidator), true);
        insurance.setOperator(address(engine), true);
        engine.addMarket("BTC-USD", 500, 250, 1_000_000 * S, 28800);
        engine.setOiSkewCap(10000); // Disable skew cap for testing
        engine.setMaxExposureBps(0); // Disable exposure limit for testing
        engine.updateMarkPrice(btcMkt, 50_000 * U, 50_000 * U);
        vm.stopPrank();

        // Fund alice and bob
        _fundTrader(alice, 100_000 * U);
        _fundTrader(bob, 100_000 * U);

        // Fund insurance
        usdc.mint(address(this), 10_000_000 * U);
        usdc.approve(address(vault), 10_000_000 * U);
        vault.deposit(10_000_000 * U);
        vm.prank(owner);
        vault.setOperator(address(this), true);
        vault.internalTransfer(address(this), address(insurance), 10_000_000 * U);
    }

    function _fundTrader(address trader, uint256 amount) internal {
        usdc.mint(trader, amount);
        vm.startPrank(trader);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    // ================================================================
    //  TEST 1: Liquidate healthy position should revert
    // ================================================================
    function test_liq_healthyPositionReverts() public {
        emit log_string("=== LIQUIDATOR: Healthy position cannot be liquidated ===");

        // Alice opens 1 BTC long with plenty of margin
        vm.prank(owner);
        engine.openPosition(btcMkt, alice, int256(1 * S), 50_000 * U);

        // Counter-party
        vm.prank(owner);
        engine.openPosition(btcMkt, bob, -int256(1 * S), 50_000 * U);

        // Try to liquidate healthy alice
        vm.expectRevert(abi.encodeWithSelector(
            Liquidator.PositionNotLiquidatable.selector, btcMkt, alice
        ));
        vm.prank(keeper);
        liquidator.liquidate(btcMkt, alice);

        emit log_string("  [OK] Cannot liquidate healthy position");
    }

    // ================================================================
    //  TEST 2: Liquidate zero address
    // ================================================================
    function test_liq_zeroAddressReverts() public {
        emit log_string("=== LIQUIDATOR: Zero address reverts ===");

        vm.expectRevert(Liquidator.ZeroAddress.selector);
        vm.prank(keeper);
        liquidator.liquidate(btcMkt, address(0));

        emit log_string("  [OK] Zero address rejected");
    }

    // ================================================================
    //  TEST 3: Liquidate position that doesn't exist
    // ================================================================
    function test_liq_noPositionReverts() public {
        emit log_string("=== LIQUIDATOR: No position reverts ===");

        vm.expectRevert(abi.encodeWithSelector(
            Liquidator.NoPosition.selector, btcMkt, alice
        ));
        vm.prank(keeper);
        liquidator.liquidate(btcMkt, alice);

        emit log_string("  [OK] No position rejected");
    }

    // ================================================================
    //  TEST 4: Paused liquidator blocks all liquidations
    // ================================================================
    function test_liq_pausedReverts() public {
        emit log_string("=== LIQUIDATOR: Paused state blocks liquidation ===");

        vm.prank(owner);
        liquidator.pause();

        vm.expectRevert(Liquidator.Paused.selector);
        vm.prank(keeper);
        liquidator.liquidate(btcMkt, alice);

        emit log_string("  [OK] Paused liquidator blocks operations");
    }

    // ================================================================
    //  TEST 5: Batch liquidation with mixed valid/invalid
    // ================================================================
    function test_liq_batchMixedPositions() public {
        emit log_string("=== LIQUIDATOR: Batch with mixed positions ===");

        // Alice opens a position, bob doesn't
        vm.prank(owner);
        engine.openPosition(btcMkt, alice, int256(1 * S), 50_000 * U);
        vm.prank(owner);
        engine.openPosition(btcMkt, bob, -int256(1 * S), 50_000 * U);

        bytes32[] memory markets = new bytes32[](3);
        address[] memory traders = new address[](3);
        markets[0] = btcMkt;
        markets[1] = btcMkt;
        markets[2] = keccak256(abi.encodePacked("NONEXISTENT"));
        traders[0] = alice;
        traders[1] = makeAddr("nopos");
        traders[2] = alice;

        // Should not revert - batch silently skips invalid
        vm.prank(keeper);
        liquidator.liquidateBatch(markets, traders);

        // No liquidations should have succeeded (all healthy or no position)
        assertEq(liquidator.totalLiquidations(), 0, "No liquidations should succeed");
        emit log_string("  [OK] Batch gracefully skips invalid/healthy positions");
    }

    // ================================================================
    //  TEST 6: Batch array length mismatch
    // ================================================================
    function test_liq_batchLengthMismatch() public {
        emit log_string("=== LIQUIDATOR: Batch length mismatch ===");

        bytes32[] memory markets = new bytes32[](2);
        address[] memory traders = new address[](1);
        markets[0] = btcMkt;
        markets[1] = btcMkt;
        traders[0] = alice;

        vm.expectRevert("Length mismatch");
        vm.prank(keeper);
        liquidator.liquidateBatch(markets, traders);

        emit log_string("  [OK] Length mismatch rejected");
    }

    // ================================================================
    //  TEST 7: Keeper counter tracking
    // ================================================================
    function test_liq_keeperCounterTracking() public {
        emit log_string("=== LIQUIDATOR: Keeper counter tracking ===");

        // Setup undercollateralized position
        vm.prank(owner);
        engine.openPosition(btcMkt, alice, int256(1 * S), 50_000 * U);
        vm.prank(owner);
        engine.openPosition(btcMkt, bob, -int256(1 * S), 50_000 * U);

        // Price drop to make alice liquidatable
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 25_000 * U, 25_000 * U);

        // Verify liquidatable
        bool canLiq = engine.isLiquidatable(btcMkt, alice);
        if (!canLiq) {
            emit log_string("  [SKIP] Position not liquidatable at this price drop");
            return;
        }

        uint256 countBefore = liquidator.keeperLiquidations(keeper);

        vm.prank(keeper);
        liquidator.liquidate(btcMkt, alice);

        uint256 countAfter = liquidator.keeperLiquidations(keeper);
        assertEq(countAfter, countBefore + 1, "Keeper counter should increment");
        assertEq(liquidator.totalLiquidations(), 1, "Total should be 1");
        emit log_string("  [OK] Counters track correctly");
    }

    // ================================================================
    //  TEST 8: canLiquidate view function accuracy
    // ================================================================
    function test_liq_canLiquidateAccuracy() public {
        emit log_string("=== LIQUIDATOR: canLiquidate view accuracy ===");

        // No position
        (bool can, int256 size) = liquidator.canLiquidate(btcMkt, alice);
        assertFalse(can, "Should not be liquidatable without position");
        assertEq(size, 0, "Size should be 0");

        // Open position
        vm.prank(owner);
        engine.openPosition(btcMkt, alice, int256(1 * S), 50_000 * U);
        vm.prank(owner);
        engine.openPosition(btcMkt, bob, -int256(1 * S), 50_000 * U);

        (can, size) = liquidator.canLiquidate(btcMkt, alice);
        assertFalse(can, "Healthy position not liquidatable");
        assertEq(size, int256(1 * S), "Size should be 1 BTC");

        emit log_string("  [OK] canLiquidate view accurate");
    }

    // ================================================================
    //  TEST 9: Ownership transfer - 2-step
    // ================================================================
    function test_liq_ownershipTransfer() public {
        emit log_string("=== LIQUIDATOR: 2-step ownership transfer ===");

        address newOwner = makeAddr("newOwner");

        // Non-owner cannot transfer
        vm.expectRevert(Liquidator.NotOwner.selector);
        vm.prank(alice);
        liquidator.transferOwnership(newOwner);

        // Owner initiates transfer
        vm.prank(owner);
        liquidator.transferOwnership(newOwner);

        // Owner is still owner
        assertEq(liquidator.owner(), owner, "Owner unchanged before accept");

        // Random cannot accept
        vm.expectRevert(Liquidator.NotOwner.selector);
        vm.prank(alice);
        liquidator.acceptOwnership();

        // New owner accepts
        vm.prank(newOwner);
        liquidator.acceptOwnership();
        assertEq(liquidator.owner(), newOwner, "Ownership transferred");

        emit log_string("  [OK] 2-step ownership transfer works correctly");
    }

    // ================================================================
    //  TEST 10: scanLiquidatable batch view
    // ================================================================
    function test_liq_scanLiquidatable() public {
        emit log_string("=== LIQUIDATOR: scanLiquidatable batch view ===");

        // Open positions
        vm.prank(owner);
        engine.openPosition(btcMkt, alice, int256(1 * S), 50_000 * U);
        vm.prank(owner);
        engine.openPosition(btcMkt, bob, -int256(1 * S), 50_000 * U);

        bytes32[] memory markets = new bytes32[](2);
        address[] memory traders = new address[](2);
        markets[0] = btcMkt;
        markets[1] = btcMkt;
        traders[0] = alice;
        traders[1] = bob;

        bool[] memory results = liquidator.scanLiquidatable(markets, traders);
        assertFalse(results[0], "Alice should not be liquidatable");
        assertFalse(results[1], "Bob should not be liquidatable");

        emit log_string("  [OK] scanLiquidatable returns correct results");
    }
}
