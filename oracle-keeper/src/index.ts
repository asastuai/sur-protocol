/**
 * SUR Protocol - Oracle Price Keeper
 *
 * The heartbeat of the protocol. Without fresh prices:
 * - No trades execute (PerpEngine rejects with StalePrice)
 * - No liquidations trigger (isLiquidatable uses markPrice)
 * - The entire protocol is frozen
 *
 * This keeper:
 * 1. Fetches price updates from Pyth Hermes API (off-chain, free)
 * 2. Submits them to OracleRouter.pushPriceBatchWithPyth() on Base L2
 * 3. Loops every PUSH_INTERVAL_MS (default 5s)
 * 4. Tracks gas costs and monitors price health
 *
 * Pyth Architecture:
 *   Pyth is PULL-based. Prices are published off-chain by Pyth publishers.
 *   To use them on-chain, you must:
 *   1. Fetch the latest VAA (Verified Action Approval) from Hermes API
 *   2. Submit it to the Pyth contract on-chain (costs a small fee in ETH)
 *   3. Then read the price from the Pyth contract
 *   OracleRouter.pushPriceBatchWithPyth() does steps 2+3 in one tx.
 *
 * Usage:
 *   cd oracle-keeper
 *   npm install
 *   cp .env.example .env  # configure
 *   npm run dev
 */

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type Chain,
  keccak256,
  toHex,
  formatEther,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";

// ============================================================
//                    CONFIGURATION
// ============================================================

interface OracleKeeperConfig {
  chain: typeof baseSepolia | typeof base;
  rpcUrl: string;
  oracleRouterAddress: Hex;
  keeperPrivateKey: Hex;
  pushIntervalMs: number;
  hermesUrl: string;
  markets: MarketFeedConfig[];
  maxGasPriceGwei: number;
  minBalanceEth: number;
}

interface MarketFeedConfig {
  name: string;
  marketId: Hex;
  pythFeedId: Hex;
}

function loadConfig(): OracleKeeperConfig {
  const isTestnet = process.env.NETWORK !== "mainnet";

  const markets: MarketFeedConfig[] = [];

  // BTC-USD
  markets.push({
    name: "BTC-USD",
    marketId: keccak256(toHex("BTC-USD")) as Hex,
    pythFeedId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" as Hex,
  });

  // ETH-USD
  markets.push({
    name: "ETH-USD",
    marketId: keccak256(toHex("ETH-USD")) as Hex,
    pythFeedId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" as Hex,
  });

  return {
    chain: isTestnet ? baseSepolia : base,
    rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
    oracleRouterAddress: (process.env.ORACLE_ROUTER_ADDRESS || "0x") as Hex,
    keeperPrivateKey: (process.env.KEEPER_PRIVATE_KEY || "0x") as Hex,
    pushIntervalMs: parseInt(process.env.PUSH_INTERVAL_MS || "5000"),
    hermesUrl: process.env.HERMES_URL || "https://hermes.pyth.network",
    markets,
    maxGasPriceGwei: parseInt(process.env.MAX_GAS_PRICE_GWEI || "50"),
    minBalanceEth: parseFloat(process.env.MIN_BALANCE_ETH || "0.005"),
  };
}

// ============================================================
//                    CONTRACT ABI
// ============================================================

