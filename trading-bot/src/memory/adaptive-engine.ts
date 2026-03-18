// ============================================================
// src/memory/adaptive-engine.ts — Parameter Self-Tuning
// v3.2 Adaptive — runs every 30 min, adjusts bounded params
// ============================================================

import type { TradeMemory } from './trade-memory';
import type { PerformanceTracker, EngineStats } from './performance-tracker';

interface Rule {
  engine: string;
  param: string;
  condition: (s: EngineStats) => boolean;
  adjustment: (cur: number, s: EngineStats) => number;
  reason: (s: EngineStats) => string;
  min_sample: number;
  cooldown_ms: number;
}

export class AdaptiveEngine {
  private memory: TradeMemory;
  private tracker: PerformanceTracker;
  private lastRun = 0;
  private readonly RUN_INTERVAL = 1_800_000; // 30 min
  private lastAdjustments = new Map<string, number>();

  constructor(memory: TradeMemory, tracker: PerformanceTracker) {
    this.memory = memory;
    this.tracker = tracker;
    this.initDefaults();
  }

  // ── Initialize all params with defaults + bounds ──
  private initDefaults(): void {
    const init = (e: string, p: string, def: number, min: number, max: number) =>
      this.memory.initParam(e, p, def, min, max);

    // SCALP
    init('SCALP', 'min_confidence',  60, 45, 80);
    init('SCALP', 'max_per_hour',     2,  1,  4);
    init('SCALP', 'sl_atr_mult',    2.0, 1.2, 3.0);
    init('SCALP', 'tp_atr_mult',    3.5, 2.0, 6.0);
    init('SCALP', 'enabled',          1,  0,  1);

    // MOMENTUM
    init('MOMENTUM', 'min_confidence',      50, 35, 70);
    init('MOMENTUM', 'trailing_callback',  1.8, 1.0, 3.0);
    init('MOMENTUM', 'trailing_activation',2.5, 1.5, 4.0);
    init('MOMENTUM', 'enabled',              1,  0,  1);

    // SWING
    init('SWING', 'enabled', 1, 0, 1);

    // REVERSAL
    init('REVERSAL', 'min_exhaustion',    60, 40, 80);
    init('REVERSAL', 'enabled',            1,  0,  1);

    // SNIPER
    init('SNIPER', 'min_brain_confidence', 75, 65, 90);
    init('SNIPER', 'min_level_strength',   45, 30, 70);
    init('SNIPER', 'enabled',               1,  0,  1);

    // BREAKOUT_RETEST
    init('BREAKOUT_RETEST', 'sl_atr_mult', 1.0, 0.6, 1.5);
    init('BREAKOUT_RETEST', 'tp_atr_mult', 6.0, 4.0, 8.0);
    init('BREAKOUT_RETEST', 'margin',      125,  75, 200);
    init('BREAKOUT_RETEST', 'enabled',       1,   0,   1);

    // GRID
    init('GRID', 'max_concurrent', 2, 1, 3);
    init('GRID', 'enabled',        1, 0, 1);

    // TREND_FOLLOW
    init('TREND_FOLLOW', 'min_confidence',     55, 40, 70);
    init('TREND_FOLLOW', 'sl_atr_mult',       3.0, 2.0, 4.0);
    init('TREND_FOLLOW', 'trailing_callback', 1.5, 1.0, 2.5);
    init('TREND_FOLLOW', 'enabled',             1,  0,  1);
  }

  // ── Main adaptive loop — call from evaluate() ──
  run(): void {
    if (Date.now() - this.lastRun < this.RUN_INTERVAL) return;
    this.lastRun = Date.now();

    const total = this.memory.getTotalCount();
    if (total < 20) return; // not enough data

    // Apply rules
    for (const rule of this.rules) {
      this.applyRule(rule);
    }

    // Auto-disable engines bleeding badly
    this.checkAutoDisable();
  }

  // ── Get adaptive param value, fallback to default ──
  getParam(engine: string, param: string, fallback: number): number {
    return this.memory.getParam(engine, param) ?? fallback;
  }

