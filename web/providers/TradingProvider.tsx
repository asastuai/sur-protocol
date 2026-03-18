/**
 * SUR Protocol - Trading Provider
 *
 * Top-level context that:
 * 1. Manages WebSocket connection to the API server
 * 2. Dispatches incoming messages to the trading store
 * 3. Provides state + actions to all child components
 *
 * Architecture:
 *
 *   <TradingProvider>
 *     │
 *     ├─ WebSocket connection to ws://localhost:3002
 *     │    ├─ onMessage → parse → dispatch(action)
 *     │    └─ send() exposed for order submission
 *     │
 *     ├─ useTradingStore() → [state, dispatch]
 *     │
 *     └─ Context.Provider value={state, dispatch, send, ...}
 *          ├─ <Header />
 *          ├─ <Chart />
 *          ├─ <Orderbook />     ← reads state.bids, state.asks
 *          ├─ <OrderPanel />    ← calls submitOrder() via send()
 *          ├─ <PositionsPanel/> ← reads state.positions
 *          └─ <RecentTrades />  ← reads state.recentTrades
 */

"use client";

import {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import {
  useTradingStore,
  type TradingState,
  type TradingDispatch,
} from "../lib/trading-store";
import { WS_URL, fromPrice, fromSize, MARKETS, DEFAULT_MARKET, BINANCE_SYMBOLS, BINANCE_WS_URL, type MarketMeta } from "../lib/constants";

const PAPER_STORAGE_KEY = "sur_paper_trading_v1";

// ============================================================
//                    CONTEXT TYPE
// ============================================================

interface TradingContextValue {
  state: TradingState;
  dispatch: TradingDispatch;
  send: (data: any) => void;
  market: MarketMeta;
  switchMarket: (name: string) => void;
}

const TradingContext = createContext<TradingContextValue | null>(null);

// ============================================================
//                    PROVIDER
// ============================================================

export function TradingProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useTradingStore();
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const maxRetries = 5;
  const reconnectMs = 5000;

  // Current market
  const market = MARKETS.find(m => m.name === state.selectedMarket) || DEFAULT_MARKET;

  // ---- WebSocket Send ----
  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v
      ));
    }
  }, []);

  // ---- Message Handler ----
  const handleMessage = useCallback((msg: any) => {
    switch (msg.type) {
      case "pong":
        break;

      case "orderbook": {
        const bids = parseLevels(msg.snapshot?.bids || []);
        const asks = parseLevels(msg.snapshot?.asks || []);
        dispatch({ type: "SET_ORDERBOOK_SNAPSHOT", bids, asks });
        break;
      }

      case "orderbookUpdate": {
        const bids = parseLevels(msg.bids || []);
        const asks = parseLevels(msg.asks || []);
        dispatch({ type: "UPDATE_ORDERBOOK", bids, asks });
        break;
      }

      case "trade": {
        const t = msg.trade;
        dispatch({
          type: "ADD_TRADE",
          trade: {
            id: t.id,
            price: fromPrice(t.price),
            size: fromSize(t.size),
            side: t.makerSide === "sell" ? "buy" : "sell", // taker's side
            time: new Date(t.timestamp).toLocaleTimeString("en", { hour12: false }),
            timestamp: t.timestamp,
          },
        });
        break;
      }

      case "orderAccepted":
        dispatch({ type: "ORDER_ACCEPTED", orderId: msg.orderId, status: msg.status });
        // Auto-clear after 3s
        setTimeout(() => dispatch({ type: "CLEAR_ORDER_STATUS" }), 3000);
        break;

      case "orderRejected":
        dispatch({ type: "ORDER_REJECTED", orderId: msg.orderId, reason: msg.reason });
        setTimeout(() => dispatch({ type: "CLEAR_ORDER_STATUS" }), 5000);
        break;

      case "orderCancelled":
        dispatch({ type: "ORDER_CANCELLED", orderId: msg.orderId });
        break;

      case "error":
        console.warn("[WS] Server error:", msg.message);
        break;
    }
  }, [dispatch]);

  // ---- WebSocket Connection ----
  const connect = useCallback(() => {
    // Skip WS connection if no URL configured (paper-trading-only mode)
    if (!WS_URL || WS_URL === "ws://localhost:3002" && typeof window !== "undefined" && window.location.hostname !== "localhost") {
      dispatch({ type: "SET_WS_STATUS", status: "disconnected" });
      return;
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    dispatch({ type: "SET_WS_STATUS", status: "connecting" });
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      dispatch({ type: "SET_WS_STATUS", status: "connected" });
      retriesRef.current = 0;

      // Subscribe to current market channels
      ws.send(JSON.stringify({
        type: "subscribe",
        channels: [
          `orderbook:${market.id}`,
          `trades:${market.id}`,
        ],
      }));

      // Heartbeat
      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 15000);

      ws.onclose = () => {
        clearInterval(heartbeat);
        dispatch({ type: "SET_WS_STATUS", status: "disconnected" });
        wsRef.current = null;

        if (retriesRef.current < maxRetries) {
          retriesRef.current++;
          setTimeout(connect, reconnectMs);
        }
      };
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch {}
    };

    ws.onerror = () => {
      dispatch({ type: "SET_WS_STATUS", status: "error" });
    };

    wsRef.current = ws;
  }, [dispatch, handleMessage, market.id]);

  // Connect on mount
  useEffect(() => {
    connect();
    return () => {
      retriesRef.current = maxRetries; // prevent reconnect on unmount
      wsRef.current?.close();
    };
  }, [connect]);

  // ---- Load paper mode preference from localStorage ----
  useEffect(() => {
    try {
      const savedMode = localStorage.getItem("sur_paper_mode");
      if (savedMode === "true" && !state.paperMode) {
        dispatch({ type: "TOGGLE_PAPER_MODE" });
      }
    } catch {}
  }, []);

  // ---- Save paper mode preference ----
  useEffect(() => {
    try { localStorage.setItem("sur_paper_mode", String(state.paperMode)); } catch {}
  }, [state.paperMode]);

  // ---- Paper Trading: Load from localStorage ----
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PAPER_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Skip loading if there are broken positions with price 0
        const hasValid = !parsed.paperPositions?.some((p: any) => p.entryPrice <= 0);
        // Skip loading if balances are all zero with no positions (broken state)
        const isEmpty = (parsed.paperWalletBalance ?? 0) <= 0
          && (parsed.paperBalance ?? 0) <= 0
          && (!parsed.paperPositions || parsed.paperPositions.length === 0);
        if (hasValid && !isEmpty) {
          dispatch({ type: "PAPER_LOAD", state: parsed });
        } else {
          // Reset broken state
          localStorage.removeItem(PAPER_STORAGE_KEY);
        }
      }
    } catch {}
  }, [dispatch]);

  // ---- Paper Trading: Save to localStorage ----
  useEffect(() => {
    try {
      localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify({
        paperWalletBalance: state.paperWalletBalance,
        paperBalance: state.paperBalance,
        paperPositions: state.paperPositions,
        paperOrders: state.paperOrders,
        paperTradeHistory: state.paperTradeHistory,
        paperTotalRealizedPnl: state.paperTotalRealizedPnl,
      }));
    } catch {}
  }, [state.paperWalletBalance, state.paperBalance, state.paperPositions, state.paperOrders, state.paperTradeHistory, state.paperTotalRealizedPnl]);

  // ---- Real-time price from Binance WebSocket ----
  const binanceWsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    const symbol = BINANCE_SYMBOLS[market.name];
    if (!symbol) return;

    const url = `${BINANCE_WS_URL}/${symbol}@aggTrade`;
    let ws: WebSocket;
    let priceThrottle: ReturnType<typeof setTimeout> | null = null;
    let lastPrice = 0;

    try {
      ws = new WebSocket(url);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const price = parseFloat(data.p);
          const size = parseFloat(data.q);
          if (price <= 0) return;

          // Throttle price updates to ~4/sec
          if (price !== lastPrice && !priceThrottle) {
            lastPrice = price;
            dispatch({ type: "UPDATE_MARK_PRICE", price });
            priceThrottle = setTimeout(() => { priceThrottle = null; }, 250);
          }

          // Note: Binance aggTrades are NOT SUR protocol trades.
          // Recent trades list only shows actual SUR protocol trades (from our WS backend).
          // We only use Binance for the mark price feed.
        } catch {}
      };

      ws.onerror = () => {
        // Fallback: fetch price via REST if WS fails
        fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`)
          .then(r => r.json())
          .then(data => {
            const price = parseFloat(data.price);
            if (price > 0) dispatch({ type: "UPDATE_MARK_PRICE", price });
          })
          .catch(() => {});
      };

      binanceWsRef.current = ws;
    } catch {
      // Fallback seed price if Binance is completely unreachable
      if (state.markPrice <= 0) {
        const basePrice = market.name === "ETH-USD" ? 2500 : 100000;
        dispatch({ type: "UPDATE_MARK_PRICE", price: basePrice });
      }
    }

    return () => {
      if (priceThrottle) clearTimeout(priceThrottle);
      try { ws?.close(); } catch {}
      binanceWsRef.current = null;
    };
  }, [market.name, dispatch]);

  // ---- Fetch 24h stats from Binance (volume, change%) ----
  useEffect(() => {
    const symbol = BINANCE_SYMBOLS[market.name];
    if (!symbol) return;

    const fetchStats = () => {
      fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol.toUpperCase()}`)
        .then(r => r.json())
        .then(data => {
          dispatch({
            type: "SET_MARKET_STATS",
            volume24h: parseFloat(data.quoteVolume || "0"),
            change24h: parseFloat(data.priceChangePercent || "0"),
          });
        })
        .catch(() => {});
    };

    fetchStats();
    const interval = setInterval(fetchStats, 30_000); // refresh every 30s
    return () => clearInterval(interval);
  }, [market.name, dispatch]);

  // ---- Paper Trading: Check limit order fills on price change ----
  const prevPriceRef = useRef(0);
  useEffect(() => {
    if (state.markPrice <= 0 || state.paperOrders.length === 0) return;
    const price = state.markPrice;
    for (const order of state.paperOrders) {
      const shouldFill =
        (order.side === "buy" && price <= order.price) ||
        (order.side === "sell" && price >= order.price);
      if (shouldFill) {
        dispatch({
          type: "PAPER_FILL_LIMIT",
          orderId: order.id,
          fillPrice: order.price,
          feeBps: 6,
        });
      }
    }
    prevPriceRef.current = price;
  }, [state.markPrice, state.paperOrders, dispatch]);

  // ---- Paper Trading: Check TP/SL on price change ----
  useEffect(() => {
    if (state.markPrice <= 0 || state.paperPositions.length === 0) return;
    const price = state.markPrice;
    for (const pos of state.paperPositions) {
      // Take Profit check
      if (pos.tp && pos.tp > 0) {
        const tpHit = pos.side === "long" ? price >= pos.tp : price <= pos.tp;
        if (tpHit) {
          dispatch({
            type: "PAPER_CLOSE_POSITION",
            positionId: pos.id,
            closePrice: pos.tp,
            feeBps: 6,
          });
          continue; // don't also check SL for same position
        }
      }
      // Stop Loss check
      if (pos.sl && pos.sl > 0) {
        const slHit = pos.side === "long" ? price <= pos.sl : price >= pos.sl;
        if (slHit) {
          dispatch({
            type: "PAPER_CLOSE_POSITION",
            positionId: pos.id,
            closePrice: pos.sl,
            feeBps: 6,
          });
        }
      }
    }
  }, [state.markPrice, state.paperPositions, dispatch]);

  // ---- Market Switching ----
  const switchMarket = useCallback((name: string) => {
    const newMarket = MARKETS.find(m => m.name === name);
    if (!newMarket || newMarket.name === state.selectedMarket) return;

    // Unsubscribe old
    send({
      type: "unsubscribe",
      channels: [`orderbook:${market.id}`, `trades:${market.id}`],
    });

    dispatch({ type: "SET_MARKET", market: name });

    // Subscribe new
    send({
      type: "subscribe",
      channels: [`orderbook:${newMarket.id}`, `trades:${newMarket.id}`],
    });
  }, [market.id, state.selectedMarket, dispatch, send]);

  return (
    <TradingContext.Provider value={{ state, dispatch, send, market, switchMarket }}>
      {children}
    </TradingContext.Provider>
  );
}

// ============================================================
//                    CONSUMER HOOK
// ============================================================

export function useTrading() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error("useTrading must be inside TradingProvider");
  return ctx;
}

// Alias for cross-margin components
export const useTradingContext = useTrading;

// ============================================================
//                    HELPERS
// ============================================================

function parseLevels(raw: any[]): import("../lib/trading-store").PriceLevel[] {
  if (!raw || raw.length === 0) return [];

  const levels = raw.map((l: any) => ({
    price: typeof l.price === "number" ? l.price : fromPrice(l.price),
    size: typeof l.totalSize === "number" ? l.totalSize : fromSize(l.totalSize),
    total: 0,
    percentage: 0,
  }));

  // Calculate cumulative totals
  let cum = 0;
  for (const l of levels) {
    cum += l.size;
    l.total = cum;
  }

  // Calculate percentage (relative to max total)
  const maxTotal = cum;
  for (const l of levels) {
    l.percentage = maxTotal > 0 ? (l.total / maxTotal) * 100 : 0;
  }

  return levels;
}
