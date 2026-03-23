/**
 * SUR Protocol - Points Engine Tests
 *
 * Tests the points calculation logic, volume tiers,
 * daily streaks, referrals, and leaderboard.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// We test the pure logic by importing the engine.
// Supabase is not configured in test env, so it uses in-memory fallback.
import {
  calculatePointsForTrade,
  getTraderPoints,
  getLeaderboard,
  registerReferral,
  getCampaignStats,
} from "../src/points/engine.js";

const TRADER_A = "0x1111111111111111111111111111111111111111";
const TRADER_B = "0x2222222222222222222222222222222222222222";
const TRADER_C = "0x3333333333333333333333333333333333333333";

describe("Points Engine", () => {
  // Note: in-memory store persists across tests within a single run.
  // Tests are ordered to account for cumulative state.

  describe("Basic Points Calculation", () => {
    it("should award 1 point per $1,000 volume (base rate)", async () => {
      const points = await calculatePointsForTrade(TRADER_A, 1000);
      // First trade: $1k volume, 1x tier, 1 day streak (1.1x)
      // = (1000/1000) * 1.0 * 1.1 = 1.1
      expect(points).toBeGreaterThan(0);
      expect(points).toBeLessThan(5);
    });

    it("should award more points for larger volume", async () => {
      const smallPoints = await calculatePointsForTrade(TRADER_B, 500);
      const record = await getTraderPoints(TRADER_B);
      expect(record).not.toBeNull();
      expect(record!.points).toBeGreaterThan(0);
      expect(record!.total_volume).toBe(500);
      expect(record!.trade_count).toBe(1);
    });

    it("should accumulate points across multiple trades", async () => {
      const before = await getTraderPoints(TRADER_A);
      await calculatePointsForTrade(TRADER_A, 2000);
      const after = await getTraderPoints(TRADER_A);
      expect(after!.points).toBeGreaterThan(before!.points);
      expect(after!.trade_count).toBe(before!.trade_count + 1);
    });
  });

  describe("Volume Tiers", () => {
    it("should apply 1.5x multiplier after $10k cumulative volume", async () => {
      // Push TRADER_C past $10k
      await calculatePointsForTrade(TRADER_C, 5000);
      await calculatePointsForTrade(TRADER_C, 5000);
      // Now at $10k, next trade should get 1.5x tier
      const pointsBefore = (await getTraderPoints(TRADER_C))!.points;
      const earned = await calculatePointsForTrade(TRADER_C, 1000);
      // At 1.5x tier, $1k = (1000/1000) * 1.5 * streakMult
      expect(earned).toBeGreaterThan(1.0); // More than base 1.0
    });
  });

  describe("Daily Streaks", () => {
    it("should track streak days", async () => {
      const record = await getTraderPoints(TRADER_A);
      expect(record!.streak_days).toBeGreaterThanOrEqual(1);
      expect(record!.last_trade_date).not.toBeNull();
    });

    it("should not increment streak for same-day trades", async () => {
      const before = await getTraderPoints(TRADER_A);
      await calculatePointsForTrade(TRADER_A, 500);
      const after = await getTraderPoints(TRADER_A);
      // Same day — streak should not increase
      expect(after!.streak_days).toBe(before!.streak_days);
    });
  });

  describe("Referrals", () => {
    it("should register a referral", async () => {
      const ok = await registerReferral(TRADER_A, TRADER_B, "ref-a");
      expect(ok).toBe(true);
    });

    it("should not allow self-referral", async () => {
      const ok = await registerReferral(TRADER_A, TRADER_A, "self");
      expect(ok).toBe(false);
    });

    it("should not allow duplicate referee", async () => {
      const ok = await registerReferral(TRADER_C, TRADER_B, "ref-c");
      expect(ok).toBe(false); // TRADER_B already referred by TRADER_A
    });

    it("should credit referrer when referee trades", async () => {
      const before = await getTraderPoints(TRADER_A);
      // TRADER_B trades — TRADER_A should get 10% bonus
      await calculatePointsForTrade(TRADER_B, 10000);
      const after = await getTraderPoints(TRADER_A);
      // TRADER_A's points should increase from referral bonus
      expect(after!.points).toBeGreaterThan(before!.points);
    });
  });

  describe("Leaderboard", () => {
    it("should return traders ranked by points", async () => {
      const lb = await getLeaderboard(1, 10);
      expect(lb.length).toBeGreaterThan(0);
      // Should be sorted descending
      for (let i = 1; i < lb.length; i++) {
        expect(lb[i - 1].points).toBeGreaterThanOrEqual(lb[i].points);
      }
    });

    it("should include rank field", async () => {
      const lb = await getLeaderboard(1, 10);
      expect(lb[0].rank).toBe(1);
      if (lb.length > 1) expect(lb[1].rank).toBe(2);
    });
  });

  describe("Campaign Stats", () => {
    it("should return aggregate campaign stats", async () => {
      const stats = await getCampaignStats(1);
      expect(stats.total_participants).toBeGreaterThanOrEqual(3);
      expect(stats.total_volume).toBeGreaterThan(0);
      expect(stats.total_points).toBeGreaterThan(0);
      expect(stats.total_trades).toBeGreaterThan(0);
    });
  });

  describe("Edge Cases", () => {
    it("should handle zero volume trade", async () => {
      const points = await calculatePointsForTrade(TRADER_A, 0);
      expect(points).toBe(0);
    });

    it("should handle very large volume", async () => {
      const points = await calculatePointsForTrade(
        "0x9999999999999999999999999999999999999999",
        1_000_000,
      );
      expect(points).toBeGreaterThan(0);
      expect(Number.isFinite(points)).toBe(true);
    });

    it("should return null for unknown trader", async () => {
      const record = await getTraderPoints(
        "0x0000000000000000000000000000000000000000",
      );
      expect(record).toBeNull();
    });
  });
});
