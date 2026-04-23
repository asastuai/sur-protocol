# MAPPING 3 — `setMarginTiers` Refactor Design

**Companion to:** [`MAPPING_3_prospective_params.md`](MAPPING_3_prospective_params.md) §3.1a.
**Target contract:** `contracts/src/PerpEngine.sol`.
**Status:** design specification. Implementation follows in a separate commit.

---

## 1. Problem

`setMarginTiers(bytes32 marketId, MarginTier[] calldata tiers)` overwrites the per-market margin-tier array. The tiers are read by `_calculateTieredMargin`, which is called at three sites:

- `openPosition` — initial margin required at open (prospective, no bug)
- `_reduceOrFlipPosition` — margin requirement at modification (similar to open)
- `_isLiquidatable` — maintenance margin used to decide liquidation eligibility **on already-open positions**

The liquidation-check site is where the retroactive bug lives: an admin can bump maintenance margin from 250 bps to 500 bps and instantly render open positions liquidatable, without their collateral or size having changed. This is the same class of governance-attack vector closed for `setLiquidationThresholdBps` in CollateralManager, applied to PerpEngine.

The fix: each position snapshots the margin-tier regime active at its open, and the liquidation check uses the snapshot instead of the current live tiers.

The complication vs. simpler snapshot-field patterns (A2A's `feeBpsAtPost`, OrderSettlement's `OrderSnapshot`) is that margin tiers are:

- An **array of brackets**, not a single value.
- Applied **tax-bracket-style** — the required margin for a position of notional `N` sums the bracket margins up to `N`, it does not pick a single tier. So the whole array is needed at read time, not just a single tier's bps.
- **Size-dependent** — the position's current notional determines which brackets are engaged. A position that grows across a bracket boundary must cross into the higher bracket.

These properties rule out the "congelar tier activo" approach (freeze only the tier active at open) — it would lock a position's leverage forever even as the position grows, breaking the protocol's risk-management posture. See §2.

---

## 2. Option A vs. Option B recap

**Option A — freeze the entire tier array at position open.** Position tracks which version of the market's tier array was active when it opened, uses that version for all subsequent margin calculations.
- Protects against admin bumps.
- Preserves the protocol's size-dependent risk scaling: if the position grows, it crosses into higher brackets *of the frozen array*.

**Option B — freeze only the tier active at open.** Position tracks a single `(initialBps, maintBps)` pair from the tier that matched its notional at open.
- Protects against admin bumps.
- **Breaks size-dependent risk scaling**: a position opened at $5K (tier 1, 20x) can grow to $1M without ever triggering the higher-margin requirements that the tier system exists to enforce.

Option B is semantically broken. Option A is correct. The refactor implements A.

---

## 3. Data-structure design (A.2 — versioned tier history)

### 3.1 The versioned storage

```solidity
/// @notice Historical tier configurations per market.  A new version is
///         pushed every time setMarginTiers is called.  Positions reference
///         the version active at their open time via Position.marginTierVersion.
/// @dev    Version 0 is reserved for "no tiers configured — use flat
///         market.initialMarginBps / maintenanceMarginBps".  Real tier
///         versions start at 1.
mapping(bytes32 => MarginTier[][]) private marketMarginTiersHistory;

/// @notice Current active tier version per market.  Used as the snapshot
///         written into Position.marginTierVersion at openPosition.
mapping(bytes32 => uint256) public marketCurrentTierVersion;
```

Trade-off chosen: direct array-of-arrays in storage. Costs more than hashing+mapping, but avoids introducing a separate version registry and keeps the data locality clear.

### 3.2 Position struct gains one field

```solidity
struct Position {
    int256 size;
    uint256 entryPrice;
    uint256 margin;
    int256 lastCumulativeFunding;
    uint256 lastUpdated;
    uint256 marginTierVersion; // NEW — snapshot of market's tier version at open
}
```

Storage cost: one `uint256` per position (32 bytes).

### 3.3 Version 0 semantics (the fallback)

`marginTierVersion == 0` is reserved. It means "no tier snapshot was taken for this position" and signals `_calculateTieredMargin` to fall back to the flat `market.initialMarginBps / maintenanceMarginBps` — identical to the current pre-refactor fallback when a market has no tiers configured.

This covers the case of a market with flat rates only (never had `setMarginTiers` called). The flat rates in `Market` are immutable after `addMarket` — there is no admin setter for them — so a position with `version == 0` against a flat market has no retroactive-bump exposure.

---

## 4. Write path — `setMarginTiers`

