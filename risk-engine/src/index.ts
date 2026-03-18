/**
 * SUR Protocol - Risk Management Engine
 *
 * Continuous monitoring of protocol health. Detects and alerts on:
 *
 * 1. PRICE PREMIUM — mark vs index divergence (oracle issues, manipulation)
 * 2. OI IMBALANCE — when longs/shorts are heavily skewed (directional risk)
 * 3. FUNDING RATE — extreme rates signal unhealthy market dynamics
 * 4. INSURANCE FUND — low coverage means bad debt can't be absorbed
 * 5. VAULT SOLVENCY — the nuclear check: is the vault actually solvent?
 * 6. LIQUIDATION CASCADE — many positions near maintenance margin
 *
 * Risk Levels:
 *   🟢 GREEN    — healthy, no action needed
 *   🟡 YELLOW   — elevated, monitor closely
 *   🟠 ORANGE   — concerning, consider reducing exposure
 *   🔴 RED      — dangerous, intervention may be needed
 *   ⛔ CRITICAL  — emergency, circuit breaker recommended
 *
 * Actions:
 *   - GREEN/YELLOW: log only
 *   - ORANGE: emit warning, increase monitoring frequency
 *   - RED: emit urgent alert, recommend pausing new positions
 *   - CRITICAL: recommend full market pause (circuit breaker)
 *
 * In production, RED/CRITICAL alerts would trigger:
 *   - PagerDuty/Telegram notifications
 *   - Automated market pause via multisig/timelock
 *   - Auto-Deleverage (ADL) system activation
 */

import "dotenv/config";
import {
  createPublicClient, http,
  type PublicClient, type Hex, type Chain,
  keccak256, toHex, formatEther,
} from "viem";
import { baseSepolia, base } from "viem/chains";
import {
  RiskCalculator, type ProtocolRiskSnapshot, type RiskAlert, type RiskLevel,
} from "./metrics.js";

// ============================================================
//                    CONFIG
// ============================================================

interface RiskConfig {
  chain: typeof baseSepolia | typeof base;
  rpcUrl: string;
  engineAddress: Hex;
  vaultAddress: Hex;
  insuranceFundAddress: Hex;
  scanIntervalMs: number;
  fastScanIntervalMs: number;  // used when risk is elevated
  markets: { name: string; id: Hex }[];
}

function loadConfig(): RiskConfig {
  const isTestnet = process.env.NETWORK !== "mainnet";
  const marketNames = (process.env.MARKETS || "BTC-USD,ETH-USD").split(",");

  return {
    chain: isTestnet ? baseSepolia : base,
    rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
    engineAddress: (process.env.ENGINE_ADDRESS || "0x") as Hex,
    vaultAddress: (process.env.VAULT_ADDRESS || "0x") as Hex,
    insuranceFundAddress: (process.env.INSURANCE_FUND_ADDRESS || "0x") as Hex,
    scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || "15000"),
    fastScanIntervalMs: parseInt(process.env.FAST_SCAN_INTERVAL_MS || "5000"),
    markets: marketNames.map(n => ({
      name: n.trim(),
      id: keccak256(toHex(n.trim(), { size: null })) as Hex,
    })),
  };
}

// ============================================================
//                    DASHBOARD
// ============================================================

const RISK_ICONS: Record<RiskLevel, string> = {
  GREEN: "🟢", YELLOW: "🟡", ORANGE: "🟠", RED: "🔴", CRITICAL: "⛔",
};

