// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/A2ADarkPool.sol";
import "../src/PerpVault.sol";
import "../src/PerpEngine.sol";
import "../src/InsuranceFund.sol";
import "./mocks/MockUSDC.sol";

contract A2ADarkPoolTest is Test {
    A2ADarkPool public pool;
    PerpVault public vault;
    PerpEngine public engine;
    InsuranceFund public insurance;
    MockUSDC public usdc;

    address public owner = makeAddr("owner");
    address public agentA = makeAddr("agentA");
    address public agentB = makeAddr("agentB");
    address public agentC = makeAddr("agentC");
    address public feeRecipient = makeAddr("feeRecipient");

    uint256 constant USDC_U = 1e6;
    uint256 constant SIZE_U = 1e8;
    bytes32 public btcMarket;

    function setUp() public {
        vm.warp(1000); // ensure block.timestamp > cooldown period

        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 0);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance));
        pool = new A2ADarkPool(address(vault), address(engine), feeRecipient, owner);

        btcMarket = keccak256(abi.encodePacked("BTC-USD"));

        // Permissions
        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        vault.setOperator(address(pool), true);
        engine.setOperator(address(pool), true);
        engine.setOperator(owner, true);
        engine.addMarket("BTC-USD", 500, 250, 10_000 * SIZE_U, 28800);
        engine.updateMarkPrice(btcMarket, 50_000 * USDC_U, 50_000 * USDC_U);
        engine.setMaxExposureBps(0); // disable for dark pool tests
        vm.stopPrank();

        // Fund agents
        _fundAgent(agentA, 500_000);
        _fundAgent(agentB, 500_000);
        _fundAgent(agentC, 100_000);
    }

    function _fundAgent(address agent, uint256 usdcAmount) internal {
        usdc.mint(agent, usdcAmount * USDC_U);
        vm.startPrank(agent);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(usdcAmount * USDC_U);
        vm.stopPrank();
    }

    // ============================================================
    //                  POST INTENT
    // ============================================================

    function test_postIntent_success() public {
        vm.prank(agentA);
        uint256 id = pool.postIntent(btcMarket, true, 10 * SIZE_U, 49_800 * USDC_U, 50_200 * USDC_U, 3600);

        assertEq(id, 1);
        (uint256 iid, address agent,, bool isBuy, uint256 size, uint256 minP, uint256 maxP,,, A2ADarkPool.IntentStatus status,) = pool.intents(id);
        assertEq(iid, 1);
        assertEq(agent, agentA);
        assertTrue(isBuy);
        assertEq(size, 10 * SIZE_U);
        assertEq(minP, 49_800 * USDC_U);
        assertEq(maxP, 50_200 * USDC_U);
        assertTrue(status == A2ADarkPool.IntentStatus.Open);
    }

    function test_postIntent_sell() public {
        vm.prank(agentB);
        uint256 id = pool.postIntent(btcMarket, false, 5 * SIZE_U, 50_000 * USDC_U, 50_500 * USDC_U, 3600);

        (,,, bool isBuy,,,,,,, ) = pool.intents(id);
        assertFalse(isBuy);
    }

    function test_postIntent_revertsZeroSize() public {
        vm.prank(agentA);
        vm.expectRevert(A2ADarkPool.ZeroAmount.selector);
        pool.postIntent(btcMarket, true, 0, 49_000 * USDC_U, 51_000 * USDC_U, 3600);
    }

    function test_postIntent_revertsMinGtMax() public {
        vm.prank(agentA);
        vm.expectRevert("min > max price");
        pool.postIntent(btcMarket, true, 1 * SIZE_U, 51_000 * USDC_U, 49_000 * USDC_U, 3600);
    }

    function test_postIntent_revertsInvalidDuration() public {
        vm.prank(agentA);
        vm.expectRevert("Invalid duration");
        pool.postIntent(btcMarket, true, 1 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 10); // too short
    }

    function test_cancelIntent_success() public {
        vm.prank(agentA);
        uint256 id = pool.postIntent(btcMarket, true, 5 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 3600);

        vm.prank(agentA);
        pool.cancelIntent(id);

        (,,,,,,,,,A2ADarkPool.IntentStatus status,) = pool.intents(id);
        assertTrue(status == A2ADarkPool.IntentStatus.Cancelled);
    }

    function test_cancelIntent_revertsNotCreator() public {
        vm.prank(agentA);
        uint256 id = pool.postIntent(btcMarket, true, 5 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 3600);

        vm.prank(agentB);
        vm.expectRevert(abi.encodeWithSelector(A2ADarkPool.NotIntentCreator.selector, id));
        pool.cancelIntent(id);
    }

    // ============================================================
    //                  POST RESPONSE
    // ============================================================

    function test_postResponse_success() public {
        vm.prank(agentA);
        uint256 intentId = pool.postIntent(btcMarket, true, 10 * SIZE_U, 49_800 * USDC_U, 50_200 * USDC_U, 3600);

        vm.prank(agentB);
        uint256 respId = pool.postResponse(intentId, 50_050 * USDC_U, 600);

        (uint256 rid, uint256 iid, address agent, uint256 price,,, A2ADarkPool.ResponseStatus status) = pool.responses(respId);
        assertEq(rid, 1);
        assertEq(iid, intentId);
        assertEq(agent, agentB);
        assertEq(price, 50_050 * USDC_U);
        assertTrue(status == A2ADarkPool.ResponseStatus.Pending);
    }

    function test_postResponse_revertsPriceOutOfRange() public {
        vm.prank(agentA);
        uint256 intentId = pool.postIntent(btcMarket, true, 10 * SIZE_U, 49_800 * USDC_U, 50_200 * USDC_U, 3600);

        vm.prank(agentB);
        vm.expectRevert(abi.encodeWithSelector(A2ADarkPool.PriceOutOfRange.selector, 51_000 * USDC_U, 49_800 * USDC_U, 50_200 * USDC_U));
        pool.postResponse(intentId, 51_000 * USDC_U, 600); // above max
    }

    function test_postResponse_revertsSelfTrade() public {
        vm.prank(agentA);
        uint256 intentId = pool.postIntent(btcMarket, true, 10 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 3600);

        vm.prank(agentA);
        vm.expectRevert(A2ADarkPool.SelfTrade.selector);
        pool.postResponse(intentId, 50_000 * USDC_U, 600);
    }

    function test_postResponse_revertsExpiredIntent() public {
        vm.prank(agentA);
        uint256 intentId = pool.postIntent(btcMarket, true, 10 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 60);

        vm.warp(block.timestamp + 120); // past expiry

        vm.prank(agentB);
        vm.expectRevert(abi.encodeWithSelector(A2ADarkPool.IntentExpired.selector, intentId));
        pool.postResponse(intentId, 50_000 * USDC_U, 600);
    }

    function test_multipleResponses_sameIntent() public {
        vm.prank(agentA);
        uint256 intentId = pool.postIntent(btcMarket, true, 10 * SIZE_U, 49_800 * USDC_U, 50_200 * USDC_U, 3600);

        vm.prank(agentB);
        pool.postResponse(intentId, 50_050 * USDC_U, 600);

        vm.warp(block.timestamp + 10); // past cooldown
        vm.prank(agentC);
        pool.postResponse(intentId, 50_000 * USDC_U, 600);

        uint256[] memory resps = pool.getResponses(intentId);
        assertEq(resps.length, 2);
    }

    // ============================================================
    //                  ACCEPT + SETTLE
    // ============================================================

    function test_acceptAndSettle_buyIntent() public {
        // Agent A wants to BUY 1 BTC
        vm.prank(agentA);
        uint256 intentId = pool.postIntent(btcMarket, true, 1 * SIZE_U, 49_800 * USDC_U, 50_200 * USDC_U, 3600);

        // Agent B offers to SELL at $50,100
        vm.prank(agentB);
        uint256 respId = pool.postResponse(intentId, 50_100 * USDC_U, 600);

        uint256 aBalBefore = vault.balances(agentA);
        uint256 bBalBefore = vault.balances(agentB);

        // Agent A accepts
        vm.prank(agentA);
        pool.acceptAndSettle(intentId, respId);

        // Verify intent is filled
        (,,,,,,,,,A2ADarkPool.IntentStatus status,) = pool.intents(intentId);
        assertTrue(status == A2ADarkPool.IntentStatus.Filled);

        // Verify positions were opened
        (int256 aSize,,,,) = engine.getPosition(btcMarket, agentA);
        (int256 bSize,,,,) = engine.getPosition(btcMarket, agentB);
        assertEq(aSize, int256(1 * SIZE_U));  // A is long
        assertEq(bSize, -int256(1 * SIZE_U)); // B is short
    }

    function test_acceptAndSettle_sellIntent() public {
        // Agent A wants to SELL 2 BTC
        vm.prank(agentA);
        uint256 intentId = pool.postIntent(btcMarket, false, 2 * SIZE_U, 49_500 * USDC_U, 50_500 * USDC_U, 3600);

        // Agent B offers at $50,000
        vm.prank(agentB);
        uint256 respId = pool.postResponse(intentId, 50_000 * USDC_U, 600);

        vm.prank(agentA);
        pool.acceptAndSettle(intentId, respId);

        (int256 aSize,,,,) = engine.getPosition(btcMarket, agentA);
        (int256 bSize,,,,) = engine.getPosition(btcMarket, agentB);
        assertEq(aSize, -int256(2 * SIZE_U)); // A is short (seller)
        assertEq(bSize, int256(2 * SIZE_U));  // B is long (buyer)
    }

    function test_acceptAndSettle_collectsFees() public {
        uint256 feeBefore = vault.balances(feeRecipient);

        vm.prank(agentA);
        uint256 intentId = pool.postIntent(btcMarket, true, 10 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 3600);

        vm.prank(agentB);
        uint256 respId = pool.postResponse(intentId, 50_000 * USDC_U, 600);

        vm.prank(agentA);
        pool.acceptAndSettle(intentId, respId);

        uint256 feeAfter = vault.balances(feeRecipient);
        // notional = 50000 * 10 = $500,000
        // fee per side = 500000 * 0.0003 = $150
        // total fee = $300
        uint256 expectedFee = 2 * ((500_000 * USDC_U * 3) / 10_000);
        assertEq(feeAfter - feeBefore, expectedFee);
    }

    function test_acceptAndSettle_revertsNotCreator() public {
        vm.prank(agentA);
        uint256 intentId = pool.postIntent(btcMarket, true, 1 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 3600);

        vm.prank(agentB);
        uint256 respId = pool.postResponse(intentId, 50_000 * USDC_U, 600);

        // Agent C tries to accept — not the creator
        vm.prank(agentC);
        vm.expectRevert(abi.encodeWithSelector(A2ADarkPool.NotIntentCreator.selector, intentId));
        pool.acceptAndSettle(intentId, respId);
    }

    // ============================================================
    //                  REPUTATION
    // ============================================================

    function test_reputation_defaultScore() public view {
        uint256 score = pool.getReputationScore(agentA);
        assertEq(score, 500); // new agent = 50%
    }

    function test_reputation_increasesAfterTrade() public {
        vm.prank(agentA);
        uint256 intentId = pool.postIntent(btcMarket, true, 1 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 3600);
        vm.prank(agentB);
        uint256 respId = pool.postResponse(intentId, 50_000 * USDC_U, 600);
        vm.prank(agentA);
        pool.acceptAndSettle(intentId, respId);

        // Both agents now have 1 completed trade, 0 failures
        uint256 scoreA = pool.getReputationScore(agentA);
        uint256 scoreB = pool.getReputationScore(agentB);
        assertEq(scoreA, 1000); // 1/1 = 100%
        assertEq(scoreB, 1000);
    }

    function test_reputation_decreasesOnCancel() public {
        // Complete one trade
        vm.prank(agentA);
        uint256 id1 = pool.postIntent(btcMarket, true, 1 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 3600);
        vm.prank(agentB);
        uint256 r1 = pool.postResponse(id1, 50_000 * USDC_U, 600);
        vm.prank(agentA);
        pool.acceptAndSettle(id1, r1);

        // Cancel an intent
        vm.prank(agentA);
        uint256 id2 = pool.postIntent(btcMarket, true, 1 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 3600);
        vm.prank(agentA);
        pool.cancelIntent(id2);

        // Score: 1 completed / (1 completed + 1 expired) = 50%
        uint256 score = pool.getReputationScore(agentA);
        assertEq(score, 500);
    }

    function test_reputation_profile() public {
        vm.prank(agentA);
        uint256 id = pool.postIntent(btcMarket, true, 1 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 3600);
        vm.prank(agentB);
        uint256 r = pool.postResponse(id, 50_000 * USDC_U, 600);
        vm.prank(agentA);
        pool.acceptAndSettle(id, r);

        (uint256 score, uint256 completed, uint256 vol,,, uint256 first, uint256 last) = pool.getAgentProfile(agentA);
        assertEq(score, 1000);
        assertEq(completed, 1);
        assertTrue(vol > 0);
        assertTrue(first > 0);
        assertTrue(last > 0);
    }

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    function test_getOpenIntents() public {
        vm.prank(agentA);
        pool.postIntent(btcMarket, true, 1 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 3600);

        vm.prank(agentB);
        pool.postIntent(btcMarket, false, 2 * SIZE_U, 49_500 * USDC_U, 50_500 * USDC_U, 3600);

        uint256[] memory open = pool.getOpenIntents(btcMarket);
        assertEq(open.length, 2);
    }

    function test_totalIntents() public {
        vm.prank(agentA);
        pool.postIntent(btcMarket, true, 1 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 3600);

        assertEq(pool.totalIntents(), 1);
    }

    // ============================================================
    //                  ADMIN
    // ============================================================

    function test_setFeeBps() public {
        vm.prank(owner);
        pool.setFeeBps(5); // 0.05%
        assertEq(pool.feeBps(), 5);
    }

    function test_setFeeBps_revertsExcessive() public {
        vm.prank(owner);
        vm.expectRevert("Max 0.5%");
        pool.setFeeBps(51);
    }

    function test_pause_blocksIntents() public {
        vm.prank(owner);
        pool.pause();

        vm.prank(agentA);
        vm.expectRevert(A2ADarkPool.Paused.selector);
        pool.postIntent(btcMarket, true, 1 * SIZE_U, 49_000 * USDC_U, 51_000 * USDC_U, 3600);
    }
}
