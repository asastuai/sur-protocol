/**
 * SUR Protocol - Points Engine
 *
 * Calculates and tracks points for the testnet trading campaign.
 *
 * Rules:
 *   - Base: 1 point per $1,000 trading volume
 *   - Volume tiers: $10k+ = 1.5x, $50k+ = 2x, $100k+ = 3x
 *   - Streak bonus: +10% per consecutive day (max 7 days = +70%)
 *   - Referral: 10% of referred trader's points go to referrer
 *   - Season 1 only
 */

import { getSupabase } from "../db/supabase.js";

// ============================================================
//                    TYPES
// ============================================================

export interface PointsRecord {
  trader: string;
  points: number;
  total_volume: number;
  trade_count: number;
  streak_days: number;
  last_trade_date: string | null;
  multiplier: number;
  season: number;
  rank?: number;
}

export interface PointsHistoryEntry {
  trader: string;
  points_earned: number;
  reason: string;
  metadata?: Record<string, unknown>;
  season: number;
}

export interface ReferralRecord {
  referrer: string;
  referee: string;
  referral_code: string;
  volume_from_referee: number;
  points_earned: number;
}

export interface CampaignStats {
  total_participants: number;
  total_volume: number;
  total_points: number;
  total_trades: number;
}

// ============================================================
//                    CONSTANTS
// ============================================================

const CURRENT_SEASON = 1;
const POINTS_PER_1K_VOLUME = 1;

// Volume tier multipliers
const VOLUME_TIERS = [
  { threshold: 100_000, multiplier: 3.0 },
  { threshold: 50_000, multiplier: 2.0 },
  { threshold: 10_000, multiplier: 1.5 },
  { threshold: 0, multiplier: 1.0 },
];

const MAX_STREAK_DAYS = 7;
const STREAK_BONUS_PER_DAY = 0.10; // 10% per day
const REFERRAL_BONUS_RATE = 0.10; // 10% of referee's points

// In-memory fallback when Supabase is not configured
const memoryStore = new Map<string, PointsRecord>();
const memoryHistory: PointsHistoryEntry[] = [];
const memoryReferrals = new Map<string, ReferralRecord>(); // referee -> referral

// ============================================================
//                    HELPERS
// ============================================================

function getVolumeTierMultiplier(totalVolume: number): number {
  for (const tier of VOLUME_TIERS) {
    if (totalVolume >= tier.threshold) return tier.multiplier;
  }
  return 1.0;
}

function getStreakMultiplier(streakDays: number): number {
  const capped = Math.min(streakDays, MAX_STREAK_DAYS);
  return 1 + capped * STREAK_BONUS_PER_DAY;
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

// ============================================================
//                    CORE ENGINE
// ============================================================

/**
 * Called after each trade settlement. Awards points to the trader.
 */
export async function calculatePointsForTrade(
  trader: string,
  volume: number,
): Promise<number> {
  const traderLower = trader.toLowerCase();
  const record = await getOrCreateRecord(traderLower);

  // Update volume and trade count
  record.total_volume += volume;
  record.trade_count += 1;

  // Process daily streak
  const today = todayStr();
  if (record.last_trade_date !== today) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    if (record.last_trade_date === yesterdayStr) {
      record.streak_days = Math.min(record.streak_days + 1, MAX_STREAK_DAYS);
    } else if (record.last_trade_date !== today) {
      record.streak_days = 1; // Reset streak
    }
    record.last_trade_date = today;
  }

  // Calculate points for this trade
  const basePoints = (volume / 1000) * POINTS_PER_1K_VOLUME;
  const tierMultiplier = getVolumeTierMultiplier(record.total_volume);
  const streakMultiplier = getStreakMultiplier(record.streak_days);
  const totalMultiplier = tierMultiplier * streakMultiplier;

  const pointsEarned = basePoints * totalMultiplier;
  record.points += pointsEarned;
  record.multiplier = totalMultiplier;

  // Persist
  await saveRecord(record);
  await saveHistory({
    trader: traderLower,
    points_earned: pointsEarned,
    reason: "trade",
    metadata: { volume, tierMultiplier, streakMultiplier },
    season: CURRENT_SEASON,
  });

  // Credit referrer if exists
  await creditReferralPoints(traderLower, pointsEarned);

  console.log(
    `[Points] ${traderLower.slice(0, 10)}... +${pointsEarned.toFixed(1)} pts (vol=$${volume.toFixed(0)}, streak=${record.streak_days}d, mult=${totalMultiplier.toFixed(2)}x)`
  );

  return pointsEarned;
}

/**
 * Get a trader's points record with rank.
 */
export async function getTraderPoints(
  trader: string,
  season = CURRENT_SEASON,
): Promise<PointsRecord | null> {
  const traderLower = trader.toLowerCase();
  const client = getSupabase();

  if (client) {
    const { data, error } = await client
      .from("points")
      .select("*")
      .eq("trader", traderLower)
      .eq("season", season)
      .single();

    if (error || !data) return null;

    // Get rank
    const { count } = await client
      .from("points")
      .select("*", { count: "exact", head: true })
      .eq("season", season)
      .gte("points", data.points);

    return { ...data, rank: count || 1 } as PointsRecord;
  }

  // In-memory fallback
  const record = memoryStore.get(traderLower);
  if (!record) return null;

  // Calculate rank
  const allRecords = Array.from(memoryStore.values())
    .sort((a, b) => b.points - a.points);
  const rank = allRecords.findIndex((r) => r.trader === traderLower) + 1;

  return { ...record, rank };
}

/**
 * Get top traders by points.
 */
