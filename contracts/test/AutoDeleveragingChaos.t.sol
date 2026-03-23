// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AutoDeleveraging.sol";
import "../src/PerpEngine.sol";
import "../src/PerpVault.sol";
import "../src/InsuranceFund.sol";
import "./mocks/MockUSDC.sol";

/// @title AutoDeleveraging Chaos Tests
/// @notice Attack vectors: ADL on non-profitable position, cooldown bypass,
///         insurance fund sufficient, disabled ADL, 1-step ownership risk

contract AutoDeleveragingChaosTest is Test {
    MockUSDC public usdc;
    PerpVault public vault;
    PerpEngine public engine;
    InsuranceFund public insurance;
    AutoDeleveraging public adl;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("treasury");
    address public keeper = makeAddr("keeper");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    uint256 constant U = 1e6;
    uint256 constant S = 1e8;
    bytes32 public btcMkt;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, type(uint256).max);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);

        btcMkt = keccak256(abi.encodePacked("BTC-USD"));

        adl = new AutoDeleveraging(address(engine), address(vault), address(insurance), owner);

        // Set realistic timestamp (Foundry starts at 1, cooldown=300 checks fail)
        vm.warp(1700000000);

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        vault.setOperator(address(adl), true);
        engine.setOperator(address(adl), true);
        engine.setOperator(owner, true);
        engine.setOiSkewCap(10000);
        engine.setMaxExposureBps(0);
        insurance.setOperator(address(engine), true);
        engine.addMarket("BTC-USD", 500, 250, 1_000_000 * S, 28800);
        engine.updateMarkPrice(btcMkt, 50_000 * U, 50_000 * U);
        adl.setOperator(keeper, true);
        vm.stopPrank();

        // Fund traders
        _fundTrader(alice, 500_000 * U);
        _fundTrader(bob, 500_000 * U);

        // Fund insurance with a small amount (below threshold for ADL testing)
        usdc.mint(address(this), 500 * U); // Only $500
        usdc.approve(address(vault), 500 * U);
        vault.deposit(500 * U);
        vm.prank(owner);
        vault.setOperator(address(this), true);
        vault.internalTransfer(address(this), address(insurance), 500 * U);
    }

    function _fundTrader(address trader, uint256 amount) internal {
        usdc.mint(trader, amount);
        vm.startPrank(trader);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function _openPositions() internal {
        // Alice long 1 BTC, Bob short 1 BTC at $50k
        vm.startPrank(owner);
        engine.openPosition(btcMkt, alice, int256(1 * S), 50_000 * U);
        engine.openPosition(btcMkt, bob, -int256(1 * S), 50_000 * U);
        vm.stopPrank();
    }

    // ================================================================
    //  TEST 1: ADL blocked when insurance fund is sufficient
    // ================================================================
    function test_adl_blockedWhenFundSufficient() public {
        emit log_string("=== ADL: Blocked when insurance fund sufficient ===");

        _openPositions();

        // Add more to insurance to make it sufficient
        usdc.mint(address(this), 2000 * U);
        usdc.approve(address(vault), 2000 * U);
        vault.deposit(2000 * U);
        vault.internalTransfer(address(this), address(insurance), 2000 * U);

        // Price goes up - alice is profitable
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 55_000 * U, 55_000 * U);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(
            AutoDeleveraging.InsuranceFundSufficient.selector, 2500 * U, 1000 * U
        ));
        adl.executeADL(btcMkt, alice, 1 * S, 55_000 * U, 2000 * U);

        emit log_string("  [OK] ADL blocked when insurance fund is sufficient");
    }

    // ================================================================
    //  TEST 2: ADL blocked on non-profitable position
    // ================================================================
    function test_adl_blockedOnNonProfitable() public {
        emit log_string("=== ADL: Blocked on non-profitable position ===");

        _openPositions();

        // Price drops - alice is NOT profitable (long at $50k, now $45k)
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 45_000 * U, 45_000 * U);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(
            AutoDeleveraging.PositionNotProfitable.selector, btcMkt, alice
        ));
        adl.executeADL(btcMkt, alice, 1 * S, 45_000 * U, 2000 * U);

        emit log_string("  [OK] ADL blocked on non-profitable position");
    }

    // ================================================================
    //  TEST 3: ADL cooldown enforcement
    // ================================================================
    function test_adl_cooldownEnforcement() public {
        emit log_string("=== ADL: Cooldown enforcement ===");

        _openPositions();

        // Price goes up - alice is profitable, bob is not
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 55_000 * U, 55_000 * U);

        // Execute ADL on profitable alice
        vm.prank(keeper);
        adl.executeADL(btcMkt, alice, S / 2, 55_000 * U, 1500 * U);

        // Try immediately again - should hit cooldown
        vm.prank(keeper);
        vm.expectRevert(); // CooldownActive
        adl.executeADL(btcMkt, alice, S / 2, 55_000 * U, 1500 * U);

        // Wait cooldown (300s) and refresh mark price
        vm.warp(block.timestamp + 301);
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 55_000 * U, 55_000 * U);

        // Should work now (if position still profitable)
        (int256 size,,,,) = engine.positions(btcMkt, alice);
        if (size != 0) {
            int256 pnl = engine.getUnrealizedPnl(btcMkt, alice);
            if (pnl > 0) {
                vm.prank(keeper);
                adl.executeADL(btcMkt, alice, uint256(size), 55_000 * U, 1500 * U);
                emit log_string("  [OK] ADL succeeds after cooldown");
            }
        }

        emit log_string("  [OK] Cooldown enforced");
    }

    // ================================================================
    //  TEST 4: ADL disabled
    // ================================================================
    function test_adl_disabledBlocks() public {
        emit log_string("=== ADL: Disabled ADL blocks execution ===");

        vm.prank(owner);
        adl.setADLEnabled(false);

        _openPositions();
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 55_000 * U, 55_000 * U);

        vm.prank(keeper);
        vm.expectRevert(AutoDeleveraging.ADLDisabled.selector);
        adl.executeADL(btcMkt, alice, 1 * S, 55_000 * U, 2000 * U);

        emit log_string("  [OK] Disabled ADL blocks operations");
    }

    // ================================================================
    //  TEST 5: ADL paused
    // ================================================================
    function test_adl_pausedBlocks() public {
        emit log_string("=== ADL: Paused state blocks execution ===");

        vm.prank(owner);
        adl.pause();

        vm.prank(keeper);
        vm.expectRevert(AutoDeleveraging.Paused.selector);
        adl.executeADL(btcMkt, alice, 1 * S, 55_000 * U, 2000 * U);

        emit log_string("  [OK] Paused state blocks operations");
    }

    // ================================================================
    //  TEST 6: Non-operator blocked
    // ================================================================
    function test_adl_nonOperatorBlocked() public {
        emit log_string("=== ADL: Non-operator blocked ===");

        vm.prank(alice);
        vm.expectRevert(AutoDeleveraging.NotOperator.selector);
        adl.executeADL(btcMkt, alice, 1 * S, 55_000 * U, 2000 * U);

        emit log_string("  [OK] Non-operator blocked");
    }

    // ================================================================
    //  TEST 7: No position to deleverage
    // ================================================================
    function test_adl_noPosition() public {
        emit log_string("=== ADL: No position to deleverage ===");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AutoDeleveraging.NoPosition.selector, btcMkt, alice));
        adl.executeADL(btcMkt, alice, 1 * S, 55_000 * U, 2000 * U);

        emit log_string("  [OK] No position reverts");
    }

    // ================================================================
    //  TEST 8: Bad debt below threshold
    // ================================================================
    function test_adl_badDebtBelowThreshold() public {
        emit log_string("=== ADL: Bad debt below threshold ===");

        _openPositions();
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 55_000 * U, 55_000 * U);

        // Bad debt amount $500 < $1000 threshold
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(
            AutoDeleveraging.BadDebtBelowThreshold.selector, 500 * U, 1000 * U
        ));
        adl.executeADL(btcMkt, alice, 1 * S, 55_000 * U, 500 * U);

        emit log_string("  [OK] Bad debt below threshold rejected");
    }

    // ================================================================
    //  TEST 9: 1-step ownership transfer risk
    // ================================================================
    function test_adl_oneStepOwnershipRisk() public {
        emit log_string("=== ADL: 1-step ownership transfer (RISK) ===");

        // FIX APPLIED: Now uses 2-step transfer like all other contracts
        address newOwner = makeAddr("newOwner");

        vm.prank(owner);
        adl.transferOwnership(newOwner);

        // Owner is still owner until accepted
        assertEq(adl.owner(), owner, "Owner unchanged before accept");

        // Random cannot accept
        vm.expectRevert(AutoDeleveraging.NotOwner.selector);
        vm.prank(alice);
        adl.acceptOwnership();

        // New owner accepts
        vm.prank(newOwner);
        adl.acceptOwnership();
        assertEq(adl.owner(), newOwner, "Ownership transferred after accept");

        emit log_string("  [FIXED] 2-step ownership transfer - safe from typos");
    }

    // ================================================================
    //  TEST 10: isADLRequired view accuracy
    // ================================================================
    function test_adl_isADLRequiredAccuracy() public {
        emit log_string("=== ADL: isADLRequired view accuracy ===");

        // Insurance fund has $500 < $1000 threshold, ADL enabled, no cooldown
        (bool required, uint256 fundBal) = adl.isADLRequired();
        assertTrue(required, "ADL should be required when fund < threshold");
        assertEq(fundBal, 500 * U, "Fund balance should be $500");

        // Disable ADL
        vm.prank(owner);
        adl.setADLEnabled(false);
        (required,) = adl.isADLRequired();
        assertFalse(required, "ADL not required when disabled");

        emit log_string("  [OK] isADLRequired view accurate");
    }
}
