// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/PerpVault.sol";
import "../../src/PerpEngine.sol";
import "../../src/InsuranceFund.sol";
import "../../src/Liquidator.sol";
import "../mocks/MockUSDC.sol";

/// @title InvariantHandlerV2 - Enhanced handler with liquidation, funding, multi-market
/// @dev More actions = more sequences = more bugs found

contract InvariantHandlerV2 is Test {
    PerpVault public vault;
    PerpEngine public engine;
    InsuranceFund public insurance;
    Liquidator public liquidator;
    MockUSDC public usdc;

    address public owner;
    bytes32 public btcMarket;
    bytes32 public ethMarket;
    address public fundingPool;

    address[] public actors;
    mapping(address => bool) public isActor;

    uint256 constant U = 1e6;
    uint256 constant S = 1e8;

    // Ghost variables for independent tracking
    uint256 public ghost_totalDeposited;
    uint256 public ghost_totalWithdrawn;
    uint256 public ghost_totalTrades;
    uint256 public ghost_totalLiquidations;
    uint256 public ghost_totalFundingEvents;
    uint256 public ghost_priceUpdates;

    // Track OI independently
    uint256 public ghost_btcLongOI;
    uint256 public ghost_btcShortOI;

    // Track all positions for conservation checks
    mapping(address => int256) public ghost_btcPositions;
    mapping(address => int256) public ghost_ethPositions;

    constructor(
        PerpVault _vault,
        PerpEngine _engine,
        InsuranceFund _insurance,
        Liquidator _liquidator,
        MockUSDC _usdc,
        address _owner,
        bytes32 _btcMarket,
        bytes32 _ethMarket,
        address _fundingPool
    ) {
        vault = _vault;
        engine = _engine;
        insurance = _insurance;
        liquidator = _liquidator;
        usdc = _usdc;
        owner = _owner;
        btcMarket = _btcMarket;
        ethMarket = _ethMarket;
        fundingPool = _fundingPool;

        // Pre-create 8 actors
        for (uint256 i = 1; i <= 8; i++) {
            address actor = address(uint160(i * 10000 + 42));
            actors.push(actor);
            isActor[actor] = true;

            usdc.mint(actor, 200_000 * U);
            vm.startPrank(actor);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(100_000 * U);
            vm.stopPrank();

            ghost_totalDeposited += 100_000 * U;
        }
    }

    // ============================================================
    //               FUZZABLE ACTIONS
    // ============================================================

    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = _getActor(actorSeed);
        amount = bound(amount, 100 * U, 50_000 * U);

        usdc.mint(actor, amount);
        vm.startPrank(actor);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();

        ghost_totalDeposited += amount;
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        address actor = _getActor(actorSeed);
        uint256 balance = vault.balances(actor);
        if (balance < 100 * U) return;

        amount = bound(amount, 100 * U, balance);

        vm.prank(actor);
        try vault.withdraw(amount) {
            ghost_totalWithdrawn += amount;
        } catch {}
    }

    function openBtcPosition(uint256 actorSeed, uint256 sizeSeed, bool isLong) external {
        address actor = _getActor(actorSeed);
        uint256 balance = vault.balances(actor);
        if (balance < 2_000 * U) return;

        uint256 size = bound(sizeSeed, S / 100, S); // 0.01 - 1 BTC

        int256 sizeDelta = isLong ? int256(size) : -int256(size);

        vm.prank(owner);
        try engine.openPosition(btcMarket, actor, sizeDelta, 50_000 * U) {
            ghost_totalTrades++;
        } catch {}
    }

    function openEthPosition(uint256 actorSeed, uint256 sizeSeed, bool isLong) external {
        address actor = _getActor(actorSeed);
        uint256 balance = vault.balances(actor);
        if (balance < 1_000 * U) return;

        uint256 size = bound(sizeSeed, S / 10, 10 * S); // 0.1 - 10 ETH

        int256 sizeDelta = isLong ? int256(size) : -int256(size);

        vm.prank(owner);
        try engine.openPosition(ethMarket, actor, sizeDelta, 3_000 * U) {
            ghost_totalTrades++;
        } catch {}
    }

    function closeBtcPosition(uint256 actorSeed) external {
        address actor = _getActor(actorSeed);
        (int256 size,,,,,) = engine.positions(btcMarket, actor);
        if (size == 0) return;

        vm.prank(owner);
        try engine.openPosition(btcMarket, actor, -size, 50_000 * U) {
            ghost_totalTrades++;
        } catch {}
    }

    function closeEthPosition(uint256 actorSeed) external {
        address actor = _getActor(actorSeed);
        (int256 size,,,,,) = engine.positions(ethMarket, actor);
        if (size == 0) return;

        vm.prank(owner);
        try engine.openPosition(ethMarket, actor, -size, 3_000 * U) {
            ghost_totalTrades++;
        } catch {}
    }

    function updateBtcPrice(uint256 priceSeed) external {
        uint256 price = bound(priceSeed, 25_000 * U, 80_000 * U);
        vm.prank(owner);
        engine.updateMarkPrice(btcMarket, price, price);
        ghost_priceUpdates++;
    }

    function updateEthPrice(uint256 priceSeed) external {
        uint256 price = bound(priceSeed, 1_500 * U, 6_000 * U);
        vm.prank(owner);
        engine.updateMarkPrice(ethMarket, price, price);
        ghost_priceUpdates++;
    }

    function tryLiquidate(uint256 actorSeed) external {
        address actor = _getActor(actorSeed);

        // Try BTC market
        (int256 btcSize,,,,,) = engine.positions(btcMarket, actor);
        if (btcSize != 0 && engine.isLiquidatable(btcMarket, actor)) {
            vm.prank(actors[0]); // any actor as keeper
            try liquidator.liquidate(btcMarket, actor) {
                ghost_totalLiquidations++;
            } catch {}
        }

        // Try ETH market
        (int256 ethSize,,,,,) = engine.positions(ethMarket, actor);
        if (ethSize != 0 && engine.isLiquidatable(ethMarket, actor)) {
            vm.prank(actors[0]);
            try liquidator.liquidate(ethMarket, actor) {
                ghost_totalLiquidations++;
            } catch {}
        }
    }

    function applyFunding() external {
        vm.startPrank(owner);
        try engine.applyFundingRate(btcMarket) {
            ghost_totalFundingEvents++;
        } catch {}
        try engine.applyFundingRate(ethMarket) {
            ghost_totalFundingEvents++;
        } catch {}
        vm.stopPrank();
    }

    function warpTime(uint256 timeSeed) external {
        uint256 delta = bound(timeSeed, 60, 28800); // 1 min to 8 hours
        vm.warp(block.timestamp + delta);

        // Refresh prices to prevent StalePrice errors
        vm.startPrank(owner);
        // Keep prices in current range to avoid breaking things
        engine.updateMarkPrice(btcMarket, 50_000 * U, 50_000 * U);
        engine.updateMarkPrice(ethMarket, 3_000 * U, 3_000 * U);
        vm.stopPrank();
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

    /// @notice Sum of all tracked account balances in vault
    function totalTrackedBalances() external view returns (uint256 total) {
        for (uint256 i = 0; i < actors.length; i++) {
            total += vault.balances(actors[i]);
        }
        total += vault.balances(address(engine));
        total += vault.balances(address(insurance));
        total += vault.balances(fundingPool);
    }

    /// @notice Net open interest across all actors for a market
    function netOpenInterest(bytes32 marketId) external view returns (int256 net) {
        for (uint256 i = 0; i < actors.length; i++) {
            (int256 size,,,,,) = engine.positions(marketId, actors[i]);
            net += size;
        }
    }
}
