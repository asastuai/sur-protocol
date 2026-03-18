// ============================================================
// src/memory/trade-memory.ts — Persistent Trade Storage
// v3.2 Adaptive — uses bun:sqlite (built-in, no dependencies)
// ============================================================

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { join } from 'path';

export interface TradeMemoryRecord {
  id: string;
  engine: string;
  pair: string;
  side: 'LONG' | 'SHORT';
  entry_price: number;
  exit_price: number;
  margin: number;
  leverage: number;
  quantity: number;
  pnl: number;
  pnl_pct: number;
  fees: number;
  net_pnl: number;
  is_win: boolean;
  exit_reason: string;
  opened_at: number;
  closed_at: number;
  duration_ms: number;
  hour_of_day: number;
  day_of_week: number;
  brain_regime: string;
  brain_confidence: number;
  brain_bias: string;
  brain_event: string;
  exhaustion_score: number;
  rsi_1m: number;
  rsi_5m: number;
  mfi_5m: number;
  bb_width: number;
  atr_pct: number;
  tags: string;
  confidence: number;
}

export class TradeMemory {
  db: Database;

  constructor(dbPath?: string) {
    const dir = join(process.cwd(), 'data');
    try { mkdirSync(dir, { recursive: true }); } catch {}
    const path = dbPath || join(dir, 'trade-memory.db');
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        engine TEXT NOT NULL,
        pair TEXT NOT NULL DEFAULT 'BTCUSDT',
        side TEXT NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL NOT NULL,
        margin REAL NOT NULL,
        leverage INTEGER NOT NULL,
        quantity REAL NOT NULL,
        pnl REAL NOT NULL,
        pnl_pct REAL NOT NULL,
        fees REAL NOT NULL DEFAULT 0,
        net_pnl REAL NOT NULL,
        is_win INTEGER NOT NULL,
        exit_reason TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        hour_of_day INTEGER NOT NULL,
        day_of_week INTEGER NOT NULL,
        brain_regime TEXT DEFAULT '',
        brain_confidence REAL DEFAULT 0,
        brain_bias TEXT DEFAULT '',
        brain_event TEXT DEFAULT 'NONE',
        exhaustion_score REAL DEFAULT 0,
        rsi_1m REAL DEFAULT 0,
        rsi_5m REAL DEFAULT 0,
        mfi_5m REAL DEFAULT 0,
        bb_width REAL DEFAULT 0,
        atr_pct REAL DEFAULT 0,
        tags TEXT DEFAULT '[]',
        confidence REAL DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_engine ON trades(engine);
      CREATE INDEX IF NOT EXISTS idx_closed_at ON trades(closed_at);
      CREATE INDEX IF NOT EXISTS idx_engine_regime ON trades(engine, brain_regime);
      CREATE INDEX IF NOT EXISTS idx_engine_hour ON trades(engine, hour_of_day);

      CREATE TABLE IF NOT EXISTS adaptive_params (
        engine TEXT NOT NULL,
        param_name TEXT NOT NULL,
        current_value REAL NOT NULL,
        default_value REAL NOT NULL,
        min_value REAL NOT NULL,
        max_value REAL NOT NULL,
        last_adjusted_at INTEGER DEFAULT 0,
        adjustment_reason TEXT DEFAULT '',
        PRIMARY KEY (engine, param_name)
      );

      CREATE TABLE IF NOT EXISTS adaptation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        engine TEXT NOT NULL,
        param_name TEXT NOT NULL,
        old_value REAL,
        new_value REAL,
        reason TEXT
      );
    `);
  }

  recordTrade(t: TradeMemoryRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO trades (
        id, engine, pair, side, entry_price, exit_price, margin, leverage, quantity,
        pnl, pnl_pct, fees, net_pnl, is_win, exit_reason,
        opened_at, closed_at, duration_ms, hour_of_day, day_of_week,
        brain_regime, brain_confidence, brain_bias, brain_event, exhaustion_score,
        rsi_1m, rsi_5m, mfi_5m, bb_width, atr_pct, tags, confidence
      ) VALUES (
        $id, $engine, $pair, $side, $entry_price, $exit_price, $margin, $leverage, $quantity,
        $pnl, $pnl_pct, $fees, $net_pnl, $is_win, $exit_reason,
        $opened_at, $closed_at, $duration_ms, $hour_of_day, $day_of_week,
        $brain_regime, $brain_confidence, $brain_bias, $brain_event, $exhaustion_score,
        $rsi_1m, $rsi_5m, $mfi_5m, $bb_width, $atr_pct, $tags, $confidence
      )
    `).run({
      ...t,
      is_win: t.is_win ? 1 : 0,
      tags: typeof t.tags === 'string' ? t.tags : JSON.stringify(t.tags || []),
    });
  }

  getByEngine(engine: string, limit = 50): TradeMemoryRecord[] {
    return this.db.prepare(
      `SELECT * FROM trades WHERE engine = ? ORDER BY closed_at DESC LIMIT ?`
    ).all(engine, limit) as TradeMemoryRecord[];
  }

  getByEngineAndRegime(engine: string, regime: string, limit = 50): TradeMemoryRecord[] {
    return this.db.prepare(
      `SELECT * FROM trades WHERE engine = ? AND brain_regime = ? ORDER BY closed_at DESC LIMIT ?`
    ).all(engine, regime, limit) as TradeMemoryRecord[];
  }

  getByEngineAndHour(engine: string, hour: number, limit = 30): TradeMemoryRecord[] {
    return this.db.prepare(
      `SELECT * FROM trades WHERE engine = ? AND hour_of_day = ? ORDER BY closed_at DESC LIMIT ?`
    ).all(engine, hour, limit) as TradeMemoryRecord[];
  }

  getSince(sinceMs: number): TradeMemoryRecord[] {
    return this.db.prepare(
      `SELECT * FROM trades WHERE closed_at >= ? ORDER BY closed_at DESC`
    ).all(sinceMs) as TradeMemoryRecord[];
  }

  getTotalCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM trades').get() as any).cnt;
  }

  // ── Adaptive params ──

  initParam(engine: string, param: string, def: number, min: number, max: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO adaptive_params
        (engine, param_name, current_value, default_value, min_value, max_value)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(engine, param, def, def, min, max);
  }

  getParam(engine: string, param: string): number | null {
    const row = this.db.prepare(
      `SELECT current_value FROM adaptive_params WHERE engine = ? AND param_name = ?`
    ).get(engine, param) as any;
    return row ? row.current_value : null;
  }

  setParam(engine: string, param: string, value: number, reason: string): void {
    const existing = this.db.prepare(
      `SELECT current_value, min_value, max_value FROM adaptive_params WHERE engine = ? AND param_name = ?`
    ).get(engine, param) as any;
    if (!existing) return;

    const bounded = Math.max(existing.min_value, Math.min(existing.max_value, value));

    this.db.prepare(`
      INSERT INTO adaptation_log (timestamp, engine, param_name, old_value, new_value, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Date.now(), engine, param, existing.current_value, bounded, reason);

    this.db.prepare(`
      UPDATE adaptive_params SET current_value = ?, last_adjusted_at = ?, adjustment_reason = ?
      WHERE engine = ? AND param_name = ?
    `).run(bounded, Date.now(), reason, engine, param);
  }

  getAdaptationLog(limit = 20): any[] {
    return this.db.prepare(
      `SELECT * FROM adaptation_log ORDER BY timestamp DESC LIMIT ?`
    ).all(limit);
  }

  close(): void {
    this.db.close();
  }
}
