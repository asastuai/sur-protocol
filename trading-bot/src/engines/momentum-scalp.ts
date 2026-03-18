// ============================================================
// src/engines/momentum-scalp.ts — Momentum Scalp Strategy
// ============================================================
// Core strategy: EMA Triple Cross + RSI + MFI + BB + ATR
// Leverage: x15-x20 adaptive based on volatility
// Timeframe: 1-minute candles with 5-minute confirmation
// ============================================================

import type { AsterGateway } from '../gateway/aster-gateway';
import type { PaperExecutor } from '../executors/paper-executor';
import type { Config } from '../config';
import type { Logger } from '../utils/logger';
import type { Candle, Signal, Indicators } from '../types';
import { computeIndicators, calcATR, calcEMA } from '../indicators/technical';
import { MarketBrain, type MarketState, type MarketStateV2 } from './market-brain';
import { StructureScanner, type StructureState } from './structure-scanner';
import { DerivativesFeed } from '../data/derivatives-feed';
import { TradeMemory } from '../memory/trade-memory';
import { PerformanceTracker } from '../memory/performance-tracker';
import { AdaptiveEngine } from '../memory/adaptive-engine';
import { MacroFilter, type MacroState } from './macro-filter';
import { CircuitBreaker } from './circuit-breaker';

export class MomentumScalpEngine {
  private gateway: AsterGateway;
  private executor: PaperExecutor;
  private config: Config;
  private logger: Logger;
  private symbol: string;

  private candles1m: Candle[] = [];
  private candles5m: Candle[] = [];
  private currentPrice = 0;
  private running = false;
  private lastSignalTime = 0;
  private signalCooldown = 300_000;

  // v2.0 — Market Brain (demoted to context advisor in v4.0)
  private brain = new MarketBrain();

  // v4.0 — Structure Scanner (primary signal source)
  private scanner = new StructureScanner();

  // v4.0 — Derivatives Feed (quant context layer)
  private derivFeed: DerivativesFeed;
  private lastMomentumSignalTime = 0;
  private lastSwingSignalTime = 0;

  // v3.0 — Engine cooldowns
  private cooldowns = new Map<string, number>();

  // v3.2 — Adaptive system
  private memory: TradeMemory;
  private tracker: PerformanceTracker;
  private adaptive: AdaptiveEngine;
  private lastIndicators: Indicators | null = null;
  private lastAdaptiveStatusTime = 0;

  // v3.3 — Fast Regime Transition Detector
  private recentStops: { side: string; time: number; engine: string }[] = [];
  private regimePauseUntil = 0;

  // v6.0 — Macro Filter + Circuit Breaker
  private macroFilter = new MacroFilter();
  private circuitBreaker!: CircuitBreaker;
  private macroState: MacroState | null = null;
  private lastMacroUpdate = 0;
  private lastRecordedTradeCount = 0;

  // Stats
  private tickCount = 0;
  private lastStatusTime = 0;
  private statusInterval = 30_000;

  constructor(
    gateway: AsterGateway,
    executor: PaperExecutor,
    config: Config,
    logger: Logger,
    symbol: string
  ) {
    this.gateway = gateway;
    this.executor = executor;
    this.config = config;
    this.logger = logger;
    this.symbol = symbol;

    // v3.2 — Initialize adaptive memory system
    this.memory = new TradeMemory();
    this.tracker = new PerformanceTracker(this.memory);
    this.adaptive = new AdaptiveEngine(this.memory, this.tracker);
    this.logger.info(`🧠 Adaptive system initialized | ${this.memory.getTotalCount()} trades in memory`);

    // v4.0 — Initialize Derivatives Feed
    this.derivFeed = new DerivativesFeed(symbol);
    this.derivFeed.init();

    // v6.0 — Circuit Breaker
    this.circuitBreaker = new CircuitBreaker({
      maxConsecSL: config.CB_MAX_CONSEC_SL,
      slWindowMs: config.CB_SL_WINDOW_MS,
      pauseDurationMs: config.CB_PAUSE_DURATION_MS,
      maxTradesPerDay: config.CB_MAX_TRADES_PER_DAY,
      maxTradesPerEngine: config.CB_MAX_TRADES_PER_ENGINE,
      maxDailyLossPct: 3,
      maxDailyLossAbs: config.CB_MAX_DAILY_LOSS_ABS,
      lossStreakCooldownMult: config.CB_LOSS_STREAK_COOLDOWN_MULT,
    });
    this.logger.info(`⚡ CircuitBreaker initialized | Max ${config.CB_MAX_TRADES_PER_DAY} trades/day | Max loss $${config.CB_MAX_DAILY_LOSS_ABS}/day`);
  }

  // ─── v3.0 HELPERS ────────────────────────────────────────

  private isOnCooldown(engine: string): boolean {
    const until = this.cooldowns.get(engine) || 0;
    return Date.now() < until;
  }

  private setCooldown(engine: string, ms: number): void {
    this.cooldowns.set(engine, Date.now() + ms);
  }

  // v6.0 — Record newly closed trades in CircuitBreaker
  private recordNewTradesInCB(): void {
    const allTrades = this.executor.getClosedTrades();
    if (allTrades.length > this.lastRecordedTradeCount) {
      const newTrades = allTrades.slice(this.lastRecordedTradeCount);
      for (const t of newTrades) {
        if (t.engine) {
          this.circuitBreaker.recordTrade(t.engine, t.netPnl, t.closeReason);
          const stats = this.circuitBreaker.getDailyStats();
          this.logger.info(
            `⚡ CB recorded ${t.engine} | PnL: $${t.netPnl.toFixed(2)} | ${t.closeReason} | ` +
            `Daily: ${stats.totalTrades}/${stats.maxTrades} trades | $${stats.dailyPnL.toFixed(2)} PnL`
          );
        }
      }
      this.lastRecordedTradeCount = allTrades.length;
    }
  }

  // ════════════════════════════════════════════════════════════
  // v4.0 ENGINE METHODS — Structure-First
  // ════════════════════════════════════════════════════════════

  private evaluateBreakoutPlay(ss: StructureState): void {
    if (this.isOnCooldown('BREAKOUT_PLAY')) return;
    if (this.getOpenPositionsByEngine('BREAKOUT_PLAY').length >= 1) return;
    if (this.getTradesLastHour('BREAKOUT_PLAY') >= this.config.BREAKOUT_PLAY_MAX_PER_HOUR) return;

    const atr = ss.context.atrPct * ss.currentPrice / 100;

    // ── MODE A: RETEST (the proven 3.74 PF logic) ──
    if (ss.recentBreakout.direction !== 'NONE' &&
        ss.recentBreakout.barsAgo >= this.config.BREAKOUT_PLAY_MIN_BARS &&
        ss.recentBreakout.barsAgo <= this.config.BREAKOUT_PLAY_MAX_BARS) {

      const level = ss.recentBreakout.level;
      const distFromLevel = Math.abs(ss.currentPrice - level) / level;

      if (distFromLevel < this.config.BREAKOUT_PLAY_RETEST_ZONE_PCT) {
        const priceAbove = ss.currentPrice > level;
        const direction: 'LONG' | 'SHORT' = priceAbove ? 'LONG' : 'SHORT';

        const retestConfirmed = priceAbove
          ? (ss.lastCandle.rejectionSide === 'LOWER' && ss.lastCandle.isBullish)
          : (ss.lastCandle.rejectionSide === 'UPPER' && !ss.lastCandle.isBullish);

        if (retestConfirmed && ss.volumeRatio > 0.5) {
          const sl = direction === 'LONG' ? level - atr * 1.0 : level + atr * 1.0;
          const tp = direction === 'LONG' ? ss.currentPrice + atr * 6 : ss.currentPrice - atr * 6;
          const aligned = (direction === 'LONG' && ss.context.trendHint === 'UP') ||
                           (direction === 'SHORT' && ss.context.trendHint === 'DOWN');
          const baseMargin = aligned ? this.config.BREAKOUT_PLAY_RETEST_MARGIN_ALIGNED
                                     : this.config.BREAKOUT_PLAY_RETEST_MARGIN_COUNTER;

          // Derivatives: OI confirms or weakens the retest
          const d = ss.derivatives;
          let marginMod = 1.0;
          const derivTags: string[] = [];
          if (d.oiTrend === 'RISING' && d.oiChange1h > 2) { marginMod = 1.2; derivTags.push('OI_CONFIRM'); }
          if (d.oiTrend === 'FALLING' && d.oiChange1h < -2) { marginMod = 0.7; derivTags.push('OI_WEAK'); }
          if (direction === 'LONG' && d.recentLiqDominant === 'SHORT_LIQD') { marginMod *= 1.15; derivTags.push('LIQ_CASCADE'); }
          if (direction === 'SHORT' && d.recentLiqDominant === 'LONG_LIQD') { marginMod *= 1.15; derivTags.push('LIQ_CASCADE'); }
          if (direction === 'SHORT' && d.fundingSignal === 'LONGS_PAY') derivTags.push('FUNDING_CONFIRM');
          if (direction === 'LONG' && d.fundingSignal === 'SHORTS_PAY') derivTags.push('FUNDING_CONFIRM');
          const margin = Math.round(baseMargin * marginMod);

          this.openEnginePosition({
            engine: 'BREAKOUT_PLAY', direction, price: ss.currentPrice,
            leverage: this.config.BREAKOUT_PLAY_LEVERAGE, margin, sl, tp,
            trailingActivationPct: this.config.BREAKOUT_PLAY_TRAILING_ACTIVATION,
            trailingCallbackPct: this.config.BREAKOUT_PLAY_TRAILING_CALLBACK,
            tags: ['BREAKOUT_PLAY', 'RETEST', `LEVEL_${level.toFixed(0)}`, ...derivTags],
            confidence: 70,
          });
          this.setCooldown('BREAKOUT_PLAY', this.config.BREAKOUT_PLAY_COOLDOWN_MS);
          this.logger.info(
            `🔁 BREAKOUT_PLAY RETEST | ${direction} @ $${ss.currentPrice.toFixed(2)} | ` +
            `Level $${level.toFixed(2)} | SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | ${aligned ? 'ALIGNED' : 'COUNTER'} | ${derivTags.join(',') || 'NO_DERIV'}`
          );
          return;
        }
      }
    }

    // ── MODE B: CONTINUATION (fresh breakout + strong volume) ──
    if (ss.recentBreakout.direction !== 'NONE' &&
        ss.recentBreakout.barsAgo <= 3 &&
        ss.recentBreakout.confirmed &&
        ss.volumeRatio > this.config.BREAKOUT_PLAY_CONT_MIN_VOL) {

      const direction: 'LONG' | 'SHORT' = ss.recentBreakout.direction === 'UP' ? 'LONG' : 'SHORT';
      const level = ss.recentBreakout.level;
      const sl = direction === 'LONG' ? level - atr * 0.5 : level + atr * 0.5;
      const d = ss.derivatives;

      // OI falling = fake breakout → BLOCK continuation
      if (d.oiTrend === 'FALLING' && d.oiChange1h < -2) {
        this.logger.info(`🚫 BREAKOUT_PLAY CONT blocked: OI_WEAK (${d.oiChange1h.toFixed(1)}% 1h)`);
        return;
      }

      const contTags = ['BREAKOUT_PLAY', 'CONTINUATION', `LEVEL_${level.toFixed(0)}`, `VOL_${ss.volumeRatio.toFixed(1)}x`];
      let contMarginMod = 1.0;
      if (d.oiTrend === 'RISING' && d.oiChange1h > 2) { contMarginMod = 1.2; contTags.push('OI_CONFIRM'); }
      if (direction === 'LONG' && d.recentLiqDominant === 'SHORT_LIQD') { contMarginMod *= 1.15; contTags.push('LIQ_CASCADE'); }
      if (direction === 'SHORT' && d.recentLiqDominant === 'LONG_LIQD') { contMarginMod *= 1.15; contTags.push('LIQ_CASCADE'); }

      this.openEnginePosition({
        engine: 'BREAKOUT_PLAY', direction, price: ss.currentPrice,
        leverage: this.config.BREAKOUT_PLAY_CONT_LEVERAGE,
        margin: Math.round(this.config.BREAKOUT_PLAY_CONTINUATION_MARGIN * contMarginMod),
        sl, tp: 0,
        trailingActivationPct: this.config.BREAKOUT_PLAY_TRAILING_ACTIVATION,
        trailingCallbackPct: this.config.BREAKOUT_PLAY_TRAILING_CALLBACK,
        tags: contTags,
        confidence: 65,
      });
      this.setCooldown('BREAKOUT_PLAY', this.config.BREAKOUT_PLAY_COOLDOWN_MS);
      this.logger.info(
        `💥 BREAKOUT_PLAY CONT | ${direction} @ $${ss.currentPrice.toFixed(2)} | ` +
        `Level $${level.toFixed(2)} | Vol ${ss.volumeRatio.toFixed(1)}x | Trailing only`
      );
    }
  }

