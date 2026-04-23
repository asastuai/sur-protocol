# MAPPING 2 — Triple-Anchor on Liquidations

**Companion to:** [`proof-of-context-mapping.md`](proof-of-context-mapping.md) Mapping 2.
**Scope:** design specification. No code changes in this document.
**Status:** design ready; implementation blocked on Drand-on-Base integration decision (§5).

---

## 1. The problem

The current liquidation path in `Liquidator.sol` reads a single clock: the chain-local clock implied by `block.timestamp` at the moment the liquidation transaction executes. Liquidatability itself is determined by `PerpEngine.isLiquidatable()`, which compares position state against the oracle price at settlement time — a price tied to the oracle round that was the most recent one on-chain when the liquidation transaction was included.

This is a **single-clock** system. An attacker with short-term influence over the combination of (a) block ordering / MEV capability, (b) oracle-round arrival timing, or (c) both, can construct scenarios where a liquidation executes under a combination that is individually valid but jointly anomalous. The chain cannot detect the anomaly because it has no independent clock to compare against.

The proof-of-context paper's §7 constraint 6 proposes anchoring timing-critical operations against three clocks with orthogonal failure physics:

- **Block height** — chain-local clock. Vulnerable to MEV, reordering, chain reorg.
- **TEE timestamp** — enclave-local clock (when applicable). Vulnerable to manipulation inside a compromised enclave.
- **Drand round** — external threshold-BLS clock at 30-second granularity. Vulnerable to compromise of 2/3 of the Drand League of Entropy.

Divergence between the three beyond expected skew is cause to *defer* the liquidation, not slash. The keeper retries on the next block with an updated anchor set.

**Honest threat model caveat** (paper §9): under a valid TEE attestation chain, the triple anchor defends against accidental skew and isolated single-clock failure. It does *not* defend against a compromised enclave that echoes the other two clocks. For SUR's liquidator — which currently has no TEE in the path at all — the anchor degrades to a two-clock system (block height + Drand round). Even two clocks is strictly stronger than the current one-clock scheme.

---

## 2. Proposed design for SUR

### 2.1 Two-clock baseline (no TEE in path)

SUR liquidation is currently a permissionless on-chain call; there is no enclave in the path. The Mapping 2 baseline is therefore:

```
(block_height, drand_round)
```

The liquidator (keeper) submits the liquidation call along with a `DrandProof` structure that attests the Drand round they claim is current. An on-chain `DrandVerifier` contract validates the proof and the `Liquidator` contract checks divergence between `block.number` and the attested `drand_round` against the protocol-defined skew window.

### 2.2 Three-clock variant (when TEE-keepers exist)

Future SUR keeper infrastructure may run inside TDX + H100 enclaves (for example, when keepers are agentic workers bidding in the A2A Dark Pool). In that case the keeper submits additionally:

```
(tee_timestamp_ns, tee_attestation_quote)
```

and the `Liquidator` contract (or an off-chain verifier with on-chain slashing hooks) validates the attestation quote against a known-good enclave-measurement registry before using the TEE timestamp in the divergence check.

### 2.3 What changes in `Liquidator.sol`

New struct:

```solidity
/// Triple-anchor attestation submitted alongside a liquidation call.
/// tee_* fields are zero when the keeper is not running inside a TEE.
struct LiquidationAnchor {
    uint256 blockHeight;        // Must equal block.number at call time (or block.number - 1 on latency edge).
    uint64  drandRound;         // Drand mainnet round number the keeper claims is current.
    bytes   drandSignature;     // BLS signature for the claimed round (verified by DrandVerifier).
    uint64  teeTimestampNs;     // Enclave-reported Unix nanoseconds (0 if no TEE).
    bytes   teeAttestationQuote; // TDX/H100 attestation (empty if no TEE).
}
```

Modified function signatures:

```solidity
function liquidate(bytes32 marketId, address trader, LiquidationAnchor calldata anchor)
    external whenNotPaused;

function liquidateBatch(
    bytes32[] calldata marketIds,
    address[] calldata traders,
    LiquidationAnchor calldata anchor  // one anchor for the batch is fine;
                                       // the batch itself has a single clock
) external whenNotPaused;

function liquidateAccount(address trader, LiquidationAnchor calldata anchor)
    external whenNotPaused;
```

A new internal check runs before the engine call:

