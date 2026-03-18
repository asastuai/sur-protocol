/**
 * SUR Protocol - Matching Engine
 *
 * In-memory orderbook with price-time priority matching.
 * TypeScript port of the Rust engine for the API server.
 *
 * Architecture:
 *   - Bids: Map sorted by price DESC (best bid = highest price)
 *   - Asks: Map sorted by price ASC (best ask = lowest price)
 *   - Within each price level: FIFO queue
 *   - Trades execute at the MAKER's price (price improvement for taker)
 */

import { randomUUID } from "crypto";
import type {
  Order, Trade, Side, OrderType, TimeInForce, OrderStatus,
  MarketConfig, PriceLevel, OrderbookSnapshot,
} from "../types/index.js";

// ============================================================
//                    PRICE LEVEL
// ============================================================

class OrderQueue {
  orders: Order[] = [];
  totalSize: bigint = 0n;
  visibleSize: bigint = 0n;  // excludes hidden orders

  push(order: Order): void {
    this.orders.push(order);
    this.totalSize += order.remaining;
    if (!order.hidden) this.visibleSize += order.remaining;
  }

  front(): Order | undefined {
    return this.orders[0];
  }

  popFront(): Order | undefined {
    const order = this.orders.shift();
    if (order) {
      this.totalSize -= order.remaining;
      if (!order.hidden) this.visibleSize -= order.remaining;
    }
    return order;
  }

  removeById(orderId: string): Order | undefined {
    const idx = this.orders.findIndex((o) => o.id === orderId);
    if (idx === -1) return undefined;
    const [order] = this.orders.splice(idx, 1);
    this.totalSize -= order.remaining;
    if (!order.hidden) this.visibleSize -= order.remaining;
    return order;
  }

  isEmpty(): boolean {
    return this.orders.length === 0;
  }

  reduceFront(amount: bigint): void {
    if (this.orders[0]) {
      this.orders[0].remaining -= amount;
      this.totalSize -= amount;
      if (!this.orders[0].hidden) this.visibleSize -= amount;
    }
  }

  /** True if all remaining orders are hidden */
  isVisiblyEmpty(): boolean {
    return this.visibleSize <= 0n;
  }
}

// ============================================================
//                    ORDERBOOK
// ============================================================

export class OrderBook {
  readonly market: MarketConfig;

  // Sorted maps: JS Map preserves insertion order, we maintain sorted manually
  private bids: Map<bigint, OrderQueue> = new Map(); // price DESC
  private asks: Map<bigint, OrderQueue> = new Map(); // price ASC
  private orderIndex: Map<string, { side: Side; price: bigint }> = new Map();

  tradeCount = 0;

  constructor(market: MarketConfig) {
    this.market = market;
  }

  // --- Queries ---

  bestBid(): bigint | undefined {
    return this.sortedBidPrices()[0];
  }

  bestAsk(): bigint | undefined {
    return this.sortedAskPrices()[0];
  }

  spread(): { bid: bigint; ask: bigint; spread: bigint } | undefined {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (bid === undefined || ask === undefined) return undefined;
    return { bid, ask, spread: ask - bid };
  }

  activeOrderCount(): number {
    return this.orderIndex.size;
  }

  snapshot(depth: number = 20): OrderbookSnapshot {
    return {
      marketId: this.market.id,
      bids: this.topBids(depth),
      asks: this.topAsks(depth),
      timestamp: Date.now(),
    };
  }

  topBids(n: number): PriceLevel[] {
    return this.sortedBidPrices()
      .map((price) => {
        const q = this.bids.get(price)!;
        // Only show visible portion
        return { price, totalSize: q.visibleSize, orderCount: q.orders.filter(o => !o.hidden).length };
      })
      .filter((lvl) => lvl.totalSize > 0n) // skip levels that are entirely hidden
      .slice(0, n);
  }

  topAsks(n: number): PriceLevel[] {
    return this.sortedAskPrices()
      .map((price) => {
        const q = this.asks.get(price)!;
        return { price, totalSize: q.visibleSize, orderCount: q.orders.filter(o => !o.hidden).length };
      })
      .filter((lvl) => lvl.totalSize > 0n)
      .slice(0, n);
  }

  // --- Order Management ---

