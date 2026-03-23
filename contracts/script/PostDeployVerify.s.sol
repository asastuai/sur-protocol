// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/// @title PostDeployVerify - Verify all deployment invariants after deploy
/// @dev Usage:
///   Set all contract addresses as env vars, then:
///   forge script script/PostDeployVerify.s.sol:PostDeployVerify --rpc-url base_sepolia -vvvv

interface IOwnable {
    function owner() external view returns (address);
}

interface IPerpVault {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function paused() external view returns (bool);
    function depositCap() external view returns (uint256);
    function operators(address) external view returns (bool);
    function healthCheck() external view returns (bool healthy, uint256 actual, uint256 accounted);
}

interface IPerpEngine {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function paused() external view returns (bool);
    function operators(address) external view returns (bool);
    function vault() external view returns (address);
    function feeRecipient() external view returns (address);
    function insuranceFund() external view returns (address);
    function circuitBreakerActive() external view returns (bool);
    function circuitBreakerWindowSecs() external view returns (uint256);
    function circuitBreakerThresholdBps() external view returns (uint256);
    function circuitBreakerCooldownSecs() external view returns (uint256);
    function reserveFactorBps() external view returns (uint256);
    function getOpenInterest(bytes32 marketId) external view returns (uint256 oiLong, uint256 oiShort);
    function markets(bytes32 marketId) external view returns (
        bytes32, string memory, bool, uint256, uint256, uint256,
        uint256, uint256, uint256, int256, uint256, uint256, uint256, uint256
    );
}

interface IOrderSettlement {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function paused() external view returns (bool);
}

interface ILiquidator {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function paused() external view returns (bool);
    function engine() external view returns (address);
    function insuranceFund() external view returns (address);
}

interface IOracleRouter {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function oracleCircuitBreakerActive() external view returns (bool);
    function isOracleHealthy() external view returns (bool);
    function isPriceFresh(bytes32 marketId) external view returns (bool);
}

interface IInsuranceFund {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function operators(address) external view returns (bool);
}

interface ISurTimelock {
    function owner() external view returns (address);
    function guardian() external view returns (address);
    function delay() external view returns (uint256);
    function setupComplete() external view returns (bool);
}

