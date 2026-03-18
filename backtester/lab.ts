#!/usr/bin/env npx tsx
// ============================================================
// lab.ts — SUR Protocol Experiment Laboratory
//
// Un sistema automático que corre experimentos de backtesting
// sin tocar el bot en producción. Prueba parámetros, configs
// del brain, y patches de código buscando mejor Sharpe.
// Adapted from Aster Bot Lab for SUR Protocol.
//
// MODOS:
//   npx tsx lab.ts                     → corre todos los experimentos definidos
//   npx tsx lab.ts --mode=random --n=20  → 20 runs con params aleatorios
//   npx tsx lab.ts --mode=grid          → grid search sobre rangos definidos
//   npx tsx lab.ts --mode=hypothesis    → prueba hipótesis específicas
//   npx tsx lab.ts --leaderboard        → muestra ranking de resultados
//   npx tsx lab.ts --compare=exp1,exp2  → compara 2 experimentos
//
// CÓMO FUNCIONA:
//   1. Cada experimento define env vars que sobreescriben los defaults del runner
//   2. El lab spawns `npx tsx run.ts` con esas env vars
//   3. Parsea LAB_RESULTS_JSON del output
//   4. Guarda todo en ./lab-results/leaderboard.json
//   5. Tu bot real NO se toca — todo corre en su propio proceso
// ============================================================

