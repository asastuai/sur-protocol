"use client";

import { useState, useEffect, useRef } from "react";

// ============================================================
//  API BASE URL
// ============================================================

import { API_BASE as API } from "@/lib/api-url";

const ALL_ENGINES = [
  "Swing Rider",
  "Trend Rider",
  "Mean Reversion",
  "Breakout Hunter",
  "Scalper",
  "Momentum Burst",
  "Range Trader",
];

/** Smart interval selection — more granular for shorter periods */
const PERIOD_INTERVAL: Record<string, { interval: string; label: string; approxCandles: string }> = {
  "7d":   { interval: "5m",  label: "5-min candles",  approxCandles: "~2,016" },
  "30d":  { interval: "5m",  label: "5-min candles",  approxCandles: "~8,640" },
  "90d":  { interval: "15m", label: "15-min candles", approxCandles: "~8,640" },
  "365d": { interval: "1h",  label: "1-hour candles", approxCandles: "~8,760" },
};

// ============================================================
//  TYPES
// ============================================================

interface EngineResult {
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

interface DailyPnl {
  date: string;
  pnl: number;
  trades: number;
  cumPnl?: number;
}

interface TradeEntry {
  id: number;
  engine: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  fees: number;
  durationMin: number;
  exitReason: string;
}

interface BacktestResults {
  summary?: {
    netPnl: number;
    totalTrades: number;
    winRate: number;
    profitFactor: number;
    sharpe: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    returnPct?: number;
  };
  engines?: EngineResult[];
  leaderboard?: LeaderboardEntry[];
  dailyPnl?: DailyPnl[];
  trades?: TradeEntry[];
}

// ============================================================
//  HELPERS
// ============================================================

function fmt(n: number) {
  return n >= 0
    ? `$${n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `-$${Math.abs(n).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtSigned(n: number) {
  return `${n >= 0 ? "+" : ""}${fmt(n)}`;
}

// ============================================================
//  ICONS (inline SVG)
// ============================================================

function IconFlask({ className = "" }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M9 3h6M10 3v6.5L4 20h16L14 9.5V3" />
      <path d="M8.5 14h7" />
    </svg>
  );
}

function IconPlay({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function IconChevron({ open, className = "" }: { open: boolean; className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? "rotate-180" : ""} ${className}`}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function IconTrophy({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M8 21h8M12 17v4M17 4H7l-2 8h14l-2-8zM7 4V2h10v2" />
    </svg>
  );
}

function IconChart({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 3v18h18" />
      <path d="M7 16l4-8 4 4 5-10" />
    </svg>
  );
}

function IconList({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function IconCpu({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="15" x2="23" y2="15" />
      <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="15" x2="4" y2="15" />
    </svg>
  );
}

// ============================================================
//  STAT CARD
// ============================================================

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-sur-surface border border-sur-border rounded-xl p-4">
      <div className="text-[10px] text-sur-muted font-medium uppercase tracking-wider mb-2">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${color || "text-sur-text"}`}>{value}</div>
      {sub && <div className="text-[10px] text-sur-muted mt-1 tabular-nums">{sub}</div>}
    </div>
  );
}

// ============================================================
//  SECTION HEADER
// ============================================================

function SectionHeader({ icon, title, badge }: { icon: React.ReactNode; title: string; badge?: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="text-sur-muted">{icon}</span>
      <h2 className="text-base font-semibold">{title}</h2>
      {badge && (
        <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-sur-accent/15 text-sur-accent">
          {badge}
        </span>
      )}
    </div>
  );
}

// ============================================================
//  MEDAL RENDERING
// ============================================================

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-yellow-500/20 text-yellow-400 text-[10px] font-bold">1</span>;
  if (rank === 2) return <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-400/20 text-gray-300 text-[10px] font-bold">2</span>;
  if (rank === 3) return <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-700/20 text-amber-600 text-[10px] font-bold">3</span>;
  return <span className="text-[11px] text-sur-muted tabular-nums pl-1.5">{rank}</span>;
}

// ============================================================
//  LOCAL COMPUTE BADGE
// ============================================================

function LocalBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sur-accent/10 border border-sur-accent/20 text-[10px] font-medium text-sur-accent">
      <IconCpu className="text-sur-accent" />
      Runs locally on your device
    </span>
  );
}

