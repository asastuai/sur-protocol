// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/PerpVault.sol";
import "../../src/PerpEngine.sol";
import "../mocks/MockUSDC.sol";

/// @title InvariantHandler - Defines actions for Foundry's invariant fuzzer
/// @dev The fuzzer calls random sequences of these functions, then the
///      invariant test verifies that protocol invariants still hold.

contract InvariantHandler is Test {
    PerpVault public vault;
    PerpEngine public engine;
    MockUSDC public usdc;

    address public owner;
    bytes32 public btcMarket;

    // Track all actors for invariant checking
    address[] public actors;
    mapping(address => bool) public isActor;

    uint256 constant USDC_UNIT = 1e6;
    uint256 constant SIZE_UNIT = 1e8;

    // Ghost variables: track expected state independently
    uint256 public ghost_totalDeposited;
    uint256 public ghost_totalWithdrawn;
    uint256 public ghost_totalTrades;

    constructor(
        PerpVault _vault,
        PerpEngine _engine,
        MockUSDC _usdc,
        address _owner,
        bytes32 _btcMarket
    ) {
        vault = _vault;
        engine = _engine;
        usdc = _usdc;
        owner = _owner;
        btcMarket = _btcMarket;

        // Pre-create actors
        for (uint256 i = 1; i <= 5; i++) {
            address actor = address(uint160(i * 1000 + 777));
            actors.push(actor);
            isActor[actor] = true;

            // Mint and deposit for each actor
            usdc.mint(actor, 100_000 * USDC_UNIT);
            vm.startPrank(actor);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(50_000 * USDC_UNIT);
            vm.stopPrank();

            ghost_totalDeposited += 50_000 * USDC_UNIT;
        }
    }

    // ============================================================
    //               FUZZABLE ACTIONS
    // ============================================================

    /// @notice Deposit USDC into vault
    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = _getActor(actorSeed);
        amount = bound(amount, 1, 10_000 * USDC_UNIT);

        // Mint fresh USDC
        usdc.mint(actor, amount);

        vm.startPrank(actor);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();

        ghost_totalDeposited += amount;
    }

    /// @notice Withdraw USDC from vault
    function withdraw(uint256 actorSeed, uint256 amount) external {
        address actor = _getActor(actorSeed);
        uint256 balance = vault.balances(actor);
        if (balance == 0) return;

        amount = bound(amount, 1, balance);

        vm.prank(actor);
        vault.withdraw(amount);

        ghost_totalWithdrawn += amount;
    }

    /// @notice Open a position (via operator, simulating settlement)
    function openPosition(uint256 actorSeed, uint256 sizeSeed, bool isLong) external {
        address actor = _getActor(actorSeed);
        uint256 balance = vault.balances(actor);
        if (balance < 1_000 * USDC_UNIT) return; // need min balance for margin

        uint256 size = bound(sizeSeed, SIZE_UNIT / 100, 2 * SIZE_UNIT); // 0.01 - 2 BTC

        int256 sizeDelta = isLong ? int256(size) : -int256(size);

        vm.prank(owner);
        try engine.openPosition(btcMarket, actor, sizeDelta, 50_000 * USDC_UNIT) {
            ghost_totalTrades++;
        } catch {
            // Insufficient margin or other error - that's fine
        }
    }

    /// @notice Close a position (reduce to zero)
    function closePosition(uint256 actorSeed) external {
        address actor = _getActor(actorSeed);
        (int256 size,,,,,) = engine.positions(btcMarket, actor);
        if (size == 0) return;

        // Opposite sizeDelta to close
        int256 closeDelta = -size;

        vm.prank(owner);
        try engine.openPosition(btcMarket, actor, closeDelta, 50_000 * USDC_UNIT) {
            ghost_totalTrades++;
        } catch {}
    }

    /// @notice Update mark price (within reasonable range)
    function updatePrice(uint256 priceSeed) external {
        uint256 price = bound(priceSeed, 30_000 * USDC_UNIT, 80_000 * USDC_UNIT);

        vm.prank(owner);
        engine.updateMarkPrice(btcMarket, price, price);
    }

    // ============================================================
    //                      HELPERS
    // ============================================================

    function _getActor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function getActor(uint256 i) external view returns (address) {
        return actors[i];
    }
}