```
function setMarginTiers(bytes32 marketId, MarginTier[] calldata tiers)
    external onlyOwner marketExists(marketId)
{
    // Existing validations preserved (tier sorting, bps bounds).
    // ...

    // Push new version into the history.
    uint256 newVersion = marketMarginTiersHistory[marketId].length + 1;
    require(newVersion <= MAX_TIER_VERSIONS, "MAX_TIER_VERSIONS exceeded");

    marketMarginTiersHistory[marketId].push();      // grow the outer array
    MarginTier[] storage dst = marketMarginTiersHistory[marketId][newVersion - 1];
    for (uint256 i = 0; i < tiers.length; i++) {
        dst.push(tiers[i]);
    }

    marketCurrentTierVersion[marketId] = newVersion;

    emit MarginTiersUpdated(marketId, tiers.length);
    emit ParameterBump(
        keccak256(abi.encodePacked("PerpEngine.marginTiers:", marketId)),
        abi.encode(oldVersionIndex),
        abi.encode(newVersion),
        block.number,
        msg.sender
    );
}
```

Notes:
- Replaces the existing `delete marketMarginTiers[marketId]; marketMarginTiers[marketId].push(...)` pattern. The old `marketMarginTiers` mapping is **retained** for backward-compatible reads by off-chain indexers; it mirrors the current version (index `currentVersion - 1`) or remains empty for version 0.
- Emits `ParameterBump` — now correctly, because the refactor delivers on the prospective-only promise.
- `MAX_TIER_VERSIONS` is a hard cap (suggested default: 50) to bound storage growth. See §7 on GC.

---

## 5. Read path — `_calculateTieredMargin`

Current signature reads `MarginTier[] storage tiers = marketMarginTiersProperty[marketId]` — the live tiers. New signature takes the version explicitly:

```
function _calculateTieredMargin(
    bytes32 marketId,
    uint256 notional,
    bool isInitial,
    uint256 version
) internal view returns (uint256) {
    if (version == 0) {
        // Legacy / no-snapshot fallback: use the market's flat rates.
        Market storage m = markets[marketId];
        uint256 flatBps = isInitial ? m.initialMarginBps : m.maintenanceMarginBps;
        return (notional * flatBps) / BPS;
    }

    MarginTier[] storage tiers = marketMarginTiersHistory[marketId][version - 1];

    // Existing tax-bracket-style accumulation loop, unchanged semantically.
    // ...
}
```

Callers update:

- **`openPosition` / `_reduceOrFlipPosition`** — for the initial-margin calculation of a *new or enlarged* position, use `marketCurrentTierVersion[marketId]`. For the maintenance-margin side (unchanged in these paths because they use the initial value), same rule.

- **`_isLiquidatable`** — this is the critical read site. Reads `positions[marketId][trader].marginTierVersion` and passes that to `_calculateTieredMargin`. **The position's snapshotted version, not the current one.** This is where the prospective-only invariant holds.

### 5.1 Snapshot on open

```
function openPosition(bytes32 marketId, address trader, int256 sizeDelta, uint256 price)
    ...
{
    Position storage pos = positions[marketId][trader];

    if (pos.size == 0) {
        // Fresh position — snapshot the current tier version.
        pos.marginTierVersion = marketCurrentTierVersion[marketId];
    }
    // Top-ups inherit the existing snapshot (pos.marginTierVersion unchanged
    // when pos.size != 0), consistent with A2ADarkPool and CollateralManager
    // patterns: position opens once, snapshot is sticky until full close.

    // ...rest of openPosition unchanged...
}
```

---

## 6. Full-close semantics

When a position fully closes (`size` returns to zero), `marginTierVersion` is reset to `0` as part of the close path, so a subsequent open on the same (market, trader) captures the then-current version rather than the stale prior one.

```
// In _closePosition or equivalent:
pos.marginTierVersion = 0;
```

---

## 7. Hard cap and future garbage collection

`MAX_TIER_VERSIONS` is a hard cap on how many historical versions a market can accumulate. Default suggestion: **50**.

Rationale:
- Tier bumps are expected to be rare (per-market, low frequency — not per-block).
- 50 bumps per market is a large operational budget even for an actively-tuned market.
- Storage growth is bounded.

What happens if the cap is reached: `setMarginTiers` reverts with `"MAX_TIER_VERSIONS exceeded"`. Operators have two paths:
1. **Wait for old versions to become unreferenced** as old positions close. Future `pruneVersion(marketId, version)` can remove storage for versions with zero remaining references (requires a reference counter — out of scope for v1).
2. **Redeploy the market** with a fresh `addMarket` — heavy-handed but explicit.

The reference counter + prune primitive is a future enhancement flagged in the code as a TODO. For v1, the cap + operational awareness is sufficient.

---

## 8. Migration path — none needed

SUR's PerpEngine is **constructor-deployed and not upgradeable**. This refactor lands as a new-deployment change, not an upgrade in place.

All positions in the freshly-deployed contract are opened against the new code path and receive a valid `marginTierVersion` snapshot. There is no legacy state to migrate.

