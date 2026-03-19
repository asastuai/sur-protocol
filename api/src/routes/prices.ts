/**
 * SUR Protocol - Historical Price Data Routes
 *
 * Serves OHLCV candle data from Binance's public API with in-memory caching.
 * Endpoint: GET /api/prices/:market?period=30d&interval=5m
 */

import type { IncomingMessage, ServerResponse, Server } from "http";
import { createGunzip } from "zlib";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** [timestamp, open, high, low, close, volume] */
type Candle = [number, number, number, number, number, number];

interface CacheEntry {
  data: PricesResponse;
  expiresAt: number;
}

interface PricesResponse {
  market: string;
  symbol: string;
  period: string;
  interval: string;
  candles: Candle[];
  count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKET_MAP: Record<string, string> = {
  "BTC-USD": "BTCUSDT",
  "ETH-USD": "ETHUSDT",
};

const VALID_PERIODS = ["7d", "30d", "90d", "365d"];
const VALID_INTERVALS = ["5m", "15m", "1h"];
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const BINANCE_MAX_CANDLES = 1000;

const INTERVAL_MS: Record<string, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

const PERIOD_MS: Record<string, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  "365d": 365 * 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const cache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, statusCode: number, data: unknown, headers?: Record<string, string>): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300",
    ...headers,
  });
  res.end(body);
}

function jsonGzip(req: IncomingMessage, res: ServerResponse, statusCode: number, data: unknown, headers?: Record<string, string>): void {
  const acceptEncoding = req.headers["accept-encoding"] || "";
  const body = JSON.stringify(data);

  if (typeof acceptEncoding === "string" && acceptEncoding.includes("gzip")) {
    const { createGzip } = require("zlib");
    const gzip = createGzip();
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Cache-Control": "public, max-age=300",
      ...headers,
    });
    const { Readable } = require("stream");
    const readable = Readable.from([Buffer.from(body)]);
    readable.pipe(gzip).pipe(res);
  } else {
    json(res, statusCode, data, headers);
  }
}

/**
 * Fetch candles from Binance public klines API.
 * Returns raw Binance arrays.
 */
async function fetchBinanceKlines(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number
): Promise<Candle[]> {
  const allCandles: Candle[] = [];
  let currentStart = startTime;

  while (currentStart < endTime) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${symbol}` +
      `&interval=${interval}&startTime=${currentStart}&endTime=${endTime}&limit=${BINANCE_MAX_CANDLES}`;

    const response = await fetch(url);

    if (response.status === 429) {
      // Rate limited — return what we have so far or throw
      if (allCandles.length > 0) {
        console.warn(`[Prices] Binance rate limit hit after ${allCandles.length} candles, returning partial data`);
        break;
      }
      throw new Error("RATE_LIMITED");
    }

    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
    }

    const raw: unknown[][] = await response.json();
    if (!raw.length) break;

    for (const k of raw) {
      // k = [openTime, open, high, low, close, volume, closeTime, ...]
      allCandles.push([
        k[0] as number,
        parseFloat(k[1] as string),
        parseFloat(k[2] as string),
        parseFloat(k[3] as string),
        parseFloat(k[4] as string),
        parseFloat(k[5] as string),
      ]);
    }

    // Move start forward past the last candle we received
    const lastOpenTime = raw[raw.length - 1][0] as number;
    currentStart = lastOpenTime + INTERVAL_MS[interval];

    // If Binance returned fewer than limit, we've fetched everything
    if (raw.length < BINANCE_MAX_CANDLES) break;
  }

  return allCandles;
}

/**
 * Determine the effective interval. For very large requests (365d + 5m),
 * auto-switch to 1h to keep request count reasonable.
 */
function effectiveInterval(period: string, requestedInterval: string): string {
  const periodMs = PERIOD_MS[period] || PERIOD_MS["30d"];
  const intervalMs = INTERVAL_MS[requestedInterval] || INTERVAL_MS["5m"];
  const estimatedCandles = periodMs / intervalMs;

  // If more than 50,000 candles (~50 requests), switch to 1h
  if (estimatedCandles > 50_000) {
    console.log(
      `[Prices] Auto-switching interval from ${requestedInterval} to 1h ` +
      `(${Math.round(estimatedCandles)} candles would require ~${Math.ceil(estimatedCandles / 1000)} requests)`
    );
    return "1h";
  }
  return requestedInterval;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle /api/prices/:market routes. Returns true if the request was handled.
 */
export function handlePricesRoute(req: IncomingMessage, res: ServerResponse): boolean {
  const fullUrl = req.url ?? "";
  const method = req.method ?? "GET";

  if (method !== "GET") return false;

  // Parse: /api/prices/BTC-USD?period=30d&interval=5m
  const match = fullUrl.match(/^\/api\/prices\/([^?]+)(\?.*)?$/);
  if (!match) return false;

  const market = decodeURIComponent(match[1]).toUpperCase();
  const queryString = match[2] || "";
  const params = new URLSearchParams(queryString.replace(/^\?/, ""));

  const symbol = MARKET_MAP[market];
  if (!symbol) {
    json(res, 400, {
      error: `Unknown market: ${market}. Supported: ${Object.keys(MARKET_MAP).join(", ")}`,
    });
    return true;
  }

  const period = VALID_PERIODS.includes(params.get("period") || "")
    ? params.get("period")!
    : "30d";

  const requestedInterval = VALID_INTERVALS.includes(params.get("interval") || "")
    ? params.get("interval")!
    : "5m";

  const interval = effectiveInterval(period, requestedInterval);

  // Check cache
  const cacheKey = `${symbol}_${period}_${interval}`;
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[Prices] Cache HIT: ${cacheKey}`);
    jsonGzip(req, res, 200, cached.data);
    return true;
  }

  console.log(`[Prices] Cache MISS: ${cacheKey} — fetching from Binance`);

  // Async fetch — we return true immediately, respond when data arrives
  const now = Date.now();
  const startMs = now - (PERIOD_MS[period] || PERIOD_MS["30d"]);

  fetchBinanceKlines(symbol, interval, startMs, now)
    .then((candles) => {
      const responseData: PricesResponse = {
        market,
        symbol,
        period,
        interval,
        candles,
        count: candles.length,
      };

      // Store in cache
      cache.set(cacheKey, {
        data: responseData,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      console.log(`[Prices] Fetched ${candles.length} candles for ${cacheKey}`);
      jsonGzip(req, res, 200, responseData);
    })
    .catch((err) => {
      console.error(`[Prices] Fetch error for ${cacheKey}:`, err);

      // If rate limited, try returning stale cache
      if (err.message === "RATE_LIMITED" && cached) {
        console.warn(`[Prices] Rate limited — serving stale cache for ${cacheKey}`);
        jsonGzip(req, res, 200, cached.data);
        return;
      }

      if (!res.headersSent) {
        const statusCode = err.message === "RATE_LIMITED" ? 429 : 502;
        json(res, statusCode, {
          error: err.message === "RATE_LIMITED"
            ? "Binance rate limit exceeded. Try again shortly."
            : "Failed to fetch price data from upstream",
        });
      }
    });

  return true;
}

/**
 * Register prices routes (lifecycle hook, called once at startup).
 */
export function registerPricesRoutes(_server: Server): void {
  console.log("[Routes] Prices endpoints registered (/api/prices/*)");
}
