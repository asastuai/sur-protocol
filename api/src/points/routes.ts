/**
 * SUR Protocol - Points API Routes
 *
 * Endpoints:
 *   GET  /api/points/:address     - Trader's points, rank, streak, multiplier
 *   GET  /api/points/leaderboard  - Top 100 by points
 *   GET  /api/points/stats        - Campaign stats (participants, volume, points)
 *   POST /api/points/referral     - Register referral { referrer, referee, code }
 */

import type { IncomingMessage, ServerResponse, Server } from "http";
import {
  getTraderPoints,
  getLeaderboard,
  getCampaignStats,
  registerReferral,
} from "./engine.js";

// ============================================================
//                    HELPERS
// ============================================================

function json(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16_384) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function isAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

// ============================================================
//                    ROUTE HANDLER
// ============================================================

export function handlePointsRoute(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  // GET /api/points/leaderboard?season=1&limit=100
  if (method === "GET" && url.match(/^\/api\/points\/leaderboard(\?.*)?$/)) {
    const params = new URLSearchParams(url.split("?")[1] || "");
    const season = parseInt(params.get("season") || "1", 10);
    const limit = Math.min(parseInt(params.get("limit") || "100", 10), 500);

    getLeaderboard(season, limit)
      .then((data) => json(res, 200, { season, leaderboard: data }))
      .catch((err) => {
        console.error("[Points] Leaderboard error:", err);
        json(res, 500, { error: "Internal server error" });
      });
    return true;
  }

  // GET /api/points/stats?season=1
  if (method === "GET" && url.match(/^\/api\/points\/stats(\?.*)?$/)) {
    const params = new URLSearchParams(url.split("?")[1] || "");
    const season = parseInt(params.get("season") || "1", 10);

    getCampaignStats(season)
      .then((stats) => json(res, 200, { season, ...stats }))
      .catch((err) => {
        console.error("[Points] Stats error:", err);
        json(res, 500, { error: "Internal server error" });
      });
    return true;
  }

  // POST /api/points/referral
  if (method === "POST" && url === "/api/points/referral") {
    readBody(req)
      .then(async (body) => {
        const { referrer, referee, code } = JSON.parse(body);

        if (!referrer || !referee || !code) {
          json(res, 400, { error: "Missing referrer, referee, or code" });
          return;
        }
        if (!isAddress(referrer) || !isAddress(referee)) {
          json(res, 400, { error: "Invalid address format" });
          return;
        }

        const ok = await registerReferral(referrer, referee, code);
        if (ok) {
          json(res, 200, { success: true, message: "Referral registered" });
        } else {
          json(res, 409, { error: "Referral already exists or self-referral" });
        }
      })
      .catch((err) => {
        console.error("[Points] Referral error:", err);
        json(res, 400, { error: "Invalid request body" });
      });
    return true;
  }

  // GET /api/points/:address
  const addressMatch = url.match(/^\/api\/points\/(0x[a-fA-F0-9]{40})(\?.*)?$/);
  if (method === "GET" && addressMatch) {
    const address = addressMatch[1];
    const params = new URLSearchParams(url.split("?")[1] || "");
    const season = parseInt(params.get("season") || "1", 10);

    getTraderPoints(address, season)
      .then((record) => {
        if (!record) {
          json(res, 200, {
            trader: address.toLowerCase(),
            points: 0,
            total_volume: 0,
            trade_count: 0,
            streak_days: 0,
            multiplier: 1.0,
            rank: null,
            season,
          });
        } else {
          json(res, 200, record);
        }
      })
      .catch((err) => {
        console.error("[Points] Get trader error:", err);
        json(res, 500, { error: "Internal server error" });
      });
    return true;
  }

  return false;
}

/**
 * Register points routes (lifecycle hook).
 */
export function registerPointsRoutes(_server: Server): void {
  console.log("[Routes] Points endpoints registered (/api/points/*)");
}
