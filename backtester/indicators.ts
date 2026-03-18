// ============================================================
// indicators.ts — Krown-Style + SMC Pro Indicator Library
//
// Replaces $100+/month of paid TradingView scripts with pure math.
// All indicators are TypeScript, no dependencies, designed for
// direct integration with Aster Bot.
//
// INDICATORS:
//   1. HPDR  — Historical Price Delta Range (percentile bands)
//   2. HPAS  — Historical Price Action Statistics (returns/range/volume by day+hour)
//   3. CTRSI — Caretaker RSI (auto divergence detection: regular + hidden)
//   4. PA_PIVOT — Price Action Pivots (multi-timeframe structural pivots)
//   5. SMC   — Smart Money Concepts (OB, FVG, BOS/CHoCH, Liquidity)
//
// USAGE:
//   import { HPDR, HPAS, CTRSI, PAPivot, SMC } from './indicators';
//   const hpdr = new HPDR({ range: 14, levels: [0.38, 0.50, 0.61, 0.78, 0.88, 0.95, 1.0] });
//   hpdr.update(candle);
//   const bands = hpdr.getBands();
// ============================================================

// ── Shared Types ──

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export type Side = 'LONG' | 'SHORT';

// ════════════════════════════════════════════════════════════
// 1. HPDR — Historical Price Delta Range
//
// Measures how much price typically changes over N bars.
// Collects deltas, sorts into percentiles, plots bands
// around a rolling median as support/resistance zones.
//
// Core math:
//   delta[i] = close[i] - close[i - range]
//   For each percentile p, band = median + percentile(deltas, p)
// ════════════════════════════════════════════════════════════

export interface HPDRConfig {
  range: number;         // lookback for deltas (default: 14)
  levels: number[];      // percentile levels [0-1] (default: fib-like)
  sampleSize: number;    // max deltas to keep (default: 500)
}

export interface HPDRBands {
  median: number;
  upper: Map<number, number>;  // level → price
  lower: Map<number, number>;  // level → price
  probability: number;         // where current price sits in range [0-1]
  volatility: number;          // current range width as % of price
}

export class HPDR {
  private config: HPDRConfig;
  private closes: number[] = [];
  private posDeltas: number[] = [];
  private negDeltas: number[] = [];
  private allDeltas: number[] = [];

  constructor(config?: Partial<HPDRConfig>) {
    this.config = {
      range: config?.range ?? 14,
      levels: config?.levels ?? [0.38, 0.50, 0.61, 0.78, 0.88, 0.95, 1.0],
      sampleSize: config?.sampleSize ?? 500,
    };
  }

  update(candle: Candle) {
    this.closes.push(candle.close);
    if (this.closes.length < this.config.range + 1) return;

    const delta = candle.close - this.closes[this.closes.length - 1 - this.config.range];
    this.allDeltas.push(delta);
    if (delta >= 0) this.posDeltas.push(delta);
    else this.negDeltas.push(Math.abs(delta));

    // Cap sample size
    if (this.allDeltas.length > this.config.sampleSize) this.allDeltas.shift();
    if (this.posDeltas.length > this.config.sampleSize / 2) this.posDeltas.shift();
    if (this.negDeltas.length > this.config.sampleSize / 2) this.negDeltas.shift();
    if (this.closes.length > this.config.sampleSize * 2) this.closes = this.closes.slice(-this.config.sampleSize);
  }

  getBands(): HPDRBands | null {
    if (this.allDeltas.length < 20) return null;

    const price = this.closes[this.closes.length - 1];
    const sortedPos = [...this.posDeltas].sort((a, b) => a - b);
    const sortedNeg = [...this.negDeltas].sort((a, b) => a - b);
    const sortedAll = [...this.allDeltas].sort((a, b) => a - b);

    const median = percentile(sortedAll, 0.50);
    const medianPrice = price + median * 0.5; // bias toward current price

    const upper = new Map<number, number>();
    const lower = new Map<number, number>();

    for (const level of this.config.levels) {
      const upDelta = sortedPos.length > 5 ? percentile(sortedPos, level) : 0;
      const dnDelta = sortedNeg.length > 5 ? percentile(sortedNeg, level) : 0;
      upper.set(level, medianPrice + upDelta);
      lower.set(level, medianPrice - dnDelta);
    }

    // Probability: where is price in the overall range
    const rangeHigh = upper.get(1.0) ?? price;
    const rangeLow = lower.get(1.0) ?? price;
    const totalRange = rangeHigh - rangeLow;
    const probability = totalRange > 0 ? (price - rangeLow) / totalRange : 0.5;

    const volatility = totalRange / price;

    return { median: medianPrice, upper, lower, probability, volatility };
  }

  /** Get signal: is price near a band edge? */
  getSignal(): { bias: 'LONG' | 'SHORT' | 'NEUTRAL'; strength: number; nearLevel: string } | null {
    const bands = this.getBands();
    if (!bands) return null;

    const price = this.closes[this.closes.length - 1];

    // Near lower bands = bullish (buy the dip)
    if (bands.probability < 0.15) return { bias: 'LONG', strength: 1 - bands.probability * 5, nearLevel: `Lower ${(bands.probability * 100).toFixed(0)}%` };
    if (bands.probability > 0.85) return { bias: 'SHORT', strength: (bands.probability - 0.85) * 5, nearLevel: `Upper ${(bands.probability * 100).toFixed(0)}%` };

    return { bias: 'NEUTRAL', strength: 0, nearLevel: `Mid ${(bands.probability * 100).toFixed(0)}%` };
  }
}

// ════════════════════════════════════════════════════════════
// 2. HPAS — Historical Price Action Statistics
//
// Tracks returns, intra-day ranges, and volume broken down
// by day of week and hour. Enables:
//   - "Mondays at 14:00 UTC have average return of +0.3%"
//   - "Thursday has the widest intra-day range"
//   - CT Sequential: consecutive win/loss bar probability
// ════════════════════════════════════════════════════════════

