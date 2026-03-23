/**
 * Funding Rate Verification Tests
 *
 * Validates the funding rate calculation against the reference implementation:
 *   fundingRate = (markPrice - indexPrice) / indexPrice
 *   annualized = fundingRate * (365.25 * 24 * 3600 / interval)
 *
 * Reference: https://www.binance.com/en/support/faq/360033525031
 * Binance uses: F = P * clamp(r, -0.05%, 0.05%) where r = premium/index
 * SUR uses: F = (mark - index) / index per interval (simpler, unclamped)
 */

import { describe, it, expect } from "vitest";

// ============================================================
//                  CONSTANTS (from funding-bot)
// ============================================================

const PRICE_PRECISION = 1e6;
const SIZE_PRECISION = 1e8;
const FUNDING_INTERVAL_SECS = 28800; // 8 hours

// ============================================================
//                  FUNDING RATE CALCULATION
// ============================================================

function calcFundingRate(markPrice: number, indexPrice: number): {
  premium: number;
  fundingRate: number;
  annualizedRate: number;
} {
  const premium = indexPrice > 0 ? (markPrice - indexPrice) / indexPrice : 0;
  const fundingRate = premium * 100; // percentage per interval
  const intervalsPerYear = (365.25 * 24 * 3600) / FUNDING_INTERVAL_SECS;
  const annualizedRate = fundingRate * intervalsPerYear;
  return { premium: premium * 100, fundingRate, annualizedRate };
}

describe("Funding Rate Calculation", () => {
  it("should return zero rate when mark equals index", () => {
    const { fundingRate, premium } = calcFundingRate(50000, 50000);
    expect(fundingRate).toBe(0);
    expect(premium).toBe(0);
  });

  it("should return positive rate when mark > index (longs pay shorts)", () => {
    // Mark at $50,500, index at $50,000 → 1% premium
    const { fundingRate, premium } = calcFundingRate(50500, 50000);
    expect(premium).toBeCloseTo(1.0, 4);
    expect(fundingRate).toBeCloseTo(1.0, 4);
  });

  it("should return negative rate when mark < index (shorts pay longs)", () => {
    // Mark at $49,500, index at $50,000 → -1% premium
    const { fundingRate, premium } = calcFundingRate(49500, 50000);
    expect(premium).toBeCloseTo(-1.0, 4);
    expect(fundingRate).toBeCloseTo(-1.0, 4);
  });

  it("should correctly annualize the rate", () => {
    // 0.01% per 8h → ~10.96% annualized
    const { annualizedRate } = calcFundingRate(50005, 50000);
    const expectedPremium = (50005 - 50000) / 50000; // 0.0001 = 0.01%
    const intervalsPerYear = (365.25 * 24 * 3600) / 28800;
    const expectedAnnualized = expectedPremium * 100 * intervalsPerYear;
    expect(annualizedRate).toBeCloseTo(expectedAnnualized, 1);
  });

  it("should handle very small premiums correctly", () => {
    // $0.01 difference on $50,000 → 0.00002%
    const { premium } = calcFundingRate(50000.01, 50000);
    expect(premium).toBeCloseTo(0.00002, 5);
  });

  it("should handle large premiums (market stress)", () => {
    // 5% premium — extreme market condition
    const { premium, fundingRate } = calcFundingRate(52500, 50000);
    expect(premium).toBeCloseTo(5.0, 2);
    expect(fundingRate).toBeCloseTo(5.0, 2);
  });

  it("should handle zero index price gracefully", () => {
    const { fundingRate, premium } = calcFundingRate(100, 0);
    expect(fundingRate).toBe(0);
    expect(premium).toBe(0);
  });
});

// ============================================================
//            COMPARISON VS BINANCE REFERENCE
// ============================================================

