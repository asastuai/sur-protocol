// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/// @title AcceptOwnership - Accept pending ownership on all SUR contracts via Timelock
/// @notice After TransferOwnership.s.sol sets pendingOwner, this script generates the
///         calldata for the Gnosis Safe to queue+execute acceptOwnership() through the Timelock.
///
/// @dev Usage:
///   1. Set environment variables with deployed contract addresses
///   2. Run to generate calldata:
///        forge script script/AcceptOwnership.s.sol:AcceptOwnership --rpc-url base_mainnet -vvvv
///   3. Use the output calldata in Gnosis Safe to queue transactions on the Timelock

interface IAcceptOwnership {
    function acceptOwnership() external;
}

interface ISurTimelock {
    function queueTransaction(address target, uint256 value, bytes calldata data) external returns (bytes32);
    function delay() external view returns (uint256);
}

contract AcceptOwnership is Script {
    function run() external view {
        address timelockAddr = vm.envAddress("TIMELOCK_ADDRESS");
        address vaultAddr = vm.envAddress("VAULT_ADDRESS");
        address engineAddr = vm.envAddress("ENGINE_ADDRESS");
        address settlementAddr = vm.envAddress("SETTLEMENT_ADDRESS");
        address insuranceAddr = vm.envAddress("INSURANCE_ADDRESS");
        address liquidatorAddr = vm.envAddress("LIQUIDATOR_ADDRESS");
        address oracleAddr = vm.envAddress("ORACLE_ADDRESS");

        bytes memory acceptCalldata = abi.encodeWithSelector(IAcceptOwnership.acceptOwnership.selector);

        console.log("==========================================================");
        console.log("  SUR Protocol - Accept Ownership Calldata Generator");
        console.log("==========================================================");
        console.log("");
        console.log("Timelock:", timelockAddr);
        console.log("Delay:", ISurTimelock(timelockAddr).delay() / 1 hours, "hours");
        console.log("");
        console.log("Queue these 6 transactions on the Timelock via Gnosis Safe:");
        console.log("  Each: target.call(acceptOwnership()) with value=0");
        console.log("");
        console.log("Targets:");
        console.log("  1. PerpVault:       ", vaultAddr);
        console.log("  2. PerpEngine:      ", engineAddr);
        console.log("  3. OrderSettlement: ", settlementAddr);
        console.log("  4. InsuranceFund:   ", insuranceAddr);
        console.log("  5. Liquidator:      ", liquidatorAddr);
        console.log("  6. OracleRouter:    ", oracleAddr);
        console.log("");
        console.log("Calldata (same for all 6):");
        console.log("  0x79ba5097");
        console.log("");
        console.log("Encoded queueTransaction calldata for each:");

        address[6] memory targets = [vaultAddr, engineAddr, settlementAddr, insuranceAddr, liquidatorAddr, oracleAddr];
        string[6] memory names = ["PerpVault", "PerpEngine", "OrderSettlement", "InsuranceFund", "Liquidator", "OracleRouter"];

        for (uint256 i = 0; i < 6; i++) {
            bytes memory queueCalldata = abi.encodeWithSelector(
                ISurTimelock.queueTransaction.selector,
                targets[i],
                0,
                acceptCalldata
            );
            console.log("");
            console.log(names[i], ":");
            console.logBytes(queueCalldata);
        }
    }
}
