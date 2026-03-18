/**
 * SUR Protocol — Risk Guardian
 *
 * Per-user anti-liquidation agent. Monitors each subscribed user's positions
 * and takes defensive actions BEFORE the protocol's liquidation engine acts.
 *
 * Why this matters:
 *   When you get liquidated on a perp DEX, you lose ALL your margin.
 *   The Risk Guardian intervenes earlier — closing partially or adding margin —
 *   so you preserve capital that would otherwise be lost entirely.
 *
 * Defense layers (in escalation order):
 *   1. MONITOR  — track distance to liquidation in real-time
 *   2. ALERT    — notify when distance drops below threshold
 *   3. DEFEND   — add margin from free balance automatically
 *   4. REDUCE   — close portion of position to lower exposure
 *   5. HEDGE    — open opposing position on correlated asset
 *   6. EMERGENCY — full close before liquidation engine acts
 *
 * Business model:
 *   - Free while inactive. Fee charged ONLY when guardian intervenes.
 *   - Fee: configurable bps on notional protected (default: 5 bps = 0.05%)
 *   - Aligned incentives: user pays only for value received.
 *
 * This is STANDALONE — reads positions via Agent API, executes via Agent API.
 * Port: 3005
 */

import "dotenv/config";
import http from "http";

const PORT = parseInt(process.env.RISK_GUARDIAN_PORT || "3005");
const AGENT_API = process.env.AGENT_API_URL || "http://localhost:3003";
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_MS || "3000");

// ============================================================
//                    TYPES
// ============================================================

type DefenseLevel = "safe" | "caution" | "warning" | "danger" | "critical";
type ActionType = "alert" | "add_margin" | "reduce_position" | "hedge" | "emergency_close";

interface GuardianConfig {
  trader: string;
  enabled: boolean;

  // Thresholds (distance to liquidation as percentage of margin)
  alertThreshold: number;       // default: 30% — notify user
  defendThreshold: number;      // default: 20% — add margin from free balance
  reduceThreshold: number;      // default: 12% — close 25% of position
  emergencyThreshold: number;   // default: 5%  — close everything

  // Actions enabled
  autoAddMargin: boolean;       // can guardian add margin from free balance?
  autoReduceSize: boolean;      // can guardian close partial positions?
  autoHedge: boolean;           // can guardian open hedge positions?
  autoEmergencyClose: boolean;  // can guardian fully close at risk of liquidation?

  maxMarginToAdd: number;       // max USDC guardian can add per intervention
  reducePercentage: number;     // how much to close on reduce (default: 25%)
}

interface MonitoredPosition {
  trader: string;
  market: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  margin: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  distanceToLiq: number;        // percentage (0-100)
  defenseLevel: DefenseLevel;
}

interface GuardianAction {
  id: string;
  timestamp: number;
  trader: string;
  market: string;
  action: ActionType;
  detail: string;
  notionalProtected: number;
  feeBps: number;
  feeCharged: number;
  success: boolean;
}

// ============================================================
//                    STATE
// ============================================================

const subscriptions: Map<string, GuardianConfig> = new Map();
const actionLog: GuardianAction[] = [];
let scanCount = 0;

const DEFAULT_CONFIG: Omit<GuardianConfig, "trader"> = {
  enabled: true,
  alertThreshold: 30,
  defendThreshold: 20,
  reduceThreshold: 12,
  emergencyThreshold: 5,
  autoAddMargin: true,
  autoReduceSize: true,
  autoHedge: false,          // disabled by default — too aggressive
  autoEmergencyClose: true,
  maxMarginToAdd: 5000,      // $5,000 max
  reducePercentage: 25,      // close 25% on reduce
};

const GUARDIAN_FEE_BPS = 5;  // 0.05% of notional protected

// ============================================================
//                    CORE LOGIC
// ============================================================

function classifyRisk(distanceToLiq: number, config: GuardianConfig): DefenseLevel {
  if (distanceToLiq <= config.emergencyThreshold) return "critical";
  if (distanceToLiq <= config.reduceThreshold) return "danger";
  if (distanceToLiq <= config.defendThreshold) return "warning";
  if (distanceToLiq <= config.alertThreshold) return "caution";
  return "safe";
}

function calculateDistanceToLiq(position: {
  markPrice: number; liquidationPrice: number; side: string
}): number {
  const { markPrice, liquidationPrice, side } = position;
  if (liquidationPrice <= 0 || markPrice <= 0) return 100;
  const diff = Math.abs(markPrice - liquidationPrice);
  return (diff / markPrice) * 100;
}

