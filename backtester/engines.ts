// ============================================================
// backtester/engines.ts — Engine Evaluators for Backtest
// v7.0 — TP-First Exit System
//
// CAMBIOS vs v6.0:
//   - SWING SL: ATR × 2.0 (era 4.88) — configurable via env
//   - SWING TP: basado en R:R ratio puro (era min(R:R×2.5, 2.5%))
//   - Nuevo: TP reachability filter (skip si TP > 1.5% del precio)
//   - Nuevo: SL noise filter (skip si SL < 0.15% del precio)
//   - TREND_RIDER: confidence gate subido a 75 (era 60 implícito)
//   - SWING: confidence gate subido a 75 (era 65)
//   - Trailing params mantenidos por compatibilidad pero no usados como exit primario
// ============================================================

import type { EngineSignal, Side } from './sim-executor';

// Re-export types we need (avoid importing from bot source)
interface Candle {
  openTime: number; open: number; high: number; low: number;
  close: number; volume: number; closeTime: number;
  quoteVolume: number; trades: number;
  takerBuyBaseVol: number; takerBuyQuoteVol: number; isClosed: boolean;
}

interface MarketStateV2 {
  regime: string; specialEvent: string; confidence: number;
  allowedSides: string; bias: string; leverageMultiplier: number;
  positionSizeMultiplier: number; reasons: string[]; timestamp: number;
  metrics: any;
  structureLevels: any[]; nearestSupport: number | null;
  nearestResistance: number | null; divergence: any;
  exhaustionScore: number; recentBreakoutLevel: number | null;
  recentBreakoutBarsAgo: number;
}

interface StructureState {
  levels: any[]; nearestSupport: number | null; nearestResistance: number | null;
  priceDistToSupport: number; priceDistToResistance: number;
  recentBreakout: { level: number; direction: string; barsAgo: number; confirmed: boolean };
  divergence: { type: string; strength: number };
  exhaustionScore: number;
  lastCandle: { isRejection: boolean; rejectionSide: string; isBullish: boolean; bodySize: number; upperWickRatio: number; lowerWickRatio: number };
  volumeRatio: number; volumeTrend: string;
  context: { emaAlignment: string; ema21Slope: number; rsi5m: number; atrPct: number; trendHint: string; confidence: number };
  currentPrice: number; timestamp: number;
}

// ── Indicators (inlined to avoid import issues) ──

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
  const r: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return r;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const c = closes[i] - closes[i - 1];
    if (c > 0) ag += c; else al += Math.abs(c);
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

function calcATR(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trs.push(tr);
  }
  if (trs.length < period) return 0;
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

function calcBB(closes: number[], period: number) {
  if (closes.length < period) return { width: 0, upper: 0, lower: 0, mid: 0 };
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return { width: mean > 0 ? (std * 4 / mean) * 100 : 0, upper: mean + std * 2, lower: mean - std * 2, mid: mean };
}

function calcMFI(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 50;
  let posFlow = 0, negFlow = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const prevTp = (candles[i - 1].high + candles[i - 1].low + candles[i - 1].close) / 3;
    const mf = tp * candles[i].volume;
    if (tp > prevTp) posFlow += mf; else negFlow += mf;
  }
  if (negFlow === 0) return 100;
  return 100 - 100 / (1 + posFlow / negFlow);
}

// ── Config type (subset we need) ──
export type BtConfig = Record<string, any>;

// ════════════════════════════════════════════════════════════
// ENGINE: SWING (v7.0 — TP-First)
// ════════════════════════════════════════════════════════════

