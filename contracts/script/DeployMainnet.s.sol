// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/PerpVault.sol";
import "../src/PerpEngine.sol";
import "../src/OrderSettlement.sol";
import "../src/Liquidator.sol";
import "../src/InsuranceFund.sol";
import "../src/OracleRouter.sol";
import "../src/SurTimelock.sol";

/// @title DeployMainnet - Full SUR Protocol deployment to Base Mainnet
/// @author SUR Protocol Team
/// @notice Deploys all core contracts, configures permissions, markets, and oracles.
///
/// @dev Usage:
///   1. Set environment variables:
///        DEPLOYER_PRIVATE_KEY  - deployer EOA private key
///        GUARDIAN_ADDRESS      - hot wallet for emergency pause
///        FEE_RECIPIENT         - treasury address for protocol fees
///        USDC_ADDRESS          - Base mainnet USDC (default: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
///        PYTH_ADDRESS          - Base mainnet Pyth (default: 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a)
///        VAULT_CAP             - initial deposit cap in USDC units (e.g., 5000000000000 = $5M)
///
///   2. Deploy:
///        forge script script/DeployMainnet.s.sol:DeployMainnet \
///          --rpc-url base_mainnet --broadcast --verify --slow -vvvv
///
///   3. After deployment:
///        - Run TransferOwnership.s.sol to move ownership to Safe + Timelock
///        - Fund OracleRouter with ETH for Pyth update fees
///        - Set up keeper bots for oracle updates and liquidations
///
///   IMPORTANT: Verify all addresses and parameters before broadcasting.

