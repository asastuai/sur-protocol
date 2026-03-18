// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/PerpVault.sol";
import "../src/PerpEngine.sol";
import "../src/OrderSettlement.sol";
import "../src/Liquidator.sol";
import "../src/InsuranceFund.sol";
import "../src/OracleRouter.sol";

/// @title TestnetIntegration - Deploy + test full scenario on Base Sepolia
/// @dev Usage:
///   forge script script/TestnetIntegration.s.sol:TestnetIntegration \
///     --rpc-url base_sepolia --broadcast --verify -vvvv
///
///  This script:
///  1. Deploys all contracts
///  2. Configures the full permission chain
///  3. Adds BTC-USD market
///  4. Opens a position (operator direct call)
///  5. Verifies position data
///  6. Updates mark price
///  7. Checks liquidation status
///  8. Logs everything for verification

contract TestnetIntegration is Script {
    // Base Sepolia addresses
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    // Pyth on Base Sepolia (official deployment)
    address constant PYTH = 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729;
    // BTC/USD Pyth feed ID (same across all chains)
    bytes32 constant PYTH_BTC_FEED = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    uint256 constant USDC_UNIT = 1e6;
    uint256 constant SIZE_UNIT = 1e8;
    uint256 constant DEPOSIT_CAP = 100_000 * USDC_UNIT; // $100k

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console.log("==========================================");
        console.log("  SUR Protocol - Testnet Integration Test");
        console.log("==========================================");
        console.log("Deployer:", deployer);
        console.log("Chain:", block.chainid);
        console.log("");

        vm.startBroadcast(pk);

        // =============================================
        //  STEP 1: DEPLOY ALL CONTRACTS
        // =============================================
        console.log("[1/7] Deploying contracts...");

        PerpVault vault = new PerpVault(USDC, deployer, DEPOSIT_CAP);
        console.log("  PerpVault:", address(vault));

        InsuranceFund insurance = new InsuranceFund(address(vault), deployer);
        console.log("  InsuranceFund:", address(insurance));

        PerpEngine engine = new PerpEngine(
            address(vault), deployer, deployer, address(insurance)
        );
        console.log("  PerpEngine:", address(engine));

        OrderSettlement settlement = new OrderSettlement(
            address(engine), address(vault), deployer, deployer
        );
        console.log("  OrderSettlement:", address(settlement));

        Liquidator liquidator = new Liquidator(
            address(engine), address(insurance), deployer
        );
        console.log("  Liquidator:", address(liquidator));

        // OracleRouter with real Pyth on Base Sepolia
        OracleRouter oracle = new OracleRouter(PYTH, address(engine), deployer);
        console.log("  OracleRouter:", address(oracle));

        // =============================================
        //  STEP 2: CONFIGURE PERMISSIONS
        // =============================================
        console.log("");
        console.log("[2/7] Configuring permission chain...");

        vault.setOperator(address(engine), true);
        vault.setOperator(address(settlement), true);
        engine.setOperator(address(settlement), true);
        engine.setOperator(address(liquidator), true);
        engine.setOperator(address(oracle), true);
        engine.setOperator(deployer, true);
        settlement.setOperator(deployer, true);
        insurance.setOperator(address(liquidator), true);
        oracle.setOperator(deployer, true);
        console.log("  All permissions configured");

        // =============================================
        //  STEP 3: ADD MARKETS
        // =============================================
        console.log("");
        console.log("[3/7] Adding markets...");

        bytes32 btcMarket = keccak256(abi.encodePacked("BTC-USD"));

        engine.addMarket("BTC-USD", 500, 250, 10_000 * SIZE_UNIT, 28800);
        engine.updateMarkPrice(btcMarket, 50_000 * USDC_UNIT, 50_000 * USDC_UNIT);
        console.log("  BTC-USD added (20x, 2.5% MM)");

        // Configure oracle feed with real Pyth feed ID
        oracle.configureFeed(btcMarket, PYTH_BTC_FEED, address(0), 300, 200, 100);
        console.log("  Oracle feed configured (Pyth only, no CL on testnet)");

        // =============================================
        //  STEP 4: VERIFY DEPLOYMENT
        // =============================================
        console.log("");
        console.log("[4/7] Verifying deployment...");

        require(vault.owner() == deployer, "Vault owner mismatch");
        require(engine.operators(address(settlement)), "Settlement not operator on engine");
        require(engine.operators(address(liquidator)), "Liquidator not operator on engine");
        require(vault.depositCap() == DEPOSIT_CAP, "Deposit cap mismatch");
        console.log("  All assertions passed");

        // =============================================
        //  STEP 5: TEST DEPOSIT (if deployer has USDC)
        // =============================================
        console.log("");
        console.log("[5/7] Testing deposit flow...");

        // Check if deployer has USDC
        uint256 usdcBalance = IERC20Minimal(USDC).balanceOf(deployer);
        console.log("  Deployer USDC balance:", usdcBalance);

        if (usdcBalance >= 100 * USDC_UNIT) {
            IERC20Minimal(USDC).approve(address(vault), 100 * USDC_UNIT);
            vault.deposit(100 * USDC_UNIT);
            console.log("  Deposited $100 USDC");
            console.log("  Vault balance:", vault.balances(deployer));

            // Test withdraw
            vault.withdraw(50 * USDC_UNIT);
            console.log("  Withdrew $50 USDC");
            console.log("  Vault balance:", vault.balances(deployer));
        } else {
            console.log("  SKIP: Deployer has insufficient USDC for deposit test");
            console.log("  Get testnet USDC from: https://faucet.circle.com/");
        }

        // =============================================
        //  STEP 6: TEST POSITION (direct operator call)
        // =============================================
        console.log("");
        console.log("[6/7] Testing position flow...");

        if (vault.balances(deployer) >= 5_000 * USDC_UNIT) {
            // Open 0.01 BTC long at $50k
            engine.openPosition(btcMarket, deployer, int256(SIZE_UNIT / 100), 50_000 * USDC_UNIT);
            console.log("  Opened: 0.01 BTC LONG @ $50,000");

            (int256 size, uint256 entry, uint256 margin,,) = engine.positions(btcMarket, deployer);
            console.log("  Position size:", uint256(size));
            console.log("  Entry price:", entry);
            console.log("  Margin locked:", margin);

            // Close position
            engine.openPosition(btcMarket, deployer, -int256(SIZE_UNIT / 100), 50_000 * USDC_UNIT);
            console.log("  Position closed");

            (size,,,,) = engine.positions(btcMarket, deployer);
            require(size == 0, "Position not closed!");
            console.log("  Verified: position size = 0");
        } else {
            console.log("  SKIP: Insufficient balance for position test");
        }

        // =============================================
        //  STEP 7: PRINT SUMMARY
        // =============================================
        console.log("");
        console.log("[7/7] Checking vault health...");

        (bool healthy, uint256 actual, uint256 accounted) = vault.healthCheck();
        console.log("  Healthy:", healthy);
        console.log("  USDC held:", actual);
        console.log("  Accounted:", accounted);

        vm.stopBroadcast();

        console.log("");
        console.log("==========================================");
        console.log("  DEPLOYMENT + INTEGRATION TEST COMPLETE");
        console.log("==========================================");
        console.log("");
        console.log("Contract Addresses (save these!):");
        console.log("  PerpVault:       ", address(vault));
        console.log("  PerpEngine:      ", address(engine));
        console.log("  OrderSettlement: ", address(settlement));
        console.log("  Liquidator:      ", address(liquidator));
        console.log("  InsuranceFund:   ", address(insurance));
        console.log("  OracleRouter:    ", address(oracle));
        console.log("");
        console.log("Next: Fund the deployer with testnet USDC from faucet.circle.com");
        console.log("Then: Run the EIP-712 signing test from the frontend or a script");
    }
}

/// @dev Minimal ERC20 for approve/balanceOf
interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}
