# SUR Protocol — Security Hardening Report

**Date:** 2026-03-22
**Scope:** Full protocol hardening — contracts, testing, monitoring, deployment, documentation
**Status:** COMPLETE — Ready for external audit

---

## Executive Summary

SUR Protocol underwent a comprehensive security hardening process covering:

- **Internal security audit** of 11 contracts (~5,450 LoC) → 69 findings, ALL addressed
- **Gas optimization** across all contracts
- **Monitoring enhancement** with on-chain health checks and Prometheus alerting
- **Deployment pipeline** with dry-run verification scripts
- **Stress testing** — 302 tests including adversarial chaos scenarios
- **Operational readiness** — runbooks, incident response, launch checklist

The protocol is now ready for external audit by a Tier-1 security firm.

---

## 1. Internal Security Audit

### Finding Summary

| Severity | Found | Fixed | Accepted Risk | Notes |
|----------|-------|-------|---------------|-------|
| CRITICAL | 7 | 7 | 0 | All fixed — reentrancy, price validation, funding pool, collateral separation, equity calc, collateral liquidation |
| HIGH | 16 | 16 | 0 | All fixed — funding caps, oracle CB, L2 sequencer, insurance caps, reentrancy guards, CEI ordering |
| MEDIUM | 22 | 19 | 3 | 3 accepted: OI skew ordering (revert undoes state), gross OI reserve factor (intentionally conservative), global oracle CB (safer for correlated markets) |
| LOW | 16 | 16 | 0 | All fixed — events, 2-step ownership on all contracts, parameter validation |
| INFO | 8 | 2 | 6 | Style items accepted as-is, no security impact |
| **TOTAL** | **69** | **60** | **9** | |

Full details: [SECURITY_AUDIT_INTERNAL_2026-03-22.md](SECURITY_AUDIT_INTERNAL_2026-03-22.md)

### Critical Fixes Applied

| # | Finding | Fix |
|---|---------|-----|
| C-1 | PerpEngine no reentrancy guard | Added `nonReentrant` (EIP-1153 transient storage) to 7 external functions |
| C-2 | Funding pool uses feeRecipient | Separated `fundingPool` address from `feeRecipient` |
| C-3 | No execution price validation | Added limit price checks: `taker.price` and `maker.price` enforced on-chain |
| C-4 | No execution size validation | Added `require(executionSize <= maker.size && executionSize <= taker.size)` |
| C-5 | Collateral credits enable unbacked withdrawals | Separated `collateralBalances` mapping from `balances` |
| C-6 | TradingVault equity excludes unrealized PnL | Queries PerpEngine for all vault position PnL |
| C-7 | No collateral liquidation mechanism | Implemented `liquidateCollateral()` callable by keepers |

### High Fixes Applied

| # | Finding | Fix |
|---|---------|-----|
| H-1 | Liquidation checks margin before applying funding | Moved `_applyFunding()` BEFORE `_isBelowMaintenance()` |
| H-2 | Cross-margin removeMargin equity check incorrect | Fixed: check `equity >= totalMaint` without subtracting amount |
| H-3 | closePosition no fresh price check | Added `_requireFreshPrice(marketId)` |
| H-4 | Funding rate uncapped | Capped at 0.1% per interval, max 3 periods per call |
| H-5 | PriceImpact event uses msg.sender | Now uses actual trader address |
| H-6 | Oracle CB pushes bad price before blocking | Returns early without pushing price when CB triggers |
| H-7 | Deviation warning allows up to 3x threshold | Blocks at `maxDeviationBps`, not 3x |
| H-8 | Missing L2 Sequencer Uptime check | Added Chainlink Sequencer Uptime Feed with grace period |
| H-9 | Insurance keeper reward uncapped | Per-call $1K cap, daily $10K cumulative limit |
| H-10 | A2ADarkPool no reentrancy guard | Added `nonReentrant`, reordered to CEI pattern |
| H-11 | A2ADarkPool fee before position open | Fees collected after position confirmation |
| H-12 | CollateralManager CEI violation | State updates moved before external calls |
| H-13 | CollateralManager oracle no bounds | Max 10% deviation per update |
| H-14 | TradingVault manager can bypass drawdown | 24h cooldown, only owner can unpause after drawdown |
| H-15 | Stale equity for share calculation | Fees accrued before equity calculation |
| H-16 | batchSetPausableTargets bypasses timelock | `setupComplete` flag locks function after initial setup |

