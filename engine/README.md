# SUR Protocol - Matching Engine

> High-performance off-chain matching engine for perpetual futures, written in Rust.

## Architecture

```
┌───────────────────────────────────────┐
│          MatchingEngine               │
│                                       │
│  submit_order() ──► match_order()     │
│                      │                │
│              ┌───────┴───────┐        │
│              │   OrderBook   │        │
│              │               │        │
│              │  Bids (desc)  │        │
│              │  ────────     │        │
│              │  50,000 [3]   │        │
│              │  49,900 [1]   │        │
│              │               │        │
│              │  Asks (asc)   │        │
│              │  ────────     │        │
│              │  50,100 [2]   │        │
│              │  50,200 [1]   │        │
│              └───────────────┘        │
│                      │                │
│              ┌───────┴───────┐        │
│              │    Trades     │        │
│              │  (settlement  │        │
│              │   batches)    │        │
│              └───────────────┘        │
└───────────────────────────────────────┘
```

## Features (Phase 0)

- **Price-time priority** matching (best price first, then FIFO)
- **Order types**: Limit, Market
- **Time-in-force**: GTC, IOC, FOK, PostOnly
- **Fee calculation**: Maker/taker fee model (2bps / 6bps)
- **Partial fills**: Orders can be partially filled across multiple price levels
- **Order cancellation**: O(1) lookup by order ID
- **Fixed-point arithmetic**: No floating point in price/quantity calculations

## Quick Start

```bash
cd engine

# Build
cargo build

# Run tests
cargo test

# Run with logging
RUST_LOG=sur_engine=debug cargo run

# Run benchmarks
cargo bench
```

## Module Overview

| Module | Description |
|--------|-------------|
| `types` | Core types: Price, Quantity, Order, Trade, MarketConfig |
| `orderbook` | OrderBook data structure with BTreeMap price levels |
| `matching` | MatchingEngine with order validation & matching algorithm |

## How Matching Works

1. **Incoming order** is validated (quantity, price alignment, lot size)
2. **PostOnly check**: reject if would match immediately
3. **FOK check**: verify full liquidity exists before matching
4. **Match loop**: compare against opposite side of book
   - Buy orders match against asks (lowest price first)
   - Sell orders match against bids (highest price first)
   - Trades execute at **maker's price** (price improvement for taker)
5. **Post-match**: remaining quantity handled per TimeInForce policy
   - GTC: place on book
   - IOC: cancel remainder
   - FOK: all-or-nothing (already checked)

## Fixed-Point Precision

| Type | Decimals | Scale | Example |
|------|----------|-------|---------|
| Price | 6 | 1,000,000 | $50,000.00 = `50_000_000_000` |
| Quantity | 8 | 100,000,000 | 1.5 BTC = `150_000_000` |

## Phase 1 Roadmap

- [ ] WebSocket API (tokio + tungstenite)
- [ ] EIP-712 signature verification (alloy)
- [ ] Settlement batch creation (for on-chain submission)
- [ ] PostgreSQL persistence
- [ ] Redis orderbook cache
- [ ] Rate limiting per trader
- [ ] Self-trade prevention
- [ ] Multiple markets support
