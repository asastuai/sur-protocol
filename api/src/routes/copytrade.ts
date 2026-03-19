/**
 * SUR Protocol - Copy Trading Routes
 *
 * Registers /api/copytrade/* endpoints on the raw Node HTTP server.
 * Endpoints for discovering top traders, following/unfollowing,
 * managing copy configurations, and viewing copy trade history.
 *
 * All state is held in memory (no persistence).
 */

import type { IncomingMessage, ServerResponse } from "http";

// ── Types ──────────────────────────────────────────────────────────

interface Trader {
  address: string;
  roi30d: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  copiers: number;
  riskScore: "low" | "medium" | "high";
  totalTrades: number;
  avgHoldTime: string;
}

interface FollowEntry {
  trader: string;
  allocation: number;
  maxLeverage: number;
  copyPct: number;
  copyMode: "proportional" | "fixed";
  autoStopLoss: boolean;
  followedAt: string;
  pnl: number;
}

interface CopyHistoryEntry {
  id: string;
  trader: string;
  market: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  exitPrice: number | null;
  pnl: number;
  timestamp: string;
}

// ── In-memory state ────────────────────────────────────────────────

let traders: Trader[] = [];
let seeded = false;

/** Map of user placeholder -> their follow entries */
const following: Map<string, FollowEntry[]> = new Map();

const copyHistory: CopyHistoryEntry[] = [];

// ── Seed data ──────────────────────────────────────────────────────

function seedTraders(): void {
  if (seeded) return;
  seeded = true;

  traders = [
    {
      address: "0x742d35Cc6634C0532925a3b844Bc9e7595f44e2",
      roi30d: 34.5,
      winRate: 67.2,
      totalPnl: 12450.0,
      maxDrawdown: 8.3,
      copiers: 847,
      riskScore: "low",
      totalTrades: 234,
      avgHoldTime: "4.2h",
    },
    {
      address: "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      roi30d: 78.9,
      winRate: 54.1,
      totalPnl: 38920.0,
      maxDrawdown: 22.7,
      copiers: 1203,
      riskScore: "high",
      totalTrades: 512,
      avgHoldTime: "1.8h",
    },
    {
      address: "0x2546BcD3c84621e976D8185a91A922aE77ECEc30",
      roi30d: 12.3,
      winRate: 81.4,
      totalPnl: 5680.0,
      maxDrawdown: 3.1,
      copiers: 2105,
      riskScore: "low",
      totalTrades: 97,
      avgHoldTime: "18.5h",
    },
    {
      address: "0xbDA5747bFD65F08deb54cb465eB87D40e51B197E",
      roi30d: 156.2,
      winRate: 42.8,
      totalPnl: 72310.0,
      maxDrawdown: 41.5,
      copiers: 634,
      riskScore: "high",
      totalTrades: 1847,
      avgHoldTime: "0.4h",
    },
    {
      address: "0xdD2FD4581271e230360230F9337D5c0430Bf44C0",
      roi30d: 21.7,
      winRate: 73.6,
      totalPnl: 9870.0,
      maxDrawdown: 6.2,
      copiers: 1567,
      riskScore: "low",
      totalTrades: 178,
      avgHoldTime: "8.1h",
    },
    {
      address: "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec",
      roi30d: 45.8,
      winRate: 61.3,
      totalPnl: 21540.0,
      maxDrawdown: 14.9,
      copiers: 923,
      riskScore: "medium",
      totalTrades: 345,
      avgHoldTime: "3.6h",
    },
    {
      address: "0x71bE63f3384f5fb98995898A86B02Fb2426c5788",
      roi30d: -5.4,
      winRate: 38.9,
      totalPnl: -2340.0,
      maxDrawdown: 52.3,
      copiers: 89,
      riskScore: "high",
      totalTrades: 2103,
      avgHoldTime: "0.2h",
    },
    {
      address: "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a",
      roi30d: 8.9,
      winRate: 91.2,
      totalPnl: 3120.0,
      maxDrawdown: 1.8,
      copiers: 3412,
      riskScore: "low",
      totalTrades: 45,
      avgHoldTime: "48.0h",
    },
  ];
}

// ── Helpers ─────────────────────────────────────────────────────────

function sortTraders(list: Trader[], sort: string): Trader[] {
  const copy = [...list];
  switch (sort) {
    case "roi":
      return copy.sort((a, b) => b.roi30d - a.roi30d);
    case "copiers":
      return copy.sort((a, b) => b.copiers - a.copiers);
    case "risk": {
      const riskOrder: Record<string, number> = { low: 0, medium: 1, high: 2 };
      return copy.sort(
        (a, b) => (riskOrder[a.riskScore] ?? 1) - (riskOrder[b.riskScore] ?? 1)
      );
    }
    default:
      return copy;
  }
}

function computeStats() {
  if (traders.length === 0) {
    return { totalCopiers: 0, totalVolume: 0, avgRoi: 0 };
  }
  const totalCopiers = traders.reduce((sum, t) => sum + t.copiers, 0);
  const totalVolume = traders.reduce((sum, t) => sum + Math.abs(t.totalPnl), 0);
  const avgRoi =
    Math.round(
      (traders.reduce((sum, t) => sum + t.roi30d, 0) / traders.length) * 100
    ) / 100;

  return { totalCopiers, totalVolume, avgRoi };
}