  // ── Check if engine is enabled ──
  isEnabled(engine: string): boolean {
    return (this.memory.getParam(engine, 'enabled') ?? 1) !== 0;
  }

  // ── Force a manual re-enable (human override) ──
  enableEngine(engine: string): void {
    this.memory.setParam(engine, 'enabled', 1, 'Manual re-enable');
    console.log(`✅ ADAPTIVE | ${engine} manually re-enabled`);
  }

  // ── Print current state of all adaptive params ──
  printState(): void {
    const engines = ['SCALP', 'MOMENTUM', 'SWING', 'REVERSAL', 'SNIPER', 'BREAKOUT_RETEST', 'GRID', 'TREND_FOLLOW'];
    console.log('\n🔧 ADAPTIVE PARAMS:');
    for (const e of engines) {
      const enabled = this.isEnabled(e);
      const stats = this.tracker.getEngineStats(e, 20);
      if (stats.total_trades === 0) continue;
      const wr = stats.win_rate.toFixed(0);
      const pnl = stats.total_pnl.toFixed(2);
      console.log(`  ${enabled ? '✅' : '🚫'} ${e}: WR ${wr}% | PnL $${pnl} | ${stats.total_trades}T`);
    }
    const log = this.memory.getAdaptationLog(5);
    if (log.length > 0) {
      console.log('  Recent adjustments:');
      for (const l of log) {
        console.log(`    ${l.engine}.${l.param_name}: ${l.old_value?.toFixed(2)} → ${l.new_value?.toFixed(2)} | ${l.reason}`);
      }
    }
    console.log('');
  }

  // ── Private: apply a single rule ──
  private applyRule(rule: Rule): void {
    const stats = this.tracker.getEngineStats(rule.engine, 20);
    if (stats.total_trades < rule.min_sample) return;

    const key = `${rule.engine}_${rule.param}`;
    const lastAdj = this.lastAdjustments.get(key) || 0;
    if (Date.now() - lastAdj < rule.cooldown_ms) return;

    if (!rule.condition(stats)) return;

    const cur = this.memory.getParam(rule.engine, rule.param);
    if (cur === null) return;

    const raw = rule.adjustment(cur, stats);
    // Bounds are enforced inside setParam
    const pct = Math.abs(raw - cur) / Math.max(Math.abs(cur), 0.01);
    if (pct < 0.02) return; // Skip if <2% change

    const reason = rule.reason(stats);
    this.memory.setParam(rule.engine, rule.param, raw, reason);
    this.lastAdjustments.set(key, Date.now());
    this.tracker.invalidate(rule.engine);

    const newVal = this.memory.getParam(rule.engine, rule.param)!;
    console.log(`🔧 ADAPTIVE | ${rule.engine}.${rule.param}: ${cur.toFixed(2)} → ${newVal.toFixed(2)} | ${reason}`);
  }

