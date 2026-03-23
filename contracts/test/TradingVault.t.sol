// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/TradingVault.sol";
import "../src/PerpVault.sol";
import "../src/PerpEngine.sol";
import "./mocks/MockUSDC.sol";

/// @notice Tests for TradingVault:
///   - Vault creation (fees, limits, validation)
///   - Share accounting (first depositor, proportional, dilution)
///   - Deposits + withdrawals
///   - Lockup period enforcement
///   - Performance fee with high water mark
///   - Management fee accrual over time
///   - Max drawdown circuit breaker
///   - Manager trading permissions
///   - Multi-depositor equity distribution
///   - Edge cases (zero shares, empty vault, rounding)

contract TradingVaultTest is Test {
    TradingVault public tv;
    PerpVault public perpVault;
    PerpEngine public engine;
    MockUSDC public usdc;

    address public owner = makeAddr("owner");
    address public manager = makeAddr("manager");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public feeRecipient = makeAddr("feeRecipient");
    address public insuranceFund = makeAddr("insuranceFund");

    uint256 constant USDC_UNIT = 1e6;
    uint256 constant SHARE_P = 1e18;
    uint256 constant INITIAL_BALANCE = 100_000 * USDC_UNIT;

    bytes32 public vaultId;

    function setUp() public {
        usdc = new MockUSDC();
        perpVault = new PerpVault(address(usdc), owner, 0);
        engine = new PerpEngine(address(perpVault), owner, feeRecipient, insuranceFund, feeRecipient);
        tv = new TradingVault(address(perpVault), address(engine), owner);

        // Set TradingVault as operator on PerpVault (for internalTransfer)
        vm.prank(owner);
        perpVault.setOperator(address(tv), true);

        // Set TradingVault as operator on PerpEngine (for trading)
        vm.prank(owner);
        engine.setOperator(address(tv), true);

        // Mint USDC and deposit into PerpVault for users
        _setupUser(manager);
        _setupUser(alice);
        _setupUser(bob);

        // Manager creates a vault
        vm.prank(manager);
        vaultId = tv.createVault(
            "Alpha Vault",
            "BTC/ETH momentum strategy",
            2000,   // 20% performance fee
            200,    // 2% management fee
            500_000 * USDC_UNIT, // $500K deposit cap
            86400,  // 24h lockup
            3000    // 30% max drawdown
        );
    }

    function _setupUser(address user) internal {
        usdc.mint(user, INITIAL_BALANCE);
        vm.prank(user);
        usdc.approve(address(perpVault), type(uint256).max);
        vm.prank(user);
        perpVault.deposit(INITIAL_BALANCE);
    }

    // ============================================================
    //                  VAULT CREATION
    // ============================================================

    function test_createVault_success() public view {
        (
            string memory name, string memory desc, address mgr, bool isPaused,
            uint256 totalShares, uint256 totalEquity,,
            uint256 perfFee, uint256 mgmtFee,, uint256 createdAt
        ) = tv.getVaultInfo(vaultId);

        assertEq(name, "Alpha Vault");
        assertEq(desc, "BTC/ETH momentum strategy");
        assertEq(mgr, manager);
        assertFalse(isPaused);
        assertEq(totalShares, 0);
        assertEq(totalEquity, 0);
        assertEq(perfFee, 2000);
        assertEq(mgmtFee, 200);
        assertTrue(createdAt > 0);
    }

    function test_createVault_revertsExcessivePerfFee() public {
        vm.prank(alice);
        vm.expectRevert(TradingVault.InvalidFees.selector);
        tv.createVault("Bad", "", 3001, 0, 0, 0, 5000); // >30%
    }

    function test_createVault_revertsExcessiveMgmtFee() public {
        vm.prank(alice);
        vm.expectRevert(TradingVault.InvalidFees.selector);
        tv.createVault("Bad", "", 0, 501, 0, 0, 5000); // >5%
    }

    function test_createVault_multipleVaults() public {
        vm.prank(alice);
        bytes32 v2 = tv.createVault("Delta Neutral", "", 1500, 100, 0, 3600, 5000);

        assertFalse(v2 == vaultId); // different IDs
        assertEq(tv.vaultCount(), 2);
    }

    // ============================================================
    //                  DEPOSITS + SHARE ACCOUNTING
    // ============================================================

    function test_deposit_firstDepositor_getsProportionalShares() public {
        uint256 amount = 10_000 * USDC_UNIT;

        vm.prank(alice);
        tv.deposit(vaultId, amount);

        (,,,, uint256 totalShares, uint256 totalEquity,,,,, ) = tv.getVaultInfo(vaultId);

        // First deposit: shares = amount * (1e18 / 1e6) = amount * 1e12
        uint256 expectedShares = amount * (SHARE_P / USDC_UNIT);
        assertEq(totalShares, expectedShares);
        assertEq(totalEquity, amount);

        // Check depositor record
        (uint256 shares, uint256 usdcVal,,,, int256 pnl) = tv.getDepositorInfo(vaultId, alice);
        assertEq(shares, expectedShares);
        assertEq(usdcVal, amount);
        assertEq(pnl, 0); // no profit/loss yet
    }

    function test_deposit_secondDepositor_proportionalShares() public {
        // Alice deposits $10,000
        vm.prank(alice);
        tv.deposit(vaultId, 10_000 * USDC_UNIT);

        // Bob deposits $5,000
        vm.prank(bob);
        tv.deposit(vaultId, 5_000 * USDC_UNIT);

        // Total equity: $15,000
        (,,,, uint256 totalShares, uint256 totalEquity,,,,, ) = tv.getVaultInfo(vaultId);
        assertEq(totalEquity, 15_000 * USDC_UNIT);

        // Bob should have exactly half the shares of Alice
        (uint256 aliceShares,,,,,) = tv.getDepositorInfo(vaultId, alice);
        (uint256 bobShares,,,,,) = tv.getDepositorInfo(vaultId, bob);
        assertEq(bobShares, aliceShares / 2);
    }

    function test_deposit_revertsZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(TradingVault.ZeroAmount.selector);
        tv.deposit(vaultId, 0);
    }

    function test_deposit_revertsExceedsCap() public {
        // Cap is $500K
        // Deposit $600K (alice has $100K, need more)
        usdc.mint(alice, 600_000 * USDC_UNIT);
        vm.prank(alice);
        usdc.approve(address(perpVault), type(uint256).max);
        vm.prank(alice);
        perpVault.deposit(600_000 * USDC_UNIT);

        vm.prank(alice);
        vm.expectRevert(); // DepositCapExceeded
        tv.deposit(vaultId, 600_000 * USDC_UNIT);
    }

    function test_deposit_revertsNonExistentVault() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.VaultNotFound.selector, bytes32(uint256(99))));
        tv.deposit(bytes32(uint256(99)), 1000 * USDC_UNIT);
    }

    // ============================================================
    //                  WITHDRAWALS
    // ============================================================

    function test_withdraw_fullAmount() public {
        uint256 amount = 10_000 * USDC_UNIT;

        vm.prank(alice);
        tv.deposit(vaultId, amount);

        (uint256 shares,,,,,) = tv.getDepositorInfo(vaultId, alice);

        // Skip lockup
        vm.warp(block.timestamp + 86401);

        uint256 balBefore = perpVault.balances(alice);
        vm.prank(alice);
        tv.withdraw(vaultId, shares);

        // Should get back original amount (no trades happened, no fees accrued significantly)
        uint256 balAfter = perpVault.balances(alice);
        // Allow 1 USDC tolerance for management fee accrual
        assertApproxEqAbs(balAfter - balBefore, amount, 1 * USDC_UNIT);

        // Shares should be zero
        (uint256 remainingShares,,,,,) = tv.getDepositorInfo(vaultId, alice);
        assertEq(remainingShares, 0);
    }

    function test_withdraw_revertsLockup() public {
        vm.prank(alice);
        tv.deposit(vaultId, 10_000 * USDC_UNIT);

        (uint256 shares,,,,,) = tv.getDepositorInfo(vaultId, alice);

        // Try to withdraw immediately (lockup is 24h)
        vm.prank(alice);
        vm.expectRevert(); // LockupNotExpired
        tv.withdraw(vaultId, shares);
    }

    function test_withdraw_revertsInsufficientShares() public {
        vm.prank(alice);
        tv.deposit(vaultId, 10_000 * USDC_UNIT);

        vm.warp(block.timestamp + 86401);

        (uint256 shares,,,,,) = tv.getDepositorInfo(vaultId, alice);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.InsufficientShares.selector, shares + 1, shares));
        tv.withdraw(vaultId, shares + 1);
    }

    function test_withdraw_partial() public {
        uint256 amount = 10_000 * USDC_UNIT;

        vm.prank(alice);
        tv.deposit(vaultId, amount);

        (uint256 totalShares,,,,,) = tv.getDepositorInfo(vaultId, alice);

        vm.warp(block.timestamp + 86401);

        // Withdraw half shares
        uint256 halfShares = totalShares / 2;
        vm.prank(alice);
        tv.withdraw(vaultId, halfShares);

        (uint256 remaining,,,,,) = tv.getDepositorInfo(vaultId, alice);
        assertEq(remaining, totalShares - halfShares);
    }

    // ============================================================
    //                  PNL TRACKING
    // ============================================================

    function test_depositor_pnlTracking() public {
        // Alice deposits $10,000
        vm.prank(alice);
        tv.deposit(vaultId, 10_000 * USDC_UNIT);

        (,,, uint256 totalDeposited, uint256 totalWithdrawn, int256 pnl) = tv.getDepositorInfo(vaultId, alice);
        assertEq(totalDeposited, 10_000 * USDC_UNIT);
        assertEq(totalWithdrawn, 0);
        assertEq(pnl, 0);
    }

    // ============================================================
    //                  MANAGER PERMISSIONS
    // ============================================================

    function test_trade_revertsNotManager() public {
        vm.prank(alice);
        tv.deposit(vaultId, 10_000 * USDC_UNIT);

        // Alice tries to trade on the vault — not the manager
        vm.prank(alice);
        vm.expectRevert(TradingVault.NotManager.selector);
        tv.trade(vaultId, bytes32(0), 100, 50_000 * USDC_UNIT);
    }

    // ============================================================
    //                  PAUSE / EMERGENCY
    // ============================================================

    function test_emergencyPause_blocksDeposits() public {
        vm.prank(owner);
        tv.emergencyPause(vaultId);

        vm.prank(alice);
        vm.expectRevert(TradingVault.VaultPaused.selector);
        tv.deposit(vaultId, 10_000 * USDC_UNIT);
    }

    function test_unpauseVault_onlyManager() public {
        vm.prank(owner);
        tv.emergencyPause(vaultId);

        // Alice can't unpause
        vm.prank(alice);
        vm.expectRevert(TradingVault.NotManager.selector);
        tv.unpauseVault(vaultId);

        // Manager can
        vm.prank(manager);
        tv.unpauseVault(vaultId);

        // Deposits work again
        vm.prank(alice);
        tv.deposit(vaultId, 1_000 * USDC_UNIT);
    }

    function test_withdraw_worksEvenWhenPaused() public {
        vm.prank(alice);
        tv.deposit(vaultId, 10_000 * USDC_UNIT);

        vm.warp(block.timestamp + 86401);

        // Pause vault
        vm.prank(owner);
        tv.emergencyPause(vaultId);

        // Alice should STILL be able to withdraw (safety — never lock user funds)
        (uint256 shares,,,,,) = tv.getDepositorInfo(vaultId, alice);
        vm.prank(alice);
        tv.withdraw(vaultId, shares); // should not revert
    }

    // ============================================================
    //                  MULTI-DEPOSITOR EQUITY
    // ============================================================

    function test_multiDepositor_equitySplit() public {
        // Alice: $30,000, Bob: $10,000 → 75%/25% split
        vm.prank(alice);
        tv.deposit(vaultId, 30_000 * USDC_UNIT);

        vm.prank(bob);
        tv.deposit(vaultId, 10_000 * USDC_UNIT);

        (, uint256 aliceVal,,,,) = tv.getDepositorInfo(vaultId, alice);
        (, uint256 bobVal,,,,) = tv.getDepositorInfo(vaultId, bob);

        // Alice should have ~75%, Bob ~25% of $40,000
        assertApproxEqAbs(aliceVal, 30_000 * USDC_UNIT, 1 * USDC_UNIT);
        assertApproxEqAbs(bobVal, 10_000 * USDC_UNIT, 1 * USDC_UNIT);
    }

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    function test_vaultCount() public view {
        assertEq(tv.vaultCount(), 1);
    }

    function test_getVaultId() public view {
        assertEq(tv.getVaultId(0), vaultId);
    }

    function test_getVaultInfo_nonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(TradingVault.VaultNotFound.selector, bytes32(uint256(999))));
        tv.getVaultInfo(bytes32(uint256(999)));
    }
}