import { execSync, spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';

// ── Types ──

interface ExperimentConfig {
  name: string;
  description: string;
  envVars: Record<string, string>;
  cliArgs?: string;              // extra CLI args like --days=90
  brainFresh?: boolean;          // --fresh flag (default: true)
  tags?: string[];               // for filtering results
  codePatch?: {                  // optional code modification
    file: string;                // relative path to file to patch
    search: string;              // string to find
    replace: string;             // replacement
  }[];
}

interface ExperimentResult {
  name: string;
  description: string;
  tags: string[];
  envVars: Record<string, string>;
  results: {
    sharpe: number;
    sortino: number;
    netPnl: number;
    netPnlPct: number;
    totalTrades: number;
    winRate: number;
    profitFactor: number;
    maxDD: number;
    maxDDpct: number;
    avgWin: number;
    avgLoss: number;
    capital: number;
    days: number;
  } | null;
  error?: string;
  duration: number;              // seconds
  timestamp: string;
}

interface Leaderboard {
  experiments: ExperimentResult[];
  bestSharpe: ExperimentResult | null;
  lastUpdated: string;
}

// ════════════════════════════════════════════════════════════
// EXPERIMENT DEFINITIONS
//
// Definí tus experimentos acá. Cada uno es un set de env vars
// que sobreescriben los defaults del runner.
//
// ENV VARS DISPONIBLES (del runner):
//   SWING_SL_ATR_MULT, SWING_TP_RR, SWING_MARGIN, SWING_LEVERAGE,
//   MIN_CONFIDENCE_SWING, SWING_COOLDOWN,
//   TR_MARGIN, TR_LEVERAGE, TR_SL_MULT, TR_TP_RR, TR_COOLDOWN, TR_MIN_CONF,
//   MAX_POSITIONS, MAX_TRADES_DAY,
//   SWING_TP_MAX_PCT, SWING_SL_MIN_PCT
//
// ENV VARS DEL BRAIN (agregados en v2.1):
//   BRAIN_OBS_TRADES, BRAIN_MARGIN_FLOOR, BRAIN_MARGIN_CEIL,
//   BRAIN_KELLY_FLOOR, BRAIN_INERTIA, BRAIN_MAX_PENALTY
// ════════════════════════════════════════════════════════════

const EXPERIMENTS: ExperimentConfig[] = [

  // ─────────────── BASELINE ───────────────
  {
    name: 'baseline-no-brain',
    description: 'v7.0 defaults sin brain (control)',
    envVars: {
      SWING_SL_ATR_MULT: '2.0',
      SWING_TP_RR: '2.0',
      SWING_MARGIN: '100',
      SWING_LEVERAGE: '5',
      MIN_CONFIDENCE_SWING: '70',
      SWING_COOLDOWN: '1800000',
      MAX_TRADES_DAY: '6',
      MAX_POSITIONS: '2',
    },
    tags: ['baseline'],
  },

  // ─────────────── MC TOP 1 (Sharpe +0.57) ───────────────
  {
    name: 'mc-top1-sl165-tp282',
    description: 'Mejor combo de Monte Carlo: SL=1.65, TP_RR=2.82',
    envVars: {
      SWING_SL_ATR_MULT: '1.65',
      SWING_TP_RR: '2.82',
      SWING_MARGIN: '180',
      SWING_LEVERAGE: '6',
      MIN_CONFIDENCE_SWING: '75',
      SWING_COOLDOWN: '3600000',
      MAX_TRADES_DAY: '3',
      MAX_POSITIONS: '2',
    },
    tags: ['mc-winner', 'tight-sl'],
  },

  // ─────────────── MC TOP 2 (Sharpe +0.43) ───────────────
  {
    name: 'mc-top2-sl339-tp128',
    description: 'MC #2: SL ancho, TP corto (high WR style)',
    envVars: {
      SWING_SL_ATR_MULT: '3.39',
      SWING_TP_RR: '1.28',
      SWING_MARGIN: '100',
      SWING_LEVERAGE: '6',
      MIN_CONFIDENCE_SWING: '75',
      SWING_COOLDOWN: '7200000',
      MAX_TRADES_DAY: '3',
      MAX_POSITIONS: '2',
    },
    tags: ['mc-winner', 'wide-sl'],
  },

  // ─────────────── HIPÓTESIS: Brain ayuda al MC top 1 ───────────────
  {
    name: 'mc-top1-with-brain',
    description: 'MC top 1 + brain v2.1 advisor (sizing adaptativo)',
    envVars: {
      SWING_SL_ATR_MULT: '1.65',
      SWING_TP_RR: '2.82',
      SWING_MARGIN: '180',
      SWING_LEVERAGE: '6',
      MIN_CONFIDENCE_SWING: '75',
      SWING_COOLDOWN: '3600000',
      MAX_TRADES_DAY: '3',
      MAX_POSITIONS: '2',
    },
    tags: ['brain', 'mc-winner'],
  },

  // ─────────────── HIPÓTESIS: Cooldown más largo ───────────────
  {
    name: 'high-selectivity',
    description: 'Solo 2 trades/día, confidence 80, cooldown 2h',
    envVars: {
      SWING_SL_ATR_MULT: '1.65',
      SWING_TP_RR: '2.82',
      SWING_MARGIN: '200',
      SWING_LEVERAGE: '6',
      MIN_CONFIDENCE_SWING: '80',
      SWING_COOLDOWN: '7200000',
      MAX_TRADES_DAY: '2',
      MAX_POSITIONS: '1',
    },
    tags: ['hypothesis', 'low-frequency'],
  },

  // ─────────────── HIPÓTESIS: SL más ajustado ───────────────
  {
    name: 'tight-sl-experiment',
    description: 'SL=1.2 ATR (más ajustado), TP mantener 2.82',
    envVars: {
      SWING_SL_ATR_MULT: '1.2',
      SWING_TP_RR: '2.82',
      SWING_MARGIN: '150',
      SWING_LEVERAGE: '6',
      MIN_CONFIDENCE_SWING: '75',
      SWING_COOLDOWN: '3600000',
      MAX_TRADES_DAY: '3',
    },
    tags: ['hypothesis', 'tight-sl'],
  },

  // ─────────────── HIPÓTESIS: R:R más alto ───────────────
  {
    name: 'high-rr-experiment',
    description: 'TP_RR=3.5 (más ambicioso), SL=1.65',
    envVars: {
      SWING_SL_ATR_MULT: '1.65',
      SWING_TP_RR: '3.5',
      SWING_MARGIN: '150',
      SWING_LEVERAGE: '6',
      MIN_CONFIDENCE_SWING: '75',
      SWING_COOLDOWN: '3600000',
      MAX_TRADES_DAY: '3',
    },
    tags: ['hypothesis', 'high-rr'],
  },

  // ─────────────── TREND_RIDER focus ───────────────
  {
    name: 'trend-rider-focus',
    description: 'TR con margin más alto, solo en macro fuerte',
    envVars: {
      TR_MARGIN: '150',
      TR_LEVERAGE: '5',
      TR_SL_MULT: '1.8',
      TR_TP_RR: '2.5',
      TR_MIN_CONF: '85',
      TR_COOLDOWN: '3600000',
      SWING_MARGIN: '150',
      SWING_SL_ATR_MULT: '1.65',
      SWING_TP_RR: '2.82',
      MIN_CONFIDENCE_SWING: '75',
      MAX_TRADES_DAY: '4',
    },
    tags: ['hypothesis', 'trend-rider'],
  },

  // ─────────────── BRAIN: Observation phase más corta ───────────────
  {
    name: 'brain-fast-learning',
    description: 'Brain con observation=50 trades (aprende más rápido)',
    envVars: {
      SWING_SL_ATR_MULT: '1.65',
      SWING_TP_RR: '2.82',
      SWING_MARGIN: '180',
      SWING_LEVERAGE: '6',
      MIN_CONFIDENCE_SWING: '75',
      SWING_COOLDOWN: '3600000',
      MAX_TRADES_DAY: '3',
      BRAIN_OBS_TRADES: '50',
    },
    tags: ['brain', 'hypothesis'],
  },

  // ─────────────── BRAIN: Margin range más amplio ───────────────
  {
    name: 'brain-wide-range',
    description: 'Brain con margin range [0.3, 2.5] (más agresivo)',
    envVars: {
      SWING_SL_ATR_MULT: '1.65',
      SWING_TP_RR: '2.82',
      SWING_MARGIN: '180',
      SWING_LEVERAGE: '6',
      MIN_CONFIDENCE_SWING: '75',
      SWING_COOLDOWN: '3600000',
      MAX_TRADES_DAY: '3',
      BRAIN_MARGIN_FLOOR: '0.3',
      BRAIN_MARGIN_CEIL: '2.5',
    },
    tags: ['brain', 'hypothesis'],
  },

  // ── BRAIN FIX EXPERIMENTS (brain env vars now wired) ──
  // Base: hs-cf75 winner (Sharpe 2.037) + brain overlay
  {
    name: 'brain-winner-obs50',
    description: 'Winner hs-cf75 + brain OBS=50 (aprende más rápido, 237 trades en 180d)',
    envVars: {
      MIN_CONFIDENCE_SWING: '75',
      MAX_POSITIONS: '1',
      SWING_TP_RR: '2.82',
      MAX_TRADES_DAY: '2',
      SWING_SL_ATR_MULT: '1.65',
      SWING_LEVERAGE: '6',
      SWING_COOLDOWN: '7200000',
      SWING_MARGIN: '200',
      BRAIN_OBS_TRADES: '50',
      BRAIN_MARGIN_FLOOR: '0.5',
      BRAIN_MARGIN_CEIL: '1.8',
    },
    tags: ['brain', 'winner-base'],
  },
  {
    name: 'brain-winner-obs30',
    description: 'Winner hs-cf75 + brain OBS=30 (muy rápido, empieza a ajustar desde trade 30)',
    envVars: {
      MIN_CONFIDENCE_SWING: '75',
      MAX_POSITIONS: '1',
      SWING_TP_RR: '2.82',
      MAX_TRADES_DAY: '2',
      SWING_SL_ATR_MULT: '1.65',
      SWING_LEVERAGE: '6',
      SWING_COOLDOWN: '7200000',
      SWING_MARGIN: '200',
      BRAIN_OBS_TRADES: '30',
      BRAIN_MARGIN_FLOOR: '0.5',
      BRAIN_MARGIN_CEIL: '1.8',
    },
    tags: ['brain', 'winner-base'],
  },
  {
    name: 'brain-winner-aggressive',
    description: 'Winner + brain agresivo: margin range [0.3, 2.5], Kelly floor 0.5',
    envVars: {
      MIN_CONFIDENCE_SWING: '75',
      MAX_POSITIONS: '1',
      SWING_TP_RR: '2.82',
      MAX_TRADES_DAY: '2',
      SWING_SL_ATR_MULT: '1.65',
      SWING_LEVERAGE: '6',
      SWING_COOLDOWN: '7200000',
      SWING_MARGIN: '200',
      BRAIN_OBS_TRADES: '50',
      BRAIN_MARGIN_FLOOR: '0.3',
      BRAIN_MARGIN_CEIL: '2.5',
      BRAIN_KELLY_FLOOR: '0.5',
    },
    tags: ['brain', 'winner-base', 'aggressive'],
  },
  {
    name: 'brain-sl12-obs50',
    description: 'hs-sl12 (MaxDD mínimo) + brain OBS=50',
    envVars: {
      MIN_CONFIDENCE_SWING: '80',
      MAX_POSITIONS: '1',
      SWING_TP_RR: '2.82',
      MAX_TRADES_DAY: '2',
      SWING_SL_ATR_MULT: '1.2',
      SWING_LEVERAGE: '6',
      SWING_COOLDOWN: '7200000',
      SWING_MARGIN: '200',
      BRAIN_OBS_TRADES: '50',
      BRAIN_MARGIN_FLOOR: '0.5',
      BRAIN_MARGIN_CEIL: '1.8',
    },
    tags: ['brain', 'low-dd'],
  },
  {
    name: 'brain-winner-conservative',
    description: 'Winner + brain conservador: margin [0.6, 1.4], inertia 300 trades',
    envVars: {
      MIN_CONFIDENCE_SWING: '75',
      MAX_POSITIONS: '1',
      SWING_TP_RR: '2.82',
      MAX_TRADES_DAY: '2',
      SWING_SL_ATR_MULT: '1.65',
      SWING_LEVERAGE: '6',
      SWING_COOLDOWN: '7200000',
      SWING_MARGIN: '200',
      BRAIN_OBS_TRADES: '50',
      BRAIN_MARGIN_FLOOR: '0.6',
      BRAIN_MARGIN_CEIL: '1.4',
      BRAIN_INERTIA_TRADES: '300',
      BRAIN_MAX_PENALTY: '0.25',
    },
    tags: ['brain', 'winner-base', 'conservative'],
  },
];


// ════════════════════════════════════════════════════════════
// RANDOM SEARCH GENERATOR
// ════════════════════════════════════════════════════════════

interface ParamRange {
  envVar: string;
  min: number;
  max: number;
  step?: number;   // if set, snap to grid
  type: 'float' | 'int';
}

const SEARCH_SPACE: ParamRange[] = [
  { envVar: 'SWING_SL_ATR_MULT', min: 0.8, max: 4.0, step: 0.05, type: 'float' },
  { envVar: 'SWING_TP_RR',       min: 1.0, max: 4.0, step: 0.1,  type: 'float' },
  { envVar: 'SWING_MARGIN',      min: 60,  max: 250, step: 10,    type: 'int' },
  { envVar: 'SWING_LEVERAGE',    min: 3,   max: 10,  step: 1,     type: 'int' },
  { envVar: 'MIN_CONFIDENCE_SWING', min: 60, max: 90, step: 5,    type: 'int' },
  { envVar: 'SWING_COOLDOWN',    min: 600000, max: 7200000, step: 600000, type: 'int' },
  { envVar: 'MAX_TRADES_DAY',    min: 2,   max: 8,   step: 1,     type: 'int' },
  { envVar: 'MAX_POSITIONS',     min: 1,   max: 3,   step: 1,     type: 'int' },
];

function randomSample(range: ParamRange): number {
  const raw = range.min + Math.random() * (range.max - range.min);
  if (range.step) {
    const snapped = Math.round(raw / range.step) * range.step;
    return range.type === 'int' ? Math.round(snapped) : Number(snapped.toFixed(4));
  }
  return range.type === 'int' ? Math.round(raw) : Number(raw.toFixed(4));
}

function generateRandomExperiment(index: number): ExperimentConfig {
  const envVars: Record<string, string> = {};
  for (const range of SEARCH_SPACE) {
    envVars[range.envVar] = String(randomSample(range));
  }

  const summary = `SL=${envVars.SWING_SL_ATR_MULT} RR=${envVars.SWING_TP_RR} M=$${envVars.SWING_MARGIN} L=${envVars.SWING_LEVERAGE}x`;
  return {
    name: `random-${index.toString().padStart(3, '0')}`,
    description: `Random search: ${summary}`,
    envVars,
    tags: ['random-search'],
  };
}


// ════════════════════════════════════════════════════════════
// EXPERIMENT RUNNER
// ════════════════════════════════════════════════════════════

const LAB_DIR = './lab-results';
const LEADERBOARD_FILE = join(LAB_DIR, 'leaderboard.json');
const RUNNER_SCRIPT = './run.ts'; // relative to bot directory

function loadLeaderboard(): Leaderboard {
  if (existsSync(LEADERBOARD_FILE)) {
    try {
      return JSON.parse(readFileSync(LEADERBOARD_FILE, 'utf-8'));
    } catch { /* corrupt */ }
  }
  return { experiments: [], bestSharpe: null, lastUpdated: '' };
}

function saveLeaderboard(lb: Leaderboard) {
  lb.lastUpdated = new Date().toISOString();
  if (lb.experiments.length > 0) {
    const sorted = lb.experiments
      .filter(e => e.results)
      .sort((a, b) => (b.results?.sharpe ?? -999) - (a.results?.sharpe ?? -999));
    lb.bestSharpe = sorted[0] || null;
  }
  writeFileSync(LEADERBOARD_FILE, JSON.stringify(lb, null, 2));
}

function runExperiment(exp: ExperimentConfig, days: number, capital: number): ExperimentResult {
  const start = Date.now();
  const fresh = exp.brainFresh !== false ? 'true' : 'false';
  const extraArgs = exp.cliArgs || '';

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  🧪 EXPERIMENT: ${exp.name}`);
  console.log(`     ${exp.description}`);
  console.log(`     Days=${days} Capital=$${capital} Fresh=${fresh}`);

  // Build env string
  const envEntries = Object.entries(exp.envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`     Params: ${envEntries}`);
  console.log(`${'─'.repeat(60)}`);

  // Apply code patches if any
  const patchedFiles: { file: string; backup: string }[] = [];
  if (exp.codePatch) {
    for (const patch of exp.codePatch) {
      const backup = `${patch.file}.lab-backup`;
      try {
        copyFileSync(patch.file, backup);
        patchedFiles.push({ file: patch.file, backup });
        let content = readFileSync(patch.file, 'utf-8');
        content = content.replace(patch.search, patch.replace);
        writeFileSync(patch.file, content);
        console.log(`  📝 Patched: ${patch.file}`);
      } catch (e) {
        console.error(`  ❌ Patch failed: ${patch.file}`);
      }
    }
  }

  let result: ExperimentResult = {
    name: exp.name,
    description: exp.description,
    tags: exp.tags || [],
    envVars: exp.envVars,
    results: null,
    duration: 0,
    timestamp: new Date().toISOString(),
  };

  try {
    // Build the command — spawn the runner with env vars
    const cmd = `npx tsx ${RUNNER_SCRIPT} --days=${days} --capital=${capital} --fresh=${fresh} ${extraArgs}`;
    const labBrainPath = join(LAB_DIR, "brain_" + exp.name + ".json");
    const env = { ...process.env, ...exp.envVars, BRAIN_MEMORY_PATH: labBrainPath };

    console.log(`  ▶ Running: ${cmd}`);
    const output = spawnSync('npx', [
      'tsx', RUNNER_SCRIPT,
      `--days=${days}`, `--capital=${capital}`, `--fresh=${fresh}`,
      ...(extraArgs ? extraArgs.split(' ') : []),
    ], {
      env,
      encoding: 'utf-8',
      timeout: 1_800_000,
      maxBuffer: 50 * 1024 * 1024,
      shell: true,
      cwd: process.cwd(),
    });

    const stdout = output.stdout || '';
    const stderr = output.stderr || '';

    if (output.status !== 0) {
      console.error(`  ❌ Exit code: ${output.status}`);
      if (stderr) console.error(`  stderr: ${stderr.slice(0, 500)}`);
      result.error = `Exit ${output.status}: ${stderr.slice(0, 200)}`;
    }

    // Parse LAB_RESULTS_JSON from output
    const jsonLine = stdout.split('\n').find(l => l.includes('LAB_RESULTS_JSON:'));
    if (jsonLine) {
      const jsonStr = jsonLine.split('LAB_RESULTS_JSON:')[1].trim();
      result.results = JSON.parse(jsonStr);

      const r = result.results!;
      const sharpeColor = r.sharpe > 0 ? '🟢' : r.sharpe > -1 ? '🟡' : '🔴';
      console.log(`\n  ${sharpeColor} RESULTS:`);
      console.log(`     Sharpe:  ${r.sharpe.toFixed(3)}`);
      console.log(`     Sortino: ${r.sortino.toFixed(3)}`);
      console.log(`     Net PnL: $${r.netPnl.toFixed(2)} (${r.netPnlPct.toFixed(1)}%)`);
      console.log(`     Trades:  ${r.totalTrades} | WR: ${r.winRate.toFixed(1)}% | PF: ${r.profitFactor.toFixed(2)}`);
      console.log(`     Max DD:  $${r.maxDD.toFixed(2)} (${r.maxDDpct.toFixed(1)}%)`);
    } else {
      console.error('  ❌ No LAB_RESULTS_JSON found in output');
      result.error = 'No results JSON in output';

      // Save raw output for debugging
      const debugFile = join(LAB_DIR, `debug_${exp.name}.txt`);
      writeFileSync(debugFile, stdout + '\n\nSTDERR:\n' + stderr);
      console.log(`  💾 Debug output saved: ${debugFile}`);
    }
  } catch (e: any) {
    result.error = e.message;
    console.error(`  ❌ Error: ${e.message}`);
  }

  // Restore code patches
  for (const { file, backup } of patchedFiles) {
    try {
      copyFileSync(backup, file);
      execSync(`rm ${backup}`);
      console.log(`  📝 Restored: ${file}`);
    } catch { /* ignore */ }
  }

  result.duration = (Date.now() - start) / 1000;
  console.log(`  ⏱️  Duration: ${result.duration.toFixed(0)}s`);

  return result;
}


// ════════════════════════════════════════════════════════════
// LEADERBOARD DISPLAY
// ════════════════════════════════════════════════════════════

function printLeaderboard(lb: Leaderboard, limit = 20) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  🏆 EXPERIMENT LEADERBOARD — ${lb.experiments.length} experiments`);
  console.log(`  Last updated: ${lb.lastUpdated}`);
  console.log(`${'═'.repeat(80)}\n`);

  const sorted = lb.experiments
    .filter(e => e.results)
    .sort((a, b) => (b.results?.sharpe ?? -999) - (a.results?.sharpe ?? -999))
    .slice(0, limit);

  if (sorted.length === 0) {
    console.log('  No experiments with results yet.\n');
    return;
  }

  // Header
  console.log(`  ${'#'.padStart(3)} | ${'Sharpe'.padStart(7)} | ${'Sortino'.padStart(7)} | ${'Net PnL'.padStart(10)} | ${'WR%'.padStart(5)} | ${'PF'.padStart(5)} | ${'MaxDD%'.padStart(6)} | ${'Trades'.padStart(6)} | Name`);
  console.log(`  ${'─'.repeat(3)} | ${'─'.repeat(7)} | ${'─'.repeat(7)} | ${'─'.repeat(10)} | ${'─'.repeat(5)} | ${'─'.repeat(5)} | ${'─'.repeat(6)} | ${'─'.repeat(6)} | ${'─'.repeat(30)}`);

  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const r = e.results!;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    const sharpeStr = r.sharpe.toFixed(3).padStart(7);
    const sortinoStr = r.sortino.toFixed(3).padStart(7);
    const pnlStr = `$${r.netPnl.toFixed(0)}`.padStart(10);
    const wrStr = r.winRate.toFixed(1).padStart(5);
    const pfStr = r.profitFactor.toFixed(2).padStart(5);
    const ddStr = r.maxDDpct.toFixed(1).padStart(6);
    const tradesStr = String(r.totalTrades).padStart(6);

    console.log(`${medal}${String(i + 1).padStart(3)} | ${sharpeStr} | ${sortinoStr} | ${pnlStr} | ${wrStr} | ${pfStr} | ${ddStr} | ${tradesStr} | ${e.name}`);
  }

  // Summary
  const positive = sorted.filter(e => (e.results?.sharpe ?? 0) > 0).length;
  console.log(`\n  Summary: ${positive}/${sorted.length} experiments with positive Sharpe`);

  if (lb.bestSharpe?.results) {
    console.log(`\n  🏆 BEST: ${lb.bestSharpe.name}`);
    console.log(`     ${lb.bestSharpe.description}`);
    console.log(`     Params: ${Object.entries(lb.bestSharpe.envVars).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }

  console.log(`\n${'═'.repeat(80)}\n`);
}

function printComparison(lb: Leaderboard, names: string[]) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  📊 COMPARISON`);
  console.log(`${'═'.repeat(70)}\n`);

  const exps = names.map(n => lb.experiments.find(e => e.name === n)).filter(Boolean) as ExperimentResult[];

  if (exps.length < 2) {
    console.log('  Need at least 2 valid experiment names.');
    console.log(`  Available: ${lb.experiments.map(e => e.name).join(', ')}`);
    return;
  }

  const metrics = ['sharpe', 'sortino', 'netPnl', 'winRate', 'profitFactor', 'maxDDpct', 'totalTrades', 'avgWin', 'avgLoss'] as const;

  // Header
  const nameWidth = 25;
  console.log(`  ${'Metric'.padEnd(15)} | ${exps.map(e => e.name.slice(0, nameWidth).padStart(nameWidth)).join(' | ')}`);
  console.log(`  ${'─'.repeat(15)} | ${exps.map(() => '─'.repeat(nameWidth)).join(' | ')}`);

  for (const metric of metrics) {
    const values = exps.map(e => {
      const v = e.results?.[metric] ?? 0;
      if (metric === 'netPnl') return `$${v.toFixed(2)}`.padStart(nameWidth);
      if (metric === 'avgWin' || metric === 'avgLoss') return `$${v.toFixed(2)}`.padStart(nameWidth);
      return v.toFixed(3).padStart(nameWidth);
    });

    // Highlight best
    const best = exps.reduce((bi, e, i) => {
      const v = e.results?.[metric] ?? -999;
      const bv = exps[bi].results?.[metric] ?? -999;
      if (metric === 'maxDDpct' || metric === 'avgLoss') return v < bv ? i : bi; // lower is better
      return v > bv ? i : bi;
    }, 0);

    const row = values.map((v, i) => i === best ? `${v} ✅` : `${v}   `);
    console.log(`  ${metric.padEnd(15)} | ${row.join(' | ')}`);
  }

  // Param differences
  console.log(`\n  📋 PARAMETER DIFFERENCES:`);
  const allKeys = new Set(exps.flatMap(e => Object.keys(e.envVars)));
  for (const key of allKeys) {
    const vals = exps.map(e => e.envVars[key] || 'default');
    const allSame = vals.every(v => v === vals[0]);
    if (!allSame) {
      console.log(`     ${key}: ${exps.map((e, i) => `${e.name.slice(0, 15)}=${vals[i]}`).join(' vs ')}`);
    }
  }

  console.log(`\n${'═'.repeat(70)}\n`);
}


