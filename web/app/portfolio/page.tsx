"use client";

import { useState, useMemo, useEffect } from "react";
import { useAccount } from "wagmi";
import { useTrading } from "@/providers/TradingProvider";
import { fmtPrice, fmtSize } from "@/lib/constants";
import { computePaperPnl } from "@/lib/trading-store";

// ============================================================
//                    COMPONENTS
// ============================================================

function MetricBox({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div>
      <div className="text-[11px] text-sur-muted font-medium uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${color || ""}`}>{value}</div>
      {sub && <div className="text-[11px] text-sur-muted mt-0.5">{sub}</div>}
    </div>
  );
}

type TimeRange = "24h" | "7d" | "30d" | "all";

export default function PortfolioPage() {
  const { isConnected, address } = useAccount();
  const { state } = useTrading();
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [tab, setTab] = useState<"positions" | "orders" | "history" | "vaults">("positions");
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  // Compute real values from paper trading state
  const markPrice = state.markPrice;
  const paperPositions = state.paperPositions;
  const paperOrders = state.paperOrders;
  const paperHistory = state.paperTradeHistory;

  const totalUnrealizedPnl = useMemo(() => {
    return paperPositions.reduce((sum, p) => {
      const { pnl } = computePaperPnl(p, markPrice > 0 ? markPrice : p.entryPrice);
      return sum + pnl;
    }, 0);
  }, [paperPositions, markPrice]);

  const totalMarginUsed = paperPositions.reduce((s, p) => s + p.margin, 0);
  const realizedPnl = state.paperTotalRealizedPnl;
  const equity = state.paperBalance + totalMarginUsed + totalUnrealizedPnl;
  const totalPnl = realizedPnl + totalUnrealizedPnl;
  const deposited = 100_000; // initial paper balance
  const totalPnlPct = deposited > 0 ? (totalPnl / deposited) * 100 : 0;

  const fmt = (n: number) => n >= 0
    ? `$${n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `-$${Math.abs(n).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const fmtSigned = (n: number) => `${n >= 0 ? "+" : ""}${fmt(n)}`;

  // Use paper data OR testnet data
  const isPaper = state.paperMode;
  const positions = isPaper ? [] : state.positions; // testnet positions
  const orders = isPaper ? [] : state.openOrders;

  if (!isConnected && !isPaper) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 rounded-2xl bg-sur-surface border border-sur-border flex items-center justify-center mx-auto mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-sur-muted">
              <path d="M21 12V7H5a2 2 0 010-4h14v4" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3 5v14a2 2 0 002 2h16v-5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M18 12a2 2 0 100 4 2 2 0 000-4z" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <h2 className="text-lg font-semibold mb-2">Connect Your Wallet</h2>
          <p className="text-sm text-sur-muted max-w-sm">
            Connect your wallet to view your portfolio, or switch to Paper Trading mode to practice.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Page header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold">Portfolio</h1>
              {isPaper && (
                <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-sur-yellow/15 text-sur-yellow">
                  Paper
                </span>
              )}
            </div>
            <p className="text-xs text-sur-muted font-mono">
              {isPaper ? "Paper Trading Account" : address}
            </p>
          </div>
          <div className="flex items-center gap-1.5 bg-sur-surface border border-sur-border rounded-lg p-0.5">
            {(["24h", "7d", "30d", "all"] as TimeRange[]).map(r => (
              <button
                key={r}
                onClick={() => setTimeRange(r)}
                className={`px-3 py-1.5 text-[11px] font-medium rounded-md transition-colors ${
                  timeRange === r ? "bg-white/[0.08] text-white" : "text-sur-muted hover:text-sur-text"
                }`}
              >
                {r === "all" ? "All" : r.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Account overview */}
        <div className="grid grid-cols-5 gap-6 mb-8 bg-sur-surface border border-sur-border rounded-xl p-6">
          <MetricBox label="Equity" value={fmt(equity)} />
          <MetricBox
            label="Total PnL"
            value={fmtSigned(totalPnl)}
            sub={`${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}%`}
            color={totalPnl >= 0 ? "text-sur-green" : "text-sur-red"}
          />
          <MetricBox
            label="Unrealized PnL"
            value={fmtSigned(totalUnrealizedPnl)}
            color={totalUnrealizedPnl >= 0 ? "text-sur-green" : "text-sur-red"}
          />
          <MetricBox
            label="Realized PnL"
            value={fmtSigned(realizedPnl)}
            color={realizedPnl >= 0 ? "text-sur-green" : "text-sur-red"}
          />
          <MetricBox label="Available Balance" value={fmt(state.paperBalance)} />
        </div>

        {/* Tabs */}
        <div className="bg-sur-surface border border-sur-border rounded-xl overflow-hidden">
          <div className="flex items-center gap-1 border-b border-sur-border px-4 pt-1">
            {([
              { key: "positions" as const, label: "Open Positions", count: paperPositions.length },
              { key: "orders" as const, label: "Open Orders", count: paperOrders.length },
              { key: "history" as const, label: "Trade History", count: paperHistory.length },
            ]).map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-3 text-[12px] font-medium transition-colors relative ${
                  tab === t.key ? "text-white" : "text-sur-muted hover:text-sur-text"
                }`}
              >
                {t.label}
                {t.count > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[9px] bg-sur-accent/20 text-sur-accent">
                    {t.count}
                  </span>
                )}
                {tab === t.key && (
                  <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-sur-accent" />
                )}
              </button>
            ))}
          </div>

          <div className="min-h-[200px]">
            {tab === "positions" && (
              paperPositions.length === 0 ? (
                <div className="flex items-center justify-center h-48 text-xs text-sur-muted">
                  No open positions
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider">
                      {["Market", "Side", "Size", "Entry", "Mark", "PnL", "Margin", "Leverage"].map(h => (
                        <th key={h} className={`${h === "Market" || h === "Side" ? "text-left" : "text-right"} px-4 py-2.5 font-medium`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paperPositions.map((p) => {
                      const { pnl, pnlPct } = computePaperPnl(p, markPrice > 0 ? markPrice : p.entryPrice);
                      return (
                        <tr key={p.id} className="text-[11px] hover:bg-white/[0.02] border-t border-sur-border/50">
                          <td className="px-4 py-3 font-medium">{p.market}</td>
                          <td className="px-4 py-3">
                            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                              p.side === "long" ? "bg-sur-green/10 text-sur-green" : "bg-sur-red/10 text-sur-red"
                            }`}>
                              {p.side.toUpperCase()} {p.leverage}x
                            </span>
                          </td>
                          <td className="text-right px-4 py-3 tabular-nums">{p.size.toFixed(4)}</td>
                          <td className="text-right px-4 py-3 tabular-nums">{fmtPrice(p.entryPrice)}</td>
                          <td className="text-right px-4 py-3 tabular-nums">{fmtPrice(markPrice)}</td>
                          <td className={`text-right px-4 py-3 tabular-nums font-medium ${pnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                            {pnl >= 0 ? "+" : ""}${Math.abs(pnl).toFixed(2)} ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%)
                          </td>
                          <td className="text-right px-4 py-3 tabular-nums">${p.margin.toFixed(2)}</td>
                          <td className="text-right px-4 py-3 tabular-nums">{p.leverage}x</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )
            )}

            {tab === "orders" && (
              paperOrders.length === 0 ? (
                <div className="flex items-center justify-center h-48 text-xs text-sur-muted">
                  No open orders
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider">
                      {["Market", "Side", "Type", "Price", "Size", "Leverage"].map(h => (
                        <th key={h} className={`${["Market","Side","Type"].includes(h) ? "text-left" : "text-right"} px-4 py-2.5 font-medium`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paperOrders.map((o) => (
                      <tr key={o.id} className="text-[11px] hover:bg-white/[0.02] border-t border-sur-border/50">
                        <td className="px-4 py-3 font-medium">{o.market}</td>
                        <td className={`px-4 py-3 ${o.side === "buy" ? "text-sur-green" : "text-sur-red"}`}>{o.side.toUpperCase()}</td>
                        <td className="px-4 py-3 text-sur-muted">Limit</td>
                        <td className="text-right px-4 py-3 tabular-nums">{fmtPrice(o.price)}</td>
                        <td className="text-right px-4 py-3 tabular-nums">{o.size.toFixed(4)}</td>
                        <td className="text-right px-4 py-3 tabular-nums">{o.leverage}x</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {tab === "history" && (
              paperHistory.length === 0 ? (
                <div className="flex items-center justify-center h-48 text-xs text-sur-muted">
                  No trade history yet — start trading to see your history
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider">
                      {["Market", "Side", "Size", "Price", "PnL", "Fee", "Time"].map(h => (
                        <th key={h} className={`${["Market","Side"].includes(h) ? "text-left" : "text-right"} px-4 py-2.5 font-medium`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paperHistory.slice(0, 50).map((t) => (
                      <tr key={t.id} className="text-[11px] hover:bg-white/[0.02] border-t border-sur-border/50">
                        <td className="px-4 py-3 font-medium">{t.market}</td>
                        <td className={`px-4 py-3 ${t.side === "buy" ? "text-sur-green" : "text-sur-red"}`}>{t.side.toUpperCase()}</td>
                        <td className="text-right px-4 py-3 tabular-nums">{t.size.toFixed(4)}</td>
                        <td className="text-right px-4 py-3 tabular-nums">{fmtPrice(t.price)}</td>
                        <td className={`text-right px-4 py-3 tabular-nums font-medium ${t.pnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                          {t.pnl >= 0 ? "+" : ""}${Math.abs(t.pnl).toFixed(2)}
                        </td>
                        <td className="text-right px-4 py-3 tabular-nums text-sur-muted">${t.fee.toFixed(2)}</td>
                        <td className="text-right px-4 py-3 tabular-nums text-sur-muted">
                          {new Date(t.timestamp).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
