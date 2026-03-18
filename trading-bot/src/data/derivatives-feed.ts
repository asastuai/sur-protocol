// ============================================================
// src/data/derivatives-feed.ts
// 
// Quant data layer for bot v4.0 Structure-First
// Fetches: Funding Rate, Open Interest, Long/Short Ratio,
//          Order Book Depth, Liquidations (WebSocket)
//
// Aster DEX API (Binance-compatible)
// Base URL: https://fapi.asterdex.com
// WebSocket: wss://fstream.asterdex.com
// 
// All endpoints are PUBLIC — no API key needed
// ============================================================

import WebSocket from 'ws';

// ── Types ──

export interface DerivativesData {
  // Funding Rate
  fundingRate: number;            // e.g. 0.0003 = 0.03%
  fundingRatePct: number;         // e.g. 0.03 (human readable %)
  nextFundingTime: number;        // ms timestamp
  hoursUntilFunding: number;      // hours until next funding
  fundingSignal: 'LONGS_PAY' | 'SHORTS_PAY' | 'NEUTRAL';
  
  // Open Interest
  openInterest: number;           // total OI in contracts
  openInterestUsd: number;        // total OI in USD
  oiChange5m: number;             // % change last 5 min
  oiChange1h: number;             // % change last 1 hour
  oiChange4h: number;             // % change last 4 hours
  oiTrend: 'RISING' | 'FALLING' | 'FLAT';
  
  // Long/Short Ratio
  longShortRatio: number;         // e.g. 1.5 = more longs
  topTraderLSRatio: number;       // top traders L/S ratio
  crowdedSide: 'LONG_CROWDED' | 'SHORT_CROWDED' | 'BALANCED';
  
  // Order Book Imbalance
  bidDepthUsd: number;            // total $ in top 20 bids
  askDepthUsd: number;            // total $ in top 20 asks
  bookImbalance: number;          // -1 to +1 (positive = more bids)
  nearestBidWall: number | null;  // price of biggest bid cluster
  nearestAskWall: number | null;  // price of biggest ask cluster
  
  // Recent Liquidations (from WebSocket buffer)
  recentLiquidations: {
    totalLongLiqUsd1h: number;    // $ liquidated longs in last 1h
    totalShortLiqUsd1h: number;   // $ liquidated shorts in last 1h
    dominantSide: 'LONG_LIQD' | 'SHORT_LIQD' | 'BALANCED';
    lastBigLiq: { side: string; price: number; usd: number; time: number } | null;
  };
  
  // Meta
  timestamp: number;
  stale: boolean;                 // true if data is >2 min old
}

// ── Config ──

const BASE_URL = 'https://fapi.asterdex.com';
const WS_URL = 'wss://fstream.asterdex.com';
const SYMBOL = 'BTCUSDT';

// ── Main Class ──

export class DerivativesFeed {
  private oiHistory: { time: number; oi: number }[] = [];
  private liqBuffer: { side: string; price: number; qty: number; usd: number; time: number }[] = [];
  private liqWs: WebSocket | null = null;
  private lastData: DerivativesData | null = null;
  private lastFetchTime = 0;
  private cacheTtlMs = 30_000; // Cache 30s (no spam API)

  constructor(
    private symbol: string = SYMBOL,
    private baseUrl: string = BASE_URL,
    private wsUrl: string = WS_URL,
  ) {}

  // ── Initialize: start liquidation WebSocket ──
  
  init(): void {
    this.startLiquidationStream();
    console.log(`📡 DerivativesFeed initialized for ${this.symbol}`);
  }

  // ── Main fetch: returns all derivatives data ──
  