  private evaluateLevelBounce(ss: StructureState): void {
    if (this.isOnCooldown('LEVEL_BOUNCE')) return;
    if (this.getOpenPositionsByEngine('LEVEL_BOUNCE').length >= 1) return;
    if (this.getTradesLastHour('LEVEL_BOUNCE') >= this.config.LEVEL_BOUNCE_MAX_PER_HOUR) return;

    let targetLevel: { price: number; strength: number; type: string } | null = null;
    let direction: 'LONG' | 'SHORT' | null = null;

    // Support bounce → LONG
    if (ss.priceDistToSupport < this.config.LEVEL_BOUNCE_MAX_DIST_PCT && ss.nearestSupport) {
      const level = ss.levels.find(l => l.price === ss.nearestSupport);
      if (level && level.strength >= this.config.LEVEL_BOUNCE_MIN_LEVEL_STRENGTH) {
        targetLevel = level; direction = 'LONG';
      }
    }

    // Resistance rejection → SHORT
    if (!direction && ss.priceDistToResistance < this.config.LEVEL_BOUNCE_MAX_DIST_PCT && ss.nearestResistance) {
      const level = ss.levels.find(l => l.price === ss.nearestResistance);
      if (level && level.strength >= this.config.LEVEL_BOUNCE_MIN_LEVEL_STRENGTH) {
        targetLevel = level; direction = 'SHORT';
      }
    }

    if (!targetLevel || !direction) return;

    // Candle rejection confirmation
    if (!ss.lastCandle.isRejection) return;
    if (direction === 'LONG' && ss.lastCandle.rejectionSide !== 'LOWER') return;
    if (direction === 'SHORT' && ss.lastCandle.rejectionSide !== 'UPPER') return;

    // Candle closes in right direction
    if (direction === 'LONG' && !ss.lastCandle.isBullish) return;
    if (direction === 'SHORT' && ss.lastCandle.isBullish) return;

    // Volume alive (not dead)
    if (ss.volumeRatio < 0.6) return;

    // RSI not extreme against trade
    if (direction === 'LONG' && ss.context.rsi5m > 75) return;
    if (direction === 'SHORT' && ss.context.rsi5m < 25) return;

    // Sizing: context-aligned → more margin
    const aligned =
      (direction === 'LONG' && ss.context.emaAlignment === 'BULLISH') ||
      (direction === 'SHORT' && ss.context.emaAlignment === 'BEARISH');
    const margin = aligned ? this.config.LEVEL_BOUNCE_MARGIN_ALIGNED : this.config.LEVEL_BOUNCE_MARGIN_COUNTER;
    const leverage = aligned ? this.config.LEVEL_BOUNCE_LEVERAGE_ALIGNED : this.config.LEVEL_BOUNCE_LEVERAGE_COUNTER;

    const atr = ss.context.atrPct * ss.currentPrice / 100;
    const sl = direction === 'LONG' ? targetLevel.price - atr * 0.8 : targetLevel.price + atr * 0.8;
    const risk = Math.abs(ss.currentPrice - sl);
    const tpByRR = direction === 'LONG' ? ss.currentPrice + risk * 2.5 : ss.currentPrice - risk * 2.5;
    const nextLvl = direction === 'LONG' ? ss.nearestResistance : ss.nearestSupport;
    const tp = nextLvl ?
      (direction === 'LONG' ? Math.min(nextLvl, tpByRR) : Math.max(nextLvl, tpByRR)) : tpByRR;

    // Derivatives: book walls + crowded detection
    const d = ss.derivatives;
    let lbMarginMod = 1.0;
    const lbTags = ['LEVEL_BOUNCE', `LVL_${targetLevel.price.toFixed(0)}`, `STR_${targetLevel.strength}`, aligned ? 'ALIGNED' : 'COUNTER'];
    if (direction === 'LONG' && d.nearestBidWall) {
      const dist = Math.abs(d.nearestBidWall - targetLevel.price) / targetLevel.price;
      if (dist < 0.003) { lbMarginMod = 1.15; lbTags.push('BID_WALL'); }
    }
    if (direction === 'SHORT' && d.nearestAskWall) {
      const dist = Math.abs(d.nearestAskWall - targetLevel.price) / targetLevel.price;
      if (dist < 0.003) { lbMarginMod = 1.15; lbTags.push('ASK_WALL'); }
    }
    if (direction === 'LONG' && d.crowdedSide === 'LONG_CROWDED') { lbMarginMod *= 0.8; lbTags.push('CROWDED_L'); }
    if (direction === 'SHORT' && d.crowdedSide === 'SHORT_CROWDED') { lbMarginMod *= 0.8; lbTags.push('CROWDED_S'); }
    if (direction === 'LONG' && d.bookImbalance > 0.3) lbTags.push('BOOK_BULL');
    if (direction === 'SHORT' && d.bookImbalance < -0.3) lbTags.push('BOOK_BEAR');

    this.openEnginePosition({
      engine: 'LEVEL_BOUNCE', direction, price: ss.currentPrice,
      leverage, margin: Math.round(margin * lbMarginMod), sl, tp,
      trailingActivationPct: this.config.LEVEL_BOUNCE_TRAILING_ACTIVATION,
      trailingCallbackPct: this.config.LEVEL_BOUNCE_TRAILING_CALLBACK,
      tags: lbTags,
      confidence: targetLevel.strength,
    });
    this.setCooldown('LEVEL_BOUNCE', this.config.LEVEL_BOUNCE_COOLDOWN_MS);
    this.logger.info(
      `📍 LEVEL_BOUNCE | ${direction} @ $${ss.currentPrice.toFixed(2)} | ` +
      `Level $${targetLevel.price.toFixed(2)} (str ${targetLevel.strength}) | ` +
      `SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | x${leverage} | ${aligned ? 'ALIGNED' : 'COUNTER'}`
    );
  }

  private evaluateExhaustionReversal(ss: StructureState): void {
    if (this.isOnCooldown('EXHAUSTION_REVERSAL')) return;
    if (this.getOpenPositionsByEngine('EXHAUSTION_REVERSAL').length >= 1) return;
    if (this.getTradesLastHour('EXHAUSTION_REVERSAL') >= this.config.EXHAUSTION_REVERSAL_MAX_PER_HOUR) return;
    if (ss.exhaustionScore < this.config.EXHAUSTION_REVERSAL_MIN_EXHAUSTION) return;

    let confirmations: string[] = [];
    let direction: 'LONG' | 'SHORT';

    if (ss.context.emaAlignment === 'BULLISH' && ss.context.rsi5m > 65) {
      direction = 'SHORT';
      if (ss.divergence.type === 'BEARISH_DIV') confirmations.push('BEARISH_DIV');
      if (ss.lastCandle.rejectionSide === 'UPPER') confirmations.push('UPPER_REJECTION');
      if (ss.volumeTrend === 'FALLING') confirmations.push('VOLUME_DRY_UP');
      if (ss.nearestResistance && ss.priceDistToResistance < 0.3) confirmations.push('AT_RESISTANCE');
    } else if (ss.context.emaAlignment === 'BEARISH' && ss.context.rsi5m < 35) {
      direction = 'LONG';
      if (ss.divergence.type === 'BULLISH_DIV') confirmations.push('BULLISH_DIV');
      if (ss.lastCandle.rejectionSide === 'LOWER') confirmations.push('LOWER_REJECTION');
      if (ss.volumeTrend === 'FALLING') confirmations.push('VOLUME_DRY_UP');
      if (ss.nearestSupport && ss.priceDistToSupport < 0.3) confirmations.push('AT_SUPPORT');
    } else {
      return;
    }

    // Derivatives: extra confirmations (funding, crowding, OI, liquidations)
    const dEx = ss.derivatives;
    if (direction! === 'SHORT' && dEx.fundingRate > 0.0005) confirmations.push('FUNDING_EXTREME_LONG');
    if (direction! === 'LONG' && dEx.fundingRate < -0.0003) confirmations.push('FUNDING_EXTREME_SHORT');
    if (direction! === 'SHORT' && dEx.crowdedSide === 'LONG_CROWDED') confirmations.push('LONG_CROWDED');
    if (direction! === 'LONG' && dEx.crowdedSide === 'SHORT_CROWDED') confirmations.push('SHORT_CROWDED');
    if (dEx.oiTrend === 'FALLING' && dEx.oiChange1h < -3) confirmations.push('OI_DECLINING');
    if (direction! === 'LONG' && dEx.recentLiqDominant === 'LONG_LIQD') confirmations.push('LONG_LIQS_EXHAUSTED');
    if (direction! === 'SHORT' && dEx.recentLiqDominant === 'SHORT_LIQD') confirmations.push('SHORT_LIQS_EXHAUSTED');

    if (confirmations.length < this.config.EXHAUSTION_REVERSAL_MIN_CONFIRMATIONS) return;

    const atr = ss.context.atrPct * ss.currentPrice / 100;
    const sl = direction! === 'LONG'
      ? ss.currentPrice - atr * this.config.EXHAUSTION_REVERSAL_SL_ATR_MULT
      : ss.currentPrice + atr * this.config.EXHAUSTION_REVERSAL_SL_ATR_MULT;
    const tp = direction! === 'LONG'
      ? ss.currentPrice + atr * this.config.EXHAUSTION_REVERSAL_TP_ATR_MULT
      : ss.currentPrice - atr * this.config.EXHAUSTION_REVERSAL_TP_ATR_MULT;
    const margin = confirmations.length >= 3 ? this.config.EXHAUSTION_REVERSAL_MARGIN_3CONF : this.config.EXHAUSTION_REVERSAL_MARGIN_2CONF;
    const leverage = confirmations.length >= 3 ? 8 : 6;

    this.openEnginePosition({
      engine: 'EXHAUSTION_REVERSAL', direction: direction!, price: ss.currentPrice,
      leverage, margin, sl, tp,
      trailingActivationPct: this.config.EXHAUSTION_REVERSAL_TRAILING_ACTIVATION,
      trailingCallbackPct: this.config.EXHAUSTION_REVERSAL_TRAILING_CALLBACK,
      tags: ['EXHAUSTION', ...confirmations],
      confidence: Math.min(100, ss.exhaustionScore + confirmations.length * 10),
    });
    this.setCooldown('EXHAUSTION_REVERSAL', this.config.EXHAUSTION_REVERSAL_COOLDOWN_MS);
    this.logger.info(
      `🔄 EXHAUSTION_REVERSAL | ${direction!} @ $${ss.currentPrice.toFixed(2)} | ` +
      `Exhaustion: ${ss.exhaustionScore} | ${confirmations.join(', ')} | x${leverage}`
    );
  }

