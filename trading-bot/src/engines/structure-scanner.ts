// ============================================================
// src/engines/structure-scanner.ts — v4.0 Structure-First
// Reemplaza Market Brain como fuente primaria de señales.
// 90% código del Brain v2, nuevo output: StructureState.
// ============================================================

import { calcEMA, calcRSI, calcATR } from '../indicators/technical';
import type { Candle } from '../types';

export interface StructureLevel {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  touches: number;
  strength: number;           // 0-100
  lastTouchBarsAgo: number;
}

export interface StructureState {
  // Niveles de precio
  levels: StructureLevel[];
  nearestSupport: number | null;
  nearestResistance: number | null;
  priceDistToSupport: number;     // %
  priceDistToResistance: number;  // %

  // Breakout tracking
  recentBreakout: {
    level: number;
    direction: 'UP' | 'DOWN' | 'NONE';
    barsAgo: number;
    confirmed: boolean;   // volume > 1.5x avg
  };

  // Divergencia RSI
  divergence: {
    type: 'BULLISH_DIV' | 'BEARISH_DIV' | 'NONE';
    strength: number;
  };

  // Exhaustion (standalone, sin depender del régimen)
  exhaustionScore: number;  // 0-100

  // Análisis de la última candle
  lastCandle: {
    isRejection: boolean;
    rejectionSide: 'UPPER' | 'LOWER' | 'NONE';
    isBullish: boolean;
    bodySize: number;
    upperWickRatio: number;
    lowerWickRatio: number;
  };

  // Volume
  volumeRatio: number;          // current / 20-bar avg
  volumeTrend: 'RISING' | 'FALLING' | 'FLAT';

  // Context (ex-Brain, solo advisory — modifica sizing, no bloquea)
  context: {
    emaAlignment: 'BULLISH' | 'BEARISH' | 'FLAT';
    ema21Slope: number;
    rsi5m: number;
    atrPct: number;
    trendHint: 'UP' | 'DOWN' | 'NONE';
    confidence: number;
  };

  // Derivatives data (populated by DerivativesFeed, optional)
  derivatives: {
    fundingRate: number;
    fundingSignal: 'LONGS_PAY' | 'SHORTS_PAY' | 'NEUTRAL';
    hoursUntilFunding: number;
    oiChange1h: number;
    oiTrend: 'RISING' | 'FALLING' | 'FLAT';
    longShortRatio: number;
    crowdedSide: 'LONG_CROWDED' | 'SHORT_CROWDED' | 'BALANCED';
    bookImbalance: number;
    nearestBidWall: number | null;
    nearestAskWall: number | null;
    recentLiqDominant: 'LONG_LIQD' | 'SHORT_LIQD' | 'BALANCED';
  };

  currentPrice: number;
  timestamp: number;
}

export class StructureScanner {
  // Persistent breakout state across ticks
  private lastBreakout: StructureState['recentBreakout'] = {
    level: 0, direction: 'NONE', barsAgo: 0, confirmed: false,
  };
  private lastBreakoutTimestamp = 0;

