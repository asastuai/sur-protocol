/**
 * SUR Protocol — Copytrade Bot
 * Adapted from Alpha Relay (Hyperliquid) for SUR Protocol.
 *
 * Two-process architecture:
 *   Process 1 (Profiler): Discovers top traders on SUR via Agent API leaderboard
 *   Process 2 (Copier):   Monitors primary trader's positions, replicates on your account
 *
 * Usage:
 *   bun run src/index.ts --mode=profile    # Discover & score traders
 *   bun run src/index.ts --mode=copy       # Copy primary trader
 *   bun run src/index.ts --mode=paper      # Paper copy (no execution)
 */

import "dotenv/config";

const SUR_API = process.env.SUR_API_URL || "http://localhost:3003";
const SUR_WS = process.env.SUR_WS_URL || "ws://localhost:3002";
const AGENT_ADDRESS = process.env.SUR_AGENT_ADDRESS || "";
const AGENT_KEY = process.env.SUR_AGENT_KEY || "";

const CAPITAL = Number(process.env.CAPITAL) || 2000;
const MAX_POSITION_PCT = Number(process.env.MAX_POSITION_PCT) || 0.20;
const MAX_LEVERAGE = Number(process.env.MAX_LEVERAGE) || 5;
const MAX_DAILY_LOSS_PCT = Number(process.env.MAX_DAILY_LOSS_PCT) || 0.03;
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS) || 3000;
const PROFILE_INTERVAL_MS = Number(process.env.PROFILE_INTERVAL_MS) || 900_000; // 15 min

// ============================================================
//                    SUR API CLIENT
// ============================================================

interface SurPosition {
  market: string;
  side: string;
  size: number;
  entryPrice: number;
  margin: number;
  leverage: number;
  unrealizedPnl: number;
}

interface TraderProfile {
  address: string;
  accountValue: number;
  pnl7d: number;
  pnl30d: number;
  trades: ClosedTrade[];
  score: number;
  tier: "S" | "A" | "B" | "C";
  sharpe7d: number;
  sharpe30d: number;
  winRate: number;
  maxDrawdown: number;
  profitFactor: number;
}

interface ClosedTrade {
  market: string;
  pnl: number;
  timestamp: number;
  size: number;
  side: string;
}

class SurClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`SUR API ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private async post(path: string, body: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`SUR API ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async getLeaderboard(): Promise<any[]> {
    const data = await this.get("/v1/agent/leaderboard");
    return data.leaderboard || data.agents || [];
  }

  async getPositions(trader: string): Promise<SurPosition[]> {
    const data = await this.get(`/v1/positions/${trader}`);
    return (data.positions || []).map((p: any) => ({
      market: p.market || p.marketId,
      side: Number(p.size) > 0 ? "long" : "short",
      size: Math.abs(Number(p.size)),
      entryPrice: Number(p.entryPrice),
      margin: Number(p.margin),
      leverage: Number(p.leverage || 1),
      unrealizedPnl: Number(p.unrealizedPnl || 0),
    }));
  }

  async getBalance(trader: string): Promise<number> {
    const data = await this.get(`/v1/account/${trader}`);
    return Number(data.balance || data.available || 0);
  }

  async getTrades(trader: string): Promise<ClosedTrade[]> {
    try {
      const data = await this.get(`/v1/trades/${trader}`);
      return (data.trades || []).map((t: any) => ({
        market: t.market || t.marketId,
        pnl: Number(t.closedPnl || t.pnl || 0),
        timestamp: t.timestamp || t.time || Date.now(),
        size: Math.abs(Number(t.size || 0)),
        side: t.side || "unknown",
      }));
    } catch {
      return [];
    }
  }

  async getMarketPrice(market: string): Promise<number> {
    const data = await this.get(`/v1/markets`);
    const m = (data.markets || []).find((x: any) => x.name === market || x.id === market);
    return m ? Number(m.markPrice || m.price || 0) : 0;
  }

  async submitOrder(params: {
    market: string;
    side: "buy" | "sell";
    size: number;
    price: number;
    leverage?: number;
  }): Promise<any> {
    return this.post("/v1/orders", {
      trader: AGENT_ADDRESS,
      marketId: params.market,
      side: params.side,
      orderType: "market",
      price: String(Math.round(params.price * 1e6)),
      size: String(Math.round(params.size * 1e8)),
      timeInForce: "IOC",
      hidden: false,
      nonce: String(Date.now()),
      expiry: String(Math.floor(Date.now() / 1000) + 3600),
      signature: "0x",
    });
  }

  async closePosition(market: string): Promise<any> {
    return this.post("/v1/positions/close", {
      trader: AGENT_ADDRESS,
      market,
      percentage: 100,
    });
  }
}

