// ============================================================
// src/indicators/technical.ts — Technical Indicators
// ============================================================

import type { Candle, Indicators } from '../types';

/**
 * Calculate EMA (Exponential Moving Average)
 */
export function calcEMA(closes: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);

  // Start with SMA for first value
  let sum = 0;
  for (let i = 0; i < period && i < closes.length; i++) {
    sum += closes[i];
  }
  result[period - 1] = sum / period;

  // Calculate EMA from period onwards
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }

  return result;
}

/**
 * Calculate RSI (Relative Strength Index)
 */
export function calcRSI(closes: number[], period: number): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  // Subsequent values using smoothed averages
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    result[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }

  return result;
}

/**
 * Calculate MFI (Money Flow Index)
 * Requires high, low, close, volume
 */
export function calcMFI(candles: Candle[], period: number): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return result;

  // Typical price = (H + L + C) / 3
  const tp: number[] = candles.map(c => (c.high + c.low + c.close) / 3);
  const rawMF: number[] = tp.map((t, i) => t * candles[i].volume);

  for (let i = period; i < candles.length; i++) {
    let posFlow = 0;
    let negFlow = 0;

    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) {
        posFlow += rawMF[j];
      } else if (tp[j] < tp[j - 1]) {
        negFlow += rawMF[j];
      }
    }

    const mfRatio = negFlow === 0 ? 100 : posFlow / negFlow;
    result[i] = 100 - (100 / (1 + mfRatio));
  }

  return result;
}

/**
 * Calculate Bollinger Bands
 */
export function calcBollingerBands(
  closes: number[],
  period: number,
  stddev: number
): { upper: number[]; middle: number[]; lower: number[]; width: number[] } {
  const upper: number[] = new Array(closes.length).fill(NaN);
  const middle: number[] = new Array(closes.length).fill(NaN);
  const lower: number[] = new Array(closes.length).fill(NaN);
  const width: number[] = new Array(closes.length).fill(NaN);

  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + (val - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);

    middle[i] = mean;
    upper[i] = mean + stddev * sd;
    lower[i] = mean - stddev * sd;
    width[i] = mean > 0 ? ((upper[i] - lower[i]) / mean) * 100 : 0;
  }

  return { upper, middle, lower, width };
}

/**
 * Calculate ATR (Average True Range)
 */
export function calcATR(candles: Candle[], period: number): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return result;

  // True Range
  const tr: number[] = [0]; // First candle has no previous
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }

  // Initial ATR = SMA of first `period` TRs
  let atrSum = 0;
  for (let i = 1; i <= period; i++) {
    atrSum += tr[i];
  }
  result[period] = atrSum / period;

  // Smoothed ATR
  for (let i = period + 1; i < candles.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }

  return result;
}

/**
 * Calculate average volume over N periods
 */
export function calcAvgVolume(candles: Candle[], period: number): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += candles[j].volume;
    }
    result[i] = sum / period;
  }

  return result;
}

/**
 * Compute all indicators from candle data
 */
export function computeIndicators(
  candles: Candle[],
  config: {
    emaFast: number;
    emaMid: number;
    emaSlow: number;
    rsiPeriod: number;
    mfiPeriod: number;
    bbPeriod: number;
    bbStddev: number;
    atrPeriod: number;
  }
): Indicators | null {
  if (candles.length < 60) return null; // Need enough data

  const closes = candles.map(c => c.close);
  const idx = closes.length - 1;

  const emaFastArr = calcEMA(closes, config.emaFast);
  const emaMidArr = calcEMA(closes, config.emaMid);
  const emaSlowArr = calcEMA(closes, config.emaSlow);
  const rsiArr = calcRSI(closes, config.rsiPeriod);
  const mfiArr = calcMFI(candles, config.mfiPeriod);
  const bb = calcBollingerBands(closes, config.bbPeriod, config.bbStddev);
  const atrArr = calcATR(candles, config.atrPeriod);
  const avgVol = calcAvgVolume(candles, 20);

  // ATR average over last 20 periods
  const atrRecent = atrArr.slice(-20).filter(v => !isNaN(v));
  const atrAvg20 = atrRecent.length > 0
    ? atrRecent.reduce((a, b) => a + b, 0) / atrRecent.length
    : atrArr[idx] || 0;

  const volumeRatio = avgVol[idx] > 0
    ? candles[idx].volume / avgVol[idx]
    : 1;

  const result: Indicators = {
    emaFast: emaFastArr[idx] || 0,
    emaMid: emaMidArr[idx] || 0,
    emaSlow: emaSlowArr[idx] || 0,
    rsi: rsiArr[idx] || 50,
    mfi: mfiArr[idx] || 50,
    bbUpper: bb.upper[idx] || 0,
    bbMiddle: bb.middle[idx] || 0,
    bbLower: bb.lower[idx] || 0,
    bbWidth: bb.width[idx] || 0,
    atr: atrArr[idx] || 0,
    atrAvg20,
    volumeRatio,
    prevRsi: rsiArr[idx - 1] || 50,
  };

  return result;
}