export function evaluateSwing(state: MarketStateV2, price: number, c5m: Candle[], cfg: BtConfig): EngineSignal | null {
  // v7.0: Higher confidence threshold — only trade strong signals
  const minConf = cfg.MIN_CONFIDENCE_SWING ?? 75;
  if (state.specialEvent === 'NONE' && state.confidence < minConf) return null;

  // v7.0: Skip CHOP and TRANSITION — only trade clear trends
  if (state.regime === 'CHOP') return null;
  // TRANSITION allowed only for special events
  if (state.regime === 'TRANSITION' && state.specialEvent === 'NONE') return null;

  const atr = calcATR(c5m, 14);
  if (atr === 0) return null;

  // ── MACRO TREND FILTER v5.5 — 1h SMA50 + SMA200 ──────────
  let macroLongBlocked  = false;
  let macroShortBlocked = false;
  const hourlyCl: number[] = [];
  for (let hi = 11; hi < c5m.length; hi += 12) hourlyCl.push(c5m[hi].close);
  if (hourlyCl.length >= 50) {
    const sma50  = hourlyCl.slice(-50).reduce((s, v) => s + v, 0) / 50;
    const sma200 = hourlyCl.length >= 200
      ? hourlyCl.slice(-200).reduce((s, v) => s + v, 0) / 200 : sma50;
    const nearSMA = Math.abs(price - sma50) / sma50 < 0.01;
    if (!nearSMA) {
      if (price < sma50)  macroLongBlocked  = true;
      if (price > sma50)  macroShortBlocked = true;
    }
    if (price < sma200 * 0.98) macroLongBlocked  = true;
    if (price > sma200 * 1.02) macroShortBlocked = true;
  }
  // ─────────────────────────────────────────────────────────

  let side: Side | null = null;
  let sl = 0;
  let leverage = cfg.SWING_LEVERAGE_MIN;

  // ── v7.0: SL/TP config (env-overridable for grid search) ──
  const SL_MULT = cfg.SWING_SL_ATR_MULT ?? 2.0;
  const TP_RR   = cfg.SWING_TP_RR_RATIO ?? 2.0;
  const TP_MAX_PCT = cfg.SWING_TP_MAX_PCT ?? 0.015;  // 1.5% max TP distance
  const SL_MIN_PCT = cfg.SWING_SL_MIN_PCT ?? 0.0015; // 0.15% min SL distance (noise filter)

  if (state.specialEvent === 'CAPITULATION') {
    side = 'LONG';
    // Special events: use structure-based SL (tighter than ATR-based)
    sl = Math.min(...c5m.slice(-20).map(c => c.low)) * 0.998;
  } else if (state.specialEvent === 'EUPHORIA') {
    side = 'SHORT';
    sl = Math.max(...c5m.slice(-20).map(c => c.high)) * 1.002;
  } else if (state.specialEvent === 'BREAKOUT') {
    side = state.bias === 'LONG' ? 'LONG' : 'SHORT';
    sl = side === 'LONG' ? price - atr * SL_MULT : price + atr * SL_MULT;
    leverage = cfg.SWING_LEVERAGE_MIN + 1;
  } else if (state.confidence >= minConf) {
    if (state.bias === 'LONG') { side = 'LONG'; sl = price - atr * SL_MULT; }
    else if (state.bias === 'SHORT') { side = 'SHORT'; sl = price + atr * SL_MULT; }
    leverage = cfg.SWING_LEVERAGE_MAX;
  }

  if (!side) return null;
  if (state.allowedSides === 'LONG_ONLY' && side === 'SHORT') return null;
  if (state.allowedSides === 'SHORT_ONLY' && side === 'LONG') return null;

  // Apply macro filter — CAPITULATION/EUPHORIA bypass
  const isExtremeEvent = state.specialEvent === 'CAPITULATION' || state.specialEvent === 'EUPHORIA';
  if (!isExtremeEvent) {
    if (macroLongBlocked  && side === 'LONG')  return null;
    if (macroShortBlocked && side === 'SHORT') return null;
  }

  // ── v7.0: TP based purely on R:R ratio (no % cap) ──
  const riskDist = Math.abs(price - sl);
  const tp = side === 'LONG'
    ? price + riskDist * TP_RR
    : price - riskDist * TP_RR;

  // ── v7.0: Reachability filter — skip if TP is too far ──
  const tpPct = Math.abs(tp - price) / price;
  if (tpPct > TP_MAX_PCT) return null;  // TP too far = unreachable

  // ── v7.0: Noise filter — skip if SL is too close ──
  const slPct = riskDist / price;
  if (slPct < SL_MIN_PCT) return null;  // SL too close = noise

  return {
    engine: 'SWING', side, price, leverage,
    margin: cfg.SWING_MARGIN_FIXED, sl, tp,
    // Trailing params kept for compatibility — not used as primary exit in v7
    trailingActivationPct: cfg.SWING_TRAILING_ACTIVATION,
    trailingCallbackPct: cfg.SWING_TRAILING_CALLBACK,
    tags: ['SWING', state.specialEvent], confidence: state.confidence,
  };
}

// ════════════════════════════════════════════════════════════
// ENGINE: BREAKOUT_RETEST (v3.0) — unchanged
// ════════════════════════════════════════════════════════════