---

## 2. Test Suite

### Coverage Summary

| Suite | Tests | Focus |
|-------|-------|-------|
| PerpVault | 50 | Deposits, withdrawals, operators, caps, reentrancy, pause |
| PerpEngine | 38 (+1000 fuzz) | Positions, margin, PnL, funding, cross-margin, OI caps |
| OrderSettlement Integration | 5 | Full trade lifecycle |
| OracleRouter | 32 | Pyth/Chainlink, staleness, deviation, fallback |
| CircuitBreaker | 10 | Liquidation volume tracking, auto-trigger, cooldown |
| OracleCircuitBreaker | 14 | Price deviation triggers, cooldown, auto-reset |
| CrossMargin | 11 | Cross-margin mode, account liquidation, equity |
| ExposureLimit | 9 | Per-trader exposure limits, multi-market caps |
| GMXFeatures | 20 | Feature parity tests |
| MEVProtection | 10 | Commit-settle delay, expired orders, replay |
| LiquidationStress | 9 | Cascades, 50x leverage, oscillation, batch, symmetry |
| CollateralManager | 29 | Multi-collateral, haircuts, deposit/withdraw |
| A2ADarkPool | 25 | Intents, responses, settlement, reputation |
| TradingVault | 22 | Shares, fees, HWM, lockup, drawdown |
| Invariant (4 props x 256 runs x 50 depth) | 4 | Vault solvency, conservation, no-negatives, health |
| **LoadTest (100 DAU)** | 1 | Full day simulation: 72 trades, 62 liquidations, 100 deposits |
| **ChaosTest (adversarial)** | 13 (+1000 fuzz) | 13 attack vectors designed to break the protocol |
| **TOTAL** | **302** | **ALL PASS** |

### Chaos Test Results (Adversarial Stress Tests)

Each test was designed to find a specific class of vulnerability:

| Test | Scenario | Result |
|------|----------|--------|
| `flashCrash95pct_insuranceDrain` | 200 traders, BTC -95%, 1000 liquidations | Vault solvent |
| `dustPositionRounding` | 1000 min-size open/close cycles | 0 rounding profit extracted |
| `500simultaneousPositions` | 250 pairs + wild price oscillation | Vault $15M = $15M exactly |
| `priceNearZeroAndRecover` | BTC $50K → $1 → $100K | Vault healthy, OI zeroed |
| `fundingAccumulation30days` | 50 longs, 90 funding intervals | All closable, vault solvent |
| `rapidOpenCloseSameBlock` | 200 open+close in same block | 0 profit, 0 loss |
| `extremePositionSizes` | 100 BTC whale ($5M notional), +50% | PnL correct ($2.5M) |
| `crossMarginCascade` | 50 traders, 2 markets, BTC -30% + ETH -40% | Vault OK, cross-margin holds |
| `insuranceFundFullDepletion` | $1K insurance, 80% crash, 500 liquidations | All liquidations succeeded |
| `rapidFlip500times` | 500 direction flips | USDC conserved exactly |
| `10marketsSimultaneous` | 50 traders x 10 markets, 20% crash, 350 liquidations | Vault healthy |
| `fuzz_randomTrading` | 1000 seeds x 20 random ops | ALL PASSED |
| `withdrawWithOpenPosition` | Withdraw max with open position | Free balance withdrawn, position intact |

### Load Test Results (100 DAU Simulation)

- 10 phases simulating a full trading day
- 72 trades executed, 62 liquidations processed
- 100 deposits totaling $2M
- Vault solvency: $2,000,000 = $2,000,000 (exact match)
- Average gas per trade: 603K

---

## 3. Monitoring & Alerting

### On-Chain Health Checks

The monitoring service (`monitoring/src/index.ts`) performs periodic on-chain checks:

| Check | Contract | Method |
|-------|----------|--------|
| Engine Circuit Breaker | PerpEngine | `circuitBreakerActive()` |
| Oracle Circuit Breaker | OracleRouter | `oracleCircuitBreakerActive()` |
| Oracle Health | OracleRouter | `isOracleHealthy()` |
| Settlement Pause | OrderSettlement | `paused()` |
| Liquidator Pause | Liquidator | `paused()` |
| Vault Health | PerpVault | `healthCheck()` |
| Open Interest | PerpEngine | `getOpenInterest(marketId)` |
| Pending Ownership | 5 contracts | `pendingOwner()` |

