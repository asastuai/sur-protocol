# SUR Protocol Bug Bounty Program

**Platform:** Immunefi
**Protocol:** SUR Protocol — Perpetual DEX on Base L2
**Launch Date:** TBD
**Last Updated:** 2026-03-19

---

## 1. Program Overview

SUR Protocol is a perpetual futures decentralized exchange (DEX) deployed on Base L2. The protocol enables leveraged trading of perpetual contracts with USDC as the sole collateral asset. It features an off-chain matching engine paired with on-chain settlement, a dual oracle system (Pyth primary, Chainlink fallback), permissionless liquidations, an insurance fund for bad debt coverage, auto-deleveraging as a last resort, agent-to-agent dark pool trading, multi-collateral support, pooled trading vaults, and a timelock governance controller.

All user funds are custodied on-chain in `PerpVault.sol`. Position logic, settlement, liquidation, and fee collection are handled by separate contracts operating as authorized operators on the vault.

This bug bounty program is focused exclusively on the on-chain smart contracts listed below. We invite security researchers to identify vulnerabilities that could lead to loss of funds, unauthorized state changes, or protocol insolvency.

---

## 2. Rewards by Severity

Rewards are denominated in USD and paid out in USDC or equivalent stablecoins.

| Severity | Smart Contract Reward Range |
|----------|----------------------------|
| **Critical** | $10,000 - $50,000 |
| **High** | $5,000 - $15,000 |
| **Medium** | $1,000 - $5,000 |
| **Low** | $250 - $1,000 |

Reward amounts within each range are determined at the sole discretion of the SUR Protocol team, based on the likelihood and impact of the reported vulnerability. Duplicate reports receive no reward; only the first valid submission qualifies.

Payouts for Critical and High severity reports may include additional bonuses for high-quality reports that include a working proof of concept.

---

## 3. Assets in Scope

### 3.1 Smart Contracts (In Scope)

All contracts are written in Solidity ^0.8.24 and deployed on Base L2.

| Contract | Role | Criticality | Classification |
|----------|------|-------------|----------------|
| **PerpVault.sol** | Custodial vault for all USDC collateral. Deposits, withdrawals, operator-authorized transfers, reentrancy protection, deposit caps. | Critical | PRIMARY (fund-holding) |
| **PerpEngine.sol** | Core perpetual futures engine. Markets, positions, margin, PnL, funding rates, circuit breaker, OI caps, skew caps. | Critical | PRIMARY (controls fund movement) |
| **OrderSettlement.sol** | On-chain settlement of off-chain matched trades. EIP-712 signatures, nonces, expiry, fees, dynamic spread. | Critical | PRIMARY (controls fund movement) |
| **Liquidator.sol** | Permissionless liquidation. Single, batch, and cross-margin liquidation. Keeper reward distribution. | High | PRIMARY (triggers fund movement) |
| **InsuranceFund.sol** | Bad debt coverage. Keeper rewards, fund health reporting. Balance held in PerpVault. | High | PRIMARY (manages protocol solvency) |
| **AutoDeleveraging.sol** | Last-resort deleveraging when insurance is depleted. Cooldown, minimum threshold, disable toggle. | High | PRIMARY (emergency fund movement) |
| **OracleRouter.sol** | Price feed router. Pyth primary, Chainlink fallback. Staleness, deviation, confidence validation. | High | SECONDARY (price integrity) |
| **CollateralManager.sol** | Multi-collateral (cbETH, wstETH, stUSDC) with haircuts. Credits USDC-equivalent to PerpVault. | High | PRIMARY (holds non-USDC collateral) |
| **TradingVault.sol** | Pooled trading vaults. Shares, performance/management fees, high water mark, lockup, max drawdown. | High | PRIMARY (holds depositor funds) |
| **A2ADarkPool.sol** | Agent-to-agent OTC trading via intents. On-chain reputation, size thresholds. | Medium | PRIMARY (triggers fund movement) |
| **SurTimelock.sol** | Timelock controller. 24h+ delay on admin ops. Guardian limited to emergency pause. | Medium | SECONDARY (governance) |
| **SurMath.sol** | Fixed-point math library. WAD precision, wadMul, wadDiv, BPS calculations. | Medium | SECONDARY (math library) |

### 3.2 Backend Services (Out of Scope)

The following off-chain components are **not** in scope but listed for context:

- **API Server** — REST/WebSocket API for frontend
- **Oracle Keeper** — Pushes Pyth prices to OracleRouter
- **Funding Rate Bot** — Applies funding rate settlements
- **Liquidation Keeper** — Monitors and triggers liquidations

---

## 4. Impacts in Scope

### 4.1 Critical

