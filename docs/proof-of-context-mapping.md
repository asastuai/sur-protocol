# Proof-of-Context → SUR Protocol — Design Mapping

**Destination path in repo:** `sur-protocol/docs/proof-of-context-mapping.md`
**Status:** design document (not implementation). No code changes implied by this document alone.
**Date:** 22 April 2026.
**Author:** Juan Cruz Maisu.
**References:**
- Position paper: [github.com/asastuai/proof-of-context](https://github.com/asastuai/proof-of-context) v0.6 (commit 9e7954d).
- Reference implementation scaffold: [github.com/asastuai/proof-of-context-impl](https://github.com/asastuai/proof-of-context-impl) v0.1.0-scaffold.

---

## 1. Why this document exists

The proof-of-context (PoC) paper formalized several architectural patterns that SUR Protocol was already solving by instinct from a different angle. The paper names the patterns, provides the threat model, and specifies the constraints a viable construction must satisfy. This document maps those patterns back down to concrete places in SUR where they apply.

The mapping is not hypothetical. Each item below identifies:

- **What in SUR the pattern applies to** (specific subsystem, settlement path, or admin handler).
- **What would change** (new field, new check, new invariant, new handler behavior).
- **How the change is bounded** (what it does *not* touch; what remains stable).
- **How it is tested** (the minimum observable behavior that proves the change works).

The document is written so that a future contributor — or the author after a long gap — can pick any one of the seven items and implement it as a standalone unit without needing to read the whole paper.

---

## 2. The seven mappings

### Mapping 1 — Freshness-at-pay-time as an explicit predicate on x402 settlement

**Pattern in paper:** §7 constraint 8 (freshness-at-pay-time), §3.6 (attestation-as-settlement). BaseOracle already operationalized this at the data layer; PoC generalizes it to the compute layer.

**What in SUR this applies to:** the x402 settlement path for trade execution and funding-rate payments. Every payment event currently assumes the oracle price and counterparty state that triggered it are "fresh enough" — an implicit predicate. PoC makes it explicit.

**What would change:**
- Every settlement handler reads a `freshness_proof` field from the incoming settlement message: `(trade_context_root, triple_anchor, oracle_round_hash, counterparty_state_hash)`.
- Before clearing the payment, the handler evaluates a `SettlementGate`-analogous check: is the oracle round recent enough? Is the counterparty state from the expected block-height window? Is the TEE-timestamp (when applicable) within skew?
- If any of the four freshness axes fails, the handler emits a `SettlementRejected(freshness_type)` event and does not clear. The protocol does not lose the trade claim — it surfaces the specific axis of staleness so the caller can re-submit or dispute.

**Bounded:**
- Does not change the core perp-futures accounting or the matching engine.
- Does not require any new on-chain cryptography — existing x402 signatures remain.
- Freshness thresholds are protocol-level parameters with conservative defaults (see `FreshnessThresholds::default_base_mainnet()` in the reference crate).

**Acceptance test:**
A deliberately-stale trade (constructed by replaying a cached attestation after the oracle has moved more than K blocks) is submitted to settlement; it is rejected with `SettlementRejected(FreshnessType::Model)`. A fresh trade with identical payload except for the freshness proof clears normally.

---

### Mapping 2 — Triple-anchor (block + TEE + Drand) for timing-sensitive operations

**Pattern in paper:** §7 constraint 6 plus the honest-threat-model caveat in §9. Three clocks with orthogonal failure physics. Under a valid TEE attestation chain the triple anchor defends against accidental skew and isolated single-clock failure; it does not defend against enclave compromise (that is the attestation chain's job).

**What in SUR this applies to:** liquidation engine, funding-rate accrual, any cron-like on-chain action whose correctness depends on "what time is it now".

**What would change:**
- Liquidation events carry a three-field timestamp: `(block_height, tee_timestamp_ns_if_applicable, drand_round)`.
- A divergence check on the three fields against protocol-defined skew thresholds (default from paper §9: ±2 blocks, ±5 s TEE, ±1 Drand round) is run before the liquidation effects apply.
- Divergence beyond threshold triggers a deferral (not a slash — this is timing-anchoring, not proof-of-context yet), with the liquidation retried on the next block.

**Bounded:**
- The TEE clock is optional — for liquidations performed by on-chain logic with no enclave in the path, it degrades to a two-clock anchor (block + Drand). The two-clock version is still strictly stronger than the current one-clock (block-only) scheme.
- Does not change liquidation economics (who gets liquidated at what price).
- Drand fetch can fail (we observed this during the paper's §9 measurement — `api.drand.sh` returned 502, the Cloudflare mirror succeeded). The handler treats a failed Drand fetch as a deferral, not a rejection, for a bounded retry window.

**Acceptance test:**
An attacker attempts to trigger a liquidation by presenting a stale `block_height` with a current `drand_round` (a plausible timing-manipulation under MEV). The divergence check detects the inconsistency and defers. The liquidation executes on the next block with consistent anchors.

---

### Mapping 3 — Prospective-only semantics for admin parameter updates

**Pattern in paper:** §7 constraint 5 (prospective-only root bumps). A publisher root bump never invalidates already-committed attestations; workers with in-flight commitments settle under the old rules. This is the simpler alternative to a publisher-bond mechanism and generalizes directly to DeFi parameter updates.

**What in SUR this applies to:** every admin handler that modifies a parameter consumed by live positions — fee tiers, funding-rate curves, collateral factors, pool weights, dispute windows.

**What would change:**
- Each parameter update emits a `ParameterBump(param_id, old_value, new_value, effective_block)` event.
- Live positions opened before `effective_block` continue to settle against `old_value` until they close; new positions opened at or after `effective_block` settle against `new_value`.
- A runtime-upgrade variant (analogue of §7 constraint 5's "runtime-upgrade notice period") applies for any update that materially changes the economics of holding a position: the admin must announce the update N blocks in advance, giving holders time to exit without loss.

**Bounded:**
- Does not touch emergency-parameter handlers (circuit breakers, halt switches) — those are by design retroactive, because they exist to stop ongoing harm.
- The prospective-only invariant is enforced at the position-accounting layer, not at the admin-handler layer; admin handlers continue to write the new value immediately, but the accounting reads the appropriate historical value for each position.

**Acceptance test:**
An admin bumps `funding_rate_multiplier` from 1.0 to 1.5 at block B. Positions opened at block B-10 continue to accrue funding at 1.0 until they close. A position opened at block B+1 accrues at 1.5. The test asserts both.

---

### Mapping 4 — Four freshness types mapped to SUR-specific failures

**Pattern in paper:** §6 decomposition (`f_c`, `f_m`, `f_i`, `f_s`). Each type fails differently and requires different measurement.

**What in SUR this applies to:** the protocol's instrumentation and the event schema for settlement rejections.

**SUR-specific readings of each type:**
- **`f_c` — computational freshness.** Latency between trade submission (sign) and on-chain clearance. Currently implicit in block inclusion; PoC makes it a first-class parameter. Failure: worker signs a trade, holds it for many blocks, submits it when the price has already moved.
- **`f_m` — model/feed freshness.** Oracle round or price-feed version used for a liquidation or settlement. Failure: a liquidation is triggered using a Chainlink round that is multiple rounds behind the current canonical round.
- **`f_i` — input freshness.** Counterparty collateral state, order-book depth, or tool-call results consumed by the computation. Failure: a match is settled based on a counterparty snapshot that precedes a collateral withdrawal.
- **`f_s` — settlement freshness.** Window between trade-commit and on-chain clear. Failure: a counterparty sits on a committed trade for too long, disadvantaging the other side.

**What would change:**
- `SettlementRejected` events carry the violated `FreshnessType` as a typed field.
- Operator dashboards and auditors get a clean histogram of which axis is most often violated in production — actionable information for both threshold tuning and incident investigation.

**Bounded:**
- No new on-chain logic required beyond the event-schema field.
- Thresholds are configurable per market (a perp on a volatile asset wants tighter `f_m`; a stable-asset perp can tolerate wider).

**Acceptance test:**
Instrumented staging produces four categories of synthetic staleness, one per type, and the rejection events emit with the correct `FreshnessType` tag.

---

### Mapping 5 — Trade-context root as a SUR-specific execution-context root

**Pattern in paper:** §8 (execution-context root). A Merkle commitment binding every protocol-relevant component of the execution environment. Anything not in the root is a trivial evasion vector.

**What in SUR this applies to:** the A2A Dark Pool match-settlement path — the most economically sensitive point in the protocol.

**Minimum trade-context root for SUR:**

```
trade_context_root = Merkle(
    order_id,
    counterparty_a_sig,
    counterparty_b_sig,
    price_oracle_round,
    price_oracle_feed_id,
    collateral_state_root_a,
    collateral_state_root_b,
    block_height,
    tee_timestamp_if_available,
    drand_round,
    fee_schedule_version,
    funding_rate_version,
)
```

**What would change:**
- Every A2A trade submitted to settlement carries this root.
- Settlement verification recomputes the root from the underlying state and checks equality.
- Any field that differs between commit-time and settle-time causes the settlement to defer or reject, with a typed reason.

**Bounded:**
- Scope of the root is an explicit, versioned protocol parameter (`TRADE_CONTEXT_ROOT_SCHEMA_v1`). Adding fields requires a protocol version bump with a prospective-only rollout (see Mapping 3).
- Does not touch off-chain matching — only the moment a match becomes a settlement claim.

**Acceptance test:**
A trade is submitted with a valid `trade_context_root`. A replay of the same trade bytes after the Chainlink round has advanced produces a different root-recompute on the verifier side and is rejected with `FreshnessType::Model` (oracle round mismatch).

---

### Mapping 6 — Reframing: "settlement-gated perp DEX"

**Pattern in paper:** §3.6 verification-vs-settlement axis. The paper's central reframing: PAL\*M is attestation-as-verification; proof-of-context is attestation-as-settlement.

**What in SUR this applies to:** positioning, documentation, public-facing README, outreach material.

**What would change:**
- The SUR README tagline moves from "verified perp DEX" (or whatever the current framing is) to "settlement-gated perp DEX" once Mappings 1-5 are in.
- Cold outreach to LPs and agent traders uses the new framing, because it names what the protocol actually *protects against* (settlement on stale context), not just what it *does* (execute perps).
- Documentation gains a short "threat model" section that distinguishes "correctness of the swap" (already handled by existing math) from "validity at settlement time" (what PoC adds).

**Bounded:**
- Documentation-only change for the positioning layer. Does not touch code.

**Acceptance test (soft):**
A non-technical reader of the updated README can, within 30 seconds, articulate the difference between "Sur verifies the trade math" and "Sur gates settlement on freshness". If they conflate the two, the framing has not landed.

---

### Mapping 7 — A2A Dark Pool as the first real PoC deployment

**Pattern in paper:** §10 (Author Background and Deployment Path) explicitly positions SUR as the deployment testbed for proof-of-context: "the settlement rail, agentic counterparty model, on-chain reputation layer, and micropayment infrastructure are already in place".

**What in SUR this applies to:** a feature-flag in the A2A Dark Pool — `settlement_gating=proof_of_context` — that activates the full PoC flow for a subset of markets, while legacy markets continue with the current settlement path. This allows gradual rollout without a protocol-wide commitment.

**What would change:**
- A new module `sur-protocol/contracts/src/PoCGate.sol` (or Rust equivalent in the off-chain side) that consumes the reference implementation's types.
- Feature-flagged activation per market: low-volume markets first, canary markets, then full rollout.
- Gas accounting for the PoC verification step, published per-market, so LPs can evaluate the overhead against its security value.

**Bounded:**
- Not a hard fork — existing markets continue unchanged while PoC-gated markets come online alongside them.
- Economic risk during the canary period is bounded by market size.

**Acceptance test:**
A PoC-gated canary market processes at least N trades end-to-end on Base testnet with zero false rejections under honest conditions and correct rejection under synthetic staleness. N and the threshold values are set in the canary's configuration, not in this document.

---

## 3. Phased implementation plan

The seven mappings are not all the same cost. In increasing order:

**Phase 1 (cheapest, can pilot now):**
- **Mapping 3** (prospective-only parameter updates). Pure convention + accounting-layer read of the appropriate historical parameter value. Auditable in a short window. No new dependencies.
- **Mapping 6** (framing / documentation). Pure docs.

**Phase 2 (moderate, requires new dependencies):**
- **Mapping 2** (triple-anchor on liquidations). Requires Drand client in the settlement pipeline. No cryptography beyond signature verification.
- **Mapping 4** (freshness-type event schema). Additive event fields + histogram instrumentation.

**Phase 3 (requires the reference crate at Phase 2):**
- **Mapping 1** (freshness-at-pay-time on x402). Requires `SettlementGate` trait from the reference crate.
- **Mapping 5** (trade-context root). Requires `ExecutionContextRoot` Merkle scheme from the reference crate.

**Phase 4 (requires the reference crate at Phase 3):**
- **Mapping 7** (canary PoC-gated market). Requires TEE attestation chain from the reference crate plus full SUR integration.

## 4. Open questions (to be resolved during implementation)

1. **Canonical oracle for `f_m`.** Chainlink rounds are the obvious choice for price feeds, but SUR may integrate multiple oracles per market. The protocol-level definition of "current canonical round" for a multi-source market is not yet decided.
2. **Drand fallback policy.** Primary (`api.drand.sh`) failed during the paper's measurement run; Cloudflare mirror worked. The production policy for Drand availability (retries, fallback URLs, timeout-vs-reject tradeoff) is pending.
3. **Per-market freshness tuning.** Mapping 4 admits per-market thresholds. The governance / admin process for setting these is not yet part of SUR's admin schema.
4. **TEE availability in the SUR path.** Mappings 2 and 5 reference TEE timestamps as one of the three anchors. Whether SUR components run inside TDX + H100 enclaves is a deployment decision, not a protocol decision — both two-clock (no TEE) and three-clock (with TEE) variants of the anchor should be supported.

## 5. Not in scope

- Any change to perp-futures pricing math, funding-rate formulas, or liquidation economics.
- Any change to the A2A Dark Pool's off-chain matching. PoC only touches the moment a match becomes a settlement claim.
- Any change to x402 itself. The x402 message schema gains a `freshness_proof` field but the underlying payment rail is untouched.
- Any immediate on-chain deployment to mainnet SUR markets. All mappings above are initially testnet-scope, with Mapping 7 defining the canary rollout criteria.

---

## 6. Reference crate integration points (forward)

As `proof-of-context-impl` matures through its own phases, the integration points in SUR are:

| SUR mapping | Requires crate phase | Reference-crate types/traits |
|---|---|---|
| Mapping 1 | ≥2 | `SettlementGate`, `FreshnessCommitment`, `FreshnessThresholds` |
| Mapping 2 | 1 (scaffold OK) | `TripleAnchor` (struct only; logic built Sur-side) |
| Mapping 3 | — (no crate needed) | pure SUR convention |
| Mapping 4 | 1 (scaffold OK) | `FreshnessType` enum |
| Mapping 5 | ≥2 | `ExecutionContextRoot`, `merkle_root()` |
| Mapping 6 | — (docs only) | — |
| Mapping 7 | ≥3 | full trait set + TEE attestation chain |

---

## 7. Revision log

- **v1 (22 April 2026):** initial mapping. Produced as the concrete output of decanting the proof-of-context paper (v0.6) into SUR-actionable form. No implementation yet.
