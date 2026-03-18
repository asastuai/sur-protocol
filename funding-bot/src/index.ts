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
  createPublicClient, createWalletClient, http,
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

  return {
    chain: isTestnet ? baseSepolia : base,
    rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
    engineAddress: (process.env.ENGINE_ADDRESS || "0x") as Hex,
    keeperPrivateKey: (process.env.KEEPER_PRIVATE_KEY || "0x") as Hex,
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

  const publicClient = createPublicClient({
    chain: config.chain as Chain, transport: http(config.rpcUrl),
  });
  const walletClient = createWalletClient({
    account, chain: config.chain as Chain, transport: http(config.rpcUrl),
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
          // Read market state
          const data = await publicClient.readContract({
            address: config.engineAddress, abi: ENGINE_ABI,
            functionName: "markets", args: [market.id],
          });

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

            // Apply funding
            try {
              const hash = await walletClient.writeContract({
                address: config.engineAddress, abi: ENGINE_ABI,
                functionName: "applyFundingRate", args: [market.id],
              });

              const receipt = await publicClient.waitForTransactionReceipt({ hash });
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
