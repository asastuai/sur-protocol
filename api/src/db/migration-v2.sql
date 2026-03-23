-- ============================================================
-- SUR Protocol - Migration v2: Points System
-- ============================================================
-- Run this in Supabase SQL Editor AFTER the initial schema.sql
-- Safe to run multiple times (IF NOT EXISTS)
-- ============================================================

-- Points: tracks each trader's accumulated points per season
CREATE TABLE IF NOT EXISTS points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader TEXT NOT NULL,
  points NUMERIC DEFAULT 0,
  total_volume NUMERIC DEFAULT 0,
  trade_count INT DEFAULT 0,
  streak_days INT DEFAULT 0,
  last_trade_date DATE,
  multiplier NUMERIC DEFAULT 1.0,
  season INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(trader, season)
);

CREATE INDEX IF NOT EXISTS idx_points_trader ON points(trader);
CREATE INDEX IF NOT EXISTS idx_points_season_points ON points(season, points DESC);

-- Points History: audit log of every point award
CREATE TABLE IF NOT EXISTS points_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader TEXT NOT NULL,
  points_earned NUMERIC NOT NULL,
  reason TEXT NOT NULL,
  metadata JSONB,
  season INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_points_history_trader ON points_history(trader);
CREATE INDEX IF NOT EXISTS idx_points_history_season ON points_history(season, created_at DESC);

-- Referrals: one-to-one mapping of referee to referrer
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer TEXT NOT NULL,
  referee TEXT NOT NULL UNIQUE,
  referral_code TEXT NOT NULL,
  volume_from_referee NUMERIC DEFAULT 0,
  points_earned NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);

-- Enable Row Level Security (optional — disable for backend service key)
-- ALTER TABLE points ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE points_history ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- VERIFICATION: Run this to confirm all tables exist
-- ============================================================
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
-- AND table_name IN ('trades', 'positions', 'leaderboard', 'points', 'points_history', 'referrals');
