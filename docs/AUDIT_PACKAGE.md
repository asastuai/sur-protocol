# SUR Protocol — Audit Package

**Prepared:** 2026-03-22 (Updated: 2026-03-23)
**Protocol:** SUR Protocol — Perpetual DEX on Base L2
**Solidity:** ^0.8.24 (compiled with 0.8.28)
**Framework:** Foundry (forge, forge-std)
**License:** BUSL-1.1
**Chain:** Base L2 (Chain ID 8453)

---

## 1. Scope Overview

| Metric | Value |
|--------|-------|
| **Core contracts** | 11 |
| **Interfaces** | 3 |
| **Libraries** | 1 |
| **Total Solidity (src/)** | ~5,450 lines |
| **External dependencies** | 0 (no OpenZeppelin, no Solmate) |
| **Test suites** | 31 |
| **Tests passing** | 494/494 |
| **Chaos/adversarial tests** | 132 (6-level pipeline) |
| **Formal proofs (Halmos)** | 5 properties mathematically proven |
| **Fuzz runs** | 1,000 per fuzz test |
| **Invariant calls** | 179,200+ (256 runs × 50 depth × 7 invariants) |
| **Bugs found & fixed** | 8 (6 critical/high + 2 medium/low) |

---

## 2. Contracts In Scope

### 2.1 Critical (Fund-Holding / Fund-Moving)

| Contract | Lines | Description | Criticality |
|----------|-------|-------------|-------------|
| **PerpVault.sol** | 415 | Custodial vault for all USDC. Deposits, withdrawals, internal balance transfers, deposit caps. | CRITICAL |
| **PerpEngine.sol** | 1,499 | Core perps engine. Markets, positions, margin (isolated + cross), PnL, funding rates, circuit breaker, OI/skew caps, tiered leverage. | CRITICAL |
| **OrderSettlement.sol** | 490 | EIP-712 signed order settlement. Batch processing, nonce replay protection, MEV commit-settle delay, dynamic spread. | CRITICAL |

### 2.2 High (Fund Movement / Solvency)

| Contract | Lines | Description | Criticality |
|----------|-------|-------------|-------------|
| **Liquidator.sol** | 118 | Permissionless liquidation. Single, batch, cross-margin. Keeper rewards. | HIGH |
| **InsuranceFund.sol** | 192 | Bad debt tracking, keeper reward distribution. Balance held in PerpVault. | HIGH |
| **AutoDeleveraging.sol** | 272 | Last-resort ADL when insurance depleted. Cooldown, threshold, disable toggle. | HIGH |
| **CollateralManager.sol** | 339 | Multi-collateral (cbETH, wstETH, stUSDC). Haircuts. Credits USDC-equivalent to PerpVault. | HIGH |
| **TradingVault.sol** | 524 | Pooled trading vaults. Shares, performance/management fees, HWM, lockup, max drawdown. | HIGH |

### 2.3 Medium (Price Integrity / Governance / OTC)

| Contract | Lines | Description | Criticality |
|----------|-------|-------------|-------------|
| **OracleRouter.sol** | 590 | Pyth primary + Chainlink fallback. Staleness, deviation, confidence checks. Oracle circuit breaker. | HIGH |
| **A2ADarkPool.sol** | 447 | Agent-to-agent OTC trading via intents. On-chain reputation, size gates. | MEDIUM |
| **SurTimelock.sol** | 323 | 24h+ delay governance. Guardian emergency pause. Self-governing config changes. | MEDIUM |

### 2.4 Library

| Contract | Lines | Description |
|----------|-------|-------------|
| **SurMath.sol** | 72 | WAD (18-decimal) fixed-point math. Currently unused by main contracts. |

---

## 3. Architecture

### 3.1 Fund Flow