export interface HPASConfig {
  maxSamples: number;     // max samples per bucket (default: 200)
}

interface HPASBucket {
  returns: number[];      // close-to-close % returns
  ranges: number[];       // (high-low)/open %
  volumes: number[];      // raw volumes
}

export interface HPASStats {
  avgReturn: number;
  medianReturn: number;
  avgRange: number;
  avgVolume: number;
  winRate: number;         // % of positive returns
  p25Return: number;
  p75Return: number;
  sampleSize: number;
}

export interface CTSequential {
  consecutiveGains: number;
  consecutiveLosses: number;
  probContinueGain: number;   // P(next bar is also green given N consecutive greens)
  probContinueLoss: number;   // P(next bar is also red given N consecutive reds)
}

export class HPAS {
  private config: HPASConfig;
  // Buckets: key = "DOW:HOUR" e.g. "1:14" = Monday 14:00
  private byDayHour: Map<string, HPASBucket> = new Map();
  private byDay: Map<number, HPASBucket> = new Map();
  private byHour: Map<number, HPASBucket> = new Map();
  // CT Sequential tracking
  private consecutiveReturns: number[] = [];
  private gainStreaks: Map<number, { continued: number; stopped: number }> = new Map();
  private lossStreaks: Map<number, { continued: number; stopped: number }> = new Map();
  private lastClose = 0;
  private currentStreak = 0;

  constructor(config?: Partial<HPASConfig>) {
    this.config = { maxSamples: config?.maxSamples ?? 200 };
  }

  update(candle: Candle) {
    if (this.lastClose === 0) { this.lastClose = candle.close; return; }

    const ret = (candle.close - this.lastClose) / this.lastClose;
    const range = (candle.high - candle.low) / candle.open;
    const date = new Date(candle.closeTime);
    const dow = date.getUTCDay();
    const hour = date.getUTCHours();

    // Add to buckets
    const addToBucket = (map: Map<string | number, HPASBucket>, key: string | number) => {
      if (!map.has(key)) map.set(key, { returns: [], ranges: [], volumes: [] });
      const b = map.get(key)!;
      b.returns.push(ret);
      b.ranges.push(range);
      b.volumes.push(candle.volume);
      if (b.returns.length > this.config.maxSamples) { b.returns.shift(); b.ranges.shift(); b.volumes.shift(); }
    };

    addToBucket(this.byDayHour as any, `${dow}:${hour}`);
    addToBucket(this.byDay as any, dow);
    addToBucket(this.byHour as any, hour);

    // CT Sequential: track consecutive gain/loss bars
    const isGain = candle.close > this.lastClose;

    if (this.currentStreak > 0 && isGain) {
      // Was gaining, still gaining → record continuation at streak length
      const s = this.gainStreaks.get(this.currentStreak) ?? { continued: 0, stopped: 0 };
      s.continued++;
      this.gainStreaks.set(this.currentStreak, s);
      this.currentStreak++;
    } else if (this.currentStreak < 0 && !isGain) {
      // Was losing, still losing
      const len = Math.abs(this.currentStreak);
      const s = this.lossStreaks.get(len) ?? { continued: 0, stopped: 0 };
      s.continued++;
      this.lossStreaks.set(len, s);
      this.currentStreak--;
    } else {
      // Streak broken
      if (this.currentStreak > 0) {
        const s = this.gainStreaks.get(this.currentStreak) ?? { continued: 0, stopped: 0 };
        s.stopped++;
        this.gainStreaks.set(this.currentStreak, s);
      } else if (this.currentStreak < 0) {
        const len = Math.abs(this.currentStreak);
        const s = this.lossStreaks.get(len) ?? { continued: 0, stopped: 0 };
        s.stopped++;
        this.lossStreaks.set(len, s);
      }
      this.currentStreak = isGain ? 1 : -1;
    }

    this.lastClose = candle.close;
  }

  getStats(dow?: number, hour?: number): HPASStats | null {
    let bucket: HPASBucket | undefined;
    if (dow !== undefined && hour !== undefined) bucket = (this.byDayHour as any).get(`${dow}:${hour}`);
    else if (dow !== undefined) bucket = this.byDay.get(dow);
    else if (hour !== undefined) bucket = this.byHour.get(hour);
    if (!bucket || bucket.returns.length < 10) return null;

    const sorted = [...bucket.returns].sort((a, b) => a - b);
    return {
      avgReturn: mean(bucket.returns),
      medianReturn: percentile(sorted, 0.5),
      avgRange: mean(bucket.ranges),
      avgVolume: mean(bucket.volumes),
      winRate: bucket.returns.filter(r => r > 0).length / bucket.returns.length,
      p25Return: percentile(sorted, 0.25),
      p75Return: percentile(sorted, 0.75),
      sampleSize: bucket.returns.length,
    };
  }

  getSequential(): CTSequential {
    const absStreak = Math.abs(this.currentStreak);

    let probGain = 0.5, probLoss = 0.5;
    if (this.currentStreak > 0) {
      const s = this.gainStreaks.get(absStreak);
      if (s && (s.continued + s.stopped) >= 5) {
        probGain = s.continued / (s.continued + s.stopped);
      }
    }
    if (this.currentStreak < 0) {
      const s = this.lossStreaks.get(absStreak);
      if (s && (s.continued + s.stopped) >= 5) {
        probLoss = s.continued / (s.continued + s.stopped);
      }
    }

    return {
      consecutiveGains: Math.max(0, this.currentStreak),
      consecutiveLosses: Math.max(0, -this.currentStreak),
      probContinueGain: probGain,
      probContinueLoss: probLoss,
    };
  }

  /** Signal: is this a historically bad time to trade? */
  getSignal(dow: number, hour: number): { tradeable: boolean; expectedReturn: number; avgRange: number } {
    const stats = this.getStats(dow, hour);
    if (!stats) return { tradeable: true, expectedReturn: 0, avgRange: 0 };
    return {
      tradeable: stats.avgRange > 0.001, // skip very low range hours
      expectedReturn: stats.avgReturn,
      avgRange: stats.avgRange,
    };
  }
}

