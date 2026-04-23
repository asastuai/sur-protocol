# MAPPING 3 — Prospective-Only Parameter Updates

**Companion to:** [`proof-of-context-mapping.md`](proof-of-context-mapping.md) Mapping 3.
**Scope:** design specification. No code changes in this document.
**Status:** ready to implement (Phase 1, cheapest item — pure convention + accounting-layer read).

---

## 1. The invariant being added

> **Admin parameter updates that change the economic terms of open positions take effect prospectively only. Positions opened before the bump continue to settle against the pre-bump values until they close.**

The invariant applies strictly to *position-economics* parameters. Safety parameters (circuit breakers, ADL switches, pause controls) remain retroactive by design — they exist to stop ongoing harm and must apply immediately. Operational parameters (operator addresses, fee recipient, infrastructure pointers) are neither: they do not affect open-position economics and do not need prospective-only semantics.

The classification of each admin setter is part of this document (§3).

---

## 2. Why

Current behavior: an admin calls `setLiquidationThresholdBps(6500)` (for example) and the new threshold applies to every open position from that block forward, including positions opened under the prior `6000` threshold. A trader who sized their position based on the earlier liquidation cushion has their risk parameters retroactively altered without consent.

This is a known class of DeFi risk — parameter-frontrunning, admin-rug-lite — and it is not addressed by the current SurTimelock alone. The timelock ensures parameter updates are *visible* N blocks before they activate; it does not ensure they apply *only to new positions*.

Prospective-only semantics close this gap without requiring new cryptography, new external dependencies, or governance changes. It is a pure convention + accounting-layer read of the appropriate historical parameter value per position.

---

## 3. Classification of existing admin setters

### 3.1 Position-economics parameters (MUST become prospective-only)

The change in these parameters alters the economic meaning of open positions.

| Contract | Function | What it controls |
|---|---|---|
| `PerpEngine.sol` | `setMaxExposureBps(uint256)` | Per-account max-exposure limit |
| `PerpEngine.sol` | `setOiCap(bytes32, uint256)` | Per-market open-interest cap |
| `PerpEngine.sol` | `setOiSkewCap(uint256)` | Global OI skew cap in bps |
| `PerpEngine.sol` | `setReserveFactor(uint256)` | Reserve accounting factor |
| `PerpEngine.sol` | `setMaxPriceAge(uint256)` | Oracle staleness tolerance for settlement |
| `CollateralManager.sol` | `setHaircut(address, uint256)` | Per-token collateral haircut |
| `CollateralManager.sol` | `setLiquidationThresholdBps(uint256)` | Critical — liquidation math on open positions |
| `CollateralManager.sol` | `setMaxPriceDeviationBps(uint256)` | Collateral price-deviation tolerance |
| `OrderSettlement.sol` | `setFees(uint32, uint32)` | Maker / taker fees |
| `OrderSettlement.sol` | `setDynamicSpreadTiers(uint32,uint32,uint32)` | Spread tiering |
| `OrderSettlement.sol` | `setDynamicSpreadEnabled(bool)` | Spread mode toggle |
| `OrderSettlement.sol` | `setSettlementDelay(uint256, uint256)` | Settlement window min/max |
| `A2ADarkPool.sol` | `setFeeBps(uint256)` | Dark-pool fee in bps |
| `A2ADarkPool.sol` | `setLargeTradeThreshold(uint256)` | Large-trade routing threshold |
| `A2ADarkPool.sol` | `setLargeTradeMinReputation(uint256)` | Dark-pool access bar |

Count: 15 setters across four contracts.

#### 3.1a Reclassification findings from implementation

Implementation revealed that the initial classification above was too aggressive on the PerpEngine setters. The detailed audit of read sites showed that five of the parameters listed under PerpEngine (maxExposureBps, oiCap, oiSkewCap, reserveFactor, maxPriceAge) are **risk-limit or safety parameters**, not position-economics parameters:

- **`setMaxExposureBps`, `setOiCap`, `setOiSkewCap`, `setReserveFactor`** are *risk limits* read at position-open and position-modify time. A tightening bump blocks new entries or enlargement, but does not retroactively close an already-open position below the new limit, and does not alter its economic terms (fees, liquidation threshold, PnL calculation). They satisfy the prospective-only invariant **by construction**, with no snapshot field required. Implementation emits `ParameterBump` from each of the four for schema consistency.
- **`setMaxPriceAge`** is an oracle-freshness *safety* guard. Tightening it rejects stale-price operations more aggressively — a fail-safe behavior that benefits all participants regardless of when their positions opened. Implementation does NOT emit `ParameterBump` from this setter; classified as safety-adjacent, same category as `setCircuitBreakerParams`.

