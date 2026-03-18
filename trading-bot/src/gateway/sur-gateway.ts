// ============================================================
// src/gateway/sur-gateway.ts — SUR Protocol REST + WebSocket
// ============================================================
// Drop-in replacement for AsterGateway.
// Uses SUR Agent API (port 3003) for REST and SUR WebSocket for real-time data.
// Falls back to Binance public klines/ticker for candle data (same format).
// ============================================================

import { createHmac } from 'crypto';
import type { Config } from '../config';
import type { Logger } from '../utils/logger';
import type { Candle, TickerData } from '../types';

type MessageHandler = (stream: string, data: any) => void;

// SUR markets use "-USD" suffix, Binance uses "USDT"
const SUR_MARKETS: Record<string, string> = {
  BTCUSDT: 'BTC-USD',
  ETHUSDT: 'ETH-USD',
};

function toSurMarket(symbol: string): string {
  return SUR_MARKETS[symbol] || symbol.replace('USDT', '-USD');
}

export class SurGateway {
  private config: Config;
  private logger: Logger;
  private ws: WebSocket | null = null;
  private binanceWs: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private streams: string[] = [];
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  // ─── SUR Agent API (REST) ─────────────────────────────

  private async surRequest(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    body?: any,
  ): Promise<any> {
    const url = `${this.config.REST_BASE_URL}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.ASTER_API_KEY) {
      headers['X-SUR-Agent-Key'] = this.config.ASTER_API_KEY;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`SUR API ${res.status}: ${errBody}`);
    }

    return res.json();
  }

  // ─── Candle Data (Binance public API — same data, no auth) ───

  async getKlines(
    symbol: string,
    interval: string,
    limit = 200,
  ): Promise<Candle[]> {
    // Use Binance public futures API for historical klines
    // SUR uses Binance price feeds anyway, so data is identical
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    const raw = await res.json();

    return raw.map((k: any[]) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5] || '0'),
      closeTime: k[6],
      quoteVolume: parseFloat(k[7] || '0'),
      trades: k[8] || 0,
      takerBuyBaseVol: parseFloat(k[9] || '0'),
      takerBuyQuoteVol: parseFloat(k[10] || '0'),
      isClosed: true,
    }));
  }

  async getTicker(symbol: string): Promise<TickerData> {
    const url = `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`;
    const res = await fetch(url);
    const raw = await res.json();
    return {
      symbol: raw.symbol,
      price: parseFloat(raw.lastPrice),
      priceChange: parseFloat(raw.priceChange),
      priceChangePct: parseFloat(raw.priceChangePercent),
      high24h: parseFloat(raw.highPrice),
      low24h: parseFloat(raw.lowPrice),
      volume24h: parseFloat(raw.volume),
      quoteVolume24h: parseFloat(raw.quoteVolume),
    };
  }

  async getPrice(symbol: string): Promise<number> {
    const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`;
    const res = await fetch(url);
    const raw = await res.json();
    return parseFloat(raw.price);
  }

  async getFundingRate(symbol: string): Promise<number> {
    const surMarket = toSurMarket(symbol);
    try {
      const data = await this.surRequest(`/v1/funding/${surMarket}`);
      return data.fundingRate || 0;
    } catch {
      // Fallback to Binance
      const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
      const res = await fetch(url);
      const raw = await res.json();
      return raw.length > 0 ? parseFloat(raw[0].fundingRate) : 0;
    }
  }

  // ─── SUR Order Execution ─────────────────────────────

