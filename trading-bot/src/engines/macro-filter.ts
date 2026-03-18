// ============================================================
// src/engines/macro-filter.ts — v6.0 Higher Timeframe Filter
// ============================================================
// Problem: Brain uses 5m EMAs → detects "UPTREND" during bear
// market dead cat bounces. 90-day backtest: $1,230 in fees lost.
//
// Solution: Overlay 1h + 4h trend analysis on top of Brain.
// If macro says BEARISH, block all LONGs even if 5m says UP.
// If macro says BULLISH, block all SHORTs even if 5m says DOWN.
// If macro says NEUTRAL/CHOP → reduce position size + frequency.
// ============================================================

import type { Candle } from '../types';
import { calcEMA } from '../indicators/technical';

export type MacroTrend = 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';

export interface MacroState {
  trend: MacroTrend;
  ema50_1h: number;
  ema200_1h: number;
  ema21_4h: number;
  ema50_4h: number;
  price_vs_ema200_pct: number;  // negative = below SMA200 = bearish
  hourlyTrend: 'UP' | 'DOWN' | 'FLAT';
  fourHourTrend: 'UP' | 'DOWN' | 'FLAT';
  score: number;                // -100 to +100
  allowLongs: boolean;
  allowShorts: boolean;
  marginMultiplier: number;     // 0.3 - 1.0 (reduces sizing in unfavorable macro)
  cooldownMultiplier: number;   // 1.0 - 3.0 (slows down trading in chop)
  reasons: string[];
  timestamp: number;
}

export class MacroFilter {
  private lastState: MacroState | null = null;

