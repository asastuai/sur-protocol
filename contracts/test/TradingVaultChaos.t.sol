// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/TradingVault.sol";
import "../src/PerpEngine.sol";
import "../src/PerpVault.sol";
import "../src/InsuranceFund.sol";
import "./mocks/MockUSDC.sol";

/// @title TradingVault Chaos Tests
/// @notice Attack vectors: share inflation, first depositor frontrun, fee drain,
///         lockup bypass, drawdown manipulation, deposit cap bypass

contract TradingVaultChaosTest is Test {
    MockUSDC public usdc;
    PerpVault public vault;
    PerpEngine public engine;
    InsuranceFund public insurance;
    TradingVault public tradingVault;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("treasury");
    address public manager = makeAddr("manager");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    uint256 constant U = 1e6;
    uint256 constant S = 1e8;
    bytes32 public btcMkt;

    function setUp() public {
        vm.warp(1700000000);

        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, type(uint256).max);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);

        btcMkt = keccak256(abi.encodePacked("BTC-USD"));

        tradingVault = new TradingVault(address(vault), address(engine), owner);

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        vault.setOperator(address(tradingVault), true);
        engine.setOperator(address(tradingVault), true);
        engine.setOperator(owner, true);
        engine.setOiSkewCap(10000);
        engine.setMaxExposureBps(0);
        engine.addMarket("BTC-USD", 500, 250, 1_000_000 * S, 28800);
        engine.updateMarkPrice(btcMkt, 50_000 * U, 50_000 * U);
        vm.stopPrank();

        // Fund participants
        _fundTrader(manager, 500_000 * U);
        _fundTrader(alice, 500_000 * U);
        _fundTrader(bob, 500_000 * U);
    }

    function _fundTrader(address trader, uint256 amount) internal {
        usdc.mint(trader, amount);
        vm.startPrank(trader);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function _createVault() internal returns (bytes32 vaultId) {
        vm.prank(manager);
        vaultId = tradingVault.createVault("TestVault", "Testing", 2000, 200, 0, 86400, 3000);
    }

    // ================================================================
    //  TEST 1: Minimum first deposit prevents share inflation attack
    // ================================================================
    function test_tv_minFirstDeposit() public {
        emit log_string("=== TV: Min first deposit prevents inflation attack ===");

        bytes32 vid = _createVault();

        // Try to deposit $1 (below $1000 minimum first deposit)
        vm.prank(alice);
        vm.expectRevert("Min first deposit $1000");
        tradingVault.deposit(vid, 1 * U);

        // $1000 works
        vm.prank(alice);
        tradingVault.deposit(vid, 1000 * U);

        emit log_string("  [OK] Share inflation attack mitigated by min first deposit");
    }

    // ================================================================
    //  TEST 2: Lockup period enforcement
    // ================================================================
    function test_tv_lockupEnforcement() public {
        emit log_string("=== TV: Lockup period enforcement ===");

        bytes32 vid = _createVault();

        vm.prank(alice);
        tradingVault.deposit(vid, 10_000 * U);

        // Try immediate withdrawal
        (uint256 shares,,,,, ) = tradingVault.getDepositorInfo(vid, alice);

        vm.prank(alice);
        vm.expectRevert(); // LockupNotExpired
        tradingVault.withdraw(vid, shares);

        // Advance past lockup (86400s)
        vm.warp(block.timestamp + 86401);

        vm.prank(alice);
        tradingVault.withdraw(vid, shares);

        emit log_string("  [OK] Lockup period enforced");
    }

    // ================================================================
    //  TEST 3: Non-manager cannot trade
    // ================================================================
    function test_tv_nonManagerCannotTrade() public {
        emit log_string("=== TV: Non-manager cannot trade ===");

        bytes32 vid = _createVault();

        vm.prank(alice);
        tradingVault.deposit(vid, 10_000 * U);

        // Alice tries to trade
        vm.prank(alice);
        vm.expectRevert(TradingVault.NotManager.selector);
        tradingVault.trade(vid, btcMkt, int256(S / 10), 50_000 * U);

        emit log_string("  [OK] Non-manager cannot trade");
    }

    // ================================================================
    //  TEST 4: Zero amount operations
    // ================================================================
    function test_tv_zeroAmountOperations() public {
        emit log_string("=== TV: Zero amount operations ===");

        bytes32 vid = _createVault();

        vm.prank(alice);
        vm.expectRevert(TradingVault.ZeroAmount.selector);
        tradingVault.deposit(vid, 0);

        vm.prank(alice);
        vm.expectRevert(TradingVault.ZeroAmount.selector);
        tradingVault.withdraw(vid, 0);

        emit log_string("  [OK] Zero amounts rejected");
    }

    // ================================================================
    //  TEST 5: Invalid fee parameters on vault creation
    // ================================================================
    function test_tv_invalidFees() public {
        emit log_string("=== TV: Invalid fee parameters ===");

        // Performance fee > 30%
        vm.prank(manager);
        vm.expectRevert(TradingVault.InvalidFees.selector);
        tradingVault.createVault("Bad", "Bad", 3001, 200, 0, 86400, 3000);

        // Management fee > 5%
        vm.prank(manager);
        vm.expectRevert(TradingVault.InvalidFees.selector);
        tradingVault.createVault("Bad", "Bad", 2000, 501, 0, 86400, 3000);

        emit log_string("  [OK] Invalid fees rejected");
    }

    // ================================================================
    //  TEST 6: Deposit cap enforcement
    // ================================================================
    function test_tv_depositCapEnforcement() public {
        emit log_string("=== TV: Deposit cap enforcement ===");

        vm.prank(manager);
        bytes32 vid = tradingVault.createVault("Capped", "Cap", 2000, 200, 50_000 * U, 86400, 3000);

        // First deposit OK
        vm.prank(alice);
        tradingVault.deposit(vid, 40_000 * U);

        // Second exceeds cap
        vm.prank(bob);
        vm.expectRevert(); // DepositCapExceeded
        tradingVault.deposit(vid, 20_000 * U);

        emit log_string("  [OK] Deposit cap enforced");
    }

    // ================================================================
    //  TEST 7: Vault not found
    // ================================================================
    function test_tv_vaultNotFound() public {
        emit log_string("=== TV: Vault not found ===");

        bytes32 fakeId = keccak256("nonexistent");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.VaultNotFound.selector, fakeId));
        tradingVault.deposit(fakeId, 1000 * U);

        emit log_string("  [OK] Nonexistent vault rejected");
    }

    // ================================================================
    //  TEST 8: Withdraw more shares than owned
    // ================================================================
    function test_tv_withdrawExcessShares() public {
        emit log_string("=== TV: Withdraw excess shares ===");

        bytes32 vid = _createVault();

        vm.prank(alice);
        tradingVault.deposit(vid, 10_000 * U);

        (uint256 shares,,,,, ) = tradingVault.getDepositorInfo(vid, alice);

        vm.warp(block.timestamp + 86401);

        vm.prank(alice);
        vm.expectRevert(); // InsufficientShares
        tradingVault.withdraw(vid, shares + 1);

        emit log_string("  [OK] Cannot withdraw more shares than owned");
    }

    // ================================================================
    //  TEST 9: Management fee accrual over time
    // ================================================================
    function test_tv_managementFeeAccrual() public {
        emit log_string("=== TV: Management fee accrual ===");

        bytes32 vid = _createVault();

        vm.prank(alice);
        tradingVault.deposit(vid, 100_000 * U);

        uint256 managerBalBefore = vault.balances(manager);

        // Advance 1 year
        vm.warp(block.timestamp + 365.25 days);

        // Trigger fee accrual via a deposit
        vm.prank(bob);
        tradingVault.deposit(vid, 1000 * U);

        uint256 managerBalAfter = vault.balances(manager);
        uint256 feeCollected = managerBalAfter - managerBalBefore;

        emit log_named_uint("  Fee collected (should be ~2% of 100k = ~2000)", feeCollected);

        // 2% of $100k = $2000, allow some tolerance for precision
        assertTrue(feeCollected > 1900 * U && feeCollected < 2100 * U, "Fee should be ~$2000");
        emit log_string("  [OK] Management fee accrued correctly over 1 year");
    }

    // ================================================================
    //  TEST 10: Emergency pause by owner
    // ================================================================
    function test_tv_emergencyPause() public {
        emit log_string("=== TV: Emergency pause ===");

        bytes32 vid = _createVault();

        vm.prank(owner);
        tradingVault.emergencyPause(vid);

        vm.prank(alice);
        vm.expectRevert(TradingVault.VaultPaused.selector);
        tradingVault.deposit(vid, 10_000 * U);

        emit log_string("  [OK] Emergency pause blocks deposits");
    }
}
