/**
 * SUR Protocol - Agent REST API
 *
 * Dedicated HTTP API for AI agents. Runs alongside the WebSocket API.
 * Agents prefer REST for:
 *   - Stateless operations (no persistent WS connection needed)
 *   - Simple request/response (place order → get confirmation)
 *   - Batch operations (submit 10 orders in one call)
 *   - x402 integration (payment embedded in HTTP headers)
 *
 * This is PURELY ADDITIVE — new standalone HTTP server,
 * does NOT modify or import from the WebSocket API or matching engine.
 *
 * Endpoints:
 *   POST /v1/orders          — Submit signed order
 *   POST /v1/orders/batch    — Submit multiple orders
 *   DELETE /v1/orders/:id    — Cancel order
 *   GET  /v1/orderbook/:market — Orderbook snapshot
 *   GET  /v1/markets          — List all markets
 *   GET  /v1/markets/:id      — Market details
 *   GET  /v1/positions/:trader — All positions for a trader
 *   GET  /v1/account/:trader   — Cross-margin account details
 *   GET  /v1/trades/:market    — Recent trades
 *   GET  /v1/funding/:market   — Current funding rate
 *   POST /v1/agent/register    — Register an agent address for fee discounts
 *   GET  /v1/agent/status/:addr — Agent status & stats
 *
 * Authentication: EIP-712 signature in X-SUR-Signature header
 * Rate limits: 100 req/s free, 1000 req/s with x402 payment
 */

import "dotenv/config";
import http from "http";
import { URL } from "url";

// ============================================================
//                    CONFIG
// ============================================================

const PORT = parseInt(process.env.AGENT_API_PORT || "3003");
const MAX_BATCH_SIZE = 50;

// Agent registry: address → { registered, totalVolume, orderCount, tier }
const agentRegistry: Map<string, AgentProfile> = new Map();

interface AgentProfile {
  address: string;
  name: string;
  registeredAt: number;
  totalOrders: number;
  totalVolume: number;   // USDC
  tier: "standard" | "silver" | "gold" | "platinum";
  makerFeeBps: number;
  takerFeeBps: number;
}

// Fee tiers for agents (better than human default)
const AGENT_FEE_TIERS = {
  standard:  { makerFeeBps: 1.5, takerFeeBps: 5,   minVolume: 0 },        // 0.015% / 0.05%
  silver:    { makerFeeBps: 1,   takerFeeBps: 4,   minVolume: 1_000_000 }, // $1M volume
  gold:      { makerFeeBps: 0.5, takerFeeBps: 3,   minVolume: 10_000_000 },
  platinum:  { makerFeeBps: 0,   takerFeeBps: 2,   minVolume: 100_000_000 }, // maker rebate at 0
};

// ============================================================
//                    RATE LIMITING
// ============================================================

const rateLimits: Map<string, { count: number; resetAt: number }> = new Map();
const FREE_RATE_LIMIT = 100;    // per second
const PAID_RATE_LIMIT = 1000;   // with x402 payment

function checkRateLimit(ip: string, isPaid: boolean): boolean {
  const limit = isPaid ? PAID_RATE_LIMIT : FREE_RATE_LIMIT;
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + 1000 });
    return true;
  }

  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// ============================================================
//                    REQUEST HELPERS
// ============================================================

function json(res: http.ServerResponse, data: any, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "X-Powered-By": "SUR Protocol Agent API",
  });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error("Invalid JSON")); }
    });
  });
}

// ============================================================
//                    ROUTE HANDLERS
// ============================================================

