/**
 * SUR Keeper - Liquidation Scanner & Executor
 *
 * Two-phase approach:
 *   1. SCAN: Check all tracked positions for liquidation eligibility
 *      - Uses multicall to batch isLiquidatable() checks (gas-efficient)
 *      - Sorts candidates by profitability (larger positions first)
 *
 *   2. EXECUTE: Call Liquidator.liquidateBatch() for confirmed candidates
 *      - Simulates tx first to catch reverts before wasting gas
 *      - Tracks gas costs vs keeper rewards for P&L
 *      - Retries failed liquidations once (price might have moved)
 */

import {
  type PublicClient,
  type WalletClient,
  type Hex,
  type Chain,
  encodeFunctionData,
  decodeFunctionResult,
} from "viem";
import { ENGINE_ABI, LIQUIDATOR_ABI } from "./abis.js";
import type { TrackedPosition, PositionTracker } from "./tracker.js";

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

// ============================================================
//                    TYPES
// ============================================================

export interface LiquidationCandidate {
  marketId: Hex;
  trader: Hex;
  size: bigint;
  margin: bigint;
  estimatedReward: bigint; // rough estimate: margin / 2
}

export interface LiquidationResult {
  success: boolean;
  marketId: Hex;
  trader: Hex;
  txHash?: Hex;
  gasUsed?: bigint;
  reward?: bigint;
  error?: string;
  timestamp: number;
}

export interface KeeperStats {
  totalScans: number;
  totalLiquidations: number;
  totalFailed: number;
  totalRewardEarned: bigint;  // USDC (6 dec)
  totalGasSpent: bigint;      // wei
  uptimeMs: number;
  startedAt: number;
}

// ============================================================
//                    SCANNER
// ============================================================

export class LiquidationScanner {
  private client: PublicClient;
  private walletClient: WalletClient;
  private tracker: PositionTracker;

  private engineAddress: Hex;
  private liquidatorAddress: Hex;
  private keeperAddress: Hex;

  // Stats
  stats: KeeperStats;
  private results: LiquidationResult[] = [];

  constructor(
    client: PublicClient,
    walletClient: WalletClient,
    tracker: PositionTracker,
    engineAddress: Hex,
    liquidatorAddress: Hex,
    keeperAddress: Hex,
  ) {
    this.client = client;
    this.walletClient = walletClient;
    this.tracker = tracker;
    this.engineAddress = engineAddress;
    this.liquidatorAddress = liquidatorAddress;
    this.keeperAddress = keeperAddress;

    this.stats = {
      totalScans: 0,
      totalLiquidations: 0,
      totalFailed: 0,
      totalRewardEarned: 0n,
      totalGasSpent: 0n,
      uptimeMs: 0,
      startedAt: Date.now(),
    };
  }

  // ============================================================
  //                     SCAN
  // ============================================================

  async scan(): Promise<LiquidationCandidate[]> {
    this.stats.totalScans++;
    const positions = this.tracker.getAllPositions();

    if (positions.length === 0) return [];

    // Batch check isLiquidatable via multicall
    const calls = positions.map((pos) => ({
      address: this.engineAddress,
      abi: ENGINE_ABI,
      functionName: "isLiquidatable" as const,
      args: [pos.marketId, pos.trader] as readonly [Hex, Hex],
    }));

    let results: boolean[];
    try {
      const multicallResults = await this.client.multicall({ contracts: calls });
      results = multicallResults.map((r) =>
        r.status === "success" ? (r.result as boolean) : false
      );
    } catch (err) {
      // Fallback: check individually
      console.warn("[Scanner] Multicall failed, checking individually...");
      results = await Promise.all(
        positions.map(async (pos) => {
          try {
            return await this.client.readContract({
              address: this.engineAddress,
              abi: ENGINE_ABI,
              functionName: "isLiquidatable",
              args: [pos.marketId, pos.trader],
            });
          } catch {
            return false;
          }
        })
      );
    }

    // Collect candidates
    const candidates: LiquidationCandidate[] = [];
    for (let i = 0; i < positions.length; i++) {
      if (results[i]) {
        const pos = positions[i];
        candidates.push({
          marketId: pos.marketId,
          trader: pos.trader,
          size: pos.size,
          margin: pos.margin,
          estimatedReward: pos.margin / 2n, // rough: 50% of margin
        });
      }
    }

    // Sort by estimated reward (biggest first — more profitable)
    candidates.sort((a, b) => {
      if (b.estimatedReward > a.estimatedReward) return 1;
      if (b.estimatedReward < a.estimatedReward) return -1;
      return 0;
    });

    return candidates;
  }

  // ============================================================
  //                     EXECUTE
  // ============================================================

  async executeLiquidations(candidates: LiquidationCandidate[]): Promise<LiquidationResult[]> {
    if (candidates.length === 0) return [];

    const results: LiquidationResult[] = [];

    if (candidates.length === 1) {
      // Single liquidation — use liquidate() (simpler, cheaper gas)
      const result = await this.executeSingle(candidates[0]);
      results.push(result);
    } else {
      // Batch liquidation — use liquidateBatch()
      const batchResult = await this.executeBatch(candidates);
      results.push(...batchResult);
    }

    // Update stats
    for (const r of results) {
      if (r.success) {
        this.stats.totalLiquidations++;
        if (r.reward) this.stats.totalRewardEarned += r.reward;
      } else {
        this.stats.totalFailed++;
      }
      if (r.gasUsed) this.stats.totalGasSpent += r.gasUsed;
    }

    this.results.push(...results);
    return results;
  }

