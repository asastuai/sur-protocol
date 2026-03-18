"use client";

import { useTrading } from "@/providers/TradingProvider";
import { fmtPrice, fmtSize } from "@/lib/constants";

export function RecentTrades() {
  const { state } = useTrading();

  const trades = state.recentTrades;

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-sur-border text-[11px] font-semibold uppercase tracking-wider text-sur-muted">
        Recent Trades
      </div>

      <div className="grid grid-cols-3 px-3 py-1 text-[10px] text-sur-muted font-medium border-b border-sur-border">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Time</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {trades.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[10px] text-sur-muted/60">No trades yet</p>
          </div>
        ) : (
          trades.map((t, i) => (
            <div key={t.id || i} className="grid grid-cols-3 px-3 py-[2.5px] text-[11px] hover:bg-white/[0.02]">
              <span className={`tabular-nums ${t.side === "buy" ? "text-sur-green" : "text-sur-red"}`}>
                {fmtPrice(t.price)}
              </span>
              <span className="tabular-nums text-right">{fmtSize(t.size)}</span>
              <span className="tabular-nums text-right text-sur-muted">{t.time}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
