/**
 * Matching Engine Tests
 *
 * Run: npm test (or npx vitest run)
 */

import { describe, it, expect } from "vitest";
import { MatchingEngine, createOrder } from "../src/engine/matching.js";
import { type MarketConfig, toPrice, toSize } from "../src/types/index.js";
import { keccak256, toHex } from "viem";

const BTC_MARKET: MarketConfig = {
  id: keccak256(toHex("BTC-USD", { size: null })) as `0x${string}`,
  name: "BTC-USD",
  baseAsset: "BTC",
  quoteAsset: "USD",
  tickSize: 100n,
  lotSize: 1000n,
  minSize: 10_000n,
  maxLeverage: 20,
  makerFeeBps: 2,
  takerFeeBps: 6,
};

function makeOrder(
  side: "buy" | "sell",
  price: number,
  size: number,
  tif: "GTC" | "IOC" | "FOK" | "PostOnly" = "GTC"
) {
  return createOrder({
    trader: "0xAlice0000000000000000000000000000000001" as `0x${string}`,
    marketId: BTC_MARKET.id,
    side,
    orderType: "limit",
    price: toPrice(price),
    size: toSize(size),
    timeInForce: tif,
    nonce: BigInt(Math.floor(Math.random() * 1e9)),
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature: "0x00" as `0x${string}`,
  });
}

describe("MatchingEngine", () => {
  it("places a limit order on the book when no match", () => {
    const engine = new MatchingEngine(BTC_MARKET);
    const result = engine.submitOrder(makeOrder("buy", 50_000, 1));

    expect(result.status).toBe("open");
    expect(result.trades).toHaveLength(0);
    expect(engine.book.bestBid()).toBe(toPrice(50_000));
  });

  it("matches a buy against a resting sell", () => {
    const engine = new MatchingEngine(BTC_MARKET);

    engine.submitOrder(makeOrder("sell", 50_000, 1));
    const result = engine.submitOrder(makeOrder("buy", 50_000, 1));

    expect(result.status).toBe("filled");
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].price).toBe(toPrice(50_000));
    expect(result.trades[0].size).toBe(toSize(1));
    expect(engine.book.activeOrderCount()).toBe(0);
  });

  it("executes at maker price (price improvement)", () => {
    const engine = new MatchingEngine(BTC_MARKET);

    engine.submitOrder(makeOrder("sell", 49_000, 1)); // maker at $49k
    const result = engine.submitOrder(makeOrder("buy", 50_000, 1)); // taker willing to pay $50k

    expect(result.trades[0].price).toBe(toPrice(49_000)); // executes at maker's price
  });

  it("partially fills and rests remainder on book", () => {
    const engine = new MatchingEngine(BTC_MARKET);

    engine.submitOrder(makeOrder("sell", 50_000, 0.5));
    const result = engine.submitOrder(makeOrder("buy", 50_000, 1));

    expect(result.status).toBe("partiallyFilled");
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].size).toBe(toSize(0.5));
    expect(result.remaining).toBe(toSize(0.5));
    expect(engine.book.bestBid()).toBe(toPrice(50_000)); // remainder on book
  });

  it("sweeps multiple price levels", () => {
    const engine = new MatchingEngine(BTC_MARKET);

    engine.submitOrder(makeOrder("sell", 50_000, 0.5));
    engine.submitOrder(makeOrder("sell", 50_100, 0.5));
    engine.submitOrder(makeOrder("sell", 50_200, 0.5));

    const result = engine.submitOrder(makeOrder("buy", 50_200, 1.2));

    expect(result.trades).toHaveLength(3);
    expect(result.trades[0].price).toBe(toPrice(50_000));
    expect(result.trades[1].price).toBe(toPrice(50_100));
    expect(result.trades[2].price).toBe(toPrice(50_200));
  });

  it("respects FIFO within a price level", () => {
    const engine = new MatchingEngine(BTC_MARKET);

    const sell1 = makeOrder("sell", 50_000, 1);
    sell1.trader = "0xSeller1000000000000000000000000000000001" as `0x${string}`;
    const sell2 = makeOrder("sell", 50_000, 1);
    sell2.trader = "0xSeller2000000000000000000000000000000002" as `0x${string}`;

    engine.submitOrder(sell1);
    engine.submitOrder(sell2);

    const result = engine.submitOrder(makeOrder("buy", 50_000, 1));
    expect(result.trades[0].makerTrader).toBe(sell1.trader); // first in, first served
  });

  it("cancels an order", () => {
    const engine = new MatchingEngine(BTC_MARKET);
    const result = engine.submitOrder(makeOrder("buy", 50_000, 1));

    const cancelled = engine.cancelOrder(result.orderId);
    expect(cancelled).toBeDefined();
    expect(cancelled!.status).toBe("cancelled");
    expect(engine.book.activeOrderCount()).toBe(0);
  });

  it("rejects PostOnly that would match", () => {
    const engine = new MatchingEngine(BTC_MARKET);
    engine.submitOrder(makeOrder("sell", 50_000, 1));

    const result = engine.submitOrder(makeOrder("buy", 50_000, 1, "PostOnly"));
    expect(result.status).toBe("rejected");
    expect(result.trades).toHaveLength(0);
  });

  it("accepts PostOnly that rests on book", () => {
    const engine = new MatchingEngine(BTC_MARKET);
    engine.submitOrder(makeOrder("sell", 51_000, 1));

    const result = engine.submitOrder(makeOrder("buy", 50_000, 1, "PostOnly"));
    expect(result.status).toBe("open");
    expect(engine.book.bestBid()).toBe(toPrice(50_000));
  });

  it("IOC fills partially and cancels rest", () => {
    const engine = new MatchingEngine(BTC_MARKET);
    engine.submitOrder(makeOrder("sell", 50_000, 0.3));

    const result = engine.submitOrder(makeOrder("buy", 50_000, 1, "IOC"));
    expect(result.status).toBe("partiallyFilled");
    expect(result.trades).toHaveLength(1);
    expect(engine.book.bestBid()).toBeUndefined(); // not resting
  });

  it("FOK cancels if cannot fill entirely", () => {
    const engine = new MatchingEngine(BTC_MARKET);
    engine.submitOrder(makeOrder("sell", 50_000, 0.5));

    const result = engine.submitOrder(makeOrder("buy", 50_000, 1, "FOK"));
    expect(result.status).toBe("cancelled");
    expect(result.trades).toHaveLength(0);
    // Maker untouched
    expect(engine.book.bestAsk()).toBe(toPrice(50_000));
  });

  it("FOK fills when sufficient liquidity", () => {
    const engine = new MatchingEngine(BTC_MARKET);
    engine.submitOrder(makeOrder("sell", 50_000, 1));

    const result = engine.submitOrder(makeOrder("buy", 50_000, 1, "FOK"));
    expect(result.status).toBe("filled");
    expect(result.trades).toHaveLength(1);
  });

  it("orderbook snapshot has correct structure", () => {
    const engine = new MatchingEngine(BTC_MARKET);
    engine.submitOrder(makeOrder("buy", 49_900, 1));
    engine.submitOrder(makeOrder("buy", 50_000, 2));
    engine.submitOrder(makeOrder("sell", 50_100, 1.5));

    const snapshot = engine.book.snapshot();
    expect(snapshot.bids).toHaveLength(2);
    expect(snapshot.asks).toHaveLength(1);
    expect(snapshot.bids[0].price).toBe(toPrice(50_000)); // best bid first
    expect(snapshot.asks[0].price).toBe(toPrice(50_100));
  });
});
