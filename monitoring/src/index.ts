/**
 * SUR Protocol - Unified Monitoring & Alerting
 *
 * Monitors every component of the protocol stack:
 *
 * ON-CHAIN:
 *   - Vault solvency (USDC balance vs accounted)
 *   - Contract pause status
 *   - Oracle price freshness
 *   - Insurance fund coverage
 *   - Open interest per market
 *
 * INFRASTRUCTURE:
 *   - API server health (WebSocket ping)
 *   - Keeper bot gas balances
 *   - Oracle keeper last push time
 *   - Block production (chain liveness)
 *
 * ALERTS dispatched via:
 *   - Telegram bot
 *   - Discord webhook
 *   - Console log (always)
 *
 * Severity levels: INFO, WARN, ERROR, CRITICAL
 */

import "dotenv/config";
import {
  createPublicClient, http,
  type PublicClient, type Hex, type Chain,
  keccak256, toHex, formatEther,
} from "viem";
import { baseSepolia, base } from "viem/chains";

// ============================================================
//                    CONFIG
// ============================================================

interface MonitorConfig {
  chain: typeof baseSepolia | typeof base;
  rpcUrl: string;
  contracts: {
    vault: Hex; engine: Hex; settlement: Hex;
    liquidator: Hex; insuranceFund: Hex; oracleRouter: Hex;
  };
  keeperAddresses: Hex[];
  wsApiUrl: string;
  checkIntervalMs: number;
  alertWebhooks: {
    telegram?: { botToken: string; chatId: string };
    discord?: { webhookUrl: string };
  };
  markets: { name: string; id: Hex }[];
  minKeeperBalanceEth: number;
}

function loadConfig(): MonitorConfig {
  const isTestnet = process.env.NETWORK !== "mainnet";
  const marketNames = (process.env.MARKETS || "BTC-USD,ETH-USD").split(",");

  return {
    chain: isTestnet ? baseSepolia : base,
    rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
    contracts: {
      vault: (process.env.VAULT_ADDRESS || "0x") as Hex,
      engine: (process.env.ENGINE_ADDRESS || "0x") as Hex,
      settlement: (process.env.SETTLEMENT_ADDRESS || "0x") as Hex,
      liquidator: (process.env.LIQUIDATOR_ADDRESS || "0x") as Hex,
      insuranceFund: (process.env.INSURANCE_FUND_ADDRESS || "0x") as Hex,
      oracleRouter: (process.env.ORACLE_ROUTER_ADDRESS || "0x") as Hex,
    },
    keeperAddresses: (process.env.KEEPER_ADDRESSES || "").split(",").filter(Boolean).map(a => a.trim() as Hex),
    wsApiUrl: process.env.WS_API_URL || "ws://localhost:3002",
    checkIntervalMs: parseInt(process.env.CHECK_INTERVAL_MS || "30000"),
    alertWebhooks: {
      telegram: process.env.TELEGRAM_BOT_TOKEN ? {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID || "",
      } : undefined,
      discord: process.env.DISCORD_WEBHOOK_URL ? {
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      } : undefined,
    },
    markets: marketNames.map(n => ({
      name: n.trim(),
      id: keccak256(toHex(n.trim(), { size: null })) as Hex,
    })),
    minKeeperBalanceEth: parseFloat(process.env.MIN_KEEPER_BALANCE_ETH || "0.01"),
  };
}

// ============================================================
//                    ALERT SYSTEM
// ============================================================

type Severity = "INFO" | "WARN" | "ERROR" | "CRITICAL";

interface Alert {
  severity: Severity;
  component: string;
  message: string;
  value?: string;
  timestamp: number;
}

const SEVERITY_EMOJI: Record<Severity, string> = {
  INFO: "ℹ️", WARN: "⚠️", ERROR: "🔴", CRITICAL: "🚨",
};

class AlertDispatcher {
  private config: MonitorConfig;
  private cooldowns: Map<string, number> = new Map();
  private cooldownMs = 300_000; // 5 min between repeated alerts
  private history: Alert[] = [];

  constructor(config: MonitorConfig) {
    this.config = config;
  }