- Direct theft of user funds from PerpVault or CollateralManager
- Permanent freezing of funds (unable to withdraw indefinitely)
- Oracle manipulation leading to protocol insolvency
- Unauthorized minting of vault balance or share inflation in TradingVault
- Bypassing EIP-712 signature verification for unauthorized trades
- Exploiting funding rate calculation to extract unbounded funds
- Manipulating PnL accounting to steal from protocol reserve
- Reentrancy attacks resulting in fund theft
- Draining insurance fund through crafted liquidation sequences
- Bypassing timelock to execute admin operations without delay

### 4.2 High

- Temporary freezing of funds (recoverable by admin, but locked for extended period)
- Griefing attacks causing direct financial loss to users
- Unauthorized liquidation of healthy positions
- Bypassing deposit caps, withdrawal limits, or OI caps
- Manipulating cross-margin equity to avoid liquidation
- Circuit breaker bypass enabling trading during extreme dislocations
- Exploiting ADL to unfairly target specific positions
- Share price manipulation in TradingVault
- Collateral valuation manipulation in CollateralManager

### 4.3 Medium

- Griefing attacks without direct financial loss
- DoS on non-critical view functions
- Events emitting incorrect data
- Nonce manipulation preventing order submission
- Fee calculation rounding errors that accumulate
- Incorrect liquidation price in view functions

### 4.4 Low

- Informational findings and best-practice deviations
- Gas optimization opportunities (informational only)
- Code quality improvements without security impact
- Missing event emissions for non-critical state changes

---

## 5. Out of Scope

- **Frontend and UI bugs**
- **Off-chain infrastructure** — Matching engine, API, keepers, bots
- **Already known issues** — Documented in codebase or audit reports
- **Centralization risks** — Owner multisig, operator keys, guardian keys (accepted trust model)
- **Attacks requiring compromised private keys**
- **Gas optimization** without security implications
- **Theoretical attacks without proof of concept**
- **Third-party protocol risks** — Bugs in Pyth, Chainlink, USDC, or Base L2
- **Market manipulation via legitimate trading** — Front-running, MEV
- **Issues from deprecated or test contracts**
- **Social engineering attacks**
- **DDoS/volumetric attacks**

---

## 6. Rules of Engagement

### 6.1 Responsible Disclosure

- Report vulnerabilities exclusively through Immunefi. Do not disclose publicly.
- Provide clear description, affected contract(s), and step-by-step proof of concept.
- Include a Foundry test or detailed transaction sequence.

### 6.2 Testing Guidelines

- **DO NOT test on Base mainnet.** Use local forks or testnets only.
- Use Foundry (`forge test`) with a local fork of Base for PoC development.
- Do not interact with deployed production contracts.

### 6.3 Eligibility

- Vulnerability must be previously unknown to the team.
- Must be within in-scope assets (Section 3.1).
- Must include a valid proof of concept.
- First valid submission only; duplicates receive no reward.

### 6.4 Restrictions

- Do not disrupt protocol operation on mainnet.
- Do not access or modify other users' data.
- Do not perform social engineering or physical attacks.
- Violations disqualify the researcher.

---

## 7. Contact Information

| Channel | Details |
|---------|---------|
| **Immunefi Program** | `https://immunefi.com/bounty/surprotocol` (TBD) |
| **Security Email** | `security@surprotocol.xyz` (TBD) |
| **Response SLA** | Acknowledgment within 48 hours; triage within 5 business days |

---

## 8. KYC Requirements

- **KYC required for payouts >= $5,000** (High and Critical severity).
- KYC handled by Immunefi's third-party provider, not shared with SUR team.
- Researchers from OFAC-sanctioned jurisdictions are not eligible.
- KYC must be completed within 30 days of confirmed report.
- For payouts < $5,000, KYC is recommended but not mandatory.

---

## Appendix: Contract Dependency Graph

```
SurTimelock (governance)
    └──► Owner of all contracts below

PerpVault (USDC custody)
    ▲
    ├── PerpEngine (positions, margin, PnL, funding)
    │       ▲
    │       ├── OrderSettlement (EIP-712 trade settlement)
    │       ├── Liquidator (permissionless liquidation)
    │       ├── AutoDeleveraging (last-resort deleveraging)
    │       ├── TradingVault (pooled trading)
    │       └── A2ADarkPool (OTC agent-to-agent trading)
    │
    ├── InsuranceFund (bad debt coverage)
    │       ▲
    │       ├── Liquidator
    │       └── AutoDeleveraging
    │
    ├── CollateralManager (multi-collateral deposits)
    │
    └── OracleRouter (Pyth + Chainlink price feeds)
```

---

*This document is subject to change. Refer to the latest version on Immunefi.*