  /**
   * Analyze macro trend using 5m candles to derive 1h and 4h views.
   * Call every 5-15 minutes (doesn't need to be every candle).
   *
   * Requires at least 1000 x 5m candles (~3.5 days) for 200-period 1h EMA.
   * Ideally 2400+ x 5m candles (~8 days) for reliable 4h analysis.
   */
  analyze(candles5m: Candle[]): MacroState {
    const reasons: string[] = [];
    let score = 0;

    // ─── BUILD 1H CANDLES FROM 5M ────────────────────
    const candles1h = this.build1hCandles(candles5m);
    const candles4h = this.build4hCandles(candles1h);

    if (candles1h.length < 210) {
      // Not enough data for SMA200 on 1h — return neutral
      return this.getNeutralState('Insufficient 1h data for macro filter');
    }

    const currentPrice = candles5m[candles5m.length - 1]?.close || 0;
    if (!currentPrice) return this.getNeutralState('No price data');

    // ─── 1H ANALYSIS ─────────────────────────────────
    const closes1h = candles1h.map(c => c.close);
    const ema50_1h = calcEMA(closes1h, 50);
    const ema200_1h = calcEMA(closes1h, 200); // This is our "SMA200-1h equivalent"

    const e50_1h = ema50_1h[ema50_1h.length - 1] || currentPrice;
    const e200_1h = ema200_1h[ema200_1h.length - 1] || currentPrice;

    const priceVsEma200 = ((currentPrice - e200_1h) / e200_1h) * 100;
    const ema50vs200 = ((e50_1h - e200_1h) / e200_1h) * 100;

    // 1H EMA slopes (rate of change over 5 bars = 5 hours)
    const slope50_1h = ema50_1h.length > 5
      ? (e50_1h - (ema50_1h[ema50_1h.length - 6] || e50_1h)) / e50_1h
      : 0;
    const slope200_1h = ema200_1h.length > 5
      ? (e200_1h - (ema200_1h[ema200_1h.length - 6] || e200_1h)) / e200_1h
      : 0;

    // Score 1H factors (±40 max)
    // Price above/below EMA200
    if (priceVsEma200 > 1.5) { score += 15; reasons.push(`Price +${priceVsEma200.toFixed(1)}% above 1h EMA200 ✅`); }
    else if (priceVsEma200 > 0.3) { score += 8; reasons.push(`Price slightly above 1h EMA200`); }
    else if (priceVsEma200 < -1.5) { score -= 15; reasons.push(`Price ${priceVsEma200.toFixed(1)}% below 1h EMA200 🔴`); }
    else if (priceVsEma200 < -0.3) { score -= 8; reasons.push(`Price slightly below 1h EMA200`); }

    // Golden/Death cross on 1H (EMA50 vs EMA200)
    if (ema50vs200 > 0.5) { score += 12; reasons.push('1h Golden cross (EMA50 > EMA200)'); }
    else if (ema50vs200 < -0.5) { score -= 12; reasons.push('1h Death cross (EMA50 < EMA200)'); }

    // 1H EMA50 slope
    if (slope50_1h > 0.001) { score += 8; reasons.push('1h EMA50 rising'); }
    else if (slope50_1h < -0.001) { score -= 8; reasons.push('1h EMA50 falling'); }

    // 1H EMA200 slope (slower, more significant)
    if (slope200_1h > 0.0003) { score += 5; reasons.push('1h EMA200 rising (macro bull)'); }
    else if (slope200_1h < -0.0003) { score -= 5; reasons.push('1h EMA200 falling (macro bear)'); }

    const hourlyTrend: 'UP' | 'DOWN' | 'FLAT' =
      score > 15 ? 'UP' : score < -15 ? 'DOWN' : 'FLAT';

    // ─── 4H ANALYSIS ─────────────────────────────────
    let e21_4h = currentPrice;
    let e50_4h = currentPrice;
    let fourHourTrend: 'UP' | 'DOWN' | 'FLAT' = 'FLAT';

    if (candles4h.length >= 55) {
      const closes4h = candles4h.map(c => c.close);
      const ema21_4h = calcEMA(closes4h, 21);
      const ema50_4h_arr = calcEMA(closes4h, 50);

      e21_4h = ema21_4h[ema21_4h.length - 1] || currentPrice;
      e50_4h = ema50_4h_arr[ema50_4h_arr.length - 1] || currentPrice;

      const ema21vs50_4h = ((e21_4h - e50_4h) / e50_4h) * 100;
      const priceVs4hEma50 = ((currentPrice - e50_4h) / e50_4h) * 100;

      // 4H slope
      const slope21_4h = ema21_4h.length > 3
        ? (e21_4h - (ema21_4h[ema21_4h.length - 4] || e21_4h)) / e21_4h
        : 0;

      // Score 4H factors (±35 max)
      if (ema21vs50_4h > 0.8) { score += 12; reasons.push('4h EMA21 > EMA50 (bull structure)'); }
      else if (ema21vs50_4h < -0.8) { score -= 12; reasons.push('4h EMA21 < EMA50 (bear structure)'); }

      if (priceVs4hEma50 > 2.0) { score += 10; reasons.push(`Price +${priceVs4hEma50.toFixed(1)}% above 4h EMA50`); }
      else if (priceVs4hEma50 < -2.0) { score -= 10; reasons.push(`Price ${priceVs4hEma50.toFixed(1)}% below 4h EMA50`); }

      if (slope21_4h > 0.001) { score += 8; reasons.push('4h EMA21 rising'); }
      else if (slope21_4h < -0.001) { score -= 8; reasons.push('4h EMA21 falling'); }

      // Multi-week momentum (last 24 4h candles = 4 days)
      if (candles4h.length >= 24) {
        const pct4d = ((currentPrice - candles4h[candles4h.length - 24].close)
          / candles4h[candles4h.length - 24].close) * 100;
        if (pct4d > 3) { score += 5; reasons.push(`4-day momentum: +${pct4d.toFixed(1)}%`); }
        else if (pct4d < -3) { score -= 5; reasons.push(`4-day momentum: ${pct4d.toFixed(1)}%`); }
      }

      fourHourTrend = score > 25 ? 'UP' : score < -25 ? 'DOWN' : 'FLAT';
    }

    // ─── CLASSIFY MACRO TREND ────────────────────────
    const absScore = Math.abs(score);
    let trend: MacroTrend;
    let allowLongs = true;
    let allowShorts = true;
    let marginMultiplier = 1.0;
    let cooldownMultiplier = 1.0;

    if (absScore >= 50) {
      if (score > 0) {
        trend = 'STRONG_BULL';
        allowShorts = false;           // Block shorts in strong macro bull
        marginMultiplier = 1.0;
        cooldownMultiplier = 0.8;      // Slightly faster in strong trends
        reasons.push('🟢 MACRO: STRONG BULL — shorts blocked');
      } else {
        trend = 'STRONG_BEAR';
        allowLongs = false;            // Block longs in strong macro bear
        marginMultiplier = 1.0;
        cooldownMultiplier = 0.8;
        reasons.push('🔴 MACRO: STRONG BEAR — longs blocked');
      }
    } else if (absScore >= 25) {
      if (score > 0) {
        trend = 'BULL';
        marginMultiplier = 0.8;        // Slightly reduce counter-trend sizing
        cooldownMultiplier = 1.0;
        reasons.push('🟢 MACRO: BULL — prefer longs');
      } else {
        trend = 'BEAR';
        marginMultiplier = 0.8;
        cooldownMultiplier = 1.0;
        reasons.push('🔴 MACRO: BEAR — prefer shorts');
      }
    } else {
      trend = 'NEUTRAL';
      marginMultiplier = 0.5;          // Half sizing in macro uncertainty
      cooldownMultiplier = 2.0;        // Double cooldowns — reduce trades
      reasons.push('⚪ MACRO: NEUTRAL — reduced sizing, longer cooldowns');
    }

    const state: MacroState = {
      trend,
      ema50_1h: e50_1h,
      ema200_1h: e200_1h,
      ema21_4h: e21_4h,
      ema50_4h: e50_4h,
      price_vs_ema200_pct: priceVsEma200,
      hourlyTrend,
      fourHourTrend,
      score,
      allowLongs,
      allowShorts,
      marginMultiplier,
      cooldownMultiplier,
      reasons,
      timestamp: Date.now(),
    };

    this.lastState = state;
    return state;
  }

