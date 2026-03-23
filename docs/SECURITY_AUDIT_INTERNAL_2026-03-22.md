# SUR Protocol — Internal Security Audit Report

**Date:** 2026-03-22
**Auditor:** Claude Opus 4.6 (5 parallel instances)
**Scope:** 11 contracts, ~5,450 lines of Solidity
**Method:** Line-by-line review with severity ratings

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 7 |
| HIGH | 16 |
| MEDIUM | 22 |
| LOW | 16 |
| INFO | 8 |

---

## CRITICAL FINDINGS

### C-1: PerpEngine — Reentrancy via vault.internalTransfer (No nonReentrant Guard)
- **Location:** Multiple functions (openPosition, closePosition, liquidatePosition, addMargin, removeMargin, applyFundingRate)
- **Description:** PerpEngine makes ~20 external calls to `vault.internalTransfer()` scattered across internal functions. No reentrancy mutex exists. State updates frequently happen after external calls (e.g., in `_openNewPosition`, margin transfer occurs before OI updates).
- **Impact:** Reentrancy attack could allow double-settlement of PnL, manipulation of OI, or draining of balances.
- **Fix:** Add OpenZeppelin's `ReentrancyGuard` with `nonReentrant` modifier on all externally-callable state-changing functions.

### C-2: PerpEngine — Funding Payment Uses feeRecipient as Funding Pool
- **Location:** `_applyFunding()` lines 490-499
- **Description:** When shorts receive funding (fundingPayment < 0), the contract transfers FROM `feeRecipient` TO the trader. If feeRecipient runs dry, ALL position modifications revert, halting the entire protocol.
- **Impact:** Protocol-wide DoS if feeRecipient balance is insufficient. Protocol fees and funding flows are mixed.
- **Fix:** Use a dedicated funding pool account. Funding should flow between longs and shorts, not through fee collection.

### C-3: OrderSettlement — No Execution Price Validation Against Signed Limit Prices
- **Location:** `_settleTrade()` lines 245-327
- **Description:** The operator-provided `executionPrice` is never checked against `maker.price` or `taker.price`. A compromised operator can settle at any arbitrary price.
- **Impact:** Traders' signed limit prices are not enforced on-chain. Operator can rob traders by settling at unfavorable prices.
- **Fix:**
```solidity
if (taker.isLong) {
    require(trade.executionPrice <= taker.price, "Taker price exceeded");
    require(trade.executionPrice >= maker.price, "Maker price exceeded");
} else {
    require(trade.executionPrice >= taker.price, "Taker price exceeded");
    require(trade.executionPrice <= maker.price, "Maker price exceeded");
}
```

### C-4: OrderSettlement — No Execution Size Validation Against Signed Order Sizes
- **Location:** `_settleTrade()` lines 245-327
- **Description:** `trade.executionSize` is never validated against `maker.size` or `taker.size`. Operator can force positions larger than authorized.
- **Impact:** Traders could be forced into positions much larger than they signed for.
- **Fix:** `require(trade.executionSize <= maker.size && trade.executionSize <= taker.size)`

### C-5: PerpVault — Collateral Credits Enable Unbacked USDC Withdrawals
- **Location:** `creditCollateral` line 298 + `withdraw` line 193
- **Description:** `creditCollateral` increases `balances[trader]` without actual USDC entering the vault, but `withdraw` checks the same `balances` mapping. Mixed deposit/collateral balances create accounting issues.
- **Impact:** Users with collateral credits could withdraw real USDC beyond their actual deposit.
- **Fix:** Maintain separate `depositBalance` and `collateralBalance` mappings. Only `depositBalance` should be withdrawable via `withdraw()`.

### C-6: TradingVault — _getVaultEquity Missing Unrealized PnL (TODO in Code)
- **Location:** `_getVaultEquity` lines 416-422
- **Description:** Equity calculation only includes free USDC balance, ignoring all open position PnL. There is a TODO comment acknowledging this.
- **Impact:** ALL share issuance, redemption, fee calculation, and drawdown checks are wrong. This is a fundamental functional bug.
- **Fix:** Query PerpEngine for all vault positions' unrealized PnL and include in equity calculation.

### C-7: CollateralManager — No Mechanism to Liquidate Undercollateralized Positions
- **Location:** Entire contract
- **Description:** No function exists to liquidate or force-withdraw collateral when its value drops below the credited USDC amount. Bad debt accumulates silently during market downturns.
- **Impact:** Protocol becomes undercollateralized during market downturns with no recovery mechanism.
- **Fix:** Implement `liquidateCollateral` function callable by keepers.

---

## HIGH FINDINGS

