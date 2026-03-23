// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {SurTimelock} from "../src/SurTimelock.sol";

/// @title Deploy SUR Timelock & Transfer Ownership
/// @notice Deploys the Timelock, registers all pausable targets,
///         then transfers ownership of all protocol contracts to the Timelock.
///
/// @dev Usage:
///   1. Set env vars (PRIVATE_KEY, MULTISIG_ADDRESS, GUARDIAN_ADDRESS)
///   2. Run: forge script script/DeployTimelock.s.sol --rpc-url $RPC_URL --broadcast
///
///   After deployment:
///   - All protocol contracts owned by Timelock
///   - Timelock owned by Multisig
///   - Guardian can emergency-pause any contract
///   - All admin changes require 48h delay

contract DeployTimelock is Script {
    // ============================================================
    //  DEPLOYED CONTRACT ADDRESSES (Base Sepolia)
    //  Update these before running on mainnet!
    // ============================================================

    address constant VAULT       = 0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81;
    address constant ENGINE      = 0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6;
    address constant SETTLEMENT  = 0x7297429477254843cB00A6e17C5B1f83B3AE2Eec;
    address constant LIQUIDATOR  = 0xE748C66Ec162F7C0E56258415632A46b69b48eB1;
    address constant ORACLE      = 0xb1A0aC35bcAABd9FFD19b4006a43873663901882;

    // Delay: 48 hours for testnet, consider 72h+ for mainnet
    uint256 constant TIMELOCK_DELAY = 48 hours;

    function run() external {
        // Read from environment
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address multisig = vm.envAddress("MULTISIG_ADDRESS");
        address guardian = vm.envAddress("GUARDIAN_ADDRESS");

        vm.startBroadcast(deployerKey);

        // 1. Deploy Timelock
        SurTimelock timelock = new SurTimelock(
            multisig,   // owner = Gnosis Safe
            guardian,    // guardian = hot wallet for emergency pause
            TIMELOCK_DELAY
        );

        console.log("SurTimelock deployed at:", address(timelock));
        console.log("  Owner (multisig):", multisig);
        console.log("  Guardian:", guardian);
        console.log("  Delay:", TIMELOCK_DELAY / 1 hours, "hours");

        // 2. Register all protocol contracts as pausable targets
        address[] memory targets = new address[](5);
        targets[0] = VAULT;
        targets[1] = ENGINE;
        targets[2] = SETTLEMENT;
        targets[3] = LIQUIDATOR;
        targets[4] = ORACLE;

        timelock.batchSetPausableTargets(targets);
        console.log("Registered 5 pausable targets");

        // 3. Transfer ownership of each contract to the Timelock
        //    NOTE: PerpVault uses 2-step ownership. After this script,
        //    the Timelock multisig must call acceptOwnership() on PerpVault
        //    via the Timelock's executeTransaction.

        // For contracts with single-step transferOwnership:
        // (Uncomment when ready - each contract needs transferOwnership called)
        //
        // IPerpEngine(ENGINE).transferOwnership(address(timelock));
        // IOrderSettlement(SETTLEMENT).transferOwnership(address(timelock));
        // IOracleRouter(ORACLE).transferOwnership(address(timelock));
        // ILiquidator(LIQUIDATOR).transferOwnership(address(timelock));
        //
        // For PerpVault (2-step):
        // IPerpVault(VAULT).transferOwnership(address(timelock));
        // Then Timelock must call: VAULT.acceptOwnership()

        console.log("");
        console.log("=== NEXT STEPS ===");
        console.log("1. Transfer ownership of each contract to:", address(timelock));
        console.log("2. For PerpVault: call transferOwnership, then Timelock calls acceptOwnership");
        console.log("3. Verify all contracts show Timelock as owner");
        console.log("4. Test: queue + execute a setDepositCap through Timelock");
        console.log("5. Test: guardian emergency pause");

        vm.stopBroadcast();
    }
}
