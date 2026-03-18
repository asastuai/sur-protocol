# SUR Protocol - Liquidation Keeper Bot

> Automated bot that monitors positions and liquidates undercollateralized ones, earning keeper rewards.

## How It Works

```
┌─────────────────────────────────────────────┐
│              Keeper Bot                      │
│                                             │
│  ┌─────────────┐    ┌────────────────────┐  │
│  │  Position    │    │   Liquidation      │  │
│  │  Tracker     │───▶│   Scanner          │  │
│  │              │    │                    │  │
│  │ Indexes all  │    │ Checks all tracked │  │
│  │ open pos via │    │ positions via      │  │
│  │ PerpEngine   │    │ multicall          │  │
│  │ events       │    │ isLiquidatable()   │  │
│  └──────────────┘    └────────┬───────────┘  │
│                               │              │
│                     ┌─────────▼───────────┐  │
│                     │   Executor          │  │
│                     │                     │  │
│                     │ Simulates tx first  │  │
│                     │ Then calls          │  │
│                     │ Liquidator.sol      │  │
│                     │ liquidate() or      │  │
│                     │ liquidateBatch()    │  │
│                     └─────────────────────┘  │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
              ┌──────────────────┐
              │   Base L2        │
              │  Liquidator.sol  │──▶ PerpEngine.liquidatePosition()
              │  (permissionless)│     Keeper earns reward
              └──────────────────┘
```

## Revenue Model

| Scenario | Keeper Reward | Example ($50k BTC position) |
|----------|--------------|---------------------------|
| Healthy liquidation | 50% of remaining margin (cap 5% notional) | ~$500-1,250 |
| Underwater liquidation | 0.05% of notional (from insurance) | ~$25 |
| Gas cost per liquidation | ~$0.01-0.05 on Base L2 | $0.02 |

## Quick Start

```bash
cd keeper

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your keeper wallet key and contract addresses

# Run
npm run dev     # development (auto-reload)
npm start       # production
```

## Output Example

```
╔═══════════════════════════════════════════════╗
║     SUR Protocol - Liquidation Keeper Bot      ║
║   Automated position monitoring & liquidation  ║
╚═══════════════════════════════════════════════╝

[Config] Network:    Base Sepolia
[Config] Keeper:     0x742d35Cc6634C0532925a3b844Bc9e7595f2bD38
[Config] Scan every: 5000ms
[Keeper] ETH balance: 0.150000 ETH
[Boot] Phase 1: Syncing historical positions...
[Tracker] Sync complete. 42 active positions tracked.
[Boot] Phase 2: Starting real-time event watcher...

  KEEPER BOT RUNNING
  Monitoring 42 positions
  Scanning every 5s

[Scan #3] 🎯 Found 2 liquidatable position(s)!
  → 0x742d35Cc... LONG 1.5000 | margin: $3,750.00 | est. reward: $1,875.00
  → 0xAb5801a7... SHORT 0.8000 | margin: $2,000.00 | est. reward: $1,000.00
[Execute] Liquidating 2 position(s)...
  ✅ 0x742d35Cc... liquidated | tx: 0xabc123def... | reward: ~$1,875.00
  ✅ 0xAb5801a7... liquidated | tx: 0xabc123def... | reward: ~$1,000.00
[Stats] Uptime: 0.5h | Scans: 36 | Liquidations: 2 (0 failed) | Rewards: $2,875.00 | Gas: 0.000040 ETH
```

## Key Design Decisions

**Simulate before execute:** Every liquidation is simulated via `simulateContract()` before spending gas. This catches reverts from race conditions (another keeper got there first).

**Batch when possible:** Uses `liquidateBatch()` for multiple liquidations in one tx, reducing gas costs. Falls back to individual `liquidate()` if the batch reverts.

**Multicall for scanning:** Checks all positions in a single RPC call using `multicall`. Handles 100+ positions without hitting rate limits.

**Minimum reward threshold:** Configurable minimum reward ($0.10 default) to avoid wasting gas on tiny positions.

**Event-driven position tracking:** Doesn't poll the chain for position data. Instead, listens to PositionOpened/Modified/Closed/Liquidated events to maintain a live registry.

## Module Overview

| File | Lines | Description |
|------|-------|-------------|
| `src/index.ts` | Main loop, config, boot sequence, stats dashboard |
| `src/tracker.ts` | Position indexer via PerpEngine events |
| `src/scanner.ts` | Liquidation detection + execution + P&L tracking |
| `src/abis.ts` | Contract ABIs (PerpEngine, Liquidator, Vault) |
