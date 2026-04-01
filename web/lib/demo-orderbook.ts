/**
 * Demo orderbook generator — simulates live trading activity.
 * Only active when no WebSocket data is available.
 * Remove this file before mainnet launch.
 */

import type { PriceLevel, TradeEntry } from './trading-zustand';

const BASE_PRICE = 84250;

function initLevels(basePrice: number, side: 'bid' | 'ask', count: number): PriceLevel[] {
  const levels: PriceLevel[] = [];
  let cumTotal = 0;

  for (let i = 0; i < count; i++) {
    const offset = (i + 1) * 1.5;
    const price = side === 'bid' ? basePrice - offset : basePrice + offset;
    const size = 0.05 + Math.random() * 0.3;
    cumTotal += size;
    levels.push({
      price: Math.round(price * 100) / 100,
      size: Math.round(size * 10000) / 10000,
      total: Math.round(cumTotal * 10000) / 10000,
      percentage: 0,
    });
  }

  const maxTotal = levels[levels.length - 1]?.total || 1;
  levels.forEach(l => { l.percentage = (l.total / maxTotal) * 100; });
  return levels;
}

function recalcTotals(levels: PriceLevel[]) {
  let cum = 0;
  for (const l of levels) {
    cum += l.size;
    l.total = Math.round(cum * 10000) / 10000;
  }
  const max = levels[levels.length - 1]?.total || 1;
  levels.forEach(l => { l.percentage = (l.total / max) * 100; });
}

export function createDemoOrderbook() {
  let currentPrice = BASE_PRICE;
  let bids = initLevels(currentPrice, 'bid', 15);
  let asks = initLevels(currentPrice, 'ask', 15);
  let initialized = false;

  return {
    tick: (realPrice?: number) => {
      // Sync to real Binance price if available
      if (realPrice && realPrice > 0) {
        if (!initialized || Math.abs(currentPrice - realPrice) > 50) {
          currentPrice = realPrice;
          bids = initLevels(currentPrice, 'bid', 15);
          asks = initLevels(currentPrice, 'ask', 15);
          initialized = true;
        }
        // Follow real price closely
        currentPrice = realPrice;
      } else {
        // Standalone demo mode
        currentPrice += (Math.random() - 0.5) * 1;
        currentPrice += (BASE_PRICE - currentPrice) * 0.005;
      }

      // Only modify 1-2 random levels per tick (not all)
      const modCount = Math.random() > 0.6 ? 2 : 1;
      for (let i = 0; i < modCount; i++) {
        const idx = Math.floor(Math.random() * 15);
        // Slightly change the size of one level
        const delta = (Math.random() - 0.5) * 0.05;
        if (bids[idx]) bids[idx].size = Math.max(0.01, bids[idx].size + delta);
        if (asks[idx]) asks[idx].size = Math.max(0.01, asks[idx].size + delta);
      }

      recalcTotals(bids);
      recalcTotals(asks);

      // Trade only sometimes (40% chance)
      const trade: TradeEntry | null = Math.random() > 0.6 ? {
        id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        price: Math.round((currentPrice + (Math.random() - 0.5) * 2) * 100) / 100,
        size: Math.round((0.001 + Math.random() * 0.05) * 10000) / 10000,
        side: Math.random() > 0.5 ? 'buy' : 'sell',
        time: new Date().toLocaleTimeString(),
        timestamp: Date.now(),
      } : null;

      return { bids: [...bids], asks: [...asks], trade, markPrice: currentPrice };
    },
  };
}
