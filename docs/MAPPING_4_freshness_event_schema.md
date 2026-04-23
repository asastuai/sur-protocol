# MAPPING 4 — Freshness-Typed Event Schema

**Companion to:** [`proof-of-context-mapping.md`](proof-of-context-mapping.md) Mapping 4.
**Scope:** design specification. No code changes in this document.
**Status:** ready to implement. Additive to existing event schema; zero breaking changes.

---

## 1. The additive change

Every SUR component that can reject a settlement, liquidation, or trade acceptance on the grounds of stale contextual state emits a **typed** event whose schema identifies *which freshness axis failed*. The four axes are those formalized in the proof-of-context paper §6:

- `f_c` — **computational freshness** (submit-to-inclusion latency)
- `f_m` — **model freshness** (oracle round / price feed version)
- `f_i` — **input freshness** (counterparty state, RAG corpus, tool-call results)
- `f_s` — **settlement freshness** (commit-to-clear window)

The goal is instrumentation and auditability. Operators, LPs, and protocol monitors get a clean histogram of which axis fails most often in production. That histogram is directly actionable for (a) threshold tuning, (b) incident triage, and (c) external reporting to auditors.

This mapping introduces no new rejection logic. It only types the rejection events that accompany whatever gating logic Mappings 1, 2, 3, and 5 install.

---

## 2. Event schema

### 2.1 Shared library type

Add to `contracts/src/libraries/` a small library that is referenced by every other contract emitting freshness-typed events:

```solidity
// contracts/src/libraries/FreshnessTypes.sol
library FreshnessTypes {
    /// Enumeration of the four freshness axes from proof-of-context §6.
    /// Encoded as uint8 for event-index efficiency.
    uint8 constant FRESHNESS_COMPUTATIONAL = 1;
    uint8 constant FRESHNESS_MODEL         = 2;
    uint8 constant FRESHNESS_INPUT         = 3;
    uint8 constant FRESHNESS_SETTLEMENT    = 4;
}
```

The constants are uint8 rather than a named enum so that the field can be `indexed` in Solidity events (named enums cannot be indexed as-is; uint8 can).

### 2.2 Core event

Emitted at every rejection site, regardless of which contract rejected:

```solidity
/// Emitted when a settlement, liquidation, or trade is rejected on freshness grounds.
/// @param marketId        Market whose operation was rejected.
/// @param actor           Address whose operation was rejected (trader, keeper, counterparty).
/// @param operationType   Keccak256 of the operation name, e.g. keccak256("LIQUIDATE"),
///                        keccak256("SETTLE_A2A"), keccak256("SETTLE_BATCH").
/// @param freshnessType   One of FreshnessTypes.FRESHNESS_* constants.
/// @param observedStaleness  Numeric stalness on the violated axis, in the unit native
///                           to that axis (blocks for f_c/f_s, rounds for f_m oracle-round,
///                           blocks for f_i).  Encoded as uint256.
/// @param thresholdAtTime    The configured threshold for this market at the time of rejection.
event FreshnessRejected(
    bytes32 indexed marketId,
    address indexed actor,
    bytes32 indexed operationType,
    uint8 freshnessType,
    uint256 observedStaleness,
    uint256 thresholdAtTime
);
```

### 2.3 Per-market configuration struct

A small config record per market allows per-asset tuning:

```solidity
struct FreshnessConfig {
    // Maximum submit-to-inclusion latency, in blocks.
    uint32 maxFcBlocks;
    // Maximum distance from latest oracle round, in rounds.
    uint32 maxFmRounds;
    // Maximum blocks the input-world state can lag, in blocks.
    uint32 maxFiBlocks;
    // Maximum commit-to-settle window, in blocks.
    uint32 maxFsBlocks;
    // Protocol version of the config schema. Bump on breaking change.
    uint8  configVersion;
}

mapping(bytes32 marketId => FreshnessConfig) public freshnessConfigs;
```

The config is set and updated via an admin handler that emits `ParameterBump` per Mapping 3 (prospective-only, since tightening a freshness window retroactively would reject in-flight matches that were fresh under the prior config).

### 2.4 Observability helper event

Emitted whenever a settlement or liquidation clears **without** freshness rejection — the complementary event to `FreshnessRejected`. Provides the denominator for rejection-rate metrics:

```solidity
event FreshnessCheckPassed(
    bytes32 indexed marketId,
    address indexed actor,
    bytes32 indexed operationType,
    uint256 fcObserved,   // elapsed-blocks between commit and inclusion
    uint256 fmObserved,   // round-distance between used and current oracle round
    uint256 fiObserved,   // block-lag of input state
    uint256 fsObserved    // block-distance from commit to settle
);
```

