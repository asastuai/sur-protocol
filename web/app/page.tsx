'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useTrading } from '@/providers/TradingProvider';
import { useTradingZustand, computePaperPnl } from '@/lib/trading-zustand';
import { MARKETS, type MarketMeta } from '@/lib/constants';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';

// v2 UI components (FRONT layout)
import {
  OrderBookPanel,
  PositionsPanel as V2PositionsPanel,
  MarketSelectorPanel,
} from '@/components/trading-v2';

// Heavy components — lazy loaded for faster initial render
const Chart = dynamic(() => import('@/components/trading/Chart').then(m => m.Chart), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center h-full bg-sur-bg text-sur-muted text-xs">Loading chart...</div>,
});

const OrderPanel = dynamic(() => import('@/components/trading/OrderPanel').then(m => m.OrderPanel), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center h-full bg-sur-bg text-sur-muted text-xs">Loading...</div>,
});

// Types
import type { Market, OrderBook, Trade, Position, Order } from '@/lib/front-types';

// ============================================================
//  BRIDGE: Convert real Zustand data → v2 component props
// ============================================================

function useMarketBridge(): {
  markets: Market[];
  selectedMarket: Market;
  onSelectMarket: (m: Market) => void;
} {
  const { state, switchMarket, market: marketMeta } = useTrading();
  const markPrice = useTradingZustand(s => s.markPrice);
  const change24h = useTradingZustand(s => s.change24h);
  const volume24h = useTradingZustand(s => s.volume24h);
  const fundingRate = useTradingZustand(s => s.fundingRate);

  const markets: Market[] = useMemo(() =>
    MARKETS.map(m => ({
      symbol: m.name,
      baseAsset: m.baseAsset,
      quoteAsset: m.quoteAsset,
      price: m.name === state.selectedMarket ? markPrice : 0,
      change24h: m.name === state.selectedMarket ? change24h : 0,
      high24h: 0,
      low24h: 0,
      volume24h: m.name === state.selectedMarket ? volume24h : 0,
      openInterest: 0,
      fundingRate: m.name === state.selectedMarket ? fundingRate / 100 : 0,
      nextFunding: '08:00:00',
      markPrice: m.name === state.selectedMarket ? markPrice : 0,
      indexPrice: m.name === state.selectedMarket ? markPrice : 0,
    })),
    [state.selectedMarket, markPrice, change24h, volume24h, fundingRate]
  );

  const selectedMarket = useMemo(() =>
    markets.find(m => m.symbol === state.selectedMarket) || markets[0],
    [markets, state.selectedMarket]
  );

  const onSelectMarket = useCallback((m: Market) => {
    switchMarket(m.symbol);
  }, [switchMarket]);

  return { markets, selectedMarket, onSelectMarket };
}

function useOrderBookBridge(): {
  orderBook: OrderBook;
  recentTrades: Trade[];
} {
  const bids = useTradingZustand(s => s.bids);
  const asks = useTradingZustand(s => s.asks);
  const spread = useTradingZustand(s => s.spread);
  const recentTrades = useTradingZustand(s => s.recentTrades);
  const markPrice = useTradingZustand(s => s.markPrice);

  const orderBook: OrderBook = useMemo(() => ({
    bids: bids.map(b => ({ price: b.price, size: b.size, total: b.total, percentage: b.percentage })),
    asks: asks.map(a => ({ price: a.price, size: a.size, total: a.total, percentage: a.percentage })),
    spread,
    spreadPercentage: markPrice > 0 ? (spread / markPrice) * 100 : 0,
  }), [bids, asks, spread, markPrice]);

  const trades: Trade[] = useMemo(() =>
    recentTrades.map(t => ({
      id: t.id,
      price: t.price,
      size: t.size,
      side: t.side,
      timestamp: t.timestamp,
    })),
    [recentTrades]
  );

  return { orderBook, recentTrades: trades };
}

function usePositionsBridge(): {
  positions: Position[];
  orders: Order[];
} {
  const paperPositions = useTradingZustand(s => s.paperPositions);
  const paperOrders = useTradingZustand(s => s.paperOrders);
  const markPrice = useTradingZustand(s => s.markPrice);

  const positions: Position[] = useMemo(() =>
    paperPositions.map(p => {
      const { pnl, pnlPct, liqPrice } = computePaperPnl(p, markPrice);
      return {
        id: p.id,
        symbol: p.market,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice,
        liquidationPrice: liqPrice,
        margin: p.margin,
        leverage: p.leverage,
        unrealizedPnl: pnl,
        unrealizedPnlPercentage: pnlPct,
        realizedPnl: 0,
      };
    }),
    [paperPositions, markPrice]
  );

  const orders: Order[] = useMemo(() =>
    paperOrders.map(o => ({
      id: o.id,
      symbol: o.market,
      side: o.side,
      type: o.orderType as any,
      status: 'open' as const,
      price: o.price,
      size: o.size,
      filled: 0,
      remaining: o.size,
      reduceOnly: false,
      postOnly: false,
      timestamp: o.createdAt,
    })),
    [paperOrders]
  );

  return { positions, orders };
}

// ============================================================
//  MOBILE LAYOUT
// ============================================================

type MobileTab = 'chart' | 'order' | 'book' | 'positions';

