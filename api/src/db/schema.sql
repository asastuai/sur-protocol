-- SUR Protocol - Supabase Schema
-- Run this in Supabase SQL Editor to initialize the database

-- ============================================================
--                    TRADES
-- ============================================================

CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market TEXT NOT NULL,
  price NUMERIC NOT NULL,
  size NUMERIC NOT NULL,
  side TEXT NOT NULL,
  maker_order_id TEXT,
  taker_order_id TEXT,
  tx_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_trades_market ON trades(market);
CREATE INDEX idx_trades_created ON trades(created_at DESC);

-- ============================================================
--                    POSITIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader TEXT NOT NULL,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  size NUMERIC NOT NULL,
  entry_price NUMERIC NOT NULL,
  margin NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(trader, market)
);

CREATE INDEX idx_positions_trader ON positions(trader);

-- ============================================================
--                    LEADERBOARD
-- ============================================================

CREATE TABLE IF NOT EXISTS leaderboard (
  trader TEXT PRIMARY KEY,
  total_pnl NUMERIC DEFAULT 0,
  total_volume NUMERIC DEFAULT 0,
  trade_count INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_leaderboard_pnl ON leaderboard(total_pnl DESC);

-- ============================================================
--                    LEADERBOARD RPC FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION update_leaderboard(
  p_trader TEXT,
  p_pnl NUMERIC,
  p_volume NUMERIC
) RETURNS void AS $$
BEGIN
  INSERT INTO leaderboard (trader, total_pnl, total_volume, trade_count, updated_at)
  VALUES (p_trader, p_pnl, p_volume, 1, now())
  ON CONFLICT (trader) DO UPDATE SET
    total_pnl = leaderboard.total_pnl + p_pnl,
    total_volume = leaderboard.total_volume + p_volume,
    trade_count = leaderboard.trade_count + 1,
    updated_at = now();
END;
$$ LANGUAGE plpgsql;
