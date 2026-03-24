import type { Market, OrderBook, Position, Order, Trade, CandlestickData } from './front-types';

// Generate mock candlestick data
export function generateCandlestickData(basePrice: number, count: number): CandlestickData[] {
  const data: CandlestickData[] = [];
  let price = basePrice;
  const now = Date.now();

  for (let i = count; i >= 0; i--) {
    const volatility = 0.02;
    const change = (Math.random() - 0.5) * 2 * volatility * price;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * volatility * price * 0.5;
    const low = Math.min(open, close) - Math.random() * volatility * price * 0.5;

    data.push({
      time: now - i * 60 * 1000,
      open,
      high,
      low,
      close,
      volume: Math.random() * 1000000 + 500000,
    });

    price = close;
  }

  return data;
}

// Mock markets data
export const mockMarkets: Market[] = [
  {
    symbol: 'BTC-PERP',
    baseAsset: 'BTC',
    quoteAsset: 'USD',
    price: 67234.50,
    change24h: 2.34,
    high24h: 68100.00,
    low24h: 65800.00,
    volume24h: 2_450_000_000,
    openInterest: 890_000_000,
    fundingRate: 0.0045,
    nextFunding: '04:23:15',
    markPrice: 67238.25,
    indexPrice: 67230.00,
  },
  {
    symbol: 'ETH-PERP',
    baseAsset: 'ETH',
    quoteAsset: 'USD',
    price: 3456.78,
    change24h: -1.23,
    high24h: 3520.00,
    low24h: 3420.00,
    volume24h: 1_230_000_000,
    openInterest: 450_000_000,
    fundingRate: 0.0032,
    nextFunding: '04:23:15',
    markPrice: 3457.12,
    indexPrice: 3455.90,
  },
  {
    symbol: 'SOL-PERP',
    baseAsset: 'SOL',
    quoteAsset: 'USD',
    price: 178.45,
    change24h: 5.67,
    high24h: 182.00,
    low24h: 168.00,
    volume24h: 890_000_000,
    openInterest: 234_000_000,
    fundingRate: 0.0078,
    nextFunding: '04:23:15',
    markPrice: 178.52,
    indexPrice: 178.40,
  },
  {
    symbol: 'ARB-PERP',
    baseAsset: 'ARB',
    quoteAsset: 'USD',
    price: 1.245,
    change24h: -3.45,
    high24h: 1.32,
    low24h: 1.21,
    volume24h: 156_000_000,
    openInterest: 45_000_000,
    fundingRate: -0.0012,
    nextFunding: '04:23:15',
    markPrice: 1.246,
    indexPrice: 1.244,
  },
  {
    symbol: 'DOGE-PERP',
    baseAsset: 'DOGE',
    quoteAsset: 'USD',
    price: 0.1234,
    change24h: 8.90,
    high24h: 0.1280,
    low24h: 0.1120,
    volume24h: 234_000_000,
    openInterest: 67_000_000,
    fundingRate: 0.0156,
    nextFunding: '04:23:15',
    markPrice: 0.1235,
    indexPrice: 0.1233,
  },
  {
    symbol: 'AVAX-PERP',
    baseAsset: 'AVAX',
    quoteAsset: 'USD',
    price: 42.67,
    change24h: 1.23,
    high24h: 43.50,
    low24h: 41.20,
    volume24h: 178_000_000,
    openInterest: 89_000_000,
    fundingRate: 0.0023,
    nextFunding: '04:23:15',
    markPrice: 42.69,
    indexPrice: 42.65,
  },
];

// Generate mock order book
export function generateOrderBook(basePrice: number): OrderBook {
  const bids: { price: number; size: number; total: number; percentage: number }[] = [];
  const asks: { price: number; size: number; total: number; percentage: number }[] = [];

  let bidTotal = 0;
  let askTotal = 0;

  for (let i = 0; i < 15; i++) {
    const bidPrice = basePrice - (i + 1) * (basePrice * 0.0002);
    const askPrice = basePrice + (i + 1) * (basePrice * 0.0002);
    const bidSize = Math.random() * 10 + 0.5;
    const askSize = Math.random() * 10 + 0.5;

    bidTotal += bidSize;
    askTotal += askSize;

    bids.push({ price: bidPrice, size: bidSize, total: bidTotal, percentage: 0 });
    asks.push({ price: askPrice, size: askSize, total: askTotal, percentage: 0 });
  }

  const maxTotal = Math.max(bidTotal, askTotal);
  bids.forEach(b => b.percentage = (b.total / maxTotal) * 100);
  asks.forEach(a => a.percentage = (a.total / maxTotal) * 100);

  const spread = asks[0].price - bids[0].price;
  const spreadPercentage = (spread / basePrice) * 100;

  return { bids, asks, spread, spreadPercentage };
}

// Mock recent trades
export function generateRecentTrades(basePrice: number, count: number): Trade[] {
  const trades: Trade[] = [];
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    trades.push({
      id: `trade-${i}`,
      price: basePrice + (Math.random() - 0.5) * basePrice * 0.001,
      size: Math.random() * 5 + 0.1,
      side: Math.random() > 0.5 ? 'buy' : 'sell',
      timestamp: now - i * (Math.random() * 5000 + 1000),
    });
  }

  return trades;
}

// Mock positions
export const mockPositions: Position[] = [
  {
    id: 'pos-1',
    symbol: 'BTC-PERP',
    side: 'long',
    size: 0.5,
    entryPrice: 65000,
    markPrice: 67234.50,
    liquidationPrice: 52000,
    margin: 3250,
    leverage: 10,
    unrealizedPnl: 1117.25,
    unrealizedPnlPercentage: 34.38,
    realizedPnl: 0,
  },
  {
    id: 'pos-2',
    symbol: 'ETH-PERP',
    side: 'short',
    size: 2.5,
    entryPrice: 3500,
    markPrice: 3456.78,
    liquidationPrice: 4200,
    margin: 875,
    leverage: 10,
    unrealizedPnl: 108.05,
    unrealizedPnlPercentage: 12.35,
    realizedPnl: 0,
  },
];

// Mock open orders
export const mockOrders: Order[] = [
  {
    id: 'ord-1',
    symbol: 'BTC-PERP',
    side: 'buy',
    type: 'limit',
    status: 'open',
    price: 65000,
    size: 0.25,
    filled: 0,
    remaining: 0.25,
    reduceOnly: false,
    postOnly: true,
    timestamp: Date.now() - 3600000,
  },
  {
    id: 'ord-2',
    symbol: 'ETH-PERP',
    side: 'sell',
    type: 'stop-limit',
    status: 'open',
    price: 3400,
    size: 1.0,
    filled: 0,
    remaining: 1.0,
    reduceOnly: true,
    postOnly: false,
    timestamp: Date.now() - 7200000,
  },
];