  // ── Auto-disable engine if bleeding over 15+ trades ──
  private checkAutoDisable(): void {
    const health = this.tracker.getGlobalHealth();
    for (const engine of health.engines_struggling) {
      const stats = this.tracker.getEngineStats(engine, 20);
      if (stats.win_rate < 35 && stats.total_trades >= 15) {
        const enabled = this.memory.getParam(engine, 'enabled');
        if (enabled === 1) {
          this.memory.setParam(engine, 'enabled', 0,
            `AUTO-DISABLED: WR ${stats.win_rate.toFixed(1)}% over ${stats.total_trades}T`
          );
          console.log(
            `🚨 ADAPTIVE | ${engine} AUTO-DISABLED | WR ${stats.win_rate.toFixed(1)}% | ` +
            `${stats.total_trades}T | PnL $${stats.total_pnl.toFixed(2)}`
          );
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  //  ADAPTIVE RULES
  // ════════════════════════════════════════════════════════════

  private rules: Rule[] = [

    // ── SCALP: too many losses → raise confidence ──
    {
      engine: 'SCALP', param: 'min_confidence',
      condition: s => s.win_rate < 45,
      adjustment: (cur) => cur + 5,
      reason: s => `WR ${s.win_rate.toFixed(1)}% < 45% → raising selectivity`,
      min_sample: 10, cooldown_ms: 3_600_000,
    },

    // ── SCALP: performing well → carefully lower confidence ──
    {
      engine: 'SCALP', param: 'min_confidence',
      condition: s => s.win_rate > 65 && s.total_trades >= 15,
      adjustment: (cur) => cur - 3,
      reason: s => `WR ${s.win_rate.toFixed(1)}% > 65% → slightly lowering threshold`,
      min_sample: 15, cooldown_ms: 7_200_000,
    },

    // ── SCALP: overtrading and losing → reduce frequency ──
    {
      engine: 'SCALP', param: 'max_per_hour',
      condition: s => s.win_rate < 45 && s.total_trades >= 20,
      adjustment: (cur) => Math.max(1, cur - 1),
      reason: s => `WR ${s.win_rate.toFixed(1)}% with high vol → less frequency`,
      min_sample: 20, cooldown_ms: 14_400_000,
    },

    // ── MOMENTUM: trailing cutting winners ──
    {
      engine: 'MOMENTUM', param: 'trailing_callback',
      condition: s => s.avg_loss > s.avg_win * 1.3 && s.total_trades >= 8,
      adjustment: (cur) => cur + 0.2,
      reason: s => `avgLoss $${s.avg_loss.toFixed(2)} > 1.3x avgWin $${s.avg_win.toFixed(2)} → widen trail`,
      min_sample: 8, cooldown_ms: 7_200_000,
    },

    // ── MOMENTUM: losing overall → raise confidence ──
    {
      engine: 'MOMENTUM', param: 'min_confidence',
      condition: s => s.win_rate < 40 && s.total_trades >= 10,
      adjustment: (cur) => cur + 5,
      reason: s => `MOMENTUM WR ${s.win_rate.toFixed(1)}% < 40% → raising threshold`,
      min_sample: 10, cooldown_ms: 7_200_000,
    },

    // ── BREAKOUT_RETEST: winning → more capital ──
    {
      engine: 'BREAKOUT_RETEST', param: 'margin',
      condition: s => s.win_rate > 55 && s.profit_factor > 1.5 && s.total_trades >= 8,
      adjustment: (cur) => cur * 1.1,
      reason: s => `B.RETEST WR ${s.win_rate.toFixed(1)}%, PF ${s.profit_factor.toFixed(2)} → +10% margin`,
      min_sample: 8, cooldown_ms: 14_400_000,
    },

    // ── BREAKOUT_RETEST: losing → less capital ──
    {
      engine: 'BREAKOUT_RETEST', param: 'margin',
      condition: s => s.win_rate < 40 && s.total_trades >= 8,
      adjustment: (cur) => cur * 0.85,
      reason: s => `B.RETEST WR ${s.win_rate.toFixed(1)}% → -15% margin`,
      min_sample: 8, cooldown_ms: 7_200_000,
    },

    // ── TREND_FOLLOW: losing → raise confidence ──
    {
      engine: 'TREND_FOLLOW', param: 'min_confidence',
      condition: s => s.win_rate < 40 && s.total_trades >= 8,
      adjustment: (cur) => cur + 5,
      reason: s => `TREND_FOLLOW WR ${s.win_rate.toFixed(1)}% → raising selectivity`,
      min_sample: 8, cooldown_ms: 7_200_000,
    },

    // ── Emergency: 5+ consecutive losses → +10 confidence boost ──
    ...(['SCALP', 'MOMENTUM', 'REVERSAL', 'BREAKOUT_RETEST', 'TREND_FOLLOW'] as const).map(eng => ({
      engine: eng, param: 'min_confidence',
      condition: (s: EngineStats) => s.current_streak <= -5,
      adjustment: (cur: number) => cur + 10,
      reason: (s: EngineStats) => `${Math.abs(s.current_streak)} consecutive losses → emergency boost`,
      min_sample: 5, cooldown_ms: 3_600_000,
    }) as Rule),

  ];
}
