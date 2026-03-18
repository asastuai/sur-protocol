#!/usr/bin/env bun
// ============================================================
// backtester/run.ts — SUR Protocol Backtest Runner v1.0
// Usage: bun run backtester/run.ts [--days=7] [--capital=2000] [--fresh=true]
//
// Adapted from Aster Bot Backtester v7.3 for SUR Protocol.
// Uses Binance Futures public API for price data (same feed SUR uses).
// Fee structure: 0.06% taker (SUR Protocol on-chain fees).
// Supported symbols: BTC-USD, ETH-USD (mapped to BTCUSDT/ETHUSDT)
// ============================================================

import { SimExecutor, type EngineSignal } from './sim-executor';
import { AdaptiveBrain, type MarketSnapshot } from './adaptive-brain';
import { evaluateSwing, evaluateBreakoutRetest, evaluateTrendFollow,
         evaluateScalp, evaluateLevelBounce, evaluateBreakoutPlay,
         evaluateTrendRider, type BtConfig } from './engines';
import { generateReport } from './report';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { generateSyntheticData } from './gen-data';

// ── v6.0 Macro + Circuit Breaker (inline to avoid import issues) ──

type MacroTrend = 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';
interface MacroState {
  trend: MacroTrend; score: number;
  allowLongs: boolean; allowShorts: boolean;
  marginMultiplier: number; cooldownMultiplier: number;
}

interface SLRecord { engine: string; timestamp: number; }
interface DayTradeRecord { engine: string; timestamp: number; pnl: number; }

class SimpleCircuitBreaker {
  private slHistory: SLRecord[] = [];
  private trades: DayTradeRecord[] = [];
  private paused = new Map<string, number>();
  private dailyPnL = 0;
  private dayStart = 0;
  private globalPaused = false;
  private globalResumeAt = 0;
  private consecLosses = new Map<string, number>();

  private maxConsecSL = 3;
  private slWindowMs = 6 * 3_600_000;
  private pauseMs = 12 * 3_600_000;
  private maxTradesPerDay = 10;
  private maxDailyLossAbs = 60;

  constructor(maxDaily = 10) {
    this.maxTradesPerDay = maxDaily;
    this.dayStart = 0;
  }

  canTrade(engine: string, now: number): boolean {
    const todayStart = Math.floor(now / 86_400_000) * 86_400_000;
    if (todayStart > this.dayStart) { this.dayStart = todayStart; this.dailyPnL = 0; }

    if (this.globalPaused && now < this.globalResumeAt) return false;
    if (this.globalPaused) this.globalPaused = false;

    const ep = this.paused.get(engine);
    if (ep && now < ep) return false;
    if (ep) { this.paused.delete(engine); this.consecLosses.set(engine, 0); }

    const todayTrades = this.trades.filter(t => t.timestamp >= this.dayStart);
    if (todayTrades.length >= this.maxTradesPerDay) return false;

    return true;
  }

  recordTrade(engine: string, pnl: number, reason: string, now: number) {
    const todayStart = Math.floor(now / 86_400_000) * 86_400_000;
    if (todayStart > this.dayStart) { this.dayStart = todayStart; this.dailyPnL = 0; }

    this.trades.push({ engine, timestamp: now, pnl });
    this.dailyPnL += pnl;

    if (pnl < 0) this.consecLosses.set(engine, (this.consecLosses.get(engine) || 0) + 1);
    else this.consecLosses.set(engine, 0);

    if (reason === 'SL' || reason === 'LIQUIDATION') {
      this.slHistory.push({ engine, timestamp: now });
      const windowStart = now - this.slWindowMs;
      const cnt = this.slHistory.filter(r => r.engine === engine && r.timestamp >= windowStart).length;
      if (cnt >= this.maxConsecSL) {
        this.paused.set(engine, now + this.pauseMs);
      }
    }

    if (this.dailyPnL < -this.maxDailyLossAbs) {
      this.globalPaused = true;
      this.globalResumeAt = this.dayStart + 86_400_000;
    }

    // Cleanup old
    const cut = now - 7 * 86_400_000;
    this.trades = this.trades.filter(t => t.timestamp >= cut);
    this.slHistory = this.slHistory.filter(r => r.timestamp >= cut);
  }

  getDailyTradeCount(now: number): number {
    return this.trades.filter(t => t.timestamp >= this.dayStart).length;
  }
}

// ── Mejora 4: Adaptive Confidence Gate (Opus PLAN-AVANZADO #4) ──
class AdaptiveGate {
  private recent: boolean[] = [];
  private window = 20;

  recordResult(isWin: boolean) {
    this.recent.push(isWin);
    if (this.recent.length > this.window) this.recent.shift();
  }

  getConfidenceBoost(): number {
    if (this.recent.length < 10) return 0;
    const wr = this.recent.filter(w => w).length / this.recent.length;
    if (wr < 0.35) return 25;
    if (wr < 0.45) return 15;
    if (wr < 0.55) return 5;
    return 0;
  }

  getRecentWR(): number {
    if (this.recent.length === 0) return 0.5;
    return this.recent.filter(w => w).length / this.recent.length;
  }
}