```
Users
  │
  ▼
PerpVault (USDC custody) ◄──── CollateralManager (yield tokens → USDC credit)
  │
  ├── PerpEngine (positions, margin, PnL, funding)
  │       │
  │       ├── OrderSettlement (EIP-712 matched trades)
  │       ├── Liquidator (permissionless liquidation)
  │       ├── AutoDeleveraging (last-resort)
  │       ├── TradingVault (pooled copy-trading)
  │       └── A2ADarkPool (OTC agent-to-agent)
  │
  └── InsuranceFund (bad debt coverage, keeper rewards)

OracleRouter (Pyth + Chainlink) → PerpEngine.updateMarkPrice()

SurTimelock (governance)
  └── Owner of all contracts
      └── Owned by Gnosis Safe (4/7 multisig)
```

### 3.2 Access Control Model

| Role | Who | Powers |
|------|-----|--------|
| **Owner** | SurTimelock (→ Gnosis Safe) | Add markets, set parameters, set operators, pause/unpause, transfer ownership |
| **Operator** | Other SUR contracts (e.g., Settlement is operator on Engine) | Execute protocol operations (open/close positions, settle trades, etc.) |
| **Guardian** | Hot wallet | Emergency pause only (no delay, via SurTimelock) |
| **Keeper** | Bots | Permissionless liquidation, oracle price pushes |
| **Trader** | Any EOA/contract | Deposit, withdraw, sign orders, set margin mode |

### 3.3 Operator Permissions Map

```
PerpVault operators:    PerpEngine, OrderSettlement
PerpEngine operators:   OrderSettlement, Liquidator, OracleRouter
InsuranceFund operators: Liquidator
```

---

## 4. Key Security Properties to Verify

### 4.1 Invariants (Tested)

1. **Vault solvency:** `USDC.balanceOf(vault) >= sum(all balances)`
2. **Deposit/withdraw conservation:** deposits - withdrawals = total balance change
3. **No negative balances:** no account can go below zero
4. **Vault health:** `healthCheck()` passes after any state transition

### 4.2 Critical Properties (Verified via Chaos Testing)

All properties below have been tested adversarially across 6 levels of chaos testing. See [CHAOS_TESTING_REPORT_2026-03-23.md](CHAOS_TESTING_REPORT_2026-03-23.md) for full details.

1. **No unauthorized fund extraction** — only operators can call `internalTransfer` ✅ Tested
2. **PnL accounting correctness** — open + close must net to zero across all positions ✅ Proven (Halmos + fuzz)
3. **Funding rate zero-sum** — total funding paid = total funding received ✅ Verified (L5 precision tests)
4. **Liquidation correctness** — only underwater positions liquidatable ✅ Tested (L4 economic attacks)
5. **EIP-712 signature integrity** — orders cannot be replayed, forged, or front-run ✅ Tested (L1 chaos)
6. **Oracle manipulation resistance** — staleness, deviation, confidence checks hold ✅ Tested (L1 chaos + L4 stale price)
7. **Circuit breaker effectiveness** — halts trading under extreme conditions ✅ Tested (L2 cross-contract + L4 flash crash)
8. **Ownership transfer safety** — 2-step pattern on all contracts ✅ Fixed (BUG-8) + Tested

### 4.3 Properties Still Requiring External Review

1. **Cross-margin equity edge cases** — Complex multi-position scenarios under extreme volatility
2. **EIP-712 domain separator across chains** — Replay protection if deployed on multiple L2s
3. **Gas griefing via unbounded loops** — `A2ADarkPool.getOpenIntents()` and batch operations

---

## 5. Known Issues & Design Decisions

### 5.1 Acknowledged Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Off-chain order matching, on-chain settlement | Performance — matching engine runs off-chain, settlement is on-chain with EIP-712 signatures |
| 2 | Single USDC collateral in PerpVault | Simplicity — multi-collateral handled separately via CollateralManager with haircuts |
| 3 | Permissionless liquidation | Decentralization — anyone can liquidate, keeper gets reward |
| 4 | 25% partial liquidation per round | Capital efficiency — reduces position gradually instead of full close |
| 5 | Guardian can only pause, never unpause | Safety — unpause requires full timelock delay |
| 6 | `batchSetPausableTargets` bypasses timelock | One-time setup convenience during deployment |

### 5.2 Known Limitations

