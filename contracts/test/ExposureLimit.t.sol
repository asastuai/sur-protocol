// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PerpVault.sol";
import "../src/PerpEngine.sol";
import "../src/InsuranceFund.sol";
import "./mocks/MockUSDC.sol";

/// @title Exposure Limit Tests
/// @notice Tests for P0: Cross-margin exposure limits preventing single trader dominance

contract ExposureLimitTest is Test {
    PerpVault public vault;
    PerpEngine public engine;
    InsuranceFund public insurance;
    MockUSDC public usdc;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public feeRecipient = makeAddr("feeRecipient");

    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public charlie = makeAddr("charlie");

    uint256 constant USDC = 1e6;
    uint256 constant SIZE = 1e8;
    uint256 constant BTC_PRICE = 50_000 * 1e6;
    uint256 constant ETH_PRICE = 3_000 * 1e6;

    bytes32 public btcMarketId;
    bytes32 public ethMarketId;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 0);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        engine.setOperator(operator, true);
        insurance.setOperator(address(engine), true);
        engine.setOiSkewCap(10000); // disable skew cap for tests
        vm.stopPrank();

        btcMarketId = keccak256(abi.encodePacked("BTC-USD"));
        ethMarketId = keccak256(abi.encodePacked("ETH-USD"));

        vm.startPrank(owner);
        engine.addMarket("BTC-USD", 500, 250, 10_000 * SIZE, 28800);
        engine.addMarket("ETH-USD", 500, 250, 100_000 * SIZE, 28800);
        vm.stopPrank();

        vm.startPrank(operator);
        engine.updateMarkPrice(btcMarketId, BTC_PRICE, BTC_PRICE);
        engine.updateMarkPrice(ethMarketId, ETH_PRICE, ETH_PRICE);
        vm.stopPrank();

        _fund(alice, 10_000_000 * USDC);   // $10M
        _fund(bob, 10_000_000 * USDC);     // $10M
        _fund(charlie, 10_000_000 * USDC); // $10M
        _fund(feeRecipient, 10_000_000 * USDC);
        _fund(address(insurance), 10_000_000 * USDC);
    }

    function _fund(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(amount);
        vm.stopPrank();
    }

    // ============================================================
    //              DEFAULTS
    // ============================================================

    function test_exposureLimit_default() public view {
        assertEq(engine.maxExposureBps(), 500); // 5%
    }

    // ============================================================
    //              EXPOSURE LIMIT ENFORCEMENT
    // ============================================================

    /// @dev Helper to build baseline OI without exposure limit blocking
    function _buildBaselineOI() internal {
        // Temporarily disable limit to bootstrap OI
        vm.prank(owner);
        engine.setMaxExposureBps(0);

        vm.prank(operator);
        engine.openPosition(btcMarketId, bob, int256(100 * SIZE), BTC_PRICE);
        vm.prank(operator);
        engine.openPosition(btcMarketId, charlie, -int256(100 * SIZE), BTC_PRICE);

        // Re-enable limit at 5%
        vm.prank(owner);
        engine.setMaxExposureBps(500);
    }

    function test_exposureLimit_allowsSmallPosition() public {
        _buildBaselineOI();

        // Total OI = 200 BTC * $50k = $10M notional
        // 5% limit = $500k max per trader = 10 BTC

        // Alice opens 1 BTC ($50k notional) - should work fine
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(1 * SIZE), BTC_PRICE);

        (int256 size,,,,) = engine.getPosition(btcMarketId, alice);
        assertEq(size, int256(1 * SIZE));
    }

    function test_exposureLimit_blocksExcessivePosition() public {
        _buildBaselineOI();

        // Total OI = 200 BTC. 5% = ~10 BTC max per trader.
        // Alice tries 50 BTC ($2.5M) which is >>5% of $10M
        vm.prank(operator);
        vm.expectRevert(); // ExposureLimitExceeded
        engine.openPosition(btcMarketId, alice, int256(50 * SIZE), BTC_PRICE);
    }

    function test_exposureLimit_blocksIncrease() public {
        _buildBaselineOI();

        // Alice opens small position first (within limit)
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(5 * SIZE), BTC_PRICE);

        // Now try to increase way beyond limit
        vm.prank(operator);
        vm.expectRevert(); // ExposureLimitExceeded
        engine.openPosition(btcMarketId, alice, int256(50 * SIZE), BTC_PRICE);
    }

    function test_exposureLimit_crossMarketCumulative() public {
        // Disable limit to bootstrap OI in both markets
        vm.prank(owner);
        engine.setMaxExposureBps(0);

        vm.prank(operator);
        engine.openPosition(btcMarketId, bob, int256(100 * SIZE), BTC_PRICE);
        vm.prank(operator);
        engine.openPosition(btcMarketId, charlie, -int256(100 * SIZE), BTC_PRICE);
        vm.prank(operator);
        engine.openPosition(ethMarketId, bob, int256(1000 * SIZE), ETH_PRICE);
        vm.prank(operator);
        engine.openPosition(ethMarketId, charlie, -int256(1000 * SIZE), ETH_PRICE);

        // Re-enable at 5%
        vm.prank(owner);
        engine.setMaxExposureBps(500);

        // Total OI: BTC=200*$50k + ETH=2000*$3k = $10M + $6M = $16M
        // 5% limit = $800k per trader

        // Alice opens BTC position worth ~$250k (5 BTC)
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(5 * SIZE), BTC_PRICE);

        // Alice opens ETH position worth ~$150k (50 ETH) - cumulative ~$400k, still ok
        vm.prank(operator);
        engine.openPosition(ethMarketId, alice, int256(50 * SIZE), ETH_PRICE);

        // Verify both positions exist
        (int256 btcSize,,,,) = engine.getPosition(btcMarketId, alice);
        (int256 ethSize,,,,) = engine.getPosition(ethMarketId, alice);
        assertEq(btcSize, int256(5 * SIZE));
        assertEq(ethSize, int256(50 * SIZE));
    }

    function test_exposureLimit_disabledWhenZero() public {
        vm.prank(owner);
        engine.setMaxExposureBps(0); // disable

        // Even a massive position should work
        vm.prank(operator);
        engine.openPosition(btcMarketId, bob, int256(100 * SIZE), BTC_PRICE);
        vm.prank(operator);
        engine.openPosition(btcMarketId, charlie, -int256(100 * SIZE), BTC_PRICE);

        // Alice takes huge position - no limit
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(100 * SIZE), BTC_PRICE);

        (int256 size,,,,) = engine.getPosition(btcMarketId, alice);
        assertEq(size, int256(100 * SIZE));
    }

    function test_exposureLimit_allowsReducingPosition() public {
        _buildBaselineOI();

        // Alice opens a position within limit
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, int256(5 * SIZE), BTC_PRICE);

        // Reducing/closing should always work regardless of limit
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, -int256(3 * SIZE), BTC_PRICE);

        (int256 size,,,,) = engine.getPosition(btcMarketId, alice);
        assertEq(size, int256(2 * SIZE));
    }

    // ============================================================
    //              ADMIN
    // ============================================================

    function test_exposureLimit_setMaxExposure() public {
        vm.prank(owner);
        engine.setMaxExposureBps(1000); // 10%
        assertEq(engine.maxExposureBps(), 1000);
    }

    function test_exposureLimit_onlyOwnerCanSet() public {
        vm.prank(alice);
        vm.expectRevert(PerpEngine.NotOwner.selector);
        engine.setMaxExposureBps(1000);
    }
}