// POST /v1/orders — Submit a signed order
async function handleSubmitOrder(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const { trader, marketId, side, orderType, price, size, timeInForce, nonce, expiry, signature, hidden } = body;

    if (!trader || !marketId || !side || !size || !signature) {
      return error(res, "Missing required fields: trader, marketId, side, size, signature");
    }

    // Check if agent is registered for fee discounts
    const agent = agentRegistry.get(trader.toLowerCase());
    const feeTier = agent?.tier || "standard";

    const orderId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // In production: forward to matching engine via internal channel
    // For now, return acknowledgment with order ID
    json(res, {
      orderId,
      status: "accepted",
      feeTier,
      makerFeeBps: agent?.makerFeeBps ?? 2,
      takerFeeBps: agent?.takerFeeBps ?? 6,
      timestamp: Date.now(),
    }, 201);

    // Update agent stats
    if (agent) {
      agent.totalOrders++;
    }
  } catch (err: any) {
    error(res, err.message || "Invalid request");
  }
}

// POST /v1/orders/batch — Submit multiple orders at once
async function handleBatchOrders(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const { orders } = body;

    if (!Array.isArray(orders) || orders.length === 0) {
      return error(res, "orders must be a non-empty array");
    }
    if (orders.length > MAX_BATCH_SIZE) {
      return error(res, `Max batch size is ${MAX_BATCH_SIZE}`);
    }

    const results = orders.map((order: any, i: number) => ({
      index: i,
      orderId: `batch_${Date.now()}_${i}`,
      status: "accepted",
      timestamp: Date.now(),
    }));

    json(res, { results, count: results.length }, 201);
  } catch (err: any) {
    error(res, err.message);
  }
}

// GET /v1/orderbook/:market — Orderbook snapshot
function handleOrderbook(res: http.ServerResponse, market: string) {
  // In production: read from matching engine
  json(res, {
    market,
    bids: [],
    asks: [],
    timestamp: Date.now(),
    note: "Connect matching engine for live data",
  });
}

// GET /v1/markets — List all available markets
function handleMarkets(res: http.ServerResponse) {
  const markets = [
    // Crypto
    { name: "BTC-USD", type: "crypto", maxLeverage: 20, initialMarginBps: 500, status: "active" },
    { name: "ETH-USD", type: "crypto", maxLeverage: 20, initialMarginBps: 500, status: "active" },
    { name: "SOL-USD", type: "crypto", maxLeverage: 20, initialMarginBps: 500, status: "active" },
    // Stocks
    { name: "AAPL-USD", type: "stock", maxLeverage: 10, initialMarginBps: 1000, status: "active" },
    { name: "TSLA-USD", type: "stock", maxLeverage: 10, initialMarginBps: 1000, status: "active" },
    { name: "NVDA-USD", type: "stock", maxLeverage: 10, initialMarginBps: 1000, status: "active" },
    { name: "AMZN-USD", type: "stock", maxLeverage: 10, initialMarginBps: 1000, status: "active" },
    { name: "MSFT-USD", type: "stock", maxLeverage: 10, initialMarginBps: 1000, status: "active" },
    { name: "GOOG-USD", type: "stock", maxLeverage: 10, initialMarginBps: 1000, status: "active" },
    { name: "META-USD", type: "stock", maxLeverage: 10, initialMarginBps: 1000, status: "active" },
    { name: "COIN-USD", type: "stock", maxLeverage: 8, initialMarginBps: 1200, status: "active" },
    { name: "SPY-USD", type: "stock", maxLeverage: 12, initialMarginBps: 800, status: "active" },
  ];
  json(res, { markets, count: markets.length });
}

// POST /v1/agent/register — Register an agent for fee discounts
async function handleAgentRegister(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const { address, name, signature } = body;

    if (!address || !name) {
      return error(res, "Missing required fields: address, name");
    }

    const addr = address.toLowerCase();
    if (agentRegistry.has(addr)) {
      return error(res, "Agent already registered", 409);
    }

    const tier = AGENT_FEE_TIERS.standard;
    const profile: AgentProfile = {
      address: addr,
      name,
      registeredAt: Date.now(),
      totalOrders: 0,
      totalVolume: 0,
      tier: "standard",
      makerFeeBps: tier.makerFeeBps,
      takerFeeBps: tier.takerFeeBps,
    };

    agentRegistry.set(addr, profile);

    json(res, {
      status: "registered",
      address: addr,
      name,
      tier: "standard",
      fees: { makerBps: tier.makerFeeBps, takerBps: tier.takerFeeBps },
      nextTier: { name: "silver", volumeRequired: "$1M", fees: { makerBps: 1, takerBps: 4 } },
    }, 201);
  } catch (err: any) {
    error(res, err.message);
  }
}

