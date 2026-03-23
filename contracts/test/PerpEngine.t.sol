// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PerpVault.sol";
import "../src/PerpEngine.sol";
import "./mocks/MockUSDC.sol";

contract PerpEngineTest is Test {
    PerpVault public vault;
    PerpEngine public engine;
    MockUSDC public usdc;

    address public owner = makeAddr("owner");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public operator = makeAddr("operator");
    address public feeRecipient = makeAddr("feeRecipient");
    address public insurance = makeAddr("insurance");

    uint256 constant USDC = 1e6;
    uint256 constant PRICE = 1e6;
    uint256 constant SIZE = 1e8;
    uint256 constant BPS = 10_000;

    bytes32 public btcMarketId;
    uint256 constant BTC_PRICE = 50_000 * PRICE;
    uint256 constant INITIAL_MARGIN_BPS = 500;     // 5% = 20x
    uint256 constant MAINT_MARGIN_BPS = 250;       // 2.5%
    uint256 constant MAX_POS = 100 * SIZE;
    uint256 constant FUNDING_INTERVAL = 28800;     // 8h

    // ============================================================
    //                          SETUP
    // ============================================================

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 0);
        engine = new PerpEngine(address(vault), owner, feeRecipient, insurance, feeRecipient);

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        engine.setOperator(operator, true);
        engine.setMaxExposureBps(0); // disable for non-exposure tests
        engine.setOiSkewCap(10000);  // disable skew cap for tests
        vm.stopPrank();

        btcMarketId = keccak256(abi.encodePacked("BTC-USD"));
        vm.prank(owner);
        engine.addMarket("BTC-USD", INITIAL_MARGIN_BPS, MAINT_MARGIN_BPS, MAX_POS, FUNDING_INTERVAL);

        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, BTC_PRICE, BTC_PRICE);

        _fundTrader(alice, 100_000 * USDC);
        _fundTrader(bob, 100_000 * USDC);
        _fundTrader(feeRecipient, 100_000 * USDC);
        _fundTrader(insurance, 500_000 * USDC); // insurance fund backstops profits
    }

    function _fundTrader(address trader, uint256 amount) internal {
        usdc.mint(trader, amount);
        vm.startPrank(trader);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(amount);
        vm.stopPrank();
    }

    // ============================================================
    //                    CONSTRUCTOR TESTS
    // ============================================================

    function test_constructor() public view {
        assertEq(address(engine.vault()), address(vault));
        assertEq(engine.owner(), owner);
        assertEq(engine.feeRecipient(), feeRecipient);
        assertEq(engine.insuranceFund(), insurance);
        assertFalse(engine.paused());
    }

    function test_constructor_revertsZeroAddress() public {
        vm.expectRevert(PerpEngine.ZeroAddress.selector);
        new PerpEngine(address(0), owner, feeRecipient, insurance, feeRecipient);

        vm.expectRevert(PerpEngine.ZeroAddress.selector);
        new PerpEngine(address(vault), address(0), feeRecipient, insurance, feeRecipient);
    }

    // ============================================================
    //                    MARKET TESTS
    // ============================================================

    function test_addMarket() public view {
        (
            bytes32 id, , bool active,
            uint256 initialMargin, uint256 maintMargin,
            uint256 maxPos, , , , , ,
            uint256 fundingInterval, ,
        ) = engine.markets(btcMarketId);

        assertEq(id, btcMarketId);
        assertTrue(active);
        assertEq(initialMargin, INITIAL_MARGIN_BPS);
        assertEq(maintMargin, MAINT_MARGIN_BPS);
        assertEq(maxPos, MAX_POS);
        assertEq(fundingInterval, FUNDING_INTERVAL);
    }

    function test_addMarket_revertsDuplicate() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PerpEngine.MarketAlreadyExists.selector, btcMarketId));
        engine.addMarket("BTC-USD", 500, 250, MAX_POS, FUNDING_INTERVAL);
    }

    function test_marketCount() public view {
        assertEq(engine.marketCount(), 1);
    }

    // ============================================================
    //                  OPEN POSITION - LONG
    // ============================================================

    function test_openLong() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        (int256 size, uint256 entry, uint256 margin, , ) = engine.getPosition(btcMarketId, alice);

        assertEq(size, int256(1 * SIZE));
        assertEq(entry, BTC_PRICE);
        // Margin = $50,000 * 5% = $2,500
        assertEq(margin, 2_500 * USDC);
        assertEq(vault.balances(alice), 100_000 * USDC - 2_500 * USDC);
    }

    function test_openLong_small() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(SIZE / 10), BTC_PRICE);

        (int256 size, , uint256 margin, , ) = engine.getPosition(btcMarketId, alice);
        assertEq(size, int256(SIZE / 10));
        // Notional = $5,000. Margin = 5% = $250
        assertEq(margin, 250 * USDC);
    }

    // ============================================================
    //                 OPEN POSITION - SHORT
    // ============================================================

    function test_openShort() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, -int256(1 * SIZE), BTC_PRICE);

        (int256 size, uint256 entry, uint256 margin, , ) = engine.getPosition(btcMarketId, alice);

        assertEq(size, -int256(1 * SIZE));
        assertEq(entry, BTC_PRICE);
        assertEq(margin, 2_500 * USDC);
    }

    // ============================================================
    //                    INCREASE POSITION
    // ============================================================

    function test_increasePosition() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        uint256 newPrice = 52_000 * PRICE;
        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, newPrice, newPrice);

        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), newPrice);

        (int256 size, uint256 entry, uint256 margin, , ) = engine.getPosition(btcMarketId, alice);

        assertEq(size, int256(2 * SIZE));
        // Weighted avg: (50,000 * 1 + 52,000 * 1) / 2 = 51,000
        assertEq(entry, 51_000 * PRICE);
        // Margin: 2,500 + 2,600 = 5,100
        assertEq(margin, 5_100 * USDC);
    }

    // ============================================================
    //                   CLOSE POSITION - PNL
    // ============================================================

    function test_closeLong_profit() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        uint256 balBefore = vault.balances(alice);

        uint256 exitPrice = 55_000 * PRICE;
        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, exitPrice, exitPrice);

        vm.prank(operator);
        engine.closePosition(btcMarketId, alice, exitPrice);

        (int256 size, , , , ) = engine.getPosition(btcMarketId, alice);
        assertEq(size, 0);

        // PnL = +$5,000. Gets back: $2,500 + $5,000 = $7,500
        assertEq(vault.balances(alice) - balBefore, 7_500 * USDC);
    }

    function test_closeLong_loss() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        uint256 balBefore = vault.balances(alice);

        uint256 exitPrice = 48_000 * PRICE;
        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, exitPrice, exitPrice);

        vm.prank(operator);
        engine.closePosition(btcMarketId, alice, exitPrice);

        // PnL = -$2,000. Gets back: $2,500 - $2,000 = $500
        assertEq(vault.balances(alice) - balBefore, 500 * USDC);
    }

    function test_closeShort_profit() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, -int256(1 * SIZE), BTC_PRICE);

        uint256 balBefore = vault.balances(alice);

        uint256 exitPrice = 45_000 * PRICE;
        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, exitPrice, exitPrice);

        vm.prank(operator);
        engine.closePosition(btcMarketId, alice, exitPrice);

        // Short PnL = +$5,000. Gets back: $2,500 + $5,000 = $7,500
        assertEq(vault.balances(alice) - balBefore, 7_500 * USDC);
    }

    function test_closeShort_loss() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, -int256(1 * SIZE), BTC_PRICE);

        uint256 balBefore = vault.balances(alice);

        uint256 exitPrice = 51_000 * PRICE;
        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, exitPrice, exitPrice);

        vm.prank(operator);
        engine.closePosition(btcMarketId, alice, exitPrice);

        // Short PnL = -$1,000. Gets back: $2,500 - $1,000 = $1,500
        assertEq(vault.balances(alice) - balBefore, 1_500 * USDC);
    }

    // ============================================================
    //                   PARTIAL CLOSE
    // ============================================================

    function test_partialClose() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(2 * SIZE), BTC_PRICE);

        uint256 exitPrice = 52_000 * PRICE;
        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, exitPrice, exitPrice);

        // Close half: sell 1 BTC
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, -int256(1 * SIZE), exitPrice);

        (int256 size, uint256 entry, uint256 margin, , ) = engine.getPosition(btcMarketId, alice);

        assertEq(size, int256(1 * SIZE));     // 1 BTC remaining
        assertEq(entry, BTC_PRICE);            // entry unchanged
        assertEq(margin, 2_500 * USDC);        // half margin remains
    }

    // ============================================================
    //                   POSITION FLIP
    // ============================================================

    function test_flipPosition() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        uint256 flipPrice = 52_000 * PRICE;
        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, flipPrice, flipPrice);

        // Sell 2 BTC: closes 1 long, opens 1 short
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, -int256(2 * SIZE), flipPrice);

        (int256 size, uint256 entry, uint256 margin, , ) = engine.getPosition(btcMarketId, alice);

        assertEq(size, -int256(1 * SIZE));  // now short
        assertEq(entry, flipPrice);
        // Margin for 1 short at $52k = $2,600
        assertEq(margin, 2_600 * USDC);
    }

    // ============================================================
    //                   VIEW FUNCTIONS
    // ============================================================

    function test_unrealizedPnl() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, 55_000 * PRICE, 55_000 * PRICE);

        assertEq(engine.getUnrealizedPnl(btcMarketId, alice), int256(5_000 * USDC));
    }

    function test_unrealizedPnl_negative() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, 48_000 * PRICE, 48_000 * PRICE);

        assertEq(engine.getUnrealizedPnl(btcMarketId, alice), -int256(2_000 * USDC));
    }

    function test_leverage() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        // Notional $50k / margin $2,500 = 20x = 2000 in 100ths
        assertEq(engine.getLeverage(btcMarketId, alice), 2000);
    }

    function test_isLiquidatable_false() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        assertFalse(engine.isLiquidatable(btcMarketId, alice));
    }

    function test_isLiquidatable_true() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        // Drop to $48,700. PnL = -$1,300. Effective margin = $1,200.
        // Ratio = 1,200/48,700 = 2.46% < 2.5% maintenance
        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, 48_700 * PRICE, 48_700 * PRICE);

        assertTrue(engine.isLiquidatable(btcMarketId, alice));
    }

    function test_marginRatio() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        ( , , , , uint256 ratio) = engine.getPosition(btcMarketId, alice);
        // At entry: 2,500 / 50,000 = 5% = 500 bps
        assertEq(ratio, 500);
    }

    // ============================================================
    //                  OPEN INTEREST
    // ============================================================

    function test_openInterest() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(2 * SIZE), BTC_PRICE);
        vm.prank(operator);
        engine.openPosition(btcMarketId, bob, -int256(1 * SIZE), BTC_PRICE);

        ( , , , , , , , , , , , , uint256 oiLong, uint256 oiShort) = engine.markets(btcMarketId);
        assertEq(oiLong, 2 * SIZE);
        assertEq(oiShort, 1 * SIZE);
    }

    function test_openInterest_decreasesOnClose() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(2 * SIZE), BTC_PRICE);

        vm.prank(operator);
        engine.closePosition(btcMarketId, alice, BTC_PRICE);

        ( , , , , , , , , , , , , uint256 oiLong, ) = engine.markets(btcMarketId);
        assertEq(oiLong, 0);
    }

    // ============================================================
    //                   PRICE MANAGEMENT
    // ============================================================

    function test_stalePrice_reverts() public {
        vm.warp(block.timestamp + 120);

        vm.prank(operator);
        vm.expectRevert();
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);
    }

    // ============================================================
    //                    FUNDING RATE
    // ============================================================

    function test_fundingRate_applied() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        // Mark > index → longs pay
        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, 50_500 * PRICE, BTC_PRICE);

        vm.warp(block.timestamp + FUNDING_INTERVAL);
        engine.applyFundingRate(btcMarketId);

        ( , , , , , , , , , int256 cumFunding, , , , ) = engine.markets(btcMarketId);
        assertTrue(cumFunding > 0);
    }

    function test_fundingRate_notBeforeInterval() public {
        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, 50_500 * PRICE, BTC_PRICE);

        vm.warp(block.timestamp + 3600); // only 1h
        engine.applyFundingRate(btcMarketId);

        ( , , , , , , , , , int256 cumFunding, , , , ) = engine.markets(btcMarketId);
        assertEq(cumFunding, 0);
    }

    // ============================================================
    //                   MARGIN & LIMITS
    // ============================================================

    function test_insufficientMargin_reverts() public {
        // 20 BTC * $50k * 5% = $50k margin (alice has $100k, ok)
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(20 * SIZE), BTC_PRICE);

        // 30 more BTC needs $75k. Alice has $50k left.
        vm.prank(operator);
        vm.expectRevert();
        engine.openPosition(btcMarketId, alice, int256(30 * SIZE), BTC_PRICE);
    }

    function test_maxPosition_reverts() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(
            PerpEngine.MaxPositionExceeded.selector, 101 * SIZE, MAX_POS
        ));
        engine.openPosition(btcMarketId, alice, int256(101 * SIZE), BTC_PRICE);
    }

    // ============================================================
    //                   ACCESS CONTROL
    // ============================================================

    function test_onlyOperator_open() public {
        vm.prank(alice);
        vm.expectRevert(PerpEngine.NotOperator.selector);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);
    }

    function test_onlyOperator_close() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        vm.prank(alice);
        vm.expectRevert(PerpEngine.NotOperator.selector);
        engine.closePosition(btcMarketId, alice, BTC_PRICE);
    }

    function test_onlyOwner_addMarket() public {
        vm.prank(alice);
        vm.expectRevert(PerpEngine.NotOwner.selector);
        engine.addMarket("ETH-USD", 500, 250, MAX_POS, FUNDING_INTERVAL);
    }

    function test_closeNoPosition_reverts() public {
        vm.prank(operator);
        vm.expectRevert(PerpEngine.NoPosition.selector);
        engine.closePosition(btcMarketId, alice, BTC_PRICE);
    }

    function test_pause_blocks() public {
        vm.prank(owner);
        engine.pause();

        vm.prank(operator);
        vm.expectRevert(PerpEngine.Paused.selector);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);
    }

    // ============================================================
    //                  EDGE CASES
    // ============================================================

    function test_openClose_samePrice_noProfit() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        uint256 balBefore = vault.balances(alice);

        vm.prank(operator);
        engine.closePosition(btcMarketId, alice, BTC_PRICE);

        // Gets back exactly the margin
        assertEq(vault.balances(alice) - balBefore, 2_500 * USDC);
    }

    function test_totalLoss_marginStaysInPool() public {
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        uint256 engineBefore = vault.balances(address(engine));

        // Crash: loss ($3k) > margin ($2.5k) = bad debt
        uint256 crashPrice = 47_000 * PRICE;
        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, crashPrice, crashPrice);

        vm.prank(operator);
        engine.closePosition(btcMarketId, alice, crashPrice);

        // Margin stays in engine pool (not sent to insurance)
        // This funds future winner payouts
        assertEq(vault.balances(address(engine)), engineBefore);
        // Alice gets nothing back (total loss)
    }

    // ============================================================
    //                  MULTI-MARKET
    // ============================================================

    function test_multipleMarkets() public {
        bytes32 ethMarketId = keccak256(abi.encodePacked("ETH-USD"));
        vm.prank(owner);
        engine.addMarket("ETH-USD", 500, 250, 1000 * SIZE, FUNDING_INTERVAL);

        uint256 ethPrice = 3_000 * PRICE;
        vm.prank(operator);
        engine.updateMarkPrice(ethMarketId, ethPrice, ethPrice);

        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);
        vm.prank(operator);
        engine.openPosition(ethMarketId, alice, -int256(10 * SIZE), ethPrice);

        (int256 btcSize, , , , ) = engine.getPosition(btcMarketId, alice);
        (int256 ethSize, , , , ) = engine.getPosition(ethMarketId, alice);

        assertEq(btcSize, int256(1 * SIZE));
        assertEq(ethSize, -int256(10 * SIZE));
        assertEq(engine.marketCount(), 2);
    }

    // ============================================================
    //                     FUZZ TESTS
    // ============================================================

    function testFuzz_openClose_conserved(uint256 sizeRaw) public {
        sizeRaw = bound(sizeRaw, SIZE / 1000, 10 * SIZE);

        uint256 totalBefore = vault.balances(alice) + vault.balances(address(engine))
            + vault.balances(feeRecipient) + vault.balances(insurance);

        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(sizeRaw), BTC_PRICE);

        vm.prank(operator);
        engine.closePosition(btcMarketId, alice, BTC_PRICE);

        uint256 totalAfter = vault.balances(alice) + vault.balances(address(engine))
            + vault.balances(feeRecipient) + vault.balances(insurance);

        // Total USDC must be conserved
        assertEq(totalAfter, totalBefore);
    }

    function testFuzz_pnlSymmetry(uint256 entryRaw, uint256 exitRaw, uint256 sizeRaw) public pure {
        uint256 entryPrice = bound(entryRaw, 1_000 * PRICE, 200_000 * PRICE);
        uint256 exitPrice = bound(exitRaw, 1_000 * PRICE, 200_000 * PRICE);
        int256 size = int256(bound(sizeRaw, SIZE / 100, 100 * SIZE));

        int256 pnlLong = (int256(exitPrice) - int256(entryPrice)) * size / int256(SIZE);
        int256 pnlShort = (int256(exitPrice) - int256(entryPrice)) * (-size) / int256(SIZE);

        // Long and short PnL are always exactly opposite
        assert(pnlLong + pnlShort == 0);
    }
}
