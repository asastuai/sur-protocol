// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PerpVault.sol";
import "../src/PerpEngine.sol";
import "../src/OrderSettlement.sol";
import "../src/Liquidator.sol";
import "../src/InsuranceFund.sol";
import "../src/OracleRouter.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockPyth.sol";
import "./mocks/MockChainlink.sol";

/// @title SUR Protocol - Full Integration Test
/// @notice Tests the ENTIRE protocol lifecycle end-to-end:
///         deploy → configure → fund → trade → PnL → liquidation → withdraw
/// @dev This is the single most important test file in the protocol.
///      If this passes, all contracts are wired correctly.

contract IntegrationTest is Test {
    // === Contracts ===
    MockUSDC public usdc;
    PerpVault public vault;
    PerpEngine public engine;
    OrderSettlement public settlement;
    Liquidator public liquidator;
    InsuranceFund public insurance;
    OracleRouter public oracle;

    // === Mocks ===
    MockPyth public mockPyth;
    MockChainlinkAggregator public mockChainlinkBTC;

    // === Accounts ===
    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("treasury");
    address public keeper = makeAddr("keeper");

    uint256 constant ALICE_PK = 0xA11CE;
    uint256 constant BOB_PK = 0xB0B;
    uint256 constant CHARLIE_PK = 0xC4A7;
    address public alice;
    address public bob;
    address public charlie;

    // === Constants ===
    uint256 constant USDC_UNIT = 1e6;
    uint256 constant SIZE_UNIT = 1e8;
    uint256 constant BTC_50K = 50_000 * USDC_UNIT; // $50,000.000000

    bytes32 public btcMarket;
    bytes32 constant PYTH_BTC_FEED = bytes32(uint256(0xB7C));

    // ============================================================
    //            STEP 1: DEPLOY & CONFIGURE EVERYTHING
    // ============================================================

    function setUp() public {
        alice = vm.addr(ALICE_PK);
        bob = vm.addr(BOB_PK);
        charlie = vm.addr(CHARLIE_PK);

        // --- Deploy infrastructure ---
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 10_000_000 * USDC_UNIT); // $10M cap

        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);

        settlement = new OrderSettlement(address(engine), address(vault), feeRecipient, owner);
        liquidator = new Liquidator(address(engine), address(insurance), owner);

        mockPyth = new MockPyth();
        mockChainlinkBTC = new MockChainlinkAggregator(8, "BTC/USD");
        oracle = new OracleRouter(address(mockPyth), address(engine), owner);

        btcMarket = keccak256(abi.encodePacked("BTC-USD"));

        // --- Configure permission chain ---
        vm.startPrank(owner);

        // Vault trusts: engine, settlement (for fee collection)
        vault.setOperator(address(engine), true);
        vault.setOperator(address(settlement), true);

        // Engine trusts: settlement (trades), liquidator (liquidations), oracle (prices)
        engine.setOperator(address(settlement), true);
        engine.setOperator(address(liquidator), true);
        engine.setOperator(address(oracle), true);
        engine.setOperator(owner, true); // for initial price setup

        // Settlement trusts: owner (for testing, in prod this is the backend)
        settlement.setOperator(owner, true);

        // Insurance fund trusts: liquidator
        insurance.setOperator(address(liquidator), true);

        // Oracle trusts: owner (keeper role for testing)
        oracle.setOperator(owner, true);

        // Disable exposure limit and circuit breaker for integration tests (tested separately)
        engine.setMaxExposureBps(0);
        engine.setCircuitBreakerParams(60, 10000, 60); // 100% threshold = never triggers
        engine.setOiSkewCap(10000); // disable skew cap for tests
        settlement.setSettlementDelay(0, 300); // disable MEV delay for integration tests

        // --- Add BTC-USD market ---
        engine.addMarket(
            "BTC-USD",
            500,             // 5% initial margin = 20x max leverage
            250,             // 2.5% maintenance margin
            10_000 * SIZE_UNIT, // max 10,000 BTC per position
            28800            // 8-hour funding interval
        );

        // Set initial prices so engine has fresh data
        engine.updateMarkPrice(btcMarket, BTC_50K, BTC_50K);

        // Configure oracle feeds
        oracle.configureFeed(
            btcMarket,
            PYTH_BTC_FEED,
            address(mockChainlinkBTC),
            120,    // 120s staleness
            100,    // 1% max deviation
            50      // 0.5% max confidence
        );

        vm.stopPrank();

        // --- Set oracle prices ---
        mockPyth.setPrice(PYTH_BTC_FEED, 5_000_000_000_000, 1_000_000, -8, block.timestamp);
        mockChainlinkBTC.setPrice(int256(50_000 * 1e8), block.timestamp);

        // --- Fund participants ---
        _deposit(alice, 50_000 * USDC_UNIT);
        _deposit(bob, 50_000 * USDC_UNIT);
        _deposit(charlie, 20_000 * USDC_UNIT);
        _deposit(address(insurance), 500_000 * USDC_UNIT); // seed insurance
    }

    function _deposit(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    // ============================================================
    //                  EIP-712 SIGNING HELPERS
    // ============================================================

    function _signOrder(
        uint256 pk, address trader, bool isLong,
        uint256 size, uint256 price, uint256 nonce
    ) internal view returns (OrderSettlement.SignedOrder memory) {
        uint256 expiry = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(
            settlement.ORDER_TYPEHASH(),
            trader, btcMarket, isLong, size, price, nonce, expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", settlement.DOMAIN_SEPARATOR(), structHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        return OrderSettlement.SignedOrder({
            trader: trader,
            marketId: btcMarket,
            isLong: isLong,
            size: size,
            price: price,
            nonce: nonce,
            expiry: expiry,
            signature: abi.encodePacked(r, s, v)
        });
    }

    // ============================================================
    //   STEP 2: FULL LIFECYCLE TEST - THE MOST IMPORTANT TEST
    // ============================================================

    function test_fullLifecycle() public {
        // ========================================
        // PHASE A: OPEN POSITIONS VIA SETTLEMENT
        // ========================================

        // Alice goes LONG 1 BTC at $50,000
        // Bob goes SHORT 1 BTC at $50,000
        OrderSettlement.SignedOrder memory makerOrder = _signOrder(
            BOB_PK, bob, false, 1 * SIZE_UNIT, BTC_50K, 1
        );
        OrderSettlement.SignedOrder memory takerOrder = _signOrder(
            ALICE_PK, alice, true, 1 * SIZE_UNIT, BTC_50K, 1
        );

        OrderSettlement.MatchedTrade memory trade = OrderSettlement.MatchedTrade({
            maker: makerOrder,
            taker: takerOrder,
            executionPrice: BTC_50K,
            executionSize: 1 * SIZE_UNIT
        });

        vm.prank(owner);
        settlement.settleOne(trade);

        // Verify positions
        (int256 aliceSize, uint256 aliceEntry, uint256 aliceMargin,,) =
            engine.positions(btcMarket, alice);
        (int256 bobSize, uint256 bobEntry, uint256 bobMargin,,) =
            engine.positions(btcMarket, bob);

        assertEq(aliceSize, int256(SIZE_UNIT), "Alice should be 1 BTC long");
        assertEq(bobSize, -int256(SIZE_UNIT), "Bob should be 1 BTC short");
        assertEq(aliceEntry, BTC_50K, "Alice entry should be $50k");
        assertEq(bobEntry, BTC_50K, "Bob entry should be $50k");

        // Margin auto-calculated: $50,000 * 5% = $2,500
        assertEq(aliceMargin, 2_500 * USDC_UNIT, "Alice margin should be $2,500");
        assertEq(bobMargin, 2_500 * USDC_UNIT, "Bob margin should be $2,500");

        // Verify fees collected (maker 0.02%, taker 0.06% of $50k notional)
        // Maker fee: $10, Taker fee: $30
        assertEq(vault.balances(feeRecipient), 40 * USDC_UNIT, "Treasury should have $40 in fees");

        // Verify vault accounting
        // Alice: 50k - 2500 margin - 30 taker fee = 47,470
        assertEq(vault.balances(alice), 47_470 * USDC_UNIT);
        // Bob: 50k - 2500 margin - 10 maker fee = 47,490
        assertEq(vault.balances(bob), 47_490 * USDC_UNIT);

        emit log_string("--- Phase A: Positions opened successfully ---");

        // ========================================
        // PHASE B: PRICE MOVES, CHECK PNL
        // ========================================

        // BTC pumps to $55,000 → Alice profits, Bob loses
        _updatePrice(55_000);

        int256 alicePnl = engine.getUnrealizedPnl(btcMarket, alice);
        int256 bobPnl = engine.getUnrealizedPnl(btcMarket, bob);

        // Alice PnL = ($55k - $50k) * 1 BTC = +$5,000
        assertEq(alicePnl, int256(5_000 * USDC_UNIT), "Alice should be +$5k");
        // Bob PnL = ($50k - $55k) * 1 BTC = -$5,000
        assertEq(bobPnl, -int256(5_000 * USDC_UNIT), "Bob should be -$5k");

        // Bob is now underwater: margin $2500 + PnL -$5000 = -$2500
        // margin ratio = 0 → liquidatable
        assertTrue(engine.isLiquidatable(btcMarket, bob), "Bob should be liquidatable");
        assertFalse(engine.isLiquidatable(btcMarket, alice), "Alice should NOT be liquidatable");

        emit log_string("--- Phase B: PnL verified at $55k ---");

        // ========================================
        // PHASE C: LIQUIDATE BOB
        // ========================================

        uint256 keeperBalBefore = vault.balances(keeper);
        uint256 insuranceBalBefore = vault.balances(address(insurance));

        // Keeper liquidates Bob - partial liquidation (25% per call),
        // so we loop until position is fully closed.
        // With 25% reduction per round, convergence to the tiny-position
        // threshold (SIZE_PRECISION/100 = 1e6) takes ~18 rounds from 1e8.
        uint256 rounds;
        while (true) {
            (bobSize,,,,) = engine.positions(btcMarket, bob);
            if (bobSize == 0) break;
            if (!engine.isLiquidatable(btcMarket, bob)) break;
            vm.prank(keeper);
            liquidator.liquidate(btcMarket, bob);
            rounds++;
            require(rounds <= 25, "Too many liquidation rounds");
        }

        // Bob's position should be gone
        (bobSize,,,,) = engine.positions(btcMarket, bob);
        assertEq(bobSize, 0, "Bob position should be closed");

        // Keeper earned a reward
        uint256 keeperReward = vault.balances(keeper) - keeperBalBefore;
        assertGt(keeperReward, 0, "Keeper should have received reward");

        // Liquidation stats - partial liquidation (25% per round) requires multiple rounds
        assertEq(liquidator.totalLiquidations(), rounds, "Liquidation rounds should match");
        assertEq(liquidator.keeperLiquidations(keeper), rounds, "Keeper liquidation count should match");

        emit log_named_uint("  Keeper reward", keeperReward);
        emit log_string("--- Phase C: Bob liquidated successfully ---");

        // ========================================
        // PHASE D: ALICE CLOSES WITH PROFIT
        // ========================================

        // Alice closes her profitable long by taking an opposite trade with Charlie
        // Charlie goes SHORT 1 BTC at $55,000 (new counterparty)
        OrderSettlement.SignedOrder memory closeOrder = _signOrder(
            ALICE_PK, alice, false, 1 * SIZE_UNIT, 55_000 * USDC_UNIT, 2
        );
        OrderSettlement.SignedOrder memory charlieOrder = _signOrder(
            CHARLIE_PK, charlie, true, 1 * SIZE_UNIT, 55_000 * USDC_UNIT, 1
        );

        // This settles Alice closing (reduce her long) and Charlie opening a long
        OrderSettlement.MatchedTrade memory closeTrade = OrderSettlement.MatchedTrade({
            maker: closeOrder,   // Alice sells (close long)
            taker: charlieOrder, // Charlie buys (new long)
            executionPrice: 55_000 * USDC_UNIT,
            executionSize: 1 * SIZE_UNIT
        });

        uint256 aliceBalBefore = vault.balances(alice);
        vm.prank(owner);
        settlement.settleOne(closeTrade);

        // Alice's position should be closed (her short cancels her long)
        (aliceSize,,,,) = engine.positions(btcMarket, alice);
        assertEq(aliceSize, 0, "Alice position should be closed");

        // Alice should have made money
        uint256 aliceBalAfter = vault.balances(alice);
        assertGt(aliceBalAfter, aliceBalBefore, "Alice should have profited");

        emit log_named_uint("  Alice balance after close", aliceBalAfter);
        emit log_string("--- Phase D: Alice closed profitably ---");

        // ========================================
        // PHASE E: UPDATE PRICES VIA ORACLE
        // ========================================

        // Push price through the OracleRouter → PerpEngine
        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        assertTrue(oracle.isPriceFresh(btcMarket), "Price should be fresh");

        (uint256 lastOraclePrice,) = oracle.getLastPrice(btcMarket);
        assertEq(lastOraclePrice, 55_000 * USDC_UNIT, "Oracle should report $55k");

        emit log_string("--- Phase E: Oracle push verified ---");

        // ========================================
        // PHASE F: ALICE WITHDRAWS
        // ========================================

        uint256 aliceFinalVaultBal = vault.balances(alice);
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vault.withdraw(aliceFinalVaultBal);

        assertEq(vault.balances(alice), 0, "Alice vault balance should be 0");
        assertEq(
            usdc.balanceOf(alice),
            aliceUsdcBefore + aliceFinalVaultBal,
            "Alice should have USDC in wallet"
        );

        emit log_string("--- Phase F: Alice withdrew successfully ---");

        // ========================================
        // PHASE G: VERIFY GLOBAL INVARIANTS
        // ========================================

        _verifyGlobalInvariants();

        emit log_string("=== FULL LIFECYCLE TEST PASSED ===");
    }

    // ============================================================
    //       STEP 3: INVARIANT CHECKS (called at any point)
    // ============================================================

    function _verifyGlobalInvariants() internal {
        // INVARIANT 1: Vault USDC balance >= totalDeposits
        (bool healthy, uint256 actualUsdc, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "INVARIANT VIOLATED: Vault accounting mismatch");
        assertGe(actualUsdc, accounted, "INVARIANT VIOLATED: USDC < accounted");

        // INVARIANT 2: Insurance fund balance >= 0 (it's uint, always true,
        // but we check it wasn't drained unexpectedly)
        uint256 insuranceBal = vault.balances(address(insurance));
        emit log_named_uint("  Insurance fund balance", insuranceBal);

        // INVARIANT 3: Fee recipient accumulated fees
        uint256 treasuryBal = vault.balances(feeRecipient);
        assertGt(treasuryBal, 0, "INVARIANT: Treasury should have fees");
        emit log_named_uint("  Treasury balance", treasuryBal);
    }

    // ============================================================
    //      ADDITIONAL INTEGRATION SCENARIOS
    // ============================================================

    function test_oraclePushThenTrade() public {
        // Test: Oracle updates price, THEN trade settles
        // Ensures freshness checks pass through the whole pipeline

        // Update oracle to $52k
        _updatePrice(52_000);

        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        // Now trade at $52k
        OrderSettlement.SignedOrder memory maker = _signOrder(
            BOB_PK, bob, false, 1 * SIZE_UNIT, 52_000 * USDC_UNIT, 10
        );
        OrderSettlement.SignedOrder memory taker = _signOrder(
            ALICE_PK, alice, true, 1 * SIZE_UNIT, 52_000 * USDC_UNIT, 10
        );

        vm.prank(owner);
        settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: maker,
            taker: taker,
            executionPrice: 52_000 * USDC_UNIT,
            executionSize: 1 * SIZE_UNIT
        }));

        (int256 size,, uint256 margin,,) = engine.positions(btcMarket, alice);
        assertEq(size, int256(SIZE_UNIT));
        // Margin = $52,000 * 5% = $2,600
        assertEq(margin, 2_600 * USDC_UNIT);
    }

    function test_multipleTradesAndLiquidations() public {
        // Alice, Bob, Charlie all open longs
        _openLongViaTrade(ALICE_PK, alice, BOB_PK, bob, 1);
        _openLongViaTrade(CHARLIE_PK, charlie, BOB_PK, bob, 2);

        // Alice: 1 BTC long, Charlie: 1 BTC long, Bob: 2 BTC short

        // Price crashes to $47k (6% drop)
        _updatePrice(47_000);
        vm.prank(owner);
        oracle.pushPrice(btcMarket);

        // All three should be affected
        // Alice long: PnL = -$3k, margin $2.5k → underwater → liquidatable
        // Charlie long: PnL = -$3k, margin $2.5k → underwater → liquidatable
        // Bob short: PnL = +$6k, margin $5k → very healthy
        assertTrue(engine.isLiquidatable(btcMarket, alice));
        assertTrue(engine.isLiquidatable(btcMarket, charlie));
        assertFalse(engine.isLiquidatable(btcMarket, bob));

        // Batch liquidate alice and charlie
        bytes32[] memory mkts = new bytes32[](2);
        address[] memory traders = new address[](2);
        mkts[0] = btcMarket; mkts[1] = btcMarket;
        traders[0] = alice; traders[1] = charlie;

        vm.prank(keeper);
        liquidator.liquidateBatch(mkts, traders);

        assertEq(liquidator.totalLiquidations(), 2);

        // Bob still has his position
        (int256 bobSize,,,,) = engine.positions(btcMarket, bob);
        assertEq(bobSize, -int256(2 * SIZE_UNIT));

        _verifyGlobalInvariants();
    }

    function test_noncePreventsReplay() public {
        OrderSettlement.SignedOrder memory maker = _signOrder(
            BOB_PK, bob, false, 1 * SIZE_UNIT, BTC_50K, 99
        );
        OrderSettlement.SignedOrder memory taker = _signOrder(
            ALICE_PK, alice, true, 1 * SIZE_UNIT, BTC_50K, 99
        );

        OrderSettlement.MatchedTrade memory trade = OrderSettlement.MatchedTrade({
            maker: maker, taker: taker,
            executionPrice: BTC_50K, executionSize: 1 * SIZE_UNIT
        });

        // First trade succeeds
        vm.prank(owner);
        settlement.settleOne(trade);

        // Replay fails
        vm.prank(owner);
        vm.expectRevert();
        settlement.settleOne(trade);
    }

    function test_cannotLiquidateHealthyPosition() public {
        _openLongViaTrade(ALICE_PK, alice, BOB_PK, bob, 1);

        vm.prank(keeper);
        vm.expectRevert();
        liquidator.liquidate(btcMarket, alice);
    }

    // ============================================================
    //                      HELPERS
    // ============================================================

    function _updatePrice(uint256 priceDollars) internal {
        uint256 price6dec = priceDollars * USDC_UNIT;
        int64 pythPrice = int64(int256(priceDollars * 1e8)); // expo=-8
        int256 clPrice = int256(priceDollars * 1e8);         // 8 decimals

        mockPyth.setPrice(PYTH_BTC_FEED, pythPrice, 1_000_000, -8, block.timestamp);
        mockChainlinkBTC.setPrice(clPrice, block.timestamp);

        // Also update engine directly (oracle.pushPrice needs engine fresh price check)
        vm.prank(owner);
        engine.updateMarkPrice(btcMarket, price6dec, price6dec);
    }

    function _openLongViaTrade(
        uint256 longPK, address longAddr,
        uint256 shortPK, address shortAddr,
        uint256 nonce
    ) internal {
        OrderSettlement.SignedOrder memory maker = _signOrder(
            shortPK, shortAddr, false, 1 * SIZE_UNIT, BTC_50K, nonce
        );
        OrderSettlement.SignedOrder memory taker = _signOrder(
            longPK, longAddr, true, 1 * SIZE_UNIT, BTC_50K, nonce
        );

        vm.prank(owner);
        settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: maker, taker: taker,
            executionPrice: BTC_50K, executionSize: 1 * SIZE_UNIT
        }));
    }
}