// ============================================================
//                    SCORING ENGINE
// ============================================================
// Ported from Alpha Relay — DEX-agnostic scoring algorithm

function calculateMetrics(trades: ClosedTrade[]): {
  sharpe7d: number; sharpe30d: number; winRate: number;
  maxDrawdown: number; profitFactor: number; monthlyConsistency: number;
} {
  if (trades.length < 5) {
    return { sharpe7d: 0, sharpe30d: 0, winRate: 0, maxDrawdown: 0, profitFactor: 0, monthlyConsistency: 0 };
  }

  const now = Date.now();
  const d7 = now - 7 * 86400_000;
  const d30 = now - 30 * 86400_000;

  const pnls = trades.map(t => t.pnl);
  const pnls7d = trades.filter(t => t.timestamp >= d7).map(t => t.pnl);
  const pnls30d = trades.filter(t => t.timestamp >= d30).map(t => t.pnl);

  const sharpe = (arr: number[]): number => {
    if (arr.length < 3) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const std = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
    return std > 0 ? mean / std : 0;
  };

  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const winRate = wins.length / pnls.length;
  const profitFactor = losses.length > 0
    ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0))
    : wins.length > 0 ? 10 : 0;

  // Max drawdown from cumulative PnL
  let peak = 0, maxDD = 0, cumulative = 0;
  for (const p of pnls) {
    cumulative += p;
    if (cumulative > peak) peak = cumulative;
    const dd = peak > 0 ? (peak - cumulative) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Monthly consistency (coefficient of variation of weekly PnLs)
  const weeklyPnls: number[] = [];
  const weekMs = 7 * 86400_000;
  const oldest = Math.min(...trades.map(t => t.timestamp));
  for (let start = oldest; start < now; start += weekMs) {
    const end = start + weekMs;
    const weekPnl = trades.filter(t => t.timestamp >= start && t.timestamp < end)
      .reduce((s, t) => s + t.pnl, 0);
    weeklyPnls.push(weekPnl);
  }
  let monthlyConsistency = 0;
  if (weeklyPnls.length >= 2) {
    const mean = weeklyPnls.reduce((a, b) => a + b, 0) / weeklyPnls.length;
    const std = Math.sqrt(weeklyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / weeklyPnls.length);
    const cv = mean !== 0 ? Math.abs(std / mean) : 5;
    monthlyConsistency = Math.max(0, 1 - cv / 5);
  }

  return {
    sharpe7d: sharpe(pnls7d),
    sharpe30d: sharpe(pnls30d),
    winRate,
    maxDrawdown: maxDD,
    profitFactor,
    monthlyConsistency,
  };
}

function calculateScore(m: ReturnType<typeof calculateMetrics>, hasLongHistory: boolean): number {
  if (hasLongHistory) {
    return (
      (m.sharpe7d / 2) * 0.40 +
      (m.sharpe30d / 2) * 0.20 +
      Math.min(0.05 / Math.max(m.maxDrawdown, 0.001), 1) * 0.20 +
      (m.profitFactor / 4) * 0.10 +
      m.monthlyConsistency * 0.10
    );
  }
  // New trader weighting
  return (
    (m.sharpe7d / 2) * 0.60 +
    Math.min(0.05 / Math.max(m.maxDrawdown, 0.001), 1) * 0.20 +
    (m.profitFactor / 4) * 0.10
  );
}

function assignTier(score: number): "S" | "A" | "B" | "C" {
  if (score >= 0.78) return "S";
  if (score >= 0.65) return "A";
  if (score >= 0.45) return "B";
  return "C";
}

