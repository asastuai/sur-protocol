"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useTrading } from "@/providers/TradingProvider";

interface PointsData {
  trader: string;
  points: number;
  total_volume: number;
  trade_count: number;
  streak_days: number;
  multiplier: number;
  rank: number | null;
  season: number;
}

interface CampaignStats {
  total_participants: number;
  total_volume: number;
  total_points: number;
  total_trades: number;
}

interface LeaderboardEntry extends PointsData {
  rank: number;
}

const API_BASE = process.env.NEXT_PUBLIC_WS_URL?.replace("wss://", "https://").replace("ws://", "http://") || "http://localhost:3002";

export default function PointsPage() {
  const { isConnected, address } = useAccount();
  const { state } = useTrading();
  const [notified, setNotified] = useState(false);
  const [email, setEmail] = useState("");
  const [tab, setTab] = useState<"overview" | "leaderboard">("overview");

  // Backend data
  const [myPoints, setMyPoints] = useState<PointsData | null>(null);
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // Fallback: local paper trading stats
  const totalVolume = state.paperTradeHistory.reduce((sum, t) => sum + t.price * t.size, 0);
  const tradeCount = state.paperTradeHistory.length;
  const isPaper = state.paperMode;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch campaign stats
      const statsRes = await fetch(`${API_BASE}/api/points/stats`);
      if (statsRes.ok) setStats(await statsRes.json());

      // Fetch user points if connected
      if (address) {
        const pointsRes = await fetch(`${API_BASE}/api/points/${address}`);
        if (pointsRes.ok) setMyPoints(await pointsRes.json());
      }

      // Fetch leaderboard
      const lbRes = await fetch(`${API_BASE}/api/points/leaderboard?limit=50`);
      if (lbRes.ok) {
        const data = await lbRes.json();
        setLeaderboard(data.leaderboard || []);
      }
    } catch {
      // API not available — use local fallback
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleNotify = (e: React.FormEvent) => {
    e.preventDefault();
    if (email.trim()) {
      setNotified(true);
      setEmail("");
    }
  };

  // Use backend data if available, otherwise local
  const displayPoints = myPoints?.points ?? 0;
  const displayVolume = myPoints?.total_volume ?? totalVolume;
  const displayTrades = myPoints?.trade_count ?? tradeCount;
  const displayStreak = myPoints?.streak_days ?? 0;
  const displayMultiplier = myPoints?.multiplier ?? 1.0;
  const displayRank = myPoints?.rank ?? null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-2">Points & Rewards</h1>
        <p className="text-sm text-sur-muted mb-8">
          Earn SUR points by trading, providing liquidity, and contributing to the protocol.
        </p>

        {/* Season 1 banner */}
        <div className="bg-sur-surface border border-sur-accent/30 rounded-xl p-8 text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-sur-accent to-blue-400 flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl font-bold text-white">S1</span>
          </div>
          <div className="flex items-center justify-center gap-2 mb-2">
            <h2 className="text-lg font-semibold">Season 1 — Testnet Campaign</h2>
            <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-sur-green/15 text-sur-green uppercase tracking-wider">
              Live
            </span>
          </div>
          <p className="text-sm text-sur-muted max-w-md mx-auto mb-6">
            Trade on testnet to earn points. Top traders will be rewarded when mainnet launches.
            All on-chain trading activity is tracked automatically.
          </p>

          {/* Campaign stats */}
          {stats && (
            <div className="grid grid-cols-4 gap-4 max-w-lg mx-auto mb-6">
              <div>
                <div className="text-lg font-bold tabular-nums">{stats.total_participants}</div>
                <div className="text-[10px] text-sur-muted">Traders</div>
              </div>
              <div>
                <div className="text-lg font-bold tabular-nums">${(stats.total_volume / 1000).toFixed(0)}k</div>
                <div className="text-[10px] text-sur-muted">Volume</div>
              </div>
              <div>
                <div className="text-lg font-bold tabular-nums">{stats.total_points.toFixed(0)}</div>
                <div className="text-[10px] text-sur-muted">Points</div>
              </div>
              <div>
                <div className="text-lg font-bold tabular-nums">{stats.total_trades}</div>
                <div className="text-[10px] text-sur-muted">Trades</div>
              </div>
            </div>
          )}

          {notified ? (
            <p className="text-sur-green text-xs font-medium">You&apos;ll be notified for Season 2.</p>
          ) : (
            <form onSubmit={handleNotify} className="flex gap-2 max-w-sm mx-auto">
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                className="flex-1 px-4 py-2.5 text-xs bg-sur-bg border border-sur-border rounded-lg focus:border-sur-accent/50 outline-none transition-colors"
              />
              <button
                type="submit"
                className="px-5 py-2.5 bg-sur-accent text-white text-xs font-semibold rounded-lg hover:bg-sur-accent/90 transition-colors"
              >
                Notify Me
              </button>
            </form>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-sur-surface rounded-lg p-1 w-fit">
          <button
            onClick={() => setTab("overview")}
            className={`px-4 py-2 text-xs font-medium rounded-md transition-colors ${
              tab === "overview" ? "bg-sur-accent text-white" : "text-sur-muted hover:text-sur-text"
            }`}
          >
            Your Points
          </button>
          <button
            onClick={() => setTab("leaderboard")}
            className={`px-4 py-2 text-xs font-medium rounded-md transition-colors ${
              tab === "leaderboard" ? "bg-sur-accent text-white" : "text-sur-muted hover:text-sur-text"
            }`}
          >
            Leaderboard
          </button>
        </div>

        {tab === "overview" && (
          <div className="grid grid-cols-2 gap-4 mb-8">
            {/* Your points summary */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-sm">Your Points</h3>
                {displayRank && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-sur-accent/15 text-sur-accent">
                    Rank #{displayRank}
                  </span>
                )}
              </div>
              {isConnected || isPaper ? (
                <div className="space-y-3">
                  <div className="text-center py-3 mb-3 bg-sur-bg rounded-lg">
                    <div className="text-3xl font-bold tabular-nums">{displayPoints.toFixed(1)}</div>
                    <div className="text-[10px] text-sur-muted mt-1">SUR Points</div>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-sur-muted">Trading Volume</span>
                    <span className="tabular-nums font-medium">
                      ${displayVolume.toLocaleString("en", { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-sur-muted">Total Trades</span>
                    <span className="tabular-nums font-medium">{displayTrades}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-sur-muted">Daily Streak</span>
                    <span className="tabular-nums font-medium">{displayStreak} day{displayStreak !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-sur-muted">Multiplier</span>
                    <span className="tabular-nums font-medium text-sur-accent">{displayMultiplier.toFixed(2)}x</span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-32">
                  <p className="text-xs text-sur-muted">Connect wallet to see your points</p>
                </div>
              )}
            </div>

            {/* How to earn */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="font-semibold text-sm mb-3">How to Earn Points</h3>
              <ul className="space-y-2.5 text-[12px] text-sur-muted">
                <li className="flex items-start gap-2">
                  <span className="text-sur-accent font-bold mt-0.5">1</span>
                  <span><span className="text-sur-text font-medium">Trade</span> — 1 point per $1,000 volume. Both maker and taker earn points.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-sur-accent font-bold mt-0.5">2</span>
                  <span><span className="text-sur-text font-medium">Volume Tiers</span> — $10k+ = 1.5x, $50k+ = 2x, $100k+ = 3x multiplier</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-sur-accent font-bold mt-0.5">3</span>
                  <span><span className="text-sur-text font-medium">Daily Streaks</span> — +10% per consecutive day (max 7 days = +70%)</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-sur-accent font-bold mt-0.5">4</span>
                  <span><span className="text-sur-text font-medium">Refer Traders</span> — Earn 10% of your referrals&apos; points</span>
                </li>
              </ul>
            </div>
          </div>
        )}

        {tab === "leaderboard" && (
          <div className="bg-sur-surface border border-sur-border rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-sur-border text-sur-muted">
                  <th className="text-left px-4 py-3 font-medium">#</th>
                  <th className="text-left px-4 py-3 font-medium">Trader</th>
                  <th className="text-right px-4 py-3 font-medium">Points</th>
                  <th className="text-right px-4 py-3 font-medium">Volume</th>
                  <th className="text-right px-4 py-3 font-medium">Trades</th>
                  <th className="text-right px-4 py-3 font-medium">Streak</th>
                  <th className="text-right px-4 py-3 font-medium">Mult.</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-sur-muted">
                      {loading ? "Loading..." : "No traders yet. Be the first to earn points!"}
                    </td>
                  </tr>
                ) : (
                  leaderboard.map((entry, i) => {
                    const isMe = address?.toLowerCase() === entry.trader;
                    return (
                      <tr
                        key={entry.trader}
                        className={`border-b border-sur-border/50 ${isMe ? "bg-sur-accent/5" : "hover:bg-sur-bg/50"}`}
                      >
                        <td className="px-4 py-2.5 font-medium">
                          {i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}
                        </td>
                        <td className="px-4 py-2.5 font-mono">
                          {entry.trader.slice(0, 6)}...{entry.trader.slice(-4)}
                          {isMe && <span className="ml-1 text-sur-accent text-[9px] font-bold">(you)</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                          {entry.points.toFixed(1)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-sur-muted">
                          ${Number(entry.total_volume).toLocaleString("en", { maximumFractionDigits: 0 })}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-sur-muted">
                          {entry.trade_count}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-sur-muted">
                          {entry.streak_days}d
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-sur-accent">
                          {Number(entry.multiplier).toFixed(1)}x
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Point multipliers info */}
        <div className="bg-sur-surface border border-sur-border rounded-xl p-6 mt-8">
          <h3 className="font-semibold text-sm mb-4">Point Multipliers</h3>
          <div className="grid grid-cols-3 gap-6 text-[11px] text-sur-muted">
            <div>
              <div className="text-sur-text font-medium mb-1">Volume Tiers</div>
              <p className="leading-relaxed">$0-$10k = 1x, $10k-$50k = 1.5x, $50k-$100k = 2x, $100k+ = 3x. Based on cumulative volume this season.</p>
            </div>
            <div>
              <div className="text-sur-text font-medium mb-1">Daily Streaks</div>
              <p className="leading-relaxed">+10% per consecutive trading day, up to 7 days (+70%). Missing a day resets your streak.</p>
            </div>
            <div>
              <div className="text-sur-text font-medium mb-1">Referral Bonus</div>
              <p className="leading-relaxed">Earn 10% of the points your referred traders earn. Share your referral link from the Referrals page.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