// ════════════════════════════════════════════════════════════
// 3. CTRSI — Caretaker RSI with Divergence Detection
//
// Auto-detects:
//   - Regular bullish divergence (price lower low, RSI higher low)
//   - Regular bearish divergence (price higher high, RSI lower high)
//   - Hidden bullish divergence (price higher low, RSI lower low)
//   - Hidden bearish divergence (price lower high, RSI higher high)
//
// Uses pivot detection on both price and RSI to find divergences.
// ════════════════════════════════════════════════════════════

export interface CTRSIConfig {
  rsiLength: number;       // RSI period (default: 14)
  pivotLeft: number;       // bars to left for pivot (default: 5)
  pivotRight: number;      // bars to right for pivot (default: 2)
  maxLookback: number;     // max bars between divergence pivots (default: 60)
  overbought: number;      // (default: 70)
  oversold: number;        // (default: 30)
}

export type DivergenceType = 'REGULAR_BULL' | 'REGULAR_BEAR' | 'HIDDEN_BULL' | 'HIDDEN_BEAR';

export interface Divergence {
  type: DivergenceType;
  barIndex: number;
  rsiValue: number;
  priceValue: number;
  strength: number;    // 0-1, based on how wide the divergence is
}

export interface CTRSIState {
  rsi: number;
  rsiMA: number;
  divergences: Divergence[];
  pivotHighs: { bar: number; price: number; rsi: number }[];
  pivotLows: { bar: number; price: number; rsi: number }[];
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  signalStrength: number;
}

export class CTRSI {
  private config: CTRSIConfig;
  private closes: number[] = [];
  private highs: number[] = [];
  private lows: number[] = [];
  private rsiValues: number[] = [];
  private gains: number[] = [];
  private losses: number[] = [];
  private avgGain = 0;
  private avgLoss = 0;
  private barIndex = 0;

  // Pivot storage
  private pivotHighs: { bar: number; price: number; rsi: number }[] = [];
  private pivotLows: { bar: number; price: number; rsi: number }[] = [];
  private lastDivergences: Divergence[] = [];

  constructor(config?: Partial<CTRSIConfig>) {
    this.config = {
      rsiLength: config?.rsiLength ?? 14,
      pivotLeft: config?.pivotLeft ?? 5,
      pivotRight: config?.pivotRight ?? 2,
      maxLookback: config?.maxLookback ?? 60,
      overbought: config?.overbought ?? 70,
      oversold: config?.oversold ?? 30,
    };
  }

  update(candle: Candle) {
    this.closes.push(candle.close);
    this.highs.push(candle.high);
    this.lows.push(candle.low);
    this.barIndex++;

    // Calculate RSI (Wilder's smoothing)
    if (this.closes.length < 2) { this.rsiValues.push(50); return; }

    const change = candle.close - this.closes[this.closes.length - 2];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (this.closes.length <= this.config.rsiLength + 1) {
      this.gains.push(gain);
      this.losses.push(loss);
      if (this.closes.length === this.config.rsiLength + 1) {
        this.avgGain = this.gains.reduce((s, v) => s + v, 0) / this.config.rsiLength;
        this.avgLoss = this.losses.reduce((s, v) => s + v, 0) / this.config.rsiLength;
      }
      this.rsiValues.push(50);
      return;
    }

    this.avgGain = (this.avgGain * (this.config.rsiLength - 1) + gain) / this.config.rsiLength;
    this.avgLoss = (this.avgLoss * (this.config.rsiLength - 1) + loss) / this.config.rsiLength;

    const rs = this.avgLoss > 0 ? this.avgGain / this.avgLoss : 100;
    const rsi = 100 - 100 / (1 + rs);
    this.rsiValues.push(rsi);

    // Detect pivots
    this.detectPivots();

    // Detect divergences
    this.detectDivergences();

    // Trim arrays
    const maxLen = this.config.maxLookback * 3;
    if (this.closes.length > maxLen) {
      const trim = this.closes.length - maxLen;
      this.closes = this.closes.slice(trim);
      this.highs = this.highs.slice(trim);
      this.lows = this.lows.slice(trim);
      this.rsiValues = this.rsiValues.slice(trim);
    }
  }

  private detectPivots() {
    const { pivotLeft, pivotRight } = this.config;
    const i = this.closes.length - 1 - pivotRight;
    if (i < pivotLeft) return;

    // Check pivot high (price)
    let isPH = true;
    for (let j = 1; j <= pivotLeft; j++) if (this.highs[i - j] >= this.highs[i]) { isPH = false; break; }
    if (isPH) for (let j = 1; j <= pivotRight; j++) if (this.highs[i + j] >= this.highs[i]) { isPH = false; break; }
    if (isPH) {
      this.pivotHighs.push({ bar: this.barIndex - pivotRight, price: this.highs[i], rsi: this.rsiValues[i] });
      if (this.pivotHighs.length > 20) this.pivotHighs.shift();
    }

    // Check pivot low (price)
    let isPL = true;
    for (let j = 1; j <= pivotLeft; j++) if (this.lows[i - j] <= this.lows[i]) { isPL = false; break; }
    if (isPL) for (let j = 1; j <= pivotRight; j++) if (this.lows[i + j] <= this.lows[i]) { isPL = false; break; }
    if (isPL) {
      this.pivotLows.push({ bar: this.barIndex - pivotRight, price: this.lows[i], rsi: this.rsiValues[i] });
      if (this.pivotLows.length > 20) this.pivotLows.shift();
    }
  }