  async fetch(): Promise<DerivativesData> {
    // Return cache if fresh
    if (this.lastData && Date.now() - this.lastFetchTime < this.cacheTtlMs) {
      return this.lastData;
    }

    try {
      const [funding, oi, oiHist, lsGlobal, lsTop, book] = await Promise.all([
        this.fetchFundingRate(),
        this.fetchOpenInterest(),
        this.fetchOIHistory(),
        this.fetchGlobalLongShortRatio(),
        this.fetchTopTraderLongShortRatio(),
        this.fetchOrderBookDepth(),
      ]);

      // ── Process Funding Rate ──
      const fundingRate = parseFloat(funding.lastFundingRate || '0');
      const nextFundingTime = parseInt(funding.nextFundingTime || '0');
      const hoursUntilFunding = Math.max(0, (nextFundingTime - Date.now()) / 3_600_000);

      // ── Process Open Interest ──
      const currentOi = parseFloat(oi.openInterest || '0');
      const markPrice = parseFloat(funding.markPrice || funding.indexPrice || '65000');
      const oiUsd = currentOi * markPrice;

      // Store OI history
      this.oiHistory.push({ time: Date.now(), oi: currentOi });
      // Keep last 4h only
      const fourHoursAgo = Date.now() - 4 * 3_600_000;
      this.oiHistory = this.oiHistory.filter(h => h.time > fourHoursAgo);

      // Calculate OI changes from API history
      const oiChanges = this.calcOIChanges(oiHist, currentOi);

      // ── Process Long/Short Ratio ──
      const globalLS = parseFloat(lsGlobal?.longShortRatio || '1');
      const topLS = parseFloat(lsTop?.longShortRatio || '1');

      // ── Process Order Book ──
      const bookAnalysis = this.analyzeOrderBook(book, markPrice);

      // ── Process Liquidations (from WebSocket buffer) ──
      const liqAnalysis = this.analyzeLiquidations();

      const data: DerivativesData = {
        // Funding
        fundingRate,
        fundingRatePct: fundingRate * 100,
        nextFundingTime,
        hoursUntilFunding,
        fundingSignal: fundingRate > 0.0003 ? 'LONGS_PAY' :
                       fundingRate < -0.0002 ? 'SHORTS_PAY' : 'NEUTRAL',

        // OI
        openInterest: currentOi,
        openInterestUsd: oiUsd,
        oiChange5m: oiChanges.change5m,
        oiChange1h: oiChanges.change1h,
        oiChange4h: oiChanges.change4h,
        oiTrend: oiChanges.change1h > 2 ? 'RISING' :
                 oiChanges.change1h < -2 ? 'FALLING' : 'FLAT',

        // Long/Short
        longShortRatio: globalLS,
        topTraderLSRatio: topLS,
        crowdedSide: globalLS > 1.8 ? 'LONG_CROWDED' :
                     globalLS < 0.6 ? 'SHORT_CROWDED' : 'BALANCED',

        // Order Book
        ...bookAnalysis,

        // Liquidations
        recentLiquidations: liqAnalysis,

        // Meta
        timestamp: Date.now(),
        stale: false,
      };

      this.lastData = data;
      this.lastFetchTime = Date.now();
      return data;

    } catch (err) {
      console.error('❌ DerivativesFeed fetch error:', err);
      // Return stale data if available
      if (this.lastData) {
        return { ...this.lastData, stale: true };
      }
      // Return neutral defaults
      return this.getDefaults();
    }
  }

  // ════════════════════════════════════════════
  // API CALLS — Aster DEX (Binance-compatible)
  // ════════════════════════════════════════════

