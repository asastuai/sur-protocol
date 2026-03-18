# SUR Protocol - Smart Contract Architecture

## Phase 0: PerpVault (Complete)

```
┌─────────────────────────────────────────────────────┐
│                     PerpVault.sol                     │
│                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │   deposit()  │  │  withdraw()  │  │  balanceOf() │ │
│  │   User → Vault│  │ Vault → User │  │   Query      │ │
│  └──────┬──────┘  └──────┬───────┘  └─────────────┘ │
│         │                │                            │
│         ▼                ▼                            │
│  ┌──────────────────────────────────┐                │
│  │      balances[address] → uint256  │                │
│  │      totalDeposits → uint256      │                │
│  └──────────────────────────────────┘                │
│         │                                            │
│         ▼                                            │
│  ┌──────────────────────────────────┐                │
│  │  internalTransfer() [Operator]    │                │
│  │  batchInternalTransfer() [Oper.]  │                │
│  │  Settlement moves balances        │                │
│  │  between accounts (no USDC move)  │                │
│  └──────────────────────────────────┘                │
│                                                       │
│  Safety: pause(), depositCap, maxWithdrawalPerTx     │
│  Admin: setOperator(), transferOwnership() (2-step)  │
└─────────────────────────────────────────────────────┘
```

## Phase 1: PerpEngine (Complete)

```
┌─────────────────────────────────────────────────────────┐
│                     PerpEngine.sol                        │
│                                                           │
│  Markets: BTC-USD, ETH-USD, etc.                         │
│  ┌───────────────────────────────────────────────────┐   │
│  │ Market Config: maxLeverage, maintenanceMarginBps, │   │
│  │                makerFeeBps, takerFeeBps, markPrice │   │
│  └───────────────────────────────────────────────────┘   │
│                                                           │
│  Positions: trader × market → Position                   │
│  ┌───────────────────────────────────────────────────┐   │
│  │ Position: size (int256 WAD, +long/-short)         │   │
│  │           entryPrice (6 dec, weighted average)     │   │
│  │           margin (USDC locked in reserve)          │   │
│  └───────────────────────────────────────────────────┘   │
│                                                           │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  │
│  │ openPosition │  │ closePosition │  │  getPnl()    │  │
│  │  (operator)  │  │  (operator)   │  │  (view)      │  │
│  └──────┬───────┘  └──────┬────────┘  └──────────────┘  │
│         │                 │                               │
│         ▼                 ▼                               │
│  ┌──────────────────────────────────────┐                │
│  │  vault.internalTransfer()            │                │
│  │  trader ←→ reserve (PnL settlement) │                │
│  └──────────────────────────────────────┘                │
│                                                           │
│  PnL: unrealizedPnl = (markPrice - entry) × size / WAD  │
│  Margin ratio = (margin + pnl) / notional                │
│  Liquidatable when marginRatio < maintenanceMarginBps    │
└─────────────────────────────────────────────────────────┘
```

## Phase 1 Target: Full Protocol

```
                    ┌──────────────┐
                    │   Frontend    │
                    │  (Next.js)    │
                    └──────┬───────┘
                           │ WebSocket + EIP-712 signed orders
                           ▼
                    ┌──────────────┐
                    │   Matching    │
                    │   Engine      │
                    │   (Rust)      │
                    └──────┬───────┘
                           │ Batch of matched trades
                           ▼
┌──────────────────────────────────────────────────────┐
│                  BASE L2 (On-Chain)                   │
│                                                       │
│  ┌─────────────┐  ┌───────────────┐  ┌────────────┐ │
│  │ PerpVault    │◄─│ OrderSettle-  │  │ Oracle     │ │
│  │ (collateral) │  │ ment.sol      │──│ Router.sol │ │
│  └──────┬──────┘  └───────┬───────┘  └────────────┘ │
│         │                 │                           │
│         ▼                 ▼                           │
│  ┌──────────────────────────────┐  ┌──────────────┐ │
│  │      PerpEngine.sol          │  │ Insurance    │ │
│  │  (positions, PnL, margin)    │──│ Fund.sol     │ │
│  └──────────────────────────────┘  └──────────────┘ │
│         │                                            │
│         ▼                                            │
│  ┌──────────────────────────────┐                    │
│  │      Liquidator.sol          │                    │
│  │  (keeper-triggered)          │                    │
│  └──────────────────────────────┘                    │
└──────────────────────────────────────────────────────┘
```

## Security Model

| Role | Permissions | Who |
|------|-------------|-----|
| Owner | Set operators, pause, set caps, transfer ownership, add markets | Gnosis Safe multisig |
| Operator (Vault) | internalTransfer, batchInternalTransfer | PerpEngine, OrderSettlement |
| Operator (Engine) | openPosition, closePosition, setMarkPrice | OrderSettlement, Oracle |
| Keeper | Trigger liquidations | Anyone (incentivized by liquidation fee) |
| User | deposit, withdraw own funds | Any wallet |

## Key Design Decisions

1. **USDC only (Phase 0)**: Simplifies accounting, avoids oracle dependency for collateral valuation
2. **6 decimal precision**: Native USDC units, no scaling needed
3. **18 decimal internal math (WAD)**: SurMath library for precise fixed-point calculations
4. **Signed position sizes**: int256 in WAD — positive = long, negative = short
5. **Weighted average entry**: On position increase, entry price is recalculated as weighted average
6. **Protocol reserve as counterparty**: Simplifies settlement vs tracking per-pair counterparties
7. **One position per trader per market**: Net position model (like dYdX, GMX)
8. **Checks-effects-interactions**: State updated before external calls
9. **Two-step ownership**: Prevents accidental ownership loss
10. **Deposit cap**: Limits TVL during early launch for risk management
11. **Max withdrawal per tx**: Rate-limits potential exploits
12. **Batch transfers**: Gas-efficient settlement of multiple trades
13. **Health check**: On-chain invariant verification in PerpVault
14. **Liquidation price calculation**: On-chain view function for frontend display