const ORACLE_ROUTER_ABI = [
  {
    type: "function",
    name: "pushPriceBatchWithPyth",
    stateMutability: "payable",
    inputs: [
      { name: "marketIds", type: "bytes32[]" },
      { name: "pythUpdateData", type: "bytes[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "pushPriceWithPyth",
    stateMutability: "payable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "pythUpdateData", type: "bytes[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getLastPrice",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      { name: "markPrice", type: "uint256" },
      { name: "indexPrice", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "isPriceFresh",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const PYTH_ABI = [
  {
    type: "function",
    name: "getUpdateFee",
    stateMutability: "view",
    inputs: [{ name: "updateData", type: "bytes[]" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// Pyth contract on Base Sepolia
const PYTH_ADDRESS: Record<number, Hex> = {
  84532: "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729", // Base Sepolia
  8453: "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",  // Base Mainnet
};

// ============================================================
//                    HERMES CLIENT
// ============================================================

async function fetchPythPriceUpdates(
  hermesUrl: string,
  feedIds: Hex[]
): Promise<{ updateData: Hex[]; prices: Map<string, { price: number; conf: number }> }> {
  // Pyth Hermes v2 API
  const ids = feedIds.map((id) => id.slice(2)); // remove 0x prefix
  const url = `${hermesUrl}/v2/updates/price/latest?${ids.map((id) => `ids[]=${id}`).join("&")}&encoding=hex&parsed=true`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Hermes API error: ${resp.status} ${resp.statusText}`);

  const data = await resp.json();

  // Extract binary update data (VAAs)
  const updateData: Hex[] = data.binary.data.map((d: string) => `0x${d}` as Hex);

  // Extract parsed prices for logging
  const prices = new Map<string, { price: number; conf: number }>();
  for (const parsed of data.parsed || []) {
    const feedId = "0x" + parsed.id;
    const priceData = parsed.price;
    const expo = priceData.expo;
    const price = Number(priceData.price) * Math.pow(10, expo);
    const conf = Number(priceData.conf) * Math.pow(10, expo);
    prices.set(feedId, { price, conf });
  }

  return { updateData, prices };
}

// ============================================================
//                    KEEPER STATS
// ============================================================

interface Stats {
  totalPushes: number;
  totalFailed: number;
  totalGasSpent: bigint;
  totalPythFees: bigint;
  lastPushTime: number;
  lastPrices: Map<string, number>;
  startedAt: number;
}

function formatStats(stats: Stats, balance: bigint): string {
  const uptimeH = ((Date.now() - stats.startedAt) / 3600000).toFixed(1);
  const totalSpent = stats.totalGasSpent + stats.totalPythFees;
  const priceStr = [...stats.lastPrices.entries()]
    .map(([name, price]) => `${name}: $${price.toFixed(2)}`)
    .join(" | ");

  return [
    `Uptime: ${uptimeH}h`,
    `Pushes: ${stats.totalPushes} (${stats.totalFailed} failed)`,
    `Spent: ${formatEther(totalSpent)} ETH`,
    `Balance: ${formatEther(balance)} ETH`,
    priceStr,
  ].join(" | ");
}

// ============================================================
//                    MAIN
// ============================================================

async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║     SUR Protocol - Oracle Price Keeper         ║");
  console.log("║   Pushes Pyth prices to OracleRouter on Base  ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log();

  const config = loadConfig();
  const account = privateKeyToAccount(config.keeperPrivateKey);

  console.log(`[Config] Network:       ${config.chain.name}`);
  console.log(`[Config] Keeper:        ${account.address}`);
  console.log(`[Config] OracleRouter:  ${config.oracleRouterAddress}`);
  console.log(`[Config] Push interval: ${config.pushIntervalMs}ms`);
  console.log(`[Config] Hermes:        ${config.hermesUrl}`);
  console.log(`[Config] Markets:       ${config.markets.map((m) => m.name).join(", ")}`);
  console.log();

  const publicClient = createPublicClient({
    chain: config.chain as Chain,
    transport: http(config.rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: config.chain as Chain,
    transport: http(config.rpcUrl),
  });

  const pythAddress = PYTH_ADDRESS[config.chain.id];
  if (!pythAddress) {
    console.error(`[Fatal] No Pyth address for chain ${config.chain.id}`);
    process.exit(1);
  }

  // Check balance
  let balance = await publicClient.getBalance({ address: account.address });
  console.log(`[Keeper] ETH balance: ${formatEther(balance)} ETH`);
  if (Number(formatEther(balance)) < config.minBalanceEth) {
    console.warn(`[Keeper] ⚠️  Low balance! Need at least ${config.minBalanceEth} ETH for gas + Pyth fees.`);
  }

  // Stats
  const stats: Stats = {
    totalPushes: 0,
    totalFailed: 0,
    totalGasSpent: 0n,
    totalPythFees: 0n,
    lastPushTime: 0,
    lastPrices: new Map(),
    startedAt: Date.now(),
  };

  console.log();
  console.log("════════════════════════════════════════════");
  console.log("  ORACLE KEEPER RUNNING");
  console.log("════════════════════════════════════════════");
  console.log();

  // ---- Main Loop ----
  let running = true;
  let cycle = 0;

  const pushLoop = async () => {
    while (running) {
      cycle++;

      try {
        // 1. Fetch prices from Hermes
        const feedIds = config.markets.map((m) => m.pythFeedId);
        const { updateData, prices } = await fetchPythPriceUpdates(config.hermesUrl, feedIds);

        // Log prices
        for (const m of config.markets) {
          const p = prices.get(m.pythFeedId);
          if (p) {
            stats.lastPrices.set(m.name, p.price);
          }
        }

        // 2. Estimate Pyth update fee
        const pythFee = await publicClient.readContract({
          address: pythAddress,
          abi: PYTH_ABI,
          functionName: "getUpdateFee",
          args: [updateData],
        });

        // Add 10% buffer to fee
        const feeWithBuffer = pythFee + pythFee / 10n;

        // 3. Check gas price
        const gasPrice = await publicClient.getGasPrice();
        const gasPriceGwei = Number(gasPrice) / 1e9;

        if (gasPriceGwei > config.maxGasPriceGwei) {
          console.warn(`[Cycle ${cycle}] Gas too high: ${gasPriceGwei.toFixed(1)} gwei > ${config.maxGasPriceGwei} max. Skipping.`);
          await sleep(config.pushIntervalMs);
          continue;
        }

        // 4. Simulate tx first
        const marketIds = config.markets.map((m) => m.marketId);

        try {
          await publicClient.simulateContract({
            address: config.oracleRouterAddress,
            abi: ORACLE_ROUTER_ABI,
            functionName: "pushPriceBatchWithPyth",
            args: [marketIds, updateData],
            value: feeWithBuffer,
            account: account.address,
          });
        } catch (simErr: any) {
          // Common: "Price not changed enough" or "Feed not active"
          // These are expected — just log and continue
          const reason = simErr?.shortMessage || simErr?.message || "unknown";
          if (cycle % 6 === 0) {
            console.log(`[Cycle ${cycle}] Sim skipped: ${reason.slice(0, 80)}`);
          }
          await sleep(config.pushIntervalMs);
          continue;
        }

        // 5. Submit tx
        const hash = await walletClient.writeContract({
          address: config.oracleRouterAddress,
          abi: ORACLE_ROUTER_ABI,
          functionName: "pushPriceBatchWithPyth",
          args: [marketIds, updateData],
          value: feeWithBuffer,
        });

        // 6. Wait for confirmation
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const gasCost = receipt.gasUsed * (receipt.effectiveGasPrice || gasPrice);

        stats.totalPushes++;
        stats.totalGasSpent += gasCost;
        stats.totalPythFees += pythFee;
        stats.lastPushTime = Date.now();

        // Format price log
        const priceLog = config.markets
          .map((m) => {
            const p = prices.get(m.pythFeedId);
            return p ? `${m.name}: $${p.price.toFixed(2)}` : m.name;
          })
          .join(" | ");

        console.log(
          `[Push #${stats.totalPushes}] ✅ ${priceLog} | ` +
          `gas: ${formatEther(gasCost)} ETH | ` +
          `pyth fee: ${formatEther(pythFee)} ETH | ` +
          `tx: ${hash.slice(0, 14)}...`
        );

        // Refresh balance periodically
        if (stats.totalPushes % 10 === 0) {
          balance = await publicClient.getBalance({ address: account.address });
          if (Number(formatEther(balance)) < config.minBalanceEth) {
            console.warn(`[Keeper] ⚠️  Balance low: ${formatEther(balance)} ETH. Refill soon!`);
          }
        }
      } catch (err: any) {
        stats.totalFailed++;
        const msg = err?.shortMessage || err?.message || String(err);
        console.error(`[Cycle ${cycle}] ❌ Push failed: ${msg.slice(0, 120)}`);
      }

      // Stats every 60 cycles (~5 min at 5s interval)
      if (cycle % 60 === 0) {
        balance = await publicClient.getBalance({ address: account.address }).catch(() => balance);
        console.log(`[Stats] ${formatStats(stats, balance)}`);
      }

      await sleep(config.pushIntervalMs);
    }
  };

  pushLoop();

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[Shutdown] Stopping oracle keeper...");
    running = false;
    console.log(`[Shutdown] Final: ${stats.totalPushes} pushes, ${formatEther(stats.totalGasSpent + stats.totalPythFees)} ETH spent`);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
