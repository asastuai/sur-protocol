/**
 * SUR Protocol - Liquidation Keeper Bot
 *
 * Automated bot that:
 * 1. Indexes all open positions from PerpEngine events
 * 2. Monitors them every N seconds for liquidation eligibility
 * 3. Executes liquidations via Liquidator.sol (permissionless)
 * 4. Earns keeper rewards (50% of remaining margin, capped at 5% notional)
 *
 * Architecture:
 *   PositionTracker  →  scans PerpEngine events  → in-memory position registry
 *   LiquidationScanner → multicall isLiquidatable() → execute via Liquidator.sol
 *
 * Revenue model:
 *   Healthy liquidation:  ~50% of remaining margin (can be $100-$5,000+ per liq)
 *   Underwater liquidation: 0.05% of notional from insurance fund (~$25 on $50k pos)
 *   Cost: ~$0.01-0.05 gas per liquidation on Base L2
 *
 * Usage:
 *   cd keeper
 *   cp .env.example .env  # configure
 *   npm install
 *   npm run dev            # development with auto-reload
 *   npm start              # production
 */

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  type Hex,
  type Chain,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { PositionTracker } from "./tracker.js";
import { LiquidationScanner } from "./scanner.js";

// ============================================================
//                    CONFIGURATION
// ============================================================

interface KeeperConfig {
  chain: typeof baseSepolia | typeof base;
  rpcUrl: string;
  rpcUrlWs?: string;

  engineAddress: Hex;
  liquidatorAddress: Hex;
  vaultAddress: Hex;

  keeperPrivateKey: Hex;

  // Scan interval in milliseconds
  scanIntervalMs: number;

  // How far back to sync events on startup (block number)
  syncFromBlock: bigint;

  // Maximum batch size for liquidations
  maxBatchSize: number;

  // Minimum reward threshold (don't liquidate if reward < this, in USDC 6 dec)
  minRewardThreshold: bigint;

  // Markets to monitor
  marketNames: string[];
}

function loadConfig(): KeeperConfig {
  const isTestnet = process.env.NETWORK !== "mainnet";

  // Validate private key
  const pk = process.env.KEEPER_PRIVATE_KEY;
  if (!pk || pk === "0x" || !/^0x[a-fA-F0-9]{64}$/.test(pk)) {
    console.error("[Fatal] KEEPER_PRIVATE_KEY is missing or invalid.");
    console.error("  → Must be a 32-byte hex string (0x + 64 hex chars).");
    console.error("  → Set it in Railway env vars, NOT in .env files.");
    process.exit(1);
  }

  // Validate required contract addresses
  for (const [name, value] of Object.entries({
    ENGINE_ADDRESS: process.env.ENGINE_ADDRESS,
    LIQUIDATOR_ADDRESS: process.env.LIQUIDATOR_ADDRESS,
  })) {
    if (!value || value === "0x" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
      console.error(`[Fatal] ${name} is missing or invalid (got: "${value || ""}")`);
      process.exit(1);
    }
  }

  // Validate RPC URL for mainnet
  if (!isTestnet && !process.env.RPC_URL) {
    console.error("[Fatal] RPC_URL is required for mainnet.");
    process.exit(1);
  }

  return {
    chain: isTestnet ? baseSepolia : base,
    rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
    rpcUrlWs: process.env.RPC_URL_WS,

    engineAddress: process.env.ENGINE_ADDRESS as Hex,
    liquidatorAddress: process.env.LIQUIDATOR_ADDRESS as Hex,
    vaultAddress: (process.env.VAULT_ADDRESS || "0x") as Hex,

    keeperPrivateKey: pk as Hex,

    scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || "5000"),
    syncFromBlock: BigInt(process.env.SYNC_FROM_BLOCK || "0"),
    maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE || "10"),
    minRewardThreshold: BigInt(process.env.MIN_REWARD_USDC || "100000"), // $0.10

    marketNames: (process.env.MARKETS || "BTC-USD,ETH-USD").split(","),
  };
}

// ============================================================
//                     MAIN
// ============================================================

