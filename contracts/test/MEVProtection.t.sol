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
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance));
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
        // With default 2s delay, trades should auto-commit and settle immediately
        OrderSettlement.MatchedTrade memory trade = _createTrade(1);

        vm.prank(owner);
        settlement.settleOne(trade);

        // Should work - auto-commit for delays <= 2s
        (int256 size,,,,) = engine.positions(btcMarket, alice);
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

        (int256 size,,,,) = engine.positions(btcMarket, alice);
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

        (int256 size,,,,) = engine.positions(btcMarket, alice);
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
