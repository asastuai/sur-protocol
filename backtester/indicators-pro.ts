// ============================================================
// indicators-pro.ts — Professional Indicator Extensions
//
// NUEVOS INDICADORES (6):
//   6. VWAP    — Volume Weighted Avg Price + σ bands (institutional S/R)
//   7. VPOC    — Volume Profile: POC, VAH, VAL (donde se concentra el volumen)
//   8. ADX_DMI — Trend Strength + Direction (ADX > 25 = trend, < 20 = chop)
//   9. VOL_REGIME — ATR Percentile (¿estamos en alta o baja volatilidad?)
//  10. MTF_EMA — Multi-Timeframe EMA Alignment (1m, 5m, 1h confluencia)
//  11. DELTA   — Buy/Sell Pressure estimation (quién controla: bulls o bears)
//
// MEJORAS:
//   - PAPivot ahora acepta daily candles directamente
//   - Weekly pivots además de daily
//   - CPR (Central Pivot Range)
//
// CONFLUENCE GATE:
//   - Cada indicador vota LONG/SHORT/NEUTRAL
//   - Trade solo se ejecuta si N de M indicadores confirman
//   - Configurable: cuántos necesitás (default: 6 de 11)
//
// USAGE:
//   import { ProHub } from './indicators-pro';
//   const hub = new ProHub();
//   hub.update1m(candle1m);           // cada candle 1m
//   hub.update5m(candle5m);           // cada candle 5m
//   hub.feedDailyCandle(dailyCandle); // al inicio o cada día nuevo
//   const gate = hub.evaluate(price, 'LONG');
//   if (gate.approved) { /* execute trade */ }
// ============================================================

import type { Candle, Side } from './indicators';

// Re-export everything from base
export * from './indicators';

// ════════════════════════════════════════════════════════════
// 6. VWAP — Volume Weighted Average Price
//
// El nivel institucional por excelencia. Cuando el precio está
// arriba del VWAP, los compradores del día tienen profit.
// Cuando está abajo, los vendedores dominan.
//
// Incluye bandas de ±1σ, ±2σ, ±3σ (desviación estándar)
// que actúan como S/R dinámico intraday.
// ════════════════════════════════════════════════════════════

export interface VWAPState {
  vwap: number;
  upperBand1: number;  // +1σ
  upperBand2: number;  // +2σ
  lowerBand1: number;  // -1σ
  lowerBand2: number;  // -2σ
  priceRelative: number; // price position relative to VWAP [-1 to +1]
  isAbove: boolean;
}

export class VWAP {
  private cumTPV = 0;     // cumulative (typical_price × volume)
  private cumVol = 0;     // cumulative volume
  private cumTPV2 = 0;    // for variance calculation
  private currentDay = 0;
  private vwap = 0;
  private stdDev = 0;
  private barCount = 0;

  update(candle: Candle) {
    const day = Math.floor(candle.closeTime / 86_400_000);

    // Reset at new day
    if (day !== this.currentDay) {
      this.cumTPV = 0;
      this.cumVol = 0;
      this.cumTPV2 = 0;
      this.barCount = 0;
      this.currentDay = day;
    }

    const tp = (candle.high + candle.low + candle.close) / 3;
    this.cumTPV += tp * candle.volume;
    this.cumVol += candle.volume;
    this.cumTPV2 += tp * tp * candle.volume;
    this.barCount++;

    if (this.cumVol > 0) {
      this.vwap = this.cumTPV / this.cumVol;
      // Standard deviation
      const meanTP2 = this.cumTPV2 / this.cumVol;
      const variance = Math.max(0, meanTP2 - this.vwap * this.vwap);
      this.stdDev = Math.sqrt(variance);
    }
  }

  getState(price: number): VWAPState | null {
    if (this.barCount < 5 || this.vwap === 0) return null;

    const s = this.stdDev;
    const maxDist = Math.max(s * 2, this.vwap * 0.001); // prevent div/0
    const relative = Math.max(-1, Math.min(1, (price - this.vwap) / maxDist));

    return {
      vwap: this.vwap,
      upperBand1: this.vwap + s,
      upperBand2: this.vwap + 2 * s,
      lowerBand1: this.vwap - s,
      lowerBand2: this.vwap - 2 * s,
      priceRelative: relative,
      isAbove: price > this.vwap,
    };
  }

  /** Vote: LONG si price rebota desde VWAP abajo, SHORT si rechaza arriba */
  vote(price: number): IndicatorVote {
    const state = this.getState(price);
    if (!state) return { name: 'VWAP', bias: 'NEUTRAL', strength: 0, reason: 'Warming up' };

    // Near lower band = potential long
    if (state.priceRelative < -0.7) {
      return { name: 'VWAP', bias: 'LONG', strength: Math.min(1, Math.abs(state.priceRelative)), reason: `Below VWAP -${Math.abs(state.priceRelative * 100).toFixed(0)}%σ` };
    }
    // Near upper band = potential short
    if (state.priceRelative > 0.7) {
      return { name: 'VWAP', bias: 'SHORT', strength: Math.min(1, state.priceRelative), reason: `Above VWAP +${(state.priceRelative * 100).toFixed(0)}%σ` };
    }
    // Price near VWAP = neutral, use direction for weak signal
    if (state.isAbove) return { name: 'VWAP', bias: 'LONG', strength: 0.2, reason: 'Above VWAP (weak bull)' };
    return { name: 'VWAP', bias: 'SHORT', strength: 0.2, reason: 'Below VWAP (weak bear)' };
  }
}

// ════════════════════════════════════════════════════════════
// 7. VPOC — Volume Profile (Point of Control)
//
// Divide el rango de precios en buckets y cuenta cuánto
// volumen se tradeo en cada nivel. El POC es el precio
// con más volumen — actúa como imán/soporte fuerte.
//
// VAH = Value Area High (70% del volumen arriba)
// VAL = Value Area Low (70% del volumen abajo)
// Rango entre VAH-VAL = "valor justo" — price tiende a volver acá.
// ════════════════════════════════════════════════════════════

