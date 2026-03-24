'use client';

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { Market } from '@/lib/front-types';

interface MarketSelectorProps {
  markets: Market[];
  selectedMarket: Market;
  onSelectMarket: (market: Market) => void;
}

export function MarketSelectorPanel({ markets, selectedMarket, onSelectMarket }: MarketSelectorProps) {
  const [search, setSearch] = useState('');
  const [showFavorites, setShowFavorites] = useState(false);
  const [favorites, setFavorites] = useState<string[]>(['BTC-PERP', 'ETH-PERP']);

  const filteredMarkets = useMemo(() => {
    let filtered = markets;
    if (search) {
      filtered = filtered.filter(m =>
        m.symbol.toLowerCase().includes(search.toLowerCase()) ||
        m.baseAsset.toLowerCase().includes(search.toLowerCase())
      );
    }
    if (showFavorites) {
      filtered = filtered.filter(m => favorites.includes(m.symbol));
    }
    return filtered;
  }, [markets, search, showFavorites, favorites]);

  const toggleFavorite = (symbol: string) => {
    setFavorites(prev =>
      prev.includes(symbol)
        ? prev.filter(s => s !== symbol)
        : [...prev, symbol]
    );
  };

  return (
    <div className="flex h-full flex-col border-r border-border bg-card">
      <div className="border-b border-border p-3">
        <h2 className="mb-3 text-sm font-medium text-foreground">Markets</h2>
        <div className="relative">
          <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search markets..."
            className="w-full rounded-lg border border-border bg-input py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
        </div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => setShowFavorites(false)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              !showFavorites ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            All
          </button>
          <button
            onClick={() => setShowFavorites(true)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              showFavorites ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
            Favorites
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span>Market</span>
        <span className="text-right">Price</span>
        <span className="text-right">24h %</span>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {filteredMarkets.map((market) => (
          <div
            key={market.symbol}
            role="button"
            tabIndex={0}
            onClick={() => onSelectMarket(market)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectMarket(market); } }}
            className={cn(
              'group grid w-full cursor-pointer grid-cols-3 items-center gap-2 px-3 py-2.5 text-left transition-colors',
              selectedMarket.symbol === market.symbol ? 'bg-secondary/70' : 'hover:bg-secondary/30'
            )}
          >
            <div className="flex items-center gap-2">
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); toggleFavorite(market.symbol); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleFavorite(market.symbol); } }}
                className={cn(
                  'cursor-pointer transition-colors',
                  favorites.includes(market.symbol) ? 'text-yellow-500' : 'text-muted-foreground opacity-0 group-hover:opacity-100'
                )}
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill={favorites.includes(market.symbol) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              </span>
              <div>
                <div className="text-sm font-medium text-foreground">{market.baseAsset}</div>
                <div className="text-[10px] text-muted-foreground">PERP</div>
              </div>
            </div>
            <div className="text-right font-mono text-sm text-foreground">
              ${market.price < 1 ? market.price.toFixed(4) : market.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
            <div className={cn('text-right font-mono text-sm', market.change24h >= 0 ? 'text-long' : 'text-short')}>
              {market.change24h >= 0 ? '+' : ''}{market.change24h.toFixed(2)}%
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-border p-3">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-muted-foreground">Total Markets</div>
            <div className="font-mono font-medium text-foreground">{markets.length}</div>
          </div>
          <div>
            <div className="text-muted-foreground">24h Volume</div>
            <div className="font-mono font-medium text-foreground">
              ${(markets.reduce((sum, m) => sum + m.volume24h, 0) / 1_000_000_000).toFixed(2)}B
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