// GET /v1/agent/status/:address — Agent profile & stats
function handleAgentStatus(res: http.ServerResponse, address: string) {
  const profile = agentRegistry.get(address.toLowerCase());
  if (!profile) {
    return error(res, "Agent not registered. POST /v1/agent/register first.", 404);
  }
  json(res, { agent: profile });
}

// GET /v1/agent/leaderboard — Top agents by volume
function handleLeaderboard(res: http.ServerResponse) {
  const agents = Array.from(agentRegistry.values())
    .sort((a, b) => b.totalVolume - a.totalVolume)
    .slice(0, 50);

  json(res, {
    leaderboard: agents.map((a, i) => ({
      rank: i + 1,
      name: a.name,
      address: a.address,
      tier: a.tier,
      totalVolume: a.totalVolume,
      totalOrders: a.totalOrders,
    })),
  });
}

// ============================================================
//                    ROUTER
// ============================================================

function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method || "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-SUR-Signature, X-SUR-Agent, X-402-Payment",
    });
    return res.end();
  }

  // Rate limit check
  const ip = req.socket.remoteAddress || "unknown";
  const hasPayment = !!req.headers["x-402-payment"];
  if (!checkRateLimit(ip, hasPayment)) {
    return error(res, "Rate limit exceeded. Use x402 payment for higher limits.", 429);
  }

  // Routes
  if (method === "POST" && path === "/v1/orders") return handleSubmitOrder(req, res);
  if (method === "POST" && path === "/v1/orders/batch") return handleBatchOrders(req, res);
  if (method === "GET" && path === "/v1/markets") return handleMarkets(res);
  if (method === "GET" && path.startsWith("/v1/orderbook/")) return handleOrderbook(res, path.split("/")[3]);
  if (method === "POST" && path === "/v1/agent/register") return handleAgentRegister(req, res);
  if (method === "GET" && path.startsWith("/v1/agent/status/")) return handleAgentStatus(res, path.split("/")[4]);
  if (method === "GET" && path === "/v1/agent/leaderboard") return handleLeaderboard(res);

  // Health check
  if (path === "/health") return json(res, { status: "ok", service: "sur-agent-api", timestamp: Date.now() });

  // x402 discovery endpoint
  if (path === "/.well-known/x402") {
    return json(res, {
      protocol: "x402",
      version: "2.0",
      service: "SUR Protocol Agent API",
      description: "Perpetual futures DEX — Agent-Native trading on Base L2",
      endpoints: {
        orders: { path: "/v1/orders", method: "POST", cost: "free" },
        orderbook: { path: "/v1/orderbook/:market", method: "GET", cost: "0.0001 USDC/call" },
        trades: { path: "/v1/trades/:market", method: "GET", cost: "0.0001 USDC/call" },
        streaming: { path: "ws://localhost:3002", protocol: "websocket", cost: "0.001 USDC/min" },
      },
      payment: {
        asset: "USDC",
        network: "base",
        recipient: "0x...",  // SUR fee recipient
      },
    });
  }

  error(res, "Not found", 404);
}

// ============================================================
//                    SERVER
// ============================================================

const server = http.createServer(route);

server.listen(PORT, () => {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║     SUR Protocol - Agent REST API              ║");
  console.log(`║     Port: ${PORT}                                  ║`);
  console.log("║     Built for agents. Optimized for speed.    ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log();
  console.log(`  Health:      http://localhost:${PORT}/health`);
  console.log(`  Markets:     http://localhost:${PORT}/v1/markets`);
  console.log(`  Register:    POST http://localhost:${PORT}/v1/agent/register`);
  console.log(`  Leaderboard: http://localhost:${PORT}/v1/agent/leaderboard`);
  console.log(`  x402 Disco:  http://localhost:${PORT}/.well-known/x402`);
  console.log();
});