export interface VolumeProfileState {
  poc: number;       // Point of Control (highest volume price)
  vah: number;       // Value Area High
  val: number;       // Value Area Low
  totalVolume: number;
  priceInVA: boolean; // is current price inside value area?
  abovePOC: boolean;
}

export class VolumeProfile {
  private buckets: Map<number, number> = new Map(); // price_bucket → volume
  private bucketSize: number;
  private sessionVolume = 0;
  private currentDay = 0;

  constructor(bucketSize = 10) {
    this.bucketSize = bucketSize; // $10 per bucket for BTC
  }

  update(candle: Candle) {
    const day = Math.floor(candle.closeTime / 86_400_000);
    if (day !== this.currentDay) {
      this.buckets.clear();
      this.sessionVolume = 0;
      this.currentDay = day;
    }

    // Distribute volume across the candle's range
    const steps = Math.max(1, Math.round((candle.high - candle.low) / this.bucketSize));
    const volPerStep = candle.volume / steps;

    for (let i = 0; i <= steps; i++) {
      const p = candle.low + (candle.high - candle.low) * (i / steps);
      const bucket = Math.round(p / this.bucketSize) * this.bucketSize;
      this.buckets.set(bucket, (this.buckets.get(bucket) || 0) + volPerStep);
    }
    this.sessionVolume += candle.volume;
  }

  getState(price: number): VolumeProfileState | null {
    if (this.buckets.size < 5) return null;

    // Find POC (bucket with most volume)
    let maxVol = 0, poc = 0;
    for (const [p, v] of this.buckets) {
      if (v > maxVol) { maxVol = v; poc = p; }
    }

    // Calculate Value Area (70% of total volume centered on POC)
    const sorted = [...this.buckets.entries()].sort((a, b) => a[0] - b[0]);
    const target = this.sessionVolume * 0.70;
    let accumulated = 0;

    // Start from POC and expand outward
    const pocIdx = sorted.findIndex(([p]) => p === poc);
    let lo = pocIdx, hi = pocIdx;
    accumulated = sorted[pocIdx][1];

    while (accumulated < target && (lo > 0 || hi < sorted.length - 1)) {
      const expandLo = lo > 0 ? sorted[lo - 1][1] : 0;
      const expandHi = hi < sorted.length - 1 ? sorted[hi + 1][1] : 0;

      if (expandLo >= expandHi && lo > 0) { lo--; accumulated += sorted[lo][1]; }
      else if (hi < sorted.length - 1) { hi++; accumulated += sorted[hi][1]; }
      else break;
    }

    const val = sorted[lo][0];
    const vah = sorted[hi][0];

    return {
      poc, vah, val,
      totalVolume: this.sessionVolume,
      priceInVA: price >= val && price <= vah,
      abovePOC: price > poc,
    };
  }

  vote(price: number): IndicatorVote {
    const state = this.getState(price);
    if (!state) return { name: 'VPOC', bias: 'NEUTRAL', strength: 0, reason: 'Warming up' };

    const distPOC = (price - state.poc) / state.poc;

    // Price below VAL = potential long (return to value)
    if (price < state.val) {
      return { name: 'VPOC', bias: 'LONG', strength: Math.min(1, Math.abs(distPOC) * 50), reason: `Below VA (POC $${state.poc.toFixed(0)})` };
    }
    // Price above VAH = potential short (return to value)
    if (price > state.vah) {
      return { name: 'VPOC', bias: 'SHORT', strength: Math.min(1, Math.abs(distPOC) * 50), reason: `Above VA (POC $${state.poc.toFixed(0)})` };
    }
    // Inside value area = trend continuation bias
    if (state.abovePOC) return { name: 'VPOC', bias: 'LONG', strength: 0.3, reason: 'In VA above POC' };
    return { name: 'VPOC', bias: 'SHORT', strength: 0.3, reason: 'In VA below POC' };
  }
}

// ════════════════════════════════════════════════════════════
// 8. ADX / DMI — Average Directional Index
//
// ADX mide la FUERZA del trend (no la dirección).
//   ADX > 25 = hay tendencia fuerte → trade with trend
//   ADX < 20 = chop/ranging → evitar o scalp
//   ADX < 15 = ultra-chop → NO tradear
//
// +DI > -DI = bulls dominan
// -DI > +DI = bears dominan
// Crossover de DI = cambio de control
// ════════════════════════════════════════════════════════════

export interface ADXState {
  adx: number;
  plusDI: number;
  minusDI: number;
  trendStrength: 'STRONG' | 'MODERATE' | 'WEAK' | 'CHOP';
  trendDirection: 'BULL' | 'BEAR' | 'NONE';
  diCrossover: 'BULL_CROSS' | 'BEAR_CROSS' | 'NONE';
}

export class ADX_DMI {
  private period: number;
  private highs: number[] = [];
  private lows: number[] = [];
  private closes: number[] = [];
  private smoothPlusDM = 0;
  private smoothMinusDM = 0;
  private smoothTR = 0;
  private adxValues: number[] = [];
  private prevPlusDI = 0;
  private prevMinusDI = 0;
  private initialized = false;

  constructor(period = 14) {
    this.period = period;
  }

