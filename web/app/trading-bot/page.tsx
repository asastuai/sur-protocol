"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ============================================================
//                    API CONFIG
// ============================================================

const API =
  process.env.NEXT_PUBLIC_WS_URL
    ?.replace("wss://", "https://")
    .replace("ws://", "http://") || "http://localhost:3002";

// ============================================================
//                    TYPES
// ============================================================

interface Engine {
  id: string;
  name: string;
  enabled: boolean;
  winRate: number;
  trades: number;
  netPnl: number;
  confidence: number;
}

interface Position {
  id: string;
  market: string;
  side: "long" | "short";
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  margin: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

interface Trade {
  id: string;
  time: string;
  engine: string;
  market: string;
  side: "long" | "short";
  entry: number;
  exit: number;
  pnl: number;
  fees: number;
  duration: string;
  exitReason: string;
}

interface BotStatus {
  running: boolean;
  uptime: string;
  totalPnl: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  avgHoldTime: string;
}

interface BotConfig {
  maxPositions: number;
  maxTradesPerDay: number;
  maxDrawdown: string;
  kellyFraction: string;
  sizingMode: "fixed" | "kelly" | "adaptive";
}

// ============================================================
//                    HELPER COMPONENTS
// ============================================================

function StatusDot({ active }: { active: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${active ? "bg-sur-green" : "bg-sur-red"}`} />
  );
}

function ToggleSwitch({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative w-9 h-5 rounded-full transition-colors ${enabled ? "bg-sur-green/80" : "bg-white/10"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? "translate-x-4" : "translate-x-0"}`}
      />
    </button>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <svg className="animate-spin h-6 w-6 text-sur-accent" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <span className="ml-2 text-[12px] text-sur-muted">Loading...</span>
    </div>
  );
}

function OfflineBanner() {
  return (
    <div className="bg-sur-red/10 border border-sur-red/30 rounded-xl p-4 mb-6 flex items-center gap-3">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sur-red flex-shrink-0">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
      <div>
        <div className="text-[13px] font-semibold text-sur-red">Backend Offline</div>
        <div className="text-[11px] text-sur-muted">Cannot connect to the trading bot API at {API}. Make sure the backend is running.</div>
      </div>
    </div>
  );
}

// ============================================================
//                    PAGE
// ============================================================