  private evaluateTrendRider(ss: StructureState): void {
    if (this.isOnCooldown('TREND_RIDER')) return;
    if (this.getOpenPositionsByEngine('TREND_RIDER').length >= 1) return;
    if (this.getTradesLastHour('TREND_RIDER') >= this.config.TREND_RIDER_MAX_PER_HOUR) return;

    // Needs clear EMA structure (not regime)
    if (ss.context.emaAlignment === 'FLAT') return;
    const direction: 'LONG' | 'SHORT' = ss.context.emaAlignment === 'BULLISH' ? 'LONG' : 'SHORT';

    // EMA slope must confirm active trend
    if (direction === 'LONG' && ss.context.ema21Slope <= 0) return;
    if (direction === 'SHORT' && ss.context.ema21Slope >= 0) return;

    // Candle in right direction
    if (direction === 'LONG' && !ss.lastCandle.isBullish) return;
    if (direction === 'SHORT' && ss.lastCandle.isBullish) return;

    // Volume alive
    if (ss.volumeRatio < 0.7) return;

    // RSI not extreme against trade
    if (direction === 'LONG' && ss.context.rsi5m > 72) return;
    if (direction === 'SHORT' && ss.context.rsi5m < 28) return;

    // Don't ride an exhausted trend
    if (ss.exhaustionScore > this.config.TREND_RIDER_MAX_EXHAUSTION) return;

    // Derivatives: OI dying → don't ride it
    const dTr = ss.derivatives;
    if (dTr.oiTrend === 'FALLING' && dTr.oiChange1h < -3) {
      this.logger.debug(`⏸️ TREND_RIDER blocked: OI declining (${dTr.oiChange1h.toFixed(1)}% 1h)`);
      return;
    }

    const atr = ss.context.atrPct * ss.currentPrice / 100;
    const sl = direction === 'LONG'
      ? ss.currentPrice - atr * this.config.TREND_RIDER_SL_ATR_MULT
      : ss.currentPrice + atr * this.config.TREND_RIDER_SL_ATR_MULT;

    // Derivatives margin adjustment
    let trMarginMod = 1.0;
    const trTags = ['TREND_RIDER', `EMA_${ss.context.emaAlignment}`];
    if (dTr.oiTrend === 'RISING') { trMarginMod = 1.15; trTags.push('OI_RISING'); }
    if (direction === 'LONG' && dTr.fundingRate > 0.0006) { trMarginMod = 0.7; trTags.push('FUNDING_CROWDED'); }
    if (direction === 'SHORT' && dTr.fundingRate < -0.0004) { trMarginMod = 0.7; trTags.push('FUNDING_CROWDED'); }
    if (direction === 'LONG' && dTr.crowdedSide === 'LONG_CROWDED') { trMarginMod *= 0.85; trTags.push('CROWDED'); }
    if (direction === 'SHORT' && dTr.crowdedSide === 'SHORT_CROWDED') { trMarginMod *= 0.85; trTags.push('CROWDED'); }

    // v6.0: Macro direction gate
    if (this.macroState) {
      if (direction === 'LONG' && !this.macroState.allowLongs) {
        this.logger.debug(`⛔ TREND_RIDER LONG blocked by macro: ${this.macroState.trend}`);
        return;
      }
      if (direction === 'SHORT' && !this.macroState.allowShorts) {
        this.logger.debug(`⛔ TREND_RIDER SHORT blocked by macro: ${this.macroState.trend}`);
        return;
      }
    }

    this.openEnginePosition({
      engine: 'TREND_RIDER', direction, price: ss.currentPrice,
      leverage: this.config.TREND_RIDER_LEVERAGE,
      margin: Math.round(this.config.TREND_RIDER_MARGIN * trMarginMod * (this.macroState?.marginMultiplier ?? 1)),
      sl, tp: 0,
      trailingActivationPct: this.config.TREND_RIDER_TRAILING_ACTIVATION,
      trailingCallbackPct: this.config.TREND_RIDER_TRAILING_CALLBACK,
      tags: trTags,
      confidence: 70,
    });
    this.setCooldown('TREND_RIDER', this.config.TREND_RIDER_COOLDOWN_MS);
    this.logger.info(
      `📈 TREND_RIDER | ${direction} @ $${ss.currentPrice.toFixed(2)} | ` +
      `EMA ${ss.context.emaAlignment} | Slope ${(ss.context.ema21Slope * 100).toFixed(3)}% | ` +
      `SL $${sl.toFixed(2)} (${this.config.TREND_RIDER_SL_ATR_MULT}x ATR) | Trail ${this.config.TREND_RIDER_TRAILING_ACTIVATION}%/${this.config.TREND_RIDER_TRAILING_CALLBACK}%`
    );
  }

  // ─── v3.3: Fast Regime Transition Detector ───────────────
  private onStopLossHit(side: string, engine: string): void {
    this.recentStops.push({ side, time: Date.now(), engine });
    // Limpiar stops >2h
    this.recentStops = this.recentStops.filter(s => Date.now() - s.time < 7_200_000);

    // Contar stops misma dirección en última hora
    const recentSameSide = this.recentStops.filter(
      s => s.side === side && Date.now() - s.time < 3_600_000
    );

    if (recentSameSide.length >= 2 && Date.now() > this.regimePauseUntil) {
      this.logger.warn(
        `🚨 REGIME ALERT: ${recentSameSide.length} ${side} SL hits in 1h ` +
        `[${recentSameSide.map(s => s.engine).join(', ')}] → ` +
        `pausing regime-dependent engines for 15min`
      );
      this.regimePauseUntil = Date.now() + 900_000; // 15 min
      // Forzar re-análisis del brain inmediato
      (this.brain as any).lastAnalysisTime = 0;
    }
  }

  private getOpenPositionsByEngine(engine: string): any[] {
    return this.executor.getOpenPositions().filter((p: any) => p.engine === engine);
  }

  /**
   * Count trades closed in the last hour for a given engine
   */
  private getTradesLastHour(engine: string): number {
    const oneHourAgo = Date.now() - 3_600_000;
    return (this.executor as any).getClosedTrades?.()
      ?.filter((t: any) => t.engine === engine && t.closeTime > oneHourAgo)?.length ?? 0;
  }

  /**
   * v3.1 — Brain bias hard lock
   * Returns false if the direction conflicts with Brain's allowed sides.
   * REVERSAL is exempt (can counter with high confidence).
   */
  private checkBrainBiasAlignment(
    direction: 'LONG' | 'SHORT',
    state: MarketStateV2 | MarketState
  ): boolean {
    if (state.allowedSides === 'SHORT_ONLY' && direction === 'LONG') return false;
    if (state.allowedSides === 'LONG_ONLY' && direction === 'SHORT') return false;
    if (state.allowedSides === 'NONE') return false;
    return true;
  }

  private getCurrentExposurePct(): number {
    const positions = this.executor.getOpenPositions();
    const totalMargin = positions.reduce((s: number, p: any) => s + (p.margin || 0), 0);
    const capital = this.executor.getCurrentCapital();
    return capital > 0 ? (totalMargin / capital) * 100 : 0;
  }

  private async closePosition(id: string, reason: string): Promise<void> {
    const pos = this.executor.getOpenPositions().find((p: any) => p.id === id);
    if (!pos) return;

    const trade = await this.executor.closePosition(pos, this.currentPrice, reason);

    // ── v3.2: Record to adaptive memory ──
    try {
      const brainState = this.brain.getLastState() as MarketStateV2 | null;
      const ind = this.lastIndicators;
      const atrPct = ind ? (ind.atr / this.currentPrice) * 100 : 0;
      const closedAt = Date.now();

      this.memory.recordTrade({
        id: trade.id,
        engine: pos.engine || 'UNKNOWN',
        pair: this.symbol,
        side: pos.side,
        entry_price: pos.entryPrice,
        exit_price: this.currentPrice,
        margin: pos.margin,
        leverage: pos.leverage,
        quantity: pos.quantity,
        pnl: trade.pnl,
        pnl_pct: trade.pnlPct,
        fees: trade.fees,
        net_pnl: trade.netPnl,
        is_win: trade.netPnl > 0,
        exit_reason: reason,
        opened_at: pos.openTime,
        closed_at: closedAt,
        duration_ms: closedAt - pos.openTime,
        hour_of_day: new Date(closedAt).getUTCHours(),
        day_of_week: new Date(closedAt).getUTCDay(),
        brain_regime: pos.brainRegime || brainState?.regime || '',
        brain_confidence: pos.confidence || brainState?.confidence || 0,
        brain_bias: brainState?.bias || '',
        brain_event: brainState?.specialEvent || 'NONE',
        exhaustion_score: (brainState as any)?.exhaustionScore || 0,
        rsi_1m: ind?.rsi || 0,
        rsi_5m: brainState?.metrics?.rsi_5m || 0,
        mfi_5m: ind?.mfi || 0,
        bb_width: ind?.bbWidth || 0,
        atr_pct: atrPct,
        tags: pos.tags?.join(',') || '',
        confidence: pos.confidence || 0,
      });
    } catch (err) {
      // Never let memory errors crash the bot
      this.logger.error('Memory record error (non-fatal):', err);
    }
  }

  /**
   * Unified openPosition for all v3 engines — accepts simplified object format
   */
  private async openEnginePosition(params: {
    engine: string;
    direction: 'LONG' | 'SHORT';
    price: number;
    leverage: number;
    margin: number;
    sl: number;
    tp: number;
    trailingActivationPct?: number;
    trailingCallbackPct?: number;
    tags?: string[];
    confidence?: number;
    brainRegime?: string;
  }): Promise<void> {
    try {
      const signal: Signal = {
        type: params.direction === 'LONG' ? 'ENTRY_LONG' : 'ENTRY_SHORT',
        side: params.direction,
        price: params.price,
        timestamp: Date.now(),
        indicators: {} as any,
        conditions: {
          emaCross: true, rsiConfirm: true, mfiConfirm: true,
          trendAlign: true, volumeConfirm: true, conditionsMet: 5,
        },
        suggestedLeverage: params.leverage,
        stopLoss: params.sl,
        takeProfit: params.tp,
      };

      const capital = this.executor.getCurrentCapital();
      await (this.executor as any).openPosition(signal, capital, {
        margin: params.margin,
        leverage: params.leverage,
        tags: params.tags,
        engine: params.engine as any,
        trailingActivationPct: params.trailingActivationPct ?? 0,
        trailingCallbackPct: params.trailingCallbackPct ?? 0,
        confidence: params.confidence,
        brainRegime: params.brainRegime,
      });
    } catch (err) {
      this.logger.error(`${params.engine} execution error:`, err);
    }
  }

  /**
   * Load historical candles for indicator warmup
   */
  async warmup() {
    this.logger.info('📥 Loading historical candles for warmup...');

    try {
      this.candles1m = await this.gateway.getKlines(
        this.symbol, '1m', this.config.WARMUP_CANDLES
      );
      this.candles5m = await this.gateway.getKlines(
        this.symbol, '5m', this.config.WARMUP_CANDLES
      );

      this.currentPrice = this.candles1m[this.candles1m.length - 1]?.close || 0;

      this.logger.info(
        `✅ Warmup complete: ${this.candles1m.length} x 1m candles, ` +
        `${this.candles5m.length} x 5m candles. ` +
        `Current price: $${this.currentPrice.toFixed(2)}`
      );
    } catch (err) {
      this.logger.error('Warmup failed:', err);
      throw err;
    }
  }

