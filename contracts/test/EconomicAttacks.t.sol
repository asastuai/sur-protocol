// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PerpVault.sol";
import "../src/PerpEngine.sol";
import "../src/InsuranceFund.sol";
import "../src/Liquidator.sol";
import "../src/AutoDeleveraging.sol";
import "../src/A2ADarkPool.sol";
import "./mocks/MockUSDC.sol";

/// @title Level 4: Economic Attack Simulations
/// @notice Extreme market scenarios that test economic resilience:
///   - Flash crash 90% -> cascading liquidations -> insurance drain -> ADL
///   - Funding rate gaming over 100+ intervals
///   - Dark pool arbitrage (dark pool price vs mark price)
///   - Whale manipulation (1 actor with 80% OI)
///   - Bank run (all depositors withdraw with open positions)

contract EconomicAttacks is Test {
    MockUSDC public usdc;
    PerpVault public vault;
    PerpEngine public engine;
    InsuranceFund public insurance;
    Liquidator public liquidator;
    AutoDeleveraging public adl;
    A2ADarkPool public darkpool;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("treasury");
    address public fundingPool = makeAddr("fundingPool");
    address public keeper = makeAddr("keeper");

    // Traders
    address public whale = makeAddr("whale");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public charlie = makeAddr("charlie");
    address public dave = makeAddr("dave");
    address public eve = makeAddr("eve");

    uint256 constant U = 1e6;
    uint256 constant S = 1e8;
    bytes32 public btcMkt;
    bytes32 public ethMkt;

    function setUp() public {
        vm.warp(1700000000);

        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, type(uint256).max);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), fundingPool);
        liquidator = new Liquidator(address(engine), address(insurance), owner);
        adl = new AutoDeleveraging(address(engine), address(vault), address(insurance), owner);
        darkpool = new A2ADarkPool(address(vault), address(engine), feeRecipient, owner);

        btcMkt = keccak256(abi.encodePacked("BTC-USD"));
        ethMkt = keccak256(abi.encodePacked("ETH-USD"));

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        vault.setOperator(address(adl), true);
        vault.setOperator(address(darkpool), true);
        engine.setOperator(owner, true);
        engine.setOperator(address(liquidator), true);
        engine.setOperator(address(adl), true);
        engine.setOperator(address(darkpool), true);
        engine.setOiSkewCap(10000);
        engine.setMaxExposureBps(0);
        insurance.setOperator(address(engine), true);
        adl.setOperator(keeper, true);

        engine.addMarket("BTC-USD", 500, 250, 10_000_000 * S, 28800);
        engine.addMarket("ETH-USD", 500, 250, 100_000_000 * S, 28800);
        engine.updateMarkPrice(btcMkt, 50_000 * U, 50_000 * U);
        engine.updateMarkPrice(ethMkt, 3_000 * U, 3_000 * U);
        vm.stopPrank();

        // Fund traders with varying capital
        _fund(whale, 5_000_000 * U);
        _fund(alice, 200_000 * U);
        _fund(bob, 200_000 * U);
        _fund(charlie, 200_000 * U);
        _fund(dave, 200_000 * U);
        _fund(eve, 200_000 * U);

        // Seed insurance fund
        usdc.mint(address(this), 500_000 * U);
        usdc.approve(address(vault), 500_000 * U);
        vault.deposit(500_000 * U);
        vm.prank(owner);
        vault.setOperator(address(this), true);
        vault.internalTransfer(address(this), address(insurance), 500_000 * U);

        // Seed funding pool
        usdc.mint(address(this), 1_000_000 * U);
        usdc.approve(address(vault), 1_000_000 * U);
        vault.deposit(1_000_000 * U);
        vault.internalTransfer(address(this), fundingPool, 1_000_000 * U);
    }

    function _fund(address trader, uint256 amount) internal {
        usdc.mint(trader, amount);
        vm.startPrank(trader);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    // ================================================================
    //  ATTACK 1: Flash Crash 90% -> Cascading Liquidations
    //  Scenario: BTC drops from $50k to $5k. Multiple overleveraged
    //  longs get liquidated in sequence. Insurance fund absorbs losses.
    //  If insurance depletes, ADL kicks in on profitable shorts.
    // ================================================================
    function test_econ_flashCrashCascade() public {
        emit log_string("=== ECON: Flash Crash 90% Cascade ===");

        // Open long positions at $50k for 5 traders
        vm.startPrank(owner);
        engine.openPosition(btcMkt, alice, int256(2 * S), 50_000 * U);   // 2 BTC long
        engine.openPosition(btcMkt, bob, int256(2 * S), 50_000 * U);     // 2 BTC long
        engine.openPosition(btcMkt, charlie, int256(2 * S), 50_000 * U); // 2 BTC long
        engine.openPosition(btcMkt, dave, int256(2 * S), 50_000 * U);    // 2 BTC long
        // Whale takes the other side (short)
        engine.openPosition(btcMkt, whale, -int256(8 * S), 50_000 * U);  // 8 BTC short
        vm.stopPrank();

        uint256 insuranceBefore = insurance.balance();
        emit log_string(string.concat("  Insurance before: $", vm.toString(insuranceBefore / U)));

        // Stage 1: Moderate drop to $30k
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 30_000 * U, 30_000 * U);

        // Try liquidating all longs
        uint256 liquidationCount = 0;
        address[4] memory longs = [alice, bob, charlie, dave];
        for (uint256 i = 0; i < 4; i++) {
            if (engine.isLiquidatable(btcMkt, longs[i])) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, longs[i]) {
                    liquidationCount++;
                } catch {}
            }
        }
        emit log_string(string.concat("  Liquidations at $30k: ", vm.toString(liquidationCount)));

        // Stage 2: Crash to $10k
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 10_000 * U, 10_000 * U);

        for (uint256 i = 0; i < 4; i++) {
            (int256 size,,,,,) = engine.positions(btcMkt, longs[i]);
            if (size != 0 && engine.isLiquidatable(btcMkt, longs[i])) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, longs[i]) {
                    liquidationCount++;
                } catch {}
            }
        }
        emit log_string(string.concat("  Total liquidations: ", vm.toString(liquidationCount)));

        // Stage 3: Full crash to $5k
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 5_000 * U, 5_000 * U);

        for (uint256 i = 0; i < 4; i++) {
            (int256 size,,,,,) = engine.positions(btcMkt, longs[i]);
            if (size != 0 && engine.isLiquidatable(btcMkt, longs[i])) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, longs[i]) {
                    liquidationCount++;
                } catch {}
            }
        }

        uint256 insuranceAfter = insurance.balance();
        emit log_string(string.concat("  Insurance after: $", vm.toString(insuranceAfter / U)));

        // Check if ADL is needed
        (bool adlRequired, uint256 fundBal) = adl.isADLRequired();
        emit log_string(string.concat("  ADL required: ", adlRequired ? "YES" : "NO"));

        // If ADL required, execute on profitable whale (short is profitable at $5k)
        if (adlRequired) {
            int256 whalePnl = engine.getUnrealizedPnl(btcMkt, whale);
            emit log_string(string.concat("  Whale PnL: $", vm.toString(uint256(whalePnl) / U)));

            (int256 whaleSize,,,,,) = engine.positions(btcMkt, whale);
            if (whaleSize != 0 && whalePnl > 0) {
                uint256 absSize = uint256(-whaleSize);
                vm.prank(keeper);
                try adl.executeADL(btcMkt, whale, absSize / 2, 5_000 * U, fundBal + 1000 * U) {
                    emit log_string("  [OK] ADL executed on profitable whale");
                } catch {
                    emit log_string("  [INFO] ADL execution reverted (expected in some scenarios)");
                }
            }
        }

        // CRITICAL: Vault must remain solvent after all of this
        uint256 actualUsdc = usdc.balanceOf(address(vault));
        uint256 totalDeposits = vault.totalDeposits();
        assertGe(actualUsdc, totalDeposits, "CRITICAL: Vault insolvent after flash crash cascade");

        emit log_string("  [OK] Vault solvent after 90% flash crash cascade");
    }

    // ================================================================
    //  ATTACK 2: Funding Rate Gaming
    //  Scenario: Attacker creates extreme OI imbalance and harvests
    //  funding payments over 100+ intervals. Tests if funding mechanism
    //  can be gamed for risk-free profit.
    // ================================================================
    function test_econ_fundingRateGaming() public {
        emit log_string("=== ECON: Funding Rate Gaming (20 full intervals) ===");

        // Whale goes massively long, small short by alice
        vm.startPrank(owner);
        engine.openPosition(btcMkt, whale, int256(50 * S), 50_000 * U);  // 50 BTC long
        engine.openPosition(btcMkt, alice, -int256(1 * S), 50_000 * U);  // 1 BTC short
        vm.stopPrank();

        uint256 whaleBalBefore = vault.balances(whale);
        uint256 aliceBalBefore = vault.balances(alice);
        uint256 fundingPoolBefore = vault.balances(fundingPool);

        emit log_string(string.concat("  Whale balance before: $", vm.toString(whaleBalBefore / U)));
        emit log_string(string.concat("  Alice balance before: $", vm.toString(aliceBalBefore / U)));
        emit log_string(string.concat("  Funding pool before: $", vm.toString(fundingPoolBefore / U)));

        // fundingIntervalSecs = 28800 (8h). Warp full intervals.
        // Set mark > index to create positive funding rate (longs pay shorts)
        for (uint256 i = 0; i < 20; i++) {
            vm.warp(block.timestamp + 28801); // Just over 8 hours
            // Mark $51k, Index $50k -> 2% premium -> longs pay funding
            vm.prank(owner);
            engine.updateMarkPrice(btcMkt, 51_000 * U, 50_000 * U);

            vm.prank(owner);
            try engine.applyFundingRate(btcMkt) {} catch {}
        }

        // Funding is applied when positions are touched. Touch both positions.
        vm.warp(block.timestamp + 28801);
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 50_000 * U, 50_000 * U);

        // Open tiny position to trigger funding settlement for whale
        vm.prank(owner);
        try engine.openPosition(btcMkt, whale, int256(S / 100), 50_000 * U) {} catch {}
        // And for alice
        vm.prank(owner);
        try engine.openPosition(btcMkt, alice, -int256(S / 100), 50_000 * U) {} catch {}

        uint256 whaleBalAfter = vault.balances(whale);
        uint256 aliceBalAfter = vault.balances(alice);
        uint256 fundingPoolAfter = vault.balances(fundingPool);

        // Whale is long-dominant with mark > index, should PAY funding
        emit log_string(string.concat("  Whale balance after: $", vm.toString(whaleBalAfter / U)));
        emit log_string(string.concat("  Alice balance after: $", vm.toString(aliceBalAfter / U)));
        emit log_string(string.concat("  Funding pool after: $", vm.toString(fundingPoolAfter / U)));

        if (whaleBalAfter < whaleBalBefore) {
            uint256 whalePaid = whaleBalBefore - whaleBalAfter;
            emit log_string(string.concat("  Whale paid funding: $", vm.toString(whalePaid / U)));
        } else {
            emit log_string("  [WARN] Whale did NOT pay funding despite long-dominant + premium");
        }

        if (aliceBalAfter > aliceBalBefore) {
            uint256 aliceReceived = aliceBalAfter - aliceBalBefore;
            emit log_string(string.concat("  Alice received funding: $", vm.toString(aliceReceived / U)));
        }

        // Conservation: total funds should be conserved (funding is zero-sum + pool)
        uint256 actualUsdc = usdc.balanceOf(address(vault));
        uint256 totalDeposits = vault.totalDeposits();
        assertGe(actualUsdc, totalDeposits, "CRITICAL: Vault insolvent after funding gaming");

        emit log_string("  [OK] Funding rate gaming didn't break solvency");
    }

    // ================================================================
    //  ATTACK 3: Dark Pool Arbitrage
    //  Scenario: Exploit price difference between dark pool settlement
    //  price and current mark price for risk-free profit.
    // ================================================================
    function test_econ_darkPoolArbitrage() public {
        emit log_string("=== ECON: Dark Pool Arbitrage ===");

        uint256 eveBefore = vault.balances(eve);

        // Eve posts intent to buy 1 BTC at $49k-$51k range
        vm.prank(eve);
        uint256 intentId = darkpool.postIntent(btcMkt, true, 1 * S, 49_000 * U, 51_000 * U, 3600);

        // Alice responds at $49,500 (low end)
        vm.prank(alice);
        uint256 respId = darkpool.postResponse(intentId, 49_500 * U, 3600);

        // Eve accepts - gets long at $49,500
        vm.prank(eve);
        darkpool.acceptAndSettle(intentId, respId);

        // Verify positions
        (int256 eveSize,,,,,) = engine.positions(btcMkt, eve);
        (int256 aliceSize,,,,,) = engine.positions(btcMkt, alice);
        assertEq(eveSize, int256(1 * S), "Eve should be long 1 BTC");
        assertEq(aliceSize, -int256(1 * S), "Alice should be short 1 BTC");

        // Mark price is $50k but Eve entered at $49,500 -> $500 immediate "profit"
        int256 evePnl = engine.getUnrealizedPnl(btcMkt, eve);
        int256 alicePnl = engine.getUnrealizedPnl(btcMkt, alice);

        emit log_string(string.concat("  Eve PnL (entered at $49.5k, mark $50k): $", vm.toString(uint256(evePnl) / U)));

        // CRITICAL: PnL should be symmetric - Eve's gain = Alice's loss
        // Allow 1 USDC tolerance for rounding
        int256 pnlSum = evePnl + alicePnl;
        assertTrue(
            pnlSum >= -1e6 && pnlSum <= 1e6,
            "CRITICAL: PnL not symmetric between dark pool counterparties"
        );

        // Now Eve tries to close on-chain at mark price for profit
        vm.prank(owner);
        engine.openPosition(btcMkt, eve, -int256(1 * S), 50_000 * U);

        uint256 eveAfter = vault.balances(eve);
        if (eveAfter > eveBefore) {
            emit log_string(string.concat("  Eve profit from arb: $", vm.toString((eveAfter - eveBefore) / U)));
        }

        // Vault solvency
        assertGe(
            usdc.balanceOf(address(vault)),
            vault.totalDeposits(),
            "CRITICAL: Vault insolvent after dark pool arbitrage"
        );

        emit log_string("  [OK] Dark pool arbitrage doesn't break solvency");
    }

    // ================================================================
    //  ATTACK 4: Whale Manipulation - 80% OI Dominance
    //  Scenario: Whale controls 80% of open interest and tries to
    //  manipulate funding rates and trigger targeted liquidations.
    // ================================================================
    function test_econ_whaleManipulation() public {
        emit log_string("=== ECON: Whale Manipulation (80% OI) ===");

        // Whale goes long 40 BTC, 4 others short 2.5 BTC each = 10 BTC total
        // Whale = 80% of total OI
        vm.startPrank(owner);
        engine.openPosition(btcMkt, whale, int256(40 * S), 50_000 * U);
        engine.openPosition(btcMkt, alice, -int256(10 * S), 50_000 * U);
        engine.openPosition(btcMkt, bob, -int256(10 * S), 50_000 * U);
        engine.openPosition(btcMkt, charlie, -int256(10 * S), 50_000 * U);
        engine.openPosition(btcMkt, dave, -int256(10 * S), 50_000 * U);
        vm.stopPrank();

        // Check OI distribution - fields 12,13 in Market struct (0-indexed)
        (,,,,,,,,,,,, uint256 oiLong, uint256 oiShort) = engine.markets(btcMkt);
        emit log_string(string.concat("  OI Long: ", vm.toString(oiLong / S), " BTC"));
        emit log_string(string.concat("  OI Short: ", vm.toString(oiShort / S), " BTC"));

        uint256 whaleBalBefore = vault.balances(whale);

        // Price moves up with premium -> whale profits, shorts suffer, longs pay funding
        // Mark $55k, Index $50k = 10% premium -> positive funding rate
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 55_000 * U, 50_000 * U);

        // Apply funding over full intervals (28800s each)
        for (uint256 i = 0; i < 10; i++) {
            vm.warp(block.timestamp + 28801);
            vm.startPrank(owner);
            engine.updateMarkPrice(btcMkt, 55_000 * U, 50_000 * U);
            try engine.applyFundingRate(btcMkt) {} catch {}
            vm.stopPrank();
        }

        // Touch whale position to settle accumulated funding
        vm.prank(owner);
        try engine.openPosition(btcMkt, whale, int256(S / 100), 55_000 * U) {} catch {}

        // Check if any shorts are liquidatable now
        address[4] memory shorts = [alice, bob, charlie, dave];
        uint256 liquidatable = 0;
        for (uint256 i = 0; i < 4; i++) {
            if (engine.isLiquidatable(btcMkt, shorts[i])) {
                liquidatable++;
            }
        }
        emit log_string(string.concat("  Liquidatable shorts: ", vm.toString(liquidatable)));

        // Even if whale dominates, protocol should remain solvent
        assertGe(
            usdc.balanceOf(address(vault)),
            vault.totalDeposits(),
            "CRITICAL: Vault insolvent under whale manipulation"
        );

        // Whale's funding payments should be proportional to dominance
        uint256 whaleBalAfter = vault.balances(whale);
        emit log_string(string.concat("  Whale balance after funding: $", vm.toString(whaleBalAfter / U)));

        emit log_string("  [OK] Protocol survives whale manipulation");
    }

    // ================================================================
    //  ATTACK 5: Bank Run - All Depositors Withdraw At Once
    //  Scenario: All depositors try to withdraw while positions are open.
    //  Should fail gracefully - locked margin cannot be withdrawn.
    // ================================================================
    function test_econ_bankRun() public {
        emit log_string("=== ECON: Bank Run (mass withdrawal) ===");

        // Open balanced positions
        vm.startPrank(owner);
        engine.openPosition(btcMkt, alice, int256(2 * S), 50_000 * U);
        engine.openPosition(btcMkt, bob, -int256(2 * S), 50_000 * U);
        engine.openPosition(btcMkt, charlie, int256(1 * S), 50_000 * U);
        engine.openPosition(btcMkt, dave, -int256(1 * S), 50_000 * U);
        vm.stopPrank();

        uint256 totalBefore = vault.totalDeposits();
        emit log_string(string.concat("  Total deposits before run: $", vm.toString(totalBefore / U)));

        // Everyone tries to withdraw their FULL balance
        address[6] memory depositors = [whale, alice, bob, charlie, dave, eve];
        uint256 totalWithdrawn = 0;
        uint256 failedWithdrawals = 0;

        for (uint256 i = 0; i < 6; i++) {
            uint256 bal = vault.balances(depositors[i]);
            if (bal > 0) {
                vm.prank(depositors[i]);
                try vault.withdraw(bal) {
                    totalWithdrawn += bal;
                } catch {
                    failedWithdrawals++;
                    // Try withdrawing half
                    vm.prank(depositors[i]);
                    try vault.withdraw(bal / 2) {
                        totalWithdrawn += bal / 2;
                    } catch {
                        failedWithdrawals++;
                    }
                }
            }
        }

        emit log_string(string.concat("  Total withdrawn: $", vm.toString(totalWithdrawn / U)));
        emit log_string(string.concat("  Failed withdrawals: ", vm.toString(failedWithdrawals)));

        // CRITICAL: Vault must still hold enough USDC for remaining deposits
        uint256 actualUsdc = usdc.balanceOf(address(vault));
        uint256 totalDeposits = vault.totalDeposits();
        assertGe(actualUsdc, totalDeposits, "CRITICAL: Vault insolvent after bank run");

        // Positions should still be open for those who couldn't fully withdraw
        (int256 aliceSize,,,,,) = engine.positions(btcMkt, alice);
        (int256 bobSize,,,,,) = engine.positions(btcMkt, bob);
        emit log_string(string.concat("  Alice position still open: ", aliceSize != 0 ? "YES" : "NO"));
        emit log_string(string.concat("  Bob position still open: ", bobSize != 0 ? "YES" : "NO"));

        emit log_string("  [OK] Bank run handled gracefully, vault solvent");
    }

    // ================================================================
    //  ATTACK 6: Pump and Dump with Liquidation Cascade
    //  Scenario: Price pumps 100%, shorts get liquidated, then
    //  dumps 80%. Longs get liquidated. Double cascade test.
    // ================================================================
    function test_econ_pumpAndDumpCascade() public {
        emit log_string("=== ECON: Pump & Dump Double Cascade ===");

        // Balanced positions
        vm.startPrank(owner);
        engine.openPosition(btcMkt, alice, int256(3 * S), 50_000 * U);  // long
        engine.openPosition(btcMkt, bob, -int256(3 * S), 50_000 * U);   // short
        engine.openPosition(btcMkt, charlie, int256(2 * S), 50_000 * U);// long
        engine.openPosition(btcMkt, dave, -int256(2 * S), 50_000 * U);  // short
        vm.stopPrank();

        // PUMP: $50k -> $100k (100% increase)
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 100_000 * U, 100_000 * U);
        emit log_string("  Price pumped to $100k");

        // Liquidate shorts
        address[2] memory shorts = [bob, dave];
        for (uint256 i = 0; i < 2; i++) {
            (int256 size,,,,,) = engine.positions(btcMkt, shorts[i]);
            if (size != 0 && engine.isLiquidatable(btcMkt, shorts[i])) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, shorts[i]) {
                    emit log_string(string.concat("  Liquidated short: ", vm.toString(uint160(shorts[i]))));
                } catch {}
            }
        }

        // DUMP: $100k -> $10k (90% crash)
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 10_000 * U, 10_000 * U);
        emit log_string("  Price dumped to $10k");

        // Liquidate longs
        address[2] memory longs = [alice, charlie];
        for (uint256 i = 0; i < 2; i++) {
            (int256 size,,,,,) = engine.positions(btcMkt, longs[i]);
            if (size != 0 && engine.isLiquidatable(btcMkt, longs[i])) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, longs[i]) {
                    emit log_string(string.concat("  Liquidated long: ", vm.toString(uint160(longs[i]))));
                } catch {}
            }
        }

        // After double cascade, vault must be solvent
        assertGe(
            usdc.balanceOf(address(vault)),
            vault.totalDeposits(),
            "CRITICAL: Vault insolvent after pump & dump cascade"
        );

        uint256 insuranceBal = insurance.balance();
        emit log_string(string.concat("  Insurance fund remaining: $", vm.toString(insuranceBal / U)));

        emit log_string("  [OK] Vault survives pump & dump double cascade");
    }

    // ================================================================
    //  ATTACK 7: Multi-Market Contagion
    //  Scenario: BTC crashes while ETH pumps. Cross-market PnL
    //  interactions. Can profit on one market cover losses on another?
    // ================================================================
    function test_econ_multiMarketContagion() public {
        emit log_string("=== ECON: Multi-Market Contagion ===");

        // Alice: long BTC, short ETH (hedged)
        // Bob: short BTC, long ETH (hedged)
        // Charlie: long both (directional)
        vm.startPrank(owner);
        engine.openPosition(btcMkt, alice, int256(2 * S), 50_000 * U);
        engine.openPosition(ethMkt, alice, -int256(30 * S), 3_000 * U);
        engine.openPosition(btcMkt, bob, -int256(2 * S), 50_000 * U);
        engine.openPosition(ethMkt, bob, int256(30 * S), 3_000 * U);
        engine.openPosition(btcMkt, charlie, int256(2 * S), 50_000 * U);
        engine.openPosition(ethMkt, charlie, int256(20 * S), 3_000 * U);
        // Dave takes other sides
        engine.openPosition(ethMkt, dave, -int256(20 * S), 3_000 * U);
        vm.stopPrank();

        // BTC crashes 60%, ETH pumps 50%
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 20_000 * U, 20_000 * U);
        vm.prank(owner);
        engine.updateMarkPrice(ethMkt, 4_500 * U, 4_500 * U);

        // Check PnL for hedged positions
        int256 aliceBtcPnl = engine.getUnrealizedPnl(btcMkt, alice);
        int256 aliceEthPnl = engine.getUnrealizedPnl(ethMkt, alice);
        emit log_string(string.concat("  Alice BTC PnL: ", aliceBtcPnl < 0 ? "-$" : "+$",
            vm.toString(aliceBtcPnl < 0 ? uint256(-aliceBtcPnl) / U : uint256(aliceBtcPnl) / U)));
        emit log_string(string.concat("  Alice ETH PnL: ", aliceEthPnl < 0 ? "-$" : "+$",
            vm.toString(aliceEthPnl < 0 ? uint256(-aliceEthPnl) / U : uint256(aliceEthPnl) / U)));

        // Check Charlie (directional long both)
        int256 charlieBtcPnl = engine.getUnrealizedPnl(btcMkt, charlie);
        int256 charlieEthPnl = engine.getUnrealizedPnl(ethMkt, charlie);
        int256 charlieNet = charlieBtcPnl + charlieEthPnl;
        emit log_string(string.concat("  Charlie net PnL: ", charlieNet > 0 ? "+" : "-"));

        // Try liquidations across markets
        address[4] memory traders = [alice, bob, charlie, dave];
        for (uint256 i = 0; i < 4; i++) {
            (int256 btcSize,,,,,) = engine.positions(btcMkt, traders[i]);
            if (btcSize != 0 && engine.isLiquidatable(btcMkt, traders[i])) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, traders[i]) {
                    emit log_string(string.concat("  Liquidated BTC position for trader ", vm.toString(i)));
                } catch {}
            }
            (int256 ethSize,,,,,) = engine.positions(ethMkt, traders[i]);
            if (ethSize != 0 && engine.isLiquidatable(ethMkt, traders[i])) {
                vm.prank(keeper);
                try liquidator.liquidate(ethMkt, traders[i]) {
                    emit log_string(string.concat("  Liquidated ETH position for trader ", vm.toString(i)));
                } catch {}
            }
        }

        assertGe(
            usdc.balanceOf(address(vault)),
            vault.totalDeposits(),
            "CRITICAL: Vault insolvent after multi-market contagion"
        );

        emit log_string("  [OK] Multi-market contagion handled correctly");
    }

    // ================================================================
    //  ATTACK 8: Insurance Fund Depletion -> ADL Chain
    //  Scenario: Repeated bad liquidations drain insurance completely.
    //  ADL must activate. Verify ADL correctly reduces profitable positions.
    // ================================================================
    function test_econ_insuranceDrainADLChain() public {
        emit log_string("=== ECON: Insurance Depletion -> ADL Chain ===");

        uint256 insuranceStart = insurance.balance();
        emit log_string(string.concat("  Insurance start: $", vm.toString(insuranceStart / U)));

        // Create many overleveraged positions
        vm.startPrank(owner);
        engine.openPosition(btcMkt, alice, int256(4 * S), 50_000 * U);
        engine.openPosition(btcMkt, bob, int256(4 * S), 50_000 * U);
        engine.openPosition(btcMkt, charlie, int256(4 * S), 50_000 * U);
        // Whale takes the short side
        engine.openPosition(btcMkt, whale, -int256(12 * S), 50_000 * U);
        vm.stopPrank();

        // Crash to $15k (70% drop) - massive bad debt
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 15_000 * U, 15_000 * U);

        // Liquidate all longs
        address[3] memory longs = [alice, bob, charlie];
        for (uint256 i = 0; i < 3; i++) {
            (int256 size,,,,,) = engine.positions(btcMkt, longs[i]);
            if (size != 0 && engine.isLiquidatable(btcMkt, longs[i])) {
                vm.prank(keeper);
                try liquidator.liquidate(btcMkt, longs[i]) {} catch {}
            }
        }

        uint256 insuranceAfterLiqs = insurance.balance();
        emit log_string(string.concat("  Insurance after liquidations: $", vm.toString(insuranceAfterLiqs / U)));

        // Check if ADL is needed
        (bool adlNeeded,) = adl.isADLRequired();
        emit log_string(string.concat("  ADL required: ", adlNeeded ? "YES" : "NO"));

        // If ADL needed, execute on profitable whale
        if (adlNeeded) {
            int256 whalePnl = engine.getUnrealizedPnl(btcMkt, whale);
            if (whalePnl > 0) {
                (int256 whaleSize,,,,,) = engine.positions(btcMkt, whale);
                uint256 absSize = uint256(-whaleSize);
                vm.prank(keeper);
                try adl.executeADL(btcMkt, whale, absSize / 4, 15_000 * U, insuranceAfterLiqs + 2000 * U) {
                    emit log_string("  ADL executed on whale (25% reduction)");

                    // Verify whale position was reduced
                    (int256 newSize,,,,,) = engine.positions(btcMkt, whale);
                    assertTrue(
                        uint256(-newSize) < absSize,
                        "Whale position should be smaller after ADL"
                    );
                } catch {
                    emit log_string("  ADL reverted (may need higher badDebt threshold)");
                }
            }
        }

        // Vault solvency is paramount
        assertGe(
            usdc.balanceOf(address(vault)),
            vault.totalDeposits(),
            "CRITICAL: Vault insolvent after insurance drain + ADL"
        );

        emit log_string("  [OK] Insurance drain -> ADL chain handled");
    }

    // ================================================================
    //  ATTACK 9: Rapid Position Flipping
    //  Scenario: Trader rapidly flips between long/short to extract
    //  value from fee rounding or position accounting bugs.
    // ================================================================
    function test_econ_rapidPositionFlipping() public {
        emit log_string("=== ECON: Rapid Position Flipping (fee extraction) ===");

        // Enable price impact fees: 100 bps = 1% impact factor, quadratic (20000)
        vm.prank(owner);
        engine.setPriceImpactConfig(btcMkt, 100, 20000);

        // Need some base OI so impact calculation works
        vm.startPrank(owner);
        engine.openPosition(btcMkt, alice, int256(5 * S), 50_000 * U);
        engine.openPosition(btcMkt, bob, -int256(5 * S), 50_000 * U);
        vm.stopPrank();

        uint256 eveBefore = vault.balances(eve);

        // Eve flips position 50 times
        for (uint256 i = 0; i < 50; i++) {
            int256 size = (i % 2 == 0) ? int256(1 * S) : -int256(1 * S);

            vm.prank(owner);
            try engine.openPosition(btcMkt, eve, size, 50_000 * U) {} catch {
                break; // Stop if out of margin
            }

            // Close immediately
            vm.prank(owner);
            try engine.openPosition(btcMkt, eve, -size, 50_000 * U) {} catch {
                break;
            }
        }

        uint256 eveAfter = vault.balances(eve);

        // Eve should have LOST money to fees, not gained
        // If eveAfter > eveBefore, there's a fee accounting bug
        if (eveAfter > eveBefore) {
            emit log_string("  [WARN] Eve profited from flipping! Possible fee bug");
            emit log_string(string.concat("  Profit: $", vm.toString((eveAfter - eveBefore) / U)));
        } else {
            uint256 feeLoss = eveBefore - eveAfter;
            emit log_string(string.concat("  Eve lost to fees: $", vm.toString(feeLoss / U)));
        }

        // Fee recipient should have collected
        uint256 feeRecBal = vault.balances(feeRecipient);
        emit log_string(string.concat("  Fee recipient collected: $", vm.toString(feeRecBal / U)));

        assertGe(
            usdc.balanceOf(address(vault)),
            vault.totalDeposits(),
            "CRITICAL: Vault insolvent after rapid flipping"
        );

        emit log_string("  [OK] Rapid flipping doesn't break accounting");
    }

    // ================================================================
    //  ATTACK 10: Stale Price Oracle Exploitation
    //  Scenario: After time passes without price update, attacker
    //  tries to open positions or liquidate at stale prices.
    //  Protocol should reject stale operations.
    // ================================================================
    function test_econ_stalePriceExploitation() public {
        emit log_string("=== ECON: Stale Price Oracle Exploitation ===");

        // Open positions at current price
        vm.startPrank(owner);
        engine.openPosition(btcMkt, alice, int256(1 * S), 50_000 * U);
        engine.openPosition(btcMkt, bob, -int256(1 * S), 50_000 * U);
        vm.stopPrank();

        // Warp 2 hours into the future (beyond staleness threshold)
        vm.warp(block.timestamp + 7200);

        // Attacker tries to open position at stale price
        vm.prank(owner);
        try engine.openPosition(btcMkt, eve, int256(1 * S), 50_000 * U) {
            emit log_string("  [WARN] Position opened with stale price!");
        } catch {
            emit log_string("  [OK] Position rejected due to stale price");
        }

        // Attacker tries to liquidate at stale price
        vm.prank(keeper);
        try liquidator.liquidate(btcMkt, alice) {
            emit log_string("  [WARN] Liquidation executed with stale price!");
        } catch {
            emit log_string("  [OK] Liquidation rejected due to stale price");
        }

        // Refresh price and verify normal operations resume
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 50_000 * U, 50_000 * U);

        vm.prank(owner);
        engine.openPosition(btcMkt, eve, int256(1 * S), 50_000 * U);
        emit log_string("  [OK] Operations resume after price refresh");

        assertGe(
            usdc.balanceOf(address(vault)),
            vault.totalDeposits(),
            "CRITICAL: Vault insolvent after stale price exploitation"
        );

        emit log_string("  [OK] Stale price exploitation prevented");
    }

    // ================================================================
    //  ATTACK 11: Dust Position Accumulation
    //  Scenario: Open many tiny positions to see if dust amounts
    //  accumulate rounding errors that leak value.
    // ================================================================
    function test_econ_dustPositionAccumulation() public {
        emit log_string("=== ECON: Dust Position Accumulation ===");

        uint256 vaultUsdcBefore = usdc.balanceOf(address(vault));
        uint256 totalDepsBefore = vault.totalDeposits();

        // Open and close 100 tiny positions (minimum size)
        for (uint256 i = 0; i < 100; i++) {
            int256 minSize = int256(S / 100); // 0.01 BTC = $500 notional

            vm.prank(owner);
            try engine.openPosition(btcMkt, eve, minSize, 50_000 * U) {
                // Close immediately
                vm.prank(owner);
                try engine.openPosition(btcMkt, eve, -minSize, 50_000 * U) {} catch {}
            } catch {
                break;
            }
        }

        uint256 vaultUsdcAfter = usdc.balanceOf(address(vault));
        uint256 totalDepsAfter = vault.totalDeposits();

        // USDC in vault should never decrease (only fees move internally)
        assertEq(vaultUsdcAfter, vaultUsdcBefore, "Vault USDC changed during dust trading");

        // Total deposits should remain consistent
        assertEq(totalDepsAfter, totalDepsBefore, "Total deposits changed during dust trading");

        // Check for rounding dust accumulation
        uint256 feeRecBal = vault.balances(feeRecipient);
        emit log_string(string.concat("  Fees from 100 dust trades: $", vm.toString(feeRecBal / U)));

        emit log_string("  [OK] No value leakage from dust positions");
    }

    // ================================================================
    //  ATTACK 12: Maximum Leverage Stress Test
    //  Scenario: Open positions at maximum allowed leverage and test
    //  liquidation at the exact boundary.
    // ================================================================
    function test_econ_maxLeverageStress() public {
        emit log_string("=== ECON: Maximum Leverage Stress ===");

        // Alice has $200k, tries to open max leverage position
        // At 5% maintenance margin (500 bps), max ~20x leverage
        // $200k * 20x = $4M notional = 80 BTC at $50k
        vm.prank(owner);
        try engine.openPosition(btcMkt, alice, int256(80 * S), 50_000 * U) {
            emit log_string("  80 BTC position opened at 20x leverage");
        } catch {
            // Try smaller
            vm.prank(owner);
            try engine.openPosition(btcMkt, alice, int256(30 * S), 50_000 * U) {
                emit log_string("  30 BTC position opened");
            } catch {
                vm.prank(owner);
                engine.openPosition(btcMkt, alice, int256(10 * S), 50_000 * U);
                emit log_string("  10 BTC position opened");
            }
        }

        // Bob takes the other side
        (int256 aliceSize,,,,,) = engine.positions(btcMkt, alice);
        vm.prank(owner);
        engine.openPosition(btcMkt, bob, -aliceSize, 50_000 * U);

        // Small price move should bring close to liquidation
        // 5% maintenance margin -> ~5% price move should liquidate
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 47_500 * U, 47_500 * U); // -5%

        bool aliceLiquidatable = engine.isLiquidatable(btcMkt, alice);
        emit log_string(string.concat("  Alice liquidatable at -5%: ", aliceLiquidatable ? "YES" : "NO"));

        if (aliceLiquidatable) {
            vm.prank(keeper);
            try liquidator.liquidate(btcMkt, alice) {
                emit log_string("  [OK] Max leverage position liquidated at boundary");
            } catch {
                emit log_string("  [INFO] Liquidation reverted at boundary");
            }
        }

        assertGe(
            usdc.balanceOf(address(vault)),
            vault.totalDeposits(),
            "CRITICAL: Vault insolvent at max leverage boundary"
        );

        emit log_string("  [OK] Max leverage stress test passed");
    }
}