  // ── Main scan — called every tick from evaluate() ──
  scan(candles1m: Candle[], candles5m: Candle[]): StructureState {
    if (candles5m.length < 50) {
      return this.emptyState(candles5m);
    }

    const current = candles5m[candles5m.length - 1];
    const closes5m = candles5m.map(c => c.close);

    // Core indicators
    const rsi5m   = calcRSI(closes5m, 14);
    const ema21   = calcEMA(closes5m, 21);
    const ema48   = calcEMA(closes5m, 48);
    const atr5m   = calcATR(candles5m, 14);
    const rsiLast = rsi5m[rsi5m.length - 1] || 50;
    const ema21v  = ema21[ema21.length - 1] || current.close;
    const ema48v  = ema48[ema48.length - 1] || current.close;
    const ema21p  = ema21[ema21.length - 2] || ema21v;

    // Volume stats
    const vols20  = candles5m.slice(-20).map(c => c.volume);
    const avgVol  = vols20.reduce((s, v) => s + v, 0) / vols20.length;
    const volRatio = avgVol > 0 ? current.volume / avgVol : 1;

    // Structure levels
    const levels = this.detectStructureLevels(candles5m);

    // Support / Resistance closest
    const supports    = levels.filter(l => l.type === 'SUPPORT' && l.price < current.close);
    const resistances = levels.filter(l => l.type === 'RESISTANCE' && l.price > current.close);
    const nearSup     = supports.length    ? supports.reduce((a, b) => a.price > b.price ? a : b)    : null;
    const nearRes     = resistances.length ? resistances.reduce((a, b) => a.price < b.price ? a : b) : null;

    // Breakout detection (stateful — tracks bars elapsed since breakout)
    const breakout = this.detectBreakout(candles5m, levels, avgVol);

    // Divergence
    const divergence = this.detectDivergence(candles5m, rsi5m);

    // Exhaustion (standalone: doesn't need Brain regime)
    const exhaustion = this.calcExhaustionStandalone(candles5m, rsiLast, ema21v, ema48v);

    // Last candle analysis
    const lastCandle = this.analyzeLastCandle(candles5m);

    // Volume trend
    const volumeTrend = this.analyzeVolumeTrend(candles5m);

    // EMA alignment
    const emaAlignment =
      ema21v > ema48v * 1.001 ? 'BULLISH' :
      ema21v < ema48v * 0.999 ? 'BEARISH' : 'FLAT';
    const ema21Slope = ema21p > 0 ? (ema21v - ema21p) / ema21p : 0;

    return {
      levels,
      nearestSupport:       nearSup?.price ?? null,
      nearestResistance:    nearRes?.price ?? null,
      priceDistToSupport:   nearSup  ? ((current.close - nearSup.price)  / current.close) * 100 : 99,
      priceDistToResistance: nearRes ? ((nearRes.price - current.close) / current.close) * 100 : 99,
      recentBreakout:   breakout,
      divergence:       { type: divergence.type as any, strength: divergence.strength },
      exhaustionScore:  exhaustion,
      lastCandle,
      volumeRatio:      volRatio,
      volumeTrend,
      context: {
        emaAlignment,
        ema21Slope,
        rsi5m: rsiLast,
        atrPct: atr5m > 0 ? (atr5m / current.close) * 100 : 0,
        trendHint: ema21v > ema48v ? 'UP' : ema21v < ema48v ? 'DOWN' : 'NONE',
        confidence: 50,
      },
      derivatives: StructureScanner.neutralDerivatives(), // enriched async by DerivativesFeed
      currentPrice: current.close,
      timestamp: Date.now(),
    };
  }

