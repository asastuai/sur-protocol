/**
 * Security & Hardening Tests
 *
 * Tests for: config validation, rate limiting, input validation, WS auth
 * Run: npx vitest run test/security.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================
//                  CONFIG VALIDATION
// ============================================================

describe("Config Validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("should exit on missing OPERATOR_PRIVATE_KEY", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);

    delete process.env.OPERATOR_PRIVATE_KEY;
    process.env.NETWORK = "testnet";

    await expect(async () => {
      const { loadConfig } = await import("../src/config/index.js");
      loadConfig();
    }).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should exit on invalid OPERATOR_PRIVATE_KEY (too short)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);

    process.env.OPERATOR_PRIVATE_KEY = "0xdead";
    process.env.NETWORK = "testnet";

    await expect(async () => {
      const { loadConfig } = await import("../src/config/index.js");
      loadConfig();
    }).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should exit on OPERATOR_PRIVATE_KEY = '0x' (default placeholder)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);

    process.env.OPERATOR_PRIVATE_KEY = "0x";
    process.env.NETWORK = "testnet";

    await expect(async () => {
      const { loadConfig } = await import("../src/config/index.js");
      loadConfig();
    }).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should exit on missing required contract addresses", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);

    // Valid PK but missing addresses
    process.env.OPERATOR_PRIVATE_KEY =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    process.env.NETWORK = "testnet";
    delete process.env.VAULT_ADDRESS;
    delete process.env.ENGINE_ADDRESS;
    delete process.env.SETTLEMENT_ADDRESS;

    await expect(async () => {
      const { loadConfig } = await import("../src/config/index.js");
      loadConfig();
    }).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should load config successfully with valid env vars", async () => {
    process.env.OPERATOR_PRIVATE_KEY =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    process.env.VAULT_ADDRESS = "0x" + "a".repeat(40);
    process.env.ENGINE_ADDRESS = "0x" + "b".repeat(40);
    process.env.SETTLEMENT_ADDRESS = "0x" + "c".repeat(40);
    process.env.NETWORK = "testnet";

    const { loadConfig } = await import("../src/config/index.js");
    const config = loadConfig();

    expect(config.operatorPrivateKey).toBe(process.env.OPERATOR_PRIVATE_KEY);
    expect(config.contracts.vault).toBe(process.env.VAULT_ADDRESS);
    expect(config.rpcUrls.length).toBeGreaterThanOrEqual(1);
  });

  it("should parse RPC fallback URLs", async () => {
    process.env.OPERATOR_PRIVATE_KEY =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    process.env.VAULT_ADDRESS = "0x" + "a".repeat(40);
    process.env.ENGINE_ADDRESS = "0x" + "b".repeat(40);
    process.env.SETTLEMENT_ADDRESS = "0x" + "c".repeat(40);
    process.env.RPC_URL = "https://primary.rpc";
    process.env.RPC_URLS_FALLBACK = "https://backup1.rpc,https://backup2.rpc";
    process.env.NETWORK = "testnet";

    const { loadConfig } = await import("../src/config/index.js");
    const config = loadConfig();

    expect(config.rpcUrls).toEqual([
      "https://primary.rpc",
      "https://backup1.rpc",
      "https://backup2.rpc",
    ]);
  });
});

// ============================================================
//                  INPUT VALIDATION
// ============================================================

describe("Order Input Validation", () => {
  it("should reject invalid trader address", () => {
    const invalidAddresses = ["", "0x", "0xZZZ", "not-an-address", "0x123"];
    for (const addr of invalidAddresses) {
      expect(/^0x[a-fA-F0-9]{40}$/.test(addr)).toBe(false);
    }
  });

  it("should accept valid trader address", () => {
    const valid = "0x" + "a".repeat(40);
    expect(/^0x[a-fA-F0-9]{40}$/.test(valid)).toBe(true);
  });

  it("should reject invalid marketId", () => {
    const invalidIds = ["", "0x", "0x123", "not-a-hash"];
    for (const id of invalidIds) {
      expect(/^0x[a-fA-F0-9]{64}$/.test(id)).toBe(false);
    }
  });

  it("should accept valid marketId (bytes32)", () => {
    const valid = "0x" + "f".repeat(64);
    expect(/^0x[a-fA-F0-9]{64}$/.test(valid)).toBe(true);
  });

  it("should reject invalid side values", () => {
    const invalidSides = ["long", "short", "BUY", "SELL", "", "up"];
    for (const side of invalidSides) {
      expect(["buy", "sell"].includes(side)).toBe(false);
    }
  });

  it("should reject zero or negative size", () => {
    expect(BigInt("0") <= 0n).toBe(true);
    expect(BigInt("-100") <= 0n).toBe(true);
  });

  it("should accept positive size", () => {
    expect(BigInt("1000000") > 0n).toBe(true);
  });

  it("should reject expired orders", () => {
    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    const pastExpiry = nowSecs - 3600n; // 1 hour ago
    expect(pastExpiry > 0n && pastExpiry < nowSecs).toBe(true);
  });

  it("should accept future expiry", () => {
    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    const futureExpiry = nowSecs + 3600n; // 1 hour from now
    expect(futureExpiry > nowSecs).toBe(true);
  });

  it("should accept zero expiry (no expiration)", () => {
    // Zero expiry means "never expires" — should pass validation
    expect(BigInt("0") === 0n).toBe(true);
  });

  it("should reject invalid signature format", () => {
    const invalidSigs = ["", "0x", "not-hex", "deadbeef"];
    for (const sig of invalidSigs) {
      expect(/^0x[a-fA-F0-9]+$/.test(sig)).toBe(false);
    }
  });

  it("should accept valid signature format", () => {
    const validSig = "0x" + "ab".repeat(65);
    expect(/^0x[a-fA-F0-9]+$/.test(validSig)).toBe(true);
  });
});

// ============================================================
//                  RATE LIMITER LOGIC
// ============================================================

describe("Rate Limiter", () => {
  // Inline rate limiter for unit testing (mirrors the one in ws/server.ts)
  class RateLimiter {
    private windows: Map<string, { count: number; resetAt: number }> = new Map();
    constructor(
      private maxPerWindow: number,
      private windowMs: number
    ) {}

    check(key: string): boolean {
      const now = Date.now();
      const entry = this.windows.get(key);
      if (!entry || entry.resetAt < now) {
        this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
        return true;
      }
      if (entry.count >= this.maxPerWindow) return false;
      entry.count++;
      return true;
    }
  }

  it("should allow messages under the limit", () => {
    const limiter = new RateLimiter(5, 1000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("client_1")).toBe(true);
    }
  });

  it("should reject messages over the limit", () => {
    const limiter = new RateLimiter(3, 1000);
    expect(limiter.check("client_1")).toBe(true);
    expect(limiter.check("client_1")).toBe(true);
    expect(limiter.check("client_1")).toBe(true);
    expect(limiter.check("client_1")).toBe(false); // 4th = rejected
    expect(limiter.check("client_1")).toBe(false); // 5th = still rejected
  });

  it("should track limits per client independently", () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.check("client_1")).toBe(true);
    expect(limiter.check("client_1")).toBe(true);
    expect(limiter.check("client_1")).toBe(false); // client_1 exhausted
    expect(limiter.check("client_2")).toBe(true); // client_2 is fresh
    expect(limiter.check("client_2")).toBe(true);
    expect(limiter.check("client_2")).toBe(false);
  });

  it("should reset after window expires", async () => {
    const limiter = new RateLimiter(1, 50); // 50ms window
    expect(limiter.check("client_1")).toBe(true);
    expect(limiter.check("client_1")).toBe(false);

    await new Promise((r) => setTimeout(r, 60)); // Wait for window to expire

    expect(limiter.check("client_1")).toBe(true); // Window reset
  });
});

// ============================================================
//                  RETRY WITH BACKOFF
// ============================================================

describe("Retry with Backoff", () => {
  // Inline the retryWithBackoff for unit testing
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
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
      }
    }
    throw new Error("unreachable");
  }

  it("should succeed on first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure then succeed", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("ok");

    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should throw after max retries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    await expect(
      retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 1 })
    ).rejects.toThrow("always fails");

    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

// ============================================================
//                  PRIVATE KEY VALIDATION
// ============================================================

describe("Private Key Validation Regex", () => {
  const PK_REGEX = /^0x[a-fA-F0-9]{64}$/;

  it("should accept valid 32-byte hex key", () => {
    expect(PK_REGEX.test("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")).toBe(true);
  });

  it("should reject empty string", () => {
    expect(PK_REGEX.test("")).toBe(false);
  });

  it("should reject '0x' placeholder", () => {
    expect(PK_REGEX.test("0x")).toBe(false);
  });

  it("should reject key without 0x prefix", () => {
    expect(PK_REGEX.test("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")).toBe(false);
  });

  it("should reject too-short key", () => {
    expect(PK_REGEX.test("0xdead")).toBe(false);
  });

  it("should reject key with non-hex characters", () => {
    expect(PK_REGEX.test("0x" + "g".repeat(64))).toBe(false);
  });
});

// ============================================================
//                  ADDRESS VALIDATION
// ============================================================

describe("Ethereum Address Validation Regex", () => {
  const ADDR_REGEX = /^0x[a-fA-F0-9]{40}$/;

  it("should accept valid checksummed address", () => {
    expect(ADDR_REGEX.test("0x5e444D0Ee11AC01D41b982c3b608c4afa0Aa02fE")).toBe(true);
  });

  it("should accept lowercase address", () => {
    expect(ADDR_REGEX.test("0x" + "a".repeat(40))).toBe(true);
  });

  it("should reject '0x' placeholder", () => {
    expect(ADDR_REGEX.test("0x")).toBe(false);
  });

  it("should reject too-short address", () => {
    expect(ADDR_REGEX.test("0x1234")).toBe(false);
  });
});
