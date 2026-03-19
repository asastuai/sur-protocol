/**
 * SUR Protocol - Trading Bot Control Routes
 *
 * Registers /api/bot/* endpoints on the raw Node HTTP server.
 * All state is held in memory; the bot simulates trades when running.
 */

import type { IncomingMessage, ServerResponse } from "http";

// ── Types ────────────────────────────────────────────────────

interface BotConfig {
  maxPositions: number;
  maxTradesPerDay: number;
  maxDrawdown: number;
  kellyFraction: number;
  sizingMode: string;
}

interface Engine {
  name: string;
  enabled: boolean;
  trades: number;
  wins: number;
  netPnl: number;
  confidence: number;
}

interface Trade {
  id: string;
  engine: string;
  market: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  exitPrice: number | null;
  pnl: number;
  status: "open" | "closed";
  openedAt: number;
  closedAt: number | null;
}

interface Position {
  id: string;
  engine: string;
  market: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  openedAt: number;
}

// ── In-memory state ──────────────────────────────────────────

const state = {
  running: false,
  startedAt: 0,
  market: "BTC-USD",
  totalPnl: 0,
  config: {
    maxPositions: 3,
    maxTradesPerDay: 10,
    maxDrawdown: 15,
    kellyFraction: 0.25,
    sizingMode: "adaptive",
  } as BotConfig,
  engines: [
    { name: "Swing Rider", enabled: true, trades: 0, wins: 0, netPnl: 0, confidence: 75 },
    { name: "Mean Revert", enabled: true, trades: 0, wins: 0, netPnl: 0, confidence: 68 },
    { name: "Momentum Burst", enabled: true, trades: 0, wins: 0, netPnl: 0, confidence: 72 },
    { name: "Funding Arb", enabled: false, trades: 0, wins: 0, netPnl: 0, confidence: 80 },
    { name: "Breakout Sniper", enabled: true, trades: 0, wins: 0, netPnl: 0, confidence: 65 },
    { name: "Scalp Grid", enabled: false, trades: 0, wins: 0, netPnl: 0, confidence: 60 },
    { name: "Trend Follower", enabled: true, trades: 0, wins: 0, netPnl: 0, confidence: 70 },
  ] as Engine[],
  trades: [] as Trade[],
  positions: [] as Position[],
};

let simulationInterval: ReturnType<typeof setInterval> | null = null;

// ── Price helpers ────────────────────────────────────────────

const BASE_PRICES: Record<string, number> = {
  "BTC-USD": 84500,
  "ETH-USD": 3250,
};

function currentPrice(market: string): number {
  const base = BASE_PRICES[market] ?? 84500;
  const drift = (Math.random() - 0.5) * base * 0.004; // +-0.2%
  return Math.round((base + drift) * 100) / 100;
}

// ── Simulation ───────────────────────────────────────────────

function startSimulation() {
  if (simulationInterval) return;

  const tick = () => {
    if (!state.running) return;

    const enabledEngines = state.engines.filter((e) => e.enabled);
    if (enabledEngines.length === 0) return;

    // Randomly close an open position ~30% of the time
    if (state.positions.length > 0 && Math.random() < 0.3) {
      const idx = Math.floor(Math.random() * state.positions.length);
      const pos = state.positions[idx];
      const exit = currentPrice(pos.market);
      const pnl =
        pos.side === "long"
          ? (exit - pos.entryPrice) * pos.size
          : (pos.entryPrice - exit) * pos.size;
      const roundedPnl = Math.round(pnl * 100) / 100;

      // Record closed trade
      state.trades.push({
        id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        engine: pos.engine,
        market: pos.market,
        side: pos.side,
        size: pos.size,
        entryPrice: pos.entryPrice,
        exitPrice: exit,
        pnl: roundedPnl,
        status: "closed",
        openedAt: pos.openedAt,
        closedAt: Date.now(),
      });

      // Update engine stats
      const eng = state.engines.find((e) => e.name === pos.engine);
      if (eng) {
        eng.trades++;
        eng.netPnl = Math.round((eng.netPnl + roundedPnl) * 100) / 100;
        if (roundedPnl > 0) eng.wins++;
      }

      state.totalPnl = Math.round((state.totalPnl + roundedPnl) * 100) / 100;
      state.positions.splice(idx, 1);
      return;
    }

    // Open a new position if under limit
    if (state.positions.length < state.config.maxPositions) {
      const engine = enabledEngines[Math.floor(Math.random() * enabledEngines.length)];
      const market = state.market;
      const price = currentPrice(market);
      const side: "long" | "short" = Math.random() > 0.5 ? "long" : "short";
      const size = Math.round((0.001 + Math.random() * 0.05) * 10000) / 10000;

      const pos: Position = {
        id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        engine: engine.name,
        market,
        side,
        size,
        entryPrice: price,
        unrealizedPnl: 0,
        openedAt: Date.now(),
      };

      state.positions.push(pos);

      // Also log as an open trade
      state.trades.push({
        id: pos.id.replace("p-", "t-"),
        engine: engine.name,
        market,
        side,
        size,
        entryPrice: price,
        exitPrice: null,
        pnl: 0,
        status: "open",
        openedAt: Date.now(),
        closedAt: null,
      });
    }
  };

  // Run every 30-60 seconds
  const schedule = () => {
    const delay = 30_000 + Math.random() * 30_000;
    simulationInterval = setTimeout(() => {
      tick();
      if (state.running) schedule();
    }, delay) as unknown as ReturnType<typeof setInterval>;
  };

  schedule();
}

