// ============================================================
// src/types.ts — Shared Types
// ============================================================

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  takerBuyBaseVol: number;
  takerBuyQuoteVol: number;
  isClosed: boolean;
}

export interface TickerData {
  symbol: string;
  price: number;
  priceChange: number;
  priceChangePct: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  quoteVolume24h: number;
}

export interface Indicators {
  emaFast: number;
  emaMid: number;
  emaSlow: number;
  rsi: number;
  mfi: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  bbWidth: number;
  atr: number;
  atrAvg20: number;
  volumeRatio: number;    // current vol / avg vol
  prevRsi: number;        // RSI from previous candle
}

export type Side = 'LONG' | 'SHORT';
export type SignalType = 'ENTRY_LONG' | 'ENTRY_SHORT' | 'EXIT' | 'NONE';

export interface Signal {
  type?: SignalType;
  side?: Side;
  price: number;
  timestamp?: number;
  indicators?: Indicators | Record<string, any>;
  conditions?: {
    emaCross: boolean;
    rsiConfirm: boolean;
    mfiConfirm: boolean;
    trendAlign: boolean;
    volumeConfirm: boolean;
    conditionsMet: number;
  };
  suggestedLeverage: number;
  stopLoss: number;
  takeProfit: number;
  // Swing engine extensions
  margin?: number;
  engine?: string;
  confidence?: number;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  quantity: number;
  leverage: number;
  margin: number;          // USDT margin used
  stopLoss: number;
  takeProfit: number;
  trailingActivated: boolean;
  trailingHighWater: number;
  openTime: number;
  pnl: number;
  pnlPct: number;
  status: 'OPEN' | 'CLOSED';
  closePrice?: number;
  closeTime?: number;
  closeReason?: 'TP' | 'SL' | 'TRAILING' | 'CIRCUIT_BREAKER' | 'MANUAL';
  // v2.0 fields
  tags?: string[];
  engine?: 'SCALP' | 'MOMENTUM' | 'SWING' | 'REVERSAL' | 'SNIPER' | 'BREAKOUT_RETEST' | 'GRID' | 'TREND_FOLLOW'
         | 'LEVEL_BOUNCE' | 'BREAKOUT_PLAY' | 'EXHAUSTION_REVERSAL' | 'TREND_RIDER'; // v4.0
  trailingActivationPct?: number;
  trailingCallbackPct?: number;
  // v3.0 fields
  confidence?: number;
  brainRegime?: string;
}

export interface TradeRecord {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  leverage: number;
  margin: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  netPnl: number;
  openTime: number;
  closeTime: number;
  duration: number;        // ms
  closeReason: string;
  indicators: Indicators;
  // v2.0 fields
  tags?: string[];
  engine?: 'SCALP' | 'MOMENTUM' | 'SWING' | 'REVERSAL' | 'SNIPER' | 'BREAKOUT_RETEST' | 'GRID' | 'TREND_FOLLOW'
         | 'LEVEL_BOUNCE' | 'BREAKOUT_PLAY' | 'EXHAUSTION_REVERSAL' | 'TREND_RIDER'; // v4.0
  // v3.0 fields
  confidence?: number;
  brainRegime?: string;
}

export interface Report {
  startTime: number;
  endTime: number;
  durationHours: number;
  symbol: string;
  mode: 'PAPER' | 'LIVE';
  startingCapital: number;
  finalCapital: number;
  totalPnl: number;
  totalPnlPct: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  bestTrade: TradeRecord | null;
  worstTrade: TradeRecord | null;
  avgTradeDuration: number;
  trades: TradeRecord[];
  signalsGenerated: number;
  signalsActedOn: number;
  circuitBreakerTriggered: boolean;
}

export interface ExecutorInterface {
  openPosition(signal: Signal, capital: number): Promise<Position>;
  closePosition(position: Position, price: number, reason: string): Promise<TradeRecord>;
  getOpenPositions(): Position[];
  generateReport(): Report;
  getDailyPnl(): number;
  getWeeklyPnl(): number;
  getCurrentCapital(): number;
}
