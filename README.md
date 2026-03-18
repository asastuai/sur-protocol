# SUR Protocol

> The first perpetual futures DEX built for Argentina and Latin America.

**Architecture:** Hybrid (off-chain matching engine + on-chain settlement on Base L2)

## Monorepo Structure

```
sur-protocol/
├── contracts/          # Solidity smart contracts (Foundry)
│   ├── src/            # Contract source files
│   ├── test/           # Foundry tests
│   ├── script/         # Deploy scripts
│   └── foundry.toml    # Foundry config
├── engine/             # Matching engine (Rust) [Phase 0-1]
├── api/                # Backend API (Node.js/TypeScript) [Phase 1-2]
├── web/                # Frontend (Next.js) [Phase 2]
└── docs/               # Documentation & specs
```

## Quick Start

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for contracts)
- [Rust](https://rustup.rs/) (for matching engine, Phase 1)
- [Node.js 20+](https://nodejs.org/) (for API & frontend)

### Setup Contracts

```bash
cd contracts

# Install dependencies (OpenZeppelin)
forge install OpenZeppelin/openzeppelin-contracts --no-commit

# Build
forge build

# Run tests
forge test -vvv

# Run tests with gas report
forge test --gas-report

# Deploy to Base Sepolia testnet
forge script script/DeploySur.s.sol:DeploySur --rpc-url base_sepolia --broadcast --verify
```

### Environment Variables

```bash
cp .env.example .env
# Fill in:
# PRIVATE_KEY=your_deployer_private_key
# BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
# BASESCAN_API_KEY=your_basescan_key
# USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e  (Base Sepolia USDC)
```

## Contracts Overview

| Contract | Description | Status |
|----------|-------------|--------|
| `PerpVault.sol` | USDC collateral custody, deposits & withdrawals | ✅ Complete |
| `SurMath.sol` | Fixed-point math library (WAD precision) | ✅ Complete |
| `PerpEngine.sol` | Position management, PnL, margin, liquidation | ✅ Complete |
| `OrderSettlement.sol` | Batch trade settlement with EIP-712 signatures | ✅ Complete |
| `Liquidator.sol` | Permissionless liquidation, keeper rewards, batch liquidate | ✅ Complete |
| `InsuranceFund.sol` | Bad debt absorption, fund health tracking | ✅ Complete |
| `OracleRouter.sol` | Pyth + Chainlink price feeds, normalization, deviation checks | ✅ Complete |

**Phase 1 Core Protocol: COMPLETE** 🎉

## Network

- **Testnet:** Base Sepolia
- **Mainnet:** Base (target Phase 4)

## License

BUSL-1.1 (Business Source License)