  update(candle: Candle) {
    this.highs.push(candle.high);
    this.lows.push(candle.low);
    this.closes.push(candle.close);

    if (this.closes.length < 2) return;

    const i = this.closes.length - 1;
    const prevHigh = this.highs[i - 1];
    const prevLow = this.lows[i - 1];
    const prevClose = this.closes[i - 1];

    // True Range
    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevClose),
      Math.abs(candle.low - prevClose)
    );

    // Directional Movement
    const upMove = candle.high - prevHigh;
    const downMove = prevLow - candle.low;
    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;

    if (this.closes.length <= this.period + 1) {
      this.smoothPlusDM += plusDM;
      this.smoothMinusDM += minusDM;
      this.smoothTR += tr;

      if (this.closes.length === this.period + 1) {
        this.initialized = true;
      }
      return;
    }

    // Wilder smoothing
    this.smoothPlusDM = this.smoothPlusDM - (this.smoothPlusDM / this.period) + plusDM;
    this.smoothMinusDM = this.smoothMinusDM - (this.smoothMinusDM / this.period) + minusDM;
    this.smoothTR = this.smoothTR - (this.smoothTR / this.period) + tr;

    if (this.smoothTR === 0) return;

    const plusDI = (this.smoothPlusDM / this.smoothTR) * 100;
    const minusDI = (this.smoothMinusDM / this.smoothTR) * 100;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0;

    this.adxValues.push(dx);
    this.prevPlusDI = plusDI;
    this.prevMinusDI = minusDI;

    // Trim
    if (this.adxValues.length > 200) this.adxValues = this.adxValues.slice(-150);
    if (this.highs.length > 300) {
      this.highs = this.highs.slice(-200);
      this.lows = this.lows.slice(-200);
      this.closes = this.closes.slice(-200);
    }
  }

  getState(): ADXState | null {
    if (this.adxValues.length < this.period) return null;

    // ADX = smoothed average of DX
    const recent = this.adxValues.slice(-this.period);
    const adx = recent.reduce((s, v) => s + v, 0) / recent.length;

    const trendStrength: ADXState['trendStrength'] =
      adx >= 40 ? 'STRONG' : adx >= 25 ? 'MODERATE' : adx >= 15 ? 'WEAK' : 'CHOP';
    const trendDirection: ADXState['trendDirection'] =
      this.prevPlusDI > this.prevMinusDI ? 'BULL' : this.prevMinusDI > this.prevPlusDI ? 'BEAR' : 'NONE';

    // DI crossover detection
    let diCrossover: ADXState['diCrossover'] = 'NONE';
    // Simple: if gap just switched sides recently
    const diGap = this.prevPlusDI - this.prevMinusDI;
    if (Math.abs(diGap) < 3 && adx > 20) {
      diCrossover = diGap > 0 ? 'BULL_CROSS' : 'BEAR_CROSS';
    }

    return { adx, plusDI: this.prevPlusDI, minusDI: this.prevMinusDI, trendStrength, trendDirection, diCrossover };
  }

  vote(): IndicatorVote {
    const state = this.getState();
    if (!state) return { name: 'ADX', bias: 'NEUTRAL', strength: 0, reason: 'Warming up' };

    // In chop = don't trade
    if (state.trendStrength === 'CHOP') {
      return { name: 'ADX', bias: 'NEUTRAL', strength: 0, reason: `ADX ${state.adx.toFixed(0)} = CHOP → no trade` };
    }

    const str = state.adx >= 40 ? 0.9 : state.adx >= 25 ? 0.6 : 0.3;

    if (state.trendDirection === 'BULL') {
      return { name: 'ADX', bias: 'LONG', strength: str, reason: `ADX ${state.adx.toFixed(0)} +DI>${state.plusDI.toFixed(0)} trend BULL` };
    }
    if (state.trendDirection === 'BEAR') {
      return { name: 'ADX', bias: 'SHORT', strength: str, reason: `ADX ${state.adx.toFixed(0)} -DI>${state.minusDI.toFixed(0)} trend BEAR` };
    }
    return { name: 'ADX', bias: 'NEUTRAL', strength: 0, reason: `ADX ${state.adx.toFixed(0)} no clear direction` };
  }
}

// ════════════════════════════════════════════════════════════
// 9. VOL_REGIME — Volatility Regime via ATR Percentile
//
// Calcula ATR y lo compara con su propio historial.
//   ATR percentile > 80% = high vol → SL más anchos, margin menor
//   ATR percentile < 20% = low vol → SL tight, margin mayor, squeeze
//   ATR percentile 40-60% = normal → parámetros standard
//
// También detecta "volatility expansion" (squeeze → explosion)
// que es una de las señales más rentables en futures.
// ════════════════════════════════════════════════════════════

export interface VolRegimeState {
  atr: number;
  atrPct: number;           // 0-1, percentile rank
  regime: 'HIGH_VOL' | 'NORMAL' | 'LOW_VOL' | 'SQUEEZE';
  expanding: boolean;        // vol is increasing
  slMultiplier: number;      // suggested SL adjustment
  marginMultiplier: number;  // suggested margin adjustment
}

export class VolRegime {
  private atrPeriod: number;
  private historyLen: number;
  private trs: number[] = [];
  private atrs: number[] = [];
  private prevClose = 0;

  constructor(atrPeriod = 14, historyLen = 200) {
    this.atrPeriod = atrPeriod;
    this.historyLen = historyLen;
  }

  update(candle: Candle) {
    if (this.prevClose === 0) { this.prevClose = candle.close; return; }

    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - this.prevClose),
      Math.abs(candle.low - this.prevClose)
    );
    this.trs.push(tr);
    this.prevClose = candle.close;

    if (this.trs.length >= this.atrPeriod) {
      if (this.atrs.length === 0) {
        // First ATR = simple average
        const sum = this.trs.slice(-this.atrPeriod).reduce((s, v) => s + v, 0);
        this.atrs.push(sum / this.atrPeriod);
      } else {
        // Wilder smoothing
        const prevATR = this.atrs[this.atrs.length - 1];
        this.atrs.push((prevATR * (this.atrPeriod - 1) + tr) / this.atrPeriod);
      }
    }

    // Trim
    if (this.trs.length > this.historyLen * 2) this.trs = this.trs.slice(-this.historyLen);
    if (this.atrs.length > this.historyLen * 2) this.atrs = this.atrs.slice(-this.historyLen);
  }

  getState(): VolRegimeState | null {
    if (this.atrs.length < 30) return null;

    const currentATR = this.atrs[this.atrs.length - 1];
    const sorted = [...this.atrs].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= currentATR);
    const atrPct = rank / sorted.length;

    // Expansion detection: ATR increasing over last 5 bars
    const recent5 = this.atrs.slice(-5);
    const expanding = recent5.length >= 5 && recent5[4] > recent5[0] * 1.15;

    // Squeeze: very low vol that's about to expand
    const isSqueeze = atrPct < 0.15 && expanding;

    let regime: VolRegimeState['regime'];
    if (isSqueeze) regime = 'SQUEEZE';
    else if (atrPct > 0.80) regime = 'HIGH_VOL';
    else if (atrPct < 0.20) regime = 'LOW_VOL';
    else regime = 'NORMAL';

    // Multiplier suggestions
    let slMult = 1.0, marginMult = 1.0;
    if (regime === 'HIGH_VOL') { slMult = 1.3; marginMult = 0.7; }
    if (regime === 'LOW_VOL') { slMult = 0.8; marginMult = 1.2; }
    if (regime === 'SQUEEZE') { slMult = 0.9; marginMult = 1.3; } // tight SL, bigger size

    return { atr: currentATR, atrPct, regime, expanding, slMultiplier: slMult, marginMultiplier: marginMult };
  }

  vote(): IndicatorVote {
    const state = this.getState();
    if (!state) return { name: 'VOL', bias: 'NEUTRAL', strength: 0, reason: 'Warming up' };

    // Volatility regime doesn't vote directionally —
    // it modifies trade quality (NEUTRAL with context)
    if (state.regime === 'SQUEEZE') {
      return { name: 'VOL', bias: 'NEUTRAL', strength: 0.8, reason: `SQUEEZE → breakout imminent (ATR p${(state.atrPct * 100).toFixed(0)})` };
    }
    if (state.regime === 'HIGH_VOL') {
      return { name: 'VOL', bias: 'NEUTRAL', strength: 0.3, reason: `HIGH VOL → reduce size (ATR p${(state.atrPct * 100).toFixed(0)})` };
    }
    return { name: 'VOL', bias: 'NEUTRAL', strength: 0.5, reason: `${state.regime} (ATR p${(state.atrPct * 100).toFixed(0)})` };
  }
}

