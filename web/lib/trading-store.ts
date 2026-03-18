/**
 * SUR Protocol - Trading Store
 *
 * Central state for all trading data. Uses useReducer for predictable updates.
 * The TradingProvider connects WebSocket messages to dispatch actions.
 *
 * Data flow:
 *   WS message → dispatch(action) → reducer → new state → components re-render
 */

"use client";

import { useReducer, type Dispatch } from "react";
import type { Hex } from "viem";
import { calculateTieredMargin, getMaxLeverageForSize } from "./constants";

// ============================================================
//                    STATE TYPES
// ============================================================

export interface PriceLevel {
  price: number;     // human-readable (50125.42)
  size: number;      // human-readable (1.5000)
  total: number;     // cumulative
  percentage: number; // 0-100 for depth bar
}

export interface TradeEntry {
  id: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  time: string;      // formatted time string
  timestamp: number;
}

export interface PositionEntry {
  market: string;
  marketId: Hex;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  pnl: number;
  pnlPct: number;
  margin: number;
  leverage: number;
  liqPrice: number;
}

export interface OpenOrderEntry {
  id: string;
  market: string;
  side: "buy" | "sell";
  type: string;
  tif: string;
  price: number;
  size: number;
  filled: number;
  timestamp: number;
}

export interface TradingState {
  // Connection
  wsStatus: "connecting" | "connected" | "disconnected" | "error";

  // Market data
  selectedMarket: string;  // market name "BTC-USD"
  markPrice: number;
  lastPriceDirection: "up" | "down";
  change24h: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;

  // Orderbook
  bids: PriceLevel[];
  asks: PriceLevel[];
  spread: number;

  // Trades
  recentTrades: TradeEntry[];

  // User data
  positions: PositionEntry[];
  openOrders: OpenOrderEntry[];
  vaultBalance: number;

  // Order status
  lastOrderId: string | null;
  lastOrderStatus: string | null;
  orderError: string | null;

  // Nonce tracking
  nextNonce: number;

  // Paper trading
  paperMode: boolean;
  paperWalletBalance: number; // USDC in "wallet" (not yet deposited)
  paperBalance: number;       // USDC in vault (available for trading)
  paperPositions: PaperPosition[];
  paperOrders: PaperLimitOrder[];
  paperTradeHistory: PaperTradeEntry[];
  paperTotalRealizedPnl: number;
}

export interface PaperPosition {
  id: string;
  market: string;
  marketId: Hex;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  margin: number;
  leverage: number;
  openedAt: number;
  tp?: number;  // take profit price
  sl?: number;  // stop loss price
}

export interface PaperLimitOrder {
  id: string;
  market: string;
  marketId: Hex;
  side: "buy" | "sell";
  price: number;
  size: number;
  leverage: number;
  createdAt: number;
  tp?: number;
  sl?: number;
}

export interface PaperTradeEntry {
  id: string;
  market: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  pnl: number;
  fee: number;
  timestamp: number;
}

const PAPER_INITIAL_BALANCE = 100_000;

export const initialState: TradingState = {
  wsStatus: "disconnected",
  selectedMarket: "BTC-USD",
  markPrice: 0,
  lastPriceDirection: "up",
  change24h: 0,
  volume24h: 0,
  openInterest: 0,
  fundingRate: 0,
  bids: [],
  asks: [],
  spread: 0,
  recentTrades: [],
  positions: [],
  openOrders: [],
  vaultBalance: 0,
  lastOrderId: null,
  lastOrderStatus: null,
  orderError: null,
  nextNonce: 1,
  paperMode: false,
  paperWalletBalance: 10_000,
  paperBalance: PAPER_INITIAL_BALANCE,
  paperPositions: [],
  paperOrders: [],
  paperTradeHistory: [],
  paperTotalRealizedPnl: 0,
};

// ============================================================
//                    ACTIONS
// ============================================================

