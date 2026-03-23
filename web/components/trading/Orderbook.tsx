"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { useTrading } from "@/providers/TradingProvider";
import { fmtPrice, fmtSize } from "@/lib/constants";
import { SkeletonOrderbook } from "@/components/ui/Skeleton";

interface OrderbookProps {
  onPriceClick?: (price: number) => void;
}

interface FlashState {
  [key: string]: {
    type: "new" | "increase" | "decrease";
    timestamp: number;
  };
}

export function Orderbook({ onPriceClick }: OrderbookProps) {
  const { state } = useTrading();
  const [flashStates, setFlashStates] = useState<FlashState>({});

  const prevBidsRef = useRef<Map<number, number>>(new Map());
  const prevAsksRef = useRef<Map<number, number>>(new Map());

  const bids = state.bids;
  const asks = state.asks;
  const hasData = bids.length > 0 || asks.length > 0;

  const lastPrice = state.markPrice > 0 ? fmtPrice(state.markPrice) : "—";
  const dir = state.lastPriceDirection;
  const spread = state.spread > 0 ? state.spread.toFixed(2) : "—";
  const spreadPct = state.markPrice > 0 && state.spread > 0
    ? ((state.spread / state.markPrice) * 100).toFixed(3)
    : "—";

  // Detect order book changes and trigger flash effects
  useEffect(() => {
    if (!hasData) return;

    const newFlashes: FlashState = {};
    const now = Date.now();

    bids.forEach((level) => {
      const prevSize = prevBidsRef.current.get(level.price);
      const key = `bid-${level.price}`;
      if (prevSize === undefined) {
        newFlashes[key] = { type: "new", timestamp: now };
      } else if (level.size > prevSize) {
        newFlashes[key] = { type: "increase", timestamp: now };
      } else if (level.size < prevSize) {
        newFlashes[key] = { type: "decrease", timestamp: now };
      }
    });

    asks.forEach((level) => {
      const prevSize = prevAsksRef.current.get(level.price);
      const key = `ask-${level.price}`;
      if (prevSize === undefined) {
        newFlashes[key] = { type: "new", timestamp: now };
      } else if (level.size > prevSize) {
        newFlashes[key] = { type: "increase", timestamp: now };
      } else if (level.size < prevSize) {
        newFlashes[key] = { type: "decrease", timestamp: now };
      }
    });

    if (Object.keys(newFlashes).length > 0) {
      setFlashStates((prev) => ({ ...prev, ...newFlashes }));

      setTimeout(() => {
        setFlashStates((prev) => {
          const updated = { ...prev };
          Object.keys(newFlashes).forEach((key) => {
            if (updated[key]?.timestamp === now) {
              delete updated[key];
            }
          });
          return updated;
        });
      }, 600);
    }

    prevBidsRef.current = new Map(bids.map((b) => [b.price, b.size]));
    prevAsksRef.current = new Map(asks.map((a) => [a.price, a.size]));
  }, [bids, asks, hasData]);

  const getFlashClass = useCallback(
    (side: "bid" | "ask", price: number) => {
      const key = `${side}-${price}`;
      const flash = flashStates[key];
      if (!flash) return "";

      if (side === "bid") {
        return flash.type === "increase"
          ? "animate-flash-bid-increase"
          : "animate-flash-bid";
      } else {
        return flash.type === "increase"
          ? "animate-flash-ask-increase"
          : "animate-flash-ask";
      }
    },
    [flashStates]
  );

  return (
    <div className="flex flex-col h-full" aria-label="Order book" role="region">
      <div className="px-3 py-2 border-b border-sur-border text-[11px] font-semibold uppercase tracking-wider text-sur-muted flex justify-between items-center">
        <span>Orderbook</span>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-3 px-3 py-1 text-[10px] text-sur-muted font-medium border-b border-sur-border" role="row" aria-hidden="true">
        <span role="columnheader">Price (USD)</span>
        <span role="columnheader" className="text-right">Size</span>
        <span role="columnheader" className="text-right">Total</span>
      </div>

      {!hasData ? (
        <>
          {state.markPrice > 0 ? (
            <>
              <div className="flex-1 overflow-hidden">
                <SkeletonOrderbook />
              </div>
              <div className="px-3 py-2 border-y border-sur-border flex items-center justify-between bg-sur-bg/50">
                <div className="flex items-center gap-2">
                  <span className={`tabular-nums font-semibold text-sm ${dir === "up" ? "text-sur-green" : "text-sur-red"}`}>
                    {lastPrice}
                  </span>
                  <span className={`text-[8px] ${dir === "up" ? "text-sur-green" : "text-sur-red"}`}>
                    {dir === "up" ? "▲" : "▼"}
                  </span>
                </div>
                <span className="text-[10px] text-sur-muted">Loading orderbook...</span>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-2">
                <div className="relative w-8 h-8 mx-auto" role="status" aria-label="Connecting to orderbook">
                  <div className="absolute inset-0 rounded-full border-2 border-sur-border" aria-hidden="true" />
                  <div className="absolute inset-0 rounded-full border-2 border-sur-accent border-t-transparent animate-spin" aria-hidden="true" />
                </div>
                <span className="text-[10px] text-sur-muted" aria-hidden="true">Connecting...</span>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Asks (lowest at bottom) */}
          <div className="flex-1 overflow-hidden flex flex-col justify-end" role="list" aria-label="Ask orders">
            {asks.slice(0, 12).reverse().map((level, i) => {
              const flash = getFlashClass("ask", level.price);
              return (
                <div
                  key={`a${i}`}
                  role="listitem"
                  onClick={() => onPriceClick?.(level.price)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPriceClick?.(level.price); } }}
                  tabIndex={onPriceClick ? 0 : undefined}
                  aria-label={`Ask: price ${fmtPrice(level.price)} USD, size ${fmtSize(level.size)}, total ${fmtSize(level.total)}`}
                  className={`relative grid grid-cols-3 px-3 py-[2.5px] text-[11px] hover:bg-white/[0.03] cursor-pointer transition-colors ${flash}`}
                >
                  <div
                    aria-hidden="true"
                    className="absolute inset-y-0 right-0 bg-sur-red/[0.07] transition-all duration-150"
                    style={{ width: `${Math.min(level.percentage, 98)}%` }}
                  />
                  <span className="tabular-nums text-sur-red relative">{fmtPrice(level.price)}</span>
                  <span className={`tabular-nums text-right relative ${flash ? "animate-pulse-size" : ""}`}>{fmtSize(level.size)}</span>
                  <span className="tabular-nums text-right text-sur-muted relative">{fmtSize(level.total)}</span>
                </div>
              );
            })}
          </div>

          {/* Spread / Last price */}
          <div
            className="px-3 py-2 border-y border-sur-border flex items-center justify-between bg-sur-bg/50"
            aria-label={`Last price ${lastPrice} USD, moving ${dir}. Spread ${spread}${spreadPct !== "—" ? ` (${spreadPct}%)` : ""}`}
          >
            <div className="flex items-center gap-2">
              <span className={`tabular-nums font-semibold text-sm ${dir === "up" ? "text-sur-green" : "text-sur-red"}`}>
                {lastPrice}
              </span>
              <span aria-hidden="true" className={`text-[8px] ${dir === "up" ? "text-sur-green" : "text-sur-red"}`}>
                {dir === "up" ? "▲" : "▼"}
              </span>
            </div>
            <span className="text-[10px] text-sur-muted" aria-hidden="true">
              Spread: {spread} {spreadPct !== "—" ? `(${spreadPct}%)` : ""}
            </span>
          </div>

          {/* Bids */}
          <div className="flex-1 overflow-hidden" role="list" aria-label="Bid orders">
            {bids.slice(0, 12).map((level, i) => {
              const flash = getFlashClass("bid", level.price);
              return (
                <div
                  key={`b${i}`}
                  role="listitem"
                  onClick={() => onPriceClick?.(level.price)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPriceClick?.(level.price); } }}
                  tabIndex={onPriceClick ? 0 : undefined}
                  aria-label={`Bid: price ${fmtPrice(level.price)} USD, size ${fmtSize(level.size)}, total ${fmtSize(level.total)}`}
                  className={`relative grid grid-cols-3 px-3 py-[2.5px] text-[11px] hover:bg-white/[0.03] cursor-pointer transition-colors ${flash}`}
                >
                  <div
                    aria-hidden="true"
                    className="absolute inset-y-0 right-0 bg-sur-green/[0.07] transition-all duration-150"
                    style={{ width: `${Math.min(level.percentage, 98)}%` }}
                  />
                  <span className="tabular-nums text-sur-green relative">{fmtPrice(level.price)}</span>
                  <span className={`tabular-nums text-right relative ${flash ? "animate-pulse-size" : ""}`}>{fmtSize(level.size)}</span>
                  <span className="tabular-nums text-right text-sur-muted relative">{fmtSize(level.total)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
