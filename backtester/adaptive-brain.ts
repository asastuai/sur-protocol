// ============================================================
// adaptive-brain.ts — Learning Agent for Aster Bot v2.1
// 
// v2.1 FIX: Brain is ADVISOR, not GATEKEEPER
//   - NEVER blocks trades — only adjusts sizing (0.4x to 1.8x)
//   - Observation phase: first 100 trades → no adjustments
//   - Kelly floor: even negative Kelly gives 0.6x (not 0x)
//   - Additive penalties with floor (no multiplicative stacking)
//   - Portfolio gate: only reduces size, never blocks
//   - Fix: conditional reset (preserves memory between runs)
//
// v2.0 features retained:
//   - Differential Sharpe Ratio (DSR) as primary metric
//   - Half-Kelly Criterion for optimal sizing
//   - Temporal decay on buckets
//   - Adaptive bucket tiers by trade count
//   - Normalized weighted-average scoring
//   - Anti-oscillation lockout, proven whitelist
//   - Uses candle timestamps (not Date.now())
// ============================================================

import { writeFileSync, readFileSync, existsSync } from 'fs';

// ── Types ──

export interface MarketSnapshot {
  price: number;
  atrPct: number;
  atrRatio: number;
  rsi: number;
  mfi: number;
  regime: string;
  emaAlignment: string;
  ema21Slope: number;
  momentum1h: number;
  momentum4h: number;
  distToSupport: number;
  distToResistance: number;
  specialEvent: string;
  volumeRatio: number;
  volumeTrend: string;
  macroTrend: string;
  macroScore: number;
  side: string;
  engine: string;
  confidence: number;
  utcHour: number;
  dayOfWeek: number;
  recentWR: number;
  streakCount: number;
}

export interface TradeMemory {
  id: string;
  snapshot: MarketSnapshot;
  outcome: {
    isWin: boolean;
    netPnl: number;
    netPnlPct: number;
    holdTimeMin: number;
    exitReason: string;
    maxFavorable: number;
    maxAdverse: number;
  };
  timestamp: number;
}

export interface BrainDecision {
  qualityScore: number;      // 0-100: informational score (does NOT gate trades)
  confidence: number;        // 0-1: how much data the brain has
  shouldTrade: boolean;      // v2.1: ALWAYS TRUE — brain never blocks
  marginMultiplier: number;  // 0.4-1.8: size adjustment (never zero)
  slMultiplier: number;      // 0.8-1.2: SL distance adjustment
  tpMultiplier: number;      // 0.8-1.2: TP distance adjustment
  reasons: string[];
}

// ── Feature Bucketing ──

type BucketKey = string;

function computeBucketLabels(snapshot: MarketSnapshot) {
  const rsiBucket = snapshot.rsi < 30 ? 'oversold'
    : snapshot.rsi < 40 ? 'low'
    : snapshot.rsi < 60 ? 'neutral'
    : snapshot.rsi < 70 ? 'high'
    : 'overbought';

  const volBucket = snapshot.atrRatio < 0.7 ? 'compressed'
    : snapshot.atrRatio < 1.0 ? 'low'
    : snapshot.atrRatio < 1.3 ? 'normal'
    : snapshot.atrRatio < 1.8 ? 'high'
    : 'extreme';

  const momBucket = snapshot.momentum1h < -1.0 ? 'strong_down'
    : snapshot.momentum1h < -0.3 ? 'down'
    : snapshot.momentum1h < 0.3 ? 'flat'
    : snapshot.momentum1h < 1.0 ? 'up'
    : 'strong_up';

  const timeBucket = snapshot.utcHour < 4 ? 'asia_night'
    : snapshot.utcHour < 8 ? 'asia_day'
    : snapshot.utcHour < 12 ? 'europe_morning'
    : snapshot.utcHour < 16 ? 'us_overlap'
    : snapshot.utcHour < 20 ? 'us_afternoon'
    : 'evening';

  const confBucket = snapshot.confidence < 40 ? 'low'
    : snapshot.confidence < 60 ? 'med'
    : snapshot.confidence < 80 ? 'high'
    : 'very_high';

  const streakBucket = snapshot.streakCount >= 3 ? 'hot_streak'
    : snapshot.streakCount >= 1 ? 'winning'
    : snapshot.streakCount <= -3 ? 'cold_streak'
    : snapshot.streakCount <= -1 ? 'losing'
    : 'neutral';

  const structBucket = snapshot.distToSupport < 0.3 ? 'near_support'
    : snapshot.distToResistance < 0.3 ? 'near_resistance'
    : 'mid_range';

  const macroAligned =
    (snapshot.macroTrend.includes('BULL') && snapshot.side === 'LONG') ||
    (snapshot.macroTrend.includes('BEAR') && snapshot.side === 'SHORT');

  return {
    rsiBucket, volBucket, momBucket, timeBucket, confBucket,
    streakBucket, structBucket, macroAligned,
  };
}