contract PostDeployVerify is Script {
    uint256 checks;
    uint256 passed;
    uint256 warnings;

    function run() external view {
        address vaultAddr = vm.envAddress("VAULT_ADDRESS");
        address engineAddr = vm.envAddress("ENGINE_ADDRESS");
        address settlementAddr = vm.envAddress("SETTLEMENT_ADDRESS");
        address liquidatorAddr = vm.envAddress("LIQUIDATOR_ADDRESS");
        address insuranceAddr = vm.envAddress("INSURANCE_ADDRESS");
        address oracleAddr = vm.envAddress("ORACLE_ADDRESS");
        address timelockAddr = vm.envAddress("TIMELOCK_ADDRESS");

        console.log("==========================================================");
        console.log("  SUR Protocol - Post-Deploy Verification");
        console.log("==========================================================");
        console.log("Chain ID:", block.chainid);
        console.log("");

        // ─── SECTION 1: Contract Existence ───
        _header("1. Contract Existence");
        _checkCode(vaultAddr, "PerpVault");
        _checkCode(engineAddr, "PerpEngine");
        _checkCode(settlementAddr, "OrderSettlement");
        _checkCode(liquidatorAddr, "Liquidator");
        _checkCode(insuranceAddr, "InsuranceFund");
        _checkCode(oracleAddr, "OracleRouter");
        _checkCode(timelockAddr, "SurTimelock");

        // ─── SECTION 2: Pause Status ───
        _header("2. Pause Status (all should be UNPAUSED)");
        _checkFalse(IPerpVault(vaultAddr).paused(), "PerpVault.paused");
        _checkFalse(IPerpEngine(engineAddr).paused(), "PerpEngine.paused");
        _checkFalse(IOrderSettlement(settlementAddr).paused(), "OrderSettlement.paused");
        _checkFalse(ILiquidator(liquidatorAddr).paused(), "Liquidator.paused");

        // ─── SECTION 3: Circuit Breakers ───
        _header("3. Circuit Breakers (should be INACTIVE)");
        _checkFalse(IPerpEngine(engineAddr).circuitBreakerActive(), "Engine CB active");
        _checkFalse(IOracleRouter(oracleAddr).oracleCircuitBreakerActive(), "Oracle CB active");
        _checkTrue(IOracleRouter(oracleAddr).isOracleHealthy(), "Oracle healthy");

        // ─── SECTION 4: Operator Permissions ───
        _header("4. Operator Permissions");
        _checkTrue(IPerpVault(vaultAddr).operators(engineAddr), "Vault: engine is operator");
        _checkTrue(IPerpVault(vaultAddr).operators(settlementAddr), "Vault: settlement is operator");
        _checkTrue(IPerpEngine(engineAddr).operators(settlementAddr), "Engine: settlement is operator");
        _checkTrue(IPerpEngine(engineAddr).operators(liquidatorAddr), "Engine: liquidator is operator");
        _checkTrue(IPerpEngine(engineAddr).operators(oracleAddr), "Engine: oracle is operator");
        _checkTrue(IInsuranceFund(insuranceAddr).operators(liquidatorAddr), "Insurance: liquidator is operator");

        // ─── SECTION 5: Contract Wiring ───
        _header("5. Contract Wiring");
        _checkEq(address(IPerpEngine(engineAddr).vault()), vaultAddr, "Engine.vault");
        _checkEq(address(IPerpEngine(engineAddr).insuranceFund()), insuranceAddr, "Engine.insuranceFund");
        _checkEq(address(ILiquidator(liquidatorAddr).engine()), engineAddr, "Liquidator.engine");
        _checkEq(address(ILiquidator(liquidatorAddr).insuranceFund()), insuranceAddr, "Liquidator.insuranceFund");

        // ─── SECTION 6: Vault Health ───
        _header("6. Vault Health");
        (bool healthy,,) = IPerpVault(vaultAddr).healthCheck();
        _checkTrue(healthy, "Vault healthCheck");

        // ─── SECTION 7: Circuit Breaker Config ───
        _header("7. PerpEngine Circuit Breaker Config");
        uint256 cbWindow = IPerpEngine(engineAddr).circuitBreakerWindowSecs();
        uint256 cbThreshold = IPerpEngine(engineAddr).circuitBreakerThresholdBps();
        uint256 cbCooldown = IPerpEngine(engineAddr).circuitBreakerCooldownSecs();
        console.log("  Window:", cbWindow, "s");
        console.log("  Threshold:", cbThreshold, "bps");
        console.log("  Cooldown:", cbCooldown, "s");
        _checkTrue(cbWindow > 0, "CB window > 0");
        _checkTrue(cbThreshold > 0, "CB threshold > 0");
        _checkTrue(cbCooldown > 0, "CB cooldown > 0");

        // ─── SECTION 8: Timelock Config ───
        _header("8. Timelock Config");
        uint256 delay = ISurTimelock(timelockAddr).delay();
        address guardian = ISurTimelock(timelockAddr).guardian();
        bool setupDone = ISurTimelock(timelockAddr).setupComplete();
        console.log("  Delay:", delay / 1 hours, "hours");
        console.log("  Guardian:", guardian);
        console.log("  Setup locked:", setupDone);
        _checkTrue(delay >= 24 hours, "Timelock delay >= 24h");
        _checkTrue(guardian != address(0), "Guardian set");
        _checkTrue(setupDone, "Setup complete (locked)");

        // ─── SECTION 9: Markets ───
        _header("9. Markets");
        bytes32 btcMarket = keccak256(abi.encodePacked("BTC-USD"));
        bytes32 ethMarket = keccak256(abi.encodePacked("ETH-USD"));
        _checkMarket(engineAddr, btcMarket, "BTC-USD");
        _checkMarket(engineAddr, ethMarket, "ETH-USD");

        // ─── SECTION 10: Ownership ───
        _header("10. Ownership Summary");
        console.log("  PerpVault owner:       ", IPerpVault(vaultAddr).owner());
        console.log("  PerpEngine owner:      ", IPerpEngine(engineAddr).owner());
        console.log("  OrderSettlement owner: ", IOrderSettlement(settlementAddr).owner());
        console.log("  Liquidator owner:      ", ILiquidator(liquidatorAddr).owner());
        console.log("  InsuranceFund owner:   ", IInsuranceFund(insuranceAddr).owner());
        console.log("  OracleRouter owner:    ", IOracleRouter(oracleAddr).owner());
        console.log("  SurTimelock owner:     ", ISurTimelock(timelockAddr).owner());

        // Check for pending ownership transfers
        _checkPendingOwner(vaultAddr, "PerpVault");
        _checkPendingOwner(engineAddr, "PerpEngine");
        _checkPendingOwner(settlementAddr, "OrderSettlement");
        _checkPendingOwner(liquidatorAddr, "Liquidator");
        _checkPendingOwner(insuranceAddr, "InsuranceFund");
        _checkPendingOwner(oracleAddr, "OracleRouter");

        // ─── SUMMARY ───
        console.log("");
        console.log("==========================================================");
        console.log("  VERIFICATION COMPLETE");
        console.log("==========================================================");
    }

    // ─── HELPERS ───

    function _header(string memory title) internal pure {
        console.log("");
        console.log(string(abi.encodePacked("--- ", title, " ---")));
    }

    function _checkCode(address addr, string memory name) internal view {
        uint256 size;
        assembly { size := extcodesize(addr) }
        if (size > 0) {
            console.log("  [OK]", name, "deployed, code size:", size);
        } else {
            console.log("  [FAIL]", name, "NO CODE at", addr);
        }
    }

    function _checkTrue(bool val, string memory label) internal pure {
        console.log(val ? "  [OK]" : "  [FAIL]", label);
    }

    function _checkFalse(bool val, string memory label) internal pure {
        console.log(!val ? "  [OK]" : "  [FAIL]", label);
    }

    function _checkEq(address a, address b, string memory label) internal pure {
        if (a == b) {
            console.log("  [OK]", label);
        } else {
            console.log("  [FAIL]", label);
            console.log("    expected:", b);
            console.log("    got:     ", a);
        }
    }

    function _checkMarket(address engineAddr, bytes32 marketId, string memory name) internal view {
        try IPerpEngine(engineAddr).markets(marketId) returns (
            bytes32, string memory, bool active, uint256 imBps, uint256 mmBps,
            uint256 maxPos, uint256, uint256, uint256, int256, uint256, uint256, uint256, uint256
        ) {
            if (active) {
                console.log("  [OK]", name, "active");
                console.log("    IM (bps):", imBps);
                console.log("    MM (bps):", mmBps);
            } else {
                console.log("  [WARN]", name, "exists but INACTIVE");
            }
        } catch {
            console.log("  [FAIL]", name, "market not found");
        }
    }

    function _checkPendingOwner(address target, string memory name) internal view {
        try IOwnable(target).owner() returns (address) {
            // Check pendingOwner
            (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature("pendingOwner()"));
            if (ok && data.length >= 32) {
                address pending = abi.decode(data, (address));
                if (pending != address(0)) {
                    console.log("  [INFO]", name, "pendingOwner:", pending);
                }
            }
        } catch {}
    }
}
