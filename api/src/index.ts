/**
 * SUR Protocol - API Server Entry Point
 *
 * Starts:
 * 1. HTTP server with health-check endpoint (for Railway)
 * 2. WebSocket server (receives trader orders)
 * 3. Settlement pipeline (submits matched trades on-chain)
 * 4. On-chain indexer (reads positions/balances)
 *
 * Architecture:
 *
 *   Trader Wallet
 *       ↕ EIP-712 signed orders
 *   WebSocket Server (port from PORT env or 3002)
 *       ↕ orders
 *   Matching Engine (in-memory, per market)
 *       ↕ matched trades
 *   Settlement Pipeline
 *       ↕ batches
 *   Base L2 → OrderSettlement.sol → PerpEngine.sol → PerpVault.sol
 */

import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { loadConfig } from "./config/index.js";
import { SettlementPipeline } from "./settlement/pipeline.js";
import { SurWebSocketServer } from "./ws/server.js";
import { OnChainIndexer } from "./indexer/onchain.js";
import { registerBotRoutes, handleBotRoute } from "./routes/bot.js";
import { registerCopytradeRoutes, handleCopytradeRoute } from "./routes/copytrade.js";
import { registerBacktesterRoutes, handleBacktesterRoute } from "./routes/backtester.js";
import { registerPricesRoutes, handlePricesRoute } from "./routes/prices.js";
import { registerPointsRoutes, handlePointsRoute } from "./points/routes.js";
import { initSupabase } from "./db/supabase.js";

const startedAt = Date.now();