  placeOrder(order: Order): void {
    const side = order.side;
    const price = order.price;
    const map = side === "buy" ? this.bids : this.asks;

    if (!map.has(price)) map.set(price, new OrderQueue());
    map.get(price)!.push(order);
    this.orderIndex.set(order.id, { side, price });
  }

  cancelOrder(orderId: string): Order | undefined {
    const entry = this.orderIndex.get(orderId);
    if (!entry) return undefined;

    const { side, price } = entry;
    const map = side === "buy" ? this.bids : this.asks;
    const queue = map.get(price);
    if (!queue) return undefined;

    const order = queue.removeById(orderId);
    if (order) {
      this.orderIndex.delete(orderId);
      if (queue.isEmpty()) map.delete(price);
    }
    return order;
  }

  peekBestAsk(): Order | undefined {
    const price = this.sortedAskPrices()[0];
    if (price === undefined) return undefined;
    return this.asks.get(price)?.front();
  }

  peekBestBid(): Order | undefined {
    const price = this.sortedBidPrices()[0];
    if (price === undefined) return undefined;
    return this.bids.get(price)?.front();
  }

  fillBestAsk(qty: bigint): Order | undefined {
    const price = this.sortedAskPrices()[0];
    if (price === undefined) return undefined;
    const queue = this.asks.get(price)!;
    const front = queue.front();
    if (!front) return undefined;

    queue.reduceFront(qty);
    if (front.remaining <= 0n) {
      const filled = queue.popFront();
      this.orderIndex.delete(front.id);
      if (queue.isEmpty()) this.asks.delete(price);
      if (filled) filled.status = "filled";
      return filled;
    } else {
      front.status = "partiallyFilled";
      return undefined;
    }
  }

  fillBestBid(qty: bigint): Order | undefined {
    const price = this.sortedBidPrices()[0];
    if (price === undefined) return undefined;
    const queue = this.bids.get(price)!;
    const front = queue.front();
    if (!front) return undefined;

    queue.reduceFront(qty);
    if (front.remaining <= 0n) {
      const filled = queue.popFront();
      this.orderIndex.delete(front.id);
      if (queue.isEmpty()) this.bids.delete(price);
      if (filled) filled.status = "filled";
      return filled;
    } else {
      front.status = "partiallyFilled";
      return undefined;
    }
  }

  // --- Sorting ---

  private sortedBidPrices(): bigint[] {
    return [...this.bids.keys()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  }

  private sortedAskPrices(): bigint[] {
    return [...this.asks.keys()].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
  }
}

// ============================================================
//                  MATCHING ENGINE
// ============================================================

export interface MatchResult {
  orderId: string;
  status: OrderStatus;
  trades: Trade[];
  remaining: bigint;
}

export class MatchingEngine {
  readonly book: OrderBook;
  private allTrades: Trade[] = [];

  constructor(market: MarketConfig) {
    this.book = new OrderBook(market);
  }

  submitOrder(order: Order): MatchResult {
    // Validate
    const rejection = this.validate(order);
    if (rejection) {
      order.status = "rejected";
      return { orderId: order.id, status: "rejected", trades: [], remaining: order.remaining };
    }

    // PostOnly check
    if (order.timeInForce === "PostOnly" && this.wouldMatch(order)) {
      order.status = "rejected";
      return { orderId: order.id, status: "rejected", trades: [], remaining: order.remaining };
    }

    // FOK check
    if (order.timeInForce === "FOK" && !this.canFillEntirely(order)) {
      order.status = "cancelled";
      return { orderId: order.id, status: "cancelled", trades: [], remaining: order.remaining };
    }

    // Match
    const trades = this.matchOrder(order);

    // Handle remaining
    if (order.remaining === 0n) {
      order.status = "filled";
    } else if (order.timeInForce === "GTC" || order.timeInForce === "PostOnly") {
      if (order.orderType === "limit") {
        order.status = trades.length > 0 ? "partiallyFilled" : "open";
        this.book.placeOrder(order);
      }
    } else {
      // IOC or market: cancel remainder
      order.status = trades.length > 0 ? "partiallyFilled" : "cancelled";
    }

    this.allTrades.push(...trades);

    return {
      orderId: order.id,
      status: order.status,
      trades,
      remaining: order.remaining,
    };
  }

  cancelOrder(orderId: string): Order | undefined {
    const order = this.book.cancelOrder(orderId);
    if (order) order.status = "cancelled";
    return order;
  }