  // ── STRUCTURE LEVELS (copied from market-brain.ts) ──
  private detectStructureLevels(candles5m: Candle[]): StructureLevel[] {
    const levels: StructureLevel[] = [];
    const lookback = Math.min(candles5m.length, 200);
    const recent = candles5m.slice(-lookback);
    const tolerance = 0.002;

    for (let i = 5; i < recent.length - 5; i++) {
      const c = recent[i];
      const isSwingHigh =
        recent.slice(i - 5, i).every(x => x.high <= c.high) &&
        recent.slice(i + 1, i + 6).every(x => x.high <= c.high);
      const isSwingLow =
        recent.slice(i - 5, i).every(x => x.low >= c.low) &&
        recent.slice(i + 1, i + 6).every(x => x.low >= c.low);

      if (isSwingHigh) {
        const existing = levels.find(
          l => l.type === 'RESISTANCE' && Math.abs(l.price - c.high) / c.high < tolerance
        );
        if (existing) {
          existing.touches++;
          existing.price = (existing.price + c.high) / 2;
          existing.lastTouchBarsAgo = recent.length - i;
          existing.strength = Math.min(100, existing.touches * 25);
        } else {
          levels.push({ price: c.high, type: 'RESISTANCE', touches: 1, strength: 20, lastTouchBarsAgo: recent.length - i });
        }
      }

      if (isSwingLow) {
        const existing = levels.find(
          l => l.type === 'SUPPORT' && Math.abs(l.price - c.low) / c.low < tolerance
        );
        if (existing) {
          existing.touches++;
          existing.price = (existing.price + c.low) / 2;
          existing.lastTouchBarsAgo = recent.length - i;
          existing.strength = Math.min(100, existing.touches * 25);
        } else {
          levels.push({ price: c.low, type: 'SUPPORT', touches: 1, strength: 20, lastTouchBarsAgo: recent.length - i });
        }
      }
    }

    return levels
      .map(l => ({ ...l, strength: Math.min(100, l.strength + (l.lastTouchBarsAgo < 20 ? 15 : 0)) }))
      .filter(l => l.strength >= 20)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 10);
  }

  // ── BREAKOUT DETECTION (stateful version) ──
  private detectBreakout(candles5m: Candle[], levels: StructureLevel[], avgVol: number): StructureState['recentBreakout'] {
    const recent = candles5m.slice(-10);
    const current = candles5m[candles5m.length - 1];

    // Check for fresh breakout
    for (const level of levels) {
      if (level.strength < 40) continue;

      if (level.type === 'RESISTANCE') {
        const wasBelow = recent.slice(0, -3).some(c => c.close < level.price);
        const isAbove  = recent.slice(-3).every(c => c.close > level.price);
        if (wasBelow && isAbove) {
          this.lastBreakout = {
            level: level.price, direction: 'UP', barsAgo: 1,
            confirmed: current.volume > avgVol * 1.5,
          };
          this.lastBreakoutTimestamp = Date.now();
          return this.lastBreakout;
        }
      }

      if (level.type === 'SUPPORT') {
        const wasAbove = recent.slice(0, -3).some(c => c.close > level.price);
        const isBelow  = recent.slice(-3).every(c => c.close < level.price);
        if (wasAbove && isBelow) {
          this.lastBreakout = {
            level: level.price, direction: 'DOWN', barsAgo: 1,
            confirmed: current.volume > avgVol * 1.5,
          };
          this.lastBreakoutTimestamp = Date.now();
          return this.lastBreakout;
        }
      }
    }

    // No fresh breakout — update barsAgo on last known breakout (5m bars = 5 min)
    if (this.lastBreakout.direction !== 'NONE' && this.lastBreakoutTimestamp > 0) {
      const minutesElapsed = (Date.now() - this.lastBreakoutTimestamp) / 60_000;
      const barsAgo = Math.round(minutesElapsed / 5);

      // Expire after 30 bars (~2.5h)
      if (barsAgo <= 30) {
        this.lastBreakout = { ...this.lastBreakout, barsAgo };
        return this.lastBreakout;
      } else {
        this.lastBreakout = { level: 0, direction: 'NONE', barsAgo: 0, confirmed: false };
      }
    }

    return { level: 0, direction: 'NONE', barsAgo: 0, confirmed: false };
  }

  // ── DIVERGENCE (copied from market-brain.ts) ──
  private detectDivergence(candles5m: Candle[], rsiValues: number[]): { type: string; strength: number } {
    const noDiv = { type: 'NONE', strength: 0 };
    if (candles5m.length < 30 || rsiValues.length < 30) return noDiv;

    const lookback = 25;
    const recent = candles5m.slice(-lookback);
    const rsiRecent = rsiValues.slice(-lookback);
    const lows: { idx: number; price: number; rsi: number }[] = [];
    const highs: { idx: number; price: number; rsi: number }[] = [];

    for (let i = 3; i < recent.length - 3; i++) {
      if (recent[i].low <= recent[i-1].low && recent[i].low <= recent[i-2].low &&
          recent[i].low <= recent[i+1].low && recent[i].low <= recent[i+2].low) {
        lows.push({ idx: i, price: recent[i].low, rsi: rsiRecent[i] || 50 });
      }
      if (recent[i].high >= recent[i-1].high && recent[i].high >= recent[i-2].high &&
          recent[i].high >= recent[i+1].high && recent[i].high >= recent[i+2].high) {
        highs.push({ idx: i, price: recent[i].high, rsi: rsiRecent[i] || 50 });
      }
    }

    if (lows.length >= 2) {
      const [prev, curr] = lows.slice(-2);
      if (curr.price < prev.price && curr.rsi > prev.rsi && curr.rsi < 40) {
        const priceDiv = ((prev.price - curr.price) / prev.price) * 100;
        const rsiDiv = curr.rsi - prev.rsi;
        return { type: 'BULLISH_DIV', strength: Math.min(100, Math.round(priceDiv * 10 + rsiDiv * 3)) };
      }
    }

    if (highs.length >= 2) {
      const [prev, curr] = highs.slice(-2);
      if (curr.price > prev.price && curr.rsi < prev.rsi && curr.rsi > 60) {
        const priceDiv = ((curr.price - prev.price) / prev.price) * 100;
        const rsiDiv = prev.rsi - curr.rsi;
        return { type: 'BEARISH_DIV', strength: Math.min(100, Math.round(priceDiv * 10 + rsiDiv * 3)) };
      }
    }

    return noDiv;
  }

  // ── EXHAUSTION (standalone — no Brain regime needed) ──
  private calcExhaustionStandalone(
    candles5m: Candle[], rsi5m: number, ema21: number, ema48: number
  ): number {
    let score = 0;
    const recent = candles5m.slice(-10);

    let consecGreen = 0, consecRed = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].close > recent[i].open) {
        if (consecRed > 0) break;
        consecGreen++;
      } else {
        if (consecGreen > 0) break;
        consecRed++;
      }
    }

    // Uptrend exhaustion signals
    if (ema21 > ema48) {
      if (rsi5m > 75)  score += 25;
      if (rsi5m > 80)  score += 15;
      if (consecGreen >= 5) score += 15;
      if (consecGreen >= 7) score += 10;
      const distFromEma = ema21 > 0 ? ((candles5m[candles5m.length-1].close - ema21) / ema21) * 100 : 0;
      if (distFromEma > 1.5) score += 15;
      if (this.analyzeVolumeTrend(candles5m) === 'FALLING') score += 20;
    }

    // Downtrend exhaustion signals
    if (ema21 < ema48) {
      if (rsi5m < 25)  score += 25;
      if (rsi5m < 20)  score += 15;
      if (consecRed >= 5)  score += 15;
      if (consecRed >= 7)  score += 10;
      const distFromEma = ema21 > 0 ? ((ema21 - candles5m[candles5m.length-1].close) / ema21) * 100 : 0;
      if (distFromEma > 1.5) score += 15;
      if (this.analyzeVolumeTrend(candles5m) === 'FALLING') score += 20;
    }

    return Math.min(100, score);
  }

  // ── LAST CANDLE ANALYSIS (new — 10 lines) ──
  private analyzeLastCandle(candles: Candle[]): StructureState['lastCandle'] {
    const c = candles[candles.length - 1];
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.close, c.open);
    const lowerWick = Math.min(c.close, c.open) - c.low;
    const bodyOrMin = Math.max(body, 0.01);
    return {
      isRejection: upperWick > body * 2 || lowerWick > body * 2,
      rejectionSide: upperWick > body * 2 ? 'UPPER' : lowerWick > body * 2 ? 'LOWER' : 'NONE',
      isBullish: c.close > c.open,
      bodySize: body,
      upperWickRatio: upperWick / bodyOrMin,
      lowerWickRatio: lowerWick / bodyOrMin,
    };
  }

  // ── VOLUME TREND (copied from market-brain.ts) ──
  analyzeVolumeTrend(candles: Candle[]): 'RISING' | 'FALLING' | 'FLAT' {
    if (candles.length < 20) return 'FLAT';
    const recent10 = candles.slice(-10).reduce((s, c) => s + c.volume, 0) / 10;
    const prev10   = candles.slice(-20, -10).reduce((s, c) => s + c.volume, 0) / 10;
    if (prev10 === 0) return 'FLAT';
    const ratio = recent10 / prev10;
    if (ratio > 1.3) return 'RISING';
    if (ratio < 0.7) return 'FALLING';
    return 'FLAT';
  }

  static neutralDerivatives(): StructureState['derivatives'] {
    return {
      fundingRate: 0, fundingSignal: 'NEUTRAL', hoursUntilFunding: 8,
      oiChange1h: 0, oiTrend: 'FLAT', longShortRatio: 1,
      crowdedSide: 'BALANCED', bookImbalance: 0,
      nearestBidWall: null, nearestAskWall: null,
      recentLiqDominant: 'BALANCED',
    };
  }

  private emptyState(candles5m: Candle[]): StructureState {
    const price = candles5m.length > 0 ? candles5m[candles5m.length - 1].close : 0;
    return {
      levels: [], nearestSupport: null, nearestResistance: null,
      priceDistToSupport: 99, priceDistToResistance: 99,
      recentBreakout: { level: 0, direction: 'NONE', barsAgo: 0, confirmed: false },
      divergence: { type: 'NONE', strength: 0 },
      exhaustionScore: 0,
      lastCandle: { isRejection: false, rejectionSide: 'NONE', isBullish: true, bodySize: 0, upperWickRatio: 0, lowerWickRatio: 0 },
      volumeRatio: 1, volumeTrend: 'FLAT',
      context: { emaAlignment: 'FLAT', ema21Slope: 0, rsi5m: 50, atrPct: 0, trendHint: 'NONE', confidence: 0 },
      derivatives: StructureScanner.neutralDerivatives(),
      currentPrice: price, timestamp: Date.now(),
    };
  }
}
