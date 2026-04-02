"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useTrading } from "@/providers/TradingProvider";
import { fmtPrice, fmtSize } from "@/lib/constants";
import { SkeletonOrderbook } from "@/components/ui/Skeleton";

interface OrderbookProps {
  onPriceClick?: (price: number) => void;
}

// Grouping options for price levels
const GROUPINGS = [0.01, 0.1, 1, 10, 100];

export function Orderbook({ onPriceClick }: OrderbookProps) {
  const { state } = useTrading();
  const [grouping, setGrouping] = useState(0.01);

  // Flash tracking via refs — no re-renders, pure DOM manipulation for performance
  const askRowsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const bidRowsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevBidsRef = useRef<Map<number, number>>(new Map());
  const prevAsksRef = useRef<Map<number, number>>(new Map());
  const flashTimers = useRef<Map<string, number>>(new Map());

  const bids = state.bids;
  const asks = state.asks;
  const hasData = bids.length > 0 || asks.length > 0;

  const lastPrice = state.markPrice > 0 ? fmtPrice(state.markPrice) : "—";
  const dir = state.lastPriceDirection;
  const spread = state.spread > 0 ? state.spread.toFixed(2) : "—";
  const spreadPct =
    state.markPrice > 0 && state.spread > 0
      ? ((state.spread / state.markPrice) * 100).toFixed(3)
      : "—";

  // Max total for depth bar scaling
  const maxTotal = useMemo(() => {
    const askMax = asks.length > 0 ? asks[Math.min(asks.length - 1, 11)]?.total || 0 : 0;
    const bidMax = bids.length > 0 ? bids[Math.min(bids.length - 1, 11)]?.total || 0 : 0;
    return Math.max(askMax, bidMax, 1);
  }, [asks, bids]);

  // Hyperliquid-style flash: instant punch, fast decay
  const triggerFlash = useCallback(
    (key: string, side: "bid" | "ask", el: HTMLDivElement | null) => {
      if (!el) return;

      // Cancel previous flash on this row
      const prev = flashTimers.current.get(key);
      if (prev) cancelAnimationFrame(prev);

      const color =
        side === "bid"
          ? "rgba(14, 203, 129, 0.35)"
          : "rgba(246, 70, 93, 0.35)";

      // Instant punch
      el.style.backgroundColor = color;
      el.style.transition = "none";

      // Force reflow for instant paint
      el.offsetHeight;

      // Fast decay — 200ms ease-out
      const raf = requestAnimationFrame(() => {
        el.style.transition = "background-color 200ms ease-out";
        el.style.backgroundColor = "transparent";
      });

      flashTimers.current.set(key, raf);
    },
    []
  );

  // Detect changes and flash
  useEffect(() => {
    if (!hasData) return;

    bids.forEach((level) => {
      const prevSize = prevBidsRef.current.get(level.price);
      if (prevSize !== undefined && level.size !== prevSize) {
        const key = `bid-${level.price}`;
        triggerFlash(key, "bid", bidRowsRef.current.get(key) || null);
      }
    });

    asks.forEach((level) => {
      const prevSize = prevAsksRef.current.get(level.price);
      if (prevSize !== undefined && level.size !== prevSize) {
        const key = `ask-${level.price}`;
        triggerFlash(key, "ask", askRowsRef.current.get(key) || null);
      }
    });

    prevBidsRef.current = new Map(bids.map((b) => [b.price, b.size]));
    prevAsksRef.current = new Map(asks.map((a) => [a.price, a.size]));
  }, [bids, asks, hasData, triggerFlash]);

  // Cleanup timers
  useEffect(() => {
    return () => {
      flashTimers.current.forEach((raf) => cancelAnimationFrame(raf));
    };
  }, []);

  const registerAskRef = useCallback(
    (key: string) => (el: HTMLDivElement | null) => {
      if (el) askRowsRef.current.set(key, el);
      else askRowsRef.current.delete(key);
    },
    []
  );

  const registerBidRef = useCallback(
    (key: string) => (el: HTMLDivElement | null) => {
      if (el) bidRowsRef.current.set(key, el);
      else bidRowsRef.current.delete(key);
    },
    []
  );

  const cycleGrouping = useCallback(() => {
    setGrouping((prev) => {
      const idx = GROUPINGS.indexOf(prev);
      return GROUPINGS[(idx + 1) % GROUPINGS.length];
    });
  }, []);

  return (
    <div className="flex flex-col h-full select-none" aria-label="Order book" role="region">
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-[--sur-border] flex justify-between items-center">
        <span className="text-xs font-medium text-[--sur-muted] tracking-wide">Orderbook</span>
        <button
          onClick={cycleGrouping}
          className="text-[10px] tabular-nums text-[--sur-muted] hover:text-[--sur-text] px-1.5 py-0.5 rounded hover:bg-white/[0.04] transition-colors"
          title="Change price grouping"
        >
          {grouping < 1 ? grouping.toFixed(2) : grouping.toFixed(0)}
        </button>
      </div>

      {/* Column headers */}
      <div
        className="grid grid-cols-3 px-3 py-1 text-[10px] text-[--sur-muted] font-medium"
        role="row"
        aria-hidden="true"
      >
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>

      {!hasData ? (
        <>
          {state.markPrice > 0 ? (
            <>
              <div className="flex-1 overflow-hidden">
                <SkeletonOrderbook />
              </div>
              <div className="px-3 py-1.5 border-y border-[--sur-border] flex items-center justify-between">
                <span
                  className={`tabular-nums font-semibold text-sm ${
                    dir === "up" ? "text-[--sur-green]" : "text-[--sur-red]"
                  }`}
                >
                  {lastPrice}
                </span>
                <span className="text-[10px] text-[--sur-muted]">Loading...</span>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-2">
                <div className="relative w-6 h-6 mx-auto" role="status" aria-label="Connecting">
                  <div className="absolute inset-0 rounded-full border-2 border-[--sur-border]" />
                  <div className="absolute inset-0 rounded-full border-2 border-[--sur-accent] border-t-transparent animate-spin" />
                </div>
                <span className="text-[10px] text-[--sur-muted]">Connecting...</span>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Asks — lowest at bottom, grows upward */}
          <div className="flex-1 overflow-hidden flex flex-col justify-end" role="list" aria-label="Asks">
            {asks
              .slice(0, 12)
              .reverse()
              .map((level, i) => {
                const key = `ask-${level.price}`;
                const depthPct = Math.min((level.total / maxTotal) * 100, 100);
                return (
                  <div
                    key={key}
                    ref={registerAskRef(key)}
                    role="listitem"
                    onClick={() => onPriceClick?.(level.price)}
                    className="relative grid grid-cols-3 px-3 py-[2px] text-[11px] cursor-pointer group"
                  >
                    {/* Depth bar — grows from right */}
                    <div
                      className="absolute inset-y-0 right-0 bg-[--sur-red] opacity-[0.08] transition-[width] duration-100"
                      style={{ width: `${depthPct}%` }}
                    />
                    {/* Hover highlight */}
                    <div className="absolute inset-0 bg-white opacity-0 group-hover:opacity-[0.03] transition-opacity duration-75" />
                    <span className="tabular-nums text-[--sur-red] relative z-[1]">
                      {fmtPrice(level.price)}
                    </span>
                    <span className="tabular-nums text-right text-[--sur-text] relative z-[1]">
                      {fmtSize(level.size)}
                    </span>
                    <span className="tabular-nums text-right text-[--sur-muted] relative z-[1]">
                      {fmtSize(level.total)}
                    </span>
                  </div>
                );
              })}
          </div>

          {/* Spread / Mid price — the center divider */}
          <div
            className="px-3 py-1.5 border-y border-[--sur-border] flex items-center justify-between"
            aria-label={`Last price ${lastPrice}, spread ${spread}`}
          >
            <div className="flex items-center gap-1.5">
              <span
                className={`tabular-nums font-bold text-[14px] ${
                  dir === "up" ? "text-[--sur-green]" : "text-[--sur-red]"
                }`}
              >
                {lastPrice}
              </span>
              <span
                className={`text-[9px] ${
                  dir === "up" ? "text-[--sur-green]" : "text-[--sur-red]"
                }`}
              >
                {dir === "up" ? "↑" : "↓"}
              </span>
            </div>
            <span className="text-[10px] text-[--sur-muted] tabular-nums">
              {spread} {spreadPct !== "—" ? `(${spreadPct}%)` : ""}
            </span>
          </div>

          {/* Bids — highest at top, grows downward */}
          <div className="flex-1 overflow-hidden" role="list" aria-label="Bids">
            {bids.slice(0, 12).map((level, i) => {
              const key = `bid-${level.price}`;
              const depthPct = Math.min((level.total / maxTotal) * 100, 100);
              return (
                <div
                  key={key}
                  ref={registerBidRef(key)}
                  role="listitem"
                  onClick={() => onPriceClick?.(level.price)}
                  className="relative grid grid-cols-3 px-3 py-[2px] text-[11px] cursor-pointer group"
                >
                  {/* Depth bar */}
                  <div
                    className="absolute inset-y-0 right-0 bg-[--sur-green] opacity-[0.08] transition-[width] duration-100"
                    style={{ width: `${depthPct}%` }}
                  />
                  {/* Hover */}
                  <div className="absolute inset-0 bg-white opacity-0 group-hover:opacity-[0.03] transition-opacity duration-75" />
                  <span className="tabular-nums text-[--sur-green] relative z-[1]">
                    {fmtPrice(level.price)}
                  </span>
                  <span className="tabular-nums text-right text-[--sur-text] relative z-[1]">
                    {fmtSize(level.size)}
                  </span>
                  <span className="tabular-nums text-right text-[--sur-muted] relative z-[1]">
                    {fmtSize(level.total)}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
