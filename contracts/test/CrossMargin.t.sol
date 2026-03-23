// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PerpVault.sol";
import "../src/PerpEngine.sol";
import "../src/Liquidator.sol";
import "../src/InsuranceFund.sol";
import "./mocks/MockUSDC.sol";

/// @title Cross Margin Tests
/// @notice Verifies cross-margin mode:
///   - Mode switching
///   - Multi-market positions with shared equity
///   - Profits in one market offsetting losses in another
///   - Account-level liquidation when total equity < maintenance
///   - Isolated mode unchanged

contract CrossMarginTest is Test {
    PerpVault public vault;
    PerpEngine public engine;
    Liquidator public liquidator;
    InsuranceFund public insurance;
    MockUSDC public usdc;

    address public owner = makeAddr("owner");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public keeper = makeAddr("keeper");
    address public operator = makeAddr("operator");
    address public feeRecipient = makeAddr("feeRecipient");

    uint256 constant USDC = 1e6;
    uint256 constant SIZE = 1e8;
    uint256 constant BTC_PRICE = 50_000 * USDC;
    uint256 constant ETH_PRICE = 3_000 * USDC;

    bytes32 public btcMarket;
    bytes32 public ethMarket;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 0);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);
        liquidator = new Liquidator(address(engine), address(insurance), owner);

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        engine.setOperator(operator, true);
        engine.setOperator(address(liquidator), true);
        insurance.setOperator(address(liquidator), true);
        engine.setMaxExposureBps(0); // disable for non-exposure tests
        engine.setOiSkewCap(10000);  // disable skew cap for tests
        vm.stopPrank();

        btcMarket = keccak256(abi.encodePacked("BTC-USD"));
        ethMarket = keccak256(abi.encodePacked("ETH-USD"));

        vm.startPrank(owner);
        engine.addMarket("BTC-USD", 500, 250, 100 * SIZE, 28800);
        engine.addMarket("ETH-USD", 667, 333, 1000 * SIZE, 28800);
        engine.setOperator(operator, true);
        vm.stopPrank();

        vm.prank(operator);
        engine.updateMarkPrice(btcMarket, BTC_PRICE, BTC_PRICE);
        vm.prank(operator);
        engine.updateMarkPrice(ethMarket, ETH_PRICE, ETH_PRICE);

        _fund(alice, 100_000 * USDC);
        _fund(bob, 100_000 * USDC);
        _fund(keeper, 1_000 * USDC);
        _fund(address(insurance), 500_000 * USDC);
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    // ============================================================
    //              MODE SWITCHING
    // ============================================================

    function test_defaultModeIsIsolated() public view {
        assertEq(uint(engine.traderMarginMode(alice)), uint(PerpEngine.MarginMode.ISOLATED));
    }

    function test_switchToCrossMargin() public {
        vm.prank(alice);
        engine.setMarginMode(PerpEngine.MarginMode.CROSS);
        assertEq(uint(engine.traderMarginMode(alice)), uint(PerpEngine.MarginMode.CROSS));
    }

    function test_cannotSwitchWithOpenPositions() public {
        vm.prank(operator);
        engine.openPosition(btcMarket, alice, int256(1 * SIZE), BTC_PRICE);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpEngine.CannotSwitchModeWithPositions.selector));
        engine.setMarginMode(PerpEngine.MarginMode.CROSS);
    }

    function test_switchBackToIsolated() public {
        vm.prank(alice);
        engine.setMarginMode(PerpEngine.MarginMode.CROSS);
        assertEq(uint(engine.traderMarginMode(alice)), uint(PerpEngine.MarginMode.CROSS));

        vm.prank(alice);
        engine.setMarginMode(PerpEngine.MarginMode.ISOLATED);
        assertEq(uint(engine.traderMarginMode(alice)), uint(PerpEngine.MarginMode.ISOLATED));
    }

    // ============================================================
    //         CROSS MARGIN: OPEN MULTI-MARKET POSITIONS
    // ============================================================

    function test_crossMargin_openTwoMarkets() public {
        vm.prank(alice);
        engine.setMarginMode(PerpEngine.MarginMode.CROSS);

        // Open 1 BTC long ($50k * 5% = $2,500 margin)
        vm.prank(operator);
        engine.openPosition(btcMarket, alice, int256(1 * SIZE), BTC_PRICE);

        // Open 10 ETH short ($3k * 10 * 6.67% = $2,001 margin)
        vm.prank(operator);
        engine.openPosition(ethMarket, alice, -int256(10 * SIZE), ETH_PRICE);

        // Verify both positions exist
        (int256 btcSize,,,,) = engine.positions(btcMarket, alice);
        (int256 ethSize,,,,) = engine.positions(ethMarket, alice);
        assertEq(btcSize, int256(1 * SIZE));
        assertEq(ethSize, -int256(10 * SIZE));

        // Active market count should be 2
        assertEq(engine.getActiveMarketCount(alice), 2);
    }

    // ============================================================
    //         CROSS MARGIN: ACCOUNT EQUITY
    // ============================================================

    function test_crossMargin_accountEquity() public {
        vm.prank(alice);
        engine.setMarginMode(PerpEngine.MarginMode.CROSS);

        // Open 1 BTC long ($2,500 margin)
        vm.prank(operator);
        engine.openPosition(btcMarket, alice, int256(1 * SIZE), BTC_PRICE);

        (int256 equity, uint256 maintReq) = engine.getAccountEquity(alice);

        // Equity = free balance (100k - 2.5k = 97.5k) + position equity (2.5k margin + 0 pnl)
        // = 100k * USDC
        assertEq(equity, int256(100_000 * USDC));

        // Maintenance requirement: $50k * 2.5% = $1,250
        assertEq(maintReq, 1_250 * USDC);
    }

    // ============================================================
    //    CROSS MARGIN: PROFITS OFFSET LOSSES (THE KEY TEST)
    // ============================================================

    function test_crossMargin_profitsOffsetLosses() public {
        vm.prank(alice);
        engine.setMarginMode(PerpEngine.MarginMode.CROSS);

        // Open 1 BTC long and 10 ETH short
        vm.prank(operator);
        engine.openPosition(btcMarket, alice, int256(1 * SIZE), BTC_PRICE);
        vm.prank(operator);
        engine.openPosition(ethMarket, alice, -int256(10 * SIZE), ETH_PRICE);

        // BTC drops 4% to $48,000 — BTC long LOSES $2,000
        // ETH drops 4% to $2,880 — ETH short GAINS $1,200
        vm.prank(operator);
        engine.updateMarkPrice(btcMarket, 48_000 * USDC, 48_000 * USDC);
        vm.prank(operator);
        engine.updateMarkPrice(ethMarket, 2_880 * USDC, 2_880 * USDC);

        // In isolated mode, BTC position might be near liquidation
        // (margin $2,500, loss $2,000, effective margin $500, notional $48k, ratio ~1.04%)
        // Below 2.5% maintenance → liquidatable in isolated mode

        // In cross mode, the ETH profit offsets:
        // Total equity = free balance + (BTC margin + BTC pnl) + (ETH margin + ETH pnl)
        // BTC pnl = ($48k - $50k) * 1 = -$2,000
        // ETH pnl = ($3k - $2.88k) * 10 = +$1,200

        (int256 equity, uint256 maintReq) = engine.getAccountEquity(alice);

        // The account should NOT be liquidatable because total equity is well above maintenance
        assertFalse(engine.isAccountLiquidatable(alice), "Cross-margin account should NOT be liquidatable");

        // The equity should reflect the offset
        // Free: 100k - 2500 (btc margin) - 2001 (eth margin) ≈ 95,499
        // BTC position: 2500 + (-2000) = 500
        // ETH position: 2001 + 1200 = 3201
        // Total ≈ 99,200 (roughly, 100k - net loss of 800)
        assertTrue(equity > int256(98_000 * USDC), "Equity should be well above maintenance");
        assertTrue(equity < int256(100_000 * USDC), "Equity should be less than initial (net loss)");
    }

    // ============================================================
    //     CROSS MARGIN: ACCOUNT LIQUIDATION
    // ============================================================

    function test_crossMargin_accountLiquidation() public {
        vm.prank(alice);
        engine.setMarginMode(PerpEngine.MarginMode.CROSS);

        // Alice opens a big 2 BTC long with 20x leverage ($5,000 margin)
        vm.prank(operator);
        engine.openPosition(btcMarket, alice, int256(2 * SIZE), BTC_PRICE);

        // BTC crashes to $46,000 — loss = $8,000 on 2 BTC
        vm.prank(operator);
        engine.updateMarkPrice(btcMarket, 46_000 * USDC, 46_000 * USDC);

        // At this point, account equity:
        // Free: 100k - 5k = 95k
        // BTC position: 5k margin + (-8k pnl) = -3k
        // Total equity: 95k - 3k = 92k
        // Maintenance: $46k * 2 * 2.5% = $2,300
        // 92k >> 2,300 → NOT liquidatable yet

        assertFalse(engine.isAccountLiquidatable(alice));

        // Now imagine alice withdrew most of her free balance first
        // Simulate: alice only had $6,000 total to start
        // Let's create bob with small balance in cross mode
        vm.prank(bob);
        engine.setMarginMode(PerpEngine.MarginMode.CROSS);

        // Give bob only 6k
        // He already has 100k from setUp, so let's work with that
        // Instead: open a position that will eat through his margin

        // Bob opens 2 BTC long ($5k margin from 100k balance)
        vm.prank(operator);
        engine.openPosition(btcMarket, bob, int256(2 * SIZE), BTC_PRICE);

        // Bob withdraws most of his free balance, leaving only $6k total equity
        uint256 bobFree = vault.balances(bob);
        uint256 toWithdraw = bobFree - 1_000 * USDC; // leave only $1k free
        vm.prank(bob);
        vault.withdraw(toWithdraw);

        // BTC crashes to $46,500 — loss on 2 BTC = $7,000
        vm.prank(operator);
        engine.updateMarkPrice(btcMarket, 46_500 * USDC, 46_500 * USDC);

        // Bob's account:
        // Free: ~$1,000
        // BTC position: $5,000 margin + (-$7,000 pnl) = -$2,000
        // Total equity: $1,000 + (-$2,000) = -$1,000 (NEGATIVE!)
        // Maintenance: $46.5k * 2 * 2.5% = $2,325
        // -$1,000 < $2,325 → LIQUIDATABLE

        assertTrue(engine.isAccountLiquidatable(bob), "Bob should be liquidatable");

        // Keeper liquidates entire account
        uint256 keeperBalBefore = vault.balances(keeper);
        vm.prank(keeper);
        liquidator.liquidateAccount(bob);

        // Bob's positions should all be gone
        (int256 bobBtcSize,,,,) = engine.positions(btcMarket, bob);
        assertEq(bobBtcSize, 0, "Bob's BTC position should be closed");
        assertEq(engine.getActiveMarketCount(bob), 0, "Bob should have no active markets");

        // Keeper earned reward
        assertTrue(vault.balances(keeper) > keeperBalBefore, "Keeper should have earned reward");
    }

    // ============================================================
    //     ISOLATED MODE: UNCHANGED BEHAVIOR
    // ============================================================

    function test_isolatedMode_unchanged() public {
        // Default is isolated — no changes to existing behavior
        assertEq(uint(engine.traderMarginMode(alice)), uint(PerpEngine.MarginMode.ISOLATED));

        // Open position
        vm.prank(operator);
        engine.openPosition(btcMarket, alice, int256(1 * SIZE), BTC_PRICE);

        // Verify isolated liquidation check works as before
        assertFalse(engine.isLiquidatable(btcMarket, alice));

        // BTC crashes — isolated check uses position's own margin only
        vm.prank(operator);
        engine.updateMarkPrice(btcMarket, 47_000 * USDC, 47_000 * USDC);

        // Margin $2,500, loss $3,000, effective = -$500 → liquidatable
        assertTrue(engine.isLiquidatable(btcMarket, alice), "Should be liquidatable in isolated mode");

        // isAccountLiquidatable returns false for isolated-mode traders
        assertFalse(engine.isAccountLiquidatable(alice), "isAccountLiquidatable should be false for isolated");
    }

    // ============================================================
    //     CROSS MARGIN: NOT LIQUIDATABLE WITH ENOUGH FREE BALANCE
    // ============================================================

    function test_crossMargin_freeBalancePreventsLiquidation() public {
        vm.prank(alice);
        engine.setMarginMode(PerpEngine.MarginMode.CROSS);

        vm.prank(operator);
        engine.openPosition(btcMarket, alice, int256(1 * SIZE), BTC_PRICE);

        // BTC crashes to $47,000 (loss $3,000)
        vm.prank(operator);
        engine.updateMarkPrice(btcMarket, 47_000 * USDC, 47_000 * USDC);

        // In isolated mode this would be liquidatable (margin $2.5k, loss $3k)
        // In cross mode, alice has ~$97.5k free balance backing the position
        assertFalse(engine.isAccountLiquidatable(alice), "Should NOT be liquidatable with large free balance");
    }

    // ============================================================
    //     ACTIVE MARKET TRACKING
    // ============================================================

    function test_activeMarketTracking() public {
        vm.prank(alice);
        engine.setMarginMode(PerpEngine.MarginMode.CROSS);

        assertEq(engine.getActiveMarketCount(alice), 0);

        // Open BTC
        vm.prank(operator);
        engine.openPosition(btcMarket, alice, int256(1 * SIZE), BTC_PRICE);
        assertEq(engine.getActiveMarketCount(alice), 1);

        // Open ETH
        vm.prank(operator);
        engine.openPosition(ethMarket, alice, -int256(5 * SIZE), ETH_PRICE);
        assertEq(engine.getActiveMarketCount(alice), 2);

        // Close BTC
        vm.prank(operator);
        engine.closePosition(btcMarket, alice, BTC_PRICE);
        assertEq(engine.getActiveMarketCount(alice), 1);

        // Close ETH
        vm.prank(operator);
        engine.closePosition(ethMarket, alice, ETH_PRICE);
        assertEq(engine.getActiveMarketCount(alice), 0);

        // Can now switch mode
        vm.prank(alice);
        engine.setMarginMode(PerpEngine.MarginMode.ISOLATED);
    }
}