**Newly identified retroactive bug:** The implementation audit surfaced **`setMarginTiers(bytes32, MarginTier[])`** as a genuine position-economics setter not originally listed in §3.1. `_calculateTieredMargin` is read during liquidation eligibility checks of already-open positions, so an admin tier bump can retroactively alter which positions are liquidation-eligible. Fix requires per-position tier snapshotting (which interacts with the fact that tier selection depends on current position size — positions that grow across tier boundaries complicate the snapshot semantics). Documented as a pending dedicated refactor; `setMarginTiers` does not emit `ParameterBump` until that refactor lands — emitting would incorrectly signal that the prospective-only convention is already upheld.

The CollateralManager, OrderSettlement, and A2ADarkPool classifications remain as originally stated. Those implementations did require snapshot refactors and are complete.

### 3.2 Safety / emergency parameters (STAY retroactive by design)

These parameters exist to halt ongoing harm; they must apply immediately.

| Contract | Function | Rationale for retroactive |
|---|---|---|
| `PerpEngine.sol` | `setCircuitBreakerParams(uint256, uint256, uint256)` | Emergency throttle |
| `OracleRouter.sol` | `setOracleCircuitBreakerParams(uint256, uint256)` | Price-feed halt |
| `AutoDeleveraging.sol` | `setADLEnabled(bool)` | Emergency switch |
| `AutoDeleveraging.sol` | `setADLParams(uint256, uint256)` | ADL triggering economics (emergency class) |

### 3.3 Operational / infrastructure parameters (retroactive; no position economics)

| Contract | Function |
|---|---|
| (all) | `setOperator(address, bool)` |
| `PerpEngine.sol` | `setFeeRecipient`, `setInsuranceFund`, `setFundingPool` |
| `PerpVault.sol` | `setDepositCap`, `setMaxWithdrawalPerTx`, `setMaxOperatorTransferPerTx` |
| `InsuranceFund.sol` | `setMaxKeeperRewardPerCall`, `setMaxDailyKeeperRewards` |
| `OracleRouter.sol` | `setSequencerUptimeFeed` |
| `OrderSettlement.sol` | `setFeeRecipient` |
| `A2ADarkPool.sol` | `setFeeRecipient` |
| `CollateralManager.sol` | `setLiquidationThresholdBps` — NOTE: in §3.1, listed here only to note it has both an infrastructure-style signature and position-economics impact |
| `SurTimelock.sol` | `setDelay`, `setGuardian`, `setPausableTarget` |

---

## 4. Event schema

A single, typed event emitted by every prospective-only setter:

```solidity
/// Emitted whenever a position-economics parameter changes prospectively.
/// @param paramId        Keccak256 of the canonical parameter name,
///                       e.g. keccak256("CollateralManager.liquidationThresholdBps").
/// @param oldValue       Previous value (ABI-encoded).
/// @param newValue       New value (ABI-encoded).
/// @param effectiveBlock Block number at which the new value begins applying
///                       to *new* positions. Must be >= block.number at emission.
/// @param admin          Address of the admin that triggered the update.
event ParameterBump(
    bytes32 indexed paramId,
    bytes oldValue,
    bytes newValue,
    uint256 effectiveBlock,
    address indexed admin
);
```

The `paramId` is a deterministic hash of the fully-qualified parameter name so indexers and dashboards can filter by parameter without brittle string matching.

The `effectiveBlock` field acknowledges that SurTimelock may already delay activation. For non-timelocked prospective parameters, `effectiveBlock == block.number` (immediate prospective); for timelocked, `effectiveBlock == block.number + timelock.delay()`.

The event does not replace existing per-parameter events (e.g. `LiquidationThresholdUpdated`). Those remain for backwards compatibility with existing indexers; `ParameterBump` is emitted alongside them and becomes the canonical cross-contract signal.

---

## 5. Accounting-layer read of historical values

For prospective-only to hold, every read site that applies a position-economics parameter must read *the value effective at the position's open block*, not the current value.

Two implementation strategies:

### Strategy A — Per-position snapshot (preferred for small parameter surface)

At position open, the contract snapshots the parameter values relevant to that position into the position struct. All subsequent reads for that position use the snapshot. Parameter bumps do not affect already-stored snapshots.

**Pro:** clean, local, no bookkeeping across bumps.
**Con:** enlarges the position struct; parameter surface must be fixed at design time.

### Strategy B — Versioned parameter history (preferred for evolving parameter surface)

The contract maintains a `mapping(bytes32 paramId => Version[] history)` where each `Version` is `{ uint256 startBlock; bytes value; }`. Position open records only the `openBlock`. At read time, the contract binary-searches the parameter's version history for the version active at `openBlock`.

**Pro:** allows adding new prospective-only parameters without changing position structs.
**Con:** slightly more expensive per read; requires ensuring `Version[]` is append-only.

### Recommendation for SUR

Given that the position struct already exists in `PerpEngine.sol` and is hot-path, Strategy A is the right fit for the 15 parameters enumerated in §3.1. Strategy B can be introduced later if the prospective-only surface grows.

The concrete list of snapshot fields to add to the position struct:

