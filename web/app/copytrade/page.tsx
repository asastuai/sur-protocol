"use client";

import { useState, useEffect, useCallback } from "react";

// ============================================================
//                    API CONFIG
// ============================================================

import { API_BASE as API } from "@/lib/api-url";

// ============================================================
//                    TYPES
// ============================================================

interface Trader {
  address: string;
  roi30d: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  copiers: number;
  risk: "Low" | "Medium" | "High";
  sparkline: number[];
}

interface ActiveCopy {
  trader: string;
  since: string;
  allocation: number;
  myPnl: number;
  winRate: number;
  status: "Active" | "Paused";
}

interface HistoryRow {
  date: string;
  trader: string;
  market: string;
  side: string;
  entry: number;
  exit: number;
  theirPnl: number;
  myPnl: number;
  fees: number;
}

interface Stats {
  totalCopiers: number;
  copiersChange: string;
  volumeCopied: string;
  volumeChange: string;
  avgRoi: string;
  avgRoiLabel: string;
}

type TraderTab = "top" | "copied" | "risk";
type CopyMode = "Mirror" | "Proportional" | "Fixed";

interface CopySettings {
  maxAllocation: number;
  maxLeverage: number;
  copyPct: number;
  autoStopLoss: boolean;
  copyMode: CopyMode;
}

const DEFAULT_SETTINGS: CopySettings = {
  maxAllocation: 5000,
  maxLeverage: 10,
  copyPct: 50,
  autoStopLoss: true,
  copyMode: "Proportional",
};

// ============================================================
//                    HELPER COMPONENTS
// ============================================================

function RiskBadge({ risk }: { risk: "Low" | "Medium" | "High" }) {
  const styles = {
    Low: "bg-sur-green/10 text-sur-green",
    Medium: "bg-sur-yellow/10 text-sur-yellow",
    High: "bg-sur-red/10 text-sur-red",
  };
  return (
    <span className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${styles[risk]}`}>
      {risk}
    </span>
  );
}

function MiniSparkline({ data, positive }: { data: number[]; positive: boolean }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  return (
    <div className="flex items-end gap-[2px] h-[20px]">
      {data.map((v, i) => (
        <div
          key={i}
          className={`w-[3px] rounded-sm ${positive ? "bg-sur-green/60" : "bg-sur-red/60"}`}
          style={{ height: `${((v - min) / range) * 100}%`, minHeight: "2px" }}
        />
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: "Active" | "Paused" }) {
  return (
    <span className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
      status === "Active" ? "bg-sur-green/10 text-sur-green" : "bg-sur-yellow/10 text-sur-yellow"
    }`}>
      {status}
    </span>
  );
}

// SVG Icons
function IconCopy() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5,3 19,12 5,21" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

function IconX() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconUsers() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

function IconChart() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22,12 18,12 15,21 9,3 6,12 2,12" />
    </svg>
  );
}

function IconTrending() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23,6 13.5,15.5 8.5,10.5 1,18" /><polyline points="17,6 23,6 23,12" />
    </svg>
  );
}

function IconSpinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
      <path d="M21 12a9 9 0 11-6.219-8.56" />
    </svg>
  );
}

// ============================================================
//                    MAIN PAGE
// ============================================================