```solidity
function _verifyAnchor(LiquidationAnchor calldata anchor) internal view {
    // 1. Block height: must equal block.number (tolerance 1 block to cover
    //    the gap between the keeper reading height off-chain and tx inclusion).
    if (anchor.blockHeight != block.number && anchor.blockHeight != block.number - 1)
        revert AnchorBlockDivergence();

    // 2. Drand: verify the BLS signature via the DrandVerifier and check
    //    that the claimed round matches "current" Drand by schedule.
    if (!drandVerifier.verifyRound(anchor.drandRound, anchor.drandSignature))
        revert AnchorDrandInvalid();
    uint256 expectedRound = drandVerifier.currentRoundByWallTime(block.timestamp);
    if (_absDiff(anchor.drandRound, expectedRound) > DRAND_SKEW_TOLERANCE)
        revert AnchorDrandDivergence();

    // 3. TEE (optional): if any tee_* field is non-zero, verify attestation
    //    and check that tee_timestamp_ns is consistent with the Drand round
    //    and block height.
    if (anchor.teeAttestationQuote.length > 0) {
        attestationVerifier.verifyQuote(anchor.teeAttestationQuote);
        // Consistency check: tee_timestamp_ns should fall within the
        // block.timestamp ± tolerance window.
        if (_teeSkewTooHigh(anchor.teeTimestampNs, block.timestamp))
            revert AnchorTeeDivergence();
    }
}
```

### 2.4 Default skew tolerances (from paper §9 empirical calibration)

- `BLOCK_SKEW_TOLERANCE = 1` block (Base L2 target 2 s/block, keeper sees current height ± 1).
- `DRAND_SKEW_TOLERANCE = 1` round (±30 s at mainnet cadence; absorbs CDN propagation variance).
- `TEE_SKEW_TOLERANCE = 5` seconds (two orders of magnitude above documented 15 ppm honest drift; conservative).

These are protocol constants rather than admin parameters; changing them requires a full protocol upgrade, not a hot-swappable setter. Rationale: tightening them creates false-positive liquidation rejections; loosening them weakens the anchor's protection. Either direction deserves governance review.

---

## 3. Failure-mode semantics

A divergence trips **deferral**, not slash. The liquidation transaction reverts with one of:

- `AnchorBlockDivergence`
- `AnchorDrandInvalid`
- `AnchorDrandDivergence`
- `AnchorTeeDivergence`

The keeper retries on the next block with updated anchor values. No funds move, no position state changes.

Rationale for deferral rather than slash:

- The anchor is a freshness check, not a fraud check. Divergence under MEV or oracle latency is possible without adversarial intent.
- The existing keeper-reward economics already incentivize keepers to retry quickly — a deferred liquidation is a lost reward opportunity, not a recoverable loss.
- Slashing here would require a separate stake mechanism for keepers, which SUR does not currently have. Introducing it is orthogonal to this mapping.

---

## 4. Interaction with existing circuit breakers

`PerpEngine.setCircuitBreakerParams` and `OracleRouter.setOracleCircuitBreakerParams` remain retroactive (see [`MAPPING_3_prospective_params.md`](MAPPING_3_prospective_params.md) §3.2). If a circuit breaker is tripped during a liquidation attempt, the existing behavior takes priority and the anchor check is bypassed by the `whenNotPaused` / circuit-breaker-state checks that already guard the liquidation path.

This means: a pause or circuit-break event halts *all* liquidations, including anchor-verified ones. Anchor verification only applies to the non-emergency path.

---

## 5. Critical dependency — Drand verification on Base L2

Mapping 2 implementation is **blocked on a deployment decision** for Drand verification on Base. Three options:

### Option A — On-chain BLS verification

Deploy a `DrandVerifier.sol` that performs BLS signature verification against the Drand League-of-Entropy public key. Most secure; most gas-expensive. BLS verification on EVM is ~500k-1M gas per call, which adds meaningful cost to every liquidation.

### Option B — Trusted relayer with on-chain commitment

A SUR-operated relayer subscribes to Drand's primary and Cloudflare-mirror endpoints, signs each round with a protocol-managed key, and posts signed rounds to `DrandVerifier.sol` on a rolling basis. Liquidator reads the latest posted round. Adds a trust assumption on the relayer.

### Option C — Hybrid: relayer with optional challenge window

Relayer posts rounds as in Option B. A challenge mechanism allows anyone to post a BLS proof demonstrating the relayer posted a wrong round, which slashes a relayer bond. Combines Option B's gas profile with Option A's security-in-the-limit, at the cost of introducing a new economic primitive (relayer bond + challenge flow).

### Recommendation

**Option B for v1 deployment** (lowest cost, fastest path to a working anchor), with an explicit plan to migrate to **Option C after v1 is stable**. The migration is a drop-in upgrade of the verifier contract address at the Liquidator level; no change to the `LiquidationAnchor` struct or keeper-side code is required.

Option A is over-engineered for the economic exposure of the first PoC-gated markets. It remains available if a specific market's value-at-risk justifies the gas overhead.

---

## 6. Acceptance tests

### 6.1 Honest keeper liquidation clears