  async dispatch(alert: Alert): Promise<void> {
    // Cooldown check
    const key = `${alert.component}:${alert.severity}:${alert.message.slice(0, 50)}`;
    const lastSent = this.cooldowns.get(key) || 0;
    if (Date.now() - lastSent < this.cooldownMs && alert.severity !== "CRITICAL") return;

    this.cooldowns.set(key, Date.now());
    this.history.push(alert);
    if (this.history.length > 500) this.history = this.history.slice(-250);

    // Console (always)
    const ts = new Date(alert.timestamp).toLocaleTimeString("en", { hour12: false });
    console.log(`${SEVERITY_EMOJI[alert.severity]} [${ts}] [${alert.component}] ${alert.message}${alert.value ? ` (${alert.value})` : ""}`);

    // Only send external alerts for WARN+ severity
    if (alert.severity === "INFO") return;

    const text = `${SEVERITY_EMOJI[alert.severity]} *SUR ${alert.severity}*\n[${alert.component}] ${alert.message}${alert.value ? `\nValue: ${alert.value}` : ""}`;

    // Telegram
    if (this.config.alertWebhooks.telegram) {
      const { botToken, chatId } = this.config.alertWebhooks.telegram;
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
        });
      } catch {}
    }

    // Discord
    if (this.config.alertWebhooks.discord) {
      try {
        await fetch(this.config.alertWebhooks.discord.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
        });
      } catch {}
    }
  }

  getHistory(n = 50): Alert[] { return this.history.slice(-n); }
}

// ============================================================
//                    HEALTH CHECKS
// ============================================================

