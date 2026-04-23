// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/A2ADarkPool.sol";
import "../src/PerpEngine.sol";
import "../src/PerpVault.sol";
import "../src/InsuranceFund.sol";
import "./mocks/MockUSDC.sol";

/// @title A2ADarkPool Chaos Tests
/// @notice Attack vectors: self-trade, expired intent, response cooldown bypass,
///         reputation manipulation, missing cancelResponse, price range abuse

contract A2ADarkPoolChaosTest is Test {
    MockUSDC public usdc;
    PerpVault public vault;
    PerpEngine public engine;
    InsuranceFund public insurance;
    A2ADarkPool public darkpool;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("treasury");
    address public agentA = makeAddr("agentA");
    address public agentB = makeAddr("agentB");

    uint256 constant U = 1e6;
    uint256 constant S = 1e8;
    bytes32 public btcMkt;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, type(uint256).max);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);

        btcMkt = keccak256(abi.encodePacked("BTC-USD"));

        darkpool = new A2ADarkPool(address(vault), address(engine), feeRecipient, owner);

        // Set realistic timestamp before engine operations
        vm.warp(1700000000);

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        vault.setOperator(address(darkpool), true);
        engine.setOperator(address(darkpool), true);
        engine.setOperator(owner, true);
        engine.setOiSkewCap(10000);
        engine.setMaxExposureBps(0);
        engine.addMarket("BTC-USD", 500, 250, 1_000_000 * S, 28800);
        engine.updateMarkPrice(btcMkt, 50_000 * U, 50_000 * U);
        vm.stopPrank();

        // Fund agents
        _fundTrader(agentA, 500_000 * U);
        _fundTrader(agentB, 500_000 * U);
    }

    function _fundTrader(address trader, uint256 amount) internal {
        usdc.mint(trader, amount);
        vm.startPrank(trader);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    // ================================================================
    //  TEST 1: Self-trade prevention
    // ================================================================
    function test_dp_selfTradeBlocked() public {
        emit log_string("=== DARKPOOL: Self-trade prevention ===");

        // AgentA posts intent
        vm.prank(agentA);
        uint256 intentId = darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);

        // AgentA tries to respond to own intent
        vm.prank(agentA);
        vm.expectRevert(A2ADarkPool.SelfTrade.selector);
        darkpool.postResponse(intentId, 50_000 * U, 3600);

        emit log_string("  [OK] Self-trade blocked on response");
    }

    // ================================================================
    //  TEST 2: Response price out of range
    // ================================================================
    function test_dp_priceOutOfRange() public {
        emit log_string("=== DARKPOOL: Price out of range ===");

        vm.prank(agentA);
        uint256 intentId = darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);

        // Below min
        vm.prank(agentB);
        vm.expectRevert(abi.encodeWithSelector(
            A2ADarkPool.PriceOutOfRange.selector, 48_000 * U, 49_000 * U, 51_000 * U
        ));
        darkpool.postResponse(intentId, 48_000 * U, 3600);

        emit log_string("  [OK] Out-of-range price rejected");
    }

    // ================================================================
    //  TEST 3: Expired intent interaction
    // ================================================================
    function test_dp_expiredIntent() public {
        emit log_string("=== DARKPOOL: Expired intent ===");

        vm.prank(agentA);
        uint256 intentId = darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 60);

        // Advance past expiry
        vm.warp(block.timestamp + 61);

        vm.prank(agentB);
        vm.expectRevert(abi.encodeWithSelector(A2ADarkPool.IntentExpired.selector, intentId));
        darkpool.postResponse(intentId, 50_000 * U, 3600);

        emit log_string("  [OK] Cannot respond to expired intent");
    }

    // ================================================================
    //  TEST 4: Response cooldown enforcement
    // ================================================================
    function test_dp_responseCooldown() public {
        emit log_string("=== DARKPOOL: Response cooldown ===");

        // Post 2 intents
        vm.prank(agentA);
        uint256 id1 = darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);
        vm.prank(agentA);
        uint256 id2 = darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);

        // AgentB responds to first
        vm.prank(agentB);
        darkpool.postResponse(id1, 50_000 * U, 3600);

        // Immediate second response should hit cooldown
        vm.prank(agentB);
        vm.expectRevert(); // CooldownActive
        darkpool.postResponse(id2, 50_000 * U, 3600);

        // Wait cooldown
        vm.warp(block.timestamp + 6);
        vm.prank(agentB);
        darkpool.postResponse(id2, 50_000 * U, 3600);

        emit log_string("  [OK] Response cooldown enforced");
    }

    // ================================================================
    //  TEST 5: Full A2A trade flow - atomic settlement
    // ================================================================
    function test_dp_atomicSettlement() public {
        emit log_string("=== DARKPOOL: Atomic settlement ===");

        // AgentA wants to buy 1 BTC
        vm.prank(agentA);
        uint256 intentId = darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);

        // AgentB responds
        vm.prank(agentB);
        uint256 respId = darkpool.postResponse(intentId, 50_000 * U, 3600);

        // AgentA accepts
        vm.prank(agentA);
        darkpool.acceptAndSettle(intentId, respId);

        // Verify positions
        (int256 sizeA,,,,,) = engine.positions(btcMkt, agentA);
        (int256 sizeB,,,,,) = engine.positions(btcMkt, agentB);
        assertEq(sizeA, int256(1 * S), "AgentA should be long");
        assertEq(sizeB, -int256(1 * S), "AgentB should be short");

        emit log_string("  [OK] Atomic settlement works correctly");
    }

    // ================================================================
    //  TEST 6: Non-creator cannot accept intent
    // ================================================================
    function test_dp_onlyCreatorCanAccept() public {
        emit log_string("=== DARKPOOL: Only creator can accept ===");

        vm.prank(agentA);
        uint256 intentId = darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);

        vm.prank(agentB);
        uint256 respId = darkpool.postResponse(intentId, 50_000 * U, 3600);

        // AgentB tries to accept (not the creator)
        vm.prank(agentB);
        vm.expectRevert(abi.encodeWithSelector(A2ADarkPool.NotIntentCreator.selector, intentId));
        darkpool.acceptAndSettle(intentId, respId);

        emit log_string("  [OK] Only intent creator can accept");
    }

    // ================================================================
    //  TEST 7: Double settlement prevention
    // ================================================================
    function test_dp_doubleSettlement() public {
        emit log_string("=== DARKPOOL: Double settlement prevention ===");

        vm.prank(agentA);
        uint256 intentId = darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);

        vm.prank(agentB);
        uint256 respId = darkpool.postResponse(intentId, 50_000 * U, 3600);

        // First settlement
        vm.prank(agentA);
        darkpool.acceptAndSettle(intentId, respId);

        // Second attempt
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(A2ADarkPool.IntentNotOpen.selector, intentId));
        darkpool.acceptAndSettle(intentId, respId);

        emit log_string("  [OK] Double settlement blocked");
    }

    // ================================================================
    //  TEST 8: Reputation system accuracy
    // ================================================================
    function test_dp_reputationTracking() public {
        emit log_string("=== DARKPOOL: Reputation tracking ===");

        // New agents start at 500 (50%)
        uint256 repA = darkpool.getReputationScore(agentA);
        assertEq(repA, 500, "New agent should have 500 rep");

        // Complete a trade
        vm.prank(agentA);
        uint256 intentId = darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);
        vm.prank(agentB);
        uint256 respId = darkpool.postResponse(intentId, 50_000 * U, 3600);
        vm.prank(agentA);
        darkpool.acceptAndSettle(intentId, respId);

        // Rep should be 1000 (1 completed, 0 expired/cancelled)
        repA = darkpool.getReputationScore(agentA);
        assertEq(repA, 1000, "1 trade, 0 failures = 1000 rep");

        // Cancel an intent to penalize
        vm.prank(agentA);
        uint256 id2 = darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);
        vm.prank(agentA);
        darkpool.cancelIntent(id2);

        // Rep = 1/2 = 500
        repA = darkpool.getReputationScore(agentA);
        assertEq(repA, 500, "1 trade + 1 cancelled = 500 rep");

        emit log_string("  [OK] Reputation tracked correctly");
    }

    // ================================================================
    //  TEST 9: Large trade reputation gate
    // ================================================================
    function test_dp_largeTradeReputationGate() public {
        emit log_string("=== DARKPOOL: Large trade reputation gate ===");

        // Default: $10k threshold, 500 rep required
        // New agent has 500 rep (default) - should pass
        vm.prank(agentA);
        darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);

        // Cancel to drop reputation
        vm.prank(agentA);
        darkpool.cancelIntent(1);

        // Now agentA has 0 completed, 1 expired => rep = 0
        // Try large trade again
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(
            A2ADarkPool.InsufficientReputation.selector, 0, 500
        ));
        darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);

        emit log_string("  [OK] Large trade blocked for low-rep agent");
    }

    // ================================================================
    //  TEST 10: Missing cancelResponse function
    //  ResponseStatus.Cancelled exists but no way to reach it!
    // ================================================================
    function test_dp_missingCancelResponse() public {
        emit log_string("=== DARKPOOL: Missing cancelResponse function ===");

        vm.prank(agentA);
        uint256 intentId = darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);

        vm.prank(agentB);
        uint256 respId = darkpool.postResponse(intentId, 50_000 * U, 3600);

        // FIX APPLIED: cancelResponse now exists
        vm.prank(agentB);
        darkpool.cancelResponse(respId);

        // Verify response is cancelled - cannot be accepted
        // (ResponseStatus is auto-cast to uint256 by public getter)

        // Verify reputation was penalized
        (,,,, uint256 cancelledCount,,) = darkpool.getAgentProfile(agentB);
        assertEq(cancelledCount, 1, "cancelledResponses should be 1");

        // Cancelled response cannot be accepted
        vm.prank(agentA);
        vm.expectRevert("Response not pending");
        darkpool.acceptAndSettle(intentId, respId);

        emit log_string("  [FIXED] cancelResponse works - responder can cancel");
        emit log_string("  [FIXED] Reputation correctly penalized on cancel");
    }

    // ================================================================
    //  TEST 11: Paused state
    // ================================================================
    function test_dp_pausedBlocks() public {
        emit log_string("=== DARKPOOL: Paused state ===");

        vm.prank(owner);
        darkpool.pause();

        vm.prank(agentA);
        vm.expectRevert(A2ADarkPool.Paused.selector);
        darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);

        emit log_string("  [OK] Paused state blocks operations");
    }

    // ================================================================
    //  TEST 12: Zero size intent
    // ================================================================
    function test_dp_zeroSizeIntent() public {
        emit log_string("=== DARKPOOL: Zero size intent ===");

        vm.prank(agentA);
        vm.expectRevert(A2ADarkPool.ZeroAmount.selector);
        darkpool.postIntent(btcMkt, true, 0, 49_000 * U, 51_000 * U, 3600);

        emit log_string("  [OK] Zero size rejected");
    }
}