  /**
   * Start processing WebSocket events
   */
  start() {
    this.running = true;
    this.lastStatusTime = Date.now();

    this.gateway.onMessage((stream: string, data: any) => {
      if (!this.running) return;

      try {
        // Process kline events
        if (stream.includes('@kline_1m')) {
          this.handleKline(data, '1m');
        } else if (stream.includes('@kline_5m')) {
          this.handleKline(data, '5m');
        }

        // Process ticker for real-time price
        if (stream.includes('@ticker')) {
          this.handleTicker(data);
        }

        // Process trades for volume tracking
        if (stream.includes('@aggTrade')) {
          this.handleAggTrade(data);
        }
      } catch (err) {
        this.logger.error('Event processing error:', err);
      }
    });

    this.logger.info('🟢 Strategy engine started. Listening for signals...');
  }

  async stop() {
    this.running = false;
    this.gateway.disconnect();
    this.logger.info('🔴 Strategy engine stopped.');
  }

  // ─── EVENT HANDLERS ─────────────────────────────

  private handleKline(data: any, interval: string) {
    const k = data.k;
    if (!k) return;

    const candle: Candle = {
      openTime: k.t,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
      closeTime: k.T,
      quoteVolume: parseFloat(k.q),
      trades: k.n,
      takerBuyBaseVol: parseFloat(k.V),
      takerBuyQuoteVol: parseFloat(k.Q),
      isClosed: k.x,
    };

    const candles = interval === '1m' ? this.candles1m : this.candles5m;

    if (candle.isClosed) {
      // New closed candle — add to history
      candles.push(candle);

      // Keep max 500 candles in memory
      if (candles.length > 500) candles.shift();

      // Only evaluate signals on closed 1m candles
      if (interval === '1m') {
        // v6.0: Record newly closed trades in circuit breaker
        this.recordNewTradesInCB();

        // v6.0: Update macro filter every 5 min (needs 1200+ 5m candles = ~4 days)
        if (this.config.MACRO_FILTER_ENABLED &&
            Date.now() - this.lastMacroUpdate >= this.config.MACRO_FILTER_INTERVAL_MS &&
            this.candles5m.length >= this.config.MACRO_MIN_5M_CANDLES) {
          this.macroState = this.macroFilter.analyze(this.candles5m);
          this.lastMacroUpdate = Date.now();
          this.logger.info(
            `📊 MACRO: ${this.macroState.trend} | Score: ${this.macroState.score} | ` +
            `Longs: ${this.macroState.allowLongs ? '✅' : '❌'} | ` +
            `Shorts: ${this.macroState.allowShorts ? '✅' : '❌'} | ` +
            `Margin: ${(this.macroState.marginMultiplier * 100).toFixed(0)}%`
          );
        }

        this.evaluate(); // v3.x legacy engines

        // v4.0: structure-first engines (run in parallel, same position limits)
        if (this.candles5m.length >= 50) {
          const ss = this.scanner.scan(this.candles1m, this.candles5m);
          this.evaluateV4(ss).catch(e => this.logger.error('evaluateV4 error (non-fatal):', e));
        }
      }
    } else {
      // Update current (unclosed) candle
      if (candles.length > 0) {
        const last = candles[candles.length - 1];
        if (last.openTime === candle.openTime) {
          candles[candles.length - 1] = candle;
        }
      }
    }
  }

  private handleTicker(data: any) {
    if (data.c) {
      this.currentPrice = parseFloat(data.c);
    }

    // Update open positions with current price
    if (this.executor.getOpenPositions().length > 0) {
      this.checkOpenPositions();
    }

    // Periodic status
    this.tickCount++;
    if (Date.now() - this.lastStatusTime > this.statusInterval) {
      this.printStatus();
      this.lastStatusTime = Date.now();
    }
  }

  private handleAggTrade(_data: any) {
    // Could be used for more granular volume analysis
    // For now, we rely on kline volume data
  }

  // ─── STRATEGY EVALUATION ─────────────────────────

  private evaluate() {
    // Check circuit breaker
    if ((this.executor as any).isCircuitBreakerActive?.()) {
      return;
    }

    // ─── v3.2: Adaptive engine — runs every 30 min ───
    this.adaptive.run();

    // ─── v3.2: Adaptive status print — every 6 hours ───
    if (Date.now() - this.lastAdaptiveStatusTime > 21_600_000) {
      this.adaptive.printState();
      this.lastAdaptiveStatusTime = Date.now();
    }

    // ─── v3.2: TIME FILTER — horas tóxicas (08-09 UTC = 0% WR sobre 13 trades) ───
    const hourUTC = new Date().getUTCHours();
    const isToxicHour = hourUTC === 8 || hourUTC === 9;

    // ─── MARKET BRAIN v2: Run every 3 minutes ───
    let marketState = this.brain.getLastState() as MarketStateV2 | null;

    if (this.brain.shouldAnalyze()) {
      marketState = this.brain.analyzeV2(this.candles1m, this.candles5m);

      const v2State = marketState as MarketStateV2;
      this.logger.info(
        `🧠 BRAIN v2 | Regime: ${marketState.regime} | ` +
        `Event: ${marketState.specialEvent} | ` +
        `Confidence: ${marketState.confidence.toFixed(0)}% | ` +
        `Bias: ${marketState.bias} | ` +
        `Allowed: ${marketState.allowedSides} | ` +
        `Exhaustion: ${v2State.exhaustionScore ?? 0} | ` +
        `Div: ${v2State.divergence?.type ?? 'NONE'} | ` +
        `RSI5m: ${marketState.metrics.rsi_5m.toFixed(0)} | ` +
        `Mom4h: ${marketState.metrics.momentum_4h_pct.toFixed(2)}%`
      );

      if (marketState.reasons.length > 0) {
        this.logger.info(`   Reasons: ${marketState.reasons.join(' | ')}`);
      }

      this.logger.logBrainCSV(marketState);
    }

    if (!marketState) return;

    const v2State = marketState as MarketStateV2;
    const openCount = this.executor.getOpenPositions().length;

    // ─── v3.3: Regime Pause — solo BREAKOUT_RETEST y SNIPER operan ───
    const inRegimePause = Date.now() < this.regimePauseUntil;
    if (inRegimePause) {
      const remaining = Math.round((this.regimePauseUntil - Date.now()) / 1000);
      this.logger.debug(`⏸️ REGIME PAUSE: ${remaining}s left — only structure-based engines active`);
      if (openCount < this.config.MAX_TOTAL_POSITIONS) {
        if (this.adaptive.isEnabled('SNIPER'))        this.evaluateSniper(v2State);
        if (this.adaptive.isEnabled('BREAKOUT_RETEST')) this.evaluateBreakoutRetest(v2State);
      }
      return;
    }

    // ══════════════════════════════════════════════════════
    // ★ v5.0 — AGGRESSIVE MODE: All profitable engines active
    // MOMENTUM: DISABLED (PF 0.22, -$123 net)
    // SCALP: Active (PF 1.04, needs tighter filters)
    // SWING: Active + BOOSTED (PF 2.18, best engine)
    // BREAKOUT_RETEST: Active (solid structure)
    // TREND_FOLLOW: Active (tighter SL now)
    // SNIPER: Active (high confluence)
    // ══════════════════════════════════════════════════════
    if (this.executor.getOpenPositions().length < this.config.MAX_TOTAL_POSITIONS) {
      // Priority 1: Structure-based engines (highest edge)
      if (this.adaptive.isEnabled('BREAKOUT_RETEST')) this.evaluateBreakoutRetest(v2State);
      if (this.adaptive.isEnabled('SNIPER'))          this.evaluateSniper(v2State);

      // Priority 2: Best performer
      if (this.adaptive.isEnabled('SWING'))           this.evaluateSwing(v2State);

      // TREND_FOLLOW disabled — v5.3: PF 0.96, -$3.64 net en backtest 7d
      // if (this.adaptive.isEnabled('TREND_FOLLOW') && !isToxicHour) this.evaluateTrendFollow(v2State);

      // SCALP disabled — v5.3: PF 0.98, -$0.83 net en backtest 7d
      // if (this.adaptive.isEnabled('SCALP') && !isToxicHour) this.evaluateScalp(v2State);

      // MOMENTUM — DISABLED: worst engine by every metric
      // if (this.adaptive.isEnabled('MOMENTUM') && !isToxicHour) this.evaluateMomentum(v2State);

      // GRID — only in chop
      if (this.adaptive.isEnabled('GRID') && !isToxicHour)  this.evaluateGrid(v2State);

      // REVERSAL — only when exhaustion detected
      if (this.adaptive.isEnabled('REVERSAL'))        this.evaluateReversal(v2State);
    }
  }

  // ─── v4.0 EVALUATE — Structure-First ──────────────────────
  // Runs in parallel with the old evaluate() via a flag.
  // Will fully replace it once paper-tested.

  private async evaluateV4(ss: StructureState): Promise<void> {
    if (this.executor.getOpenPositions().length >= this.config.MAX_TOTAL_POSITIONS) return;

    // Enrich with derivatives (cached 30s — never blocks)
    try {
      const d = await this.derivFeed.fetch();
      ss.derivatives = {
        fundingRate: d.fundingRate,
        fundingSignal: d.fundingSignal,
        hoursUntilFunding: d.hoursUntilFunding,
        oiChange1h: d.oiChange1h,
        oiTrend: d.oiTrend,
        longShortRatio: d.longShortRatio,
        crowdedSide: d.crowdedSide,
        bookImbalance: d.bookImbalance,
        nearestBidWall: d.nearestBidWall,
        nearestAskWall: d.nearestAskWall,
        recentLiqDominant: d.recentLiquidations.dominantSide,
      };
    } catch { /* neutral defaults already set */ }

    // v6.0 active engines: TREND_RIDER only (BREAKOUT_PLAY disabled: PF 0.78, -$59 en 90d)
    if (this.executor.getOpenPositions().length < this.config.MAX_TOTAL_POSITIONS) {
      // BREAKOUT_PLAY disabled — v6.0: PF 0.78, 44% WR, -$59.49 net en 90d backtest
      // this.evaluateBreakoutPlay(ss);

      // LEVEL_BOUNCE disabled — v5.1: PF 0.19, 32% WR, -$23.91 en backtest de 7d
      // this.evaluateExhaustionReversal(ss);

      // TREND_RIDER — gated by circuit breaker
      const cbTR = this.circuitBreaker.canTrade('TREND_RIDER');
      if (cbTR.allowed) {
        this.evaluateTrendRider(ss);
      } else {
        this.logger.debug(`⛔ TREND_RIDER blocked: ${cbTR.reason}`);
      }
    }
  }

  // ─── SCALP ENGINE v3.2 (ADAPTIVE) ──────────────────────────