```
struct PositionEconomicsSnapshot {
    uint32  makerFee;                    // OrderSettlement.setFees maker
    uint32  takerFee;                    // OrderSettlement.setFees taker
    uint256 liquidationThresholdBps;     // CollateralManager
    uint256 maxExposureBps;              // PerpEngine
    uint256 oiCap;                       // PerpEngine.setOiCap for this market
    uint256 oiSkewCap;                   // PerpEngine
    uint256 reserveFactor;               // PerpEngine
    uint256 maxPriceAge;                 // PerpEngine
    uint256 maxPriceDeviationBps;        // CollateralManager
    // Token-specific haircuts stored in a separate per-token snapshot
    //   mapping(address token => uint256 haircut) haircutSnapshot
    //   (filled at deposit time or at first use per position)
}
```

---

## 6. Scope exclusions

The following are explicitly *not* part of this mapping:

- Circuit breakers and ADL parameters (§3.2) — these stay retroactive by design.
- Operational / infrastructure setters (§3.3) — no position economics.
- Governance parameters of `SurTimelock.sol` — meta-level, outside this scope.
- Parameters introduced in future contracts — this document enumerates what exists at the time of writing; future additions require their own classification decision.

---

## 7. Acceptance tests

### 7.1 Liquidation threshold bump does not retroactively liquidate

```
Given:
  - Position A opened at block B with liquidationThresholdBps = 6000
  - Position's current collateral ratio = 0.62 (above 6000 bps, safe)
Action:
  - Admin calls setLiquidationThresholdBps(6500) at block B + 10
Expect:
  - Position A does NOT become liquidation-eligible
  - A new Position C opened at block B + 11 with the same ratio (0.62)
    IS liquidation-eligible (because 0.62 < 0.65)
  - ParameterBump event emitted with paramId =
    keccak256("CollateralManager.liquidationThresholdBps"),
    effectiveBlock = B + 10 (or B + 10 + timelock.delay())
```

### 7.2 Fee bump does not re-charge existing positions

```
Given:
  - Position A opened at block B with taker fee 10 bps
  - Position A unrealized notional at block B + 20: X USDC
Action:
  - Admin calls setFees(maker = 10, taker = 20) at block B + 15
Expect:
  - Position A's settlement at close uses taker fee 10 bps
  - A position C opened at block B + 16 uses taker fee 20 bps
  - Both positions observable via the same position-query RPC, reporting
    their distinct snapshot values.
```

### 7.3 Circuit breaker parameter update IS retroactive (counter-test)

```
Given:
  - Position A open
Action:
  - Admin calls setCircuitBreakerParams(windowSecs=30, thresholdBps=50, cooldownSecs=60)
Expect:
  - New circuit-breaker behavior applies to ALL positions including A
  - NO ParameterBump event emitted (this parameter is intentionally retroactive)
  - The existing per-parameter event (or equivalent) emits per current convention
```

### 7.4 Admin attempts to bump a prospective-only parameter without the new event

The test asserts that every prospective-only setter, after the refactor, emits `ParameterBump`. A regression test walks all 15 setters and fails if any setter call does not produce the event.

---

## 8. Rollout plan

1. Add `ParameterBump` event + `PositionEconomicsSnapshot` struct definitions as library-level types. No behavior change. Deploy to testnet.
2. Refactor one contract's setters at a time (suggest order: `OrderSettlement` → `A2ADarkPool` → `PerpEngine` → `CollateralManager`). After each contract, run full Foundry test suite; must remain green.
3. Each refactor includes (a) updating the admin setter to emit `ParameterBump`, (b) updating the read sites to consume the position snapshot, (c) adding the two acceptance-test families from §7 for the parameters in that contract.
4. After all four contracts are refactored and testnet-green for at least one full week, merge to mainnet-targeted branch.

---

## 9. Open design decisions

1. **`effectiveBlock` timing.** Should `ParameterBump.effectiveBlock` equal `block.number` at emission (prospective but immediate) or `block.number + timelock.delay()` (prospective and timelocked)? Current answer: *whichever the underlying setter already uses.* SurTimelock-gated setters get the timelocked effectiveBlock; direct `onlyOwner` setters get immediate. This preserves the existing governance surface; changing it is orthogonal to prospective-only semantics.
2. **Gas cost of position snapshot.** Adding 9+ fields to the position struct enlarges storage writes at open. Measured on a future Foundry gas-report after the refactor; acceptable overhead is yet to be defined. Alternative: pack the snapshot into a single `bytes32` hash of the parameter set with an off-chain index mapping the hash to values. Deferred until measurement.
3. **Parameter surface evolution.** If we later decide to make, say, `setADLParams` prospective-only (treating ADL as position-economics rather than safety), the reclassification must be published as a governance proposal, not a silent refactor. Policy: changes to the §3 classification require an on-chain governance event, not a pull request alone.

---

## 10. Revision log

- **v1 (22 April 2026):** design document produced alongside Mapping 3 of the proof-of-context integration roadmap. Enumerates existing admin setters, classifies them, specifies the event and invariant, and proposes a rollout plan. No code changes yet.
