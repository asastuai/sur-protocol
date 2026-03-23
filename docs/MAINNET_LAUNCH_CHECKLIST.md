# SUR Protocol - Mainnet Launch Checklist

## Contract Sizes (EIP-170 Limit: 24,576 bytes)

| Contract | Size (bytes) | Margin | Status |
|----------|-------------|--------|--------|
| PerpEngine | 23,124 | 1,452 | TIGHT - no more features |
| OracleRouter | 8,519 | 16,057 | OK |
| OrderSettlement | 8,103 | 16,473 | OK |
| A2ADarkPool | 7,904 | 16,672 | OK |
| CollateralManager | 7,811 | 16,765 | OK |
| TradingVault | 7,566 | 17,010 | OK |
| PerpVault | 5,300 | 19,276 | OK |
| Liquidator | 4,181 | 20,395 | OK |
| AutoDeleveraging | 4,435 | 20,141 | OK |
| InsuranceFund | 3,097 | 21,479 | OK |
| SurTimelock | 2,936 | 21,640 | OK |

**WARNING:** PerpEngine tiene solo 1,452 bytes de margen. NO agregar funcionalidad sin antes optimizar o splitear.

## Gas Costs Per Operation (Base L2 @ 0.005 gwei)

| Operacion | Gas | USD (approx) |
|-----------|-----|-------------|
| Deposit USDC | ~112K | $0.0006 |
| Withdraw USDC | ~122K | $0.0006 |
| Settle trade (EIP-712) | ~460K | $0.0023 |
| Open position (operator) | ~290K | $0.0015 |
| Close position | ~250K | $0.0013 |
| Liquidate (single) | ~200K | $0.0010 |
| Liquidate batch (10) | ~1.0M | $0.0050 |
| Oracle price push | ~130K | $0.0007 |
| Apply funding rate | ~52K | $0.0003 |

## Test Coverage Summary

| Suite | Tests | Status |
|-------|-------|--------|
| PerpVault | 50 | PASS |
| PerpEngine | 38 (+1000 fuzz) | PASS |
| OrderSettlement (Integration) | 5 | PASS |
| OracleRouter | 32 | PASS |
| CircuitBreaker | 10 | PASS |
| OracleCircuitBreaker | 14 | PASS |
| CrossMargin | 11 | PASS |
| ExposureLimit | 9 | PASS |
| GMXFeatures | 20 | PASS |
| MEVProtection | 10 | PASS |
| LiquidationStress | 9 | PASS |
| CollateralManager | 29 | PASS |
| A2ADarkPool | 25 | PASS |
| TradingVault | 22 | PASS |
| Invariant (4 props x 256 runs x 50 depth) | 4 | PASS |
| LoadTest (100 DAU) | 1 | PASS |
| ChaosTest (adversarial) | 13 (+1000 fuzz) | PASS |
| **TOTAL** | **302** | **ALL PASS** |

## Security Audit Summary

Internal audit: 69 findings, ALL FIXED
- Critical: 5/5 fixed
- High: 12/12 fixed
- Medium: 14/14 fixed
- Low: 22/22 fixed
- Info: 16/16 fixed

## Pre-Launch Steps (in order)

### Phase 0: External Audit (MANDATORY)
- [ ] Package codebase for auditor (flattened sources, test suite, docs)
- [ ] External audit with Tier-1 firm (Spearbit, Trail of Bits, OpenZeppelin, Cantina)
- [ ] Fix all audit findings
- [ ] Re-run full test suite after fixes

### Phase 1: Infrastructure
- [ ] Deploy monitoring stack (Prometheus + Grafana + alerting)
- [ ] Configure Telegram/Discord alert channels
- [ ] Set up Grafana dashboards from alerting-rules.yml
- [ ] Deploy keeper bots (oracle, liquidation, funding)
- [ ] Fund keeper wallets with ETH
- [ ] Test alert pipeline end-to-end