  /** Safe JSON parser: returns null if response is not valid JSON (e.g. HTML 404) */
  private async safeJson(res: Response): Promise<any> {
    try {
      const text = await res.text();
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // 1. Funding Rate + Mark Price (Premium Index)
  // Weight: 1
  private async fetchFundingRate() {
    const res = await fetch(
      `${this.baseUrl}/fapi/v1/premiumIndex?symbol=${this.symbol}`
    );
    return await this.safeJson(res) ?? { lastFundingRate: '0', nextFundingTime: '0', markPrice: '0' };
    // Response: {
    //   symbol, markPrice, indexPrice, estimatedSettlePrice,
    //   lastFundingRate, nextFundingTime, interestRate, time
    // }
  }

  // 2. Open Interest (current)
  // Weight: 1
  private async fetchOpenInterest() {
    const res = await fetch(
      `${this.baseUrl}/fapi/v1/openInterest?symbol=${this.symbol}`
    );
    return await this.safeJson(res) ?? { openInterest: '0' };
    // Response: { openInterest, symbol, time }
  }

  // 3. Open Interest History (for calculating changes)
  // NOTE: /futures/data/openInterestHist is a Binance-specific endpoint
  // not supported on Aster DEX — returns HTML 404. We silently return []
  // and fall back to local oiHistory buffer for OI change calculations.
  private async fetchOIHistory() {
    try {
      const res = await fetch(
        `${this.baseUrl}/futures/data/openInterestHist?symbol=${this.symbol}&period=5m&limit=50`
      );
      if (!res.ok) return []; // Aster returns 404 HTML — skip silently
      return await res.json(); // await needed so rejection is caught here
      // Response: [{ symbol, sumOpenInterest, sumOpenInterestValue, timestamp }]
    } catch {
      return []; // Some exchanges may not support this
    }
  }

  // 4. Global Long/Short Account Ratio
  // Weight: 1
  private async fetchGlobalLongShortRatio() {
    try {
      const res = await fetch(
        `${this.baseUrl}/futures/data/globalLongShortAccountRatio?symbol=${this.symbol}&period=5m&limit=1`
      );
      const data = await this.safeJson(res);
      if (!data) return { longShortRatio: '1' };
      return Array.isArray(data) ? data[0] : data;
    } catch {
      return { longShortRatio: '1' };
    }
  }

  // 5. Top Trader Long/Short Ratio (positions)
  // Weight: 1
  private async fetchTopTraderLongShortRatio() {
    try {
      const res = await fetch(
        `${this.baseUrl}/futures/data/topLongShortPositionRatio?symbol=${this.symbol}&period=5m&limit=1`
      );
      const data = await this.safeJson(res);
      if (!data) return { longShortRatio: '1' };
      return Array.isArray(data) ? data[0] : data;
    } catch {
      return { longShortRatio: '1' };
    }
  }

  // 6. Order Book Depth (top 20 levels)
  // Weight: 5
  private async fetchOrderBookDepth() {
    const res = await fetch(
      `${this.baseUrl}/fapi/v1/depth?symbol=${this.symbol}&limit=20`
    );
    return await this.safeJson(res) ?? { bids: [], asks: [] };
    // Response: { 
    //   lastUpdateId, E, T,
    //   bids: [["price", "qty"], ...],
    //   asks: [["price", "qty"], ...]
    // }
  }

  // ════════════════════════════════════════════
  // WEBSOCKET — Real-time Liquidations
  // ════════════════════════════════════════════

  private startLiquidationStream(): void {
    const wsUrl = `${this.wsUrl}/ws/${this.symbol.toLowerCase()}@forceOrder`;

    const connect = () => {
      this.liqWs = new WebSocket(wsUrl);

      this.liqWs.on('open', () => {
        console.log('📡 Liquidation stream connected');
      });

      this.liqWs.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          const order = msg.o;
          if (!order) return;

          const side = order.S; // BUY = short got liquidated, SELL = long got liquidated
          const price = parseFloat(order.p);
          const qty = parseFloat(order.q);
          const usd = price * qty;

          this.liqBuffer.push({
            side: side === 'SELL' ? 'LONG' : 'SHORT', // SELL order = closing a LONG
            price,
            qty,
            usd,
            time: Date.now(),
          });

          // Keep last 2h only
          const twoHoursAgo = Date.now() - 2 * 3_600_000;
          this.liqBuffer = this.liqBuffer.filter(l => l.time > twoHoursAgo);

          // Log big liquidations
          if (usd > 50_000) {
            console.log(
              `💀 BIG LIQ: ${side === 'SELL' ? 'LONG' : 'SHORT'} $${usd.toFixed(0)} @ $${price.toFixed(2)}`
            );
          }
        } catch { /* ignore parse errors */ }
      });

      this.liqWs.on('close', () => {
        console.log('📡 Liquidation stream disconnected, reconnecting...');
        setTimeout(connect, 5000);
      });

      this.liqWs.on('error', (err) => {
        console.error('📡 Liquidation stream error:', err.message);
      });
    };

