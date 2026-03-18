// ============================================================
// src/engines/market-brain.ts — Market Intelligence Layer
// ============================================================

import type { Candle, Indicators } from '../types';
import { calcEMA, calcRSI, calcATR, calcBollingerBands, calcMFI } from '../indicators/technical';

export type Regime = 'UPTREND' | 'DOWNTREND' | 'CHOP' | 'TRANSITION' | 'REVERSAL_ZONE';
export type SpecialEvent = 'NONE' | 'CAPITULATION' | 'EUPHORIA' | 'SQUEEZE' | 'BREAKOUT' | 'EXHAUSTION' | 'RETEST';
export type AllowedSides = 'LONG_ONLY' | 'SHORT_ONLY' | 'BOTH' | 'NONE';

export interface MarketState {
  regime: Regime;
  specialEvent: SpecialEvent;
  confidence: number;          // 0-100
  allowedSides: AllowedSides;
  bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  leverageMultiplier: number;  // 0.5 - 1.5
  positionSizeMultiplier: number; // 0.5 - 3.0 (for high-conviction events)
  reasons: string[];
  timestamp: number;

  // Metrics for logging
  metrics: {
    ema21_slope_5m: number;
    ema48_slope_5m: number;
    price_vs_ema21_pct: number;
    price_vs_ema48_pct: number;
    rsi_5m: number;
    rsi_1h: number;            // derived from 5m candles
    mfi_5m: number;
    bb_width_5m: number;
    atr_pct: number;
    momentum_1h_pct: number;
    momentum_4h_pct: number;
    volume_trend: 'RISING' | 'FALLING' | 'FLAT';
    higher_highs: boolean;
    lower_lows: boolean;
    consec_green_5m: number;
    consec_red_5m: number;
    distance_from_20bar_high_pct: number;
    distance_from_20bar_low_pct: number;
  };
}

// ── v3.0 additions ──────────────────────────────────────────

export interface StructureLevel {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  touches: number;
  strength: number;       // 0-100
  lastTouchBarsAgo: number;
}

export interface DivergenceSignal {
  type: 'BULLISH_DIV' | 'BEARISH_DIV' | 'HIDDEN_BULL_DIV' | 'HIDDEN_BEAR_DIV' | 'NONE';
  strength: number;       // 0-100
  priceLow1: number;
  priceLow2: number;
  rsiLow1: number;
  rsiLow2: number;
}

export interface MarketStateV2 extends MarketState {
  structureLevels: StructureLevel[];
  nearestSupport: number | null;
  nearestResistance: number | null;
  divergence: DivergenceSignal;
  exhaustionScore: number;
  recentBreakoutLevel: number | null;
  recentBreakoutBarsAgo: number;
}

export class MarketBrain {
  private lastState: MarketState | null = null;
  private stateHistory: MarketState[] = [];
  private readonly ANALYSIS_INTERVAL = 180_000; // v3.0: 3 minutes (was 5)
  private lastAnalysisTime = 0;

  // v3.0 — breakout tracking across analysis cycles
  private recentBreakoutLevel: number | null = null;
  private recentBreakoutBarsAgo = 0;

  /**
   * Call on every 1m candle close — internally decides if full analysis needed
   */
  shouldAnalyze(): boolean {
    return Date.now() - this.lastAnalysisTime >= this.ANALYSIS_INTERVAL;
  }