  private evaluateScalp(state: MarketState) {
    // ── Gate 1: Adaptive confidence (default 60, auto-tuned) ──
    const minConf = this.adaptive.getParam('SCALP', 'min_confidence', this.config.MIN_CONFIDENCE_SCALP);
    if (state.confidence < minConf) return;

    // ── Gate 2: Solo en tendencia clara — no scalp en CHOP ──
    if (state.regime !== 'UPTREND' && state.regime !== 'DOWNTREND') return;

    // ── Gate 3: Cooldown ──
    if (this.isOnCooldown('SCALP')) return;

    // ── Gate 4: Max 1 SCALP abierto simultáneo ──
    if (this.getOpenPositionsByEngine('SCALP').length >= 1) return;

    // ── Gate 5: Adaptive max per hour ──
    const maxPerHour = this.adaptive.getParam('SCALP', 'max_per_hour', this.config.SCALP_MAX_PER_HOUR);
    if (this.getTradesLastHour('SCALP') >= maxPerHour) {
      this.logger.debug(`⏸️ SCALP: Max ${maxPerHour} scalps/hour reached`);
      return;
    }

    // ── Gate 6: Max total positions ──
    if (this.executor.getOpenPositions().length >= this.config.MAX_TOTAL_POSITIONS) return;

    // Compute indicators on 1m candles
    const indicators = computeIndicators(this.candles1m, {
      emaFast: this.config.EMA_FAST,
      emaMid: this.config.EMA_MID,
      emaSlow: this.config.EMA_SLOW,
      rsiPeriod: this.config.RSI_PERIOD,
      mfiPeriod: this.config.MFI_PERIOD,
      bbPeriod: this.config.BB_PERIOD,
      bbStddev: this.config.BB_STDDEV,
      atrPeriod: this.config.ATR_PERIOD,
    });
    if (!indicators) return;
    this.lastIndicators = indicators; // v3.2: save for memory recording

    // ── Gate 7: BB Width — skip flat markets ──
    if (indicators.bbWidth < this.config.SCALP_MIN_BB_WIDTH) {
      this.logger.debug(`⏸️ SCALP: BB flat: ${indicators.bbWidth.toFixed(4)} < ${this.config.SCALP_MIN_BB_WIDTH}`);
      return;
    }

    // ── Gate 8: Volatility filter — no scalp si mercado demasiado volátil ──
    const atrPct = indicators.atr / this.currentPrice * 100;
    if (atrPct > 0.15) {
      this.logger.debug(`⏸️ SCALP: ATR too high: ${atrPct.toFixed(3)}% > 0.15%`);
      return;
    }

    // ── Gate 9: RSI extremes — no scalp en oversold/overbought ──
    if (indicators.rsi < 25 || indicators.rsi > 75) {
      this.logger.debug(`⏸️ SCALP: RSI extreme: ${indicators.rsi.toFixed(1)}`);
      return;
    }

    // ── HARD LOCK: direction = Brain direction ──
    // Si Brain dice DOWNTREND → solo SHORTs. Sin excepciones.
    let forcedSide: 'LONG' | 'SHORT';
    if (state.regime === 'UPTREND' && state.allowedSides !== 'SHORT_ONLY') {
      forcedSide = 'LONG';
    } else if (state.regime === 'DOWNTREND' && state.allowedSides !== 'LONG_ONLY') {
      forcedSide = 'SHORT';
    } else {
      return; // Régimen no alinea con sides permitidos
    }

    // ★★★ BRAIN BIAS FINAL CHECK ★★★
    if (!this.checkBrainBiasAlignment(forcedSide, state)) return;

    // ── Generate signal, pero forzamos la dirección del Brain ──
    const signal = this.generateSignal(indicators, state, forcedSide);
    (this.executor as any).registerSignal?.();
    if (signal.type !== 'NONE') this.logger.logSignalCSV(signal);
    if (signal.type === 'NONE') return;

    this.setCooldown('SCALP', this.config.SCALP_COOLDOWN_MS);

    // Apply leverage multiplier from brain — hard cap x10 AFTER multiplier
    const adjustedLeverage = Math.round(
      Math.min(this.config.SCALP_DEFAULT_LEVERAGE, signal.suggestedLeverage) * state.leverageMultiplier
    );
    signal.suggestedLeverage = Math.min(10, Math.max(5, adjustedLeverage)); // v3.3: hard cap

    this.executeScalpTrade(signal);
  }

  // ─── MOMENTUM ENGINE v3.2 (ADAPTIVE) ──────────────────────────

  private evaluateMomentum(state: MarketState) {
    // Adaptive confidence threshold (default 65 after hotfix)
    const minConf = this.adaptive.getParam('MOMENTUM', 'min_confidence', this.config.MIN_CONFIDENCE_MOMENTUM);
    if (state.confidence < minConf) return;
    if (state.allowedSides === 'NONE') return;

    // Cooldown
    if (Date.now() - this.lastMomentumSignalTime < this.config.MOMENTUM_COOLDOWN_MS) return;

    // Max positions
    const openPositions = this.executor.getOpenPositions();
    if (openPositions.length >= this.config.MAX_TOTAL_POSITIONS) return;

    // Don't open momentum if one already open
    const existingMomentum = openPositions.find(p => p.engine === 'MOMENTUM');
    if (existingMomentum) return;

    if (this.candles5m.length < 60) return;

    const closes5m = this.candles5m.map(c => c.close);
    const idx = closes5m.length - 1;
    const atr5mArr = calcATR(this.candles5m, 14);
    const currentATR5m = atr5mArr[idx] || 0;

    // Need some ATR
    if (currentATR5m === 0) return;

    const price = this.currentPrice;
    const bias = state.bias;
    if (bias === 'NEUTRAL') return;

    // Simple momentum signal: EMA alignment on 5m + trend direction from brain
    const ema21 = state.metrics.price_vs_ema21_pct;
    const ema48 = state.metrics.price_vs_ema48_pct;

    let side: 'LONG' | 'SHORT' | null = null;

    if (bias === 'LONG' && ema21 > 0 && ema48 > 0) {
      // Price above both EMAs, brain says LONG
      side = 'LONG';
    } else if (bias === 'SHORT' && ema21 < 0 && ema48 < 0) {
      // Price below both EMAs, brain says SHORT
      side = 'SHORT';
    }

    if (!side) return;

    // ★★★ BRAIN BIAS CHECK ★★★
    if (!this.checkBrainBiasAlignment(side, state)) return;

    const leverage = Math.round(this.config.MOMENTUM_DEFAULT_LEVERAGE * state.leverageMultiplier);
    const capital = this.executor.getCurrentCapital();
    const margin = capital * (this.config.MOMENTUM_MARGIN_PCT / 100);

    const sl = side === 'LONG'
      ? price - (currentATR5m * this.config.MOMENTUM_SL_ATR_MULT_5M)
      : price + (currentATR5m * this.config.MOMENTUM_SL_ATR_MULT_5M);
    const tp = side === 'LONG'
      ? price + (currentATR5m * this.config.MOMENTUM_TP_ATR_MULT_5M)
      : price - (currentATR5m * this.config.MOMENTUM_TP_ATR_MULT_5M);

    this.logger.signal(
      `📊 MOMENTUM SIGNAL | ${side} | ` +
      `Price: $${price.toFixed(2)} | Leverage: x${leverage} | ` +
      `Margin: $${margin.toFixed(2)} | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)} | ` +
      `Confidence: ${state.confidence.toFixed(0)}% | ATR5m: ${currentATR5m.toFixed(2)}`
    );

    this.lastMomentumSignalTime = Date.now();

    const signal: Signal = {
      type: side === 'LONG' ? 'ENTRY_LONG' : 'ENTRY_SHORT',
      side,
      price,
      timestamp: Date.now(),
      indicators: {} as any,
      conditions: {
        emaCross: true, rsiConfirm: true, mfiConfirm: true,
        trendAlign: true, volumeConfirm: true, conditionsMet: 5,
      },
      suggestedLeverage: leverage,
      stopLoss: sl,
      takeProfit: tp,
    };

    (this.executor as any).openPosition(signal, capital, {
      margin,
      leverage,
      tags: ['MOMENTUM'],
      engine: 'MOMENTUM',
      trailingActivationPct: this.config.MOMENTUM_TRAILING_ACTIVATION,
      trailingCallbackPct: this.config.MOMENTUM_TRAILING_CALLBACK,
    });
  }

  // ─── SWING ENGINE ─────────────────────────────

  private evaluateSwing(state: MarketState) {
    // Only enter swings on special events or very high confidence trends
    if (state.specialEvent === 'NONE' && state.confidence < this.config.MIN_CONFIDENCE_SWING) return;

    // Check if we already have a swing position
    const swingPositions = this.executor.getOpenPositions()
      .filter(p => p.tags?.includes('SWING'));
    if (swingPositions.length >= this.config.SWING_MAX_CONCURRENT) return;

    // Cooldown: Only 1 swing per 4 hours
    if (Date.now() - this.lastSwingSignalTime < this.config.SWING_COOLDOWN_MS) return;

    const price = this.currentPrice;
    const atr5m = this.getATR5m();
    if (atr5m === 0) return;

    let side: 'LONG' | 'SHORT' | null = null;
    let sl: number = 0;
    let leverage: number = this.config.SWING_LEVERAGE_MIN;
    let reason: string = '';

    // ─── CAPITULATION SWING LONG ───
    if (state.specialEvent === 'CAPITULATION') {
      side = 'LONG';
      const recentLow = Math.min(...this.candles5m.slice(-20).map(c => c.low));
      sl = recentLow * 0.998;
      leverage = this.config.SWING_LEVERAGE_MIN;
      reason = 'SWING_CAPITULATION_LONG';
    }

    // ─── EUPHORIA SWING SHORT ───
    if (state.specialEvent === 'EUPHORIA') {
      side = 'SHORT';
      const recentHigh = Math.max(...this.candles5m.slice(-20).map(c => c.high));
      sl = recentHigh * 1.002;
      leverage = this.config.SWING_LEVERAGE_MIN;
      reason = 'SWING_EUPHORIA_SHORT';
    }

    // ─── BREAKOUT SWING ───
    if (state.specialEvent === 'BREAKOUT') {
      side = state.bias === 'LONG' ? 'LONG' : 'SHORT';
      sl = side === 'LONG'
        ? price - (atr5m * 4.88)  // v5.2: sweet spot backtested
        : price + (atr5m * 4.88); // v5.2: sweet spot backtested
      leverage = this.config.SWING_LEVERAGE_MIN + 1;
      reason = 'SWING_BREAKOUT';
    }

    // ─── HIGH CONFIDENCE TREND SWING ───
    if (side === null && state.confidence >= this.config.MIN_CONFIDENCE_SWING) {
      if (state.bias === 'LONG') {
        side = 'LONG';
        sl = price - (atr5m * 4.88); // v5.2: sweet spot backtested
      } else if (state.bias === 'SHORT') {
        side = 'SHORT';
        sl = price + (atr5m * 4.88); // v5.2: sweet spot backtested
      }
      leverage = this.config.SWING_LEVERAGE_MAX;
      reason = 'SWING_HIGH_CONVICTION';
    }

    if (!side) return;

    // Check allowed sides
    if (state.allowedSides === 'LONG_ONLY' && side === 'SHORT') return;
    if (state.allowedSides === 'SHORT_ONLY' && side === 'LONG') return;

    const margin = this.config.SWING_MARGIN_FIXED;
    // ★ v5.0: TP was 5% ($3000+ distance) — NEVER hit. Now 2.5% or 2:1 R:R, whichever is closer
    const riskDistance = Math.abs(price - sl);
    const tpByRR = side === 'LONG' ? price + riskDistance * 2.5 : price - riskDistance * 2.5;
    const tpByPct = side === 'LONG' ? price * 1.025 : price * 0.975; // 2.5% move
    const tp = side === 'LONG' ? Math.min(tpByRR, tpByPct) : Math.max(tpByRR, tpByPct);

    this.logger.signal(
      `🎯 SWING SIGNAL | ${reason} | ${side} | ` +
      `Price: $${price.toFixed(2)} | Leverage: x${leverage} | ` +
      `Margin: $${margin} | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)} | ` +
      `Confidence: ${state.confidence.toFixed(0)}% | ` +
      `Special: ${state.specialEvent}`
    );

    // v6.0: Circuit breaker gate
    const cbSW = this.circuitBreaker.canTrade('SWING');
    if (!cbSW.allowed) {
      this.logger.info(`⛔ SWING blocked: ${cbSW.reason}`);
      return;
    }

    // v6.0: Macro direction gate
    if (this.macroState) {
      if (side === 'LONG' && !this.macroState.allowLongs) {
        this.logger.info(`⛔ SWING LONG blocked by macro: ${this.macroState.trend}`);
        return;
      }
      if (side === 'SHORT' && !this.macroState.allowShorts) {
        this.logger.info(`⛔ SWING SHORT blocked by macro: ${this.macroState.trend}`);
        return;
      }
    }

    this.lastSwingSignalTime = Date.now();

    this.executeSwingTrade({
      side,
      price,
      leverage,
      margin: Math.round(margin * (this.macroState?.marginMultiplier ?? 1)),
      stopLoss: sl,
      takeProfit: tp,
      reason,
      trailingActivationPct: this.config.SWING_TRAILING_ACTIVATION,
      trailingCallbackPct: this.config.SWING_TRAILING_CALLBACK,
      tags: ['SWING', reason],
    });
  }

