/**
 * SUR Protocol - Trading Provider
 *
 * Manages side effects (WebSocket, Binance feed, localStorage persistence)
 * and bridges them to the Zustand store.
 *
 * Components can use either:
 *   - useTrading() for the legacy context API (state, dispatch, send, market)
 *   - useTradingZustand(selector) for optimized Zustand subscriptions
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
  useTradingZustand,
  type PriceLevel,
} from "../lib/trading-zustand";
import {
  type TradingState,
  type TradingAction,
  type TradingDispatch,
} from "../lib/trading-store";
import { WS_URL, fromPrice, fromSize, MARKETS, DEFAULT_MARKET, BINANCE_SYMBOLS, BINANCE_WS_URL, type MarketMeta } from "../lib/constants";

const PAPER_STORAGE_KEY = "sur_paper_trading_v1";

// ============================================================
//                    CONTEXT (legacy bridge)
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
  const store = useTradingZustand();
  const actions = store.actions;
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const maxRetries = 5;
  const reconnectMs = 5000;

  const market = MARKETS.find(m => m.name === store.selectedMarket) || DEFAULT_MARKET;

  // ---- Dispatch bridge (maps old reducer actions to Zustand) ----
  const dispatch: TradingDispatch = useCallback((action: TradingAction) => {
    const a = useTradingZustand.getState().actions;
    switch (action.type) {
      case "SET_WS_STATUS": a.setWsStatus(action.status); break;
      case "SET_MARKET": a.setMarket(action.market); break;
      case "SET_ORDERBOOK_SNAPSHOT":
      case "UPDATE_ORDERBOOK": a.updateOrderbook(action.bids as any, action.asks as any); break;
      case "ADD_TRADE": a.addTrade(action.trade as any); break;
      case "SET_TRADES": a.setTrades(action.trades as any); break;
      case "UPDATE_MARK_PRICE": a.updateMarkPrice(action.price); break;
      case "SET_POSITIONS": a.setPositions(action.positions as any); break;
      case "SET_OPEN_ORDERS": a.setOpenOrders(action.orders as any); break;
      case "SET_VAULT_BALANCE": a.setVaultBalance(action.balance); break;
      case "ORDER_ACCEPTED": a.orderAccepted(action.orderId, action.status); break;
      case "ORDER_REJECTED": a.orderRejected(action.orderId, action.reason); break;
      case "ORDER_CANCELLED": a.orderCancelled(action.orderId); break;
      case "INCREMENT_NONCE": a.incrementNonce(); break;
      case "CLEAR_ORDER_STATUS": a.clearOrderStatus(); break;
      case "SET_MARKET_STATS": a.setMarketStats(action); break;
      case "PAPER_MARKET_ORDER": a.paperMarketOrder(action); break;
      case "PAPER_LIMIT_ORDER": a.paperLimitOrder(action); break;
      case "PAPER_CLOSE_POSITION": a.paperClosePosition(action.positionId, action.closePrice, action.feeBps); break;
      case "PAPER_CANCEL_ORDER": a.paperCancelOrder(action.orderId); break;
      case "PAPER_UPDATE_TPSL": a.paperUpdateTpSl(action.positionId, action.tp, action.sl); break;
      case "PAPER_FILL_LIMIT": a.paperFillLimit(action.orderId, action.fillPrice, action.feeBps); break;
      case "PAPER_DEPOSIT": a.paperDeposit(action.amount); break;
      case "PAPER_WITHDRAW": a.paperWithdraw(action.amount); break;
      case "PAPER_RESET": a.paperReset(); break;
      case "PAPER_LOAD": a.paperLoad(action.state as any); break;
      case "TOGGLE_PAPER_MODE": a.togglePaperMode(); break;
    }
  }, []);

  // ---- WebSocket Send (with retry + rate limit) ----
  const pendingRef = useRef<any[]>([]);
  const sendCountRef = useRef(0);
  const sendResetRef = useRef(0);
  const send = useCallback((data: any) => {
    // Rate limit: max 10 messages per second
    const now = Date.now();
    if (now - sendResetRef.current > 1000) {
      sendCountRef.current = 0;
      sendResetRef.current = now;
    }
    if (sendCountRef.current >= 10) return;
    sendCountRef.current++;

    const msg = JSON.stringify(data, (_k, v) => typeof v === "bigint" ? v.toString() : v);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(msg);
    } else {
      pendingRef.current.push(msg);
    }
  }, []);

  // ---- Message Handler ----
  const handleMessage = useCallback((msg: any) => {
    const a = useTradingZustand.getState().actions;
    switch (msg.type) {
      case "pong": break;
      case "orderbook":
        a.updateOrderbook(
          parseLevels(msg.snapshot?.bids || []),
          parseLevels(msg.snapshot?.asks || []),
        );
        break;
      case "orderbookUpdate":
        a.updateOrderbook(
          parseLevels(msg.bids || []),
          parseLevels(msg.asks || []),
        );
        break;
      case "trade": {
        const t = msg.trade;
        a.addTrade({
          id: t.id,
          price: fromPrice(t.price),
          size: fromSize(t.size),
          side: t.makerSide === "sell" ? "buy" : "sell",
          time: new Date(t.timestamp).toLocaleTimeString("en", { hour12: false }),
          timestamp: t.timestamp,
        });
        break;
      }
      case "orderAccepted":
        a.orderAccepted(msg.orderId, msg.status);
        setTimeout(() => a.clearOrderStatus(), 3000);
        break;
      case "orderRejected":
        a.orderRejected(msg.orderId, msg.reason);
        setTimeout(() => a.clearOrderStatus(), 5000);
        break;
      case "orderCancelled":
        a.orderCancelled(msg.orderId);
        break;
      case "error":
        // console.warn("[WS] Server error:", msg.message);
        break;
    }
  }, []);

  // ---- WebSocket Connection ----
  const connect = useCallback(() => {
    if (!WS_URL || (WS_URL.includes("localhost") && typeof window !== "undefined" && window.location.hostname !== "localhost")) {
      actions.setWsStatus("disconnected");
      return;
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    actions.setWsStatus("connecting");
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      actions.setWsStatus("connected");
      retriesRef.current = 0;
      // Flush queued messages
      while (pendingRef.current.length > 0) {
        const msg = pendingRef.current.shift();
        if (msg) ws.send(msg);
      }

      ws.send(JSON.stringify({
        type: "subscribe",
        channels: [`orderbook:${market.id}`, `trades:${market.id}`],
      }));

      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 15000);

      ws.onclose = () => {
        clearInterval(heartbeat);
        actions.setWsStatus("disconnected");
        wsRef.current = null;
        if (retriesRef.current < maxRetries) {
          retriesRef.current++;
          setTimeout(connect, reconnectMs);
        }
      };
    };

    ws.onmessage = (event) => {
      try { handleMessage(JSON.parse(event.data)); } catch {}
    };

    ws.onerror = () => { actions.setWsStatus("error"); };
    wsRef.current = ws;
  }, [actions, handleMessage, market.id]);

  useEffect(() => {
    connect();
    return () => {
      retriesRef.current = maxRetries;
      wsRef.current?.close();
    };
  }, [connect]);

  // ---- Load paper mode preference ----
  useEffect(() => {
    try {
      const savedMode = localStorage.getItem("sur_paper_mode");
      if (savedMode === "true" && !useTradingZustand.getState().paperMode) {
        actions.togglePaperMode();
      }
    } catch {}
  }, [actions]);

  // ---- Save paper mode preference ----
  const paperMode = useTradingZustand(s => s.paperMode);
  useEffect(() => {
    try { localStorage.setItem("sur_paper_mode", String(paperMode)); } catch {}
  }, [paperMode]);

  // ---- Paper Trading: Load from localStorage ----
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PAPER_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const hasValid = !parsed.paperPositions?.some((p: any) => p.entryPrice <= 0);
        const isEmpty = (parsed.paperWalletBalance ?? 0) <= 0
          && (parsed.paperBalance ?? 0) <= 0
          && (!parsed.paperPositions || parsed.paperPositions.length === 0);
        if (hasValid && !isEmpty) {
          actions.paperLoad(parsed);
        } else {
          localStorage.removeItem(PAPER_STORAGE_KEY);
        }
      }
    } catch {}
  }, [actions]);

  // ---- Paper Trading: Save to localStorage ----
  const paperWalletBalance = useTradingZustand(s => s.paperWalletBalance);
  const paperBalance = useTradingZustand(s => s.paperBalance);
  const paperPositions = useTradingZustand(s => s.paperPositions);
  const paperOrders = useTradingZustand(s => s.paperOrders);
  const paperTradeHistory = useTradingZustand(s => s.paperTradeHistory);
  const paperTotalRealizedPnl = useTradingZustand(s => s.paperTotalRealizedPnl);

  useEffect(() => {
    try {
      localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify({
        paperWalletBalance, paperBalance, paperPositions,
        paperOrders, paperTradeHistory, paperTotalRealizedPnl,
      }));
    } catch {}
  }, [paperWalletBalance, paperBalance, paperPositions, paperOrders, paperTradeHistory, paperTotalRealizedPnl]);

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
          if (price <= 0) return;
          if (price !== lastPrice && !priceThrottle) {
            lastPrice = price;
            useTradingZustand.getState().actions.updateMarkPrice(price);
            priceThrottle = setTimeout(() => { priceThrottle = null; }, 250);
          }
        } catch {}
      };

      ws.onerror = () => {
        fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`)
          .then(r => r.json())
          .then(data => {
            const price = parseFloat(data.price);
            if (price > 0) useTradingZustand.getState().actions.updateMarkPrice(price);
          })
          .catch(() => {});
      };

      binanceWsRef.current = ws;
    } catch {
      if (useTradingZustand.getState().markPrice <= 0) {
        const basePrice = market.name === "ETH-USD" ? 2500 : 100000;
        actions.updateMarkPrice(basePrice);
      }
    }

    return () => {
      if (priceThrottle) clearTimeout(priceThrottle);
      try { ws?.close(); } catch {}
      binanceWsRef.current = null;
    };
  }, [market.name, actions]);

  // ---- Fetch 24h stats from Binance ----
  useEffect(() => {
    const symbol = BINANCE_SYMBOLS[market.name];
    if (!symbol) return;

    const fetchStats = () => {
      fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol.toUpperCase()}`)
        .then(r => r.json())
        .then(data => {
          actions.setMarketStats({
            volume24h: parseFloat(data.quoteVolume || "0"),
            change24h: parseFloat(data.priceChangePercent || "0"),
          });
        })
        .catch(() => {});

      fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol.toUpperCase()}`)
        .then(r => r.json())
        .then(data => {
          const rate = parseFloat(data.lastFundingRate || "0");
          if (!isNaN(rate)) actions.setMarketStats({ fundingRate: rate * 100 });
        })
        .catch(() => {});
    };

    fetchStats();
    const interval = setInterval(fetchStats, 30_000);
    return () => clearInterval(interval);
  }, [market.name, actions]);

  // ---- Paper Trading: Check limit/stop order fills ----
  const markPrice = useTradingZustand(s => s.markPrice);
  useEffect(() => {
    if (markPrice <= 0) return;
    const orders = useTradingZustand.getState().paperOrders;
    if (orders.length === 0) return;
    const price = markPrice;

    for (const order of orders) {
      let shouldFill = false;
      let fillPrice = order.price;

      if (order.orderType === "stopMarket" && order.stopPrice) {
        const triggered = order.side === "buy" ? price >= order.stopPrice : price <= order.stopPrice;
        if (triggered) { shouldFill = true; fillPrice = price; }
      } else if (order.orderType === "stopLimit" && order.stopPrice) {
        const triggered = order.side === "buy" ? price >= order.stopPrice : price <= order.stopPrice;
        const limitHit = order.side === "buy" ? price <= order.price : price >= order.price;
        if (triggered && limitHit) { shouldFill = true; fillPrice = order.price; }
      } else {
        shouldFill = (order.side === "buy" && price <= order.price) || (order.side === "sell" && price >= order.price);
      }

      if (shouldFill) {
        useTradingZustand.getState().actions.paperFillLimit(order.id, fillPrice, 6);
      }
    }
  }, [markPrice]);

  // ---- Paper Trading: Check TP/SL ----
  useEffect(() => {
    if (markPrice <= 0) return;
    const positions = useTradingZustand.getState().paperPositions;
    if (positions.length === 0) return;
    const price = markPrice;

    for (const pos of positions) {
      if (pos.tp && pos.tp > 0) {
        const tpHit = pos.side === "long" ? price >= pos.tp : price <= pos.tp;
        if (tpHit) {
          useTradingZustand.getState().actions.paperClosePosition(pos.id, pos.tp, 6);
          continue;
        }
      }
      if (pos.sl && pos.sl > 0) {
        const slHit = pos.side === "long" ? price <= pos.sl : price >= pos.sl;
        if (slHit) {
          useTradingZustand.getState().actions.paperClosePosition(pos.id, pos.sl, 6);
        }
      }
    }
  }, [markPrice]);

  // ---- Market Switching ----
  const switchMarket = useCallback((name: string) => {
    const newMarket = MARKETS.find(m => m.name === name);
    const currentMarket = useTradingZustand.getState().selectedMarket;
    if (!newMarket || newMarket.name === currentMarket) return;

    send({
      type: "unsubscribe",
      channels: [`orderbook:${market.id}`, `trades:${market.id}`],
    });

    actions.setMarket(name);

    send({
      type: "subscribe",
      channels: [`orderbook:${newMarket.id}`, `trades:${newMarket.id}`],
    });
  }, [market.id, actions, send]);

  // ---- Legacy context bridge ----
  // Read the full store as TradingState shape for backward compatibility
  const legacyState: TradingState = store as any;

  return (
    <TradingContext.Provider value={{ state: legacyState, dispatch, send, market, switchMarket }}>
      {children}
    </TradingContext.Provider>
  );
}

// ============================================================
//                    CONSUMER HOOKS
// ============================================================

export function useTrading() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error("useTrading must be inside TradingProvider");
  return ctx;
}

export const useTradingContext = useTrading;

// ============================================================
//                    HELPERS
// ============================================================

function parseLevels(raw: any[]): PriceLevel[] {
  if (!raw || raw.length === 0) return [];

  const levels = raw.map((l: any) => ({
    price: typeof l.price === "number" ? l.price : fromPrice(l.price),
    size: typeof l.totalSize === "number" ? l.totalSize : fromSize(l.totalSize),
    total: 0,
    percentage: 0,
  }));

  let cum = 0;
  for (const l of levels) {
    cum += l.size;
    l.total = cum;
  }

  const maxTotal = cum;
  for (const l of levels) {
    l.percentage = maxTotal > 0 ? (l.total / maxTotal) * 100 : 0;
  }

  return levels;
}
