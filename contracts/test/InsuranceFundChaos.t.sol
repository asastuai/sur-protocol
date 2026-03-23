// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/InsuranceFund.sol";
import "../src/PerpVault.sol";
import "./mocks/MockUSDC.sol";

/// @title InsuranceFund Chaos Tests
/// @notice Attack vectors: keeper reward drain, daily cap bypass, bad debt duplication,
///         pause bypass, balance drain, timestamp manipulation

contract InsuranceFundChaosTest is Test {
    MockUSDC public usdc;
    PerpVault public vault;
    InsuranceFund public insurance;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public keeper = makeAddr("keeper");
    address public alice = makeAddr("alice");

    uint256 constant U = 1e6;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, type(uint256).max);
        insurance = new InsuranceFund(address(vault), owner);

        vm.startPrank(owner);
        vault.setOperator(address(insurance), true);
        insurance.setOperator(operator, true);
        vm.stopPrank();

        // Fund insurance: deposit 1M USDC into vault, transfer to insurance
        usdc.mint(address(this), 1_000_000 * U);
        usdc.approve(address(vault), 1_000_000 * U);
        vault.deposit(1_000_000 * U);
        vm.prank(owner);
        vault.setOperator(address(this), true);
        vault.internalTransfer(address(this), address(insurance), 1_000_000 * U);
    }

    // ================================================================
    //  TEST 1: Per-call keeper reward cap
    // ================================================================
    function test_if_perCallRewardCap() public {
        emit log_string("=== IF: Per-call keeper reward cap ===");

        // Default cap is $1000
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(
            InsuranceFund.KeeperRewardExceedsPerCallCap.selector,
            1500 * U,
            1000 * U
        ));
        insurance.payKeeperReward(keeper, 1500 * U);

        // Within cap works
        vm.prank(operator);
        insurance.payKeeperReward(keeper, 500 * U);

        emit log_string("  [OK] Per-call cap enforced");
    }

    // ================================================================
    //  TEST 2: Daily cumulative reward cap
    // ================================================================
    function test_if_dailyRewardCap() public {
        emit log_string("=== IF: Daily cumulative reward cap ===");

        // Default daily cap is $10,000
        // Pay 10 x $1000 to hit the cap
        vm.startPrank(operator);
        for (uint256 i = 0; i < 10; i++) {
            insurance.payKeeperReward(keeper, 1000 * U);
        }

        // 11th should exceed daily cap
        vm.expectRevert(abi.encodeWithSelector(
            InsuranceFund.DailyKeeperRewardCapExceeded.selector,
            11_000 * U,
            10_000 * U
        ));
        insurance.payKeeperReward(keeper, 1000 * U);
        vm.stopPrank();

        emit log_string("  [OK] Daily reward cap enforced");
    }

    // ================================================================
    //  TEST 3: Daily cap reset after 24h
    // ================================================================
    function test_if_dailyCapReset() public {
        emit log_string("=== IF: Daily cap resets after 24h ===");

        // Hit the daily cap
        vm.startPrank(operator);
        for (uint256 i = 0; i < 10; i++) {
            insurance.payKeeperReward(keeper, 1000 * U);
        }

        // Should fail
        vm.expectRevert();
        insurance.payKeeperReward(keeper, 1000 * U);

        // Advance 24h+1
        vm.warp(block.timestamp + 1 days + 1);

        // Should work now
        insurance.payKeeperReward(keeper, 1000 * U);
        vm.stopPrank();

        assertEq(insurance.dailyKeeperRewardsPaid(), 1000 * U, "Daily counter should reset");
        emit log_string("  [OK] Daily cap resets after 24h");
    }

    // ================================================================
    //  TEST 4: Bad debt deduplication
    // ================================================================
    function test_if_badDebtDeduplication() public {
        emit log_string("=== IF: Bad debt deduplication ===");

        bytes32 mkt = keccak256(abi.encodePacked("BTC-USD"));

        vm.startPrank(operator);
        // First recording succeeds
        insurance.recordBadDebt(mkt, alice, 5000 * U);

        // Same params in same block should be duplicate
        vm.expectRevert("Duplicate bad debt");
        insurance.recordBadDebt(mkt, alice, 5000 * U);
        vm.stopPrank();

        assertEq(insurance.totalBadDebt(), 5000 * U, "Bad debt should be 5000");
        emit log_string("  [OK] Duplicate bad debt rejected in same block");
    }

    // ================================================================
    //  TEST 5: Bad debt different blocks not duplicate
    // ================================================================
    function test_if_badDebtDifferentBlocks() public {
        emit log_string("=== IF: Bad debt in different blocks OK ===");

        bytes32 mkt = keccak256(abi.encodePacked("BTC-USD"));

        vm.prank(operator);
        insurance.recordBadDebt(mkt, alice, 5000 * U);

        // Advance 1 block
        vm.roll(block.number + 1);

        // Same params different block should succeed (different hash due to block.number)
        vm.prank(operator);
        insurance.recordBadDebt(mkt, alice, 5000 * U);

        assertEq(insurance.totalBadDebt(), 10_000 * U, "Both bad debts should count");
        emit log_string("  [OK] Different block bad debts recorded separately");
    }

    // ================================================================
    //  TEST 6: Drain via keeper reward exceeding balance
    // ================================================================
    function test_if_rewardExceedsBalance() public {
        emit log_string("=== IF: Reward exceeding balance reverts ===");

        // Set high per-call cap
        vm.prank(owner);
        insurance.setMaxKeeperRewardPerCall(2_000_000 * U);

        // Set high daily cap
        vm.prank(owner);
        insurance.setMaxDailyKeeperRewards(2_000_000 * U);

        // Try to pay more than insurance balance
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(
            InsuranceFund.InsufficientFundBalance.selector,
            1_500_000 * U,
            1_000_000 * U
        ));
        insurance.payKeeperReward(keeper, 1_500_000 * U);

        emit log_string("  [OK] Cannot drain more than balance");
    }

    // ================================================================
    //  TEST 7: Non-operator cannot record bad debt
    // ================================================================
    function test_if_nonOperatorBlocked() public {
        emit log_string("=== IF: Non-operator access control ===");

        bytes32 mkt = keccak256(abi.encodePacked("BTC-USD"));

        vm.expectRevert(InsuranceFund.NotOperator.selector);
        vm.prank(alice);
        insurance.recordBadDebt(mkt, alice, 5000 * U);

        vm.expectRevert(InsuranceFund.NotOperator.selector);
        vm.prank(alice);
        insurance.payKeeperReward(keeper, 100 * U);

        emit log_string("  [OK] Non-operator calls rejected");
    }

    // ================================================================
    //  TEST 8: Paused fund blocks operations
    // ================================================================
    function test_if_pausedOperations() public {
        emit log_string("=== IF: Paused fund blocks operations ===");

        vm.prank(owner);
        insurance.pause();

        bytes32 mkt = keccak256(abi.encodePacked("BTC-USD"));

        vm.prank(operator);
        vm.expectRevert(InsuranceFund.InsuranceFundPaused.selector);
        insurance.recordBadDebt(mkt, alice, 5000 * U);

        vm.prank(operator);
        vm.expectRevert(InsuranceFund.InsuranceFundPaused.selector);
        insurance.payKeeperReward(keeper, 100 * U);

        emit log_string("  [OK] Paused fund blocks all operator operations");
    }

    // ================================================================
    //  TEST 9: Zero amount keeper reward (no-op)
    // ================================================================
    function test_if_zeroAmountReward() public {
        emit log_string("=== IF: Zero amount keeper reward ===");

        uint256 balBefore = insurance.balance();

        // Should return silently (no revert, no transfer)
        vm.prank(operator);
        insurance.payKeeperReward(keeper, 0);

        uint256 balAfter = insurance.balance();
        assertEq(balBefore, balAfter, "Balance unchanged on zero reward");

        emit log_string("  [OK] Zero amount is a no-op");
    }

    // ================================================================
    //  TEST 10: Zero address keeper reward
    // ================================================================
    function test_if_zeroAddressKeeper() public {
        emit log_string("=== IF: Zero address keeper rejected ===");

        vm.prank(operator);
        vm.expectRevert(InsuranceFund.ZeroAddress.selector);
        insurance.payKeeperReward(address(0), 100 * U);

        emit log_string("  [OK] Zero address keeper rejected");
    }

    // ================================================================
    //  TEST 11: Health check view accuracy
    // ================================================================
    function test_if_healthCheckAccuracy() public {
        emit log_string("=== IF: Health check accuracy ===");

        (uint256 bal, uint256 debt, uint256 liqCount) = insurance.healthCheck();
        assertEq(bal, 1_000_000 * U, "Balance should be 1M");
        assertEq(debt, 0, "No bad debt yet");
        assertEq(liqCount, 0, "No liquidations yet");

        // Record some bad debt and pay some rewards
        bytes32 mkt = keccak256(abi.encodePacked("BTC-USD"));
        vm.startPrank(operator);
        insurance.recordBadDebt(mkt, alice, 50_000 * U);
        insurance.payKeeperReward(keeper, 500 * U);
        vm.stopPrank();

        (bal, debt, liqCount) = insurance.healthCheck();
        assertEq(bal, 999_500 * U, "Balance should be 999,500");
        assertEq(debt, 50_000 * U, "Bad debt should be 50k");
        assertEq(liqCount, 1, "1 liquidation recorded");

        emit log_string("  [OK] Health check returns accurate data");
    }

    // ================================================================
    //  TEST 12: Market-specific bad debt tracking
    // ================================================================
    function test_if_marketBadDebtTracking() public {
        emit log_string("=== IF: Market-specific bad debt tracking ===");

        bytes32 btcMkt = keccak256(abi.encodePacked("BTC-USD"));
        bytes32 ethMkt = keccak256(abi.encodePacked("ETH-USD"));

        vm.startPrank(operator);
        insurance.recordBadDebt(btcMkt, alice, 30_000 * U);

        vm.roll(block.number + 1);
        insurance.recordBadDebt(ethMkt, alice, 10_000 * U);
        vm.stopPrank();

        assertEq(insurance.marketBadDebt(btcMkt), 30_000 * U, "BTC bad debt");
        assertEq(insurance.marketBadDebt(ethMkt), 10_000 * U, "ETH bad debt");
        assertEq(insurance.totalBadDebt(), 40_000 * U, "Total bad debt");

        emit log_string("  [OK] Per-market bad debt tracked correctly");
    }
}