  // ─── ENGINE 4: REVERSAL ───────────────────────────────────

  private evaluateReversal(state: MarketStateV2): void {
    // Gate 1: Need active trend to reverse
    if (state.regime !== 'UPTREND' && state.regime !== 'DOWNTREND' && state.regime !== 'REVERSAL_ZONE') return;

    // Gate 2: Exhaustion must be meaningful
    if ((state.exhaustionScore ?? 0) < this.config.REVERSAL_MIN_EXHAUSTION) return;

    // Gate 3: Cooldown check
    if (this.isOnCooldown('REVERSAL')) return;

    // Gate 4: Max positions
    if (this.getOpenPositionsByEngine('REVERSAL').length >= 1) return;

    const candles = this.candles5m;
    if (candles.length < 10) return;
    const current = candles[candles.length - 1];
    const confirmations: string[] = [];

    const isUptrendReversal =
      state.regime === 'UPTREND' ||
      (state.regime === 'REVERSAL_ZONE' && state.bias === 'LONG');
    const direction = isUptrendReversal ? 'SHORT' : 'LONG';

    // Confirmation 1: RSI Divergence
    if (isUptrendReversal && state.divergence?.type === 'BEARISH_DIV') {
      confirmations.push('BEARISH_DIVERGENCE');
    }
    if (!isUptrendReversal && state.divergence?.type === 'BULLISH_DIV') {
      confirmations.push('BULLISH_DIVERGENCE');
    }

    // Confirmation 2: Wick Rejection
    const bodySize = Math.abs(current.close - current.open);
    const upperWick = current.high - Math.max(current.close, current.open);
    const lowerWick = Math.min(current.close, current.open) - current.low;

    if (isUptrendReversal && upperWick > bodySize * 2) {
      confirmations.push('UPPER_WICK_REJECTION');
    }
    if (!isUptrendReversal && lowerWick > bodySize * 2) {
      confirmations.push('LOWER_WICK_REJECTION');
    }

    // Confirmation 3: Volume Dry-up
    const recentVol = candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5;
    const prevVol = candles.length >= 15
      ? candles.slice(-15, -5).reduce((s, c) => s + c.volume, 0) / 10
      : recentVol;
    if (prevVol > 0 && recentVol / prevVol < 0.6) {
      confirmations.push('VOLUME_DRY_UP');
    }

    // Need at least 2 of 3 confirmations
    if (confirmations.length < this.config.REVERSAL_MIN_CONFIRMATIONS) return;

    // Confirmation 4 (bonus): Near structure level
    if (isUptrendReversal && state.nearestResistance) {
      const distToRes = Math.abs(current.close - state.nearestResistance) / current.close;
      if (distToRes < 0.003) confirmations.push('AT_RESISTANCE');
    }
    if (!isUptrendReversal && state.nearestSupport) {
      const distToSup = Math.abs(current.close - state.nearestSupport) / current.close;
      if (distToSup < 0.003) confirmations.push('AT_SUPPORT');
    }

    // Calculate confidence
    const confidence = Math.min(100,
      (state.exhaustionScore ?? 0) * 0.3 +
      (state.divergence?.strength ?? 0) * 0.3 +
      confirmations.length * 15
    );

    if (confidence < 55) return;

    // Respect brain bias — but reversal CAN go against it if confidence is high
    if (direction === 'LONG' && state.allowedSides === 'SHORT_ONLY' && confidence < 70) return;
    if (direction === 'SHORT' && state.allowedSides === 'LONG_ONLY' && confidence < 70) return;

    const atr5m = this.getATR5m();
    if (atr5m === 0) return;
    const leverage = confidence > 75 ? this.config.REVERSAL_MAX_LEVERAGE : this.config.REVERSAL_DEFAULT_LEVERAGE;
    const sl = direction === 'LONG'
      ? current.close - atr5m * this.config.REVERSAL_SL_ATR_MULT
      : current.close + atr5m * this.config.REVERSAL_SL_ATR_MULT;
    const tp = direction === 'LONG'
      ? current.close + atr5m * this.config.REVERSAL_TP_ATR_MULT
      : current.close - atr5m * this.config.REVERSAL_TP_ATR_MULT;

    this.openEnginePosition({
      engine: 'REVERSAL',
      direction, price: current.close, leverage,
      margin: this.config.REVERSAL_MARGIN,
      sl, tp,
      trailingActivationPct: this.config.REVERSAL_TRAILING_ACTIVATION,
      trailingCallbackPct: this.config.REVERSAL_TRAILING_CALLBACK,
      tags: ['REVERSAL', ...confirmations],
      confidence,
      brainRegime: state.regime,
    });

    this.setCooldown('REVERSAL', this.config.REVERSAL_COOLDOWN_MS);

    this.logger.info(
      `🔄 REVERSAL | ${direction} @ $${current.close.toFixed(2)} | ` +
      `x${leverage} | Exhaustion: ${state.exhaustionScore} | ` +
      `Confirmations: ${confirmations.join(', ')} | Conf: ${confidence.toFixed(0)}%`
    );
  }

  // ─── ENGINE 5: SNIPER ─────────────────────────────────────

  private evaluateSniper(state: MarketStateV2): void {
    // Gate 1: Brain must be very confident
    if (state.confidence < this.config.SNIPER_MIN_BRAIN_CONFIDENCE) {
      this.logger.debug(`⏸️ SNIPER skip: brain conf ${state.confidence.toFixed(0)}% < ${this.config.SNIPER_MIN_BRAIN_CONFIDENCE}%`);
      return;
    }

    // Gate 2: Only in clear trends
    if (state.regime !== 'UPTREND' && state.regime !== 'DOWNTREND') return;

    // Gate 3: Cooldown + max positions
    if (this.isOnCooldown('SNIPER')) return;
    if (this.getOpenPositionsByEngine('SNIPER').length >= 1) return;

    const candles = this.candles5m;
    if (candles.length < 25) return;
    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const direction = state.regime === 'UPTREND' ? 'LONG' : 'SHORT';

    let structureLevelOk = false;
    let levelPrice = 0;
    let emaBounceOk = false;
    let volumeSpikeOk = false;
    let rsiOk = false;

    // Check 1: Near strong structure level
    const levels = (state.structureLevels ?? []).filter(l => l.strength >= this.config.SNIPER_MIN_LEVEL_STRENGTH);
    this.logger.debug(`🎯 SNIPER: ${levels.length} levels strength>=${this.config.SNIPER_MIN_LEVEL_STRENGTH} | direction: ${direction}`);
    levels.forEach(l => this.logger.debug(`   ${l.type} @ $${l.price.toFixed(2)} str:${l.strength}`));
    for (const level of levels) {
      const dist = Math.abs(current.close - level.price) / current.close;
      if (dist < 0.005) {
        if (direction === 'LONG' && level.type === 'SUPPORT') {
          structureLevelOk = true;
          levelPrice = level.price;
        }
        if (direction === 'SHORT' && level.type === 'RESISTANCE') {
          structureLevelOk = true;
          levelPrice = level.price;
        }
      }
    }

    // Check 2: EMA Bounce
    const closes = candles.map(c => c.close);
    const ema21Arr = calcEMA(closes, 21);
    const ema21Val = ema21Arr[ema21Arr.length - 1] ?? current.close;

    if (direction === 'LONG') {
      const touchedEma = prev.low <= ema21Val * 1.002;
      const bouncedUp = current.close > ema21Val && current.close > current.open;
      if (touchedEma && bouncedUp) emaBounceOk = true;
    } else {
      const touchedEma = prev.high >= ema21Val * 0.998;
      const bouncedDown = current.close < ema21Val && current.close < current.open;
      if (touchedEma && bouncedDown) emaBounceOk = true;
    }

    // Check 3: Volume Spike
    const avgVol = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
    if (avgVol > 0 && current.volume > avgVol * 1.5) volumeSpikeOk = true;

    // Check 4: RSI in favorable zone
    const rsi = state.metrics.rsi_5m;
    if (direction === 'LONG' && rsi > 35 && rsi < 60) rsiOk = true;
    if (direction === 'SHORT' && rsi > 40 && rsi < 65) rsiOk = true;

    // ALL 4 checks must pass
    if (!structureLevelOk || !emaBounceOk || !volumeSpikeOk || !rsiOk) return;

    // Structure-based SL
    const structureSl = direction === 'LONG'
      ? levelPrice * 0.998
      : levelPrice * 1.002;

    const riskPerUnit = Math.abs(current.close - structureSl);
    if (riskPerUnit === 0) return;
    const tp = direction === 'LONG'
      ? current.close + riskPerUnit * this.config.SNIPER_MIN_RR_RATIO
      : current.close - riskPerUnit * this.config.SNIPER_MIN_RR_RATIO;

    const leverage = state.confidence > 85
      ? this.config.SNIPER_MAX_LEVERAGE
      : this.config.SNIPER_DEFAULT_LEVERAGE;

    this.openEnginePosition({
      engine: 'SNIPER',
      direction, price: current.close, leverage,
      margin: this.config.SNIPER_MARGIN,
      sl: structureSl, tp,
      trailingActivationPct: this.config.SNIPER_TRAILING_ACTIVATION,
      trailingCallbackPct: this.config.SNIPER_TRAILING_CALLBACK,
      tags: ['SNIPER', 'CONFLUENCE_4', `BRAIN_${state.confidence.toFixed(0)}`],
      confidence: state.confidence,
      brainRegime: state.regime,
    });

    this.setCooldown('SNIPER', this.config.SNIPER_COOLDOWN_MS);

    this.logger.info(
      `🎯 SNIPER | ${direction} @ $${current.close.toFixed(2)} | ` +
      `x${leverage} | SL: $${structureSl.toFixed(2)} (structure) | ` +
      `TP: $${tp.toFixed(2)} (${this.config.SNIPER_MIN_RR_RATIO}:1 R:R) | ` +
      `Brain: ${state.confidence.toFixed(0)}% | Level: $${levelPrice.toFixed(2)}`
    );
  }

  // ─── ENGINE 6: BREAKOUT RETEST ────────────────────────────

