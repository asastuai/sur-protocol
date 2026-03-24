'use client';

import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import type { OrderBook, Trade } from '@/lib/front-types';
import { cn } from '@/lib/utils';

interface OrderBookPanelProps {
  orderBook: OrderBook;
  recentTrades: Trade[];
  currentPrice: number;
  priceChange24h?: number;
}

type ViewMode = 'book' | 'trades' | 'both';
type BookMode = 'both' | 'bids' | 'asks';

interface FlashState {
  [key: string]: {
    type: 'new' | 'increase' | 'decrease';
    timestamp: number;
  };
}

export function OrderBookPanel({
  orderBook,
  recentTrades,
  currentPrice,
  priceChange24h = 0
}: OrderBookPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('both');
  const [bookMode, setBookMode] = useState<BookMode>('both');
  const [precision, setPrecision] = useState(2);
  const [flashStates, setFlashStates] = useState<FlashState>({});
  const [newTradeIds, setNewTradeIds] = useState<Set<string>>(new Set());

  const prevBidsRef = useRef<Map<number, number>>(new Map());
  const prevAsksRef = useRef<Map<number, number>>(new Map());
  const prevTradeIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const newFlashStates: FlashState = {};
    const now = Date.now();

    orderBook.bids.forEach((bid) => {
      const prevSize = prevBidsRef.current.get(bid.price);
      const key = `bid-${bid.price}`;
      if (prevSize === undefined) {
        newFlashStates[key] = { type: 'new', timestamp: now };
      } else if (bid.size > prevSize) {
        newFlashStates[key] = { type: 'increase', timestamp: now };
      } else if (bid.size < prevSize) {
        newFlashStates[key] = { type: 'decrease', timestamp: now };
      }
    });

    orderBook.asks.forEach((ask) => {
      const prevSize = prevAsksRef.current.get(ask.price);
      const key = `ask-${ask.price}`;
      if (prevSize === undefined) {
        newFlashStates[key] = { type: 'new', timestamp: now };
      } else if (ask.size > prevSize) {
        newFlashStates[key] = { type: 'increase', timestamp: now };
      } else if (ask.size < prevSize) {
        newFlashStates[key] = { type: 'decrease', timestamp: now };
      }
    });

    if (Object.keys(newFlashStates).length > 0) {
      setFlashStates(prev => ({ ...prev, ...newFlashStates }));
      setTimeout(() => {
        setFlashStates(prev => {
          const updated = { ...prev };
          Object.keys(newFlashStates).forEach(key => {
            if (updated[key]?.timestamp === now) delete updated[key];
          });
          return updated;
        });
      }, 600);
    }

    prevBidsRef.current = new Map(orderBook.bids.map(b => [b.price, b.size]));
    prevAsksRef.current = new Map(orderBook.asks.map(a => [a.price, a.size]));
  }, [orderBook.bids, orderBook.asks]);

  useEffect(() => {
    const currentTradeIds = new Set(recentTrades.map(t => t.id));
    const newTrades = recentTrades.filter(t => !prevTradeIdsRef.current.has(t.id));
    if (newTrades.length > 0) {
      setNewTradeIds(new Set(newTrades.map(t => t.id)));
      setTimeout(() => setNewTradeIds(new Set()), 500);
    }
    prevTradeIdsRef.current = currentTradeIds;
  }, [recentTrades]);

  const formattedPrice = useMemo(() => {
    return currentPrice.toLocaleString('en-US', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision
    });
  }, [currentPrice, precision]);

  const isPositive = priceChange24h >= 0;

  const maxAskTotal = useMemo(() => Math.max(...orderBook.asks.map(a => a.total)), [orderBook.asks]);
  const maxBidTotal = useMemo(() => Math.max(...orderBook.bids.map(b => b.total)), [orderBook.bids]);

  const visibleRows = bookMode === 'both' ? 12 : 24;

  const getFlashClass = useCallback((side: 'bid' | 'ask', price: number) => {
    const key = `${side}-${price}`;
    const flash = flashStates[key];
    if (!flash) return '';
    if (side === 'bid') {
      return flash.type === 'increase' ? 'animate-flash-bid-increase' : 'animate-flash-bid';
    } else {
      return flash.type === 'increase' ? 'animate-flash-ask-increase' : 'animate-flash-ask';
    }
  }, [flashStates]);

  return (
    <div className="flex h-full flex-col bg-card/50">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5">
        <div className="flex items-center gap-1">
          {(['book', 'trades', 'both'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={cn(
                "px-2 py-1 text-[11px] font-medium rounded transition-colors",
                viewMode === mode ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {mode === 'book' ? 'Book' : mode === 'trades' ? 'Trades' : 'Both'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((p) => (
            <button
              key={p}
              onClick={() => setPrecision(p)}
              className={cn(
                "w-5 h-5 text-[10px] font-mono rounded transition-colors",
                precision === p ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              .{p === 0 ? '0' : p === 1 ? '1' : '01'}
            </button>
          ))}
        </div>
      </div>

      {viewMode !== 'trades' && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border/50">
          <button onClick={() => setBookMode('both')} className={cn("p-1 rounded transition-colors", bookMode === 'both' ? "bg-secondary" : "hover:bg-secondary/50")} title="Show both">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="12" height="5" rx="1" className="fill-short/60" />
              <rect x="1" y="8" width="12" height="5" rx="1" className="fill-long/60" />
            </svg>
          </button>
          <button onClick={() => setBookMode('bids')} className={cn("p-1 rounded transition-colors", bookMode === 'bids' ? "bg-secondary" : "hover:bg-secondary/50")} title="Bids only">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="12" height="12" rx="1" className="fill-long/60" />
            </svg>
          </button>
          <button onClick={() => setBookMode('asks')} className={cn("p-1 rounded transition-colors", bookMode === 'asks' ? "bg-secondary" : "hover:bg-secondary/50")} title="Asks only">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="12" height="12" rx="1" className="fill-short/60" />
            </svg>
          </button>
        </div>
      )}

      {viewMode !== 'trades' && (
        <div className="grid grid-cols-3 gap-1 px-3 py-1 text-[10px] text-muted-foreground font-medium">
          <span>Price</span>
          <span className="text-right">Size</span>
          <span className="text-right">Total</span>
        </div>
      )}

      {viewMode !== 'trades' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          {bookMode !== 'bids' && (
            <div className={cn("flex flex-col-reverse overflow-hidden", "flex-1")}>
              {orderBook.asks.slice(0, visibleRows).map((ask, i) => (
                <OrderRow key={`ask-${ask.price}-${i}`} price={ask.price} size={ask.size} total={ask.total} maxTotal={maxAskTotal} side="ask" precision={precision} flashClass={getFlashClass('ask', ask.price)} />
              ))}
            </div>
          )}

          {bookMode === 'both' && (
            <div className="flex items-center justify-between px-3 py-1.5 bg-secondary/30 border-y border-border/30">
              <div className="flex items-center gap-2">
                <span className={cn("font-mono text-sm font-semibold", isPositive ? "text-long" : "text-short")}>
                  {formattedPrice}
                </span>
                <span className={cn("text-[10px] font-mono", isPositive ? "text-long" : "text-short")}>
                  {isPositive ? '+' : ''}{priceChange24h.toFixed(2)}%
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">
                Spread: {orderBook.spread.toFixed(precision)} ({orderBook.spreadPercentage.toFixed(3)}%)
              </span>
            </div>
          )}

          {bookMode !== 'asks' && (
            <div className={cn("flex flex-col overflow-hidden", "flex-1")}>
              {orderBook.bids.slice(0, visibleRows).map((bid, i) => (
                <OrderRow key={`bid-${bid.price}-${i}`} price={bid.price} size={bid.size} total={bid.total} maxTotal={maxBidTotal} side="bid" precision={precision} flashClass={getFlashClass('bid', bid.price)} />
              ))}
            </div>
          )}
        </div>
      )}

      {viewMode !== 'book' && (
        <div className={cn("flex flex-col border-t border-border/50", viewMode === 'trades' ? "flex-1" : "h-[180px]")}>
          {viewMode === 'both' && (
            <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border/30">
              Recent Trades
            </div>
          )}
          <div className="grid grid-cols-3 gap-1 px-3 py-1 text-[10px] text-muted-foreground font-medium">
            <span>Price</span>
            <span className="text-right">Size</span>
            <span className="text-right">Time</span>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {recentTrades.slice(0, viewMode === 'trades' ? 50 : 15).map((trade) => (
              <div
                key={trade.id}
                className={cn(
                  "grid grid-cols-3 gap-1 px-3 py-0.5 text-[11px] hover:bg-secondary/20 transition-colors",
                  newTradeIds.has(trade.id) && "animate-flash-new-trade"
                )}
              >
                <span className={cn("font-mono", trade.side === 'buy' ? "text-long" : "text-short")}>
                  {trade.price.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision })}
                </span>
                <span className="text-right font-mono text-foreground/90">{trade.size.toFixed(4)}</span>
                <span className="text-right font-mono text-muted-foreground">
                  {new Date(trade.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface OrderRowProps {
  price: number;
  size: number;
  total: number;
  maxTotal: number;
  side: 'bid' | 'ask';
  precision: number;
  flashClass?: string;
}

function OrderRow({ price, size, total, maxTotal, side, precision, flashClass }: OrderRowProps) {
  const percentage = (total / maxTotal) * 100;
  const isBid = side === 'bid';

  return (
    <div className={cn("relative grid grid-cols-3 gap-1 px-3 py-[3px] text-[11px] hover:bg-secondary/30 transition-colors cursor-pointer group", flashClass)}>
      <div
        className={cn(
          "absolute top-0 h-full transition-all duration-150",
          isBid ? "left-0 bg-long/[0.08] group-hover:bg-long/[0.15]" : "right-0 bg-short/[0.08] group-hover:bg-short/[0.15]"
        )}
        style={{ width: `${Math.min(percentage, 100)}%` }}
      />
      <span className={cn("relative z-10 font-mono font-medium", isBid ? "text-long" : "text-short")}>
        {price.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision })}
      </span>
      <span className={cn("relative z-10 text-right font-mono text-foreground/90", flashClass && "animate-pulse-size")}>
        {size.toFixed(4)}
      </span>
      <span className="relative z-10 text-right font-mono text-muted-foreground">
        {total.toFixed(4)}
      </span>
    </div>
  );
}