export default function TradingBotPage() {
  // Data states
  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [selectedMarket, setSelectedMarket] = useState("BTC-USD");

  // Risk config
  const [config, setConfig] = useState<BotConfig>({
    maxPositions: 5,
    maxTradesPerDay: 12,
    maxDrawdown: "15",
    kellyFraction: "0.25",
    sizingMode: "adaptive",
  });

  // UI states
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Derived
  const botRunning = botStatus?.running ?? false;
  const totalPnl = botStatus?.totalPnl ?? 0;
  const activePositionCount = positions.length;
  const enabledEngineCount = engines.filter((e) => e.enabled).length;

  // ---- Fetchers ----

  const fetchData = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const [statusRes, enginesRes, tradesRes, positionsRes] = await Promise.all([
        fetch(`${API}/api/bot/status`),
        fetch(`${API}/api/bot/engines`),
        fetch(`${API}/api/bot/trades`),
        fetch(`${API}/api/bot/positions`),
      ]);

      if (!statusRes.ok || !enginesRes.ok || !tradesRes.ok || !positionsRes.ok) {
        throw new Error("API error");
      }

      const [status, eng, trd, pos] = await Promise.all([
        statusRes.json(),
        enginesRes.json(),
        tradesRes.json(),
        positionsRes.json(),
      ]);

      setBotStatus(status);
      setEngines(Array.isArray(eng) ? eng : []);
      setTrades(Array.isArray(trd) ? trd : []);
      setPositions(Array.isArray(pos) ? pos : []);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  // ---- Polling ----

  useEffect(() => {
    fetchData(true);
  }, [fetchData]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (botRunning) {
      pollRef.current = setInterval(() => fetchData(false), 5000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [botRunning, fetchData]);

  // ---- Actions ----

  const toggleBot = async () => {
    setActionLoading(true);
    try {
      const endpoint = botRunning ? "stop" : "start";
      const res = await fetch(`${API}/api/bot/${endpoint}`, { method: "POST" });
      if (res.ok) {
        await fetchData(false);
      }
    } catch {
      setOffline(true);
    } finally {
      setActionLoading(false);
    }
  };

  const toggleEngine = async (name: string) => {
    try {
      const res = await fetch(`${API}/api/bot/engines/${encodeURIComponent(name)}/toggle`, {
        method: "POST",
      });
      if (res.ok) {
        await fetchData(false);
      }
    } catch {
      setOffline(true);
    }
  };

  const updateConfig = async (updates: Partial<BotConfig>) => {
    const newConfig = { ...config, ...updates };
    setConfig(newConfig);
    try {
      await fetch(`${API}/api/bot/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig),
      });
    } catch {
      // silent fail on config save — local state still updates
    }
  };

  const updateConfidence = async (id: string, val: number) => {
    setEngines((prev) => prev.map((e) => (e.id === id ? { ...e, confidence: val } : e)));
  };

  // ---- Formatters ----

  const fmt = (n: number) =>
    n >= 0
      ? `$${n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `-$${Math.abs(n).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const fmtSigned = (n: number) => `${n >= 0 ? "+" : ""}${fmt(n)}`;

  // ---- Render ----

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto px-6 py-8">

        {/* ============================================================ */}
        {/*                    PAGE HEADER                               */}
        {/* ============================================================ */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sur-accent to-purple-500 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a4 4 0 0 1 4 4v1h2a2 2 0 0 1 2 2v2a2 2 0 0 1-1 1.73V18a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5.27A2 2 0 0 1 4 11V9a2 2 0 0 1 2-2h2V6a4 4 0 0 1 4-4z" />
              <path d="M9 14v1" /><path d="M15 14v1" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">AI Trading Bot</h1>
              <span className="px-2 py-0.5 rounded text-[8px] font-bold bg-sur-accent/15 text-sur-accent uppercase tracking-wider">
                Beta
              </span>
            </div>
            <p className="text-sm text-sur-muted">Multi-engine autonomous trading on SUR Protocol</p>
          </div>
        </div>

        {/* Offline banner */}
        {offline && <OfflineBanner />}

        {/* Loading state */}
        {loading && !offline && <LoadingSpinner />}

        {/* Main content — hidden while initial load */}
        {!loading && (
          <>
            {/* ============================================================ */}
            {/*                    STATUS BAR                                */}
            {/* ============================================================ */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-4 mb-6">
              <div className="flex items-center justify-between">
                {/* Bot toggle */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={toggleBot}
                    disabled={actionLoading || offline}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-semibold transition-colors disabled:opacity-50 ${
                      botRunning
                        ? "bg-sur-green/15 text-sur-green hover:bg-sur-green/25"
                        : "bg-sur-red/15 text-sur-red hover:bg-sur-red/25"
                    }`}
                  >
                    {actionLoading ? (
                      <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : botRunning ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="4" width="4" height="16" rx="1" />
                        <rect x="14" y="4" width="4" height="16" rx="1" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                    {actionLoading ? "..." : botRunning ? "Running" : "Stopped"}
                  </button>
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${botRunning ? "bg-sur-green animate-pulse" : "bg-sur-red"}`} />
                    <span className="text-[10px] text-sur-muted">{botRunning ? "Live" : "Idle"}</span>
                  </div>
                </div>

                {/* Metrics row */}
                <div className="flex items-center gap-8">
                  <div className="text-center">
                    <div className="text-[9px] text-sur-muted uppercase tracking-wider mb-0.5">Total P&L</div>
                    <div className={`text-[13px] font-bold tabular-nums ${totalPnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                      {fmtSigned(totalPnl)}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-[9px] text-sur-muted uppercase tracking-wider mb-0.5">Positions</div>
                    <div className="text-[13px] font-bold tabular-nums">{activePositionCount}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[9px] text-sur-muted uppercase tracking-wider mb-0.5">Engines Active</div>
                    <div className="text-[13px] font-bold tabular-nums">{enabledEngineCount}/{engines.length}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[9px] text-sur-muted uppercase tracking-wider mb-0.5">Uptime</div>
                    <div className="text-[13px] font-bold tabular-nums">{botStatus?.uptime ?? "--"}</div>
                  </div>
                  <div>
                    <div className="text-[9px] text-sur-muted uppercase tracking-wider mb-0.5">Market</div>
                    <select
                      value={selectedMarket}
                      onChange={(e) => setSelectedMarket(e.target.value)}
                      className="bg-sur-bg border border-sur-border rounded-md px-2 py-1 text-[12px] text-sur-text focus:outline-none focus:border-sur-accent"
                    >
                      <option value="BTC-USD">BTC-USD</option>
                      <option value="ETH-USD">ETH-USD</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* CTA when bot is stopped */}
              {!botRunning && !offline && (
                <div className="mt-3 pt-3 border-t border-sur-border/50 flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-sur-accent">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span className="text-[11px] text-sur-muted">
                    Bot is stopped. Click <strong className="text-sur-accent">Start</strong> to begin automated trading.
                  </span>
                </div>
              )}
            </div>

            {/* ============================================================ */}
            {/*                    TRADING ENGINES                           */}
            {/* ============================================================ */}
            <div className="mb-6">
              <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-sur-accent">
                  <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                </svg>
                Trading Engines
              </h2>

              {engines.length === 0 ? (
                <div className="bg-sur-surface border border-sur-border rounded-xl p-8 text-center">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-sur-muted mx-auto mb-2">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                  </svg>
                  <div className="text-[12px] text-sur-muted">No trading engines configured</div>
                </div>
              ) : (
                <div className={`grid gap-3`} style={{ gridTemplateColumns: `repeat(${Math.min(engines.length, 7)}, minmax(0, 1fr))` }}>
                  {engines.map((engine) => (
                    <div
                      key={engine.id}
                      className={`bg-sur-surface border rounded-xl p-3 transition-colors ${
                        engine.enabled ? "border-sur-border" : "border-sur-border/50 opacity-60"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-1.5">
                          <StatusDot active={engine.enabled && botRunning} />
                          <span className="text-[10px] font-semibold truncate">{engine.name}</span>
                        </div>
                        <ToggleSwitch enabled={engine.enabled} onToggle={() => toggleEngine(engine.name)} />
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex justify-between text-[9px]">
                          <span className="text-sur-muted">Win Rate</span>
                          <span className={`font-medium tabular-nums ${engine.winRate >= 55 ? "text-sur-green" : "text-sur-yellow"}`}>
                            {engine.winRate}%
                          </span>
                        </div>
                        <div className="flex justify-between text-[9px]">
                          <span className="text-sur-muted">Trades</span>
                          <span className="tabular-nums">{engine.trades}</span>
                        </div>
                        <div className="flex justify-between text-[9px]">
                          <span className="text-sur-muted">Net P&L</span>
                          <span className={`font-medium tabular-nums ${engine.netPnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                            {fmtSigned(engine.netPnl)}
                          </span>
                        </div>
                        <div className="mt-2">
                          <div className="flex justify-between text-[9px] mb-1">
                            <span className="text-sur-muted">Confidence</span>
                            <span className="tabular-nums text-sur-accent">{engine.confidence}%</span>
                          </div>
                          <input
                            type="range"
                            min={10}
                            max={100}
                            step={5}
                            value={engine.confidence}
                            onChange={(e) => updateConfidence(engine.id, Number(e.target.value))}
                            className="w-full h-1 rounded-full appearance-none bg-white/10 accent-sur-accent cursor-pointer"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ============================================================ */}
            {/*                    ACTIVE POSITIONS                          */}
            {/* ============================================================ */}
            <div className="bg-sur-surface border border-sur-border rounded-xl overflow-hidden mb-6">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-sur-border">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-sur-accent">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
                <h2 className="text-[13px] font-semibold">Active Positions</h2>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-sur-accent/20 text-sur-accent font-medium">
                  {positions.length}
                </span>
              </div>

              {positions.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="text-sur-muted/40 mx-auto mb-2">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                  <div className="text-[12px] text-sur-muted">No active positions</div>
                  <div className="text-[10px] text-sur-muted/60 mt-1">
                    {botRunning ? "Waiting for trading signals..." : "Start the bot to open positions"}
                  </div>
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider">
                      {["Market", "Side", "Entry Price", "Current Price", "Size", "Leverage", "Unrealized P&L", "Margin", "Liq. Price"].map((h, i) => (
                        <th key={h} className={`${i < 2 ? "text-left" : "text-right"} px-4 py-2.5 font-medium`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((pos) => (
                      <tr key={pos.id} className="text-[11px] hover:bg-white/[0.02] border-t border-sur-border/50">
                        <td className="px-4 py-3 font-medium">{pos.market}</td>
                        <td className="px-4 py-3">
                          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                            pos.side === "long" ? "bg-sur-green/10 text-sur-green" : "bg-sur-red/10 text-sur-red"
                          }`}>
                            {pos.side.toUpperCase()}
                          </span>
                        </td>
                        <td className="text-right px-4 py-3 tabular-nums">{fmt(pos.entryPrice)}</td>
                        <td className="text-right px-4 py-3 tabular-nums">{fmt(pos.currentPrice)}</td>
                        <td className="text-right px-4 py-3 tabular-nums">{pos.size.toFixed(4)}</td>
                        <td className="text-right px-4 py-3 tabular-nums">{pos.leverage}x</td>
                        <td className={`text-right px-4 py-3 tabular-nums font-medium ${pos.unrealizedPnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                          {fmtSigned(pos.unrealizedPnl)} ({pos.unrealizedPnlPct >= 0 ? "+" : ""}{pos.unrealizedPnlPct.toFixed(1)}%)
                        </td>
                        <td className="text-right px-4 py-3 tabular-nums">{fmt(pos.margin)}</td>
                        <td className="text-right px-4 py-3 tabular-nums text-sur-yellow">{fmt(pos.liquidationPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* ============================================================ */}
            {/*                    RISK SETTINGS + PERFORMANCE               */}
            {/* ============================================================ */}
            <div className="grid grid-cols-3 gap-6 mb-6">
              {/* Risk Settings */}
              <div className="bg-sur-surface border border-sur-border rounded-xl p-4">
                <div className="flex items-center gap-2 mb-4">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-sur-yellow">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                  <h2 className="text-[13px] font-semibold">Risk Settings</h2>
                </div>
                <div className="space-y-4">
                  {/* Max positions */}
                  <div>
                    <div className="flex justify-between text-[10px] mb-1">
                      <span className="text-sur-muted">Max Positions</span>
                      <span className="text-sur-text font-medium tabular-nums">{config.maxPositions}</span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={config.maxPositions}
                      onChange={(e) => updateConfig({ maxPositions: Number(e.target.value) })}
                      className="w-full h-1 rounded-full appearance-none bg-white/10 accent-sur-accent cursor-pointer"
                    />
                    <div className="flex justify-between text-[9px] text-sur-muted mt-0.5">
                      <span>1</span><span>10</span>
                    </div>
                  </div>

                  {/* Max trades per day */}
                  <div>
                    <div className="flex justify-between text-[10px] mb-1">
                      <span className="text-sur-muted">Max Trades / Day</span>
                      <span className="text-sur-text font-medium tabular-nums">{config.maxTradesPerDay}</span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={20}
                      value={config.maxTradesPerDay}
                      onChange={(e) => updateConfig({ maxTradesPerDay: Number(e.target.value) })}
                      className="w-full h-1 rounded-full appearance-none bg-white/10 accent-sur-accent cursor-pointer"
                    />
                    <div className="flex justify-between text-[9px] text-sur-muted mt-0.5">
                      <span>1</span><span>20</span>
                    </div>
                  </div>

                  {/* Max drawdown */}
                  <div>
                    <div className="flex justify-between text-[10px] mb-1">
                      <span className="text-sur-muted">Max Drawdown %</span>
                    </div>
                    <input
                      type="text"
                      value={config.maxDrawdown}
                      onChange={(e) => updateConfig({ maxDrawdown: e.target.value })}
                      className="w-full bg-sur-bg border border-sur-border rounded-md px-3 py-1.5 text-[11px] text-sur-text focus:outline-none focus:border-sur-accent tabular-nums"
                      placeholder="15"
                    />
                  </div>

                  {/* Kelly fraction */}
                  <div>
                    <div className="flex justify-between text-[10px] mb-1">
                      <span className="text-sur-muted">Kelly Fraction</span>
                    </div>
                    <input
                      type="text"
                      value={config.kellyFraction}
                      onChange={(e) => updateConfig({ kellyFraction: e.target.value })}
                      className="w-full bg-sur-bg border border-sur-border rounded-md px-3 py-1.5 text-[11px] text-sur-text focus:outline-none focus:border-sur-accent tabular-nums"
                      placeholder="0.25"
                    />
                  </div>

                  {/* Sizing mode */}
                  <div>
                    <div className="text-[10px] text-sur-muted mb-1.5">Position Sizing</div>
                    <div className="flex gap-1">
                      {(["fixed", "kelly", "adaptive"] as const).map((mode) => (
                        <button
                          key={mode}
                          onClick={() => updateConfig({ sizingMode: mode })}
                          className={`flex-1 px-2 py-1.5 rounded-md text-[10px] font-medium transition-colors ${
                            config.sizingMode === mode
                              ? "bg-sur-accent/20 text-sur-accent border border-sur-accent/30"
                              : "bg-sur-bg text-sur-muted border border-sur-border hover:text-sur-text"
                          }`}
                        >
                          {mode === "adaptive" ? "Adaptive Brain" : mode.charAt(0).toUpperCase() + mode.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Performance Chart Area */}
              <div className="col-span-2 bg-sur-surface border border-sur-border rounded-xl p-4">
                <div className="flex items-center gap-2 mb-4">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-sur-accent">
                    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
                    <polyline points="17 6 23 6 23 12" />
                  </svg>
                  <h2 className="text-[13px] font-semibold">Performance</h2>
                </div>

                {/* Chart placeholder */}
                <div className="relative bg-sur-bg border border-sur-border/50 rounded-lg h-48 flex items-center justify-center mb-4 overflow-hidden">
                  {/* Grid lines */}
                  <div className="absolute inset-0 opacity-[0.04]">
                    {[...Array(6)].map((_, i) => (
                      <div key={`h${i}`} className="absolute w-full border-t border-white" style={{ top: `${(i + 1) * 16.66}%` }} />
                    ))}
                    {[...Array(10)].map((_, i) => (
                      <div key={`v${i}`} className="absolute h-full border-l border-white" style={{ left: `${(i + 1) * 10}%` }} />
                    ))}
                  </div>
                  {/* Simulated equity curve */}
                  <svg viewBox="0 0 400 120" className="absolute inset-0 w-full h-full p-4" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgb(34,197,94)" stopOpacity="0.3" />
                        <stop offset="100%" stopColor="rgb(34,197,94)" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path
                      d="M0,100 L20,95 L40,88 L60,90 L80,78 L100,82 L120,70 L140,65 L160,72 L180,60 L200,55 L220,48 L240,52 L260,40 L280,35 L300,38 L320,28 L340,22 L360,25 L380,18 L400,10"
                      fill="url(#eqGrad)"
                      stroke="none"
                    />
                    <path
                      d="M0,100 L20,95 L40,88 L60,90 L80,78 L100,82 L120,70 L140,65 L160,72 L180,60 L200,55 L220,48 L240,52 L260,40 L280,35 L300,38 L320,28 L340,22 L360,25 L380,18 L400,10"
                      fill="none"
                      stroke="rgb(34,197,94)"
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  <span className="relative text-[11px] text-sur-muted/50 font-medium tracking-wider uppercase">
                    Equity Curve
                  </span>
                </div>

                {/* Stats grid */}
                <div className="grid grid-cols-6 gap-4">
                  {[
                    { label: "Total Trades", value: botStatus?.totalTrades?.toLocaleString() ?? "--" },
                    { label: "Win Rate", value: botStatus?.winRate != null ? `${botStatus.winRate}%` : "--", color: botStatus?.winRate != null && botStatus.winRate >= 50 ? "text-sur-green" : undefined },
                    { label: "Profit Factor", value: botStatus?.profitFactor?.toFixed(2) ?? "--", color: botStatus?.profitFactor != null && botStatus.profitFactor >= 1 ? "text-sur-green" : undefined },
                    { label: "Sharpe Ratio", value: botStatus?.sharpeRatio?.toFixed(2) ?? "--", color: botStatus?.sharpeRatio != null && botStatus.sharpeRatio >= 1 ? "text-sur-green" : undefined },
                    { label: "Max Drawdown", value: botStatus?.maxDrawdown != null ? `${botStatus.maxDrawdown}%` : "--", color: "text-sur-red" },
                    { label: "Avg Hold Time", value: botStatus?.avgHoldTime ?? "--" },
                  ].map((stat) => (
                    <div key={stat.label} className="text-center">
                      <div className="text-[9px] text-sur-muted uppercase tracking-wider mb-0.5">{stat.label}</div>
                      <div className={`text-[13px] font-bold tabular-nums ${stat.color || "text-sur-text"}`}>{stat.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ============================================================ */}
            {/*                    RECENT TRADES LOG                         */}
            {/* ============================================================ */}
            <div className="bg-sur-surface border border-sur-border rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-sur-border">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-sur-accent">
                  <path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" />
                </svg>
                <h2 className="text-[13px] font-semibold">Recent Trades</h2>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/[0.06] text-sur-muted font-medium">
                  {trades.length > 0 ? `Last ${trades.length}` : "0"}
                </span>
              </div>

              {trades.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="text-sur-muted/40 mx-auto mb-2">
                    <path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" />
                  </svg>
                  <div className="text-[12px] text-sur-muted">No trades yet</div>
                  <div className="text-[10px] text-sur-muted/60 mt-1">
                    {botRunning ? "Waiting for the first trade signal..." : "Start the bot to begin trading"}
                  </div>
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider">
                      {["Time", "Engine", "Market", "Side", "Entry", "Exit", "P&L", "Fees", "Duration", "Exit Reason"].map((h, i) => (
                        <th key={h} className={`${i < 4 ? "text-left" : "text-right"} px-3 py-2.5 font-medium`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((trade) => (
                      <tr key={trade.id} className="text-[11px] hover:bg-white/[0.02] border-t border-sur-border/50">
                        <td className="px-3 py-2.5 tabular-nums text-sur-muted font-mono text-[10px]">{trade.time}</td>
                        <td className="px-3 py-2.5 text-[10px]">
                          <span className="px-1.5 py-0.5 rounded bg-white/[0.04] text-sur-text/70">{trade.engine}</span>
                        </td>
                        <td className="px-3 py-2.5 font-medium">{trade.market}</td>
                        <td className="px-3 py-2.5">
                          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                            trade.side === "long" ? "bg-sur-green/10 text-sur-green" : "bg-sur-red/10 text-sur-red"
                          }`}>
                            {trade.side.toUpperCase()}
                          </span>
                        </td>
                        <td className="text-right px-3 py-2.5 tabular-nums">{fmt(trade.entry)}</td>
                        <td className="text-right px-3 py-2.5 tabular-nums">{fmt(trade.exit)}</td>
                        <td className={`text-right px-3 py-2.5 tabular-nums font-medium ${trade.pnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                          {fmtSigned(trade.pnl)}
                        </td>
                        <td className="text-right px-3 py-2.5 tabular-nums text-sur-muted">{fmt(trade.fees)}</td>
                        <td className="text-right px-3 py-2.5 tabular-nums text-sur-muted">{trade.duration}</td>
                        <td className="text-right px-3 py-2.5">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                            trade.exitReason === "TP Hit"
                              ? "bg-sur-green/10 text-sur-green"
                              : trade.exitReason === "SL Hit"
                              ? "bg-sur-red/10 text-sur-red"
                              : "bg-sur-yellow/10 text-sur-yellow"
                          }`}>
                            {trade.exitReason}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer */}
            <div className="mt-8 pt-4 border-t border-sur-border text-center text-[10px] text-sur-muted">
              AI Trading Bot is experimental. All trading involves risk. Past performance does not guarantee future results.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
