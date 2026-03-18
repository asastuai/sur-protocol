"use client";

import { useTrading } from "@/providers/TradingProvider";
import { fmtPrice, fmtSize } from "@/lib/constants";

interface OrderbookProps {
  onPriceClick?: (price: number) => void;
}

export function Orderbook({ onPriceClick }: OrderbookProps) {
  const { state } = useTrading();

  const bids = state.bids;
  const asks = state.asks;
  const hasData = bids.length > 0 || asks.length > 0;

  const lastPrice = state.markPrice > 0 ? fmtPrice(state.markPrice) : "—";
  const dir = state.lastPriceDirection;
  const spread = state.spread > 0 ? state.spread.toFixed(2) : "—";
  const spreadPct = state.markPrice > 0 && state.spread > 0
    ? ((state.spread / state.markPrice) * 100).toFixed(3)
    : "—";

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-sur-border text-[11px] font-semibold uppercase tracking-wider text-sur-muted flex justify-between items-center">
        <span>Orderbook</span>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-3 px-3 py-1 text-[10px] text-sur-muted font-medium border-b border-sur-border">
        <span>Price (USD)</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>

      {!hasData ? (
        <>
          {/* Empty asks area */}
          <div className="flex-1 flex items-end justify-center pb-2">
            <span className="text-[10px] text-sur-muted/40">—</span>
          </div>

          {/* Spread / Last price */}
          <div className="px-3 py-2 border-y border-sur-border flex items-center justify-between bg-sur-bg/50">
            <div className="flex items-center gap-2">
              <span className={`tabular-nums font-semibold text-sm ${state.markPrice > 0 ? (dir === "up" ? "text-sur-green" : "text-sur-red") : "text-sur-muted"}`}>
                {lastPrice}
              </span>
              {state.markPrice > 0 && (
                <span className={`text-[8px] ${dir === "up" ? "text-sur-green" : "text-sur-red"}`}>
                  {dir === "up" ? "▲" : "▼"}
                </span>
              )}
            </div>
            <span className="text-[10px] text-sur-muted">
              No orderbook data
            </span>
          </div>

          {/* Empty bids area */}
          <div className="flex-1 flex items-start justify-center pt-2">
            <span className="text-[10px] text-sur-muted/40">—</span>
          </div>
        </>
      ) : (
        <>
          {/* Asks (lowest at bottom) */}
          <div className="flex-1 overflow-hidden flex flex-col justify-end">
            {asks.slice(0, 12).reverse().map((level, i) => (
              <div
                key={`a${i}`}
                onClick={() => onPriceClick?.(level.price)}
                className="relative grid grid-cols-3 px-3 py-[2.5px] text-[11px] hover:bg-white/[0.03] cursor-pointer"
              >
                <div
                  className="absolute inset-y-0 right-0 bg-sur-red/[0.07]"
                  style={{ width: `${Math.min(level.percentage, 98)}%` }}
                />
                <span className="tabular-nums text-sur-red relative">{fmtPrice(level.price)}</span>
                <span className="tabular-nums text-right relative">{fmtSize(level.size)}</span>
                <span className="tabular-nums text-right text-sur-muted relative">{fmtSize(level.total)}</span>
              </div>
            ))}
          </div>

          {/* Spread / Last price */}
          <div className="px-3 py-2 border-y border-sur-border flex items-center justify-between bg-sur-bg/50">
            <div className="flex items-center gap-2">
              <span className={`tabular-nums font-semibold text-sm ${dir === "up" ? "text-sur-green" : "text-sur-red"}`}>
                {lastPrice}
              </span>
              <span className={`text-[8px] ${dir === "up" ? "text-sur-green" : "text-sur-red"}`}>
                {dir === "up" ? "▲" : "▼"}
              </span>
            </div>
            <span className="text-[10px] text-sur-muted">
              Spread: {spread} {spreadPct !== "—" ? `(${spreadPct}%)` : ""}
            </span>
          </div>

          {/* Bids */}
          <div className="flex-1 overflow-hidden">
            {bids.slice(0, 12).map((level, i) => (
              <div
                key={`b${i}`}
                onClick={() => onPriceClick?.(level.price)}
                className="relative grid grid-cols-3 px-3 py-[2.5px] text-[11px] hover:bg-white/[0.03] cursor-pointer"
              >
                <div
                  className="absolute inset-y-0 right-0 bg-sur-green/[0.07]"
                  style={{ width: `${Math.min(level.percentage, 98)}%` }}
                />
                <span className="tabular-nums text-sur-green relative">{fmtPrice(level.price)}</span>
                <span className="tabular-nums text-right relative">{fmtSize(level.size)}</span>
                <span className="tabular-nums text-right text-sur-muted relative">{fmtSize(level.total)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