export function evaluateBreakoutRetest(state: MarketStateV2, price: number, c5m: Candle[], cfg: BtConfig): EngineSignal | null {
  if (!state.recentBreakoutLevel) return null;
  if (state.recentBreakoutBarsAgo < cfg.BREAKOUT_RETEST_MIN_BARS_SINCE_BREAKOUT) return null;
  if (state.recentBreakoutBarsAgo > cfg.BREAKOUT_RETEST_MAX_BARS_SINCE_BREAKOUT) return null;

  const cur = c5m[c5m.length - 1];
  const prev = c5m[c5m.length - 2];
  const level = state.recentBreakoutLevel;
  if (Math.abs(cur.close - level) / level > cfg.BREAKOUT_RETEST_RETEST_ZONE_PCT) return null;

  const above = cur.close > level;
  let side: Side;
  let confirmed = false;

  if (above) {
    side = 'LONG';
    confirmed = (cur.low < level || prev.low < level) && cur.close > level && cur.close > cur.open;
  } else {
    side = 'SHORT';
    confirmed = (cur.high > level || prev.high > level) && cur.close < level && cur.close < cur.open;
  }
  if (!confirmed) return null;

  const avgVol = c5m.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  if (avgVol > 0 && cur.volume < avgVol * 0.5) return null;

  const atrVal = calcATR(c5m, 14);
  if (atrVal === 0) return null;

  const leverage = state.confidence > 60 ? cfg.BREAKOUT_RETEST_MAX_LEVERAGE : cfg.BREAKOUT_RETEST_DEFAULT_LEVERAGE;
  const sl = side === 'LONG' ? level - atrVal * cfg.BREAKOUT_RETEST_SL_ATR_MULT : level + atrVal * cfg.BREAKOUT_RETEST_SL_ATR_MULT;
  const tp = side === 'LONG' ? cur.close + atrVal * cfg.BREAKOUT_RETEST_TP_ATR_MULT : cur.close - atrVal * cfg.BREAKOUT_RETEST_TP_ATR_MULT;

  return {
    engine: 'BREAKOUT_RETEST', side, price: cur.close, leverage,
    margin: cfg.BREAKOUT_RETEST_MARGIN, sl, tp,
    trailingActivationPct: cfg.BREAKOUT_RETEST_TRAILING_ACTIVATION,
    trailingCallbackPct: cfg.BREAKOUT_RETEST_TRAILING_CALLBACK,
    tags: ['BREAKOUT_RETEST'], confidence: state.confidence,
  };
}

// ════════════════════════════════════════════════════════════
// ENGINE: TREND_FOLLOW (v3.1) — unchanged (disabled in run.ts)
// ════════════════════════════════════════════════════════════

export function evaluateTrendFollow(state: MarketStateV2, price: number, c5m: Candle[], cfg: BtConfig): EngineSignal | null {
  if (state.regime !== 'UPTREND' && state.regime !== 'DOWNTREND') return null;
  if (state.confidence < cfg.TREND_FOLLOW_MIN_CONFIDENCE) return null;
  if (c5m.length < 50) return null;

  const cur = c5m[c5m.length - 1];
  const prev = c5m[c5m.length - 2];
  const side: Side = state.regime === 'UPTREND' ? 'LONG' : 'SHORT';

  if (state.allowedSides === 'SHORT_ONLY' && side === 'LONG') return null;
  if (state.allowedSides === 'LONG_ONLY' && side === 'SHORT') return null;

  const closes = c5m.map(c => c.close);
  const ema21 = calcEMA(closes, 21);
  const ema48 = calcEMA(closes, 48);
  const e21 = ema21[ema21.length - 1] ?? cur.close;
  const e48 = ema48[ema48.length - 1] ?? cur.close;

  if (side === 'LONG' && e21 <= e48) return null;
  if (side === 'SHORT' && e21 >= e48) return null;

  let pullbackOk = false;
  if (side === 'LONG') {
    pullbackOk = prev.low <= e21 * 1.003 && cur.close > e21 && cur.close > cur.open;
  } else {
    pullbackOk = prev.high >= e21 * 0.997 && cur.close < e21 && cur.close < cur.open;
  }
  if (!pullbackOk) return null;

  const avgVol = c5m.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  if (avgVol > 0 && cur.volume < avgVol * 0.7) return null;

  const atrVal = calcATR(c5m, 14);
  if (atrVal === 0) return null;

  const leverage = state.confidence > 70 ? (cfg.TREND_FOLLOW_MAX_LEVERAGE || 8) : cfg.TREND_FOLLOW_DEFAULT_LEVERAGE;
  const sl = side === 'LONG' ? cur.close - atrVal * cfg.TREND_FOLLOW_SL_ATR_MULT : cur.close + atrVal * cfg.TREND_FOLLOW_SL_ATR_MULT;

  return {
    engine: 'TREND_FOLLOW', side, price: cur.close, leverage,
    margin: cfg.TREND_FOLLOW_MARGIN, sl, tp: 0,
    trailingActivationPct: cfg.TREND_FOLLOW_TRAILING_ACTIVATION,
    trailingCallbackPct: cfg.TREND_FOLLOW_TRAILING_CALLBACK,
    tags: ['TREND_FOLLOW'], confidence: state.confidence,
  };
}