  private detectDivergences() {
    this.lastDivergences = [];
    const { maxLookback } = this.config;

    // Need at least 2 pivots
    if (this.pivotLows.length >= 2) {
      const curr = this.pivotLows[this.pivotLows.length - 1];
      const prev = this.pivotLows[this.pivotLows.length - 2];
      if (curr.bar - prev.bar <= maxLookback) {
        // Regular bullish: price lower low, RSI higher low
        if (curr.price < prev.price && curr.rsi > prev.rsi) {
          const strength = Math.min(1, Math.abs(curr.rsi - prev.rsi) / 10);
          this.lastDivergences.push({ type: 'REGULAR_BULL', barIndex: curr.bar, rsiValue: curr.rsi, priceValue: curr.price, strength });
        }
        // Hidden bullish: price higher low, RSI lower low
        if (curr.price > prev.price && curr.rsi < prev.rsi) {
          const strength = Math.min(1, Math.abs(curr.rsi - prev.rsi) / 10);
          this.lastDivergences.push({ type: 'HIDDEN_BULL', barIndex: curr.bar, rsiValue: curr.rsi, priceValue: curr.price, strength });
        }
      }
    }

    if (this.pivotHighs.length >= 2) {
      const curr = this.pivotHighs[this.pivotHighs.length - 1];
      const prev = this.pivotHighs[this.pivotHighs.length - 2];
      if (curr.bar - prev.bar <= maxLookback) {
        // Regular bearish: price higher high, RSI lower high
        if (curr.price > prev.price && curr.rsi < prev.rsi) {
          const strength = Math.min(1, Math.abs(curr.rsi - prev.rsi) / 10);
          this.lastDivergences.push({ type: 'REGULAR_BEAR', barIndex: curr.bar, rsiValue: curr.rsi, priceValue: curr.price, strength });
        }
        // Hidden bearish: price lower high, RSI higher high
        if (curr.price < prev.price && curr.rsi > prev.rsi) {
          const strength = Math.min(1, Math.abs(curr.rsi - prev.rsi) / 10);
          this.lastDivergences.push({ type: 'HIDDEN_BEAR', barIndex: curr.bar, rsiValue: curr.rsi, priceValue: curr.price, strength });
        }
      }
    }
  }

  getState(): CTRSIState | null {
    if (this.rsiValues.length < this.config.rsiLength + 5) return null;

    const rsi = this.rsiValues[this.rsiValues.length - 1];
    // Simple RSI MA
    const maLen = Math.min(9, this.rsiValues.length);
    const rsiMA = this.rsiValues.slice(-maLen).reduce((s, v) => s + v, 0) / maLen;

    let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    let signalStrength = 0;

    // Divergence-based signals
    const recentDivs = this.lastDivergences.filter(d => this.barIndex - d.barIndex < 10);
    const bullDivs = recentDivs.filter(d => d.type.includes('BULL'));
    const bearDivs = recentDivs.filter(d => d.type.includes('BEAR'));

    if (bullDivs.length > 0 && rsi < this.config.oversold + 10) {
      signal = 'BUY';
      signalStrength = Math.max(...bullDivs.map(d => d.strength));
    } else if (bearDivs.length > 0 && rsi > this.config.overbought - 10) {
      signal = 'SELL';
      signalStrength = Math.max(...bearDivs.map(d => d.strength));
    }

    return { rsi, rsiMA, divergences: this.lastDivergences, pivotHighs: this.pivotHighs.slice(-5), pivotLows: this.pivotLows.slice(-5), signal, signalStrength };
  }
}

// ════════════════════════════════════════════════════════════
// 4. PA_PIVOT — Price Action Pivots
//
// Multi-timeframe structural pivots:
//   - Classic pivots (PP, S1-S3, R1-R3) from daily/weekly
//   - Fibonacci pivots
//   - Camarilla pivots
//   - Structural HH/HL/LH/LL detection
// ════════════════════════════════════════════════════════════

export interface PivotLevels {
  pp: number;
  r1: number; r2: number; r3: number;
  s1: number; s2: number; s3: number;
  // Fibonacci
  fibR1: number; fibR2: number; fibR3: number;
  fibS1: number; fibS2: number; fibS3: number;
  // Camarilla
  camR1: number; camR2: number; camR3: number; camR4: number;
  camS1: number; camS2: number; camS3: number; camS4: number;
}