### Prometheus Alert Rules

| Severity | Rule | Trigger |
|----------|------|---------|
| P0 | `EngineCircuitBreakerActive` | CB state = active |
| P0 | `OracleCircuitBreakerActive` | Oracle CB = active |
| P0 | `ContractPaused` | Settlement or Liquidator paused |
| P1 | `EngineCircuitBreakerCooldown` | CB in cooldown period |
| P1 | `OwnershipTransferPending` | Any contract has non-zero pendingOwner |
| P1 | `InsuranceCoverageDroppingFast` | Insurance balance dropping >20% in 1h |
| P2 | `CircuitBreakerRecovered` | CB recovered (info) |
| P2 | `LiquidationVolumeSpike` | High liquidation volume |
| P2 | `OracleHealthDegraded` | Oracle reporting unhealthy |

---

## 4. Deployment Pipeline

### Scripts

| Script | Purpose |
|--------|---------|
| `DeployTestnet.s.sol` | Base Sepolia deployment (24h timelock, $100K cap) |
| `DeployMainnet.s.sol` | Base Mainnet deployment (48h timelock, $5M cap) |
| `PostDeployVerify.s.sol` | 10-section verification: existence, pause, CB, operators, wiring, health, CB config, timelock, markets, ownership |
| `TransferOwnership.s.sol` | 2-step ownership transfer to Timelock for all 6 contracts |
| `AcceptOwnership.s.sol` | Generates calldata for Safe to accept ownership via Timelock |
| `ExportAddresses.s.sol` | Exports all addresses as JSON |
| `AddStockMarkets.s.sol` | Adds 9 stock perp markets |

### PostDeployVerify Checks (10 sections)

1. Contract existence (7 contracts)
2. Pause status (all unpaused)
3. Circuit breakers (both inactive)
4. Operator permissions (6 operator relationships verified)
5. Contract wiring (vault, insurance fund references)
6. Vault health check
7. Circuit breaker config (window, threshold, cooldown all > 0)
8. Timelock config (delay >= 24h, guardian set, setup locked)
9. Markets (BTC-USD, ETH-USD active with correct params)
10. Ownership summary + pending transfers

---

## 5. Contract Sizes (EIP-170 Compliance)

| Contract | Size (bytes) | Margin | Status |
|----------|-------------|--------|--------|
| PerpEngine | 23,124 | 1,452 | **TIGHT** — no more features |
| OracleRouter | 8,519 | 16,057 | OK |
| OrderSettlement | 8,103 | 16,473 | OK |
| A2ADarkPool | 7,904 | 16,672 | OK |
| CollateralManager | 7,811 | 16,765 | OK |
| TradingVault | 7,566 | 17,010 | OK |
| PerpVault | 5,300 | 19,276 | OK |
| AutoDeleveraging | 4,435 | 20,141 | OK |
| Liquidator | 4,181 | 20,395 | OK |
| InsuranceFund | 3,097 | 21,479 | OK |
| SurTimelock | 2,936 | 21,640 | OK |

**WARNING:** PerpEngine has only 1,452 bytes margin. No additional features can be added without optimization or contract splitting.

---

## 6. Gas Costs (Base L2 @ 0.005 gwei)

| Operation | Gas | USD |
|-----------|-----|-----|
| Deposit USDC | ~112K | $0.0006 |
| Withdraw USDC | ~122K | $0.0006 |
| Settle trade (EIP-712) | ~460K | $0.0023 |
| Open position (operator) | ~290K | $0.0015 |
| Close position | ~250K | $0.0013 |
| Liquidate (single) | ~200K | $0.0010 |
| Liquidate batch (10) | ~1.0M | $0.0050 |
| Oracle price push | ~130K | $0.0007 |
| Apply funding rate | ~52K | $0.0003 |

---

## 7. Key Invariants Verified

All invariants hold across all test scenarios including chaos tests:

