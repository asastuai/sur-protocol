/**
 * SUR Protocol - WebSocket Server
 *
 * Handles:
 * - Client connections and authentication
 * - Order submission (signed EIP-712 orders)
 * - Order cancellation
 * - Market data streaming (orderbook, trades)
 * - Position updates
 *
 * Channels:
 *   orderbook:{marketId}  - Orderbook snapshots + updates
 *   trades:{marketId}     - Recent trades
 *   orders:{address}      - User's order updates
 */

import { WebSocketServer, WebSocket } from "ws";
import { type Server as HttpServer } from "http";
import { type Config } from "../config/index.js";
import { MatchingEngine, createOrder } from "../engine/matching.js";
import { SettlementPipeline } from "../settlement/pipeline.js";
import { verifyMessage } from "viem";
import type {
  ClientMessage,
  ServerMessage,
  SubmitOrderRequest,
  MarketConfig,
  Order,
  TradeMessage,
  Side,
  OrderType,
  TimeInForce,
} from "../types/index.js";

// ============================================================
//                   RATE LIMITER
// ============================================================

class RateLimiter {
  private windows: Map<string, { count: number; resetAt: number }> = new Map();
  private maxPerWindow: number;
  private windowMs: number;

  constructor(maxPerWindow: number, windowMs: number) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;

    // Cleanup stale entries every minute
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.windows) {
        if (entry.resetAt < now) this.windows.delete(key);
      }
    }, 60_000);
  }

  check(key: string): boolean {
    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || entry.resetAt < now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (entry.count >= this.maxPerWindow) return false;
    entry.count++;
    return true;
  }
}

// ============================================================
//                   CLIENT TRACKING
// ============================================================

interface ConnectedClient {
  ws: WebSocket;
  id: string;
  subscriptions: Set<string>;
  trader?: `0x${string}`;
  authenticated: boolean;
  ip: string;
}

// ============================================================
//                   WS SERVER
// ============================================================

const MAX_CONNECTIONS = parseInt(process.env.MAX_WS_CONNECTIONS || "200");
const MAX_MESSAGES_PER_SEC = parseInt(process.env.MAX_MESSAGES_PER_SEC || "10");