  getLastState(): MacroState | null { return this.lastState; }

  // ─── CANDLE BUILDERS ───────────────────────────────

  /** Build 1h candles from 5m candles (12 x 5m = 1h) */
  private build1hCandles(candles5m: Candle[]): Candle[] {
    const result: Candle[] = [];
    const PERIOD = 12; // 12 x 5min = 1h

    for (let i = 0; i + PERIOD <= candles5m.length; i += PERIOD) {
      const batch = candles5m.slice(i, i + PERIOD);
      result.push({
        openTime: batch[0].openTime,
        open: batch[0].open,
        high: Math.max(...batch.map(c => c.high)),
        low: Math.min(...batch.map(c => c.low)),
        close: batch[batch.length - 1].close,
        volume: batch.reduce((s, c) => s + c.volume, 0),
        closeTime: batch[batch.length - 1].closeTime,
        quoteVolume: batch.reduce((s, c) => s + c.quoteVolume, 0),
        trades: batch.reduce((s, c) => s + c.trades, 0),
        takerBuyBaseVol: batch.reduce((s, c) => s + c.takerBuyBaseVol, 0),
        takerBuyQuoteVol: batch.reduce((s, c) => s + c.takerBuyQuoteVol, 0),
        isClosed: true,
      });
    }
    return result;
  }

  /** Build 4h candles from 1h candles (4 x 1h = 4h) */
  private build4hCandles(candles1h: Candle[]): Candle[] {
    const result: Candle[] = [];
    const PERIOD = 4;

    for (let i = 0; i + PERIOD <= candles1h.length; i += PERIOD) {
      const batch = candles1h.slice(i, i + PERIOD);
      result.push({
        openTime: batch[0].openTime,
        open: batch[0].open,
        high: Math.max(...batch.map(c => c.high)),
        low: Math.min(...batch.map(c => c.low)),
        close: batch[batch.length - 1].close,
        volume: batch.reduce((s, c) => s + c.volume, 0),
        closeTime: batch[batch.length - 1].closeTime,
        quoteVolume: batch.reduce((s, c) => s + c.quoteVolume, 0),
        trades: batch.reduce((s, c) => s + c.trades, 0),
        takerBuyBaseVol: batch.reduce((s, c) => s + c.takerBuyBaseVol, 0),
        takerBuyQuoteVol: batch.reduce((s, c) => s + c.takerBuyQuoteVol, 0),
        isClosed: true,
      });
    }
    return result;
  }

  private getNeutralState(reason: string): MacroState {
    return {
      trend: 'NEUTRAL',
      ema50_1h: 0, ema200_1h: 0, ema21_4h: 0, ema50_4h: 0,
      price_vs_ema200_pct: 0,
      hourlyTrend: 'FLAT', fourHourTrend: 'FLAT',
      score: 0, allowLongs: true, allowShorts: true,
      marginMultiplier: 0.5, cooldownMultiplier: 2.0,
      reasons: [reason], timestamp: Date.now(),
    };
  }
}
