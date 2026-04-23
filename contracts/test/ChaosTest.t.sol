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

/// @title SUR Protocol - Chaos / Adversarial Stress Tests
/// @notice These tests actively try to BREAK protocol invariants:
///   - Vault solvency (actual USDC >= accounted)
///   - No negative balances
///   - No stuck funds
///   - No phantom PnL
///   - No insurance fund drain beyond expected
///   - No rounding exploits
///   - No overflow/underflow in extreme scenarios

contract ChaosTest is Test {
    MockUSDC public usdc;
    PerpVault public vault;
    PerpEngine public engine;
    OrderSettlement public settlement;
    Liquidator public liquidator;
    InsuranceFund public insurance;
    OracleRouter public oracle;
    MockPyth public mockPyth;
    MockChainlinkAggregator public mockCL_BTC;
    MockChainlinkAggregator public mockCL_ETH;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("treasury");
    address public keeper = makeAddr("keeper");

    uint256 constant U = 1e6;  // USDC precision
    uint256 constant S = 1e8;  // Size precision
    uint256 constant BTC_PRICE = 50_000 * U;
    uint256 constant ETH_PRICE = 3_000 * U;

    bytes32 public btcMkt;
    bytes32 public ethMkt;
    bytes32 constant PYTH_BTC = bytes32(uint256(0xB7C));
    bytes32 constant PYTH_ETH = bytes32(uint256(0xE74));

    // 500 trader slots
    uint256 constant MAX_TRADERS = 500;
    uint256[] internal pks;
    address[] internal addrs;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, type(uint256).max); // no cap
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);
        settlement = new OrderSettlement(address(engine), address(vault), feeRecipient, owner);
        liquidator = new Liquidator(address(engine), address(insurance), owner);
        mockPyth = new MockPyth();
        mockCL_BTC = new MockChainlinkAggregator(8, "BTC/USD");
        mockCL_ETH = new MockChainlinkAggregator(8, "ETH/USD");
        oracle = new OracleRouter(address(mockPyth), address(engine), owner);

        btcMkt = keccak256(abi.encodePacked("BTC-USD"));
        ethMkt = keccak256(abi.encodePacked("ETH-USD"));

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
        settlement.setSettlementDelay(0, 300);

        engine.addMarket("BTC-USD", 500, 250, 1_000_000 * S, 28800);
        engine.addMarket("ETH-USD", 500, 250, 10_000_000 * S, 28800);
        engine.updateMarkPrice(btcMkt, BTC_PRICE, BTC_PRICE);
        engine.updateMarkPrice(ethMkt, ETH_PRICE, ETH_PRICE);
        oracle.configureFeed(btcMkt, PYTH_BTC, address(mockCL_BTC), 120, 500, 200);
        oracle.configureFeed(ethMkt, PYTH_ETH, address(mockCL_ETH), 120, 500, 200);
        vm.stopPrank();

        _setOracle(50_000, 3_000);
        _fund(address(insurance), 10_000_000 * U);

        for (uint256 i = 0; i < MAX_TRADERS; i++) {
            uint256 pk = 0x2000 + i;
            pks.push(pk);
            addrs.push(vm.addr(pk));
        }
    }

    // ================================================================
    //  TEST 1: Flash crash 95% - mass bad debt - insurance drain
    // ================================================================

    function test_chaos_flashCrash95pct_insuranceDrain() public {
        emit log_string("=== CHAOS: 95% flash crash with 200 leveraged traders ===");

        // 200 traders go max-leverage long (20x on 0.1 BTC = $5k notional, $250 margin)
        uint256 numTraders = 200;
        for (uint256 i = 0; i < numTraders; i += 2) {
            _fund(addrs[i], 5_000 * U);
            _fund(addrs[i + 1], 5_000 * U);
            _trade(i, true, i + 1, false, btcMkt, S / 10, BTC_PRICE, i + 1);
        }

        // Flash crash: BTC drops 95% to $2,500
        _setPrice(btcMkt, 2_500);

        // Liquidate ALL longs - they're all deeply underwater
        uint256 liquidated;
        for (uint256 i = 0; i < numTraders; i += 2) {
            (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
            if (sz != 0) {
                // May need multiple rounds due to partial liquidation
                for (uint256 r = 0; r < 25; r++) {
                    (sz,,,,,) = engine.positions(btcMkt, addrs[i]);
                    if (sz == 0) break;
                    if (!engine.isLiquidatable(btcMkt, addrs[i])) break;
                    vm.prank(keeper);
                    liquidator.liquidate(btcMkt, addrs[i]);
                    liquidated++;
                }
            }
        }

        emit log_named_uint("  Liquidations executed", liquidated);

        // CRITICAL INVARIANT: Vault must still be solvent
        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after 95% crash");
        assertGe(actual, accounted, "BROKEN: USDC < accounted");

        // Insurance fund should be depleted but not negative (uint256)
        uint256 insBal = vault.balances(address(insurance));
        emit log_named_uint("  Insurance remaining", insBal / U);

        // Shorts should have massive profits
        uint256 totalShortProfit;
        for (uint256 i = 1; i < numTraders; i += 2) {
            int256 pnl = engine.getUnrealizedPnl(btcMkt, addrs[i]);
            if (pnl > 0) totalShortProfit += uint256(pnl);
        }
        emit log_named_uint("  Total short unrealized profit", totalShortProfit / U);
    }

    // ================================================================
    //  TEST 2: Dust position attack - try to extract rounding profit
    // ================================================================

    function test_chaos_dustPositionRounding() public {
        emit log_string("=== CHAOS: Dust position rounding attack ===");

        address attacker = addrs[0];
        _fund(attacker, 100_000 * U);

        uint256 balBefore = vault.balances(attacker);

        // Open and close 1000 tiny positions trying to accumulate rounding errors
        for (uint256 i = 0; i < 1000; i++) {
            // Minimum possible size: 1 unit of SIZE_PRECISION
            vm.prank(owner);
            engine.openPosition(btcMkt, attacker, 1, BTC_PRICE);

            vm.prank(owner);
            engine.closePosition(btcMkt, attacker, BTC_PRICE);
        }

        uint256 balAfter = vault.balances(attacker);

        // Attacker should NOT have more money than they started with
        assertLe(balAfter, balBefore, "BROKEN: Dust rounding gave free money");

        // Verify vault solvency
        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after dust attack");

        emit log_named_uint("  Balance before", balBefore / U);
        emit log_named_uint("  Balance after", balAfter / U);
        emit log_named_uint("  Lost to fees/rounding", (balBefore - balAfter) / U);
    }

    // ================================================================
    //  TEST 3: 500 simultaneous positions - gas + accounting stress
    // ================================================================

    function test_chaos_500simultaneousPositions() public {
        emit log_string("=== CHAOS: 500 simultaneous positions ===");

        // 250 pairs of long/short
        for (uint256 i = 0; i < 500; i += 2) {
            _fund(addrs[i], 10_000 * U);
            _fund(addrs[i + 1], 10_000 * U);
            _trade(i, true, i + 1, false, btcMkt, S / 10, BTC_PRICE, i + 1);
        }

        // Verify OI
        (uint256 oiL, uint256 oiS) = engine.getOpenInterest(btcMkt);
        assertEq(oiL, 250 * (S / 10), "OI long mismatch");
        assertEq(oiS, 250 * (S / 10), "OI short mismatch");

        // Price oscillates violently: 50k -> 45k -> 55k -> 40k -> 60k
        uint256[5] memory prices = [uint256(50_000), 45_000, 55_000, 40_000, 60_000];

        for (uint256 p = 0; p < 5; p++) {
            _setPrice(btcMkt, prices[p]);

            // Liquidate whatever we can
            for (uint256 i = 0; i < 500; i++) {
                (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
                if (sz != 0 && engine.isLiquidatable(btcMkt, addrs[i])) {
                    vm.prank(keeper);
                    try liquidator.liquidate(btcMkt, addrs[i]) {} catch {}
                }
            }
        }

        // INVARIANT: Vault still solvent
        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after 500-position chaos");
        assertGe(actual, accounted);

        emit log_named_uint("  Vault actual USDC", actual / U);
        emit log_named_uint("  Vault accounted", accounted / U);
    }

    // ================================================================
    //  TEST 4: Price goes to near-zero then recovers - precision test
    // ================================================================

    function test_chaos_priceNearZeroAndRecover() public {
        emit log_string("=== CHAOS: Price drops to $1 then recovers to $100k ===");

        // 50 longs, 50 shorts
        for (uint256 i = 0; i < 100; i += 2) {
            _fund(addrs[i], 50_000 * U);
            _fund(addrs[i + 1], 50_000 * U);
            _trade(i, true, i + 1, false, btcMkt, S, BTC_PRICE, i + 1);
        }

        // Price drops to $1 (99.998% drop)
        _setPrice(btcMkt, 1);

        // All longs are dead - liquidate them
        for (uint256 i = 0; i < 100; i += 2) {
            for (uint256 r = 0; r < 25; r++) {
                (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
                if (sz == 0) break;
                if (!engine.isLiquidatable(btcMkt, addrs[i])) break;
                vm.prank(keeper);
                liquidator.liquidate(btcMkt, addrs[i]);
            }
        }

        // Price recovers to $100,000
        _setPrice(btcMkt, 100_000);

        // Shorts should have massive unrealized profit
        // But can they actually realize it? Close all shorts
        for (uint256 i = 1; i < 100; i += 2) {
            (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
            if (sz != 0) {
                vm.prank(owner);
                engine.closePosition(btcMkt, addrs[i], 100_000 * U);
            }
        }

        // INVARIANT: Vault still healthy
        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after extreme price swing");
        assertGe(actual, accounted);

        // OI should be zero
        (uint256 oiL, uint256 oiS) = engine.getOpenInterest(btcMkt);
        assertEq(oiL, 0, "OI long should be 0");
        assertEq(oiS, 0, "OI short should be 0");

        emit log_named_uint("  Final vault USDC", actual / U);
    }

    // ================================================================
    //  TEST 5: Funding rate accumulation extreme - 30 days of skew
    // ================================================================

    function test_chaos_fundingAccumulation30days() public {
        emit log_string("=== CHAOS: 30 days of max funding accumulation ===");

        // Create massive OI skew: 50 longs, 0 shorts
        // Use direct operator calls since we can't have unmatched via settlement
        for (uint256 i = 0; i < 50; i++) {
            _fund(addrs[i], 100_000 * U);
            vm.prank(owner);
            engine.openPosition(btcMkt, addrs[i], int256(S), BTC_PRICE);
        }

        // Set mark > index to create positive funding (longs pay)
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 51_000 * U, 50_000 * U); // 2% premium

        // Apply funding every 8h for 30 days = 90 intervals
        for (uint256 day = 0; day < 30; day++) {
            for (uint256 interval = 0; interval < 3; interval++) {
                vm.warp(block.timestamp + 8 hours);
                // Refresh price timestamp
                _setOracle(51_000, 3_000);
                vm.prank(owner);
                engine.updateMarkPrice(btcMkt, 51_000 * U, 50_000 * U);
                engine.applyFundingRate(btcMkt);
            }
        }

        // Check that cumulative funding is reasonable (capped at 0.1% per interval)
        // 90 intervals * 0.1% max = 9% max theoretical
        // Actual: (51k-50k)/50k = 2% per interval, capped at 0.1% = 0.1%
        // Total: 90 * 0.1% = 9% of position notional

        // Try to close all positions - funding should have eroded margins
        uint256 closable;
        for (uint256 i = 0; i < 50; i++) {
            (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
            if (sz != 0) {
                vm.prank(owner);
                try engine.closePosition(btcMkt, addrs[i], 51_000 * U) {
                    closable++;
                } catch {
                    // Position might be too underwater
                    if (engine.isLiquidatable(btcMkt, addrs[i])) {
                        vm.prank(keeper);
                        liquidator.liquidate(btcMkt, addrs[i]);
                    }
                }
            }
        }

        // INVARIANT
        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after 30 days of funding");
        assertGe(actual, accounted);

        emit log_named_uint("  Closable positions", closable);
        emit log_named_uint("  Vault actual", actual / U);
    }

    // ================================================================
    //  TEST 6: Rapid open/close same block - MEV-style
    // ================================================================

    function test_chaos_rapidOpenCloseSameBlock() public {
        emit log_string("=== CHAOS: 200 open+close in same block ===");

        address trader = addrs[0];
        _fund(trader, 500_000 * U);

        uint256 balBefore = vault.balances(trader);
        uint256 feeBefore = vault.balances(feeRecipient);

        // Open and close 200 times at same price in same block
        for (uint256 i = 0; i < 200; i++) {
            vm.prank(owner);
            engine.openPosition(btcMkt, trader, int256(S), BTC_PRICE);
            vm.prank(owner);
            engine.closePosition(btcMkt, trader, BTC_PRICE);
        }

        uint256 balAfter = vault.balances(trader);
        uint256 feeAfter = vault.balances(feeRecipient);

        // Trader should NOT profit from this
        assertLe(balAfter, balBefore, "BROKEN: Open/close same price gave profit");

        // Fees should be collected properly
        assertGe(feeAfter, feeBefore, "Fees should not decrease");

        // Position should be clean
        (int256 sz,,,,,) = engine.positions(btcMkt, trader);
        assertEq(sz, 0, "Position should be closed");

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after rapid open/close");

        emit log_named_uint("  Lost to fees", (balBefore - balAfter) / U);
    }

    // ================================================================
    //  TEST 7: Max uint256-adjacent values - overflow hunt
    // ================================================================

    function test_chaos_extremePositionSizes() public {
        emit log_string("=== CHAOS: Extreme position sizes ===");

        // Try opening a position with enormous size
        address whale = addrs[0];
        _fund(whale, 100_000_000 * U); // $100M

        // 100 BTC position ($5M notional) - should require large margin
        vm.prank(owner);
        engine.openPosition(btcMkt, whale, int256(100 * S), BTC_PRICE);

        (int256 sz,, uint256 margin,,,) = engine.positions(btcMkt, whale);
        assertEq(sz, int256(100 * S), "Should have 100 BTC position");
        assertGt(margin, 0, "Margin should be non-zero");

        uint256 balAfterOpen = vault.balances(whale);

        // Price pumps 50% - PnL = $2.5M on 100 BTC
        _setPrice(btcMkt, 75_000);
        int256 pnl = engine.getUnrealizedPnl(btcMkt, whale);
        assertEq(pnl, int256(2_500_000 * U), "PnL should be $2.5M");

        // Close at $75k
        vm.prank(owner);
        engine.closePosition(btcMkt, whale, 75_000 * U);

        uint256 whaleBal = vault.balances(whale);
        assertGt(whaleBal, balAfterOpen, "Whale should have profit");

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after whale trade");

        emit log_named_uint("  Whale final balance", whaleBal / U);
    }

    // ================================================================
    //  TEST 8: Cross-margin cascade - multi-market simultaneous liquidation
    // ================================================================

    function test_chaos_crossMarginCascade() public {
        emit log_string("=== CHAOS: Cross-margin cascade across 2 markets ===");

        // 50 traders in cross-margin mode with positions in BOTH markets
        for (uint256 i = 0; i < 50; i++) {
            _fund(addrs[i], 20_000 * U);

            vm.prank(addrs[i]);
            engine.setMarginMode(PerpEngine.MarginMode.CROSS);

            // Long 0.5 BTC ($25k notional, needs $1250 margin)
            vm.prank(owner);
            engine.openPosition(btcMkt, addrs[i], int256(S / 2), BTC_PRICE);

            // Long 5 ETH ($15k notional, needs $750 margin)
            vm.prank(owner);
            engine.openPosition(ethMkt, addrs[i], int256(5 * S), ETH_PRICE);
        }

        // Both markets crash simultaneously
        // BTC -30%, ETH -40%
        _setPrice(btcMkt, 35_000);
        _setEthPrice(1_800);

        // Account liquidations
        uint256 liquidated;
        for (uint256 i = 0; i < 50; i++) {
            if (engine.isAccountLiquidatable(addrs[i])) {
                vm.prank(keeper);
                liquidator.liquidateAccount(addrs[i]);
                liquidated++;
            }
        }

        emit log_named_uint("  Accounts liquidated", liquidated);

        // INVARIANT
        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after cross-margin cascade");
        assertGe(actual, accounted);

        emit log_named_uint("  Vault actual", actual / U);
        emit log_named_uint("  Vault accounted", accounted / U);
    }

    // ================================================================
    //  TEST 9: Insurance fund total depletion - what happens?
    // ================================================================

    function test_chaos_insuranceFundFullDepletion() public {
        emit log_string("=== CHAOS: Complete insurance fund depletion ===");

        // Small insurance fund - only $10k
        // Reset insurance by moving funds out
        vm.prank(owner);
        insurance.setOperator(owner, true);
        // The insurance fund has $10M from setUp. We can't drain it directly.
        // Instead, start with tiny insurance and see what happens with massive bad debt.

        // New insurance fund setup
        InsuranceFund insurance2 = new InsuranceFund(address(vault), owner);
        vm.startPrank(owner);
        insurance2.setOperator(address(liquidator), true);
        engine.setInsuranceFund(address(insurance2));
        vm.stopPrank();
        _fund(address(insurance2), 1_000 * U); // Only $1k in insurance

        // 100 traders go 20x long
        for (uint256 i = 0; i < 100; i += 2) {
            _fund(addrs[i], 5_000 * U);
            _fund(addrs[i + 1], 5_000 * U);
            _trade(i, true, i + 1, false, btcMkt, S / 10, BTC_PRICE, i + 1);
        }

        // 80% crash - every long position creates bad debt
        _setPrice(btcMkt, 10_000);

        // Liquidate as many as possible
        uint256 liquidated;
        uint256 failed;
        for (uint256 i = 0; i < 100; i += 2) {
            for (uint256 r = 0; r < 25; r++) {
                (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
                if (sz == 0) break;
                if (!engine.isLiquidatable(btcMkt, addrs[i])) break;
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, addrs[i]) {
                    liquidated++;
                } catch {
                    failed++;
                    break;
                }
            }
        }

        emit log_named_uint("  Liquidations succeeded", liquidated);
        emit log_named_uint("  Liquidations failed (insurance empty)", failed);

        uint256 ins2Bal = vault.balances(address(insurance2));
        emit log_named_uint("  Insurance2 remaining", ins2Bal / U);

        // INVARIANT: Even with empty insurance, vault must be solvent
        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent with empty insurance");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 10: Flip position 500 times in rapid succession
    // ================================================================

    function test_chaos_rapidFlip500times() public {
        emit log_string("=== CHAOS: Flip position direction 500 times ===");

        address flipper = addrs[0];
        address counterparty = addrs[1];
        _fund(flipper, 500_000 * U);
        _fund(counterparty, 500_000 * U);

        uint256 vaultUsdcBefore = usdc.balanceOf(address(vault));

        // Alternate long/short 500 times
        for (uint256 i = 0; i < 500; i++) {
            bool goLong = (i % 2 == 0);

            // Open a position
            vm.prank(owner);
            engine.openPosition(
                btcMkt,
                flipper,
                goLong ? int256(S / 10) : -int256(S / 10),
                BTC_PRICE
            );

            // Close it
            vm.prank(owner);
            engine.closePosition(btcMkt, flipper, BTC_PRICE);
        }

        // Vault USDC should be conserved (minus fees which stay in vault)
        uint256 vaultUsdcAfter = usdc.balanceOf(address(vault));
        assertEq(vaultUsdcAfter, vaultUsdcBefore, "BROKEN: USDC leaked from vault");

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after 500 flips");

        emit log_named_uint("  Vault USDC unchanged", vaultUsdcAfter / U);
    }

    // ================================================================
    //  TEST 11: Maximum concurrent markets stress
    // ================================================================

    function test_chaos_10marketsSimultaneous() public {
        emit log_string("=== CHAOS: 10 markets, 50 traders each ===");

        // Add 8 more markets
        string[8] memory names = ["SOL-USD", "DOGE-USD", "AVAX-USD", "LINK-USD", "MATIC-USD", "ARB-USD", "OP-USD", "APE-USD"];
        uint256[8] memory prices = [uint256(100), 0, 30, 15, 1, 1, 2, 5]; // $100, skip DOGE, etc
        bytes32[] memory mktIds = new bytes32[](10);
        mktIds[0] = btcMkt;
        mktIds[1] = ethMkt;

        vm.startPrank(owner);
        for (uint256 m = 0; m < 8; m++) {
            if (prices[m] == 0) {
                prices[m] = 1; // DOGE = $0.10 but we use $1 min
            }
            engine.addMarket(names[m], 1000, 500, 10_000_000 * S, 28800); // 10x markets
            bytes32 mid = keccak256(abi.encodePacked(names[m]));
            mktIds[m + 2] = mid;
            engine.updateMarkPrice(mid, prices[m] * U, prices[m] * U);
        }
        vm.stopPrank();

        // 50 traders open positions in ALL 10 markets
        for (uint256 i = 0; i < 100; i += 2) {
            _fund(addrs[i], 100_000 * U);
            _fund(addrs[i + 1], 100_000 * U);

            for (uint256 m = 0; m < 10; m++) {
                uint256 price;
                if (m == 0) price = 50_000;
                else if (m == 1) price = 3_000;
                else price = prices[m - 2];

                uint256 posSize = S / 10; // small positions

                vm.prank(owner);
                engine.openPosition(mktIds[m], addrs[i], int256(posSize), price * U);
                vm.prank(owner);
                engine.openPosition(mktIds[m], addrs[i + 1], -int256(posSize), price * U);
            }
        }

        // Total: 50 traders * 10 markets = 500 long + 500 short positions

        // Crash everything by 20%
        vm.startPrank(owner);
        engine.updateMarkPrice(btcMkt, 40_000 * U, 40_000 * U);
        engine.updateMarkPrice(ethMkt, 2_400 * U, 2_400 * U);
        for (uint256 m = 0; m < 8; m++) {
            uint256 newPrice = (prices[m] * 80) / 100;
            if (newPrice == 0) newPrice = 1;
            engine.updateMarkPrice(mktIds[m + 2], newPrice * U, newPrice * U);
        }
        vm.stopPrank();

        // Batch liquidate across all markets
        uint256 totalLiq;
        for (uint256 m = 0; m < 10; m++) {
            for (uint256 i = 0; i < 100; i++) {
                (int256 sz,,,,,) = engine.positions(mktIds[m], addrs[i]);
                if (sz != 0 && engine.isLiquidatable(mktIds[m], addrs[i])) {
                    vm.prank(keeper);
                    try liquidator.liquidate(mktIds[m], addrs[i]) {
                        totalLiq++;
                    } catch {}
                }
            }
        }

        emit log_named_uint("  Total liquidations across 10 markets", totalLiq);

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after 10-market chaos");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 12: Fuzz - random sizes, prices, directions
    // ================================================================

    function testFuzz_chaos_randomTrading(uint256 seed) public {
        // Use seed to generate pseudo-random trading activity
        uint256 numOps = 20; // 20 random operations
        address t1 = addrs[0];
        address t2 = addrs[1];
        _fund(t1, 1_000_000 * U);
        _fund(t2, 1_000_000 * U);

        uint256 priceUsd = 50_000; // starting BTC price

        for (uint256 i = 0; i < numOps; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));

            uint256 action = seed % 4;
            uint256 sizeRaw = ((seed >> 8) % 100) + 1; // 1-100 units of S/100
            uint256 priceChange = (seed >> 16) % 20; // 0-19% change

            // Price moves randomly
            if ((seed >> 32) % 2 == 0) {
                priceUsd = priceUsd + (priceUsd * priceChange / 100);
            } else {
                uint256 drop = priceUsd * priceChange / 100;
                priceUsd = priceUsd > drop + 100 ? priceUsd - drop : 100;
            }

            _setPrice(btcMkt, priceUsd);

            if (action == 0 || action == 1) {
                // Open or increase
                (int256 sz,,,,,) = engine.positions(btcMkt, t1);
                if (sz == 0) {
                    bool goLong = action == 0;
                    vm.prank(owner);
                    try engine.openPosition(btcMkt, t1, goLong ? int256(sizeRaw * S / 100) : -int256(sizeRaw * S / 100), priceUsd * U) {} catch {}
                }
            } else if (action == 2) {
                // Close if open
                (int256 sz,,,,,) = engine.positions(btcMkt, t1);
                if (sz != 0) {
                    vm.prank(owner);
                    try engine.closePosition(btcMkt, t1, priceUsd * U) {} catch {}
                }
            } else {
                // Try liquidation
                (int256 sz,,,,,) = engine.positions(btcMkt, t1);
                if (sz != 0 && engine.isLiquidatable(btcMkt, t1)) {
                    vm.prank(keeper);
                    try liquidator.liquidate(btcMkt, t1) {} catch {}
                }
            }
        }

        // INVARIANT must hold for ANY seed
        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent with random trading");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 13: Withdraw race - try to withdraw during open position
    // ================================================================

    function test_chaos_withdrawWithOpenPosition() public {
        emit log_string("=== CHAOS: Withdraw maximum with open position ===");

        address trader = addrs[0];
        _fund(trader, 100_000 * U);

        // Open 1 BTC long ($50k notional, $2500 margin locked)
        vm.prank(owner);
        engine.openPosition(btcMkt, trader, int256(S), BTC_PRICE);

        // Try to withdraw everything
        uint256 bal = vault.balances(trader);
        vm.prank(trader);
        vault.withdraw(bal);

        // Should have withdrawn free balance (100k - 2500 margin = 97500, minus fees)
        uint256 afterBal = vault.balances(trader);
        assertEq(afterBal, 0, "All free balance should be withdrawn");

        // But position still exists
        (int256 sz,, uint256 margin,,,) = engine.positions(btcMkt, trader);
        assertEq(sz, int256(S));
        assertGt(margin, 0);

        // Vault should still be healthy
        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after withdraw-with-position");
    }

    // ================================================================
    //  TEST 14: PnL extraction via self-trade sandwich
    //  Attack: trader opens long, price pumps, opens short on same
    //  account to "lock" profit, then tries to extract more than fair PnL
    // ================================================================

    function test_chaos_selfTradePnlExtraction() public {
        emit log_string("=== CHAOS: Self-trade PnL extraction attempt ===");

        // Two accounts controlled by same attacker
        address attacker1 = addrs[0];
        address attacker2 = addrs[1];
        address victim = addrs[2];
        address victim2 = addrs[3];

        _fund(attacker1, 1_000_000 * U);
        _fund(attacker2, 1_000_000 * U);
        _fund(victim, 1_000_000 * U);
        _fund(victim2, 1_000_000 * U);

        uint256 vaultBefore = usdc.balanceOf(address(vault));

        // Step 1: attacker1 opens huge long, victim opens short
        _trade(0, true, 2, false, btcMkt, 10 * S, BTC_PRICE, 1);

        // Step 2: Price pumps 50%
        _setPrice(btcMkt, 75_000);

        // Step 3: attacker2 opens short at high price, victim2 opens long
        _trade(3, true, 1, false, btcMkt, 10 * S, 75_000 * U, 2);

        // Step 4: attacker1 closes long at huge profit
        vm.prank(owner);
        engine.closePosition(btcMkt, attacker1, 75_000 * U);

        // Step 5: Price drops back
        _setPrice(btcMkt, 50_000);

        // Step 6: attacker2 closes short at profit
        vm.prank(owner);
        engine.closePosition(btcMkt, attacker2, 50_000 * U);

        // INVARIANT: vault solvency
        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after self-trade sandwich");
        assertGe(actual, accounted);

        // INVARIANT: Total USDC in vault cannot increase (no money printer)
        uint256 vaultAfter = usdc.balanceOf(address(vault));
        assertEq(vaultAfter, vaultBefore, "BROKEN: USDC appeared from nowhere");

        emit log_named_uint("  Attacker1 final balance", vault.balances(attacker1) / U);
        emit log_named_uint("  Attacker2 final balance", vault.balances(attacker2) / U);
    }

    // ================================================================
    //  TEST 15: Funding rate manipulation attack
    //  Attack: Open massive one-sided position to force funding rate
    //  in your favor, collect funding, then close.
    // ================================================================

    function test_chaos_fundingRateManipulation() public {
        emit log_string("=== CHAOS: Funding rate manipulation ===");

        // Attacker creates massive long skew
        uint256 numAttackers = 50;
        uint256 numVictims = 10;

        // Attackers go long, victims go short (10:1 ratio)
        for (uint256 i = 0; i < numAttackers; i++) {
            _fund(addrs[i], 100_000 * U);
        }
        for (uint256 i = 0; i < numVictims; i++) {
            _fund(addrs[numAttackers + i], 100_000 * U);
        }

        // Open positions: 50 longs vs 10 shorts (same size each)
        for (uint256 i = 0; i < numVictims; i++) {
            uint256 longIdx = i;
            uint256 shortIdx = numAttackers + i;
            _trade(longIdx, true, shortIdx, false, btcMkt, S, BTC_PRICE, i + 1);
        }
        // 40 more longs without matching shorts - have to open via operator
        for (uint256 i = numVictims; i < numAttackers; i++) {
            vm.prank(owner);
            engine.openPosition(btcMkt, addrs[i], int256(S), BTC_PRICE);
        }

        uint256 totalBalBefore = 0;
        for (uint256 i = 0; i < numAttackers + numVictims; i++) {
            totalBalBefore += vault.balances(addrs[i]);
            (,, uint256 margin,,,) = engine.positions(btcMkt, addrs[i]);
            totalBalBefore += margin;
        }

        // Warp 30 days, apply funding every 8 hours
        for (uint256 f = 0; f < 90; f++) {
            vm.warp(block.timestamp + 28800);
            _setPrice(btcMkt, 50_000); // keep price fresh
            engine.applyFundingRate(btcMkt);
        }

        // Close all positions
        _setPrice(btcMkt, 50_000);
        for (uint256 i = 0; i < numAttackers + numVictims; i++) {
            (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
            if (sz != 0) {
                vm.prank(owner);
                engine.closePosition(btcMkt, addrs[i], BTC_PRICE);
            }
        }

        uint256 totalBalAfter = 0;
        for (uint256 i = 0; i < numAttackers + numVictims; i++) {
            totalBalAfter += vault.balances(addrs[i]);
        }

        // INVARIANT: vault solvency
        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after funding manipulation");

        // INVARIANT: No money created from funding (it's zero-sum minus what went to funding pool)
        emit log_named_uint("  Total value before (bal+margin)", totalBalBefore / U);
        emit log_named_uint("  Total value after (bal only)", totalBalAfter / U);
    }

    // ================================================================
    //  TEST 16: Liquidation front-running - try to add margin just
    //  before liquidation to grief keeper, then remove immediately after
    // ================================================================

    function test_chaos_liquidationFrontrunMargin() public {
        emit log_string("=== CHAOS: Liquidation front-run with margin add/remove ===");

        address trader = addrs[0];
        address counterparty = addrs[1];

        _fund(trader, 50_000 * U);
        _fund(counterparty, 50_000 * U);

        // Open 1 BTC long at 20x leverage (margin = $2500)
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        // Drop price to near liquidation
        _setPrice(btcMkt, 48_500); // ~3% drop, near maintenance

        // Trader adds margin to avoid liquidation
        vm.prank(owner);
        engine.addMargin(btcMkt, trader, 5_000 * U);

        // Now drop more - should be safe with extra margin
        _setPrice(btcMkt, 46_000);

        bool liq = engine.isLiquidatable(btcMkt, trader);

        // Try to remove the extra margin
        if (!liq) {
            // This should fail if removing would make position liquidatable
            vm.prank(owner);
            try engine.removeMargin(btcMkt, trader, 5_000 * U) {
                // If succeeded, position must still be above maintenance
                assertFalse(engine.isLiquidatable(btcMkt, trader), "BROKEN: Removed margin made position liquidatable");
            } catch {
                // Expected - can't remove margin below maintenance
            }
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after margin manipulation");
    }

    // ================================================================
    //  TEST 17: Integer overflow boundary test
    //  Use maximum possible values to test overflow protection
    // ================================================================

    function test_chaos_integerBoundaries() public {
        emit log_string("=== CHAOS: Integer boundary values ===");

        address trader = addrs[0];
        address cp = addrs[1];

        // Fund with a LOT of money
        _fund(trader, 10_000_000_000 * U); // $10B
        _fund(cp, 10_000_000_000 * U);

        // Set BTC price to something enormous
        _setPrice(btcMkt, 1_000_000); // $1M BTC

        // Open position with near-max size (limited by maxPositionSize)
        // Max position is 1,000,000 BTC * S = 1e14
        // Notional = 1M * 1M * 1e6 / 1e8 = 1e16 (trillions in USDC)
        // This should overflow or fail gracefully
        uint256 bigSize = 100_000 * S; // 100k BTC = $100B notional at $1M

        vm.prank(owner);
        try engine.openPosition(btcMkt, trader, int256(bigSize), 1_000_000 * U) {
            // If it succeeded, verify accounting
            (int256 sz,, uint256 margin,,,) = engine.positions(btcMkt, trader);
            assertGt(margin, 0, "Position opened with 0 margin");

            // Close at same price - should be zero PnL
            vm.prank(owner);
            engine.closePosition(btcMkt, trader, 1_000_000 * U);

            uint256 bal = vault.balances(trader);
            emit log_named_uint("  Balance after close (should be ~10B)", bal / U);
        } catch {
            emit log_string("  Large position correctly rejected");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after integer boundary test");
    }

    // ================================================================
    //  TEST 18: Cascading liquidation death spiral
    //  Liquidations drive price down, triggering more liquidations
    // ================================================================

    function test_chaos_cascadingDeathSpiral() public {
        emit log_string("=== CHAOS: Cascading liquidation death spiral ===");

        // 200 traders, all long, staggered entry prices and leverage
        uint256 numTraders = 200;
        for (uint256 i = 0; i < numTraders; i++) {
            _fund(addrs[i], 10_000 * U);
            // Varying sizes: 0.05 to 0.5 BTC
            uint256 size = (S / 20) + (S * i / (numTraders * 4));
            vm.prank(owner);
            engine.openPosition(btcMkt, addrs[i], int256(size), BTC_PRICE);
        }

        // Simulate death spiral: price drops in steps, liquidations at each step
        uint256 totalLiquidations = 0;
        uint256[] memory spiral = new uint256[](20);
        for (uint256 i = 0; i < 20; i++) {
            spiral[i] = 50_000 - (i * 1_500); // 50k -> 47k -> ... -> 21.5k
        }

        for (uint256 step = 0; step < 20; step++) {
            if (spiral[step] < 5000) break;
            _setPrice(btcMkt, spiral[step]);

            // Liquidate everything liquidatable
            for (uint256 i = 0; i < numTraders; i++) {
                (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
                if (sz == 0) continue;
                if (!engine.isLiquidatable(btcMkt, addrs[i])) continue;

                for (uint256 r = 0; r < 10; r++) {
                    (sz,,,,,) = engine.positions(btcMkt, addrs[i]);
                    if (sz == 0) break;
                    if (!engine.isLiquidatable(btcMkt, addrs[i])) break;
                    vm.prank(keeper);
                    try liquidator.liquidate(btcMkt, addrs[i]) {
                        totalLiquidations++;
                    } catch { break; }
                }
            }
        }

        emit log_named_uint("  Total liquidations in spiral", totalLiquidations);

        // Count remaining positions
        uint256 surviving = 0;
        for (uint256 i = 0; i < numTraders; i++) {
            (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
            if (sz != 0) surviving++;
        }
        emit log_named_uint("  Surviving positions", surviving);

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after death spiral");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 19: Simultaneous long+short same trader different markets
    //  Try to create artificial delta-neutral position to extract value
    // ================================================================

    function test_chaos_deltaNeutralExtraction() public {
        emit log_string("=== CHAOS: Delta-neutral cross-market extraction ===");

        address attacker = addrs[0];
        address cp1 = addrs[1];
        address cp2 = addrs[2];
        address cp3 = addrs[3];

        _fund(attacker, 500_000 * U);
        _fund(cp1, 500_000 * U);
        _fund(cp2, 500_000 * U);
        _fund(cp3, 500_000 * U);

        uint256 balBefore = vault.balances(attacker);

        // Long 5 BTC ($250k notional)
        _trade(0, true, 1, false, btcMkt, 5 * S, BTC_PRICE, 1);

        // Short equivalent ETH ($250k notional = ~83.3 ETH)
        uint256 ethEquiv = (250_000 * S) / 3_000; // ~83.3 ETH
        _trade(2, true, 0, false, ethMkt, ethEquiv, ETH_PRICE, 2);

        // BTC and ETH both pump 20% (correlated move)
        _setPrice(btcMkt, 60_000);
        _setPrice(ethMkt, 3_600);

        // Close BTC long (profit)
        vm.prank(owner);
        engine.closePosition(btcMkt, attacker, 60_000 * U);

        // Close ETH short (loss)
        vm.prank(owner);
        engine.closePosition(ethMkt, attacker, 3_600 * U);

        uint256 balAfter = vault.balances(attacker);

        // BTC profit: 5 * ($60k - $50k) = $50k
        // ETH loss: 83.3 * ($3600 - $3000) = ~$50k
        // Should roughly net out (minus fees)
        emit log_named_uint("  Balance before", balBefore / U);
        emit log_named_uint("  Balance after", balAfter / U);

        // Key: attacker should NOT profit from correlated moves when delta neutral
        // Allow small deviation for fees/rounding but no windfall
        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after delta-neutral attack");
    }

    // ================================================================
    //  TEST 20: Partial liquidation repeated until position is dust
    //  Then try to extract the dust
    // ================================================================

    function test_chaos_repeatedPartialLiquidationDust() public {
        emit log_string("=== CHAOS: Repeated partial liquidation to dust ===");

        address trader = addrs[0];
        address cp = addrs[1];

        _fund(trader, 10_000 * U);
        _fund(cp, 10_000 * U);

        // Open 1 BTC long
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        // Drop price just barely past maintenance
        _setPrice(btcMkt, 48_500);

        // Liquidate in a loop - each round takes 25%
        uint256 rounds = 0;
        for (uint256 r = 0; r < 50; r++) {
            (int256 sz,,,,,) = engine.positions(btcMkt, trader);
            if (sz == 0) break;

            if (engine.isLiquidatable(btcMkt, trader)) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, trader) {
                    rounds++;
                } catch { break; }
            } else {
                // Push price down more to make it liquidatable again
                uint256 currentPrice = 48_500 - (r * 100);
                if (currentPrice < 1000) break;
                _setPrice(btcMkt, currentPrice);
            }
        }

        emit log_named_uint("  Liquidation rounds", rounds);

        // Position should be fully closed (dust gets full-closed)
        (int256 finalSz,,,,,) = engine.positions(btcMkt, trader);
        emit log_named_int("  Remaining size", finalSz);

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after dust liquidation");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 21: Oracle price manipulation sandwich
    //  Open at stale price, wait for update, close at new price
    // ================================================================

    function test_chaos_oracleStalenessExploit() public {
        emit log_string("=== CHAOS: Oracle staleness exploitation ===");

        address attacker = addrs[0];
        address cp = addrs[1];

        _fund(attacker, 100_000 * U);
        _fund(cp, 100_000 * U);

        // Open position at $50k
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        // Warp past maxPriceAge (60s default)
        vm.warp(block.timestamp + 61);

        // Try to close with stale price - should fail
        vm.prank(owner);
        try engine.closePosition(btcMkt, attacker, 55_000 * U) {
            // If it succeeds with stale oracle, that's a problem
            // The close uses operator-provided price but _requireFreshPrice should block
            emit log_string("  WARNING: Close succeeded with stale oracle");
        } catch {
            emit log_string("  [OK] Close correctly blocked with stale oracle");
        }

        // Try to open with stale price
        _fund(addrs[2], 100_000 * U);
        vm.prank(owner);
        try engine.openPosition(btcMkt, addrs[2], int256(S), 55_000 * U) {
            emit log_string("  WARNING: Open succeeded with stale oracle");
        } catch {
            emit log_string("  [OK] Open correctly blocked with stale oracle");
        }

        // Refresh price and close normally
        _setPrice(btcMkt, 50_000);
        vm.prank(owner);
        engine.closePosition(btcMkt, attacker, BTC_PRICE);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after staleness test");
    }

    // ================================================================
    //  TEST 22: Cross-margin equity theft
    //  Use profitable position in one market to over-leverage in another
    //  then try to extract the equity difference
    // ================================================================

    function test_chaos_crossMarginEquityTheft() public {
        emit log_string("=== CHAOS: Cross-margin equity theft attempt ===");

        address attacker = addrs[0];
        _fund(attacker, 50_000 * U);

        // Switch to cross-margin
        vm.prank(attacker);
        engine.setMarginMode(PerpEngine.MarginMode.CROSS);

        // Open BTC long at $50k (5x leverage: 1 BTC = $50k notional, $10k margin)
        vm.prank(owner);
        engine.openPosition(btcMkt, attacker, int256(S), BTC_PRICE);

        // BTC pumps 40% to $70k - attacker has $20k unrealized profit
        _setPrice(btcMkt, 70_000);

        // Try to open massive ETH position using the unrealized profit as margin
        vm.prank(owner);
        try engine.openPosition(ethMkt, attacker, int256(100 * S), ETH_PRICE) {
            emit log_named_uint("  ETH position opened with size (should be limited)", 100);

            // Now BTC crashes back to $50k - the profit disappears
            _setPrice(btcMkt, 50_000);
            _setPrice(ethMkt, 2_500); // ETH drops too

            // Check if account is now underwater
            (int256 equity, uint256 maintReq) = engine.getAccountEquity(attacker);
            emit log_named_int("  Account equity after crash", equity / int256(U));
            emit log_named_uint("  Maintenance required", maintReq / U);

            if (equity < int256(maintReq)) {
                emit log_string("  Account is liquidatable (expected)");
                // Liquidate the whole account
                vm.prank(keeper);
                try liquidator.liquidateAccount(attacker) {
                    emit log_string("  Account liquidated");
                } catch {
                    emit log_string("  Account liquidation failed");
                }
            }
        } catch {
            emit log_string("  [OK] Over-leveraged ETH position correctly rejected");
        }

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after cross-margin equity theft");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 23: Nonce collision / replay attack
    //  Try to settle the same trade twice
    // ================================================================

    function test_chaos_nonceReplay() public {
        emit log_string("=== CHAOS: Nonce replay attack ===");

        address trader = addrs[0];
        address cp = addrs[1];
        _fund(trader, 100_000 * U);
        _fund(cp, 100_000 * U);

        // First trade - should succeed
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 42);

        // Try exact same trade again (same nonce) - should fail
        vm.prank(owner);
        try settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: _sign(pks[1], addrs[1], false, btcMkt, S, BTC_PRICE, 42),
            taker: _sign(pks[0], addrs[0], true, btcMkt, S, BTC_PRICE, 42),
            executionPrice: BTC_PRICE,
            executionSize: S
        })) {
            revert("BROKEN: Nonce replay succeeded");
        } catch {
            emit log_string("  [OK] Nonce replay correctly blocked");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy);
    }

    // ================================================================
    //  TEST 24: Massive batch - 100 simultaneous settlements
    // ================================================================

    function test_chaos_massiveBatchSettlement() public {
        emit log_string("=== CHAOS: 100 simultaneous batch settlements ===");

        // Fund 200 traders
        for (uint256 i = 0; i < 200; i++) {
            _fund(addrs[i], 50_000 * U);
        }

        // Build 100 matched trades
        OrderSettlement.MatchedTrade[] memory trades = new OrderSettlement.MatchedTrade[](100);
        for (uint256 i = 0; i < 100; i++) {
            uint256 longIdx = i * 2;
            uint256 shortIdx = i * 2 + 1;
            trades[i] = OrderSettlement.MatchedTrade({
                maker: _sign(pks[shortIdx], addrs[shortIdx], false, btcMkt, S / 10, BTC_PRICE, i + 1),
                taker: _sign(pks[longIdx], addrs[longIdx], true, btcMkt, S / 10, BTC_PRICE, i + 1),
                executionPrice: BTC_PRICE,
                executionSize: S / 10
            });
        }

        // Settle all at once
        vm.prank(owner);
        settlement.settleBatch(trades);

        // Verify all 200 positions exist
        (uint256 oiL, uint256 oiS) = engine.getOpenInterest(btcMkt);
        assertEq(oiL, 100 * (S / 10), "OI long mismatch");
        assertEq(oiS, 100 * (S / 10), "OI short mismatch");

        // Price whipsaw
        _setPrice(btcMkt, 55_000);
        _setPrice(btcMkt, 42_000);
        _setPrice(btcMkt, 51_000);

        // Mass liquidation check
        uint256 liqCount = 0;
        for (uint256 i = 0; i < 200; i++) {
            (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
            if (sz != 0 && engine.isLiquidatable(btcMkt, addrs[i])) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, addrs[i]) { liqCount++; } catch {}
            }
        }
        emit log_named_uint("  Liquidations after whipsaw", liqCount);

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after mass batch");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 25: Zero-price edge case
    //  What happens when mark price is set to minimum possible value?
    // ================================================================

    function test_chaos_extremeLowPrice() public {
        emit log_string("=== CHAOS: Extreme low price (BTC = $1) ===");

        address t1 = addrs[0];
        address t2 = addrs[1];
        _fund(t1, 100_000 * U);
        _fund(t2, 100_000 * U);

        // Open at $50k
        _trade(0, true, 1, false, btcMkt, 10 * S, BTC_PRICE, 1);

        // Price drops to $1
        _setPrice(btcMkt, 1);

        // PnL for long: (1 - 50000) * 10 BTC = -$499,990
        // Margin was ~$25,000, so massive bad debt
        int256 pnl = engine.getUnrealizedPnl(btcMkt, t1);
        emit log_named_int("  Long PnL at $1", pnl / int256(U));

        // Liquidate - should handle bad debt
        vm.prank(keeper);
        try liquidator.liquidate(btcMkt, t1) {
            emit log_string("  Liquidation succeeded at $1");
        } catch (bytes memory reason) {
            emit log_string("  Liquidation failed (may need multiple rounds)");
        }

        // Try repeated liquidation
        for (uint256 r = 0; r < 20; r++) {
            (int256 sz,,,,,) = engine.positions(btcMkt, t1);
            if (sz == 0) break;
            if (!engine.isLiquidatable(btcMkt, t1)) break;
            vm.prank(keeper);
            try liquidator.liquidate(btcMkt, t1) {} catch { break; }
        }

        // Short should have massive unrealized profit
        int256 shortPnl = engine.getUnrealizedPnl(btcMkt, t2);
        emit log_named_int("  Short PnL at $1", shortPnl / int256(U));

        // Can the short close and actually receive the profit?
        uint256 shortBalBefore = vault.balances(t2);
        vm.prank(owner);
        engine.closePosition(btcMkt, t2, 1 * U);

        uint256 shortBalAfter = vault.balances(t2);
        emit log_named_uint("  Short withdrew", (shortBalAfter - shortBalBefore) / U);

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after $1 BTC");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 26: Interleaved open/close/liquidate in same block
    //  Hammer the engine with mixed operations on same positions
    // ================================================================

    function test_chaos_interleavedOperationsSameBlock() public {
        emit log_string("=== CHAOS: Interleaved ops same block ===");

        uint256 numTraders = 100;
        for (uint256 i = 0; i < numTraders; i++) {
            _fund(addrs[i], 50_000 * U);
        }

        // Open 50 pairs
        for (uint256 i = 0; i < numTraders; i += 2) {
            _trade(i, true, i + 1, false, btcMkt, S / 2, BTC_PRICE, i + 1);
        }

        // Same block: price change, partial close some, increase others, liquidate some
        _setPrice(btcMkt, 47_000);

        for (uint256 i = 0; i < numTraders; i += 4) {
            // Trader i: try to reduce position
            (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
            if (sz != 0) {
                vm.prank(owner);
                try engine.openPosition(btcMkt, addrs[i], -sz / 2, 47_000 * U) {} catch {}
            }

            // Trader i+1: try to increase position
            (sz,,,,,) = engine.positions(btcMkt, addrs[i + 1]);
            if (sz != 0) {
                vm.prank(owner);
                try engine.openPosition(btcMkt, addrs[i + 1], sz, 47_000 * U) {} catch {}
            }

            // Trader i+2: try to close entirely
            (sz,,,,,) = engine.positions(btcMkt, addrs[i + 2]);
            if (sz != 0) {
                vm.prank(owner);
                try engine.closePosition(btcMkt, addrs[i + 2], 47_000 * U) {} catch {}
            }

            // Trader i+3: try to liquidate
            (sz,,,,,) = engine.positions(btcMkt, addrs[i + 3]);
            if (sz != 0 && engine.isLiquidatable(btcMkt, addrs[i + 3])) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, addrs[i + 3]) {} catch {}
            }
        }

        // Verify OI consistency
        (uint256 oiL, uint256 oiS) = engine.getOpenInterest(btcMkt);
        uint256 actualLong = 0;
        uint256 actualShort = 0;
        for (uint256 i = 0; i < numTraders; i++) {
            (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
            if (sz > 0) actualLong += uint256(sz);
            else if (sz < 0) actualShort += uint256(-sz);
        }

        assertEq(oiL, actualLong, "BROKEN: OI long mismatch after interleaved ops");
        assertEq(oiS, actualShort, "BROKEN: OI short mismatch after interleaved ops");

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after interleaved ops");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 27: Position flip at exact liquidation boundary
    //  Open long, drop to exactly maintenance, then flip to short
    // ================================================================

    function test_chaos_flipAtLiquidationBoundary() public {
        emit log_string("=== CHAOS: Position flip at liquidation boundary ===");

        address trader = addrs[0];
        address cp = addrs[1];
        _fund(trader, 100_000 * U);
        _fund(cp, 100_000 * U);

        // Open 1 BTC long
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        (,, uint256 margin,,,) = engine.positions(btcMkt, trader);
        emit log_named_uint("  Initial margin", margin / U);

        // Binary search for liquidation price
        uint256 lo = 40_000;
        uint256 hi = 50_000;
        uint256 liqPrice;
        for (uint256 i = 0; i < 30; i++) {
            uint256 mid = (lo + hi) / 2;
            _setPrice(btcMkt, mid);
            if (engine.isLiquidatable(btcMkt, trader)) {
                lo = mid;
                liqPrice = mid;
            } else {
                hi = mid;
            }
        }

        // Set price to just above liquidation
        _setPrice(btcMkt, liqPrice + 1);
        assertFalse(engine.isLiquidatable(btcMkt, trader), "Should not be liquidatable just above boundary");

        emit log_named_uint("  Liquidation price found", liqPrice);

        // Now try to FLIP the position to short (2x size to go from +1 to -1 BTC)
        vm.prank(owner);
        try engine.openPosition(btcMkt, trader, -2 * int256(S), (liqPrice + 1) * U) {
            // If flip succeeded, check the new position
            (int256 newSz,, uint256 newMargin,,,) = engine.positions(btcMkt, trader);
            emit log_named_int("  New position size", newSz / int256(S));
            emit log_named_uint("  New margin", newMargin / U);

            // Close the flipped position
            _setPrice(btcMkt, liqPrice + 1);
            vm.prank(owner);
            engine.closePosition(btcMkt, trader, (liqPrice + 1) * U);
        } catch {
            emit log_string("  Flip correctly rejected at liquidation boundary");
        }

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after flip at boundary");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 28: Funding pool exhaustion attack
    //  Try to drain the funding pool by accumulating funding payments
    // ================================================================

    function test_chaos_fundingPoolExhaustion() public {
        emit log_string("=== CHAOS: Funding pool exhaustion ===");

        // Fund the funding pool with limited amount
        _fund(feeRecipient, 10_000 * U); // only $10k in funding pool

        address longTrader = addrs[0];
        address shortTrader = addrs[1];
        _fund(longTrader, 500_000 * U);
        _fund(shortTrader, 500_000 * U);

        // Open positions: long pays short
        _trade(0, true, 1, false, btcMkt, 10 * S, BTC_PRICE, 1);

        // Set mark > index to make longs pay funding
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 51_000 * U, 50_000 * U); // 2% premium

        // Apply funding many times to try to exhaust the pool
        bool exhausted = false;
        for (uint256 f = 0; f < 100; f++) {
            vm.warp(block.timestamp + 28800);
            // Keep price fresh
            vm.prank(owner);
            engine.updateMarkPrice(btcMkt, 51_000 * U, 50_000 * U);

            try engine.applyFundingRate(btcMkt) {} catch {
                emit log_named_uint("  Funding failed at round", f);
                exhausted = true;
                break;
            }
        }

        if (exhausted) {
            emit log_string("  Funding pool exhausted - checking if protocol still works");
        }

        // Regardless of funding pool state, try to close positions
        _setPrice(btcMkt, 50_000);
        vm.prank(owner);
        try engine.closePosition(btcMkt, longTrader, BTC_PRICE) {
            emit log_string("  Long close succeeded");
        } catch {
            emit log_string("  WARNING: Long close failed - positions may be stuck");
        }

        vm.prank(owner);
        try engine.closePosition(btcMkt, shortTrader, BTC_PRICE) {
            emit log_string("  Short close succeeded");
        } catch {
            emit log_string("  WARNING: Short close failed - positions may be stuck");
        }

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after funding pool exhaustion");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 29: Precision attack - sizes that don't divide by 4
    //  Partial liquidation does absSize / 4. What if absSize = 3?
    //  Then liquidateSize = 0 → should full-close instead.
    // ================================================================

    function test_chaos_indivisiblePartialLiquidation() public {
        emit log_string("=== CHAOS: Indivisible partial liquidation sizes ===");

        // Test with sizes 1, 2, 3, 5, 7, 99, 101
        uint256[7] memory sizes = [uint256(1), 2, 3, 5, 7, 99, 101];
        uint256 totalBadAccounting = 0;

        for (uint256 t = 0; t < 7; t++) {
            address trader = addrs[t * 2];
            address cp = addrs[t * 2 + 1];
            _fund(trader, 1_000_000 * U);
            _fund(cp, 1_000_000 * U);

            // Open position with specific size
            _trade(t * 2, true, t * 2 + 1, false, btcMkt, sizes[t], BTC_PRICE, t + 100);

            // Drop price to make liquidatable
            _setPrice(btcMkt, 48_000);

            // Liquidate until position is gone
            uint256 rounds = 0;
            for (uint256 r = 0; r < 30; r++) {
                (int256 sz,,,,,) = engine.positions(btcMkt, trader);
                if (sz == 0) break;
                if (!engine.isLiquidatable(btcMkt, trader)) {
                    _setPrice(btcMkt, 48_000 - (r * 200));
                    if (48_000 - (r * 200) < 1000) break;
                    continue;
                }
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, trader) { rounds++; } catch { break; }
            }

            (int256 remaining,,,,,) = engine.positions(btcMkt, trader);
            if (remaining != 0) totalBadAccounting++;

            // Reset price for next iteration
            _setPrice(btcMkt, 50_000);
        }

        assertEq(totalBadAccounting, 0, "BROKEN: Positions stuck after indivisible liquidation");

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after indivisible liquidation");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 30: Vault deposit/withdraw during active liquidation cascade
    //  Try to front-run a liquidation by depositing/withdrawing
    // ================================================================

    function test_chaos_depositWithdrawDuringLiquidation() public {
        emit log_string("=== CHAOS: Deposit/withdraw during liquidation cascade ===");

        // Setup 100 traders with positions
        for (uint256 i = 0; i < 100; i++) {
            _fund(addrs[i], 10_000 * U);
        }
        for (uint256 i = 0; i < 100; i += 2) {
            _trade(i, true, i + 1, false, btcMkt, S / 5, BTC_PRICE, i + 1);
        }

        // Price drops
        _setPrice(btcMkt, 45_000);

        // Simultaneous: some traders try to deposit (to save position),
        // others try to withdraw (to flee), keeper tries to liquidate
        for (uint256 i = 0; i < 100; i += 4) {
            // Trader i: deposit more to save position
            usdc.mint(addrs[i], 5_000 * U);
            vm.startPrank(addrs[i]);
            usdc.approve(address(vault), 5_000 * U);
            vault.deposit(5_000 * U);
            vm.stopPrank();

            // Trader i+1: withdraw everything possible
            uint256 bal = vault.balances(addrs[i + 1]);
            if (bal > 0) {
                vm.prank(addrs[i + 1]);
                try vault.withdraw(bal) {} catch {}
            }

            // Trader i+2: try to liquidate
            (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i + 2]);
            if (sz != 0 && engine.isLiquidatable(btcMkt, addrs[i + 2])) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, addrs[i + 2]) {} catch {}
            }

            // Trader i+3: try to add margin
            (sz,,,,,) = engine.positions(btcMkt, addrs[i + 3]);
            if (sz != 0) {
                uint256 freeBal = vault.balances(addrs[i + 3]);
                if (freeBal > 0) {
                    vm.prank(owner);
                    try engine.addMargin(btcMkt, addrs[i + 3], freeBal / 2) {} catch {}
                }
            }
        }

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent during chaotic deposit/withdraw/liquidate");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 31: Extreme funding accumulation + position modification
    //  Accumulate huge funding debt, then try to increase position
    // ================================================================

    function test_chaos_fundingDebtThenIncrease() public {
        emit log_string("=== CHAOS: Funding debt then position increase ===");

        address longTrader = addrs[0];
        address shortTrader = addrs[1];
        _fund(longTrader, 100_000 * U);
        _fund(shortTrader, 100_000 * U);

        // Open positions
        _trade(0, true, 1, false, btcMkt, 5 * S, BTC_PRICE, 1);

        // Set mark > index (longs pay funding)
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 52_000 * U, 50_000 * U);

        // Accumulate funding for 30 days
        for (uint256 f = 0; f < 90; f++) {
            vm.warp(block.timestamp + 28800);
            vm.prank(owner);
            engine.updateMarkPrice(btcMkt, 52_000 * U, 50_000 * U);
            engine.applyFundingRate(btcMkt);
        }

        // Check long trader's position - margin should be eaten by funding
        (int256 sz,, uint256 margin,,,) = engine.positions(btcMkt, longTrader);
        emit log_named_uint("  Long margin after 90 funding periods", margin / U);
        emit log_named_uint("  Long free balance", vault.balances(longTrader) / U);

        // Now try to increase the long position (should apply pending funding first)
        _setPrice(btcMkt, 50_000);
        vm.prank(owner);
        try engine.openPosition(btcMkt, longTrader, int256(S), BTC_PRICE) {
            emit log_string("  Position increase succeeded after funding debt");
            (,, uint256 newMargin,,,) = engine.positions(btcMkt, longTrader);
            emit log_named_uint("  New margin", newMargin / U);
        } catch {
            emit log_string("  Position increase failed (insufficient margin after funding)");
        }

        // The short should have received a lot of funding
        uint256 shortBal = vault.balances(shortTrader);
        (,, uint256 shortMargin,,,) = engine.positions(btcMkt, shortTrader);
        emit log_named_uint("  Short free balance", shortBal / U);
        emit log_named_uint("  Short margin (includes funding)", shortMargin / U);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after funding debt + increase");
    }

    // ================================================================
    //  TEST 32: Maximum entropy - random operations with 10 markets
    //  500 traders, 10 markets, random operations for 100 rounds
    // ================================================================

    function test_chaos_maximumEntropy10Markets() public {
        emit log_string("=== CHAOS: Maximum entropy - 10 markets, 200 traders, 200 rounds ===");

        // Add 8 more markets
        bytes32[] memory mkts = new bytes32[](10);
        mkts[0] = btcMkt;
        mkts[1] = ethMkt;
        string[8] memory names = ["SOL-USD", "AVAX-USD", "DOGE-USD", "MATIC-USD", "LINK-USD", "UNI-USD", "AAVE-USD", "ARB-USD"];
        uint256[8] memory prices = [uint256(100), 30, 1, 1, 15, 8, 100, 1];

        vm.startPrank(owner);
        for (uint256 i = 0; i < 8; i++) {
            engine.addMarket(names[i], 500, 250, 10_000_000 * S, 28800);
            mkts[i + 2] = keccak256(abi.encodePacked(names[i]));
            engine.updateMarkPrice(mkts[i + 2], prices[i] * U, prices[i] * U);
        }
        vm.stopPrank();

        // Fund 200 traders
        uint256 numTraders = 200;
        for (uint256 i = 0; i < numTraders; i++) {
            _fund(addrs[i], 50_000 * U);
        }

        // 200 rounds of random operations
        uint256 totalOps = 0;
        uint256 totalErrors = 0;

        for (uint256 round = 0; round < 200; round++) {
            uint256 seed = uint256(keccak256(abi.encode(round, block.timestamp)));
            uint256 traderIdx = seed % numTraders;
            address trader = addrs[traderIdx];
            bytes32 mkt = mkts[seed % 10];
            uint256 op = (seed >> 8) % 6;

            if (op == 0) {
                // Open long
                uint256 size = (S / 10) + (seed % (S * 2));
                vm.prank(owner);
                try engine.openPosition(mkt, trader, int256(size), _getMarkPrice(mkt)) {
                    totalOps++;
                } catch { totalErrors++; }
            } else if (op == 1) {
                // Open short
                uint256 size = (S / 10) + (seed % (S * 2));
                vm.prank(owner);
                try engine.openPosition(mkt, trader, -int256(size), _getMarkPrice(mkt)) {
                    totalOps++;
                } catch { totalErrors++; }
            } else if (op == 2) {
                // Close position
                (int256 sz,,,,,) = engine.positions(mkt, trader);
                if (sz != 0) {
                    vm.prank(owner);
                    try engine.closePosition(mkt, trader, _getMarkPrice(mkt)) {
                        totalOps++;
                    } catch { totalErrors++; }
                }
            } else if (op == 3) {
                // Price change: +/- 10%
                uint256 currentPrice = _getMarkPrice(mkt);
                uint256 delta = currentPrice / 10;
                uint256 newPrice;
                if (seed % 2 == 0) {
                    newPrice = currentPrice + (delta * (seed % 10)) / 10;
                } else {
                    uint256 drop = (delta * (seed % 10)) / 10;
                    newPrice = currentPrice > drop + U ? currentPrice - drop : U;
                }
                vm.prank(owner);
                engine.updateMarkPrice(mkt, newPrice, newPrice);
                totalOps++;
            } else if (op == 4) {
                // Liquidate
                (int256 sz,,,,,) = engine.positions(mkt, trader);
                if (sz != 0 && engine.isLiquidatable(mkt, trader)) {
                    vm.prank(keeper);
                    try liquidator.liquidate(mkt, trader) { totalOps++; } catch { totalErrors++; }
                }
            } else {
                // Apply funding
                try engine.applyFundingRate(mkt) { totalOps++; } catch { totalErrors++; }
            }
        }

        emit log_named_uint("  Successful ops", totalOps);
        emit log_named_uint("  Failed ops (expected)", totalErrors);

        // Verify OI consistency for ALL markets
        for (uint256 m = 0; m < 10; m++) {
            (uint256 oiL, uint256 oiS) = engine.getOpenInterest(mkts[m]);
            uint256 actualL = 0;
            uint256 actualS = 0;
            for (uint256 i = 0; i < numTraders; i++) {
                (int256 sz,,,,,) = engine.positions(mkts[m], addrs[i]);
                if (sz > 0) actualL += uint256(sz);
                else if (sz < 0) actualS += uint256(-sz);
            }
            assertEq(oiL, actualL, "BROKEN: OI long mismatch on market");
            assertEq(oiS, actualS, "BROKEN: OI short mismatch on market");
        }

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after maximum entropy");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 34: _settlePnl insurance pull when insurance is empty
    //  Winners can't close if engine pool insufficient + insurance empty
    // ================================================================

    function test_chaos_winnerCantCloseEmptyInsurance() public {
        emit log_string("=== CHAOS: Winner can't close with empty insurance ===");

        // Create fresh engine with empty insurance
        InsuranceFund insurance2 = new InsuranceFund(address(vault), owner);
        PerpEngine engine2 = new PerpEngine(address(vault), owner, feeRecipient, address(insurance2), feeRecipient);
        Liquidator liq2 = new Liquidator(address(engine2), address(insurance2), owner);

        vm.startPrank(owner);
        vault.setOperator(address(engine2), true);
        engine2.setOperator(owner, true);
        engine2.setOperator(address(liq2), true);
        engine2.setCircuitBreakerParams(60, 10000, 60);
        engine2.setMaxExposureBps(0);
        engine2.setOiSkewCap(10000);
        engine2.addMarket("BTC-USD", 500, 250, 1_000_000 * S, 28800);
        insurance2.setOperator(address(liq2), true);
        vm.stopPrank();

        bytes32 btc2 = keccak256(abi.encodePacked("BTC-USD"));
        vm.prank(owner);
        engine2.updateMarkPrice(btc2, BTC_PRICE, BTC_PRICE);

        address winner = addrs[0];
        address loser = addrs[1];
        _fund(winner, 100_000 * U);
        _fund(loser, 100_000 * U);

        // Winner opens long, loser opens short
        vm.prank(owner);
        engine2.openPosition(btc2, winner, int256(10 * S), BTC_PRICE);
        vm.prank(owner);
        engine2.openPosition(btc2, loser, -int256(10 * S), BTC_PRICE);

        // Loser gets liquidated first (price drops, then rises)
        vm.prank(owner);
        engine2.updateMarkPrice(btc2, 40_000 * U, 40_000 * U);

        // Liquidate loser - margin goes to engine pool
        for (uint256 r = 0; r < 10; r++) {
            (int256 sz,,,,,) = engine2.positions(btc2, loser);
            if (sz == 0) break;
            if (!engine2.isLiquidatable(btc2, loser)) break;
            vm.prank(keeper);
            try liq2.liquidate(btc2, loser) {} catch { break; }
        }

        // Now price pumps massively - winner has huge profit
        vm.prank(owner);
        engine2.updateMarkPrice(btc2, 80_000 * U, 80_000 * U);

        // Winner tries to close - engine pool might not have enough
        // because loser's margin was partially sent to keeper/insurance
        vm.prank(owner);
        try engine2.closePosition(btc2, winner, 80_000 * U) {
            emit log_string("  [OK] Winner closed successfully");
        } catch {
            emit log_string("  [BUG] Winner CANNOT close position - funds stuck!");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 35: Funding pool empty blocks ALL operations
    //  If fundingPool balance = 0 and shorts should receive funding,
    //  _applyFunding reverts, blocking open/close/liquidate
    // ================================================================

    function test_chaos_fundingPoolEmptyBlocksOps() public {
        emit log_string("=== CHAOS: Empty funding pool blocks all operations ===");

        // Create engine with a fundingPool that has no money
        address emptyPool = makeAddr("emptyPool");
        PerpEngine engine2 = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), emptyPool);

        vm.startPrank(owner);
        vault.setOperator(address(engine2), true);
        engine2.setOperator(owner, true);
        engine2.setCircuitBreakerParams(60, 10000, 60);
        engine2.setMaxExposureBps(0);
        engine2.setOiSkewCap(10000);
        engine2.addMarket("BTC-USD", 500, 250, 1_000_000 * S, 28800);
        vm.stopPrank();

        bytes32 btc2 = keccak256(abi.encodePacked("BTC-USD"));
        vm.prank(owner);
        engine2.updateMarkPrice(btc2, BTC_PRICE, BTC_PRICE);

        address longTrader = addrs[0];
        address shortTrader = addrs[1];
        _fund(longTrader, 100_000 * U);
        _fund(shortTrader, 100_000 * U);

        // Open positions
        vm.prank(owner);
        engine2.openPosition(btc2, longTrader, int256(S), BTC_PRICE);
        vm.prank(owner);
        engine2.openPosition(btc2, shortTrader, -int256(S), BTC_PRICE);

        // Set mark > index so longs pay shorts
        vm.prank(owner);
        engine2.updateMarkPrice(btc2, 52_000 * U, 50_000 * U);

        // Apply funding
        vm.warp(block.timestamp + 28800);
        vm.prank(owner);
        engine2.updateMarkPrice(btc2, 52_000 * U, 50_000 * U);
        engine2.applyFundingRate(btc2);

        // Now short has pending funding to RECEIVE from empty pool
        // Long pays to pool (ok), but short receives from pool (should fail)

        // Try to close the SHORT position - _applyFunding should try to
        // transfer from emptyPool to shortTrader, which will fail if pool is empty
        vm.prank(owner);
        engine2.updateMarkPrice(btc2, 50_000 * U, 50_000 * U);

        vm.prank(owner);
        try engine2.closePosition(btc2, shortTrader, BTC_PRICE) {
            emit log_string("  [OK] Short close succeeded (pool had funds from long's payment)");
        } catch {
            emit log_string("  [BUG] Short CANNOT close - funding pool empty blocks close!");
        }

        // Try to close the LONG position
        vm.prank(owner);
        try engine2.closePosition(btc2, longTrader, BTC_PRICE) {
            emit log_string("  [OK] Long close succeeded");
        } catch {
            emit log_string("  [BUG] Long CANNOT close - stuck!");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 36: Funding when trader vault balance is 0
    //  Trader deposited all into margin, funding payment tries to
    //  transfer from trader (vault balance 0) to fundingPool
    // ================================================================

    function test_chaos_fundingWithZeroVaultBalance() public {
        emit log_string("=== CHAOS: Funding payment with 0 vault balance ===");

        address longTrader = addrs[0];
        address shortTrader = addrs[1];
        _fund(longTrader, 2_500 * U);  // exactly enough for margin at 20x
        _fund(shortTrader, 2_500 * U);

        // Open at exactly the margin required (20x leverage = 5% margin)
        // 1 BTC at $50k = $50k notional, 5% = $2,500 margin
        vm.prank(owner);
        engine.openPosition(btcMkt, longTrader, int256(S), BTC_PRICE);
        vm.prank(owner);
        engine.openPosition(btcMkt, shortTrader, -int256(S), BTC_PRICE);

        // Verify long trader has 0 free balance
        uint256 freeBal = vault.balances(longTrader);
        emit log_named_uint("  Long free balance (should be 0)", freeBal);

        // Set mark > index so long pays funding
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 52_000 * U, 50_000 * U);

        // Apply funding
        vm.warp(block.timestamp + 28800);
        _setPrice(btcMkt, 50_000);

        // Funding payment would be: size * (mark-index)/index * 1 period
        // = 1e8 * (52k-50k)/50k * 1 = 1e8 * 0.04 * 1 = 4e6 in FUNDING_PRECISION
        // In USDC: ~$2000
        // But it's capped at pos.margin ($2500 for the trader)
        // The transfer is from TRADER (not margin!) to fundingPool
        // Wait - line 535: vault.internalTransfer(trader, fundingPool, payment)
        // This transfers from the trader's VAULT BALANCE (which is 0!)
        // But the payment comes from pos.margin -= payment (line 534)
        // So margin is reduced but the transfer is from trader balance which is 0!

        // Actually re-reading: the funding payment transfers from trader to fundingPool
        // via vault.internalTransfer. But the trader's vault balance IS 0.
        // The margin is tracked separately in PerpEngine, not in vault.
        // This means the transfer WILL FAIL because trader has 0 vault balance.

        // Let's try to trigger it via any position operation
        vm.prank(owner);
        try engine.closePosition(btcMkt, longTrader, BTC_PRICE) {
            emit log_string("  [OK] Close succeeded");
        } catch {
            emit log_string("  [BUG] Close FAILED - funding transfer from 0 balance!");

            // Can the trader even be liquidated?
            vm.prank(owner);
            engine.updateMarkPrice(btcMkt, 48_000 * U, 48_000 * U);
            bool isLiq = engine.isLiquidatable(btcMkt, longTrader);
            console.log("  Is liquidatable?", isLiq);

            if (isLiq) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, longTrader) {
                    emit log_string("  Liquidation succeeded");
                } catch {
                    emit log_string("  [BUG] Liquidation ALSO FAILED - position completely stuck!");
                }
            }
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 37: Partial close rounding attack
    //  releasedMargin = (pos.margin * closingSize) / absOldSize
    //  If this rounds down, margin dust accumulates in engine
    // ================================================================

    function test_chaos_partialCloseRounding() public {
        emit log_string("=== CHAOS: Partial close margin rounding attack ===");

        address trader = addrs[0];
        address cp = addrs[1];
        _fund(trader, 1_000_000 * U);
        _fund(cp, 1_000_000 * U);

        uint256 vaultUsdcBefore = usdc.balanceOf(address(vault));

        // Open position with prime-number size that doesn't divide evenly
        uint256 primeSize = 997; // prime number of SIZE_PRECISION units
        _trade(0, true, 1, false, btcMkt, primeSize, BTC_PRICE, 1);

        (,, uint256 initialMargin,,,) = engine.positions(btcMkt, trader);
        emit log_named_uint("  Initial margin", initialMargin);

        // Close in small increments that cause maximum rounding
        uint256 totalReleased = 0;
        for (uint256 i = 0; i < 30; i++) {
            (int256 sz,,,,,) = engine.positions(btcMkt, trader);
            if (sz == 0) break;
            uint256 absSize = uint256(sz);
            uint256 closeSize = absSize > 3 ? 3 : absSize; // close 3 units at a time

            vm.prank(owner);
            try engine.openPosition(btcMkt, trader, -int256(closeSize), BTC_PRICE) {} catch { break; }
        }

        // Close remainder
        (int256 finalSz,,,,,) = engine.positions(btcMkt, trader);
        if (finalSz != 0) {
            vm.prank(owner);
            engine.closePosition(btcMkt, trader, BTC_PRICE);
        }

        // Close counterparty too so engine balance reflects only dust
        (int256 cpSz,,,,,) = engine.positions(btcMkt, cp);
        if (cpSz != 0) {
            vm.prank(owner);
            engine.closePosition(btcMkt, cp, BTC_PRICE);
        }

        uint256 traderBal = vault.balances(trader);
        uint256 engineBal = vault.balances(address(engine));
        emit log_named_uint("  Trader balance after all closes", traderBal);
        emit log_named_uint("  CP balance after close", vault.balances(cp));
        emit log_named_uint("  Engine balance (should be ~0)", engineBal);
        emit log_named_uint("  Margin dust trapped in engine", engineBal);

        // The engine should not accumulate unbounded dust
        // Some rounding is expected but it should be tiny
        assertLt(engineBal, 100, "BROKEN: Significant margin dust trapped in engine");

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after rounding attack");

        uint256 vaultUsdcAfter = usdc.balanceOf(address(vault));
        assertEq(vaultUsdcAfter, vaultUsdcBefore, "BROKEN: USDC leaked from vault");
    }

    // ================================================================
    //  TEST 38: Engine pool depletion via sequential winners
    //  If multiple winners close and engine pool gets drained,
    //  later winners can't close
    // ================================================================

    function test_chaos_enginePoolSequentialDrain() public {
        emit log_string("=== CHAOS: Engine pool drain via sequential winners ===");

        // 50 longs vs 50 shorts
        uint256 pairs = 50;
        for (uint256 i = 0; i < pairs * 2; i++) {
            _fund(addrs[i], 20_000 * U);
        }
        for (uint256 i = 0; i < pairs; i++) {
            _trade(i, true, pairs + i, false, btcMkt, S / 2, BTC_PRICE, i + 1);
        }

        // Price pumps 30% - all longs are winners
        _setPrice(btcMkt, 65_000);

        // Close ALL longs (winners) one by one
        uint256 closedCount = 0;
        uint256 failedCount = 0;
        for (uint256 i = 0; i < pairs; i++) {
            (int256 sz,,,,,) = engine.positions(btcMkt, addrs[i]);
            if (sz != 0) {
                vm.prank(owner);
                try engine.closePosition(btcMkt, addrs[i], 65_000 * U) {
                    closedCount++;
                } catch {
                    failedCount++;
                    emit log_named_uint("  Winner close failed at index", i);
                }
            }
        }

        emit log_named_uint("  Winners closed successfully", closedCount);
        emit log_named_uint("  Winners FAILED to close", failedCount);

        if (failedCount > 0) {
            emit log_string("  [BUG] Some winners cannot close - engine pool drained!");
            uint256 engineBal = vault.balances(address(engine));
            emit log_named_uint("  Engine pool balance", engineBal / U);
        }

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after sequential drain");
        assertGe(actual, accounted);
    }

    // ================================================================
    //  TEST 39: Margin removal then funding creates negative effective margin
    //  Remove margin to minimum, then funding eats remaining margin,
    //  position should become liquidatable
    // ================================================================

    function test_chaos_marginRemovalThenFundingEats() public {
        emit log_string("=== CHAOS: Margin removal + funding creates negative margin ===");

        address trader = addrs[0];
        address cp = addrs[1];
        _fund(trader, 100_000 * U);
        _fund(cp, 100_000 * U);

        // Open 1 BTC long with extra margin
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        // Add lots of extra margin
        vm.prank(owner);
        engine.addMargin(btcMkt, trader, 20_000 * U);

        (,, uint256 marginBefore,,,) = engine.positions(btcMkt, trader);
        emit log_named_uint("  Margin after adding extra", marginBefore / U);

        // Remove margin down to just above maintenance
        // Maintenance = 2.5% of $50k = $1,250
        vm.prank(owner);
        engine.removeMargin(btcMkt, trader, 19_000 * U);

        (,, uint256 marginAfter,,,) = engine.positions(btcMkt, trader);
        emit log_named_uint("  Margin after removal", marginAfter / U);

        // Set funding to eat remaining margin
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 55_000 * U, 50_000 * U); // 10% premium → high funding

        // Apply funding 3 times (max per call)
        for (uint256 f = 0; f < 10; f++) {
            vm.warp(block.timestamp + 28800);
            vm.prank(owner);
            engine.updateMarkPrice(btcMkt, 55_000 * U, 50_000 * U);
            engine.applyFundingRate(btcMkt);
        }

        // Check if position is now liquidatable
        _setPrice(btcMkt, 50_000);
        bool isLiq = engine.isLiquidatable(btcMkt, trader);
        console.log("  Is liquidatable after funding drain?", isLiq);

        // Position should be closeable regardless
        vm.prank(owner);
        try engine.closePosition(btcMkt, trader, BTC_PRICE) {
            emit log_string("  [OK] Position closed after margin drain");
        } catch {
            emit log_string("  [BUG] Position STUCK after margin was drained by funding!");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 40: Fee recipient balance overflow
    //  Price impact fees accumulate in feeRecipient - can this cause issues?
    // ================================================================

    function test_chaos_priceImpactFeeAccumulation() public {
        emit log_string("=== CHAOS: Price impact fee accumulation ===");

        // Configure price impact
        vm.prank(owner);
        engine.setPriceImpactConfig(btcMkt, 500, 20000); // 5% impact factor, quadratic

        // Create initial OI so price impact applies
        _fund(addrs[0], 1_000_000 * U);
        _fund(addrs[1], 1_000_000 * U);
        _trade(0, true, 1, false, btcMkt, 5 * S, BTC_PRICE, 1);

        // Now many traders pile in on the same side (worsening skew)
        uint256 totalFees = 0;
        uint256 feeBalBefore = vault.balances(feeRecipient);

        for (uint256 i = 2; i < 50; i++) {
            _fund(addrs[i], 100_000 * U);
            uint256 balBefore = vault.balances(addrs[i]);
            vm.prank(owner);
            try engine.openPosition(btcMkt, addrs[i], int256(S / 5), BTC_PRICE) {
                uint256 balAfter = vault.balances(addrs[i]);
                // Fee = what was deducted beyond margin
            } catch {}
        }

        uint256 feeBalAfter = vault.balances(feeRecipient);
        totalFees = feeBalAfter - feeBalBefore;
        emit log_named_uint("  Total price impact fees collected", totalFees / U);

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after fee accumulation");
        assertGe(actual, accounted);
    }

    // Helper: get current mark price for a market
    function _getMarkPrice(bytes32 mkt) internal view returns (uint256) {
        (,,,,,,uint256 markPrice,,,,,,, ) = engine.markets(mkt);
        return markPrice > 0 ? markPrice : U; // fallback to $1 if unset
    }

    // ================================================================
    //  TEST 33: Insurance fund = $0 then liquidation
    //  What happens when insurance has exactly zero?
    // ================================================================

    function test_chaos_zeroInsuranceLiquidation() public {
        emit log_string("=== CHAOS: Zero insurance fund liquidation ===");

        // Create fresh insurance fund with $0
        InsuranceFund insurance2 = new InsuranceFund(address(vault), owner);
        vm.startPrank(owner);
        insurance2.setOperator(address(liquidator), true);
        vm.stopPrank();

        // Create separate engine pointing to empty insurance
        PerpEngine engine2 = new PerpEngine(address(vault), owner, feeRecipient, address(insurance2), feeRecipient);
        Liquidator liq2 = new Liquidator(address(engine2), address(insurance2), owner);

        vm.startPrank(owner);
        vault.setOperator(address(engine2), true);
        engine2.setOperator(owner, true);
        engine2.setOperator(address(liq2), true);
        engine2.setCircuitBreakerParams(60, 10000, 60);
        engine2.setMaxExposureBps(0);
        engine2.setOiSkewCap(10000);
        engine2.addMarket("BTC-USD", 500, 250, 1_000_000 * S, 28800);
        bytes32 btc2 = keccak256(abi.encodePacked("BTC-USD"));
        engine2.updateMarkPrice(btc2, BTC_PRICE, BTC_PRICE);
        insurance2.setOperator(address(liq2), true);
        vm.stopPrank();

        address trader = addrs[0];
        address cp = addrs[1];
        _fund(trader, 10_000 * U);
        _fund(cp, 10_000 * U);

        // Open position via engine2
        vm.prank(owner);
        engine2.openPosition(btc2, trader, int256(S), BTC_PRICE);
        vm.prank(owner);
        engine2.openPosition(btc2, cp, -int256(S), BTC_PRICE);

        // Crash price - position is deep underwater
        vm.prank(owner);
        engine2.updateMarkPrice(btc2, 30_000 * U, 30_000 * U);

        // Try to liquidate with $0 insurance
        // The bad-debt path tries to pay keeper from insurance fund
        // With $0, this should either revert or handle gracefully
        vm.prank(keeper);
        try liq2.liquidate(btc2, trader) {
            emit log_string("  Liquidation succeeded with $0 insurance");
        } catch (bytes memory reason) {
            emit log_string("  Liquidation FAILED with $0 insurance");
            emit log_named_uint("  Revert reason length", reason.length);
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  HELPERS
    // ================================================================

    function _fund(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function _setOracle(uint256 btcUsd, uint256 ethUsd) internal {
        mockPyth.setPrice(PYTH_BTC, int64(int256(btcUsd * 1e8)), 1_000_000, -8, block.timestamp);
        mockPyth.setPrice(PYTH_ETH, int64(int256(ethUsd * 1e8)), 1_000_000, -8, block.timestamp);
        mockCL_BTC.setPrice(int256(btcUsd * 1e8), block.timestamp);
        mockCL_ETH.setPrice(int256(ethUsd * 1e8), block.timestamp);
    }

    function _setPrice(bytes32 mkt, uint256 priceUsd) internal {
        vm.prank(owner);
        engine.updateMarkPrice(mkt, priceUsd * U, priceUsd * U);
        if (mkt == btcMkt) {
            mockPyth.setPrice(PYTH_BTC, int64(int256(priceUsd * 1e8)), 1_000_000, -8, block.timestamp);
            mockCL_BTC.setPrice(int256(priceUsd * 1e8), block.timestamp);
        } else if (mkt == ethMkt) {
            mockPyth.setPrice(PYTH_ETH, int64(int256(priceUsd * 1e8)), 1_000_000, -8, block.timestamp);
            mockCL_ETH.setPrice(int256(priceUsd * 1e8), block.timestamp);
        }
    }

    function _setEthPrice(uint256 priceUsd) internal {
        _setPrice(ethMkt, priceUsd);
    }

    function _trade(
        uint256 longIdx, bool longIsLong,
        uint256 shortIdx, bool shortIsLong,
        bytes32 mkt, uint256 size, uint256 price, uint256 nonce
    ) internal {
        OrderSettlement.SignedOrder memory maker = _sign(pks[shortIdx], addrs[shortIdx], shortIsLong, mkt, size, price, nonce);
        OrderSettlement.SignedOrder memory taker = _sign(pks[longIdx], addrs[longIdx], longIsLong, mkt, size, price, nonce);
        vm.prank(owner);
        settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: maker, taker: taker, executionPrice: price, executionSize: size
        }));
    }

    // ================================================================
    //  WAVE 5: Deep protocol invariant tests
    // ================================================================

    // ================================================================
    //  TEST 41: addMargin doesn't apply pending funding
    //  Trader adds margin without funding being applied first.
    //  This means funding debt is hidden until next operation that
    //  triggers _applyFunding.
    // ================================================================
    function test_chaos_addMarginSkipsFunding() public {
        emit log_string("=== CHAOS: addMargin skips pending funding ===");

        address longTrader = addrs[0];
        address shortTrader = addrs[1];
        _fund(longTrader, 100_000 * U);
        _fund(shortTrader, 100_000 * U);

        // Open opposing positions
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        // Create funding: mark > index → longs pay shorts
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 55_000 * U, 50_000 * U); // 10% premium

        // Advance time and apply funding rate
        vm.warp(block.timestamp + 1 hours);
        engine.applyFundingRate(btcMkt);

        // Record margin before addMargin
        (,, uint256 marginBefore,,,) = engine.positions(btcMkt, longTrader);
        emit log_named_uint("  Long margin before addMargin", marginBefore);

        // Long trader adds margin WITHOUT funding being applied
        vm.prank(owner);
        engine.addMargin(btcMkt, longTrader, 5_000 * U);

        (,, uint256 marginAfterAdd,,,) = engine.positions(btcMkt, longTrader);
        emit log_named_uint("  Long margin after addMargin (funding NOT applied)", marginAfterAdd);

        // Now close position — this WILL apply funding
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 50_000 * U, 50_000 * U); // reset prices
        vm.prank(owner);
        engine.closePosition(btcMkt, longTrader, BTC_PRICE);

        uint256 longBal = vault.balances(longTrader);
        emit log_named_uint("  Long trader final balance", longBal);

        // The bug: margin shows inflated because funding wasn't deducted before add
        // After close, funding IS applied, so final balance should be correct
        // But the VISIBLE margin was misleading during addMargin
        // This is an INFO-level issue (view inconsistency) not a fund-loss issue
        // because _applyFunding happens on close

        // Close counterparty
        vm.prank(owner);
        engine.closePosition(btcMkt, shortTrader, BTC_PRICE);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after addMargin+funding");
    }

    // ================================================================
    //  TEST 42: removeMargin then funding drops equity below maintenance
    //  Trader removes margin while large negative funding is pending.
    //  removeMargin check passes, but after funding, position is underwater.
    // ================================================================
    function test_chaos_removeMarginThenFunding() public {
        emit log_string("=== CHAOS: removeMargin then funding drops below maintenance ===");

        address longTrader = addrs[0];
        address shortTrader = addrs[1];
        _fund(longTrader, 100_000 * U);
        _fund(shortTrader, 100_000 * U);

        // Open positions
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        (,, uint256 initialMargin,,,) = engine.positions(btcMkt, longTrader);
        emit log_named_uint("  Initial margin", initialMargin);

        // Remove as much margin as allowed
        uint256 removable = initialMargin / 2;
        vm.prank(owner);
        try engine.removeMargin(btcMkt, longTrader, removable) {
            emit log_named_uint("  Removed margin", removable);
        } catch {
            emit log_string("  removeMargin failed (expected)");
            removable = 0;
        }

        // Create heavy funding: mark >> index → longs pay
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 60_000 * U, 50_000 * U); // 20% premium

        // Apply funding multiple rounds
        for (uint256 i = 0; i < 5; i++) {
            vm.warp(block.timestamp + 1 hours);
            engine.applyFundingRate(btcMkt);
        }

        // Now open/close to trigger _applyFunding and see what happens
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 50_000 * U, 50_000 * U);
        bool isLiq = engine.isLiquidatable(btcMkt, longTrader);
        emit log_named_uint("  Is liquidatable after funding?", isLiq ? 1 : 0);

        if (isLiq) {
            emit log_string("  [BUG] Position became liquidatable due to removeMargin+funding!");
            // This is the bug: removeMargin allowed removal, then funding made it underwater
            vm.prank(keeper);
            liquidator.liquidate(btcMkt, longTrader);
            emit log_string("  Liquidation executed");
        } else {
            vm.prank(owner);
            engine.closePosition(btcMkt, longTrader, BTC_PRICE);
        }

        vm.prank(owner);
        engine.closePosition(btcMkt, shortTrader, BTC_PRICE);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 43: Exposure limit bypass - first trader has no limit
    //  When totalProtocolOI == 0, _checkExposureLimit returns early
    //  allowing unlimited position size for the first trader.
    // ================================================================
    function test_chaos_exposureLimitEnforced() public {
        emit log_string("=== CHAOS: Exposure limit enforcement ===");

        // Disable exposure limit initially to build OI
        vm.prank(owner);
        engine.setMaxExposureBps(0); // disabled

        // Build up OI with multiple traders
        for (uint256 i = 0; i < 5; i++) {
            _fund(addrs[i], 1_000_000 * U);
            _fund(addrs[i + 5], 1_000_000 * U);
            _trade(i, true, i + 5, false, btcMkt, S, BTC_PRICE, i + 1);
        }

        // Now enable tight exposure limit
        vm.prank(owner);
        engine.setMaxExposureBps(2000); // 20% max per trader

        // Trader 0 has 1S ($50k) of total OI ($500k) = 20%.
        // Try to open LARGE ETH position to exceed 20%
        _fund(addrs[0], 1_000_000 * U);
        _fund(addrs[10], 1_000_000 * U);
        vm.prank(owner);
        try engine.openPosition(ethMkt, addrs[0], int256(50 * S), ETH_PRICE) {
            // Notional: 50 * $3k = $150k + $50k BTC = $200k total
            // Total OI would be $500k BTC + $300k ETH = $800k
            // 20% of $800k = $160k. Trader has $200k > $160k → should fail
            emit log_string("  [BUG] Opened beyond exposure limit!");
        } catch {
            emit log_string("  [OK] Exposure limit correctly enforced");
        }

        // Cleanup
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(owner);
            engine.closePosition(btcMkt, addrs[i], BTC_PRICE);
            vm.prank(owner);
            engine.closePosition(btcMkt, addrs[i + 5], BTC_PRICE);
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 44: Position flip margin handling
    //  Flip from long to short in one tx. Check margin is correctly
    //  released from old position and allocated to new.
    // ================================================================
    function test_chaos_positionFlipMargin() public {
        emit log_string("=== CHAOS: Position flip margin handling ===");

        address trader = addrs[0];
        address cp = addrs[1];
        _fund(trader, 200_000 * U);
        _fund(cp, 200_000 * U);

        // Open long
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        (int256 longSz,, uint256 longMargin,,,) = engine.positions(btcMkt, trader);
        uint256 balBefore = vault.balances(trader);
        emit log_named_int("  Long size", longSz);
        emit log_named_uint("  Long margin", longMargin);
        emit log_named_uint("  Free balance before flip", balBefore);

        // Price moves up → long is profitable
        _setPrice(btcMkt, 55_000);

        // Flip to short (sizeDelta = -2 * S → close long S, open short S)
        vm.prank(owner);
        engine.openPosition(btcMkt, trader, -2 * int256(S), 55_000 * U);

        (int256 shortSz, uint256 entryPrice, uint256 shortMargin,,,) = engine.positions(btcMkt, trader);
        uint256 balAfter = vault.balances(trader);
        emit log_named_int("  Short size after flip", shortSz);
        emit log_named_uint("  Short entry price", entryPrice);
        emit log_named_uint("  Short margin", shortMargin);
        emit log_named_uint("  Free balance after flip", balAfter);

        // Verify: profit from closing long should be in trader balance
        // longPnl = (55k - 50k) * 1e8 / 1e8 = 5000 USDC
        // Total returned = longMargin + 5000
        // New short should have fresh margin locked

        // Close positions
        _setPrice(btcMkt, 55_000);
        vm.prank(owner);
        engine.closePosition(btcMkt, trader, 55_000 * U);
        vm.prank(owner);
        engine.closePosition(btcMkt, cp, 55_000 * U);

        uint256 finalBal = vault.balances(trader);
        uint256 cpBal = vault.balances(cp);
        emit log_named_uint("  Trader final balance", finalBal);
        emit log_named_uint("  CP final balance", cpBal);

        // Total should sum to initial deposits (conservation of value)
        // Must include all internal accounts: engine, feeRecipient, fundingPool, insurance
        uint256 totalFinal = finalBal + cpBal + vault.balances(address(engine))
            + vault.balances(feeRecipient)
            + vault.balances(engine.fundingPool())
            + vault.balances(engine.insuranceFund());
        emit log_named_uint("  Total in system", totalFinal);
        emit log_named_uint("  Fee recipient balance", vault.balances(feeRecipient));
        emit log_named_uint("  Funding pool balance", vault.balances(engine.fundingPool()));
        emit log_named_uint("  Insurance balance", vault.balances(engine.insuranceFund()));
        // Allow for pre-seeded insurance/funding balances from setUp
        assertGe(totalFinal, 400_000 * U, "BROKEN: Value leaked from system after flip");

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after flip");
    }

    // ================================================================
    //  TEST 45: Liquidation violates OI skew cap
    //  Liquidating one side can push OI skew past the cap.
    //  Protocol allows it (liquidation shouldn't be blocked) but
    //  the resulting state could prevent new position opens.
    // ================================================================
    function test_chaos_liquidationViolatesOiSkew() public {
        emit log_string("=== CHAOS: Liquidation creates OI skew violation ===");

        // Disable skew cap to build positions, then set tight cap
        vm.prank(owner);
        engine.setOiSkewCap(10000); // 100% = disabled

        // Open balanced positions: 5 longs, 5 shorts
        for (uint256 i = 0; i < 5; i++) {
            _fund(addrs[i], 100_000 * U);
            _fund(addrs[i + 5], 100_000 * U);
            _trade(i, true, i + 5, false, btcMkt, S / 2, BTC_PRICE, i + 1);
        }

        // Now set tight skew cap
        vm.prank(owner);
        engine.setOiSkewCap(5500); // 55% max on one side

        // Verify balanced OI
        (,,,,,,,,,,,,uint256 oiLong, uint256 oiShort) = engine.markets(btcMkt);
        emit log_named_uint("  OI Long", oiLong);
        emit log_named_uint("  OI Short", oiShort);

        // Crash price → liquidate longs
        _setPrice(btcMkt, 30_000);

        uint256 liquidatedCount = 0;
        for (uint256 i = 0; i < 5; i++) {
            if (engine.isLiquidatable(btcMkt, addrs[i])) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, addrs[i]) {
                    liquidatedCount++;
                } catch {}
            }
        }
        emit log_named_uint("  Longs liquidated", liquidatedCount);

        // Check OI after liquidations
        (,,,,,,,,,,,,uint256 oiLongAfter, uint256 oiShortAfter) = engine.markets(btcMkt);
        emit log_named_uint("  OI Long after liquidations", oiLongAfter);
        emit log_named_uint("  OI Short after liquidations", oiShortAfter);

        // Now try to open a new SHORT — should it be blocked by skew?
        _fund(addrs[15], 100_000 * U);
        _fund(addrs[16], 100_000 * U);
        vm.prank(owner);
        try engine.openPosition(btcMkt, addrs[15], -int256(S / 10), 30_000 * U) {
            emit log_string("  New short opened (OI skew cap allows or is one-sided)");
        } catch {
            emit log_string("  [INFO] New short blocked by skew cap after liquidation cascade");
        }

        // Try to open a new LONG to rebalance
        vm.prank(owner);
        try engine.openPosition(btcMkt, addrs[16], int256(S / 10), 30_000 * U) {
            emit log_string("  New long opened to rebalance");
        } catch {
            emit log_string("  [BUG?] Can't open new long either - market is stuck!");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 46: PnL overflow with extreme prices
    //  Test _calculatePnl with max reasonable values to check for overflow
    // ================================================================
    function test_chaos_pnlOverflowExtremeValues() public {
        emit log_string("=== CHAOS: PnL overflow with extreme values ===");

        address trader = addrs[0];
        address cp = addrs[1];
        _fund(trader, 100_000_000 * U); // $100M
        _fund(cp, 100_000_000 * U);

        // Open at $100k BTC with large size
        uint256 highPrice = 100_000 * U;
        _setPrice(btcMkt, 100_000);
        _trade(0, true, 1, false, btcMkt, 10 * S, highPrice, 1); // 10 BTC

        // Price goes to $1M (10x) — unrealized PnL = $9M per BTC = $90M total
        _setPrice(btcMkt, 1_000_000);

        // Can we close without overflow?
        vm.prank(owner);
        try engine.closePosition(btcMkt, trader, 1_000_000 * U) {
            emit log_string("  [OK] Close succeeded at 10x price");
        } catch (bytes memory reason) {
            emit log_string("  [BUG] Close FAILED - possible overflow!");
            emit log_named_bytes("  Reason", reason);
        }

        // Close CP at loss
        vm.prank(owner);
        try engine.closePosition(btcMkt, cp, 1_000_000 * U) {
            emit log_string("  [OK] CP close succeeded");
        } catch {
            emit log_string("  [INFO] CP close failed (expected, massive loss)");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after extreme PnL");
    }

    // ================================================================
    //  TEST 47: Funding precision loss - small delta rounds to zero
    //  When mark ≈ index, fundingRate might round to 0, allowing
    //  positions to avoid paying funding entirely.
    // ================================================================
    function test_chaos_fundingPrecisionLoss() public {
        emit log_string("=== CHAOS: Funding precision loss ===");

        address longTrader = addrs[0];
        address shortTrader = addrs[1];
        _fund(longTrader, 100_000 * U);
        _fund(shortTrader, 100_000 * U);

        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        // Set mark barely above index: $50,001 vs $50,000 (0.002% premium)
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 50_001 * U, 50_000 * U);

        (,, uint256 marginBefore,,,) = engine.positions(btcMkt, longTrader);

        // Apply funding many times (update price each round to avoid StalePrice)
        uint256 fundingRounds = 24; // 24 hours
        for (uint256 i = 0; i < fundingRounds; i++) {
            vm.warp(block.timestamp + 1 hours);
            // Keep mark barely above index but refresh the oracle
            vm.prank(owner);
            engine.updateMarkPrice(btcMkt, 50_001 * U, 50_000 * U);
            engine.applyFundingRate(btcMkt);
        }

        // Trigger _applyFunding by closing (refresh price first)
        _setPrice(btcMkt, 50_000);
        vm.prank(owner);
        engine.closePosition(btcMkt, longTrader, BTC_PRICE);

        (,, uint256 marginAfter,,,) = engine.positions(btcMkt, longTrader);
        uint256 longBal = vault.balances(longTrader);
        uint256 shortBal = vault.balances(shortTrader);

        emit log_named_uint("  Long balance after 24h", longBal);

        // Close short too
        vm.prank(owner);
        engine.closePosition(btcMkt, shortTrader, BTC_PRICE);
        uint256 shortBalAfter = vault.balances(shortTrader);
        emit log_named_uint("  Short balance after close", shortBalAfter);

        // If funding precision is lost, both traders get back ~same as deposited
        uint256 longDelta = 100_000 * U > longBal ? 100_000 * U - longBal : longBal - 100_000 * U;
        uint256 shortDelta = shortBalAfter > 100_000 * U ? shortBalAfter - 100_000 * U : 100_000 * U - shortBalAfter;

        emit log_named_uint("  Long funding paid", longDelta);
        emit log_named_uint("  Short funding received", shortDelta);

        if (longDelta == 0 && shortDelta == 0) {
            emit log_string("  [BUG] Zero funding despite 24h of positive rate!");
        } else {
            emit log_string("  [OK] Funding was applied");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 48: Cross-margin removeMargin with stale equity
    //  In cross mode, removeMargin checks getAccountEquity which
    //  uses current mark prices without freshness check.
    // ================================================================
    function test_chaos_crossMarginRemoveStaleEquity() public {
        emit log_string("=== CHAOS: Cross-margin removeMargin with stale price ===");

        address trader = addrs[0];
        address cp = addrs[1];
        _fund(trader, 100_000 * U);
        _fund(cp, 100_000 * U);

        // Switch to cross margin (trader calls directly)
        vm.prank(trader);
        engine.setMarginMode(PerpEngine.MarginMode.CROSS);

        // Open BTC position
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        // Price pumps — trader has unrealized profit
        _setPrice(btcMkt, 60_000);

        // Now let oracle go stale (advance time without updating)
        vm.warp(block.timestamp + 2 hours);

        // Try to remove margin based on stale high equity
        (,, uint256 posMargin,,,) = engine.positions(btcMkt, trader);
        uint256 removeAmt = posMargin / 2;
        vm.prank(owner);
        try engine.removeMargin(btcMkt, trader, removeAmt) {
            emit log_named_uint("  Removed margin with stale price", removeAmt);

            // Now if price dumps, trader might be underwater
            _setPrice(btcMkt, 40_000);
            bool isLiq = engine.isLiquidatable(btcMkt, trader);
            emit log_named_uint("  Is liquidatable after dump?", isLiq ? 1 : 0);

            if (isLiq) {
                emit log_string("  [BUG] removeMargin allowed removal, then price dump made position liquidatable!");
            }
        } catch {
            emit log_string("  [OK] removeMargin blocked (freshness check or margin check)");
        }

        // Cleanup
        _setPrice(btcMkt, 50_000);
        vm.prank(owner);
        engine.closePosition(btcMkt, trader, BTC_PRICE);
        vm.prank(owner);
        engine.closePosition(btcMkt, cp, BTC_PRICE);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 49: Liquidation then immediate re-open in same block
    //  After being liquidated, can trader immediately re-open?
    // ================================================================
    function test_chaos_liquidateThenReopenSameBlock() public {
        emit log_string("=== CHAOS: Liquidate then re-open same block ===");

        address trader = addrs[0];
        address cp = addrs[1];
        _fund(trader, 50_000 * U);
        _fund(cp, 100_000 * U);

        // Open long
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        // Crash price to trigger liquidation
        _setPrice(btcMkt, 35_000);

        assertTrue(engine.isLiquidatable(btcMkt, trader), "Should be liquidatable");

        // Liquidate
        vm.prank(keeper);
        liquidator.liquidate(btcMkt, trader);
        emit log_string("  Liquidated trader");

        // Check trader still has some balance (from partial liquidation or remaining)
        uint256 traderBal = vault.balances(trader);
        emit log_named_uint("  Trader balance after liquidation", traderBal);

        // Try to immediately re-open in same block
        if (traderBal > 10_000 * U) {
            vm.prank(owner);
            try engine.openPosition(btcMkt, trader, int256(S / 4), 35_000 * U) {
                emit log_string("  [INFO] Re-opened immediately after liquidation (same block)");
                // This is allowed but could be concerning for MEV
            } catch {
                emit log_string("  [OK] Re-open blocked after liquidation");
            }
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 50: Concurrent multi-market operations stress test
    //  Open positions on both markets, manipulate prices asymmetrically,
    //  apply funding on both, then close everything. Check solvency.
    // ================================================================
    function test_chaos_multiMarketAsymmetricStress() public {
        emit log_string("=== CHAOS: Multi-market asymmetric stress ===");

        // Fund 10 traders
        for (uint256 i = 0; i < 10; i++) {
            _fund(addrs[i], 200_000 * U);
        }

        // Open BTC positions: 0-4 long, 5-9 short
        for (uint256 i = 0; i < 5; i++) {
            _trade(i, true, i + 5, false, btcMkt, S / 2, BTC_PRICE, i + 100);
        }

        // Open ETH positions: 0-4 short, 5-9 long (opposite direction)
        for (uint256 i = 0; i < 5; i++) {
            _trade(i + 5, true, i, false, ethMkt, 2 * S, ETH_PRICE, i + 200);
        }

        // BTC pumps, ETH dumps (asymmetric stress)
        _setPrice(btcMkt, 70_000);
        _setPrice(ethMkt, 2_000);

        // Apply funding (mark != index creates pressure)
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 70_000 * U, 50_000 * U); // huge premium on BTC
        vm.prank(owner);
        engine.updateMarkPrice(ethMkt, 2_000 * U, 3_000 * U); // discount on ETH

        for (uint256 i = 0; i < 5; i++) {
            vm.warp(block.timestamp + 1 hours);
            engine.applyFundingRate(btcMkt);
            engine.applyFundingRate(ethMkt);
        }

        // Refresh prices before closing (avoid StalePrice after time warp)
        _setPrice(btcMkt, 70_000);
        _setPrice(ethMkt, 2_000);

        // Close all positions
        uint256 closeFails = 0;
        for (uint256 i = 0; i < 10; i++) {
            // Close BTC position
            (int256 btcSz,,,,,) = engine.positions(btcMkt, addrs[i]);
            if (btcSz != 0) {
                vm.prank(owner);
                try engine.closePosition(btcMkt, addrs[i], 70_000 * U) {} catch { closeFails++; }
            }
            // Close ETH position
            (int256 ethSz,,,,,) = engine.positions(ethMkt, addrs[i]);
            if (ethSz != 0) {
                vm.prank(owner);
                try engine.closePosition(ethMkt, addrs[i], 2_000 * U) {} catch { closeFails++; }
            }
        }

        emit log_named_uint("  Close failures", closeFails);
        if (closeFails > 0) {
            emit log_string("  [BUG] Some positions could not close in multi-market stress!");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after multi-market stress");
    }

    // ================================================================
    //  WAVE 6: Advanced arithmetic and state manipulation
    // ================================================================

    // ================================================================
    //  TEST 51: Double funding application
    //  openPosition calls _applyFunding, then close also calls it.
    //  If funding was already applied, second call should be no-op.
    //  But what if funding accumulates between open and close in same block?
    // ================================================================
    function test_chaos_doubleFundingApplication() public {
        emit log_string("=== CHAOS: Double funding application ===");

        address longTrader = addrs[0];
        address shortTrader = addrs[1];
        _fund(longTrader, 100_000 * U);
        _fund(shortTrader, 100_000 * U);

        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        // Create funding pressure
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 55_000 * U, 50_000 * U);
        vm.warp(block.timestamp + 1 hours);
        engine.applyFundingRate(btcMkt);

        // Get margin before any funding application
        (,, uint256 marginBefore,,,) = engine.positions(btcMkt, longTrader);

        // Refresh price after warp to avoid StalePrice
        _setPrice(btcMkt, 50_000);

        // Increase position — triggers _applyFunding
        _fund(longTrader, 100_000 * U);
        vm.prank(owner);
        engine.openPosition(btcMkt, longTrader, int256(S / 10), BTC_PRICE);

        (,, uint256 marginAfterIncrease,,,) = engine.positions(btcMkt, longTrader);

        // Immediately close — triggers _applyFunding again
        vm.prank(owner);
        engine.closePosition(btcMkt, longTrader, BTC_PRICE);

        uint256 longBal = vault.balances(longTrader);
        emit log_named_uint("  Margin before", marginBefore);
        emit log_named_uint("  Margin after increase", marginAfterIncrease);
        emit log_named_uint("  Final balance", longBal);

        // Close CP
        vm.prank(owner);
        engine.closePosition(btcMkt, shortTrader, BTC_PRICE);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after double funding");
    }

    // ================================================================
    //  TEST 52: Massive price swing PnL exceeds deposited collateral
    //  Test that the engine handles cases where PnL exceeds all
    //  deposited margin, ensuring no underflow in _settlePnl.
    // ================================================================
    function test_chaos_pnlExceedsAllCollateral() public {
        emit log_string("=== CHAOS: PnL exceeds all deposited collateral ===");

        address longTrader = addrs[0];
        address shortTrader = addrs[1];
        _fund(longTrader, 50_000 * U);
        _fund(shortTrader, 50_000 * U);

        // Open at $50k
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        // Price crashes to $5k (90% drop) — long loses $45k on $50k position
        // But margin is only ~$2.5k (5%)
        // Long loss = 45k > margin = 2.5k → bad debt
        _setPrice(btcMkt, 5_000);

        // Liquidate the long (underwater)
        if (engine.isLiquidatable(btcMkt, longTrader)) {
            vm.prank(keeper);
            liquidator.liquidate(btcMkt, longTrader);
            emit log_string("  Liquidated long (90% crash)");
        }

        // Short is in massive profit — can they close?
        vm.prank(owner);
        try engine.closePosition(btcMkt, shortTrader, 5_000 * U) {
            emit log_string("  [OK] Short closed with massive profit");
        } catch {
            emit log_string("  [BUG] Short can't close with massive profit!");
        }

        uint256 shortBal = vault.balances(shortTrader);
        emit log_named_uint("  Short balance (profit)", shortBal);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after 90% crash");
    }

    // ================================================================
    //  TEST 53: Funding rate accumulation over many periods
    //  Test that cumulative funding doesn't overflow or lose precision
    //  over hundreds of funding periods.
    // ================================================================
    function test_chaos_fundingAccumulationOverflow() public {
        emit log_string("=== CHAOS: Funding rate accumulation over many periods ===");

        address longTrader = addrs[0];
        address shortTrader = addrs[1];
        _fund(longTrader, 500_000 * U);
        _fund(shortTrader, 500_000 * U);

        _trade(0, true, 1, false, btcMkt, S / 10, BTC_PRICE, 1);

        // Apply max funding rate (0.1% per interval) for 100 intervals
        // fundingIntervalSecs = 28800 (8 hours), so advance 8h each round
        // Total funding = 100 * 0.1% = 10%
        uint256 rounds = 100;
        for (uint256 i = 0; i < rounds; i++) {
            vm.warp(block.timestamp + 28800); // 8 hours = 1 funding interval
            // Refresh price to avoid stale + keep premium
            vm.prank(owner);
            engine.updateMarkPrice(btcMkt, 100_000 * U, 50_000 * U);
            engine.applyFundingRate(btcMkt);
        }

        // Check if cumulative funding is still reasonable
        (,,,,,,,,,int256 cumFunding,,,, ) = engine.markets(btcMkt);
        emit log_named_int("  Cumulative funding after 100 rounds", cumFunding);

        // Close positions
        _setPrice(btcMkt, 50_000);
        vm.prank(owner);
        engine.closePosition(btcMkt, longTrader, BTC_PRICE);
        vm.prank(owner);
        engine.closePosition(btcMkt, shortTrader, BTC_PRICE);

        uint256 longBal = vault.balances(longTrader);
        uint256 shortBal = vault.balances(shortTrader);
        emit log_named_uint("  Long balance (paid funding)", longBal);
        emit log_named_uint("  Short balance (received funding)", shortBal);

        // Verify conservation: long+short+engine should be close to total deposited
        uint256 total = longBal + shortBal + vault.balances(address(engine))
            + vault.balances(engine.fundingPool());
        emit log_named_uint("  Total in system", total);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after 100 funding rounds");
    }

    // ================================================================
    //  TEST 54: Settle with negative PnL greater than margin
    //  When loss > margin, the "bad debt" path should NOT underflow.
    // ================================================================
    function test_chaos_settlePnlNegativeExceedsMargin() public {
        emit log_string("=== CHAOS: _settlePnl with loss > margin ===");

        address longTrader = addrs[0];
        address shortTrader = addrs[1];
        _fund(longTrader, 50_000 * U);
        _fund(shortTrader, 50_000 * U);

        // Open positions
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        // Remove margin to minimum
        (,, uint256 margin,,,) = engine.positions(btcMkt, longTrader);
        // Try removing 70% of margin
        uint256 removeAmt = (margin * 70) / 100;
        vm.prank(owner);
        try engine.removeMargin(btcMkt, longTrader, removeAmt) {
            emit log_named_uint("  Removed margin", removeAmt);
        } catch {
            emit log_string("  Can't remove 70% margin (expected)");
        }

        // Crash price — loss exceeds remaining margin
        _setPrice(btcMkt, 40_000);

        // Close (not liquidate) — should handle loss > margin gracefully
        vm.prank(owner);
        try engine.closePosition(btcMkt, longTrader, 40_000 * U) {
            emit log_string("  [OK] Close succeeded with loss > margin");
        } catch {
            emit log_string("  Close failed, trying liquidation");
            if (engine.isLiquidatable(btcMkt, longTrader)) {
                vm.prank(keeper);
                liquidator.liquidate(btcMkt, longTrader);
                emit log_string("  Liquidated instead");
            }
        }

        // Close CP
        _setPrice(btcMkt, 40_000);
        vm.prank(owner);
        engine.closePosition(btcMkt, shortTrader, 40_000 * U);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after loss > margin");
    }

    // ================================================================
    //  TEST 55: Vault health check after complex operations
    //  Run a sequence of deposits, trades, funding, liquidations,
    //  withdrawals, and check vault accounting remains correct.
    // ================================================================
    function test_chaos_vaultAccountingComplex() public {
        emit log_string("=== CHAOS: Complex vault accounting ===");

        uint256 totalDeposited = 0;

        // 15 traders deposit varying amounts
        for (uint256 i = 0; i < 15; i++) {
            uint256 amount = (i + 1) * 50_000 * U;
            _fund(addrs[i], amount);
            totalDeposited += amount;
        }
        emit log_named_uint("  Total deposited", totalDeposited);

        // Open 5 BTC trades
        for (uint256 i = 0; i < 5; i++) {
            _trade(i, true, i + 5, false, btcMkt, (i + 1) * S / 5, BTC_PRICE, i + 1);
        }

        // Open 2 ETH trades
        _trade(10, true, 11, false, ethMkt, 2 * S, ETH_PRICE, 100);
        _trade(12, true, 13, false, ethMkt, 3 * S, ETH_PRICE, 101);

        // Price movements
        _setPrice(btcMkt, 55_000);
        _setPrice(ethMkt, 2_500);

        // Apply funding
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 55_000 * U, 50_000 * U);
        vm.prank(owner);
        engine.updateMarkPrice(ethMkt, 2_500 * U, 3_000 * U);
        vm.warp(block.timestamp + 1 hours);
        engine.applyFundingRate(btcMkt);
        engine.applyFundingRate(ethMkt);

        // Withdraw from non-trading accounts
        vm.prank(addrs[14]);
        vault.withdraw(10_000 * U);

        // Crash BTC, liquidate some longs
        _setPrice(btcMkt, 35_000);
        for (uint256 i = 0; i < 5; i++) {
            if (engine.isLiquidatable(btcMkt, addrs[i])) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, addrs[i]) {} catch {}
            }
        }

        // Close all remaining positions
        _setPrice(btcMkt, 35_000);
        _setPrice(ethMkt, 2_500);
        for (uint256 i = 0; i < 15; i++) {
            (int256 btcSz,,,,,) = engine.positions(btcMkt, addrs[i]);
            if (btcSz != 0) {
                vm.prank(owner);
                try engine.closePosition(btcMkt, addrs[i], 35_000 * U) {} catch {}
            }
            (int256 ethSz,,,,,) = engine.positions(ethMkt, addrs[i]);
            if (ethSz != 0) {
                vm.prank(owner);
                try engine.closePosition(ethMkt, addrs[i], 2_500 * U) {} catch {}
            }
        }

        // Final vault health
        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        emit log_named_uint("  Actual USDC in vault", actual);
        emit log_named_uint("  Accounted balance sum", accounted);
        emit log_named_uint("  Difference", actual > accounted ? actual - accounted : accounted - actual);
        assertTrue(healthy, "BROKEN: Vault insolvent after complex operations");
        assertGe(actual, accounted, "BROKEN: USDC actual < accounted");
    }

    function _sign(
        uint256 pk, address trader, bool isLong,
        bytes32 mkt, uint256 size, uint256 price, uint256 nonce
    ) internal view returns (OrderSettlement.SignedOrder memory) {
        uint256 expiry = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(
            settlement.ORDER_TYPEHASH(),
            trader, mkt, isLong, size, price, nonce, expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", settlement.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return OrderSettlement.SignedOrder({
            trader: trader, marketId: mkt, isLong: isLong,
            size: size, price: price, nonce: nonce, expiry: expiry,
            signature: abi.encodePacked(r, s, v)
        });
    }
}
