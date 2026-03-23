"use client";

import { useState, useRef, useEffect } from "react";
import { useTrading } from "@/providers/TradingProvider";
import { MARKETS, fmtPrice } from "@/lib/constants";

export function Header() {
  const { state, dispatch, switchMarket } = useTrading();
  const [marketOpen, setMarketOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const price = state.markPrice > 0 ? fmtPrice(state.markPrice) : "—";
  const change = state.change24h || 0;
  const isUp = change >= 0;

  // Show "Live" when we have a real price (from Binance), regardless of SUR WS status
  const hasRealPrice = state.markPrice > 0;
  const wsColor = hasRealPrice ? "#3fb950" : state.wsStatus === "connecting" ? "#e3b341" : "#f85149";
  const wsLabel = hasRealPrice ? "Live" : state.wsStatus === "connecting" ? "Connecting..." : "Offline";

  // Close dropdown on outside click
  useEffect(() => {
    if (!marketOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setMarketOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [marketOpen]);

  return (
    <header className="h-10 border-b border-sur-border bg-sur-bg/50 flex items-center justify-between px-4 flex-shrink-0">
      {/* Left: Market + Price */}
      <div className="flex items-center gap-4">
        {/* Market selector */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setMarketOpen(!marketOpen)}
            className="flex items-center gap-2 px-2.5 py-1 rounded hover:bg-white/[0.04] transition-colors"
          >
            <span className="font-semibold text-sm">{state.selectedMarket}</span>
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none" className={`text-sur-muted transition-transform ${marketOpen ? "rotate-180" : ""}`}>
              <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          {marketOpen && (
            <div className="absolute top-full left-0 mt-1 bg-sur-surface border border-sur-border rounded-md shadow-xl z-50 min-w-[140px] animate-fade-in">
              {MARKETS.map((m) => (
                <button
                  key={m.name}
                  onClick={() => { switchMarket(m.name); setMarketOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-xs hover:bg-white/[0.04] transition-colors ${
                    m.name === state.selectedMarket ? "text-sur-accent font-medium" : "text-sur-text"
                  }`}
                >
                  {m.name}
                  <span className="text-sur-muted ml-2">{m.maxLeverage}x</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="w-px h-5 bg-sur-border" />

        {/* Price */}
        <div className="flex items-center gap-3">
          <span className="tabular-nums font-semibold text-sm">{price}</span>
          {change !== 0 && (
            <span className={`tabular-nums text-xs font-medium ${isUp ? "text-sur-green" : "text-sur-red"}`}>
              {isUp ? "+" : ""}{change.toFixed(2)}%
            </span>
          )}
        </div>

        {/* Stats */}
        <div className="hidden lg:flex items-center gap-5 text-[11px] text-sur-muted">
          <div>
            <span className="mr-1.5">24h Vol</span>
            <span className="text-sur-text tabular-nums">
              {state.volume24h > 0
                ? state.volume24h >= 1e9 ? `$${(state.volume24h / 1e9).toFixed(2)}B` : `$${(state.volume24h / 1e6).toFixed(1)}M`
                : "—"}
            </span>
          </div>
          <div>
            <span className="mr-1.5">OI</span>
            <span className="text-sur-text tabular-nums">
              {state.openInterest > 0 ? `$${(state.openInterest / 1e6).toFixed(1)}M` : "—"}
            </span>
          </div>
          <div>
            <span className="mr-1.5">Funding</span>
            <span className={`tabular-nums ${state.fundingRate >= 0 ? "text-sur-green" : "text-sur-red"}`}>
              {state.fundingRate !== 0 ? `${state.fundingRate > 0 ? "+" : ""}${state.fundingRate.toFixed(4)}%` : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Right: Paper toggle + WS status */}
      <div className="flex items-center gap-3">
        {/* Paper Trading Toggle */}
        <button
          onClick={() => dispatch({ type: "TOGGLE_PAPER_MODE" })}
          className={`flex items-center gap-2 px-2.5 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wider transition-all ${
            state.paperMode
              ? "bg-sur-yellow/15 text-sur-yellow border border-sur-yellow/30 hover:bg-sur-yellow/25"
              : "bg-white/[0.04] text-sur-muted border border-sur-border hover:bg-white/[0.08] hover:text-sur-text"
          }`}
        >
          {/* Toggle switch */}
          <div className={`relative w-6 h-3.5 rounded-full transition-colors ${
            state.paperMode ? "bg-sur-yellow/40" : "bg-sur-border"
          }`}>
            <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full transition-all ${
              state.paperMode ? "left-3 bg-sur-yellow" : "left-0.5 bg-sur-muted"
            }`} />
          </div>
          {state.paperMode ? "Paper" : "Testnet"}
        </button>

        {/* Live status */}
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full live-dot" style={{ background: wsColor }} />
          <span className="text-[10px] text-sur-muted">{wsLabel}</span>
        </div>
      </div>
    </header>
  );
}