export interface StructuralPivot {
  type: 'HH' | 'HL' | 'LH' | 'LL';
  price: number;
  bar: number;
  trendBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export class PAPivot {
  private dailyCandles: { high: number; low: number; close: number; open: number }[] = [];
  private currentDay = 0;
  private currentDayHLC = { high: -Infinity, low: Infinity, close: 0, open: 0 };
  // Structural pivots
  private swingHighs: { price: number; bar: number }[] = [];
  private swingLows: { price: number; bar: number }[] = [];
  private barCounter = 0;
  private highs: number[] = [];
  private lows: number[] = [];

  update(candle: Candle) {
    this.barCounter++;
    this.highs.push(candle.high);
    this.lows.push(candle.low);

    // Aggregate into daily candles
    const day = Math.floor(candle.closeTime / 86_400_000);
    if (day > this.currentDay && this.currentDay > 0) {
      this.dailyCandles.push({ ...this.currentDayHLC });
      if (this.dailyCandles.length > 30) this.dailyCandles.shift();
      this.currentDayHLC = { high: candle.high, low: candle.low, close: candle.close, open: candle.open };
      this.currentDay = day;
    } else {
      if (this.currentDay === 0) { this.currentDayHLC.open = candle.open; this.currentDay = day; }
      if (candle.high > this.currentDayHLC.high) this.currentDayHLC.high = candle.high;
      if (candle.low < this.currentDayHLC.low) this.currentDayHLC.low = candle.low;
      this.currentDayHLC.close = candle.close;
    }

    // Detect swing pivots (5 bar left, 2 bar right)
    this.detectSwings();

    // Trim
    const maxLen = 500;
    if (this.highs.length > maxLen) { this.highs = this.highs.slice(-maxLen); this.lows = this.lows.slice(-maxLen); }
  }

  private detectSwings() {
    const left = 5, right = 2;
    const i = this.highs.length - 1 - right;
    if (i < left) return;

    let isSH = true, isSL = true;
    for (let j = 1; j <= left; j++) {
      if (this.highs[i - j] >= this.highs[i]) isSH = false;
      if (this.lows[i - j] <= this.lows[i]) isSL = false;
    }
    for (let j = 1; j <= right; j++) {
      if (this.highs[i + j] >= this.highs[i]) isSH = false;
      if (this.lows[i + j] <= this.lows[i]) isSL = false;
    }

    if (isSH) { this.swingHighs.push({ price: this.highs[i], bar: this.barCounter - right }); if (this.swingHighs.length > 20) this.swingHighs.shift(); }
    if (isSL) { this.swingLows.push({ price: this.lows[i], bar: this.barCounter - right }); if (this.swingLows.length > 20) this.swingLows.shift(); }
  }

  /** Get daily pivot levels from previous day */
  getPivotLevels(): PivotLevels | null {
    if (this.dailyCandles.length < 1) return null;
    const prev = this.dailyCandles[this.dailyCandles.length - 1];
    const { high: H, low: L, close: C } = prev;
    const range = H - L;

    const pp = (H + L + C) / 3;

    return {
      pp,
      // Classic
      r1: 2 * pp - L, r2: pp + range, r3: H + 2 * (pp - L),
      s1: 2 * pp - H, s2: pp - range, s3: L - 2 * (H - pp),
      // Fibonacci
      fibR1: pp + 0.382 * range, fibR2: pp + 0.618 * range, fibR3: pp + range,
      fibS1: pp - 0.382 * range, fibS2: pp - 0.618 * range, fibS3: pp - range,
      // Camarilla
      camR1: C + range * 1.1 / 12, camR2: C + range * 1.1 / 6,
      camR3: C + range * 1.1 / 4, camR4: C + range * 1.1 / 2,
      camS1: C - range * 1.1 / 12, camS2: C - range * 1.1 / 6,
      camS3: C - range * 1.1 / 4, camS4: C - range * 1.1 / 2,
    };
  }

  /** Get structural HH/HL/LH/LL analysis */
  getStructure(): StructuralPivot | null {
    if (this.swingHighs.length < 2 || this.swingLows.length < 2) return null;

    const currHigh = this.swingHighs[this.swingHighs.length - 1];
    const prevHigh = this.swingHighs[this.swingHighs.length - 2];
    const currLow = this.swingLows[this.swingLows.length - 1];
    const prevLow = this.swingLows[this.swingLows.length - 2];

    const hh = currHigh.price > prevHigh.price;
    const hl = currLow.price > prevLow.price;
    const lh = currHigh.price < prevHigh.price;
    const ll = currLow.price < prevLow.price;

    if (hh && hl) return { type: 'HH', price: currHigh.price, bar: currHigh.bar, trendBias: 'BULLISH' };
    if (lh && ll) return { type: 'LL', price: currLow.price, bar: currLow.bar, trendBias: 'BEARISH' };
    if (hh && ll) return { type: 'HH', price: currHigh.price, bar: currHigh.bar, trendBias: 'NEUTRAL' };
    if (hl) return { type: 'HL', price: currLow.price, bar: currLow.bar, trendBias: 'BULLISH' };
    if (lh) return { type: 'LH', price: currHigh.price, bar: currHigh.bar, trendBias: 'BEARISH' };

    return null;
  }

  /** Signal: near a pivot level? */
  getSignal(price: number): { nearLevel: string; distance: number; bias: Side | 'NEUTRAL' } | null {
    const pivots = this.getPivotLevels();
    if (!pivots) return null;

    const levels: [string, number][] = [
      ['PP', pivots.pp], ['R1', pivots.r1], ['R2', pivots.r2], ['S1', pivots.s1], ['S2', pivots.s2],
      ['FibR1', pivots.fibR1], ['FibR2', pivots.fibR2], ['FibS1', pivots.fibS1], ['FibS2', pivots.fibS2],
      ['CamR3', pivots.camR3], ['CamS3', pivots.camS3],
    ];

    let closest = { name: '', dist: Infinity };
    for (const [name, level] of levels) {
      const dist = Math.abs(price - level) / price;
      if (dist < closest.dist) closest = { name, dist };
    }

    if (closest.dist > 0.005) return null; // more than 0.5% away, not relevant

    const bias = closest.name.includes('S') ? 'LONG' : closest.name.includes('R') ? 'SHORT' : 'NEUTRAL';
    return { nearLevel: closest.name, distance: closest.dist, bias };
  }
}

// ════════════════════════════════════════════════════════════
// 5. SMC — Smart Money Concepts
//
// Detects:
//   - Order Blocks (OB): Last down candle before bullish move / vice versa
//   - Fair Value Gaps (FVG): Price imbalance between 3 candles
//   - BOS/CHoCH: Break of Structure / Change of Character
//   - Liquidity: Equal highs/lows that attract stop hunts
// ════════════════════════════════════════════════════════════

export interface OrderBlock {
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  bar: number;
  mitigated: boolean;
  strength: number;   // based on the impulse that followed
}

export interface FairValueGap {
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  bar: number;
  filled: boolean;
  midpoint: number;
}

export interface StructureBreak {
  type: 'BOS' | 'CHoCH';
  side: 'BULL' | 'BEAR';
  level: number;
  bar: number;
}

export interface LiquidityLevel {
  type: 'EQUAL_HIGHS' | 'EQUAL_LOWS';
  price: number;
  count: number;      // how many touches
  bar: number;
  swept: boolean;
}

export interface SMCState {
  orderBlocks: OrderBlock[];
  fvgs: FairValueGap[];
  structureBreaks: StructureBreak[];
  liquidity: LiquidityLevel[];
  signal: { side: Side; reason: string; strength: number } | null;
}

export class SMC {
  private candles: Candle[] = [];
  private barCounter = 0;
  private orderBlocks: OrderBlock[] = [];
  private fvgs: FairValueGap[] = [];
  private structureBreaks: StructureBreak[] = [];
  private liquidityLevels: LiquidityLevel[] = [];
  // Swing tracking for structure
  private swingHighs: { price: number; bar: number }[] = [];
  private swingLows: { price: number; bar: number }[] = [];
  private lastTrend: 'UP' | 'DOWN' | 'NONE' = 'NONE';