async function main() {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║       SUR Protocol - Backend API           ║");
  console.log("║    First Argentine Perp DEX on Base L2     ║");
  console.log("╚════════════════════════════════════════════╝");
  console.log();

  // Load configuration
  const config = loadConfig();
  console.log(`[Config] Network: ${config.chain.name}`);
  console.log(`[Config] RPC: ${config.rpcUrl}${config.rpcUrls.length > 1 ? ` (+${config.rpcUrls.length - 1} fallback)` : ""}`);
  console.log(`[Config] Markets: ${config.markets.map((m) => m.name).join(", ")}`);
  console.log(`[Config] Batch interval: ${config.batchIntervalMs}ms`);
  console.log(`[Config] Max WS connections: ${process.env.MAX_WS_CONNECTIONS || 200}`);
  console.log();

  // Initialize Supabase (optional — runs without it)
  initSupabase();

  // Initialize components
  const pipeline = new SettlementPipeline(config);
  const wsServer = new SurWebSocketServer(config, pipeline);
  const indexer = new OnChainIndexer(config);

  // Settlement pipeline events
  pipeline.on("started", () => console.log("[Settlement] Pipeline started"));
  pipeline.on("batchCreated", (b) =>
    console.log(`[Settlement] Batch #${b.id} created with ${b.trades.length} trades`)
  );
  pipeline.on("batchSubmitted", (data) =>
    console.log(`[Settlement] Batch #${data.batchId} submitted: ${data.txHash}`)
  );
  pipeline.on("batchConfirmed", (data) =>
    console.log(`[Settlement] Batch #${data.batchId} confirmed in block ${data.blockNumber}`)
  );
  pipeline.on("batchFailed", (data) =>
    console.error(`[Settlement] Batch #${data.batchId} FAILED: ${data.reason}`)
  );
  pipeline.on("error", (err) => console.error(`[Settlement] Error: ${err}`));

  // Start settlement pipeline
  pipeline.start();

  // ---- HTTP Server (health check for Railway) ----
  const port = parseInt(process.env.PORT || String(config.wsPort));

  // CORS: whitelist allowed origins (default: localhost for dev)
  const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:3000,http://localhost:3001")
    .split(",")
    .map((o) => o.trim());

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS headers — only allow whitelisted origins
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Bot control routes
    if (req.url?.startsWith("/api/bot/")) {
      if (handleBotRoute(req, res)) return;
    }

    // Copy trading routes
    if (req.url?.startsWith("/api/copytrade/")) {
      if (handleCopytradeRoute(req, res)) return;
    }

    // Price data routes (async — fetches from Binance)
    if (req.url?.startsWith("/api/prices/")) {
      if (handlePricesRoute(req, res)) return;
    }

    // Points & rewards routes
    if (req.url?.startsWith("/api/points/")) {
      if (handlePointsRoute(req, res)) return;
    }

    // Backtester routes (async — reads POST body)
    if (req.url?.startsWith("/api/backtester/")) {
      handleBacktesterRoute(req, res).catch((err) => {
        console.error("[Backtester] Route error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    if (req.url === "/health" || req.url === "/") {
      const wsStats = wsServer.getStats();
      const pipelineStats = pipeline.getStats();

      const body = JSON.stringify({
        status: "ok",
        service: "sur-api",
        version: "0.1.0",
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        network: config.chain.name,
        connections: wsStats.connectedClients,
        markets: wsStats.markets.length,
        settlement: {
          pending: pipelineStats.pendingTrades,
          batches: pipelineStats.totalBatches,
          confirmed: pipelineStats.confirmed,
          failed: pipelineStats.failed,
        },
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    // Prometheus-compatible metrics endpoint
    if (req.url === "/metrics") {
      const wsStats = wsServer.getStats();
      const pipelineStats = pipeline.getStats();
      const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);

      const lines = [
        "# HELP sur_api_uptime_seconds API uptime in seconds",
        "# TYPE sur_api_uptime_seconds gauge",
        `sur_api_uptime_seconds ${uptimeSec}`,
        "",
        "# HELP sur_api_ws_connections Current WebSocket connections",
        "# TYPE sur_api_ws_connections gauge",
        `sur_api_ws_connections ${wsStats.connectedClients}`,
        "",
        "# HELP sur_api_settlement_pending Pending trades awaiting settlement",
        "# TYPE sur_api_settlement_pending gauge",
        `sur_api_settlement_pending ${pipelineStats.pendingTrades}`,
        "",
        "# HELP sur_api_settlement_batches_total Total settlement batches submitted",
        "# TYPE sur_api_settlement_batches_total counter",
        `sur_api_settlement_batches_total ${pipelineStats.totalBatches}`,
        "",
        "# HELP sur_api_settlement_confirmed_total Confirmed settlement batches",
        "# TYPE sur_api_settlement_confirmed_total counter",
        `sur_api_settlement_confirmed_total ${pipelineStats.confirmed}`,
        "",
        "# HELP sur_api_settlement_failed_total Failed settlement batches",
        "# TYPE sur_api_settlement_failed_total counter",
        `sur_api_settlement_failed_total ${pipelineStats.failed}`,
        "",
        ...wsStats.markets.map((m) => [
          `sur_api_market_orders{market="${m.id.slice(0, 10)}"} ${m.orders}`,
          `sur_api_market_trades{market="${m.id.slice(0, 10)}"} ${m.trades}`,
        ]).flat(),
        "",
      ];

      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(lines.join("\n"));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // Register bot control routes
  registerBotRoutes(httpServer);

  // Register copy trading routes
  registerCopytradeRoutes(httpServer);

  // Register backtester routes
  registerBacktesterRoutes(httpServer);

  // Register prices routes
  registerPricesRoutes(httpServer);

  // Register points routes
  registerPointsRoutes(httpServer);

  // Attach WebSocket to the HTTP server (shared port for Railway)
  wsServer.attachToServer(httpServer);

  httpServer.listen(port, () => {
    console.log();
    console.log("═══════════════════════════════════════════");
    console.log(`  HTTP + WebSocket: port ${port}`);
    console.log(`  Health: http://localhost:${port}/health`);
    console.log("  Status: RUNNING");
    console.log("═══════════════════════════════════════════");
    console.log();
  });

  // Health check on startup
  try {
    const blockNumber = await indexer.getBlockNumber();
    console.log(`[Indexer] Connected to chain. Block: ${blockNumber}`);
  } catch (err) {
    console.warn(`[Indexer] Chain connection failed (expected if no contracts deployed yet)`);
  }

  // Print periodic stats
  setInterval(() => {
    const wsStats = wsServer.getStats();
    const pipelineStats = pipeline.getStats();
    console.log(
      `[Stats] Clients: ${wsStats.connectedClients} | ` +
        `Pending: ${pipelineStats.pendingTrades} | ` +
        `Batches: ${pipelineStats.totalBatches} (${pipelineStats.confirmed} confirmed, ${pipelineStats.failed} failed) | ` +
        `Markets: ${wsStats.markets.map((m) => `${m.id.slice(0, 8)}:${m.orders}orders/${m.trades}trades`).join(", ")}`
    );
  }, 30_000);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[Shutdown] Stopping...");
    pipeline.stop();
    wsServer.stop();
    httpServer.close();
    console.log("[Shutdown] Done.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
