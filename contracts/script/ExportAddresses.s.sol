// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/// @title ExportAddresses - Generate deployment addresses JSON for frontend integration
/// @dev Usage:
///   forge script script/ExportAddresses.s.sol:ExportAddresses -vvvv
///   Output: deployments/{chainId}.json

contract ExportAddresses is Script {
    function run() external {
        address vaultAddr = vm.envAddress("VAULT_ADDRESS");
        address engineAddr = vm.envAddress("ENGINE_ADDRESS");
        address settlementAddr = vm.envAddress("SETTLEMENT_ADDRESS");
        address liquidatorAddr = vm.envAddress("LIQUIDATOR_ADDRESS");
        address insuranceAddr = vm.envAddress("INSURANCE_ADDRESS");
        address oracleAddr = vm.envAddress("ORACLE_ADDRESS");
        address timelockAddr = vm.envAddress("TIMELOCK_ADDRESS");

        string memory json = string(abi.encodePacked(
            '{\n',
            '  "chainId": ', vm.toString(block.chainid), ',\n',
            '  "contracts": {\n',
            '    "PerpVault": "', vm.toString(vaultAddr), '",\n',
            '    "PerpEngine": "', vm.toString(engineAddr), '",\n',
            '    "OrderSettlement": "', vm.toString(settlementAddr), '",\n',
            '    "Liquidator": "', vm.toString(liquidatorAddr), '",\n',
            '    "InsuranceFund": "', vm.toString(insuranceAddr), '",\n',
            '    "OracleRouter": "', vm.toString(oracleAddr), '",\n',
            '    "SurTimelock": "', vm.toString(timelockAddr), '"\n',
            '  },\n'
        ));

        json = string(abi.encodePacked(
            json,
            '  "markets": {\n',
            '    "BTC-USD": "', vm.toString(keccak256(abi.encodePacked("BTC-USD"))), '",\n',
            '    "ETH-USD": "', vm.toString(keccak256(abi.encodePacked("ETH-USD"))), '"\n',
            '  }\n',
            '}'
        ));

        string memory filename = string(abi.encodePacked("deployments/", vm.toString(block.chainid), ".json"));
        vm.writeFile(filename, json);

        console.log("Exported deployment addresses to:", filename);
    }
}
