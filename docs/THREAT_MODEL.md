# Threat Model

This document articulates what SUR Protocol protects against today, what it does *not* protect against, and the separation between *computational correctness* (already addressed) and *settlement validity* (the gap proof-of-context integration is designed to close).

It is written for auditors, LPs, agent traders, and protocol integrators who need to know precisely where the guarantees stop before they allocate capital or build on top.

---

## 1. What SUR currently protects against

### 1.1 Custody
USDC collateral is held in `PerpVault.sol`. No operator, admin, or off-chain component holds user funds. Withdrawals are a function of on-chain position state, not an operator signature. A compromise of the off-chain infrastructure (matching engine, API, web frontend) cannot by itself cause loss of custody.

### 1.2 Settlement finality
Trades match off-chain but settle on-chain via `OrderSettlement.sol` under EIP-712 signed orders. Once a batch is submitted and the block finalizes, the settlement is irrevocable under standard Base-L2 finality assumptions.

### 1.3 Margin and liquidation correctness
Position accounting, PnL computation, and liquidation logic live in `PerpEngine.sol` and `Liquidator.sol`. The *math* of these operations is covered by 494 passing Foundry tests. If your position is flagged for liquidation, the amount liquidated and the price at which it is liquidated are computed by on-chain code the user can audit.

### 1.4 Oracle integrity (primary feed)
`OracleRouter.sol` consumes Pyth and Chainlink price feeds with deviation checks and normalization. A price outside the deviation bound is rejected. A price from a stale round — defined by the underlying feed's publication criteria — is rejected at the oracle layer.

### 1.5 Bad-debt absorption
`InsuranceFund.sol` absorbs bad debt from failed liquidations. Its balance is public and tracked. The fund draining to zero is an observable event with operator response paths (documented in `INCIDENT_RESPONSE.md`).

---

## 2. What SUR does NOT currently protect against

The following categories of failure are **not** blocked by the current protocol and are the explicit scope of the proof-of-context integration roadmap (`docs/proof-of-context-mapping.md`).

### 2.1 Settlement against stale contextual state
An on-chain match can clear against an oracle round that was the latest round when the match was signed off-chain, but is no longer the latest round when the on-chain settlement transaction is included. The math of the settlement is correct against the signed price. The *economic meaning* of the settlement may not be, if the price has moved materially in the intervening blocks.

**Why this isn't addressed by the current oracle deviation check:** the deviation check compares the submitted price against the current on-chain price. A match signed against price `P₀` and submitted when the current price is `P₁` within the deviation threshold clears — but the counterparty whose side was disadvantaged by `P₁ - P₀` has no recourse. Proof-of-context's `f_m` (model/feed freshness) gating makes this an explicit rejection rather than an implicit tolerance.

### 2.2 Timing manipulation of liquidations
The liquidation engine reads "current" block height and "current" oracle round. An attacker with short-term influence over block ordering (MEV-class capability) or short-term control over the timing of an oracle update can construct a scenario where a liquidation executes under a combination of block-timestamp and oracle-round that is individually valid but jointly anomalous. Proof-of-context's triple-anchor (block height + TEE timestamp + Drand round) introduces an orthogonal clock so this joint anomaly is detectable and deferrable rather than silently executed.

### 2.3 Retroactive impact of admin parameter updates
If a protocol admin updates a parameter consumed by live positions — a fee tier, a funding-rate multiplier, a collateral factor — the change currently takes effect immediately and affects all positions including those already open. A malicious or mistaken admin can retroactively harm open positions. Proof-of-context's *prospective-only semantics* (see `MAPPING_3_prospective_params.md` for the SUR-specific design) enforces the invariant that parameter bumps do not retroactively alter the economic terms of positions opened before the bump.

### 2.4 Counterparty-state drift
A match can be constructed off-chain against a counterparty snapshot that precedes a collateral withdrawal. The on-chain collateral check at settlement catches insufficient collateral, but the full *counterparty intent freshness* — "was this counterparty in the state they believed they were in when they signed?" — is not verified as a first-class protocol concept. Proof-of-context's `f_i` (input freshness) framing makes this surface explicit.

### 2.5 Settlement-window griefing
A counterparty can sit on a committed match for an extended period, submitting it when conditions have moved against the other side. The current protocol has no explicit `f_s` (settlement freshness) window; matches are valid until explicitly cancelled or expired by the matching engine's own heuristics. Proof-of-context introduces a per-market maximum settlement window as a first-class parameter.

---

## 3. Separation: computational correctness vs. settlement validity

A useful framing for understanding where the current protocol ends and where proof-of-context begins:

| Question | Current SUR | Proof-of-context integration |
|---|---|---|
| Is the math correct? | ✅ yes, 494 tests | — (no change; PoC is strictly additive) |
| Does the signer actually exist? | ✅ EIP-712 verification | — |
| Is collateral sufficient? | ✅ on-chain check | — |
| Is the oracle price within deviation bounds? | ✅ `OracleRouter` | — |
| **Is the oracle round still fresh at settlement time?** | ❌ not checked | ✅ `f_m` gating |
| **Is the counterparty state still the one they signed against?** | partial | ✅ `f_i` gating |
| **Are block / TEE / Drand clocks consistent at critical moments?** | ❌ single-clock | ✅ triple-anchor |
| **Has the match been held too long?** | ❌ no hard window | ✅ `f_s` gating |
| **Do admin param updates respect open positions?** | ❌ retroactive | ✅ prospective-only |

The gap is not that the computation is wrong. The gap is that a correct computation against stale context can clear payment. Proof-of-context closes that gap without touching the computation itself.

---

## 4. Threat model assumptions

The above guarantees hold under the following assumptions; they do not hold if any of these is violated.

1. **Base L2 sequencer honesty and liveness.** If the Base sequencer is compromised or halted beyond the chain's recovery mechanisms, on-chain settlement cannot progress regardless of SUR's logic.
2. **Pyth and Chainlink oracle honesty.** A fundamentally corrupted oracle source cannot be detected by freshness-gating alone; the deviation check catches gross manipulation but coordinated cross-source manipulation is out of scope for this protocol.
3. **Matching engine availability.** SUR does not guarantee that a trade *can* be matched — off-chain liveness failures result in trades that cannot settle. Users retain custody via `PerpVault.sol` regardless.
4. **EIP-712 signature integrity.** If a user's signing key is compromised, the attacker can sign orders as that user. Key custody is the user's responsibility.
5. **Insurance fund solvency.** Bad debt larger than the insurance fund balance results in socialized losses per the documented fallback policy. This is an explicit design trade-off, not a gap.

---

## 5. Scope note on the proof-of-context integration roadmap

The proof-of-context integration (`docs/proof-of-context-mapping.md`) is a *roadmap*, not a claim of existing capability. At the time of this document's authorship, no SUR market has the PoC gating mechanisms active. The integration will roll out per the phased plan in the mapping document, starting with the cheapest items (prospective-only parameters; documentation framing) and progressing toward the canary PoC-gated market only after the reference implementation crate (`github.com/asastuai/proof-of-context-impl`) reaches the appropriate phase.

Until then, the gaps documented in §2 are known gaps. This document exists so that a rational actor — auditor, LP, agent integrator — can evaluate SUR's current guarantees precisely and decide accordingly.

---

## 6. Revision log

- **v1 (22 April 2026):** initial threat model document. Produced as part of the Mapping 6 (framing) item of the proof-of-context integration roadmap. No changes to protocol code implied.