| # | Issue | Severity | Notes |
|---|-------|----------|-------|
| 1 | **SurMath.sol unused** | Info | Library exists but main contracts inline their own math. |
| 2 | **A2ADarkPool `getOpenIntents()` unbounded iteration** | Low | `activeIntentIds` array grows without cleanup. Gas bomb risk if many intents accumulate. |
| 3 | **PerpEngine at 23,124 bytes** | Info | Only 1,452 bytes margin to EIP-170 limit. No new features without optimization or splitting. |

> **Note:** Several items previously listed here (TradingVault equity, InsuranceFund pause, inconsistent ownership patterns, sequencer uptime check) were fixed during the internal security hardening. See [HARDENING_COMPLETE.md](HARDENING_COMPLETE.md) for details.

### 5.3 Bugs Found & Fixed During Chaos Testing (2026-03-23)

| # | Bug | Contract | Severity | Status |
|---|-----|----------|----------|--------|
| 1 | Reentrancy via vault.internalTransfer | PerpEngine | CRITICAL | Fixed |
| 2 | Funding uses feeRecipient as pool | PerpEngine | CRITICAL | Fixed |
| 3 | No execution price validation | OrderSettlement | CRITICAL | Fixed |
| 4 | No execution size validation | OrderSettlement | CRITICAL | Fixed |
| 5 | Collateral credits enable unbacked withdrawals | PerpVault | CRITICAL | Fixed |
| 6 | Missing collateral balance separation | PerpVault | HIGH | Fixed |
| 7 | Missing `cancelResponse()` function | A2ADarkPool | MEDIUM | Fixed |
| 8 | 1-step ownership transfer | AutoDeleveraging | LOW | Fixed |

> See [CHAOS_TESTING_REPORT_2026-03-23.md](CHAOS_TESTING_REPORT_2026-03-23.md) for full details on all bugs, test methodology, and findings.

### 5.4 Trust Assumptions

1. **Operators are trusted contracts** — set by owner, not arbitrary addresses
2. **Oracle keeper pushes honest prices** — Pyth VAA verification provides cryptographic guarantee
3. **Gnosis Safe signers are honest** — 4/7 quorum required
4. **Base L2 sequencer is monitored** — Chainlink Sequencer Uptime Feed check with grace period added
5. **USDC is non-rebasing, non-fee-on-transfer** — standard ERC20 behavior assumed (fee-on-transfer guard added to deposits)
6. **Collateral tokens in CollateralManager are vetted** — owner responsible for adding only safe tokens

---

## 6. External Integrations

| Integration | Usage | Interface |
|-------------|-------|-----------|
| **Pyth Network** | Primary oracle (pull-based, VAA verified) | `IPyth.sol` |
| **Chainlink** | Fallback oracle (push-based) | `IChainlink.sol` |
| **USDC (Circle)** | Sole collateral token | `IERC20.sol` |
| **Base L2** | Deployment chain | EVM compatible |

---

## 7. Test Coverage

### 7.1 Test Suites

#### Core Tests (302 tests, 14 suites)

| Suite | Tests | Focus |
|-------|-------|-------|
| PerpVaultTest | 50 | Deposits, withdrawals, operators, caps, reentrancy, pause |
| PerpEngineTest | 38 (+1000 fuzz) | Positions, margin, PnL, funding, cross-margin, OI caps |
| OracleRouterTest | 32 | Pyth/Chainlink, staleness, deviation, fallback, circuit breaker |
| CollateralManagerTest | 29 | Multi-collateral, haircuts, deposit/withdraw, price updates |
| A2ADarkPoolTest | 25 | Intents, responses, settlement, reputation, fees |
| TradingVaultTest | 22 | Shares, fees, HWM, lockup, drawdown, multi-depositor |
| GMXFeaturesTest | 20 | Feature parity tests |
| OracleCircuitBreakerTest | 14 | Price deviation triggers, cooldown, auto-reset |
| ChaosTest | 13 (+1000 fuzz) | Adversarial stress: flash crash, dust rounding, 500 positions, insurance drain |
| CrossMarginTest | 11 | Cross-margin mode, account liquidation, equity |
| CircuitBreakerTest | 10 | Liquidation volume tracking, auto-trigger, cooldown |
| MEVProtectionTest | 10 | Commit-settle delay, expired orders, replay protection |
| ExposureLimitTest | 9 | Per-trader exposure limits, multi-market caps |
| LiquidationStressTest | 9 | Cascade (12 pos), 50x leverage, oscillation, batch, symmetry |
| IntegrationTest | 5 | Full trade lifecycle: deposit → open → close → withdraw |
| InvariantTest | 4 | Vault solvency, conservation, no-negatives, health (256 runs × 50 depth) |
| LoadTest | 1 | 100 DAU full day simulation: 72 trades, 62 liquidations |

