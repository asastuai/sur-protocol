// ============================================================
// src/memory/performance-tracker.ts — Rolling Performance Analysis
// v3.2 Adaptive
// ============================================================

import type { TradeMemory, TradeMemoryRecord } from './trade-memory';

export interface EngineStats {
  engine: string;
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  profit_factor: number;
  avg_pnl: number;
  avg_win: number;
  avg_loss: number;
  total_pnl: number;
  max_consecutive_losses: number;
  current_streak: number;   // positive = win streak, negative = loss streak
  sharpe_like: number;
}

const EMPTY_STATS = (engine: string): EngineStats => ({
  engine, total_trades: 0, wins: 0, losses: 0,
  win_rate: 0, profit_factor: 0, avg_pnl: 0,
  avg_win: 0, avg_loss: 0, total_pnl: 0,
  max_consecutive_losses: 0, current_streak: 0, sharpe_like: 0,
});

export class PerformanceTracker {
  private memory: TradeMemory;
  private cache = new Map<string, { data: EngineStats; expiry: number }>();
  private TTL = 120_000; // 2 min cache

  constructor(memory: TradeMemory) {
    this.memory = memory;
  }

  getEngineStats(engine: string, lastN = 20): EngineStats {
    const key = `${engine}_${lastN}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiry > Date.now()) return cached.data;

    const trades = this.memory.getByEngine(engine, lastN);
    const stats = this.calcStats(trades, engine);
    this.cache.set(key, { data: stats, expiry: Date.now() + this.TTL });
    return stats;
  }

  invalidate(engine: string): void {
    for (const k of this.cache.keys()) {
      if (k.startsWith(engine)) this.cache.delete(k);
    }
  }

  getGlobalHealth(): {
    worst_engine: string;
    best_engine: string;
    engines_struggling: string[];   // WR < 40% with >= 10 trades
    engines_hot: string[];          // WR > 60% with >= 5 trades
  } {
    const ENGINES = ['SCALP', 'MOMENTUM', 'SWING', 'REVERSAL', 'SNIPER', 'BREAKOUT_RETEST', 'GRID', 'TREND_FOLLOW'];
    const results = ENGINES.map(e => ({ e, stats: this.getEngineStats(e, 20) }))
      .filter(r => r.stats.total_trades >= 5);

    const sorted = [...results].sort((a, b) => a.stats.total_pnl - b.stats.total_pnl);
    return {
      worst_engine: sorted[0]?.e || 'N/A',
      best_engine: sorted[sorted.length - 1]?.e || 'N/A',
      engines_struggling: results
        .filter(r => r.stats.win_rate < 40 && r.stats.total_trades >= 10)
        .map(r => r.e),
      engines_hot: results
        .filter(r => r.stats.win_rate > 60 && r.stats.total_trades >= 5)
        .map(r => r.e),
    };
  }

  private calcStats(trades: TradeMemoryRecord[], engine: string): EngineStats {
    if (trades.length === 0) return EMPTY_STATS(engine);

    const wins = trades.filter(t => t.is_win);
    const losses = trades.filter(t => !t.is_win);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    // Consecutive loss streak (trades are DESC, need ASC for streak)
    const asc = [...trades].reverse();
    let maxLoss = 0, curLoss = 0;
    for (const t of asc) {
      curLoss = t.is_win ? 0 : curLoss + 1;
      if (curLoss > maxLoss) maxLoss = curLoss;
    }

    // Current streak (DESC order)
    let streak = 0;
    for (const t of trades) {
      if (t.is_win && streak >= 0) streak++;
      else if (!t.is_win && streak <= 0) streak--;
      else break;
    }

    const pnls = trades.map(t => t.net_pnl);
    const avg = pnls.reduce((s, v) => s + v, 0) / pnls.length;
    const variance = pnls.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / pnls.length;
    const std = Math.sqrt(variance);

    return {
      engine,
      total_trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      win_rate: (wins.length / trades.length) * 100,
      profit_factor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
      avg_pnl: avg,
      avg_win: wins.length > 0 ? grossProfit / wins.length : 0,
      avg_loss: losses.length > 0 ? grossLoss / losses.length : 0,
      total_pnl: pnls.reduce((s, v) => s + v, 0),
      max_consecutive_losses: maxLoss,
      current_streak: streak,
      sharpe_like: std > 0 ? avg / std : 0,
    };
  }
}
