// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/CollateralManager.sol";
import "../src/PerpVault.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockERC20.sol";

/// @title CollateralManager Chaos Tests
/// @notice Attack vectors: rounding exploits, deposit cap bypass, haircut manipulation,
///         liquidation threshold gaming, stale price exploitation, withdrawal drain

contract CollateralManagerChaosTest is Test {
    MockUSDC public usdc;
    MockERC20 public cbETH;
    MockERC20 public stUSDC;
    PerpVault public vault;
    CollateralManager public cm;

    address public owner = makeAddr("owner");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public keeper = makeAddr("keeper");

    uint256 constant U = 1e6;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, type(uint256).max);
        cm = new CollateralManager(address(vault), owner);

        vm.startPrank(owner);
        vault.setOperator(address(cm), true);
        cm.setOperator(keeper, true);

        // Add cbETH: 18 decimals, 95% haircut, $3500, 120s max age, no cap
        cm.addCollateral(
            address(cbETH = new MockERC20("Coinbase ETH", "cbETH", 18)),
            "cbETH",
            18,
            9500,
            3500 * U,
            120,
            0
        );

        // Add stUSDC: 6 decimals, 100% haircut, $1, 120s max age, cap 1M
        cm.addCollateral(
            address(stUSDC = new MockERC20("Staked USDC", "stUSDC", 6)),
            "stUSDC",
            6,
            10000,
            1 * U,
            120,
            1_000_000 * U
        );
        vm.stopPrank();
    }

    // ================================================================
    //  TEST 1: Rounding dust attack - tiny deposits to extract credit
    // ================================================================
    function test_cm_roundingDustDeposit() public {
        emit log_string("=== CM: Rounding dust deposit attack ===");

        // Try depositing 1 wei of cbETH (worth ~$0.0000000000000035)
        cbETH.mint(alice, 1);
        vm.startPrank(alice);
        cbETH.approve(address(cm), 1);
        // Should revert: "Deposit too small for credit"
        vm.expectRevert("Deposit too small for credit");
        cm.depositCollateral(address(cbETH), 1);
        vm.stopPrank();
        emit log_string("  [OK] Dust deposit blocked - no free credit");
    }

    // ================================================================
    //  TEST 2: Deposit cap bypass via multiple small deposits
    // ================================================================
    function test_cm_depositCapEnforcement() public {
        emit log_string("=== CM: Deposit cap enforcement ===");

        // stUSDC has 1M cap
        stUSDC.mint(alice, 1_500_000 * U);
        vm.startPrank(alice);
        stUSDC.approve(address(cm), type(uint256).max);

        // First deposit: 900k (OK)
        cm.depositCollateral(address(stUSDC), 900_000 * U);

        // Second deposit: 200k (should exceed 1M cap)
        vm.expectRevert("Deposit cap exceeded");
        cm.depositCollateral(address(stUSDC), 200_000 * U);
        vm.stopPrank();

        emit log_string("  [OK] Deposit cap enforced across multiple deposits");
    }

    // ================================================================
    //  TEST 3: Withdraw more credit than deposited via rounding
    //  debitUsdc = (creditedUsdc * 1 wei) / 10e18 rounds to 0
    //  vault.debitCollateral(0) reverts ZeroAmount => attack blocked
    // ================================================================
    function test_cm_withdrawalRoundingExploit() public {
        emit log_string("=== CM: Withdrawal rounding exploit ===");

        // Deposit 10 cbETH at $3500 with 95% haircut = $33,250 credit
        uint256 depositAmt = 10 ether;
        cbETH.mint(alice, depositAmt);
        vm.startPrank(alice);
        cbETH.approve(address(cm), depositAmt);
        uint256 credited = cm.depositCollateral(address(cbETH), depositAmt);
        emit log_named_uint("  Credited USDC", credited);

        // Withdraw 1 wei: debitUsdc rounds to 0, vault reverts ZeroAmount
        vm.expectRevert(); // vault.debitCollateral(trader, 0) => ZeroAmount
        cm.withdrawCollateral(address(cbETH), 1);
        vm.stopPrank();

        emit log_string("  [OK] Rounding attack blocked by vault ZeroAmount check");
    }

    // ================================================================
    //  TEST 4: Stale price exploitation
    // ================================================================
    function test_cm_stalePriceDeposit() public {
        emit log_string("=== CM: Stale price deposit blocked ===");

        // Advance time past maxPriceAge (120s)
        vm.warp(block.timestamp + 200);

        cbETH.mint(alice, 1 ether);
        vm.startPrank(alice);
        cbETH.approve(address(cm), 1 ether);

        // Should revert with StalePrice
        vm.expectRevert(abi.encodeWithSelector(CollateralManager.StalePrice.selector, address(cbETH)));
        cm.depositCollateral(address(cbETH), 1 ether);
        vm.stopPrank();

        emit log_string("  [OK] Stale price blocks deposits");
    }

    // ================================================================
    //  TEST 5: Stale price withdrawal still works (by design? or bug?)
    // ================================================================
    function test_cm_stalePriceWithdraw() public {
        emit log_string("=== CM: Stale price withdrawal behavior ===");

        // First deposit with fresh price
        cbETH.mint(alice, 1 ether);
        vm.startPrank(alice);
        cbETH.approve(address(cm), 1 ether);
        cm.depositCollateral(address(cbETH), 1 ether);

        // Advance time past maxPriceAge
        vm.warp(block.timestamp + 200);

        // Try to withdraw with stale price
        try cm.withdrawCollateral(address(cbETH), 1 ether) {
            emit log_string("  [INFO] Withdrawal allowed with stale price");
        } catch {
            emit log_string("  [OK] Stale price blocks withdrawals too");
        }
        vm.stopPrank();
    }

    // ================================================================
    //  TEST 6: Price manipulation attack on collateral value
    // ================================================================
    function test_cm_priceManipulationDeviation() public {
        emit log_string("=== CM: Price deviation cap enforcement ===");

        // Try to pump cbETH price by >10%
        vm.startPrank(keeper);
        vm.expectRevert();
        cm.updatePrice(address(cbETH), 4000 * U); // ~14% up from $3500
        vm.stopPrank();

        emit log_string("  [OK] Price deviation cap prevents manipulation");
    }

    // ================================================================
    //  TEST 7: Liquidation threshold gaming - deposit then price drops
    // ================================================================
    function test_cm_liquidationThresholdCheck() public {
        emit log_string("=== CM: Collateral liquidation threshold ===");

        // Alice deposits 10 cbETH at $3500 -> $33,250 credit (95% haircut)
        cbETH.mint(alice, 10 ether);
        vm.startPrank(alice);
        cbETH.approve(address(cm), 10 ether);
        cm.depositCollateral(address(cbETH), 10 ether);
        vm.stopPrank();

        // Check not liquidatable at current price
        bool liqBefore = cm.isLiquidatable(alice, address(cbETH));
        assertFalse(liqBefore, "Should not be liquidatable at deposit price");

        // Price drops to $3000 (~14% down, need multiple updates within 10% deviation)
        vm.startPrank(keeper);
        cm.updatePrice(address(cbETH), 3200 * U); // first step: ~8.6% down
        cm.updatePrice(address(cbETH), 2900 * U); // second step: ~9.4% down
        vm.stopPrank();

        // At $2900, value = 10 * 2900 * 0.95 = $27,550
        // creditedUsdc = $33,250
        // ratio = 27550/33250 = 82.8% < 90% threshold => liquidatable
        bool liqAfter = cm.isLiquidatable(alice, address(cbETH));
        assertTrue(liqAfter, "Should be liquidatable after price drop");

        // Keeper liquidates
        vm.prank(keeper);
        cm.liquidateCollateral(alice, address(cbETH));

        // Verify position cleared
        (uint256 amt, uint256 credit,) = cm.getTraderCollateral(address(cbETH), alice);
        assertEq(amt, 0, "Token amount should be 0 after liquidation");
        assertEq(credit, 0, "Credit should be 0 after liquidation");
        emit log_string("  [OK] Liquidation correctly executed after price drop");
    }

    // ================================================================
    //  TEST 8: Double liquidation attempt
    // ================================================================
    function test_cm_doubleLiquidation() public {
        emit log_string("=== CM: Double liquidation prevention ===");

        // Setup liquidatable position
        cbETH.mint(alice, 10 ether);
        vm.startPrank(alice);
        cbETH.approve(address(cm), 10 ether);
        cm.depositCollateral(address(cbETH), 10 ether);
        vm.stopPrank();

        // Drop price to make liquidatable
        vm.startPrank(keeper);
        cm.updatePrice(address(cbETH), 3200 * U);
        cm.updatePrice(address(cbETH), 2900 * U);

        // First liquidation succeeds
        cm.liquidateCollateral(alice, address(cbETH));

        // Second liquidation should revert (position already cleared)
        vm.expectRevert(abi.encodeWithSelector(CollateralManager.InsufficientCollateral.selector, 0, 0));
        cm.liquidateCollateral(alice, address(cbETH));
        vm.stopPrank();

        emit log_string("  [OK] Double liquidation prevented");
    }

    // ================================================================
    //  TEST 9: Paused collateral deposit/withdraw
    // ================================================================
    function test_cm_pausedCollateral() public {
        emit log_string("=== CM: Paused collateral operations ===");

        // Pause cbETH
        vm.prank(owner);
        cm.pauseCollateral(address(cbETH));

        cbETH.mint(alice, 1 ether);
        vm.startPrank(alice);
        cbETH.approve(address(cm), 1 ether);

        // Deposit should revert
        vm.expectRevert(abi.encodeWithSelector(CollateralManager.CollateralPaused.selector, address(cbETH)));
        cm.depositCollateral(address(cbETH), 1 ether);
        vm.stopPrank();

        emit log_string("  [OK] Paused collateral blocks deposits");
    }

    // ================================================================
    //  TEST 10: Zero amount deposit/withdraw
    // ================================================================
    function test_cm_zeroAmountOperations() public {
        emit log_string("=== CM: Zero amount rejection ===");

        vm.startPrank(alice);
        vm.expectRevert(CollateralManager.ZeroAmount.selector);
        cm.depositCollateral(address(cbETH), 0);

        vm.expectRevert(CollateralManager.ZeroAmount.selector);
        cm.withdrawCollateral(address(cbETH), 0);
        vm.stopPrank();

        emit log_string("  [OK] Zero amounts rejected");
    }

    // ================================================================
    //  TEST 11: Haircut change impact on existing positions
    // ================================================================
    function test_cm_haircutChangeImpact() public {
        emit log_string("=== CM: Haircut change impact on liquidation ===");

        // Alice deposits at 95% haircut
        cbETH.mint(alice, 10 ether);
        vm.startPrank(alice);
        cbETH.approve(address(cm), 10 ether);
        cm.depositCollateral(address(cbETH), 10 ether);
        vm.stopPrank();

        (,uint256 creditedUsdc,) = cm.getTraderCollateral(address(cbETH), alice);
        emit log_named_uint("  Credited at 95% haircut", creditedUsdc);

        // Owner lowers haircut to 50% (more aggressive)
        vm.prank(owner);
        cm.setHaircut(address(cbETH), 5000);

        // Now currentValue = 10 * 3500 * 0.50 = $17,500
        // creditedUsdc = $33,250 (unchanged - stored at deposit time)
        // ratio = 17500/33250 = 52.6% < 90% threshold => liquidatable!
        bool liq = cm.isLiquidatable(alice, address(cbETH));
        assertTrue(liq, "Haircut change should make position liquidatable");

        emit log_string("  [INFO] Haircut reduction makes existing positions liquidatable");
        emit log_string("  [INFO] This is a governance risk - sudden haircut changes can mass-liquidate");
    }

    // ================================================================
    //  TEST 12: Withdraw from insufficient collateral
    // ================================================================
    function test_cm_withdrawMoreThanDeposited() public {
        emit log_string("=== CM: Withdraw more than deposited ===");

        cbETH.mint(alice, 5 ether);
        vm.startPrank(alice);
        cbETH.approve(address(cm), 5 ether);
        cm.depositCollateral(address(cbETH), 5 ether);

        // Try to withdraw 10 ether
        vm.expectRevert(abi.encodeWithSelector(
            CollateralManager.InsufficientCollateral.selector, 10 ether, 5 ether
        ));
        cm.withdrawCollateral(address(cbETH), 10 ether);
        vm.stopPrank();

        emit log_string("  [OK] Cannot withdraw more than deposited");
    }
}