  /**
   * Run full market analysis
   */
  analyze(candles1m: Candle[], candles5m: Candle[]): MarketState {
    this.lastAnalysisTime = Date.now();
    const reasons: string[] = [];
    let score = 0; // positive = bullish, negative = bearish

    const currentPrice = candles1m[candles1m.length - 1]?.close || 0;
    if (currentPrice === 0 || candles5m.length < 60) {
      return this.getDefaultState();
    }

    // ─── 5-MINUTE TIMEFRAME ANALYSIS ───────────────
    const closes5m = candles5m.map(c => c.close);
    const idx5m = closes5m.length - 1;
    const ema21_5m = calcEMA(closes5m, 21);
    const ema48_5m = calcEMA(closes5m, 48);
    const rsi5m = calcRSI(closes5m, 14);
    const mfi5m = calcMFI(candles5m, 14);
    const bb5m = calcBollingerBands(closes5m, 20, 2);
    const atr5m = calcATR(candles5m, 14);

    // EMA slopes (rate of change over last 5 bars of 5m = 25 minutes)
    const ema21Slope = this.calcSlope(ema21_5m, 5);
    const ema48Slope = this.calcSlope(ema48_5m, 5);

    // Price position
    const priceVsEma21 = ((currentPrice - (ema21_5m[idx5m] || currentPrice)) / currentPrice) * 100;
    const priceVsEma48 = ((currentPrice - (ema48_5m[idx5m] || currentPrice)) / currentPrice) * 100;

    const currentRsi5m = rsi5m[idx5m] || 50;
    const currentMfi5m = mfi5m[idx5m] || 50;
    const currentBBWidth = bb5m.width[idx5m] || 0;
    const currentATR = atr5m[idx5m] || 0;
    const atrPct = (currentATR / currentPrice) * 100;

    // ─── 1-MINUTE MOMENTUM ─────────────────────────
    const closes1m = candles1m.map(c => c.close);
    const momentum1h = candles1m.length >= 60
      ? ((currentPrice - candles1m[candles1m.length - 60].close) / candles1m[candles1m.length - 60].close) * 100
      : 0;
    const momentum4h = candles1m.length >= 240
      ? ((currentPrice - candles1m[candles1m.length - 240].close) / candles1m[candles1m.length - 240].close) * 100
      : 0;

    // ─── MARKET STRUCTURE ──────────────────────────
    const { higherHighs, lowerLows } = this.detectStructure(candles5m);
    const { consecGreen, consecRed } = this.countConsecCandles(candles5m);
    const volumeTrend = this.analyzeVolumeTrend(candles5m);

    // Distance from recent high/low
    const recent20 = candles5m.slice(-20);
    const recentHigh = Math.max(...recent20.map(c => c.high));
    const recentLow = Math.min(...recent20.map(c => c.low));
    const distFromHigh = ((currentPrice - recentHigh) / currentPrice) * 100;
    const distFromLow = ((currentPrice - recentLow) / currentPrice) * 100;

    // Pseudo 1h RSI from 5m candles (12 x 5m = 1h)
    const rsi1h = candles5m.length >= 180 
      ? this.calcPseudoHigherTFRsi(candles5m, 12, 14)
      : currentRsi5m;

    // ─── SCORING ───────────────────────────────────

    // Factor 1: EMA alignment & slopes (±25)
    if (ema21_5m[idx5m] > ema48_5m[idx5m]) {
      score += 12;
      reasons.push('EMA21 > EMA48 (bull alignment)');
    } else {
      score -= 12;
      reasons.push('EMA21 < EMA48 (bear alignment)');
    }

    if (ema21Slope > 0.0005) { score += 7; reasons.push('EMA21 rising'); }
    else if (ema21Slope < -0.0005) { score -= 7; reasons.push('EMA21 falling'); }

    if (ema48Slope > 0.0003) { score += 6; }
    else if (ema48Slope < -0.0003) { score -= 6; }

    // Factor 2: Price position (±15)
    if (priceVsEma21 > 0.15) { score += 8; reasons.push(`Price +${priceVsEma21.toFixed(2)}% above EMA21`); }
    else if (priceVsEma21 < -0.15) { score -= 8; reasons.push(`Price ${priceVsEma21.toFixed(2)}% below EMA21`); }

    if (priceVsEma48 > 0.3) { score += 7; }
    else if (priceVsEma48 < -0.3) { score -= 7; }

    // Factor 3: RSI & MFI (±15)
    if (currentRsi5m > 55) { score += 5; }
    else if (currentRsi5m < 45) { score -= 5; }
    if (currentRsi5m > 70) { score += 5; reasons.push(`RSI overbought: ${currentRsi5m.toFixed(0)}`); }
    if (currentRsi5m < 30) { score -= 5; reasons.push(`RSI oversold: ${currentRsi5m.toFixed(0)}`); }

    if (currentMfi5m > 60) { score += 3; }
    else if (currentMfi5m < 40) { score -= 3; }

    // Factor 4: Structure (±15)
    if (higherHighs) { score += 12; reasons.push('Higher highs (bullish structure)'); }
    if (lowerLows) { score -= 12; reasons.push('Lower lows (bearish structure)'); }

    // Factor 5: Momentum (±15)
    if (momentum1h > 0.5) { score += 5; reasons.push(`1h momentum: +${momentum1h.toFixed(2)}%`); }
    else if (momentum1h < -0.5) { score -= 5; reasons.push(`1h momentum: ${momentum1h.toFixed(2)}%`); }

    if (momentum4h > 1.5) { score += 8; reasons.push(`4h momentum: +${momentum4h.toFixed(2)}% strong uptrend`); }
    else if (momentum4h < -1.5) { score -= 8; reasons.push(`4h momentum: ${momentum4h.toFixed(2)}% strong downtrend`); }

    // Factor 6: Volume (±5)
    if (volumeTrend === 'RISING' && score > 0) { score += 5; reasons.push('Volume rising with trend'); }
    if (volumeTrend === 'RISING' && score < 0) { score -= 5; }

    // ─── DETECT SPECIAL EVENTS ─────────────────────

    let specialEvent: SpecialEvent = 'NONE';
    let positionSizeMultiplier = 1.0;

    // CAPITULATION: RSI < 20, MFI < 15, 5+ consecutive red candles, 
    // price >2% below EMA48, momentum4h < -3%
    if (currentRsi5m < 22 && currentMfi5m < 20 && consecRed >= 4 && 
        priceVsEma48 < -1.5 && momentum4h < -2.5) {
      specialEvent = 'CAPITULATION';
      positionSizeMultiplier = 2.5;  // Go bigger on capitulation buys
      reasons.push('🔴 CAPITULATION DETECTED — extreme oversold, high conviction LONG');
    }

    // EUPHORIA: RSI > 80, MFI > 85, 5+ consecutive green, price >2% above EMA48
    if (currentRsi5m > 78 && currentMfi5m > 80 && consecGreen >= 4 && 
        priceVsEma48 > 1.5 && momentum4h > 2.5) {
      specialEvent = 'EUPHORIA';
      positionSizeMultiplier = 2.0;  // Go bigger on euphoria shorts
      reasons.push('🟢 EUPHORIA DETECTED — extreme overbought, high conviction SHORT');
    }

    // SQUEEZE: BB Width extremely narrow → explosion incoming
    if (currentBBWidth < 0.15 && atrPct < 0.05) {
      specialEvent = 'SQUEEZE';
      positionSizeMultiplier = 1.5;
      reasons.push('⚡ BOLLINGER SQUEEZE — breakout imminent');
    }

    // BREAKOUT: Price breaks 20-bar high/low with volume
    if (distFromHigh > -0.05 && volumeTrend === 'RISING' && momentum1h > 0.5) {
      specialEvent = 'BREAKOUT';
      positionSizeMultiplier = 2.0;
      reasons.push('🚀 BREAKOUT — new 20-bar high with volume');
    }
    if (distFromLow < 0.05 && volumeTrend === 'RISING' && momentum1h < -0.5) {
      specialEvent = 'BREAKOUT';
      positionSizeMultiplier = 2.0;
      reasons.push('💥 BREAKDOWN — new 20-bar low with volume');
    }

    // ─── CLASSIFY REGIME ───────────────────────────

    const absScore = Math.abs(score);
    let regime: Regime;
    let allowedSides: AllowedSides;
    let bias: 'LONG' | 'SHORT' | 'NEUTRAL';
    let leverageMultiplier: number;

    if (absScore >= 40) {
      // Strong trend
      regime = score > 0 ? 'UPTREND' : 'DOWNTREND';
      allowedSides = score > 0 ? 'LONG_ONLY' : 'SHORT_ONLY';
      bias = score > 0 ? 'LONG' : 'SHORT';
      leverageMultiplier = 1.2; // More leverage in clear trends
      reasons.push(`Strong ${regime} (score: ${score})`);
    } else if (absScore >= 20) {
      // Moderate trend — allow both but bias one direction
      regime = score > 0 ? 'UPTREND' : 'DOWNTREND';
      allowedSides = 'BOTH';
      bias = score > 0 ? 'LONG' : 'SHORT';
      leverageMultiplier = 1.0;
      reasons.push(`Moderate ${regime} (score: ${score})`);
    } else if (absScore >= 10) {
      // Transitioning
      regime = 'TRANSITION';
      allowedSides = 'BOTH';
      bias = 'NEUTRAL';
      leverageMultiplier = 0.7; // Reduce leverage in transition
      reasons.push(`Transitioning (score: ${score})`);
    } else {
      // Chop / ranging
      regime = 'CHOP';
      allowedSides = 'NONE'; // Don't trade in chop!
      bias = 'NEUTRAL';
      leverageMultiplier = 0.5;
      reasons.push(`CHOP — no clear direction (score: ${score})`);
    }

    // Override: Special events can override CHOP restriction
    if (specialEvent === 'CAPITULATION') {
      allowedSides = 'LONG_ONLY';
      bias = 'LONG';
      leverageMultiplier = 0.8; // Conservative leverage on extreme events
    }
    if (specialEvent === 'EUPHORIA') {
      allowedSides = 'SHORT_ONLY';
      bias = 'SHORT';
      leverageMultiplier = 0.8;
    }

    const state: MarketState = {
      regime,
      specialEvent,
      confidence: Math.min(100, absScore * 1.5),
      allowedSides,
      bias,
      leverageMultiplier,
      positionSizeMultiplier,
      reasons,
      timestamp: Date.now(),
      metrics: {
        ema21_slope_5m: ema21Slope,
        ema48_slope_5m: ema48Slope,
        price_vs_ema21_pct: priceVsEma21,
        price_vs_ema48_pct: priceVsEma48,
        rsi_5m: currentRsi5m,
        rsi_1h: rsi1h,
        mfi_5m: currentMfi5m,
        bb_width_5m: currentBBWidth,
        atr_pct: atrPct,
        momentum_1h_pct: momentum1h,
        momentum_4h_pct: momentum4h,
        volume_trend: volumeTrend,
        higher_highs: higherHighs,
        lower_lows: lowerLows,
        consec_green_5m: consecGreen,
        consec_red_5m: consecRed,
        distance_from_20bar_high_pct: distFromHigh,
        distance_from_20bar_low_pct: distFromLow,
      },
    };

    this.lastState = state;
    this.stateHistory.push(state);
    if (this.stateHistory.length > 200) this.stateHistory.shift();

    return state;
  }