  private evaluateBreakoutRetest(state: MarketStateV2): void {
    // Gate 1: Must have a recent breakout level
    if (!state.recentBreakoutLevel) return;
    if (
      state.recentBreakoutBarsAgo < this.config.BREAKOUT_RETEST_MIN_BARS_SINCE_BREAKOUT ||
      state.recentBreakoutBarsAgo > this.config.BREAKOUT_RETEST_MAX_BARS_SINCE_BREAKOUT
    ) return;

    // Gate 2: Cooldown + positions
    if (this.isOnCooldown('BREAKOUT_RETEST')) return;
    if (this.getOpenPositionsByEngine('BREAKOUT_RETEST').length >= 1) return;

    const candles = this.candles5m;
    if (candles.length < 5) return;
    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const level = state.recentBreakoutLevel;

    // Gate 3: Price must be near the breakout level
    const distFromLevel = Math.abs(current.close - level) / level;
    if (distFromLevel > this.config.BREAKOUT_RETEST_RETEST_ZONE_PCT) return;

    const priceAboveLevel = current.close > level;
    let retestConfirmed = false;
    let direction: 'LONG' | 'SHORT';

    if (priceAboveLevel) {
      direction = 'LONG';
      const wickedBelow = current.low < level || prev.low < level;
      const closedAbove = current.close > level;
      const bullishCandle = current.close > current.open;
      retestConfirmed = wickedBelow && closedAbove && bullishCandle;
    } else {
      direction = 'SHORT';
      const wickedAbove = current.high > level || prev.high > level;
      const closedBelow = current.close < level;
      const bearishCandle = current.close < current.open;
      retestConfirmed = wickedAbove && closedBelow && bearishCandle;
    }

    if (!retestConfirmed) return;

    // Volume check: not dead
    const avgVol = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
    if (avgVol > 0 && current.volume < avgVol * 0.5) return;

    const atr5m = this.getATR5m();
    if (atr5m === 0) return;
    const leverage = state.confidence > 60
      ? this.config.BREAKOUT_RETEST_MAX_LEVERAGE
      : this.config.BREAKOUT_RETEST_DEFAULT_LEVERAGE;

    const slBuffer = atr5m * this.config.BREAKOUT_RETEST_SL_ATR_MULT;
    const sl = direction === 'LONG' ? level - slBuffer : level + slBuffer;
    const tp = direction === 'LONG'
      ? current.close + atr5m * this.config.BREAKOUT_RETEST_TP_ATR_MULT
      : current.close - atr5m * this.config.BREAKOUT_RETEST_TP_ATR_MULT;

    this.openEnginePosition({
      engine: 'BREAKOUT_RETEST',
      direction, price: current.close, leverage,
      margin: this.config.BREAKOUT_RETEST_MARGIN,
      sl, tp,
      trailingActivationPct: this.config.BREAKOUT_RETEST_TRAILING_ACTIVATION,
      trailingCallbackPct: this.config.BREAKOUT_RETEST_TRAILING_CALLBACK,
      tags: ['BREAKOUT_RETEST', `LEVEL_${level.toFixed(0)}`],
      confidence: state.confidence,
      brainRegime: state.regime,
    });

    this.setCooldown('BREAKOUT_RETEST', this.config.BREAKOUT_RETEST_COOLDOWN_MS);

    this.logger.info(
      `🔁 BREAKOUT_RETEST | ${direction} @ $${current.close.toFixed(2)} | ` +
      `x${leverage} | Level: $${level.toFixed(2)} | ` +
      `SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)} | ` +
      `BreakoutBarsAgo: ${state.recentBreakoutBarsAgo}`
    );
  }

  // ─── ENGINE 8: TREND_FOLLOW (v3.1 NEW) ──────────────────

  private evaluateTrendFollow(state: MarketStateV2): void {
    if (!this.config.TREND_FOLLOW_ENABLED) return;

    // ── Gate 1: Solo en tendencia clara ──
    if (state.regime !== 'UPTREND' && state.regime !== 'DOWNTREND') return;

    // ── Gate 2: Confianza mínima 55% ──
    if (state.confidence < this.config.TREND_FOLLOW_MIN_CONFIDENCE) return;

    // ── Gate 3: Cooldown + max concurrent ──
    if (this.isOnCooldown('TREND_FOLLOW')) return;
    if (this.getOpenPositionsByEngine('TREND_FOLLOW').length >= 1) return;

    // ── Gate 4: Max per hour ──
    if (this.getTradesLastHour('TREND_FOLLOW') >= this.config.TREND_FOLLOW_MAX_PER_HOUR) return;

    // ── Gate 5: Max total positions ──
    if (this.executor.getOpenPositions().length >= this.config.MAX_TOTAL_POSITIONS) return;

    if (this.candles5m.length < 25) return;

    const candles = this.candles5m;
    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const direction: 'LONG' | 'SHORT' = state.regime === 'UPTREND' ? 'LONG' : 'SHORT';

    // ★★★ BRAIN BIAS CHECK ★★★
    if (!this.checkBrainBiasAlignment(direction, state)) return;

    // ── EMA alignment must match trend ──
    const closes = candles.map(c => c.close);
    const ema21Arr = calcEMA(closes, 21);
    const ema48Arr = calcEMA(closes, 48);
    const ema21Val = ema21Arr[ema21Arr.length - 1] ?? current.close;
    const ema48Val = ema48Arr[ema48Arr.length - 1] ?? current.close;

    if (direction === 'LONG' && ema21Val <= ema48Val) return;
    if (direction === 'SHORT' && ema21Val >= ema48Val) return;

    // ── Entry: Pullback to EMA21 and bounce ──
    let pullbackConfirmed = false;
    if (direction === 'LONG') {
      const touchedEma = prev.low <= ema21Val * 1.003;      // Dentro de 0.3% del EMA21
      const bouncedUp = current.close > ema21Val;
      const bullishClose = current.close > current.open;
      pullbackConfirmed = touchedEma && bouncedUp && bullishClose;
    } else {
      const touchedEma = prev.high >= ema21Val * 0.997;
      const bouncedDown = current.close < ema21Val;
      const bearishClose = current.close < current.open;
      pullbackConfirmed = touchedEma && bouncedDown && bearishClose;
    }

    if (!pullbackConfirmed) {
      this.logger.debug(`⏸️ TREND_FOLLOW: no pullback/bounce confirmed on EMA21`);
      return;
    }

    // ── Volume: no dead market ──
    const avgVol = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
    if (avgVol > 0 && current.volume < avgVol * 0.7) return;

    // ── RSI: no extremes at entry ──
    const rsi5m = state.metrics.rsi_5m;
    if (direction === 'LONG' && rsi5m > 70) return;
    if (direction === 'SHORT' && rsi5m < 30) return;

    // ── FIRE ──
    const atr5m = this.getATR5m();
    if (atr5m === 0) return;

    const leverage = state.confidence > 70
      ? this.config.TREND_FOLLOW_MAX_LEVERAGE
      : this.config.TREND_FOLLOW_DEFAULT_LEVERAGE;

    const sl = direction === 'LONG'
      ? current.close - atr5m * this.config.TREND_FOLLOW_SL_ATR_MULT
      : current.close + atr5m * this.config.TREND_FOLLOW_SL_ATR_MULT;

    this.openEnginePosition({
      engine: 'TREND_FOLLOW',
      direction,
      price: current.close,
      leverage: Math.min(leverage, this.config.TREND_FOLLOW_MAX_LEVERAGE),
      margin: this.config.TREND_FOLLOW_MARGIN,
      sl,
      tp: 0,  // No TP fijo — solo trailing
      trailingActivationPct: this.config.TREND_FOLLOW_TRAILING_ACTIVATION,
      trailingCallbackPct: this.config.TREND_FOLLOW_TRAILING_CALLBACK,
      tags: ['TREND_FOLLOW', 'EMA21_BOUNCE', `BRAIN_${state.confidence.toFixed(0)}`],
      confidence: state.confidence,
      brainRegime: state.regime,
    });

    this.setCooldown('TREND_FOLLOW', this.config.TREND_FOLLOW_COOLDOWN_MS);

    this.logger.info(
      `📈 TREND_FOLLOW | ${direction} @ $${current.close.toFixed(2)} | ` +
      `x${leverage} | EMA21 bounce | SL: $${sl.toFixed(2)} (${this.config.TREND_FOLLOW_SL_ATR_MULT}x ATR) | ` +
      `No TP (trailing ${this.config.TREND_FOLLOW_TRAILING_ACTIVATION}%/${this.config.TREND_FOLLOW_TRAILING_CALLBACK}%) | ` +
      `Brain: ${state.confidence.toFixed(0)}% ${state.regime}`
    );
  }

  // ─── ENGINE 7: GRID ───────────────────────────────────────

  private evaluateGrid(state: MarketStateV2): void {
    // Kill switch: close all grid positions on regime change
    if (state.regime !== 'CHOP') {
      const gridPositions = this.getOpenPositionsByEngine('GRID');
      if (gridPositions.length > 0) {
        this.logger.info(`🔲 GRID | Regime changed to ${state.regime} — closing all grid positions`);
        gridPositions.forEach(p => this.closePosition(p.id, 'REGIME_CHANGE'));
      }
      return;
    }

    // Gate 2: Confirm choppiness
    if (state.confidence > this.config.GRID_MAX_BRAIN_CONFIDENCE) return;
    if (state.metrics.bb_width_5m > this.config.GRID_MAX_BB_WIDTH) return;

    // Gate 3: Cooldown + max positions
    if (this.isOnCooldown('GRID')) return;
    if (this.getOpenPositionsByEngine('GRID').length >= this.config.GRID_MAX_CONCURRENT) return;

    // Detect range using 1m candles
    const candles = this.candles1m;
    if (candles.length < this.config.GRID_RANGE_LOOKBACK_1M) return;
    const lookback = candles.slice(-this.config.GRID_RANGE_LOOKBACK_1M);
    const rangeHigh = Math.max(...lookback.map(c => c.high));
    const rangeLow = Math.min(...lookback.map(c => c.low));

    if (rangeLow === 0) return;
    const rangeWidth = (rangeHigh - rangeLow) / rangeLow * 100;

    if (rangeWidth < this.config.GRID_MIN_RANGE_PCT || rangeWidth > this.config.GRID_MAX_RANGE_PCT) return;

    const upperZone = rangeHigh - (rangeHigh - rangeLow) * 0.25;
    const lowerZone = rangeLow + (rangeHigh - rangeLow) * 0.25;
    const midPoint = (rangeHigh + rangeLow) / 2;

    const current = candles[candles.length - 1];
    const price = current.close;

    let direction: 'LONG' | 'SHORT' | null = null;
    let sl: number;
    let tp: number;

    if (price <= lowerZone) {
      direction = 'LONG';
      sl = rangeLow * 0.997;
      const existingLongs = this.getOpenPositionsByEngine('GRID').filter(p => p.side === 'LONG');
      tp = existingLongs.length === 0 ? upperZone : midPoint;
    } else if (price >= upperZone) {
      direction = 'SHORT';
      sl = rangeHigh * 1.003;
      const existingShorts = this.getOpenPositionsByEngine('GRID').filter(p => p.side === 'SHORT');
      tp = existingShorts.length === 0 ? lowerZone : midPoint;
    }

    if (!direction) return;

    // Confirmation: rejection candle at zone edge
    const bodySize = Math.abs(current.close - current.open);
    const isRejection = direction === 'LONG'
      ? (current.close > current.open && (Math.min(current.close, current.open) - current.low) > bodySize)
      : (current.close < current.open && (current.high - Math.max(current.close, current.open)) > bodySize);

    if (!isRejection) return;

    const leverage = rangeWidth < 0.4
      ? this.config.GRID_MAX_LEVERAGE
      : this.config.GRID_DEFAULT_LEVERAGE;

    this.openEnginePosition({
      engine: 'GRID',
      direction, price, leverage,
      margin: this.config.GRID_MARGIN,
      sl: sl!,
      tp: tp!,
      trailingActivationPct: 0,
      trailingCallbackPct: 0,
      tags: ['GRID', `RANGE_${rangeWidth.toFixed(2)}PCT`, `ZONE_${direction === 'LONG' ? 'BOTTOM' : 'TOP'}`],
      confidence: 50,
      brainRegime: state.regime,
    });

    this.setCooldown('GRID', this.config.GRID_COOLDOWN_MS);

    this.logger.info(
      `🔲 GRID | ${direction} @ $${price.toFixed(2)} | x${leverage} | ` +
      `Range: $${rangeLow.toFixed(2)}-$${rangeHigh.toFixed(2)} (${rangeWidth.toFixed(2)}%) | ` +
      `SL: $${sl!.toFixed(2)} | TP: $${tp!.toFixed(2)}`
    );
  }

