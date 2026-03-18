// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/// @title DeployCollateral - Deploy CollateralManager and register yield-bearing collateral
/// @dev Run after initial deployment (PerpVault must exist)
///
/// Usage:
///   forge script script/DeployCollateral.s.sol:DeployCollateral \
///     --rpc-url base_sepolia --broadcast -vvvv

interface IPerpVault {
    function setOperator(address operator, bool status) external;
}

interface ICollateralManager {
    function addCollateral(
        address token,
        string calldata symbol,
        uint8 decimals,
        uint256 haircutBps,
        uint256 initialPrice,
        uint256 maxPriceAge,
        uint256 depositCap
    ) external;
}

contract DeployCollateral is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address vault = vm.envAddress("VAULT_ADDRESS");

        vm.startBroadcast(deployerKey);

        // Deploy CollateralManager
        // Note: In production, replace with actual CREATE2 deployment
        // For now, we just log the deployment steps needed
        console.log("=== CollateralManager Deployment ===");
        console.log("Vault address:", vault);
        console.log("");
        console.log("After deploying CollateralManager:");
        console.log("1. Set CollateralManager as operator on PerpVault");
        console.log("2. Set OracleKeeper as operator on CollateralManager");
        console.log("3. Add collateral types via addCollateral()");
        console.log("");

        // Base Mainnet collateral addresses
        // cbETH: 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22
        // wstETH: 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452
        // sUSDe: 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2

        console.log("Collateral types to register:");
        console.log("  cbETH  - 95% haircut - Coinbase Staked ETH");
        console.log("  wstETH - 95% haircut - Lido Staked ETH");
        console.log("  sUSDe  - 90% haircut - Ethena Staked USDe");

        vm.stopBroadcast();
    }
}
