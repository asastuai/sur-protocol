# @sur-protocol/sdk

> Integrate with SUR Protocol in 5 lines of code.

## Install

```bash
npm install @sur-protocol/sdk viem
```

## Quick Start

```typescript
import { SurClient } from "@sur-protocol/sdk";

const sur = new SurClient({
  rpcUrl: "https://sepolia.base.org",
  wsUrl: "ws://localhost:3002",
  contracts: {
    vault: "0x...",
    engine: "0x...",
    settlement: "0x...",
  },
});

// Read a position
const pos = await sur.getPosition("BTC-USD", "0xTrader...");
console.log(`${pos.side} ${pos.size} BTC @ $${pos.entryPrice} | PnL: $${pos.unrealizedPnl}`);

// Read balance
const bal = await sur.getBalance("0xTrader...");
console.log(`Available: $${bal.available} USDC`);

// Read market data
const market = await sur.getMarket("BTC-USD");
console.log(`BTC-USD: $${market.markPrice} | OI: ${market.openInterestLong} long / ${market.openInterestShort} short`);
```

## Trading

```typescript
import { createWalletClient, custom } from "viem";
import { baseSepolia } from "viem/chains";

// Connect wallet
const walletClient = createWalletClient({
  chain: baseSepolia,
  transport: custom(window.ethereum),
});

// Submit order (signs EIP-712 + sends via WebSocket)
sur.connect();
await sur.submitOrder(walletClient, {
  market: "BTC-USD",
  side: "buy",
  size: 1.5,         // 1.5 BTC
  price: 50000,      // $50,000
  timeInForce: "GTC",
});

// Cancel
sur.cancelOrder("order_1");
```

## Real-Time Data

```typescript
sur.connect();
sur.subscribe("BTC-USD");

// Trades
sur.onTrade("BTC-USD", (trade) => {
  console.log(`${trade.side} ${trade.size} BTC @ $${trade.price}`);
});

// Orderbook
sur.onOrderbook("BTC-USD", (book) => {
  console.log(`Bid: $${book.bids[0]?.price} | Ask: $${book.asks[0]?.price} | Spread: $${book.spread}`);
});

// Order status
sur.onOrderStatus((status) => {
  console.log(`Order ${status.orderId}: ${status.status}`);
});
```

## Cross Margin

```typescript
// Check current margin mode
const mode = await sur.getMarginMode("0xTrader...");
console.log(`Mode: ${mode}`); // "isolated" or "cross"

// Switch to cross margin (must have no open positions)
await sur.setMarginMode(walletClient, "cross");

// Get full account details (cross-margin portfolio view)
const account = await sur.getAccountDetails("0xTrader...");
console.log(`Equity: $${account.totalEquity}`);
console.log(`Positions: ${account.positionCount}`);
console.log(`PnL: $${account.totalUnrealizedPnl}`);
console.log(`Available margin: $${account.availableMargin}`);
console.log(`Leverage: ${account.effectiveLeverage}x`);
console.log(`Liquidatable: ${account.isLiquidatable}`);

// In cross mode, profits from BTC can offset ETH losses:
// Long 1 BTC @ $50K → BTC goes to $55K (+$5,000 PnL)
// Long 10 ETH @ $3K → ETH drops to $2,800 (-$2,000 PnL)
// Net PnL: +$3,000 → not liquidatable even if ETH position alone would be
```

## Precision Helpers

```typescript
import { toPrice, toSize, fromPrice, fromSize, marketId } from "@sur-protocol/sdk";

toPrice(50000);      // 50000000000n (6 decimals)
toSize(1.5);         // 150000000n   (8 decimals)
fromPrice(50000000000n); // 50000
fromSize(150000000n);    // 1.5
marketId("BTC-USD"); // 0x... (bytes32)
```

## API Reference

### `SurClient`

| Method | Description |
|--------|-------------|
| `getPosition(market, trader)` | Read position: size, entry, margin, PnL, liq status |
| `getBalance(trader)` | Read available USDC in vault |
| `getMarket(market)` | Read market data: prices, OI, active status |
| `submitOrder(wallet, order)` | Sign EIP-712 + submit via WebSocket |
| `cancelOrder(orderId)` | Cancel an open order |
| `connect()` | Connect to WebSocket API |
| `subscribe(market)` | Subscribe to market's orderbook + trades |
| `onTrade(market, callback)` | Listen for trade events |
| `onOrderbook(market, callback)` | Listen for orderbook updates |
| `onOrderStatus(callback)` | Listen for order status changes |
| `disconnect()` | Close WebSocket |