async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║     SUR Protocol - Liquidation Keeper Bot      ║");
  console.log("║   Automated position monitoring & liquidation  ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log();

  const config = loadConfig();
  const account = privateKeyToAccount(config.keeperPrivateKey);

  console.log(`[Config] Network:    ${config.chain.name}`);
  console.log(`[Config] Keeper:     ${account.address}`);
  console.log(`[Config] Engine:     ${config.engineAddress}`);
  console.log(`[Config] Liquidator: ${config.liquidatorAddress}`);
  console.log(`[Config] Scan every: ${config.scanIntervalMs}ms`);
  console.log(`[Config] Markets:    ${config.marketNames.join(", ")}`);
  console.log();

  // Initialize clients (with fallback RPC support)
  const fallbackRpcs = process.env.RPC_URLS_FALLBACK
    ? process.env.RPC_URLS_FALLBACK.split(",").map((u) => u.trim()).filter(Boolean)
    : [];
  const allRpcs = [config.rpcUrl, ...fallbackRpcs];
  const transport = allRpcs.length > 1
    ? fallback(allRpcs.map((url) => http(url, { timeout: 20_000 })), { rank: true })
    : http(config.rpcUrl, { timeout: 30_000 });

  if (fallbackRpcs.length > 0) {
    console.log(`[Config] RPC fallbacks: ${fallbackRpcs.length} backup(s)`);
  }

  const publicClient = createPublicClient({
    chain: config.chain as Chain,
    transport,
  });

  const walletClient = createWalletClient({
    account,
    chain: config.chain as Chain,
    transport,
  });

  // Check keeper balance
  const balance = await publicClient.getBalance({ address: account.address });
  const balEth = Number(balance) / 1e18;
  console.log(`[Keeper] ETH balance: ${balEth.toFixed(6)} ETH`);

  if (balEth < 0.001) {
    console.warn("[Keeper] ⚠️  Low ETH balance! Need gas to execute liquidations.");
    console.warn("[Keeper] Fund your keeper address with ETH on Base.");
  }

  // Check current block
  const currentBlock = await publicClient.getBlockNumber();
  console.log(`[Chain] Current block: ${currentBlock}`);
  console.log();

  // Initialize components
  const tracker = new PositionTracker(publicClient, config.engineAddress);
  const scanner = new LiquidationScanner(
    publicClient,
    walletClient,
    tracker,
    config.engineAddress,
    config.liquidatorAddress,
    account.address,
  );

  // Sync historical positions
  console.log("[Boot] Phase 1: Syncing historical positions...");
  const syncFrom = config.syncFromBlock > 0n
    ? config.syncFromBlock
    : currentBlock > 10000n ? currentBlock - 10000n : 0n;

  try {
    await tracker.syncFromEvents(syncFrom);
  } catch (err) {
    console.warn("[Boot] Event sync failed (expected if no events yet):", (err as Error).message);
  }

  // Start watching real-time events
  console.log("[Boot] Phase 2: Starting real-time event watcher...");
  try {
    await tracker.watchEvents();
  } catch (err) {
    console.warn("[Boot] Event watching failed (will rely on periodic re-sync):", (err as Error).message);
  }

  console.log();
  console.log("════════════════════════════════════════════");
  console.log("  KEEPER BOT RUNNING");
  console.log(`  Monitoring ${tracker.positionCount()} positions`);
  console.log(`  Scanning every ${config.scanIntervalMs / 1000}s`);
  console.log("════════════════════════════════════════════");
  console.log();

  // ---- Main Loop ----
  let running = true;
  let scanCount = 0;

  const scanLoop = async () => {
    while (running) {
      scanCount++;

      try {
        // Scan for liquidatable positions
        const candidates = await scanner.scan();

        if (candidates.length > 0) {
          console.log(
            `[Scan #${scanCount}] 🎯 Found ${candidates.length} liquidatable position(s)!`
          );

          for (const c of candidates) {
            const sideLabel = c.size > 0n ? "LONG" : "SHORT";
            const sizeNum = Number(c.size > 0n ? c.size : -c.size) / 1e8;
            const rewardNum = Number(c.estimatedReward) / 1e6;
            console.log(
              `  → ${c.trader.slice(0, 10)}... ${sideLabel} ${sizeNum.toFixed(4)} | ` +
              `margin: $${(Number(c.margin) / 1e6).toFixed(2)} | ` +
              `est. reward: $${rewardNum.toFixed(2)}`
            );
          }

          // Filter by minimum reward
          const worthwhile = candidates.filter(
            c => c.estimatedReward >= config.minRewardThreshold
          );

          if (worthwhile.length > 0) {
            // Execute liquidations (capped at maxBatchSize)
            const batch = worthwhile.slice(0, config.maxBatchSize);
            console.log(`[Execute] Liquidating ${batch.length} position(s)...`);

            const results = await scanner.executeLiquidations(batch);

            for (const r of results) {
              if (r.success) {
                console.log(
                  `  ✅ ${r.trader.slice(0, 10)}... liquidated | ` +
                  `tx: ${r.txHash?.slice(0, 14)}... | ` +
                  `reward: ~$${(Number(r.reward || 0n) / 1e6).toFixed(2)}`
                );
              } else {
                console.log(
                  `  ❌ ${r.trader.slice(0, 10)}... failed: ${r.error}`
                );
              }
            }
          } else {
            console.log(`[Scan #${scanCount}] Rewards below threshold, skipping.`);
          }
        } else if (scanCount % 12 === 0) {
          // Log stats every ~1 minute (at 5s interval)
          console.log(`[Stats] ${scanner.formatStats()}`);
        }
      } catch (err) {
        console.error(`[Scan #${scanCount}] Error:`, (err as Error).message);
      }

      // Wait for next scan
      await sleep(config.scanIntervalMs);
    }
  };

  // Start scanning
  scanLoop();

  // ---- Health Check + Metrics Server ----
  const healthPort = parseInt(process.env.HEALTH_PORT || "3010");
  const healthServer = require("http").createServer((req: any, res: any) => {
    const s = scanner.getStats();
    const uptimeSec = Math.floor((Date.now() - s.startedAt) / 1000);

    if (req.url === "/metrics") {
      const lines = [
        "# HELP sur_keeper_uptime_seconds Keeper uptime",
        "# TYPE sur_keeper_uptime_seconds gauge",
        `sur_keeper_uptime_seconds ${uptimeSec}`,
        "",
        "# HELP sur_keeper_scans_total Total scans performed",
        "# TYPE sur_keeper_scans_total counter",
        `sur_keeper_scans_total ${s.totalScans}`,
        "",
        "# HELP sur_keeper_liquidations_total Successful liquidations",
        "# TYPE sur_keeper_liquidations_total counter",
        `sur_keeper_liquidations_total ${s.totalLiquidations}`,
        "",
        "# HELP sur_keeper_liquidations_failed_total Failed liquidations",
        "# TYPE sur_keeper_liquidations_failed_total counter",
        `sur_keeper_liquidations_failed_total ${s.totalFailed}`,
        "",
        "# HELP sur_keeper_tracked_positions Currently tracked positions",
        "# TYPE sur_keeper_tracked_positions gauge",
        `sur_keeper_tracked_positions ${tracker.positionCount()}`,
        "",
        "# HELP sur_keeper_reward_usdc_total Total USDC rewards earned",
        "# TYPE sur_keeper_reward_usdc_total counter",
        `sur_keeper_reward_usdc_total ${Number(s.totalRewardEarned) / 1e6}`,
        "",
        "# HELP sur_keeper_gas_spent_eth Total gas spent in ETH",
        "# TYPE sur_keeper_gas_spent_eth counter",
        `sur_keeper_gas_spent_eth ${Number(s.totalGasSpent) / 1e18}`,
        "",
      ];
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(lines.join("\n"));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "sur-keeper",
      uptime: uptimeSec,
      scans: s.totalScans,
      liquidations: s.totalLiquidations,
      failed: s.totalFailed,
      trackedPositions: tracker.positionCount(),
    }));
  });
  healthServer.listen(healthPort, () => {
    console.log(`[Health] http://localhost:${healthPort}/`);
  });

  // ---- Graceful Shutdown ----
  const shutdown = () => {
    console.log("\n[Shutdown] Stopping keeper bot...");
    running = false;
    console.log(`[Shutdown] Final stats: ${scanner.formatStats()}`);
    console.log("[Shutdown] Done. Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
