/**
 * Keeper - Scanner & Retry Tests
 *
 * Tests for: liquidation scanner logic, retry with backoff, stats tracking
 * Run: npx vitest run test/scanner.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hex } from "viem";

// ============================================================
//                  RETRY WITH BACKOFF
// ============================================================

// Inline the function from scanner.ts for unit testing
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 10, label = "test" } = opts;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((r) =>
        setTimeout(r, Math.min(baseDelayMs * Math.pow(2, attempt), 10_000))
      );
    }
  }
  throw new Error("unreachable");
}

describe("retryWithBackoff", () => {
  it("should succeed on first try without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry once then succeed", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("temp failure"))
      .mockResolvedValue("ok");

    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should retry max times then throw", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent failure"));

    await expect(
      retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 1 })
    ).rejects.toThrow("permanent failure");

    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("should throw the last error, not an earlier one", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("error 1"))
      .mockRejectedValueOnce(new Error("error 2"))
      .mockRejectedValueOnce(new Error("error 3"));

    await expect(
      retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 1 })
    ).rejects.toThrow("error 3");
  });

  it("should work with maxRetries=0 (no retries)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(
      retryWithBackoff(fn, { maxRetries: 0, baseDelayMs: 1 })
    ).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
//                  LIQUIDATION CANDIDATE SORTING
// ============================================================

interface LiquidationCandidate {
  marketId: Hex;
  trader: Hex;
  size: bigint;
  margin: bigint;
  estimatedReward: bigint;
}

describe("Liquidation Candidate Sorting", () => {
  it("should sort by estimated reward descending (biggest first)", () => {
    const candidates: LiquidationCandidate[] = [
      {
        marketId: "0x01" as Hex,
        trader: "0xaaa" as Hex,
        size: 100n,
        margin: 200n,
        estimatedReward: 100n,
      },
      {
        marketId: "0x01" as Hex,
        trader: "0xbbb" as Hex,
        size: 500n,
        margin: 1000n,
        estimatedReward: 500n,
      },
      {
        marketId: "0x01" as Hex,
        trader: "0xccc" as Hex,
        size: 300n,
        margin: 600n,
        estimatedReward: 300n,
      },
    ];

    candidates.sort((a, b) => {
      if (b.estimatedReward > a.estimatedReward) return 1;
      if (b.estimatedReward < a.estimatedReward) return -1;
      return 0;
    });

    expect(candidates[0].trader).toBe("0xbbb");
    expect(candidates[1].trader).toBe("0xccc");
    expect(candidates[2].trader).toBe("0xaaa");
  });

  it("should handle equal rewards without crashing", () => {
    const candidates: LiquidationCandidate[] = [
      {
        marketId: "0x01" as Hex,
        trader: "0xaaa" as Hex,
        size: 100n,
        margin: 200n,
        estimatedReward: 100n,
      },
      {
        marketId: "0x01" as Hex,
        trader: "0xbbb" as Hex,
        size: 100n,
        margin: 200n,
        estimatedReward: 100n,
      },
    ];

    candidates.sort((a, b) => {
      if (b.estimatedReward > a.estimatedReward) return 1;
      if (b.estimatedReward < a.estimatedReward) return -1;
      return 0;
    });

    expect(candidates.length).toBe(2);
  });

  it("should filter by minimum reward threshold", () => {
    const minReward = 100_000n; // $0.10 USDC

    const candidates: LiquidationCandidate[] = [
      {
        marketId: "0x01" as Hex,
        trader: "0xaaa" as Hex,
        size: 100n,
        margin: 50_000n,
        estimatedReward: 25_000n, // below threshold
      },
      {
        marketId: "0x01" as Hex,
        trader: "0xbbb" as Hex,
        size: 500n,
        margin: 1_000_000n,
        estimatedReward: 500_000n, // above threshold
      },
    ];

    const worthwhile = candidates.filter(
      (c) => c.estimatedReward >= minReward
    );

    expect(worthwhile.length).toBe(1);
    expect(worthwhile[0].trader).toBe("0xbbb");
  });
});

// ============================================================
//                  POSITION TRACKING
// ============================================================

describe("Position Key Generation", () => {
  function posKey(marketId: Hex, trader: Hex): string {
    return `${marketId}:${trader.toLowerCase()}`;
  }

  it("should generate consistent keys", () => {
    const key1 = posKey("0xabcd" as Hex, "0x1234" as Hex);
    const key2 = posKey("0xabcd" as Hex, "0x1234" as Hex);
    expect(key1).toBe(key2);
  });

  it("should normalize trader address to lowercase", () => {
    const key1 = posKey("0xabcd" as Hex, "0xAABB" as Hex);
    const key2 = posKey("0xabcd" as Hex, "0xaabb" as Hex);
    expect(key1).toBe(key2);
  });

  it("should differentiate by market", () => {
    const key1 = posKey("0xaaaa" as Hex, "0x1234" as Hex);
    const key2 = posKey("0xbbbb" as Hex, "0x1234" as Hex);
    expect(key1).not.toBe(key2);
  });

  it("should differentiate by trader", () => {
    const key1 = posKey("0xaaaa" as Hex, "0x1111" as Hex);
    const key2 = posKey("0xaaaa" as Hex, "0x2222" as Hex);
    expect(key1).not.toBe(key2);
  });
});

// ============================================================
//                  STATS FORMATTING
// ============================================================

describe("Keeper Stats", () => {
  interface KeeperStats {
    totalScans: number;
    totalLiquidations: number;
    totalFailed: number;
    totalRewardEarned: bigint;
    totalGasSpent: bigint;
    uptimeMs: number;
    startedAt: number;
  }

  function formatStats(s: KeeperStats, posCount: number): string {
    const uptimeH = (s.uptimeMs / 3600000).toFixed(1);
    const rewardUsd = Number(s.totalRewardEarned) / 1e6;
    const gasEth = Number(s.totalGasSpent) / 1e18;

    return [
      `Uptime: ${uptimeH}h`,
      `Scans: ${s.totalScans}`,
      `Liquidations: ${s.totalLiquidations} (${s.totalFailed} failed)`,
      `Rewards: $${rewardUsd.toFixed(2)} USDC`,
      `Gas spent: ${gasEth.toFixed(6)} ETH`,
      `Tracked positions: ${posCount}`,
    ].join(" | ");
  }

  it("should format stats with zero values", () => {
    const stats: KeeperStats = {
      totalScans: 0,
      totalLiquidations: 0,
      totalFailed: 0,
      totalRewardEarned: 0n,
      totalGasSpent: 0n,
      uptimeMs: 0,
      startedAt: Date.now(),
    };

    const result = formatStats(stats, 0);
    expect(result).toContain("Scans: 0");
    expect(result).toContain("Liquidations: 0 (0 failed)");
    expect(result).toContain("Tracked positions: 0");
  });

  it("should format stats with real values", () => {
    const stats: KeeperStats = {
      totalScans: 100,
      totalLiquidations: 5,
      totalFailed: 2,
      totalRewardEarned: 150_000_000n, // $150 USDC
      totalGasSpent: 500_000_000_000_000n, // 0.0005 ETH
      uptimeMs: 3600000, // 1 hour
      startedAt: Date.now() - 3600000,
    };

    const result = formatStats(stats, 42);
    expect(result).toContain("Uptime: 1.0h");
    expect(result).toContain("Scans: 100");
    expect(result).toContain("Liquidations: 5 (2 failed)");
    expect(result).toContain("$150.00 USDC");
    expect(result).toContain("Tracked positions: 42");
  });

  it("should calculate reward in USDC correctly", () => {
    // $1.50 = 1_500_000 in 6-decimal USDC
    const reward = 1_500_000n;
    expect(Number(reward) / 1e6).toBe(1.5);
  });

  it("should calculate gas in ETH correctly", () => {
    // 0.01 ETH = 10_000_000_000_000_000 wei
    const gas = 10_000_000_000_000_000n;
    expect(Number(gas) / 1e18).toBe(0.01);
  });
});

// ============================================================
//                  CONFIG VALIDATION
// ============================================================

describe("Keeper Config Validation", () => {
  const PK_REGEX = /^0x[a-fA-F0-9]{64}$/;
  const ADDR_REGEX = /^0x[a-fA-F0-9]{40}$/;

  it("should validate private key format", () => {
    expect(PK_REGEX.test("0x")).toBe(false);
    expect(PK_REGEX.test("")).toBe(false);
    expect(
      PK_REGEX.test(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
      )
    ).toBe(true);
  });

  it("should validate contract address format", () => {
    expect(ADDR_REGEX.test("0x")).toBe(false);
    expect(ADDR_REGEX.test("0x" + "a".repeat(40))).toBe(true);
    expect(ADDR_REGEX.test("0x" + "a".repeat(39))).toBe(false);
  });

  it("should parse market names from comma-separated string", () => {
    const raw = "BTC-USD,ETH-USD,SOL-USD";
    const markets = raw.split(",");
    expect(markets).toEqual(["BTC-USD", "ETH-USD", "SOL-USD"]);
  });
});
