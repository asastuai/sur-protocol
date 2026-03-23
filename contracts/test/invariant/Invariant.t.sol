// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import "../../src/PerpVault.sol";
import "../../src/PerpEngine.sol";
import "../../src/InsuranceFund.sol";
import "../mocks/MockUSDC.sol";
import "./InvariantHandler.sol";

/// @title SUR Protocol - Invariant Tests
/// @notice Foundry's fuzzer calls random sequences of actions on the handler,
///         then these invariant_* functions verify that core protocol properties hold.
///
/// @dev Run with: forge test --match-contract InvariantTest -vvv
///      Increase depth: forge test --match-contract InvariantTest --invariant-depth 100

contract InvariantTest is StdInvariant, Test {
    PerpVault public vault;
    PerpEngine public engine;
    InsuranceFund public insurance;
    MockUSDC public usdc;
    InvariantHandler public handler;

    address public owner = makeAddr("owner");
    address public feeRecipient = makeAddr("feeRecipient");

    bytes32 public btcMarket;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PerpVault(address(usdc), owner, 0); // unlimited
        insurance = new InsuranceFund(address(vault), owner);
        engine = new PerpEngine(address(vault), owner, feeRecipient, address(insurance), feeRecipient);

        btcMarket = keccak256(abi.encodePacked("BTC-USD"));

        vm.startPrank(owner);
        vault.setOperator(address(engine), true);
        engine.setOperator(owner, true);
        engine.setMaxExposureBps(0); // disable for invariant tests

        engine.addMarket("BTC-USD", 500, 250, 10_000 * 1e8, 28800);
        engine.updateMarkPrice(btcMarket, 50_000 * 1e6, 50_000 * 1e6);
        vm.stopPrank();

        // Fund insurance to backstop profits
        usdc.mint(address(this), 1_000_000 * 1e6);
        usdc.approve(address(vault), 1_000_000 * 1e6);
        vault.deposit(1_000_000 * 1e6);
        vm.prank(owner);
        vault.setOperator(address(this), true);
        vault.internalTransfer(address(this), address(insurance), 1_000_000 * 1e6);

        handler = new InvariantHandler(vault, engine, usdc, owner, btcMarket);

        // Tell Foundry to only call functions on the handler
        targetContract(address(handler));
    }

    // ============================================================
    //          INVARIANT 1: VAULT SOLVENCY
    // ============================================================

    /// @notice The vault must ALWAYS hold at least as much USDC as it accounts for
    function invariant_vaultSolvency() public view {
        uint256 actualUsdc = usdc.balanceOf(address(vault));
        uint256 totalAccounted = vault.totalDeposits();
        assertGe(
            actualUsdc,
            totalAccounted,
            "CRITICAL: Vault holds less USDC than accounted"
        );
    }

    // ============================================================
    //          INVARIANT 2: DEPOSIT/WITHDRAW CONSERVATION
    // ============================================================

    /// @notice Total real USDC balance = seed + handler deposits - handler withdrawals
    function invariant_depositWithdrawConservation() public view {
        uint256 actualUsdc = usdc.balanceOf(address(vault));
        uint256 deposited = handler.ghost_totalDeposited();
        uint256 withdrawn = handler.ghost_totalWithdrawn();

        // The vault's actual USDC should equal seed deposit + handler deposits - withdrawals
        uint256 seedDeposit = 1_000_000 * 1e6; // insurance fund seed from setUp
        assertEq(
            actualUsdc,
            seedDeposit + deposited - withdrawn,
            "CRITICAL: USDC balance doesn't match deposit/withdraw history"
        );
    }

    // ============================================================
    //          INVARIANT 3: NO NEGATIVE VAULT BALANCES
    // ============================================================

    /// @notice No account should ever have a negative vault balance
    /// @dev uint256 prevents this by type, but we verify the accounting
    function invariant_noNegativeBalances() public view {
        uint256 totalAccountBalances = 0;

        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address actor = handler.getActor(i);
            uint256 bal = vault.balances(actor);
            totalAccountBalances += bal;
        }

        // Engine and other contract balances
        totalAccountBalances += vault.balances(address(engine));
        totalAccountBalances += vault.balances(feeRecipient);
        totalAccountBalances += vault.balances(address(insurance));

        // Total of individual balances should never exceed total deposits
        // (it can be less if some accounts aren't tracked)
        assertLe(
            totalAccountBalances,
            vault.totalDeposits(),
            "CRITICAL: Sum of balances exceeds total deposits"
        );
    }

    // ============================================================
    //          INVARIANT 4: VAULT HEALTH CHECK
    // ============================================================

    /// @notice The vault's own health check should never fail
    function invariant_vaultHealthCheck() public view {
        (bool healthy,,) = vault.healthCheck();
        assertTrue(healthy, "CRITICAL: Vault health check failed");
    }
}