// ════════════════════════════════════════════════════════════
// 10. MTF_EMA — Multi-Timeframe EMA Alignment
//
// Chequea si las EMAs de múltiples timeframes están alineadas.
// Si 1m, 5m, y 1h EMAs apuntan en la misma dirección = confluencia.
//
// EMA Stack:
//   Fast (8) > Mid (21) > Slow (50) = BULLISH STACK
//   Fast (8) < Mid (21) < Slow (50) = BEARISH STACK
//   Mixed = CHOP
//
// Cuando TODOS los timeframes tienen el mismo stack = señal fuerte.
// ════════════════════════════════════════════════════════════

export interface MTFState {
  ema8: number; ema21: number; ema50: number;
  stack: 'BULL' | 'BEAR' | 'MIXED';
  slope8: number;   // rate of change of fast EMA
  alignment: number; // -1 to +1, how aligned the EMAs are
}

export interface MTFAlignmentState {
  tf1m: MTFState | null;
  tf5m: MTFState | null;
  overallBias: 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';
  alignmentScore: number;  // -1 to +1
}

export class MTF_EMA {
  // Track EMAs for each timeframe separately
  private ema1m = { e8: 0, e21: 0, e50: 0, prevE8: 0, count: 0 };
  private ema5m = { e8: 0, e21: 0, e50: 0, prevE8: 0, count: 0 };

  update1m(candle: Candle) { this.updateEMAs(this.ema1m, candle.close); }
  update5m(candle: Candle) { this.updateEMAs(this.ema5m, candle.close); }

  private updateEMAs(state: typeof this.ema1m, price: number) {
    state.count++;
    if (state.count === 1) {
      state.e8 = price; state.e21 = price; state.e50 = price;
    } else {
      state.prevE8 = state.e8;
      state.e8 = state.e8 + (2 / 9) * (price - state.e8);
      state.e21 = state.e21 + (2 / 22) * (price - state.e21);
      state.e50 = state.e50 + (2 / 51) * (price - state.e50);
    }
  }

  private getMTFState(state: typeof this.ema1m): MTFState | null {
    if (state.count < 50) return null;
    const stack: MTFState['stack'] =
      state.e8 > state.e21 && state.e21 > state.e50 ? 'BULL' :
      state.e8 < state.e21 && state.e21 < state.e50 ? 'BEAR' : 'MIXED';

    const slope8 = state.prevE8 > 0 ? (state.e8 - state.prevE8) / state.prevE8 : 0;

    // Alignment score: how cleanly separated are the EMAs
    const spread = (state.e8 - state.e50) / state.e50;
    const alignment = Math.max(-1, Math.min(1, spread * 100)); // normalize

    return { ema8: state.e8, ema21: state.e21, ema50: state.e50, stack, slope8, alignment };
  }

  getState(): MTFAlignmentState {
    const tf1m = this.getMTFState(this.ema1m);
    const tf5m = this.getMTFState(this.ema5m);

    let alignScore = 0;
    if (tf1m) alignScore += tf1m.stack === 'BULL' ? 0.5 : tf1m.stack === 'BEAR' ? -0.5 : 0;
    if (tf5m) alignScore += tf5m.stack === 'BULL' ? 0.5 : tf5m.stack === 'BEAR' ? -0.5 : 0;

    let overallBias: MTFAlignmentState['overallBias'] = 'NEUTRAL';
    if (alignScore >= 0.8) overallBias = 'STRONG_BULL';
    else if (alignScore >= 0.3) overallBias = 'BULL';
    else if (alignScore <= -0.8) overallBias = 'STRONG_BEAR';
    else if (alignScore <= -0.3) overallBias = 'BEAR';

    return { tf1m, tf5m, overallBias, alignmentScore: alignScore };
  }

  vote(): IndicatorVote {
    const state = this.getState();

    if (state.overallBias === 'STRONG_BULL') return { name: 'MTF_EMA', bias: 'LONG', strength: 0.9, reason: 'All TF EMA stacked BULL' };
    if (state.overallBias === 'BULL') return { name: 'MTF_EMA', bias: 'LONG', strength: 0.5, reason: 'EMA bias BULL' };
    if (state.overallBias === 'STRONG_BEAR') return { name: 'MTF_EMA', bias: 'SHORT', strength: 0.9, reason: 'All TF EMA stacked BEAR' };
    if (state.overallBias === 'BEAR') return { name: 'MTF_EMA', bias: 'SHORT', strength: 0.5, reason: 'EMA bias BEAR' };
    return { name: 'MTF_EMA', bias: 'NEUTRAL', strength: 0, reason: 'EMAs mixed/choppy' };
  }
}

