// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/// @title TransferOwnership - Transfer all SUR Protocol ownership to Gnosis Safe + Timelock
/// @author SUR Protocol Team
/// @notice Transfers ownership from deployer EOA to SurTimelock (admin) and Gnosis Safe (timelock owner).
///
/// @dev Usage:
///   1. Set environment variables:
///        DEPLOYER_PRIVATE_KEY, SAFE_ADDRESS, TIMELOCK_ADDRESS
///        VAULT_ADDRESS, ENGINE_ADDRESS, SETTLEMENT_ADDRESS
///        LIQUIDATOR_ADDRESS, INSURANCE_ADDRESS, ORACLE_ADDRESS
///
///   2. Run:
///        forge script script/TransferOwnership.s.sol:TransferOwnership \
///          --rpc-url base_mainnet --broadcast --slow -vvvv
///
///   3. After this script:
///        - Safe must call acceptOwnership() on PerpVault via the Timelock
///        - All admin ops: Safe -> queue on Timelock -> wait 48h -> execute
///        - Guardian retains emergency pause (no delay)
///
///   All contracts now support 2-step ownership transfer (transferOwnership + acceptOwnership).

interface IOwnable {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

interface IOwnableTwoStep {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

interface ISurTimelock {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
    function delay() external view returns (uint256);
    function guardian() external view returns (address);
}

contract TransferOwnership is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address safe = vm.envAddress("SAFE_ADDRESS");
        address timelockAddr = vm.envAddress("TIMELOCK_ADDRESS");

        address vaultAddr = vm.envAddress("VAULT_ADDRESS");
        address engineAddr = vm.envAddress("ENGINE_ADDRESS");
        address settlementAddr = vm.envAddress("SETTLEMENT_ADDRESS");
        address liquidatorAddr = vm.envAddress("LIQUIDATOR_ADDRESS");
        address insuranceAddr = vm.envAddress("INSURANCE_ADDRESS");
        address oracleAddr = vm.envAddress("ORACLE_ADDRESS");

        console.log("==========================================================");
        console.log("  SUR Protocol - Transfer Ownership to Safe + Timelock");
        console.log("==========================================================");
        console.log("");
        console.log("Deployer (current owner): ", deployer);
        console.log("Gnosis Safe (new admin):  ", safe);
        console.log("SurTimelock:              ", timelockAddr);
        console.log("");

        require(safe != address(0), "SAFE_ADDRESS not set");
        require(timelockAddr != address(0), "TIMELOCK_ADDRESS not set");
        require(safe != deployer, "Safe must differ from deployer");
        require(block.chainid == 8453, "WRONG CHAIN: Must run on Base Mainnet (chain ID 8453)");

        // Verify current ownership
        console.log("Verifying current ownership...");
        _verifyOwner(vaultAddr, deployer, "PerpVault");
        _verifyOwner(liquidatorAddr, deployer, "Liquidator");
        _verifyOwner(insuranceAddr, deployer, "InsuranceFund");
        _verifyOwner(oracleAddr, deployer, "OracleRouter");
        _verifyOwner(timelockAddr, deployer, "SurTimelock");
        _verifyOwner(engineAddr, deployer, "PerpEngine");
        _verifyOwner(settlementAddr, deployer, "OrderSettlement");
        console.log("  All ownership checks passed");
        console.log("");

        // Verify Timelock config
        ISurTimelock timelock = ISurTimelock(timelockAddr);
        uint256 timelockDelay = timelock.delay();
        console.log("Timelock delay:   ", timelockDelay / 1 hours, "hours");
        console.log("Timelock guardian: ", timelock.guardian());
        require(timelockDelay >= 24 hours, "Timelock delay too short (min 24h)");
        console.log("");

        vm.startBroadcast(deployerKey);

        // 1. PerpVault -> Timelock (2-step)
        console.log("[1/8] PerpVault -> transferOwnership to Timelock (2-step)...");
        IOwnableTwoStep(vaultAddr).transferOwnership(timelockAddr);
        console.log("  pendingOwner set. Timelock must call acceptOwnership() via Safe.");