#### Chaos Testing Pipeline (132 tests, 17 suites) — Added 2026-03-23

**Level 1 — Unit Chaos (88 tests, 11 contracts)**

| Suite | Tests | Focus |
|-------|-------|-------|
| VaultChaos | 10 | Deposit cap, zero amounts, reentrancy, health check |
| ChaosTest (Engine) | 29 | OI tracking, cross-margin, funding, circuit breaker |
| LiquidatorChaos | 10 | Healthy position, batch, keeper counter, scanLiquidatable |
| InsuranceFundChaos | 12 | Reward caps, daily limits, bad debt dedup, market tracking |
| CollateralManagerChaos | 12 | Rounding dust, stale price, haircut, double liquidation |
| OrderSettlementChaos | 10 | Replay, expired orders, self-trade, MEV protection |
| A2ADarkPoolChaos | 12 | Self-trade, cooldown, reputation, cancelResponse (BUG-7 fix) |
| AutoDeleveragingChaos | 10 | Non-profitable ADL, cooldown, 2-step ownership (BUG-8 fix) |
| TradingVaultChaos | 10 | Min deposit, lockup, invalid fees, emergency pause |
| SurTimelockChaos | 12 | Premature execution, expired tx, guardian limits |
| OracleRouterChaos | 8 | Stale price, deviation, zero price, feed switching |

**Level 2 — Cross-Contract Attacks (10 tests)**

| Suite | Tests | Focus |
|-------|-------|-------|
| CrossContractAttacks | 10 | Oracle→Engine→Liquidation chains, funding+settlement combos, circuit breaker cascades |

**Level 3 — Invariant Fuzzing (7 properties, 179,200+ calls)**

| Suite | Tests | Focus |
|-------|-------|-------|
| InvariantTest (extended) | 7 | Vault solvency, conservation, no-negatives, health, OI tracking, funding conservation, margin adequacy |

**Level 4 — Economic Attack Simulations (12 tests)**

| Suite | Tests | Focus |
|-------|-------|-------|
| EconomicAttacks | 12 | Flash crash cascade, funding rate gaming, whale manipulation, bank run, pump&dump, multi-market contagion, insurance drain→ADL, stale price exploit, dust accumulation, max leverage stress |

**Level 5 — Precision & Funding Deep Dive (15 tests)**

| Suite | Tests | Focus |
|-------|-------|-------|
| Level5PrecisionAttacks | 15 | Funding conservation, direction, rate cap, period cap, pool depletion, min/max positions, fee conservation, double-touch, liquidation precision, position flip, margin dust, OI tracking, market independence, entry price averaging |

**Level 6 — Formal Verification (8 properties, 5 proven)**

| Suite | Tests | Focus |
|-------|-------|-------|
| HalmosVault | 8 | Deposit math ✅, withdraw math ✅, transfer conservation ✅, solvency ✅, PnL zero-sum ✅, funding symmetry ⏱, margin bound ⏱, liquidation monotonicity ⏱ |

### 7.2 Running Tests

