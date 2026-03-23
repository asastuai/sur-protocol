"use client";

/**
 * SUR Protocol - Zustand Trading Store
 *
 * Replaces the Context+useReducer pattern. Components subscribe to specific
 * slices so only the affected UI re-renders on each state change.
 *
 * Usage:
 *   const markPrice = useTradingZustand(s => s.markPrice);
 *   const { submitMarketOrder } = useTradingZustand(s => s.actions);
 */

import { create } from "zustand";
import type { Hex } from "viem";
import { calculateTieredMargin } from "./constants";

// ============================================================
//                    STATE TYPES (re-exported from trading-store)
// ============================================================

export interface PriceLevel {
  price: number;
  size: number;
  total: number;
  percentage: number;
}

export interface TradeEntry {
  id: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  time: string;
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

export type PaperOrderType = "limit" | "stopMarket" | "stopLimit";

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
  tp?: number;
  sl?: number;
}

export interface PaperLimitOrder {
  id: string;
  market: string;
  marketId: Hex;
  side: "buy" | "sell";
  orderType: PaperOrderType;
  price: number;
  stopPrice?: number;
  size: number;
  leverage: number;
  createdAt: number;
  tp?: number;
  sl?: number;
  ocoGroupId?: string;
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

// ============================================================
//                    STORE STATE
// ============================================================

const PAPER_INITIAL_BALANCE = 100_000;

interface TradingStore {
  // Connection
  wsStatus: "connecting" | "connected" | "disconnected" | "error";

  // Market data
  selectedMarket: string;
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

  // Nonce
  nextNonce: number;

  // Paper trading
  paperMode: boolean;
  paperWalletBalance: number;
  paperBalance: number;
  paperPositions: PaperPosition[];
  paperOrders: PaperLimitOrder[];
  paperTradeHistory: PaperTradeEntry[];
  paperTotalRealizedPnl: number;

  // ---- Actions ----
  actions: TradingActions;
}

interface TradingActions {
  setWsStatus: (status: TradingStore["wsStatus"]) => void;
  setMarket: (market: string) => void;
  updateOrderbook: (bids: PriceLevel[], asks: PriceLevel[]) => void;
  addTrade: (trade: TradeEntry) => void;
  setTrades: (trades: TradeEntry[]) => void;
  updateMarkPrice: (price: number) => void;
  setPositions: (positions: PositionEntry[]) => void;
  setOpenOrders: (orders: OpenOrderEntry[]) => void;
  setVaultBalance: (balance: number) => void;
  orderAccepted: (orderId: string, status: string) => void;
  orderRejected: (orderId: string, reason: string) => void;
  orderCancelled: (orderId: string) => void;
  incrementNonce: () => void;
  clearOrderStatus: () => void;
  setMarketStats: (stats: { volume24h?: number; openInterest?: number; fundingRate?: number; change24h?: number }) => void;