// ════════════════════════════════════════════════════════════
// ENGINE: SCALP — unchanged (disabled in run.ts)
// ════════════════════════════════════════════════════════════

export function evaluateScalp(state: MarketStateV2, c1m: Candle[], price: number, cfg: BtConfig): EngineSignal | null {
  if (state.confidence < cfg.MIN_CONFIDENCE_SCALP) return null;
  if (state.regime !== 'UPTREND' && state.regime !== 'DOWNTREND') return null;
  if (c1m.length < 60) return null;

  const closes = c1m.map(c => c.close);
  const emaF = calcEMA(closes, cfg.EMA_FAST);
  const emaM = calcEMA(closes, cfg.EMA_MID);
  const emaS = calcEMA(closes, cfg.EMA_SLOW);
  const rsiArr = calcRSI(closes, 14);
  const bb = calcBB(closes, 20);
  const atrVal = calcATR(c1m, 14);
  const mfi = calcMFI(c1m, 14);

  const ef = emaF[emaF.length - 1] ?? price;
  const em = emaM[emaM.length - 1] ?? price;
  const es = emaS[emaS.length - 1] ?? price;
  const rsi = rsiArr[rsiArr.length - 1] ?? 50;
  const prevRsi = rsiArr[rsiArr.length - 2] ?? 50;

  if (bb.width < cfg.SCALP_MIN_BB_WIDTH) return null;
  if ((atrVal / price * 100) > 0.15) return null;
  if (rsi < 25 || rsi > 75) return null;

  let side: Side;
  if (state.regime === 'UPTREND' && state.allowedSides !== 'SHORT_ONLY') side = 'LONG';
  else if (state.regime === 'DOWNTREND' && state.allowedSides !== 'LONG_ONLY') side = 'SHORT';
  else return null;

  const avgVol = c1m.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  const volR = avgVol > 0 ? c1m[c1m.length - 1].volume / avgVol : 1;

  let conds = 0;
  if (side === 'LONG') {
    if (ef > em) conds++;
    if (rsi > 40 && rsi > prevRsi) conds++;
    if (mfi > 50) conds++;
    if (price > es) conds++;
    if (volR >= cfg.VOLUME_MULT) conds++;
  } else {
    if (ef < em) conds++;
    if (rsi < 60 && rsi < prevRsi) conds++;
    if (mfi < 50) conds++;
    if (price < es) conds++;
    if (volR >= cfg.VOLUME_MULT) conds++;
  }
  if (conds < cfg.MIN_SIGNALS_REQUIRED) return null;

  const margin = 2000 * (cfg.SCALP_MARGIN_PCT / 100);
  const sl = side === 'LONG' ? price - atrVal * cfg.SCALP_SL_ATR_MULT : price + atrVal * cfg.SCALP_SL_ATR_MULT;
  const tp = side === 'LONG' ? price + atrVal * cfg.SCALP_TP_ATR_MULT : price - atrVal * cfg.SCALP_TP_ATR_MULT;

  return {
    engine: 'SCALP', side, price, leverage: cfg.SCALP_DEFAULT_LEVERAGE,
    margin, sl, tp,
    trailingActivationPct: cfg.TRAILING_ACTIVATION_PCT,
    trailingCallbackPct: cfg.TRAILING_CALLBACK_PCT,
    tags: ['SCALP'], confidence: state.confidence,
  };
}

// ════════════════════════════════════════════════════════════
// ENGINE: LEVEL_BOUNCE (v4.0) — unchanged (disabled in run.ts)
// ════════════════════════════════════════════════════════════