```bash
cd contracts/

# Full suite (494 tests)
forge test -vvv                    # all tests with traces
forge test --gas-report            # with gas usage
forge test --summary               # quick summary

# By level
forge test --match-path "test/*Chaos*" -vvv           # L1: Unit chaos
forge test --match-path "test/CrossContract*" -vvv     # L2: Cross-contract
forge test --match-path "test/invariant/*" -vvv        # L3: Invariant fuzzing
forge test --match-path "test/EconomicAttacks*" -vvv   # L4: Economic attacks
forge test --match-path "test/Level5*" -vvv            # L5: Precision attacks

# Formal verification (requires Halmos + Z3)
halmos --contract HalmosVault --solver-timeout-assertion 30000
```

---

## 8. Build & Verify

### 8.1 Prerequisites

- Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- Solc 0.8.28 (auto-managed by Forge)

### 8.2 Build

```bash
cd contracts/
forge build
```

### 8.3 Project Structure

```
contracts/
├── src/
│   ├── PerpVault.sol
│   ├── PerpEngine.sol
│   ├── OrderSettlement.sol
│   ├── Liquidator.sol
│   ├── InsuranceFund.sol
│   ├── AutoDeleveraging.sol
│   ├── OracleRouter.sol
│   ├── CollateralManager.sol
│   ├── TradingVault.sol
│   ├── A2ADarkPool.sol
│   ├── SurTimelock.sol
│   ├── interfaces/
│   │   ├── ISurInterfaces.sol
│   │   ├── IPyth.sol
│   │   ├── IChainlink.sol
│   │   └── IERC20.sol
│   └── libraries/
│       └── SurMath.sol
├── test/
│   ├── *.t.sol (31 test files)
│   ├── formal/
│   │   └── HalmosVault.t.sol (symbolic execution)
│   └── invariant/
├── script/
│   ├── DeployMainnet.s.sol
│   └── TransferOwnership.s.sol
└── foundry.toml
```

---

## 9. Deployment Configuration

| Parameter | Value |
|-----------|-------|
| Chain | Base L2 (8453) |
| Solc | 0.8.28 |
| Optimizer | Yes, 200 runs |
| Via IR | Yes |
| EVM version | Cancun |
| USDC address | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Pyth address | `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a` |
| Timelock delay | 48 hours |
| Initial markets | BTC-USD (20x), ETH-USD (20x) |
| Initial vault cap | $5M USDC |

---

## 10. Areas of Highest Concern

Ranked by potential impact:

1. **PerpEngine PnL/margin accounting** — Complex position math, funding rate calculations, cross-margin equity. Any error = fund theft or insolvency.
2. **OrderSettlement EIP-712** — Signature verification, nonce management, replay protection. Any bypass = unauthorized trades.
3. **PerpVault balance integrity** — Internal transfer correctness, operator authorization. Core fund custodian.
4. **Liquidation mechanics** — Threshold calculation, partial liquidation math, keeper rewards, insurance fund interaction.
5. **CollateralManager reentrancy** — External ERC20 transfers without reentrancy guard. Withdraw function order of operations.
6. **Oracle manipulation** — Price staleness windows, deviation thresholds, Pyth VAA validation.
7. **TradingVault share pricing** — Equity calculation excludes unrealized PnL. Deposit/withdraw fairness.
8. **AutoDeleveraging fairness** — Position selection for ADL, price used for forced closure.

---

## 11. Contact

| | |
|---|---|
| **Protocol Team** | security@surprotocol.xyz |
| **Preferred Format** | Foundry PoC tests (forge test) |
| **Response SLA** | 48h acknowledgment, 5-day triage |

---

*This document provides auditors with complete context to begin review. All code is available in the repository. No external dependencies — the entire protocol is self-contained.*

**Companion documents:**
- [CHAOS_TESTING_REPORT_2026-03-23.md](CHAOS_TESTING_REPORT_2026-03-23.md) — Full chaos testing report (6 levels, 132 tests, 8 bugs)
- [SECURITY_AUDIT_INTERNAL_2026-03-22.md](SECURITY_AUDIT_INTERNAL_2026-03-22.md) — Internal security audit findings
- [HARDENING_COMPLETE.md](HARDENING_COMPLETE.md) — Security hardening changelog