    connect();
  }

  // ════════════════════════════════════════════
  // ANALYSIS FUNCTIONS
  // ════════════════════════════════════════════

  private calcOIChanges(
    oiHist: any[],
    currentOi: number
  ): { change5m: number; change1h: number; change4h: number } {
    const now = Date.now();
    const defaults = { change5m: 0, change1h: 0, change4h: 0 };

    if (!Array.isArray(oiHist) || oiHist.length === 0) {
      // Fallback: use local oiHistory
      const find = (msAgo: number) => {
        const target = now - msAgo;
        const entry = this.oiHistory.find(h => Math.abs(h.time - target) < 600_000);
        return entry?.oi;
      };
      const oi5m = find(5 * 60_000);
      const oi1h = find(60 * 60_000);
      const oi4h = find(4 * 60 * 60_000);
      return {
        change5m: oi5m ? ((currentOi - oi5m) / oi5m) * 100 : 0,
        change1h: oi1h ? ((currentOi - oi1h) / oi1h) * 100 : 0,
        change4h: oi4h ? ((currentOi - oi4h) / oi4h) * 100 : 0,
      };
    }

    // Use API history
    const sorted = oiHist.sort((a: any, b: any) => a.timestamp - b.timestamp);
    const findClosest = (msAgo: number) => {
      const target = now - msAgo;
      let closest = sorted[0];
      for (const entry of sorted) {
        if (Math.abs(entry.timestamp - target) < Math.abs(closest.timestamp - target)) {
          closest = entry;
        }
      }
      return parseFloat(closest.sumOpenInterest || '0');
    };

    return {
      change5m: (() => { const v = findClosest(5 * 60_000); return v ? ((currentOi - v) / v) * 100 : 0; })(),
      change1h: (() => { const v = findClosest(60 * 60_000); return v ? ((currentOi - v) / v) * 100 : 0; })(),
      change4h: (() => { const v = findClosest(4 * 60 * 60_000); return v ? ((currentOi - v) / v) * 100 : 0; })(),
    };
  }

  private analyzeOrderBook(
    book: any,
    markPrice: number
  ): {
    bidDepthUsd: number;
    askDepthUsd: number;
    bookImbalance: number;
    nearestBidWall: number | null;
    nearestAskWall: number | null;
  } {
    if (!book?.bids || !book?.asks) {
      return { bidDepthUsd: 0, askDepthUsd: 0, bookImbalance: 0, nearestBidWall: null, nearestAskWall: null };
    }

    let bidDepth = 0;
    let askDepth = 0;
    let maxBid = { price: 0, usd: 0 };
    let maxAsk = { price: 0, usd: 0 };

    for (const [priceStr, qtyStr] of book.bids) {
      const price = parseFloat(priceStr);
      const qty = parseFloat(qtyStr);
      const usd = price * qty;
      bidDepth += usd;
      if (usd > maxBid.usd) maxBid = { price, usd };
    }

    for (const [priceStr, qtyStr] of book.asks) {
      const price = parseFloat(priceStr);
      const qty = parseFloat(qtyStr);
      const usd = price * qty;
      askDepth += usd;
      if (usd > maxAsk.usd) maxAsk = { price, usd };
    }

    const total = bidDepth + askDepth;
    const imbalance = total > 0 ? (bidDepth - askDepth) / total : 0;

    return {
      bidDepthUsd: bidDepth,
      askDepthUsd: askDepth,
      bookImbalance: Math.round(imbalance * 100) / 100, // -1 to +1
      nearestBidWall: maxBid.usd > 50_000 ? maxBid.price : null, // Only if >$50k
      nearestAskWall: maxAsk.usd > 50_000 ? maxAsk.price : null,
    };
  }

  private analyzeLiquidations(): DerivativesData['recentLiquidations'] {
    const oneHourAgo = Date.now() - 3_600_000;
    const recent = this.liqBuffer.filter(l => l.time > oneHourAgo);

    const longLiq = recent.filter(l => l.side === 'LONG');
    const shortLiq = recent.filter(l => l.side === 'SHORT');
    const totalLongUsd = longLiq.reduce((s, l) => s + l.usd, 0);
    const totalShortUsd = shortLiq.reduce((s, l) => s + l.usd, 0);

    // Find biggest recent liquidation
    const allSorted = [...recent].sort((a, b) => b.usd - a.usd);
    const biggest = allSorted[0] || null;

    return {
      totalLongLiqUsd1h: totalLongUsd,
      totalShortLiqUsd1h: totalShortUsd,
      dominantSide: totalLongUsd > totalShortUsd * 2 ? 'LONG_LIQD' :
                    totalShortUsd > totalLongUsd * 2 ? 'SHORT_LIQD' : 'BALANCED',
      lastBigLiq: biggest && biggest.usd > 10_000 ? {
        side: biggest.side,
        price: biggest.price,
        usd: biggest.usd,
        time: biggest.time,
      } : null,
    };
  }

  private getDefaults(): DerivativesData {
    return {
      fundingRate: 0, fundingRatePct: 0, nextFundingTime: 0,
      hoursUntilFunding: 8, fundingSignal: 'NEUTRAL',
      openInterest: 0, openInterestUsd: 0,
      oiChange5m: 0, oiChange1h: 0, oiChange4h: 0, oiTrend: 'FLAT',
      longShortRatio: 1, topTraderLSRatio: 1, crowdedSide: 'BALANCED',
      bidDepthUsd: 0, askDepthUsd: 0, bookImbalance: 0,
      nearestBidWall: null, nearestAskWall: null,
      recentLiquidations: {
        totalLongLiqUsd1h: 0, totalShortLiqUsd1h: 0,
        dominantSide: 'BALANCED', lastBigLiq: null,
      },
      timestamp: Date.now(), stale: true,
    };
  }

  // ── Cleanup ──

  destroy(): void {
    if (this.liqWs) {
      this.liqWs.close();
      this.liqWs = null;
    }
  }
}