// ── CLI args ──
const args = process.argv.slice(2);
const getArg = (n: string, d: string) => {
  const a = args.find(x => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};

const DAYS    = parseInt(getArg('days', '7'));
const CAPITAL = parseInt(getArg('capital', '2000'));
const RAW_SYMBOL = getArg('symbol', 'BTC-USD');

// SUR Protocol market → Binance Futures symbol mapping
const SUR_TO_BINANCE: Record<string, string> = {
  'BTC-USD': 'BTCUSDT', 'ETH-USD': 'ETHUSDT', 'SOL-USD': 'SOLUSDT',
  'ARB-USD': 'ARBUSDT', 'OP-USD':  'OPUSDT',  'AVAX-USD': 'AVAXUSDT',
  'DOGE-USD': 'DOGEUSDT', 'LINK-USD': 'LINKUSDT',
  // Pass through if already in Binance format
};
const SYMBOL = SUR_TO_BINANCE[RAW_SYMBOL] || RAW_SYMBOL;
const SUR_MARKET = Object.entries(SUR_TO_BINANCE).find(([_, v]) => v === SYMBOL)?.[0] || RAW_SYMBOL;

const REST    = 'https://fapi.binance.com';
const DATADIR = './data/backtest';

// ── Candle type ──
interface Candle {
  openTime: number; open: number; high: number; low: number;
  close: number; volume: number; closeTime: number;
  quoteVolume: number; trades: number;
  takerBuyBaseVol: number; takerBuyQuoteVol: number; isClosed: boolean;
}

// ════════════════════════════════════════════════════════════
// DATA FETCH (cached)
// ════════════════════════════════════════════════════════════

async function fetchKlines(interval: string, start: number, end: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = start;
  while (cursor < end) {
    const url = `${REST}/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&startTime=${cursor}&limit=1500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const raw: any[] = await res.json();
    if (!raw.length) break;
    for (const k of raw) {
      all.push({
        openTime: k[0], open: +k[1], high: +k[2], low: +k[3],
        close: +k[4], volume: +k[5] || 0, closeTime: k[6],
        quoteVolume: +k[7] || 0, trades: k[8] || 0,
        takerBuyBaseVol: +k[9] || 0, takerBuyQuoteVol: +k[10] || 0,
        isClosed: true,
      });
    }
    cursor = raw[raw.length - 1][6] + 1;
    if (raw.length < 1500) break;
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
}

async function loadData(): Promise<{ c1m: Candle[]; c5m: Candle[] }> {
  mkdirSync(DATADIR, { recursive: true });
  const end = Date.now();
  const start = end - DAYS * 86_400_000;
  const warmup = 300 * 5 * 60_000;

  const key = `${SYMBOL}_${DAYS}d_${new Date().toISOString().split('T')[0]}`;
  const f1 = `${DATADIR}/${key}_1m.json`;
  const f5 = `${DATADIR}/${key}_5m.json`;

  if (existsSync(f1) && existsSync(f5)) {
    console.log(`📂 Cached data found: ${key}`);
    return {
      c1m: JSON.parse(readFileSync(f1, 'utf-8')),
      c5m: JSON.parse(readFileSync(f5, 'utf-8')),
    };
  }

  console.log(`📥 Downloading ${DAYS}d of ${SYMBOL}...`);
  try {
    console.log('   1m candles...');
    const c1m = await fetchKlines('1m', start - warmup, end);
    console.log(`   ✅ ${c1m.length} x 1m`);

    console.log('   5m candles...');
    const c5m = await fetchKlines('5m', start - warmup, end);
    console.log(`   ✅ ${c5m.length} x 5m`);

    writeFileSync(f1, JSON.stringify(c1m));
    writeFileSync(f5, JSON.stringify(c5m));
    console.log(`   💾 Cached`);
    return { c1m, c5m };
  } catch (e) {
    console.log(`   ⚠️ Network unavailable, using synthetic data for testing`);
    const synth = generateSyntheticData(DAYS);
    return synth;
  }
}

// ════════════════════════════════════════════════════════════
// INLINE BRAIN (simplified analyzeV2)
// ════════════════════════════════════════════════════════════

function calcEMA(closes: number[], period: number): number[] {
  const r: number[] = [];
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period && i < closes.length; i++) sum += closes[i];
  r[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) r[i] = closes[i] * k + r[i - 1] * (1 - k);
  return r;
}

function calcRSI(closes: number[], period: number): number[] {
  const r: number[] = [];
  if (closes.length < period + 1) return r;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const c = closes[i] - closes[i - 1]; if (c > 0) ag += c; else al += Math.abs(c);
  }
  ag /= period; al /= period;
  r[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const c = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (c > 0 ? c : 0)) / period;
    al = (al * (period - 1) + (c < 0 ? Math.abs(c) : 0)) / period;
    r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}

function calcATRArr(candles: Candle[], period: number): number[] {
  const r: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    r.push(Math.max(candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)));
  }
  const out: number[] = [];
  if (r.length < period) return out;
  let atr = r.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period] = atr;
  for (let i = period; i < r.length; i++) { atr = (atr * (period-1) + r[i]) / period; out[i+1] = atr; }
  return out;
}

function analyzeBrain(c1m: Candle[], c5m: Candle[]): any {
  if (c5m.length < 60) return null;
  const price = c1m[c1m.length - 1]?.close || 0;
  if (!price) return null;

  const closes5m = c5m.map(c => c.close);
  const idx = closes5m.length - 1;
  const ema21 = calcEMA(closes5m, 21); const ema48 = calcEMA(closes5m, 48);
  const rsi5m = calcRSI(closes5m, 14);
  const e21 = ema21[idx] || price; const e48 = ema48[idx] || price;
  const rsi = rsi5m[idx] || 50;

  let score = 0;
  if (e21 > e48) score += 12; else score -= 12;
  const slope21 = idx > 5 && ema21[idx-5] ? (e21 - ema21[idx-5]) / ema21[idx-5] : 0;
  if (slope21 > 0.0005) score += 7; else if (slope21 < -0.0005) score -= 7;

  const pvs21 = ((price - e21) / price) * 100;
  if (pvs21 > 0.15) score += 8; else if (pvs21 < -0.15) score -= 8;

  if (rsi > 55) score += 5; else if (rsi < 45) score -= 5;
  if (rsi > 70) score += 5; if (rsi < 30) score -= 5;

  const recent30 = c5m.slice(-30);
  const swingHighs: number[] = [], swingLows: number[] = [];
  for (let i = 2; i < recent30.length - 2; i++) {
    if (recent30[i].high > recent30[i-1].high && recent30[i].high > recent30[i+1].high) swingHighs.push(recent30[i].high);
    if (recent30[i].low < recent30[i-1].low && recent30[i].low < recent30[i+1].low) swingLows.push(recent30[i].low);
  }
  const hh = swingHighs.length >= 2 && swingHighs[swingHighs.length-1] > swingHighs[swingHighs.length-2];
  const ll = swingLows.length >= 2 && swingLows[swingLows.length-1] < swingLows[swingLows.length-2];
  if (hh) score += 12; if (ll) score -= 12;

  const m1h = c1m.length >= 60 ? ((price - c1m[c1m.length-60].close) / c1m[c1m.length-60].close) * 100 : 0;
  const m4h = c1m.length >= 240 ? ((price - c1m[c1m.length-240].close) / c1m[c1m.length-240].close) * 100 : 0;
  if (m1h > 0.5) score += 5; else if (m1h < -0.5) score -= 5;
  if (m4h > 1.5) score += 8; else if (m4h < -1.5) score -= 8;

  const abs = Math.abs(score);
  let regime = 'CHOP', allowedSides = 'NONE', bias = 'NEUTRAL', levMult = 0.5;
  if (abs >= 40) { regime = score > 0 ? 'UPTREND' : 'DOWNTREND'; allowedSides = score > 0 ? 'LONG_ONLY' : 'SHORT_ONLY'; bias = score > 0 ? 'LONG' : 'SHORT'; levMult = 1.2; }
  else if (abs >= 20) { regime = score > 0 ? 'UPTREND' : 'DOWNTREND'; allowedSides = 'BOTH'; bias = score > 0 ? 'LONG' : 'SHORT'; levMult = 1.0; }
  else if (abs >= 10) { regime = 'TRANSITION'; allowedSides = 'BOTH'; bias = 'NEUTRAL'; levMult = 0.7; }

  let specialEvent = 'NONE', posMult = 1.0;
  const consecGreen = countConsec(c5m, 'green');
  const consecRed = countConsec(c5m, 'red');

  let mfi = 50;
  if (c5m.length > 15) {
    let pos = 0, neg = 0;
    for (let i = c5m.length - 14; i < c5m.length; i++) {
      const tp = (c5m[i].high + c5m[i].low + c5m[i].close) / 3;
      const ptp = (c5m[i-1].high + c5m[i-1].low + c5m[i-1].close) / 3;
      const mf = tp * c5m[i].volume;
      if (tp > ptp) pos += mf; else neg += mf;
    }
    mfi = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }

  if (rsi < 22 && mfi < 20 && consecRed >= 4) { specialEvent = 'CAPITULATION'; allowedSides = 'LONG_ONLY'; bias = 'LONG'; }
  if (rsi > 78 && mfi > 80 && consecGreen >= 4) { specialEvent = 'EUPHORIA'; allowedSides = 'SHORT_ONLY'; bias = 'SHORT'; }

  const recent20 = c5m.slice(-20);
  const hi20 = Math.max(...recent20.map(c => c.high));
  const lo20 = Math.min(...recent20.map(c => c.low));
  const distHi = ((price - hi20) / price) * 100;
  const distLo = ((price - lo20) / price) * 100;
  const vol10 = c5m.slice(-10).reduce((s, c) => s + c.volume, 0) / 10;
  const vol20 = c5m.slice(-20, -10).reduce((s, c) => s + c.volume, 0) / 10;
  const volTrend = vol20 === 0 ? 'FLAT' : vol10 / vol20 > 1.3 ? 'RISING' : vol10 / vol20 < 0.7 ? 'FALLING' : 'FLAT';

  if (distHi > -0.05 && volTrend === 'RISING' && m1h > 0.5) specialEvent = 'BREAKOUT';

  const levels = detectLevels(c5m);
  const supports = levels.filter((l: any) => l.type === 'SUPPORT' && l.price < price);
  const resistances = levels.filter((l: any) => l.type === 'RESISTANCE' && l.price > price);
  const nearSup = supports.length ? Math.max(...supports.map((l: any) => l.price)) : null;
  const nearRes = resistances.length ? Math.min(...resistances.map((l: any) => l.price)) : null;

  let breakoutLevel: number | null = null;
  let breakoutBarsAgo = 0;
  for (const lv of levels) {
    if (lv.strength < 40) continue;
    const r10 = c5m.slice(-10);
    if (lv.type === 'RESISTANCE') {
      const wasBelow = r10.slice(0, -3).some((c: Candle) => c.close < lv.price);
      const isAbove = r10.slice(-3).every((c: Candle) => c.close > lv.price);
      if (wasBelow && isAbove) { breakoutLevel = lv.price; breakoutBarsAgo = 1; break; }
    }
    if (lv.type === 'SUPPORT') {
      const wasAbove = r10.slice(0, -3).some((c: Candle) => c.close > lv.price);
      const isBelow = r10.slice(-3).every((c: Candle) => c.close < lv.price);
      if (wasAbove && isBelow) { breakoutLevel = lv.price; breakoutBarsAgo = 1; break; }
    }
  }

  return {
    regime, specialEvent, confidence: Math.min(100, abs * 1.5),
    allowedSides, bias, leverageMultiplier: levMult,
    positionSizeMultiplier: posMult, reasons: [], timestamp: Date.now(),
    metrics: { rsi_5m: rsi, bb_width_5m: 0, atr_pct: 0, volume_trend: volTrend },
    structureLevels: levels, nearestSupport: nearSup, nearestResistance: nearRes,
    divergence: { type: 'NONE', strength: 0 }, exhaustionScore: 0,
    recentBreakoutLevel: breakoutLevel, recentBreakoutBarsAgo: breakoutBarsAgo,
  };
}

function countConsec(c5m: Candle[], type: string): number {
  let count = 0;
  for (let i = c5m.length - 1; i >= Math.max(0, c5m.length - 10); i--) {
    const isGreen = c5m[i].close > c5m[i].open;
    if (type === 'green' && isGreen) count++;
    else if (type === 'red' && !isGreen) count++;
    else break;
  }
  return count;
}

function detectLevels(c5m: Candle[]): any[] {
  const levels: any[] = [];
  const lookback = Math.min(c5m.length, 200);
  const recent = c5m.slice(-lookback);
  const tol = 0.002;
  for (let i = 5; i < recent.length - 5; i++) {
    const c = recent[i];
    const isHigh = recent.slice(i-5, i).every(x => x.high <= c.high) && recent.slice(i+1, i+6).every(x => x.high <= c.high);
    const isLow = recent.slice(i-5, i).every(x => x.low >= c.low) && recent.slice(i+1, i+6).every(x => x.low >= c.low);
    if (isHigh) {
      const ex = levels.find((l: any) => l.type === 'RESISTANCE' && Math.abs(l.price - c.high) / c.high < tol);
      if (ex) { ex.touches++; ex.price = (ex.price + c.high) / 2; ex.strength = Math.min(100, ex.touches * 25); }
      else levels.push({ price: c.high, type: 'RESISTANCE', touches: 1, strength: 20 });
    }
    if (isLow) {
      const ex = levels.find((l: any) => l.type === 'SUPPORT' && Math.abs(l.price - c.low) / c.low < tol);
      if (ex) { ex.touches++; ex.price = (ex.price + c.low) / 2; ex.strength = Math.min(100, ex.touches * 25); }
      else levels.push({ price: c.low, type: 'SUPPORT', touches: 1, strength: 20 });
    }
  }
  return levels.filter(l => l.strength >= 20).sort((a, b) => b.strength - a.strength).slice(0, 10);
}

// ── StructureScanner inline ──

function analyzeMacro(c5m: any[]): MacroState {
  if (c5m.length < 1200) return { trend: 'NEUTRAL', score: 0, allowLongs: true, allowShorts: true, marginMultiplier: 0.5, cooldownMultiplier: 2.0 };

  const price = c5m[c5m.length - 1].close;
  const c1h: { close: number }[] = [];
  for (let i = 0; i + 12 <= c5m.length; i += 12) {
    c1h.push({ close: c5m[i + 11].close });
  }
  const c4h: { close: number }[] = [];
  for (let i = 0; i + 4 <= c1h.length; i += 4) {
    c4h.push({ close: c1h[i + 3].close });
  }

  let score = 0;

  if (c1h.length >= 210) {
    const cl = c1h.map(c => c.close);
    const e50 = calcEMA(cl, 50);
    const e200 = calcEMA(cl, 200);
    const v50 = e50[e50.length - 1] || price;
    const v200 = e200[e200.length - 1] || price;
    const pvs200 = ((price - v200) / v200) * 100;
    const e50vs200 = ((v50 - v200) / v200) * 100;

    if (pvs200 > 1.5) score += 15;
    else if (pvs200 > 0.3) score += 8;
    else if (pvs200 < -1.5) score -= 15;
    else if (pvs200 < -0.3) score -= 8;

    if (e50vs200 > 0.5) score += 12;
    else if (e50vs200 < -0.5) score -= 12;

    const slope = e50.length > 5 ? (v50 - (e50[e50.length - 6] || v50)) / v50 : 0;
    if (slope > 0.001) score += 8;
    else if (slope < -0.001) score -= 8;
  }

  if (c4h.length >= 55) {
    const cl = c4h.map(c => c.close);
    const e21 = calcEMA(cl, 21);
    const e50 = calcEMA(cl, 50);
    const v21 = e21[e21.length - 1] || price;
    const v50 = e50[e50.length - 1] || price;
    const diff = ((v21 - v50) / v50) * 100;
    const pvs = ((price - v50) / v50) * 100;

    if (diff > 0.8) score += 12;
    else if (diff < -0.8) score -= 12;

    if (pvs > 2.0) score += 10;
    else if (pvs < -2.0) score -= 10;
  }

  const abs = Math.abs(score);
  if (abs >= 50) {
    return score > 0
      ? { trend: 'STRONG_BULL', score, allowLongs: true, allowShorts: false, marginMultiplier: 1.0, cooldownMultiplier: 0.8 }
      : { trend: 'STRONG_BEAR', score, allowLongs: false, allowShorts: true, marginMultiplier: 1.0, cooldownMultiplier: 0.8 };
  } else if (abs >= 25) {
    return score > 0
      ? { trend: 'BULL', score, allowLongs: true, allowShorts: true, marginMultiplier: 0.8, cooldownMultiplier: 1.0 }
      : { trend: 'BEAR', score, allowLongs: true, allowShorts: true, marginMultiplier: 0.8, cooldownMultiplier: 1.0 };
  }
  return { trend: 'NEUTRAL', score, allowLongs: true, allowShorts: true, marginMultiplier: 0.5, cooldownMultiplier: 2.0 };
}

function scanStructure(c1m: Candle[], c5m: Candle[]): any {
  if (c5m.length < 50) return null;
  const cur = c5m[c5m.length - 1];
  const closes = c5m.map(c => c.close);
  const ema21 = calcEMA(closes, 21); const ema48 = calcEMA(closes, 48);
  const rsi = calcRSI(closes, 14);
  const e21 = ema21[ema21.length-1] || cur.close;
  const e48 = ema48[ema48.length-1] || cur.close;
  const rsiLast = rsi[rsi.length-1] || 50;
  const vols = c5m.slice(-20).map(c => c.volume);
  const avgVol = vols.reduce((s, v) => s + v, 0) / vols.length;
  const volRatio = avgVol > 0 ? cur.volume / avgVol : 1;

  const levels = detectLevels(c5m);
  const sups = levels.filter((l: any) => l.type === 'SUPPORT' && l.price < cur.close);
  const ress = levels.filter((l: any) => l.type === 'RESISTANCE' && l.price > cur.close);
  const nearSup = sups.length ? sups.reduce((a: any, b: any) => a.price > b.price ? a : b) : null;
  const nearRes = ress.length ? ress.reduce((a: any, b: any) => a.price < b.price ? a : b) : null;

  let breakout = { level: 0, direction: 'NONE', barsAgo: 0, confirmed: false };
  for (const lv of levels) {
    if (lv.strength < 40) continue;
    const r10 = c5m.slice(-10);
    if (lv.type === 'RESISTANCE') {
      if (r10.slice(0, -3).some(c => c.close < lv.price) && r10.slice(-3).every(c => c.close > lv.price)) {
        breakout = { level: lv.price, direction: 'UP', barsAgo: 1, confirmed: cur.volume > avgVol * 1.5 };
        break;
      }
    }
    if (lv.type === 'SUPPORT') {
      if (r10.slice(0, -3).some(c => c.close > lv.price) && r10.slice(-3).every(c => c.close < lv.price)) {
        breakout = { level: lv.price, direction: 'DOWN', barsAgo: 1, confirmed: cur.volume > avgVol * 1.5 };
        break;
      }
    }
  }

  const body = Math.abs(cur.close - cur.open);
  const upWick = cur.high - Math.max(cur.close, cur.open);
  const loWick = Math.min(cur.close, cur.open) - cur.low;
  const bodyMin = Math.max(body, 0.01);

  const atrArr = calcATRArr(c5m, 14);
  const atrVal = atrArr[atrArr.length - 1] || 0;
  const atrPct = cur.close > 0 ? (atrVal / cur.close) * 100 : 0;

  const emaAlignment = e21 > e48 * 1.001 ? 'BULLISH' : e21 < e48 * 0.999 ? 'BEARISH' : 'FLAT';
  const vol10 = c5m.slice(-10).reduce((s, c) => s + c.volume, 0) / 10;
  const vol20p = c5m.slice(-20, -10).reduce((s, c) => s + c.volume, 0) / 10;
  const volTrend = vol20p === 0 ? 'FLAT' : vol10 / vol20p > 1.3 ? 'RISING' : vol10 / vol20p < 0.7 ? 'FALLING' : 'FLAT';

  return {
    levels, nearestSupport: nearSup?.price ?? null, nearestResistance: nearRes?.price ?? null,
    priceDistToSupport: nearSup ? ((cur.close - nearSup.price) / cur.close) * 100 : 99,
    priceDistToResistance: nearRes ? ((nearRes.price - cur.close) / cur.close) * 100 : 99,
    recentBreakout: breakout,
    divergence: { type: 'NONE', strength: 0 }, exhaustionScore: 0,
    lastCandle: {
      isRejection: upWick > body * 2 || loWick > body * 2,
      rejectionSide: upWick > body * 2 ? 'UPPER' : loWick > body * 2 ? 'LOWER' : 'NONE',
      isBullish: cur.close > cur.open, bodySize: body,
      upperWickRatio: upWick / bodyMin, lowerWickRatio: loWick / bodyMin,
    },
    volumeRatio: volRatio, volumeTrend: volTrend,
    context: {
      emaAlignment, ema21Slope: e21 > 0 ? (e21 - (ema21[ema21.length-2] || e21)) / e21 : 0,
      rsi5m: rsiLast, atrPct, trendHint: e21 > e48 ? 'UP' : e21 < e48 ? 'DOWN' : 'NONE',
      confidence: 50,
    },
    currentPrice: cur.close, timestamp: 0,
  };
}

// ════════════════════════════════════════════════════════════
// CONFIG (v5.0 values)
// ════════════════════════════════════════════════════════════

const cfg: BtConfig = {
  STARTING_CAPITAL: CAPITAL,
  MIN_CONFIDENCE_SCALP: 65, EMA_FAST: 8, EMA_MID: 21, EMA_SLOW: 48,
  SCALP_MIN_BB_WIDTH: 0.30, SCALP_SL_ATR_MULT: 2.0, SCALP_TP_ATR_MULT: 4.0,
  SCALP_MARGIN_PCT: 3, SCALP_DEFAULT_LEVERAGE: 12, SCALP_COOLDOWN_MS: 420_000,
  SCALP_MAX_PER_HOUR: 8, VOLUME_MULT: 1.5, MIN_SIGNALS_REQUIRED: 5,
  TRAILING_ACTIVATION_PCT: 1.5, TRAILING_CALLBACK_PCT: 0.5,
  MIN_CONFIDENCE_SWING: Number(process.env.MIN_CONFIDENCE_SWING ?? 75),
  SWING_MARGIN_FIXED: Number(process.env.SWING_MARGIN ?? 150),
  SWING_LEVERAGE_MIN: 5,
  SWING_LEVERAGE_MAX: Number(process.env.SWING_LEVERAGE ?? 6),
  SWING_COOLDOWN_MS: Number(process.env.SWING_COOLDOWN ?? 3_600_000),
  SWING_TRAILING_ACTIVATION: 1.2, SWING_TRAILING_CALLBACK: 1.0, SWING_MAX_CONCURRENT: 2,
  SWING_SL_ATR_MULT: Number(process.env.SWING_SL_ATR_MULT ?? 2.0),
  SWING_TP_RR_RATIO: Number(process.env.SWING_TP_RR ?? 2.0),
  SWING_TP_MAX_PCT: Number(process.env.SWING_TP_MAX_PCT ?? 0.015),
  SWING_SL_MIN_PCT: Number(process.env.SWING_SL_MIN_PCT ?? 0.0015),
  BREAKOUT_RETEST_MARGIN: 250, BREAKOUT_RETEST_DEFAULT_LEVERAGE: 8,
  BREAKOUT_RETEST_MAX_LEVERAGE: 12, BREAKOUT_RETEST_SL_ATR_MULT: 1.5,
  BREAKOUT_RETEST_TP_ATR_MULT: 5.0, BREAKOUT_RETEST_COOLDOWN_MS: 600_000,
  BREAKOUT_RETEST_MAX_PER_HOUR: 4, BREAKOUT_RETEST_MIN_BARS_SINCE_BREAKOUT: 3,
  BREAKOUT_RETEST_MAX_BARS_SINCE_BREAKOUT: 30, BREAKOUT_RETEST_RETEST_ZONE_PCT: 0.003,
  BREAKOUT_RETEST_TRAILING_ACTIVATION: 2.0, BREAKOUT_RETEST_TRAILING_CALLBACK: 0.6,
  TREND_FOLLOW_MARGIN: 120, TREND_FOLLOW_DEFAULT_LEVERAGE: 7,
  TREND_FOLLOW_MAX_LEVERAGE: 8, TREND_FOLLOW_MIN_CONFIDENCE: 65,
  TREND_FOLLOW_SL_ATR_MULT: 1.5, TREND_FOLLOW_COOLDOWN_MS: 600_000,
  TREND_FOLLOW_MAX_PER_HOUR: 4,
  TREND_FOLLOW_TRAILING_ACTIVATION: 1.5, TREND_FOLLOW_TRAILING_CALLBACK: 1.0,
  LEVEL_BOUNCE_MARGIN_ALIGNED: 100, LEVEL_BOUNCE_MARGIN_COUNTER: 60,
  LEVEL_BOUNCE_LEVERAGE_ALIGNED: 8, LEVEL_BOUNCE_LEVERAGE_COUNTER: 5,
  LEVEL_BOUNCE_MIN_LEVEL_STRENGTH: 40, LEVEL_BOUNCE_MAX_DIST_PCT: 0.3,
  LEVEL_BOUNCE_COOLDOWN_MS: 900_000, LEVEL_BOUNCE_MAX_PER_HOUR: 3,
  LEVEL_BOUNCE_TRAILING_ACTIVATION: 1.5, LEVEL_BOUNCE_TRAILING_CALLBACK: 1.0,
  BREAKOUT_PLAY_RETEST_MARGIN_ALIGNED: 120, BREAKOUT_PLAY_RETEST_MARGIN_COUNTER: 80,
  BREAKOUT_PLAY_CONTINUATION_MARGIN: 100, BREAKOUT_PLAY_LEVERAGE: 8,
  BREAKOUT_PLAY_CONT_LEVERAGE: 6, BREAKOUT_PLAY_RETEST_ZONE_PCT: 0.003,
  BREAKOUT_PLAY_MIN_BARS: 3, BREAKOUT_PLAY_MAX_BARS: 25,
  BREAKOUT_PLAY_CONT_MIN_VOL: 1.5, BREAKOUT_PLAY_COOLDOWN_MS: 900_000,
  BREAKOUT_PLAY_MAX_PER_HOUR: 3,
  BREAKOUT_PLAY_TRAILING_ACTIVATION: 2.0, BREAKOUT_PLAY_TRAILING_CALLBACK: 1.0,
  TREND_RIDER_MARGIN: Number(process.env.TR_MARGIN ?? 80),
  TREND_RIDER_LEVERAGE: Number(process.env.TR_LEVERAGE ?? 6),
  TREND_RIDER_SL_ATR_MULT: Number(process.env.TR_SL_MULT ?? 2.0),
  TREND_RIDER_TP_RR_RATIO: Number(process.env.TR_TP_RR ?? 2.0),
  TREND_RIDER_MAX_EXHAUSTION: 50,
  TREND_RIDER_COOLDOWN_MS: Number(process.env.TR_COOLDOWN ?? 3_600_000),
  TREND_RIDER_MAX_PER_HOUR: 2,
  TREND_RIDER_TRAILING_ACTIVATION: 2.5, TREND_RIDER_TRAILING_CALLBACK: 1.5,
  TREND_RIDER_MIN_CONFIDENCE: Number(process.env.TR_MIN_CONF ?? 80),
  MAX_TOTAL_POSITIONS: Number(process.env.MAX_POSITIONS ?? 2),
  MAX_TOTAL_EXPOSURE_PCT: 30,
  MAX_TRADES_PER_DAY: Number(process.env.MAX_TRADES_DAY ?? 6),
};

// ════════════════════════════════════════════════════════════
// MAIN LOOP
// ════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  🔬 SUR PROTOCOL BACKTESTER v1.0 (🧠 Brain v2.1 — ADVISOR MODE)`);
  console.log(`  ${SUR_MARKET} (${SYMBOL}) | ${DAYS} days | $${CAPITAL} capital`);
  console.log(`  Fee: 0.06% taker | Data: Binance Futures`);
  console.log(`${'═'.repeat(60)}\n`);

  const { c1m, c5m } = await loadData();
  console.log(`📊 ${c1m.length} x 1m, ${c5m.length} x 5m candles loaded\n`);

  const exec = new SimExecutor(CAPITAL);
  const brain = new AdaptiveBrain(process.env.BRAIN_MEMORY_PATH ?? './reports/brain-memory.json');
  const positionSnapshots = new Map<string, { snapshot: MarketSnapshot; margin: number }>();
  // v2.1 FIX: --fresh flag controls reset. Without it, brain accumulates between runs
  const FRESH_BRAIN = getArg('fresh', 'true') === 'true';
  if (FRESH_BRAIN) {
    brain.reset();
    console.log('  🧠 Brain: FRESH (reset). Use --fresh=false to keep memory between runs');
  } else {
    console.log(`  🧠 Brain: LOADED (${brain.getTotalTrades()} trades in memory)`);
  }
  const cooldowns = new Map<string, number>();
  const isCD = (e: string, t: number) => (cooldowns.get(e) || 0) > t;
  const setCD = (e: string, t: number, ms: number) => cooldowns.set(e, t + ms);

  const cb = new SimpleCircuitBreaker(cfg.MAX_TRADES_PER_DAY ?? 6);
  const ag = new AdaptiveGate();
  let macroState: MacroState = { trend: 'NEUTRAL', score: 0, allowLongs: true, allowShorts: true, marginMultiplier: 0.5, cooldownMultiplier: 2.0 };
  let lastMacroUpdate = 0;

  // Build 5m time index
  const idx5m = new Map<number, number>();
  c5m.forEach((c, i) => idx5m.set(c.openTime, i));

  let lastBrainIdx = 0;
  let lastBrainState: any = null;
  let lastSwingTime = 0;
  const WARMUP = 300;
  const total = c1m.length - WARMUP;
  let lastPct = 0;

  // v7.2: Track daily returns for Sharpe computation
  const dailyReturns: number[] = [];
  let dayStartCapital = CAPITAL;
  let currentDayStart = 0;

  console.log(`🚀 Running backtest on ${total} candles...\n`);

  for (let i = WARMUP; i < c1m.length; i++) {
    const candle = c1m[i];
    const price = candle.close;
    const time = candle.closeTime;
    brain.updateDayTracking(time); // v2: passes candle timestamp

    // v7.2: Daily return tracking for Sharpe
    const dayStart = Math.floor(time / 86_400_000) * 86_400_000;
    if (dayStart > currentDayStart && currentDayStart > 0) {
      const cap = exec.getCapital();
      const dayReturn = dayStartCapital > 0 ? (cap - dayStartCapital) / dayStartCapital : 0;
      dailyReturns.push(dayReturn);
      dayStartCapital = cap;
      currentDayStart = dayStart;
    }
    if (currentDayStart === 0) { currentDayStart = dayStart; dayStartCapital = exec.getCapital(); }

    // Progress
    const pct = Math.floor(((i - WARMUP) / total) * 100);
    if (pct >= lastPct + 10) {
      const rs = brain.getRollingSharpe();
      process.stdout.write(`  ${pct}% | ${exec.getTrades().length} trades | Capital: $${exec.getCapital().toFixed(2)} | Rolling SR: ${rs.toFixed(2)}\n`);
      brain.saveMemory(); // checkpoint save — protects against crash mid-run
      lastPct = pct;
    }

    // 1. Update positions
    const toClose = exec.updatePositions(price, time);
    for (const pt of exec.drainPartialTrades()) {
      cb.recordTrade(pt.engine, pt.netPnl, pt.closeReason, time);
      ag.recordResult(pt.netPnl > 0);
    }
    for (const { pos, reason } of toClose) {
      const trade = exec.close(pos, price, reason, time);
      cb.recordTrade(trade.engine, trade.netPnl, reason, time);
      ag.recordResult(trade.netPnl > 0);
      // 🧠 BRAIN v2.1: Learn with candle timestamp and margin
      const stored = positionSnapshots.get(pos.id);
      if (stored) {
        brain.learn({
          snapshot: stored.snapshot,
          trade: {
            id: trade.id, netPnl: trade.netPnl,
            holdTimeMin: trade.holdTimeMin, exitReason: reason,
            margin: stored.margin,
          },
          timestamp: time, // v2: candle timestamp, NOT Date.now()
        });
        positionSnapshots.delete(pos.id);
      }
    }

    // 2. Get 5m window
    const fiveMinBoundary = Math.floor(candle.openTime / 300_000) * 300_000;
    const fi = idx5m.get(fiveMinBoundary);
    const avail5m = fi !== undefined ? c5m.slice(0, fi + 1) : [];
    const avail1m = c1m.slice(0, i + 1);
    if (avail5m.length < 60) continue;

    // 2.5 Update macro filter
    if (i - lastMacroUpdate >= 60 && avail5m.length >= 1200) {
      macroState = analyzeMacro(avail5m);
      lastMacroUpdate = i;
      if (i % 500 === 0) {
        console.log(`  [${new Date(time).toISOString().slice(0,16)}] MACRO: ${macroState.trend} | Score: ${macroState.score} | Longs: ${macroState.allowLongs ? '✅' : '❌'} | Shorts: ${macroState.allowShorts ? '✅' : '❌'}`);
      }
    }

    // 3. Brain state (every 15 1m candles)
    if (i - lastBrainIdx >= 15) {
      lastBrainIdx = i;
      lastBrainState = analyzeBrain(avail1m, avail5m);

      if (i % 500 === 0 && lastBrainState) {
        const s = lastBrainState;
        console.log(`  [${new Date(time).toISOString().slice(0,16)}] Brain: ${s.regime} | Conf: ${s.confidence.toFixed(0)} | Bias: ${s.bias} | Event: ${s.specialEvent} | Price: $${price.toFixed(0)}`);
      }
    }
    if (!lastBrainState) continue;

    // 4. Position limit
    if (exec.getOpenPositions().length >= cfg.MAX_TOTAL_POSITIONS) continue;

    // 5. Toxic hours
    const hr = new Date(time).getUTCHours();
    const toxic = hr === 8 || hr === 9;

    // 6. Evaluate engines
    const sigs: (EngineSignal | null)[] = [];

    if (!isCD('BREAKOUT_RETEST', time) && exec.getOpenByEngine('BREAKOUT_RETEST').length < 1 && cb.canTrade('BREAKOUT_RETEST', time)) {
      const s = evaluateBreakoutRetest(lastBrainState, price, avail5m, cfg);
      if (s && (s.side === 'LONG' ? macroState.allowLongs : macroState.allowShorts)) {
        s.margin *= macroState.marginMultiplier;
        sigs.push(s); setCD('BREAKOUT_RETEST', time, cfg.BREAKOUT_RETEST_COOLDOWN_MS * macroState.cooldownMultiplier);
      }
    }

    if (!isCD('SWING', time) && exec.getOpenByEngine('SWING').length < cfg.SWING_MAX_CONCURRENT && cb.canTrade('SWING', time)) {
      if (time - lastSwingTime >= cfg.SWING_COOLDOWN_MS * macroState.cooldownMultiplier) {
        const s = evaluateSwing(lastBrainState, price, avail5m, cfg);
        if (s && (s.side === 'LONG' ? macroState.allowLongs : macroState.allowShorts)) {
          s.margin *= macroState.marginMultiplier;
          sigs.push(s); setCD('SWING', time, cfg.SWING_COOLDOWN_MS * macroState.cooldownMultiplier); lastSwingTime = time;
        }
      }
    }

    // TREND_FOLLOW, SCALP disabled (PF < 1)

    if (avail5m.length >= 50) {
      const ss = scanStructure(avail1m, avail5m);
      if (ss) {
        // BREAKOUT_PLAY, LEVEL_BOUNCE disabled (PF < 1)
        if (!isCD('TREND_RIDER', time) && exec.getOpenByEngine('TREND_RIDER').length < 1 && cb.canTrade('TREND_RIDER', time)
            && lastBrainState.confidence >= (cfg.TREND_RIDER_MIN_CONFIDENCE ?? 80)
            && Math.abs(macroState.score) >= 35) {
          const s = evaluateTrendRider(ss, cfg);
          if (s && (s.side === 'LONG' ? macroState.allowLongs : macroState.allowShorts)) {
            s.margin *= macroState.marginMultiplier;
            sigs.push(s); setCD('TREND_RIDER', time, cfg.TREND_RIDER_COOLDOWN_MS * macroState.cooldownMultiplier);
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════
    // 7. EXECUTE — v7.3: Brain v2.1 ADVISOR (never blocks, only sizes)
    // ═══════════════════════════════════════════════════════
    let ssForBrain: any = null;
    if (avail5m.length >= 50) { ssForBrain = scanStructure(avail1m, avail5m); }

    for (const sig of sigs) {
      if (!sig) continue;
      if (exec.getOpenPositions().length >= cfg.MAX_TOTAL_POSITIONS) break;

      // 🧠 BRAIN v2.1: Extract snapshot and evaluate quality
      const snapshot = brain.extractSnapshot({
        price: sig.price, c5m: avail5m, c1m: avail1m,
        brainState: lastBrainState, macroState, signal: sig, structState: ssForBrain,
      });
      const decision = brain.evaluate(snapshot);

      // v2.1: Brain NEVER blocks — shouldTrade is always true
      // It only adjusts marginMultiplier (0.4x to 1.8x)

      // 🧠 BRAIN v2.1: Portfolio sizing (never blocks, only reduces size)
      const openPosInfo = exec.getOpenPositions().map(p => ({
        side: p.side, engine: p.engine, margin: p.margin, leverage: p.leverage,
      }));
      const portGate = brain.evaluatePortfolioImpact(snapshot, openPosInfo, exec.getCapital());

      // 🧠 BRAIN v2.1: Kelly-based margin + portfolio size adjustment
      const adjMargin = sig.margin * decision.marginMultiplier * portGate.sizeMult;
      const riskDist = Math.abs(sig.price - sig.sl);
      const adjSL = sig.side === 'LONG'
        ? sig.price - riskDist * decision.slMultiplier
        : sig.price + riskDist * decision.slMultiplier;
      const tpDist = sig.tp > 0 ? Math.abs(sig.tp - sig.price) : 0;
      const adjTP = sig.tp > 0
        ? (sig.side === 'LONG' ? sig.price + tpDist * decision.tpMultiplier
                                : sig.price - tpDist * decision.tpMultiplier)
        : sig.tp;

      const pos = exec.open({
        engine: sig.engine, side: sig.side, price: sig.price,
        leverage: sig.leverage, margin: adjMargin, sl: adjSL, tp: adjTP,
        trailingActivationPct: sig.trailingActivationPct,
        trailingCallbackPct: sig.trailingCallbackPct,
        openTime: time, tags: [...sig.tags, `Q:${decision.qualityScore}`],
        confidence: sig.confidence,
      });
      // 🧠 BRAIN v2.1: Store snapshot AND margin for learning
      if (pos) positionSnapshots.set(pos.id, { snapshot, margin: adjMargin });
    }
  }

  // Close remaining
  const lastP = c1m[c1m.length - 1].close;
  const lastT = c1m[c1m.length - 1].closeTime;
  for (const pos of exec.getOpenPositions()) exec.close(pos, lastP, 'END_OF_BACKTEST', lastT);

  // Final daily return
  const finalCap = exec.getCapital();
  if (dayStartCapital > 0) dailyReturns.push((finalCap - dayStartCapital) / dayStartCapital);

  // ═══════════════════════════════════════════════════════
  // REPORT
  // ═══════════════════════════════════════════════════════
  const pStart = c1m[WARMUP]?.close ?? 0;
  const pEnd = c1m[c1m.length - 1]?.close ?? 0;
  const report = generateReport(exec, CAPITAL, DAYS, SYMBOL, pStart, pEnd);

  // v7.2: Compute annualized Sharpe from daily returns
  let annualizedSharpe = 0;
  let sortinoRatio = 0;
  if (dailyReturns.length >= 3) {
    const mean = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyReturns.length;
    const std = Math.sqrt(variance);
    annualizedSharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

    // Sortino: only downside deviation
    const downside = dailyReturns.filter(r => r < 0);
    if (downside.length > 0) {
      const downsideVar = downside.reduce((s, v) => s + v ** 2, 0) / downside.length;
      const downsideDev = Math.sqrt(downsideVar);
      sortinoRatio = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(252) : 0;
    }
  }

  const sharpeReport = [
    '',
    '═══════════════════════════════════════════',
    '  📈 SUR PROTOCOL — RISK-ADJUSTED METRICS',
    '═══════════════════════════════════════════',
    `  Annualized Sharpe Ratio: ${annualizedSharpe.toFixed(3)}`,
    `  Sortino Ratio: ${sortinoRatio.toFixed(3)}`,
    `  Daily Returns: ${dailyReturns.length} days`,
    `  Avg Daily Return: ${dailyReturns.length > 0 ? (dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length * 100).toFixed(4) : 0}%`,
    `  Daily Return Std: ${dailyReturns.length > 0 ? (Math.sqrt(dailyReturns.reduce((s, v) => s + v ** 2, 0) / dailyReturns.length) * 100).toFixed(4) : 0}%`,
    `  Best Day: ${dailyReturns.length > 0 ? (Math.max(...dailyReturns) * 100).toFixed(2) : 0}%`,
    `  Worst Day: ${dailyReturns.length > 0 ? (Math.min(...dailyReturns) * 100).toFixed(2) : 0}%`,
    '═══════════════════════════════════════════',
  ].join('\n');

  // 🧠 BRAIN v2.1: Generate learned insights
  const brainReport = brain.getInsights();
  const fullReport = report + '\n' + sharpeReport + '\n\n' + brainReport;
  brain.saveMemory();

  // LAB: structured results for lab.ts parser
  const _lt = exec.getTrades();
  const _lw = _lt.filter(t => t.netPnl > 0);
  const _ll = _lt.filter(t => t.netPnl <= 0);
  const _lgp = _lw.reduce((s, t) => s + t.netPnl, 0);
  const _lgl = Math.abs(_ll.reduce((s, t) => s + t.netPnl, 0));
  const _lnet = _lt.reduce((s, t) => s + t.netPnl, 0);
  let _lpeak = CAPITAL, _ldd = 0, _lrun = CAPITAL;
  for (const t of _lt) { _lrun += t.netPnl; if (_lrun > _lpeak) _lpeak = _lrun; const dd = _lpeak - _lrun; if (dd > _ldd) _ldd = dd; }
  process.stdout.write('LAB_RESULTS_JSON: ' + JSON.stringify({
    sharpe: annualizedSharpe, sortino: sortinoRatio,
    netPnl: _lnet, netPnlPct: (_lnet / CAPITAL) * 100,
    totalTrades: _lt.length,
    winRate: _lt.length > 0 ? (_lw.length / _lt.length) * 100 : 0,
    profitFactor: _lgl > 0 ? _lgp / _lgl : 0,
    maxDD: _ldd, maxDDpct: _lpeak > 0 ? (_ldd / _lpeak) * 100 : 0,
    avgWin: _lw.length > 0 ? _lgp / _lw.length : 0,
    avgLoss: _ll.length > 0 ? _lgl / _ll.length : 0,
    capital: finalCap, days: DAYS,
  }) + '\n');

  console.log(fullReport);

  // Save
  mkdirSync('./reports', { recursive: true });
  const fname = `./reports/backtest_${SYMBOL}_${DAYS}d_${new Date().toISOString().split('T')[0]}.txt`;
  writeFileSync(fname, fullReport);
  console.log(`\n💾 Report saved: ${fname}`);

  // Also save trades CSV
  const csv = 'id,engine,side,entry,exit,leverage,margin,pnl,fees,netPnl,holdMin,reason\n' +
    exec.getTrades().map(t =>
      `${t.id},${t.engine},${t.side},${t.entryPrice},${t.exitPrice},${t.leverage},${t.margin.toFixed(2)},${t.pnl.toFixed(2)},${t.fees.toFixed(2)},${t.netPnl.toFixed(2)},${t.holdTimeMin},${t.closeReason}`
    ).join('\n');
  const csvFile = `./reports/trades_${SYMBOL}_${DAYS}d_${new Date().toISOString().split('T')[0]}.csv`;
  writeFileSync(csvFile, csv);
  console.log(`💾 Trades CSV: ${csvFile}\n`);
}

main().catch(e => { console.error('❌ Backtest failed:', e); process.exit(1); });