(If there were — e.g., if SUR had a proxy — the migration would be: iterate over existing positions and set `marginTierVersion = 1`, plus bootstrap `marketMarginTiersHistory[*][0]` with the current live tiers. Irrelevant to this codebase, documented for reference.)

---

## 9. Edge cases

1. **`addMarket` called but `setMarginTiers` never called.** `marketCurrentTierVersion[market] == 0`. Positions opened against the flat rates. `_isLiquidatable` uses flat rates via the version==0 branch. Works as before, no regression.

2. **Market with tiers, position opened at version N, admin bumps to N+1, position checked for liquidation.** Position reads version N via snapshot. Correct.

3. **Position closed, admin bumps, same trader reopens in the same market.** Fresh open → `pos.size` was reset to 0 → snapshot captures current (N+1) version. Correct.

4. **Position reduced (partial close) crossing a tier boundary in its frozen array.** `_calculateTieredMargin` with the frozen array handles this — it iterates through tiers of the snapshot regime, same as current behavior does against live tiers. Semantics preserved.

5. **Admin bumps tiers mid-way through trader's `openPosition` transaction.** Not possible — `setMarginTiers` is `onlyOwner`, `openPosition` is `onlyOperator`, both take `whenNotPaused`, and Solidity tx ordering guarantees no interleaving.

6. **Storage cost of a tier-heavy market with many bumps.** Bounded by `MAX_TIER_VERSIONS × average tier count`. Example: 50 versions × 5 tiers × 3 uint256 per tier = 750 slots = ~15 KB storage per market with a long update history. Acceptable for the protection provided.

---

## 10. Test plan (for the implementation commit)

Test families, each with Given/Action/Expect:

- **`test_mapping3_marginTiers_bumpIsProspective_onExistingPosition`**  
  Open at tiers=v1 (init 5%/maint 2.5%). Admin bumps to v2 (init 10%/maint 5%). Existing position is NOT liquidatable despite the new maint being higher; the snapshot of v1 is used.

- **`test_mapping3_marginTiers_newPositionUsesNewVersion`**  
  After the bump, a second trader opens a position. Their `marginTierVersion` is 2. They are subject to the new 5% maintenance.

- **`test_mapping3_marginTiers_sizeGrowCrossesTierInFrozenArray`**  
  Open at $5K (tier 1 of v1). Grow to $50K. Required margin increases via tier 2 of v1 (the frozen array). Position is not short-circuited into a single tier.

- **`test_mapping3_marginTiers_fullCloseThenReopen_resetsSnapshot`**  
  Open at v1, admin bumps to v2, trader fully closes, reopens. New position has `marginTierVersion == 2`.

- **`test_mapping3_marginTiers_version0Fallback_withoutTiersConfigured`**  
  Market created via addMarket but never called setMarginTiers. Position opens with version 0. Margin checks use flat rates. No regression from pre-refactor behavior.

- **`test_mapping3_setMarginTiers_emitsParameterBump`**  
  Bump from v1 to v2 emits the event with the correct paramId (per-market, includes marketId).

- **`test_mapping3_setMarginTiers_hardCap_revertsAtMaxVersions`**  
  Bump MAX_TIER_VERSIONS times. The next call reverts.

- **`test_mapping3_setMarginTiers_liquidationAttackVector_closed`**  
  The full governance-attack scenario: a trader just shy of the old liquidation boundary, admin bumps maint margin. Pre-refactor, trader is liquidated. Post-refactor, trader is protected.

Full Foundry suite must remain green. Expected test count uplift: +8 Mapping 3 tests.

---

## 11. Interaction with previously-implemented PerpEngine Mapping 3

The previous PerpEngine commit (`8202626`) emitted `ParameterBump` from four risk-limit setters and explicitly **did not** emit from `setMarginTiers`, flagging the retroactive bug as pending. This refactor closes that pending item. The PerpEngine header comment on `ParameterBump` also references the pending refactor and should be updated in this implementation commit to remove the TODO and cite the refactor's landing.

---

## 12. Non-goals for this refactor

- **GC / version pruning primitive.** Flagged for future; not blocking.
- **Cross-market tier sharing.** Each market has its own version history.
- **Tier-array diff compression.** Storage is array-of-arrays, each full. If a bump changes one field, the whole array is re-stored. Acceptable; bump frequency is low.
- **Migration of positions between versions.** Positions cannot change their snapshot version without fully closing. This is the point of the snapshot.

---

## 13. Revision log

- **v1 (23 April 2026):** initial design. A.2 versioned history, `MAX_TIER_VERSIONS = 50` hard cap, version 0 as flat-rate fallback, no GC primitive in v1, no migration needed (fresh-deploy contract).