async function fetchPositions(trader: string): Promise<any[]> {
  try {
    const resp = await fetch(`${AGENT_API}/v1/positions/${trader}`);
    const data = await resp.json();
    return data.positions || [];
  } catch {
    return [];
  }
}

async function fetchBalance(trader: string): Promise<number> {
  try {
    const resp = await fetch(`${AGENT_API}/v1/balance/${trader}`);
    const data = await resp.json();
    return data.balance || 0;
  } catch {
    return 0;
  }
}

// ============================================================
//                    DEFENSIVE ACTIONS
// ============================================================

async function executeDefense(
  trader: string, market: string, level: DefenseLevel, config: GuardianConfig,
  position: any
): Promise<GuardianAction | null> {
  const notional = Math.abs(position.size * position.markPrice);
  const fee = (notional * GUARDIAN_FEE_BPS) / 10000;

  const action: GuardianAction = {
    id: `ga_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    trader, market,
    action: "alert",
    detail: "",
    notionalProtected: notional,
    feeBps: GUARDIAN_FEE_BPS,
    feeCharged: 0,
    success: true,
  };

  switch (level) {
    case "caution":
      action.action = "alert";
      action.detail = `Position ${market} distance to liq: ${position.distanceToLiq?.toFixed(1)}%. Consider adding margin or reducing size.`;
      action.feeCharged = 0; // alerts are free
      break;

    case "warning":
      if (!config.autoAddMargin) break;
      const freeBalance = await fetchBalance(trader);
      const marginToAdd = Math.min(config.maxMarginToAdd, freeBalance * 0.5);
      if (marginToAdd > 10) {
        action.action = "add_margin";
        action.detail = `Auto-added $${marginToAdd.toFixed(2)} margin to ${market} position. Distance was ${position.distanceToLiq?.toFixed(1)}%.`;
        action.feeCharged = fee;
        // In production: call Agent API to add margin
        try {
          await fetch(`${AGENT_API}/v1/positions/margin`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trader, market, amount: marginToAdd, action: "add" }),
          });
        } catch (err) {
          action.success = false;
          action.detail += " (FAILED)";
        }
      }
      break;

    case "danger":
      if (!config.autoReduceSize) break;
      action.action = "reduce_position";
      action.detail = `Auto-closed ${config.reducePercentage}% of ${market} position. Distance to liq was ${position.distanceToLiq?.toFixed(1)}%.`;
      action.feeCharged = fee;
      try {
        await fetch(`${AGENT_API}/v1/positions/close`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trader, market, percentage: config.reducePercentage }),
        });
      } catch (err) {
        action.success = false;
        action.detail += " (FAILED)";
      }
      break;

    case "critical":
      if (!config.autoEmergencyClose) break;
      action.action = "emergency_close";
      action.detail = `EMERGENCY: Closed 100% of ${market} position. Distance to liq was ${position.distanceToLiq?.toFixed(1)}%. Margin preserved.`;
      action.feeCharged = fee;
      try {
        await fetch(`${AGENT_API}/v1/positions/close`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trader, market, percentage: 100 }),
        });
      } catch (err) {
        action.success = false;
        action.detail += " (FAILED)";
      }
      break;
  }

  if (action.detail) {
    actionLog.push(action);
    console.log(`[Guardian] ${action.action.toUpperCase()} | ${trader.slice(0, 8)}... | ${market} | ${action.detail}`);
    return action;
  }
  return null;
}

// ============================================================
//                    SCAN LOOP
// ============================================================

async function scanAll(): Promise<void> {
  scanCount++;
  const traders = Array.from(subscriptions.entries()).filter(([_, c]) => c.enabled);

  for (const [trader, config] of traders) {
    const positions = await fetchPositions(trader);

    for (const pos of positions) {
      if (!pos.size || pos.size === 0) continue;

      const distance = calculateDistanceToLiq({
        markPrice: pos.markPrice || pos.mark_price || 0,
        liquidationPrice: pos.liquidationPrice || pos.liq_price || 0,
        side: pos.size > 0 ? "long" : "short",
      });

      const level = classifyRisk(distance, config);

      if (level !== "safe") {
        await executeDefense(trader, pos.market || pos.marketId, level, config, {
          ...pos,
          distanceToLiq: distance,
        });
      }
    }
  }
}

// Start scanning
setInterval(scanAll, SCAN_INTERVAL);

// ============================================================
//                    HTTP SERVER
// ============================================================

function json(res: http.ServerResponse, data: any, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data, null, 2));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", c => d += c);
    req.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("Invalid JSON")); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  // Health
  if (url.pathname === "/health") {
    return json(res, {
      status: "ok",
      service: "sur-risk-guardian",
      activeSubscriptions: subscriptions.size,
      totalScans: scanCount,
      totalActions: actionLog.length,
    });
  }

  // POST /v1/guardian/subscribe — Subscribe a trader to guardian protection
  if (method === "POST" && url.pathname === "/v1/guardian/subscribe") {
    const body = await readBody(req);
    const { trader, ...overrides } = body;
    if (!trader) return json(res, { error: "Missing 'trader' address" }, 400);

    const config: GuardianConfig = { ...DEFAULT_CONFIG, trader, ...overrides };
    subscriptions.set(trader.toLowerCase(), config);

    return json(res, {
      status: "subscribed",
      trader: trader.toLowerCase(),
      config,
      message: "Risk Guardian is now monitoring your positions.",
    }, 201);
  }

  // DELETE /v1/guardian/unsubscribe/:trader
  if (method === "DELETE" && url.pathname.startsWith("/v1/guardian/unsubscribe/")) {
    const trader = url.pathname.split("/").pop()?.toLowerCase();
    if (trader) subscriptions.delete(trader);
    return json(res, { status: "unsubscribed" });
  }

  // GET /v1/guardian/status/:trader — Get guardian status for a trader
  if (method === "GET" && url.pathname.startsWith("/v1/guardian/status/")) {
    const trader = url.pathname.split("/").pop()?.toLowerCase() || "";
    const config = subscriptions.get(trader);
    if (!config) return json(res, { error: "Not subscribed", subscribed: false }, 404);

    const traderActions = actionLog.filter(a => a.trader.toLowerCase() === trader);
    const totalFeesCharged = traderActions.reduce((sum, a) => sum + a.feeCharged, 0);
    const interventionCount = traderActions.filter(a => a.action !== "alert").length;

    return json(res, {
      subscribed: true,
      config,
      stats: {
        totalAlerts: traderActions.filter(a => a.action === "alert").length,
        totalInterventions: interventionCount,
        totalFeesCharged,
        lastAction: traderActions.length > 0 ? traderActions[traderActions.length - 1] : null,
      },
    });
  }

  // GET /v1/guardian/actions/:trader — Get action history
  if (method === "GET" && url.pathname.startsWith("/v1/guardian/actions/")) {
    const trader = url.pathname.split("/").pop()?.toLowerCase() || "";
    const actions = actionLog.filter(a => a.trader.toLowerCase() === trader);
    return json(res, { actions, count: actions.length });
  }

  // POST /v1/guardian/config — Update guardian config for a trader
  if (method === "POST" && url.pathname === "/v1/guardian/config") {
    const body = await readBody(req);
    const { trader, ...updates } = body;
    if (!trader) return json(res, { error: "Missing 'trader'" }, 400);

    const existing = subscriptions.get(trader.toLowerCase());
    if (!existing) return json(res, { error: "Not subscribed" }, 404);

    const updated = { ...existing, ...updates };
    subscriptions.set(trader.toLowerCase(), updated);
    return json(res, { status: "updated", config: updated });
  }

  // GET /v1/guardian/stats — Global guardian stats
  if (url.pathname === "/v1/guardian/stats") {
    const interventions = actionLog.filter(a => a.action !== "alert");
    const totalProtected = interventions.reduce((sum, a) => sum + a.notionalProtected, 0);
    const totalFees = interventions.reduce((sum, a) => sum + a.feeCharged, 0);

    return json(res, {
      activeSubscriptions: subscriptions.size,
      totalScans: scanCount,
      totalAlerts: actionLog.filter(a => a.action === "alert").length,
      totalInterventions: interventions.length,
      totalNotionalProtected: totalProtected,
      totalFeesCollected: totalFees,
      actionBreakdown: {
        addMargin: actionLog.filter(a => a.action === "add_margin").length,
        reducePosition: actionLog.filter(a => a.action === "reduce_position").length,
        hedge: actionLog.filter(a => a.action === "hedge").length,
        emergencyClose: actionLog.filter(a => a.action === "emergency_close").length,
      },
    });
  }

  json(res, { error: "Not found" }, 404);
});

server.listen(PORT, () => {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║     SUR Protocol — Risk Guardian               ║");
  console.log(`║     Port: ${PORT}                                  ║`);
  console.log("║     Anti-liquidation agent for every trader    ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log(`  Subscribe:   POST http://localhost:${PORT}/v1/guardian/subscribe`);
  console.log(`  Status:      GET  http://localhost:${PORT}/v1/guardian/status/:trader`);
  console.log(`  Actions:     GET  http://localhost:${PORT}/v1/guardian/actions/:trader`);
  console.log(`  Global:      GET  http://localhost:${PORT}/v1/guardian/stats`);
  console.log(`  Scan every:  ${SCAN_INTERVAL}ms`);
});