// ════════════════════════════════════════════════════════════
// 11. DELTA — Buy/Sell Pressure Estimation
//
// Sin order flow real, estimamos presión con heurísticas:
//   - Candle close near high + high volume = buying pressure
//   - Candle close near low + high volume = selling pressure
//   - Cumulative delta muestra quién domina el mercado
//
// Delta divergence: price sube pero delta baja = distribución
// (institucionales vendiendo mientras retail compra)
// ════════════════════════════════════════════════════════════

export interface DeltaState {
  cumulativeDelta: number;
  recentDelta: number;       // delta of last N bars
  deltaMA: number;           // smoothed delta
  divergence: 'BULL_DIV' | 'BEAR_DIV' | 'NONE';
  pressure: 'BUYING' | 'SELLING' | 'BALANCED';
}

export class Delta {
  private deltas: number[] = [];
  private prices: number[] = [];
  private cumDelta = 0;
  private maPeriod: number;

  constructor(maPeriod = 20) {
    this.maPeriod = maPeriod;
  }

  update(candle: Candle) {
    // Estimate delta from candle shape
    const range = candle.high - candle.low;
    if (range === 0) { this.deltas.push(0); this.prices.push(candle.close); return; }

    // Close position within range (0 = low, 1 = high)
    const closePosition = (candle.close - candle.low) / range;
    // Estimated delta: buy_volume - sell_volume
    // closePosition > 0.5 = more buying, < 0.5 = more selling
    const delta = (closePosition * 2 - 1) * candle.volume;

    this.deltas.push(delta);
    this.prices.push(candle.close);
    this.cumDelta += delta;

    // Trim
    if (this.deltas.length > 300) { this.deltas = this.deltas.slice(-200); this.prices = this.prices.slice(-200); }
  }

  getState(): DeltaState | null {
    if (this.deltas.length < this.maPeriod) return null;

    const recent = this.deltas.slice(-this.maPeriod);
    const recentDelta = recent.reduce((s, v) => s + v, 0);
    const deltaMA = recentDelta / this.maPeriod;

    // Pressure
    const pressure: DeltaState['pressure'] =
      recentDelta > 0 ? 'BUYING' : recentDelta < 0 ? 'SELLING' : 'BALANCED';

    // Delta divergence: compare price direction vs delta direction
    let divergence: DeltaState['divergence'] = 'NONE';
    if (this.prices.length >= this.maPeriod * 2) {
      const halfLen = this.maPeriod;
      const recentPrices = this.prices.slice(-halfLen);
      const olderPrices = this.prices.slice(-halfLen * 2, -halfLen);
      const recentDeltas = this.deltas.slice(-halfLen);
      const olderDeltas = this.deltas.slice(-halfLen * 2, -halfLen);

      const priceTrend = avg(recentPrices) - avg(olderPrices);
      const deltaTrend = sum(recentDeltas) - sum(olderDeltas);

      // Bearish divergence: price rising but delta falling
      if (priceTrend > 0 && deltaTrend < 0) divergence = 'BEAR_DIV';
      // Bullish divergence: price falling but delta rising
      if (priceTrend < 0 && deltaTrend > 0) divergence = 'BULL_DIV';
    }

    return { cumulativeDelta: this.cumDelta, recentDelta, deltaMA, divergence, pressure };
  }

  vote(): IndicatorVote {
    const state = this.getState();
    if (!state) return { name: 'DELTA', bias: 'NEUTRAL', strength: 0, reason: 'Warming up' };

    // Divergence is the strongest signal
    if (state.divergence === 'BULL_DIV') {
      return { name: 'DELTA', bias: 'LONG', strength: 0.7, reason: 'Delta BULL divergence (accumulation)' };
    }
    if (state.divergence === 'BEAR_DIV') {
      return { name: 'DELTA', bias: 'SHORT', strength: 0.7, reason: 'Delta BEAR divergence (distribution)' };
    }

    // Pure pressure
    if (state.pressure === 'BUYING') return { name: 'DELTA', bias: 'LONG', strength: 0.4, reason: `Buy pressure (Δ=${state.recentDelta.toFixed(0)})` };
    if (state.pressure === 'SELLING') return { name: 'DELTA', bias: 'SHORT', strength: 0.4, reason: `Sell pressure (Δ=${state.recentDelta.toFixed(0)})` };
    return { name: 'DELTA', bias: 'NEUTRAL', strength: 0, reason: 'Balanced pressure' };
  }
}

// ════════════════════════════════════════════════════════════
// ENHANCED PA PIVOTS — Daily/Weekly feed + CPR
// ════════════════════════════════════════════════════════════

export interface DailyCandle {
  date: string;   // 'YYYY-MM-DD'
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CPR {
  tc: number;    // Top Central Pivot
  pivot: number; // Pivot Point
  bc: number;    // Bottom Central Pivot
  width: number; // CPR width as % of price
  isNarrow: boolean; // narrow CPR = trending day expected
}

export interface EnhancedPivotLevels {
  // Daily
  daily: {
    pp: number; r1: number; r2: number; r3: number;
    s1: number; s2: number; s3: number;
    fibR1: number; fibR2: number; fibR3: number;
    fibS1: number; fibS2: number; fibS3: number;
    camR3: number; camR4: number; camS3: number; camS4: number;
  };
  // Weekly
  weekly: {
    pp: number; r1: number; r2: number; s1: number; s2: number;
  } | null;
  // CPR
  cpr: CPR;
  // Previous day
  pdh: number;  // Previous Day High
  pdl: number;  // Previous Day Low
}

export class EnhancedPAPivot {
  private dailyHistory: DailyCandle[] = [];
  private weeklyHistory: { high: number; low: number; close: number }[] = [];
  private currentWeekHLC = { high: -Infinity, low: Infinity, close: 0 };
  private currentWeek = 0;

