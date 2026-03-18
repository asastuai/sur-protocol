// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PerpVault.sol";
import "./mocks/MockUSDC.sol";

contract PerpVaultTest is Test {
    PerpVault public vault;
    MockUSDC public usdc;

    address public owner = makeAddr("owner");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public charlie = makeAddr("charlie");
    address public operator = makeAddr("operator");

    uint256 constant USDC_UNIT = 1e6; // 6 decimals
    uint256 constant INITIAL_BALANCE = 100_000 * USDC_UNIT; // 100k USDC
    uint256 constant DEPOSIT_CAP = 1_000_000 * USDC_UNIT; // 1M USDC cap

    // ============================================================
    //                          SETUP
    // ============================================================

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, DEPOSIT_CAP);

        // Mint USDC to test users
        usdc.mint(alice, INITIAL_BALANCE);
        usdc.mint(bob, INITIAL_BALANCE);
        usdc.mint(charlie, INITIAL_BALANCE);

        // Approve vault to spend USDC
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(charlie);
        usdc.approve(address(vault), type(uint256).max);

        // Set operator
        vm.prank(owner);
        vault.setOperator(operator, true);
    }

    // ============================================================
    //                       CONSTRUCTOR
    // ============================================================

    function test_constructor_setsState() public view {
        assertEq(address(vault.usdc()), address(usdc));
        assertEq(vault.owner(), owner);
        assertEq(vault.depositCap(), DEPOSIT_CAP);
        assertEq(vault.usdcDecimals(), 6);
        assertEq(vault.paused(), false);
        assertEq(vault.totalDeposits(), 0);
    }

    function test_constructor_revertsZeroUsdc() public {
        vm.expectRevert(PerpVault.ZeroAddress.selector);
        new PerpVault(address(0), owner, 0);
    }

    function test_constructor_revertsZeroOwner() public {
        vm.expectRevert(PerpVault.ZeroAddress.selector);
        new PerpVault(address(usdc), address(0), 0);
    }

    // ============================================================
    //                        DEPOSITS
    // ============================================================

    function test_deposit_success() public {
        uint256 amount = 10_000 * USDC_UNIT;

        vm.expectEmit(true, false, false, true);
        emit PerpVault.Deposit(alice, amount, amount);

        vm.prank(alice);
        vault.deposit(amount);

        assertEq(vault.balances(alice), amount);
        assertEq(vault.totalDeposits(), amount);
        assertEq(usdc.balanceOf(address(vault)), amount);
        assertEq(usdc.balanceOf(alice), INITIAL_BALANCE - amount);
    }

    function test_deposit_multipleUsers() public {
        uint256 aliceAmount = 10_000 * USDC_UNIT;
        uint256 bobAmount = 20_000 * USDC_UNIT;

        vm.prank(alice);
        vault.deposit(aliceAmount);
        vm.prank(bob);
        vault.deposit(bobAmount);

        assertEq(vault.balances(alice), aliceAmount);
        assertEq(vault.balances(bob), bobAmount);
        assertEq(vault.totalDeposits(), aliceAmount + bobAmount);
    }

    function test_deposit_multipleDeposits() public {
        vm.startPrank(alice);
        vault.deposit(5_000 * USDC_UNIT);
        vault.deposit(3_000 * USDC_UNIT);
        vm.stopPrank();

        assertEq(vault.balances(alice), 8_000 * USDC_UNIT);
    }

    function test_deposit_revertsZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(PerpVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_deposit_revertsWhenPaused() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert(PerpVault.Paused.selector);
        vault.deposit(1000 * USDC_UNIT);
    }

    function test_deposit_revertsExceedsCap() public {
        // Try to deposit more than cap
        usdc.mint(alice, DEPOSIT_CAP); // Give alice enough
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PerpVault.DepositCapExceeded.selector,
                DEPOSIT_CAP + 1,
                DEPOSIT_CAP
            )
        );
        vault.deposit(DEPOSIT_CAP + 1);
    }

    function test_deposit_capsWorkCorrectly() public {
        // Deposit up to cap should work
        usdc.mint(alice, DEPOSIT_CAP);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        vm.prank(alice);
        vault.deposit(DEPOSIT_CAP);
        assertEq(vault.totalDeposits(), DEPOSIT_CAP);

        // One more unit should fail
        usdc.mint(bob, 1);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);

        vm.prank(bob);
        vm.expectRevert();
        vault.deposit(1);
    }

    function test_deposit_unlimitedCapWhenZero() public {
        vm.prank(owner);
        vault.setDepositCap(0); // unlimited

        usdc.mint(alice, 10_000_000 * USDC_UNIT);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        vm.prank(alice);
        vault.deposit(10_000_000 * USDC_UNIT); // Should succeed with 0 cap
        assertEq(vault.totalDeposits(), 10_000_000 * USDC_UNIT);
    }

    // ============================================================
    //                      WITHDRAWALS
    // ============================================================

    function test_withdraw_success() public {
        uint256 depositAmount = 10_000 * USDC_UNIT;
        uint256 withdrawAmount = 3_000 * USDC_UNIT;

        vm.prank(alice);
        vault.deposit(depositAmount);

        vm.expectEmit(true, false, false, true);
        emit PerpVault.Withdraw(alice, withdrawAmount, depositAmount - withdrawAmount);

        vm.prank(alice);
        vault.withdraw(withdrawAmount);

        assertEq(vault.balances(alice), depositAmount - withdrawAmount);
        assertEq(vault.totalDeposits(), depositAmount - withdrawAmount);
        assertEq(usdc.balanceOf(alice), INITIAL_BALANCE - depositAmount + withdrawAmount);
    }

    function test_withdraw_fullBalance() public {
        uint256 amount = 10_000 * USDC_UNIT;

        vm.startPrank(alice);
        vault.deposit(amount);
        vault.withdraw(amount);
        vm.stopPrank();

        assertEq(vault.balances(alice), 0);
        assertEq(vault.totalDeposits(), 0);
        assertEq(usdc.balanceOf(alice), INITIAL_BALANCE);
    }

    function test_withdraw_revertsZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(PerpVault.ZeroAmount.selector);
        vault.withdraw(0);
    }

    function test_withdraw_revertsInsufficientBalance() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC_UNIT);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PerpVault.InsufficientBalance.selector,
                2_000 * USDC_UNIT,
                1_000 * USDC_UNIT
            )
        );
        vault.withdraw(2_000 * USDC_UNIT);
    }

    function test_withdraw_revertsWhenPaused() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC_UNIT);

        vm.prank(owner);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert(PerpVault.Paused.selector);
        vault.withdraw(500 * USDC_UNIT);
    }

    function test_withdraw_revertsExceedsMaxPerTx() public {
        vm.prank(owner);
        vault.setMaxWithdrawalPerTx(5_000 * USDC_UNIT);

        vm.prank(alice);
        vault.deposit(10_000 * USDC_UNIT);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PerpVault.WithdrawalTooLarge.selector,
                6_000 * USDC_UNIT,
                5_000 * USDC_UNIT
            )
        );
        vault.withdraw(6_000 * USDC_UNIT);
    }

    function test_withdraw_withinMaxPerTx() public {
        vm.prank(owner);
        vault.setMaxWithdrawalPerTx(5_000 * USDC_UNIT);

        vm.prank(alice);
        vault.deposit(10_000 * USDC_UNIT);

        // Should succeed at exactly the max
        vm.prank(alice);
        vault.withdraw(5_000 * USDC_UNIT);
        assertEq(vault.balances(alice), 5_000 * USDC_UNIT);
    }

    // ============================================================
    //                   INTERNAL TRANSFERS
    // ============================================================

    function test_internalTransfer_success() public {
        vm.prank(alice);
        vault.deposit(10_000 * USDC_UNIT);

        uint256 transferAmount = 3_000 * USDC_UNIT;

        vm.expectEmit(true, true, true, true);
        emit PerpVault.InternalTransfer(alice, bob, transferAmount, operator);

        vm.prank(operator);
        vault.internalTransfer(alice, bob, transferAmount);

        assertEq(vault.balances(alice), 7_000 * USDC_UNIT);
        assertEq(vault.balances(bob), 3_000 * USDC_UNIT);
        // Total deposits unchanged - just moved between accounts
        assertEq(vault.totalDeposits(), 10_000 * USDC_UNIT);
    }

    function test_internalTransfer_revertsNonOperator() public {
        vm.prank(alice);
        vault.deposit(10_000 * USDC_UNIT);

        vm.prank(alice); // not an operator
        vm.expectRevert(PerpVault.NotOperator.selector);
        vault.internalTransfer(alice, bob, 1_000 * USDC_UNIT);
    }

    function test_internalTransfer_revertsInsufficientBalance() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC_UNIT);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                PerpVault.InsufficientBalance.selector,
                2_000 * USDC_UNIT,
                1_000 * USDC_UNIT
            )
        );
        vault.internalTransfer(alice, bob, 2_000 * USDC_UNIT);
    }

    function test_internalTransfer_revertsZeroAmount() public {
        vm.prank(operator);
        vm.expectRevert(PerpVault.ZeroAmount.selector);
        vault.internalTransfer(alice, bob, 0);
    }

    function test_internalTransfer_revertsZeroAddress() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC_UNIT);

        vm.prank(operator);
        vm.expectRevert(PerpVault.ZeroAddress.selector);
        vault.internalTransfer(address(0), bob, 100);

        vm.prank(operator);
        vm.expectRevert(PerpVault.ZeroAddress.selector);
        vault.internalTransfer(alice, address(0), 100);
    }

    // ============================================================
    //                  BATCH INTERNAL TRANSFERS
    // ============================================================

    function test_batchInternalTransfer_success() public {
        vm.prank(alice);
        vault.deposit(10_000 * USDC_UNIT);
        vm.prank(bob);
        vault.deposit(5_000 * USDC_UNIT);

        address[] memory froms = new address[](2);
        address[] memory tos = new address[](2);
        uint256[] memory amounts = new uint256[](2);

        // Alice pays Bob 2000, Bob pays Charlie 1000
        froms[0] = alice;     tos[0] = bob;       amounts[0] = 2_000 * USDC_UNIT;
        froms[1] = bob;       tos[1] = charlie;   amounts[1] = 1_000 * USDC_UNIT;

        vm.prank(operator);
        vault.batchInternalTransfer(froms, tos, amounts);

        assertEq(vault.balances(alice), 8_000 * USDC_UNIT);
        assertEq(vault.balances(bob), 6_000 * USDC_UNIT);    // +2000 -1000
        assertEq(vault.balances(charlie), 1_000 * USDC_UNIT);
        assertEq(vault.totalDeposits(), 15_000 * USDC_UNIT);  // unchanged
    }

    function test_batchInternalTransfer_revertsNonOperator() public {
        address[] memory froms = new address[](1);
        address[] memory tos = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        froms[0] = alice; tos[0] = bob; amounts[0] = 100;

        vm.prank(alice);
        vm.expectRevert(PerpVault.NotOperator.selector);
        vault.batchInternalTransfer(froms, tos, amounts);
    }

    function test_batchInternalTransfer_revertsPartialFail() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC_UNIT);

        address[] memory froms = new address[](2);
        address[] memory tos = new address[](2);
        uint256[] memory amounts = new uint256[](2);

        froms[0] = alice; tos[0] = bob;     amounts[0] = 500 * USDC_UNIT;
        froms[1] = alice; tos[1] = charlie;  amounts[1] = 600 * USDC_UNIT; // would exceed after first

        vm.prank(operator);
        vm.expectRevert(); // Second transfer fails, whole batch reverts
        vault.batchInternalTransfer(froms, tos, amounts);

        // State unchanged due to revert
        assertEq(vault.balances(alice), 1_000 * USDC_UNIT);
        assertEq(vault.balances(bob), 0);
    }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    function test_setOperator() public {
        address newOp = makeAddr("newOperator");

        vm.expectEmit(true, false, false, true);
        emit PerpVault.OperatorUpdated(newOp, true);

        vm.prank(owner);
        vault.setOperator(newOp, true);
        assertTrue(vault.operators(newOp));

        vm.prank(owner);
        vault.setOperator(newOp, false);
        assertFalse(vault.operators(newOp));
    }

    function test_setOperator_revertsNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(PerpVault.NotOwner.selector);
        vault.setOperator(alice, true);
    }

    function test_pause_unpause() public {
        vm.prank(owner);
        vault.pause();
        assertTrue(vault.paused());

        vm.prank(owner);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_pause_revertsAlreadyPaused() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(owner);
        vm.expectRevert(PerpVault.Paused.selector);
        vault.pause();
    }

    function test_unpause_revertsNotPaused() public {
        vm.prank(owner);
        vm.expectRevert(PerpVault.NotPaused.selector);
        vault.unpause();
    }

    function test_setDepositCap() public {
        uint256 newCap = 5_000_000 * USDC_UNIT;

        vm.expectEmit(false, false, false, true);
        emit PerpVault.DepositCapUpdated(DEPOSIT_CAP, newCap);

        vm.prank(owner);
        vault.setDepositCap(newCap);
        assertEq(vault.depositCap(), newCap);
    }

    function test_setMaxWithdrawalPerTx() public {
        uint256 maxW = 10_000 * USDC_UNIT;

        vm.prank(owner);
        vault.setMaxWithdrawalPerTx(maxW);
        assertEq(vault.maxWithdrawalPerTx(), maxW);
    }

    // ============================================================
    //                   OWNERSHIP TRANSFER
    // ============================================================

    function test_transferOwnership_twoStep() public {
        vm.prank(owner);
        vault.transferOwnership(alice);
        assertEq(vault.pendingOwner(), alice);
        assertEq(vault.owner(), owner); // Still the old owner

        vm.prank(alice);
        vault.acceptOwnership();
        assertEq(vault.owner(), alice);
        assertEq(vault.pendingOwner(), address(0));
    }

    function test_transferOwnership_revertsNonPending() public {
        vm.prank(owner);
        vault.transferOwnership(alice);

        vm.prank(bob); // Not the pending owner
        vm.expectRevert(PerpVault.NotOwner.selector);
        vault.acceptOwnership();
    }

    function test_transferOwnership_revertsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(PerpVault.ZeroAddress.selector);
        vault.transferOwnership(address(0));
    }

    // ============================================================
    //                     HEALTH CHECK
    // ============================================================

    function test_healthCheck_healthy() public {
        vm.prank(alice);
        vault.deposit(10_000 * USDC_UNIT);

        (bool isHealthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(isHealthy);
        assertEq(actual, 10_000 * USDC_UNIT);
        assertEq(accounted, 10_000 * USDC_UNIT);
    }

    function test_healthCheck_afterDepositsAndWithdrawals() public {
        vm.prank(alice);
        vault.deposit(10_000 * USDC_UNIT);
        vm.prank(bob);
        vault.deposit(5_000 * USDC_UNIT);
        vm.prank(alice);
        vault.withdraw(3_000 * USDC_UNIT);

        (bool isHealthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(isHealthy);
        assertEq(actual, 12_000 * USDC_UNIT);
        assertEq(accounted, 12_000 * USDC_UNIT);
    }

    function test_balanceOf() public {
        vm.prank(alice);
        vault.deposit(5_000 * USDC_UNIT);

        assertEq(vault.balanceOf(alice), 5_000 * USDC_UNIT);
        assertEq(vault.balanceOf(bob), 0);
    }

    function test_vaultBalance() public {
        vm.prank(alice);
        vault.deposit(5_000 * USDC_UNIT);

        assertEq(vault.vaultBalance(), 5_000 * USDC_UNIT);
    }

    // ============================================================
    //                    FUZZ TESTS
    // ============================================================

    function testFuzz_deposit_withdraw_roundtrip(uint256 amount) public {
        // Bound to reasonable range (1 USDC to 500k USDC, within cap)
        amount = bound(amount, 1, 500_000 * USDC_UNIT);

        usdc.mint(alice, amount);
        vm.prank(alice);
        usdc.approve(address(vault), amount);

        uint256 balBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vault.deposit(amount);
        assertEq(vault.balances(alice), amount);

        vm.prank(alice);
        vault.withdraw(amount);
        assertEq(vault.balances(alice), 0);
        assertEq(usdc.balanceOf(alice), balBefore);
    }

    function testFuzz_internalTransfer_conservesTotal(
        uint256 depositA,
        uint256 depositB,
        uint256 transferAmt
    ) public {
        depositA = bound(depositA, 1, 400_000 * USDC_UNIT);
        depositB = bound(depositB, 1, 400_000 * USDC_UNIT);
        transferAmt = bound(transferAmt, 1, depositA);

        usdc.mint(alice, depositA);
        usdc.mint(bob, depositB);
        vm.prank(alice);
        usdc.approve(address(vault), depositA);
        vm.prank(bob);
        usdc.approve(address(vault), depositB);

        vm.prank(alice);
        vault.deposit(depositA);
        vm.prank(bob);
        vault.deposit(depositB);

        uint256 totalBefore = vault.totalDeposits();

        vm.prank(operator);
        vault.internalTransfer(alice, bob, transferAmt);

        // Total deposits must be conserved
        assertEq(vault.totalDeposits(), totalBefore);
        // Individual balances correct
        assertEq(vault.balances(alice), depositA - transferAmt);
        assertEq(vault.balances(bob), depositB + transferAmt);
    }

    // ============================================================
    //               COLLATERAL CREDIT / DEBIT
    // ============================================================

    function test_creditCollateral_success() public {
        uint256 creditAmount = 10_000 * USDC_UNIT;

        vm.prank(operator);
        vault.creditCollateral(alice, creditAmount);

        assertEq(vault.balances(alice), creditAmount);
        assertEq(vault.totalCollateralCredits(), creditAmount);
        // totalDeposits should NOT increase (no real USDC moved)
        assertEq(vault.totalDeposits(), 0);
    }

    function test_creditCollateral_revertsNotOperator() public {
        vm.prank(alice);
        vm.expectRevert(PerpVault.NotOperator.selector);
        vault.creditCollateral(alice, 1000 * USDC_UNIT);
    }

    function test_creditCollateral_revertsZeroAmount() public {
        vm.prank(operator);
        vm.expectRevert(PerpVault.ZeroAmount.selector);
        vault.creditCollateral(alice, 0);
    }

    function test_debitCollateral_success() public {
        // First credit
        vm.prank(operator);
        vault.creditCollateral(alice, 10_000 * USDC_UNIT);

        // Then debit
        vm.prank(operator);
        vault.debitCollateral(alice, 3_000 * USDC_UNIT);

        assertEq(vault.balances(alice), 7_000 * USDC_UNIT);
        assertEq(vault.totalCollateralCredits(), 7_000 * USDC_UNIT);
    }

    function test_debitCollateral_revertsInsufficientBalance() public {
        vm.prank(operator);
        vault.creditCollateral(alice, 5_000 * USDC_UNIT);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PerpVault.InsufficientBalance.selector, 10_000 * USDC_UNIT, 5_000 * USDC_UNIT));
        vault.debitCollateral(alice, 10_000 * USDC_UNIT);
    }

    function test_healthCheck_withCollateralCredits() public {
        // Deposit real USDC
        vm.prank(alice);
        vault.deposit(10_000 * USDC_UNIT);

        // Credit collateral (no real USDC)
        vm.prank(operator);
        vault.creditCollateral(bob, 5_000 * USDC_UNIT);

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        // Healthy: actual USDC ($10K) >= totalDeposits ($10K)
        // Collateral credits ($5K) are backed by yield tokens, not USDC
        assertTrue(healthy);
        assertEq(actual, 10_000 * USDC_UNIT);
        assertEq(accounted, 10_000 * USDC_UNIT); // only real deposits
    }

    function test_collateralCredits_usableForTrading() public {
        // Credit collateral to alice
        vm.prank(operator);
        vault.creditCollateral(alice, 10_000 * USDC_UNIT);

        // Alice's balance should be usable for internalTransfer (trading)
        vm.prank(operator);
        vault.internalTransfer(alice, bob, 5_000 * USDC_UNIT);

        assertEq(vault.balances(alice), 5_000 * USDC_UNIT);
        assertEq(vault.balances(bob), 5_000 * USDC_UNIT);
    }

    function test_mixedDepositsAndCredits() public {
        // Real USDC deposit
        vm.prank(alice);
        vault.deposit(20_000 * USDC_UNIT);

        // Collateral credit
        vm.prank(operator);
        vault.creditCollateral(alice, 15_000 * USDC_UNIT);

        // Alice has $35,000 total balance
        assertEq(vault.balances(alice), 35_000 * USDC_UNIT);
        assertEq(vault.totalDeposits(), 20_000 * USDC_UNIT);
        assertEq(vault.totalCollateralCredits(), 15_000 * USDC_UNIT);
    }
}
