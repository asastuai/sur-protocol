// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title FreshnessTypes
/// @author SUR Protocol Team
/// @notice Shared definitions for the proof-of-context freshness event schema
///         (Mapping 4 of the proof-of-context integration roadmap).
/// @dev See docs/MAPPING_4_freshness_event_schema.md and
///      docs/proof-of-context-mapping.md for the full design.
///
///      This library defines:
///        - The four freshness-type constants (f_c, f_m, f_i, f_s from paper §6).
///        - The FreshnessConfig struct carrying per-market freshness thresholds.
///        - Canonical event signatures used by contracts that gate on freshness.
///
///      Contracts that emit FreshnessRejected / FreshnessCheckPassed must
///      DECLARE the events locally because Solidity does not permit emitting
///      library-declared events from outside the library.  The signatures here
///      are the canonical reference so every contract's local declaration
///      produces the same topic0 hash, allowing indexers to subscribe
///      cross-contract by event signature alone.

library FreshnessTypes {
    // ============================================================
    //                         CONSTANTS
    // ============================================================

    /// @notice `f_c` — computational freshness.
    ///         Elapsed time between when a computation was performed and
    ///         when its attestation is submitted for settlement.  High
    ///         `f_c` means the worker sat on the result.
    uint8 internal constant FRESHNESS_COMPUTATIONAL = 1;

    /// @notice `f_m` — model / feed freshness.
    ///         Distance between the model version / oracle round the
    ///         worker used and the canonical on-chain version at
    ///         settlement time.  High `f_m` means the worker used a
    ///         stale snapshot.
    uint8 internal constant FRESHNESS_MODEL = 2;

    /// @notice `f_i` — input-world freshness.
    ///         Temporal validity of input-world state consumed by the
    ///         computation: oracle feed values, RAG retrieval corpus
    ///         version, tool-call result timestamps, collateral state,
    ///         prompt-cache entries.  High `f_i` means the worker's
    ///         inputs were taken from stale sources.
    uint8 internal constant FRESHNESS_INPUT = 3;

    /// @notice `f_s` — settlement freshness.
    ///         Permitted window between attestation commit and
    ///         settlement clearance.  High `f_s` tolerance permits
    ///         batched settlement and dispute delay at the cost of
    ///         allowing workers to sit on commits that were fresh
    ///         at commit time but stale at settlement.
    uint8 internal constant FRESHNESS_SETTLEMENT = 4;

    // ============================================================
    //                       STRUCT
    // ============================================================

    /// @notice Per-market freshness-horizon configuration.
    /// @dev    Set via a prospective-only admin handler (Mapping 3 convention):
    ///         changes emit ParameterBump and take effect against newly-opened
    ///         positions or newly-committed orders, never retroactively.
    struct FreshnessConfig {
        /// Maximum submit-to-inclusion latency, in blocks.
        uint32 maxFcBlocks;
        /// Maximum distance from latest oracle round, in rounds.
        uint32 maxFmRounds;
        /// Maximum blocks the input-world state can lag, in blocks.
        uint32 maxFiBlocks;
        /// Maximum commit-to-settle window, in blocks.
        uint32 maxFsBlocks;
        /// Protocol version of the config schema. Bump on breaking change.
        uint8  configVersion;
    }

    // ============================================================
    //                  CANONICAL EVENT SIGNATURES
    // ============================================================
    //
    // Contracts that gate on freshness declare the below events locally
    // and emit them at their rejection / pass sites.  Keeping the canonical
    // signatures here ensures every emitter produces identical topic0 hashes.
    //
    //     event FreshnessRejected(
    //         bytes32 indexed marketId,
    //         address indexed actor,
    //         bytes32 indexed operationType,
    //         uint8 freshnessType,
    //         uint256 observedStaleness,
    //         uint256 thresholdAtTime
    //     );
    //
    //     event FreshnessCheckPassed(
    //         bytes32 indexed marketId,
    //         address indexed actor,
    //         bytes32 indexed operationType,
    //         uint256 fcObserved,
    //         uint256 fmObserved,
    //         uint256 fiObserved,
    //         uint256 fsObserved
    //     );
    //
    //  operationType is typically keccak256("LIQUIDATE"), keccak256("SETTLE_A2A"),
    //  keccak256("SETTLE_BATCH"), keccak256("COLLATERAL_CHECK"), etc.

    /// @notice keccak256("FreshnessRejected(bytes32,address,bytes32,uint8,uint256,uint256)")
    /// @dev    Use as `topic0` filter when subscribing to the rejection stream
    ///         across all SUR contracts.
    function rejectedTopic() internal pure returns (bytes32) {
        return keccak256("FreshnessRejected(bytes32,address,bytes32,uint8,uint256,uint256)");
    }

    /// @notice keccak256("FreshnessCheckPassed(bytes32,address,bytes32,uint256,uint256,uint256,uint256)")
    function passedTopic() internal pure returns (bytes32) {
        return keccak256("FreshnessCheckPassed(bytes32,address,bytes32,uint256,uint256,uint256,uint256)");
    }

    // ============================================================
    //                 OPERATION-TYPE CONSTANTS
    // ============================================================

    /// @notice keccak256("LIQUIDATE")
    function OP_LIQUIDATE() internal pure returns (bytes32) {
        return keccak256("LIQUIDATE");
    }

    /// @notice keccak256("SETTLE_A2A")
    function OP_SETTLE_A2A() internal pure returns (bytes32) {
        return keccak256("SETTLE_A2A");
    }

    /// @notice keccak256("SETTLE_BATCH")
    function OP_SETTLE_BATCH() internal pure returns (bytes32) {
        return keccak256("SETTLE_BATCH");
    }

    /// @notice keccak256("COLLATERAL_CHECK")
    function OP_COLLATERAL_CHECK() internal pure returns (bytes32) {
        return keccak256("COLLATERAL_CHECK");
    }
}
