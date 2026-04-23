// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/libraries/FreshnessTypes.sol";

/// @title FreshnessTypes library tests (Mapping 4)
/// @notice Smoke-level coverage: constants are the expected values, operation
///         hashes are stable, topic hashes match what off-chain indexers will
///         filter on. No emission tests yet — those land with Mapping 1/2/5
///         implementations at the actual gating sites.
contract FreshnessTypesTest is Test {
    function test_freshnessTypeConstants_are_1_through_4() public pure {
        assertEq(FreshnessTypes.FRESHNESS_COMPUTATIONAL, uint8(1));
        assertEq(FreshnessTypes.FRESHNESS_MODEL,         uint8(2));
        assertEq(FreshnessTypes.FRESHNESS_INPUT,         uint8(3));
        assertEq(FreshnessTypes.FRESHNESS_SETTLEMENT,    uint8(4));
    }

    function test_freshnessTypeConstants_are_distinct() public pure {
        // Paranoia: no duplicates, which would collapse the rejection schema.
        uint8 a = FreshnessTypes.FRESHNESS_COMPUTATIONAL;
        uint8 b = FreshnessTypes.FRESHNESS_MODEL;
        uint8 c = FreshnessTypes.FRESHNESS_INPUT;
        uint8 d = FreshnessTypes.FRESHNESS_SETTLEMENT;
        assertTrue(a != b && a != c && a != d);
        assertTrue(b != c && b != d);
        assertTrue(c != d);
    }

    function test_rejectedTopic_isStable() public pure {
        // The canonical FreshnessRejected event signature.  If this hash
        // changes, every indexer subscribing to the rejection stream across
        // all SUR contracts breaks.
        bytes32 expected = keccak256(
            "FreshnessRejected(bytes32,address,bytes32,uint8,uint256,uint256)"
        );
        assertEq(FreshnessTypes.rejectedTopic(), expected);
    }

    function test_passedTopic_isStable() public pure {
        bytes32 expected = keccak256(
            "FreshnessCheckPassed(bytes32,address,bytes32,uint256,uint256,uint256,uint256)"
        );
        assertEq(FreshnessTypes.passedTopic(), expected);
    }

    function test_operationTypeHashes_areStable() public pure {
        assertEq(FreshnessTypes.OP_LIQUIDATE(),        keccak256("LIQUIDATE"));
        assertEq(FreshnessTypes.OP_SETTLE_A2A(),       keccak256("SETTLE_A2A"));
        assertEq(FreshnessTypes.OP_SETTLE_BATCH(),     keccak256("SETTLE_BATCH"));
        assertEq(FreshnessTypes.OP_COLLATERAL_CHECK(), keccak256("COLLATERAL_CHECK"));
    }

    function test_operationTypeHashes_areDistinct() public pure {
        bytes32 a = FreshnessTypes.OP_LIQUIDATE();
        bytes32 b = FreshnessTypes.OP_SETTLE_A2A();
        bytes32 c = FreshnessTypes.OP_SETTLE_BATCH();
        bytes32 d = FreshnessTypes.OP_COLLATERAL_CHECK();
        assertTrue(a != b && a != c && a != d);
        assertTrue(b != c && b != d);
        assertTrue(c != d);
    }

    function test_freshnessConfig_canBeConstructed() public pure {
        FreshnessTypes.FreshnessConfig memory cfg = FreshnessTypes.FreshnessConfig({
            maxFcBlocks: 30,
            maxFmRounds: 2,
            maxFiBlocks: 15,
            maxFsBlocks: 300,
            configVersion: 1
        });
        assertEq(cfg.maxFcBlocks, 30);
        assertEq(cfg.maxFmRounds, 2);
        assertEq(cfg.maxFiBlocks, 15);
        assertEq(cfg.maxFsBlocks, 300);
        assertEq(cfg.configVersion, 1);
    }
}
