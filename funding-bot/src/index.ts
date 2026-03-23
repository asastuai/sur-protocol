/**
 * SUR Protocol - Funding Rate Bot
 *
 * Keeps the perpetual price aligned with spot by applying funding rates.
 *
 * How funding works:
 *   - When mark > index (perp premium): longs PAY shorts
 *   - When mark < index (perp discount): shorts PAY longs
 *   - Rate = (markPrice - indexPrice) / indexPrice per interval
 *   - Default interval: 8 hours (28800 seconds)
 *
 * Why this bot exists:
 *   applyFundingRate() is permissionless but someone has to call it.
 *   Without it, funding never settles, and the perp price drifts
 *   away from spot indefinitely. This is a protocol liveness requirement.
 *
 * The bot also:
 *   - Monitors funding rate magnitude (warns when extreme)
 *   - Tracks historical rates for analysis
 *   - Calculates annualized funding rates
 *   - Detects OI imbalance that drives funding
 */

import "dotenv/config";
import {
  createPublicClient, createWalletClient, http, fallback,
  type PublicClient, type WalletClient, type Hex, type Chain,
  keccak256, toHex, formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";

// ============================================================
//                    CONFIG
// ============================================================

interface FundingConfig {
  chain: typeof baseSepolia | typeof base;
  rpcUrl: string;
  engineAddress: Hex;
  keeperPrivateKey: Hex;
  checkIntervalMs: number;   // how often to check if funding is due
  markets: { name: string; id: Hex }[];
}

function loadConfig(): FundingConfig {
  const isTestnet = process.env.NETWORK !== "mainnet";

  const marketNames = (process.env.MARKETS || "BTC-USD,ETH-USD").split(",");
  const markets = marketNames.map(name => ({
    name: name.trim(),
    id: keccak256(toHex(name.trim())) as Hex,
  }));

  // Validate private key
  const pk = process.env.KEEPER_PRIVATE_KEY;
  if (!pk || pk === "0x" || !/^0x[a-fA-F0-9]{64}$/.test(pk)) {
    console.error("[Fatal] KEEPER_PRIVATE_KEY is missing or invalid.");
    console.error("  → Must be a 32-byte hex string (0x + 64 hex chars).");
    console.error("  → Set it in Railway env vars, NOT in .env files.");
    process.exit(1);
  }

  // Validate engine address
  const engineAddr = process.env.ENGINE_ADDRESS;
  if (!engineAddr || engineAddr === "0x" || !/^0x[a-fA-F0-9]{40}$/.test(engineAddr)) {
    console.error(`[Fatal] ENGINE_ADDRESS is missing or invalid (got: "${engineAddr || ""}")`);
    process.exit(1);
  }

  // Validate RPC URL for mainnet
  if (!isTestnet && !process.env.RPC_URL) {
    console.error("[Fatal] RPC_URL is required for mainnet.");
    process.exit(1);
  }

  return {
    chain: isTestnet ? baseSepolia : base,
    rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
    engineAddress: engineAddr as Hex,
    keeperPrivateKey: pk as Hex,
    checkIntervalMs: parseInt(process.env.CHECK_INTERVAL_MS || "30000"), // 30s
    markets,
  };
}

// ============================================================
//                    ABI
// ============================================================

const ENGINE_ABI = [
  {
    type: "function", name: "applyFundingRate", stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "bytes32" }], outputs: [],
  },
  {
    type: "function", name: "markets", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      { name: "id", type: "bytes32" }, { name: "name", type: "string" },
      { name: "active", type: "bool" }, { name: "initialMarginBps", type: "uint256" },
      { name: "maintenanceMarginBps", type: "uint256" }, { name: "maxPositionSize", type: "uint256" },
      { name: "markPrice", type: "uint256" }, { name: "indexPrice", type: "uint256" },
      { name: "lastPriceUpdate", type: "uint256" }, { name: "cumulativeFunding", type: "int256" },
      { name: "lastFundingUpdate", type: "uint256" }, { name: "fundingIntervalSecs", type: "uint256" },
      { name: "openInterestLong", type: "uint256" }, { name: "openInterestShort", type: "uint256" },
    ],
  },
  {
    type: "event", name: "FundingRateUpdated",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "fundingRate", type: "int256", indexed: false },
      { name: "cumulativeFunding", type: "int256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

// ============================================================
//                    FUNDING TRACKER
// ============================================================

interface FundingSnapshot {
  marketName: string;
  markPrice: number;
  indexPrice: number;
  premium: number;       // (mark - index) / index as percentage
  fundingRate: number;   // per interval, as percentage
  annualizedRate: number;
  cumulativeFunding: bigint;
  oiLong: number;
  oiShort: number;
  oiImbalance: number;   // positive = more longs
  lastFundingUpdate: number;
  nextFundingDue: number;
  intervalSecs: number;
  timestamp: number;
}

interface FundingStats {
  totalApplications: number;
  totalGasSpent: bigint;
  history: FundingSnapshot[];   // last N snapshots per market
  startedAt: number;
}

// ============================================================
//                    RETRY WITH BACKOFF
// ============================================================

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, label = "operation" } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), 10_000);
      console.warn(
        `[Retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${(err as Error).message?.slice(0, 80)}`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

const FUNDING_PRECISION = 1e18;
const PRICE_PRECISION = 1e6;
const SIZE_PRECISION = 1e8;
const MAX_HISTORY = 100;

// ============================================================
//                    MAIN
// ============================================================

async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║     SUR Protocol - Funding Rate Bot            ║");
  console.log("║   Applies funding to keep perp aligned w/ spot ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log();

  const config = loadConfig();
  const account = privateKeyToAccount(config.keeperPrivateKey);

  console.log(`[Config] Network:  ${config.chain.name}`);
  console.log(`[Config] Keeper:   ${account.address}`);
  console.log(`[Config] Engine:   ${config.engineAddress}`);
  console.log(`[Config] Markets:  ${config.markets.map(m => m.name).join(", ")}`);
  console.log(`[Config] Check:    every ${config.checkIntervalMs / 1000}s`);
  console.log();

  // Initialize clients (with fallback RPC support)
  const fallbackRpcs = process.env.RPC_URLS_FALLBACK
    ? process.env.RPC_URLS_FALLBACK.split(",").map((u) => u.trim()).filter(Boolean)
    : [];
  const allRpcs = [config.rpcUrl, ...fallbackRpcs];
  const transport = allRpcs.length > 1
    ? fallback(allRpcs.map((url) => http(url, { timeout: 20_000 })), { rank: true })
    : http(config.rpcUrl, { timeout: 30_000 });

  const publicClient = createPublicClient({
    chain: config.chain as Chain, transport,
  });
  const walletClient = createWalletClient({
    account, chain: config.chain as Chain, transport,
  });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`[Keeper] Balance: ${formatEther(balance)} ETH`);
  console.log();

  const stats: FundingStats = {
    totalApplications: 0,
    totalGasSpent: 0n,
    history: [],
    startedAt: Date.now(),
  };

  let running = true;
  let cycle = 0;

  console.log("════════════════════════════════════════════");
  console.log("  FUNDING RATE BOT RUNNING");
  console.log("════════════════════════════════════════════");
  console.log();

  const loop = async () => {
    while (running) {
      cycle++;

      for (const market of config.markets) {
        try {
          // Read market state (with retry)
          const data = await retryWithBackoff(
            () => publicClient.readContract({
              address: config.engineAddress, abi: ENGINE_ABI,
              functionName: "markets", args: [market.id],
            }),
            { maxRetries: 2, baseDelayMs: 500, label: `${market.name} read` }
          );

          const [, , active, , , , markPriceRaw, indexPriceRaw, ,
            cumulativeFunding, lastFundingUpdateRaw, fundingIntervalSecsRaw,
            oiLongRaw, oiShortRaw] = data;

          if (!active) continue;

          const markPrice = Number(markPriceRaw) / PRICE_PRECISION;
          const indexPrice = Number(indexPriceRaw) / PRICE_PRECISION;
          const lastUpdate = Number(lastFundingUpdateRaw);
          const interval = Number(fundingIntervalSecsRaw);
          const oiLong = Number(oiLongRaw) / SIZE_PRECISION;
          const oiShort = Number(oiShortRaw) / SIZE_PRECISION;
          const now = Math.floor(Date.now() / 1000);
          const nextDue = lastUpdate + interval;
          const timeUntilDue = nextDue - now;

          // Calculate current rate
          const premium = indexPrice > 0 ? (markPrice - indexPrice) / indexPrice : 0;
          const fundingRate = premium * 100; // percentage per interval
          const intervalsPerYear = (365.25 * 24 * 3600) / interval;
          const annualized = fundingRate * intervalsPerYear;

          // Build snapshot
          const snapshot: FundingSnapshot = {
            marketName: market.name,
            markPrice, indexPrice, premium: premium * 100,
            fundingRate, annualizedRate: annualized,
            cumulativeFunding, oiLong, oiShort,
            oiImbalance: oiLong - oiShort,
            lastFundingUpdate: lastUpdate, nextFundingDue: nextDue,
            intervalSecs: interval, timestamp: Date.now(),
          };

          // Store history
          stats.history.push(snapshot);
          if (stats.history.length > MAX_HISTORY * config.markets.length) {
            stats.history = stats.history.slice(-MAX_HISTORY * config.markets.length);
          }

          // Check if funding is due
          if (timeUntilDue <= 0) {
            console.log(
              `[${market.name}] 💰 Funding due! Rate: ${fundingRate >= 0 ? "+" : ""}${fundingRate.toFixed(4)}% | ` +
              `Premium: ${premium >= 0 ? "+" : ""}${(premium * 100).toFixed(4)}% | ` +
              `Annualized: ${annualized >= 0 ? "+" : ""}${annualized.toFixed(2)}%`
            );

            // Apply funding (with retry)
            try {
              const hash = await retryWithBackoff(
                () => walletClient.writeContract({
                  address: config.engineAddress, abi: ENGINE_ABI,
                  functionName: "applyFundingRate", args: [market.id],
                }),
                { maxRetries: 2, label: `${market.name} funding tx` }
              );

              const receipt = await publicClient.waitForTransactionReceipt({
                hash, timeout: 30_000,
              });

              if (receipt.status !== "success") {
                console.error(`[${market.name}] ❌ Funding tx reverted: ${hash}`);
                continue;
              }

              const gasCost = receipt.gasUsed * (receipt.effectiveGasPrice || 0n);
              stats.totalApplications++;
              stats.totalGasSpent += gasCost;

              const direction = fundingRate >= 0 ? "Longs → Shorts" : "Shorts → Longs";
              console.log(
                `[${market.name}] ✅ Funding applied! ${direction} | ` +
                `tx: ${hash.slice(0, 14)}... | gas: ${formatEther(gasCost)} ETH`
              );
            } catch (err: any) {
              console.error(`[${market.name}] ❌ Apply failed: ${err?.shortMessage || err?.message}`);
            }
          } else if (cycle % 20 === 0) {
            // Periodic status log (~every 10min at 30s interval)
            const minsUntil = (timeUntilDue / 60).toFixed(0);
            const rateLabel = fundingRate >= 0 ? "+" : "";
            const imbalanceLabel = snapshot.oiImbalance > 0 ? `+${snapshot.oiImbalance.toFixed(2)} long heavy` : `${snapshot.oiImbalance.toFixed(2)} short heavy`;

            console.log(
              `[${market.name}] Rate: ${rateLabel}${fundingRate.toFixed(4)}% (${rateLabel}${annualized.toFixed(1)}% ann.) | ` +
              `Mark: $${markPrice.toFixed(2)} Index: $${indexPrice.toFixed(2)} | ` +
              `OI: ${oiLong.toFixed(2)}L/${oiShort.toFixed(2)}S (${imbalanceLabel}) | ` +
              `Next funding in ${minsUntil}m`
            );

            // Warnings for extreme rates
            if (Math.abs(annualized) > 100) {
              console.warn(`[${market.name}] ⚠️  EXTREME funding rate: ${annualized.toFixed(1)}% annualized!`);
            }
            if (Math.abs(premium) > 0.02) {
              console.warn(`[${market.name}] ⚠️  Large premium: ${(premium * 100).toFixed(2)}% — mark diverging from index`);
            }
          }
        } catch (err: any) {
          console.error(`[${market.name}] Error: ${err?.shortMessage || err?.message}`);
        }
      }

      // Stats log every 120 cycles (~1hr at 30s interval)
      if (cycle % 120 === 0) {
        const uptimeH = ((Date.now() - stats.startedAt) / 3600000).toFixed(1);
        console.log(
          `[Stats] Uptime: ${uptimeH}h | Applications: ${stats.totalApplications} | ` +
          `Gas: ${formatEther(stats.totalGasSpent)} ETH`
        );
      }

      await sleep(config.checkIntervalMs);
    }
  };

  loop();

  // ---- Health Check + Metrics Server ----
  const healthPort = parseInt(process.env.HEALTH_PORT || "3012");
  const healthServer = require("http").createServer((req: any, res: any) => {
    const uptimeSec = Math.floor((Date.now() - stats.startedAt) / 1000);

    if (req.url === "/metrics") {
      // Get last snapshot per market for rate info
      const latestByMarket = new Map<string, typeof stats.history[0]>();
      for (const snap of stats.history) {
        latestByMarket.set(snap.marketName, snap);
      }

      const lines = [
        "# HELP sur_funding_uptime_seconds Funding bot uptime",
        "# TYPE sur_funding_uptime_seconds gauge",
        `sur_funding_uptime_seconds ${uptimeSec}`,
        "",
        "# HELP sur_funding_applications_total Total funding applications",
        "# TYPE sur_funding_applications_total counter",
        `sur_funding_applications_total ${stats.totalApplications}`,
        "",
        "# HELP sur_funding_gas_spent_eth Total gas in ETH",
        "# TYPE sur_funding_gas_spent_eth counter",
        `sur_funding_gas_spent_eth ${Number(stats.totalGasSpent) / 1e18}`,
        "",
        ...[...latestByMarket.entries()].flatMap(([name, snap]) => [
          `sur_funding_rate_pct{market="${name}"} ${snap.fundingRate}`,
          `sur_funding_annualized_pct{market="${name}"} ${snap.annualizedRate}`,
          `sur_funding_premium_pct{market="${name}"} ${snap.premium}`,
          `sur_funding_oi_long{market="${name}"} ${snap.oiLong}`,
          `sur_funding_oi_short{market="${name}"} ${snap.oiShort}`,
        ]),
        "",
      ];
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(lines.join("\n"));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "sur-funding-bot",
      uptime: uptimeSec,
      totalApplications: stats.totalApplications,
      gasSpent: formatEther(stats.totalGasSpent),
      markets: config.markets.map((m) => m.name),
    }));
  });
  healthServer.listen(healthPort, () => {
    console.log(`[Health] http://localhost:${healthPort}/`);
  });

  process.on("SIGINT", () => {
    console.log(`\n[Shutdown] ${stats.totalApplications} funding applications, ${formatEther(stats.totalGasSpent)} ETH spent`);
    running = false;
    process.exit(0);
  });
  process.on("SIGTERM", () => { running = false; process.exit(0); });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
