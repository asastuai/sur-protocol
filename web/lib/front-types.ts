// Trading Types for DEX Perpetuals (from FRONT v0 project)

export interface Market {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  nextFunding: string;
  markPrice: number;
  indexPrice: number;
}

export interface OrderBookEntry {
  price: number;
  size: number;
  total: number;
  percentage: number;
}

export interface OrderBook {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  spread: number;
  spreadPercentage: number;
}

export interface Trade {
  id: string;
  price: number;
  size: number;
  side: 'buy' | 'sell';
  timestamp: number;
}

export interface Position {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  margin: number;
  leverage: number;
  unrealizedPnl: number;
  unrealizedPnlPercentage: number;
  realizedPnl: number;
}

export interface Order {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market' | 'stop' | 'stop-limit' | 'take-profit';
  status: 'open' | 'partial' | 'filled' | 'cancelled';
  price: number;
  size: number;
  filled: number;
  remaining: number;
  reduceOnly: boolean;
  postOnly: boolean;
  timestamp: number;
}

export interface CandlestickData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeFormData {
  side: 'long' | 'short';
  orderType: 'market' | 'limit';
  size: number;
  price?: number;
  leverage: number;
  reduceOnly: boolean;
  takeProfit?: number;
  stopLoss?: number;
}

export interface WalletState {
  connected: boolean;
  address: string | null;
  balance: number;
  availableBalance: number;
  marginBalance: number;
  unrealizedPnl: number;
}