export type TradingAction =
  | { type: "SET_WS_STATUS"; status: TradingState["wsStatus"] }
  | { type: "SET_MARKET"; market: string }
  | { type: "UPDATE_ORDERBOOK"; bids: PriceLevel[]; asks: PriceLevel[] }
  | { type: "SET_ORDERBOOK_SNAPSHOT"; bids: PriceLevel[]; asks: PriceLevel[] }
  | { type: "ADD_TRADE"; trade: TradeEntry }
  | { type: "SET_TRADES"; trades: TradeEntry[] }
  | { type: "UPDATE_MARK_PRICE"; price: number }
  | { type: "SET_POSITIONS"; positions: PositionEntry[] }
  | { type: "SET_OPEN_ORDERS"; orders: OpenOrderEntry[] }
  | { type: "SET_VAULT_BALANCE"; balance: number }
  | { type: "ORDER_ACCEPTED"; orderId: string; status: string }
  | { type: "ORDER_REJECTED"; orderId: string; reason: string }
  | { type: "ORDER_CANCELLED"; orderId: string }
  | { type: "INCREMENT_NONCE" }
  | { type: "CLEAR_ORDER_STATUS" }
  | { type: "SET_MARKET_STATS"; volume24h?: number; openInterest?: number; fundingRate?: number; change24h?: number }
  // Paper trading actions
  | { type: "PAPER_MARKET_ORDER"; market: string; marketId: Hex; side: "buy" | "sell"; size: number; leverage: number; fillPrice: number; feeBps: number; tp?: number; sl?: number }
  | { type: "PAPER_LIMIT_ORDER"; market: string; marketId: Hex; side: "buy" | "sell"; price: number; size: number; leverage: number; tp?: number; sl?: number }
  | { type: "PAPER_CLOSE_POSITION"; positionId: string; closePrice: number; feeBps: number }
  | { type: "PAPER_CANCEL_ORDER"; orderId: string }
  | { type: "PAPER_FILL_LIMIT"; orderId: string; fillPrice: number; feeBps: number }
  | { type: "PAPER_DEPOSIT"; amount: number }
  | { type: "PAPER_WITHDRAW"; amount: number }
  | { type: "PAPER_RESET" }
  | { type: "PAPER_LOAD"; state: Pick<TradingState, "paperWalletBalance" | "paperBalance" | "paperPositions" | "paperOrders" | "paperTradeHistory" | "paperTotalRealizedPnl"> }
  | { type: "TOGGLE_PAPER_MODE" };

// ============================================================
//                    REDUCER
// ============================================================