### H-1: PerpEngine — Liquidation Checks Maintenance Before Applying Funding
- **Location:** `liquidatePosition()` lines 964-969
- **Description:** `_isBelowMaintenance()` check uses pre-funding margin. Positions that would be solvent after receiving pending funding could still be liquidated.
- **Fix:** Move `_applyFunding(marketId, trader)` BEFORE `_isBelowMaintenance()` check.

### H-2: PerpEngine — Cross-Margin removeMargin Equity Check Incorrect
- **Location:** `removeMargin()` lines 1314-1322
- **Description:** Equity check subtracts `amount` but removing margin to free balance is a wash for total equity in cross-margin mode.
- **Fix:** Check that `equity >= totalMaint` without subtracting amount.

### H-3: PerpEngine — closePosition Does Not Check Fresh Price
- **Location:** `closePosition()` lines 418-444
- **Description:** Unlike `openPosition`, `closePosition` has no `_requireFreshPrice` check.
- **Fix:** Add `_requireFreshPrice(marketId)` to `closePosition()`.

### H-4: PerpEngine — Funding Rate Has No Cap
- **Location:** `applyFundingRate()` lines 462-468
- **Description:** No cap on funding rate or on number of periods applied at once. If keeper is offline, accumulated funding can wipe out all margin.
- **Fix:** Cap rate per interval (e.g., max 0.1% per 8h). Cap max periods per call (e.g., 3).

### H-5: PerpEngine — _calculatePriceImpact Uses msg.sender Instead of Trader
- **Location:** `_calculatePriceImpact()` line 632
- **Description:** Event `PriceImpactApplied` logs `msg.sender` (the operator), not the actual trader.
- **Fix:** Pass `trader` address as parameter and use it in event.

### H-6: OracleRouter — Circuit Breaker Pushes Bad Price Before Blocking
- **Location:** `_pushPrice()` lines 447-461
- **Description:** When circuit breaker triggers, the potentially bad price is still pushed to PerpEngine via `updateMarkPrice()`. Liquidations will use the bad price.
- **Fix:** Do NOT push price when circuit breaker triggers. Revert so last known good price remains.

### H-7: OracleRouter — Deviation Warning Does Not Block Until 3x Threshold
- **Location:** `_pushPrice()` lines 432-444
- **Description:** Significant oracle discrepancy (up to 3x max deviation) still results in price being pushed.
- **Fix:** Block price push when deviation exceeds `maxDeviationBps`. Don't wait for 3x.

### H-8: OracleRouter — Missing L2 Sequencer Uptime Check for Chainlink on Base
- **Location:** `getChainlinkPrice()` lines 260-287
- **Description:** Standard security requirement for L2 deployments. After sequencer restart, Chainlink may serve stale prices.
- **Fix:** Add Chainlink Sequencer Uptime Feed check with grace period after restart.

### H-9: InsuranceFund — Operator Can Drain Balance via payKeeperReward Without Cap
- **Location:** `payKeeperReward` line 145
- **Description:** No per-call or per-epoch limit on keeper reward payments. A compromised Liquidator operator can drain the entire fund.
- **Fix:** Add per-call cap and daily cumulative limit.

### H-10: A2ADarkPool — No Reentrancy Guard on acceptAndSettle
- **Location:** `acceptAndSettle` lines 295-340
- **Description:** Four external calls with no reentrancy guard. State updates after external calls.
- **Fix:** Add `nonReentrant` modifier. Move state updates before external calls.

### H-11: A2ADarkPool — Fee Deduction Before Position Opening
- **Location:** `acceptAndSettle` lines 315-328
- **Description:** Fees collected before `engine.openPosition`. Cross-contract reentrancy window.
- **Fix:** Collect fees after position opening confirmed.

### H-12: CollateralManager — CEI Violation in depositCollateral
- **Location:** `depositCollateral` lines 246-264
- **Description:** State updates happen after external calls (`transferFrom`, `creditCollateral`). NonReentrant guard provides protection but ordering is not ideal.
- **Fix:** Move state updates before `vault.creditCollateral` call.

### H-13: CollateralManager — Oracle Update Has No Bounds Check
- **Location:** `updatePrice` lines 205-215
- **Description:** Operator can set ANY non-zero price. Combined with phantom balance creation, a compromised operator can create unlimited USDC credit.
- **Fix:** Add max deviation per update (e.g., 10% from previous price).

### H-14: TradingVault — Manager Can Bypass Drawdown Safety (Self-Unpause)
- **Location:** `unpauseVault` line 499-502
- **Description:** Manager can immediately unpause after drawdown triggers pause. Drawdown safety is effectively a no-op.
- **Fix:** Only protocol owner (not manager) can unpause after drawdown, or add cooldown period.

### H-15: TradingVault — Stale Equity for Share Calculation
- **Location:** `deposit` lines 230-245
- **Description:** Management fee accrual reduces equity but share calculation uses pre-fee equity.
- **Fix:** Recompute equity after fee accrual.

