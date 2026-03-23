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

/// @title SUR Protocol - Liquidation Engine Stress Tests
/// @notice Stress tests covering cascade liquidations, max leverage, rapid price
///         oscillation, many simultaneous positions, and zero-margin edge cases.
/// @dev Partial liquidation = 25% per round. Full close when position is tiny
///      (absSize <= SIZE_PRECISION / 100 = 1e6).

contract LiquidationStressTest is Test {
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
    address public alice;

    // === Constants ===
    uint256 constant USDC_UNIT = 1e6;
    uint256 constant SIZE_UNIT = 1e8;
    uint256 constant BTC_50K = 50_000 * USDC_UNIT;

    bytes32 public btcMarket;
    bytes32 public ethMarket;
    bytes32 constant PYTH_BTC_FEED = bytes32(uint256(0xB7C));

    address[] internal traders;
    uint256[] internal traderPKs;

    // ============================================================
    //                          SETUP
    // ============================================================

    function setUp() public {
        alice = vm.addr(ALICE_PK);

        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 100_000_000 * USDC_UNIT);

        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);

        settlement = new OrderSettlement(address(engine), address(vault), feeRecipient, owner);
        liquidator = new Liquidator(address(engine), address(insurance), owner);

        mockPyth = new MockPyth();
        mockChainlinkBTC = new MockChainlinkAggregator(8, "BTC/USD");
        oracle = new OracleRouter(address(mockPyth), address(engine), owner);

        btcMarket = keccak256(abi.encodePacked("BTC-USD"));

        vm.startPrank(owner);

        vault.setOperator(address(engine), true);
        vault.setOperator(address(settlement), true);

        engine.setOperator(address(settlement), true);
        engine.setOperator(address(liquidator), true);
        engine.setOperator(address(oracle), true);
        engine.setOperator(owner, true);

        settlement.setOperator(owner, true);
        insurance.setOperator(address(liquidator), true);
        oracle.setOperator(owner, true);

        engine.setMaxExposureBps(0);
        engine.setCircuitBreakerParams(60, 10000, 60);
        engine.setOiSkewCap(10000);

        // BTC-USD: 20x max leverage, 2.5% maintenance
        engine.addMarket(
            "BTC-USD",
            500,   // 5% initial margin
            250,   // 2.5% maintenance margin
            10_000 * SIZE_UNIT,
            28800
        );

        // ETH-USD: 50x max leverage, 1% maintenance
        engine.addMarket(
            "ETH-USD",
            200,   // 2% initial margin
            100,   // 1% maintenance margin
            100_000 * SIZE_UNIT,
            28800
        );

        ethMarket = keccak256(abi.encodePacked("ETH-USD"));

        engine.updateMarkPrice(btcMarket, BTC_50K, BTC_50K);
        engine.updateMarkPrice(ethMarket, 3_000 * USDC_UNIT, 3_000 * USDC_UNIT);

        oracle.configureFeed(
            btcMarket,
            PYTH_BTC_FEED,
            address(mockChainlinkBTC),
            120, 100, 50
        );

        vm.stopPrank();

        mockPyth.setPrice(PYTH_BTC_FEED, 5_000_000_000_000, 1_000_000, -8, block.timestamp);
        mockChainlinkBTC.setPrice(int256(50_000 * 1e8), block.timestamp);

        _deposit(address(insurance), 5_000_000 * USDC_UNIT);
        _createTraders(25);
    }

    // ============================================================
    //                         HELPERS
    // ============================================================

    function _deposit(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function _createTraders(uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            uint256 pk = 0x1000 + i;
            address trader = vm.addr(pk);
            traderPKs.push(pk);
            traders.push(trader);
            _deposit(trader, 500_000 * USDC_UNIT);
        }
    }

    function _updatePrice(bytes32 marketId, uint256 priceDollars) internal {
        uint256 price6dec = priceDollars * USDC_UNIT;
        vm.prank(owner);
        engine.updateMarkPrice(marketId, price6dec, price6dec);
    }

    function _openPosition(
        bytes32 marketId,
        address trader,
        int256 size,
        uint256 price6dec
    ) internal {
        vm.prank(owner);
        engine.openPosition(marketId, trader, size, price6dec);
    }

    function _fullyLiquidate(bytes32 marketId, address trader) internal returns (uint256 rounds) {
        while (true) {
            (int256 size,,,,) = engine.positions(marketId, trader);
            if (size == 0) break;
            if (!engine.isLiquidatable(marketId, trader)) break;
            vm.prank(keeper);
            liquidator.liquidate(marketId, trader);
            rounds++;
            require(rounds <= 30, "Too many liquidation rounds");
        }
    }

    function _countRoundsToClose(uint256 absSize) internal pure returns (uint256 rounds) {
        uint256 SIZE_PRECISION = 1e8;
        while (absSize > 0) {
            uint256 liquidateSize = absSize / 4;
            if (liquidateSize == 0 || absSize <= SIZE_PRECISION / 100) {
                liquidateSize = absSize;
            }
            absSize -= liquidateSize;
            rounds++;
        }
    }

    // ============================================================
    //  TEST 1: CASCADE LIQUIDATION
    // ============================================================

    function test_cascadeLiquidation() public {
        uint256[] memory sizes = new uint256[](12);
        sizes[0]  = SIZE_UNIT / 2;
        sizes[1]  = SIZE_UNIT;
        sizes[2]  = 2 * SIZE_UNIT;
        sizes[3]  = 3 * SIZE_UNIT;
        sizes[4]  = 4 * SIZE_UNIT;
        sizes[5]  = 5 * SIZE_UNIT;
        sizes[6]  = 6 * SIZE_UNIT;
        sizes[7]  = SIZE_UNIT / 4;
        sizes[8]  = SIZE_UNIT * 10;
        sizes[9]  = SIZE_UNIT * 7;
        sizes[10] = SIZE_UNIT * 8;
        sizes[11] = SIZE_UNIT / 10;

        for (uint256 i = 0; i < 12; i++) {
            _openPosition(btcMarket, traders[i], int256(sizes[i]), BTC_50K);
        }

        for (uint256 i = 0; i < 12; i++) {
            (int256 sz,,,,) = engine.positions(btcMarket, traders[i]);
            assertGt(sz, 0, "Position should be open");
        }

        // CRASH: 50% drop to $25,000
        _updatePrice(btcMarket, 25_000);

        for (uint256 i = 0; i < 12; i++) {
            assertTrue(
                engine.isLiquidatable(btcMarket, traders[i]),
                string.concat("Trader ", vm.toString(i), " should be liquidatable")
            );
        }

        uint256 totalRounds = 0;
        for (uint256 i = 0; i < 12; i++) {
            uint256 rounds = _fullyLiquidate(btcMarket, traders[i]);
            assertGt(rounds, 0, "Should have taken at least 1 round");
            totalRounds += rounds;
        }

        for (uint256 i = 0; i < 12; i++) {
            (int256 sz,,,,) = engine.positions(btcMarket, traders[i]);
            assertEq(sz, 0, string.concat("Trader ", vm.toString(i), " should be fully liquidated"));
        }

        assertEq(liquidator.totalLiquidations(), totalRounds, "Total liquidations should match rounds");
        assertEq(liquidator.keeperLiquidations(keeper), totalRounds, "Keeper count mismatch");
        assertGt(vault.balances(keeper), 0, "Keeper should have earned rewards");

        emit log_named_uint("  Total partial liquidation rounds", totalRounds);
        emit log_named_uint("  Keeper total reward", vault.balances(keeper));

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "Vault should remain healthy after cascade");
    }

    // ============================================================
    //  TEST 2: MAXIMUM LEVERAGE STRESS (50x)
    // ============================================================

    function test_maxLeverageStress() public {
        uint256 ethPrice = 3_000 * USDC_UNIT;
        address trader = traders[0];

        _openPosition(ethMarket, trader, int256(10 * SIZE_UNIT), ethPrice);

        (int256 sz,, uint256 margin,,) = engine.positions(ethMarket, trader);
        assertEq(sz, int256(10 * SIZE_UNIT), "Should hold 10 ETH long");
        assertEq(margin, 600 * USDC_UNIT, "Margin should be $600 at 50x");

        // ~1.1% drop triggers liquidation at 50x
        _updatePrice(ethMarket, 2_966);

        assertTrue(engine.isLiquidatable(ethMarket, trader), "Should be liquidatable after tiny move");

        (int256 sizeBefore,,,,) = engine.positions(ethMarket, trader);
        uint256 absBefore = uint256(sizeBefore);

        vm.prank(keeper);
        liquidator.liquidate(ethMarket, trader);

        (int256 sizeAfter,,,,) = engine.positions(ethMarket, trader);
        assertEq(
            uint256(sizeAfter),
            absBefore - absBefore / 4,
            "Should have liquidated 25% of position"
        );

        uint256 totalRounds = 1;
        while (true) {
            (int256 s,,,,) = engine.positions(ethMarket, trader);
            if (s == 0) break;
            if (!engine.isLiquidatable(ethMarket, trader)) break;
            vm.prank(keeper);
            liquidator.liquidate(ethMarket, trader);
            totalRounds++;
            require(totalRounds <= 30, "Too many rounds");
        }

        (int256 finalSize,,,,) = engine.positions(ethMarket, trader);
        assertEq(finalSize, 0, "Position should be fully closed");

        emit log_named_uint("  Rounds to fully liquidate 50x position", totalRounds);

        uint256 expectedRounds = _countRoundsToClose(10 * SIZE_UNIT);
        assertEq(totalRounds, expectedRounds, "Round count should match theoretical");
    }

    // ============================================================
    //  TEST 3: RAPID PRICE OSCILLATION
    // ============================================================

    function test_rapidPriceOscillation() public {
        for (uint256 i = 0; i < 4; i++) {
            _openPosition(btcMarket, traders[i], int256(2 * SIZE_UNIT), BTC_50K);
        }
        for (uint256 i = 4; i < 8; i++) {
            _openPosition(btcMarket, traders[i], -int256(2 * SIZE_UNIT), BTC_50K);
        }

        // PHASE 1: -30%
        _updatePrice(btcMarket, 35_000);

        for (uint256 i = 0; i < 4; i++) {
            assertTrue(engine.isLiquidatable(btcMarket, traders[i]), "Longs should be liquidatable at -30%");
        }
        for (uint256 i = 4; i < 8; i++) {
            assertFalse(engine.isLiquidatable(btcMarket, traders[i]), "Shorts should be healthy at -30%");
        }

        for (uint256 i = 0; i < 4; i++) {
            vm.prank(keeper);
            liquidator.liquidate(btcMarket, traders[i]);
        }

        uint256 liquidationsAfterPhase1 = liquidator.totalLiquidations();
        assertEq(liquidationsAfterPhase1, 4, "4 partial liquidations in phase 1");

        // PHASE 2: Recovery to $42k
        _updatePrice(btcMarket, 42_000);

        for (uint256 i = 0; i < 4; i++) {
            (int256 sz,,,,) = engine.positions(btcMarket, traders[i]);
            if (sz != 0) {
                assertTrue(
                    engine.isLiquidatable(btcMarket, traders[i]),
                    "Remaining longs should still be liquidatable after partial recovery"
                );
            }
        }

        // PHASE 3: Crash to $25,200
        _updatePrice(btcMarket, 25_200);

        for (uint256 i = 4; i < 8; i++) {
            assertFalse(engine.isLiquidatable(btcMarket, traders[i]), "Shorts should be very healthy at $25.2k");
        }

        for (uint256 i = 0; i < 4; i++) {
            _fullyLiquidate(btcMarket, traders[i]);
        }

        for (uint256 i = 0; i < 4; i++) {
            (int256 sz,,,,) = engine.positions(btcMarket, traders[i]);
            assertEq(sz, 0, "Long should be fully closed after oscillation");
        }

        for (uint256 i = 4; i < 8; i++) {
            (int256 sz,,,,) = engine.positions(btcMarket, traders[i]);
            assertEq(sz, -int256(2 * SIZE_UNIT), "Shorts should be untouched");
        }

        uint256 totalLiqs = liquidator.totalLiquidations();
        assertGt(totalLiqs, liquidationsAfterPhase1, "More liquidations should have occurred in phase 3");

        emit log_named_uint("  Total liquidation rounds across oscillation", totalLiqs);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "Vault health invariant after oscillation");
    }

    // ============================================================
    //  TEST 4: MANY SIMULTANEOUS POSITIONS (22 mixed)
    // ============================================================

    function test_manySimultaneousPositions() public {
        uint256 numLongs = 11;
        uint256 numShorts = 11;

        for (uint256 i = 0; i < numLongs; i++) {
            uint256 size = (i + 1) * SIZE_UNIT;
            _openPosition(btcMarket, traders[i], int256(size), BTC_50K);
        }

        for (uint256 i = 0; i < numShorts; i++) {
            uint256 size = (i + 1) * SIZE_UNIT;
            _openPosition(btcMarket, traders[numLongs + i], -int256(size), BTC_50K);
        }

        uint256 insuranceBefore = vault.balances(address(insurance));
        uint256 keeperBefore = vault.balances(keeper);

        _updatePrice(btcMarket, 35_000);

        for (uint256 i = 0; i < numLongs; i++) {
            assertTrue(engine.isLiquidatable(btcMarket, traders[i]), "Long should be liquidatable");
        }
        for (uint256 i = 0; i < numShorts; i++) {
            assertFalse(
                engine.isLiquidatable(btcMarket, traders[numLongs + i]),
                "Short should NOT be liquidatable"
            );
        }

        bytes32[] memory mkts = new bytes32[](numLongs);
        address[] memory addrs = new address[](numLongs);
        for (uint256 i = 0; i < numLongs; i++) {
            mkts[i] = btcMarket;
            addrs[i] = traders[i];
        }

        vm.prank(keeper);
        liquidator.liquidateBatch(mkts, addrs);

        uint256 batchLiqs = liquidator.totalLiquidations();
        assertEq(batchLiqs, numLongs, "Batch should have liquidated all 11 longs (1 partial each)");

        uint256 totalRoundsAfterBatch = 0;
        for (uint256 i = 0; i < numLongs; i++) {
            uint256 rounds = _fullyLiquidate(btcMarket, traders[i]);
            totalRoundsAfterBatch += rounds;
        }

        for (uint256 i = 0; i < numLongs; i++) {
            (int256 sz,,,,) = engine.positions(btcMarket, traders[i]);
            assertEq(sz, 0, "Long position should be fully closed");
        }

        uint256 keeperReward = vault.balances(keeper) - keeperBefore;
        assertGt(keeperReward, 0, "Keeper should have earned rewards from batch + follow-up");

        uint256 insuranceAfter = vault.balances(address(insurance));
        emit log_named_uint("  Insurance fund before", insuranceBefore);
        emit log_named_uint("  Insurance fund after", insuranceAfter);
        emit log_named_uint("  Keeper total reward", keeperReward);
        emit log_named_uint("  Batch liquidation count", batchLiqs);
        emit log_named_uint("  Follow-up rounds", totalRoundsAfterBatch);

        for (uint256 i = 0; i < numShorts; i++) {
            (int256 sz,,,,) = engine.positions(btcMarket, traders[numLongs + i]);
            assertEq(sz, -int256((i + 1) * SIZE_UNIT), "Short position should be untouched");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "Vault must remain healthy after mass liquidation");

        assertEq(
            liquidator.totalLiquidations(),
            batchLiqs + totalRoundsAfterBatch,
            "Total liquidation count should be correct"
        );
    }

    // ============================================================
    //  TEST 5: ZERO-MARGIN EDGE CASE
    // ============================================================

    function test_zeroMarginEdgeCase() public {
        address trader = traders[0];
        _openPosition(btcMarket, trader, int256(SIZE_UNIT), BTC_50K);

        (int256 sz,, uint256 margin,,) = engine.positions(btcMarket, trader);
        assertEq(sz, int256(SIZE_UNIT));
        assertEq(margin, 2_500 * USDC_UNIT);

        // Safe price
        _updatePrice(btcMarket, 48_750);
        assertFalse(engine.isLiquidatable(btcMarket, trader), "Should NOT be liquidatable above maint");

        // Just below maintenance threshold
        _updatePrice(btcMarket, 48_717);
        bool isLiq = engine.isLiquidatable(btcMarket, trader);

        if (!isLiq) {
            _updatePrice(btcMarket, 48_716);
            isLiq = engine.isLiquidatable(btcMarket, trader);
        }
        assertTrue(isLiq, "Should be liquidatable at/near maintenance threshold");

        uint256 keeperBefore = vault.balances(keeper);
        vm.prank(keeper);
        liquidator.liquidate(btcMarket, trader);

        (int256 sizeAfter,,,,) = engine.positions(btcMarket, trader);
        uint256 expectedRemaining = SIZE_UNIT - SIZE_UNIT / 4;
        assertEq(uint256(sizeAfter), expectedRemaining, "Should have 75% remaining after 1 round");

        uint256 keeperReward = vault.balances(keeper) - keeperBefore;
        assertGt(keeperReward, 0, "Keeper should earn reward even at edge margin");

        emit log_named_uint("  Keeper reward at edge case", keeperReward);

        _fullyLiquidate(btcMarket, trader);
        (int256 finalSize,,,,) = engine.positions(btcMarket, trader);
        assertEq(finalSize, 0, "Position should be fully closed");

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "Vault health after edge-case liquidation");
    }

    // ============================================================
    //  TEST 6: BATCH SCAN + LIQUIDATE
    // ============================================================

    function test_scanAndBatchLiquidate() public {
        for (uint256 i = 0; i < 10; i++) {
            _openPosition(btcMarket, traders[i], int256(SIZE_UNIT), BTC_50K);
        }
        for (uint256 i = 10; i < 15; i++) {
            _openPosition(btcMarket, traders[i], -int256(SIZE_UNIT), BTC_50K);
        }

        _updatePrice(btcMarket, 35_000);

        bytes32[] memory mkts = new bytes32[](15);
        address[] memory addrs = new address[](15);
        for (uint256 i = 0; i < 15; i++) {
            mkts[i] = btcMarket;
            addrs[i] = traders[i];
        }

        bool[] memory results = liquidator.scanLiquidatable(mkts, addrs);

        for (uint256 i = 0; i < 10; i++) {
            assertTrue(results[i], "Long should be flagged liquidatable");
        }
        for (uint256 i = 10; i < 15; i++) {
            assertFalse(results[i], "Short should NOT be flagged");
        }

        vm.prank(keeper);
        liquidator.liquidateBatch(mkts, addrs);

        assertEq(liquidator.totalLiquidations(), 10, "Only longs should have been liquidated");
    }

    // ============================================================
    //  TEST 7: PARTIAL ROUND CONVERGENCE
    // ============================================================

    function test_partialRoundConvergence() public {
        address trader = traders[0];
        _openPosition(btcMarket, trader, int256(SIZE_UNIT), BTC_50K);
        _updatePrice(btcMarket, 25_000);

        uint256 rounds = _fullyLiquidate(btcMarket, trader);
        uint256 expected = _countRoundsToClose(SIZE_UNIT);
        assertEq(rounds, expected, "1 BTC should converge in expected rounds");

        emit log_named_uint("  Rounds to close 1 BTC", rounds);

        // M-5/M-7: Warp past CB cooldown (full liquidation may trigger CB)
        vm.warp(block.timestamp + 61);
        _updatePrice(btcMarket, 50_000); // reset price for new position

        address trader2 = traders[1];
        _openPosition(btcMarket, trader2, int256(SIZE_UNIT / 100), BTC_50K);
        _updatePrice(btcMarket, 25_000);

        uint256 rounds2 = _fullyLiquidate(btcMarket, trader2);
        emit log_named_uint("  Rounds to close 0.01 BTC", rounds2);
        assertLe(rounds2, rounds, "Smaller position should need <= rounds");

        (int256 s1,,,,) = engine.positions(btcMarket, trader);
        (int256 s2,,,,) = engine.positions(btcMarket, trader2);
        assertEq(s1, 0);
        assertEq(s2, 0);
    }

    // ============================================================
    //  TEST 8: CANNOT LIQUIDATE HEALTHY POSITIONS
    // ============================================================

    function test_cannotLiquidateHealthyPosition() public {
        address trader = traders[0];
        _openPosition(btcMarket, trader, int256(SIZE_UNIT), BTC_50K);

        vm.prank(keeper);
        vm.expectRevert();
        liquidator.liquidate(btcMarket, trader);
    }

    // ============================================================
    //  TEST 9: SHORT LIQUIDATION SYMMETRY
    // ============================================================

    function test_shortLiquidationSymmetry() public {
        for (uint256 i = 0; i < 8; i++) {
            _openPosition(btcMarket, traders[i], -int256((i + 1) * SIZE_UNIT), BTC_50K);
        }

        // Price pumps 50% to $75k
        _updatePrice(btcMarket, 75_000);

        for (uint256 i = 0; i < 8; i++) {
            assertTrue(engine.isLiquidatable(btcMarket, traders[i]), "Short should be liquidatable");
        }

        uint256 keeperBefore = vault.balances(keeper);

        uint256 totalRounds = 0;
        for (uint256 i = 0; i < 8; i++) {
            totalRounds += _fullyLiquidate(btcMarket, traders[i]);
        }

        for (uint256 i = 0; i < 8; i++) {
            (int256 sz,,,,) = engine.positions(btcMarket, traders[i]);
            assertEq(sz, 0, "Short should be fully closed");
        }

        uint256 keeperReward = vault.balances(keeper) - keeperBefore;
        assertGt(keeperReward, 0, "Keeper should earn reward from short liquidations");

        emit log_named_uint("  Total rounds for 8 shorts", totalRounds);
        emit log_named_uint("  Keeper reward from shorts", keeperReward);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "Vault healthy after short liquidation cascade");
    }
}
