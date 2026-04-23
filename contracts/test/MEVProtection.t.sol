// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PerpVault.sol";
import "../src/PerpEngine.sol";
import "../src/OrderSettlement.sol";
import "../src/InsuranceFund.sol";
import "./mocks/MockUSDC.sol";

/// @title MEV Protection Tests
/// @notice Tests for P1: Commit-settle time-lock pattern in OrderSettlement

contract MEVProtectionTest is Test {
    PerpVault public vault;
    PerpEngine public engine;
    OrderSettlement public settlement;
    InsuranceFund public insurance;
    MockUSDC public usdc;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("feeRecipient");

    uint256 constant ALICE_PK = 0xA11CE;
    uint256 constant BOB_PK = 0xB0B;
    address public alice;
    address public bob;

    uint256 constant USDC_UNIT = 1e6;
    uint256 constant SIZE_UNIT = 1e8;
    uint256 constant BTC_50K = 50_000 * USDC_UNIT;

    bytes32 public btcMarket;

    function setUp() public {
        alice = vm.addr(ALICE_PK);
        bob = vm.addr(BOB_PK);

        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 0);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);
        settlement = new OrderSettlement(address(engine), address(vault), feeRecipient, owner);

        btcMarket = keccak256(abi.encodePacked("BTC-USD"));

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        vault.setOperator(address(settlement), true);
        engine.setOperator(address(settlement), true);
        engine.setOperator(owner, true);
        settlement.setOperator(owner, true);
        insurance.setOperator(address(engine), true);

        engine.addMarket("BTC-USD", 500, 250, 10_000 * SIZE_UNIT, 28800);
        engine.updateMarkPrice(btcMarket, BTC_50K, BTC_50K);
        // Disable exposure limit for MEV tests (tested separately)
        engine.setMaxExposureBps(0);
        engine.setOiSkewCap(10000); // disable skew cap for tests
        vm.stopPrank();

        _deposit(alice, 100_000 * USDC_UNIT);
        _deposit(bob, 100_000 * USDC_UNIT);
        _deposit(feeRecipient, 100_000 * USDC_UNIT);
        _deposit(address(insurance), 500_000 * USDC_UNIT);
    }

    function _deposit(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    // ============================================================
    //              DEFAULTS
    // ============================================================

    function test_mev_defaultParams() public view {
        assertEq(settlement.minSettlementDelay(), 2);
        assertEq(settlement.maxSettlementDelay(), 300);
    }

    // ============================================================
    //              AUTO-COMMIT (default delay <= 2s)
    // ============================================================

    function test_mev_autoCommitWithDefaultDelay() public {
        // M-4 fix: Auto-commit removed. With default 2s delay, must pre-commit.
        OrderSettlement.MatchedTrade memory trade = _createTrade(1);

        // Pre-commit order digests
        bytes32 makerDigest = settlement.getOrderDigest(
            trade.maker.trader, trade.maker.marketId, trade.maker.isLong,
            trade.maker.size, trade.maker.price, trade.maker.nonce, trade.maker.expiry
        );
        bytes32 takerDigest = settlement.getOrderDigest(
            trade.taker.trader, trade.taker.marketId, trade.taker.isLong,
            trade.taker.size, trade.taker.price, trade.taker.nonce, trade.taker.expiry
        );

        vm.startPrank(owner);
        settlement.commitOrder(makerDigest);
        settlement.commitOrder(takerDigest);

        // Wait for 2s delay
        vm.warp(block.timestamp + 3);
        engine.updateMarkPrice(btcMarket, BTC_50K, BTC_50K);

        settlement.settleOne(trade);
        vm.stopPrank();

        (int256 size,,,,,) = engine.positions(btcMarket, alice);
        assertEq(size, int256(SIZE_UNIT));
    }

    // ============================================================
    //              COMMIT-SETTLE WITH LONGER DELAY
    // ============================================================

    function test_mev_requiresCommitWithLongerDelay() public {
        // Set a 5 second delay
        vm.prank(owner);
        settlement.setSettlementDelay(5, 300);

        OrderSettlement.MatchedTrade memory trade = _createTrade(1);

        // Try to settle without committing - should revert
        vm.prank(owner);
        vm.expectRevert();
        settlement.settleOne(trade);
    }

    function test_mev_commitThenSettle() public {
        // Set 5s delay
        vm.prank(owner);
        settlement.setSettlementDelay(5, 300);

        OrderSettlement.MatchedTrade memory trade = _createTrade(1);

        // Compute order digests and commit
        bytes32 makerDigest = settlement.getOrderDigest(
            bob, btcMarket, false, 1 * SIZE_UNIT, BTC_50K, 1, block.timestamp + 1 hours
        );
        bytes32 takerDigest = settlement.getOrderDigest(
            alice, btcMarket, true, 1 * SIZE_UNIT, BTC_50K, 1, block.timestamp + 1 hours
        );

        bytes32[] memory digests = new bytes32[](2);
        digests[0] = makerDigest;
        digests[1] = takerDigest;

        vm.prank(owner);
        settlement.commitOrderBatch(digests);

        // Try to settle immediately - should fail (delay not elapsed)
        vm.prank(owner);
        vm.expectRevert();
        settlement.settleOne(trade);

        // Wait for delay
        vm.warp(block.timestamp + 6);

        // Update price so engine has fresh data
        vm.prank(owner);
        engine.updateMarkPrice(btcMarket, BTC_50K, BTC_50K);

        // Now settle - should work
        vm.prank(owner);
        settlement.settleOne(trade);

        (int256 size,,,,,) = engine.positions(btcMarket, alice);
        assertEq(size, int256(SIZE_UNIT));
    }

    function test_mev_commitOrderSingle() public {
        vm.prank(owner);
        settlement.setSettlementDelay(5, 300);

        bytes32 digest = settlement.getOrderDigest(
            alice, btcMarket, true, 1 * SIZE_UNIT, BTC_50K, 1, block.timestamp + 1 hours
        );

        vm.prank(owner);
        settlement.commitOrder(digest);

        assertGt(settlement.orderCommitTime(digest), 0);
    }

    function test_mev_commitDoesNotOverwrite() public {
        bytes32 digest = settlement.getOrderDigest(
            alice, btcMarket, true, 1 * SIZE_UNIT, BTC_50K, 1, block.timestamp + 1 hours
        );

        vm.prank(owner);
        settlement.commitOrder(digest);
        uint256 firstCommit = settlement.orderCommitTime(digest);

        vm.warp(block.timestamp + 10);

        // Second commit should not overwrite
        vm.prank(owner);
        settlement.commitOrder(digest);
        assertEq(settlement.orderCommitTime(digest), firstCommit);
    }

    // ============================================================
    //              DISABLED MEV PROTECTION
    // ============================================================

    function test_mev_disabledWhenZeroDelay() public {
        vm.prank(owner);
        settlement.setSettlementDelay(0, 300);

        // Should work immediately without any commit
        OrderSettlement.MatchedTrade memory trade = _createTrade(1);
        vm.prank(owner);
        settlement.settleOne(trade);

        (int256 size,,,,,) = engine.positions(btcMarket, alice);
        assertEq(size, int256(SIZE_UNIT));
    }

    // ============================================================
    //              ADMIN
    // ============================================================

    function test_mev_setSettlementDelay() public {
        vm.prank(owner);
        settlement.setSettlementDelay(10, 600);

        assertEq(settlement.minSettlementDelay(), 10);
        assertEq(settlement.maxSettlementDelay(), 600);
    }

    function test_mev_onlyOwnerCanSetDelay() public {
        vm.prank(alice);
        vm.expectRevert(OrderSettlement.NotOwner.selector);
        settlement.setSettlementDelay(10, 600);
    }

    function test_mev_onlyOperatorCanCommit() public {
        bytes32 digest = bytes32(uint256(1));

        vm.prank(alice);
        vm.expectRevert(OrderSettlement.NotOperator.selector);
        settlement.commitOrder(digest);
    }

    // ============================================================
    //          MAPPING 3 — Prospective-only params
    // Acceptance tests from docs/MAPPING_3_prospective_params.md
    // ============================================================

    /// @notice Commit both sides of a trade (shared setup for the tests below).
    function _commitBoth(OrderSettlement.MatchedTrade memory trade)
        internal returns (bytes32 makerDigest, bytes32 takerDigest)
    {
        makerDigest = settlement.getOrderDigest(
            trade.maker.trader, trade.maker.marketId, trade.maker.isLong,
            trade.maker.size, trade.maker.price, trade.maker.nonce, trade.maker.expiry
        );
        takerDigest = settlement.getOrderDigest(
            trade.taker.trader, trade.taker.marketId, trade.taker.isLong,
            trade.taker.size, trade.taker.price, trade.taker.nonce, trade.taker.expiry
        );
        vm.startPrank(owner);
        settlement.commitOrder(makerDigest);
        settlement.commitOrder(takerDigest);
        vm.stopPrank();
    }

    function test_mapping3_feeBump_isProspective_onCommittedOrders() public {
        // Given: default fees (maker 2bps / taker 6bps), orders committed.
        OrderSettlement.MatchedTrade memory trade = _createTrade(1);
        _commitBoth(trade);

        // Admin bumps fees to 20/40 AFTER commit but BEFORE settle.
        vm.prank(owner);
        settlement.setFees(20, 40);

        // Wait for the delay and settle.
        vm.warp(block.timestamp + 3);
        vm.prank(owner);
        engine.updateMarkPrice(btcMarket, BTC_50K, BTC_50K);

        uint256 feeRecipBalBefore = vault.balances(feeRecipient);
        vm.prank(owner);
        settlement.settleOne(trade);
        uint256 feeRecipBalAfter = vault.balances(feeRecipient);

        // Settlement uses snapshot fees (2/6), NOT current (20/40).
        uint256 notional = (trade.executionPrice * trade.executionSize) / SIZE_UNIT;
        uint256 expectedMakerFee = (notional * 2) / 10_000;
        uint256 expectedTakerFee = (notional * 6) / 10_000;
        uint256 expectedTotal = expectedMakerFee + expectedTakerFee;

        assertEq(feeRecipBalAfter - feeRecipBalBefore, expectedTotal,
            "Settlement MUST use snapshot fees (2/6), not current (20/40)");
    }

    function test_mapping3_feeBump_appliesToOrdersCommittedAfter() public {
        // Given: admin bumps fees BEFORE commit.
        vm.prank(owner);
        settlement.setFees(20, 40);

        OrderSettlement.MatchedTrade memory trade = _createTrade(2);
        _commitBoth(trade);

        vm.warp(block.timestamp + 3);
        vm.prank(owner);
        engine.updateMarkPrice(btcMarket, BTC_50K, BTC_50K);

        uint256 feeRecipBalBefore = vault.balances(feeRecipient);
        vm.prank(owner);
        settlement.settleOne(trade);
        uint256 feeRecipBalAfter = vault.balances(feeRecipient);

        uint256 notional = (trade.executionPrice * trade.executionSize) / SIZE_UNIT;
        uint256 expectedMakerFee = (notional * 20) / 10_000;
        uint256 expectedTakerFee = (notional * 40) / 10_000;
        uint256 expectedTotal = expectedMakerFee + expectedTakerFee;

        assertEq(feeRecipBalAfter - feeRecipBalBefore, expectedTotal,
            "Orders committed AFTER the bump settle at the new fees (20/40)");
    }

    function test_mapping3_delayBump_isProspective_onCommittedOrders() public {
        // Given: default minSettlementDelay = 2s, order committed.
        OrderSettlement.MatchedTrade memory trade = _createTrade(3);
        _commitBoth(trade);

        // Admin bumps delay to 30s AFTER commit.
        vm.prank(owner);
        settlement.setSettlementDelay(30, 600);

        // Only 3s passes — would fail under the new 30s delay but the
        // order's snapshot has delay=2s, so it should clear.
        vm.warp(block.timestamp + 3);
        vm.prank(owner);
        engine.updateMarkPrice(btcMarket, BTC_50K, BTC_50K);

        vm.prank(owner);
        settlement.settleOne(trade);

        (int256 size,,,,,) = engine.positions(btcMarket, alice);
        assertEq(size, int256(SIZE_UNIT),
            "Order committed under delay=2s MUST settle after 3s even when current delay=30s");
    }

    function test_mapping3_setFees_emitsParameterBump() public {
        // Expect two bumps: one for makerFeeBps, one for takerFeeBps.
        // We only assert the signature appears; full topic check for makerFee.
        vm.expectEmit(true, false, false, true);
        emit OrderSettlement.ParameterBump(
            keccak256("OrderSettlement.makerFeeBps"),
            abi.encode(uint32(2)),
            abi.encode(uint32(5)),
            block.number,
            owner
        );
        vm.expectEmit(true, false, false, true);
        emit OrderSettlement.ParameterBump(
            keccak256("OrderSettlement.takerFeeBps"),
            abi.encode(uint32(6)),
            abi.encode(uint32(15)),
            block.number,
            owner
        );

        vm.prank(owner);
        settlement.setFees(5, 15);
    }

    function test_mapping3_setSettlementDelay_emitsParameterBump() public {
        vm.expectEmit(true, false, false, true);
        emit OrderSettlement.ParameterBump(
            keccak256("OrderSettlement.minSettlementDelay"),
            abi.encode(uint256(2)),
            abi.encode(uint256(10)),
            block.number,
            owner
        );

        vm.prank(owner);
        settlement.setSettlementDelay(10, 600);
    }

    function test_mapping3_setDynamicSpreadEnabled_emitsParameterBump() public {
        vm.expectEmit(true, false, false, true);
        emit OrderSettlement.ParameterBump(
            keccak256("OrderSettlement.dynamicSpreadEnabled"),
            abi.encode(true),
            abi.encode(false),
            block.number,
            owner
        );

        vm.prank(owner);
        settlement.setDynamicSpreadEnabled(false);
    }

    function test_mapping3_setDynamicSpreadTiers_emitsParameterBump() public {
        vm.expectEmit(true, false, false, true);
        emit OrderSettlement.ParameterBump(
            keccak256("OrderSettlement.spreadTiersBps"),
            abi.encode(uint32(5), uint32(15), uint32(30)),
            abi.encode(uint32(10), uint32(20), uint32(40)),
            block.number,
            owner
        );

        vm.prank(owner);
        settlement.setDynamicSpreadTiers(10, 20, 40);
    }

    /// @notice Counter-test: address-only setters (setFeeRecipient, setOperator)
    ///         do NOT emit ParameterBump because they are not position-economics.
    function test_mapping3_nonProspectiveSetters_doNotEmitParameterBump() public {
        bytes32 paramBumpTopic =
            keccak256("ParameterBump(bytes32,bytes,bytes,uint256,address)");

        // setFeeRecipient
        vm.recordLogs();
        vm.prank(owner);
        settlement.setFeeRecipient(makeAddr("newRecipient"));
        Vm.Log[] memory logs1 = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs1.length; i++) {
            assertNotEq(logs1[i].topics[0], paramBumpTopic,
                "setFeeRecipient must NOT emit ParameterBump");
        }

        // setOperator
        vm.recordLogs();
        vm.prank(owner);
        settlement.setOperator(makeAddr("newOp"), true);
        Vm.Log[] memory logs2 = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs2.length; i++) {
            assertNotEq(logs2[i].topics[0], paramBumpTopic,
                "setOperator must NOT emit ParameterBump");
        }
    }

    // ============================================================
    //              HELPERS
    // ============================================================

    function _createTrade(uint256 nonce)
        internal view returns (OrderSettlement.MatchedTrade memory)
    {
        OrderSettlement.SignedOrder memory makerOrder = _signOrder(
            BOB_PK, bob, false, 1 * SIZE_UNIT, BTC_50K, nonce
        );
        OrderSettlement.SignedOrder memory takerOrder = _signOrder(
            ALICE_PK, alice, true, 1 * SIZE_UNIT, BTC_50K, nonce
        );

        return OrderSettlement.MatchedTrade({
            maker: makerOrder,
            taker: takerOrder,
            executionPrice: BTC_50K,
            executionSize: 1 * SIZE_UNIT
        });
    }

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
}
