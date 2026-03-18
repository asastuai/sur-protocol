// ============================================================
// src/engines/circuit-breaker.ts — v6.0 Circuit Breaker System
// ============================================================
// Problem: Bot keeps trading after consecutive losses, compounding
// damage. 25 trades/day × 90 days = $1,230 in fees.
//
// Three layers of protection:
//  1. Per-engine: 3 SL hits in 6h → pause that engine 12h
//  2. Global daily: max N trades/day across all engines
//  3. Drawdown: if daily loss > X% → stop all trading until next day
// ============================================================

export interface CircuitBreakerConfig {
  // Per-engine circuit breaker
  maxConsecSL: number;          // Default: 3 — consecutive SL hits before pause
  slWindowMs: number;           // Default: 6h — window to count SL hits
  pauseDurationMs: number;      // Default: 12h — how long to pause after breaker trips

  // Global daily limits
  maxTradesPerDay: number;      // Default: 10 — hard cap across all engines
  maxTradesPerEngine: number;   // Default: 4 — per engine per day

  // Drawdown protection
  maxDailyLossPct: number;      // Default: 3% — stop trading if daily loss exceeds this
  maxDailyLossAbs: number;      // Default: $60 — alternative absolute limit

  // Cooling period after losses
  lossStreakCooldownMult: number; // Default: 2.0 — multiply cooldown after 2+ consecutive losses
}

interface SLRecord {
  engine: string;
  timestamp: number;
}