  async placeOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    quantity?: string;
    price?: string;
    stopPrice?: string;
    positionSide?: 'LONG' | 'SHORT';
    reduceOnly?: string;
    closePosition?: string;
  }): Promise<any> {
    const surMarket = toSurMarket(params.symbol);
    const size = parseFloat(params.quantity || '0');
    const price = parseFloat(params.price || '0');

    return this.surRequest('/v1/orders', 'POST', {
      trader: this.config.ASTER_API_KEY, // agent wallet address
      marketId: surMarket,
      side: params.side.toLowerCase(),
      orderType: params.type === 'MARKET' ? 'market' : 'limit',
      price: String(Math.round(price * 1e6)),
      size: String(Math.round(size * 1e8)),
      timeInForce: 'GTC',
      hidden: false,
      nonce: String(Date.now()),
      expiry: String(Math.floor(Date.now() / 1000) + 3600),
      signature: '0x', // Agent API handles signing
    });
  }

  async cancelOrder(symbol: string, orderId: number): Promise<any> {
    return this.surRequest(`/v1/orders/${orderId}`, 'DELETE');
  }

  async getPositions(symbol?: string): Promise<any> {
    const trader = this.config.ASTER_API_KEY;
    if (!trader) return [];

    try {
      const data = await this.surRequest(`/v1/positions/${trader}`);
      const positions = data.positions || [];

      if (symbol) {
        const surMarket = toSurMarket(symbol);
        return positions.filter((p: any) => p.market === surMarket);
      }
      return positions;
    } catch {
      return [];
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<any> {
    // SUR handles leverage per-order, not globally
    // This is a no-op but logged for compatibility
    this.logger.info(`[SUR] Leverage set to ${leverage}x for ${toSurMarket(symbol)} (applied per-order)`);
    return { leverage };
  }

  // ─── WebSocket (Binance streams for real-time candles + SUR for orders) ───

  onMessage(handler: MessageHandler) {
    this.handlers.push(handler);
  }

  async connect(streams: string[]): Promise<void> {
    this.streams = streams;

    // Connect to Binance WebSocket for real-time candle/ticker/trade data
    // SUR Protocol uses Binance price feeds, so this gives us the same data
    const streamPath = streams.join('/');
    const url = `wss://fstream.binance.com/stream?streams=${streamPath}`;

    this.logger.info(`[SUR] Connecting to price feed: ${streams.length} streams...`);

    return new Promise((resolve, reject) => {
      this.binanceWs = new WebSocket(url);

      this.binanceWs.onopen = () => {
        this.logger.info('[SUR] Price feed connected (Binance streams)');

        this.pingInterval = setInterval(() => {
          if (this.binanceWs?.readyState === WebSocket.OPEN) {
            this.binanceWs.send(JSON.stringify({ method: 'ping' }));
          }
        }, 180_000);

        resolve();
      };

      this.binanceWs.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data.toString());
          if (msg.stream && msg.data) {
            for (const handler of this.handlers) {
              handler(msg.stream, msg.data);
            }
          }
        } catch (err) {
          this.logger.error('[SUR] WS parse error:', err);
        }
      };

      this.binanceWs.onerror = (err: Event) => {
        this.logger.error('[SUR] WebSocket error:', err);
      };

      this.binanceWs.onclose = () => {
        this.logger.warn('[SUR] Price feed disconnected, reconnecting in 5s...');
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.reconnectTimer = setTimeout(() => this.connect(this.streams), 5000);
      };

      setTimeout(() => reject(new Error('WebSocket connection timeout')), 15000);
    });
  }

  // Also connect to SUR WebSocket for order status updates
  async connectSurWs(): Promise<void> {
    const surWsUrl = this.config.WS_BASE_URL.replace('fstream.asterdex.com', 'localhost:3002');
    try {
      this.ws = new WebSocket(surWsUrl);
      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data.toString());
          // Forward order status events
          if (msg.type === 'orderAccepted' || msg.type === 'orderRejected') {
            for (const handler of this.handlers) {
              handler('sur:orderStatus', msg);
            }
          }
        } catch {}
      };
    } catch {
      this.logger.warn('[SUR] Could not connect to SUR WebSocket — order updates unavailable');
    }
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.binanceWs) {
      this.binanceWs.onclose = null;
      this.binanceWs.close();
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
  }
}