  /** Feed a completed daily candle (call once per day or at startup with history) */
  feedDailyCandle(candle: DailyCandle) {
    this.dailyHistory.push(candle);
    if (this.dailyHistory.length > 60) this.dailyHistory.shift();

    // Aggregate weekly
    const d = new Date(candle.date);
    const week = getISOWeek(d);
    if (week !== this.currentWeek && this.currentWeek > 0) {
      this.weeklyHistory.push({ ...this.currentWeekHLC });
      if (this.weeklyHistory.length > 12) this.weeklyHistory.shift();
      this.currentWeekHLC = { high: candle.high, low: candle.low, close: candle.close };
      this.currentWeek = week;
    } else {
      if (this.currentWeek === 0) this.currentWeek = week;
      if (candle.high > this.currentWeekHLC.high) this.currentWeekHLC.high = candle.high;
      if (candle.low < this.currentWeekHLC.low) this.currentWeekHLC.low = candle.low;
      this.currentWeekHLC.close = candle.close;
    }
  }

  /** Feed bulk daily history at startup */
  feedDailyHistory(candles: DailyCandle[]) {
    for (const c of candles) this.feedDailyCandle(c);
  }

  getLevels(): EnhancedPivotLevels | null {
    if (this.dailyHistory.length < 2) return null;

    const prev = this.dailyHistory[this.dailyHistory.length - 1];
    const H = prev.high, L = prev.low, C = prev.close, O = prev.open;
    const range = H - L;
    const pp = (H + L + C) / 3;

    // CPR (Central Pivot Range)
    const tc = (pp - L) + pp;  // = 2*pp - L (same as R1, but conceptually CPR top)
    const bc = (pp - H) + pp;  // = 2*pp - H (same as S1, conceptually CPR bottom)
    const cprWidth = Math.abs(tc - bc) / pp * 100;
    // Narrow CPR = trending day (< 0.3% for BTC typical)
    const avgRange = this.dailyHistory.slice(-14).reduce((s, c) => s + (c.high - c.low), 0) / Math.min(14, this.dailyHistory.length);
    const isNarrow = Math.abs(tc - bc) < avgRange * 0.33;

    const daily = {
      pp,
      r1: 2 * pp - L, r2: pp + range, r3: H + 2 * (pp - L),
      s1: 2 * pp - H, s2: pp - range, s3: L - 2 * (H - pp),
      fibR1: pp + 0.382 * range, fibR2: pp + 0.618 * range, fibR3: pp + range,
      fibS1: pp - 0.382 * range, fibS2: pp - 0.618 * range, fibS3: pp - range,
      camR3: C + range * 1.1 / 4, camR4: C + range * 1.1 / 2,
      camS3: C - range * 1.1 / 4, camS4: C - range * 1.1 / 2,
    };

    // Weekly pivots
    let weekly: EnhancedPivotLevels['weekly'] = null;
    if (this.weeklyHistory.length >= 1) {
      const wPrev = this.weeklyHistory[this.weeklyHistory.length - 1];
      const wPP = (wPrev.high + wPrev.low + wPrev.close) / 3;
      const wRange = wPrev.high - wPrev.low;
      weekly = { pp: wPP, r1: 2 * wPP - wPrev.low, r2: wPP + wRange, s1: 2 * wPP - wPrev.high, s2: wPP - wRange };
    }

    return {
      daily, weekly,
      cpr: { tc, pivot: pp, bc, width: cprWidth, isNarrow },
      pdh: H, pdl: L,
    };
  }

  vote(price: number): IndicatorVote {
    const levels = this.getLevels();
    if (!levels) return { name: 'PA_PIVOT', bias: 'NEUTRAL', strength: 0, reason: 'Need daily data' };

    const d = levels.daily;
    const allLevels: [string, number, Side | 'NEUTRAL'][] = [
      ['S3', d.s3, 'LONG'], ['S2', d.s2, 'LONG'], ['FibS2', d.fibS2, 'LONG'],
      ['S1', d.s1, 'LONG'], ['FibS1', d.fibS1, 'LONG'],
      ['PP', d.pp, 'NEUTRAL'],
      ['FibR1', d.fibR1, 'SHORT'], ['R1', d.r1, 'SHORT'],
      ['FibR2', d.fibR2, 'SHORT'], ['R2', d.r2, 'SHORT'], ['R3', d.r3, 'SHORT'],
      ['PDH', levels.pdh, 'SHORT'], ['PDL', levels.pdl, 'LONG'],
    ];

    if (levels.weekly) {
      allLevels.push(['W-S1', levels.weekly.s1, 'LONG'], ['W-R1', levels.weekly.r1, 'SHORT'],
                      ['W-PP', levels.weekly.pp, 'NEUTRAL']);
    }

    let closest = { name: '', dist: Infinity, bias: 'NEUTRAL' as Side | 'NEUTRAL' };
    for (const [name, level, bias] of allLevels) {
      const dist = Math.abs(price - level) / price;
      if (dist < closest.dist) closest = { name, dist, bias };
    }

    // CPR analysis
    let cprReason = '';
    if (levels.cpr.isNarrow) cprReason = ' (narrow CPR → trending day)';
    if (price > levels.cpr.tc) cprReason += ' Above CPR';
    else if (price < levels.cpr.bc) cprReason += ' Below CPR';

    if (closest.dist > 0.004) {
      // Not near any level — use CPR position for weak signal
      const cprBias = price > levels.cpr.tc ? 'LONG' : price < levels.cpr.bc ? 'SHORT' : 'NEUTRAL';
      return { name: 'PA_PIVOT', bias: cprBias as any, strength: 0.2, reason: `No nearby level${cprReason}` };
    }

    const str = closest.dist < 0.001 ? 0.9 : closest.dist < 0.002 ? 0.7 : 0.4;
    return { name: 'PA_PIVOT', bias: closest.bias, strength: str, reason: `Near ${closest.name} ($${allLevels.find(l => l[0] === closest.name)?.[1]?.toFixed(0)})${cprReason}` };
  }
}

// ════════════════════════════════════════════════════════════
// INDICATOR VOTE TYPE
// ════════════════════════════════════════════════════════════

export interface IndicatorVote {
  name: string;
  bias: Side | 'NEUTRAL';
  strength: number;     // 0 to 1
  reason: string;
}

// ════════════════════════════════════════════════════════════
// CONFLUENCE GATE — The Brain of the System
//
// Cada trade propuesto por un engine pasa por acá.
// Cada indicador vota. El trade solo se ejecuta si hay
// suficiente confluencia (configurable).
//
// Default: necesita 6 de 11 indicadores confirmando el mismo
// lado para aprobar el trade. Es estricto a propósito.
//
// Output: approved/rejected + razones + multipliers de sizing
// ════════════════════════════════════════════════════════════

export interface ConfluenceConfig {
  minVotesRequired: number;   // mínimo de votos en la misma dirección (default: 6)
  minTotalStrength: number;   // fuerza total mínima (default: 2.5)
  blockOnChop: boolean;       // bloquear si ADX dice CHOP (default: true)
  requireVWAP: boolean;       // VWAP debe confirmar (default: false)
  requireStructure: boolean;  // estructura HH/HL/LH/LL debe confirmar (default: false)
}

export interface ConfluenceResult {
  approved: boolean;
  side: Side | 'NEUTRAL';
  votesFor: number;
  votesAgainst: number;
  votesNeutral: number;
  totalStrength: number;
  confidence: number;         // 0-100
  votes: IndicatorVote[];
  reasons: string[];
  rejectionReason: string | null;
  // Sizing adjustments from vol regime
  slMultiplier: number;
  marginMultiplier: number;
}

export class ConfluenceGate {
  private config: ConfluenceConfig;

