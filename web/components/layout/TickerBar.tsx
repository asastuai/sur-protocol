"use client";

import { useEffect, useState } from "react";
import { MARKETS, BINANCE_SYMBOLS, BINANCE_REST_URL } from "@/lib/constants";

interface TickerItem {
  type: "price" | "news";
  symbol?: string;
  price?: number;
  change?: number;
  text?: string;
}

const NEWS_ITEMS: string[] = [
  "Points & Rewards system launching May 2026",
  "Mainnet deployment coming soon",
  "Paper trading live — test with zero risk",
  "Up to 50x leverage on BTC & ETH",
  "Built on Base L2 — low fees, fast execution",
  "EIP-712 signed orders — fully non-custodial",
  "Pyth Oracle integration with Chainlink fallback",
];

export function TickerBar() {
  const [prices, setPrices] = useState<Record<string, { price: number; change: number }>>({});

  useEffect(() => {
    let cancelled = false;
    async function fetchPrices() {
      try {
        const symbols = MARKETS.map(m => BINANCE_SYMBOLS[m.name]?.toUpperCase()).filter(Boolean);
        const url = `${BINANCE_REST_URL}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
        const res = await fetch(url);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const map: Record<string, { price: number; change: number }> = {};
        for (const t of data) {
          const market = Object.entries(BINANCE_SYMBOLS).find(([, s]) => s.toUpperCase() === t.symbol)?.[0];
          if (market) {
            map[market] = { price: parseFloat(t.lastPrice) || 0, change: parseFloat(t.priceChangePercent) || 0 };
          }
        }
        if (!cancelled) setPrices(map);
      } catch {}
    }
    fetchPrices();
    const iv = setInterval(fetchPrices, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  // Build ticker items: alternate prices and news
  const items: TickerItem[] = [];
  for (const m of MARKETS) {
    const p = prices[m.name];
    if (p && p.price > 0) {
      items.push({ type: "price", symbol: m.baseAsset, price: p.price, change: p.change });
    }
  }
  // Sprinkle news between prices
  for (let i = 0; i < NEWS_ITEMS.length; i++) {
    const insertAt = Math.min(3 + i * 3, items.length);
    items.splice(insertAt, 0, { type: "news", text: NEWS_ITEMS[i] });
  }

  if (items.length === 0) return null;

  // Duplicate for seamless loop
  const doubled = [...items, ...items];

  return (
    <div className="h-7 bg-[#16161a] border-t border-sur-border flex-shrink-0 overflow-hidden relative">
      <div className="ticker-scroll flex items-center h-full whitespace-nowrap">
        {doubled.map((item, idx) => (
          <span key={idx} className="inline-flex items-center mx-4 text-[11px]">
            {item.type === "price" ? (
              <>
                <span className="text-sur-muted font-medium">{item.symbol}</span>
                <span className="text-white font-mono ml-1.5">
                  ${item.price! < 1 ? item.price!.toFixed(4) : item.price! < 100 ? item.price!.toFixed(2) : item.price!.toLocaleString("en", { maximumFractionDigits: 0 })}
                </span>
                <span className={`ml-1 font-medium ${item.change! >= 0 ? "text-[#0ECB81]" : "text-[#F6465D]"}`}>
                  {item.change! >= 0 ? "+" : ""}{item.change!.toFixed(2)}%
                </span>
                <span className="text-sur-border mx-3">|</span>
              </>
            ) : (
              <>
                <span className="text-sur-yellow">●</span>
                <span className="text-sur-muted ml-1.5">{item.text}</span>
                <span className="text-sur-border mx-3">|</span>
              </>
            )}
          </span>
        ))}
      </div>

      <style jsx>{`
        .ticker-scroll {
          animation: ticker-slide 60s linear infinite;
        }
        .ticker-scroll:hover {
          animation-play-state: paused;
        }
        @keyframes ticker-slide {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  );
}