This event is cheap (no slashing or state change) and emits at every successful gated operation. Operators can compute rejection-rate per-axis-per-market from the two event streams alone.

---

## 3. Emission sites

### 3.1 Liquidator (Mapping 2)

Anchor-divergence reverts from `_verifyAnchor` emit `FreshnessRejected` with:
- `operationType = keccak256("LIQUIDATE")`
- `freshnessType = FRESHNESS_MODEL` for `f_m` (Drand/oracle divergence)
- Specific error variant distinguished by the revert error code, but the event captures the axis

### 3.2 OrderSettlement (Mapping 1, when activated)

Settlement rejections due to `f_c` (matched order too old at inclusion), `f_m` (oracle drifted), `f_i` (counterparty state drifted), or `f_s` (settlement window exceeded) each emit `FreshnessRejected` with the corresponding type.

### 3.3 A2ADarkPool (Mappings 1, 5)

Match rejections emit with `operationType = keccak256("A2A_MATCH")` and the appropriate freshness type.

### 3.4 CollateralManager (Mapping 3)

Collateral validations that fail on `f_i` (deposit state drifted) or `f_m` (haircut oracle stale) emit with `operationType = keccak256("COLLATERAL_CHECK")`.

---

## 4. Backward compatibility

All existing rejection events (`PositionNotLiquidatable`, `LiquidationFailed`, etc.) remain unchanged. `FreshnessRejected` is **additional**, not replacing. This preserves every existing indexer, dashboard, and alert.

External consumers that want the typed view subscribe to `FreshnessRejected`; consumers that want to preserve existing behavior subscribe to the pre-existing events. There is no migration pressure — both streams run simultaneously in perpetuity.

---

## 5. Implementation effort estimate

This mapping is cheap:
- One new file: `contracts/src/libraries/FreshnessTypes.sol`.
- One new file: `contracts/src/libraries/FreshnessEvents.sol` (optional — could be inlined into individual contracts instead).
- One new struct definition: `FreshnessConfig` (live in existing `ISurInterfaces.sol` or a new `IFreshness.sol`).
- One emission call at each gated site. As Mappings 1, 2, 3, 5 get implemented, each adds one `emit FreshnessRejected(...)` at the appropriate place.
- Per-market `FreshnessConfig` setter, using the `ParameterBump` pattern from Mapping 3.

Estimate: 1 session of implementation + test work once Mapping 2 is coded. This mapping can merge before Mapping 2's rejection logic exists — the event just would not fire until there is something to reject.

---

## 6. Acceptance tests

### 6.1 Liquidator rejection emits typed event

```
Given:
  - A liquidatable position
  - Keeper submits anchor with stale Drand round
Action:
  - liquidate(marketId, trader, staleAnchor)
Expect:
  - Tx reverts with AnchorDrandDivergence
  - FreshnessRejected event emitted with freshnessType = FRESHNESS_MODEL (2)
  - FreshnessRejected.thresholdAtTime == configured DRAND_SKEW_TOLERANCE
```

### 6.2 Successful liquidation emits pass event

```
Given:
  - A liquidatable position, honest keeper with fresh anchor
Action:
  - liquidate(marketId, trader, freshAnchor)
Expect:
  - Position liquidated
  - FreshnessCheckPassed event emitted with fmObserved <= DRAND_SKEW_TOLERANCE
```

### 6.3 Per-market config tuning

```
Given:
  - Market X has freshnessConfigs[X].maxFmRounds = 1
Action:
  - Admin sets freshnessConfigs[X].maxFmRounds = 2 via prospective-only setter
Expect:
  - ParameterBump event emitted with paramId = keccak256("Freshness.maxFmRounds.X")
  - Existing liquidation anchors at round-distance 2 for market X that were previously
    rejected now clear (for commitments opened after the effective block)
  - Liquidation anchors at round-distance 2 for any other market remain rejected
```

---

## 7. Scope exclusions

- **Freshness enforcement logic itself.** This mapping only types the events. Whether a given observed staleness exceeds threshold is decided by the contract doing the check (per Mappings 1, 2, 3, 5).
- **Off-chain aggregation / dashboards.** Metrics pipelines that consume `FreshnessRejected` and `FreshnessCheckPassed` to produce operator dashboards are separate work. Out of scope for this contract-level design doc.
- **Cross-chain event aggregation.** Assumes SUR remains on Base L2 as canonical settlement chain.

---

## 8. Revision log

- **v1 (23 April 2026):** initial design. Shared `FreshnessTypes` library, `FreshnessRejected` + `FreshnessCheckPassed` events, per-market `FreshnessConfig` struct, additive non-breaking. Ready to implement once Mapping 2 lands.
