"use client";

import { useState } from "react";

/**
 * MarketSelector — Unified market picker for crypto and stock perps
 *
 * Features:
 * - Tabs: Crypto / Stocks / Favorites
 * - Stock category tags: tech, finance, auto, index
 * - Real-time price display with 24h change
 * - Search filter
 * - Max leverage indicator per market
 */

interface MarketInfo {
  name: string;
  displayName: string;
  ticker: string;
  category: string;
  type: "crypto" | "stock";
  maxLeverage: number;
  price?: number;
  change24h?: number;
}

// Active markets — only list markets that actually exist on the protocol
const MARKETS: MarketInfo[] = [
  { name: "BTC-USD", displayName: "Bitcoin", ticker: "BTC", category: "crypto", type: "crypto", maxLeverage: 50 },
  { name: "ETH-USD", displayName: "Ethereum", ticker: "ETH", category: "crypto", type: "crypto", maxLeverage: 50 },
];

type Tab = "crypto" | "favorites";

const CATEGORY_COLORS: Record<string, string> = {
  crypto: "text-[#FFB224]",
};

interface Props {
  selectedMarket: string;
  onSelectMarket: (marketName: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export default function MarketSelector({ selectedMarket, onSelectMarket, isOpen, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("crypto");
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(new Set(["BTC-USD", "ETH-USD"]));

  if (!isOpen) return null;

  const toggleFav = (name: string) => {
    const next = new Set(favorites);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setFavorites(next);
  };

  const filtered = MARKETS.filter(m => {
    if (search) {
      const q = search.toLowerCase();
      return m.name.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q) || m.ticker.toLowerCase().includes(q);
    }
    if (tab === "favorites") return favorites.has(m.name);
    if (tab === "crypto") return m.type === "crypto";
    return true;
  });

  return (
    <div className="absolute top-12 left-0 z-50 w-80 bg-[#1c1c20] border border-[#28282e] rounded-lg shadow-2xl overflow-hidden">
      {/* Search */}
      <div className="p-3 border-b border-[#28282e]">
        <input
          type="text"
          placeholder="Search markets..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-[#1c1c20] border border-[#28282e] rounded px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-[#0052FF]"
          autoFocus
        />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#28282e]">
        {(["crypto", "favorites"] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              tab === t
                ? "text-white border-b-2 border-[#0052FF]"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t === "favorites" ? "★ Favorites" : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Market List */}
      <div className="max-h-64 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="p-4 text-center text-xs text-gray-500">No markets found</div>
        )}
        {filtered.map(m => (
          <button
            key={m.name}
            onClick={() => { onSelectMarket(m.name); onClose(); }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 hover:bg-[#242428] transition-colors ${
              selectedMarket === m.name ? "bg-[#0052FF]/10" : ""
            }`}
          >
            {/* Favorite star */}
            <span
              onClick={(e) => { e.stopPropagation(); toggleFav(m.name); }}
              className={`text-sm cursor-pointer ${favorites.has(m.name) ? "text-[#FFB224]" : "text-gray-600 hover:text-gray-400"}`}
            >
              ★
            </span>

            {/* Ticker + Name */}
            <div className="flex-1 text-left">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-white">{m.ticker}</span>
                <span className={`text-[9px] ${CATEGORY_COLORS[m.category] || "text-gray-500"}`}>
                  {m.category.toUpperCase()}
                </span>
              </div>
              <div className="text-[10px] text-gray-500">{m.displayName}</div>
            </div>

            {/* Leverage */}
            <div className="text-right">
              <div className="text-[10px] text-gray-400">{m.maxLeverage}x</div>
            </div>
          </button>
        ))}
      </div>

    </div>
  );
}