export class SurWebSocketServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ConnectedClient> = new Map();
  private engines: Map<`0x${string}`, MatchingEngine> = new Map();
  private pipeline: SettlementPipeline;
  private config: Config;
  private clientCounter = 0;
  private rateLimiter = new RateLimiter(MAX_MESSAGES_PER_SEC, 1_000); // per second

  constructor(config: Config, pipeline: SettlementPipeline) {
    this.config = config;
    this.pipeline = pipeline;

    // Initialize matching engine per market
    for (const market of config.markets) {
      this.engines.set(market.id, new MatchingEngine(market));
    }

    // Listen for settlement events
    this.pipeline.on("batchConfirmed", (data) => {
      this.broadcast({ type: "error", message: `Batch ${data.batchId} confirmed on-chain` }, "*");
    });
  }

  // ============================================================
  //                    LIFECYCLE
  // ============================================================

  /** Start with a standalone port (local dev) */
  start(): void {
    this.wss = new WebSocketServer({ port: this.config.wsPort });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    console.log(`[WS] Server listening on port ${this.config.wsPort}`);
  }

  /** Attach to an existing HTTP server (Railway / production) */
  attachToServer(httpServer: HttpServer): void {
    this.wss = new WebSocketServer({ server: httpServer });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    console.log(`[WS] Attached to HTTP server`);
  }

  stop(): void {
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.clients.clear();
    this.wss?.close();
  }

  // ============================================================
  //                 CONNECTION HANDLING
  // ============================================================

  private handleConnection(ws: WebSocket, req?: import("http").IncomingMessage): void {
    // Enforce max connections
    if (this.clients.size >= MAX_CONNECTIONS) {
      ws.close(1013, "Server at capacity");
      return;
    }

    const clientId = `client_${++this.clientCounter}`;
    const ip = req?.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
      || req?.socket.remoteAddress || "unknown";

    const client: ConnectedClient = {
      ws,
      id: clientId,
      subscriptions: new Set(),
      authenticated: false,
      ip,
    };

    this.clients.set(clientId, client);
    console.log(`[WS] Client connected: ${clientId} (${ip})`);

    ws.on("message", (data) => {
      // Rate limiting per client
      if (!this.rateLimiter.check(clientId)) {
        this.send(client, { type: "error", message: "Rate limit exceeded. Max " + MAX_MESSAGES_PER_SEC + " messages/second." });
        return;
      }

      // Message size limit (64KB)
      if (data.toString().length > 65_536) {
        this.send(client, { type: "error", message: "Message too large" });
        return;
      }

      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        this.handleMessage(client, msg);
      } catch (err) {
        this.send(client, { type: "error", message: "Invalid message format" });
      }
    });

    ws.on("close", () => {
      this.clients.delete(clientId);
      console.log(`[WS] Client disconnected: ${clientId}`);
    });

    ws.on("error", (err) => {
      console.error(`[WS] Client error ${clientId}:`, err.message);
    });
  }

  // ============================================================
  //                 MESSAGE ROUTING
  // ============================================================

  private handleMessage(client: ConnectedClient, msg: ClientMessage): void {
    switch (msg.type) {
      case "ping":
        this.send(client, { type: "pong" });
        break;

      case "authenticate":
        this.handleAuthenticate(client, msg);
        break;

      case "subscribe":
        for (const channel of msg.channels) {
          client.subscriptions.add(channel);
          // Send initial snapshot for orderbook subscriptions
          if (channel.startsWith("orderbook:")) {
            const marketId = channel.split(":")[1] as `0x${string}`;
            const engine = this.engines.get(marketId);
            if (engine) {
              this.send(client, {
                type: "orderbook",
                snapshot: engine.book.snapshot(),
              });
            }
          }
        }
        break;

      case "unsubscribe":
        for (const channel of msg.channels) {
          client.subscriptions.delete(channel);
        }
        break;

      case "submitOrder":
        // Require authentication for order submission
        if (!client.authenticated) {
          this.send(client, {
            type: "error",
            message: "Authentication required. Send an 'authenticate' message first.",
          });
          return;
        }
        this.handleSubmitOrder(client, msg.order);
        break;

      case "cancelOrder":
        if (!client.authenticated) {
          this.send(client, { type: "error", message: "Authentication required." });
          return;
        }
        this.handleCancelOrder(client, msg.orderId);
        break;

      case "getAccountDetails":
        this.handleGetAccountDetails(client, msg.trader);
        break;
    }
  }

  // ============================================================
  //                  AUTHENTICATION
  // ============================================================

  private async handleAuthenticate(client: ConnectedClient, msg: any): Promise<void> {
    try {
      const { address, timestamp, signature } = msg;

      // Validate fields
      if (!address || !timestamp || !signature) {
        this.send(client, { type: "error", message: "authenticate requires address, timestamp, signature" });
        return;
      }

      // Reject if timestamp is too old (5 minutes)
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - Number(timestamp)) > 300) {
        this.send(client, { type: "error", message: "Authentication timestamp expired (max 5 minutes)" });
        return;
      }

      // Verify signature: "SUR Protocol Auth\nAddress: {address}\nTimestamp: {timestamp}"
      const message = `SUR Protocol Auth\nAddress: ${address}\nTimestamp: ${timestamp}`;
      const valid = await verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });

      if (!valid) {
        this.send(client, { type: "error", message: "Invalid signature" });
        return;
      }

      client.authenticated = true;
      client.trader = address as `0x${string}`;
      this.send(client, { type: "authenticated", address });
      console.log(`[WS] Client ${client.id} authenticated as ${address.slice(0, 10)}...`);
    } catch (err: any) {
      this.send(client, { type: "error", message: `Authentication failed: ${err?.message}` });
    }
  }

  // ============================================================
  //                 ORDER HANDLING
  // ============================================================

  private handleSubmitOrder(client: ConnectedClient, req: SubmitOrderRequest): void {
    // Validate that order trader matches authenticated address
    if (client.trader && req.trader.toLowerCase() !== client.trader.toLowerCase()) {
      this.send(client, {
        type: "orderRejected",
        orderId: "",
        reason: `Trader address mismatch. Authenticated as ${client.trader}, but order is for ${req.trader}`,
      });
      return;
    }

    // Input validation
    if (!req.trader || !/^0x[a-fA-F0-9]{40}$/.test(req.trader)) {
      this.send(client, { type: "orderRejected", orderId: "", reason: "Invalid trader address" });
      return;
    }
    if (!req.marketId || !/^0x[a-fA-F0-9]{64}$/.test(req.marketId)) {
      this.send(client, { type: "orderRejected", orderId: "", reason: "Invalid marketId" });
      return;
    }
    if (!req.side || !["buy", "sell"].includes(req.side)) {
      this.send(client, { type: "orderRejected", orderId: "", reason: "Invalid side (must be buy or sell)" });
      return;
    }
    if (!req.signature || !/^0x[a-fA-F0-9]+$/.test(req.signature)) {
      this.send(client, { type: "orderRejected", orderId: "", reason: "Invalid or missing signature" });
      return;
    }

    try {
      BigInt(req.price);
      BigInt(req.size);
      BigInt(req.nonce);
      BigInt(req.expiry);
    } catch {
      this.send(client, { type: "orderRejected", orderId: "", reason: "Invalid numeric field (price, size, nonce, or expiry)" });
      return;
    }

    if (BigInt(req.size) <= 0n) {
      this.send(client, { type: "orderRejected", orderId: "", reason: "Size must be positive" });
      return;
    }

    // Check expiry isn't in the past
    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(req.expiry) > 0n && BigInt(req.expiry) < nowSecs) {
      this.send(client, { type: "orderRejected", orderId: "", reason: "Order already expired" });
      return;
    }

    const engine = this.engines.get(req.marketId as `0x${string}`);
    if (!engine) {
      this.send(client, {
        type: "orderRejected",
        orderId: "",
        reason: "Unknown market",
      });
      return;
    }

    // Convert request to Order
    const order = createOrder({
      trader: req.trader,
      marketId: req.marketId as `0x${string}`,
      side: req.side,
      orderType: req.orderType,
      price: BigInt(req.price),
      size: BigInt(req.size),
      timeInForce: req.timeInForce,
      nonce: BigInt(req.nonce),
      expiry: BigInt(req.expiry),
      signature: req.signature,
      hidden: req.hidden || false,
    });

    // Cache order for settlement pipeline
    this.pipeline.cacheOrder(order);

    // Submit to matching engine
    const result = engine.submitOrder(order);

    // Send order status to submitter
    if (result.status === "rejected") {
      this.send(client, {
        type: "orderRejected",
        orderId: result.orderId,
        reason: "Order validation failed",
      });
      return;
    }

    this.send(client, {
      type: "orderAccepted",
      orderId: result.orderId,
      status: result.status,
    });

    // Process trades
    for (const trade of result.trades) {
      // Queue for on-chain settlement
      const makerOrder = this.findOrderById(trade.makerOrderId);
      if (makerOrder) {
        this.pipeline.queueTrade(trade, makerOrder, order);
      }

      // Broadcast trade to subscribers
      const tradeMsg: TradeMessage = {
        id: trade.id,
        marketId: trade.marketId,
        price: trade.price.toString(),
        size: trade.size.toString(),
        makerSide: trade.makerSide,
        timestamp: trade.timestamp,
      };

      this.broadcastToChannel(`trades:${trade.marketId}`, {
        type: "trade",
        trade: tradeMsg,
      });
    }

    // Broadcast orderbook update
    if (result.trades.length > 0 || result.status === "open") {
      const snapshot = engine.book.snapshot(20);
      this.broadcastToChannel(`orderbook:${req.marketId}`, {
        type: "orderbookUpdate",
        marketId: req.marketId as `0x${string}`,
        bids: snapshot.bids,
        asks: snapshot.asks,
      });
    }
  }

  private handleCancelOrder(client: ConnectedClient, orderId: string): void {
    // Try cancelling in each engine
    for (const engine of this.engines.values()) {
      const cancelled = engine.cancelOrder(orderId);
      if (cancelled) {
        this.send(client, { type: "orderCancelled", orderId });

        // Broadcast orderbook update
        const snapshot = engine.book.snapshot(20);
        this.broadcastToChannel(`orderbook:${cancelled.marketId}`, {
          type: "orderbookUpdate",
          marketId: cancelled.marketId,
          bids: snapshot.bids,
          asks: snapshot.asks,
        });
        return;
      }
    }

    this.send(client, {
      type: "error",
      message: `Order ${orderId} not found`,
    });
  }

  private async handleGetAccountDetails(client: ConnectedClient, trader: `0x${string}`): Promise<void> {
    try {
      // Read account details from on-chain via the indexer/public client
      // In production, this would use the on-chain indexer cache
      this.send(client, {
        type: "accountDetails",
        details: {
          trader,
          mode: "isolated", // Default; real impl reads from chain
          totalEquity: "0",
          totalInitialRequired: "0",
          totalMaintenanceRequired: "0",
          totalNotional: "0",
          freeBalance: "0",
          positionCount: 0,
          totalUnrealizedPnl: "0",
          isLiquidatable: false,
        },
      });
    } catch (err: any) {
      this.send(client, { type: "error", message: `Account details error: ${err?.message}` });
    }
  }

  // ============================================================
  //                ORDER LOOKUP
  // ============================================================

  private findOrderById(orderId: string): Order | undefined {
    // Search active orders across all engines
    // In production, this would be a proper index
    for (const engine of this.engines.values()) {
      // The engine doesn't expose a direct lookup, but the pipeline caches orders
      // This is a simplified version
    }
    return undefined; // Settlement pipeline uses its own cache
  }

  // ============================================================
  //               BROADCASTING
  // ============================================================

  private send(client: ConnectedClient, msg: ServerMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg, bigIntReplacer));
    }
  }

  private broadcastToChannel(channel: string, msg: ServerMessage): void {
    const data = JSON.stringify(msg, bigIntReplacer);
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(channel) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  private broadcast(msg: ServerMessage, _scope: string): void {
    const data = JSON.stringify(msg, bigIntReplacer);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  // ============================================================
  //                    STATS
  // ============================================================

  getStats(): {
    connectedClients: number;
    markets: Array<{ id: string; orders: number; trades: number }>;
  } {
    return {
      connectedClients: this.clients.size,
      markets: [...this.engines.entries()].map(([id, engine]) => ({
        id,
        orders: engine.book.activeOrderCount(),
        trades: engine.book.tradeCount,
      })),
    };
  }
}

// ============================================================
//               BIGINT JSON SERIALIZATION
// ============================================================

function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}