### Phase 2: Testnet Deploy
- [ ] Fund deployer wallet on Base Sepolia
- [ ] Get testnet USDC from faucet.circle.com
- [ ] Run: `forge script script/DeployTestnet.s.sol --rpc-url base_sepolia --broadcast --verify --slow -vvvv`
- [ ] Run: `forge script script/PostDeployVerify.s.sol --rpc-url base_sepolia -vvvv`
- [ ] Verify contracts on Sepolia Basescan
- [ ] Test full flow manually: deposit -> trade -> liquidate -> withdraw
- [ ] Run keepers against testnet for 48h minimum
- [ ] Stress test with real oracle feeds

### Phase 3: Gnosis Safe Setup
- [ ] Deploy Gnosis Safe (3/5 multisig recommended)
- [ ] Verify all signers have hardware wallets
- [ ] Test Safe transaction signing
- [ ] Document signer list (NEVER store keys digitally)

### Phase 4: Mainnet Deploy
- [ ] Create fresh deployer wallet (hardware wallet)
- [ ] Fund deployer with ETH on Base
- [ ] **CRITICAL CHECK:** Verify all env vars (USDC, Pyth, guardian, fee recipient, funding pool)
- [ ] Run: `forge script script/DeployMainnet.s.sol --rpc-url base_mainnet --broadcast --verify --slow -vvvv`
- [ ] Run: `forge script script/PostDeployVerify.s.sol --rpc-url base_mainnet -vvvv`
- [ ] Verify ALL contracts on Basescan

### Phase 5: Ownership Transfer
- [ ] Run: `forge script script/TransferOwnership.s.sol --rpc-url base_mainnet --broadcast --slow -vvvv`
- [ ] Verify pendingOwner set on all 6 contracts
- [ ] Queue acceptOwnership on Timelock via Safe (use AcceptOwnership.s.sol for calldata)
- [ ] Wait delay period (48h)
- [ ] Execute acceptOwnership on all 6 contracts
- [ ] Verify: all contracts owned by Timelock
- [ ] Verify: Timelock owned by Safe
- [ ] **DESTROY deployer private key**

### Phase 6: Go-Live
- [ ] Seed insurance fund ($50k-$100k minimum)
- [ ] Fund OracleRouter with ETH for Pyth fees
- [ ] Start oracle keeper - verify prices pushing
- [ ] Start liquidation keeper - verify scanning
- [ ] Start funding keeper
- [ ] Enable deposits (small cap first: $100k)
- [ ] Monitor first 24h with team on-call
- [ ] Gradually increase deposit cap

### Phase 7: Post-Launch
- [ ] Bug bounty program (Immunefi recommended)
- [ ] Increase deposit cap based on confidence
- [ ] Add markets (stock perps via AddStockMarkets.s.sol)
- [ ] Add Chainlink fallback feeds
- [ ] Community monitoring dashboard

## Emergency Contacts

| Role | Address/Contact | Notes |
|------|----------------|-------|
| Guardian (hot wallet) | TBD | Emergency pause, NO ownership |
| Safe Signer 1 | TBD | Hardware wallet |
| Safe Signer 2 | TBD | Hardware wallet |
| Safe Signer 3 | TBD | Hardware wallet |
| Safe Signer 4 | TBD | Hardware wallet |
| Safe Signer 5 | TBD | Hardware wallet |
| Oracle Keeper | TBD | Auto-funded bot |
| Liquidation Keeper | TBD | Auto-funded bot |

## Key Addresses (fill after deploy)

```
Chain:            Base Mainnet (8453)
PerpVault:        0x...
PerpEngine:       0x...
OrderSettlement:  0x...
Liquidator:       0x...
InsuranceFund:    0x...
OracleRouter:     0x...
SurTimelock:      0x...
Gnosis Safe:      0x...
Guardian:         0x...
Fee Recipient:    0x...
Funding Pool:     0x...
USDC:             0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
Pyth:             0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a
```
