// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/CollateralManager.sol";
import "../src/PerpVault.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockERC20.sol";

/// @notice Tests for CollateralManager:
///   - Adding collateral types (haircut bounds, duplicates)
///   - Depositing yield tokens → USDC credit calculation
///   - Withdrawing → proportional debit
///   - Oracle price updates + staleness checks
///   - Deposit cap enforcement
///   - Multi-token portfolio value
///   - Precision edge cases (large/small amounts, rounding)
///   - Pause/unpause per collateral
///   - Access control

contract CollateralManagerTest is Test {
    CollateralManager public cm;
    PerpVault public vault;
    MockUSDC public usdc;
    MockERC20 public cbETH;     // 18 decimals
    MockERC20 public wstETH;    // 18 decimals
    MockERC20 public stUSDC;    // 6 decimals

    address public owner = makeAddr("owner");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public oracleKeeper = makeAddr("oracleKeeper");

    uint256 constant USDC_UNIT = 1e6;
    uint256 constant ETH_UNIT = 1e18;
    uint256 constant BPS = 10_000;

    // cbETH at $3,500 (6 decimals = 3_500_000_000)
    uint256 constant CBETH_PRICE = 3_500 * USDC_UNIT;
    uint256 constant WSTETH_PRICE = 3_600 * USDC_UNIT;
    uint256 constant STUSDC_PRICE = 1 * USDC_UNIT; // $1.00

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 0);

        cm = new CollateralManager(address(vault), owner);

        // Create mock yield tokens
        cbETH = new MockERC20("Coinbase Staked ETH", "cbETH", 18);
        wstETH = new MockERC20("Wrapped Lido Staked ETH", "wstETH", 18);
        stUSDC = new MockERC20("Staked USDC", "stUSDC", 6);

        // Set CollateralManager as operator on vault (so it can credit/debit)
        vm.prank(owner);
        vault.setOperator(address(cm), true);

        // Set oracle keeper as operator on CollateralManager
        vm.prank(owner);
        cm.setOperator(oracleKeeper, true);

        // Add collateral types
        vm.startPrank(owner);
        cm.addCollateral(address(cbETH), "cbETH", 18, 9500, CBETH_PRICE, 120, 0);
        cm.addCollateral(address(wstETH), "wstETH", 18, 9500, WSTETH_PRICE, 120, 0);
        cm.addCollateral(address(stUSDC), "stUSDC", 6, 9000, STUSDC_PRICE, 120, 0);
        vm.stopPrank();

        // Mint tokens to users
        cbETH.mint(alice, 100 * ETH_UNIT);
        wstETH.mint(alice, 50 * ETH_UNIT);
        stUSDC.mint(alice, 100_000 * USDC_UNIT);

        cbETH.mint(bob, 200 * ETH_UNIT);

        // Approve CollateralManager
        vm.prank(alice);
        cbETH.approve(address(cm), type(uint256).max);
        vm.prank(alice);
        wstETH.approve(address(cm), type(uint256).max);
        vm.prank(alice);
        stUSDC.approve(address(cm), type(uint256).max);
        vm.prank(bob);
        cbETH.approve(address(cm), type(uint256).max);
    }

    // ============================================================
    //                  CONSTRUCTOR
    // ============================================================

    function test_constructor() public view {
        assertEq(cm.owner(), owner);
        assertEq(address(cm.vault()), address(vault));
        assertEq(cm.supportedTokenCount(), 3);
    }

    function test_constructor_revertsZeroVault() public {
        vm.expectRevert(CollateralManager.ZeroAddress.selector);
        new CollateralManager(address(0), owner);
    }

    // ============================================================
    //                  ADD COLLATERAL
    // ============================================================

    function test_addCollateral_success() public view {
        (address token,,uint8 dec, uint256 haircut, uint256 price,,,bool active,,) = cm.collaterals(address(cbETH));
        assertEq(token, address(cbETH));
        assertEq(dec, 18);
        assertEq(haircut, 9500);
        assertEq(price, CBETH_PRICE);
        assertTrue(active);
    }

    function test_addCollateral_revertsDuplicate() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CollateralManager.CollateralAlreadyExists.selector, address(cbETH)));
        cm.addCollateral(address(cbETH), "cbETH", 18, 9500, CBETH_PRICE, 120, 0);
    }

    function test_addCollateral_revertsHaircutTooLow() public {
        MockERC20 newToken = new MockERC20("Test", "TST", 18);
        vm.prank(owner);
        vm.expectRevert("Haircut too aggressive");
        cm.addCollateral(address(newToken), "TST", 18, 4999, 1e6, 120, 0); // below 50%
    }

    function test_addCollateral_revertsNotOwner() public {
        MockERC20 newToken = new MockERC20("Test", "TST", 18);
        vm.prank(alice);
        vm.expectRevert(CollateralManager.NotOwner.selector);
        cm.addCollateral(address(newToken), "TST", 18, 9500, 1e6, 120, 0);
    }

    // ============================================================
    //                  DEPOSIT COLLATERAL
    // ============================================================

    function test_deposit_cbETH_creditCalculation() public {
        uint256 amount = 10 * ETH_UNIT; // 10 cbETH

        vm.prank(alice);
        uint256 credited = cm.depositCollateral(address(cbETH), amount);

        // credit = 10e18 * 3500e6 * 9500 / (1e18 * 10000) = 33,250e6
        uint256 expected = (amount * CBETH_PRICE * 9500) / (ETH_UNIT * BPS);
        assertEq(credited, expected);
        assertEq(credited, 33_250 * USDC_UNIT); // $33,250

        // C-5 fix: collateral credits go to collateralBalances
        assertEq(vault.collateralBalances(alice), credited);
        assertEq(vault.balanceOf(alice), credited);

        // Check token was transferred
        assertEq(cbETH.balanceOf(address(cm)), amount);
        assertEq(cbETH.balanceOf(alice), 90 * ETH_UNIT);
    }

    function test_deposit_stUSDC_6decimals() public {
        uint256 amount = 10_000 * USDC_UNIT; // 10,000 stUSDC (6 decimals)

        vm.prank(alice);
        uint256 credited = cm.depositCollateral(address(stUSDC), amount);

        // credit = 10000e6 * 1e6 * 9000 / (1e6 * 10000) = 9,000e6
        uint256 expected = (amount * STUSDC_PRICE * 9000) / (USDC_UNIT * BPS);
        assertEq(credited, expected);
        assertEq(credited, 9_000 * USDC_UNIT); // $9,000 (90% of $10,000)
    }

    function test_deposit_revertsUnsupportedToken() public {
        MockERC20 random = new MockERC20("Random", "RND", 18);
        random.mint(alice, 100 * ETH_UNIT);
        vm.prank(alice);
        random.approve(address(cm), type(uint256).max);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralManager.CollateralNotSupported.selector, address(random)));
        cm.depositCollateral(address(random), 1 * ETH_UNIT);
    }

    function test_deposit_revertsZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(CollateralManager.ZeroAmount.selector);
        cm.depositCollateral(address(cbETH), 0);
    }

    function test_deposit_revertsPausedCollateral() public {
        vm.prank(owner);
        cm.pauseCollateral(address(cbETH));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralManager.CollateralPaused.selector, address(cbETH)));
        cm.depositCollateral(address(cbETH), 1 * ETH_UNIT);
    }

    function test_deposit_revertsStalePrice() public {
        // Advance time past maxPriceAge (120s)
        vm.warp(block.timestamp + 200);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralManager.StalePrice.selector, address(cbETH)));
        cm.depositCollateral(address(cbETH), 1 * ETH_UNIT);
    }

    function test_deposit_depositCap() public {
        // Add a capped collateral
        MockERC20 capped = new MockERC20("Capped", "CAP", 18);
        vm.prank(owner);
        cm.addCollateral(address(capped), "CAP", 18, 9500, 1000 * USDC_UNIT, 120, 5 * ETH_UNIT); // cap: 5 tokens

        capped.mint(alice, 100 * ETH_UNIT);
        vm.prank(alice);
        capped.approve(address(cm), type(uint256).max);

        // Deposit 3 tokens: OK
        vm.prank(alice);
        cm.depositCollateral(address(capped), 3 * ETH_UNIT);

        // Deposit 3 more: exceeds cap of 5
        vm.prank(alice);
        vm.expectRevert("Deposit cap exceeded");
        cm.depositCollateral(address(capped), 3 * ETH_UNIT);
    }

    // ============================================================
    //                  WITHDRAW COLLATERAL
    // ============================================================

    function test_withdraw_full() public {
        uint256 depositAmount = 10 * ETH_UNIT;

        vm.prank(alice);
        uint256 credited = cm.depositCollateral(address(cbETH), depositAmount);

        uint256 vaultBefore = vault.collateralBalances(alice);
        uint256 tokenBefore = cbETH.balanceOf(alice);

        vm.prank(alice);
        cm.withdrawCollateral(address(cbETH), depositAmount);

        // Vault collateral balance should be debited
        assertEq(vault.collateralBalances(alice), vaultBefore - credited);

        // Tokens returned
        assertEq(cbETH.balanceOf(alice), tokenBefore + depositAmount);

        // Tracking cleared
        (uint256 amt, uint256 cred,) = cm.getTraderCollateral(address(cbETH), alice);
        assertEq(amt, 0);
        assertEq(cred, 0);
    }

    function test_withdraw_partial() public {
        uint256 depositAmount = 10 * ETH_UNIT;

        vm.prank(alice);
        uint256 credited = cm.depositCollateral(address(cbETH), depositAmount);

        // Withdraw half
        vm.prank(alice);
        cm.withdrawCollateral(address(cbETH), 5 * ETH_UNIT);

        // Should have half the credited amount left
        (uint256 amt, uint256 cred,) = cm.getTraderCollateral(address(cbETH), alice);
        assertEq(amt, 5 * ETH_UNIT);
        assertEq(cred, credited / 2);
    }

    function test_withdraw_revertsInsufficientCollateral() public {
        vm.prank(alice);
        cm.depositCollateral(address(cbETH), 5 * ETH_UNIT);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralManager.InsufficientCollateral.selector, 10 * ETH_UNIT, 5 * ETH_UNIT));
        cm.withdrawCollateral(address(cbETH), 10 * ETH_UNIT);
    }

    // ============================================================
    //                  ORACLE PRICE UPDATES
    // ============================================================

    function test_updatePrice_success() public {
        // H-13 fix: price change must be within maxPriceDeviationBps (10%)
        uint256 newPrice = 3_800 * USDC_UNIT; // cbETH goes from $3,500 to $3,800 (8.57%)

        vm.prank(oracleKeeper);
        cm.updatePrice(address(cbETH), newPrice);

        (,,,, uint256 price,,,,,) = cm.collaterals(address(cbETH));
        assertEq(price, newPrice);
    }

    function test_updatePrice_revertsNotOperator() public {
        vm.prank(alice);
        vm.expectRevert(CollateralManager.NotOperator.selector);
        cm.updatePrice(address(cbETH), 4_000 * USDC_UNIT);
    }

    function test_updatePrice_affectsNewDeposits() public {
        // H-13 fix: price change within 10% deviation
        vm.prank(oracleKeeper);
        cm.updatePrice(address(cbETH), 3_800 * USDC_UNIT); // $3,500 → $3,800 (8.57%)

        vm.prank(alice);
        uint256 credited = cm.depositCollateral(address(cbETH), 10 * ETH_UNIT);

        // credit = 10e18 * 3800e6 * 9500 / (1e18 * 10000) = 36,100e6
        assertEq(credited, 36_100 * USDC_UNIT);
    }

    // ============================================================
    //                  MULTI-TOKEN PORTFOLIO
    // ============================================================

    function test_multiToken_portfolioValue() public {
        // Deposit 10 cbETH + 5 wstETH + 10,000 stUSDC
        vm.startPrank(alice);
        cm.depositCollateral(address(cbETH), 10 * ETH_UNIT);
        cm.depositCollateral(address(wstETH), 5 * ETH_UNIT);
        cm.depositCollateral(address(stUSDC), 10_000 * USDC_UNIT);
        vm.stopPrank();

        uint256 totalValue = cm.getCollateralValue(alice);

        // cbETH: 10 * 3500 * 0.95 = $33,250
        // wstETH: 5 * 3600 * 0.95 = $17,100
        // stUSDC: 10000 * 1 * 0.90 = $9,000
        // Total = $59,350
        assertEq(totalValue, 59_350 * USDC_UNIT);
    }

    function test_multiToken_independentTracking() public {
        vm.prank(alice);
        cm.depositCollateral(address(cbETH), 10 * ETH_UNIT);

        vm.prank(bob);
        cm.depositCollateral(address(cbETH), 20 * ETH_UNIT);

        // Alice: 10 cbETH
        (uint256 aliceAmt,,) = cm.getTraderCollateral(address(cbETH), alice);
        assertEq(aliceAmt, 10 * ETH_UNIT);

        // Bob: 20 cbETH
        (uint256 bobAmt,,) = cm.getTraderCollateral(address(cbETH), bob);
        assertEq(bobAmt, 20 * ETH_UNIT);

        // Total deposited: 30 cbETH
        (,,,,,,,, uint256 totalDeposited,) = cm.collaterals(address(cbETH));
        assertEq(totalDeposited, 30 * ETH_UNIT);
    }

    // ============================================================
    //                  HAIRCUT CHANGES
    // ============================================================

    function test_setHaircut_success() public {
        vm.prank(owner);
        cm.setHaircut(address(cbETH), 9000); // reduce to 90%

        (,,, uint256 haircut,,,,,,) = cm.collaterals(address(cbETH));
        assertEq(haircut, 9000);
    }

    function test_setHaircut_revertsOutOfRange() public {
        vm.prank(owner);
        vm.expectRevert("Invalid haircut");
        cm.setHaircut(address(cbETH), 4999); // below 50%

        vm.prank(owner);
        vm.expectRevert("Invalid haircut");
        cm.setHaircut(address(cbETH), 10001); // above 100%
    }

    // ============================================================
    //                  PAUSE / UNPAUSE
    // ============================================================

    function test_pause_blocksDeposits() public {
        vm.prank(owner);
        cm.pauseCollateral(address(cbETH));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralManager.CollateralPaused.selector, address(cbETH)));
        cm.depositCollateral(address(cbETH), 1 * ETH_UNIT);
    }

    function test_unpause_allowsDeposits() public {
        vm.prank(owner);
        cm.pauseCollateral(address(cbETH));

        vm.prank(owner);
        cm.unpauseCollateral(address(cbETH));

        vm.prank(alice);
        uint256 credited = cm.depositCollateral(address(cbETH), 1 * ETH_UNIT);
        assertTrue(credited > 0);
    }

    // ============================================================
    //                  PRECISION EDGE CASES
    // ============================================================

    function test_precision_smallDeposit() public {
        // Deposit 0.001 cbETH (1e15 wei)
        uint256 tiny = 1e15; // 0.001 ETH

        vm.prank(alice);
        uint256 credited = cm.depositCollateral(address(cbETH), tiny);

        // credit = 1e15 * 3500e6 * 9500 / (1e18 * 10000) = 3.325e6 = $3.325
        assertEq(credited, 3_325_000);
    }

    function test_precision_largeDeposit() public {
        // Deposit 1000 cbETH
        cbETH.mint(alice, 1000 * ETH_UNIT);
        vm.prank(alice);
        cbETH.approve(address(cm), type(uint256).max);

        vm.prank(alice);
        uint256 credited = cm.depositCollateral(address(cbETH), 1000 * ETH_UNIT);

        // credit = 1000 * 3500 * 0.95 = $3,325,000
        assertEq(credited, 3_325_000 * USDC_UNIT);
    }

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    function test_getSupportedTokens() public view {
        address[] memory tokens = cm.getSupportedTokens();
        assertEq(tokens.length, 3);
        assertEq(tokens[0], address(cbETH));
        assertEq(tokens[1], address(wstETH));
        assertEq(tokens[2], address(stUSDC));
    }

    function test_getTraderCollateral_currentValue() public {
        vm.prank(alice);
        cm.depositCollateral(address(cbETH), 10 * ETH_UNIT);

        // H-13 fix: price change within 10% deviation
        vm.prank(oracleKeeper);
        cm.updatePrice(address(cbETH), 3_800 * USDC_UNIT); // $3,500 → $3,800

        (uint256 amt, uint256 credited, uint256 currentVal) = cm.getTraderCollateral(address(cbETH), alice);
        assertEq(amt, 10 * ETH_UNIT);
        assertEq(credited, 33_250 * USDC_UNIT); // at old price: 10 * 3500 * 0.95
        assertEq(currentVal, 36_100 * USDC_UNIT); // at new price: 10 * 3800 * 0.95
    }
}