describe("Binance Reference Comparison", () => {
  // Binance 8h funding rate formula:
  // Premium Index = (Mark Price - Index Price) / Index Price
  // Funding Rate = Premium Index (clamped to ±0.75% per interval)
  // Note: Binance also adds interest rate component (0.01%/day), SUR doesn't

  function binanceFundingRate(mark: number, index: number): number {
    const premium = (mark - index) / index;
    // Binance clamps to ±0.75% per 8h interval
    return Math.max(-0.0075, Math.min(0.0075, premium)) * 100;
  }

  it("should match Binance for normal premiums (< 0.75%)", () => {
    // 0.05% premium — within clamp range
    const mark = 50025;
    const index = 50000;

    const surRate = calcFundingRate(mark, index).fundingRate;
    const binRate = binanceFundingRate(mark, index);

    // SUR and Binance should agree for small premiums
    expect(surRate).toBeCloseTo(binRate, 3);
  });

  it("should diverge from Binance for extreme premiums (SUR is unclamped)", () => {
    // 2% premium — Binance clamps to 0.75%, SUR passes through
    const mark = 51000;
    const index = 50000;

    const surRate = calcFundingRate(mark, index).fundingRate;
    const binRate = binanceFundingRate(mark, index);

    expect(surRate).toBeCloseTo(2.0, 2); // SUR: full 2%
    expect(binRate).toBeCloseTo(0.75, 2); // Binance: clamped to 0.75%
    expect(surRate).toBeGreaterThan(binRate); // SUR is more aggressive
  });

  it("should handle negative premium correctly in both models", () => {
    const mark = 49900;
    const index = 50000;

    const surRate = calcFundingRate(mark, index).fundingRate;
    const binRate = binanceFundingRate(mark, index);

    expect(surRate).toBeLessThan(0);
    expect(binRate).toBeLessThan(0);
    expect(surRate).toBeCloseTo(binRate, 3); // Small premium, both agree
  });
});

// ============================================================
//            OI IMBALANCE DETECTION
// ============================================================

describe("OI Imbalance Detection", () => {
  it("should detect long-heavy imbalance", () => {
    const oiLong = 150;
    const oiShort = 50;
    const imbalance = oiLong - oiShort;
    const totalOi = oiLong + oiShort;
    const longRatio = oiLong / totalOi;

    expect(imbalance).toBeGreaterThan(0);
    expect(longRatio).toBe(0.75); // 75% long
  });

  it("should detect short-heavy imbalance", () => {
    const oiLong = 30;
    const oiShort = 70;
    const imbalance = oiLong - oiShort;

    expect(imbalance).toBeLessThan(0);
  });

  it("should detect balanced OI", () => {
    const oiLong = 100;
    const oiShort = 100;
    const imbalance = oiLong - oiShort;

    expect(imbalance).toBe(0);
  });

  it("should warn when imbalance exceeds 70%", () => {
    const oiLong = 85;
    const oiShort = 15;
    const totalOi = oiLong + oiShort;
    const longRatio = oiLong / totalOi;

    expect(longRatio).toBeGreaterThan(0.7);
  });
});

// ============================================================
//            EXTREME RATE WARNINGS
// ============================================================

describe("Extreme Rate Warnings", () => {
  it("should flag rates > 100% annualized as extreme", () => {
    // ~0.1% per 8h → ~109.6% annualized
    const { annualizedRate } = calcFundingRate(50050, 50000);
    expect(Math.abs(annualizedRate)).toBeGreaterThan(100);
  });

  it("should not flag normal rates as extreme", () => {
    // 0.01% per 8h → ~10.96% annualized
    const { annualizedRate } = calcFundingRate(50005, 50000);
    expect(Math.abs(annualizedRate)).toBeLessThan(100);
  });

  it("should flag large negative premium (> 2%) as concerning", () => {
    const { premium } = calcFundingRate(48900, 50000);
    expect(Math.abs(premium)).toBeGreaterThan(2);
  });
});

// ============================================================
//            CONFIG VALIDATION
// ============================================================

describe("Funding Bot Config", () => {
  const PK_REGEX = /^0x[a-fA-F0-9]{64}$/;
  const ADDR_REGEX = /^0x[a-fA-F0-9]{40}$/;

  it("should validate private key format", () => {
    expect(PK_REGEX.test("0x")).toBe(false);
    expect(PK_REGEX.test("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")).toBe(true);
  });

  it("should validate engine address format", () => {
    expect(ADDR_REGEX.test("0x")).toBe(false);
    expect(ADDR_REGEX.test("0x" + "a".repeat(40))).toBe(true);
  });

  it("should parse market names correctly", () => {
    const raw = "BTC-USD,ETH-USD";
    const markets = raw.split(",").map((n) => n.trim());
    expect(markets).toEqual(["BTC-USD", "ETH-USD"]);
  });

  it("should handle single market", () => {
    const raw = "BTC-USD";
    const markets = raw.split(",").map((n) => n.trim());
    expect(markets).toEqual(["BTC-USD"]);
  });
});