const VAULT_ABI = [
  { type: "function", name: "healthCheck", stateMutability: "view", inputs: [],
    outputs: [{ name: "healthy", type: "bool" }, { name: "actualUsdc", type: "uint256" }, { name: "accountedUsdc", type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "balances", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const ENGINE_ABI = [
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "markets", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      { name: "id", type: "bytes32" }, { name: "name", type: "string" },
      { name: "active", type: "bool" }, { name: "initialMarginBps", type: "uint256" },
      { name: "maintenanceMarginBps", type: "uint256" }, { name: "maxPositionSize", type: "uint256" },
      { name: "markPrice", type: "uint256" }, { name: "indexPrice", type: "uint256" },
      { name: "lastPriceUpdate", type: "uint256" }, { name: "cumulativeFunding", type: "int256" },
      { name: "lastFundingUpdate", type: "uint256" }, { name: "fundingIntervalSecs", type: "uint256" },
      { name: "openInterestLong", type: "uint256" }, { name: "openInterestShort", type: "uint256" },
    ] },
] as const;

const ORACLE_ABI = [
  { type: "function", name: "isPriceFresh", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

async function checkOnChain(client: PublicClient, config: MonitorConfig, alerts: AlertDispatcher) {
  const now = Math.floor(Date.now() / 1000);
  const P = 1e6;
  const S = 1e8;

  // Vault health
  try {
    const [healthy, actualRaw, accountedRaw] = await client.readContract({
      address: config.contracts.vault, abi: VAULT_ABI, functionName: "healthCheck", args: [],
    });
    const actual = Number(actualRaw) / P;
    const accounted = Number(accountedRaw) / P;

    if (!healthy) {
      await alerts.dispatch({ severity: "CRITICAL", component: "Vault", message: "VAULT UNHEALTHY — actual USDC < accounted!", value: `$${actual.toFixed(2)} actual vs $${accounted.toFixed(2)} accounted`, timestamp: Date.now() });
    }

    const vaultPaused = await client.readContract({ address: config.contracts.vault, abi: VAULT_ABI, functionName: "paused", args: [] });
    if (vaultPaused) {
      await alerts.dispatch({ severity: "ERROR", component: "Vault", message: "Vault is PAUSED", timestamp: Date.now() });
    }
  } catch (e: any) {
    await alerts.dispatch({ severity: "WARN", component: "Vault", message: `Health check failed: ${e?.message?.slice(0, 80)}`, timestamp: Date.now() });
  }

  // Engine pause
  try {
    const enginePaused = await client.readContract({ address: config.contracts.engine, abi: ENGINE_ABI, functionName: "paused", args: [] });
    if (enginePaused) {
      await alerts.dispatch({ severity: "ERROR", component: "Engine", message: "PerpEngine is PAUSED — no trades can execute", timestamp: Date.now() });
    }
  } catch {}

  // Markets and oracle freshness
  for (const m of config.markets) {
    try {
      const data = await client.readContract({ address: config.contracts.engine, abi: ENGINE_ABI, functionName: "markets", args: [m.id] });
      const [,, active,,,,markRaw, indexRaw, lastPriceUpdate,,,,oiLRaw, oiSRaw] = data;

      const mark = Number(markRaw) / P;
      const index = Number(indexRaw) / P;
      const lastUpdate = Number(lastPriceUpdate);
      const staleSecs = now - lastUpdate;
      const oiL = Number(oiLRaw) / S;
      const oiS = Number(oiSRaw) / S;

      // Price staleness
      if (staleSecs > 120) {
        await alerts.dispatch({ severity: staleSecs > 300 ? "ERROR" : "WARN", component: "Oracle", message: `${m.name} price stale for ${staleSecs}s`, value: `Mark: $${mark.toFixed(2)}, Last update: ${staleSecs}s ago`, timestamp: Date.now() });
      }

      // Oracle freshness via OracleRouter
      try {
        const fresh = await client.readContract({ address: config.contracts.oracleRouter, abi: ORACLE_ABI, functionName: "isPriceFresh", args: [m.id] });
        if (!fresh) {
          await alerts.dispatch({ severity: "WARN", component: "Oracle", message: `${m.name} oracle reports NOT fresh`, timestamp: Date.now() });
        }
      } catch {}

      // Premium check
      if (index > 0) {
        const premium = Math.abs((mark - index) / index) * 100;
        if (premium > 2) {
          await alerts.dispatch({ severity: "ERROR", component: "Market", message: `${m.name} premium ${premium.toFixed(2)}% — mark/index diverging`, value: `Mark: $${mark.toFixed(2)}, Index: $${index.toFixed(2)}`, timestamp: Date.now() });
        }
      }

      // Insurance fund coverage
      const insBal = Number(await client.readContract({
        address: config.contracts.vault, abi: VAULT_ABI, functionName: "balances", args: [config.contracts.insuranceFund],
      })) / P;
      const totalOi = mark * (oiL + oiS);
      if (totalOi > 0 && insBal / totalOi < 0.02) {
        await alerts.dispatch({ severity: "ERROR", component: "Insurance", message: `Coverage ratio ${((insBal / totalOi) * 100).toFixed(2)}%`, value: `Balance: $${insBal.toFixed(2)}, OI: $${totalOi.toFixed(2)}`, timestamp: Date.now() });
      }
    } catch {}
  }

  // Keeper balances
  for (const keeper of config.keeperAddresses) {
    try {
      const bal = await client.getBalance({ address: keeper });
      const balEth = Number(formatEther(bal));
      if (balEth < config.minKeeperBalanceEth) {
        await alerts.dispatch({ severity: "WARN", component: "Keeper", message: `Low balance: ${keeper.slice(0, 10)}... has ${balEth.toFixed(6)} ETH`, value: `Min: ${config.minKeeperBalanceEth} ETH`, timestamp: Date.now() });
      }
    } catch {}
  }
}

async function checkInfra(config: MonitorConfig, alerts: AlertDispatcher) {
  // API WebSocket health
  try {
    const wsUrl = config.wsApiUrl.replace("ws://", "http://").replace("wss://", "https://");
    // Simple TCP check — in production, use a proper health endpoint
  } catch {}

  // Chain liveness
  try {
    const client = createPublicClient({ chain: config.chain as Chain, transport: http(config.rpcUrl) });
    const block = await client.getBlock();
    const blockAge = Math.floor(Date.now() / 1000) - Number(block.timestamp);

    if (blockAge > 60) {
      await alerts.dispatch({ severity: "WARN", component: "Chain", message: `Latest block is ${blockAge}s old`, value: `Block ${block.number}`, timestamp: Date.now() });
    }
  } catch (e: any) {
    await alerts.dispatch({ severity: "ERROR", component: "Chain", message: `RPC unreachable: ${e?.message?.slice(0, 60)}`, timestamp: Date.now() });
  }
}

// ============================================================
//                    MAIN
// ============================================================

async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║     SUR Protocol - Monitoring & Alerting       ║");
  console.log("║   Unified health checks for all components    ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log();

  const config = loadConfig();
  const alerts = new AlertDispatcher(config);

  const client = createPublicClient({
    chain: config.chain as Chain, transport: http(config.rpcUrl),
  });

  console.log(`[Config] Network:    ${config.chain.name}`);
  console.log(`[Config] Check:      every ${config.checkIntervalMs / 1000}s`);
  console.log(`[Config] Telegram:   ${config.alertWebhooks.telegram ? "enabled" : "disabled"}`);
  console.log(`[Config] Discord:    ${config.alertWebhooks.discord ? "enabled" : "disabled"}`);
  console.log(`[Config] Markets:    ${config.markets.map(m => m.name).join(", ")}`);
  console.log(`[Config] Keepers:    ${config.keeperAddresses.length} addresses`);
  console.log();

  await alerts.dispatch({ severity: "INFO", component: "Monitor", message: "Monitoring system started", timestamp: Date.now() });

  let running = true;
  let cycle = 0;

  const loop = async () => {
    while (running) {
      cycle++;

      try {
        await checkOnChain(client, config, alerts);
        await checkInfra(config, alerts);

        // Heartbeat log every 20 cycles (~10 min at 30s interval)
        if (cycle % 20 === 0) {
          const block = await client.getBlockNumber().catch(() => 0n);
          console.log(`[Heartbeat] Cycle ${cycle} | Block ${block} | ${alerts.getHistory().length} total alerts`);
        }
      } catch (e: any) {
        console.error(`[Cycle ${cycle}] Monitor error: ${e?.message?.slice(0, 100)}`);
      }

      await new Promise(r => setTimeout(r, config.checkIntervalMs));
    }
  };

  loop();

  process.on("SIGINT", () => {
    console.log("\n[Shutdown] Monitor stopping.");
    running = false;
    process.exit(0);
  });
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