  private config = {
    obLookback: 10,
    fvgMinGap: 0.001,       // min 0.1% gap for FVG
    eqlTolerance: 0.0005,   // 0.05% tolerance for equal levels
    maxActiveOB: 10,
    maxActiveFVG: 10,
    maxLiquidity: 10,
  };

  update(candle: Candle) {
    this.candles.push(candle);
    this.barCounter++;

    if (this.candles.length > 200) this.candles = this.candles.slice(-150);

    // Detect everything
    if (this.candles.length >= 3) {
      this.detectFVG();
      this.detectOrderBlocks();
      this.detectStructure();
      this.detectLiquidity();
      this.updateMitigation(candle);
    }
  }

  private detectFVG() {
    const len = this.candles.length;
    const c1 = this.candles[len - 3]; // oldest
    const c2 = this.candles[len - 2]; // middle
    const c3 = this.candles[len - 1]; // newest

    // Bullish FVG: gap between c1.high and c3.low (c2 body in between)
    if (c3.low > c1.high) {
      const gapSize = (c3.low - c1.high) / c2.close;
      if (gapSize >= this.config.fvgMinGap) {
        this.fvgs.push({
          type: 'BULLISH', top: c3.low, bottom: c1.high,
          bar: this.barCounter - 1, filled: false, midpoint: (c3.low + c1.high) / 2,
        });
      }
    }

    // Bearish FVG: gap between c3.high and c1.low
    if (c3.high < c1.low) {
      const gapSize = (c1.low - c3.high) / c2.close;
      if (gapSize >= this.config.fvgMinGap) {
        this.fvgs.push({
          type: 'BEARISH', top: c1.low, bottom: c3.high,
          bar: this.barCounter - 1, filled: false, midpoint: (c1.low + c3.high) / 2,
        });
      }
    }

    // Cap
    while (this.fvgs.length > this.config.maxActiveFVG * 2) this.fvgs.shift();
  }

  private detectOrderBlocks() {
    const len = this.candles.length;
    if (len < this.config.obLookback) return;

    const curr = this.candles[len - 1];
    const prev = this.candles[len - 2];

    // Bullish OB: bearish candle followed by strong bullish candle
    const isBearish = prev.close < prev.open;
    const isBullishImpulse = curr.close > curr.open && (curr.close - curr.open) > (prev.open - prev.close) * 1.5;

    if (isBearish && isBullishImpulse) {
      const strength = (curr.close - curr.open) / curr.open * 100;
      this.orderBlocks.push({
        type: 'BULLISH', top: prev.open, bottom: prev.low,
        bar: this.barCounter - 1, mitigated: false, strength: Math.min(1, strength / 0.5),
      });
    }

    // Bearish OB: bullish candle followed by strong bearish candle
    const isBullish = prev.close > prev.open;
    const isBearishImpulse = curr.close < curr.open && (curr.open - curr.close) > (prev.close - prev.open) * 1.5;

    if (isBullish && isBearishImpulse) {
      const strength = (curr.open - curr.close) / curr.open * 100;
      this.orderBlocks.push({
        type: 'BEARISH', top: prev.high, bottom: prev.open,
        bar: this.barCounter - 1, mitigated: false, strength: Math.min(1, strength / 0.5),
      });
    }

    while (this.orderBlocks.length > this.config.maxActiveOB * 2) this.orderBlocks.shift();
  }

  private detectStructure() {
    // Simple swing detection (3 bar pivots)
    if (this.candles.length < 5) return;
    const i = this.candles.length - 3;

    if (this.candles[i].high > this.candles[i - 1].high && this.candles[i].high > this.candles[i - 2].high &&
        this.candles[i].high > this.candles[i + 1].high && this.candles[i].high > this.candles[i + 2].high) {
      this.swingHighs.push({ price: this.candles[i].high, bar: this.barCounter - 2 });
      if (this.swingHighs.length > 10) this.swingHighs.shift();
    }

    if (this.candles[i].low < this.candles[i - 1].low && this.candles[i].low < this.candles[i - 2].low &&
        this.candles[i].low < this.candles[i + 1].low && this.candles[i].low < this.candles[i + 2].low) {
      this.swingLows.push({ price: this.candles[i].low, bar: this.barCounter - 2 });
      if (this.swingLows.length > 10) this.swingLows.shift();
    }

    // BOS / CHoCH detection
    const curr = this.candles[this.candles.length - 1];
    if (this.swingHighs.length >= 2 && this.swingLows.length >= 2) {
      const lastHigh = this.swingHighs[this.swingHighs.length - 1];
      const lastLow = this.swingLows[this.swingLows.length - 1];

      // BOS (Break of Structure) = continuation break
      // CHoCH (Change of Character) = reversal break
      if (curr.close > lastHigh.price) {
        const type = this.lastTrend === 'UP' ? 'BOS' : 'CHoCH';
        this.structureBreaks.push({ type, side: 'BULL', level: lastHigh.price, bar: this.barCounter });
        this.lastTrend = 'UP';
      }
      if (curr.close < lastLow.price) {
        const type = this.lastTrend === 'DOWN' ? 'BOS' : 'CHoCH';
        this.structureBreaks.push({ type, side: 'BEAR', level: lastLow.price, bar: this.barCounter });
        this.lastTrend = 'DOWN';
      }

      while (this.structureBreaks.length > 20) this.structureBreaks.shift();
    }
  }

