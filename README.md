<div align="center">

# SUR Protocol

### Perpetual Futures DEX — built for Argentina and Latin America

**[→ Live at sur-protocol.vercel.app](https://sur-protocol.vercel.app)**

[![Base L2](https://img.shields.io/badge/Base-Sepolia%20%2F%20Mainnet-0052FF.svg)](https://sur-protocol.vercel.app)
[![Foundry](https://img.shields.io/badge/tests-494%20passing-brightgreen.svg)](https://book.getfoundry.sh/)
[![Solidity](https://img.shields.io/badge/Solidity-0.8-363636.svg)](https://soliditylang.org/)
[![EIP-712](https://img.shields.io/badge/orders-EIP--712-orange.svg)](https://eips.ethereum.org/EIPS/eip-712)
[![License](https://img.shields.io/badge/license-BUSL--1.1-blue.svg)](LICENSE)

Hybrid architecture: off-chain matching engine + on-chain settlement on Base L2.

</div>

---

## What it is

SUR Protocol is a perpetual futures DEX designed for emerging markets — starting with Argentina — where access to derivatives has historically depended on foreign CEX accounts, USD rails, and trust in centralized custodians. SUR brings perp trading on-chain: USDC collateral, tiered and cross-margin liquidation, EIP-712 signed orders, and a hybrid architecture that keeps the order book off-chain (for latency and UX) while settlement, custody, and risk live on-chain (for non-custodial guarantees).

**11 Solidity contracts · 494 passing Foundry tests · Base L2**

- Live frontend: [sur-protocol.vercel.app](https://sur-protocol.vercel.app) — 15 crypto markets, TradingView charts, real-time price feeds via Binance / Pyth / Chainlink
- Full perp trading stack: deposits, margin, position management, liquidation engine, insurance fund, oracle router
- Non-custodial, permissionless, transparent — BUSL-1.1 licensed

---

## Architecture

**Hybrid — off-chain matching + on-chain settlement.**

| Layer | Where | Why |
|-------|-------|-----|
| Order book | Off-chain (API + engine) | Latency + UX |
| Matching | Off-chain (engine) | Throughput |
| Settlement | On-chain (Base L2) | Finality + audit |
| Custody | On-chain (PerpVault) | Non-custodial |
| Margin + liquidation | On-chain (PerpEngine + Liquidator) | Risk transparency |
| Price feeds | On-chain oracle router | Pyth + Chainlink fallback |

---

## Monorepo structure

```
sur-protocol/
├── contracts/          # Solidity smart contracts (Foundry)
│   ├── src/            # Contract source files
│   ├── test/           # Foundry tests (494 passing)
│   ├── script/         # Deploy scripts
│   └── foundry.toml    # Foundry config
├── engine/             # Matching engine (Rust)
├── api/                # Backend API (Node.js / TypeScript)
├── web/                # Frontend (Next.js)
├── demo/               # Live demo → sur-protocol.vercel.app
└── docs/               # Specs and documentation
```

---

## Core contracts

| Contract | Purpose | Status |
|----------|---------|--------|
| `PerpVault.sol` | USDC collateral custody, deposits, withdrawals | ✅ Complete |
| `PerpEngine.sol` | Position management, PnL, margin, liquidation | ✅ Complete |
| `OrderSettlement.sol` | Batch trade settlement with EIP-712 signatures | ✅ Complete |
| `Liquidator.sol` | Permissionless liquidation, keeper rewards, batch mode | ✅ Complete |
| `InsuranceFund.sol` | Bad debt absorption, fund health tracking | ✅ Complete |
| `OracleRouter.sol` | Pyth + Chainlink feeds, deviation checks, normalization | ✅ Complete |
| `SurMath.sol` | Fixed-point math library (WAD precision) | ✅ Complete |

**Phase 1 core protocol: complete.**

---

## Quick start

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (contracts)
- [Rust](https://rustup.rs/) (matching engine)
- [Node.js 20+](https://nodejs.org/) (API + frontend)

### Contracts

```bash
cd contracts

# Install OpenZeppelin dependencies
forge install OpenZeppelin/openzeppelin-contracts --no-commit

# Build
forge build

# Test (494 passing)
forge test -vvv

# Gas report
forge test --gas-report

# Deploy to Base Sepolia testnet
forge script script/DeploySur.s.sol:DeploySur \
  --rpc-url base_sepolia --broadcast --verify
```

### Environment variables

```bash
cp .env.example .env
# PRIVATE_KEY=your_deployer_private_key
# BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
# BASESCAN_API_KEY=your_basescan_key
# USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e  # Base Sepolia USDC
```

---

## Network

- **Testnet:** Base Sepolia (live, integrated with frontend)
- **Mainnet:** Base (target Phase 4)

---

## Related repositories

- [**asastuai**](https://github.com/asastuai/asastuai) — Developer profile and full portfolio
- [**liquidclaw-amm-**](https://github.com/asastuai/liquidclaw-amm-) — ve(3,3) AMM DEX on BSC + Base
- [**kybalion**](https://github.com/asastuai/kybalion) — Hermetic Computing (Rust research framework)

---

## License

BUSL-1.1 (Business Source License). See [LICENSE](LICENSE).

---

Built by [Juan Cruz Maisu](https://github.com/asastuai) · Buenos Aires, Argentina
