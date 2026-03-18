# SUR Protocol Documentation

## Overview

SUR Protocol is the first perpetual futures DEX built for Argentina and Latin America. Trade BTC and ETH perpetuals with up to 20x leverage on Base L2.

## Architecture

- **Smart Contracts** (`contracts/`): Solidity contracts deployed on Base Sepolia
  - `Settlement.sol` — Batch settlement of matched trades
  - `Vault.sol` — USDC deposit/withdrawal for margin
  - `Engine.sol` — On-chain position and margin tracking
- **API Server** (`api/`): Node.js WebSocket backend
  - In-memory matching engine with price-time priority
  - Real-time orderbook and trade streaming
  - Settlement pipeline batching trades for on-chain execution
- **Frontend** (`web/`): Next.js 15 + React 19 + Tailwind CSS
  - Real-time trading interface with lightweight-charts
  - Paper trading mode for testing without wallet
  - RainbowKit + wagmi for wallet connection
- **Oracle Keeper** (`oracle-keeper/`): Price feed relay
- **Risk Engine** (`risk-engine/`): Liquidation monitoring
- **SDK** (`sdk/`): TypeScript SDK for programmatic access

## Contracts (Base Sepolia)

| Contract   | Address                                      |
|------------|----------------------------------------------|
| Settlement | `0x7297429477254843cB00A6e17C5B1f83B3AE2Eec` |
| Engine     | `0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6` |
| Vault      | `0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81` |

## Markets

| Market  | Max Leverage | Tick Size | Lot Size | Maker Fee | Taker Fee |
|---------|-------------|-----------|----------|-----------|-----------|
| BTC-USD | 20x         | $0.01     | 0.0001   | 0.02%     | 0.06%     |
| ETH-USD | 15x         | $0.01     | 0.001    | 0.02%     | 0.06%     |

## Running Locally

```bash
# API Server (WebSocket on port 3002)
cd api && npm install && npm run dev

# Frontend (localhost:3000)
cd web && npm install && npm run dev
```

## Order Types

- **Market** — Executes immediately at best available price
- **Limit** — Rests on orderbook until price is reached
- **Stop Limit** — Triggers a limit order when stop price is hit

## Time in Force

- **GTC** — Good til cancelled
- **IOC** — Immediate or cancel (partial fills ok)
- **FOK** — Fill or kill (all or nothing)
- **Post Only** — Rejected if it would match (maker only)

## Paper Trading

The frontend includes a built-in paper trading mode with $100,000 USDC balance. No wallet required. Positions track P&L in real-time against the live orderbook mid-price.

## EIP-712 Order Signing

All orders are signed client-side using EIP-712 typed data before submission. The signature is verified during on-chain settlement.

## WebSocket API

Connect to `ws://localhost:3002`

### Subscribe
```json
{ "type": "subscribe", "channels": ["orderbook:{marketId}", "trades:{marketId}"] }
```

### Submit Order
```json
{
  "type": "submitOrder",
  "order": {
    "trader": "0x...",
    "marketId": "0x...",
    "side": "buy",
    "orderType": "limit",
    "price": "84500000000",
    "size": "10000000",
    "timeInForce": "GTC",
    "nonce": "1",
    "expiry": "1710000000",
    "signature": "0x..."
  }
}
```

### Server Messages
- `orderbook` — Full orderbook snapshot
- `orderbookUpdate` — Incremental update
- `trade` — New trade execution
- `orderAccepted` / `orderRejected` / `orderCancelled`
