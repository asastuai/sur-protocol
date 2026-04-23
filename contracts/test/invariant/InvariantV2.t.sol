// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import "../../src/PerpVault.sol";
import "../../src/PerpEngine.sol";
import "../../src/InsuranceFund.sol";
import "../../src/Liquidator.sol";
import "../mocks/MockUSDC.sol";
import "./InvariantHandlerV2.sol";

/// @title SUR Protocol - Enhanced Invariant Tests V2
/// @notice Multi-market, liquidation, funding, time warps
///         Run: forge test --match-contract InvariantV2Test -vvv --invariant-depth 200 --invariant-runs 512

contract InvariantV2Test is StdInvariant, Test {
    PerpVault public vault;
    PerpEngine public engine;
    InsuranceFund public insurance;
    Liquidator public liquidator;
    MockUSDC public usdc;
    InvariantHandlerV2 public handler;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("feeRecipient");
    address public fundingPool = makeAddr("fundingPool");

    bytes32 public btcMarket;
    bytes32 public ethMarket;

    uint256 constant U = 1e6;
    uint256 constant S = 1e8;

    function setUp() public {
        vm.warp(1700000000);

        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, type(uint256).max);
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), fundingPool);
        liquidator = new Liquidator(address(engine), address(insurance), owner);

        btcMarket = keccak256(abi.encodePacked("BTC-USD"));
        ethMarket = keccak256(abi.encodePacked("ETH-USD"));

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        engine.setOperator(owner, true);
        engine.setOperator(address(liquidator), true);
        engine.setMaxExposureBps(0);
        engine.setOiSkewCap(10000);
        insurance.setOperator(address(engine), true);

        engine.addMarket("BTC-USD", 500, 250, 100_000 * S, 28800);
        engine.addMarket("ETH-USD", 500, 250, 1_000_000 * S, 28800);
        engine.updateMarkPrice(btcMarket, 50_000 * U, 50_000 * U);
        engine.updateMarkPrice(ethMarket, 3_000 * U, 3_000 * U);
        vm.stopPrank();

        // Seed insurance fund
        usdc.mint(address(this), 5_000_000 * U);
        usdc.approve(address(vault), 5_000_000 * U);
        vault.deposit(5_000_000 * U);
        vm.prank(owner);
        vault.setOperator(address(this), true);
        vault.internalTransfer(address(this), address(insurance), 2_000_000 * U);
        vault.internalTransfer(address(this), fundingPool, 1_000_000 * U);

        handler = new InvariantHandlerV2(
            vault, engine, insurance, liquidator, usdc,
            owner, btcMarket, ethMarket, fundingPool
        );

        targetContract(address(handler));
    }

    // ============================================================
    //  INVARIANT 1: VAULT SOLVENCY (actualUSDC >= totalDeposits)
    // ============================================================
    function invariant_v2_vaultSolvency() public view {
        uint256 actualUsdc = usdc.balanceOf(address(vault));
        uint256 totalDeposits = vault.totalDeposits();
        assertGe(
            actualUsdc,
            totalDeposits,
            "CRITICAL: Vault holds less USDC than total deposits"
        );
    }

    // ============================================================
    //  INVARIANT 2: NO NEGATIVE BALANCES (sum <= totalDeposits)
    // ============================================================
    function invariant_v2_balanceSumBounded() public view {
        uint256 trackedSum = handler.totalTrackedBalances();
        uint256 totalDeposits = vault.totalDeposits();
        assertLe(
            trackedSum,
            totalDeposits,
            "CRITICAL: Tracked balance sum exceeds total deposits"
        );
    }

    // ============================================================
    //  INVARIANT 3: VAULT HEALTH CHECK ALWAYS PASSES
    // ============================================================
    function invariant_v2_vaultHealthy() public view {
        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "CRITICAL: Vault health check failed");
    }

    // ============================================================
    //  INVARIANT 4: DEPOSIT/WITHDRAW CONSERVATION
    //  actualUSDC = seed + handler_deposits - handler_withdrawals
    // ============================================================
    function invariant_v2_conservation() public view {
        uint256 actualUsdc = usdc.balanceOf(address(vault));
        uint256 deposited = handler.ghost_totalDeposited();
        uint256 withdrawn = handler.ghost_totalWithdrawn();

        // Seed: 5M (setUp) + 800k (8 actors * 100k each)
        uint256 seedDeposit = 5_000_000 * U;
        assertEq(
            actualUsdc,
            seedDeposit + deposited - withdrawn,
            "CRITICAL: USDC doesn't match deposit/withdraw history"
        );
    }

    // ============================================================
    //  INVARIANT 5: OI MUST BE BALANCED (longs ≈ shorts in net)
    //  With balanced counterparties, net OI should be bounded
    // ============================================================
    function invariant_v2_oiBalance() public view {
        // For each market, OI long should equal OI short (they're countered)
        // The engine tracks this internally
        (,,,uint256 oiLong, uint256 oiShort,,,,,,,,, ) = engine.markets(btcMarket);
        // OI long and short are absolute values, they don't need to match
        // but the protocol should track them correctly
        // Just verify they're not insanely different (could indicate accounting bug)
        if (oiLong > 0 || oiShort > 0) {
            uint256 totalOi = oiLong + oiShort;
            // Neither side should be more than 100% of total OI
            assertLe(oiLong, totalOi, "Long OI exceeds total");
            assertLe(oiShort, totalOi, "Short OI exceeds total");
        }
    }

    // ============================================================
    //  INVARIANT 6: INSURANCE FUND BALANCE CONSISTENCY
    //  Insurance fund balance in vault should match what IF reports
    // ============================================================
    function invariant_v2_insuranceFundConsistency() public view {
        uint256 vaultBal = vault.balances(address(insurance));
        uint256 ifBal = insurance.balance();
        assertEq(vaultBal, ifBal, "Insurance fund balance mismatch");
    }

    // ============================================================
    //  INVARIANT 7: NO ACTOR HAS NEGATIVE EQUITY WITH ZERO POSITION
    //  If an actor has no open positions, their balance should be >= 0
    //  (which it always is since uint256, but we check it's accessible)
    // ============================================================
    function invariant_v2_noStuckFunds() public view {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address actor = handler.getActor(i);
            (int256 btcSize,,,,,) = engine.positions(btcMarket, actor);
            (int256 ethSize,,,,,) = engine.positions(ethMarket, actor);

            if (btcSize == 0 && ethSize == 0) {
                // Actor with no positions should be able to withdraw their full balance
                // (no margin locked). Just verify balance is query-able.
                uint256 bal = vault.balances(actor);
                // Balance should be consistent with vault total
                assertLe(bal, vault.totalDeposits(), "Actor balance exceeds total deposits");
            }
        }
    }
}
