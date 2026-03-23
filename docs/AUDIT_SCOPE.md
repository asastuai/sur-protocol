# SUR Protocol - External Audit Scope

## Protocol Overview

SUR is a perpetual futures DEX on Base L2 (Coinbase). Orderbook-based with off-chain matching and on-chain settlement via EIP-712 signed orders.

### Architecture

```
User -> Frontend -> API (off-chain matching) -> OrderSettlement (on-chain)
                                                      |
                    PerpVault (USDC custody) <-> PerpEngine (positions, PnL, funding)
                                                      |
                    OracleRouter (Pyth + Chainlink) -> Price feeds
                    Liquidator (permissionless)     -> Liquidations
                    InsuranceFund                   -> Bad debt coverage
                    SurTimelock (48h delay)         -> Admin operations
```

### Key Invariants

1. **Vault solvency**: `USDC.balanceOf(vault) >= sum(vault.balances[*])`
2. **No phantom PnL**: Total realized PnL across all closed positions = 0 (zero-sum)
3. **OI consistency**: `openInterestLong + openInterestShort` matches actual positions
4. **Margin isolation**: In isolated mode, position margin comes exclusively from trader's vault balance
5. **Funding neutrality**: Funding payments net to zero across longs and shorts

## Contracts In Scope

| Contract | LoC | Complexity | Priority |
|----------|-----|------------|----------|
| PerpEngine.sol | ~1700 | CRITICAL | Highest |
| PerpVault.sol | ~350 | HIGH | High |
| OrderSettlement.sol | ~350 | HIGH | High |
| OracleRouter.sol | ~400 | HIGH | High |
| Liquidator.sol | ~140 | MEDIUM | Medium |
| InsuranceFund.sol | ~100 | MEDIUM | Medium |
| SurTimelock.sol | ~200 | MEDIUM | Medium |
| A2ADarkPool.sol | ~350 | MEDIUM | Medium |
| TradingVault.sol | ~300 | MEDIUM | Medium |
| CollateralManager.sol | ~250 | MEDIUM | Medium |
| AutoDeleveraging.sol | ~150 | LOW | Low |

**Total: ~4,300 LoC**

## Critical Areas of Focus

### 1. PerpEngine - Position Accounting
- Open/close/increase/reduce/flip positions
- PnL calculation: `(exitPrice - entryPrice) * size / SIZE_PRECISION`
- Tiered margin system
- Cross-margin mode (multi-market positions sharing equity)
- Active market tracking (O(1) add/remove)
- Funding rate calculation and application (capped at 0.1% per interval)

### 2. Liquidation System
- Partial liquidation: 25% per round
- Bad debt handling → insurance fund
- Keeper reward distribution
- Circuit breaker: triggers when liquidation volume exceeds threshold in time window
- Cross-margin account liquidation (closes ALL positions)

### 3. Oracle System
- Dual-source: Pyth (primary) + Chainlink (fallback)
- Price normalization across different decimal formats
- Oracle circuit breaker: triggers on abnormal price movements
- Auto-recovery after N consecutive good prices
- Staleness checks

### 4. Settlement
- EIP-712 typed data signing
- Nonce replay protection
- Maker/taker fee structure
- OI cap enforcement at settlement time
- MEV protection: commit-reveal with configurable delay

### 5. Vault / Fund Flows
- USDC deposit/withdraw
- Internal transfer system (operator-only)
- Batch transfers
- Deposit cap
- Health check (`actual USDC >= accounted`)

### 6. Access Control
- 2-step ownership transfer (transferOwnership + acceptOwnership) on ALL contracts
- Operator pattern (whitelisted addresses for privileged operations)
- Timelock (48h delay for admin operations)
- Guardian (emergency pause, no delay)

## Known Design Decisions

1. **Transient storage reentrancy** (EIP-1153): Uses `tload`/`tstore` instead of SSTORE for gas efficiency. Requires Cancun-compatible chain (Base supports this).
2. **No upgradeability**: Contracts are immutable. Bugs require redeployment.
3. **Partial liquidation**: 25% per round to reduce market impact. Full close below `SIZE_PRECISION / 100`.
4. **Price impact fee**: Quadratic penalty for trades worsening OI skew.
5. **Reserve factor**: Caps total OI notional at X% of vault TVL.

## Build & Test

```bash
cd contracts/
forge build
forge test                    # 302 tests, all pass
forge test -vvvv              # verbose traces
forge test --match-contract ChaosTest -vv  # adversarial stress tests
forge test --match-contract LoadTest -vv   # 100 DAU simulation
```

## Compiler Settings

```toml
solc_version = "0.8.28"
optimizer = true
optimizer_runs = 200
via_ir = true
evm_version = "cancun"
```
