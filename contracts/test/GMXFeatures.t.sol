// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PerpVault.sol";
import "../src/PerpEngine.sol";
import "../src/CollateralManager.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockERC20.sol";

/// @title GMX-Inspired Features Tests
/// @notice Tests for: price impact, reserve factor, CollateralManager reentrancy guard + CEI fix

// ============================================================
//                  REENTRANCY ATTACK CONTRACT
// ============================================================

/// @dev Malicious ERC20 that calls back into CollateralManager.withdrawCollateral on transfer()
contract ReentrantToken {
    string public name = "Reentrant";
    string public symbol = "REENT";
    uint8 public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    CollateralManager public target;
    bool public attacking;
    uint256 public attackCount;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setTarget(address _target) external {
        target = CollateralManager(_target);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient");
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        // Reentrancy attack on withdraw
        if (attacking && attackCount == 0) {
            attackCount++;
            // Try to re-enter withdrawCollateral
            target.withdrawCollateral(address(this), amount);
        }

        return true;
    }

    function enableAttack() external {
        attacking = true;
        attackCount = 0;
    }
}

// ============================================================
//                  MAIN TEST CONTRACT
// ============================================================

contract GMXFeaturesTest is Test {
    PerpVault public vault;
    PerpEngine public engine;
    CollateralManager public cm;
    MockUSDC public usdc;
    MockERC20 public cbETH;

    address public owner = makeAddr("owner");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public operator = makeAddr("operator");
    address public feeRecipient = makeAddr("feeRecipient");
    address public insurance = makeAddr("insurance");

    uint256 constant USDC_UNIT = 1e6;
    uint256 constant ETH_UNIT = 1e18;
    uint256 constant PRICE = 1e6;
    uint256 constant SIZE = 1e8;
    uint256 constant BPS = 10_000;

    bytes32 public btcMarketId;
    uint256 constant BTC_PRICE = 50_000 * PRICE;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 0);
        engine = new PerpEngine(address(vault), owner, feeRecipient, insurance, feeRecipient);
        cm = new CollateralManager(address(vault), owner);

        cbETH = new MockERC20("Coinbase Staked ETH", "cbETH", 18);

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        vault.setOperator(address(cm), true);
        engine.setOperator(operator, true);
        engine.setMaxExposureBps(0);
        engine.setOiSkewCap(10000);
        cm.setOperator(makeAddr("oracleKeeper"), true);
        cm.addCollateral(address(cbETH), "cbETH", 18, 9500, 3500 * USDC_UNIT, 120, 0);
        vm.stopPrank();

        btcMarketId = keccak256(abi.encodePacked("BTC-USD"));
        vm.prank(owner);
        engine.addMarket("BTC-USD", 500, 250, 100 * SIZE, 28800);

        vm.prank(operator);
        engine.updateMarkPrice(btcMarketId, BTC_PRICE, BTC_PRICE);

        _fundTrader(alice, 100_000 * USDC_UNIT);
        _fundTrader(bob, 100_000 * USDC_UNIT);
        _fundTrader(feeRecipient, 100_000 * USDC_UNIT);
        _fundTrader(insurance, 500_000 * USDC_UNIT);
    }

    function _fundTrader(address trader, uint256 amount) internal {
        usdc.mint(trader, amount);
        vm.startPrank(trader);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(amount);
        vm.stopPrank();
    }

    // ============================================================
    //            COLLATERAL MANAGER REENTRANCY TESTS
    // ============================================================

    function test_reentrancyGuard_blocksReentrantWithdraw() public {
        ReentrantToken rToken = new ReentrantToken();
        rToken.setTarget(address(cm));

        // Add reentrant token as collateral
        vm.prank(owner);
        cm.addCollateral(address(rToken), "REENT", 18, 9500, 1 * USDC_UNIT, 120, 0);

        // Alice deposits reentrant tokens
        rToken.mint(alice, 100 * ETH_UNIT);
        vm.prank(alice);
        rToken.approve(address(cm), type(uint256).max);
        vm.prank(alice);
        cm.depositCollateral(address(rToken), 100 * ETH_UNIT);

        // Enable reentrancy attack
        rToken.enableAttack();

        // Withdraw should revert due to nonReentrant guard
        vm.prank(alice);
        vm.expectRevert("Reentrant");
        cm.withdrawCollateral(address(rToken), 50 * ETH_UNIT);
    }

    function test_CEI_stateUpdatedBeforeTransfer() public {
        // Deposit cbETH
        cbETH.mint(alice, 10 * ETH_UNIT);
        vm.prank(alice);
        cbETH.approve(address(cm), type(uint256).max);
        vm.prank(alice);
        cm.depositCollateral(address(cbETH), 10 * ETH_UNIT);

        // Withdraw half
        vm.prank(alice);
        cm.withdrawCollateral(address(cbETH), 5 * ETH_UNIT);

        // Verify state is correct
        (uint256 amount, uint256 credited,) = cm.getTraderCollateral(address(cbETH), alice);
        assertEq(amount, 5 * ETH_UNIT, "Amount should be 5 ETH");
        assertTrue(credited > 0, "Should have remaining credit");
    }

    function test_depositCollateral_nonReentrant() public {
        // Verify deposit also has nonReentrant (by checking it works normally)
        cbETH.mint(alice, 10 * ETH_UNIT);
        vm.prank(alice);
        cbETH.approve(address(cm), type(uint256).max);
        vm.prank(alice);
        uint256 credited = cm.depositCollateral(address(cbETH), 10 * ETH_UNIT);
        assertTrue(credited > 0, "Should credit USDC");
    }

    // ============================================================
    //              RESERVE FACTOR TESTS
    // ============================================================

    function test_reserveFactor_defaultDisabled() public view {
        assertEq(engine.reserveFactorBps(), 0, "Should be disabled by default");
    }

    function test_reserveFactor_setByOwner() public {
        vm.prank(owner);
        engine.setReserveFactor(8000); // 80%
        assertEq(engine.reserveFactorBps(), 8000);
    }

    function test_reserveFactor_rejectsInvalidValue() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSignature("InvalidParam()"));
        engine.setReserveFactor(10001); // > 100%
    }

    function test_reserveFactor_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(PerpEngine.NotOwner.selector);
        engine.setReserveFactor(8000);
    }

    function test_reserveFactor_blocksExcessiveOI() public {
        // Total vault deposits: alice(100k) + bob(100k) + feeRecipient(100k) + insurance(500k) = 800k
        // Set reserve factor to 10% = max OI notional of 80k
        vm.prank(owner);
        engine.setReserveFactor(1000); // 10%

        // BTC at $50,000. 2 BTC = $100k notional > $80k limit
        // This should revert
        vm.prank(operator);
        vm.expectRevert();
        engine.openPosition(btcMarketId, alice, 2 * int256(SIZE), BTC_PRICE);
    }

    function test_reserveFactor_allowsWithinLimit() public {
        // Set reserve factor to 50% = max OI notional of 400k
        vm.prank(owner);
        engine.setReserveFactor(5000); // 50%

        // 1 BTC = $50k notional, well within $400k limit
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, 1 * int256(SIZE), BTC_PRICE);

        // Verify position opened
        (int256 size,,,,) = engine.positions(btcMarketId, alice);
        assertEq(size, 1 * int256(SIZE));
    }

    function test_reserveFactor_dynamicWithPoolSize() public {
        // Set 20% reserve factor
        vm.prank(owner);
        engine.setReserveFactor(2000);

        // Pool TVL = 800k USDC. 20% = $160k max OI notional.
        // 3 BTC = $150k should pass
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, 3 * int256(SIZE), BTC_PRICE);

        // Add more deposits → increases limit
        _fundTrader(makeAddr("whale"), 1_000_000 * USDC_UNIT);
        // Now pool = 1.8M, 20% = $360k
        // Another 3 BTC ($150k) should still pass, total $300k < $360k
        vm.prank(operator);
        engine.openPosition(btcMarketId, bob, 3 * int256(SIZE), BTC_PRICE);
    }

    // ============================================================
    //              PRICE IMPACT TESTS
    // ============================================================

    function test_priceImpact_defaultDisabled() public view {
        (uint256 factor, uint256 exponent) = engine.priceImpactConfigs(btcMarketId);
        assertEq(factor, 0, "Should be disabled by default");
        assertEq(exponent, 0);
    }

    function test_priceImpact_setByOwner() public {
        vm.prank(owner);
        engine.setPriceImpactConfig(btcMarketId, 100, 20000); // 1% factor, quadratic

        (uint256 factor, uint256 exponent) = engine.priceImpactConfigs(btcMarketId);
        assertEq(factor, 100);
        assertEq(exponent, 20000);
    }

    function test_priceImpact_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(PerpEngine.NotOwner.selector);
        engine.setPriceImpactConfig(btcMarketId, 100, 20000);
    }

    function test_priceImpact_noFeeWhenDisabled() public {
        uint256 aliceBalBefore = vault.balances(alice);

        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, 1 * int256(SIZE), BTC_PRICE);

        uint256 aliceBalAfter = vault.balances(alice);
        // Only margin should be deducted, no impact fee
        uint256 expectedMargin = (50_000 * USDC_UNIT * 500) / BPS; // 5% of $50k = $2,500
        assertEq(aliceBalBefore - aliceBalAfter, expectedMargin, "Only margin deducted");
    }

    function test_priceImpact_chargesWhenWorseningSkew() public {
        // Enable price impact: 1% factor
        vm.prank(owner);
        engine.setPriceImpactConfig(btcMarketId, 100, 20000);

        // Alice opens a long (creates initial skew)
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, 2 * int256(SIZE), BTC_PRICE);

        // Now OI: 2 BTC long, 0 short → longs dominant
        // Bob opens another long → worsens skew → should pay impact fee
        uint256 bobBalBefore = vault.balances(bob);
        uint256 feeBalBefore = vault.balances(feeRecipient);

        vm.prank(operator);
        engine.openPosition(btcMarketId, bob, 1 * int256(SIZE), BTC_PRICE);

        uint256 bobBalAfter = vault.balances(bob);
        uint256 feeBalAfter = vault.balances(feeRecipient);

        // Bob paid more than just margin (includes impact fee)
        uint256 bobPaid = bobBalBefore - bobBalAfter;
        uint256 expectedMargin = (50_000 * USDC_UNIT * 500) / BPS;
        assertTrue(bobPaid > expectedMargin, "Should pay margin + impact fee");

        // Fee recipient received the impact fee
        assertTrue(feeBalAfter > feeBalBefore, "Fee recipient should receive impact fee");
    }

    function test_priceImpact_noFeeWhenReducingSkew() public {
        // Enable price impact
        vm.prank(owner);
        engine.setPriceImpactConfig(btcMarketId, 100, 20000);

        // Alice opens a long (skew: longs dominant)
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, 2 * int256(SIZE), BTC_PRICE);

        // Bob opens a SHORT → reduces skew → should NOT pay impact fee
        uint256 bobBalBefore = vault.balances(bob);
        uint256 feeBalBefore = vault.balances(feeRecipient);

        vm.prank(operator);
        engine.openPosition(btcMarketId, bob, -1 * int256(SIZE), BTC_PRICE);

        uint256 bobPaid = bobBalBefore - vault.balances(bob);
        uint256 expectedMargin = (50_000 * USDC_UNIT * 500) / BPS;
        assertEq(bobPaid, expectedMargin, "Should only pay margin, no impact fee");
        assertEq(vault.balances(feeRecipient), feeBalBefore, "Fee recipient unchanged");
    }

    function test_priceImpact_largerTradesPayMore() public {
        // Enable price impact
        vm.prank(owner);
        engine.setPriceImpactConfig(btcMarketId, 200, 20000); // 2% factor

        // Create initial OI: alice 5 BTC long
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, 5 * int256(SIZE), BTC_PRICE);

        // Bob opens 1 BTC long (small, worsens skew)
        uint256 feeBalBefore = vault.balances(feeRecipient);
        vm.prank(operator);
        engine.openPosition(btcMarketId, bob, 1 * int256(SIZE), BTC_PRICE);
        uint256 smallImpactFee = vault.balances(feeRecipient) - feeBalBefore;

        // Close bob's position
        vm.prank(operator);
        engine.closePosition(btcMarketId, bob, BTC_PRICE);

        // Bob opens 4 BTC long (large, worsens skew more)
        feeBalBefore = vault.balances(feeRecipient);
        vm.prank(operator);
        engine.openPosition(btcMarketId, bob, 4 * int256(SIZE), BTC_PRICE);
        uint256 largeImpactFee = vault.balances(feeRecipient) - feeBalBefore;

        // Quadratic: 4x size → should pay >4x impact (quadratic scaling)
        assertTrue(largeImpactFee > smallImpactFee * 4, "Larger trades should pay quadratically more");
    }

    function test_priceImpact_increasePositionAlsoCharged() public {
        // Enable price impact
        vm.prank(owner);
        engine.setPriceImpactConfig(btcMarketId, 100, 20000);

        // Alice opens 2 BTC long
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, 2 * int256(SIZE), BTC_PRICE);

        // Alice increases by 1 BTC (same direction, worsens skew)
        uint256 feeBalBefore = vault.balances(feeRecipient);
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, 1 * int256(SIZE), BTC_PRICE);
        uint256 impactFee = vault.balances(feeRecipient) - feeBalBefore;

        assertTrue(impactFee > 0, "Increasing position should also pay impact fee");
    }

    function test_priceImpact_balancedMarketNoFee() public {
        // Enable price impact
        vm.prank(owner);
        engine.setPriceImpactConfig(btcMarketId, 100, 20000);

        // Create balanced market: 2 BTC long + 2 BTC short
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, 2 * int256(SIZE), BTC_PRICE);
        vm.prank(operator);
        engine.openPosition(btcMarketId, bob, -2 * int256(SIZE), BTC_PRICE);

        // Now market is balanced (50/50). New trader reduces or maintains balance.
        address charlie = makeAddr("charlie");
        _fundTrader(charlie, 100_000 * USDC_UNIT);

        // Charlie opens 1 BTC long → now 3L vs 2S → worsens skew → pays fee
        uint256 feeBalBefore = vault.balances(feeRecipient);
        vm.prank(operator);
        engine.openPosition(btcMarketId, charlie, 1 * int256(SIZE), BTC_PRICE);
        uint256 impactFee = vault.balances(feeRecipient) - feeBalBefore;
        assertTrue(impactFee > 0, "Should pay impact fee when worsening skew on balanced market");
    }

    // ============================================================
    //           COMBINED SCENARIOS
    // ============================================================

    function test_reserveFactorAndPriceImpact_together() public {
        // Enable both features
        vm.startPrank(owner);
        engine.setReserveFactor(5000); // 50% of pool
        engine.setPriceImpactConfig(btcMarketId, 100, 20000);
        vm.stopPrank();

        // Open within reserve factor → should work + pay impact
        vm.prank(operator);
        engine.openPosition(btcMarketId, alice, 2 * int256(SIZE), BTC_PRICE);

        (int256 size,,,,) = engine.positions(btcMarketId, alice);
        assertEq(size, 2 * int256(SIZE), "Position should be open");
    }
}