contract DeployMainnet is Script {
    // ============================================================
    //                    BASE MAINNET DEFAULTS
    // ============================================================

    address constant DEFAULT_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant DEFAULT_PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    uint256 constant DEFAULT_VAULT_CAP = 5_000_000 * 1e6; // $5M

    // ============================================================
    //                    PYTH FEED IDS
    // ============================================================

    bytes32 constant PYTH_BTC_USD = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant PYTH_ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;

    // ============================================================
    //                    CONSTANTS
    // ============================================================

    uint256 constant SIZE_PRECISION = 1e8;
    uint256 constant USDC_UNIT = 1e6;
    uint256 constant TIMELOCK_DELAY = 48 hours;

    // ============================================================
    //                    DEPLOYMENT
    // ============================================================

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address guardian = vm.envAddress("GUARDIAN_ADDRESS");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        address usdcAddress = vm.envOr("USDC_ADDRESS", DEFAULT_USDC);
        address pythAddress = vm.envOr("PYTH_ADDRESS", DEFAULT_PYTH);
        uint256 vaultCap = vm.envOr("VAULT_CAP", DEFAULT_VAULT_CAP);

        console.log("==========================================================");
        console.log("  SUR Protocol - Base Mainnet Deployment");
        console.log("==========================================================");
        console.log("");
        console.log("Deployer:       ", deployer);
        console.log("Guardian:       ", guardian);
        console.log("Fee Recipient:  ", feeRecipient);
        console.log("USDC:           ", usdcAddress);
        console.log("Pyth:           ", pythAddress);
        console.log("Vault Cap:      ", vaultCap);
        console.log("Chain ID:       ", block.chainid);
        console.log("");

        require(block.chainid == 8453, "WRONG CHAIN: Must deploy to Base Mainnet (chain ID 8453)");
        require(guardian != address(0), "GUARDIAN_ADDRESS not set");
        require(feeRecipient != address(0), "FEE_RECIPIENT not set");
        require(guardian != deployer, "Guardian must differ from deployer");

        vm.startBroadcast(deployerKey);

        // STEP 1: PerpVault
        console.log("[1/9] Deploying PerpVault...");
        PerpVault vault = new PerpVault(usdcAddress, deployer, vaultCap);
        console.log("  PerpVault:", address(vault));

        // STEP 2: InsuranceFund
        console.log("[2/9] Deploying InsuranceFund...");
        InsuranceFund insurance = new InsuranceFund(address(vault), deployer);
        console.log("  InsuranceFund:", address(insurance));

        // STEP 3: PerpEngine (C-2 fix: fundingPool separate from feeRecipient)
        address fundingPool = vm.envAddress("FUNDING_POOL");
        require(fundingPool != address(0), "FUNDING_POOL not set");
        require(fundingPool != feeRecipient, "FUNDING_POOL must differ from FEE_RECIPIENT");
        console.log("[3/9] Deploying PerpEngine...");
        PerpEngine engine = new PerpEngine(address(vault), deployer, feeRecipient, address(insurance), fundingPool);
        console.log("  PerpEngine:", address(engine));
        console.log("  Funding Pool:", fundingPool);

        // STEP 4: OrderSettlement
        console.log("[4/9] Deploying OrderSettlement...");
        OrderSettlement settlement = new OrderSettlement(address(engine), address(vault), feeRecipient, deployer);
        console.log("  OrderSettlement:", address(settlement));

        // STEP 5: Liquidator
        console.log("[5/9] Deploying Liquidator...");
        Liquidator liquidator = new Liquidator(address(engine), address(insurance), deployer);
        console.log("  Liquidator:", address(liquidator));

        // STEP 6: OracleRouter
        console.log("[6/9] Deploying OracleRouter...");
        OracleRouter oracle = new OracleRouter(pythAddress, address(engine), deployer);
        console.log("  OracleRouter:", address(oracle));

        // STEP 7: SurTimelock (48h delay)
        console.log("[7/9] Deploying SurTimelock (48h delay)...");
        SurTimelock timelock = new SurTimelock(deployer, guardian, TIMELOCK_DELAY);
        console.log("  SurTimelock:", address(timelock));

        address[] memory targets = new address[](6);
        targets[0] = address(vault);
        targets[1] = address(engine);
        targets[2] = address(settlement);
        targets[3] = address(liquidator);
        targets[4] = address(oracle);
        targets[5] = address(insurance);
        timelock.batchSetPausableTargets(targets);
        timelock.completeSetup(); // H-16 fix: lock batchSetPausableTargets
        console.log("  Registered 6 pausable targets on Timelock (setup locked)");

        // STEP 8: Configure Permissions
        console.log("[8/9] Configuring operator permissions...");

        vault.setOperator(address(engine), true);
        vault.setOperator(address(settlement), true);
        console.log("  Vault: engine + settlement as operators");

        engine.setOperator(address(settlement), true);
        engine.setOperator(address(liquidator), true);
        engine.setOperator(address(oracle), true);
        console.log("  Engine: settlement + liquidator + oracle as operators");

        insurance.setOperator(address(liquidator), true);
        console.log("  InsuranceFund: liquidator as operator");

        // STEP 9: Configure Markets & Oracles
        console.log("[9/9] Configuring markets and oracle feeds...");

        _configureBtcUsd(engine, oracle);
        _configureEthUsd(engine, oracle);

        // Conservative circuit breaker: 15% threshold, 5m window, 5m cooldown
        engine.setCircuitBreakerParams(300, 1500, 300);
        console.log("  PerpEngine circuit breaker: 15% threshold, 5m window, 5m cooldown");

        // Reserve factor: OI notional capped at 80% of pool TVL (GMX-inspired)
        engine.setReserveFactor(8000);
        console.log("  Reserve factor: 80% of pool TVL");

        // Price impact: quadratic penalty for trades worsening OI skew (GMX-inspired)
        bytes32 btcMarket = keccak256(abi.encodePacked("BTC-USD"));
        bytes32 ethMarket = keccak256(abi.encodePacked("ETH-USD"));
        engine.setPriceImpactConfig(btcMarket, 50, 20000);  // 0.5% factor, quadratic
        engine.setPriceImpactConfig(ethMarket, 50, 20000);   // 0.5% factor, quadratic
        console.log("  Price impact: 0.5% quadratic factor on BTC-USD and ETH-USD");

        vm.stopBroadcast();

        // DEPLOYMENT SUMMARY
        console.log("");
        console.log("==========================================================");
        console.log("  DEPLOYMENT COMPLETE - Base Mainnet");
        console.log("==========================================================");
        console.log("");
        console.log("  PerpVault:        ", address(vault));
        console.log("  PerpEngine:       ", address(engine));
        console.log("  OrderSettlement:  ", address(settlement));
        console.log("  Liquidator:       ", address(liquidator));
        console.log("  InsuranceFund:    ", address(insurance));
        console.log("  OracleRouter:     ", address(oracle));
        console.log("  SurTimelock:      ", address(timelock));
        console.log("");
        console.log("NEXT STEPS:");
        console.log("  1. Verify all contracts on Basescan");
        console.log("  2. Run TransferOwnership.s.sol");
        console.log("  3. Fund OracleRouter with ETH for Pyth fees");
        console.log("  4. Start oracle + liquidation keepers");
        console.log("  5. Test deposit/withdraw with small amount");
        console.log("  6. DO NOT open trading until oracle feeds confirmed live");
    }

    function _configureBtcUsd(PerpEngine engine, OracleRouter oracle) internal {
        engine.addMarket(
            "BTC-USD",
            500,                        // 5% initial margin = 20x
            250,                        // 2.5% maintenance margin
            100 * SIZE_PRECISION,       // max 100 BTC
            28800                       // 8h funding interval
        );
        console.log("  BTC-USD market added (20x leverage, 2.5% MM)");

        bytes32 btcMarket = keccak256(abi.encodePacked("BTC-USD"));
        oracle.configureFeed(
            btcMarket,
            PYTH_BTC_USD,
            address(0),     // no Chainlink fallback initially
            120,            // 2m max staleness
            200,            // 2% max deviation
            100             // 1% max confidence
        );
        console.log("  BTC-USD oracle feed configured");
    }

    function _configureEthUsd(PerpEngine engine, OracleRouter oracle) internal {
        engine.addMarket(
            "ETH-USD",
            500,                        // 5% initial margin = 20x
            250,                        // 2.5% maintenance margin
            2_000 * SIZE_PRECISION,     // max 2000 ETH
            28800                       // 8h funding interval
        );
        console.log("  ETH-USD market added (20x leverage, 2.5% MM)");

        bytes32 ethMarket = keccak256(abi.encodePacked("ETH-USD"));
        oracle.configureFeed(
            ethMarket,
            PYTH_ETH_USD,
            address(0),     // no Chainlink fallback initially
            120,            // 2m max staleness
            200,            // 2% max deviation
            100             // 1% max confidence
        );
        console.log("  ETH-USD oracle feed configured");
    }
}