// ════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════

async function main() {
  mkdirSync(LAB_DIR, { recursive: true });

  const args = process.argv.slice(2);
  const getArg = (n: string, d: string) => {
    const a = args.find(x => x.startsWith(`--${n}=`));
    return a ? a.split('=')[1] : d;
  };
  const hasFlag = (n: string) => args.includes(`--${n}`);

  const days = parseInt(getArg('days', '365'));
  const capital = parseInt(getArg('capital', '2000'));
  const mode = getArg('mode', 'hypothesis');
  const randomN = parseInt(getArg('n', '10'));

  // ── Leaderboard only ──
  if (hasFlag('leaderboard')) {
    const lb = loadLeaderboard();
    printLeaderboard(lb);
    return;
  }

  // ── Compare ──
  const compareArg = getArg('compare', '');
  if (compareArg) {
    const lb = loadLeaderboard();
    printComparison(lb, compareArg.split(','));
    return;
  }

  // ── Run experiments ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  🔬 SUR PROTOCOL LAB — Experiment Runner`);
  console.log(`  Mode: ${mode} | Days: ${days} | Capital: $${capital}`);
  console.log(`${'═'.repeat(60)}`);

  let experiments: ExperimentConfig[];

  switch (mode) {
    case 'random': {
      console.log(`  Generating ${randomN} random experiments...\n`);
      experiments = Array.from({ length: randomN }, (_, i) => generateRandomExperiment(i));
      break;
    }

    case 'grid': {
      // Grid search over a focused space (top MC params ± variations)
      console.log('  Generating grid search...\n');
      experiments = [];
      const slValues = [1.2, 1.65, 2.0, 2.5, 3.0, 3.39];
      const rrValues = [1.28, 2.0, 2.5, 2.82, 3.5];

      for (const sl of slValues) {
        for (const rr of rrValues) {
          experiments.push({
            name: `grid-sl${sl}-rr${rr}`,
            description: `Grid: SL=${sl} TP_RR=${rr}`,
            envVars: {
              SWING_SL_ATR_MULT: String(sl),
              SWING_TP_RR: String(rr),
              SWING_MARGIN: '150',
              SWING_LEVERAGE: '6',
              MIN_CONFIDENCE_SWING: '75',
              SWING_COOLDOWN: '3600000',
              MAX_TRADES_DAY: '3',
              MAX_POSITIONS: '2',
            },
            tags: ['grid-search'],
          });
        }
      }
      console.log(`  Generated ${experiments.length} grid combinations`);
      break;
    }

    case 'hypothesis':
    default: {
      // Filter to only experiments with the 'hypothesis' or specific tags
      const filterTag = getArg('tag', '');
      if (filterTag) {
        experiments = EXPERIMENTS.filter(e => e.tags?.includes(filterTag));
        console.log(`  Filtered to ${experiments.length} experiments with tag: ${filterTag}`);
      } else {
        experiments = EXPERIMENTS;
        console.log(`  Running all ${experiments.length} defined experiments`);
      }
      break;
    }
  }

  // ── Skip already-completed experiments ──
  const lb = loadLeaderboard();
  const completed = new Set(lb.experiments.map(e => e.name));
  const skipExisting = hasFlag('skip-existing');

  if (skipExisting) {
    const before = experiments.length;
    experiments = experiments.filter(e => !completed.has(e.name));
    console.log(`  Skipping ${before - experiments.length} already-completed experiments`);
  }

  console.log(`  Total to run: ${experiments.length}\n`);

  // ── Execute ──
  let done = 0;
  for (const exp of experiments) {
    done++;
    console.log(`\n  [${'█'.repeat(Math.round(done / experiments.length * 20))}${'░'.repeat(20 - Math.round(done / experiments.length * 20))}] ${done}/${experiments.length}`);

    const result = runExperiment(exp, days, capital);

    // Add/update in leaderboard
    const existingIdx = lb.experiments.findIndex(e => e.name === result.name);
    if (existingIdx >= 0) {
      lb.experiments[existingIdx] = result; // overwrite
    } else {
      lb.experiments.push(result);
    }

    saveLeaderboard(lb);

    // Save individual experiment report
    const expFile = join(LAB_DIR, `${result.name}.json`);
    writeFileSync(expFile, JSON.stringify(result, null, 2));
  }

  // ── Final leaderboard ──
  printLeaderboard(lb);

  // ── Recommendations ──
  const best = lb.experiments
    .filter(e => e.results && e.results.sharpe > 0)
    .sort((a, b) => (b.results?.sharpe ?? 0) - (a.results?.sharpe ?? 0));

  if (best.length > 0) {
    console.log('  📋 NEXT STEPS:');
    console.log(`     1. Best Sharpe: ${best[0].name} (${best[0].results!.sharpe.toFixed(3)})`);
    console.log(`     2. Apply these params to your live bot:`);
    for (const [k, v] of Object.entries(best[0].envVars)) {
      console.log(`        ${k}=${v}`);
    }
    if (best.length >= 2) {
      console.log(`\n     3. Compare top 2: npx tsx lab.ts --compare=${best[0].name},${best[1].name}`);
    }
    console.log(`     4. Run more random search: npx tsx lab.ts --mode=random --n=20`);
  } else {
    console.log('  ⚠️  No experiments with positive Sharpe yet.');
    console.log('     Try: npx tsx lab.ts --mode=random --n=30 --days=365');
  }

  console.log('');
}

main().catch(e => { console.error('❌ Lab failed:', e); process.exit(1); });