        // 2. PerpEngine -> Timelock (2-step)
        console.log("[2/8] PerpEngine -> transferOwnership to Timelock (2-step)...");
        IOwnableTwoStep(engineAddr).transferOwnership(timelockAddr);
        console.log("  pendingOwner set. Timelock must call acceptOwnership() via Safe.");

        // 3. OrderSettlement -> Timelock (2-step)
        console.log("[3/8] OrderSettlement -> transferOwnership to Timelock (2-step)...");
        IOwnableTwoStep(settlementAddr).transferOwnership(timelockAddr);
        console.log("  pendingOwner set. Timelock must call acceptOwnership() via Safe.");

        // 4. InsuranceFund -> Timelock (2-step, LOW fix)
        console.log("[4/8] InsuranceFund -> transferOwnership to Timelock (2-step)...");
        IOwnableTwoStep(insuranceAddr).transferOwnership(timelockAddr);
        console.log("  pendingOwner set. Timelock must call acceptOwnership() via Safe.");

        // 5. Liquidator -> Timelock (2-step, LOW fix)
        console.log("[5/8] Liquidator -> transferOwnership to Timelock (2-step)...");
        IOwnableTwoStep(liquidatorAddr).transferOwnership(timelockAddr);
        console.log("  pendingOwner set. Timelock must call acceptOwnership() via Safe.");

        // 6. OracleRouter -> Timelock (2-step, LOW fix)
        console.log("[6/8] OracleRouter -> transferOwnership to Timelock (2-step)...");
        IOwnableTwoStep(oracleAddr).transferOwnership(timelockAddr);
        console.log("  pendingOwner set. Timelock must call acceptOwnership() via Safe.");

        // 7. SurTimelock -> Gnosis Safe
        console.log("[7/8] SurTimelock -> transferOwnership to Gnosis Safe...");
        ISurTimelock(timelockAddr).transferOwnership(safe);
        console.log("  Done. Timelock now owned by Safe.");

        // 8. Summary of 2-step transfers
        console.log("[8/8] Six 2-step transfers pending acceptOwnership():");
        console.log("  - PerpVault, PerpEngine, OrderSettlement, InsuranceFund, Liquidator, OracleRouter");

        vm.stopBroadcast();

        // Post-transfer verification — all contracts now use 2-step ownership
        console.log("");
        console.log("=== Post-Transfer Verification ===");
        _verifyOwner(timelockAddr, safe, "SurTimelock");

        // All 6 contracts have pendingOwner = Timelock (2-step)
        address[6] memory contracts = [vaultAddr, engineAddr, settlementAddr, insuranceAddr, liquidatorAddr, oracleAddr];
        string[6] memory names = ["PerpVault", "PerpEngine", "OrderSettlement", "InsuranceFund", "Liquidator", "OracleRouter"];
        for (uint256 i = 0; i < 6; i++) {
            address pending = IOwnableTwoStep(contracts[i]).pendingOwner();
            require(pending == timelockAddr, string(abi.encodePacked(names[i], " pendingOwner mismatch")));
            console.log("  ", names[i], ": pendingOwner = Timelock (awaiting acceptOwnership)");
        }

        console.log("");
        console.log("==========================================================");
        console.log("  OWNERSHIP TRANSFER COMPLETE");
        console.log("==========================================================");
        console.log("  Chain: Gnosis Safe -> SurTimelock (48h) -> Contracts");
        console.log("  Guardian -> emergency pause (no delay)");
        console.log("");
        console.log("REMAINING:");
        console.log("  1. Safe must queue+execute acceptOwnership() on ALL 6 contracts");
        console.log("  2. Test emergency pause via guardian");
        console.log("  3. Test timelocked admin op end-to-end");
        console.log("  4. Secure or destroy deployer private key");
    }

    function _verifyOwner(address target, address expected, string memory name) internal view {
        address actual = IOwnable(target).owner();
        require(actual == expected, string(abi.encodePacked(name, ": owner mismatch")));
        console.log("  ", name, "owner:", actual);
    }
}