  // ─── TRADE EXECUTION HELPERS ──────────────────

  private async executeScalpTrade(signal: Signal) {
    try {
      const capital = this.executor.getCurrentCapital();
      const margin = capital * (this.config.SCALP_MARGIN_PCT / 100);
      await (this.executor as any).openPosition(signal, capital, {
        margin,
        leverage: signal.suggestedLeverage,
        tags: ['SCALP'],
        engine: 'SCALP',
        trailingActivationPct: this.config.TRAILING_ACTIVATION_PCT,
        trailingCallbackPct: this.config.TRAILING_CALLBACK_PCT,
      });
    } catch (err) {
      this.logger.error('Scalp execution error:', err);
    }
  }

  private async executeSwingTrade(params: {
    side: 'LONG' | 'SHORT';
    price: number;
    leverage: number;
    margin: number;
    stopLoss: number;
    takeProfit: number;
    reason: string;
    trailingActivationPct: number;
    trailingCallbackPct: number;
    tags: string[];
  }) {
    try {
      const signal: Signal = {
        type: params.side === 'LONG' ? 'ENTRY_LONG' : 'ENTRY_SHORT',
        side: params.side,
        price: params.price,
        timestamp: Date.now(),
        indicators: {} as any,
        conditions: {
          emaCross: true, rsiConfirm: true, mfiConfirm: true,
          trendAlign: true, volumeConfirm: true, conditionsMet: 5,
        },
        suggestedLeverage: params.leverage,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
      };

      const capital = this.executor.getCurrentCapital();
      await (this.executor as any).openPosition(signal, capital, {
        margin: params.margin,
        leverage: params.leverage,
        tags: params.tags,
        engine: 'SWING',
        trailingActivationPct: params.trailingActivationPct,
        trailingCallbackPct: params.trailingCallbackPct,
      });
    } catch (err) {
      this.logger.error('Swing execution error:', err);
    }
  }

  // ─── HELPER: ATR on 5m candles ────────────────

  private getATR5m(): number {
    if (this.candles5m.length < 15) return 0;
    const atrArr = calcATR(this.candles5m, 14);
    return atrArr[atrArr.length - 1] || 0;
  }

  private generateSignal(ind: Indicators, state?: MarketState, forcedSide?: 'LONG' | 'SHORT'): Signal {
    const price = this.currentPrice || this.candles1m[this.candles1m.length - 1]?.close || 0;
    if (price === 0) return { type: 'NONE', price: 0, timestamp: Date.now(), indicators: ind, conditions: { emaCross: false, rsiConfirm: false, mfiConfirm: false, trendAlign: false, volumeConfirm: false, conditionsMet: 0 }, suggestedLeverage: 0, stopLoss: 0, takeProfit: 0 };

    // ─── LONG CONDITIONS ────────────────────────
    const longEmaCross = ind.emaFast > ind.emaMid;
    const longRsi = ind.rsi > 40 && ind.rsi > ind.prevRsi;
    const longMfi = ind.mfi > 50;
    const longTrend = price > ind.emaSlow;
    const longVolume = ind.volumeRatio >= this.config.VOLUME_MULT;

    const longConditions = [longEmaCross, longRsi, longMfi, longTrend, longVolume];
    const longScore = longConditions.filter(Boolean).length;

    // ─── SHORT CONDITIONS ───────────────────────
    const shortEmaCross = ind.emaFast < ind.emaMid;
    const shortRsi = ind.rsi < 60 && ind.rsi < ind.prevRsi;
    const shortMfi = ind.mfi < 50;
    const shortTrend = price < ind.emaSlow;
    const shortVolume = ind.volumeRatio >= this.config.VOLUME_MULT;

    const shortConditions = [shortEmaCross, shortRsi, shortMfi, shortTrend, shortVolume];
    const shortScore = shortConditions.filter(Boolean).length;

    // ─── DETERMINE LEVERAGE ─────────────────────
    let leverage = this.config.DEFAULT_LEVERAGE;
    if (ind.atr < ind.atrAvg20 * 0.8) {
      leverage = this.config.LOW_VOL_LEVERAGE; // Low vol → higher leverage ok
    } else if (ind.atr > ind.atrAvg20 * 1.5) {
      leverage = this.config.HIGH_VOL_LEVERAGE; // High vol → reduce leverage
    }

    // ─── BRAIN BIAS FILTER ──────────────────────
    // Respect brain's allowed sides
    if (state) {
      if (state.allowedSides === 'SHORT_ONLY' && longScore >= this.config.MIN_SIGNALS_REQUIRED) {
        this.logger.debug(`⏸️ SCALP LONG blocked by brain (SHORT_ONLY)`);
        // Force no long signal
      } else if (state.allowedSides === 'LONG_ONLY' && shortScore >= this.config.MIN_SIGNALS_REQUIRED) {
        this.logger.debug(`⏸️ SCALP SHORT blocked by brain (LONG_ONLY)`);
        // Force no short signal
      }
    }

    // ─── GENERATE SIGNAL ────────────────────────
    // If forcedSide is set (v3.1 SCALP), only allow that direction
    const allowLong = !forcedSide || forcedSide === 'LONG';
    const allowShort = !forcedSide || forcedSide === 'SHORT';

    if (allowLong && longScore >= this.config.MIN_SIGNALS_REQUIRED &&
        (!state || state.allowedSides !== 'SHORT_ONLY')) {
      const sl = price - (ind.atr * this.config.SL_ATR_MULT);
      const tp = price + (ind.atr * this.config.TP_ATR_MULT);

      this.logger.signal(
        `🟢 LONG SIGNAL | Score: ${longScore}/5 | ` +
        `Price: $${price.toFixed(2)} | ` +
        `EMA✓:${longEmaCross} RSI✓:${longRsi} MFI✓:${longMfi} ` +
        `Trend✓:${longTrend} Vol✓:${longVolume} | ` +
        `RSI:${ind.rsi.toFixed(1)} MFI:${ind.mfi.toFixed(1)} ` +
        `ATR:${ind.atr.toFixed(2)} BB:${ind.bbWidth.toFixed(3)} | ` +
        `Lev: x${leverage}`
      );

      return {
        type: 'ENTRY_LONG',
        side: 'LONG',
        price,
        timestamp: Date.now(),
        indicators: ind,
        conditions: {
          emaCross: longEmaCross,
          rsiConfirm: longRsi,
          mfiConfirm: longMfi,
          trendAlign: longTrend,
          volumeConfirm: longVolume,
          conditionsMet: longScore,
        },
        suggestedLeverage: leverage,
        stopLoss: sl,
        takeProfit: tp,
      };
    }

    if (allowShort && shortScore >= this.config.MIN_SIGNALS_REQUIRED &&
        (!state || state.allowedSides !== 'LONG_ONLY')) {
      const sl = price + (ind.atr * this.config.SL_ATR_MULT);
      const tp = price - (ind.atr * this.config.TP_ATR_MULT);

      this.logger.signal(
        `🔴 SHORT SIGNAL | Score: ${shortScore}/5 | ` +
        `Price: $${price.toFixed(2)} | ` +
        `EMA✓:${shortEmaCross} RSI✓:${shortRsi} MFI✓:${shortMfi} ` +
        `Trend✓:${shortTrend} Vol✓:${shortVolume} | ` +
        `RSI:${ind.rsi.toFixed(1)} MFI:${ind.mfi.toFixed(1)} ` +
        `ATR:${ind.atr.toFixed(2)} BB:${ind.bbWidth.toFixed(3)} | ` +
        `Lev: x${leverage}`
      );

      return {
        type: 'ENTRY_SHORT',
        side: 'SHORT',
        price,
        timestamp: Date.now(),
        indicators: ind,
        conditions: {
          emaCross: shortEmaCross,
          rsiConfirm: shortRsi,
          mfiConfirm: shortMfi,
          trendAlign: shortTrend,
          volumeConfirm: shortVolume,
          conditionsMet: shortScore,
        },
        suggestedLeverage: leverage,
        stopLoss: sl,
        takeProfit: tp,
      };
    }

    return {
      type: 'NONE',
      price,
      timestamp: Date.now(),
      indicators: ind,
      conditions: {
        emaCross: false,
        rsiConfirm: false,
        mfiConfirm: false,
        trendAlign: false,
        volumeConfirm: false,
        conditionsMet: Math.max(longScore, shortScore),
      },
      suggestedLeverage: leverage,
      stopLoss: 0,
      takeProfit: 0,
    };
  }

  // ─── TRADE EXECUTION ──────────────────────────

  private async executeTrade(signal: Signal) {
    try {
      const capital = this.executor.getCurrentCapital();
      await this.executor.openPosition(signal, capital);
    } catch (err) {
      this.logger.error('Trade execution error:', err);
    }
  }

  private async checkOpenPositions() {
    const { toClose } = (this.executor as any).updatePositions(this.currentPrice);

    for (const { position, reason } of toClose) {
      // v3.3: use engine's closePosition() so trades get recorded to adaptive memory
      // Also notify the Regime Transition Detector on SL hits
      if (reason === 'SL') {
        this.onStopLossHit(position.side, position.engine || 'UNKNOWN');
      }
      await this.closePosition(position.id, reason);
    }
  }

  // ─── STATUS DISPLAY ───────────────────────────

  private printStatus() {
    const capital = this.executor.getCurrentCapital();
    const positions = this.executor.getOpenPositions();
    const dailyPnl = this.executor.getDailyPnl();
    const pnlPct = ((capital - this.config.STARTING_CAPITAL) / this.config.STARTING_CAPITAL) * 100;

    const last = this.candles1m[this.candles1m.length - 1];
    const indicators = last ? computeIndicators(this.candles1m, {
      emaFast: this.config.EMA_FAST,
      emaMid: this.config.EMA_MID,
      emaSlow: this.config.EMA_SLOW,
      rsiPeriod: this.config.RSI_PERIOD,
      mfiPeriod: this.config.MFI_PERIOD,
      bbPeriod: this.config.BB_PERIOD,
      bbStddev: this.config.BB_STDDEV,
      atrPeriod: this.config.ATR_PERIOD,
    }) : null;

    const posInfo = positions.length > 0
      ? positions.map(p =>
          `${p.side} $${p.entryPrice.toFixed(0)} → $${this.currentPrice.toFixed(0)} ` +
          `(${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%)`
        ).join(' | ')
      : 'No open positions';

    console.log(
      `\n📊 STATUS | ${new Date().toLocaleTimeString()} | ` +
      `$${this.currentPrice.toFixed(2)} | ` +
      `Capital: $${capital.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) | ` +
      `Daily PnL: $${dailyPnl.toFixed(2)} | ` +
      `Positions: ${positions.length}/${this.config.MAX_CONCURRENT_POSITIONS} | ` +
      `${posInfo}` +
      (indicators ? ` | RSI:${indicators.rsi.toFixed(1)} MFI:${indicators.mfi.toFixed(1)} ATR:${indicators.atr.toFixed(2)}` : '')
    );
  }
}