  private async executeSingle(candidate: LiquidationCandidate): Promise<LiquidationResult> {
    const { marketId, trader } = candidate;

    try {
      // Check if trader is in cross-margin mode
      const marginMode = await this.client.readContract({
        address: this.engineAddress,
        abi: ENGINE_ABI,
        functionName: "traderMarginMode",
        args: [trader],
      }).catch(() => 0);

      const isCross = Number(marginMode) === 1; // 1 = CROSS

      if (isCross) {
        // Cross-margin: liquidate entire account
        await this.client.simulateContract({
          address: this.liquidatorAddress,
          abi: LIQUIDATOR_ABI,
          functionName: "liquidateAccount",
          args: [trader],
          account: this.keeperAddress,
        });

        const hash = await this.walletClient.writeContract({
          address: this.liquidatorAddress,
          abi: LIQUIDATOR_ABI,
          functionName: "liquidateAccount",
          args: [trader],
          chain: this.walletClient.chain,
          account: this.keeperAddress,
        });

        const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
        this.tracker.verifyPosition(marketId, trader);
        const gasUsed = receipt.gasUsed * (receipt.effectiveGasPrice || 0n);

        console.log(`[Liquidator] Cross-margin account liquidated: ${trader.slice(0, 10)}... | tx: ${hash.slice(0, 14)}...`);

        return { success: receipt.status === "success", marketId, trader, txHash: hash, gasUsed, reward: candidate.estimatedReward, timestamp: Date.now() };
      }

      // Isolated mode: liquidate single position
      await this.client.simulateContract({
        address: this.liquidatorAddress,
        abi: LIQUIDATOR_ABI,
        functionName: "liquidate",
        args: [marketId, trader],
        account: this.keeperAddress,
      });

      const hash = await this.walletClient.writeContract({
        address: this.liquidatorAddress,
        abi: LIQUIDATOR_ABI,
        functionName: "liquidate",
        args: [marketId, trader],
        chain: this.walletClient.chain,
        account: this.keeperAddress,
      });

      const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      this.tracker.verifyPosition(marketId, trader);
      const gasUsed = receipt.gasUsed * (receipt.effectiveGasPrice || 0n);

      return {
        success: receipt.status === "success",
        marketId,
        trader,
        txHash: hash,
        gasUsed,
        reward: candidate.estimatedReward,
        timestamp: Date.now(),
      };
    } catch (err: any) {
      return {
        success: false,
        marketId,
        trader,
        error: err?.shortMessage || err?.message || String(err),
        timestamp: Date.now(),
      };
    }
  }

  private async executeBatch(candidates: LiquidationCandidate[]): Promise<LiquidationResult[]> {
    const marketIds = candidates.map(c => c.marketId);
    const traders = candidates.map(c => c.trader);

    try {
      // Simulate
      await this.client.simulateContract({
        address: this.liquidatorAddress,
        abi: LIQUIDATOR_ABI,
        functionName: "liquidateBatch",
        args: [marketIds, traders],
        account: this.keeperAddress,
      });

      // Execute
      const hash = await this.walletClient.writeContract({
        address: this.liquidatorAddress,
        abi: LIQUIDATOR_ABI,
        functionName: "liquidateBatch",
        args: [marketIds, traders],
        chain: this.walletClient.chain,
        account: this.keeperAddress,
      });

      const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      const gasUsed = receipt.gasUsed * (receipt.effectiveGasPrice || 0n);
      const gasPerLiq = gasUsed / BigInt(candidates.length);

      // Mark all as success (batch skips non-liquidatable silently)
      return candidates.map(c => {
        this.tracker.verifyPosition(c.marketId, c.trader);
        return {
          success: receipt.status === "success",
          marketId: c.marketId,
          trader: c.trader,
          txHash: hash,
          gasUsed: gasPerLiq,
          reward: c.estimatedReward,
          timestamp: Date.now(),
        };
      });
    } catch (err: any) {
      // Batch failed — fall back to individual liquidations
      console.warn("[Scanner] Batch failed, falling back to individual...");
      const results: LiquidationResult[] = [];
      for (const c of candidates) {
        results.push(await this.executeSingle(c));
      }
      return results;
    }
  }

  // ============================================================
  //                     REPORTING
  // ============================================================

  getRecentResults(n: number = 20): LiquidationResult[] {
    return this.results.slice(-n);
  }

  getStats(): KeeperStats {
    return {
      ...this.stats,
      uptimeMs: Date.now() - this.stats.startedAt,
    };
  }

  formatStats(): string {
    const s = this.getStats();
    const uptimeH = (s.uptimeMs / 3600000).toFixed(1);
    const rewardUsd = Number(s.totalRewardEarned) / 1e6;
    const gasEth = Number(s.totalGasSpent) / 1e18;

    return [
      `Uptime: ${uptimeH}h`,
      `Scans: ${s.totalScans}`,
      `Liquidations: ${s.totalLiquidations} (${s.totalFailed} failed)`,
      `Rewards: $${rewardUsd.toFixed(2)} USDC`,
      `Gas spent: ${gasEth.toFixed(6)} ETH`,
      `Net P&L: $${(rewardUsd - gasEth * 3000).toFixed(2)}`, // rough ETH price
      `Tracked positions: ${this.tracker.positionCount()}`,
    ].join(" | ");
  }
}