// Anti-fraud guardrails
function isSuspicious(m: ReturnType<typeof calculateMetrics>, tradeCount: number): string | null {
  if (m.winRate > 0.92) return "Win rate > 92% (too perfect)";
  if (m.winRate > 0.85 && m.profitFactor < 0.3) return "High WR + low PF (martingale)";
  if (m.maxDrawdown === 0 && tradeCount > 20) return "Zero drawdown with 20+ trades";
  if (m.sharpe7d > 4.0) return "Sharpe > 4.0 (statistically impossible)";
  return null;
}

// ============================================================
//                    PROFILER
// ============================================================

async function runProfiler(client: SurClient): Promise<TraderProfile[]> {
  console.log("[Profiler] Scanning SUR leaderboard...");
  const leaderboard = await client.getLeaderboard();
  console.log(`[Profiler] Found ${leaderboard.length} traders`);

  const profiles: TraderProfile[] = [];

  for (const entry of leaderboard) {
    const address = entry.address || entry.trader || entry.ethAddress;
    if (!address) continue;

    const accountValue = Number(entry.accountValue || entry.equity || 0);
    if (accountValue < 5000) continue; // Filter: min $5K

    const pnl7d = Number(entry.pnl7d || entry.windowPerformances?.["7d"] || 0);
    const pnl30d = Number(entry.pnl30d || entry.windowPerformances?.["30d"] || 0);
    if (pnl7d <= 0 && pnl30d <= 0) continue; // Filter: must be profitable

    // Fetch trade history
    const trades = await client.getTrades(address);
    if (trades.length < 5) continue; // Filter: min 5 trades

    const metrics = calculateMetrics(trades);

    // Anti-fraud check
    const suspicion = isSuspicious(metrics, trades.length);
    if (suspicion) {
      console.log(`[Profiler] REJECTED ${address.slice(0, 10)}... — ${suspicion}`);
      continue;
    }

    // Gate: Sharpe threshold
    if (metrics.sharpe30d < 0.5 && metrics.sharpe7d < 0.8) continue;

    const hasLongHistory = trades.length > 0 &&
      (Date.now() - Math.min(...trades.map(t => t.timestamp))) > 30 * 86400_000;
    const score = calculateScore(metrics, hasLongHistory);
    const tier = assignTier(score);

    profiles.push({
      address,
      accountValue,
      pnl7d,
      pnl30d,
      trades,
      score,
      tier,
      ...metrics,
    });

    console.log(`[Profiler] ${address.slice(0, 10)}... | Tier ${tier} | Score ${score.toFixed(3)} | Sharpe7d ${metrics.sharpe7d.toFixed(2)} | WR ${(metrics.winRate * 100).toFixed(1)}%`);
  }

  profiles.sort((a, b) => b.score - a.score);
  return profiles;
}

// ============================================================
//                    COPIER
// ============================================================

interface CopyState {
  primaryAddress: string;
  lastSnapshot: Map<string, SurPosition>;
  dailyPnl: number;
  dailyStart: number;
  copyCount: number;
}