interface TradeRecord {
  engine: string;
  timestamp: number;
  pnl: number;
}

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private slHistory: SLRecord[] = [];
  private tradeHistory: TradeRecord[] = [];
  private pausedEngines: Map<string, number> = new Map(); // engine → resume timestamp
  private dailyPnL = 0;
  private dayStart = 0;
  private globalPaused = false;
  private globalResumeAt = 0;
  private consecutiveLosses: Map<string, number> = new Map(); // engine → streak count

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      maxConsecSL: 3,
      slWindowMs: 6 * 3_600_000,        // 6 hours
      pauseDurationMs: 12 * 3_600_000,   // 12 hours
      maxTradesPerDay: 10,
      maxTradesPerEngine: 4,
      maxDailyLossPct: 3,
      maxDailyLossAbs: 60,
      lossStreakCooldownMult: 2.0,
      ...config,
    };
    this.dayStart = this.getDayStart(Date.now());
  }

  // ─── CHECK: Can this engine trade right now? ───────

  canTrade(engine: string, now: number = Date.now()): { allowed: boolean; reason: string } {
    // Reset daily counters if new day
    this.maybeResetDay(now);

    // 1. Global pause (drawdown breaker)
    if (this.globalPaused && now < this.globalResumeAt) {
      const minsLeft = Math.round((this.globalResumeAt - now) / 60_000);
      return { allowed: false, reason: `🔴 GLOBAL PAUSE: daily loss limit hit. Resume in ${minsLeft}min` };
    }
    if (this.globalPaused && now >= this.globalResumeAt) {
      this.globalPaused = false;
    }

    // 2. Per-engine pause
    const enginePauseUntil = this.pausedEngines.get(engine);
    if (enginePauseUntil && now < enginePauseUntil) {
      const minsLeft = Math.round((enginePauseUntil - now) / 60_000);
      return { allowed: false, reason: `🔴 ${engine} PAUSED: ${this.config.maxConsecSL} consecutive SLs. Resume in ${minsLeft}min` };
    }
    if (enginePauseUntil && now >= enginePauseUntil) {
      this.pausedEngines.delete(engine);
      this.slHistory = this.slHistory.filter(r => r.engine !== engine);
      this.consecutiveLosses.set(engine, 0);
    }

    // 3. Global daily trade limit
    const todayTrades = this.tradeHistory.filter(t => t.timestamp >= this.dayStart);
    if (todayTrades.length >= this.config.maxTradesPerDay) {
      return { allowed: false, reason: `🔴 DAILY LIMIT: ${todayTrades.length}/${this.config.maxTradesPerDay} trades today` };
    }

    // 4. Per-engine daily limit
    const engineTodayTrades = todayTrades.filter(t => t.engine === engine);
    if (engineTodayTrades.length >= this.config.maxTradesPerEngine) {
      return { allowed: false, reason: `🔴 ${engine} daily limit: ${engineTodayTrades.length}/${this.config.maxTradesPerEngine}` };
    }

    return { allowed: true, reason: 'OK' };
  }

  // ─── RECORD: Trade completed ───────────────────────

  recordTrade(engine: string, pnl: number, closeReason: string, now: number = Date.now()) {
    this.maybeResetDay(now);

    // Record trade
    this.tradeHistory.push({ engine, timestamp: now, pnl });

    // Update daily PnL
    this.dailyPnL += pnl;

    // Track consecutive losses per engine
    if (pnl < 0) {
      const streak = (this.consecutiveLosses.get(engine) || 0) + 1;
      this.consecutiveLosses.set(engine, streak);
    } else {
      this.consecutiveLosses.set(engine, 0);
    }

    // Track SL hits for per-engine breaker
    if (closeReason === 'SL' || closeReason === 'LIQUIDATION') {
      this.slHistory.push({ engine, timestamp: now });

      // Count SLs for this engine in the window
      const windowStart = now - this.config.slWindowMs;
      const recentSLs = this.slHistory.filter(
        r => r.engine === engine && r.timestamp >= windowStart
      );

      if (recentSLs.length >= this.config.maxConsecSL) {
        // TRIP: Pause this engine
        const resumeAt = now + this.config.pauseDurationMs;
        this.pausedEngines.set(engine, resumeAt);
        console.log(
          `⚡ CIRCUIT BREAKER: ${engine} paused for ${this.config.pauseDurationMs / 3_600_000}h` +
          ` (${recentSLs.length} SLs in ${this.config.slWindowMs / 3_600_000}h window)`
        );
      }
    }

    // Check daily drawdown breaker
    if (this.dailyPnL < -this.config.maxDailyLossAbs) {
      this.globalPaused = true;
      // Resume at start of next day (UTC)
      this.globalResumeAt = this.dayStart + 86_400_000;
      console.log(
        `🚨 DRAWDOWN BREAKER: Daily loss $${Math.abs(this.dailyPnL).toFixed(2)}` +
        ` exceeds limit $${this.config.maxDailyLossAbs}. All trading paused until next day.`
      );
    }

    // Cleanup old history (keep last 7 days)
    const cutoff = now - 7 * 86_400_000;
    this.tradeHistory = this.tradeHistory.filter(t => t.timestamp >= cutoff);
    this.slHistory = this.slHistory.filter(r => r.timestamp >= cutoff);
  }

  // ─── QUERY: Get cooldown multiplier for an engine ──

  /**
   * Returns a multiplier (1.0 - 3.0) for engine cooldowns.
   * After consecutive losses, we slow down that engine.
   */
  getCooldownMultiplier(engine: string): number {
    const streak = this.consecutiveLosses.get(engine) || 0;
    if (streak >= 2) return this.config.lossStreakCooldownMult;
    return 1.0;
  }

  // ─── QUERY: Get daily stats ────────────────────────

  getDailyStats(now: number = Date.now()) {
    this.maybeResetDay(now);
    const todayTrades = this.tradeHistory.filter(t => t.timestamp >= this.dayStart);
    const byEngine = new Map<string, number>();
    for (const t of todayTrades) {
      byEngine.set(t.engine, (byEngine.get(t.engine) || 0) + 1);
    }
    return {
      totalTrades: todayTrades.length,
      maxTrades: this.config.maxTradesPerDay,
      remaining: Math.max(0, this.config.maxTradesPerDay - todayTrades.length),
      dailyPnL: this.dailyPnL,
      pausedEngines: [...this.pausedEngines.entries()].map(([e, t]) => ({
        engine: e,
        resumeAt: new Date(t).toISOString(),
        minsLeft: Math.max(0, Math.round((t - now) / 60_000)),
      })),
      globalPaused: this.globalPaused,
      tradesByEngine: Object.fromEntries(byEngine),
      consecutiveLosses: Object.fromEntries(this.consecutiveLosses),
    };
  }

  // ─── INTERNALS ─────────────────────────────────────

  private getDayStart(ts: number): number {
    const d = new Date(ts);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }

  private maybeResetDay(now: number) {
    const todayStart = this.getDayStart(now);
    if (todayStart > this.dayStart) {
      this.dayStart = todayStart;
      this.dailyPnL = 0;
      // Don't reset engine pauses — they have their own timer
      // Don't reset SL history — the window handles expiry
    }
  }
}