export function tradingReducer(state: TradingState, action: TradingAction): TradingState {
  switch (action.type) {
    case "SET_WS_STATUS":
      return { ...state, wsStatus: action.status };

    case "SET_MARKET":
      return { ...state, selectedMarket: action.market, bids: [], asks: [], recentTrades: [] };

    case "SET_ORDERBOOK_SNAPSHOT":
    case "UPDATE_ORDERBOOK": {
      const bestBid = action.bids[0]?.price || 0;
      const bestAsk = action.asks[0]?.price || 0;
      const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;
      // Always update mark price from mid price of orderbook
      const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);
      const newMarkPrice = midPrice > 0 ? midPrice : state.markPrice;
      const dir = newMarkPrice >= state.markPrice ? "up" as const : "down" as const;
      return {
        ...state,
        bids: action.bids,
        asks: action.asks,
        spread,
        markPrice: newMarkPrice,
        lastPriceDirection: newMarkPrice !== state.markPrice ? dir : state.lastPriceDirection,
      };
    }

    case "ADD_TRADE": {
      const newDir = action.trade.price >= state.markPrice ? "up" : "down";
      return {
        ...state,
        recentTrades: [action.trade, ...state.recentTrades].slice(0, 50),
        markPrice: action.trade.price,
        lastPriceDirection: newDir,
      };
    }

    case "SET_TRADES":
      return { ...state, recentTrades: action.trades };

    case "UPDATE_MARK_PRICE": {
      const dir = action.price >= state.markPrice ? "up" : "down";
      return { ...state, markPrice: action.price, lastPriceDirection: dir };
    }

    case "SET_POSITIONS":
      return { ...state, positions: action.positions };

    case "SET_OPEN_ORDERS":
      return { ...state, openOrders: action.orders };

    case "SET_VAULT_BALANCE":
      return { ...state, vaultBalance: action.balance };

    case "ORDER_ACCEPTED":
      return { ...state, lastOrderId: action.orderId, lastOrderStatus: action.status, orderError: null };

    case "ORDER_REJECTED":
      return { ...state, lastOrderId: action.orderId, lastOrderStatus: "rejected", orderError: action.reason };

    case "ORDER_CANCELLED": {
      const filtered = state.openOrders.filter(o => o.id !== action.orderId);
      return { ...state, openOrders: filtered };
    }

    case "INCREMENT_NONCE":
      return { ...state, nextNonce: state.nextNonce + 1 };

    case "CLEAR_ORDER_STATUS":
      return { ...state, lastOrderId: null, lastOrderStatus: null, orderError: null };

    case "SET_MARKET_STATS":
      return {
        ...state,
        volume24h: action.volume24h ?? state.volume24h,
        openInterest: action.openInterest ?? state.openInterest,
        fundingRate: action.fundingRate ?? state.fundingRate,
        change24h: action.change24h ?? state.change24h,
      };

    // ---- Paper Trading ----

    case "PAPER_MARKET_ORDER": {
      const { market, marketId, side, size, leverage, fillPrice, feeBps, tp, sl } = action;
      const notional = fillPrice * size;
      // Use tiered margin calculation
      const tieredMargin = calculateTieredMargin(market, notional);
      const margin = Math.max(tieredMargin, notional / leverage); // use the stricter of tiered vs user-selected
      const fee = notional * (feeBps / 10000);
      const totalCost = margin + fee;

      if (totalCost > state.paperBalance) return state; // insufficient balance

      const isLong = side === "buy";
      // Check if there's an existing position in this market
      const existing = state.paperPositions.find(p => p.market === market);

      if (existing && ((existing.side === "long" && !isLong) || (existing.side === "short" && isLong))) {
        // Opposite side: close/reduce existing position
        const closeSize = Math.min(existing.size, size);
        const pnl = existing.side === "long"
          ? (fillPrice - existing.entryPrice) * closeSize
          : (existing.entryPrice - fillPrice) * closeSize;
        const closeFee = fillPrice * closeSize * (feeBps / 10000);
        const marginReturned = existing.margin * (closeSize / existing.size);
        const remainingSize = existing.size - closeSize;
        const newOpenSize = size - closeSize;

        let newPositions = state.paperPositions;
        if (remainingSize <= 0.00001) {
          newPositions = newPositions.filter(p => p.id !== existing.id);
        } else {
          newPositions = newPositions.map(p => p.id === existing.id ? {
            ...p,
            size: remainingSize,
            margin: p.margin - marginReturned,
          } : p);
        }

        let newBalance = state.paperBalance + marginReturned + pnl - closeFee;

        // If there's remaining new size, open a new position
        if (newOpenSize > 0.00001) {
          const newNotional = fillPrice * newOpenSize;
          const newMargin = newNotional / leverage;
          const newFee = newNotional * (feeBps / 10000);
          if (newMargin + newFee <= newBalance) {
            newBalance -= newMargin + newFee;
            newPositions = [...newPositions, {
              id: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              market, marketId,
              side: isLong ? "long" as const : "short" as const,
              size: newOpenSize,
              entryPrice: fillPrice,
              margin: newMargin,
              leverage,
              openedAt: Date.now(),
              ...(tp ? { tp } : {}),
              ...(sl ? { sl } : {}),
            }];
          }
        }

        return {
          ...state,
          paperBalance: newBalance,
          paperPositions: newPositions,
          paperTotalRealizedPnl: state.paperTotalRealizedPnl + pnl,
          paperTradeHistory: [{
            id: `pt_${Date.now()}`,
            market, side, size: closeSize, price: fillPrice,
            pnl, fee: closeFee, timestamp: Date.now(),
          }, ...state.paperTradeHistory].slice(0, 100),
          lastOrderStatus: "filled",
          orderError: null,
        };
      }

      if (existing && existing.side === (isLong ? "long" : "short")) {
        // Same side: merge position (weighted average entry)
        const newSize = existing.size + size;
        const newEntry = (existing.entryPrice * existing.size + fillPrice * size) / newSize;
        const newMargin = existing.margin + margin;

        return {
          ...state,
          paperBalance: state.paperBalance - totalCost,
          paperPositions: state.paperPositions.map(p => p.id === existing.id ? {
            ...p, size: newSize, entryPrice: newEntry, margin: newMargin,
            leverage: Math.round(newEntry * newSize / newMargin),
          } : p),
          paperTradeHistory: [{
            id: `pt_${Date.now()}`,
            market, side, size, price: fillPrice,
            pnl: 0, fee, timestamp: Date.now(),
          }, ...state.paperTradeHistory].slice(0, 100),
          lastOrderStatus: "filled",
          orderError: null,
        };
      }

      // No existing position: open new
      return {
        ...state,
        paperBalance: state.paperBalance - totalCost,
        paperPositions: [...state.paperPositions, {
          id: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          market, marketId,
          side: isLong ? "long" as const : "short" as const,
          size, entryPrice: fillPrice, margin, leverage,
          openedAt: Date.now(),
          ...(tp ? { tp } : {}),
          ...(sl ? { sl } : {}),
        }],
        paperTradeHistory: [{
          id: `pt_${Date.now()}`,
          market, side, size, price: fillPrice,
          pnl: 0, fee, timestamp: Date.now(),
        }, ...state.paperTradeHistory].slice(0, 100),
        lastOrderStatus: "filled",
        orderError: null,
      };
    }

    case "PAPER_LIMIT_ORDER": {
      const { market, marketId, side, price, size, leverage, tp, sl } = action;
      const notional = price * size;
      const margin = notional / leverage;
      if (margin > state.paperBalance) return state;

      return {
        ...state,
        paperBalance: state.paperBalance - margin,
        paperOrders: [...state.paperOrders, {
          id: `plimit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          market, marketId, side, price, size, leverage,
          createdAt: Date.now(),
          ...(tp ? { tp } : {}),
          ...(sl ? { sl } : {}),
        }],
        lastOrderStatus: "open",
        orderError: null,
      };
    }

    case "PAPER_CLOSE_POSITION": {
      const { positionId, closePrice, feeBps } = action;
      const pos = state.paperPositions.find(p => p.id === positionId);
      if (!pos) return state;

      const pnl = pos.side === "long"
        ? (closePrice - pos.entryPrice) * pos.size
        : (pos.entryPrice - closePrice) * pos.size;
      const fee = closePrice * pos.size * (feeBps / 10000);

      return {
        ...state,
        paperBalance: state.paperBalance + pos.margin + pnl - fee,
        paperPositions: state.paperPositions.filter(p => p.id !== positionId),
        paperTotalRealizedPnl: state.paperTotalRealizedPnl + pnl,
        paperTradeHistory: [{
          id: `pt_${Date.now()}`,
          market: pos.market,
          side: (pos.side === "long" ? "sell" : "buy") as "buy" | "sell",
          size: pos.size, price: closePrice,
          pnl, fee, timestamp: Date.now(),
        }, ...state.paperTradeHistory].slice(0, 100),
        lastOrderStatus: `closed ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
        orderError: null,
      };
    }

    case "PAPER_CANCEL_ORDER": {
      const order = state.paperOrders.find(o => o.id === action.orderId);
      if (!order) return state;
      const margin = (order.price * order.size) / order.leverage;
      return {
        ...state,
        paperBalance: state.paperBalance + margin,
        paperOrders: state.paperOrders.filter(o => o.id !== action.orderId),
      };
    }

    case "PAPER_FILL_LIMIT": {
      const { orderId, fillPrice, feeBps } = action;
      const order = state.paperOrders.find(o => o.id === orderId);
      if (!order) return state;

      // Remove from orders, then process as market order
      const stateWithoutOrder = {
        ...state,
        paperOrders: state.paperOrders.filter(o => o.id !== orderId),
        // Return margin that was reserved
        paperBalance: state.paperBalance + (order.price * order.size) / order.leverage,
      };

      return tradingReducer(stateWithoutOrder, {
        type: "PAPER_MARKET_ORDER",
        market: order.market,
        marketId: order.marketId,
        side: order.side,
        size: order.size,
        leverage: order.leverage,
        tp: order.tp,
        sl: order.sl,
        fillPrice,
        feeBps,
      });
    }

    case "PAPER_DEPOSIT": {
      const amt = Math.min(action.amount, state.paperWalletBalance);
      if (amt <= 0) return state;
      return {
        ...state,
        paperWalletBalance: state.paperWalletBalance - amt,
        paperBalance: state.paperBalance + amt,
      };
    }

    case "PAPER_WITHDRAW": {
      const amt = Math.min(action.amount, state.paperBalance);
      if (amt <= 0) return state;
      return {
        ...state,
        paperWalletBalance: state.paperWalletBalance + amt,
        paperBalance: state.paperBalance - amt,
      };
    }

    case "PAPER_RESET":
      return {
        ...state,
        paperWalletBalance: 10_000,
        paperBalance: PAPER_INITIAL_BALANCE,
        paperPositions: [],
        paperOrders: [],
        paperTradeHistory: [],
        paperTotalRealizedPnl: 0,
      };

    case "TOGGLE_PAPER_MODE":
      return { ...state, paperMode: !state.paperMode };

    case "PAPER_LOAD": {
      const loadedWallet = action.state.paperWalletBalance ?? 10_000;
      const loadedBalance = action.state.paperBalance ?? PAPER_INITIAL_BALANCE;
      const positions = action.state.paperPositions || [];
      const orders = action.state.paperOrders || [];
      // If everything is zeroed out with no positions/orders, reset to defaults
      const isBroken = loadedWallet <= 0 && loadedBalance <= 0 && positions.length === 0 && orders.length === 0;
      return {
        ...state,
        paperWalletBalance: isBroken ? 10_000 : loadedWallet,
        paperBalance: isBroken ? PAPER_INITIAL_BALANCE : loadedBalance,
        paperPositions: positions,
        paperOrders: orders,
        paperTradeHistory: action.state.paperTradeHistory || [],
        paperTotalRealizedPnl: action.state.paperTotalRealizedPnl || 0,
      };
    }

    default:
      return state;
  }
}

// ============================================================
//                    HELPERS
// ============================================================

/** Compute P&L for a paper position given current mark price */
export function computePaperPnl(pos: PaperPosition, markPrice: number) {
  const pnl = pos.side === "long"
    ? (markPrice - pos.entryPrice) * pos.size
    : (pos.entryPrice - markPrice) * pos.size;
  const pnlPct = pos.margin > 0 ? (pnl / pos.margin) * 100 : 0;
  const liqPrice = pos.side === "long"
    ? pos.entryPrice - (pos.margin * 0.95) / pos.size
    : pos.entryPrice + (pos.margin * 0.95) / pos.size;
  return { pnl, pnlPct, liqPrice };
}

// ============================================================
//                    HOOK
// ============================================================

export function useTradingStore() {
  return useReducer(tradingReducer, initialState);
}

export type TradingDispatch = Dispatch<TradingAction>;