export default function CopyTradePage() {
  // Data states
  const [stats, setStats] = useState<Stats | null>(null);
  const [traders, setTraders] = useState<Trader[]>([]);
  const [activeCopies, setActiveCopies] = useState<ActiveCopy[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  // Loading states
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingTraders, setLoadingTraders] = useState(true);
  const [loadingCopies, setLoadingCopies] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(true);

  // Error state
  const [error, setError] = useState<string | null>(null);

  // UI states
  const [traderTab, setTraderTab] = useState<TraderTab>("top");
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [expandedSettings, setExpandedSettings] = useState<string | null>(null);
  const [settingsMap, setSettingsMap] = useState<Record<string, CopySettings>>({});
  const [followLoading, setFollowLoading] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState<string | null>(null);

  // ---- Fetch helpers ----

  const safeFetch = useCallback(async (url: string, opts?: RequestInit) => {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Network error";
      throw new Error(message);
    }
  }, []);

  // ---- Initial data load ----

  useEffect(() => {
    // Stats
    safeFetch(`${API}/api/copytrade/stats`)
      .then(data => setStats(data))
      .catch(() => setError("Backend offline — some data may be unavailable"))
      .finally(() => setLoadingStats(false));

    // Traders
    safeFetch(`${API}/api/copytrade/traders`)
      .then(data => {
        setTraders(data);
        // Build initial following set from active copies
      })
      .catch(() => {})
      .finally(() => setLoadingTraders(false));

    // My copies
    safeFetch(`${API}/api/copytrade/my-copies`)
      .then((data: ActiveCopy[]) => {
        setActiveCopies(data);
        setFollowing(new Set(data.map((c: ActiveCopy) => c.trader)));
      })
      .catch(() => {})
      .finally(() => setLoadingCopies(false));

    // History
    safeFetch(`${API}/api/copytrade/history`)
      .then(data => setHistory(data))
      .catch(() => {})
      .finally(() => setLoadingHistory(false));
  }, [safeFetch]);

  // ---- Tab-based sorting fetch ----

  const fetchTradersSorted = useCallback(async (tab: TraderTab) => {
    setTraderTab(tab);
    setLoadingTraders(true);
    const sortMap: Record<TraderTab, string> = { top: "roi", copied: "copiers", risk: "risk" };
    try {
      const data = await safeFetch(`${API}/api/copytrade/traders?sort=${sortMap[tab]}`);
      setTraders(data);
    } catch {
      // keep existing data on error
    } finally {
      setLoadingTraders(false);
    }
  }, [safeFetch]);

  // ---- Follow / Unfollow ----

  const handleFollow = async (traderAddr: string) => {
    setFollowLoading(traderAddr);
    try {
      await safeFetch(`${API}/api/copytrade/follow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trader: traderAddr,
          allocation: 1000,
          maxLeverage: 10,
          copyPct: 100,
          copyMode: "proportional",
          autoStopLoss: true,
        }),
      });
      setFollowing(prev => new Set(prev).add(traderAddr));
      // Refresh copies
      const copies = await safeFetch(`${API}/api/copytrade/my-copies`);
      setActiveCopies(copies);
    } catch {
      setError("Failed to follow trader — try again");
    } finally {
      setFollowLoading(null);
    }
  };

  const handleUnfollow = async (traderAddr: string) => {
    setFollowLoading(traderAddr);
    try {
      await safeFetch(`${API}/api/copytrade/follow/${traderAddr}`, { method: "DELETE" });
      setFollowing(prev => {
        const next = new Set(prev);
        next.delete(traderAddr);
        return next;
      });
      setActiveCopies(prev => prev.filter(c => c.trader !== traderAddr));
    } catch {
      setError("Failed to unfollow trader — try again");
    } finally {
      setFollowLoading(null);
    }
  };

  const toggleFollow = (addr: string) => {
    if (following.has(addr)) {
      handleUnfollow(addr);
    } else {
      handleFollow(addr);
    }
  };

  // ---- Pause / Resume (toggle status locally + re-fetch) ----

  const togglePause = async (trader: string) => {
    const copy = activeCopies.find(c => c.trader === trader);
    if (!copy) return;
    const newStatus = copy.status === "Active" ? "Paused" : "Active";
    // Optimistic update
    setActiveCopies(prev => prev.map(c =>
      c.trader === trader ? { ...c, status: newStatus as "Active" | "Paused" } : c
    ));
    try {
      await safeFetch(`${API}/api/copytrade/config/${trader}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
    } catch {
      // Revert on error
      setActiveCopies(prev => prev.map(c =>
        c.trader === trader ? { ...c, status: copy.status } : c
      ));
    }
  };

  // ---- Settings ----

  const getSettings = (trader: string): CopySettings => settingsMap[trader] || DEFAULT_SETTINGS;

  const updateSettings = (trader: string, partial: Partial<CopySettings>) => {
    setSettingsMap(prev => ({
      ...prev,
      [trader]: { ...getSettings(trader), ...partial },
    }));
  };

  const saveSettings = async (trader: string) => {
    setSavingConfig(trader);
    try {
      const s = getSettings(trader);
      await safeFetch(`${API}/api/copytrade/config/${trader}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s),
      });
      setExpandedSettings(null);
    } catch {
      setError("Failed to save settings — try again");
    } finally {
      setSavingConfig(null);
    }
  };

  // ---- Formatters ----

  const fmt = (n: number) => n >= 0
    ? `$${n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `-$${Math.abs(n).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const fmtCompact = (n: number) => {
    if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">

        {/* ========== ERROR BANNER ========== */}
        {error && (
          <div className="mb-4 bg-sur-red/10 border border-sur-red/30 rounded-xl px-4 py-3 flex items-center justify-between">
            <span className="text-[12px] text-sur-red">{error}</span>
            <button onClick={() => setError(null)} className="text-sur-red hover:text-sur-red/70">
              <IconX />
            </button>
          </div>
        )}

        {/* ========== HERO / SUMMARY ========== */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold">Copy Trading</h1>
            <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-sur-green/15 text-sur-green flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-sur-green animate-pulse" />
              Live
            </span>
          </div>
          <p className="text-sm text-sur-muted">Follow top traders and automatically mirror their positions</p>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <div className="bg-sur-surface border border-sur-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-sur-accent/10 flex items-center justify-center text-sur-accent">
                <IconUsers />
              </div>
              <span className="text-[11px] text-sur-muted font-medium uppercase tracking-wider">Total Copiers</span>
            </div>
            {loadingStats ? (
              <div className="flex items-center gap-2 text-sur-muted"><IconSpinner /> <span className="text-[11px]">Loading...</span></div>
            ) : (
              <>
                <div className="text-xl font-bold tabular-nums">{stats?.totalCopiers?.toLocaleString() ?? "—"}</div>
                <div className="text-[11px] text-sur-green mt-0.5">{stats?.copiersChange ?? ""}</div>
              </>
            )}
          </div>
          <div className="bg-sur-surface border border-sur-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-sur-accent/10 flex items-center justify-center text-sur-accent">
                <IconChart />
              </div>
              <span className="text-[11px] text-sur-muted font-medium uppercase tracking-wider">Volume Copied</span>
            </div>
            {loadingStats ? (
              <div className="flex items-center gap-2 text-sur-muted"><IconSpinner /> <span className="text-[11px]">Loading...</span></div>
            ) : (
              <>
                <div className="text-xl font-bold tabular-nums">{stats?.volumeCopied ?? "—"}</div>
                <div className="text-[11px] text-sur-green mt-0.5">{stats?.volumeChange ?? ""}</div>
              </>
            )}
          </div>
          <div className="bg-sur-surface border border-sur-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-sur-accent/10 flex items-center justify-center text-sur-accent">
                <IconTrending />
              </div>
              <span className="text-[11px] text-sur-muted font-medium uppercase tracking-wider">Avg Copied ROI</span>
            </div>
            {loadingStats ? (
              <div className="flex items-center gap-2 text-sur-muted"><IconSpinner /> <span className="text-[11px]">Loading...</span></div>
            ) : (
              <>
                <div className="text-xl font-bold tabular-nums text-sur-green">{stats?.avgRoi ?? "—"}</div>
                <div className="text-[11px] text-sur-muted mt-0.5">{stats?.avgRoiLabel ?? ""}</div>
              </>
            )}
          </div>
        </div>

        {/* ========== TOP TRADERS ========== */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Top Traders to Follow</h2>
            <div className="flex items-center gap-1 bg-sur-surface border border-sur-border rounded-lg p-0.5">
              {([
                { key: "top" as const, label: "Top Performers" },
                { key: "copied" as const, label: "Most Copied" },
                { key: "risk" as const, label: "Lowest Risk" },
              ]).map(t => (
                <button
                  key={t.key}
                  onClick={() => fetchTradersSorted(t.key)}
                  className={`px-3 py-1.5 text-[11px] font-medium rounded-md transition-colors ${
                    traderTab === t.key ? "bg-white/[0.08] text-white" : "text-sur-muted hover:text-sur-text"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {loadingTraders && traders.length === 0 ? (
            <div className="bg-sur-surface border border-sur-border rounded-xl flex flex-col items-center justify-center py-16">
              <div className="flex items-center gap-2 text-sur-muted">
                <IconSpinner />
                <span className="text-[12px]">Loading traders...</span>
              </div>
            </div>
          ) : traders.length === 0 ? (
            <div className="bg-sur-surface border border-sur-border rounded-xl flex flex-col items-center justify-center py-16">
              <div className="w-14 h-14 rounded-2xl bg-white/[0.04] flex items-center justify-center mb-4 text-sur-muted">
                <IconUsers />
              </div>
              <h3 className="text-sm font-semibold mb-1">No Traders Found</h3>
              <p className="text-[11px] text-sur-muted">Check back soon for top performers</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {traders.map(trader => {
                const isFollowing = following.has(trader.address);
                const isLoading = followLoading === trader.address;
                return (
                  <div key={trader.address} className="bg-sur-surface border border-sur-border rounded-xl p-4 flex flex-col justify-between">
                    {/* Header */}
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-[12px] font-mono font-medium">{trader.address}</span>
                        <RiskBadge risk={trader.risk} />
                      </div>

                      {/* Sparkline */}
                      {trader.sparkline && trader.sparkline.length > 0 && (
                        <div className="mb-3">
                          <MiniSparkline data={trader.sparkline} positive={trader.roi30d >= 0} />
                        </div>
                      )}

                      {/* Metrics grid */}
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-4">
                        <div>
                          <div className="text-[9px] text-sur-muted uppercase tracking-wider">30d ROI</div>
                          <div className={`text-[13px] font-semibold tabular-nums ${trader.roi30d >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                            {trader.roi30d >= 0 ? "+" : ""}{trader.roi30d.toFixed(1)}%
                          </div>
                        </div>
                        <div>
                          <div className="text-[9px] text-sur-muted uppercase tracking-wider">Win Rate</div>
                          <div className="text-[13px] font-semibold tabular-nums">{trader.winRate.toFixed(1)}%</div>
                        </div>
                        <div>
                          <div className="text-[9px] text-sur-muted uppercase tracking-wider">Total P&L</div>
                          <div className={`text-[12px] font-medium tabular-nums ${trader.totalPnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                            {trader.totalPnl >= 0 ? "+" : ""}{fmtCompact(trader.totalPnl)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[9px] text-sur-muted uppercase tracking-wider">Max DD</div>
                          <div className="text-[12px] font-medium tabular-nums text-sur-red">-{trader.maxDrawdown}%</div>
                        </div>
                        <div>
                          <div className="text-[9px] text-sur-muted uppercase tracking-wider">Copiers</div>
                          <div className="text-[12px] font-medium tabular-nums">{trader.copiers.toLocaleString()}</div>
                        </div>
                      </div>
                    </div>

                    {/* Follow button */}
                    <button
                      onClick={() => toggleFollow(trader.address)}
                      disabled={isLoading}
                      className={`w-full py-2 text-[11px] font-semibold rounded-lg transition-colors disabled:opacity-50 ${
                        isFollowing
                          ? "bg-sur-green/15 text-sur-green border border-sur-green/30 hover:bg-sur-red/15 hover:text-sur-red hover:border-sur-red/30"
                          : "bg-sur-accent text-white hover:bg-sur-accent/80"
                      }`}
                    >
                      {isLoading ? (
                        <span className="flex items-center justify-center gap-1.5"><IconSpinner /> Working...</span>
                      ) : isFollowing ? "Following" : "Follow"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ========== MY ACTIVE COPIES ========== */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4">My Active Copies</h2>
          <div className="bg-sur-surface border border-sur-border rounded-xl overflow-hidden">
            {loadingCopies ? (
              <div className="flex flex-col items-center justify-center py-16">
                <div className="flex items-center gap-2 text-sur-muted">
                  <IconSpinner />
                  <span className="text-[12px]">Loading your copies...</span>
                </div>
              </div>
            ) : activeCopies.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16">
                <div className="w-14 h-14 rounded-2xl bg-white/[0.04] flex items-center justify-center mb-4 text-sur-muted">
                  <IconCopy />
                </div>
                <h3 className="text-sm font-semibold mb-1">No Active Copies</h3>
                <p className="text-[11px] text-sur-muted">You&apos;re not copying anyone yet — follow a trader above to start</p>
              </div>
            ) : (
              <>
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider border-b border-sur-border">
                      {["Trader", "Following Since", "Allocation", "My P&L", "Win Rate", "Status", "Actions"].map(h => (
                        <th key={h} className={`${h === "Trader" ? "text-left" : h === "Actions" ? "text-center" : "text-right"} px-4 py-3 font-medium`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activeCopies.map((copy) => (
                      <>
                        <tr key={copy.trader} className="text-[11px] hover:bg-white/[0.02] border-t border-sur-border/30">
                          <td className="px-4 py-3 font-mono font-medium">{copy.trader}</td>
                          <td className="text-right px-4 py-3 tabular-nums text-sur-muted">{copy.since}</td>
                          <td className="text-right px-4 py-3 tabular-nums">{fmt(copy.allocation)}</td>
                          <td className={`text-right px-4 py-3 tabular-nums font-medium ${copy.myPnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                            {copy.myPnl >= 0 ? "+" : ""}{fmt(copy.myPnl)}
                          </td>
                          <td className="text-right px-4 py-3 tabular-nums">{copy.winRate}%</td>
                          <td className="text-right px-4 py-3"><StatusBadge status={copy.status} /></td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                onClick={() => togglePause(copy.trader)}
                                className="p-1.5 rounded-md hover:bg-white/[0.06] text-sur-muted hover:text-sur-text transition-colors"
                                title={copy.status === "Active" ? "Pause" : "Resume"}
                              >
                                {copy.status === "Active" ? <IconPause /> : <IconPlay />}
                              </button>
                              <button
                                onClick={() => setExpandedSettings(expandedSettings === copy.trader ? null : copy.trader)}
                                className="p-1.5 rounded-md hover:bg-white/[0.06] text-sur-muted hover:text-sur-text transition-colors"
                                title="Settings"
                              >
                                <IconGear />
                              </button>
                              <button
                                onClick={() => handleUnfollow(copy.trader)}
                                disabled={followLoading === copy.trader}
                                className="p-1.5 rounded-md hover:bg-sur-red/10 text-sur-muted hover:text-sur-red transition-colors disabled:opacity-50"
                                title="Unfollow"
                              >
                                {followLoading === copy.trader ? <IconSpinner /> : <IconX />}
                              </button>
                            </div>
                          </td>
                        </tr>

                        {/* ========== EXPANDABLE COPY SETTINGS ========== */}
                        {expandedSettings === copy.trader && (
                          <tr key={`${copy.trader}-settings`}>
                            <td colSpan={7} className="border-t border-sur-border/30">
                              <div className="px-6 py-4 bg-white/[0.01]">
                                <div className="flex items-center gap-2 mb-4">
                                  <IconGear />
                                  <span className="text-[12px] font-semibold">Copy Settings for {copy.trader}</span>
                                </div>
                                <div className="grid grid-cols-5 gap-4">
                                  {/* Max Allocation */}
                                  <div>
                                    <label className="text-[9px] text-sur-muted uppercase tracking-wider font-medium block mb-1.5">Max Allocation ($)</label>
                                    <input
                                      type="number"
                                      value={getSettings(copy.trader).maxAllocation}
                                      onChange={e => updateSettings(copy.trader, { maxAllocation: Number(e.target.value) })}
                                      className="w-full bg-sur-bg border border-sur-border rounded-lg px-3 py-2 text-[12px] tabular-nums text-sur-text focus:outline-none focus:border-sur-accent"
                                    />
                                  </div>
                                  {/* Max Leverage */}
                                  <div>
                                    <label className="text-[9px] text-sur-muted uppercase tracking-wider font-medium block mb-1.5">Max Leverage</label>
                                    <input
                                      type="number"
                                      value={getSettings(copy.trader).maxLeverage}
                                      onChange={e => updateSettings(copy.trader, { maxLeverage: Number(e.target.value) })}
                                      className="w-full bg-sur-bg border border-sur-border rounded-lg px-3 py-2 text-[12px] tabular-nums text-sur-text focus:outline-none focus:border-sur-accent"
                                    />
                                  </div>
                                  {/* Copy Percentage */}
                                  <div>
                                    <label className="text-[9px] text-sur-muted uppercase tracking-wider font-medium block mb-1.5">Copy Percentage</label>
                                    <div className="flex gap-1">
                                      {[25, 50, 75, 100].map(pct => (
                                        <button
                                          key={pct}
                                          onClick={() => updateSettings(copy.trader, { copyPct: pct })}
                                          className={`flex-1 py-2 text-[10px] font-medium rounded-md transition-colors ${
                                            getSettings(copy.trader).copyPct === pct
                                              ? "bg-sur-accent text-white"
                                              : "bg-sur-bg border border-sur-border text-sur-muted hover:text-sur-text"
                                          }`}
                                        >
                                          {pct}%
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  {/* Auto Stop Loss */}
                                  <div>
                                    <label className="text-[9px] text-sur-muted uppercase tracking-wider font-medium block mb-1.5">Auto Stop-Loss</label>
                                    <button
                                      onClick={() => updateSettings(copy.trader, { autoStopLoss: !getSettings(copy.trader).autoStopLoss })}
                                      className={`w-full py-2 text-[11px] font-medium rounded-lg border transition-colors ${
                                        getSettings(copy.trader).autoStopLoss
                                          ? "bg-sur-green/10 border-sur-green/30 text-sur-green"
                                          : "bg-sur-bg border-sur-border text-sur-muted"
                                      }`}
                                    >
                                      {getSettings(copy.trader).autoStopLoss ? "Enabled" : "Disabled"}
                                    </button>
                                  </div>
                                  {/* Copy Mode */}
                                  <div>
                                    <label className="text-[9px] text-sur-muted uppercase tracking-wider font-medium block mb-1.5">Copy Mode</label>
                                    <div className="flex flex-col gap-1">
                                      {(["Mirror", "Proportional", "Fixed"] as CopyMode[]).map(mode => (
                                        <button
                                          key={mode}
                                          onClick={() => updateSettings(copy.trader, { copyMode: mode })}
                                          className={`py-1 px-2 text-[10px] font-medium rounded-md text-left transition-colors ${
                                            getSettings(copy.trader).copyMode === mode
                                              ? "bg-sur-accent/15 text-sur-accent"
                                              : "text-sur-muted hover:text-sur-text"
                                          }`}
                                        >
                                          {mode}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                                {/* Save button */}
                                <div className="mt-4 flex justify-end">
                                  <button
                                    onClick={() => saveSettings(copy.trader)}
                                    disabled={savingConfig === copy.trader}
                                    className="px-4 py-2 text-[11px] font-semibold rounded-lg bg-sur-accent text-white hover:bg-sur-accent/80 transition-colors disabled:opacity-50"
                                  >
                                    {savingConfig === copy.trader ? (
                                      <span className="flex items-center gap-1.5"><IconSpinner /> Saving...</span>
                                    ) : "Save Settings"}
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>

        {/* ========== COPY TRADE HISTORY ========== */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4">Copy Trade History</h2>
          <div className="bg-sur-surface border border-sur-border rounded-xl overflow-hidden">
            {loadingHistory ? (
              <div className="flex flex-col items-center justify-center py-16">
                <div className="flex items-center gap-2 text-sur-muted">
                  <IconSpinner />
                  <span className="text-[12px]">Loading history...</span>
                </div>
              </div>
            ) : history.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16">
                <div className="w-14 h-14 rounded-2xl bg-white/[0.04] flex items-center justify-center mb-4 text-sur-muted">
                  <IconChart />
                </div>
                <h3 className="text-sm font-semibold mb-1">No Copy Trades Yet</h3>
                <p className="text-[11px] text-sur-muted">No copy trades yet</p>
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider border-b border-sur-border">
                    {["Date", "Copied Trader", "Market", "Side", "Entry", "Exit", "Their P&L", "My P&L", "Fees"].map(h => (
                      <th key={h} className={`${["Date", "Copied Trader", "Market", "Side"].includes(h) ? "text-left" : "text-right"} px-4 py-3 font-medium`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.map((row, i) => (
                    <tr key={i} className="text-[11px] hover:bg-white/[0.02] border-t border-sur-border/30">
                      <td className="px-4 py-3 text-sur-muted tabular-nums whitespace-nowrap">{row.date}</td>
                      <td className="px-4 py-3 font-mono font-medium">{row.trader}</td>
                      <td className="px-4 py-3 font-medium">{row.market}</td>
                      <td className="px-4 py-3">
                        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                          row.side === "Long" ? "bg-sur-green/10 text-sur-green" : "bg-sur-red/10 text-sur-red"
                        }`}>
                          {row.side.toUpperCase()}
                        </span>
                      </td>
                      <td className="text-right px-4 py-3 tabular-nums">${row.entry.toLocaleString("en", { minimumFractionDigits: 1 })}</td>
                      <td className="text-right px-4 py-3 tabular-nums">${row.exit.toLocaleString("en", { minimumFractionDigits: 1 })}</td>
                      <td className={`text-right px-4 py-3 tabular-nums font-medium ${row.theirPnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                        {row.theirPnl >= 0 ? "+" : ""}{fmt(row.theirPnl)}
                      </td>
                      <td className={`text-right px-4 py-3 tabular-nums font-medium ${row.myPnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                        {row.myPnl >= 0 ? "+" : ""}{fmt(row.myPnl)}
                      </td>
                      <td className="text-right px-4 py-3 tabular-nums text-sur-muted">${row.fees.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Info card */}
        <div className="bg-sur-surface border border-sur-border rounded-xl p-5 mb-8">
          <h3 className="text-sm font-semibold mb-2">How Copy Trading Works</h3>
          <div className="grid grid-cols-3 gap-4 text-[11px] text-sur-muted">
            <div>
              <span className="text-sur-text font-medium">Mirror Mode</span>
              <p className="mt-1 leading-relaxed">Opens the exact same position size as the trader. Best for similar account sizes.</p>
            </div>
            <div>
              <span className="text-sur-text font-medium">Proportional Mode</span>
              <p className="mt-1 leading-relaxed">Adjusts position size based on the ratio of your allocation to the trader&apos;s portfolio. Recommended for most users.</p>
            </div>
            <div>
              <span className="text-sur-text font-medium">Fixed Mode</span>
              <p className="mt-1 leading-relaxed">Uses a fixed USD amount per copied trade regardless of the trader&apos;s position size. Good for risk control.</p>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
