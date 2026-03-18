// src/engines/swing-engine.ts
// SWING Engine v7.0 — Ported from Backtester
// Config ganadora: SL=1%, TP=5%, HTF=on, BULL_SWING_LONG=off
// Backtested: Sharpe=3.38, MaxDD=3.55%, WR=55% (180d bear market)

import type { AsterGateway } from '../gateway/aster-gateway';
import type { PaperExecutor } from '../executors/paper-executor';
import type { Config } from '../config';
import type { Logger } from '../utils/logger';
import type { Candle, Signal } from '../types';
import { CircuitBreaker } from './circuit-breaker';

// ═══════════════════════════════════════════════════════════════
// INLINE HELPERS (no external deps — validated in backtester)
// ═══════════════════════════════════════════════════════════════

function calcEMA(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcRSI(closes: number[], period: number): number[] {
  const rsi: number[] = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return rsi;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcATR(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 0;
  let atr = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    atr += tr;
  }
  return atr / period;
}

function countConsec(candles: Candle[], color: 'green' | 'red'): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const isGreen = candles[i].close > candles[i].open;
    if ((color === 'green') === isGreen) count++;
    else break;
  }
  return count;
}

function findBarsSinceExtreme(rsiArr: number[], side: 'high' | 'low'): number | null {
  const threshold = side === 'high' ? 70 : 30;
  for (let i = rsiArr.length - 1; i >= Math.max(0, rsiArr.length - 10); i--) {
    if (side === 'high' && rsiArr[i] >= threshold) return rsiArr.length - 1 - i;
    if (side === 'low' && rsiArr[i] <= threshold) return rsiArr.length - 1 - i;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface MarketStateV2 {
  regime: string;
  specialEvent: string;
  confidence: number;
  allowedSides: string;
  bias: string;
  timestamp: number;
  leverageMultiplier: number;
  positionSizeMultiplier: number;
  reasons: string[];
  metrics: { score: number; rsi: number; mfi: number; e21: number; e48: number };
  structureLevels: any[];
  nearestSupport: null;
  nearestResistance: null;
  divergence: null;
  exhaustionScore: number;
  recentBreakoutLevel: null;
  recentBreakoutBarsAgo: number;
}

interface SwingSignal {
  engine: 'SWING';
  side: 'LONG' | 'SHORT';
  price: number;
  sl: number;
  tp: number;
  leverage: number;
  margin: number;
  confidence: number;
  specialEvent: string;
  regime: string;
}

interface OpenPosition {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  sl: number;
  tp: number;
  leverage: number;
  margin: number;
  openTime: number;
  positionId: string;
  executorPosition?: any; // full Position object from executor (for live closePosition)
}

// ═══════════════════════════════════════════════════════════════
// SWING ENGINE
// ═══════════════════════════════════════════════════════════════

export class SwingEngine {
  private candles1m: Candle[] = [];
  private candles5m: Candle[] = [];
  private currentPrice = 0;
  private running = false;
  private openPosition: OpenPosition | null = null;
  private lastSignalTime = 0;
  private circuitBreaker: CircuitBreaker;
  private bmsbStatus: 'BULL' | 'BEAR' | 'TRANSITION' | 'UNKNOWN' = 'UNKNOWN';
  private lastStatusLog = 0;
  private dailyPnL = 0;
  private dailyTradeCount = 0;
  private dayStart = 0;

  // Candle buffer limits (prevent memory leak in long runs)
  private readonly MAX_1M_CANDLES = 15_000;  // ~10 days
  private readonly MAX_5M_CANDLES = 5_000;   // ~17 days

  constructor(
    private gateway: AsterGateway,
    private executor: PaperExecutor,
    private config: Config,
    private logger: Logger,
    private symbol: string,
  ) {
    this.circuitBreaker = new CircuitBreaker(config);
    this.dayStart = this.startOfDay();
  }

  // ── PUBLIC API ──

  async warmup(): Promise<void> {
    this.logger.info('[SWING] Starting warmup — loading historical candles...');

    const end = Date.now();
    const start = end - 7 * 86_400_000; // 7 days

    // Fetch 1m candles (7 days ≈ 10,080 candles, need multiple requests)
    this.candles1m = await this.fetchKlines('1m', start, end, 1500);
    this.logger.info(`[SWING] Loaded ${this.candles1m.length} x 1m candles`);

    // Fetch 5m candles (7 days ≈ 2,016 candles)
    this.candles5m = await this.fetchKlines('5m', start, end, 1500);
    this.logger.info(`[SWING] Loaded ${this.candles5m.length} x 5m candles`);

    // BMSB needs ~147 days of 5m data (42,336 candles)
    // With only 7 days loaded, BMSB will be UNKNOWN
    // It activates once we accumulate enough 5m candles in runtime
    this.bmsbStatus = this.calcBMSB(this.candles5m);
    this.logger.info(`[SWING] BMSB: ${this.bmsbStatus}`);

    if (this.bmsbStatus === 'UNKNOWN') {
      this.logger.info(
        '[SWING] BMSB=UNKNOWN (need ~147d of 5m data). ' +
        'BULL_SWING_LONG filter inactive until sufficient history accumulates.'
      );
    }

    this.logger.info('[SWING] Warmup complete. Ready to trade.');
  }

  start(): void {
    this.running = true;

    // Subscribe to gateway messages (same pattern as MomentumScalpEngine)
    this.gateway.onMessage((stream: string, data: any) => {
      if (!this.running) return;
      try {
        if (stream.includes('@kline_1m')) {
          const candle = this.parseKline(data);
          if (candle) {
            if (candle.isClosed) this.onCandle1m(candle);
            else this.currentPrice = candle.close; // live price from open candle
          }
        } else if (stream.includes('@kline_5m')) {
          const candle = this.parseKline(data);
          if (candle?.isClosed) this.onCandle5m(candle);
        } else if (stream.includes('@ticker')) {
          if (data?.c) this.currentPrice = parseFloat(data.c);
        }
      } catch (err) {
        this.logger.error(`[SWING] Event error: ${err}`);
      }
    });

    this.logger.info('[SWING] Engine started — listening for candles');
    this.logger.info(
      `[SWING] Config: SL=${this.config.SWING_SL_PCT}% TP=${this.config.SWING_TP_PCT}% ` +
      `Lev=${this.config.SWING_LEVERAGE}x Margin=$${(this.config as any).SWING_MARGIN_FIXED} ` +
      `Cooldown=${this.config.SWING_COOLDOWN_MS / 60_000}min ` +
      `HTF=${this.config.HTF_FILTER_ENABLED ? 'on' : 'off'} ` +
      `BULL_LONG=${this.config.BULL_SWING_LONG ? 'on' : 'off'}`
    );
  }

  // Parse raw WebSocket kline data into Candle
  private parseKline(data: any): Candle | null {
    const k = data?.k;
    if (!k) return null;
    return {
      openTime: k.t,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
      closeTime: k.T,
      quoteVolume: parseFloat(k.q) || 0,
      trades: k.n || 0,
      takerBuyBaseVol: parseFloat(k.V) || 0,
      takerBuyQuoteVol: parseFloat(k.Q) || 0,
      isClosed: k.x,
    };
  }

  async stop(): Promise<void> {
    this.running = false;

    // Close open position if any
    if (this.openPosition) {
      this.logger.info('[SWING] Stopping — closing open position...');
      await this.closePosition('MANUAL');
    }

    this.gateway.disconnect();

    this.logger.info(
      `[SWING] Engine stopped. Daily PnL: $${this.dailyPnL.toFixed(2)}, ` +
      `Trades today: ${this.dailyTradeCount}`
    );
  }

  // ── EVENT HANDLERS ──

  private onCandle1m(candle: Candle): void {
    if (!this.running) return;

    // Update buffer (with cap)
    this.candles1m.push(candle);
    if (this.candles1m.length > this.MAX_1M_CANDLES) {
      this.candles1m = this.candles1m.slice(-this.MAX_1M_CANDLES);
    }

    this.currentPrice = candle.close;

    // Reset daily counters at midnight UTC
    if (Date.now() - this.dayStart > 86_400_000) {
      this.dailyPnL = 0;
      this.dailyTradeCount = 0;
      this.dayStart = this.startOfDay();
    }

    // CHECK EXITS on every 1m candle (critical for live safety)
    if (this.openPosition) {
      this.checkExits(candle).catch(err =>
        this.logger.error(`[SWING] checkExits error: ${err}`)
      );
    }

    // Status log every 5 minutes
    const now = Date.now();
    if (now - this.lastStatusLog >= 300_000) {
      this.logStatus();
      this.lastStatusLog = now;
    }
  }

  private onCandle5m(candle: Candle): void {
    if (!this.running) return;

    // Update buffer (with cap)
    this.candles5m.push(candle);
    if (this.candles5m.length > this.MAX_5M_CANDLES) {
      this.candles5m = this.candles5m.slice(-this.MAX_5M_CANDLES);
    }

    // Re-check BMSB periodically (every ~1 hour = 12 candles of 5m)
    if (this.candles5m.length % 12 === 0) {
      const newBmsb = this.calcBMSB(this.candles5m);
      if (newBmsb !== this.bmsbStatus) {
        this.logger.info(`[SWING] BMSB changed: ${this.bmsbStatus} → ${newBmsb}`);
        this.bmsbStatus = newBmsb;
      }
    }

    // EVALUATE SIGNAL on every 5m candle close
    // Only if no position is open
    if (!this.openPosition) {
      this.evaluateAndTrade().catch(err =>
        this.logger.error(`[SWING] evaluateAndTrade error: ${err}`)
      );
    }
  }

  // ── CORE LOGIC ──

  private async evaluateAndTrade(): Promise<void> {
    // Guard: enough data?
    if (this.candles5m.length < 60 || this.candles1m.length < 60) return;

    // Guard: circuit breaker
    if (!this.circuitBreaker.canTrade('SWING', Date.now()).allowed) {
      return;
    }

    // Guard: cooldown
    const now = Date.now();
    const cooldown = this.config.SWING_COOLDOWN_MS ?? 7_200_000;
    if (now - this.lastSignalTime < cooldown) return;

    // 1. Analyze market state
    const state = this.analyzeBrain(this.candles1m, this.candles5m);
    if (!state) return;

    // 2. Generate signal
    const signal = this.evaluateSwing(state, this.currentPrice, this.candles5m);
    if (!signal) return;

    // 3. Open trade
    await this.openTrade(signal);
  }

  private async openTrade(signal: SwingSignal): Promise<void> {
    // Map SwingSignal → executor's Signal type
    const execSignal: Signal = {
      side: signal.side,
      price: signal.price,
      stopLoss: signal.sl,
      takeProfit: signal.tp,
      suggestedLeverage: signal.leverage,
      margin: signal.margin,
      engine: 'SWING',
      confidence: signal.confidence,
      indicators: {
        specialEvent: signal.specialEvent,
        regime: signal.regime,
        bmsb: this.bmsbStatus,
      },
    };

    try {
      const capital = this.config.CAPITAL ?? 650;
      const position = await this.executor.openPosition(execSignal, capital, {
        margin: signal.margin,
        leverage: signal.leverage,
        engine: 'SWING',
      } as any);

      if (position) {
        this.openPosition = {
          side: signal.side,
          entryPrice: signal.price,
          sl: signal.sl,
          tp: signal.tp,
          leverage: signal.leverage,
          margin: signal.margin,
          openTime: Date.now(),
          positionId: position.id || (position as any).positionId || `swing_${Date.now()}`,
          executorPosition: position, // store full object for live closePosition
        };

        this.lastSignalTime = Date.now();
        this.dailyTradeCount++;

        this.logger.info(
          `[SWING] 🟢 OPENED ${signal.side} ${this.symbol} @ $${signal.price.toFixed(2)} | ` +
          `margin=$${signal.margin} lev=${signal.leverage}x | ` +
          `SL=$${signal.sl.toFixed(2)} TP=$${signal.tp.toFixed(2)} | ` +
          `${signal.regime} ${signal.specialEvent !== 'NONE' ? signal.specialEvent : ''} ` +
          `conf=${signal.confidence}`
        );
      }
    } catch (err) {
      this.logger.error(`[SWING] Failed to open position: ${err}`);
    }
  }

  private async checkExits(candle: Candle): Promise<void> {
    if (!this.openPosition) return;

    const { sl, tp, side, entryPrice } = this.openPosition;

    // Use candle extremes, not just close — catches intra-candle SL/TP hits
    let slHit = false;
    let tpHit = false;

    if (side === 'LONG') {
      slHit = candle.low <= sl;     // Low touched SL
      tpHit = candle.high >= tp;    // High touched TP
    } else {
      slHit = candle.high >= sl;    // High touched SL
      tpHit = candle.low <= tp;     // Low touched TP
    }

    // If both hit in same candle, SL takes priority (conservative)
    if (slHit) {
      await this.closePosition('SL');
    } else if (tpHit) {
      await this.closePosition('TP');
    }
  }

  private async closePosition(reason: 'TP' | 'SL' | 'MANUAL'): Promise<void> {
    if (!this.openPosition) return;

    const pos = this.openPosition;
    const exitPrice = this.currentPrice;

    // Calculate PnL
    const direction = pos.side === 'LONG' ? 1 : -1;
    const priceDiff = (exitPrice - pos.entryPrice) * direction;
    const pnlPct = priceDiff / pos.entryPrice;
    const pnl = pos.margin * pos.leverage * pnlPct;

    try {
      // Pass full executor position object if available, else positionId
      const execPos = pos.executorPosition ?? pos.positionId;
      await (this.executor as any).closePosition(execPos, exitPrice, reason);
    } catch (err) {
      this.logger.error(`[SWING] Failed to close position: ${err}`);
    }

    // Update state
    this.dailyPnL += pnl;
    this.circuitBreaker.recordTrade('SWING', pnl, reason, Date.now());
    this.lastSignalTime = Date.now(); // Reset cooldown from close too

    const icon = reason === 'TP' ? '🟢' : reason === 'SL' ? '🔴' : '🟡';
    const held = ((Date.now() - pos.openTime) / 60_000).toFixed(0);

    this.logger.info(
      `[SWING] ${icon} CLOSED ${pos.side} ${this.symbol} @ $${exitPrice.toFixed(2)} | ` +
      `${reason} | PnL: $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${(pnlPct * 100).toFixed(2)}%) | ` +
      `Entry: $${pos.entryPrice.toFixed(2)} | Held: ${held}min | ` +
      `Daily PnL: $${this.dailyPnL.toFixed(2)}`
    );

    this.openPosition = null;
  }

  // ── BRAIN (ported from backtester run.ts AS-IS) ──

  private analyzeBrain(c1m: Candle[], c5m: Candle[]): MarketStateV2 | null {
    if (c5m.length < 60) return null;
    const price = c1m[c1m.length - 1]?.close || 0;
    if (!price) return null;

    const closes5m = c5m.map(c => c.close);
    const idx = closes5m.length - 1;
    const ema21 = calcEMA(closes5m, 21);
    const ema48 = calcEMA(closes5m, 48);
    const rsi5m = calcRSI(closes5m, 14);
    const e21 = ema21[idx] || price;
    const e48 = ema48[idx] || price;
    const rsi = rsi5m[idx] || 50;

    let score = 0;
    if (e21 > e48) score += 12; else score -= 12;
    const slope21 = idx > 5 && ema21[idx - 5] ? (e21 - ema21[idx - 5]) / ema21[idx - 5] : 0;
    if (slope21 > 0.0005) score += 7; else if (slope21 < -0.0005) score -= 7;

    const pvs21 = ((price - e21) / price) * 100;
    if (pvs21 > 0.15) score += 8; else if (pvs21 < -0.15) score -= 8;

    if (rsi > 55) score += 5; else if (rsi < 45) score -= 5;
    if (rsi > 70) score += 5; if (rsi < 30) score -= 5;

    const recent30 = c5m.slice(-30);
    const swingHighs: number[] = [], swingLows: number[] = [];
    for (let i = 2; i < recent30.length - 2; i++) {
      if (recent30[i].high > recent30[i - 1].high && recent30[i].high > recent30[i + 1].high)
        swingHighs.push(recent30[i].high);
      if (recent30[i].low < recent30[i - 1].low && recent30[i].low < recent30[i + 1].low)
        swingLows.push(recent30[i].low);
    }
    const hh = swingHighs.length >= 2 && swingHighs[swingHighs.length - 1] > swingHighs[swingHighs.length - 2];
    const ll = swingLows.length >= 2 && swingLows[swingLows.length - 1] < swingLows[swingLows.length - 2];
    if (hh) score += 12; if (ll) score -= 12;

    const m1h = c1m.length >= 60
      ? ((price - c1m[c1m.length - 60].close) / c1m[c1m.length - 60].close) * 100 : 0;
    const m4h = c1m.length >= 240
      ? ((price - c1m[c1m.length - 240].close) / c1m[c1m.length - 240].close) * 100 : 0;
    if (m1h > 0.5) score += 5; else if (m1h < -0.5) score -= 5;
    if (m4h > 1.5) score += 8; else if (m4h < -1.5) score -= 8;

    const abs = Math.abs(score);
    let regime = 'CHOP', allowedSides = 'NONE', bias = 'NEUTRAL', levMult = 0.5;
    if (abs >= 40) {
      regime = score > 0 ? 'UPTREND' : 'DOWNTREND';
      allowedSides = score > 0 ? 'LONG_ONLY' : 'SHORT_ONLY';
      bias = score > 0 ? 'LONG' : 'SHORT';
      levMult = 1.2;
    } else if (abs >= 20) {
      regime = score > 0 ? 'UPTREND' : 'DOWNTREND';
      allowedSides = 'BOTH'; bias = score > 0 ? 'LONG' : 'SHORT'; levMult = 1.0;
    } else if (abs >= 10) {
      regime = 'TRANSITION'; allowedSides = 'BOTH'; bias = 'NEUTRAL'; levMult = 0.7;
    }

    let specialEvent = 'NONE', posMult = 1.0;
    const consecGreen = countConsec(c5m, 'green');
    const consecRed = countConsec(c5m, 'red');

    // MFI
    let mfi = 50;
    if (c5m.length > 15) {
      let pos = 0, neg = 0;
      for (let i = c5m.length - 14; i < c5m.length; i++) {
        const tp = (c5m[i].high + c5m[i].low + c5m[i].close) / 3;
        const ptp = (c5m[i - 1].high + c5m[i - 1].low + c5m[i - 1].close) / 3;
        const mfv = tp * c5m[i].volume;
        if (tp > ptp) pos += mfv; else neg += mfv;
      }
      mfi = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    }

    const CAPITULATION_RSI = 22, CAPITULATION_MFI = 20, CAPITULATION_CONSEC_RED = 4;
    const EUPHORIA_RSI = 78, EUPHORIA_MFI = 80, EUPHORIA_CONSEC_GREEN = 4;

    if (rsi <= CAPITULATION_RSI && mfi <= CAPITULATION_MFI && consecRed >= CAPITULATION_CONSEC_RED) {
      specialEvent = 'CAPITULATION'; posMult = 1.3;
    } else if (rsi >= EUPHORIA_RSI && mfi >= EUPHORIA_MFI && consecGreen >= EUPHORIA_CONSEC_GREEN) {
      specialEvent = 'EUPHORIA'; posMult = 1.3;
    }
    // BREAKOUT detection
    if (specialEvent === 'NONE' && abs >= 25) {
      const barsSinceRSIExtreme = findBarsSinceExtreme(rsi5m, rsi > 50 ? 'high' : 'low');
      if (barsSinceRSIExtreme !== null && barsSinceRSIExtreme <= 3) {
        specialEvent = 'BREAKOUT'; posMult = 1.1;
      }
    }

    return {
      regime, specialEvent, confidence: abs,
      allowedSides, bias,
      leverageMultiplier: levMult, positionSizeMultiplier: posMult,
      reasons: [], timestamp: Date.now(),
      metrics: { score, rsi, mfi, e21, e48 },
      structureLevels: [], nearestSupport: null, nearestResistance: null,
      divergence: null, exhaustionScore: 0, recentBreakoutLevel: null, recentBreakoutBarsAgo: 0,
    };
  }

  // ── SWING SIGNAL EVALUATOR (ported from backtester engines.ts) ──

  private evaluateSwing(state: MarketStateV2, price: number, c5m: Candle[]): SwingSignal | null {
    const minConf = (this.config as any).MIN_CONFIDENCE_SWING ?? 75;

    if (state.specialEvent === 'NONE' && state.confidence < minConf) return null;
    if (state.regime === 'CHOP') return null;
    if (state.regime === 'TRANSITION' && state.specialEvent === 'NONE') return null;

    const atr = calcATR(c5m, 14);
    if (atr === 0) return null;

    // ── HTF FILTER (SMA50 1h derived from 5m candles) ──
    let macroLongBlocked = false, macroShortBlocked = false;

    if (this.config.HTF_FILTER_ENABLED !== false) {
      const hourlyCl: number[] = [];
      for (let hi = 11; hi < c5m.length; hi += 12) hourlyCl.push(c5m[hi].close);

      if (hourlyCl.length >= 50) {
        const sma50 = hourlyCl.slice(-50).reduce((s, v) => s + v, 0) / 50;
        const sma200 = hourlyCl.length >= 200
          ? hourlyCl.slice(-200).reduce((s, v) => s + v, 0) / 200 : sma50;
        const nearSMA = Math.abs(price - sma50) / sma50 < 0.01;

        if (!nearSMA) {
          if (price < sma50) macroLongBlocked = true;
          if (price > sma50) macroShortBlocked = true;
        }
        if (price < sma200 * 0.98) macroLongBlocked = true;
        if (price > sma200 * 1.02) macroShortBlocked = true;
      }
    }

    // ── BMSB FILTER (BULL_SWING_LONG) ──
    let bullSwingLongBlocked = false;
    if (this.config.BULL_SWING_LONG === false) {
      if (this.bmsbStatus === 'BULL') bullSwingLongBlocked = true;
      // If UNKNOWN, don't block (insufficient data — permissive fallback)
    }

    // ── Determine side ──
    let side: 'LONG' | 'SHORT' | null = null;

    if (state.specialEvent === 'CAPITULATION') side = 'LONG';
    else if (state.specialEvent === 'EUPHORIA') side = 'SHORT';
    else if (state.specialEvent === 'BREAKOUT') {
      side = state.bias === 'LONG' ? 'LONG' : 'SHORT';
    } else if (state.confidence >= minConf) {
      if (state.bias === 'LONG') side = 'LONG';
      else if (state.bias === 'SHORT') side = 'SHORT';
    }

    if (!side) return null;
    if (state.allowedSides === 'LONG_ONLY' && side === 'SHORT') return null;
    if (state.allowedSides === 'SHORT_ONLY' && side === 'LONG') return null;

    // Extreme events bypass macro filters (intentional — capitulations are reversals)
    const isExtremeEvent = state.specialEvent === 'CAPITULATION' || state.specialEvent === 'EUPHORIA';
    if (!isExtremeEvent) {
      if (macroLongBlocked && side === 'LONG') return null;
      if (macroShortBlocked && side === 'SHORT') return null;
      if (bullSwingLongBlocked && side === 'LONG') return null;
    }

    // ── SL/TP (fixed %, config ganadora) ──
    const FIXED_SL_PCT = (this.config.SWING_SL_PCT ?? 1.0) / 100;
    const FIXED_TP_PCT = (this.config.SWING_TP_PCT ?? 5.0) / 100;

    const sl = side === 'LONG'
      ? price * (1 - FIXED_SL_PCT)
      : price * (1 + FIXED_SL_PCT);
    const tp = side === 'LONG'
      ? price * (1 + FIXED_TP_PCT)
      : price * (1 - FIXED_TP_PCT);

    // Noise filter: SL too tight
    const slPct = Math.abs(price - sl) / price;
    if (slPct < 0.0015) return null;

    return {
      engine: 'SWING',
      side,
      price,
      sl,
      tp,
      leverage: this.config.SWING_LEVERAGE ?? 6,
      margin: (this.config as any).SWING_MARGIN_FIXED ?? 200,
      confidence: state.confidence,
      specialEvent: state.specialEvent,
      regime: state.regime,
    };
  }

  // ── BMSB (Bull Market Support Band) from 5m candles ──

  private calcBMSB(c5m: Candle[]): 'BULL' | 'BEAR' | 'TRANSITION' | 'UNKNOWN' {
    const MINS_PER_DAY = 288; // 5m candles per day
    const SMA_DAYS = 140;     // 20 weeks
    const EMA_DAYS = 147;     // 21 weeks
    const NEED_DAYS = EMA_DAYS + 10;

    const totalDays = Math.floor(c5m.length / MINS_PER_DAY);
    if (totalDays < NEED_DAYS) return 'UNKNOWN';

    // Aggregate 5m → daily closes
    const dailyCloses: number[] = [];
    for (let d = 0; d < totalDays; d++) {
      const idx = (d + 1) * MINS_PER_DAY - 1;
      if (idx < c5m.length) dailyCloses.push(c5m[idx].close);
    }
    if (dailyCloses.length < NEED_DAYS) return 'UNKNOWN';

    const sma20w = dailyCloses.slice(-SMA_DAYS).reduce((s, v) => s + v, 0) / SMA_DAYS;
    const emaInput = dailyCloses.slice(-EMA_DAYS * 2);
    const emaVals = calcEMA(emaInput, EMA_DAYS);
    const ema21w = emaVals[emaVals.length - 1] ?? sma20w;

    const price = c5m[c5m.length - 1].close;
    const bandTop = Math.max(sma20w, ema21w);
    const bandBot = Math.min(sma20w, ema21w);

    if (price > bandTop * 1.001) return 'BULL';
    if (price < bandBot * 0.999) return 'BEAR';
    return 'TRANSITION';
  }

  // ── KLINES FETCHER (warmup) ──

  private async fetchKlines(
    interval: string, startMs: number, endMs: number, limit: number
  ): Promise<Candle[]> {
    const allCandles: Candle[] = [];
    let cursor = startMs;

    // Paginate through REST API
    for (let page = 0; page < 10; page++) { // Max 10 pages
      const url = `https://fapi.asterdex.com/fapi/v1/klines?symbol=${this.symbol}` +
        `&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=${limit}`;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          this.logger.error(`[SWING] Kline fetch failed: ${res.status}`);
          break;
        }

        const data = await res.json() as any[];
        if (!data || data.length === 0) break;

        for (const k of data) {
          allCandles.push({
            openTime: k[0],
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: Number(k[5]),
            closeTime: k[6] || k[0],
            quoteVolume: Number(k[7]) || 0,
            trades: k[8] || 0,
            takerBuyBaseVol: Number(k[9]) || 0,
            takerBuyQuoteVol: Number(k[10]) || 0,
            isClosed: true,
          });
        }

        if (data.length < limit) break; // Got everything

        // Next page starts after last candle
        cursor = data[data.length - 1][0] + 1;
        if (cursor >= endMs) break;

      } catch (err) {
        this.logger.error(`[SWING] Kline fetch error: ${err}`);
        break;
      }
    }

    return allCandles;
  }

  // ── STATUS LOG ──

  private logStatus(): void {
    const brain = this.analyzeBrain(this.candles1m, this.candles5m);
    const regime = brain?.regime ?? 'N/A';
    const conf = brain?.confidence ?? 0;
    const event = brain?.specialEvent ?? 'NONE';
    const pos = this.openPosition;

    const posStr = pos
      ? `${pos.side} @ $${pos.entryPrice.toFixed(2)} (SL=$${pos.sl.toFixed(2)} TP=$${pos.tp.toFixed(2)})`
      : 'none';

    const cbOk = this.circuitBreaker.canTrade('SWING', Date.now()).allowed;

    this.logger.info(
      `[SWING] ${new Date().toLocaleTimeString()} | ` +
      `${this.symbol}: $${this.currentPrice.toFixed(2)} | ` +
      `Capital: $${((this.config as any).CAPITAL ?? 650).toFixed(2)} | ` +
      `Position: ${posStr}`
    );
    this.logger.info(
      `        Brain: ${regime} (conf=${conf}) ${event !== 'NONE' ? event : ''} | ` +
      `BMSB: ${this.bmsbStatus} | HTF: ${this.config.HTF_FILTER_ENABLED ? 'on' : 'off'} | ` +
      `Daily: ${this.dailyTradeCount}/${(this.config as any).CB_MAX_TRADES_PER_DAY ?? 2} trades | ` +
      `PnL: $${this.dailyPnL >= 0 ? '+' : ''}${this.dailyPnL.toFixed(2)} | ` +
      `CB: ${cbOk ? 'OK' : 'PAUSED'} | ` +
      `Buffers: ${this.candles1m.length}x1m ${this.candles5m.length}x5m`
    );
  }

  // ── HELPERS ──

  private startOfDay(): number {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
}
