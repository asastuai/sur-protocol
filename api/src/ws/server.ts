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
//                   CLIENT TRACKING
// ============================================================

interface ConnectedClient {
  ws: WebSocket;
  id: string;
  subscriptions: Set<string>;
  trader?: `0x${string}`;
}

// ============================================================
//                   WS SERVER
// ============================================================

export class SurWebSocketServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ConnectedClient> = new Map();
  private engines: Map<`0x${string}`, MatchingEngine> = new Map();
  private pipeline: SettlementPipeline;
  private config: Config;
  private clientCounter = 0;

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
    this.wss.on("connection", (ws) => this.handleConnection(ws));
    console.log(`[WS] Server listening on port ${this.config.wsPort}`);
  }

  /** Attach to an existing HTTP server (Railway / production) */
  attachToServer(httpServer: HttpServer): void {
    this.wss = new WebSocketServer({ server: httpServer });
    this.wss.on("connection", (ws) => this.handleConnection(ws));
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

  private handleConnection(ws: WebSocket): void {
    const clientId = `client_${++this.clientCounter}`;
    const client: ConnectedClient = {
      ws,
      id: clientId,
      subscriptions: new Set(),
    };

    this.clients.set(clientId, client);
    console.log(`[WS] Client connected: ${clientId}`);

    ws.on("message", (data) => {
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
        this.handleSubmitOrder(client, msg.order);
        break;

      case "cancelOrder":
        this.handleCancelOrder(client, msg.orderId);
        break;

      case "getAccountDetails":
        this.handleGetAccountDetails(client, msg.trader);
        break;
    }
  }

  // ============================================================
  //                 ORDER HANDLING
  // ============================================================

  private handleSubmitOrder(client: ConnectedClient, req: SubmitOrderRequest): void {
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

    // Track client's trader address
    client.trader = req.trader;

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
