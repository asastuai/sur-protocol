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

/// @title OrderSettlement Chaos Tests
/// @notice Attack vectors: signature replay, fee extraction, self-trade,
///         partial fill nonce burn, commit-settle bypass, dynamic spread manipulation

contract OrderSettlementChaosTest is Test {
    MockUSDC public usdc;
    PerpVault public vault;
    PerpEngine public engine;
    OrderSettlement public settlement;
    Liquidator public liquidator;
    InsuranceFund public insurance;
    OracleRouter public oracle;
    MockPyth public mockPyth;
    MockChainlinkAggregator public mockCL_BTC;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("treasury");
    address public keeper = makeAddr("keeper");

    uint256 constant U = 1e6;
    uint256 constant S = 1e8;
    uint256 constant BTC_PRICE = 50_000 * U;

    bytes32 public btcMkt;
    bytes32 constant PYTH_BTC = bytes32(uint256(0xB7C));

    uint256[] public pks;
    address[] public addrs;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, type(uint256).max);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);
        settlement = new OrderSettlement(address(engine), address(vault), feeRecipient, owner);
        liquidator = new Liquidator(address(engine), address(insurance), owner);
        mockPyth = new MockPyth();
        mockCL_BTC = new MockChainlinkAggregator(8, "BTC/USD");
        oracle = new OracleRouter(address(mockPyth), address(engine), owner);

        btcMkt = keccak256(abi.encodePacked("BTC-USD"));

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
        settlement.setSettlementDelay(0, 300); // no commit required

        engine.addMarket("BTC-USD", 500, 250, 1_000_000 * S, 28800);
        engine.updateMarkPrice(btcMkt, BTC_PRICE, BTC_PRICE);
        oracle.configureFeed(btcMkt, PYTH_BTC, address(mockCL_BTC), 120, 500, 200);
        vm.stopPrank();

        mockPyth.setPrice(PYTH_BTC, int64(int256(50_000 * 1e8)), 1_000_000, -8, block.timestamp);
        mockCL_BTC.setPrice(int256(50_000 * 1e8), block.timestamp);

        _fund(address(insurance), 10_000_000 * U);

        for (uint256 i = 0; i < 20; i++) {
            uint256 pk = 0x3000 + i;
            pks.push(pk);
            addrs.push(vm.addr(pk));
        }
    }

    // ================================================================
    //  TEST 1: Self-trade (maker == taker same address)
    //  Can a trader trade with themselves to farm fees or manipulate?
    // ================================================================
    function test_settlement_selfTrade() public {
        emit log_string("=== SETTLEMENT: Self-trade attack ===");

        address trader = addrs[0];
        _fund(trader, 100_000 * U);

        // Try to create a trade where maker and taker are the same person
        uint256 pk = pks[0];
        OrderSettlement.SignedOrder memory makerOrder = _signOrder(pk, trader, false, btcMkt, S, BTC_PRICE, 1);
        OrderSettlement.SignedOrder memory takerOrder = _signOrder(pk, trader, true, btcMkt, S, BTC_PRICE, 2);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSignature("SelfTrade()"));
        settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerOrder, taker: takerOrder,
            executionPrice: BTC_PRICE, executionSize: S
        }));
        emit log_string("  [OK] Self-trade blocked with SelfTrade() error");

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 2: Partial fill burns nonce — rest of order is lost
    //  If executionSize < order.size, the nonce is burned.
    //  The remaining unfilled portion is permanently lost.
    // ================================================================
    function test_settlement_partialFillNonceBurn() public {
        emit log_string("=== SETTLEMENT: Partial fill nonce burn ===");

        address maker = addrs[0];
        address taker = addrs[1];
        _fund(maker, 100_000 * U);
        _fund(taker, 100_000 * U);

        // Maker signs for 1 BTC, but only 0.1 BTC gets filled
        OrderSettlement.SignedOrder memory makerOrder = _signOrder(pks[0], maker, false, btcMkt, S, BTC_PRICE, 1);
        OrderSettlement.SignedOrder memory takerOrder = _signOrder(pks[1], taker, true, btcMkt, S / 10, BTC_PRICE, 1);

        vm.prank(owner);
        settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerOrder, taker: takerOrder,
            executionPrice: BTC_PRICE, executionSize: S / 10  // only 0.1 BTC
        }));

        emit log_string("  Partial fill executed (0.1 of 1.0 BTC)");

        // Maker's nonce is now burned — can they fill the rest?
        bool makerNonceUsed = settlement.isNonceUsed(maker, 1);
        emit log_named_uint("  Maker nonce burned?", makerNonceUsed ? 1 : 0);

        if (makerNonceUsed) {
            emit log_string("  [BUG] Maker nonce burned on partial fill! 0.9 BTC order is permanently lost.");
            emit log_string("  Impact: Makers lose unfilled order portions on every partial fill.");
        } else {
            emit log_string("  [OK] Maker nonce not burned on partial fill");
        }

        // Taker nonce too
        bool takerNonceUsed = settlement.isNonceUsed(taker, 1);
        emit log_named_uint("  Taker nonce burned?", takerNonceUsed ? 1 : 0);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 3: Operator can set execution price anywhere in limit range
    //  The operator (off-chain engine) decides the executionPrice.
    //  A malicious operator can front-run by setting price at the edge.
    // ================================================================
    function test_settlement_operatorPriceManipulation() public {
        emit log_string("=== SETTLEMENT: Operator execution price manipulation ===");

        address maker = addrs[0];
        address taker = addrs[1];
        _fund(maker, 100_000 * U);
        _fund(taker, 100_000 * U);

        // Maker (short) signs at $51k limit, Taker (long) signs at $52k limit
        // Honest execution: somewhere between $51k-$52k
        uint256 makerPrice = 51_000 * U;
        uint256 takerPrice = 52_000 * U;

        OrderSettlement.SignedOrder memory makerOrder = _signOrder(pks[0], maker, false, btcMkt, S, makerPrice, 1);
        OrderSettlement.SignedOrder memory takerOrder = _signOrder(pks[1], taker, true, btcMkt, S, takerPrice, 1);

        // Malicious operator: execute at taker's max price to maximize slippage for taker
        vm.prank(owner);
        settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerOrder, taker: takerOrder,
            executionPrice: takerPrice,  // worst possible for taker
            executionSize: S
        }));

        emit log_string("  Trade executed at taker's max limit price ($52k)");
        emit log_string("  Maker got $1k better price than their limit");
        emit log_string("  Taker got worst possible execution");

        // Now try the opposite: execute at maker's min price
        OrderSettlement.SignedOrder memory makerOrder2 = _signOrder(pks[0], maker, false, btcMkt, S, makerPrice, 2);
        OrderSettlement.SignedOrder memory takerOrder2 = _signOrder(pks[1], taker, true, btcMkt, S, takerPrice, 2);

        vm.prank(owner);
        settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerOrder2, taker: takerOrder2,
            executionPrice: makerPrice,  // worst possible for maker
            executionSize: S
        }));

        emit log_string("  Trade 2 executed at maker's min price ($51k)");
        emit log_string("  [INFO] Operator has full discretion over execution price within limits");
        emit log_string("  This is a trust assumption: operator must be honest for fair pricing");

        // Cleanup
        vm.prank(owner);
        engine.closePosition(btcMkt, maker, BTC_PRICE);
        vm.prank(owner);
        engine.closePosition(btcMkt, taker, BTC_PRICE);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 4: Commit-settle delay bypass when delay is 0
    //  With minSettlementDelay=0, no commit needed. Is this safe?
    // ================================================================
    function test_settlement_noCommitRequired() public {
        emit log_string("=== SETTLEMENT: No commit required (delay=0) ===");

        // Verify current setting
        uint256 minDelay = settlement.minSettlementDelay();
        emit log_named_uint("  Current minSettlementDelay", minDelay);

        address maker = addrs[0];
        address taker = addrs[1];
        _fund(maker, 100_000 * U);
        _fund(taker, 100_000 * U);

        // Settle without any commit
        OrderSettlement.SignedOrder memory makerOrder = _signOrder(pks[0], maker, false, btcMkt, S, BTC_PRICE, 1);
        OrderSettlement.SignedOrder memory takerOrder = _signOrder(pks[1], taker, true, btcMkt, S, BTC_PRICE, 1);

        vm.prank(owner);
        try settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerOrder, taker: takerOrder,
            executionPrice: BTC_PRICE, executionSize: S
        })) {
            if (minDelay == 0) {
                emit log_string("  [OK] Settlement without commit (delay=0, expected)");
            } else {
                emit log_string("  [BUG] Settlement without commit despite delay > 0!");
            }
        } catch {
            emit log_string("  Settlement blocked (commit required)");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 5: Enable commit-settle delay and try to bypass it
    // ================================================================
    function test_settlement_commitSettleDelayEnforcement() public {
        emit log_string("=== SETTLEMENT: Commit-settle delay enforcement ===");

        // Enable 5-second delay
        vm.prank(owner);
        settlement.setSettlementDelay(5, 300);

        address maker = addrs[0];
        address taker = addrs[1];
        _fund(maker, 100_000 * U);
        _fund(taker, 100_000 * U);

        OrderSettlement.SignedOrder memory makerOrder = _signOrder(pks[0], maker, false, btcMkt, S, BTC_PRICE, 1);
        OrderSettlement.SignedOrder memory takerOrder = _signOrder(pks[1], taker, true, btcMkt, S, BTC_PRICE, 1);

        // Try to settle without commit
        vm.prank(owner);
        try settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerOrder, taker: takerOrder,
            executionPrice: BTC_PRICE, executionSize: S
        })) {
            emit log_string("  [BUG] Settled without commit!");
        } catch {
            emit log_string("  [OK] Blocked without commit");
        }

        // Commit both orders
        bytes32 makerDigest = settlement.getOrderDigest(maker, btcMkt, false, S, BTC_PRICE, 1, makerOrder.expiry);
        bytes32 takerDigest = settlement.getOrderDigest(taker, btcMkt, true, S, BTC_PRICE, 1, takerOrder.expiry);
        vm.prank(owner);
        settlement.commitOrder(makerDigest);
        vm.prank(owner);
        settlement.commitOrder(takerDigest);

        // Try to settle immediately (before delay)
        vm.prank(owner);
        try settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerOrder, taker: takerOrder,
            executionPrice: BTC_PRICE, executionSize: S
        })) {
            emit log_string("  [BUG] Settled before delay expired!");
        } catch {
            emit log_string("  [OK] Blocked before delay");
        }

        // Wait for delay and settle
        vm.warp(block.timestamp + 6);
        vm.prank(owner);
        try settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerOrder, taker: takerOrder,
            executionPrice: BTC_PRICE, executionSize: S
        })) {
            emit log_string("  [OK] Settled after delay");
        } catch {
            emit log_string("  [BUG] Can't settle even after delay!");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 6: Fee drain with large notional
    //  Test if notional calculation (price * size / SIZE_PRECISION)
    //  overflows for extreme values
    // ================================================================
    function test_settlement_feeOverflowLargeNotional() public {
        emit log_string("=== SETTLEMENT: Fee overflow with large notional ===");

        address maker = addrs[0];
        address taker = addrs[1];
        _fund(maker, 1_000_000_000 * U); // $1B
        _fund(taker, 1_000_000_000 * U);

        // Max reasonable: $100k BTC * 10,000 BTC = $1B notional
        uint256 bigSize = 10_000 * S;
        uint256 bigPrice = 100_000 * U;
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, bigPrice, bigPrice);
        mockPyth.setPrice(PYTH_BTC, int64(int256(100_000 * 1e8)), 1_000_000, -8, block.timestamp);
        mockCL_BTC.setPrice(int256(100_000 * 1e8), block.timestamp);

        OrderSettlement.SignedOrder memory makerOrder = _signOrder(pks[0], maker, false, btcMkt, bigSize, bigPrice, 1);
        OrderSettlement.SignedOrder memory takerOrder = _signOrder(pks[1], taker, true, btcMkt, bigSize, bigPrice, 1);

        uint256 feeBefore = vault.balances(feeRecipient);

        vm.prank(owner);
        try settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerOrder, taker: takerOrder,
            executionPrice: bigPrice, executionSize: bigSize
        })) {
            uint256 feeAfter = vault.balances(feeRecipient);
            uint256 totalFees = feeAfter - feeBefore;
            emit log_named_uint("  Total fees collected ($)", totalFees / U);
            // Expected: $1B notional * (0.02% + 0.06%) = $800k
            emit log_string("  [OK] Large notional settled without overflow");
        } catch (bytes memory reason) {
            emit log_string("  [BUG] Large notional settlement failed!");
            emit log_named_bytes("  Reason", reason);
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 7: Batch settlement atomicity
    //  If one trade in a batch fails, does the whole batch revert?
    //  Or do some trades settle and others don't?
    // ================================================================
    function test_settlement_batchAtomicity() public {
        emit log_string("=== SETTLEMENT: Batch atomicity ===");

        // Trade 1: valid
        _fund(addrs[0], 100_000 * U);
        _fund(addrs[1], 100_000 * U);
        // Trade 2: taker has no funds (will fail)
        // addrs[2] not funded

        OrderSettlement.MatchedTrade[] memory trades = new OrderSettlement.MatchedTrade[](2);

        trades[0] = OrderSettlement.MatchedTrade({
            maker: _signOrder(pks[0], addrs[0], false, btcMkt, S / 10, BTC_PRICE, 1),
            taker: _signOrder(pks[1], addrs[1], true, btcMkt, S / 10, BTC_PRICE, 1),
            executionPrice: BTC_PRICE,
            executionSize: S / 10
        });

        trades[1] = OrderSettlement.MatchedTrade({
            maker: _signOrder(pks[2], addrs[2], false, btcMkt, S / 10, BTC_PRICE, 1),
            taker: _signOrder(pks[3], addrs[3], true, btcMkt, S / 10, BTC_PRICE, 1),
            executionPrice: BTC_PRICE,
            executionSize: S / 10
        });

        vm.prank(owner);
        try settlement.settleBatch(trades) {
            emit log_string("  [BUG?] Batch succeeded even with unfunded trader");
        } catch {
            emit log_string("  [OK] Batch reverted atomically (one bad trade = all fail)");
        }

        // Check trade 1 didn't settle
        (int256 sz,,,,,) = engine.positions(btcMkt, addrs[0]);
        if (sz == 0) {
            emit log_string("  [OK] Trade 1 rolled back (atomic)");
        } else {
            emit log_string("  [BUG] Trade 1 settled despite batch failure!");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 8: Expired order submitted
    //  Can operator settle an expired order?
    // ================================================================
    function test_settlement_expiredOrder() public {
        emit log_string("=== SETTLEMENT: Expired order rejection ===");

        address maker = addrs[0];
        address taker = addrs[1];
        _fund(maker, 100_000 * U);
        _fund(taker, 100_000 * U);

        // Sign orders that expire in 1 minute
        uint256 expiry = block.timestamp + 60;
        OrderSettlement.SignedOrder memory makerOrder = _signOrderWithExpiry(pks[0], maker, false, btcMkt, S, BTC_PRICE, 1, expiry);
        OrderSettlement.SignedOrder memory takerOrder = _signOrderWithExpiry(pks[1], taker, true, btcMkt, S, BTC_PRICE, 1, expiry);

        // Advance past expiry
        vm.warp(block.timestamp + 61);

        vm.prank(owner);
        try settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerOrder, taker: takerOrder,
            executionPrice: BTC_PRICE, executionSize: S
        })) {
            emit log_string("  [BUG] Expired order was settled!");
        } catch {
            emit log_string("  [OK] Expired order correctly rejected");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 9: Same nonce different market
    //  Can the same nonce be used for orders on different markets?
    //  This would be a bug if the nonce is global.
    // ================================================================
    function test_settlement_sameNonceDifferentMarket() public {
        emit log_string("=== SETTLEMENT: Same nonce different market ===");

        // Note: nonces are per-trader, not per-market
        // Using nonce=1 for BTC trade should prevent nonce=1 for ETH trade

        address maker = addrs[0];
        address taker = addrs[1];
        _fund(maker, 200_000 * U);
        _fund(taker, 200_000 * U);

        // BTC trade with nonce 1
        OrderSettlement.SignedOrder memory makerBTC = _signOrder(pks[0], maker, false, btcMkt, S / 10, BTC_PRICE, 1);
        OrderSettlement.SignedOrder memory takerBTC = _signOrder(pks[1], taker, true, btcMkt, S / 10, BTC_PRICE, 1);

        vm.prank(owner);
        settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerBTC, taker: takerBTC,
            executionPrice: BTC_PRICE, executionSize: S / 10
        }));
        emit log_string("  BTC trade settled with nonce 1");

        // Try nonce 1 again for the same market (should fail)
        OrderSettlement.SignedOrder memory makerBTC2 = _signOrder(pks[0], maker, false, btcMkt, S / 10, BTC_PRICE, 1);
        OrderSettlement.SignedOrder memory takerBTC2 = _signOrder(pks[1], taker, true, btcMkt, S / 10, BTC_PRICE, 1);

        vm.prank(owner);
        try settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: makerBTC2, taker: takerBTC2,
            executionPrice: BTC_PRICE, executionSize: S / 10
        })) {
            emit log_string("  [BUG] Same nonce reused on same market!");
        } catch {
            emit log_string("  [OK] Nonce replay blocked");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 10: Dynamic spread manipulation
    //  Open massive skew, then trade to exploit spread tiers
    // ================================================================
    function test_settlement_dynamicSpreadManipulation() public {
        emit log_string("=== SETTLEMENT: Dynamic spread manipulation ===");

        // Fund many traders and create massive long skew
        for (uint256 i = 0; i < 10; i++) {
            _fund(addrs[i], 500_000 * U);
        }

        // Open 5 long positions (creates long-dominant skew)
        for (uint256 i = 0; i < 5; i++) {
            OrderSettlement.SignedOrder memory m = _signOrder(pks[i + 5], addrs[i + 5], false, btcMkt, S / 2, BTC_PRICE, i + 10);
            OrderSettlement.SignedOrder memory t = _signOrder(pks[i], addrs[i], true, btcMkt, S / 2, BTC_PRICE, i + 10);
            vm.prank(owner);
            settlement.settleOne(OrderSettlement.MatchedTrade({
                maker: m, taker: t,
                executionPrice: BTC_PRICE, executionSize: S / 2
            }));
        }

        // Check OI skew
        (,,,,,,,,,,,,uint256 oiLong, uint256 oiShort) = engine.markets(btcMkt);
        emit log_named_uint("  OI Long", oiLong);
        emit log_named_uint("  OI Short", oiShort);

        // Now open another long — should pay dynamic spread
        _fund(addrs[10], 500_000 * U);
        _fund(addrs[11], 500_000 * U);

        uint256 takerBalBefore = vault.balances(addrs[10]);
        uint256 feeBalBefore = vault.balances(feeRecipient);

        OrderSettlement.SignedOrder memory m2 = _signOrder(pks[11], addrs[11], false, btcMkt, S / 2, BTC_PRICE, 100);
        OrderSettlement.SignedOrder memory t2 = _signOrder(pks[10], addrs[10], true, btcMkt, S / 2, BTC_PRICE, 100);

        vm.prank(owner);
        settlement.settleOne(OrderSettlement.MatchedTrade({
            maker: m2, taker: t2,
            executionPrice: BTC_PRICE, executionSize: S / 2
        }));

        uint256 takerBalAfter = vault.balances(addrs[10]);
        uint256 feeBalAfter = vault.balances(feeRecipient);
        uint256 takerCost = takerBalBefore - takerBalAfter;
        uint256 feeCollected = feeBalAfter - feeBalBefore;

        emit log_named_uint("  Taker total cost (margin + fees)", takerCost);
        emit log_named_uint("  Fees collected from this trade", feeCollected);

        // Expected: base taker fee (0.06%) + dynamic spread
        // Notional = $50k * 0.5 = $25k
        // Base fee = $25k * 0.06% = $15
        // With spread: should be higher
        uint256 baseTakerFee = (25_000 * U * 6) / 10_000;
        emit log_named_uint("  Base taker fee would be", baseTakerFee);

        if (feeCollected > baseTakerFee * 2) {
            emit log_string("  [OK] Dynamic spread is adding extra fee");
        } else {
            emit log_string("  [INFO] Dynamic spread may not be triggering");
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

    function _signOrder(
        uint256 pk, address trader, bool isLong,
        bytes32 mkt, uint256 size, uint256 price, uint256 nonce
    ) internal view returns (OrderSettlement.SignedOrder memory) {
        return _signOrderWithExpiry(pk, trader, isLong, mkt, size, price, nonce, block.timestamp + 1 hours);
    }

    function _signOrderWithExpiry(
        uint256 pk, address trader, bool isLong,
        bytes32 mkt, uint256 size, uint256 price, uint256 nonce, uint256 expiry
    ) internal view returns (OrderSettlement.SignedOrder memory) {
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