  recentTrades(n: number = 50): Trade[] {
    return this.allTrades.slice(-n);
  }

  // --- Private ---

  private validate(order: Order): string | null {
    if (order.size === 0n) return "Zero size";
    if (order.orderType === "limit" && order.price === 0n) return "Limit order needs price";
    if (order.size < this.book.market.minSize) return "Below min size";
    if (order.size % this.book.market.lotSize !== 0n) return "Not aligned to lot size";
    if (order.orderType === "limit" && order.price % this.book.market.tickSize !== 0n) {
      return "Not aligned to tick size";
    }
    return null;
  }

  private wouldMatch(order: Order): boolean {
    if (order.side === "buy") {
      const bestAsk = this.book.bestAsk();
      return bestAsk !== undefined && order.price >= bestAsk;
    } else {
      const bestBid = this.book.bestBid();
      return bestBid !== undefined && order.price <= bestBid;
    }
  }

  private canFillEntirely(order: Order): boolean {
    // Simplified: check total depth at matchable prices
    let remaining = order.remaining;
    if (order.side === "buy") {
      for (const level of this.book.topAsks(100)) {
        if (order.orderType === "limit" && level.price > order.price) break;
        const fill = remaining < level.totalSize ? remaining : level.totalSize;
        remaining -= fill;
        if (remaining === 0n) return true;
      }
    } else {
      for (const level of this.book.topBids(100)) {
        if (order.orderType === "limit" && level.price < order.price) break;
        const fill = remaining < level.totalSize ? remaining : level.totalSize;
        remaining -= fill;
        if (remaining === 0n) return true;
      }
    }
    return remaining === 0n;
  }

  private matchOrder(taker: Order): Trade[] {
    const trades: Trade[] = [];

    if (taker.side === "buy") {
      while (taker.remaining > 0n) {
        const maker = this.book.peekBestAsk();
        if (!maker) break;
        if (taker.orderType === "limit" && taker.price < maker.price) break;

        const fillQty = taker.remaining < maker.remaining ? taker.remaining : maker.remaining;
        const execPrice = maker.price; // trade at maker's price

        trades.push({
          id: randomUUID(),
          marketId: taker.marketId,
          price: execPrice,
          size: fillQty,
          makerOrderId: maker.id,
          takerOrderId: taker.id,
          makerTrader: maker.trader,
          takerTrader: taker.trader,
          makerSide: "sell",
          takerSide: "buy",
          timestamp: Date.now(),
        });

        taker.remaining -= fillQty;
        this.book.fillBestAsk(fillQty);
        this.book.tradeCount++;
      }
    } else {
      while (taker.remaining > 0n) {
        const maker = this.book.peekBestBid();
        if (!maker) break;
        if (taker.orderType === "limit" && taker.price > maker.price) break;

        const fillQty = taker.remaining < maker.remaining ? taker.remaining : maker.remaining;
        const execPrice = maker.price;

        trades.push({
          id: randomUUID(),
          marketId: taker.marketId,
          price: execPrice,
          size: fillQty,
          makerOrderId: maker.id,
          takerOrderId: taker.id,
          makerTrader: maker.trader,
          takerTrader: taker.trader,
          makerSide: "buy",
          takerSide: "sell",
          timestamp: Date.now(),
        });

        taker.remaining -= fillQty;
        this.book.fillBestBid(fillQty);
        this.book.tradeCount++;
      }
    }

    return trades;
  }
}

// ============================================================
//                    ORDER FACTORY
// ============================================================

export function createOrder(params: {
  trader: `0x${string}`;
  marketId: `0x${string}`;
  side: Side;
  orderType: OrderType;
  price: bigint;
  size: bigint;
  timeInForce: TimeInForce;
  nonce: bigint;
  expiry: bigint;
  signature: `0x${string}`;
  hidden?: boolean;
}): Order {
  return {
    id: randomUUID(),
    trader: params.trader,
    marketId: params.marketId,
    side: params.side,
    orderType: params.orderType,
    price: params.price,
    size: params.size,
    remaining: params.size,
    timeInForce: params.timeInForce,
    status: "open",
    nonce: params.nonce,
    expiry: params.expiry,
    signature: params.signature,
    createdAt: Date.now(),
    hidden: params.hidden || false,
  };
}
