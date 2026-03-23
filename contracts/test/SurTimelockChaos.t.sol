// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/SurTimelock.sol";

/// @title SurTimelock Chaos Tests
/// @notice Attack vectors: premature execution, expired execution, unauthorized queue,
///         guardian overreach, setup bypass, delay manipulation

/// @dev Mock pausable contract for testing
contract MockPausable {
    bool public paused;
    address public owner;

    constructor() { owner = msg.sender; }

    function pause() external { paused = true; }
    function unpause() external { paused = false; }
    function setOwner(address _owner) external { owner = _owner; }
}

contract SurTimelockChaosTest is Test {
    SurTimelock public timelock;
    MockPausable public target;

    address public multisig = makeAddr("multisig");
    address public guardian = makeAddr("guardian");
    address public attacker = makeAddr("attacker");

    uint256 constant DELAY = 48 hours;

    function setUp() public {
        vm.warp(1700000000);
        timelock = new SurTimelock(multisig, guardian, DELAY);
        target = new MockPausable();

        // Register target as pausable
        address[] memory targets = new address[](1);
        targets[0] = address(target);
        vm.prank(multisig);
        timelock.batchSetPausableTargets(targets);
    }

    // ================================================================
    //  TEST 1: Guardian emergency pause works
    // ================================================================
    function test_tl_guardianEmergencyPause() public {
        emit log_string("=== TL: Guardian emergency pause ===");

        vm.prank(guardian);
        timelock.emergencyPause(address(target));
        assertTrue(target.paused(), "Target should be paused");

        emit log_string("  [OK] Guardian can emergency pause");
    }

    // ================================================================
    //  TEST 2: Guardian cannot pause unregistered target
    // ================================================================
    function test_tl_guardianInvalidTarget() public {
        emit log_string("=== TL: Guardian invalid target ===");

        MockPausable unregistered = new MockPausable();

        vm.prank(guardian);
        vm.expectRevert(SurTimelock.InvalidPauseTarget.selector);
        timelock.emergencyPause(address(unregistered));

        emit log_string("  [OK] Guardian blocked on unregistered target");
    }

    // ================================================================
    //  TEST 3: Non-owner cannot queue transactions
    // ================================================================
    function test_tl_nonOwnerCannotQueue() public {
        emit log_string("=== TL: Non-owner cannot queue ===");

        vm.prank(attacker);
        vm.expectRevert(SurTimelock.NotOwner.selector);
        timelock.queueTransaction(address(target), 0, abi.encodeWithSignature("unpause()"));

        emit log_string("  [OK] Non-owner blocked from queuing");
    }

    // ================================================================
    //  TEST 4: Premature execution blocked
    // ================================================================
    function test_tl_prematureExecutionBlocked() public {
        emit log_string("=== TL: Premature execution blocked ===");

        bytes memory data = abi.encodeWithSignature("unpause()");
        uint256 eta = block.timestamp + DELAY;

        vm.prank(multisig);
        timelock.queueTransaction(address(target), 0, data);

        // Try to execute immediately
        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(
            SurTimelock.TxNotReady.selector, eta, block.timestamp
        ));
        timelock.executeTransaction(address(target), 0, data, eta);

        emit log_string("  [OK] Premature execution blocked");
    }

    // ================================================================
    //  TEST 5: Execution after delay succeeds
    // ================================================================
    function test_tl_executionAfterDelay() public {
        emit log_string("=== TL: Execution after delay succeeds ===");

        // Pause target first
        target.pause();
        assertTrue(target.paused());

        bytes memory data = abi.encodeWithSignature("unpause()");
        uint256 eta = block.timestamp + DELAY;

        vm.prank(multisig);
        timelock.queueTransaction(address(target), 0, data);

        // Wait for delay
        vm.warp(eta);

        vm.prank(multisig);
        timelock.executeTransaction(address(target), 0, data, eta);

        assertFalse(target.paused(), "Target should be unpaused");
        emit log_string("  [OK] Execution succeeds after delay");
    }

    // ================================================================
    //  TEST 6: Expired transaction rejected
    // ================================================================
    function test_tl_expiredTxRejected() public {
        emit log_string("=== TL: Expired transaction rejected ===");

        bytes memory data = abi.encodeWithSignature("unpause()");
        uint256 eta = block.timestamp + DELAY;

        vm.prank(multisig);
        timelock.queueTransaction(address(target), 0, data);

        // Wait past grace period (7 days)
        vm.warp(eta + 7 days + 1);

        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(
            SurTimelock.TxExpired.selector, eta + 7 days
        ));
        timelock.executeTransaction(address(target), 0, data, eta);

        emit log_string("  [OK] Expired transaction rejected");
    }

    // ================================================================
    //  TEST 7: Double execution prevented
    // ================================================================
    function test_tl_doubleExecutionPrevented() public {
        emit log_string("=== TL: Double execution prevented ===");

        target.pause();
        bytes memory data = abi.encodeWithSignature("unpause()");
        uint256 eta = block.timestamp + DELAY;

        vm.prank(multisig);
        timelock.queueTransaction(address(target), 0, data);

        vm.warp(eta);

        // First execution
        vm.prank(multisig);
        timelock.executeTransaction(address(target), 0, data, eta);

        // Second execution
        vm.prank(multisig);
        vm.expectRevert(SurTimelock.TxNotQueued.selector);
        timelock.executeTransaction(address(target), 0, data, eta);

        emit log_string("  [OK] Double execution prevented");
    }

    // ================================================================
    //  TEST 8: Cancel queued transaction
    // ================================================================
    function test_tl_cancelTransaction() public {
        emit log_string("=== TL: Cancel queued transaction ===");

        bytes memory data = abi.encodeWithSignature("unpause()");
        uint256 eta = block.timestamp + DELAY;

        vm.prank(multisig);
        timelock.queueTransaction(address(target), 0, data);

        // Cancel
        vm.prank(multisig);
        timelock.cancelTransaction(address(target), 0, data, eta);

        // Try to execute - should fail
        vm.warp(eta);
        vm.prank(multisig);
        vm.expectRevert(SurTimelock.TxNotQueued.selector);
        timelock.executeTransaction(address(target), 0, data, eta);

        emit log_string("  [OK] Cancelled transaction cannot be executed");
    }

    // ================================================================
    //  TEST 9: Setup completion blocks further batch registration
    // ================================================================
    function test_tl_setupCompletionLocks() public {
        emit log_string("=== TL: Setup completion locks batch registration ===");

        vm.prank(multisig);
        timelock.completeSetup();

        address[] memory targets = new address[](1);
        targets[0] = makeAddr("newTarget");

        vm.prank(multisig);
        vm.expectRevert(SurTimelock.SetupAlreadyComplete.selector);
        timelock.batchSetPausableTargets(targets);

        emit log_string("  [OK] Setup completion permanently locks batch registration");
    }

    // ================================================================
    //  TEST 10: Delay bounds enforced on construction
    // ================================================================
    function test_tl_delayBoundsEnforced() public {
        emit log_string("=== TL: Delay bounds enforced ===");

        // Too short (< 24h)
        vm.expectRevert(abi.encodeWithSelector(
            SurTimelock.DelayTooShort.selector, 1 hours, 24 hours
        ));
        new SurTimelock(multisig, guardian, 1 hours);

        // Too long (> 30 days)
        vm.expectRevert(abi.encodeWithSelector(
            SurTimelock.DelayTooLong.selector, 31 days, 30 days
        ));
        new SurTimelock(multisig, guardian, 31 days);

        emit log_string("  [OK] Delay bounds enforced");
    }

    // ================================================================
    //  TEST 11: Self-governing functions require self-call
    // ================================================================
    function test_tl_selfGoverningRequiresSelfCall() public {
        emit log_string("=== TL: Self-governing functions require self-call ===");

        // Direct calls should fail
        vm.prank(multisig);
        vm.expectRevert(SurTimelock.NotOwner.selector);
        timelock.setDelay(48 hours);

        vm.prank(multisig);
        vm.expectRevert(SurTimelock.NotOwner.selector);
        timelock.transferOwnership(attacker);

        vm.prank(multisig);
        vm.expectRevert(SurTimelock.NotOwner.selector);
        timelock.setGuardian(attacker);

        emit log_string("  [OK] Self-governing functions only callable via timelock");
    }

    // ================================================================
    //  TEST 12: Guardian cannot call non-pause functions
    // ================================================================
    function test_tl_guardianLimitedToPause() public {
        emit log_string("=== TL: Guardian limited to pause only ===");

        // Guardian cannot queue
        vm.prank(guardian);
        vm.expectRevert(SurTimelock.NotOwner.selector);
        timelock.queueTransaction(address(target), 0, abi.encodeWithSignature("unpause()"));

        // Guardian cannot cancel
        vm.prank(guardian);
        vm.expectRevert(SurTimelock.NotOwner.selector);
        timelock.cancelTransaction(address(target), 0, "", 0);

        emit log_string("  [OK] Guardian strictly limited to emergencyPause");
    }
}