  private detectLiquidity() {
    // Equal highs / equal lows (liquidity pools)
    if (this.swingHighs.length >= 2) {
      const last2H = this.swingHighs.slice(-3);
      for (let a = 0; a < last2H.length; a++) {
        for (let b = a + 1; b < last2H.length; b++) {
          const diff = Math.abs(last2H[a].price - last2H[b].price) / last2H[a].price;
          if (diff < this.config.eqlTolerance) {
            const existing = this.liquidityLevels.find(l => l.type === 'EQUAL_HIGHS' && Math.abs(l.price - last2H[a].price) / l.price < 0.001);
            if (existing) { existing.count++; existing.bar = Math.max(existing.bar, last2H[b].bar); }
            else this.liquidityLevels.push({ type: 'EQUAL_HIGHS', price: (last2H[a].price + last2H[b].price) / 2, count: 2, bar: last2H[b].bar, swept: false });
          }
        }
      }
    }
    if (this.swingLows.length >= 2) {
      const last2L = this.swingLows.slice(-3);
      for (let a = 0; a < last2L.length; a++) {
        for (let b = a + 1; b < last2L.length; b++) {
          const diff = Math.abs(last2L[a].price - last2L[b].price) / last2L[a].price;
          if (diff < this.config.eqlTolerance) {
            const existing = this.liquidityLevels.find(l => l.type === 'EQUAL_LOWS' && Math.abs(l.price - last2L[a].price) / l.price < 0.001);
            if (existing) { existing.count++; existing.bar = Math.max(existing.bar, last2L[b].bar); }
            else this.liquidityLevels.push({ type: 'EQUAL_LOWS', price: (last2L[a].price + last2L[b].price) / 2, count: 2, bar: last2L[b].bar, swept: false });
          }
        }
      }
    }
    while (this.liquidityLevels.length > this.config.maxLiquidity * 2) this.liquidityLevels.shift();
  }

  private updateMitigation(candle: Candle) {
    // Check if OBs have been mitigated (price returned to OB zone)
    for (const ob of this.orderBlocks) {
      if (ob.mitigated) continue;
      if (ob.type === 'BULLISH' && candle.low <= ob.top && candle.low >= ob.bottom) ob.mitigated = true;
      if (ob.type === 'BEARISH' && candle.high >= ob.bottom && candle.high <= ob.top) ob.mitigated = true;
    }
    // Check FVG fill
    for (const fvg of this.fvgs) {
      if (fvg.filled) continue;
      if (fvg.type === 'BULLISH' && candle.low <= fvg.bottom) fvg.filled = true;
      if (fvg.type === 'BEARISH' && candle.high >= fvg.top) fvg.filled = true;
    }
    // Check liquidity sweeps
    for (const liq of this.liquidityLevels) {
      if (liq.swept) continue;
      if (liq.type === 'EQUAL_HIGHS' && candle.high > liq.price) liq.swept = true;
      if (liq.type === 'EQUAL_LOWS' && candle.low < liq.price) liq.swept = true;
    }
  }

  getState(): SMCState {
    const activeOBs = this.orderBlocks.filter(ob => !ob.mitigated).slice(-this.config.maxActiveOB);
    const activeFVGs = this.fvgs.filter(f => !f.filled).slice(-this.config.maxActiveFVG);
    const recentBreaks = this.structureBreaks.slice(-5);
    const activeLiq = this.liquidityLevels.filter(l => !l.swept).slice(-this.config.maxLiquidity);

    // Composite signal
    let signal: SMCState['signal'] = null;
    const price = this.candles.length > 0 ? this.candles[this.candles.length - 1].close : 0;

    if (price > 0) {
      // Bullish: price at bullish OB + bullish FVG nearby + BOS bull
      const nearBullOB = activeOBs.find(ob => ob.type === 'BULLISH' && price >= ob.bottom && price <= ob.top * 1.002);
      const nearBullFVG = activeFVGs.find(f => f.type === 'BULLISH' && price >= f.bottom && price <= f.top * 1.002);
      const recentBullBOS = recentBreaks.find(b => b.side === 'BULL' && this.barCounter - b.bar < 20);

      const nearBearOB = activeOBs.find(ob => ob.type === 'BEARISH' && price <= ob.top && price >= ob.bottom * 0.998);
      const nearBearFVG = activeFVGs.find(f => f.type === 'BEARISH' && price <= f.top && price >= f.bottom * 0.998);
      const recentBearBOS = recentBreaks.find(b => b.side === 'BEAR' && this.barCounter - b.bar < 20);

      let bullScore = 0, bearScore = 0;
      if (nearBullOB) bullScore += 0.4 * nearBullOB.strength;
      if (nearBullFVG) bullScore += 0.3;
      if (recentBullBOS) bullScore += recentBullBOS.type === 'CHoCH' ? 0.4 : 0.2;

      if (nearBearOB) bearScore += 0.4 * nearBearOB.strength;
      if (nearBearFVG) bearScore += 0.3;
      if (recentBearBOS) bearScore += recentBearBOS.type === 'CHoCH' ? 0.4 : 0.2;

      if (bullScore > 0.3 && bullScore > bearScore) {
        const reasons = [];
        if (nearBullOB) reasons.push('Bull OB');
        if (nearBullFVG) reasons.push('Bull FVG');
        if (recentBullBOS) reasons.push(recentBullBOS.type);
        signal = { side: 'LONG', reason: reasons.join('+'), strength: Math.min(1, bullScore) };
      } else if (bearScore > 0.3 && bearScore > bullScore) {
        const reasons = [];
        if (nearBearOB) reasons.push('Bear OB');
        if (nearBearFVG) reasons.push('Bear FVG');
        if (recentBearBOS) reasons.push(recentBearBOS.type);
        signal = { side: 'SHORT', reason: reasons.join('+'), strength: Math.min(1, bearScore) };
      }
    }

    return { orderBlocks: activeOBs, fvgs: activeFVGs, structureBreaks: recentBreaks, liquidity: activeLiq, signal };
  }
}

// ════════════════════════════════════════════════════════════
// 6. INDICATOR HUB — Combines all indicators into one signal
// ════════════════════════════════════════════════════════════

export interface CompositeSignal {
  bias: Side | 'NEUTRAL';
  confidence: number;        // 0-100
  reasons: string[];
  indicators: {
    hpdr: { probability: number; signal: string } | null;
    ctrsi: { rsi: number; signal: string; divergences: string[] } | null;
    smc: { signal: string; obs: number; fvgs: number } | null;
    pivot: { nearLevel: string; structure: string } | null;
    hpas: { expectedReturn: number; sequential: string } | null;
  };
}

export class IndicatorHub {
  readonly hpdr: HPDR;
  readonly hpas: HPAS;
  readonly ctrsi: CTRSI;
  readonly pivot: PAPivot;
  readonly smc: SMC;