```
Given:
  - A liquidatable position exists at block B
  - Keeper fetches Drand round R via Cloudflare mirror
Action:
  - Keeper calls liquidate(marketId, trader, anchor)
    where anchor.blockHeight = B, anchor.drandRound = R,
    anchor.drandSignature is valid for round R
Expect:
  - Position is liquidated
  - LiquidationExecuted event emitted with standard fields
  - LiquidationAnchorVerified event emitted with (B, R, 0, 0)
```

### 6.2 Stale Drand round is rejected

```
Given:
  - A liquidatable position exists at block B
Action:
  - Keeper submits anchor with drandRound R where
    |R - currentExpectedRound| > DRAND_SKEW_TOLERANCE
Expect:
  - Transaction reverts with AnchorDrandDivergence
  - No position state changes
  - No LiquidationExecuted event
```

### 6.3 Invalid Drand signature is rejected

```
Given:
  - A liquidatable position exists
Action:
  - Keeper submits anchor with a forged drandSignature
Expect:
  - Transaction reverts with AnchorDrandInvalid
```

### 6.4 Block-height divergence larger than tolerance is rejected

```
Given:
  - A liquidatable position exists at block B
Action:
  - Keeper submits anchor with blockHeight = B - 2 (outside the 1-block tolerance)
Expect:
  - Transaction reverts with AnchorBlockDivergence
```

### 6.5 TEE-attested liquidation (when TEE path is active)

```
Given:
  - A liquidatable position exists
  - Keeper runs inside a known-good TDX enclave
Action:
  - Keeper submits anchor with non-zero tee_* fields + valid attestation
Expect:
  - Position liquidated
  - LiquidationAnchorVerified event emitted with all three fields populated
```

### 6.6 Retroactive counter-test — MEV reorder attack

```
Given:
  - Two competing liquidation transactions in the mempool
  - Attacker has short-term block-ordering capability
Action:
  - Attacker reorders blocks so tx A (with anchor for block B) lands at block B+2
Expect:
  - Tx A reverts with AnchorBlockDivergence
  - No partial state change
  - Honest keeper's retry tx at block B+2 with updated anchor clears
```

---

## 7. Rollout plan

1. Deploy `DrandVerifier.sol` (Option B relayer model) to Base Sepolia. Run the relayer for two weeks, recording Drand availability and round-arrival latency distribution.
2. Add `LiquidationAnchor` struct and `_verifyAnchor` to `Liquidator.sol` behind a feature flag. The feature flag allows both legacy and anchor-required liquidation paths to coexist during migration.
3. Run existing 494-test Foundry suite to ensure no regression on legacy path. Add the six acceptance-test families from §6 for the anchor path.
4. Enable the feature flag on one low-volume Base Sepolia market for one week of canary operation. Monitor `LiquidationAnchorVerified` vs `AnchorXxxDivergence` revert rate.
5. Broaden to all Base Sepolia markets for one month.
6. Mainnet rollout only after (a) Option C challenge-window design is specified or (b) governance explicitly accepts Option B's trust assumption for Phase 1.

---

## 8. Scope exclusions

- **Non-liquidation timing-sensitive operations.** Settlement, funding-rate accrual, and dark-pool matches also depend on "current time" but are out of scope for this mapping. Mapping 1 (freshness-at-pay-time on x402) handles settlement timing; funding-rate accrual is candidate for a separate future mapping.
- **Keeper stake and slashing economics.** Deferral is the failure mode; slashing is out of scope.
- **On-chain BLS verification.** Option A is documented but not the Phase 1 path.
- **Cross-chain Drand verification** (e.g., for a future L3 deployment of SUR). Assumes Base L2 as the canonical settlement chain.

---

## 9. Open design decisions

1. **Feature flag vs hard cutover.** A feature flag is safer for mainnet migration but doubles the code-path surface and complicates the audit story. Alternative: deploy a new Liquidator address with anchor-required path and migrate markets one at a time via admin.
2. **One anchor per batch vs one anchor per liquidation within a batch.** The current design has one anchor for the whole batch (simpler, gas-cheaper). This is acceptable if the batch represents a single time-consistent action — liquidating several positions that became undercollateralized against the same price move. For batches that span multiple price epochs, per-liquidation anchors may be required. Deferred until production batches are measured.
3. **Drand chain identity.** Drand has multiple chains (default, fastnet, quicknet). The paper measurement used the default chain (30 s period, pedersen-bls-chained scheme). Using the same chain in production is the current choice, but quicknet (3 s period) is strictly better for latency-sensitive use cases and may be worth evaluating when it is production-mature.

---

## 10. Revision log

- **v1 (23 April 2026):** initial design. Two-clock baseline (block + Drand), three-clock variant when TEE keepers exist, deferral-not-slash semantics, Option B relayer for Drand verification with Option C migration path. No code changes yet.