function adaptiveBucketize(snapshot: MarketSnapshot, totalTrades: number): BucketKey[] {
  const keys: BucketKey[] = [];
  const lb = computeBucketLabels(snapshot);

  // Tier 1: Always active
  keys.push(`side:${snapshot.side}`);
  keys.push(`regime:${snapshot.regime}|side:${snapshot.side}`);
  keys.push(`engine:${snapshot.engine}`);
  keys.push(`macro_aligned:${lb.macroAligned}|side:${snapshot.side}`);

  // Tier 2: After 50 trades
  if (totalTrades >= 50) {
    keys.push(`rsi:${lb.rsiBucket}|side:${snapshot.side}`);
    keys.push(`vol:${lb.volBucket}|side:${snapshot.side}`);
    keys.push(`time:${lb.timeBucket}|side:${snapshot.side}`);
    keys.push(`voltrd:${snapshot.volumeTrend}|side:${snapshot.side}`);
    keys.push(`ema:${snapshot.emaAlignment}|side:${snapshot.side}`);
  }

  // Tier 3: After 150 trades
  if (totalTrades >= 150) {
    keys.push(`engine:${snapshot.engine}|regime:${snapshot.regime}`);
    keys.push(`mom1h:${lb.momBucket}|side:${snapshot.side}`);
    keys.push(`struct:${lb.structBucket}|side:${snapshot.side}`);
    keys.push(`conf:${lb.confBucket}|side:${snapshot.side}`);
    keys.push(`streak:${lb.streakBucket}`);
    keys.push(`dow:${snapshot.dayOfWeek}|side:${snapshot.side}`);
  }

  // Tier 4: After 500 trades
  if (totalTrades >= 500) {
    keys.push(`compound:${snapshot.regime}|${lb.volBucket}|${lb.momBucket}|${snapshot.side}`);
    keys.push(`macro_aligned:${lb.macroAligned}|engine:${snapshot.engine}`);
  }

  return keys;
}

// ── Bucket Statistics ──

interface BucketStats {
  effectiveWins: number;
  effectiveLosses: number;
  totalPnl: number;
  avgWinPnl: number;
  avgLossPnl: number;
  avgHoldMin: number;
  lastUpdate: number;
  lastDecayTime: number;
  ewmaWR: number;
  ewmaPnl: number;
  dsrA: number;
  dsrB: number;
  ewmaSharpe: number;
  verdictFlips: number;
  lastVerdict: string;
  lockedUntilTrade: number;
  isProven: boolean;
  provenSince: number;
}

function newBucketStats(): BucketStats {
  return {
    effectiveWins: 0, effectiveLosses: 0, totalPnl: 0,
    avgWinPnl: 0, avgLossPnl: 0, avgHoldMin: 0,
    lastUpdate: 0, lastDecayTime: 0,
    ewmaWR: 0.5, ewmaPnl: 0,
    dsrA: 0, dsrB: 0, ewmaSharpe: 0,
    verdictFlips: 0, lastVerdict: 'neutral', lockedUntilTrade: 0,
    isProven: false, provenSince: 0,
  };
}

function updateDSR(bucket: BucketStats, returnPct: number, eta: number): number {
  const prevA = bucket.dsrA;
  const prevB = bucket.dsrB;
  bucket.dsrA = prevA + eta * (returnPct - prevA);
  bucket.dsrB = prevB + eta * (returnPct * returnPct - prevB);
  const denom = prevB - prevA * prevA;
  if (denom <= 0.0001) {
    bucket.ewmaSharpe = returnPct > 0 ? 0.5 : -0.5;
    return bucket.ewmaSharpe;
  }
  const dsr = (prevB * returnPct - 0.5 * prevA * returnPct * returnPct) / Math.pow(denom, 1.5);
  bucket.ewmaSharpe = bucket.ewmaSharpe * (1 - eta) + dsr * eta;
  return bucket.ewmaSharpe;
}

function applyBucketDecay(bucket: BucketStats, now: number, decayPerDay: number) {
  const msSinceDecay = now - bucket.lastDecayTime;
  if (msSinceDecay < 86_400_000) return;
  const days = msSinceDecay / 86_400_000;
  const factor = Math.pow(decayPerDay, days);
  bucket.effectiveWins *= factor;
  bucket.effectiveLosses *= factor;
  bucket.lastDecayTime = now;
}

function updateVerdict(bucket: BucketStats, totalTrades: number) {
  const n = bucket.effectiveWins + bucket.effectiveLosses;
  if (n < 5) return;
  const newVerdict = bucket.ewmaSharpe > 0.1 ? 'good'
    : bucket.ewmaSharpe < -0.1 ? 'bad' : 'neutral';
  if (newVerdict !== 'neutral' && bucket.lastVerdict !== 'neutral' && newVerdict !== bucket.lastVerdict) {
    bucket.verdictFlips++;
    if (bucket.verdictFlips >= 3) {
      bucket.lockedUntilTrade = totalTrades + 100;
      bucket.verdictFlips = 0;
    }
  }
  bucket.lastVerdict = newVerdict;
}