export function evaluateLevelBounce(ss: StructureState, cfg: BtConfig): EngineSignal | null {
  let target: any = null;
  let side: Side | null = null;

  if (ss.priceDistToSupport < cfg.LEVEL_BOUNCE_MAX_DIST_PCT && ss.nearestSupport) {
    const lvl = ss.levels.find((l: any) => l.price === ss.nearestSupport);
    if (lvl && lvl.strength >= cfg.LEVEL_BOUNCE_MIN_LEVEL_STRENGTH) { target = lvl; side = 'LONG'; }
  }
  if (!side && ss.priceDistToResistance < cfg.LEVEL_BOUNCE_MAX_DIST_PCT && ss.nearestResistance) {
    const lvl = ss.levels.find((l: any) => l.price === ss.nearestResistance);
    if (lvl && lvl.strength >= cfg.LEVEL_BOUNCE_MIN_LEVEL_STRENGTH) { target = lvl; side = 'SHORT'; }
  }
  if (!target || !side) return null;
  if (!ss.lastCandle.isRejection) return null;
  if (side === 'LONG' && ss.lastCandle.rejectionSide !== 'LOWER') return null;
  if (side === 'SHORT' && ss.lastCandle.rejectionSide !== 'UPPER') return null;
  if (side === 'LONG' && !ss.lastCandle.isBullish) return null;
  if (side === 'SHORT' && ss.lastCandle.isBullish) return null;
  if (ss.volumeRatio < 0.6) return null;

  const aligned = (side === 'LONG' && ss.context.emaAlignment === 'BULLISH') ||
                  (side === 'SHORT' && ss.context.emaAlignment === 'BEARISH');
  const margin = aligned ? cfg.LEVEL_BOUNCE_MARGIN_ALIGNED : cfg.LEVEL_BOUNCE_MARGIN_COUNTER;
  const leverage = aligned ? cfg.LEVEL_BOUNCE_LEVERAGE_ALIGNED : cfg.LEVEL_BOUNCE_LEVERAGE_COUNTER;

  const atrVal = ss.context.atrPct * ss.currentPrice / 100;
  const sl = side === 'LONG' ? target.price - atrVal * 0.8 : target.price + atrVal * 0.8;
  const risk = Math.abs(ss.currentPrice - sl);
  const tp = side === 'LONG' ? ss.currentPrice + risk * 2.5 : ss.currentPrice - risk * 2.5;

  return {
    engine: 'LEVEL_BOUNCE', side, price: ss.currentPrice, leverage, margin, sl, tp,
    trailingActivationPct: cfg.LEVEL_BOUNCE_TRAILING_ACTIVATION,
    trailingCallbackPct: cfg.LEVEL_BOUNCE_TRAILING_CALLBACK,
    tags: ['LEVEL_BOUNCE'], confidence: target.strength,
  };
}

// ════════════════════════════════════════════════════════════
// ENGINE: BREAKOUT_PLAY (v4.0) — unchanged (disabled in run.ts)
// ════════════════════════════════════════════════════════════