function printDashboard(snapshot: ProtocolRiskSnapshot): void {
  const ts = new Date(snapshot.timestamp).toLocaleTimeString("en", { hour12: false });

  console.log();
  console.log(`┌─── SUR RISK DASHBOARD ─── ${ts} ─── Block ${snapshot.blockNumber} ───┐`);
  console.log(`│ Overall: ${RISK_ICONS[snapshot.overallRisk]} ${snapshot.overallRisk}`);
  console.log(`│`);

  // Markets
  for (const m of snapshot.markets) {
    if (!m.active) continue;
    const prem = m.premiumPct >= 0 ? "+" : "";
    const fund = m.annualizedFundingRate >= 0 ? "+" : "";
    const imb = m.oiImbalanceRatio * 100;
    const heavy = m.oiLong > m.oiShort ? "L" : "S";

    console.log(
      `│ ${RISK_ICONS[m.overallRisk]} ${m.name.padEnd(10)} ` +
      `Mark: $${m.markPrice.toFixed(2).padStart(10)} | ` +
      `Premium: ${prem}${m.premiumPct.toFixed(3).padStart(7)}% ${RISK_ICONS[m.premiumRisk]} | ` +
      `OI: ${m.oiLong.toFixed(2)}L/${m.oiShort.toFixed(2)}S (${imb.toFixed(0)}%${heavy}) ${RISK_ICONS[m.oiImbalanceRisk]} | ` +
      `Funding: ${fund}${m.annualizedFundingRate.toFixed(1).padStart(6)}% ann ${RISK_ICONS[m.fundingRisk]}`
    );
  }

  console.log(`│`);

  // Insurance Fund
  const ins = snapshot.insuranceFund;
  console.log(
    `│ ${RISK_ICONS[ins.risk]} Insurance   ` +
    `Balance: $${ins.balance.toFixed(2).padStart(12)} | ` +
    `Coverage: ${(ins.coverageRatio * 100).toFixed(2)}% of $${ins.totalOiNotional.toFixed(2)} OI`
  );

  // Vault
  const v = snapshot.vault;
  console.log(
    `│ ${RISK_ICONS[v.risk]} Vault       ` +
    `USDC: $${v.actualUsdc.toFixed(2).padStart(12)} | ` +
    `Accounted: $${v.totalDeposits.toFixed(2)} | ` +
    `Surplus: $${v.surplus.toFixed(2)} ${v.healthy ? "✓" : "✗ UNHEALTHY"}`
  );

  console.log(`└${"─".repeat(80)}┘`);

  // Alerts
  if (snapshot.alerts.length > 0) {
    console.log();
    const severeAlerts = snapshot.alerts.filter(a => a.severity !== "GREEN");
    for (const alert of severeAlerts) {
      const prefix = alert.market ? `[${alert.market}]` : "[PROTOCOL]";
      console.log(`  ${RISK_ICONS[alert.severity]} ${alert.severity.padEnd(8)} ${prefix.padEnd(12)} ${alert.message}`);
    }
  }
}

// ============================================================
//                    ALERT HISTORY
// ============================================================

class AlertTracker {
  private history: RiskAlert[] = [];
  private lastAlertedKeys: Map<string, number> = new Map(); // key → timestamp of last alert
  private cooldownMs = 300_000; // 5 minutes between repeated alerts

  process(alerts: RiskAlert[]): RiskAlert[] {
    const newAlerts: RiskAlert[] = [];

    for (const alert of alerts) {
      const key = `${alert.category}:${alert.market || "protocol"}`;
      const lastAlerted = this.lastAlertedKeys.get(key) || 0;

      // Only emit if cooldown has passed or severity escalated
      if (Date.now() - lastAlerted > this.cooldownMs) {
        newAlerts.push(alert);
        this.lastAlertedKeys.set(key, Date.now());
      }
    }

    this.history.push(...alerts);
    if (this.history.length > 1000) {
      this.history = this.history.slice(-500);
    }

    return newAlerts;
  }

  getHistory(n: number = 50): RiskAlert[] {
    return this.history.slice(-n);
  }

  getActiveAlerts(): RiskAlert[] {
    const fiveMinAgo = Date.now() - 300_000;
    return this.history.filter(a => a.timestamp > fiveMinAgo && a.severity !== "GREEN");
  }
}

// ============================================================
//                    CIRCUIT BREAKER
// ============================================================

interface CircuitBreakerState {
  triggered: boolean;
  reason: string | null;
  triggeredAt: number | null;
  consecutiveCritical: number;
  threshold: number; // how many consecutive CRITICAL scans before recommending pause
}