  constructor(config?: Partial<ConfluenceConfig>) {
    this.config = {
      minVotesRequired: config?.minVotesRequired ?? 6,
      minTotalStrength: config?.minTotalStrength ?? 2.5,
      blockOnChop: config?.blockOnChop ?? true,
      requireVWAP: config?.requireVWAP ?? false,
      requireStructure: config?.requireStructure ?? false,
    };
  }

  evaluate(votes: IndicatorVote[], proposedSide: Side, volState?: VolRegimeState | null): ConfluenceResult {
    const forVotes = votes.filter(v => v.bias === proposedSide);
    const againstVotes = votes.filter(v => v.bias !== 'NEUTRAL' && v.bias !== proposedSide);
    const neutralVotes = votes.filter(v => v.bias === 'NEUTRAL');

    const totalForStrength = forVotes.reduce((s, v) => s + v.strength, 0);
    const totalAgainstStrength = againstVotes.reduce((s, v) => s + v.strength, 0);

    let approved = true;
    let rejectionReason: string | null = null;

    // Check minimum votes
    if (forVotes.length < this.config.minVotesRequired) {
      approved = false;
      rejectionReason = `Only ${forVotes.length}/${this.config.minVotesRequired} indicators confirm ${proposedSide}`;
    }

    // Check minimum strength
    if (approved && totalForStrength < this.config.minTotalStrength) {
      approved = false;
      rejectionReason = `Total strength ${totalForStrength.toFixed(1)} < ${this.config.minTotalStrength} required`;
    }

    // Check against votes aren't too strong
    if (approved && totalAgainstStrength > totalForStrength * 0.8) {
      approved = false;
      rejectionReason = `Strong counter-signals (${totalAgainstStrength.toFixed(1)} against vs ${totalForStrength.toFixed(1)} for)`;
    }

    // Check ADX chop blocking
    if (approved && this.config.blockOnChop) {
      const adxVote = votes.find(v => v.name === 'ADX');
      if (adxVote && adxVote.reason.includes('CHOP')) {
        approved = false;
        rejectionReason = 'ADX indicates CHOP market — no trend';
      }
    }

    // Check required indicators
    if (approved && this.config.requireVWAP) {
      const vwapVote = votes.find(v => v.name === 'VWAP');
      if (vwapVote && vwapVote.bias !== proposedSide && vwapVote.bias !== 'NEUTRAL') {
        approved = false;
        rejectionReason = `VWAP disagrees (${vwapVote.bias})`;
      }
    }

    // Vol regime adjustments
    let slMult = 1.0, marginMult = 1.0;
    if (volState) {
      slMult = volState.slMultiplier;
      marginMult = volState.marginMultiplier;
    }

    const confidence = Math.min(100, Math.round(
      (forVotes.length / votes.length) * 50 +
      (totalForStrength / (totalForStrength + totalAgainstStrength + 0.01)) * 50
    ));

    const reasons = forVotes.map(v => `✅ ${v.name}: ${v.reason}`);
    if (againstVotes.length > 0) reasons.push(...againstVotes.map(v => `❌ ${v.name}: ${v.reason}`));
    if (neutralVotes.length > 0) reasons.push(...neutralVotes.map(v => `⚪ ${v.name}: ${v.reason}`));

    return {
      approved, side: approved ? proposedSide : 'NEUTRAL',
      votesFor: forVotes.length, votesAgainst: againstVotes.length, votesNeutral: neutralVotes.length,
      totalStrength: totalForStrength, confidence, votes, reasons,
      rejectionReason, slMultiplier: slMult, marginMultiplier: marginMult,
    };
  }
}

// ════════════════════════════════════════════════════════════
// PRO HUB — Master coordinator for all indicators
// ════════════════════════════════════════════════════════════

export class ProHub {
  // Original indicators
  readonly hpdr: HPDR_Stub;
  readonly hpas: HPAS_Stub;
  readonly ctrsi: CTRSI_Stub;
  readonly smc: SMC_Stub;

  // New pro indicators
  readonly vwap: VWAP;
  readonly vpoc: VolumeProfile;
  readonly adx: ADX_DMI;
  readonly vol: VolRegime;
  readonly mtf: MTF_EMA;
  readonly delta: Delta;
  readonly pivot: EnhancedPAPivot;

  // Gate
  readonly gate: ConfluenceGate;

  constructor(gateConfig?: Partial<ConfluenceConfig>) {
    // Stubs for original indicators (user should pass real ones or use IndicatorHub)
    this.hpdr = new HPDR_Stub();
    this.hpas = new HPAS_Stub();
    this.ctrsi = new CTRSI_Stub();
    this.smc = new SMC_Stub();

    this.vwap = new VWAP();
    this.vpoc = new VolumeProfile(10); // $10 buckets for BTC
    this.adx = new ADX_DMI(14);
    this.vol = new VolRegime(14, 200);
    this.mtf = new MTF_EMA();
    this.delta = new Delta(20);
    this.pivot = new EnhancedPAPivot();

    this.gate = new ConfluenceGate(gateConfig);
  }

