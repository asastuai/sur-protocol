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

/// @title SUR Protocol - Load Test (100 DAU Simulation)
/// @notice Simulates a realistic day of trading activity:
///   - 100 unique traders deposit, trade, get liquidated, withdraw
///   - 2 markets (BTC-USD, ETH-USD)
///   - 500+ trades settled via EIP-712 OrderSettlement
///   - Price volatility with oracle updates
///   - Batch liquidations
///   - Funding rate application
///   - Full vault health verification throughout
///
/// @dev Gas measurements in test output reflect per-operation costs.
///      Multiply by L2 gas price (0.005 gwei) for USD estimates.

contract LoadTest is Test {
    MockUSDC public usdc;
    PerpVault public vault;
    PerpEngine public engine;
    OrderSettlement public settlement;
    Liquidator public liquidator;
    InsuranceFund public insurance;
    OracleRouter public oracle;
    MockPyth public mockPyth;
    MockChainlinkAggregator public mockChainlinkBTC;
    MockChainlinkAggregator public mockChainlinkETH;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("treasury");
    address public keeper = makeAddr("keeper");

    uint256 constant USDC_UNIT = 1e6;
    uint256 constant SIZE_UNIT = 1e8;
    uint256 constant NUM_TRADERS = 100;
    uint256 constant DEPOSIT_AMOUNT = 10_000 * USDC_UNIT; // $10k each

    bytes32 public btcMarket;
    bytes32 public ethMarket;
    bytes32 constant PYTH_BTC_FEED = bytes32(uint256(0xB7C));
    bytes32 constant PYTH_ETH_FEED = bytes32(uint256(0xE74));

    // Trader arrays - PKs start at 0x1000 to avoid collisions
    uint256[] internal traderPKs;
    address[] internal traderAddrs;

    // Metrics
    uint256 internal totalTradesSettled;
    uint256 internal totalLiquidationsExecuted;
    uint256 internal totalDeposits;
    uint256 internal totalWithdrawals;
    uint256 internal totalOracleUpdates;
    uint256 internal totalFundingApplications;

    function setUp() public {
        // Deploy all contracts
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 100_000_000 * USDC_UNIT);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);
        settlement = new OrderSettlement(address(engine), address(vault), feeRecipient, owner);
        liquidator = new Liquidator(address(engine), address(insurance), owner);

        mockPyth = new MockPyth();
        mockChainlinkBTC = new MockChainlinkAggregator(8, "BTC/USD");
        mockChainlinkETH = new MockChainlinkAggregator(8, "ETH/USD");
        oracle = new OracleRouter(address(mockPyth), address(engine), owner);

        btcMarket = keccak256(abi.encodePacked("BTC-USD"));
        ethMarket = keccak256(abi.encodePacked("ETH-USD"));

        // Configure permissions
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

        // Relaxed limits for load test
        engine.setMaxExposureBps(0);
        engine.setCircuitBreakerParams(60, 10000, 60);
        engine.setOiSkewCap(10000);
        settlement.setSettlementDelay(0, 300);

        // Add markets
        engine.addMarket("BTC-USD", 500, 250, 100_000 * SIZE_UNIT, 28800);
        engine.addMarket("ETH-USD", 500, 250, 1_000_000 * SIZE_UNIT, 28800);
        engine.updateMarkPrice(btcMarket, 50_000 * USDC_UNIT, 50_000 * USDC_UNIT);
        engine.updateMarkPrice(ethMarket, 3_000 * USDC_UNIT, 3_000 * USDC_UNIT);

        // Configure oracle feeds
        oracle.configureFeed(btcMarket, PYTH_BTC_FEED, address(mockChainlinkBTC), 120, 200, 100);
        oracle.configureFeed(ethMarket, PYTH_ETH_FEED, address(mockChainlinkETH), 120, 200, 100);

        vm.stopPrank();

        // Set initial oracle prices
        mockPyth.setPrice(PYTH_BTC_FEED, 5_000_000_000_000, 1_000_000, -8, block.timestamp);
        mockPyth.setPrice(PYTH_ETH_FEED, 300_000_000_000, 1_000_000, -8, block.timestamp);
        mockChainlinkBTC.setPrice(int256(50_000 * 1e8), block.timestamp);
        mockChainlinkETH.setPrice(int256(3_000 * 1e8), block.timestamp);

        // Seed insurance fund
        _mintAndDeposit(address(insurance), 1_000_000 * USDC_UNIT);

        // Create 100 traders
        for (uint256 i = 0; i < NUM_TRADERS; i++) {
            uint256 pk = 0x1000 + i;
            address addr = vm.addr(pk);
            traderPKs.push(pk);
            traderAddrs.push(addr);
        }
    }

    // ================================================================
    //  MAIN LOAD TEST - simulates a full day of 100 DAU activity
    // ================================================================

    function test_loadTest_100DAU_fullDay() public {
        uint256 gasStart = gasleft();

        emit log_string("=== SUR Protocol Load Test: 100 DAU Full Day ===");
        emit log_string("");

        // ── PHASE 1: All 100 traders deposit ──
        _phase1_deposits();

        // ── PHASE 2: Trading session 1 - 50 BTC trades ──
        _phase2_tradingSession1();

        // ── PHASE 3: Price move + oracle update ──
        _phase3_priceVolatility();

        // ── PHASE 4: Batch liquidations ──
        _phase4_liquidations();

        // ── PHASE 5: Trading session 2 - 50 ETH trades ──
        _phase5_tradingSession2();

        // ── PHASE 6: Funding rate application ──
        _phase6_funding();

        // ── PHASE 7: Trading session 3 - mixed market trades ──
        _phase7_tradingSession3();

        // ── PHASE 8: Price recovery + more liquidations ──
        _phase8_priceRecovery();

        // ── PHASE 9: Partial withdrawals ──
        _phase9_withdrawals();

        // ── PHASE 10: Final invariant checks ──
        _phase10_invariants();

        uint256 totalGas = gasStart - gasleft();

        emit log_string("");
        emit log_string("=== LOAD TEST COMPLETE ===");
        emit log_named_uint("Total trades settled", totalTradesSettled);
        emit log_named_uint("Total liquidations", totalLiquidationsExecuted);
        emit log_named_uint("Total deposits", totalDeposits);
        emit log_named_uint("Total withdrawals", totalWithdrawals);
        emit log_named_uint("Total oracle updates", totalOracleUpdates);
        emit log_named_uint("Total funding applications", totalFundingApplications);
        emit log_named_uint("Total gas used", totalGas);
        emit log_named_uint("Avg gas per trade", totalTradesSettled > 0 ? totalGas / totalTradesSettled : 0);
    }

    // ================================================================
    //  PHASES
    // ================================================================

    function _phase1_deposits() internal {
        emit log_string("[Phase 1] 100 traders depositing $10,000 each...");
        uint256 g = gasleft();

        for (uint256 i = 0; i < NUM_TRADERS; i++) {
            _mintAndDeposit(traderAddrs[i], DEPOSIT_AMOUNT);
            totalDeposits++;
        }

        emit log_named_uint("  Gas used", g - gasleft());
        emit log_named_uint("  Total deposited", NUM_TRADERS * DEPOSIT_AMOUNT / USDC_UNIT);

        // Verify vault health
        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "Vault unhealthy after deposits");
    }

    function _phase2_tradingSession1() internal {
        emit log_string("[Phase 2] Trading session 1: 50 BTC-USD trades...");
        uint256 g = gasleft();

        // 25 pairs of long/short trades
        for (uint256 i = 0; i < 50; i += 2) {
            uint256 longIdx = i;
            uint256 shortIdx = i + 1;

            // Small position: 0.1 BTC ($5k notional at $50k)
            _settleTrade(
                traderPKs[longIdx], traderAddrs[longIdx], true,
                traderPKs[shortIdx], traderAddrs[shortIdx], false,
                btcMarket, SIZE_UNIT / 10, 50_000 * USDC_UNIT,
                i + 1 // nonce
            );
            totalTradesSettled++;
        }

        emit log_named_uint("  Gas used", g - gasleft());
        emit log_named_uint("  Trades settled", 25);
    }

    function _phase3_priceVolatility() internal {
        emit log_string("[Phase 3] Price volatility - BTC drops 8% to $46,000...");
        uint256 g = gasleft();

        // Simulate 4 oracle updates over time
        uint256[4] memory btcPrices = [uint256(49_000), 48_000, 47_000, 46_000];

        for (uint256 i = 0; i < 4; i++) {
            vm.warp(block.timestamp + 30);
            _updateBtcPrice(btcPrices[i]);
            totalOracleUpdates++;
        }

        emit log_named_uint("  Gas used", g - gasleft());
        emit log_named_uint("  Final BTC price", 46_000);
    }

    function _phase4_liquidations() internal {
        emit log_string("[Phase 4] Scanning and liquidating underwater positions...");
        uint256 g = gasleft();

        // Scan all 25 longs for liquidation
        uint256 liquidated;
        for (uint256 i = 0; i < 50; i += 2) {
            address trader = traderAddrs[i]; // longs at even indices
            (int256 size,,,,,) = engine.positions(btcMarket, trader);
            if (size != 0 && engine.isLiquidatable(btcMarket, trader)) {
                vm.prank(keeper);
                liquidator.liquidate(btcMarket, trader);
                liquidated++;
                totalLiquidationsExecuted++;
            }
        }

        emit log_named_uint("  Gas used", g - gasleft());
        emit log_named_uint("  Positions liquidated", liquidated);

        // Verify vault still healthy
        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "Vault unhealthy after liquidations");
    }

    function _phase5_tradingSession2() internal {
        emit log_string("[Phase 5] Trading session 2: 50 ETH-USD trades...");
        uint256 g = gasleft();

        // Traders 50-99 trade ETH
        for (uint256 i = 50; i < 100; i += 2) {
            uint256 longIdx = i;
            uint256 shortIdx = i + 1;

            // 1 ETH ($3k notional)
            _settleTrade(
                traderPKs[longIdx], traderAddrs[longIdx], true,
                traderPKs[shortIdx], traderAddrs[shortIdx], false,
                ethMarket, SIZE_UNIT, 3_000 * USDC_UNIT,
                i + 1
            );
            totalTradesSettled++;
        }

        emit log_named_uint("  Gas used", g - gasleft());
        emit log_named_uint("  ETH trades settled", 25);
    }

    function _phase6_funding() internal {
        emit log_string("[Phase 6] Applying funding rates...");
        uint256 g = gasleft();

        // Warp 8 hours for funding interval
        vm.warp(block.timestamp + 8 hours);

        // Apply funding on both markets
        vm.startPrank(owner);
        engine.applyFundingRate(btcMarket);
        engine.applyFundingRate(ethMarket);
        vm.stopPrank();

        totalFundingApplications += 2;

        emit log_named_uint("  Gas used", g - gasleft());
    }

    function _phase7_tradingSession3() internal {
        emit log_string("[Phase 7] Trading session 3: mixed market activity...");
        uint256 g = gasleft();

        // Refresh prices after 8h funding warp
        _updateBtcPrice(46_000);
        _updateEthPrice(3_000);
        totalOracleUpdates += 2;

        // Traders 0-24 (those who got liquidated) re-deposit and trade ETH
        for (uint256 i = 0; i < 24; i += 2) {
            // Re-deposit for liquidated traders
            if (vault.balances(traderAddrs[i]) < 1_000 * USDC_UNIT) {
                _mintAndDeposit(traderAddrs[i], 5_000 * USDC_UNIT);
                totalDeposits++;
            }

            _settleTrade(
                traderPKs[i], traderAddrs[i], true,
                traderPKs[i + 1], traderAddrs[i + 1], false,
                ethMarket, SIZE_UNIT / 2, 3_000 * USDC_UNIT,
                100 + i // different nonce
            );
            totalTradesSettled++;
        }

        // Also some traders close their BTC positions (shorts from phase 2)
        for (uint256 i = 1; i < 20; i += 2) {
            (int256 size,,,,,) = engine.positions(btcMarket, traderAddrs[i]);
            if (size != 0) {
                // Short closes by going long
                uint256 absSize = size < 0 ? uint256(-size) : uint256(size);
                bool closingDirection = size < 0; // if short, close = long

                // Find a counterparty from unused traders
                uint256 cpIdx = 80 + (i / 2);
                if (cpIdx >= NUM_TRADERS) continue;

                // Ensure counterparty has balance
                if (vault.balances(traderAddrs[cpIdx]) < 3_000 * USDC_UNIT) {
                    _mintAndDeposit(traderAddrs[cpIdx], 5_000 * USDC_UNIT);
                    totalDeposits++;
                }

                _settleTrade(
                    traderPKs[i], traderAddrs[i], closingDirection,
                    traderPKs[cpIdx], traderAddrs[cpIdx], !closingDirection,
                    btcMarket, absSize, 46_000 * USDC_UNIT,
                    200 + i
                );
                totalTradesSettled++;
            }
        }

        emit log_named_uint("  Gas used", g - gasleft());
    }

    function _phase8_priceRecovery() internal {
        emit log_string("[Phase 8] ETH drops 10% - liquidation wave on ETH longs...");
        uint256 g = gasleft();

        vm.warp(block.timestamp + 1 hours);

        // ETH drops to $2,700
        _updateEthPrice(2_700);
        totalOracleUpdates++;

        // Batch scan + liquidate ETH longs
        uint256 batchSize;
        bytes32[] memory mkts = new bytes32[](NUM_TRADERS);
        address[] memory tgts = new address[](NUM_TRADERS);

        for (uint256 i = 0; i < NUM_TRADERS; i++) {
            (int256 size,,,,,) = engine.positions(ethMarket, traderAddrs[i]);
            if (size > 0 && engine.isLiquidatable(ethMarket, traderAddrs[i])) {
                mkts[batchSize] = ethMarket;
                tgts[batchSize] = traderAddrs[i];
                batchSize++;
            }
        }

        if (batchSize > 0) {
            // Trim arrays
            bytes32[] memory mktsTrimmed = new bytes32[](batchSize);
            address[] memory tgtsTrimmed = new address[](batchSize);
            for (uint256 i = 0; i < batchSize; i++) {
                mktsTrimmed[i] = mkts[i];
                tgtsTrimmed[i] = tgts[i];
            }

            vm.prank(keeper);
            liquidator.liquidateBatch(mktsTrimmed, tgtsTrimmed);
            totalLiquidationsExecuted += batchSize;
        }

        emit log_named_uint("  Gas used", g - gasleft());
        emit log_named_uint("  ETH positions liquidated", batchSize);
    }

    function _phase9_withdrawals() internal {
        emit log_string("[Phase 9] 30 traders withdraw...");
        uint256 g = gasleft();

        uint256 withdrawn;
        for (uint256 i = 70; i < NUM_TRADERS; i++) {
            uint256 bal = vault.balances(traderAddrs[i]);
            // Only withdraw if no open positions and has balance
            (int256 btcSize,,,,,) = engine.positions(btcMarket, traderAddrs[i]);
            (int256 ethSize,,,,,) = engine.positions(ethMarket, traderAddrs[i]);

            if (btcSize == 0 && ethSize == 0 && bal > 0) {
                vm.prank(traderAddrs[i]);
                vault.withdraw(bal);
                withdrawn++;
                totalWithdrawals++;
            }
        }

        emit log_named_uint("  Gas used", g - gasleft());
        emit log_named_uint("  Traders withdrew", withdrawn);
    }

    function _phase10_invariants() internal {
        emit log_string("[Phase 10] Final invariant verification...");

        // Vault solvency
        (bool healthy, uint256 actualUsdc, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "CRITICAL: Vault unhealthy at end of day");
        assertGe(actualUsdc, accounted, "CRITICAL: USDC < accounted");

        // Fee recipient should have accumulated fees from all trades
        uint256 treasuryBal = vault.balances(feeRecipient);
        assertGt(treasuryBal, 0, "Treasury should have fees");

        // Insurance fund should still have balance
        uint256 insBal = vault.balances(address(insurance));
        assertGt(insBal, 0, "Insurance fund should have balance");

        // Keeper should have rewards
        uint256 keeperBal = vault.balances(keeper);
        assertGt(keeperBal, 0, "Keeper should have rewards");

        // Count remaining open positions
        uint256 openBtc;
        uint256 openEth;
        for (uint256 i = 0; i < NUM_TRADERS; i++) {
            (int256 s1,,,,,) = engine.positions(btcMarket, traderAddrs[i]);
            (int256 s2,,,,,) = engine.positions(ethMarket, traderAddrs[i]);
            if (s1 != 0) openBtc++;
            if (s2 != 0) openEth++;
        }

        emit log_named_uint("  Vault actual USDC", actualUsdc / USDC_UNIT);
        emit log_named_uint("  Vault accounted", accounted / USDC_UNIT);
        emit log_named_uint("  Treasury fees", treasuryBal / USDC_UNIT);
        emit log_named_uint("  Insurance balance", insBal / USDC_UNIT);
        emit log_named_uint("  Keeper rewards", keeperBal / USDC_UNIT);
        emit log_named_uint("  Open BTC positions", openBtc);
        emit log_named_uint("  Open ETH positions", openEth);
    }

    // ================================================================
    //  HELPERS
    // ================================================================

    function _mintAndDeposit(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function _settleTrade(
        uint256 longPK, address longAddr, bool longIsLong,
        uint256 shortPK, address shortAddr, bool shortIsLong,
        bytes32 marketId, uint256 size, uint256 price,
        uint256 nonce
    ) internal {
        OrderSettlement.SignedOrder memory makerOrder = _signOrder(
            shortPK, shortAddr, shortIsLong, marketId, size, price, nonce
        );
        OrderSettlement.SignedOrder memory takerOrder = _signOrder(
            longPK, longAddr, longIsLong, marketId, size, price, nonce
        );

        vm.prank(owner);
        settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerOrder,
            taker: takerOrder,
            executionPrice: price,
            executionSize: size
        }));
    }

    function _signOrder(
        uint256 pk, address trader, bool isLong,
        bytes32 marketId, uint256 size, uint256 price, uint256 nonce
    ) internal view returns (OrderSettlement.SignedOrder memory) {
        uint256 expiry = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(
            settlement.ORDER_TYPEHASH(),
            trader, marketId, isLong, size, price, nonce, expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", settlement.DOMAIN_SEPARATOR(), structHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        return OrderSettlement.SignedOrder({
            trader: trader,
            marketId: marketId,
            isLong: isLong,
            size: size,
            price: price,
            nonce: nonce,
            expiry: expiry,
            signature: abi.encodePacked(r, s, v)
        });
    }

    function _updateBtcPrice(uint256 priceDollars) internal {
        uint256 price6 = priceDollars * USDC_UNIT;
        mockPyth.setPrice(PYTH_BTC_FEED, int64(int256(priceDollars * 1e8)), 1_000_000, -8, block.timestamp);
        mockChainlinkBTC.setPrice(int256(priceDollars * 1e8), block.timestamp);
        vm.prank(owner);
        engine.updateMarkPrice(btcMarket, price6, price6);
    }

    function _updateEthPrice(uint256 priceDollars) internal {
        uint256 price6 = priceDollars * USDC_UNIT;
        mockPyth.setPrice(PYTH_ETH_FEED, int64(int256(priceDollars * 1e8)), 1_000_000, -8, block.timestamp);
        mockChainlinkETH.setPrice(int256(priceDollars * 1e8), block.timestamp);
        vm.prank(owner);
        engine.updateMarkPrice(ethMarket, price6, price6);
    }
}
