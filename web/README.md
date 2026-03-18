# SUR Protocol - Trading Frontend

> Professional perpetual futures trading interface built with Next.js 15.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  HEADER: Logo | BTC-USD | $50,125.00 +2.34% | Connect Wallet  │
├───────────────────────────┬─────────┬──────────────────────────┤
│                           │         │                          │
│         CHART             │ ORDER-  │     ORDER PANEL          │
│   (Lightweight Charts)    │  BOOK   │                          │
│                           │         │  [Long]  [Short]         │
│   Candlestick + Volume    │  Asks   │  Price: $50,125          │
│   1m 5m 15m 1H 4H 1D     │ ─────── │  Size:  ______ BTC      │
│                           │  Bids   │  Leverage: ═══ 5x        │
│                           │         │  [  Long BTC  ]          │
├───────────────────────────┴─────────┼──────────────────────────┤
│  POSITIONS | ORDERS | TRADES        │     RECENT TRADES        │
│  BTC-USD LONG 1.5 @ $49,850        │  50,125.00  0.2341  12:04│
│  PnL: +$412.50 (+3.30%)            │  50,110.00  0.1200  12:04│
└─────────────────────────────────────┴──────────────────────────┘
```

## Quick Start

```bash
cd web

# Install dependencies
npm install

# Configure environment
cp .env.example .env.local
# Set NEXT_PUBLIC_WS_URL and NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID

# Run development server
npm run dev

# Open http://localhost:3000
```

## Stack

- **Next.js 15** with App Router
- **TradingView Lightweight Charts** for candlestick charts
- **wagmi + RainbowKit** for wallet connection
- **Tailwind CSS** with custom dark trading theme
- **WebSocket** for real-time orderbook and trades

## Components

| Component | Description |
|-----------|-------------|
| `Header` | Market selector, price ticker, wallet connection |
| `Chart` | TradingView Lightweight Charts with candlestick + volume |
| `Orderbook` | Bid/ask visualization with depth bars |
| `OrderPanel` | Long/Short entry with leverage slider, size input, fee preview |
| `PositionsPanel` | Tabbed view: positions, open orders, trade history |
| `RecentTrades` | Live trade feed |

## WebSocket Integration

The frontend connects to the API server via WebSocket:

```typescript
import { useWebSocket } from "@/hooks/useWebSocket";

const { status, send } = useWebSocket({
  url: "ws://localhost:3002",
  channels: ["orderbook:0x...", "trades:0x..."],
  onMessage: (data) => {
    // Handle orderbook updates, trades, etc.
  },
});
```

## EIP-712 Order Signing

Orders are signed client-side using the trader's wallet:

```typescript
import { signOrder } from "@/lib/wallet";

const signature = await signOrder(walletClient, {
  trader: address,
  marketId: BTC_MARKET_ID,
  isLong: true,
  size: parseUnits("1", 8),    // 1 BTC
  price: parseUnits("50000", 6), // $50,000
  nonce: 1n,
  expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
}, chainId, SETTLEMENT_ADDRESS);
```

The signature is sent to the backend via WebSocket, which submits it to OrderSettlement.sol for on-chain execution.
