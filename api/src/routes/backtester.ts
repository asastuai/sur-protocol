/**
 * SUR Protocol - Backtester Simulation Routes
 *
 * Registers /api/backtester/* endpoints on the raw Node HTTP server.
 * Does NOT run the real bun CLI backtester — generates realistic
 * synthetic results after a short simulated "running" delay.
 * All state is held in memory.
 */

import type { IncomingMessage, ServerResponse, Server } from "http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BacktestConfig {
  market: string;
  period: string;
  capital: number;
  mode: "single" | "montecarlo";
  iterations: number;
  engines: string[];
}

interface EngineStat {
  name: string;
  trades: number;
  winRate: number;
  profitFactor: number;
  netPnl: number;
  avgWin: number;
  avgLoss: number;
  avgHoldMin: number;
}

interface LeaderboardEntry {
  rank: number;
  configHash: string;
  netPnl: number;
  sharpe: number;
  maxDd: number;
  winRate: number;
  profitFactor: number;
}

interface DailyPnlEntry {
  date: string;
  pnl: number;
  trades: number;
  cumPnl: number;
}

interface TradeEntry {
  id: number;
  engine: string;
  side: "Long" | "Short";
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  fees: number;
  durationMin: number;
  exitReason: string;
}

interface BacktestResults {
  summary: {
    netPnl: number;
    returnPct: number;
    winRate: number;
    profitFactor: number;
    sharpe: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    totalTrades: number;
  };
  engines: EngineStat[];
  leaderboard: LeaderboardEntry[];
  dailyPnl: DailyPnlEntry[];
  trades: TradeEntry[];
}