function updateProvenStatus(bucket: BucketStats, recentPnls: number[], totalTrades: number) {
  const n = bucket.effectiveWins + bucket.effectiveLosses;
  if (n < 50) { bucket.isProven = false; return; }

  if (recentPnls.length < 20) return;
  const mean = recentPnls.reduce((s, v) => s + v, 0) / recentPnls.length;
  const variance = recentPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / recentPnls.length;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? mean / std : 0;

  let peak = 0, maxDD = 0, cum = 0;
  for (const pnl of recentPnls) {
    cum += pnl;
    if (cum > peak) peak = cum;
    const dd = peak > 0 ? (peak - cum) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  if (!bucket.isProven) {
    if (sharpe > 0.5 && maxDD < 0.30) {
      bucket.isProven = true;
      bucket.provenSince = totalTrades;
    }
  } else {
    if (sharpe < -0.3) bucket.isProven = false;
  }
}

// ── Half-Kelly ──

function computeKellyFraction(wr: number, avgWin: number, avgLoss: number): number {
  if (avgLoss === 0 || wr <= 0 || wr >= 1) return 0;
  const R = Math.abs(avgWin) / Math.abs(avgLoss);
  const kelly = wr - (1 - wr) / R;
  return kelly * 0.5; // CAN BE NEGATIVE — caller handles floor
}


// ════════════════════════════════════════════════════════════
// THE ADAPTIVE BRAIN v2.1 — ADVISOR, NOT GATEKEEPER
// ════════════════════════════════════════════════════════════

export class AdaptiveBrain {
  private memories: TradeMemory[] = [];
  private buckets: Map<BucketKey, BucketStats> = new Map();

  private globalStats = {
    totalTrades: 0,
    totalWins: 0,
    totalPnl: 0,
    bestDay: 0,
    worstDay: 0,
    currentStreak: 0,
    dailyPnl: 0,
    dailyTrades: 0,
    lastDayStart: 0,
    rollingWR: [] as boolean[],
    rollingPnl: [] as number[],
    globalDsrA: 0,
    globalDsrB: 0,
    rollingSharpe: 0,
  };

  private regimePerformance: Map<string, { wins: number; losses: number; pnl: number }> = new Map();
  private hourlyPerformance: number[][] = Array.from({ length: 24 }, () => []);
  private enginePerformance: Map<string, {
    wins: number; losses: number; pnl: number;
    bestSlMult: number; bestTpRR: number;
    adaptiveSL: number; adaptiveTP: number;
    dsrA: number; dsrB: number; ewmaSharpe: number;
  }> = new Map();

  private config = {
    minSamplesTier1: 5,
    minSamplesTier2: 8,
    minSamplesTier3: 12,
    minSamplesTier4: 20,
    ewmaAlpha: 0.08,
    maxMemorySize: 5000,
    decayPerDay: 0.997,
    memoryFile: './brain-memory.json',

    // v2.1: ADVISOR config — NEVER blocks, only sizes
    observationTrades: 100,       // first 100 trades: sizing = 1.0, just observes
    marginMultFloor: 0.4,         // HARD FLOOR: never below 0.4x
    marginMultCeiling: 1.8,       // never above 1.8x
    kellyNegativeFloor: 0.6,      // negative Kelly → 0.6x (not 0x)
    inertiaTradesFullConf: 250,   // full brain confidence at 250 trades
    maxPenaltyFromScore: 0.4,     // additive penalties capped at 0.4
    provenMinMarginMult: 0.7,     // proven buckets never below 0.7x
  };

  private simTime: number = 0;

  constructor(memoryFile?: string) {
    if (memoryFile) this.config.memoryFile = memoryFile;

    // Allow env var overrides for lab experiments
    if (process.env.BRAIN_OBS_TRADES)
      this.config.observationTrades = parseInt(process.env.BRAIN_OBS_TRADES);
    if (process.env.BRAIN_MARGIN_FLOOR)
      this.config.marginMultFloor = parseFloat(process.env.BRAIN_MARGIN_FLOOR);
    if (process.env.BRAIN_MARGIN_CEIL)
      this.config.marginMultCeiling = parseFloat(process.env.BRAIN_MARGIN_CEIL);
    if (process.env.BRAIN_KELLY_FLOOR)
      this.config.kellyNegativeFloor = parseFloat(process.env.BRAIN_KELLY_FLOOR);
    if (process.env.BRAIN_INERTIA_TRADES)
      this.config.inertiaTradesFullConf = parseInt(process.env.BRAIN_INERTIA_TRADES);
    if (process.env.BRAIN_MAX_PENALTY)
      this.config.maxPenaltyFromScore = parseFloat(process.env.BRAIN_MAX_PENALTY);

    this.loadMemory();
  }

  // ════════════════════════════════════════════════════════════
  // 1. OBSERVE
  // ════════════════════════════════════════════════════════════

  extractSnapshot(params: {
    price: number; c5m: any[]; c1m: any[];
    brainState: any; macroState: any; signal: any; structState?: any;
  }): MarketSnapshot {
    const { price, c5m, c1m, brainState, macroState, signal, structState } = params;

    let atr14 = 0, atr50 = 0;
    if (c5m.length > 15) {
      const trs14: number[] = [];
      for (let i = Math.max(1, c5m.length - 15); i < c5m.length; i++) {
        trs14.push(Math.max(c5m[i].high - c5m[i].low,
          Math.abs(c5m[i].high - c5m[i - 1].close),
          Math.abs(c5m[i].low - c5m[i - 1].close)));
      }
      atr14 = trs14.reduce((s, v) => s + v, 0) / trs14.length;
    }
    if (c5m.length > 51) {
      const trs50: number[] = [];
      for (let i = Math.max(1, c5m.length - 51); i < c5m.length; i++) {
        trs50.push(Math.max(c5m[i].high - c5m[i].low,
          Math.abs(c5m[i].high - c5m[i - 1].close),
          Math.abs(c5m[i].low - c5m[i - 1].close)));
      }
      atr50 = trs50.reduce((s, v) => s + v, 0) / trs50.length;
    }

    const m1h = c1m.length >= 60
      ? ((price - c1m[c1m.length - 60].close) / c1m[c1m.length - 60].close) * 100 : 0;
    const m4h = c1m.length >= 240
      ? ((price - c1m[c1m.length - 240].close) / c1m[c1m.length - 240].close) * 100 : 0;

    let mfi = 50;
    if (c5m.length > 15) {
      let pos = 0, neg = 0;
      for (let i = c5m.length - 14; i < c5m.length; i++) {
        const tp = (c5m[i].high + c5m[i].low + c5m[i].close) / 3;
        const ptp = (c5m[i - 1].high + c5m[i - 1].low + c5m[i - 1].close) / 3;
        const mf = tp * c5m[i].volume;
        if (tp > ptp) pos += mf; else neg += mf;
      }
      mfi = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    }

    const now = c1m[c1m.length - 1]?.closeTime || this.simTime || Date.now();
    const d = new Date(now);

    return {
      price,
      atrPct: price > 0 ? (atr14 / price) * 100 : 0,
      atrRatio: atr50 > 0 ? atr14 / atr50 : 1,
      rsi: brainState?.metrics?.rsi_5m ?? 50,
      mfi,
      regime: brainState?.regime ?? 'CHOP',
      emaAlignment: structState?.context?.emaAlignment ?? 'FLAT',
      ema21Slope: structState?.context?.ema21Slope ?? 0,
      momentum1h: m1h,
      momentum4h: m4h,
      distToSupport: structState?.priceDistToSupport ?? 99,
      distToResistance: structState?.priceDistToResistance ?? 99,
      specialEvent: brainState?.specialEvent ?? 'NONE',
      volumeRatio: structState?.volumeRatio ?? 1,
      volumeTrend: structState?.volumeTrend ?? 'FLAT',
      macroTrend: macroState?.trend ?? 'NEUTRAL',
      macroScore: macroState?.score ?? 0,
      side: signal.side,
      engine: signal.engine,
      confidence: signal.confidence ?? 50,
      utcHour: d.getUTCHours(),
      dayOfWeek: d.getUTCDay(),
      recentWR: this.getRecentWR(),
      streakCount: this.globalStats.currentStreak,
    };
  }

  // ════════════════════════════════════════════════════════════
  // 2. DECIDE — v2.1: ADVISOR ONLY, never blocks
  //
  // shouldTrade is ALWAYS true.
  // Brain's ONLY job: set marginMultiplier between [0.4, 1.8]
  //
  // During observation phase (first 100 trades): marginMult = 1.0
  // After observation: marginMult based on DSR + Kelly + context
  // ════════════════════════════════════════════════════════════

  evaluate(snapshot: MarketSnapshot): BrainDecision {
    const reasons: string[] = [];
    const totalTrades = this.globalStats.totalTrades;

    // ══════════════════════════════════════════
    // OBSERVATION PHASE: first N trades → passthrough
    // Brain only collects data, does NOT modify sizing
    // ══════════════════════════════════════════
    if (totalTrades < this.config.observationTrades) {
      reasons.push(`👁️ Observing: ${totalTrades}/${this.config.observationTrades}`);
      return {
        qualityScore: 50,
        confidence: 0,
        shouldTrade: true,
        marginMultiplier: 1.0,
        slMultiplier: 1.0,
        tpMultiplier: 1.0,
        reasons,
      };
    }

    // ══════════════════════════════════════════
    // POST-OBSERVATION: Brain advises on sizing
    // ══════════════════════════════════════════

    const brainConf = Math.min(1.0,
      (totalTrades - this.config.observationTrades) /
      (this.config.inertiaTradesFullConf - this.config.observationTrades));

    const keys = adaptiveBucketize(snapshot, totalTrades);

    // ── Collect signals from buckets ──
    const signals: { value: number; weight: number; source: string; isProven: boolean }[] = [];

    for (const key of keys) {
      const stats = this.buckets.get(key);
      if (!stats) continue;

      applyBucketDecay(stats, this.simTime, this.config.decayPerDay);

      const n = stats.effectiveWins + stats.effectiveLosses;
      const minSamples = key.includes('compound:') ? this.config.minSamplesTier4
        : key.includes('|') && !key.startsWith('side:') && !key.startsWith('regime:')
          && !key.startsWith('engine:') && !key.startsWith('macro_aligned:')
          ? this.config.minSamplesTier2
        : this.config.minSamplesTier1;

      if (n < minSamples) continue;
      if (stats.lockedUntilTrade > totalTrades) continue;

      const wr = stats.ewmaWR;
      const expectancy = wr * Math.abs(stats.avgWinPnl) - (1 - wr) * Math.abs(stats.avgLossPnl);
      const dsrSignal = Math.max(-1, Math.min(1, stats.ewmaSharpe));
      const expectancySignal = Math.max(-1, Math.min(1, expectancy * 5));
      const signal = dsrSignal * 0.6 + expectancySignal * 0.4;

      const sizeWeight = 1 - 1 / (1 + n / 30);
      const recencyMs = this.simTime - stats.lastUpdate;
      const recencyWeight = Math.exp(-recencyMs / (30 * 86_400_000));
      const weight = sizeWeight * recencyWeight;

      signals.push({ value: signal, weight, source: key, isProven: stats.isProven });

      if (Math.abs(signal) > 0.3 && weight > 0.3) {
        const dir = signal > 0 ? '✅' : '⚠️';
        const keyShort = key.split('|')[0];
        reasons.push(`${dir} ${keyShort}: DSR=${dsrSignal.toFixed(2)} exp=${expectancy.toFixed(1)} (n≈${Math.round(n)})`);
      }
    }

    // ── Quality score (informational, does NOT gate) ──
    let rawScore = 50;
    if (signals.length > 0) {
      const totalWeight = signals.reduce((s, sig) => s + sig.weight, 0);
      const weightedAvg = signals.reduce((s, sig) => s + sig.value * sig.weight, 0) / totalWeight;
      rawScore = 50 + weightedAvg * 50;
    }
    let score = 50 * (1 - brainConf) + rawScore * brainConf;

    // Context adjustments
    const regPerf = this.regimePerformance.get(snapshot.regime);
    if (regPerf && (regPerf.wins + regPerf.losses) >= 15) {
      const regWR = regPerf.wins / (regPerf.wins + regPerf.losses);
      const regAvgPnl = regPerf.pnl / (regPerf.wins + regPerf.losses);
      if (regWR < 0.38 && regAvgPnl < 0) {
        score -= 8 * brainConf;
        reasons.push(`⚠️ Regime ${snapshot.regime}: WR=${(regWR * 100).toFixed(0)}%`);
      } else if (regWR > 0.55 && regAvgPnl > 0) {
        score += 6 * brainConf;
      }
    }

    const hourData = this.hourlyPerformance[snapshot.utcHour];
    if (hourData.length >= 15) {
      const hourWR = hourData.filter(p => p > 0).length / hourData.length;
      const hourAvg = hourData.reduce((s, v) => s + v, 0) / hourData.length;
      if (hourWR < 0.30 && hourAvg < 0) {
        score -= 6 * brainConf;
      } else if (hourWR > 0.55 && hourAvg > 0) {
        score += 4 * brainConf;
      }
    }

    const engPerf = this.enginePerformance.get(snapshot.engine);
    if (engPerf && (engPerf.wins + engPerf.losses) >= 20) {
      if (engPerf.ewmaSharpe < -0.5) score -= 6 * brainConf;
      else if (engPerf.ewmaSharpe > 0.3) score += 4 * brainConf;
    }

    const macroAligned =
      (snapshot.macroTrend.includes('BULL') && snapshot.side === 'LONG') ||
      (snapshot.macroTrend.includes('BEAR') && snapshot.side === 'SHORT');
    const macroContra =
      (snapshot.macroTrend.includes('BULL') && snapshot.side === 'SHORT') ||
      (snapshot.macroTrend.includes('BEAR') && snapshot.side === 'LONG');

    if (macroAligned && Math.abs(snapshot.macroScore) > 30) {
      score += 8 * brainConf;
      reasons.push(`✅ Macro aligned: ${snapshot.macroTrend}+${snapshot.side}`);
    }
    if (macroContra && Math.abs(snapshot.macroScore) > 30) {
      score -= 10 * brainConf;
      reasons.push(`⚠️ Counter-macro: ${snapshot.macroTrend} vs ${snapshot.side}`);
    }

    score = Math.max(0, Math.min(100, score));

    // ══════════════════════════════════════════════════
    // SIZING: Score → marginMultiplier (NEVER blocks)
    //
    // score=50 → 1.0x | score=80 → 1.5x | score=20 → 0.5x
    // score=0  → 0.4x (FLOOR — still trades!)
    // ══════════════════════════════════════════════════

    let marginMult = this.config.marginMultFloor +
      (score / 100) * (this.config.marginMultCeiling - this.config.marginMultFloor);

    // Kelly refinement
    const kellySignals: { kelly: number; weight: number }[] = [];
    for (const key of keys) {
      const stats = this.buckets.get(key);
      if (!stats) continue;
      const n = stats.effectiveWins + stats.effectiveLosses;
      if (n < 15) continue;
      const hk = computeKellyFraction(stats.ewmaWR, stats.avgWinPnl, stats.avgLossPnl);
      const w = 1 - 1 / (1 + n / 50);
      kellySignals.push({ kelly: hk, weight: w });
    }

    if (kellySignals.length > 0) {
      const totalW = kellySignals.reduce((s, k) => s + k.weight, 0);
      const avgKelly = kellySignals.reduce((s, k) => s + k.kelly * k.weight, 0) / totalW;

      // v2.1: Kelly MODULATES sizing, doesn't replace it
      // Positive Kelly → boost up to 1.8x
      // Negative Kelly → floor at 0.6x (NOT zero)
      let kellyMod: number;
      if (avgKelly > 0) {
        kellyMod = 1.0 + avgKelly * 3.0;
        kellyMod = Math.min(kellyMod, 1.8);
      } else {
        kellyMod = Math.max(this.config.kellyNegativeFloor, 1.0 + avgKelly * 2.0);
      }

      // Blend score-based and kelly-based sizing
      marginMult = marginMult * (1 - brainConf * 0.5) + kellyMod * (brainConf * 0.5);

      if (avgKelly < -0.01) {
        reasons.push(`📉 Kelly: ${(avgKelly * 100).toFixed(1)}% → ${kellyMod.toFixed(2)}x`);
      } else if (avgKelly > 0.03) {
        reasons.push(`📈 Kelly: ${(avgKelly * 100).toFixed(1)}% → ${kellyMod.toFixed(2)}x`);
      }
    }

    // ── Context penalties (ADDITIVE with cap, not multiplicative) ──
    let penalty = 0;

    if (this.globalStats.dailyPnl < -15) {
      penalty += 0.25;
      reasons.push(`🛑 Daily loss $${this.globalStats.dailyPnl.toFixed(0)}`);
    } else if (this.globalStats.dailyPnl < -8) {
      penalty += 0.10;
    }

    if (snapshot.streakCount <= -4) {
      penalty += 0.15;
      reasons.push(`⚠️ Streak: ${snapshot.streakCount}`);
    } else if (snapshot.streakCount <= -2) {
      penalty += 0.05;
    }

    if (macroContra && Math.abs(snapshot.macroScore) > 40) penalty += 0.15;
    if (snapshot.atrRatio < 0.6) penalty += 0.10;

    // Cap total penalty at maxPenaltyFromScore
    penalty = Math.min(penalty, this.config.maxPenaltyFromScore);
    marginMult -= penalty;

    // Proven bucket protection
    const hasProvenBucket = signals.some(s => s.isProven && s.value > 0);
    if (hasProvenBucket) {
      marginMult = Math.max(marginMult, this.config.provenMinMarginMult);
    }

    // SL/TP from engine performance
    let slMult = 1.0, tpMult = 1.0;
    if (engPerf && (engPerf.wins + engPerf.losses) >= 25) {
      if (engPerf.adaptiveSL > 0) slMult = engPerf.adaptiveSL;
      if (engPerf.adaptiveTP > 0) tpMult = engPerf.adaptiveTP;
    }
    if (snapshot.atrRatio > 2.0) { slMult *= 1.15; tpMult *= 1.15; }

    // HARD CLAMP
    marginMult = Math.max(this.config.marginMultFloor, Math.min(this.config.marginMultCeiling, marginMult));
    slMult = Math.max(0.8, Math.min(1.2, slMult));
    tpMult = Math.max(0.8, Math.min(1.2, tpMult));

    const dataConf = signals.length > 0
      ? Math.min(1.0, signals.reduce((s, sig) => s + sig.weight, 0) / 3)
      : 0;
    const sampleConf = Math.min(1.0, totalTrades / 200);
    const decisionConf = dataConf * 0.6 + sampleConf * 0.4;

    return {
      qualityScore: Math.round(score),
      confidence: decisionConf,
      shouldTrade: true,               // v2.1: ALWAYS TRUE
      marginMultiplier: marginMult,
      slMultiplier: slMult,
      tpMultiplier: tpMult,
      reasons: reasons.slice(0, 8),
    };
  }

  // ════════════════════════════════════════════════════════════
  // 2b. PORTFOLIO SIZING — v2.1: only adjusts, never blocks
  // ════════════════════════════════════════════════════════════

  evaluatePortfolioImpact(
    snapshot: MarketSnapshot,
    openPositions: { side: string; engine: string; margin: number; leverage: number }[],
    capital: number,
  ): { sizeMult: number; reason: string } {
    let mult = 1.0;
    const reasons: string[] = [];

    const sameSide = openPositions.filter(p => p.side === snapshot.side).length;
    const sameEngine = openPositions.filter(p => p.engine === snapshot.engine).length;

    if (sameSide >= 2) { mult *= 0.6; reasons.push(`${sameSide} same-side`); }
    else if (sameSide >= 1) mult *= 0.8;
    if (sameEngine >= 1) mult *= 0.85;

    const totalExposure = openPositions.reduce((s, p) => s + p.margin * p.leverage, 0);
    const maxExposure = capital * 0.35;
    if (totalExposure >= maxExposure) {
      mult *= 0.3;
      reasons.push('near max exposure');
    } else {
      const ratio = totalExposure / maxExposure;
      if (ratio > 0.7) mult *= (1.1 - ratio);
    }

    // v2.1: Floor at 0.3 — NEVER zero
    mult = Math.max(0.3, mult);

    return { sizeMult: mult, reason: reasons.join('; ') || 'OK' };
  }

  // ════════════════════════════════════════════════════════════
  // 3. LEARN
  // ════════════════════════════════════════════════════════════

  learn(params: {
    snapshot: MarketSnapshot;
    trade: {
      id: string; netPnl: number; holdTimeMin: number;
      exitReason: string; maxFavorable?: number; maxAdverse?: number;
      margin?: number;
    };
    timestamp: number;
  }) {
    const { snapshot, trade, timestamp } = params;
    const isWin = trade.netPnl > 0;
    const margin = trade.margin || 100;
    const returnPct = trade.netPnl / margin;

    const memory: TradeMemory = {
      id: trade.id, snapshot,
      outcome: {
        isWin, netPnl: trade.netPnl, netPnlPct: returnPct,
        holdTimeMin: trade.holdTimeMin, exitReason: trade.exitReason,
        maxFavorable: trade.maxFavorable ?? 0, maxAdverse: trade.maxAdverse ?? 0,
      },
      timestamp,
    };

    this.memories.push(memory);
    if (this.memories.length > this.config.maxMemorySize) {
      this.memories = this.memories.slice(-this.config.maxMemorySize);
    }

    const gs = this.globalStats;
    gs.totalTrades++;
    if (isWin) gs.totalWins++;
    gs.totalPnl += trade.netPnl;

    if (isWin) gs.currentStreak = gs.currentStreak >= 0 ? gs.currentStreak + 1 : 1;
    else gs.currentStreak = gs.currentStreak <= 0 ? gs.currentStreak - 1 : -1;

    const dayStart = Math.floor(timestamp / 86_400_000) * 86_400_000;
    if (dayStart > gs.lastDayStart) {
      if (gs.dailyPnl > gs.bestDay) gs.bestDay = gs.dailyPnl;
      if (gs.dailyPnl < gs.worstDay) gs.worstDay = gs.dailyPnl;
      gs.dailyPnl = 0; gs.dailyTrades = 0; gs.lastDayStart = dayStart;
    }
    gs.dailyPnl += trade.netPnl;
    gs.dailyTrades++;

    gs.rollingWR.push(isWin); gs.rollingPnl.push(trade.netPnl);
    if (gs.rollingWR.length > 50) gs.rollingWR.shift();
    if (gs.rollingPnl.length > 50) gs.rollingPnl.shift();

    const eta = this.config.ewmaAlpha;
    gs.globalDsrA += eta * (returnPct - gs.globalDsrA);
    gs.globalDsrB += eta * (returnPct * returnPct - gs.globalDsrB);
    const denom = gs.globalDsrB - gs.globalDsrA * gs.globalDsrA;
    gs.rollingSharpe = denom > 0.0001 ? gs.globalDsrA / Math.sqrt(denom) : (gs.globalDsrA > 0 ? 0.5 : -0.5);

    const keys = adaptiveBucketize(snapshot, gs.totalTrades);
    for (const key of keys) {
      if (!this.buckets.has(key)) this.buckets.set(key, newBucketStats());
      const b = this.buckets.get(key)!;

      applyBucketDecay(b, timestamp, this.config.decayPerDay);

      if (isWin) {
        b.effectiveWins++;
        b.avgWinPnl = b.avgWinPnl === 0 ? trade.netPnl : b.avgWinPnl * 0.9 + trade.netPnl * 0.1;
      } else {
        b.effectiveLosses++;
        b.avgLossPnl = b.avgLossPnl === 0 ? trade.netPnl : b.avgLossPnl * 0.9 + trade.netPnl * 0.1;
      }

      b.totalPnl += trade.netPnl;
      b.avgHoldMin = b.avgHoldMin * 0.9 + trade.holdTimeMin * 0.1;
      b.lastUpdate = timestamp;
      if (b.lastDecayTime === 0) b.lastDecayTime = timestamp;

      b.ewmaWR = b.ewmaWR * (1 - eta) + (isWin ? 1 : 0) * eta;
      b.ewmaPnl = b.ewmaPnl * (1 - eta) + trade.netPnl * eta;

      updateDSR(b, returnPct, eta);
      updateVerdict(b, gs.totalTrades);

      if (gs.totalTrades % 10 === 0) {
        const recentPnls = this.memories.slice(-60)
          .filter(m => adaptiveBucketize(m.snapshot, gs.totalTrades).includes(key))
          .map(m => m.outcome.netPnl);
        updateProvenStatus(b, recentPnls, gs.totalTrades);
      }
    }

    // Regime
    if (!this.regimePerformance.has(snapshot.regime))
      this.regimePerformance.set(snapshot.regime, { wins: 0, losses: 0, pnl: 0 });
    const rp = this.regimePerformance.get(snapshot.regime)!;
    if (isWin) rp.wins++; else rp.losses++;
    rp.pnl += trade.netPnl;

    // Hourly
    this.hourlyPerformance[snapshot.utcHour].push(trade.netPnl);
    if (this.hourlyPerformance[snapshot.utcHour].length > 200)
      this.hourlyPerformance[snapshot.utcHour] = this.hourlyPerformance[snapshot.utcHour].slice(-200);

    // Engine
    if (!this.enginePerformance.has(snapshot.engine)) {
      this.enginePerformance.set(snapshot.engine, {
        wins: 0, losses: 0, pnl: 0, bestSlMult: 1.0, bestTpRR: 1.0,
        adaptiveSL: 1.0, adaptiveTP: 1.0, dsrA: 0, dsrB: 0, ewmaSharpe: 0,
      });
    }
    const ep = this.enginePerformance.get(snapshot.engine)!;
    if (isWin) ep.wins++; else ep.losses++;
    ep.pnl += trade.netPnl;

    ep.dsrA += eta * (returnPct - ep.dsrA);
    ep.dsrB += eta * (returnPct * returnPct - ep.dsrB);
    const epDenom = ep.dsrB - ep.dsrA * ep.dsrA;
    ep.ewmaSharpe = epDenom > 0.0001 ? ep.dsrA / Math.sqrt(epDenom) : (ep.dsrA > 0 ? 0.5 : -0.5);

    if (ep.wins + ep.losses >= 25) {
      const recentMem = this.memories.filter(m => m.snapshot.engine === snapshot.engine).slice(-50);
      if (recentMem.length >= 15) {
        const wins = recentMem.filter(m => m.outcome.isWin);
        const losses = recentMem.filter(m => !m.outcome.isWin);
        if (wins.length > 0 && losses.length > 0) {
          const avgWinMFE = wins.reduce((s, m) => s + m.outcome.maxFavorable, 0) / wins.length;
          const avgLossMAE = losses.reduce((s, m) => s + m.outcome.maxAdverse, 0) / losses.length;
          ep.adaptiveTP = Math.max(0.85, Math.min(1.2, 0.85 + avgWinMFE * 20));
          ep.adaptiveSL = Math.max(0.8, Math.min(1.2, 1.0 + (avgLossMAE - 0.007) * 30));
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // 4. INTROSPECT
  // ════════════════════════════════════════════════════════════

  getInsights(): string {
    const lines: string[] = [];
    const gs = this.globalStats;

    lines.push('═══════════════════════════════════════════');
    lines.push('  🧠 ADAPTIVE BRAIN v2.1 — ADVISOR MODE');
    lines.push('═══════════════════════════════════════════');

    const overallWR = gs.totalTrades > 0 ? (gs.totalWins / gs.totalTrades * 100).toFixed(1) : '?';
    const isObs = gs.totalTrades < this.config.observationTrades;
    lines.push(`\n  Trades learned: ${gs.totalTrades}`);
    lines.push(`  Mode: ${isObs ? '👁️ OBSERVING' : '🎯 ADVISING'} (obs phase: ${this.config.observationTrades})`);
    lines.push(`  WR: ${overallWR}% | PnL: $${gs.totalPnl.toFixed(2)} | Rolling SR: ${this.getRollingSharpe().toFixed(2)}`);
    lines.push(`  Streak: ${gs.currentStreak > 0 ? '+' : ''}${gs.currentStreak} | Buckets: ${this.buckets.size} | Proven: ${[...this.buckets.values()].filter(b => b.isProven).length}`);

    lines.push('\n  📊 TOP CONDITIONS (by Sharpe):');
    const sorted = [...this.buckets.entries()]
      .filter(([_, s]) => (s.effectiveWins + s.effectiveLosses) >= this.config.minSamplesTier1)
      .sort((a, b) => b[1].ewmaSharpe - a[1].ewmaSharpe).slice(0, 8);
    for (const [key, s] of sorted) {
      const n = Math.round(s.effectiveWins + s.effectiveLosses);
      const hk = computeKellyFraction(s.ewmaWR, s.avgWinPnl, s.avgLossPnl);
      lines.push(`    ✅ ${key}: DSR=${s.ewmaSharpe.toFixed(2)} WR=${(s.ewmaWR * 100).toFixed(0)}% HK=${(hk * 100).toFixed(1)}% (n≈${n})${s.isProven ? ' ★' : ''}`);
    }

    lines.push('\n  💀 WORST CONDITIONS:');
    const worst = [...this.buckets.entries()]
      .filter(([_, s]) => (s.effectiveWins + s.effectiveLosses) >= this.config.minSamplesTier1)
      .sort((a, b) => a[1].ewmaSharpe - b[1].ewmaSharpe).slice(0, 8);
    for (const [key, s] of worst) {
      const n = Math.round(s.effectiveWins + s.effectiveLosses);
      lines.push(`    ❌ ${key}: DSR=${s.ewmaSharpe.toFixed(2)} WR=${(s.ewmaWR * 100).toFixed(0)}% (n≈${n})${s.lockedUntilTrade > gs.totalTrades ? ' 🔒' : ''}`);
    }

    lines.push('\n  🌐 REGIME:');
    for (const [r, p] of this.regimePerformance) {
      const t = p.wins + p.losses; if (t < 5) continue;
      lines.push(`    ${r}: WR=${(p.wins / t * 100).toFixed(0)}% avg=$${(p.pnl / t).toFixed(2)} (n=${t})`);
    }

    lines.push('\n  ⚙️ ENGINES:');
    for (const [e, p] of this.enginePerformance) {
      const t = p.wins + p.losses; if (t < 5) continue;
      lines.push(`    ${e}: WR=${(p.wins / t * 100).toFixed(0)}% DSR=${p.ewmaSharpe.toFixed(2)} PnL=$${p.pnl.toFixed(2)} (n=${t}) SL=${p.adaptiveSL.toFixed(2)} TP=${p.adaptiveTP.toFixed(2)}`);
    }

    lines.push(`\n  🔧 Config: Obs=${this.config.observationTrades} Margin=[${this.config.marginMultFloor},${this.config.marginMultCeiling}] KellyFloor=${this.config.kellyNegativeFloor}`);
    lines.push('═══════════════════════════════════════════');
    return lines.join('\n');
  }

  // ════════════════════════════════════════════════════════════
  // 5. PERSIST
  // ════════════════════════════════════════════════════════════

  saveMemory() {
    try {
      const data = {
        version: 3, savedAt: new Date().toISOString(), config: this.config,
        globalStats: this.globalStats, memories: this.memories.slice(-2000),
        buckets: Object.fromEntries(this.buckets),
        regimePerformance: Object.fromEntries(this.regimePerformance),
        hourlyPerformance: this.hourlyPerformance,
        enginePerformance: Object.fromEntries(this.enginePerformance),
      };
      writeFileSync(this.config.memoryFile, JSON.stringify(data, null, 2));
    } catch (e) { /* silent */ }
  }

  loadMemory() {
    try {
      if (!existsSync(this.config.memoryFile)) return;
      const raw = JSON.parse(readFileSync(this.config.memoryFile, 'utf-8'));
      if (raw.version >= 2) {
        this.globalStats = { ...this.globalStats, ...raw.globalStats };
        this.memories = raw.memories || [];
        if (raw.buckets) {
          this.buckets = new Map(Object.entries(raw.buckets));
          for (const [, b] of this.buckets) {
            if (b.dsrA === undefined) { b.dsrA = 0; b.dsrB = 0; b.ewmaSharpe = 0; }
            if (b.effectiveWins === undefined) { b.effectiveWins = (b as any).wins || 0; b.effectiveLosses = (b as any).losses || 0; }
            if (b.lastDecayTime === undefined) b.lastDecayTime = b.lastUpdate || 0;
            if (b.verdictFlips === undefined) { b.verdictFlips = 0; b.lastVerdict = 'neutral'; b.lockedUntilTrade = 0; }
            if (b.isProven === undefined) { b.isProven = false; b.provenSince = 0; }
          }
        }
        if (raw.regimePerformance) this.regimePerformance = new Map(Object.entries(raw.regimePerformance));
        if (raw.hourlyPerformance) this.hourlyPerformance = raw.hourlyPerformance;
        if (raw.enginePerformance) {
          this.enginePerformance = new Map(Object.entries(raw.enginePerformance));
          for (const [, ep] of this.enginePerformance) {
            if (ep.dsrA === undefined) { ep.dsrA = 0; ep.dsrB = 0; ep.ewmaSharpe = 0; }
          }
        }
      }
    } catch (e) { /* start fresh */ }
  }

  // ════════════════════════════════════════════════════════════
  // 6. UTILITIES
  // ════════════════════════════════════════════════════════════

  getRecentWR(): number {
    const rw = this.globalStats.rollingWR;
    if (rw.length < 5) return 0.5;
    return rw.filter(w => w).length / rw.length;
  }

  getRollingSharpe(): number {
    const pnls = this.globalStats.rollingPnl;
    if (pnls.length < 10) return 0;
    const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
    const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length;
    const std = Math.sqrt(variance);
    return std > 0 ? mean / std : 0;
  }

  getMemoryCount(): number { return this.memories.length; }
  getTotalTrades(): number { return this.globalStats.totalTrades; }

  updateDayTracking(timestamp: number) {
    this.simTime = timestamp;
    const dayStart = Math.floor(timestamp / 86_400_000) * 86_400_000;
    if (dayStart > this.globalStats.lastDayStart) {
      if (this.globalStats.dailyPnl > this.globalStats.bestDay) this.globalStats.bestDay = this.globalStats.dailyPnl;
      if (this.globalStats.dailyPnl < this.globalStats.worstDay) this.globalStats.worstDay = this.globalStats.dailyPnl;
      this.globalStats.dailyPnl = 0; this.globalStats.dailyTrades = 0;
      this.globalStats.lastDayStart = dayStart;
    }
  }

  reset() {
    this.memories = [];
    this.buckets = new Map();
    this.regimePerformance = new Map();
    this.hourlyPerformance = Array.from({ length: 24 }, () => []);
    this.enginePerformance = new Map();
    this.simTime = 0;
    this.globalStats = {
      totalTrades: 0, totalWins: 0, totalPnl: 0,
      bestDay: 0, worstDay: 0, currentStreak: 0,
      dailyPnl: 0, dailyTrades: 0, lastDayStart: 0,
      rollingWR: [], rollingPnl: [],
      globalDsrA: 0, globalDsrB: 0, rollingSharpe: 0,
    };
  }
}
