/**
 * SUR Protocol - Supabase Database Client
 *
 * Persists trade history, positions, and leaderboard data
 * so state survives API restarts.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ============================================================
//                    TYPES
// ============================================================

export interface TradeRow {
  id?: string;
  market: string;
  price: number;
  size: number;
  side: string;
  maker_order_id?: string;
  taker_order_id?: string;
  tx_hash?: string;
  created_at?: string;
}

export interface PositionRow {
  id?: string;
  trader: string;
  market: string;
  side: string;
  size: number;
  entry_price: number;
  margin: number;
  updated_at?: string;
}

export interface LeaderboardRow {
  trader: string;
  total_pnl: number;
  total_volume: number;
  trade_count: number;
  updated_at?: string;
}

// ============================================================
//                    CLIENT
// ============================================================

let client: SupabaseClient | null = null;

export function initSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.warn("[DB] Supabase not configured — running without persistence");
    return null;
  }

  client = createClient(url, key);
  console.log("[DB] Supabase client initialized");
  return client;
}

export function getSupabase(): SupabaseClient | null {
  return client;
}

// ============================================================
//                    RETRY HELPER
// ============================================================

async function dbRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 2,
): Promise<T | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) {
        console.error(`[DB] ${label} failed after ${maxRetries + 1} attempts: ${(err as Error).message}`);
        return null;
      }
      const delay = Math.min(500 * Math.pow(2, attempt), 5000);
      console.warn(`[DB] ${label} retry ${attempt + 1}/${maxRetries + 1} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}

// ============================================================
//                    TRADE OPERATIONS
// ============================================================

export async function insertTrade(trade: TradeRow): Promise<void> {
  if (!client) return;
  await dbRetry(async () => {
    const { error } = await client!.from("trades").insert(trade);
    if (error) throw new Error(error.message);
  }, "insertTrade");
}

export async function getRecentTrades(market: string, limit = 50): Promise<TradeRow[]> {
  if (!client) return [];
  const { data, error } = await client
    .from("trades")
    .select("*")
    .eq("market", market)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[DB] Get trades failed:", error.message);
    return [];
  }
  return data || [];
}

// ============================================================
//                  POSITION OPERATIONS
// ============================================================

export async function upsertPosition(pos: PositionRow): Promise<void> {
  if (!client) return;
  await dbRetry(async () => {
    const { error } = await client!
      .from("positions")
      .upsert(pos, { onConflict: "trader,market" });
    if (error) throw new Error(error.message);
  }, "upsertPosition");
}

export async function getPositions(trader: string): Promise<PositionRow[]> {
  if (!client) return [];
  const { data, error } = await client
    .from("positions")
    .select("*")
    .eq("trader", trader);
  if (error) {
    console.error("[DB] Get positions failed:", error.message);
    return [];
  }
  return data || [];
}

// ============================================================
//                  LEADERBOARD OPERATIONS
// ============================================================

export async function updateLeaderboard(
  trader: string,
  pnl: number,
  volume: number,
): Promise<void> {
  if (!client) return;

  // Use RPC to atomically increment counters
  const { error } = await client.rpc("update_leaderboard", {
    p_trader: trader,
    p_pnl: pnl,
    p_volume: volume,
  });

  // Fallback: upsert if RPC not available
  if (error) {
    const { error: upsertErr } = await client
      .from("leaderboard")
      .upsert({
        trader,
        total_pnl: pnl,
        total_volume: volume,
        trade_count: 1,
        updated_at: new Date().toISOString(),
      }, { onConflict: "trader" });
    if (upsertErr) console.error("[DB] Leaderboard update failed:", upsertErr.message);
  }
}

export async function getLeaderboard(limit = 50): Promise<LeaderboardRow[]> {
  if (!client) return [];
  const { data, error } = await client
    .from("leaderboard")
    .select("*")
    .order("total_pnl", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[DB] Get leaderboard failed:", error.message);
    return [];
  }
  return data || [];
}
