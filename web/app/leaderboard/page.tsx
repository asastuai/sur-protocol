"use client";

import { useState, useMemo, useEffect } from "react";
import { useTrading } from "@/providers/TradingProvider";

export default function LeaderboardPage() {
  const { state } = useTrading();
  const [period, setPeriod] = useState<"7d" | "30d" | "all">("30d");
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  // Build leaderboard from paper trading history (real user data)
  const entries = useMemo(() => {
    if (!mounted) return [];

    // Aggregate paper trade history into a leaderboard-like view
    const history = state.paperTradeHistory;
    if (history.length === 0) return [];

    // Group by market
    const byMarket: Record<string, { pnl: number; volume: number; trades: number; wins: number }> = {};
    for (const trade of history) {
      if (!byMarket[trade.market]) {
        byMarket[trade.market] = { pnl: 0, volume: 0, trades: 0, wins: 0 };
      }
      byMarket[trade.market].pnl += trade.pnl;
      byMarket[trade.market].volume += trade.price * trade.size;
      byMarket[trade.market].trades += 1;
      if (trade.pnl > 0) byMarket[trade.market].wins += 1;
    }

    return Object.entries(byMarket).map(([market, data], i) => ({
      rank: i + 1,
      market,
      pnl: data.pnl,
      volume: data.volume,
      trades: data.trades,
      winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
    }));
  }, [mounted, state.paperTradeHistory]);

  const hasTrades = entries.length > 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold mb-2">Leaderboard</h1>
            <p className="text-sm text-sur-muted">Top traders ranked by PnL performance</p>
          </div>
          <div className="flex items-center gap-1 bg-sur-surface border border-sur-border rounded-lg p-0.5">
            {(["7d", "30d", "all"] as const).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 text-[11px] font-medium rounded-md transition-colors ${
                  period === p ? "bg-white/[0.08] text-white" : "text-sur-muted hover:text-sur-text"
                }`}
              >
                {p === "all" ? "All Time" : p.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {!hasTrades ? (
          <div className="bg-sur-surface border border-sur-border rounded-xl overflow-hidden">
            <div className="flex flex-col items-center justify-center py-20">
              <div className="w-16 h-16 rounded-2xl bg-white/[0.04] flex items-center justify-center mb-4">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-sur-muted">
                  <path d="M8 21h8M12 17v4M17 4H7l-2 8h14l-2-8zM7 4V2h10v2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <h3 className="text-sm font-semibold mb-2">Leaderboard Coming Soon</h3>
              <p className="text-xs text-sur-muted text-center max-w-sm mb-6">
                The leaderboard will populate once trading activity begins on-chain.
                Start paper trading now to practice your strategies.
              </p>
              <a
                href="/"
                className="px-5 py-2.5 bg-sur-accent text-white text-xs font-semibold rounded-lg hover:bg-sur-accent/90 transition-colors"
              >
                Start Trading
              </a>
            </div>
          </div>
        ) : (
          <div className="bg-sur-surface border border-sur-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-sur-border">
              <span className="text-[10px] text-sur-muted uppercase tracking-wider font-medium">Your Paper Trading Stats</span>
            </div>
            <table className="w-full">
              <thead>
                <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider border-b border-sur-border">
                  {["Market", "PnL", "Volume", "Trades", "Win Rate"].map(h => (
                    <th key={h} className={`${h === "Market" ? "text-left" : "text-right"} px-4 py-3 font-medium`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.market} className="text-[12px] hover:bg-white/[0.02] border-t border-sur-border/30">
                    <td className="px-4 py-3 font-medium">{e.market}</td>
                    <td className={`text-right px-4 py-3 tabular-nums font-semibold ${e.pnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                      {e.pnl >= 0 ? "+" : ""}${Math.abs(e.pnl).toLocaleString("en", { maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right px-4 py-3 tabular-nums text-sur-muted">
                      ${e.volume.toLocaleString("en", { maximumFractionDigits: 0 })}
                    </td>
                    <td className="text-right px-4 py-3 tabular-nums text-sur-muted">{e.trades}</td>
                    <td className="text-right px-4 py-3 tabular-nums">{e.winRate.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Info card */}
        <div className="mt-8 bg-sur-surface border border-sur-border rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-2">How Rankings Work</h3>
          <div className="grid grid-cols-3 gap-4 text-[11px] text-sur-muted">
            <div>
              <span className="text-sur-text font-medium">PnL Ranking</span>
              <p className="mt-1 leading-relaxed">Traders are ranked by absolute PnL in the selected time period. Only realized PnL from closed positions counts.</p>
            </div>
            <div>
              <span className="text-sur-text font-medium">Volume</span>
              <p className="mt-1 leading-relaxed">Total notional value of all executed trades. Higher volume with consistent PnL indicates a skilled trader.</p>
            </div>
            <div>
              <span className="text-sur-text font-medium">Win Rate</span>
              <p className="mt-1 leading-relaxed">Percentage of trades that were closed with a profit. A high win rate combined with positive PnL shows consistency.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
