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

/// @title PerpVault Chaos Tests
/// @notice Attack vectors: collateral→deposit conversion, totalDeposits underflow,
///         withdraw during open positions, operator abuse, healthCheck manipulation

contract VaultChaosTest is Test {
    MockUSDC public usdc;
    PerpVault public vault;
    PerpEngine public engine;
    OrderSettlement public settlement;
    Liquidator public liquidator;
    InsuranceFund public insurance;
    MockPyth public mockPyth;
    MockChainlinkAggregator public mockCL_BTC;
    OracleRouter public oracle;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("treasury");
    address public keeper = makeAddr("keeper");
    address public attacker = makeAddr("attacker");

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
        vault.setOperator(owner, true); // owner as operator for direct tests
        engine.setOperator(address(settlement), true);
        engine.setOperator(address(liquidator), true);
        engine.setOperator(owner, true);
        settlement.setOperator(owner, true);
        insurance.setOperator(address(liquidator), true);
        oracle.setOperator(owner, true);

        engine.setMaxExposureBps(0);
        engine.setCircuitBreakerParams(60, 10000, 60);
        engine.setOiSkewCap(10000);
        settlement.setSettlementDelay(0, 300);

        engine.addMarket("BTC-USD", 500, 250, 1_000_000 * S, 28800);
        engine.updateMarkPrice(btcMkt, BTC_PRICE, BTC_PRICE);
        oracle.configureFeed(btcMkt, PYTH_BTC, address(mockCL_BTC), 120, 500, 200);
        vm.stopPrank();

        mockPyth.setPrice(PYTH_BTC, int64(int256(50_000 * 1e8)), 1_000_000, -8, block.timestamp);
        mockCL_BTC.setPrice(int256(50_000 * 1e8), block.timestamp);

        _fund(address(insurance), 10_000_000 * U);

        for (uint256 i = 0; i < 20; i++) {
            uint256 pk = 0x4000 + i;
            pks.push(pk);
            addrs.push(vm.addr(pk));
        }
    }

    // ================================================================
    //  TEST 1: Collateral credit → withdrawable USDC conversion
    //  When internalTransfer debits from collateralBalances but credits
    //  to balances, the recipient gets withdrawable USDC that was never
    //  deposited. This inflates withdrawable balance beyond actual USDC.
    // ================================================================
    function test_vault_collateralToDepositConversion() public {
        emit log_string("=== VAULT: Collateral-to-deposit conversion ===");

        // User A deposits real USDC
        address userA = addrs[0];
        _fund(userA, 100_000 * U);

        // User B gets collateral credits (no real USDC deposited)
        address userB = addrs[1];
        vm.prank(owner);
        vault.creditCollateral(userB, 50_000 * U);

        uint256 totalDepBefore = vault.totalDeposits();
        uint256 totalColBefore = vault.totalCollateralCredits();
        emit log_named_uint("  totalDeposits before", totalDepBefore);
        emit log_named_uint("  totalCollateralCredits before", totalColBefore);
        emit log_named_uint("  Actual USDC in vault", usdc.balanceOf(address(vault)));

        // Operator transfers from B (collateral) to A (deposit balance)
        vm.prank(owner);
        vault.internalTransfer(userB, userA, 30_000 * U);

        uint256 totalDepAfter = vault.totalDeposits();
        uint256 totalColAfter = vault.totalCollateralCredits();
        uint256 aBal = vault.balances(userA);

        emit log_named_uint("  totalDeposits after transfer", totalDepAfter);
        emit log_named_uint("  totalCollateralCredits after transfer", totalColAfter);
        emit log_named_uint("  User A balance (withdrawable)", aBal);
        emit log_named_uint("  Actual USDC in vault", usdc.balanceOf(address(vault)));

        // A now has 130k withdrawable but vault only has 110k USDC
        // (100k from A's deposit + 10M from insurance)
        // The 30k collateral credit was converted to deposit balance!

        // Try to withdraw — this should reveal the totalDeposits underflow
        vm.prank(userA);
        try vault.withdraw(aBal) {
            emit log_string("  [BUG] User A withdrew more than totalDeposits should allow!");
            emit log_named_uint("  totalDeposits after withdraw", vault.totalDeposits());
        } catch {
            emit log_string("  Withdrawal failed (totalDeposits underflow or insufficient USDC)");
        }

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        emit log_named_uint("  Health: actual", actual);
        emit log_named_uint("  Health: accounted", accounted);
        emit log_named_uint("  Health: healthy?", healthy ? 1 : 0);
    }

    // ================================================================
    //  TEST 2: Withdraw during open position
    //  Trader deposits, opens position (margin locked in engine),
    //  then withdraws remaining vault balance. Is this safe?
    // ================================================================
    function test_vault_withdrawDuringOpenPosition() public {
        emit log_string("=== VAULT: Withdraw during open position ===");

        address trader = addrs[0];
        address cp = addrs[1];
        _fund(trader, 100_000 * U);
        _fund(cp, 100_000 * U);

        // Open position — engine locks margin
        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        uint256 traderBal = vault.balances(trader);
        emit log_named_uint("  Trader free balance after position open", traderBal);

        // Withdraw everything possible
        if (traderBal > 0) {
            vm.prank(trader);
            vault.withdraw(traderBal);
            emit log_named_uint("  Withdrew", traderBal);
        }

        // Trader now has 0 vault balance but open position
        // Can the position still be liquidated/closed?
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 35_000 * U, 35_000 * U);
        mockPyth.setPrice(PYTH_BTC, int64(int256(35_000 * 1e8)), 1_000_000, -8, block.timestamp);
        mockCL_BTC.setPrice(int256(35_000 * 1e8), block.timestamp);

        bool isLiq = engine.isLiquidatable(btcMkt, trader);
        emit log_named_uint("  Is liquidatable after withdraw + crash?", isLiq ? 1 : 0);

        if (isLiq) {
            vm.prank(keeper);
            try liquidator.liquidate(btcMkt, trader) {
                emit log_string("  [OK] Liquidation succeeded after withdraw");
            } catch {
                emit log_string("  [BUG] Can't liquidate after trader withdrew!");
            }
        }

        // Close CP
        vm.prank(owner);
        engine.closePosition(btcMkt, cp, 35_000 * U);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 3: Deposit cap enforcement
    //  Can the cap be bypassed via collateral credits?
    // ================================================================
    function test_vault_depositCapBypass() public {
        emit log_string("=== VAULT: Deposit cap bypass via collateral ===");

        // Set deposit cap high enough to allow insurance + user deposit
        vm.prank(owner);
        vault.setDepositCap(10_200_000 * U); // insurance (10M) + 200k

        // Deposit up to remaining cap
        address user = addrs[0];
        usdc.mint(user, 200_000 * U);
        vm.startPrank(user);
        usdc.approve(address(vault), 200_000 * U);
        vault.deposit(200_000 * U);

        // Try to deposit beyond cap
        usdc.mint(user, 1 * U);
        usdc.approve(address(vault), 1 * U);
        try vault.deposit(1 * U) {
            emit log_string("  [BUG] Deposited beyond cap!");
        } catch {
            emit log_string("  [OK] Deposit cap enforced");
        }
        vm.stopPrank();

        // But can we get collateral credits beyond the cap?
        vm.prank(owner);
        try vault.creditCollateral(user, 100_000 * U) {
            emit log_string("  [INFO] Collateral credit bypasses deposit cap (by design?)");
            uint256 totalBal = vault.balances(user) + vault.collateralBalances(user);
            emit log_named_uint("  User total balance", totalBal);
        } catch {
            emit log_string("  [OK] Collateral credit also capped");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 4: Internal transfer self-to-self
    //  Operator calls internalTransfer(A, A, amount) — is this a no-op?
    // ================================================================
    function test_vault_selfTransfer() public {
        emit log_string("=== VAULT: Self-transfer via operator ===");

        address user = addrs[0];
        _fund(user, 100_000 * U);

        uint256 balBefore = vault.balances(user);

        vm.prank(owner);
        vault.internalTransfer(user, user, 50_000 * U);

        uint256 balAfter = vault.balances(user);
        emit log_named_uint("  Balance before", balBefore);
        emit log_named_uint("  Balance after self-transfer", balAfter);

        assertEq(balBefore, balAfter, "BROKEN: Self-transfer changed balance");
    }

    // ================================================================
    //  TEST 5: Concurrent withdrawals race condition
    //  Multiple users try to withdraw simultaneously.
    //  Does the vault handle balance correctly?
    // ================================================================
    function test_vault_concurrentWithdrawals() public {
        emit log_string("=== VAULT: Concurrent withdrawals ===");

        // 10 users deposit $100k each
        for (uint256 i = 0; i < 10; i++) {
            _fund(addrs[i], 100_000 * U);
        }

        uint256 vaultBefore = usdc.balanceOf(address(vault));
        emit log_named_uint("  Vault USDC before withdrawals", vaultBefore);

        // All withdraw at once
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(addrs[i]);
            vault.withdraw(100_000 * U);
        }

        uint256 vaultAfter = usdc.balanceOf(address(vault));
        emit log_named_uint("  Vault USDC after all withdrawals", vaultAfter);

        // Vault should still have insurance fund balance
        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent after concurrent withdrawals");
        assertEq(actual, accounted, "BROKEN: Accounting mismatch");
    }

    // ================================================================
    //  TEST 6: Max withdrawal per tx enforcement
    // ================================================================
    function test_vault_maxWithdrawalEnforcement() public {
        emit log_string("=== VAULT: Max withdrawal per tx ===");

        vm.prank(owner);
        vault.setMaxWithdrawalPerTx(10_000 * U);

        address user = addrs[0];
        _fund(user, 100_000 * U);

        // Try to withdraw more than max
        vm.prank(user);
        try vault.withdraw(50_000 * U) {
            emit log_string("  [BUG] Withdrew beyond max per tx!");
        } catch {
            emit log_string("  [OK] Max withdrawal enforced");
        }

        // Withdraw at max
        vm.prank(user);
        vault.withdraw(10_000 * U);
        emit log_string("  [OK] Withdrew at max limit");

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 7: Max operator transfer per tx
    // ================================================================
    function test_vault_maxOperatorTransfer() public {
        emit log_string("=== VAULT: Max operator transfer per tx ===");

        vm.prank(owner);
        vault.setMaxOperatorTransferPerTx(10_000 * U);

        address user = addrs[0];
        _fund(user, 100_000 * U);

        // Operator tries large transfer
        vm.prank(owner);
        try vault.internalTransfer(user, addrs[1], 50_000 * U) {
            emit log_string("  [BUG] Operator transferred beyond max!");
        } catch {
            emit log_string("  [OK] Max operator transfer enforced");
        }

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 8: healthCheck after complex collateral + deposit mix
    //  Verify the health check catches mismatches between actual USDC
    //  and tracked balances after collateral operations.
    // ================================================================
    function test_vault_healthCheckWithCollateral() public {
        emit log_string("=== VAULT: Health check with collateral mix ===");

        // Deposit real USDC
        _fund(addrs[0], 500_000 * U);
        _fund(addrs[1], 500_000 * U);

        // Credit collateral (no real USDC)
        vm.prank(owner);
        vault.creditCollateral(addrs[2], 200_000 * U);

        // Transfer from collateral user to deposit user via engine
        vm.prank(owner);
        vault.internalTransfer(addrs[2], addrs[0], 100_000 * U);

        // Now addrs[0] has 600k withdrawable, but vault only has ~11M USDC
        uint256 bal0 = vault.balances(addrs[0]);
        uint256 totalDep = vault.totalDeposits();
        emit log_named_uint("  User 0 balance", bal0);
        emit log_named_uint("  totalDeposits", totalDep);
        emit log_named_uint("  Actual USDC", usdc.balanceOf(address(vault)));

        // The issue: balances sum > totalDeposits if collateral was transferred
        // because internalTransfer doesn't update totalDeposits or totalCollateralCredits

        // Sum all balances
        uint256 totalBals = vault.balances(addrs[0]) + vault.balances(addrs[1])
            + vault.balances(addrs[2]) + vault.balances(address(insurance))
            + vault.balances(address(engine));
        emit log_named_uint("  Sum of all deposit balances", totalBals);
        emit log_named_uint("  totalDeposits tracker", totalDep);

        if (totalBals > totalDep) {
            emit log_string("  [BUG] Sum of balances > totalDeposits! Collateral leaked into deposits.");
            emit log_named_uint("  Excess (collateral leaked)", totalBals - totalDep);
        }

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        emit log_named_uint("  Healthy?", healthy ? 1 : 0);

        // The health check only compares actual USDC vs totalDeposits
        // If totalDeposits wasn't inflated, it passes even though balances sum > totalDeposits
        // The real test: can users withdraw their deposit balance?
        vm.prank(addrs[0]);
        try vault.withdraw(bal0) {
            if (totalBals > totalDep) {
                emit log_string("  [BUG] Withdrawal succeeded with inflated balances!");
            } else {
                emit log_string("  [OK] Withdrawal succeeded (balances are clean)");
            }
        } catch {
            emit log_string("  Withdrawal failed (expected if balances inflated)");
        }
    }

    // ================================================================
    //  TEST 9: Pause/unpause during active positions
    //  When vault is paused, can positions still be liquidated?
    // ================================================================
    function test_vault_pauseDuringActivePositions() public {
        emit log_string("=== VAULT: Pause during active positions ===");

        address trader = addrs[0];
        address cp = addrs[1];
        _fund(trader, 100_000 * U);
        _fund(cp, 100_000 * U);

        _trade(0, true, 1, false, btcMkt, S, BTC_PRICE, 1);

        // Pause vault
        vm.prank(owner);
        vault.pause();

        // Price crashes — trader should be liquidatable
        vm.prank(owner);
        engine.updateMarkPrice(btcMkt, 35_000 * U, 35_000 * U);
        mockPyth.setPrice(PYTH_BTC, int64(int256(35_000 * 1e8)), 1_000_000, -8, block.timestamp);
        mockCL_BTC.setPrice(int256(35_000 * 1e8), block.timestamp);

        // Try to liquidate while paused
        vm.prank(keeper);
        try liquidator.liquidate(btcMkt, trader) {
            emit log_string("  [BUG] Liquidation succeeded while vault is paused!");
            emit log_string("  Impact: Vault pause blocks user withdrawals but allows liquidations");
        } catch {
            emit log_string("  [INFO] Liquidation blocked while paused");
            emit log_string("  Impact: Vault pause prevents liquidations too - positions stuck");
        }

        // Unpause
        vm.prank(owner);
        vault.unpause();

        // Now liquidate
        vm.prank(keeper);
        try liquidator.liquidate(btcMkt, trader) {
            emit log_string("  [OK] Liquidation succeeded after unpause");
        } catch {
            emit log_string("  [BUG] Liquidation failed even after unpause!");
        }

        // Close CP
        vm.prank(owner);
        engine.closePosition(btcMkt, cp, 35_000 * U);

        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "BROKEN: Vault insolvent");
    }

    // ================================================================
    //  TEST 10: Zero-amount edge cases
    // ================================================================
    function test_vault_zeroAmountEdgeCases() public {
        emit log_string("=== VAULT: Zero amount edge cases ===");

        address user = addrs[0];
        _fund(user, 100_000 * U);

        // Zero deposit
        vm.prank(user);
        try vault.deposit(0) {
            emit log_string("  [BUG] Zero deposit accepted!");
        } catch {
            emit log_string("  [OK] Zero deposit rejected");
        }

        // Zero withdraw
        vm.prank(user);
        try vault.withdraw(0) {
            emit log_string("  [BUG] Zero withdraw accepted!");
        } catch {
            emit log_string("  [OK] Zero withdraw rejected");
        }

        // Zero internal transfer
        vm.prank(owner);
        try vault.internalTransfer(user, addrs[1], 0) {
            emit log_string("  [BUG] Zero transfer accepted!");
        } catch {
            emit log_string("  [OK] Zero transfer rejected");
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