  // Paper trading
  paperMarketOrder: (params: {
    market: string; marketId: Hex; side: "buy" | "sell"; size: number;
    leverage: number; fillPrice: number; feeBps: number; tp?: number; sl?: number;
  }) => void;
  paperLimitOrder: (params: {
    market: string; marketId: Hex; side: "buy" | "sell"; price: number; size: number;
    leverage: number; tp?: number; sl?: number; orderType?: PaperOrderType;
    stopPrice?: number; ocoGroupId?: string;
  }) => void;
  paperClosePosition: (positionId: string, closePrice: number, feeBps: number) => void;
  paperCancelOrder: (orderId: string) => void;
  paperUpdateTpSl: (positionId: string, tp?: number | null, sl?: number | null) => void;
  paperFillLimit: (orderId: string, fillPrice: number, feeBps: number) => void;
  paperDeposit: (amount: number) => void;
  paperWithdraw: (amount: number) => void;
  paperReset: () => void;
  paperLoad: (state: {
    paperWalletBalance: number; paperBalance: number;
    paperPositions: PaperPosition[]; paperOrders: PaperLimitOrder[];
    paperTradeHistory: PaperTradeEntry[]; paperTotalRealizedPnl: number;
  }) => void;
  togglePaperMode: () => void;
}

// ============================================================
//                    HELPERS
// ============================================================

function genId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

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
//                    STORE
// ============================================================

export const useTradingZustand = create<TradingStore>()((set, get) => ({
  // Initial state
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

  actions: {
    setWsStatus: (status) => set({ wsStatus: status }),

    setMarket: (market) => set({ selectedMarket: market, bids: [], asks: [], recentTrades: [] }),

    updateOrderbook: (bids, asks) => {
      const bestBid = bids[0]?.price || 0;
      const bestAsk = asks[0]?.price || 0;
      const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;
      const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);
      const prev = get().markPrice;
      const newMarkPrice = midPrice > 0 ? midPrice : prev;
      const dir = newMarkPrice >= prev ? "up" as const : "down" as const;
      set({
        bids, asks, spread,
        markPrice: newMarkPrice,
        lastPriceDirection: newMarkPrice !== prev ? dir : get().lastPriceDirection,
      });
    },

    addTrade: (trade) => {
      const dir = trade.price >= get().markPrice ? "up" : "down";
      set({
        recentTrades: [trade, ...get().recentTrades].slice(0, 50),
        markPrice: trade.price,
        lastPriceDirection: dir,
      });
    },

    setTrades: (trades) => set({ recentTrades: trades }),

    updateMarkPrice: (price) => {
      const dir = price >= get().markPrice ? "up" : "down";
      set({ markPrice: price, lastPriceDirection: dir });
    },

    setPositions: (positions) => set({ positions }),
    setOpenOrders: (orders) => set({ openOrders: orders }),
    setVaultBalance: (balance) => set({ vaultBalance: balance }),

    orderAccepted: (orderId, status) =>
      set({ lastOrderId: orderId, lastOrderStatus: status, orderError: null }),

    orderRejected: (orderId, reason) =>
      set({ lastOrderId: orderId, lastOrderStatus: "rejected", orderError: reason }),

    orderCancelled: (orderId) =>
      set({ openOrders: get().openOrders.filter(o => o.id !== orderId) }),

    incrementNonce: () => set({ nextNonce: get().nextNonce + 1 }),

    clearOrderStatus: () =>
      set({ lastOrderId: null, lastOrderStatus: null, orderError: null }),

    setMarketStats: (stats) => set({
      volume24h: stats.volume24h ?? get().volume24h,
      openInterest: stats.openInterest ?? get().openInterest,
      fundingRate: stats.fundingRate ?? get().fundingRate,
      change24h: stats.change24h ?? get().change24h,
    }),

    // ---- Paper Trading Actions ----

    paperMarketOrder: (params) => {
      const s = get();
      const { market, marketId, side, size, leverage, fillPrice, feeBps, tp, sl } = params;
      const notional = fillPrice * size;
      const tieredMargin = calculateTieredMargin(market, notional);
      const margin = Math.max(tieredMargin, notional / leverage);
      const fee = notional * (feeBps / 10000);
      const totalCost = margin + fee;
      if (totalCost > s.paperBalance) return;

      const isLong = side === "buy";
      const existing = s.paperPositions.find(p => p.market === market);

      if (existing && ((existing.side === "long" && !isLong) || (existing.side === "short" && isLong))) {
        // Close/reduce opposite
        const closeSize = Math.min(existing.size, size);
        const pnl = existing.side === "long"
          ? (fillPrice - existing.entryPrice) * closeSize
          : (existing.entryPrice - fillPrice) * closeSize;
        const closeFee = fillPrice * closeSize * (feeBps / 10000);
        const marginReturned = existing.margin * (closeSize / existing.size);
        const remainingSize = existing.size - closeSize;
        const newOpenSize = size - closeSize;

        let newPositions = s.paperPositions;
        if (remainingSize <= 0.00001) {
          newPositions = newPositions.filter(p => p.id !== existing.id);
        } else {
          newPositions = newPositions.map(p => p.id === existing.id ? {
            ...p, size: remainingSize, margin: p.margin - marginReturned,
          } : p);
        }

        let newBalance = s.paperBalance + marginReturned + pnl - closeFee;

        if (newOpenSize > 0.00001) {
          const newNotional = fillPrice * newOpenSize;
          const newMargin = newNotional / leverage;
          const newFee = newNotional * (feeBps / 10000);
          if (newMargin + newFee <= newBalance) {
            newBalance -= newMargin + newFee;
            newPositions = [...newPositions, {
              id: genId("paper"), market, marketId,
              side: isLong ? "long" as const : "short" as const,
              size: newOpenSize, entryPrice: fillPrice, margin: newMargin,
              leverage, openedAt: Date.now(),
              ...(tp ? { tp } : {}), ...(sl ? { sl } : {}),
            }];
          }
        }

        set({
          paperBalance: newBalance,
          paperPositions: newPositions,
          paperTotalRealizedPnl: s.paperTotalRealizedPnl + pnl,
          paperTradeHistory: [{
            id: genId("pt"), market, side, size: closeSize, price: fillPrice,
            pnl, fee: closeFee, timestamp: Date.now(),
          }, ...s.paperTradeHistory].slice(0, 100),
          lastOrderStatus: "filled", orderError: null,
        });
        return;
      }

      if (existing && existing.side === (isLong ? "long" : "short")) {
        // Same side: merge
        const newSize = existing.size + size;
        const newEntry = (existing.entryPrice * existing.size + fillPrice * size) / newSize;
        const newMargin = existing.margin + margin;

        set({
          paperBalance: s.paperBalance - totalCost,
          paperPositions: s.paperPositions.map(p => p.id === existing.id ? {
            ...p, size: newSize, entryPrice: newEntry, margin: newMargin,
            leverage: Math.round(newEntry * newSize / newMargin),
          } : p),
          paperTradeHistory: [{
            id: genId("pt"), market, side, size, price: fillPrice,
            pnl: 0, fee, timestamp: Date.now(),
          }, ...s.paperTradeHistory].slice(0, 100),
          lastOrderStatus: "filled", orderError: null,
        });
        return;
      }

      // New position
      set({
        paperBalance: s.paperBalance - totalCost,
        paperPositions: [...s.paperPositions, {
          id: genId("paper"), market, marketId,
          side: isLong ? "long" as const : "short" as const,
          size, entryPrice: fillPrice, margin, leverage,
          openedAt: Date.now(),
          ...(tp ? { tp } : {}), ...(sl ? { sl } : {}),
        }],
        paperTradeHistory: [{
          id: genId("pt"), market, side, size, price: fillPrice,
          pnl: 0, fee, timestamp: Date.now(),
        }, ...s.paperTradeHistory].slice(0, 100),
        lastOrderStatus: "filled", orderError: null,
      });
    },

    paperLimitOrder: (params) => {
      const s = get();
      const { market, marketId, side, price, size, leverage, tp, sl, orderType: ot, stopPrice, ocoGroupId } = params;
      const orderType = ot || "limit";
      const priceForMargin = orderType === "stopMarket" ? (stopPrice || price) : price;
      const notional = priceForMargin * size;
      const margin = notional / leverage;
      if (margin > s.paperBalance) return;

      set({
        paperBalance: s.paperBalance - margin,
        paperOrders: [...s.paperOrders, {
          id: genId("plimit"), market, marketId, side, orderType, price, size, leverage,
          createdAt: Date.now(),
          ...(stopPrice ? { stopPrice } : {}),
          ...(tp ? { tp } : {}), ...(sl ? { sl } : {}),
          ...(ocoGroupId ? { ocoGroupId } : {}),
        }],
        lastOrderStatus: "open", orderError: null,
      });
    },

    paperClosePosition: (positionId, closePrice, feeBps) => {
      const s = get();
      const pos = s.paperPositions.find(p => p.id === positionId);
      if (!pos) return;

      const pnl = pos.side === "long"
        ? (closePrice - pos.entryPrice) * pos.size
        : (pos.entryPrice - closePrice) * pos.size;
      const fee = closePrice * pos.size * (feeBps / 10000);

      set({
        paperBalance: s.paperBalance + pos.margin + pnl - fee,
        paperPositions: s.paperPositions.filter(p => p.id !== positionId),
        paperTotalRealizedPnl: s.paperTotalRealizedPnl + pnl,
        paperTradeHistory: [{
          id: genId("pt"), market: pos.market,
          side: (pos.side === "long" ? "sell" : "buy") as "buy" | "sell",
          size: pos.size, price: closePrice, pnl, fee, timestamp: Date.now(),
        }, ...s.paperTradeHistory].slice(0, 100),
        lastOrderStatus: `closed ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
        orderError: null,
      });
    },

    paperCancelOrder: (orderId) => {
      const s = get();
      const order = s.paperOrders.find(o => o.id === orderId);
      if (!order) return;
      const toCancel = order.ocoGroupId
        ? s.paperOrders.filter(o => o.id === order.id || o.ocoGroupId === order.ocoGroupId)
        : [order];
      const cancelIds = new Set(toCancel.map(o => o.id));
      const returnedMargin = toCancel.reduce((sum, o) => {
        const p = o.orderType === "stopMarket" ? (o.stopPrice || o.price) : o.price;
        return sum + (p * o.size) / o.leverage;
      }, 0);
      set({
        paperBalance: s.paperBalance + returnedMargin,
        paperOrders: s.paperOrders.filter(o => !cancelIds.has(o.id)),
      });
    },

    paperUpdateTpSl: (positionId, tp, sl) => {
      set({
        paperPositions: get().paperPositions.map(p =>
          p.id === positionId
            ? {
                ...p,
                ...(tp !== undefined ? { tp: tp === null ? undefined : tp } : {}),
                ...(sl !== undefined ? { sl: sl === null ? undefined : sl } : {}),
              }
            : p
        ),
      });
    },

    paperFillLimit: (orderId, fillPrice, feeBps) => {
      const s = get();
      const order = s.paperOrders.find(o => o.id === orderId);
      if (!order) return;

      // Cancel OCO siblings
      const ocoSiblings = order.ocoGroupId
        ? s.paperOrders.filter(o => o.id !== order.id && o.ocoGroupId === order.ocoGroupId)
        : [];
      const cancelIds = new Set([order.id, ...ocoSiblings.map(o => o.id)]);
      const siblingMargin = ocoSiblings.reduce((sum, o) => {
        const p = o.orderType === "stopMarket" ? (o.stopPrice || o.price) : o.price;
        return sum + (p * o.size) / o.leverage;
      }, 0);
      const orderMarginPrice = order.orderType === "stopMarket" ? (order.stopPrice || order.price) : order.price;

      // Remove orders and return margin
      set({
        paperOrders: s.paperOrders.filter(o => !cancelIds.has(o.id)),
        paperBalance: s.paperBalance + (orderMarginPrice * order.size) / order.leverage + siblingMargin,
      });

      // Now execute as market order
      get().actions.paperMarketOrder({
        market: order.market, marketId: order.marketId,
        side: order.side, size: order.size, leverage: order.leverage,
        tp: order.tp, sl: order.sl, fillPrice, feeBps,
      });
    },

    paperDeposit: (amount) => {
      const s = get();
      const amt = Math.min(amount, s.paperWalletBalance);
      if (amt <= 0) return;
      set({ paperWalletBalance: s.paperWalletBalance - amt, paperBalance: s.paperBalance + amt });
    },

    paperWithdraw: (amount) => {
      const s = get();
      const amt = Math.min(amount, s.paperBalance);
      if (amt <= 0) return;
      set({ paperWalletBalance: s.paperWalletBalance + amt, paperBalance: s.paperBalance - amt });
    },

    paperReset: () => set({
      paperWalletBalance: 10_000,
      paperBalance: PAPER_INITIAL_BALANCE,
      paperPositions: [],
      paperOrders: [],
      paperTradeHistory: [],
      paperTotalRealizedPnl: 0,
    }),

    paperLoad: (loaded) => {
      const loadedWallet = loaded.paperWalletBalance ?? 10_000;
      const loadedBalance = loaded.paperBalance ?? PAPER_INITIAL_BALANCE;
      const positions = loaded.paperPositions || [];
      const orders = loaded.paperOrders || [];
      const isBroken = loadedWallet <= 0 && loadedBalance <= 0 && positions.length === 0 && orders.length === 0;
      set({
        paperWalletBalance: isBroken ? 10_000 : loadedWallet,
        paperBalance: isBroken ? PAPER_INITIAL_BALANCE : loadedBalance,
        paperPositions: positions,
        paperOrders: orders,
        paperTradeHistory: loaded.paperTradeHistory || [],
        paperTotalRealizedPnl: loaded.paperTotalRealizedPnl || 0,
      });
    },

    togglePaperMode: () => set({ paperMode: !get().paperMode }),
  },
}));