interface BacktesterState {
  status: "idle" | "running" | "complete";
  progress: number;
  results: BacktestResults | null;
  config: BacktestConfig | null;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const state: BacktesterState = {
  status: "idle",
  progress: 0,
  results: null,
  config: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function randomHash(len = 6): string {
  return Array.from({ length: len }, () =>
    "0123456789abcdef"[randInt(0, 15)]
  ).join("");
}

function parsePeriodDays(period: string): number {
  const match = period.match(/^(\d+)d$/);
  if (match) return parseInt(match[1], 10);
  if (period === "1w" || period === "7d") return 7;
  if (period === "1m" || period === "30d") return 30;
  if (period === "3m" || period === "90d") return 90;
  if (period === "1y" || period === "365d") return 365;
  return 30;
}

function getBasePrice(market: string): number {
  const m = market.toUpperCase();
  if (m.includes("BTC")) return rand(84000, 85000);
  if (m.includes("ETH")) return rand(1900, 2000);
  if (m.includes("SOL")) return rand(125, 140);
  if (m.includes("ARB")) return rand(0.9, 1.1);
  return rand(100, 1000);
}

function tradeCountRange(days: number): [number, number] {
  if (days <= 7) return [30, 50];
  if (days <= 30) return [100, 200];
  if (days <= 90) return [300, 500];
  return [800, 1500];
}

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/** Send a JSON response. */
function json(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Result generator
// ---------------------------------------------------------------------------

function generateResults(cfg: BacktestConfig): BacktestResults {
  const days = parsePeriodDays(cfg.period);
  const [minTrades, maxTrades] = tradeCountRange(days);
  const totalTrades = randInt(minTrades, maxTrades);

  // Overall P&L: -5% to +25% of capital
  const returnPct = round2(rand(-5, 25));
  const netPnl = round2(cfg.capital * (returnPct / 100));
  const overallWinRate = returnPct > 0 ? rand(55, 68) : rand(38, 48);
  const profitFactor = returnPct > 0 ? round2(rand(1.3, 2.5)) : round2(rand(0.5, 0.95));
  const sharpe = round2(rand(returnPct > 0 ? 0.8 : -0.5, returnPct > 0 ? 2.5 : 0.6));
  const maxDrawdownPct = round2(rand(3, 15));
  const maxDrawdown = round2(cfg.capital * (maxDrawdownPct / 100));

  // --- Per-engine breakdown ---
  const engines: EngineStat[] = cfg.engines.map((name) => {
    const isProfitable = Math.random() > 0.35;
    const wr = isProfitable ? round2(rand(55, 72)) : round2(rand(35, 45));
    const pf = isProfitable ? round2(rand(1.3, 2.8)) : round2(rand(0.4, 0.9));
    const engTrades = randInt(
      Math.max(5, Math.floor(totalTrades / cfg.engines.length * 0.5)),
      Math.ceil(totalTrades / cfg.engines.length * 1.5)
    );
    const avgWin = round2(rand(15, 50));
    const avgLoss = round2(rand(8, 30));
    const wins = Math.round(engTrades * (wr / 100));
    const losses = engTrades - wins;
    const engPnl = round2(wins * avgWin - losses * avgLoss);

    return {
      name,
      trades: engTrades,
      winRate: wr,
      profitFactor: pf,
      netPnl: engPnl,
      avgWin,
      avgLoss,
      avgHoldMin: randInt(30, 480),
    };
  });

  // --- Leaderboard (Monte Carlo iterations) ---
  const leaderboard: LeaderboardEntry[] = Array.from({ length: 10 }, (_, i) => ({
    rank: i + 1,
    configHash: randomHash(),
    netPnl: round2(rand(-cfg.capital * 0.08, cfg.capital * 0.3)),
    sharpe: round2(rand(-0.3, 2.5)),
    maxDd: round2(rand(2, 18)),
    winRate: round2(rand(40, 70)),
    profitFactor: round2(rand(0.6, 2.8)),
  }))
    .sort((a, b) => b.netPnl - a.netPnl)
    .map((entry, i) => ({ ...entry, rank: i + 1 }));

  // --- Daily P&L ---
  const dailyPnl: DailyPnlEntry[] = [];
  let cumPnl = 0;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  for (let d = 0; d < days; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dateStr = date.toISOString().slice(0, 10);
    const dayTrades = randInt(2, Math.ceil(totalTrades / days * 2));
    const dayPnl = round2(rand(-cfg.capital * 0.02, cfg.capital * 0.03));
    cumPnl = round2(cumPnl + dayPnl);
    dailyPnl.push({ date: dateStr, pnl: dayPnl, trades: dayTrades, cumPnl });
  }

  // --- Trade log (10 sample trades) ---
  const basePrice = getBasePrice(cfg.market);
  const exitReasons = ["TP Hit", "SL Hit", "Trailing Stop", "Time Exit", "Signal Flip"];
  const trades: TradeEntry[] = Array.from({ length: 10 }, (_, i) => {
    const engine = cfg.engines[randInt(0, cfg.engines.length - 1)];
    const side: "Long" | "Short" = Math.random() > 0.5 ? "Long" : "Short";
    const entryPrice = round2(basePrice * rand(0.995, 1.005));
    const movePct = rand(-0.008, 0.012);
    const exitPrice = round2(entryPrice * (1 + (side === "Long" ? movePct : -movePct)));
    const sizeFrac = cfg.capital * rand(0.02, 0.08);
    const pnl = round2(((exitPrice - entryPrice) / entryPrice) * sizeFrac * (side === "Long" ? 1 : -1));
    const fees = round2(sizeFrac * 0.0006 * 2);
    return {
      id: i + 1,
      engine,
      side,
      entryPrice,
      exitPrice,
      pnl,
      fees,
      durationMin: randInt(5, 600),
      exitReason: exitReasons[randInt(0, exitReasons.length - 1)],
    };
  });

  return {
    summary: {
      netPnl,
      returnPct,
      winRate: round2(overallWinRate),
      profitFactor,
      sharpe,
      maxDrawdown,
      maxDrawdownPct,
      totalTrades,
    },
    engines,
    leaderboard,
    dailyPnl,
    trades,
  };
}

// ---------------------------------------------------------------------------
// Simulate backtest run (progress ticks then generates results)
// ---------------------------------------------------------------------------

function simulateRun(cfg: BacktestConfig): void {
  state.status = "running";
  state.progress = 0;
  state.results = null;
  state.config = cfg;

  const totalMs = randInt(2000, 3000);
  const tickInterval = 200;
  const ticks = Math.floor(totalMs / tickInterval);
  let tick = 0;

  const timer = setInterval(() => {
    tick++;
    state.progress = Math.min(99, Math.round((tick / ticks) * 100));

    if (tick >= ticks) {
      clearInterval(timer);
      state.progress = 100;
      state.status = "complete";
      state.results = generateResults(cfg);
      console.log(
        `[Backtester] Simulation complete — net P&L: ${state.results.summary.netPnl} ` +
          `(${state.results.summary.returnPct}%), trades: ${state.results.summary.totalTrades}`
      );
    }
  }, tickInterval);
}

// ---------------------------------------------------------------------------
// Route handler — called from the raw http createServer callback
// ---------------------------------------------------------------------------

/**
 * Handle /api/backtester/* routes. Returns true if the request was handled.
 */
export async function handleBacktesterRoute(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  // POST /api/backtester/run
  if (url === "/api/backtester/run" && method === "POST") {
    if (state.status === "running") {
      json(res, 409, { error: "A backtest is already running" });
      return true;
    }

    let body: Record<string, unknown> = {};
    try {
      const raw = await readBody(req);
      if (raw) body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return true;
    }

    const cfg: BacktestConfig = {
      market: (body.market as string) ?? "BTC-USD",
      period: (body.period as string) ?? "30d",
      capital: (body.capital as number) ?? 2000,
      mode: (body.mode as "single" | "montecarlo") ?? "single",
      iterations: (body.iterations as number) ?? 1,
      engines: (body.engines as string[]) ?? ["Swing Rider"],
    };

    console.log(
      `[Backtester] Starting simulation — ${cfg.market} / ${cfg.period} / ` +
        `$${cfg.capital} / ${cfg.engines.length} engines`
    );

    simulateRun(cfg);

    json(res, 200, { message: "Backtest started", config: cfg });
    return true;
  }

  // GET /api/backtester/status
  if (url === "/api/backtester/status" && method === "GET") {
    json(res, 200, {
      status: state.status,
      progress: state.progress,
      results: state.results,
    });
    return true;
  }

  // GET /api/backtester/results
  if (url === "/api/backtester/results" && method === "GET") {
    if (!state.results) {
      json(res, 404, { error: "No backtest results available" });
      return true;
    }
    json(res, 200, state.results);
    return true;
  }

  return false;
}

/**
 * Register backtester routes (lifecycle hook, called once at startup).
 */
export function registerBacktesterRoutes(_server: Server): void {
  console.log("[Routes] Backtester endpoints registered (/api/backtester/*)");
}