// ============================================================
//  PAGE
// ============================================================

export default function BacktesterPage() {
  // Config state
  const [market, setMarket] = useState("BTC-USD");
  const [period, setPeriod] = useState("30d");
  const [capital, setCapital] = useState("100000");
  const [mode, setMode] = useState<"single" | "random" | "grid">("random");
  const [iterations, setIterations] = useState("500");
  const [engines, setEngines] = useState<Record<string, boolean>>(
    Object.fromEntries(ALL_ENGINES.map(e => [e, true]))
  );

  // UI state
  const [status, setStatus] = useState<"idle" | "loading" | "running" | "complete" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [showTradeLog, setShowTradeLog] = useState(false);

  // Results state
  const [results, setResults] = useState<BacktestResults | null>(null);
  const [dataInfo, setDataInfo] = useState<{ interval: string; count: number } | null>(null);

  // Worker ref
  const workerRef = useRef<Worker | null>(null);

  // Terminate worker on unmount
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const toggleEngine = (name: string) => {
    setEngines(prev => ({ ...prev, [name]: !prev[name] }));
  };

  const handleRun = async () => {
    // Terminate any existing worker
    workerRef.current?.terminate();
    workerRef.current = null;

    setStatus("loading");
    setProgress(0);
    setResults(null);
    setErrorMsg("");

    const enabledEngines = Object.entries(engines)
      .filter(([, active]) => active)
      .map(([name]) => name);

    if (enabledEngines.length === 0) {
      setErrorMsg("Select at least one engine.");
      setStatus("error");
      return;
    }

    // Step 1: Fetch price data from API
    try {
      const intervalCfg = PERIOD_INTERVAL[period] || PERIOD_INTERVAL["30d"];
      const res = await fetch(`${API}/api/prices/${market}?period=${period}&interval=${intervalCfg.interval}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to fetch price data (${res.status})`);
      }
      const priceData = await res.json();

      if (!priceData.candles || priceData.candles.length === 0) {
        throw new Error("No price data available for the selected market and period.");
      }

      setDataInfo({ interval: priceData.interval || intervalCfg.interval, count: priceData.candles.length });

      // Step 2: Create Web Worker and run backtest
      setStatus("running");

      const worker = new Worker("/backtester-worker.js");
      workerRef.current = worker;

      worker.onmessage = (e: MessageEvent) => {
        const { type } = e.data;

        if (type === "progress") {
          setProgress(e.data.progress);
        } else if (type === "complete") {
          setResults(e.data.results);
          setStatus("complete");
          worker.terminate();
          workerRef.current = null;
        } else if (type === "error") {
          setErrorMsg(e.data.error);
          setStatus("error");
          worker.terminate();
          workerRef.current = null;
        }
      };

      worker.onerror = (err) => {
        setErrorMsg(err.message || "Worker encountered an unexpected error.");
        setStatus("error");
        worker.terminate();
        workerRef.current = null;
      };

      // Send config + candles to the worker
      worker.postMessage({
        type: "run",
        config: {
          market,
          period,
          capital: parseFloat(capital) || 100000,
          mode,
          iterations: mode !== "single" ? parseInt(iterations) || 500 : 1,
          engines: enabledEngines,
          candles: priceData.candles,
        },
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to fetch price data");
      setStatus("error");
    }
  };

  // Derived values from results
  const engineResults = results?.engines || [];
  const leaderboard = results?.leaderboard || [];
  const dailyPnl = results?.dailyPnl || [];
  const tradeLog = results?.trades || [];
  const summary = results?.summary;

  const totalPnl = summary?.netPnl ?? engineResults.reduce((s, e) => s + e.netPnl, 0);
  const totalTrades = summary?.totalTrades ?? engineResults.reduce((s, e) => s + e.trades, 0);
  const overallWinRate = summary?.winRate ?? 0;
  const profitFactor = summary?.profitFactor ?? 0;
  const sharpe = summary?.sharpe ?? 0;
  const maxDrawdownPct = summary?.maxDrawdownPct ?? 0;
  const maxDrawdownAbs = summary?.maxDrawdown ?? 0;
  const capitalNum = parseFloat(capital) || 100000;
  const pnlPct = summary?.returnPct ?? (capitalNum > 0 ? (totalPnl / capitalNum) * 100 : 0);

  const totalWins = totalTrades > 0 ? Math.round(totalTrades * overallWinRate / 100) : 0;

  // Cumulative P&L for daily table
  let cumulative = 0;
  const dailyWithCum = dailyPnl.map(d => {
    if (d.cumPnl !== undefined) return d as DailyPnl & { cumPnl: number };
    cumulative += d.pnl;
    return { ...d, cumPnl: cumulative };
  });

  const isRunning = status === "running" || status === "loading";

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">

        {/* ===== HEADER ===== */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-sur-accent/10 flex items-center justify-center">
              <IconFlask className="text-sur-accent" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <h1 className="text-2xl font-bold">Strategy Backtester</h1>
                <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-sur-yellow/15 text-sur-yellow">
                  Monte Carlo
                </span>
              </div>
              <p className="text-[12px] text-sur-muted">
                Test trading strategies against historical data with randomized parameter search
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <LocalBadge />
            <button
              onClick={handleRun}
              disabled={isRunning}
              className={`flex items-center gap-2 px-5 py-2.5 text-[12px] font-semibold rounded-lg transition-all ${
                isRunning
                  ? "bg-sur-accent/50 text-white/60 cursor-wait"
                  : "bg-sur-accent text-white hover:bg-sur-accent/90 active:scale-[0.98]"
              }`}
            >
              {isRunning ? (
                <>
                  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                  {status === "loading" ? "Fetching..." : "Running..."}
                </>
              ) : (
                <>
                  <IconPlay />
                  Run Backtest
                </>
              )}
            </button>
          </div>
        </div>

        {/* ===== CONFIGURATION PANEL ===== */}
        <div className="bg-sur-surface border border-sur-border rounded-xl p-6 mb-6">
          <div className="text-[10px] text-sur-muted font-medium uppercase tracking-wider mb-4">Configuration</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">

            {/* Left column */}
            <div className="space-y-4">
              {/* Market */}
              <div>
                <label className="text-[11px] text-sur-muted font-medium block mb-1.5">Market</label>
                <select
                  value={market}
                  onChange={e => setMarket(e.target.value)}
                  className="w-full bg-sur-bg border border-sur-border rounded-lg px-3 py-2 text-[12px] text-sur-text focus:outline-none focus:border-sur-accent/50 appearance-none cursor-pointer"
                >
                  <option value="BTC-USD">BTC-USD</option>
                  <option value="ETH-USD">ETH-USD</option>
                </select>
              </div>

              {/* Time period */}
              <div>
                <label className="text-[11px] text-sur-muted font-medium block mb-1.5">Time Period</label>
                <div className="flex items-center gap-1 bg-sur-bg border border-sur-border rounded-lg p-0.5">
                  {["7d", "30d", "90d", "365d"].map(p => (
                    <button
                      key={p}
                      onClick={() => setPeriod(p)}
                      className={`flex-1 px-3 py-1.5 text-[11px] font-medium rounded-md transition-colors ${
                        period === p ? "bg-white/[0.08] text-white" : "text-sur-muted hover:text-sur-text"
                      }`}
                    >
                      {p.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-sur-muted mt-1.5">
                  Resolution: {(PERIOD_INTERVAL[period] || PERIOD_INTERVAL["30d"]).label} ({(PERIOD_INTERVAL[period] || PERIOD_INTERVAL["30d"]).approxCandles} data points)
                </div>
              </div>

              {/* Starting capital */}
              <div>
                <label className="text-[11px] text-sur-muted font-medium block mb-1.5">Starting Capital ($)</label>
                <input
                  type="text"
                  value={capital}
                  onChange={e => setCapital(e.target.value)}
                  className="w-full bg-sur-bg border border-sur-border rounded-lg px-3 py-2 text-[12px] text-sur-text tabular-nums focus:outline-none focus:border-sur-accent/50 font-mono"
                  placeholder="100000"
                />
              </div>
            </div>

            {/* Right column */}
            <div className="space-y-4">
              {/* Mode */}
              <div>
                <label className="text-[11px] text-sur-muted font-medium block mb-1.5">Mode</label>
                <div className="flex items-center gap-1 bg-sur-bg border border-sur-border rounded-lg p-0.5">
                  {([
                    { key: "single" as const, label: "Single Run" },
                    { key: "random" as const, label: "Random Search" },
                    { key: "grid" as const, label: "Grid Search" },
                  ]).map(m => (
                    <button
                      key={m.key}
                      onClick={() => setMode(m.key)}
                      className={`flex-1 px-3 py-1.5 text-[11px] font-medium rounded-md transition-colors ${
                        mode === m.key ? "bg-white/[0.08] text-white" : "text-sur-muted hover:text-sur-text"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Iterations */}
              {mode !== "single" && (
                <div>
                  <label className="text-[11px] text-sur-muted font-medium block mb-1.5">Iterations</label>
                  <input
                    type="text"
                    value={iterations}
                    onChange={e => setIterations(e.target.value)}
                    className="w-full bg-sur-bg border border-sur-border rounded-lg px-3 py-2 text-[12px] text-sur-text tabular-nums focus:outline-none focus:border-sur-accent/50 font-mono"
                    placeholder="500"
                  />
                </div>
              )}

              {/* Active engines */}
              <div>
                <label className="text-[11px] text-sur-muted font-medium block mb-1.5">Active Engines</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {ALL_ENGINES.map(name => (
                    <label
                      key={name}
                      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors text-[11px] ${
                        engines[name]
                          ? "bg-sur-accent/10 text-sur-text border border-sur-accent/30"
                          : "bg-sur-bg text-sur-muted border border-sur-border hover:border-sur-border"
                      }`}
                    >
                      <span className={`w-3 h-3 rounded-sm border flex items-center justify-center ${
                        engines[name] ? "bg-sur-accent border-sur-accent" : "border-sur-border"
                      }`}>
                        {engines[name] && (
                          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                      <input
                        type="checkbox"
                        checked={engines[name]}
                        onChange={() => toggleEngine(name)}
                        className="sr-only"
                      />
                      {name}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ===== LOADING STATE — Fetching prices ===== */}
        {status === "loading" && (
          <div className="bg-sur-surface border border-sur-border rounded-xl p-12 mb-6 flex flex-col items-center justify-center">
            <div className="relative w-12 h-12 mb-4">
              <div className="absolute inset-0 rounded-full border-2 border-sur-border" />
              <div className="absolute inset-0 rounded-full border-2 border-sur-accent border-t-transparent animate-spin" />
            </div>
            <p className="text-[13px] font-medium mb-1">Fetching historical prices...</p>
            <p className="text-[11px] text-sur-muted">
              Downloading {market} {(PERIOD_INTERVAL[period] || PERIOD_INTERVAL["30d"]).label} for the past {period.toUpperCase()} ({(PERIOD_INTERVAL[period] || PERIOD_INTERVAL["30d"]).approxCandles} data points)
            </p>
          </div>
        )}

        {/* ===== RUNNING STATE WITH PROGRESS ===== */}
        {status === "running" && (
          <div className="bg-sur-surface border border-sur-border rounded-xl p-12 mb-6 flex flex-col items-center justify-center">
            <div className="relative w-12 h-12 mb-4">
              <div className="absolute inset-0 rounded-full border-2 border-sur-border" />
              <div className="absolute inset-0 rounded-full border-2 border-sur-accent border-t-transparent animate-spin" />
            </div>
            <p className="text-[13px] font-medium mb-1">Running backtest on your device...</p>
            <p className="text-[11px] text-sur-muted mb-4">
              {mode !== "single" ? iterations : "1"} iteration{mode !== "single" ? "s" : ""} across {Object.values(engines).filter(Boolean).length} engines on {market}
            </p>
            {/* Progress bar */}
            <div className="w-full max-w-xs mb-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-sur-muted">Progress</span>
                <span className="text-[10px] text-sur-accent font-semibold tabular-nums">{Math.round(progress)}%</span>
              </div>
              <div className="w-full h-1.5 bg-sur-border rounded-full overflow-hidden">
                <div
                  className="h-full bg-sur-accent rounded-full transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                />
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-sur-muted">
              <IconCpu className="text-sur-muted" />
              <span>Computation runs locally on your browser — no server load</span>
            </div>
          </div>
        )}

        {/* ===== ERROR STATE ===== */}
        {status === "error" && (
          <div className="bg-sur-surface border border-sur-red/30 rounded-xl p-12 mb-6 flex flex-col items-center justify-center">
            <div className="w-12 h-12 rounded-full bg-sur-red/10 flex items-center justify-center mb-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-sur-red">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <p className="text-[13px] font-semibold text-sur-red mb-1">Backtest Failed</p>
            <p className="text-[11px] text-sur-muted mb-4 text-center max-w-sm">{errorMsg || "An unexpected error occurred."}</p>
            <button
              onClick={handleRun}
              className="flex items-center gap-2 px-5 py-2.5 bg-sur-accent text-white text-xs font-semibold rounded-lg hover:bg-sur-accent/90 transition-colors"
            >
              <IconPlay />
              Retry
            </button>
          </div>
        )}

        {/* ===== RESULTS ===== */}
        {status === "complete" && results && (
          <>
            {/* Data Resolution Badge */}
            {dataInfo && (
              <div className="flex items-center gap-2 mb-4">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.04] border border-sur-border text-[10px] font-medium text-sur-muted">
                  <IconChart className="text-sur-muted" />
                  {dataInfo.count.toLocaleString()} real Binance candles @ {dataInfo.interval} resolution
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.04] border border-sur-border text-[10px] font-medium text-sur-muted">
                  {period.toUpperCase()} period &middot; {market}
                </span>
                {mode !== "single" && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.04] border border-sur-border text-[10px] font-medium text-sur-muted">
                    {iterations} Monte Carlo iterations
                  </span>
                )}
              </div>
            )}
            {/* Results Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
              <StatCard
                label="Net P&L"
                value={fmtSigned(totalPnl)}
                sub={`${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% return`}
                color={totalPnl >= 0 ? "text-sur-green" : "text-sur-red"}
              />
              <StatCard
                label="Win Rate"
                value={`${overallWinRate.toFixed(1)}%`}
                sub={`${totalWins}W / ${totalTrades - totalWins}L`}
              />
              <StatCard
                label="Profit Factor"
                value={profitFactor.toFixed(2)}
                sub="Gross profit / loss"
              />
              <StatCard
                label="Sharpe Ratio"
                value={sharpe.toFixed(2)}
                sub="Risk-adjusted return"
              />
              <StatCard
                label="Max Drawdown"
                value={`${maxDrawdownPct.toFixed(1)}%`}
                sub={fmt(maxDrawdownAbs)}
                color="text-sur-red"
              />
              <StatCard
                label="Total Trades"
                value={totalTrades.toLocaleString()}
                sub={`${period.toUpperCase()} period`}
              />
            </div>

            {/* Engine Breakdown */}
            {engineResults.length > 0 && (
              <div className="mb-6">
                <SectionHeader icon={<IconChart />} title="Engine Breakdown" badge={`${engineResults.length} engines`} />
                <div className="bg-sur-surface border border-sur-border rounded-xl overflow-x-auto">
                  <table className="w-full min-w-[640px]">
                    <thead>
                      <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider border-b border-sur-border">
                        {["Engine", "Trades", "Win Rate", "Profit Factor", "Net P&L", "Avg Win", "Avg Loss", "Avg Hold"].map(h => (
                          <th key={h} className={`${h === "Engine" ? "text-left" : "text-right"} px-4 py-2.5 font-medium`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {engineResults.map((row) => (
                        <tr
                          key={row.name}
                          className={`text-[11px] border-t border-sur-border/40 transition-colors hover:bg-white/[0.02] ${
                            row.netPnl >= 0 ? "bg-sur-green/[0.02]" : "bg-sur-red/[0.02]"
                          }`}
                        >
                          <td className="px-4 py-2.5 font-medium">
                            <div className="flex items-center gap-2">
                              <span className={`w-1.5 h-1.5 rounded-full ${row.netPnl >= 0 ? "bg-sur-green" : "bg-sur-red"}`} />
                              {row.name}
                            </div>
                          </td>
                          <td className="text-right px-4 py-2.5 tabular-nums text-sur-muted">{row.trades}</td>
                          <td className="text-right px-4 py-2.5 tabular-nums">{row.winRate.toFixed(1)}%</td>
                          <td className={`text-right px-4 py-2.5 tabular-nums ${row.profitFactor >= 1.5 ? "text-sur-green" : row.profitFactor < 1 ? "text-sur-red" : "text-sur-text"}`}>
                            {row.profitFactor.toFixed(2)}
                          </td>
                          <td className={`text-right px-4 py-2.5 tabular-nums font-semibold ${row.netPnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                            {fmtSigned(row.netPnl)}
                          </td>
                          <td className="text-right px-4 py-2.5 tabular-nums text-sur-green">{fmt(row.avgWin)}</td>
                          <td className="text-right px-4 py-2.5 tabular-nums text-sur-red">{fmt(row.avgLoss)}</td>
                          <td className="text-right px-4 py-2.5 tabular-nums text-sur-muted">{row.avgHoldMin < 60 ? `${Math.round(row.avgHoldMin)}m` : `${(row.avgHoldMin / 60).toFixed(1)}h`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Strategy Leaderboard */}
            {mode !== "single" && leaderboard.length > 0 && (
              <div className="mb-6">
                <SectionHeader icon={<IconTrophy />} title="Strategy Leaderboard" badge={`Top ${leaderboard.length} Parameter Sets`} />
                <div className="bg-sur-surface border border-sur-border rounded-xl overflow-x-auto">
                  <table className="w-full min-w-[640px]">
                    <thead>
                      <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider border-b border-sur-border">
                        {["Rank", "Config Hash", "Net P&L", "Sharpe", "Max DD", "Win Rate", "Profit Factor"].map(h => (
                          <th key={h} className={`${h === "Config Hash" ? "text-left" : h === "Rank" ? "text-center" : "text-right"} px-4 py-2.5 font-medium`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {leaderboard.map((row) => (
                        <tr
                          key={row.rank}
                          className={`text-[11px] border-t transition-colors hover:bg-white/[0.02] ${
                            row.rank <= 3 ? "border-sur-border/60" : "border-sur-border/30"
                          } ${
                            row.rank === 1 ? "bg-yellow-500/[0.04]" : row.rank === 2 ? "bg-gray-400/[0.03]" : row.rank === 3 ? "bg-amber-700/[0.03]" : ""
                          }`}
                        >
                          <td className="text-center px-4 py-2.5">
                            <RankBadge rank={row.rank} />
                          </td>
                          <td className="px-4 py-2.5 font-mono text-[10px] text-sur-muted">{row.configHash}</td>
                          <td className="text-right px-4 py-2.5 tabular-nums font-semibold text-sur-green">{fmtSigned(row.netPnl)}</td>
                          <td className="text-right px-4 py-2.5 tabular-nums">{row.sharpe.toFixed(2)}</td>
                          <td className="text-right px-4 py-2.5 tabular-nums text-sur-red">{row.maxDd.toFixed(1)}%</td>
                          <td className="text-right px-4 py-2.5 tabular-nums">{row.winRate.toFixed(1)}%</td>
                          <td className="text-right px-4 py-2.5 tabular-nums">{row.profitFactor.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Daily P&L Breakdown */}
            {dailyPnl.length > 0 && (
              <div className="mb-6">
                <SectionHeader icon={<IconChart />} title="Daily P&L Breakdown" />
                <div className="bg-sur-surface border border-sur-border rounded-xl overflow-x-auto">
                  <table className="w-full min-w-[640px]">
                    <thead>
                      <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider border-b border-sur-border">
                        {["Date", "P&L", "Trades", "Cumulative P&L"].map(h => (
                          <th key={h} className={`${h === "Date" ? "text-left" : "text-right"} px-4 py-2.5 font-medium`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dailyWithCum.map((row) => (
                        <tr key={row.date} className="text-[11px] border-t border-sur-border/30 hover:bg-white/[0.02] transition-colors">
                          <td className="px-4 py-2.5 font-mono text-[10px] text-sur-muted">{row.date}</td>
                          <td className={`text-right px-4 py-2.5 tabular-nums font-semibold ${row.pnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                            {fmtSigned(row.pnl)}
                          </td>
                          <td className="text-right px-4 py-2.5 tabular-nums text-sur-muted">{row.trades}</td>
                          <td className={`text-right px-4 py-2.5 tabular-nums font-semibold ${row.cumPnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                            {fmtSigned(row.cumPnl)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Trade Log (collapsible) */}
            {tradeLog.length > 0 && (
              <div className="mb-8">
                <button
                  onClick={() => setShowTradeLog(!showTradeLog)}
                  className="flex items-center gap-2 mb-4 group"
                >
                  <span className="text-sur-muted"><IconList /></span>
                  <h2 className="text-base font-semibold group-hover:text-sur-accent transition-colors">Trade Log</h2>
                  <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-white/[0.06] text-sur-muted">
                    {tradeLog.length} trades
                  </span>
                  <IconChevron open={showTradeLog} className="text-sur-muted ml-1" />
                </button>

                {showTradeLog && (
                  <div className="bg-sur-surface border border-sur-border rounded-xl overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider border-b border-sur-border">
                          {["#", "Engine", "Side", "Entry Price", "Exit Price", "P&L", "Fees", "Duration", "Exit Reason"].map(h => (
                            <th key={h} className={`${["Engine", "Side", "Exit Reason"].includes(h) ? "text-left" : h === "#" ? "text-center" : "text-right"} px-3 py-2.5 font-medium`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {tradeLog.map((row) => (
                          <tr key={row.id} className="text-[11px] border-t border-sur-border/30 hover:bg-white/[0.02] transition-colors">
                            <td className="text-center px-3 py-2.5 tabular-nums text-sur-muted">{row.id}</td>
                            <td className="px-3 py-2.5 font-medium">{row.engine}</td>
                            <td className="px-3 py-2.5">
                              <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                                row.side === "Long" ? "bg-sur-green/10 text-sur-green" : "bg-sur-red/10 text-sur-red"
                              }`}>
                                {row.side.toUpperCase()}
                              </span>
                            </td>
                            <td className="text-right px-3 py-2.5 tabular-nums font-mono text-[10px]">
                              ${row.entryPrice.toLocaleString("en", { minimumFractionDigits: 2 })}
                            </td>
                            <td className="text-right px-3 py-2.5 tabular-nums font-mono text-[10px]">
                              ${row.exitPrice.toLocaleString("en", { minimumFractionDigits: 2 })}
                            </td>
                            <td className={`text-right px-3 py-2.5 tabular-nums font-semibold ${row.pnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                              {fmtSigned(row.pnl)}
                            </td>
                            <td className="text-right px-3 py-2.5 tabular-nums text-sur-muted">${row.fees.toFixed(2)}</td>
                            <td className="text-right px-3 py-2.5 tabular-nums text-sur-muted">{row.durationMin < 60 ? `${Math.round(row.durationMin)}m` : `${(row.durationMin / 60).toFixed(1)}h`}</td>
                            <td className="px-3 py-2.5">
                              <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${
                                row.exitReason === "TP Hit" ? "bg-sur-green/10 text-sur-green" :
                                row.exitReason === "SL Hit" ? "bg-sur-red/10 text-sur-red" :
                                "bg-sur-yellow/10 text-sur-yellow"
                              }`}>
                                {row.exitReason}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Empty state when no results */}
        {status === "idle" && (
          <div className="bg-sur-surface border border-sur-border rounded-xl overflow-hidden">
            <div className="flex flex-col items-center justify-center py-20">
              <div className="w-16 h-16 rounded-2xl bg-white/[0.04] flex items-center justify-center mb-4">
                <IconFlask className="text-sur-muted w-7 h-7" />
              </div>
              <h3 className="text-sm font-semibold mb-2">No Results Yet</h3>
              <p className="text-xs text-sur-muted text-center max-w-sm mb-6">
                Configure your strategy parameters above and click &quot;Run Backtest&quot; to simulate
                trading performance across historical data with Monte Carlo parameter sampling.
              </p>
              <button
                onClick={handleRun}
                className="flex items-center gap-2 px-5 py-2.5 bg-sur-accent text-white text-xs font-semibold rounded-lg hover:bg-sur-accent/90 transition-colors"
              >
                <IconPlay />
                Run Backtest
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