export async function getLeaderboard(
  season = CURRENT_SEASON,
  limit = 100,
): Promise<PointsRecord[]> {
  const client = getSupabase();

  if (client) {
    const { data, error } = await client
      .from("points")
      .select("*")
      .eq("season", season)
      .order("points", { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data.map((row, i) => ({ ...row, rank: i + 1 })) as PointsRecord[];
  }

  // In-memory fallback
  return Array.from(memoryStore.values())
    .filter((r) => r.season === season)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * Register a referral link between two addresses.
 */
export async function registerReferral(
  referrer: string,
  referee: string,
  code: string,
): Promise<boolean> {
  const referrerLower = referrer.toLowerCase();
  const refereeLower = referee.toLowerCase();

  if (referrerLower === refereeLower) return false;

  const client = getSupabase();

  if (client) {
    const { error } = await client
      .from("referrals")
      .insert({
        referrer: referrerLower,
        referee: refereeLower,
        referral_code: code,
      });
    if (error) {
      console.error(`[Points] Referral registration failed: ${error.message}`);
      return false;
    }
    return true;
  }

  // In-memory fallback
  if (memoryReferrals.has(refereeLower)) return false;
  memoryReferrals.set(refereeLower, {
    referrer: referrerLower,
    referee: refereeLower,
    referral_code: code,
    volume_from_referee: 0,
    points_earned: 0,
  });
  return true;
}

/**
 * Credit referrer with bonus points when referee earns points.
 */
async function creditReferralPoints(
  referee: string,
  refereePoints: number,
): Promise<void> {
  const client = getSupabase();
  let referral: ReferralRecord | null = null;

  if (client) {
    const { data } = await client
      .from("referrals")
      .select("*")
      .eq("referee", referee)
      .single();
    if (data) referral = data as ReferralRecord;
  } else {
    referral = memoryReferrals.get(referee) || null;
  }

  if (!referral) return;

  const bonusPoints = refereePoints * REFERRAL_BONUS_RATE;
  const referrerRecord = await getOrCreateRecord(referral.referrer);
  referrerRecord.points += bonusPoints;

  await saveRecord(referrerRecord);
  await saveHistory({
    trader: referral.referrer,
    points_earned: bonusPoints,
    reason: "referral",
    metadata: { referee, refereePoints },
    season: CURRENT_SEASON,
  });

  // Update referral stats
  if (client) {
    await client
      .from("referrals")
      .update({
        points_earned: referral.points_earned + bonusPoints,
      })
      .eq("referee", referee);
  } else if (memoryReferrals.has(referee)) {
    const ref = memoryReferrals.get(referee)!;
    ref.points_earned += bonusPoints;
  }
}

/**
 * Get campaign-wide statistics.
 */
export async function getCampaignStats(
  season = CURRENT_SEASON,
): Promise<CampaignStats> {
  const client = getSupabase();

  if (client) {
    const { data, error } = await client
      .from("points")
      .select("points, total_volume, trade_count")
      .eq("season", season);

    if (error || !data) {
      return { total_participants: 0, total_volume: 0, total_points: 0, total_trades: 0 };
    }

    return {
      total_participants: data.length,
      total_volume: data.reduce((s, r) => s + Number(r.total_volume), 0),
      total_points: data.reduce((s, r) => s + Number(r.points), 0),
      total_trades: data.reduce((s, r) => s + Number(r.trade_count), 0),
    };
  }

  // In-memory fallback
  const records = Array.from(memoryStore.values()).filter((r) => r.season === season);
  return {
    total_participants: records.length,
    total_volume: records.reduce((s, r) => s + r.total_volume, 0),
    total_points: records.reduce((s, r) => s + r.points, 0),
    total_trades: records.reduce((s, r) => s + r.trade_count, 0),
  };
}

// ============================================================
//                    PERSISTENCE
// ============================================================

async function getOrCreateRecord(trader: string): Promise<PointsRecord> {
  const client = getSupabase();

  if (client) {
    const { data } = await client
      .from("points")
      .select("*")
      .eq("trader", trader)
      .eq("season", CURRENT_SEASON)
      .single();

    if (data) return data as PointsRecord;

    // Create new record
    const newRecord: PointsRecord = {
      trader,
      points: 0,
      total_volume: 0,
      trade_count: 0,
      streak_days: 0,
      last_trade_date: null,
      multiplier: 1.0,
      season: CURRENT_SEASON,
    };

    await client.from("points").insert(newRecord);
    return newRecord;
  }

  // In-memory fallback
  if (!memoryStore.has(trader)) {
    memoryStore.set(trader, {
      trader,
      points: 0,
      total_volume: 0,
      trade_count: 0,
      streak_days: 0,
      last_trade_date: null,
      multiplier: 1.0,
      season: CURRENT_SEASON,
    });
  }
  return memoryStore.get(trader)!;
}

async function saveRecord(record: PointsRecord): Promise<void> {
  const client = getSupabase();

  if (client) {
    const { error } = await client
      .from("points")
      .upsert(
        { ...record, updated_at: new Date().toISOString() },
        { onConflict: "trader,season" },
      );
    if (error) console.error(`[Points] Save record failed: ${error.message}`);
    return;
  }

  // In-memory fallback
  memoryStore.set(record.trader, record);
}

async function saveHistory(entry: PointsHistoryEntry): Promise<void> {
  const client = getSupabase();

  if (client) {
    const { error } = await client.from("points_history").insert(entry);
    if (error) console.error(`[Points] Save history failed: ${error.message}`);
    return;
  }

  // In-memory fallback
  memoryHistory.push(entry);
}