function stopSimulation() {
  if (simulationInterval) {
    clearTimeout(simulationInterval as unknown as number);
    simulationInterval = null;
  }
}

// ── HTTP helpers ─────────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
  });
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Route handler ────────────────────────────────────────────

/**
 * Attempts to handle a bot route. Returns true if the request was handled.
 */
export function handleBotRoute(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  // ── GET /api/bot/status ──
  if (url === "/api/bot/status" && method === "GET") {
    const uptime = state.running ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
    json(res, {
      running: state.running,
      uptime,
      totalPnl: state.totalPnl,
      activePositions: state.positions.length,
      enabledEngines: state.engines.filter((e) => e.enabled).map((e) => e.name),
      market: state.market,
      config: { ...state.config },
    });
    return true;
  }

  // ── POST /api/bot/start ──
  if (url === "/api/bot/start" && method === "POST") {
    readBody(req).then((raw) => {
      const body = parseJson(raw);
      if (body?.market && typeof body.market === "string") {
        state.market = body.market;
      }
      state.running = true;
      state.startedAt = Date.now();
      startSimulation();
      console.log(`[Bot] Started on market ${state.market}`);
      json(res, { ok: true, market: state.market });
    });
    return true;
  }

  // ── POST /api/bot/stop ──
  if (url === "/api/bot/stop" && method === "POST") {
    state.running = false;
    stopSimulation();
    console.log("[Bot] Stopped");
    json(res, { ok: true });
    return true;
  }

  // ── POST /api/bot/config ──
  if (url === "/api/bot/config" && method === "POST") {
    readBody(req).then((raw) => {
      const body = parseJson(raw);
      if (body) {
        const allowed: (keyof BotConfig)[] = [
          "maxPositions",
          "maxTradesPerDay",
          "maxDrawdown",
          "kellyFraction",
          "sizingMode",
        ];
        for (const key of allowed) {
          if (key in body) {
            (state.config as unknown as Record<string, unknown>)[key] = body[key];
          }
        }
      }
      json(res, { ok: true, config: { ...state.config } });
    });
    return true;
  }

  // ── GET /api/bot/engines ──
  if (url === "/api/bot/engines" && method === "GET") {
    json(res, state.engines.map((e) => ({ ...e })));
    return true;
  }

  // ── POST /api/bot/engines/:name/toggle ──
  const toggleMatch = url.match(/^\/api\/bot\/engines\/(.+)\/toggle$/);
  if (toggleMatch && method === "POST") {
    const name = decodeURIComponent(toggleMatch[1]);
    const engine = state.engines.find(
      (e) => e.name.toLowerCase() === name.toLowerCase()
    );
    if (!engine) {
      json(res, { error: `Engine "${name}" not found` }, 404);
      return true;
    }
    engine.enabled = !engine.enabled;
    console.log(`[Bot] Engine "${engine.name}" ${engine.enabled ? "enabled" : "disabled"}`);
    json(res, { ok: true, engine: { ...engine } });
    return true;
  }

  // ── GET /api/bot/trades ──
  if (url === "/api/bot/trades" && method === "GET") {
    // Return most recent 50 trades, newest first
    json(res, state.trades.slice(-50).reverse());
    return true;
  }

  // ── GET /api/bot/positions ──
  if (url === "/api/bot/positions" && method === "GET") {
    // Update unrealized PnL before returning
    for (const pos of state.positions) {
      const price = currentPrice(pos.market);
      const pnl =
        pos.side === "long"
          ? (price - pos.entryPrice) * pos.size
          : (pos.entryPrice - price) * pos.size;
      pos.unrealizedPnl = Math.round(pnl * 100) / 100;
    }
    json(res, state.positions.map((p) => ({ ...p })));
    return true;
  }

  return false;
}

/**
 * Register bot routes with a raw Node HTTP server's request handler.
 * Call this from the main createServer callback.
 */
export function registerBotRoutes(
  _server: ReturnType<typeof import("http").createServer>
): void {
  // No-op: routes are handled via handleBotRoute() in the request callback.
  // This function exists for symmetry with the import pattern requested.
  console.log("[Bot] Trading bot control routes registered");
}