export function evaluateBreakoutPlay(ss: StructureState, cfg: BtConfig): EngineSignal | null {
  if (ss.recentBreakout.direction === 'NONE') return null;
  const atrVal = ss.context.atrPct * ss.currentPrice / 100;
  if (atrVal === 0) return null;

  // Mode A: Retest
  if (ss.recentBreakout.barsAgo >= cfg.BREAKOUT_PLAY_MIN_BARS &&
      ss.recentBreakout.barsAgo <= cfg.BREAKOUT_PLAY_MAX_BARS) {
    const level = ss.recentBreakout.level;
    const dist = Math.abs(ss.currentPrice - level) / level;
    if (dist < cfg.BREAKOUT_PLAY_RETEST_ZONE_PCT) {
      const above = ss.currentPrice > level;
      const side: Side = above ? 'LONG' : 'SHORT';
      const confirmed = above
        ? (ss.lastCandle.rejectionSide === 'LOWER' && ss.lastCandle.isBullish)
        : (ss.lastCandle.rejectionSide === 'UPPER' && !ss.lastCandle.isBullish);
      if (confirmed && ss.volumeRatio > 0.5) {
        const sl = side === 'LONG' ? level - atrVal : level + atrVal;
        const tp = side === 'LONG' ? ss.currentPrice + atrVal * 6 : ss.currentPrice - atrVal * 6;
        const aligned = (side === 'LONG' && ss.context.trendHint === 'UP') || (side === 'SHORT' && ss.context.trendHint === 'DOWN');
        const margin = aligned ? cfg.BREAKOUT_PLAY_RETEST_MARGIN_ALIGNED : cfg.BREAKOUT_PLAY_RETEST_MARGIN_COUNTER;
        return {
          engine: 'BREAKOUT_PLAY', side, price: ss.currentPrice,
          leverage: cfg.BREAKOUT_PLAY_LEVERAGE, margin, sl, tp,
          trailingActivationPct: cfg.BREAKOUT_PLAY_TRAILING_ACTIVATION,
          trailingCallbackPct: cfg.BREAKOUT_PLAY_TRAILING_CALLBACK,
          tags: ['BREAKOUT_PLAY', 'RETEST'], confidence: 70,
        };
      }
    }
  }

  // Mode B: Continuation
  if (ss.recentBreakout.barsAgo <= 3 && ss.recentBreakout.confirmed &&
      ss.volumeRatio > cfg.BREAKOUT_PLAY_CONT_MIN_VOL) {
    const side: Side = ss.recentBreakout.direction === 'UP' ? 'LONG' : 'SHORT';
    const level = ss.recentBreakout.level;
    const sl = side === 'LONG' ? level - atrVal * 0.5 : level + atrVal * 0.5;
    return {
      engine: 'BREAKOUT_PLAY', side, price: ss.currentPrice,
      leverage: cfg.BREAKOUT_PLAY_CONT_LEVERAGE, margin: cfg.BREAKOUT_PLAY_CONTINUATION_MARGIN,
      sl, tp: 0,
      trailingActivationPct: cfg.BREAKOUT_PLAY_TRAILING_ACTIVATION,
      trailingCallbackPct: cfg.BREAKOUT_PLAY_TRAILING_CALLBACK,
      tags: ['BREAKOUT_PLAY', 'CONTINUATION'], confidence: 65,
    };
  }

  return null;
}

// ════════════════════════════════════════════════════════════
// ENGINE: TREND_RIDER (v7.0 — restricted)
// 
// CAMBIOS v7.0:
//   - Higher confidence gate (75, was implicit ~60)
//   - Uses R:R-based TP (same as SWING)
//   - Reduced margin and leverage in cfg
// ════════════════════════════════════════════════════════════

export function evaluateTrendRider(ss: StructureState, cfg: BtConfig): EngineSignal | null {
  if (ss.context.trendHint === 'NONE') return null;
  if (ss.exhaustionScore > (cfg.TREND_RIDER_MAX_EXHAUSTION || 50)) return null;
  if (ss.context.ema21Slope === 0) return null;

  const side: Side = ss.context.trendHint === 'UP' ? 'LONG' : 'SHORT';

  // Need EMA alignment
  if (side === 'LONG' && ss.context.emaAlignment !== 'BULLISH') return null;
  if (side === 'SHORT' && ss.context.emaAlignment !== 'BEARISH') return null;

  // Need decent RSI
  if (side === 'LONG' && ss.context.rsi5m < 45) return null;
  if (side === 'SHORT' && ss.context.rsi5m > 55) return null;

  // Volume confirmation
  if (ss.volumeRatio < 0.8) return null;

  const atrVal = ss.context.atrPct * ss.currentPrice / 100;
  if (atrVal === 0) return null;

  const slMult = cfg.TREND_RIDER_SL_ATR_MULT ?? 2.0;
  const tpRR = cfg.TREND_RIDER_TP_RR_RATIO ?? 2.0;

  const sl = side === 'LONG'
    ? ss.currentPrice - atrVal * slMult
    : ss.currentPrice + atrVal * slMult;

  // v7.0: TP based on R:R ratio (was tp: 0 = no TP, only trailing)
  const riskDist = Math.abs(ss.currentPrice - sl);
  const tp = side === 'LONG'
    ? ss.currentPrice + riskDist * tpRR
    : ss.currentPrice - riskDist * tpRR;

  // v7.0: Reachability filter
  const tpPct = Math.abs(tp - ss.currentPrice) / ss.currentPrice;
  if (tpPct > 0.015) return null;

  return {
    engine: 'TREND_RIDER', side, price: ss.currentPrice,
    leverage: cfg.TREND_RIDER_LEVERAGE, margin: cfg.TREND_RIDER_MARGIN,
    sl, tp,
    trailingActivationPct: cfg.TREND_RIDER_TRAILING_ACTIVATION,
    trailingCallbackPct: cfg.TREND_RIDER_TRAILING_CALLBACK,
    tags: ['TREND_RIDER'], confidence: 60,
  };
}