1. **Vault solvency**: `USDC.balanceOf(vault) >= sum(vault.balances[*])` — verified in all 302 tests
2. **No phantom PnL**: Total realized PnL across all closed positions = 0 (zero-sum)
3. **OI consistency**: `openInterestLong + openInterestShort` matches actual positions
4. **Margin isolation**: In isolated mode, position margin comes exclusively from trader's vault balance
5. **Funding neutrality**: Funding payments net to zero across longs and shorts
6. **No negative balances**: No account can go below zero
7. **Health check**: `healthCheck()` passes after every state transition

---

## 8. Security Features Summary

### Access Control
- 2-step ownership transfer on ALL contracts (transferOwnership + acceptOwnership)
- Operator pattern — whitelisted contract addresses for privileged operations
- 48h Timelock for all admin operations
- Guardian emergency pause (no delay, pause only — cannot unpause)
- Gnosis Safe multisig (3/5 recommended) as Timelock owner

### Reentrancy Protection
- EIP-1153 transient storage (`tload`/`tstore`) on PerpEngine (7 functions)
- OpenZeppelin-style `nonReentrant` on PerpVault, A2ADarkPool, CollateralManager, OrderSettlement
- CEI pattern enforced across all state-changing functions

### Oracle Security
- Dual-source: Pyth (primary) + Chainlink (fallback)
- L2 Sequencer Uptime Feed check with grace period
- Oracle circuit breaker with N consecutive good prices for auto-reset
- Price staleness checks (configurable per market)
- Deviation threshold blocks at `maxDeviationBps`
- Bad prices NOT pushed when circuit breaker triggers

### Trading Safety
- Partial liquidation (25% per round) reduces market impact
- Engine circuit breaker triggers on excessive liquidation volume
- Funding rate capped at 0.1% per interval, max 3 periods per call
- Reserve factor caps total OI at X% of vault TVL
- OI skew caps prevent extreme directional risk
- Price impact fee (quadratic penalty for trades worsening skew)
- MEV protection via commit-reveal with configurable delay
- Insurance fund with per-call $1K and daily $10K keeper reward caps

### Vault Safety
- Deposit cap (configurable, starts at $100K testnet / $5M mainnet)
- Max withdrawal per transaction limit
- Max operator transfer per transaction cap
- Health check: on-chain invariant `actual USDC >= accounted`
- Fee-on-transfer guard on deposits
- Separate `balances` and `collateralBalances` mappings

---

## 9. Documentation Inventory

| Document | Purpose | Status |
|----------|---------|--------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Contract architecture diagrams | Current |
| [AUDIT_SCOPE.md](AUDIT_SCOPE.md) | External audit scope and focus areas | Current |
| [AUDIT_PACKAGE.md](AUDIT_PACKAGE.md) | Complete audit package for external firm | Current |
| [SECURITY_AUDIT_INTERNAL_2026-03-22.md](SECURITY_AUDIT_INTERNAL_2026-03-22.md) | Internal audit — 69 findings, all addressed | Current |
| [MAINNET_LAUNCH_CHECKLIST.md](MAINNET_LAUNCH_CHECKLIST.md) | 7-phase launch procedure | Current |
| [RUNBOOKS.md](RUNBOOKS.md) | Emergency runbooks for P0/P1 alerts | Current |
| [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) | Full incident response plan | Current |
| [BUG_BOUNTY.md](BUG_BOUNTY.md) | Immunefi-format bug bounty program | Current |
| [INVESTOR_OVERVIEW.md](INVESTOR_OVERVIEW.md) | Technical overview for stakeholders | Current |
| [HARDENING_COMPLETE.md](HARDENING_COMPLETE.md) | This document — master hardening summary | Current |

---

## 10. What's Next

### Mandatory Before Mainnet

1. **External audit** with Tier-1 firm (Spearbit, Trail of Bits, OpenZeppelin, Cantina)
2. Fix all external audit findings
3. Re-run full test suite (302 tests) after fixes
4. Testnet deployment dry-run on Base Sepolia
5. 48h testnet soak test with live oracle feeds

### Recommended

6. Gnosis Safe setup (3/5 multisig, hardware wallets)
7. Bug bounty program on Immunefi
8. Community monitoring dashboard
9. Gradual deposit cap increase based on confidence

---

*Internal hardening complete. Protocol is ready for external security review.*