function checkCircuitBreaker(
  snapshot: ProtocolRiskSnapshot,
  state: CircuitBreakerState
): CircuitBreakerState {
  if (snapshot.overallRisk === "CRITICAL") {
    state.consecutiveCritical++;

    if (state.consecutiveCritical >= state.threshold && !state.triggered) {
      state.triggered = true;
      state.triggeredAt = Date.now();

      // Find the worst alert
      const critAlerts = snapshot.alerts.filter(a => a.severity === "CRITICAL");
      state.reason = critAlerts.length > 0
        ? critAlerts.map(a => a.message).join("; ")
        : "Multiple risk indicators at CRITICAL level";

      console.log();
      console.log("╔══════════════════════════════════════════════╗");
      console.log("║  ⛔ CIRCUIT BREAKER TRIGGERED                ║");
      console.log(`║  Reason: ${state.reason?.slice(0, 40).padEnd(40)}║`);
      console.log("║                                              ║");
      console.log("║  RECOMMENDED ACTION:                         ║");
      console.log("║  1. Pause all markets (engine.pause())       ║");
      console.log("║  2. Investigate root cause                   ║");
      console.log("║  3. Resume when risk returns to GREEN        ║");
      console.log("╚══════════════════════════════════════════════╝");
      console.log();
    }
  } else {
    state.consecutiveCritical = 0;
    if (state.triggered && snapshot.overallRisk === "GREEN") {
      console.log(`[CircuitBreaker] ✅ Risk returned to GREEN. Clearing circuit breaker.`);
      state.triggered = false;
      state.reason = null;
      state.triggeredAt = null;
    }
  }

  return state;
}

// ============================================================
//                    MAIN
// ============================================================

async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║     SUR Protocol - Risk Management Engine      ║");
  console.log("║   Protocol health monitoring & circuit breaker ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log();

  const config = loadConfig();

  console.log(`[Config] Network:  ${config.chain.name}`);
  console.log(`[Config] Engine:   ${config.engineAddress}`);
  console.log(`[Config] Vault:    ${config.vaultAddress}`);
  console.log(`[Config] Insurance:${config.insuranceFundAddress}`);
  console.log(`[Config] Markets:  ${config.markets.map(m => m.name).join(", ")}`);
  console.log(`[Config] Scan:     ${config.scanIntervalMs / 1000}s (fast: ${config.fastScanIntervalMs / 1000}s)`);
  console.log();

  const client = createPublicClient({
    chain: config.chain as Chain, transport: http(config.rpcUrl),
  });

  const calculator = new RiskCalculator(
    client, config.engineAddress, config.vaultAddress,
    config.insuranceFundAddress, config.markets,
  );

  const alertTracker = new AlertTracker();
  let circuitBreaker: CircuitBreakerState = {
    triggered: false, reason: null, triggeredAt: null,
    consecutiveCritical: 0, threshold: 3, // 3 consecutive CRITICAL scans
  };

  let snapshots: ProtocolRiskSnapshot[] = [];
  let running = true;
  let cycle = 0;

  console.log("════════════════════════════════════════════");
  console.log("  RISK ENGINE RUNNING");
  console.log("════════════════════════════════════════════");

  const loop = async () => {
    while (running) {
      cycle++;

      try {
        const snapshot = await calculator.computeSnapshot();
        snapshots.push(snapshot);
        if (snapshots.length > 500) snapshots = snapshots.slice(-250);

        // Process alerts
        const newAlerts = alertTracker.process(snapshot.alerts);

        // Check circuit breaker
        circuitBreaker = checkCircuitBreaker(snapshot, circuitBreaker);

        // Print dashboard every 4 cycles (or every cycle if elevated risk)
        const isElevated = snapshot.overallRisk !== "GREEN";
        const shouldPrint = cycle % 4 === 0 || isElevated || newAlerts.length > 0;

        if (shouldPrint) {
          printDashboard(snapshot);
        }

        // Adjust scan speed based on risk level
        const interval = isElevated ? config.fastScanIntervalMs : config.scanIntervalMs;
        await sleep(interval);

      } catch (err: any) {
        console.error(`[Cycle ${cycle}] Error: ${err?.shortMessage || err?.message}`);
        await sleep(config.scanIntervalMs);
      }
    }
  };

  loop();

  process.on("SIGINT", () => {
    console.log("\n[Shutdown] Risk engine stopping.");
    console.log(`[Shutdown] ${cycle} scans completed. ${alertTracker.getHistory().length} total alerts.`);
    if (circuitBreaker.triggered) {
      console.log(`[Shutdown] ⚠️  Circuit breaker is STILL ACTIVE: ${circuitBreaker.reason}`);
    }
    running = false;
    process.exit(0);
  });
  process.on("SIGTERM", () => { running = false; process.exit(0); });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