async function runCopier(client: SurClient, primaryAddress: string, paperMode: boolean) {
  console.log(`[Copier] Monitoring ${primaryAddress.slice(0, 10)}... (${paperMode ? "PAPER" : "LIVE"})`);

  const state: CopyState = {
    primaryAddress,
    lastSnapshot: new Map(),
    dailyPnl: 0,
    dailyStart: Date.now(),
    copyCount: 0,
  };

  // Reset daily PnL at midnight
  const checkDailyReset = () => {
    if (Date.now() - state.dailyStart > 86400_000) {
      state.dailyPnl = 0;
      state.dailyStart = Date.now();
    }
  };

  const copyLoop = async () => {
    try {
      checkDailyReset();

      // Circuit breaker
      if (state.dailyPnl < -(CAPITAL * MAX_DAILY_LOSS_PCT)) {
        console.log(`[Copier] CIRCUIT BREAKER: Daily loss $${Math.abs(state.dailyPnl).toFixed(2)} exceeds ${MAX_DAILY_LOSS_PCT * 100}%`);
        return;
      }

      // Fetch primary trader's positions
      const positions = await client.getPositions(state.primaryAddress);
      const current = new Map<string, SurPosition>();
      for (const p of positions) {
        if (p.size > 0) current.set(p.market, p);
      }

      const previous = state.lastSnapshot;

      // Detect NEW positions
      for (const [market, pos] of current) {
        if (!previous.has(market)) {
          const margin = CAPITAL * MAX_POSITION_PCT;
          const leverage = Math.min(pos.leverage, MAX_LEVERAGE);
          const notional = margin * leverage;
          const size = notional / pos.entryPrice;

          console.log(`[Copier] NEW: ${pos.side.toUpperCase()} ${market} | Size ${size.toFixed(6)} | Lev ${leverage}x | Margin $${margin.toFixed(2)}`);

          if (!paperMode) {
            try {
              await client.submitOrder({
                market,
                side: pos.side === "long" ? "buy" : "sell",
                size,
                price: pos.entryPrice,
                leverage,
              });
              console.log(`[Copier] EXECUTED: ${market} ${pos.side}`);
            } catch (err) {
              console.error(`[Copier] FAILED: ${market}`, err);
            }
          }
          state.copyCount++;
        }
      }

      // Detect CLOSES
      for (const [market, prev] of previous) {
        if (!current.has(market)) {
          console.log(`[Copier] CLOSE: ${market} (primary closed)`);

          if (!paperMode) {
            try {
              await client.closePosition(market);
              console.log(`[Copier] CLOSED: ${market}`);
            } catch (err) {
              console.error(`[Copier] CLOSE FAILED: ${market}`, err);
            }
          }
        }
      }

      state.lastSnapshot = current;
    } catch (err) {
      console.error("[Copier] Scan error:", err);
    }
  };

  // Run scan loop
  console.log(`[Copier] Scanning every ${SCAN_INTERVAL_MS / 1000}s...`);
  setInterval(copyLoop, SCAN_INTERVAL_MS);
  await copyLoop(); // Initial scan
}

// ============================================================
//                    MAIN
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const mode = args.find(a => a.startsWith("--mode="))?.split("=")[1] || "paper";
  const primaryArg = args.find(a => a.startsWith("--primary="))?.split("=")[1];

  const client = new SurClient(SUR_API);

  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║   SUR PROTOCOL — Copytrade Bot                        ║
  ║   Mode: ${mode.toUpperCase().padEnd(46)}║
  ║   API: ${SUR_API.padEnd(47)}║
  ║   Capital: $${CAPITAL.toString().padEnd(43)}║
  ╚═══════════════════════════════════════════════════════╝
  `);

  if (mode === "profile") {
    const profiles = await runProfiler(client);
    console.log(`\n[Profiler] Results: ${profiles.length} qualified traders`);
    console.log("─".repeat(80));
    for (const p of profiles.slice(0, 20)) {
      console.log(
        `  Tier ${p.tier} | ${p.address.slice(0, 12)}... | Score ${p.score.toFixed(3)} | ` +
        `Sharpe ${p.sharpe7d.toFixed(2)}/${p.sharpe30d.toFixed(2)} | WR ${(p.winRate * 100).toFixed(1)}% | ` +
        `DD ${(p.maxDrawdown * 100).toFixed(1)}% | PF ${p.profitFactor.toFixed(2)} | $${p.accountValue.toFixed(0)}`
      );
    }
    if (profiles.length > 0) {
      console.log(`\nRecommended primary: ${profiles[0].address} (Tier ${profiles[0].tier}, Score ${profiles[0].score.toFixed(3)})`);
    }
    return;
  }

  if (mode === "copy" || mode === "paper") {
    const primary = primaryArg || process.env.PRIMARY_TRADER || "";
    if (!primary) {
      console.error("No primary trader specified. Use --primary=0x... or set PRIMARY_TRADER in .env");
      console.log("Run with --mode=profile first to discover traders.");
      process.exit(1);
    }
    await runCopier(client, primary, mode === "paper");
    return;
  }

  console.error(`Unknown mode: ${mode}. Use --mode=profile, --mode=copy, or --mode=paper`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