function MobileTradePage() {
  const { state } = useTrading();
  const [tab, setTab] = useState<MobileTab>('chart');
  const { orderBook, recentTrades } = useOrderBookBridge();
  const { selectedMarket } = useMarketBridge();
  const { positions, orders } = usePositionsBridge();

  const handleClosePosition = useCallback((id: string) => {
    const mp = useTradingZustand.getState().markPrice;
    useTradingZustand.getState().actions.paperClosePosition(id, mp, 6);
  }, []);

  const handleCancelOrder = useCallback((id: string) => {
    useTradingZustand.getState().actions.paperCancelOrder(id);
  }, []);

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Mobile tabs */}
      <div className="flex border-b border-border bg-card flex-shrink-0">
        {(['chart', 'order', 'book', 'positions'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-3 text-[11px] font-semibold transition-colors ${
              tab === t
                ? 'text-primary border-b-2 border-primary bg-primary/5'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t === 'chart' ? 'Chart' : t === 'order' ? 'Trade' : t === 'book' ? 'Book' : 'Positions'}
            {t === 'positions' && positions.length > 0 && (
              <span className="ml-1 text-[8px] bg-primary/20 text-primary rounded-full px-1.5 py-0.5">{positions.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'chart' && <Chart market={state.selectedMarket} />}
        {tab === 'order' && (
          <div className="p-3"><OrderPanel /></div>
        )}
        {tab === 'book' && (
          <OrderBookPanel
            orderBook={orderBook}
            recentTrades={recentTrades}
            currentPrice={selectedMarket.price}
            priceChange24h={selectedMarket.change24h}
          />
        )}
        {tab === 'positions' && (
          <V2PositionsPanel
            positions={positions}
            orders={orders}
            onClosePosition={handleClosePosition}
            onCancelOrder={handleCancelOrder}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================
//  DESKTOP LAYOUT
// ============================================================

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < breakpoint);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [breakpoint]);
  return isMobile;
}

export default function TradingPage() {
  const { state } = useTrading();
  const isMobile = useIsMobile();
  const [showSidebar, setShowSidebar] = useState(true);

  const { markets, selectedMarket, onSelectMarket } = useMarketBridge();
  const { orderBook, recentTrades } = useOrderBookBridge();
  const { positions, orders } = usePositionsBridge();

  const handleClosePosition = useCallback((id: string) => {
    const mp = useTradingZustand.getState().markPrice;
    useTradingZustand.getState().actions.paperClosePosition(id, mp, 6);
  }, []);

  const handleCancelOrder = useCallback((id: string) => {
    useTradingZustand.getState().actions.paperCancelOrder(id);
  }, []);

  if (isMobile) return <ErrorBoundary fallbackPage="trading"><MobileTradePage /></ErrorBoundary>;

  return (
    <ErrorBoundary fallbackPage="trading">
    <div className="flex h-full flex-col bg-background">
      {/* Connection status */}
      {(state.wsStatus === 'connecting' || state.wsStatus === 'error') && (
        <div className={`h-6 flex items-center justify-center text-[10px] border-b flex-shrink-0 ${
          state.wsStatus === 'connecting'
            ? 'bg-yellow-500/10 border-yellow-500/20 text-yellow-500'
            : 'bg-short/10 border-short/20 text-short'
        }`}>
          {state.wsStatus === 'connecting' && 'Connecting to trading engine...'}
          {state.wsStatus === 'error' && 'Engine offline — paper trading active'}
        </div>
      )}

      {/* Order notification toast */}
      {state.lastOrderStatus && (
        <div className={`fixed top-16 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-xs font-medium animate-fade-in ${
          state.orderError
            ? 'bg-short/20 text-short border border-short/30'
            : 'bg-long/20 text-long border border-long/30'
        }`}>
          {state.orderError ? `Rejected: ${state.orderError}` : `Order ${state.lastOrderStatus}`}
        </div>
      )}

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Market Selector Sidebar */}
        {showSidebar && (
          <div className="w-64 flex-shrink-0">
            <MarketSelectorPanel
              markets={markets}
              selectedMarket={selectedMarket}
              onSelectMarket={onSelectMarket}
            />
          </div>
        )}

        {/* Toggle Sidebar Button */}
        <button
          onClick={() => setShowSidebar(!showSidebar)}
          className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-r-md border border-l-0 border-border bg-card p-2 text-muted-foreground transition-colors hover:text-foreground"
          style={{ left: showSidebar ? '256px' : '0' }}
        >
          <svg className={`h-4 w-4 transition-transform ${showSidebar ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {/* Trading Area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Top: Chart + OrderBook + OrderPanel */}
          <div className="flex flex-1 overflow-hidden border-b border-border">
            {/* Real TradingView Chart */}
            <div className="flex-1 border-r border-border bg-card overflow-hidden">
              <Chart market={state.selectedMarket} />
            </div>

            {/* Order Book with real data */}
            <div className="w-72 flex-shrink-0 border-r border-border bg-card">
              <OrderBookPanel
                orderBook={orderBook}
                recentTrades={recentTrades}
                currentPrice={selectedMarket.price}
                priceChange24h={selectedMarket.change24h}
              />
            </div>

            {/* Real Order Panel (paper trading engine) */}
            <div className="w-80 flex-shrink-0 bg-card overflow-y-auto scrollbar-thin">
              <OrderPanel />
            </div>
          </div>

          {/* Bottom: Positions & Orders */}
          <div className="h-64 flex-shrink-0 bg-card">
            <V2PositionsPanel
              positions={positions}
              orders={orders}
              onClosePosition={handleClosePosition}
              onCancelOrder={handleCancelOrder}
            />
          </div>
        </div>
      </div>
    </div>
    </ErrorBoundary>
  );
}
