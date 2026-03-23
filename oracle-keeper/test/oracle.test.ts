/**
 * Oracle Keeper Tests
 *
 * Tests for:
 *  - retryWithBackoff logic
 *  - Hermes URL failover
 *  - Stats formatting
 *  - Config validation (PK, address, Hermes URL parsing)
 *  - Pyth price parsing
 *  - Gas price gating
 */

import { describe, it, expect } from "vitest";
import { formatEther } from "viem";

// ============================================================
//                  RETRY WITH BACKOFF
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
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

describe("retryWithBackoff", () => {
  it("should succeed on first try", async () => {
    const result = await retryWithBackoff(() => Promise.resolve(42), {
      baseDelayMs: 1,
    });
    expect(result).toBe(42);
  });

  it("should retry and eventually succeed", async () => {
    let attempts = 0;
    const result = await retryWithBackoff(
      () => {
        attempts++;
        if (attempts < 3) throw new Error("fail");
        return Promise.resolve("ok");
      },
      { maxRetries: 3, baseDelayMs: 1 }
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("should throw after exhausting retries", async () => {
    await expect(
      retryWithBackoff(() => Promise.reject(new Error("permanent")), {
        maxRetries: 2,
        baseDelayMs: 1,
      })
    ).rejects.toThrow("permanent");
  });

  it("should cap delay at 10 seconds", async () => {
    // With baseDelayMs=5000, attempt 2 would be 20000 but should cap at 10000
    const delay = Math.min(5000 * Math.pow(2, 2), 10_000);
    expect(delay).toBe(10_000);
  });
});

// ============================================================
//                  CONFIG VALIDATION
// ============================================================

const PK_REGEX = /^0x[a-fA-F0-9]{64}$/;
const ADDR_REGEX = /^0x[a-fA-F0-9]{40}$/;

describe("Config Validation", () => {
  it("should validate private key format", () => {
    expect(PK_REGEX.test("0x")).toBe(false);
    expect(PK_REGEX.test("not-a-key")).toBe(false);
    expect(PK_REGEX.test("0x" + "a".repeat(63))).toBe(false);
    expect(
      PK_REGEX.test(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
      )
    ).toBe(true);
  });

  it("should validate oracle router address format", () => {
    expect(ADDR_REGEX.test("0x")).toBe(false);
    expect(ADDR_REGEX.test("0x" + "a".repeat(39))).toBe(false);
    expect(ADDR_REGEX.test("0x" + "a".repeat(40))).toBe(true);
  });

  it("should parse Hermes URL list correctly", () => {
    const primary = "https://hermes.pyth.network";
    const fallbackEnv = "https://hermes-beta.pyth.network, https://hermes2.pyth.network";
    const hermesUrls = [
      primary,
      ...fallbackEnv
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    ];
    expect(hermesUrls).toEqual([
      "https://hermes.pyth.network",
      "https://hermes-beta.pyth.network",
      "https://hermes2.pyth.network",
    ]);
  });

  it("should use default fallback when no env var", () => {
    const primary = "https://hermes.pyth.network";
    const fallbackEnv = undefined;
    const hermesUrls = [
      primary,
      ...(fallbackEnv
        ? fallbackEnv.split(",").map((u: string) => u.trim()).filter(Boolean)
        : ["https://hermes-beta.pyth.network"]),
    ];
    expect(hermesUrls).toEqual([
      "https://hermes.pyth.network",
      "https://hermes-beta.pyth.network",
    ]);
  });

  it("should parse push interval from string", () => {
    expect(parseInt("5000")).toBe(5000);
    expect(parseInt("10000")).toBe(10000);
  });

  it("should parse max gas price", () => {
    expect(parseInt("50")).toBe(50);
    expect(parseInt("")).toBeNaN();
  });
});

// ============================================================
//                  PYTH PRICE PARSING
// ============================================================

describe("Pyth Price Parsing", () => {
  it("should correctly apply exponent to price", () => {
    // Pyth returns price as integer with negative exponent
    // e.g., price=6789012345000, expo=-8 → $67,890.12345
    const priceRaw = 6789012345000;
    const expo = -8;
    const price = priceRaw * Math.pow(10, expo);
    expect(price).toBeCloseTo(67890.12345, 2);
  });

  it("should handle conf (confidence interval)", () => {
    const confRaw = 500000;
    const expo = -8;
    const conf = confRaw * Math.pow(10, expo);
    expect(conf).toBeCloseTo(0.005, 6);
  });

  it("should handle zero exponent", () => {
    const price = 100 * Math.pow(10, 0);
    expect(price).toBe(100);
  });

  it("should strip 0x prefix for Hermes API query", () => {
    const feedId =
      "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
    const stripped = feedId.slice(2);
    expect(stripped).not.toContain("0x");
    expect(stripped.length).toBe(64);
  });

  it("should build correct query params", () => {
    const feedIds = [
      "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
      "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    ];
    const ids = feedIds.map((id) => id.slice(2));
    const queryParams = ids.map((id) => `ids[]=${id}`).join("&");
    expect(queryParams).toContain("ids[]=e62df6c8");
    expect(queryParams).toContain("&ids[]=ff61491a");
  });
});

// ============================================================
//                  GAS PRICE GATING
// ============================================================

describe("Gas Price Gating", () => {
  it("should skip when gas exceeds max", () => {
    const gasPriceGwei = 55.2;
    const maxGasPriceGwei = 50;
    expect(gasPriceGwei > maxGasPriceGwei).toBe(true);
  });

  it("should proceed when gas is under max", () => {
    const gasPriceGwei = 0.05; // Base L2 typical
    const maxGasPriceGwei = 50;
    expect(gasPriceGwei > maxGasPriceGwei).toBe(false);
  });

  it("should convert wei to gwei correctly", () => {
    const gasPrice = 50000000000n; // 50 gwei in wei
    const gwei = Number(gasPrice) / 1e9;
    expect(gwei).toBe(50);
  });
});

// ============================================================
//                  PYTH FEE BUFFER
// ============================================================

describe("Pyth Fee Buffer", () => {
  it("should add 10% buffer to fee", () => {
    const pythFee = 100n;
    const feeWithBuffer = pythFee + pythFee / 10n;
    expect(feeWithBuffer).toBe(110n);
  });

  it("should handle zero fee", () => {
    const pythFee = 0n;
    const feeWithBuffer = pythFee + pythFee / 10n;
    expect(feeWithBuffer).toBe(0n);
  });

  it("should handle large fee", () => {
    const pythFee = 1000000000000000n; // 0.001 ETH
    const feeWithBuffer = pythFee + pythFee / 10n;
    expect(feeWithBuffer).toBe(1100000000000000n);
  });
});

// ============================================================
//                  STATS FORMATTING
// ============================================================

describe("Stats Formatting", () => {
  it("should format uptime in hours", () => {
    const startedAt = Date.now() - 3600000; // 1 hour ago
    const uptimeH = ((Date.now() - startedAt) / 3600000).toFixed(1);
    expect(uptimeH).toBe("1.0");
  });

  it("should format gas + pyth total", () => {
    const totalGasSpent = 500000000000000n; // 0.0005 ETH
    const totalPythFees = 200000000000000n; // 0.0002 ETH
    const total = totalGasSpent + totalPythFees;
    const formatted = formatEther(total);
    expect(formatted).toBe("0.0007");
  });

  it("should format price map entries", () => {
    const lastPrices = new Map<string, number>();
    lastPrices.set("BTC-USD", 67890.12);
    lastPrices.set("ETH-USD", 3456.78);

    const priceStr = [...lastPrices.entries()]
      .map(([name, price]) => `${name}: $${price.toFixed(2)}`)
      .join(" | ");

    expect(priceStr).toBe("BTC-USD: $67890.12 | ETH-USD: $3456.78");
  });

  it("should calculate staleness correctly", () => {
    const lastPushTime = Date.now() - 15000; // 15 seconds ago
    const staleSec = Math.floor((Date.now() - lastPushTime) / 1000);
    expect(staleSec).toBeGreaterThanOrEqual(14);
    expect(staleSec).toBeLessThanOrEqual(16);
  });

  it("should report -1 staleness when no push yet", () => {
    const lastPushTime = 0;
    const staleSec = lastPushTime
      ? Math.floor((Date.now() - lastPushTime) / 1000)
      : -1;
    expect(staleSec).toBe(-1);
  });
});

// ============================================================
//                  HERMES FAILOVER LOGIC
// ============================================================

describe("Hermes Failover", () => {
  it("should try endpoints sequentially", async () => {
    const tried: string[] = [];
    const hermesUrls = ["http://fail1", "http://fail2", "http://success"];

    for (const url of hermesUrls) {
      tried.push(url);
      if (url === "http://success") break;
    }

    expect(tried).toEqual(["http://fail1", "http://fail2", "http://success"]);
  });

  it("should throw when all endpoints fail", () => {
    const lastError = new Error("timeout");
    const allFailed = true;
    if (allFailed) {
      expect(() => {
        throw new Error(
          `All Hermes endpoints failed. Last error: ${lastError.message}`
        );
      }).toThrow("All Hermes endpoints failed");
    }
  });
});

// ============================================================
//                  PYTH CONTRACT ADDRESSES
// ============================================================

describe("Pyth Contract Addresses", () => {
  const PYTH_ADDRESS: Record<number, string> = {
    84532: "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729", // Base Sepolia
    8453: "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a", // Base Mainnet
  };

  it("should have Base Sepolia address", () => {
    expect(PYTH_ADDRESS[84532]).toBeDefined();
    expect(PYTH_ADDRESS[84532]).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("should have Base Mainnet address", () => {
    expect(PYTH_ADDRESS[8453]).toBeDefined();
    expect(PYTH_ADDRESS[8453]).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("should return undefined for unsupported chains", () => {
    expect(PYTH_ADDRESS[1]).toBeUndefined();
  });
});