### H-16: SurTimelock — batchSetPausableTargets Bypasses Timelock
- **Location:** `batchSetPausableTargets` line 282
- **Description:** Owner can register arbitrary pausable targets at any time, bypassing timelock delay.
- **Fix:** Add `setupComplete` flag that disables this function after initial setup.

---

## MEDIUM FINDINGS (22)

1. **OrderSettlement:** `maxSettlementDelay` declared but never enforced
2. **OrderSettlement:** No upper bound on fee BPS (owner can set >100%)
3. **OrderSettlement:** Reentrancy risk on external calls in `_settleTrade`
4. **OrderSettlement:** MEV commit-settle protection bypassed at default settings
5. **PerpEngine:** Circuit breaker reset loop over all markets — DoS if many markets
6. **PerpEngine:** OI skew cap checked after state mutation
7. **PerpEngine:** `liquidateAccount` doesn't trigger circuit breaker tracking
8. **PerpEngine:** Reserve factor uses gross OI (both sides) instead of net
9. **PerpEngine:** No event for `setMarketActive`
10. **PerpEngine:** `setMaxPriceAge` has no minimum/maximum bounds
11. **PerpEngine:** `setCircuitBreakerParams` has no validation
12. **PerpVault:** No reentrancy guard on operator functions
13. **PerpVault:** totalDeposits accounting breaks with mixed deposit/collateral
14. **PerpVault:** Compromised operator has unlimited power over all balances
15. **InsuranceFund:** `recordBadDebt` has no deduplication
16. **InsuranceFund:** No pause mechanism
17. **OracleRouter:** Circuit breaker auto-resets without verifying stability
18. **OracleRouter:** Circuit breaker is global, not per-market
19. **OracleRouter:** Owner can disable all price validation via zero params
20. **CollateralManager:** Haircut precision loss on small deposits
21. **TradingVault:** Vault account address collision risk
22. **TradingVault:** First depositor share inflation attack

---

## GOOD PRACTICES NOTED

- Two-step ownership transfer on PerpEngine, OrderSettlement, A2ADarkPool, CollateralManager, TradingVault
- Partial liquidation (25% per round) reduces cascading risk
- Tiered margin brackets (tax-bracket style)
- Separation of concerns (Engine holds no funds, Vault manages all collateral)
- OI skew caps prevent extreme directional risk
- Circuit breaker with auto-reset
- CEI pattern correctly applied in CollateralManager.withdrawCollateral
- NonReentrant guard on CollateralManager

---

## Priority Fix Order

### Phase 1: Critical (Block Mainnet)
1. ✅ Add `nonReentrant` to PerpEngine — 7 functions protected (C-1)
2. ✅ Validate execution price/size in OrderSettlement (C-3, C-4)
3. ✅ Redesign funding pool — separate `fundingPool` address from `feeRecipient` (C-2)
4. ✅ Separate deposit vs collateral balances in PerpVault — `collateralBalances` mapping (C-5)
5. ✅ Implement collateral liquidation in CollateralManager (C-7)
6. ✅ Fix TradingVault equity calculation (C-6)

### Phase 2: High Priority
7. ✅ Reorder funding before liquidation check in PerpEngine (H-1)
8. ✅ Cap funding rate (0.1%/interval) and max periods (3) (H-4)
9. ✅ Fix OracleRouter circuit breaker — return early, don't push bad prices (H-6)
10. ✅ Add L2 Sequencer Uptime check (H-8)
11. ✅ Cap InsuranceFund keeper rewards — per-call $1K, daily $10K (H-9)
12. ✅ Add reentrancy guard to A2ADarkPool + CEI reorder (H-10, H-11)
13. ✅ Add price bounds (10% max deviation) to CollateralManager.updatePrice (H-13)
14. ✅ Fix TradingVault drawdown bypass — 24h cooldown (H-14)
15. ✅ Lock batchSetPausableTargets after setup (H-16)
16. ✅ Fix PriceImpact event uses trader not msg.sender (H-5)
17. ✅ Fix stale equity for share calculation — accrue fees first (H-15)
18. ✅ Fix CEI violation in CollateralManager.depositCollateral (H-12)
16. ✅ Fix OracleRouter deviation check — block at maxDeviationBps (H-7)
17. ✅ Add `_requireFreshPrice` to closePosition (H-3)
18. ✅ Fix cross-margin removeMargin equity check (H-2)