  // ─── MARKET BRAIN v2 ─────────────────────────────────────

  /**
   * v3.0: Extended analysis with structure mapper, divergence, exhaustion
   */
  analyzeV2(candles1m: Candle[], candles5m: Candle[]): MarketStateV2 {
    // Get base state (also sets this.lastState)
    const baseState = this.analyze(candles1m, candles5m);

    const closes5m = candles5m.map(c => c.close);
    const rsiValues = calcRSI(closes5m, 14);
    const currentRsi5m = rsiValues[rsiValues.length - 1] || 50;
    const currentPrice = candles5m[candles5m.length - 1]?.close || 0;

    // Structure levels
    const structureLevels = this.detectStructureLevels(candles5m);

    // Nearest S/R
    const supports = structureLevels.filter(l => l.type === 'SUPPORT' && l.price < currentPrice);
    const resistances = structureLevels.filter(l => l.type === 'RESISTANCE' && l.price > currentPrice);
    const nearestSupport = supports.length > 0
      ? Math.max(...supports.map(l => l.price))
      : null;
    const nearestResistance = resistances.length > 0
      ? Math.min(...resistances.map(l => l.price))
      : null;

    // Divergence detection
    const divergence = this.detectDivergence(candles5m, rsiValues);

    // Exhaustion score
    const exhaustionScore = this.calcExhaustionScore(baseState, candles5m, currentRsi5m);

    // Breakout detection
    const breakoutInfo = this.detectBreakout(candles5m, structureLevels);
    if (breakoutInfo.level && breakoutInfo.direction !== 'NONE') {
      this.recentBreakoutLevel = breakoutInfo.level;
      this.recentBreakoutBarsAgo = 1;
    } else if (this.recentBreakoutBarsAgo > 0) {
      this.recentBreakoutBarsAgo++;
      // Reset after 50 bars (too old)
      if (this.recentBreakoutBarsAgo > 50) {
        this.recentBreakoutLevel = null;
        this.recentBreakoutBarsAgo = 0;
      }
    }

    // Regime override
    let regime = baseState.regime;
    if (exhaustionScore > 70 && divergence.type !== 'NONE') {
      regime = 'REVERSAL_ZONE';
    }

    // Special event override
    let specialEvent = baseState.specialEvent;
    if (exhaustionScore > 60 && divergence.strength > 40) {
      specialEvent = 'EXHAUSTION';
    }
    if (this.recentBreakoutLevel && this.recentBreakoutBarsAgo <= 5) {
      specialEvent = 'BREAKOUT';
    }
    if (this.recentBreakoutLevel && this.recentBreakoutBarsAgo > 5 && this.recentBreakoutBarsAgo < 30) {
      const distFromLevel = Math.abs(currentPrice - this.recentBreakoutLevel) / this.recentBreakoutLevel;
      if (distFromLevel < 0.003) {
        specialEvent = 'RETEST';
      }
    }

    const v2State: MarketStateV2 = {
      ...baseState,
      regime,
      specialEvent,
      structureLevels,
      nearestSupport,
      nearestResistance,
      divergence,
      exhaustionScore,
      recentBreakoutLevel: this.recentBreakoutLevel,
      recentBreakoutBarsAgo: this.recentBreakoutBarsAgo,
    };

    // Update lastState with the richer v2 state
    this.lastState = v2State;
    return v2State;
  }