  /** Feed 1m candle (most indicators work on 1m) */
  update1m(candle: Candle) {
    this.vwap.update(candle);
    this.vpoc.update(candle);
    this.adx.update(candle);
    this.vol.update(candle);
    this.mtf.update1m(candle);
    this.delta.update(candle);
    // Original indicators
    this.hpdr.update(candle);
    this.hpas.update(candle);
    this.ctrsi.update(candle);
    this.smc.update(candle);
  }

  /** Feed 5m candle (for MTF alignment) */
  update5m(candle: Candle) {
    this.mtf.update5m(candle);
  }

  /** Feed daily candle(s) for pivot calculations */
  feedDailyCandle(candle: DailyCandle) {
    this.pivot.feedDailyCandle(candle);
  }

  feedDailyHistory(candles: DailyCandle[]) {
    this.pivot.feedDailyHistory(candles);
  }

  /** Main evaluation: should this trade be approved? */
  evaluate(price: number, proposedSide: Side): ConfluenceResult {
    const votes: IndicatorVote[] = [
      this.vwap.vote(price),
      this.vpoc.vote(price),
      this.adx.vote(),
      this.vol.vote(),
      this.mtf.vote(),
      this.delta.vote(),
      this.pivot.vote(price),
      this.hpdr.vote(price),
      this.hpas.vote(),
      this.ctrsi.vote(),
      this.smc.vote(price),
    ];

    const volState = this.vol.getState();
    return this.gate.evaluate(votes, proposedSide, volState);
  }

  /** Quick summary for logging */
  getSummary(price: number): string {
    const votes: IndicatorVote[] = [
      this.vwap.vote(price), this.vpoc.vote(price), this.adx.vote(),
      this.vol.vote(), this.mtf.vote(), this.delta.vote(),
      this.pivot.vote(price), this.hpdr.vote(price),
      this.hpas.vote(), this.ctrsi.vote(), this.smc.vote(price),
    ];

    const bulls = votes.filter(v => v.bias === 'LONG');
    const bears = votes.filter(v => v.bias === 'SHORT');
    const neutral = votes.filter(v => v.bias === 'NEUTRAL');

    return [
      `📊 CONFLUENCE: ${bulls.length}🟢 ${bears.length}🔴 ${neutral.length}⚪`,
      ...votes.map(v => {
        const icon = v.bias === 'LONG' ? '🟢' : v.bias === 'SHORT' ? '🔴' : '⚪';
        return `  ${icon} ${v.name.padEnd(10)} [${(v.strength * 100).toFixed(0).padStart(3)}%] ${v.reason}`;
      }),
    ].join('\n');
  }
}

// ════════════════════════════════════════════════════════════
// STUBS — Wrappers for original indicators that implement vote()
//
// These let the ProHub work standalone. In production, replace
// with real instances from indicators.ts
// ════════════════════════════════════════════════════════════

import { HPDR, HPAS, CTRSI, SMC } from './indicators';

class HPDR_Stub extends HPDR {
  vote(price: number): IndicatorVote {
    const sig = this.getSignal();
    if (!sig) return { name: 'HPDR', bias: 'NEUTRAL', strength: 0, reason: 'Warming up' };
    return { name: 'HPDR', bias: sig.bias as any, strength: sig.strength, reason: `HPDR ${sig.nearLevel}` };
  }
}

class HPAS_Stub extends HPAS {
  vote(): IndicatorVote {
    const seq = this.getSequential();
    if (seq.consecutiveGains >= 5 && seq.probContinueGain < 0.4) {
      return { name: 'HPAS', bias: 'SHORT', strength: 0.5, reason: `${seq.consecutiveGains} greens, P(cont)=${(seq.probContinueGain * 100).toFixed(0)}%` };
    }
    if (seq.consecutiveLosses >= 5 && seq.probContinueLoss < 0.4) {
      return { name: 'HPAS', bias: 'LONG', strength: 0.5, reason: `${seq.consecutiveLosses} reds, P(cont)=${(seq.probContinueLoss * 100).toFixed(0)}%` };
    }
    return { name: 'HPAS', bias: 'NEUTRAL', strength: 0, reason: 'No sequential signal' };
  }
}

class CTRSI_Stub extends CTRSI {
  vote(): IndicatorVote {
    const state = this.getState();
    if (!state) return { name: 'CT_RSI', bias: 'NEUTRAL', strength: 0, reason: 'Warming up' };
    if (state.signal === 'BUY') return { name: 'CT_RSI', bias: 'LONG', strength: state.signalStrength, reason: `RSI ${state.rsi.toFixed(0)} + ${state.divergences.map(d => d.type).join(',')}` };
    if (state.signal === 'SELL') return { name: 'CT_RSI', bias: 'SHORT', strength: state.signalStrength, reason: `RSI ${state.rsi.toFixed(0)} + ${state.divergences.map(d => d.type).join(',')}` };
    // Plain RSI levels
    if (state.rsi < 30) return { name: 'CT_RSI', bias: 'LONG', strength: 0.4, reason: `RSI oversold ${state.rsi.toFixed(0)}` };
    if (state.rsi > 70) return { name: 'CT_RSI', bias: 'SHORT', strength: 0.4, reason: `RSI overbought ${state.rsi.toFixed(0)}` };
    return { name: 'CT_RSI', bias: 'NEUTRAL', strength: 0, reason: `RSI ${state.rsi.toFixed(0)} neutral` };
  }
}

class SMC_Stub extends SMC {
  vote(price: number): IndicatorVote {
    const state = this.getState();
    if (!state.signal) return { name: 'SMC', bias: 'NEUTRAL', strength: 0, reason: 'No SMC setup' };
    return { name: 'SMC', bias: state.signal.side as any, strength: state.signal.strength, reason: `SMC: ${state.signal.reason}` };
  }
}

// ════════════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════════════

function avg(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function sum(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0);
}

function getISOWeek(date: Date): number {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
