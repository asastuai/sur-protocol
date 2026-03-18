# SUR Protocol - Backend API

> WebSocket server + settlement pipeline connecting traders to Base L2.

## Architecture

```
┌─────────────────┐
│  Trader Wallet   │
│ (signs EIP-712)  │
└────────┬────────┘
         │ WebSocket
         ▼
┌──────────────────────────────────────────┐
│            API Server (Node.js)           │
│                                          │
│  ┌──────────────┐  ┌──────────────────┐  │
│  │  WS Server   │──│ Matching Engine  │  │
│  │  (port 3002) │  │ (per market)     │  │
│  └──────┬───────┘  └──────┬───────────┘  │
│         │                 │ matched       │
│         │                 │ trades        │
│         │          ┌──────▼───────────┐  │
│         │          │   Settlement     │  │
│         │          │   Pipeline       │  │
│         │          └──────┬───────────┘  │
│         │                 │ batches      │
│  ┌──────▼───────┐  ┌──────▼───────────┐  │
│  │  On-Chain    │  │  Wallet Client   │  │
│  │  Indexer     │  │  (operator key)  │  │
│  └──────────────┘  └──────────────────┘  │
└──────────────────────┬───────────────────┘
                       │ JSON-RPC
                       ▼
              ┌──────────────────┐
              │   Base L2        │
              │  OrderSettlement │
              │  PerpEngine      │
              │  PerpVault       │
              └──────────────────┘
```

## Quick Start

```bash
cd api

# Install dependencies
npm install

# Copy env and configure
cp .env.example .env
# Edit .env with your contract addresses and operator key

# Run in development mode
npm run dev

# Build for production
npm run build
npm start
```

## WebSocket Protocol

Connect to `ws://localhost:3002`

### Client → Server Messages

```json
// Subscribe to channels
{ "type": "subscribe", "channels": ["orderbook:0x...", "trades:0x..."] }

// Submit signed order
{
  "type": "submitOrder",
  "order": {
    "trader": "0xAlice...",
    "marketId": "0x...",
    "side": "buy",
    "orderType": "limit",
    "price": "50000000000",
    "size": "100000000",
    "timeInForce": "GTC",
    "nonce": "1",
    "expiry": "1711900800",
    "signature": "0x..."
  }
}

// Cancel order
{ "type": "cancelOrder", "orderId": "uuid-here" }

// Heartbeat
{ "type": "ping" }
```

### Server → Client Messages

```json
// Order accepted
{ "type": "orderAccepted", "orderId": "...", "status": "open" }

// Trade executed
{ "type": "trade", "trade": { "id": "...", "price": "50000000000", "size": "100000000", "makerSide": "sell", "timestamp": 1711900800 } }

// Orderbook update
{ "type": "orderbookUpdate", "marketId": "0x...", "bids": [...], "asks": [...] }

// Heartbeat response
{ "type": "pong" }
```

## Settlement Pipeline

The pipeline batches matched trades and submits them to `OrderSettlement.sol`:

1. Engine matches two orders → produces a `Trade`
2. Pipeline queues the trade with both original signed orders
3. Every `BATCH_INTERVAL_MS` (default 2s), pipeline flushes:
   - Single trade → `settleOne()` (cheaper gas)
   - Multiple trades → `settleBatch()`
4. Waits for tx confirmation
5. Emits events for WebSocket broadcast

If a batch fails (tx reverts), trades are re-queued for the next batch.

## Module Overview

| Module | Description |
|--------|-------------|
| `src/types/` | Core types matching contracts + Rust engine |
| `src/config/` | Environment, contract addresses, ABIs |
| `src/engine/` | In-memory orderbook with price-time priority |
| `src/settlement/` | Batches trades, submits to OrderSettlement.sol |
| `src/ws/` | WebSocket server for client connections |
| `src/indexer/` | Reads on-chain state (positions, balances) |
| `src/index.ts` | Entry point, boots all components |
