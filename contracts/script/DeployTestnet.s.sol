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

/// @title DeployTestnet - SUR Protocol deployment to Base Sepolia
/// @author SUR Protocol Team
/// @notice Identical to mainnet deploy but for Base Sepolia (chain ID 84532).
///         Uses testnet USDC and Pyth addresses. Lower caps for testing.
///
/// @dev Usage:
///   1. Set environment variables:
///        DEPLOYER_PRIVATE_KEY  - deployer EOA private key
///        GUARDIAN_ADDRESS      - hot wallet for emergency pause
///        FEE_RECIPIENT         - treasury address for protocol fees
///
///   2. Deploy:
///        forge script script/DeployTestnet.s.sol:DeployTestnet \
///          --rpc-url base_sepolia --broadcast --verify --slow -vvvv
///
///   3. After deployment:
///        - Fund deployer with Sepolia ETH (faucet)
///        - Mint test USDC or use faucet
///        - Start oracle + liquidation keepers pointing to testnet contracts

contract DeployTestnet is Script {
    // ============================================================
    //                  BASE SEPOLIA DEFAULTS
    // ============================================================

    // Base Sepolia USDC (Circle testnet faucet)
    address constant DEFAULT_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    // Pyth on Base Sepolia
    address constant DEFAULT_PYTH = 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729;
    // Testnet: small cap for safety
    uint256 constant DEFAULT_VAULT_CAP = 100_000 * 1e6; // $100K

    // ============================================================
    //                    PYTH FEED IDS
    // ============================================================

    // Same feed IDs work on testnet and mainnet
    bytes32 constant PYTH_BTC_USD = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant PYTH_ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;

    // ============================================================
    //                    CONSTANTS
    // ============================================================

    uint256 constant SIZE_PRECISION = 1e8;
    uint256 constant USDC_UNIT = 1e6;
    uint256 constant TIMELOCK_DELAY = 24 hours; // Shorter for testnet iteration

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
        console.log("  SUR Protocol - Base Sepolia Testnet Deployment");
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

        require(block.chainid == 84532, "WRONG CHAIN: Must deploy to Base Sepolia (chain ID 84532)");
        require(guardian != address(0), "GUARDIAN_ADDRESS not set");
        require(feeRecipient != address(0), "FEE_RECIPIENT not set");

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
        // On testnet, use feeRecipient as funding pool for simplicity (can be changed via setFundingPool)
        address fundingPool = vm.envOr("FUNDING_POOL", feeRecipient);
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

        // STEP 7: SurTimelock (24h for testnet)
        console.log("[7/9] Deploying SurTimelock (24h delay for testnet)...");
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

        // Circuit breaker: 15% threshold, 5m window, 5m cooldown
        engine.setCircuitBreakerParams(300, 1500, 300);
        console.log("  Circuit breaker: 15% threshold, 5m window, 5m cooldown");

        // Reserve factor: 80% of pool TVL
        engine.setReserveFactor(8000);
        console.log("  Reserve factor: 80% of pool TVL");

        // Price impact: 0.5% quadratic
        bytes32 btcMarket = keccak256(abi.encodePacked("BTC-USD"));
        bytes32 ethMarket = keccak256(abi.encodePacked("ETH-USD"));
        engine.setPriceImpactConfig(btcMarket, 50, 20000);
        engine.setPriceImpactConfig(ethMarket, 50, 20000);
        console.log("  Price impact: 0.5% quadratic on BTC-USD and ETH-USD");

        vm.stopBroadcast();

        // DEPLOYMENT SUMMARY
        console.log("");
        console.log("==========================================================");
        console.log("  DEPLOYMENT COMPLETE - Base Sepolia Testnet");
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
        console.log("  1. Verify contracts on Sepolia Basescan");
        console.log("  2. Get testnet USDC from faucet");
        console.log("  3. Fund OracleRouter with Sepolia ETH");
        console.log("  4. Point keepers to testnet contract addresses");
        console.log("  5. Test full flow: deposit -> trade -> liquidation -> withdraw");
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
            address(0),     // no Chainlink on testnet
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
            address(0),     // no Chainlink on testnet
            120,            // 2m max staleness
            200,            // 2% max deviation
            100             // 1% max confidence
        );
        console.log("  ETH-USD oracle feed configured");
    }
}
