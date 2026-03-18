// ============================================================
// src/executors/paper-executor.ts — Simulated Paper Trading
// ============================================================

import type { Config } from '../config';
import type { Logger } from '../utils/logger';
import type {
  Signal, Position, TradeRecord, Report, ExecutorInterface,
} from '../types';
import { randomUUID } from 'crypto';

export class PaperExecutor implements ExecutorInterface {
  private config: Config;
  private logger: Logger;
  private capital: number;
  private openPositions: Position[] = [];
  private closedTrades: TradeRecord[] = [];
  private startTime: number = Date.now();
  private signalsGenerated = 0;
  private signalsActedOn = 0;
  private dailyPnl = 0;
  private weeklyPnl = 0;
  private dayStart: number = Date.now();
  private weekStart: number = Date.now();
  private maxCapital: number;
  private circuitBreakerTriggered = false;

  // Simulated fees (Aster Pro Mode API: maker 0%, taker 0.02%)
  private readonly TAKER_FEE = 0.0002; // 0.02%
  private readonly MAKER_FEE = 0.0000; // 0% for API

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.capital = config.STARTING_CAPITAL;
    this.maxCapital = config.STARTING_CAPITAL;
  }

  registerSignal() {
    this.signalsGenerated++;
  }

  isCircuitBreakerActive(): boolean {
    return this.circuitBreakerTriggered;
  }

  async openPosition(signal: Signal, capital: number, overrides?: {
    margin?: number;
    leverage?: number;
    tags?: string[];
    engine?: 'SCALP' | 'MOMENTUM' | 'SWING' | 'REVERSAL' | 'SNIPER' | 'BREAKOUT_RETEST' | 'GRID' | 'TREND_FOLLOW';
    trailingActivationPct?: number;
    trailingCallbackPct?: number;
    confidence?: number;
    brainRegime?: string;
  }): Promise<Position> {
    this.signalsActedOn++;

    const margin = overrides?.margin ?? capital * (this.config.POSITION_SIZE_PCT / 100);
    const leverage = overrides?.leverage ?? signal.suggestedLeverage;
    const notional = margin * leverage;
    const quantity = notional / signal.price;

    // Entry fee (taker)
    const entryFee = notional * this.TAKER_FEE;

    const position: Position = {
      id: randomUUID().slice(0, 8),
      symbol: signal.side === 'LONG' ? 'LONG' : 'SHORT',
      side: signal.side!,
      entryPrice: signal.price,
      quantity,
      leverage,
      margin: margin - entryFee, // Fee deducted from margin
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      trailingActivated: false,
      trailingHighWater: signal.price,
      openTime: Date.now(),
      pnl: -entryFee, // Start with entry fee as cost
      pnlPct: 0,
      status: 'OPEN',
      // v2.0 fields
      tags: overrides?.tags,
      engine: overrides?.engine,
      trailingActivationPct: overrides?.trailingActivationPct,
      trailingCallbackPct: overrides?.trailingCallbackPct,
      // v3.0 fields
      confidence: overrides?.confidence,
      brainRegime: overrides?.brainRegime,
    };

    this.openPositions.push(position);

    const engineTag = position.engine ? ` [${position.engine}]` : '';
    const tagsStr = position.tags?.length ? ` tags:${position.tags.join('+')}` : '';
    this.logger.trade(
      `📗 PAPER OPEN ${position.side}${engineTag} | ` +
      `Entry: $${signal.price.toFixed(2)} | ` +
      `Size: ${quantity.toFixed(6)} | ` +
      `Leverage: x${leverage} | ` +
      `Margin: $${margin.toFixed(2)} | ` +
      `SL: $${signal.stopLoss.toFixed(2)} | ` +
      `TP: $${signal.takeProfit.toFixed(2)} | ` +
      `Fee: $${entryFee.toFixed(4)}${tagsStr}`
    );

    return position;
  }

  async closePosition(
    position: Position,
    price: number,
    reason: string
  ): Promise<TradeRecord> {
    const notional = position.quantity * price;
    const exitFee = notional * this.TAKER_FEE;

    // Calculate PnL
    let rawPnl: number;
    if (position.side === 'LONG') {
      rawPnl = (price - position.entryPrice) * position.quantity;
    } else {
      rawPnl = (position.entryPrice - price) * position.quantity;
    }

    const totalFees = (position.quantity * position.entryPrice * this.TAKER_FEE) + exitFee;
    const netPnl = rawPnl - totalFees;
    const pnlPct = (netPnl / position.margin) * 100;

    // Update capital
    this.capital += netPnl;
    this.dailyPnl += netPnl;
    this.weeklyPnl += netPnl;

    // Track max capital for drawdown
    if (this.capital > this.maxCapital) {
      this.maxCapital = this.capital;
    }

    // Remove from open positions
    this.openPositions = this.openPositions.filter(p => p.id !== position.id);

    const trade: TradeRecord = {
      id: position.id,
      symbol: this.config.TRADE_SYMBOL,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: price,
      quantity: position.quantity,
      leverage: position.leverage,
      margin: position.margin,
      pnl: rawPnl,
      pnlPct,
      fees: totalFees,
      netPnl,
      openTime: position.openTime,
      closeTime: Date.now(),
      duration: Date.now() - position.openTime,
      closeReason: reason,
      indicators: {} as any, // Will be filled by engine
      // v2.0 fields
      tags: position.tags,
      engine: position.engine,
      // v3.0 fields
      confidence: position.confidence,
      brainRegime: position.brainRegime,
    };

    this.closedTrades.push(trade);
    this.logger.logTradeCSV(trade); // ← write to CSV

    const emoji = netPnl >= 0 ? '📈' : '📉';
    this.logger.trade(
      `${emoji} PAPER CLOSE ${position.side} | ` +
      `Exit: $${price.toFixed(2)} | ` +
      `PnL: $${netPnl.toFixed(2)} (${pnlPct.toFixed(2)}%) | ` +
      `Reason: ${reason} | ` +
      `Fees: $${totalFees.toFixed(4)} | ` +
      `Capital: $${this.capital.toFixed(2)}`
    );

    // Check circuit breakers
    this.checkCircuitBreakers();

    return trade;
  }

  /**
   * Update open positions with current price (for trailing stops, SL/TP)
   */
  updatePositions(currentPrice: number): { toClose: { position: Position; reason: string }[] } {
    const toClose: { position: Position; reason: string }[] = [];

    for (const pos of this.openPositions) {
      // Calculate current PnL
      if (pos.side === 'LONG') {
        pos.pnl = (currentPrice - pos.entryPrice) * pos.quantity;
        pos.pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage;
      } else {
        pos.pnl = (pos.entryPrice - currentPrice) * pos.quantity;
        pos.pnlPct = ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100 * pos.leverage;
      }

      // Check Stop Loss
      if (pos.side === 'LONG' && currentPrice <= pos.stopLoss) {
        toClose.push({ position: pos, reason: 'SL' });
        continue;
      }
      if (pos.side === 'SHORT' && currentPrice >= pos.stopLoss) {
        toClose.push({ position: pos, reason: 'SL' });
        continue;
      }

      // Check Take Profit (skip if tp = 0 — trailing-only engines like TREND_FOLLOW)
      if (pos.takeProfit > 0 && pos.side === 'LONG' && currentPrice >= pos.takeProfit) {
        toClose.push({ position: pos, reason: 'TP' });
        continue;
      }
      if (pos.takeProfit > 0 && pos.side === 'SHORT' && currentPrice <= pos.takeProfit) {
        toClose.push({ position: pos, reason: 'TP' });
        continue;
      }

      // ════════════════════════════════════════════════════════
      // ★ v5.0 TRAILING STOP — Aggressive Profit Capture
      // Key changes from v3.2:
      //   1. MIN_NET_PROFIT $0.65 → $2.50 (trade must be worth the fees)
      //   2. Minimum hold time: 60s before trailing can close
      //   3. Minimum price move: 0.15% from entry before trailing activates
      //   4. Higher activation = lets winners run further
      // ════════════════════════════════════════════════════════
      const profitPct = pos.pnlPct;
      const trailActivationPct = pos.trailingActivationPct ?? this.config.TRAILING_ACTIVATION_PCT;
      const trailCallbackPct = pos.trailingCallbackPct ?? this.config.TRAILING_CALLBACK_PCT;

      // Gate: minimum hold time — don't let trailing close trades < 60s old
      const holdTimeMs = Date.now() - pos.openTime;
      const MIN_HOLD_MS = 60_000; // 60 seconds minimum

      // Gate: minimum price move from entry (0.15% leveraged) before trailing can even activate
      const priceMovePct = pos.side === 'LONG'
        ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
      const MIN_PRICE_MOVE_PCT = 0.15; // raw price must move 0.15% in favor

      if (!pos.trailingActivated && profitPct >= trailActivationPct && priceMovePct >= MIN_PRICE_MOVE_PCT) {
        pos.trailingActivated = true;
        pos.trailingHighWater = currentPrice;
        const engineTag = pos.engine ? ` [${pos.engine}]` : '';
        this.logger.info(`🔄 Trailing activated ${pos.id}${engineTag} at $${currentPrice.toFixed(2)} | +${profitPct.toFixed(2)}% | held ${(holdTimeMs/1000).toFixed(0)}s`);
      }

      if (pos.trailingActivated) {
        // Update high water mark
        if (pos.side === 'LONG' && currentPrice > pos.trailingHighWater) {
          pos.trailingHighWater = currentPrice;
        }
        if (pos.side === 'SHORT' && currentPrice < pos.trailingHighWater) {
          pos.trailingHighWater = currentPrice;
        }

        // Check trailing callback
        const callbackPct = trailCallbackPct / 100;

        // ★ v5.0 PROFIT LOCK: much higher minimum — trade must be profitable after fees
        // With avg fees ~$0.40-0.56/trade, $2.50 ensures meaningful net profit
        const MIN_NET_PROFIT = 2.50; // was $0.65 — now trade must actually profit
        const priceDeltaForMinProfit = pos.quantity > 0 ? MIN_NET_PROFIT / pos.quantity : 0;
        const minProfitPriceLong  = pos.entryPrice + priceDeltaForMinProfit;
        const minProfitPriceShort = pos.entryPrice - priceDeltaForMinProfit;

        if (pos.side === 'LONG') {
          const trailPrice = pos.trailingHighWater * (1 - callbackPct);
          const effectiveTrailPrice = Math.max(trailPrice, minProfitPriceLong);
          // Don't close if held < minimum time
          if (holdTimeMs >= MIN_HOLD_MS && currentPrice <= effectiveTrailPrice) {
            toClose.push({ position: pos, reason: 'TRAILING' });
            continue;
          }
        } else {
          const trailPrice = pos.trailingHighWater * (1 + callbackPct);
          const effectiveTrailPrice = Math.min(trailPrice, minProfitPriceShort);
          if (holdTimeMs >= MIN_HOLD_MS && currentPrice >= effectiveTrailPrice) {
            toClose.push({ position: pos, reason: 'TRAILING' });
            continue;
          }
        }
      }

      // Liquidation check (simplified)
      const liqPct = (1 / pos.leverage) * 100 * 0.9; // ~90% of margin
      if (Math.abs(pos.pnlPct) >= liqPct && pos.pnl < 0) {
        toClose.push({ position: pos, reason: 'LIQUIDATION' });
      }
    }

    return { toClose };
  }

  private checkCircuitBreakers() {
    // Reset daily counter if new day
    const now = Date.now();
    if (now - this.dayStart > 86400000) {
      this.dailyPnl = 0;
      this.dayStart = now;
    }
    if (now - this.weekStart > 604800000) {
      this.weeklyPnl = 0;
      this.weekStart = now;
    }

    const dailyLossPct = (this.dailyPnl / this.config.STARTING_CAPITAL) * 100;
    const weeklyLossPct = (this.weeklyPnl / this.config.STARTING_CAPITAL) * 100;

    if (dailyLossPct <= -this.config.MAX_DAILY_LOSS_PCT) {
      this.circuitBreakerTriggered = true;
      this.logger.warn(
        `🚨 CIRCUIT BREAKER: Daily loss ${dailyLossPct.toFixed(2)}% exceeds -${this.config.MAX_DAILY_LOSS_PCT}%`
      );
    }

    if (weeklyLossPct <= -this.config.MAX_WEEKLY_LOSS_PCT) {
      this.circuitBreakerTriggered = true;
      this.logger.warn(
        `🚨 CIRCUIT BREAKER: Weekly loss ${weeklyLossPct.toFixed(2)}% exceeds -${this.config.MAX_WEEKLY_LOSS_PCT}%`
      );
    }
  }

  getOpenPositions(): Position[] {
    return this.openPositions;
  }

  getDailyPnl(): number {
    return this.dailyPnl;
  }

  getWeeklyPnl(): number {
    return this.weeklyPnl;
  }

  getCurrentCapital(): number {
    return this.capital;
  }

  /**
   * Get count of closed trades after a given timestamp
   */
  getClosedTradesAfter(timestamp: number): number {
    return this.closedTrades.filter(t => t.closeTime > timestamp).length;
  }

  /**
   * Get closed trades array (for engine access)
   */
  getClosedTrades(): TradeRecord[] {
    return this.closedTrades;
  }

  generateReport(): Report {
    const endTime = Date.now();
    const durationHours = (endTime - this.startTime) / 3600000;

    const wins = this.closedTrades.filter(t => t.netPnl > 0);
    const losses = this.closedTrades.filter(t => t.netPnl <= 0);

    const totalGross = wins.reduce((s, t) => s + t.netPnl, 0);
    const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));

    // Max drawdown calculation
    let peak = this.config.STARTING_CAPITAL;
    let maxDD = 0;
    let runningCapital = this.config.STARTING_CAPITAL;

    for (const trade of this.closedTrades) {
      runningCapital += trade.netPnl;
      if (runningCapital > peak) peak = runningCapital;
      const dd = peak - runningCapital;
      if (dd > maxDD) maxDD = dd;
    }

    const avgDuration = this.closedTrades.length > 0
      ? this.closedTrades.reduce((s, t) => s + t.duration, 0) / this.closedTrades.length
      : 0;

    return {
      startTime: this.startTime,
      endTime,
      durationHours,
      symbol: this.config.TRADE_SYMBOL,
      mode: 'PAPER',
      startingCapital: this.config.STARTING_CAPITAL,
      finalCapital: this.capital,
      totalPnl: this.capital - this.config.STARTING_CAPITAL,
      totalPnlPct: ((this.capital - this.config.STARTING_CAPITAL) / this.config.STARTING_CAPITAL) * 100,
      totalTrades: this.closedTrades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: this.closedTrades.length > 0
        ? (wins.length / this.closedTrades.length) * 100
        : 0,
      avgWin: wins.length > 0 ? totalGross / wins.length : 0,
      avgLoss: losses.length > 0 ? totalLoss / losses.length : 0,
      profitFactor: totalLoss > 0 ? totalGross / totalLoss : totalGross > 0 ? Infinity : 0,
      maxDrawdown: maxDD,
      maxDrawdownPct: peak > 0 ? (maxDD / peak) * 100 : 0,
      bestTrade: wins.length > 0
        ? wins.reduce((best, t) => t.netPnl > best.netPnl ? t : best)
        : null,
      worstTrade: losses.length > 0
        ? losses.reduce((worst, t) => t.netPnl < worst.netPnl ? t : worst)
        : null,
      avgTradeDuration: avgDuration,
      trades: this.closedTrades,
      signalsGenerated: this.signalsGenerated,
      signalsActedOn: this.signalsActedOn,
      circuitBreakerTriggered: this.circuitBreakerTriggered,
    };
  }
}