### Phase 3: Medium (22 findings)
19. ✅ M-1: OrderSettlement setSettlementDelay bounds validation
20. ✅ M-2: OrderSettlement fee BPS capped at 10% (1000 BPS)
21. ✅ M-3: OrderSettlement reentrancy guard on settleBatch/settleOne
22. ✅ M-4: OrderSettlement MEV auto-commit bypass removed
23. ✅ M-5: PerpEngine CB reset — removed O(n) market loop, lazy reset
24. ⚪ M-6: PerpEngine OI skew cap ordering — NOT A BUG (revert undoes state)
25. ✅ M-7: PerpEngine liquidateAccount now triggers CB tracking
26. ⚪ M-8: PerpEngine reserve factor uses gross OI — INTENTIONAL (more conservative)
27. ✅ M-9: PerpEngine setMarketActive now emits MarketActiveChanged event
28. ✅ M-10: PerpEngine setMaxPriceAge bounded [10, 3600]
29. ✅ M-11: PerpEngine setCircuitBreakerParams validated (min 60s, max 86400s)
30. ✅ M-12: PerpVault nonReentrant on internalTransfer + batchInternalTransfer
31. ✅ M-13: PerpVault deposit verifies actual received amount (fee-on-transfer guard)
32. ✅ M-14: PerpVault maxOperatorTransferPerTx cap added
33. ✅ M-15: InsuranceFund recordBadDebt deduplication via hash
34. ✅ M-16: InsuranceFund pause/unpause mechanism added
35. ✅ M-17: OracleRouter CB auto-reset requires N consecutive good prices
36. ⚪ M-18: OracleRouter CB global vs per-market — INTENTIONAL (safer for correlated markets)
37. ✅ M-19: OracleRouter setOracleCircuitBreakerParams validated
38. ✅ M-20: CollateralManager minimum credit check (revert on zero credit)
39. ✅ M-21: TradingVault vault account address collision prevention (double-hash)
40. ✅ M-22: TradingVault first depositor minimum $1000 deposit

### Phase 4: Low (16 findings) — ALL FIXED
41. ✅ L-1: PerpEngine — pause/unpause now checks current state + events
42. ✅ L-2: PerpEngine — added events: MaxPriceAgeUpdated, FeeRecipientUpdated, InsuranceFundUpdated, FundingPoolUpdated, CircuitBreakerParamsUpdated
43. ✅ L-3: PerpEngine — setMaxExposureBps validates newBps <= BPS || newBps == 0
44. ✅ L-4: PerpVault — custom errors OperatorTransferTooLarge, ArrayLengthMismatch; batchInternalTransfer validates + checks cap
45. ✅ L-5: OrderSettlement — events: FeesUpdated, DynamicSpreadUpdated, DynamicSpreadTiersUpdated; tier ascending validation
46. ✅ L-6: InsuranceFund — 2-step ownership (pendingOwner/acceptOwnership), events: PauseStatusChanged, OwnershipTransferred, OwnershipTransferStarted, MaxKeeperRewardUpdated
47. ✅ L-7: OracleRouter — 2-step ownership, events: OwnershipTransferred, OwnershipTransferStarted, SequencerFeedUpdated; gracePeriod >= 300 validation
48. ✅ L-8: Liquidator — 2-step ownership, events: OwnershipTransferred, OwnershipTransferStarted
49. ✅ L-9: CollateralManager — events: CollateralPauseChanged, OperatorUpdated, PauseStatusChanged, OwnershipTransferred, OwnershipTransferStarted, MaxPriceDeviationUpdated, LiquidationThresholdUpdated; zero-address check on setOperator; maxPriceDeviationBps bounded [100, 5000]
50. ✅ L-10: A2ADarkPool — events: OwnershipTransferred, OwnershipTransferStarted, OperatorUpdated, FeeBpsUpdated, FeeRecipientUpdated, LargeTradeThresholdUpdated, LargeTradeMinReputationUpdated, PauseStatusChanged; zero-address checks on setOperator, setFeeRecipient
51. ✅ L-11: TradingVault — events: OwnershipTransferred, OwnershipTransferStarted, OperatorUpdated; zero-address check on setOperator
52. ✅ L-12-16: Various minor — covered by above (events on all admin state changes across all contracts)

### Phase 5: Info (8 findings) — FIXED WHERE IMPACTFUL
53. ✅ I-1: SurTimelock — SetupCompleted event on completeSetup()
54. ✅ I-2: SurTimelock — batchSetPausableTargets loop uses unchecked { ++i }
55. ⚪ I-3-8: Code style (magic numbers, NatSpec completeness, require strings vs custom errors) — accepted as-is, no security impact

---

## Final Status

| Severity | Total | Fixed | Accepted Risk |
|----------|-------|-------|---------------|
| CRITICAL | 7     | 7     | 0             |
| HIGH     | 16    | 16    | 0             |
| MEDIUM   | 22    | 19    | 3             |
| LOW      | 16    | 16    | 0             |
| INFO     | 8     | 2     | 6             |
| **TOTAL**| **69**| **60**| **9**         |

**All tests passing: 302/302** (includes LoadTest + ChaosTest added post-audit)
**Compilation: Clean (warnings only in test files)**