  // ─── STRUCTURE LEVEL DETECTION ───────────────────────────

  private detectStructureLevels(candles5m: Candle[]): StructureLevel[] {
    const levels: StructureLevel[] = [];
    const lookback = Math.min(candles5m.length, 200);
    const recent = candles5m.slice(-lookback);
    const tolerance = 0.002; // 0.2% tolerance

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
          levels.push({
            price: c.high, type: 'RESISTANCE', touches: 1,
            strength: 20, lastTouchBarsAgo: recent.length - i,
          });
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
          levels.push({
            price: c.low, type: 'SUPPORT', touches: 1,
            strength: 20, lastTouchBarsAgo: recent.length - i,
          });
        }
      }
    }

    return levels
      .map(l => ({
        ...l,
        strength: Math.min(100, l.strength + (l.lastTouchBarsAgo < 20 ? 15 : 0)),
      }))
      .filter(l => l.strength >= 20)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 10);
  }

  // ─── RSI DIVERGENCE DETECTION ────────────────────────────

  private detectDivergence(candles5m: Candle[], rsiValues: number[]): DivergenceSignal {
    const noDiv: DivergenceSignal = {
      type: 'NONE', strength: 0, priceLow1: 0, priceLow2: 0, rsiLow1: 0, rsiLow2: 0,
    };
    if (candles5m.length < 30 || rsiValues.length < 30) return noDiv;

    const lookback = 25;
    const recent = candles5m.slice(-lookback);
    const rsiRecent = rsiValues.slice(-lookback);

    const lows: { idx: number; price: number; rsi: number }[] = [];
    const highs: { idx: number; price: number; rsi: number }[] = [];

    for (let i = 3; i < recent.length - 3; i++) {
      if (recent[i].low <= recent[i - 1].low && recent[i].low <= recent[i - 2].low &&
          recent[i].low <= recent[i + 1].low && recent[i].low <= recent[i + 2].low) {
        lows.push({ idx: i, price: recent[i].low, rsi: rsiRecent[i] || 50 });
      }
      if (recent[i].high >= recent[i - 1].high && recent[i].high >= recent[i - 2].high &&
          recent[i].high >= recent[i + 1].high && recent[i].high >= recent[i + 2].high) {
        highs.push({ idx: i, price: recent[i].high, rsi: rsiRecent[i] || 50 });
      }
    }

    // Bullish divergence
    if (lows.length >= 2) {
      const [prev, curr] = lows.slice(-2);
      if (curr.price < prev.price && curr.rsi > prev.rsi && curr.rsi < 40) {
        const priceDiv = ((prev.price - curr.price) / prev.price) * 100;
        const rsiDiv = curr.rsi - prev.rsi;
        return {
          type: 'BULLISH_DIV',
          strength: Math.min(100, Math.round(priceDiv * 10 + rsiDiv * 3)),
          priceLow1: prev.price, priceLow2: curr.price,
          rsiLow1: prev.rsi, rsiLow2: curr.rsi,
        };
      }
    }

    // Bearish divergence
    if (highs.length >= 2) {
      const [prev, curr] = highs.slice(-2);
      if (curr.price > prev.price && curr.rsi < prev.rsi && curr.rsi > 60) {
        const priceDiv = ((curr.price - prev.price) / prev.price) * 100;
        const rsiDiv = prev.rsi - curr.rsi;
        return {
          type: 'BEARISH_DIV',
          strength: Math.min(100, Math.round(priceDiv * 10 + rsiDiv * 3)),
          priceLow1: prev.price, priceLow2: curr.price,
          rsiLow1: prev.rsi, rsiLow2: curr.rsi,
        };
      }
    }

    return noDiv;
  }

  // ─── EXHAUSTION SCORE ────────────────────────────────────

  private calcExhaustionScore(state: MarketState, candles5m: Candle[], rsi5m: number): number {
    let score = 0;

    if (state.regime === 'UPTREND') {
      if (rsi5m > 75) score += 25;
      if (rsi5m > 80) score += 15;
      if (state.metrics.volume_trend === 'FALLING') score += 20;
      if (state.metrics.consec_green_5m >= 5) score += 15;
      if (state.metrics.consec_green_5m >= 7) score += 10;
      if (state.metrics.price_vs_ema21_pct > 1.5) score += 15;
    } else if (state.regime === 'DOWNTREND') {
      if (rsi5m < 25) score += 25;
      if (rsi5m < 20) score += 15;
      if (state.metrics.volume_trend === 'FALLING') score += 20;
      if (state.metrics.consec_red_5m >= 5) score += 15;
      if (state.metrics.consec_red_5m >= 7) score += 10;
      if (state.metrics.price_vs_ema21_pct < -1.5) score += 15;
    }

    return Math.min(100, score);
  }

  // ─── BREAKOUT DETECTION ──────────────────────────────────

  private detectBreakout(
    candles5m: Candle[],
    levels: StructureLevel[]
  ): { level: number | null; barsAgo: number; direction: 'UP' | 'DOWN' | 'NONE' } {
    const recent = candles5m.slice(-10);

    for (const level of levels) {
      if (level.strength < 40) continue;

      if (level.type === 'RESISTANCE') {
        const wasBelow = recent.slice(0, -3).some(c => c.close < level.price);
        const isAbove = recent.slice(-3).every(c => c.close > level.price);
        if (wasBelow && isAbove) {
          return { level: level.price, barsAgo: 1, direction: 'UP' };
        }
      }

      if (level.type === 'SUPPORT') {
        const wasAbove = recent.slice(0, -3).some(c => c.close > level.price);
        const isBelow = recent.slice(-3).every(c => c.close < level.price);
        if (wasAbove && isBelow) {
          return { level: level.price, barsAgo: 1, direction: 'DOWN' };
        }
      }
    }

    return { level: null, barsAgo: 0, direction: 'NONE' };
  }

  getLastState(): MarketState | null {
    return this.lastState;
  }

  // ─── HELPER METHODS ──────────────────────────────

  private calcSlope(arr: number[], lookback: number): number {
    const end = arr.length - 1;
    const start = Math.max(0, end - lookback);
    if (!arr[end] || !arr[start] || arr[start] === 0) return 0;
    return (arr[end] - arr[start]) / arr[start];
  }

  private detectStructure(candles: Candle[]): { higherHighs: boolean; lowerLows: boolean } {
    if (candles.length < 30) return { higherHighs: false, lowerLows: false };

    // Find swing points in last 30 candles
    const recent = candles.slice(-30);
    const swingHighs: number[] = [];
    const swingLows: number[] = [];

    for (let i = 2; i < recent.length - 2; i++) {
      if (recent[i].high > recent[i-1].high && recent[i].high > recent[i-2].high &&
          recent[i].high > recent[i+1].high && recent[i].high > recent[i+2].high) {
        swingHighs.push(recent[i].high);
      }
      if (recent[i].low < recent[i-1].low && recent[i].low < recent[i-2].low &&
          recent[i].low < recent[i+1].low && recent[i].low < recent[i+2].low) {
        swingLows.push(recent[i].low);
      }
    }

    const higherHighs = swingHighs.length >= 2 && 
      swingHighs[swingHighs.length - 1] > swingHighs[swingHighs.length - 2];
    const lowerLows = swingLows.length >= 2 && 
      swingLows[swingLows.length - 1] < swingLows[swingLows.length - 2];

    return { higherHighs, lowerLows };
  }

  private countConsecCandles(candles: Candle[]): { consecGreen: number; consecRed: number } {
    let green = 0, red = 0;
    for (let i = candles.length - 1; i >= Math.max(0, candles.length - 10); i--) {
      if (candles[i].close > candles[i].open) {
        if (red > 0) break;
        green++;
      } else {
        if (green > 0) break;
        red++;
      }
    }
    return { consecGreen: green, consecRed: red };
  }

  private analyzeVolumeTrend(candles: Candle[]): 'RISING' | 'FALLING' | 'FLAT' {
    if (candles.length < 20) return 'FLAT';
    const recent10 = candles.slice(-10).reduce((s, c) => s + c.volume, 0) / 10;
    const prev10 = candles.slice(-20, -10).reduce((s, c) => s + c.volume, 0) / 10;
    if (prev10 === 0) return 'FLAT';
    const ratio = recent10 / prev10;
    if (ratio > 1.3) return 'RISING';
    if (ratio < 0.7) return 'FALLING';
    return 'FLAT';
  }

  private calcPseudoHigherTFRsi(candles5m: Candle[], barsPerPeriod: number, rsiPeriod: number): number {
    // Aggregate 5m candles into pseudo-1h candles, then compute RSI
    const aggregated: number[] = [];
    for (let i = 0; i < candles5m.length; i += barsPerPeriod) {
      const chunk = candles5m.slice(i, i + barsPerPeriod);
      if (chunk.length === barsPerPeriod) {
        aggregated.push(chunk[chunk.length - 1].close);
      }
    }
    if (aggregated.length < rsiPeriod + 1) return 50;
    const rsiArr = calcRSI(aggregated, rsiPeriod);
    return rsiArr[rsiArr.length - 1] || 50;
  }

  private getDefaultState(): MarketState {
    return {
      regime: 'CHOP', specialEvent: 'NONE', confidence: 0,
      allowedSides: 'NONE', bias: 'NEUTRAL', leverageMultiplier: 0.5,
      positionSizeMultiplier: 1.0, reasons: ['Insufficient data'],
      timestamp: Date.now(),
      metrics: {
        ema21_slope_5m: 0, ema48_slope_5m: 0, price_vs_ema21_pct: 0,
        price_vs_ema48_pct: 0, rsi_5m: 50, rsi_1h: 50, mfi_5m: 50,
        bb_width_5m: 0, atr_pct: 0, momentum_1h_pct: 0, momentum_4h_pct: 0,
        volume_trend: 'FLAT', higher_highs: false, lower_lows: false,
        consec_green_5m: 0, consec_red_5m: 0,
        distance_from_20bar_high_pct: 0, distance_from_20bar_low_pct: 0,
      },
    };
  }
}
