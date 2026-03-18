// ============================================================
// src/gateway/aster-gateway.ts — Aster DEX REST + WebSocket
// ============================================================

import { createHmac } from 'crypto';
import type { Config } from '../config';
import type { Logger } from '../utils/logger';
import type { Candle, TickerData } from '../types';

type MessageHandler = (stream: string, data: any) => void;

export class AsterGateway {
  private config: Config;
  private logger: Logger;
  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private streams: string[] = [];
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  // ─── REST API ─────────────────────────────────────

  private sign(queryString: string): string {
    return createHmac('sha256', this.config.ASTER_API_SECRET)
      .update(queryString)
      .digest('hex');
  }

  private async request(
    endpoint: string,
    params: Record<string, string | number> = {},
    signed = false,
    method: 'GET' | 'POST' | 'DELETE' = 'GET'
  ): Promise<any> {
    const url = new URL(`${this.config.REST_BASE_URL}${endpoint}`);

    if (signed) {
      params.timestamp = Date.now();
      params.recvWindow = 50000;
    }

    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    if (signed) {
      const signature = this.sign(queryString);
      url.search = `${queryString}&signature=${signature}`;
    } else {
      url.search = queryString;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.ASTER_API_KEY) {
      headers['X-MBX-APIKEY'] = this.config.ASTER_API_KEY;
    }

    const res = await fetch(url.toString(), { method, headers });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Aster API ${res.status}: ${errBody}`);
    }

    return res.json();
  }

  /**
   * Fetch historical klines (candlesticks)
   * GET /fapi/v1/klines
   */
  async getKlines(
    symbol: string,
    interval: string,
    limit = 200
  ): Promise<Candle[]> {
    const raw = await this.request('/fapi/v1/klines', {
      symbol,
      interval,
      limit,
    });

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

  /**
   * Get 24h ticker
   * GET /fapi/v1/ticker/24hr
   */
  async getTicker(symbol: string): Promise<TickerData> {
    const raw = await this.request('/fapi/v1/ticker/24hr', { symbol });
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

  /**
   * Get current price
   * GET /fapi/v1/ticker/price
   */
  async getPrice(symbol: string): Promise<number> {
    const raw = await this.request('/fapi/v1/ticker/price', { symbol });
    return parseFloat(raw.price);
  }

  /**
   * Get funding rate
   * GET /fapi/v1/fundingRate
   */
  async getFundingRate(symbol: string): Promise<number> {
    const raw = await this.request('/fapi/v1/fundingRate', {
      symbol,
      limit: 1,
    });
    return raw.length > 0 ? parseFloat(raw[0].fundingRate) : 0;
  }

  /**
   * Place order (SIGNED)
   * POST /fapi/v1/order
   */
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
    return this.request('/fapi/v1/order', params as any, true, 'POST');
  }

  /**
   * Cancel order (SIGNED)
   * DELETE /fapi/v1/order
   */
  async cancelOrder(symbol: string, orderId: number): Promise<any> {
    return this.request(
      '/fapi/v1/order',
      { symbol, orderId },
      true,
      'DELETE'
    );
  }

  /**
   * Get open positions (SIGNED)
   * GET /fapi/v1/positionRisk
   */
  async getPositions(symbol?: string): Promise<any> {
    const params: Record<string, any> = {};
    if (symbol) params.symbol = symbol;
    return this.request('/fapi/v1/positionRisk', params, true);
  }

  /**
   * Set leverage (SIGNED)
   * POST /fapi/v1/leverage
   */
  async setLeverage(symbol: string, leverage: number): Promise<any> {
    return this.request(
      '/fapi/v1/leverage',
      { symbol, leverage },
      true,
      'POST'
    );
  }

  // ─── WEBSOCKET ────────────────────────────────────

  onMessage(handler: MessageHandler) {
    this.handlers.push(handler);
  }

  async connect(streams: string[]): Promise<void> {
    this.streams = streams;
    const streamPath = streams.join('/');
    const url = `${this.config.WS_BASE_URL}/stream?streams=${streamPath}`;

    this.logger.info(`🔌 Connecting to WebSocket: ${streams.length} streams...`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.logger.info('✅ WebSocket connected');

        // Keepalive ping every 3 minutes
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ method: 'ping' }));
          }
        }, 180_000);

        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data.toString());
          if (msg.stream && msg.data) {
            for (const handler of this.handlers) {
              handler(msg.stream, msg.data);
            }
          }
        } catch (err) {
          this.logger.error('WS parse error:', err);
        }
      };

      this.ws.onerror = (err: Event) => {
        this.logger.error('WebSocket error:', err);
      };

      this.ws.onclose = () => {
        this.logger.warn('⚡ WebSocket disconnected, reconnecting in 5s...');
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.reconnectTimer = setTimeout(() => this.connect(this.streams), 5000);
      };

      // Timeout for initial connection
      setTimeout(() => reject(new Error('WebSocket connection timeout')), 15000);
    });
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.onclose = null; // Prevent auto-reconnect
      this.ws.close();
    }
  }
}