  constructor(config?: {
    hpdr?: Partial<HPDRConfig>;
    ctrsi?: Partial<CTRSIConfig>;
  }) {
    this.hpdr = new HPDR(config?.hpdr);
    this.hpas = new HPAS();
    this.ctrsi = new CTRSI(config?.ctrsi);
    this.pivot = new PAPivot();
    this.smc = new SMC();
  }

  /** Feed a candle to ALL indicators at once */
  update(candle: Candle) {
    this.hpdr.update(candle);
    this.hpas.update(candle);
    this.ctrsi.update(candle);
    this.pivot.update(candle);
    this.smc.update(candle);
  }

  /** Get composite signal from all indicators */
  getSignal(price: number): CompositeSignal {
    let bullScore = 0, bearScore = 0;
    const reasons: string[] = [];

    const date = new Date();
    const dow = date.getUTCDay();
    const hour = date.getUTCHours();

    // HPDR
    const hpdrSig = this.hpdr.getSignal();
    let hpdrInfo: CompositeSignal['indicators']['hpdr'] = null;
    if (hpdrSig) {
      hpdrInfo = { probability: this.hpdr.getBands()?.probability ?? 0.5, signal: hpdrSig.bias };
      if (hpdrSig.bias === 'LONG') { bullScore += 15 * hpdrSig.strength; reasons.push(`HPDR: ${hpdrSig.nearLevel}`); }
      if (hpdrSig.bias === 'SHORT') { bearScore += 15 * hpdrSig.strength; reasons.push(`HPDR: ${hpdrSig.nearLevel}`); }
    }

    // CTRSI
    const rsiState = this.ctrsi.getState();
    let ctrsiInfo: CompositeSignal['indicators']['ctrsi'] = null;
    if (rsiState) {
      ctrsiInfo = { rsi: rsiState.rsi, signal: rsiState.signal, divergences: rsiState.divergences.map(d => d.type) };
      if (rsiState.signal === 'BUY') { bullScore += 25 * rsiState.signalStrength; reasons.push(`RSI Div: ${rsiState.divergences.map(d => d.type).join(',')}`); }
      if (rsiState.signal === 'SELL') { bearScore += 25 * rsiState.signalStrength; reasons.push(`RSI Div: ${rsiState.divergences.map(d => d.type).join(',')}`); }
    }

    // SMC
    const smcState = this.smc.getState();
    let smcInfo: CompositeSignal['indicators']['smc'] = null;
    smcInfo = { signal: smcState.signal?.reason ?? 'NEUTRAL', obs: smcState.orderBlocks.length, fvgs: smcState.fvgs.length };
    if (smcState.signal) {
      const score = 30 * smcState.signal.strength;
      if (smcState.signal.side === 'LONG') { bullScore += score; reasons.push(`SMC: ${smcState.signal.reason}`); }
      else { bearScore += score; reasons.push(`SMC: ${smcState.signal.reason}`); }
    }

    // Pivot
    const pivotSig = this.pivot.getSignal(price);
    const structure = this.pivot.getStructure();
    let pivotInfo: CompositeSignal['indicators']['pivot'] = null;
    if (pivotSig || structure) {
      pivotInfo = { nearLevel: pivotSig?.nearLevel ?? 'none', structure: structure?.type ?? 'none' };
      if (pivotSig) {
        if (pivotSig.bias === 'LONG') { bullScore += 10; reasons.push(`Pivot: near ${pivotSig.nearLevel}`); }
        if (pivotSig.bias === 'SHORT') { bearScore += 10; reasons.push(`Pivot: near ${pivotSig.nearLevel}`); }
      }
      if (structure) {
        if (structure.trendBias === 'BULLISH') bullScore += 10;
        if (structure.trendBias === 'BEARISH') bearScore += 10;
      }
    }

    // HPAS
    const hpasSig = this.hpas.getSignal(dow, hour);
    const sequential = this.hpas.getSequential();
    let hpasInfo: CompositeSignal['indicators']['hpas'] = null;
    hpasInfo = { expectedReturn: hpasSig.expectedReturn, sequential: `G:${sequential.consecutiveGains} L:${sequential.consecutiveLosses}` };

    // Sequential: long streaks suggest mean reversion
    if (sequential.consecutiveGains >= 5 && sequential.probContinueGain < 0.4) { bearScore += 10; reasons.push(`CT Seq: ${sequential.consecutiveGains} greens, P(cont)=${(sequential.probContinueGain * 100).toFixed(0)}%`); }
    if (sequential.consecutiveLosses >= 5 && sequential.probContinueLoss < 0.4) { bullScore += 10; reasons.push(`CT Seq: ${sequential.consecutiveLosses} reds, P(cont)=${(sequential.probContinueLoss * 100).toFixed(0)}%`); }

    // Composite
    const totalScore = bullScore + bearScore;
    let bias: Side | 'NEUTRAL' = 'NEUTRAL';
    let confidence = 0;

    if (bullScore > bearScore && bullScore >= 30) {
      bias = 'LONG';
      confidence = Math.min(100, bullScore);
    } else if (bearScore > bullScore && bearScore >= 30) {
      bias = 'SHORT';
      confidence = Math.min(100, bearScore);
    }

    return { bias, confidence, reasons, indicators: { hpdr: hpdrInfo, ctrsi: ctrsiInfo, smc: smcInfo, pivot: pivotInfo, hpas: hpasInfo } };
  }
}

// ════════════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════════════

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