// Using a simple placeholder user id since there is no auth yet
const DEFAULT_USER = "anonymous";

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

function getQueryParam(url: string, param: string): string | null {
  const idx = url.indexOf("?");
  if (idx === -1) return null;
  const search = new URLSearchParams(url.slice(idx));
  return search.get(param);
}

// ── Route handler ────────────────────────────────────────────

/**
 * Attempts to handle a copytrade route. Returns true if the request was handled.
 */
export function handleCopytradeRoute(
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const fullUrl = req.url ?? "";
  const [url] = fullUrl.split("?");
  const method = req.method ?? "GET";

  // ── GET /api/copytrade/traders ──
  if (url === "/api/copytrade/traders" && method === "GET") {
    if (!seeded) seedTraders();
    const sort = (getQueryParam(fullUrl, "sort") ?? "roi").toLowerCase();
    const sorted = sortTraders(traders, sort);
    json(res, sorted);
    return true;
  }

  // ── POST /api/copytrade/follow ──
  if (url === "/api/copytrade/follow" && method === "POST") {
    readBody(req).then((raw) => {
      const body = parseJson(raw);
      if (!body) {
        json(res, { error: "Invalid JSON body" }, 400);
        return;
      }

      const { trader, allocation, maxLeverage, copyPct, copyMode, autoStopLoss } =
        body as Record<string, unknown>;

      if (!trader || typeof trader !== "string") {
        json(res, { error: "trader address is required" }, 400);
        return;
      }

      const entry: FollowEntry = {
        trader,
        allocation: (allocation as number) ?? 1000,
        maxLeverage: (maxLeverage as number) ?? 10,
        copyPct: (copyPct as number) ?? 100,
        copyMode: (copyMode as "proportional" | "fixed") ?? "proportional",
        autoStopLoss: (autoStopLoss as boolean) ?? true,
        followedAt: new Date().toISOString(),
        pnl: 0,
      };

      const userFollows = following.get(DEFAULT_USER) ?? [];

      // Prevent duplicate follows
      if (userFollows.some((f) => f.trader === trader)) {
        json(res, { error: "Already following this trader" }, 409);
        return;
      }

      userFollows.push(entry);
      following.set(DEFAULT_USER, userFollows);

      json(res, { message: "Now following trader", data: entry }, 201);
    });
    return true;
  }

  // ── DELETE /api/copytrade/follow/:address ──
  const unfollowMatch = url.match(/^\/api\/copytrade\/follow\/(.+)$/);
  if (unfollowMatch && method === "DELETE") {
    const address = decodeURIComponent(unfollowMatch[1]);
    const userFollows = following.get(DEFAULT_USER) ?? [];
    const idx = userFollows.findIndex((f) => f.trader === address);

    if (idx === -1) {
      json(res, { error: "Not following this trader" }, 404);
      return true;
    }

    const [removed] = userFollows.splice(idx, 1);
    following.set(DEFAULT_USER, userFollows);

    json(res, { message: "Unfollowed trader", data: removed });
    return true;
  }

  // ── GET /api/copytrade/my-copies ──
  if (url === "/api/copytrade/my-copies" && method === "GET") {
    const userFollows = following.get(DEFAULT_USER) ?? [];
    json(res, userFollows);
    return true;
  }

  // ── POST /api/copytrade/config/:address ──
  const configMatch = url.match(/^\/api\/copytrade\/config\/(.+)$/);
  if (configMatch && method === "POST") {
    const address = decodeURIComponent(configMatch[1]);

    readBody(req).then((raw) => {
      const body = parseJson(raw);
      if (!body) {
        json(res, { error: "Invalid JSON body" }, 400);
        return;
      }

      const userFollows = following.get(DEFAULT_USER) ?? [];
      const entry = userFollows.find((f) => f.trader === address);

      if (!entry) {
        json(res, { error: "Not following this trader" }, 404);
        return;
      }

      const { allocation, maxLeverage, copyPct, copyMode, autoStopLoss } =
        body as Record<string, unknown>;

      if (allocation !== undefined) entry.allocation = allocation as number;
      if (maxLeverage !== undefined) entry.maxLeverage = maxLeverage as number;
      if (copyPct !== undefined) entry.copyPct = copyPct as number;
      if (copyMode !== undefined) entry.copyMode = copyMode as "proportional" | "fixed";
      if (autoStopLoss !== undefined) entry.autoStopLoss = autoStopLoss as boolean;

      json(res, { message: "Config updated", data: entry });
    });
    return true;
  }

  // ── GET /api/copytrade/history ──
  if (url === "/api/copytrade/history" && method === "GET") {
    json(res, copyHistory);
    return true;
  }

  // ── GET /api/copytrade/stats ──
  if (url === "/api/copytrade/stats" && method === "GET") {
    json(res, computeStats());
    return true;
  }

  return false;
}

/**
 * Register copytrade routes with a raw Node HTTP server.
 * Call this from the main createServer callback.
 */
export function registerCopytradeRoutes(
  _server: ReturnType<typeof import("http").createServer>
): void {
  // No-op: routes are handled via handleCopytradeRoute() in the request callback.
  console.log("[CopyTrade] Routes registered under /api/copytrade/*");
}
